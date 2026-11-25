import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type Diagnostics,
  type LeaseKey,
  leaseKeyId,
  type OpsCommandPayload,
  type OpsOperation,
  OpsUpdatePayload,
  signOpsCommand,
} from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import { RemoteOpsAgent, type RemoteOpsDeps } from '../src/remote-ops/agent.js';
import { RuntimeInstaller } from '../src/remote-ops/installer.js';
import { LoginManager } from '../src/remote-ops/login.js';
import { FileLog, tailLog } from '../src/remote-ops/logs.js';
import { hostPlatform } from '../src/remote-ops/manifest.js';
import { runProcess } from '../src/remote-ops/process.js';
import { detectService } from '../src/remote-ops/service-control.js';
import { nodeOps, tempDir } from './helpers.js';

const WORKER = 'w-1';

function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, lease };
}

function command(
  op: OpsOperation,
  k: ReturnType<typeof key> | null,
  opts: { now?: Date; ttlMs?: number; workerId?: string } = {},
): OpsCommandPayload {
  const now = opts.now ?? new Date();
  const base = {
    commandId: randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (opts.ttlMs ?? 120_000)).toISOString(),
    op,
  };
  return k === null
    ? base
    : {
        ...base,
        signature: signOpsCommand({ ...base, workerId: opts.workerId ?? WORKER }, k.lease.kid, k.privateKey),
      };
}

async function agent(overrides: Partial<RemoteOpsDeps> = {}, keys: LeaseKey[] = []) {
  const dataDir = await tempDir('ro-agent-');
  const logger = createLogger({ sink: () => undefined });
  const installer = await RuntimeInstaller.open({
    ops: nodeOps(),
    dataDir,
    manifest: { schema: 1, runtimes: {} },
    host: hostPlatform(),
    nodePath: process.execPath,
    logger,
  });
  const redactor = new Redactor();
  const sent: OpsUpdatePayload[] = [];
  const restart = vi.fn((_drain: boolean, _t: number) => Promise.resolve('restarting' as const));
  const diagnostics: Diagnostics = {
    collectedAt: new Date().toISOString(),
    workerVersion: '0.1.0',
    node: { version: '24.11.0', ok: true, requiredMajor: 24 },
    os: { platform: 'linux', release: '6', arch: 'x64' },
    uptimeSec: 1,
    memory: { freeBytes: 1, totalBytes: 2 },
    disk: [],
    sandbox: [],
    runtimes: [],
    service: { manager: 'systemd' },
    problems: [],
  };
  const a = await RemoteOpsAgent.open({
    ops: nodeOps(),
    dataDir,
    installer,
    login: new LoginManager({ binary: () => Promise.resolve(null), env: {}, run: runProcess, logger }),
    log: new FileLog(dataDir),
    redactor,
    logger,
    keySource: () => ({ keys, pinned: false }),
    disabled: [],
    service: { manager: 'systemd', restartable: true },
    restart,
    restartRuntime: () => Promise.resolve({ ok: true }),
    runtimeInUse: () => false,
    diagnostics: () => Promise.resolve(diagnostics),
    changed: () => undefined,
    ...overrides,
  });
  a.attach((p) => {
    sent.push(OpsUpdatePayload.parse(p)); // everything the agent sends is valid on the wire
    return Promise.resolve();
  });
  return { a, sent, restart, dataDir, redactor };
}

