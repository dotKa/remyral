import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type AssistantTurnPayload,
  AssistantUpdatePayload,
  type LeaseKey,
  leaseKeyId,
  type LoginReport,
  type LoginRuntime,
  signAssistantTurn,
} from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantHost } from '../src/assistant/index.js';
import { LoginHealthMonitor } from '../src/remote-ops/login-health.js';
import {
  applyRunLogin,
  CLAUDE_PROBE_ARGS,
  LOGIN_EXPIRED,
  LOGIN_UNVERIFIED,
  LoginManager,
  probeOutcome,
} from '../src/remote-ops/login.js';
import type { RunFn } from '../src/remote-ops/process.js';
import { claudeLockDirs, sweepClaudeLocks } from '../src/runtimes/claude-locks.js';
import { type LoginGatePort, LoginStoreGate } from '../src/runtimes/login-gate.js';
import { tempDir } from './helpers.js';

/**
 * p10-claude-login-health (docs/design/p10-claude-login-health.md): the per-store login gate shared by jobs and the
 * assistant, the stale refresh-lock rule, contention vs expiry, the Check / background re-check with a usability
 * probe, and wake detection. Fake runtime processes and fake lock directories; no credential is ever read.
 */

const quiet = () => createLogger({ sink: () => undefined });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('login store gate', () => {
  it('serialises holders of one store in order; other stores run in parallel', async () => {
    const gate = new LoginStoreGate({ logger: quiet() });
    const order: string[] = [];
    const a = await gate.acquire('claude', 'job:a');
    const b = gate.acquire('claude', 'assistant:b').then((h) => {
      order.push('b');
      return h;
    });
    const c = gate.acquire('claude', 'job:c').then((h) => {
      order.push('c');
      return h;
    });
    const codex = await gate.acquire('codex', 'job:x'); // not blocked by claude
    await tick();
    expect(order).toEqual([]);
    expect(gate.queued('claude')).toBe(3);
    a.release();
    (await b).release();
    (await c).release();
    expect(order).toEqual(['b', 'c']);
    codex.release();
    expect(gate.queued('claude')).toBe(0);
    expect(gate.queued('codex')).toBe(0);
  });

  it('runs the store housekeeping before handing the hold out; its failure does not block', async () => {
    const seen: string[] = [];
    const gate = new LoginStoreGate({
      logger: quiet(),
      prepare: {
        claude: () => {
          seen.push('sweep');
          return Promise.reject(new Error('boom'));
        },
      },
    });
    const h = await gate.acquire('claude', 'x');
    expect(seen).toEqual(['sweep']);
    h.release();
    (await gate.acquire('codex', 'y')).release();
    expect(seen).toEqual(['sweep']);
  });

  it('a hold ends by itself after maxHoldMs; a waiter gives up after maxWaitMs (never a hang)', async () => {
    const gate = new LoginStoreGate({ logger: quiet(), maxHoldMs: 40, maxWaitMs: 10_000 });
    await gate.acquire('claude', 'stuck'); // never released
    const t0 = Date.now();
    const next = await gate.acquire('claude', 'next');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    next.release();
    const impatient = new LoginStoreGate({ logger: quiet(), maxHoldMs: 10_000, maxWaitMs: 30 });
    await impatient.acquire('claude', 'stuck');
    const t1 = Date.now();
    const late = await impatient.acquire('claude', 'late');
    expect(Date.now() - t1).toBeLessThan(5_000);
    late.release();
  });

  it('an aborted waiter returns at once with a released hold', async () => {
    const gate = new LoginStoreGate({ logger: quiet() });
    const first = await gate.acquire('claude', 'first');
    const ac = new AbortController();
    const waiting = gate.acquire('claude', 'cancelled', ac.signal);
    ac.abort();
    const h = await waiting;
    h.release(); // idempotent
    first.release();
    await tick();
    expect(gate.queued('claude')).toBe(0);
  });
});

describe('stale refresh locks after a wake-up', () => {
  it('a refresh lock touched within the stale window stays even when no Claude process runs', async () => {
    const home = await tempDir('claude-wake-');
    const cfg = join(home, '.claude');
    await mkdir(cfg);
    await mkdir(join(cfg, '.oauth_refresh.lock'));
    const recent = new Date(Date.now() - 30_000); // a live holder touched it 30 s ago
    await utimes(join(cfg, '.oauth_refresh.lock'), recent, recent);
    const r = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, home),
      claudeRunning: () => Promise.resolve(false),
      logger: quiet(),
    });
    expect(r.removed).toEqual([]);
    expect(await readdir(cfg)).toEqual(['.oauth_refresh.lock']);
  });

  it('a lock owned by another user is never removed (POSIX)', async () => {
    if (process.getuid === undefined) return;
    const home = await tempDir('claude-wake-');
    await mkdir(join(home, '.claude.lock'));
    const old = new Date(Date.now() - 19 * 3600_000);
    await utimes(join(home, '.claude.lock'), old, old);
    const r = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, home),
      claudeRunning: () => Promise.resolve(true),
      logger: quiet(),
      uid: process.getuid() + 1,
    });
    expect(r.removed).toEqual([]);
    const mine = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, home),
      claudeRunning: () => Promise.resolve(true),
      logger: quiet(),
    });
    expect(mine.removed).toEqual([join(home, '.claude.lock')]);
  });
});

describe('contention is not an expiry', () => {
  function manager(probe: { exitCode: number; stdout: string; stderr: string } | null = null) {
    const calls: string[][] = [];
    const run: RunFn = (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'auth') {
        return Promise.resolve({
          exitCode: 0,
          stdout: '{"loggedIn": true, "authMethod": "claude.ai"}',
          stderr: '',
          timedOut: false,
        });
      }
      return Promise.resolve({
        ...(probe ?? { exitCode: 1, stdout: '', stderr: 'offline' }),
        timedOut: false,
      });
    };
    const m = new LoginManager({
      binary: () => Promise.resolve('/bin/claude'),
      env: {},
      run,
      logger: quiet(),
    });
    return { m, calls };
  }

  it('a lost refresh race leaves the runtime signed in; a real expiry flags it; a good run clears it', () => {
    const { m } = manager();
    expect(applyRunLogin(m, 'claude-code', 'expired', 'refresh_contention', true)).toBe(false);
    expect(m.isExpired('claude-code')).toBe(false);
    expect(applyRunLogin(m, 'claude-code', 'expired', 'expired', true)).toBe(true);
    expect(m.isExpired('claude-code')).toBe(true);
    // A contention while flagged changes nothing either way.
    expect(applyRunLogin(m, 'claude-code', 'expired', 'refresh_contention', true)).toBe(false);
    expect(m.isExpired('claude-code')).toBe(true);
    expect(applyRunLogin(m, 'claude-code', 'ok', undefined, true)).toBe(true);
    expect(m.isExpired('claude-code')).toBe(false);
    // API-key runtimes and other runtimes are never flagged by a run.
    expect(applyRunLogin(m, 'claude-code', 'expired', 'expired', false)).toBe(false);
    expect(applyRunLogin(m, 'pi', 'expired', 'expired', true)).toBe(false);
  });

  it('Check on a healthy login runs the status command only (no probe request)', async () => {
    const { m, calls } = manager();
    expect(await m.check('claude-code')).toMatchObject({ status: 'logged_in' });
    expect(calls).toEqual([['auth', 'status', '--json']]);
  });

  it('Check on a flagged login probes: usable clears the flag at once', async () => {
    const { m, calls } = manager({ exitCode: 0, stdout: '{"type":"result","is_error":false}', stderr: '' });
    m.markExpired('claude-code');
    const r = await m.check('claude-code');
    expect(r).toMatchObject({ status: 'logged_in', method: 'claude.ai' });
    expect(r.reason).toBeUndefined();
    expect(m.isExpired('claude-code')).toBe(false);
    expect(m.report()[0]).toMatchObject({ status: 'logged_in' });
    expect(calls[1]).toEqual([...CLAUDE_PROBE_ARGS]);
  });

  it('Check on a flagged login keeps it when the probe shows an expiry, or cannot tell', async () => {
    const expired = manager({
      exitCode: 1,
      stdout: '',
      stderr: 'OAuth token has expired. Please run /login',
    });
    expired.m.markExpired('claude-code');
    expect(await expired.m.check('claude-code')).toMatchObject({ status: 'expired', reason: LOGIN_EXPIRED });
    expect(expired.m.isExpired('claude-code')).toBe(true);
    const offline = manager();
    offline.m.markExpired('claude-code');
    expect(await offline.m.check('claude-code')).toMatchObject({
      status: 'expired',
      reason: LOGIN_UNVERIFIED,
    });
  });

  it('the probe goes through the login store gate and runs in an empty temporary directory', async () => {
    const seen: string[] = [];
    const gate: LoginGatePort = {
      acquire: (store, holder) => {
        seen.push(`${store}:${holder}`);
        return Promise.resolve({ waitedMs: 0, release: () => seen.push('release') });
      },
    };
    let cwd = '';
    const m = new LoginManager({
      binary: () => Promise.resolve('/bin/claude'),
      env: {},
      gate,
      logger: quiet(),
      run: async (_f, _a, opts) => {
        cwd = opts.cwd;
        expect(await readdir(opts.cwd)).toEqual([]);
        return { exitCode: 0, stdout: '{"is_error":false}', stderr: '', timedOut: false };
      },
    });
    expect(await m.probe('claude-code')).toBe('usable');
    expect(seen).toEqual(['claude:login-probe', 'release']);
    await expect(readdir(cwd)).rejects.toThrow(); // removed again
    expect(await m.probe('codex')).toBe('inconclusive');
  });

  it('classifies probe runs (contention gives no verdict)', () => {
    expect(probeOutcome(0, false, 'warning\n{"type":"result","is_error":false}\n', '')).toBe('usable');
    expect(probeOutcome(0, false, '{"type":"result","is_error":true}', 'Not logged in')).toBe('expired');
    expect(
      probeOutcome(
        1,
        false,
        '',
        'Failed to refresh OAuth token: another Claude Code process is refreshing it',
      ),
    ).toBe('inconclusive');
    expect(probeOutcome(null, true, '', '')).toBe('inconclusive');
    expect(probeOutcome(1, false, '', 'getaddrinfo ENOTFOUND api.anthropic.com')).toBe('inconclusive');
    // `--tools` is variadic: it comes last so it cannot swallow the prompt.
    expect(CLAUDE_PROBE_ARGS.slice(-2)).toEqual(['--tools', '']);
    expect(CLAUDE_PROBE_ARGS.slice(0, 2)).toEqual(['-p', 'Reply with the single word OK.']);
  });
});