describe('remote-ops agent: command verification', () => {
  it('runs a correctly signed command and refuses unsigned / wrongly bound / expired ones', async () => {
    const k = key();
    const { a, sent } = await agent({}, [k.lease]);
    await a.onCommand(WORKER, command({ kind: 'diagnostics.run' }, k));
    expect(sent.map((u) => u.state)).toEqual(['running', 'succeeded']);
    expect(sent.at(-1)?.diagnostics?.workerVersion).toBe('0.1.0');

    sent.length = 0;
    await a.onCommand(WORKER, command({ kind: 'diagnostics.run' }, null));
    expect(sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'unsigned' })]);
    sent.length = 0;
    await a.onCommand(WORKER, command({ kind: 'diagnostics.run' }, k, { workerId: 'w-other' }));
    expect(sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'bad_signature' })]);
    sent.length = 0;
    await a.onCommand(WORKER, command({ kind: 'diagnostics.run' }, key()));
    expect(sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'bad_signature' })]);
    sent.length = 0;
    await a.onCommand(
      WORKER,
      command({ kind: 'diagnostics.run' }, k, { now: new Date(Date.now() - 3_600_000) }),
    );
    expect(sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'expired' })]);
    sent.length = 0;
    await a.onCommand(null, command({ kind: 'diagnostics.run' }, k));
    expect(sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'not_enrolled' })]);
  });

  it('never runs a command twice (replay), also after a restart', async () => {
    const k = key();
    const { a, sent, restart, dataDir } = await agent({}, [k.lease]);
    const cmd = command({ kind: 'service.restart', drain: false, drainTimeoutSec: 0 }, k);
    await a.onCommand(WORKER, cmd);
    await a.onCommand(WORKER, cmd);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(sent.map((u) => u.state)).toEqual(['running', 'succeeded']);
    // A new agent on the same data dir (the worker restarted) still knows the command.
    const again = await RemoteOpsAgent.open({
      ops: nodeOps(),
      dataDir,
      installer: await RuntimeInstaller.open({
        ops: nodeOps(),
        dataDir,
        manifest: { schema: 1, runtimes: {} },
        host: hostPlatform(),
        nodePath: process.execPath,
        logger: createLogger({ sink: () => undefined }),
      }),
      login: new LoginManager({
        binary: () => Promise.resolve(null),
        env: {},
        run: runProcess,
        logger: createLogger({ sink: () => undefined }),
      }),
      log: null,
      redactor: new Redactor(),
      logger: createLogger({ sink: () => undefined }),
      keySource: () => ({ keys: [k.lease], pinned: false }),
      disabled: [],
      service: { manager: 'systemd', restartable: true },
      restart,
      restartRuntime: () => Promise.resolve({ ok: true }),
      runtimeInUse: () => false,
      diagnostics: () => Promise.reject(new Error('unused')),
      changed: () => undefined,
    });
    await again.onCommand(WORKER, cmd);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('p16-doctor: doctor.run answers with the doctor report; refused on a build without one', async () => {
    const k = key();
    const report = {
      schemaVersion: 1 as const,
      collectedAt: new Date().toISOString(),
      mode: 'remote' as const,
      workerVersion: '0.1.0',
      host: { platform: 'linux', release: '6.8', arch: 'x64', node: 'v24.11.0' },
      master: 'https://remyral.example.com',
      summary: { ok: 1, info: 0, warning: 0, error: 0 },
      findings: [{ check: 'config', code: 'ok', severity: 'ok' as const, message: 'Config is valid' }],
    };
    const { a, sent } = await agent({ doctor: () => Promise.resolve(report) }, [k.lease]);
    await a.onCommand(WORKER, command({ kind: 'doctor.run' }, k));
    expect(sent.map((u) => u.state)).toEqual(['running', 'succeeded']);
    expect(sent.at(-1)?.doctor?.findings[0]?.check).toBe('config');
    const plain = await agent({}, [k.lease]);
    await plain.a.onCommand(WORKER, command({ kind: 'doctor.run' }, k));
    expect(plain.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'not_supported' });
    // A local opt-out of diagnostics covers the doctor too.
    const off = await agent({ disabled: ['diagnostics'], doctor: () => Promise.resolve(report) }, [k.lease]);
    await off.a.onCommand(WORKER, command({ kind: 'doctor.run' }, k));
    expect(off.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'disabled_locally' });
  });

  it('p17-disk-selfclean: disk.clean runs the hygiene and answers diskClean; refused without it or opted out', async () => {
    const k = key();
    const run = {
      trigger: 'manual' as const,
      startedAt: '2026-10-25T10:00:00.000Z',
      finishedAt: '2026-10-25T10:00:05.000Z',
      freeBefore: 100,
      freeAfter: 5000,
      freedBytes: 4900,
      freed: [{ category: 'logs' as const, bytes: 4900, items: 2 }],
      stillLow: false,
      errors: 0,
    };
    let calls = 0;
    const { a, sent } = await agent(
      {
        diskClean: () => {
          calls++;
          return Promise.resolve(run);
        },
      },
      [k.lease],
    );
    await a.onCommand(WORKER, command({ kind: 'disk.clean' }, k));
    expect(sent.map((u) => u.state)).toEqual(['running', 'succeeded']);
    expect(sent.at(-1)?.diskClean).toEqual(run);
    expect(calls).toBe(1);
    // Every update parses as an OPS_UPDATE (the master validates them).
    for (const u of sent) expect(OpsUpdatePayload.safeParse(u).success).toBe(true);
    const plain = await agent({}, [k.lease]);
    await plain.a.onCommand(WORKER, command({ kind: 'disk.clean' }, k));
    expect(plain.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'unsupported' });
    // It removes what the worker installed and cached: a local opt-out of installs covers it.
    const off = await agent({ disabled: ['install'], diskClean: () => Promise.resolve(run) }, [k.lease]);
    await off.a.onCommand(WORKER, command({ kind: 'disk.clean' }, k));
    expect(off.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'disabled_locally' });
  });

  it('accepts unsigned commands only while the master has no lease keys at all (dev)', async () => {
    const { a, sent } = await agent({}, []);
    await a.onCommand(WORKER, command({ kind: 'diagnostics.run' }, null));
    expect(sent.at(-1)?.state).toBe('succeeded');
  });

  it('local opt-outs win over the panel', async () => {
    const k = key();
    const { a, sent, restart } = await agent({ disabled: ['restart', 'install'] }, [k.lease]);
    await a.onCommand(WORKER, command({ kind: 'service.restart', drain: true, drainTimeoutSec: 60 }, k));
    await a.onCommand(WORKER, command({ kind: 'runtime.install', runtime: 'codex', version: '0.162.1' }, k));
    expect(sent.map((u) => u.reason)).toEqual(['disabled_locally', 'disabled_locally']);
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('remote-ops agent: service operations', () => {
  it('restart: refused without a service manager, drain timeout reported, success otherwise', async () => {
    const k = key();
    const off = await agent({ service: { manager: 'none', restartable: false } }, [k.lease]);
    await off.a.onCommand(WORKER, command({ kind: 'service.restart', drain: true, drainTimeoutSec: 5 }, k));
    expect(off.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'not_restartable' });
    expect(off.restart).not.toHaveBeenCalled();

    const busy = await agent({ restart: () => Promise.resolve('drain_timeout' as const) }, [k.lease]);
    await busy.a.onCommand(WORKER, command({ kind: 'service.restart', drain: true, drainTimeoutSec: 1 }, k));
    expect(busy.sent.at(-1)).toMatchObject({ state: 'failed', reason: 'drain_timeout' });

    const ok = await agent({}, [k.lease]);
    await ok.a.onCommand(WORKER, command({ kind: 'service.restart', drain: true, drainTimeoutSec: 600 }, k));
    expect(ok.restart).toHaveBeenCalledWith(true, 600);
    expect(ok.sent.at(-1)).toMatchObject({ state: 'succeeded', detail: 'restarting now' });
  });

  it('runtime restart reports the probe; removal of an in-use active runtime is refused', async () => {
    const k = key();
    const { a, sent } = await agent(
      { restartRuntime: () => Promise.resolve({ ok: false, detail: 'runtime_binary_missing: not found' }) },
      [k.lease],
    );
    await a.onCommand(WORKER, command({ kind: 'runtime.restart', runtime: 'pi' }, k));
    expect(sent.at(-1)).toMatchObject({ state: 'failed', reason: 'runtime_unavailable' });
    sent.length = 0;
    await a.onCommand(WORKER, command({ kind: 'runtime.remove', runtime: 'pi', version: '1.1.0' }, k));
    expect(sent.at(-1)).toMatchObject({ state: 'refused', reason: 'not_installed' });
  });

  it('service detection: systemd INVOCATION_ID, launchd label, otherwise not restartable', () => {
    expect(detectService('linux', { INVOCATION_ID: 'abc' }, '/var/lib/remyral-worker')).toEqual({
      manager: 'systemd',
      restartable: true,
    });
    expect(detectService('linux', {}, '/x')).toEqual({ manager: 'none', restartable: false });
    expect(detectService('darwin', { XPC_SERVICE_NAME: 'com.remyral.worker' }, '/x').restartable).toBe(true);
    expect(detectService('darwin', { XPC_SERVICE_NAME: 'com.apple.Terminal' }, '/x').restartable).toBe(false);
    expect(
      detectService('win32', { NODE_ENV: 'production' }, 'C:\\ProgramData\\RemyralWorker\\data').manager,
    ).toBe('scm');
  });
});

describe('remote-ops agent: logs', () => {
  it('tails the worker log in bounded, redacted chunks (secrets registered later are still redacted)', async () => {
    const k = key();
    const { a, sent, dataDir, redactor } = await agent({}, [k.lease]);
    const log = new FileLog(dataDir);
    await mkdir(log.dir, { recursive: true });
    const secret = 'sk-live-REDACT-ME-0123456789abcdef';
    const lines = Array.from({ length: 450 }, (_, n) => JSON.stringify({ msg: `line ${String(n)}` }));
    lines.push(JSON.stringify({ msg: `leaked ${secret}` }));
    lines.push(JSON.stringify({ msg: 'github ghp_0123456789abcdefghijABCDEFGHIJ0123456789' }));
    await appendFile(log.path, `${lines.join('\n')}\n`);
    redactor.secrets.add(secret);
    await a.onCommand(WORKER, command({ kind: 'logs.tail', lines: 400, maxBytes: 256 * 1024 }, k));
    const chunks = sent.filter((u) => u.logs !== undefined);
    expect(chunks.length).toBe(2);
    expect(chunks.map((c) => c.state)).toEqual(['running', 'succeeded']);
    const all = chunks.flatMap((c) => c.logs?.lines ?? []);
    expect(all).toHaveLength(400);
    expect(chunks[0]?.logs?.truncated).toBe(true);
    expect(chunks.at(-1)?.logs?.last).toBe(true);
    const text = all.join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('ghp_0123456789');
    expect(text).toContain('line 449');
  });

  it('rotation keeps two generations; bytes bound the tail', async () => {
    const dir = await tempDir();
    const log = new FileLog(dir, 64 * 1024);
    for (let n = 0; n < 3000; n++) log.append(JSON.stringify({ n, pad: 'x'.repeat(40) }));
    log.close();
    expect(log.bytes()).toBeLessThanOrEqual(2 * 64 * 1024);
    const r = await tailLog(log, new Redactor(), { lines: 2000, maxBytes: 8 * 1024 });
    expect(Buffer.byteLength(r.lines.join('\n'))).toBeLessThanOrEqual(8 * 1024);
    expect(r.truncated).toBe(true);
    expect(r.lines.at(-1)).toContain('"n":2999');
  });

  it('p6-worker-boot-diagnostics: source boot / updater read their fixed files, redacted; missing → logs_unavailable', async () => {
    const k = key();
    const dir = await tempDir();
    const boot = join(dir, 'boot.log');
    const updater = join(dir, 'updater.log');
    await appendFile(
      boot,
      `${JSON.stringify({ event: 'fatal', error: { message: 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789' } })}\n`,
    );
    await appendFile(
      updater,
      `${JSON.stringify({ msg: 'new version failed its health check; rolling back' })}\n`,
    );
    const { a, sent } = await agent({ logSources: { boot, updater: null } }, [k.lease]);
    await a.onCommand(WORKER, command({ kind: 'logs.tail', lines: 10, maxBytes: 4096, source: 'boot' }, k));
    const bootLines = sent.at(-1)?.logs?.lines ?? [];
    expect(sent.at(-1)?.state).toBe('succeeded');
    expect(bootLines.join('\n')).toContain('"event":"fatal"');
    expect(bootLines.join('\n')).not.toContain('ghp_0123456789');
    await a.onCommand(
      WORKER,
      command({ kind: 'logs.tail', lines: 10, maxBytes: 4096, source: 'updater' }, k),
    );
    expect(sent.at(-1)).toMatchObject({ state: 'failed', reason: 'logs_unavailable' });
    expect(sent.at(-1)?.detail).toContain('updater');
    const { a: b, sent: s2 } = await agent({ logSources: { boot: null, updater } }, [k.lease]);
    await b.onCommand(
      WORKER,
      command({ kind: 'logs.tail', lines: 10, maxBytes: 4096, source: 'updater' }, k),
    );
    expect(s2.at(-1)?.logs?.lines.join('\n')).toContain('rolling back');
  });

  it('logs unavailable → failed with a reason', async () => {
    const k = key();
    const { a, sent } = await agent({ log: null }, [k.lease]);
    await a.onCommand(WORKER, command({ kind: 'logs.tail', lines: 10, maxBytes: 4096 }, k));
    expect(sent.at(-1)).toMatchObject({ state: 'failed', reason: 'logs_unavailable' });
  });

  it('re-sends the last update of recent commands after a reconnect', async () => {
    const k = key();
    const { a, sent } = await agent({}, [k.lease]);
    await a.onCommand(WORKER, command({ kind: 'diagnostics.run' }, k));
    const n = sent.length;
    a.onSessionEstablished();
    await vi.waitFor(() => {
      expect(sent.length).toBe(n + 1);
    });
    expect(sent.at(-1)?.state).toBe('succeeded');
  });
});

describe('remote-ops agent: mcp.probe (p14-mcp-core)', () => {
  const server = {
    spec: Buffer.from('{}').toString('base64'),
    signature: { keyId: '0'.repeat(16), signature: 'A'.repeat(86) },
  };
  const op = { kind: 'mcp.probe' as const, server, secrets: [] };

  it('without MCP support the op is refused; with it, the report (or refusal) is passed through', async () => {
    const k = key();
    const none = await agent({}, [k.lease]);
    await none.a.onCommand(WORKER, command(op, k));
    expect(none.sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'unsupported' })]);

    const report = {
      tools: [{ name: 'get_issue', description: 'd', schemaSha256: 'a'.repeat(64) }],
      transport: 'streamable-http' as const,
      durationMs: 5,
    };
    const ok = await agent({ mcpProbe: () => Promise.resolve({ state: 'succeeded', report }) }, [k.lease]);
    await ok.a.onCommand(WORKER, command(op, k));
    expect(ok.sent).toEqual([
      expect.objectContaining({ state: 'succeeded', kind: 'mcp.probe', mcpProbe: report }),
    ]);

    const bad = await agent(
      {
        mcpProbe: () =>
          Promise.resolve({ state: 'refused', reason: 'mcp_verification_failed', detail: 'bad_signature' }),
      },
      [k.lease],
    );
    await bad.a.onCommand(WORKER, command(op, k));
    expect(bad.sent).toEqual([
      expect.objectContaining({ state: 'refused', reason: 'mcp_verification_failed' }),
    ]);
  });

  it('a local diagnostics opt-out refuses it', async () => {
    const k = key();
    const { a, sent } = await agent(
      { disabled: ['diagnostics'], mcpProbe: () => Promise.reject(new Error('must not run')) },
      [k.lease],
    );
    await a.onCommand(WORKER, command(op, k));
    expect(sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'disabled_locally' })]);
  });
});