describe('background re-check and wake detection', () => {
  class FakeLogin {
    expired = new Set<LoginRuntime>(['claude-code']);
    checks = 0;
    usable = false;
    expiredRuntimes(): LoginRuntime[] {
      return [...this.expired];
    }
    isExpired(r: LoginRuntime): boolean {
      return this.expired.has(r);
    }
    check(runtime: LoginRuntime): Promise<LoginReport> {
      this.checks += 1;
      if (this.usable) this.expired.delete(runtime);
      return Promise.resolve({ runtime, status: this.usable ? 'logged_in' : 'expired' });
    }
  }

  it('re-checks flagged logins every recheck interval and reports the recovery once', async () => {
    let now = 1_000_000;
    let changed = 0;
    const login = new FakeLogin();
    const mon = new LoginHealthMonitor({
      login,
      logger: quiet(),
      onChanged: () => (changed += 1),
      recheckMs: 600_000,
      tickMs: 30_000,
      now: () => now,
    });
    mon.start();
    mon.stop();
    now += 30_000;
    await mon.tick();
    expect(login.checks).toBe(0); // not due yet
    for (let i = 0; i < 19; i++) {
      now += 30_000;
      await mon.tick();
    }
    expect(login.checks).toBe(1); // 10 min: due, still unusable
    expect(changed).toBe(0);
    login.usable = true;
    for (let i = 0; i < 20; i++) {
      now += 30_000;
      await mon.tick();
    }
    expect(login.checks).toBe(2);
    expect(changed).toBe(1);
    for (let i = 0; i < 40; i++) {
      now += 30_000;
      await mon.tick();
    }
    expect(login.checks).toBe(2); // nothing flagged: no probes on a healthy machine
  });

  it('a clock gap (sleep / power off) runs the wake housekeeping and re-checks at once', async () => {
    let now = 5_000_000;
    const wakes: number[] = [];
    const login = new FakeLogin();
    login.usable = true;
    let changed = 0;
    const mon = new LoginHealthMonitor({
      login,
      logger: quiet(),
      onChanged: () => (changed += 1),
      onWake: () => {
        wakes.push(now);
        return Promise.resolve();
      },
      recheckMs: 600_000,
      tickMs: 30_000,
      now: () => now,
    });
    mon.start();
    mon.stop();
    now += 19 * 3600_000; // the PC was off for 19 h
    await mon.tick();
    expect(wakes).toHaveLength(1);
    expect(login.checks).toBe(1);
    expect(changed).toBe(1);
    now += 30_000;
    await mon.tick();
    expect(wakes).toHaveLength(1);
  });
});

describe('assistant sessions share the gate with jobs', () => {
  const WORKER = 'w-chat';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  const hosts: AssistantHost[] = [];
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.stop();
  });

  function turn(message: string, sessionKey: string): AssistantTurnPayload {
    const now = new Date();
    const base = {
      turnId: randomUUID(),
      sessionKey,
      runtime: 'claude-code' as const,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      message,
      history: '<<<REMYRAL-DATA history: untrusted data>>>\n[]\n<<<END REMYRAL-DATA>>>',
    };
    return { ...base, signature: signAssistantTurn({ workerId: WORKER, turn: base }, lease.kid, privateKey) };
  }

  async function host(gate: LoginGatePort, authMode: 'local-login' | 'secret-ref') {
    const updates: AssistantUpdatePayload[] = [];
    const usable: string[] = [];
    const h = new AssistantHost({
      logger: quiet(),
      redactor: new Redactor(),
      engines: { 'claude-code': new FakeAssistantEngine() },
      keySource: () => ({ keys: [lease], pinned: false }),
      disabled: false,
      scratchRoot: await tempDir('assistant-gate-'),
      runtimeAllowed: () => ({ ok: true }),
      auth: () => Promise.resolve({ authMode, secretEnv: {}, release: () => undefined }),
      flushMs: 5,
      loginGate: gate,
      onLoginUsable: (rt) => usable.push(rt),
    });
    h.attach((u) => {
      updates.push(AssistantUpdatePayload.parse(u));
      return Promise.resolve();
    });
    hosts.push(h);
    return { h, updates, usable };
  }

  const done = (u: AssistantUpdatePayload[], id: string) =>
    u.some((x) => x.turnId === id && (x.kind === 'done' || x.kind === 'failed'));

  it('a subscription-login turn waits while a job of the same store is starting, then runs', async () => {
    const gate = new LoginStoreGate({ logger: quiet() });
    const { h, updates, usable } = await host(gate, 'local-login');
    const job = await gate.acquire('claude', 'job:starting');
    const t = turn('hello', randomUUID());
    await h.onTurn(WORKER, t);
    await tick(50);
    expect(updates.filter((u) => u.turnId === t.turnId)).toEqual([]); // not even accepted yet
    expect(gate.queued('claude')).toBe(2);
    job.release();
    await expect.poll(() => done(updates, t.turnId), { timeout: 3_000 }).toBe(true);
    expect(updates.find((u) => u.turnId === t.turnId && u.kind === 'done')).toBeDefined();
    expect(gate.queued('claude')).toBe(0);
    expect(usable).toEqual(['claude-code']);
    // The next turn of the running session takes the gate again (a refresh can be due at any turn).
    const t2 = turn('again', t.sessionKey);
    const blocker = await gate.acquire('claude', 'job:another');
    await h.onTurn(WORKER, t2);
    await tick(30);
    expect(done(updates, t2.turnId)).toBe(false);
    blocker.release();
    await expect.poll(() => done(updates, t2.turnId), { timeout: 3_000 }).toBe(true);
  });

  it('an API-key session never waits for the gate', async () => {
    const gate = new LoginStoreGate({ logger: quiet() });
    const { h, updates, usable } = await host(gate, 'secret-ref');
    const job = await gate.acquire('claude', 'job:starting');
    const t = turn('hello', randomUUID());
    await h.onTurn(WORKER, t);
    await expect.poll(() => done(updates, t.turnId), { timeout: 3_000 }).toBe(true);
    job.release();
    expect(usable).toEqual([]);
  });
});