describe('remote-ops agent: login operations re-probe the runtime (p14-login-status-consistency)', () => {
  /** A login manager stub: every operation ends logged in / logged out at once. */
  function fakeLogin(order: string[]): LoginManager {
    const report = (runtime: 'claude-code' | 'codex', status: 'logged_in' | 'logged_out') => ({
      runtime,
      status,
      checkedAt: new Date().toISOString(),
    });
    return {
      active: () => undefined,
      report: () => [],
      check: (runtime: 'claude-code' | 'codex') => {
        order.push('check');
        return Promise.resolve(report(runtime, 'logged_in'));
      },
      logout: (runtime: 'claude-code' | 'codex') => {
        order.push('logout');
        return Promise.resolve(report(runtime, 'logged_out'));
      },
      start: (_id: string, _runtime: string, emit: (u: { state: string }) => void) => {
        order.push('login');
        emit({ state: 'running' });
        emit({ state: 'succeeded' });
        return Promise.resolve();
      },
      cancel: () => false,
    } as unknown as LoginManager;
  }

  function wiring() {
    const order: string[] = [];
    const reprobe = vi.fn(async (runtime: string) => {
      order.push(`reprobe:${runtime}`);
      await new Promise((resolve) => setTimeout(resolve, 20)); // a probe takes a moment
      order.push('probed');
    });
    const changed = vi.fn(() => {
      order.push('capabilities');
    });
    return { order, reprobe, changed };
  }

  it('a status check forces a fresh probe before CAPABILITIES are re-sent and before the result goes out', async () => {
    const k = key();
    const w = wiring();
    const { a, sent } = await agent({ login: fakeLogin(w.order), reprobe: w.reprobe, changed: w.changed }, [
      k.lease,
    ]);
    a.attach((p) => {
      w.order.push(`update:${p.state}`);
      sent.push(p);
      return Promise.resolve();
    });
    await a.onCommand(WORKER, command({ kind: 'login.status', runtime: 'claude-code' }, k));
    expect(w.reprobe).toHaveBeenCalledWith('claude-code');
    expect(w.order).toEqual(['check', 'reprobe:claude-code', 'probed', 'capabilities', 'update:succeeded']);
  });

  it('a successful login and a logout re-probe before CAPABILITIES; the login result waits for it', async () => {
    const k = key();
    const w = wiring();
    const { a } = await agent({ login: fakeLogin(w.order), reprobe: w.reprobe, changed: w.changed }, [
      k.lease,
    ]);
    a.attach((p) => {
      w.order.push(`update:${p.state}`);
      return Promise.resolve();
    });
    await a.onCommand(WORKER, command({ kind: 'login.start', runtime: 'claude-code' }, k));
    await vi.waitFor(() => {
      expect(w.order).toContain('update:succeeded');
    });
    expect(w.order).toEqual([
      'login',
      'update:running',
      'reprobe:claude-code',
      'probed',
      'capabilities',
      'update:succeeded',
    ]);
    w.order.length = 0;
    await a.onCommand(WORKER, command({ kind: 'login.logout', runtime: 'codex' }, k));
    expect(w.order).toEqual(['logout', 'reprobe:codex', 'probed', 'capabilities', 'update:succeeded']);
  });

  it('an added account only re-sends CAPABILITIES; a failing re-probe still reports the check', async () => {
    const k = key();
    const w = wiring();
    const { a, sent } = await agent({ login: fakeLogin(w.order), reprobe: w.reprobe, changed: w.changed }, [
      k.lease,
    ]);
    await a.onCommand(WORKER, command({ kind: 'login.status', runtime: 'claude-code', account: 'acc2' }, k));
    expect(w.reprobe).not.toHaveBeenCalled();
    expect(w.changed).toHaveBeenCalledTimes(1);

    const broken = await agent(
      {
        login: fakeLogin([]),
        reprobe: () => Promise.reject(new Error('probe crashed')),
        changed: w.changed,
      },
      [k.lease],
    );
    await broken.a.onCommand(WORKER, command({ kind: 'login.status', runtime: 'claude-code' }, k));
    expect(broken.sent.at(-1)).toMatchObject({ state: 'succeeded', login: { status: 'logged_in' } });
    expect(w.changed).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)?.state).toBe('succeeded');
  });
});

describe('remote-ops agent: code.images.prepare (p14-code-images)', () => {
  const op = { kind: 'code.images.prepare' as const };
  const report = {
    ready: true,
    images: [
      {
        language: 'js' as const,
        tag: 'remyral/code-js:0.1.0',
        base: `node:24-bookworm-slim@sha256:${'d'.repeat(64)}`,
        id: `sha256:${'a'.repeat(64)}`,
      },
    ],
  };

  it('refused without a container engine; built → codeImages and CAPABILITIES re-sent; a local install opt-out refuses it', async () => {
    const k = key();
    const none = await agent({}, [k.lease]);
    await none.a.onCommand(WORKER, command(op, k));
    expect(none.sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'unsupported' })]);

    const changed = vi.fn();
    const ok = await agent(
      {
        changed,
        codeImages: {
          prepare: ({ progress }) => {
            progress('pull', 0, 4);
            return Promise.resolve({ state: 'succeeded', report, detail: 'built' });
          },
        },
      },
      [k.lease],
    );
    await ok.a.onCommand(WORKER, command(op, k));
    expect(ok.sent.map((u) => u.state)).toEqual(['accepted', 'running', 'succeeded']);
    expect(ok.sent[1]?.progress).toEqual({ step: 'pull', done: 0, total: 4 });
    expect(ok.sent.at(-1)).toMatchObject({ kind: 'code.images.prepare', codeImages: report });
    expect(changed).toHaveBeenCalledTimes(1);

    const failed = vi.fn();
    const bad = await agent(
      {
        changed: failed,
        codeImages: {
          prepare: () => Promise.resolve({ state: 'failed', reason: 'pull_failed', detail: 'no network' }),
        },
      },
      [k.lease],
    );
    await bad.a.onCommand(WORKER, command(op, k));
    expect(bad.sent.at(-1)).toMatchObject({ state: 'failed', reason: 'pull_failed', detail: 'no network' });
    expect(failed).not.toHaveBeenCalled();

    const off = await agent(
      { disabled: ['install'], codeImages: { prepare: () => Promise.reject(new Error('never')) } },
      [k.lease],
    );
    await off.a.onCommand(WORKER, command(op, k));
    expect(off.sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'disabled_locally' })]);
  });
});
