import { EventEmitter } from 'node:events';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createLogger } from '@remyral/observability';
import {
  type RuntimeKind,
  type WorkerConfigDelivery,
  workerConfigHash,
  workerConfigIssues,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  accountFolder,
  accountFolderReclaimArgs,
  accountLoginDir,
  accountsOf,
  existingAccountFolders,
  findAccount,
  removeAccountFolder,
  storeOf,
  syncAccountFolders,
} from '../src/accounts/accounts.js';
import { deriveCeiling } from '../src/config/ceiling.js';
import { type WorkerConfig, workerConfigSchema } from '../src/config/schema.js';
import { effectiveConfig, type EffectiveConfig } from '../src/managed-config/effective.js';
import { applyRunLogin, LoginManager, loginEnv, type LoginUpdate } from '../src/remote-ops/login.js';
import type { RunFn } from '../src/remote-ops/process.js';
import { RuntimeUsageCollector } from '../src/runtimes/usage.js';
import { selectProfile, type WorkerSandboxCapabilities } from '../src/sandbox/policy.js';
import { planJobEnv } from '../src/secrets/env.js';
import { buildSeatbeltProfile } from '../src/sandbox/host/seatbelt.js';
import { captureLines, tempDir } from './helpers.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §2.1): the worker side of several Claude Code / Codex
 * accounts — the configured login stays the `default` account (no move, no re-login), added subscription accounts
 * get their own folder and config dir, API-key accounts are vault references; login relay, env, sandbox policy and
 * usage readings are per account.
 */

const DATA = '/var/lib/remyral/data';

function effective(over: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    projects: {},
    workspaces: {},
    allowedRuntimes: ['claude-code', 'codex'],
    maxParallelJobs: 2,
    sandboxProfiles: ['host-restricted'],
    runtimeAuth: { 'claude-code': { mode: 'local-login' }, codex: { mode: 'local-login' } },
    runtimeSettings: {},
    modelProfiles: {},
    workspace: { retainFailed: 0, minFreeBytes: 0, submodules: 'skip', packageCacheMaxBytes: 0 },
    labels: {},
    runtimeAccounts: {
      'claude-code': [
        { id: 'a1b2c3d4', kind: 'subscription' },
        {
          id: 'k9',
          kind: 'api_key',
          auth: { mode: 'secret-ref', ref: 'secret:vault-anthropic-team', env: 'ANTHROPIC_API_KEY' },
          credentialId: 'anthropic-team',
        },
      ],
    },
    ...over,
  };
}

describe('accounts in effect', () => {
  it('the configured login is the default account: its own store, no folder (no move, no re-login)', () => {
    const list = accountsOf(effective(), DATA);
    const def = findAccount(list, 'claude-code', undefined);
    expect(def).toMatchObject({ id: 'default', kind: 'subscription', isDefault: true, store: 'claude' });
    expect(def?.loginDir).toBeUndefined();
    expect(def?.folder).toBeUndefined();
    expect(storeOf('claude-code', def)).toBe('claude');
    expect(findAccount(list, 'codex', 'default')?.store).toBe('codex');
  });

  it('an added subscription account: its folder, config dir and store', () => {
    const a = findAccount(accountsOf(effective(), DATA), 'claude-code', 'a1b2c3d4');
    expect(a).toMatchObject({
      kind: 'subscription',
      isDefault: false,
      auth: { mode: 'local-login' },
      store: 'claude-a1b2c3d4',
      folder: join(DATA, 'runtime-accounts', 'claude-code', 'a1b2c3d4'),
      loginDir: join(DATA, 'runtime-accounts', 'claude-code', 'a1b2c3d4', '.claude'),
    });
    expect(accountLoginDir(DATA, 'codex', 'x1')).toBe(
      join(DATA, 'runtime-accounts', 'codex', 'x1', '.codex'),
    );
    expect(() => accountFolder(DATA, 'codex', 'default')).toThrow(RangeError);
    expect(() => accountFolder(DATA, 'codex', '../x')).toThrow(RangeError);
  });

  it('an API-key account is a vault reference; a default configured with a key is an API-key account', () => {
    const list = accountsOf(
      effective({
        runtimeAuth: { codex: { mode: 'secret-ref', ref: 'secret:vault-openai', env: 'CODEX_API_KEY' } },
      }),
      DATA,
    );
    expect(findAccount(list, 'claude-code', 'k9')).toMatchObject({
      kind: 'api_key',
      credentialId: 'anthropic-team',
      auth: { mode: 'secret-ref', ref: 'secret:vault-anthropic-team' },
    });
    expect(findAccount(list, 'codex', 'default')).toMatchObject({
      kind: 'api_key',
      credentialId: 'openai',
      isDefault: true,
    });
    // A runtime that is not enabled has no accounts.
    expect(
      accountsOf(effective({ allowedRuntimes: ['codex'] }), DATA).some((a) => a.runtime === 'claude-code'),
    ).toBe(false);
  });

  it('the panel document: accounts parsed from runtimes.<rt>.accounts (vault only for keys)', () => {
    const parsed = workerConfigSchema('linux').parse({
      masterUrl: 'wss://m.example.com/v1/worker',
      workspaceRoot: '/srv/work',
    });
    const { dataDir: _d, $schema: _s, ...rest } = parsed;
    const base = { ...rest, dataDir: DATA, source: '/etc/remyral-worker/config.json' };
    const config: WorkerConfig = { ...base, ...deriveCeiling({}, base) };
    const document = {
      schemaVersion: 1 as const,
      projects: {},
      allowedRuntimes: ['claude-code' as const],
      maxParallelJobs: 2,
      sandboxProfiles: ['host-restricted' as const],
      workspace: {},
      labels: {},
      runtimes: {
        'claude-code': {
          auth: { mode: 'local-login' as const },
          accounts: [
            { id: 'a1', kind: 'subscription' as const },
            {
              id: 'k1',
              kind: 'api_key' as const,
              credentialRef: { source: 'vault' as const, id: 'anthropic-x' },
            },
          ],
        },
      },
    };
    const delivery: WorkerConfigDelivery = {
      generation: 1,
      documentHash: workerConfigHash(document),
      issuedAt: '2026-10-19T10:00:00.000Z',
      document,
    };
    const e = effectiveConfig(config, delivery).config;
    expect(e.runtimeAccounts?.['claude-code']).toEqual([
      { id: 'a1', kind: 'subscription' },
      {
        id: 'k1',
        kind: 'api_key',
        // The runtime's default variable (ANTHROPIC_API_KEY) applies when the reference names none.
        auth: { mode: 'secret-ref', ref: 'secret:vault-anthropic-x' },
        credentialId: 'anthropic-x',
      },
    ]);
    // Local configuration only (no panel document): no added accounts.
    expect(effectiveConfig(config, null).config.runtimeAccounts).toBeUndefined();
  });
});

describe('config document rules for accounts', () => {
  const doc = (accounts: unknown[]) =>
    ({
      schemaVersion: 1,
      projects: {},
      allowedRuntimes: ['claude-code'],
      maxParallelJobs: 1,
      sandboxProfiles: ['host-restricted'],
      workspace: {},
      labels: {},
      runtimes: { 'claude-code': { accounts } },
    }) as unknown as WorkerConfigDelivery['document'];

  it('accepts subscription and vault API-key accounts; refuses keys from the worker store and duplicates', () => {
    expect(
      workerConfigIssues(
        doc([
          { id: 'a1', kind: 'subscription' },
          { id: 'k1', kind: 'api_key', credentialRef: { source: 'vault', id: 'anthropic-x' } },
        ]),
        { vault: true, accounts: true },
      ),
    ).toEqual([]);
    expect(
      workerConfigIssues(doc([{ id: 'a1', kind: 'subscription' }]), { vault: true }).map((i) => i.code),
    ).toEqual(['accounts_unsupported']);
    expect(
      workerConfigIssues(
        doc([
          { id: 'a1', kind: 'subscription' },
          { id: 'a1', kind: 'api_key', credentialRef: { source: 'worker-store', name: 'x' } },
        ]),
        { vault: true, accounts: true },
      ).map((i) => i.code),
    ).toEqual(['duplicate', 'vault_required']);
  });
});

describe('account folders', () => {
  it('creates owner-only config dirs for added subscription accounts and lists the stale ones', async () => {
    const data = await tempDir('acc-folders-');
    const list = accountsOf(effective(), data);
    await mkdir(join(data, 'runtime-accounts', 'codex', 'gone1'), { recursive: true });
    const r = await syncAccountFolders(data, list, () => existingAccountFolders(data, (p) => readdir(p)));
    expect(r.created).toEqual([join(data, 'runtime-accounts', 'claude-code', 'a1b2c3d4')]);
    expect(r.stale).toEqual([join(data, 'runtime-accounts', 'codex', 'gone1')]);
    const st = await stat(join(data, 'runtime-accounts', 'claude-code', 'a1b2c3d4', '.claude'));
    expect(st.isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(st.mode & 0o077).toBe(0);
    await removeAccountFolder(data, r.stale[0] ?? '');
    expect(await existingAccountFolders(data, (p) => readdir(p))).toEqual([
      join(data, 'runtime-accounts', 'claude-code', 'a1b2c3d4'),
    ]);
    // Never outside the accounts root.
    await expect(removeAccountFolder(data, join(data, 'secrets'))).rejects.toThrow(RangeError);
  });

  it('Windows: taking a lent folder back — owner to the worker, then every slot entry removed (recursive)', () => {
    const worker = 'S-1-5-80-111-222-333-444-555';
    const slot = 'S-1-5-21-1-2-3-1001';
    expect(accountFolderReclaimArgs('C:\\data\\runtime-accounts\\claude-code\\a1', worker, [slot])).toEqual([
      ['C:\\data\\runtime-accounts\\claude-code\\a1', '/setowner', `*${worker}`, '/T', '/C', '/Q'],
      ['C:\\data\\runtime-accounts\\claude-code\\a1', '/remove:g', `*${slot}`, '/T', '/C', '/Q'],
    ]);
    expect(() => accountFolderReclaimArgs('x', 'not-a-sid', [])).toThrow();
  });

  it('macOS Seatbelt: the account folder in the data dir is writable and readable for that attempt only', () => {
    const sb = buildSeatbeltProfile({
      workspace: '/ws/jobs/j/a',
      sandboxDir: '/ws/sandboxes/j/a',
      workspaceRoot: '/ws',
      workerDataDir: '/data',
      homes: ['/Users/w'],
      loginDirs: ['/data/runtime-accounts/claude-code/a1'],
    });
    const values = Object.values(sb.params);
    expect(values).toContain('/data/runtime-accounts/claude-code/a1');
    expect(sb.profile).toMatch(/require-not \(subpath/);
  });
});

describe('job environment per account', () => {
  it("a subscription account sets its own config dir instead of passing the worker's through", () => {
    const claude = planJobEnv(
      { runtime: 'claude-code', auth: { mode: 'local-login' }, loginDir: '/d/acc/a1/.claude' },
      'w1',
    );
    expect(claude.authMode).toBe('local-login');
    expect(claude.env).toEqual({ CLAUDE_CONFIG_DIR: '/d/acc/a1/.claude' });
    expect(claude.passthrough).not.toContain('CLAUDE_CONFIG_DIR');
    const codex = planJobEnv(
      { runtime: 'codex', auth: { mode: 'local-login' }, loginDir: '/d/acc/b/.codex' },
      'w1',
    );
    expect(codex.env).toEqual({ CODEX_HOME: '/d/acc/b/.codex' });
    // The configured login (default) keeps passing the worker's own variable, as before.
    expect(planJobEnv({ runtime: 'codex', auth: { mode: 'local-login' } }, 'w1').passthrough).toContain(
      'CODEX_HOME',
    );
  });

  it('an API-key account injects its vault credential (Claude ANTHROPIC_API_KEY, Codex CODEX_API_KEY)', () => {
    const claude = planJobEnv(
      { runtime: 'claude-code', auth: { mode: 'secret-ref', ref: 'secret:vault-anthropic-team' } },
      'w1',
    );
    expect(claude.secrets).toEqual([
      { env: 'ANTHROPIC_API_KEY', name: 'vault-anthropic-team', ref: 'secret:vault-anthropic-team' },
    ]);
    const codex = planJobEnv(
      { runtime: 'codex', auth: { mode: 'secret-ref', ref: 'secret:vault-openai' } },
      'w1',
    );
    expect(codex.secrets[0]?.env).toBe('CODEX_API_KEY');
  });
});

/** A login process that prints nothing and exits 0 (the account dir arrives in its env). */
function fakeSpawn(envs: Record<string, string>[]) {
  return ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
    envs.push(opts.env);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 999_999;
    child.kill = () => true;
    setTimeout(() => child.emit('close', 0), 5);
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

describe('login relay per account', () => {
  const runs: { args: readonly string[]; env: Record<string, string> }[] = [];
  const run: RunFn = (_bin, args, opts) => {
    runs.push({ args, env: { ...(opts.env as Record<string, string>) } });
    const loggedIn = args.includes('status');
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      stdout: loggedIn ? '{"loggedIn": true, "authMethod": "claude.ai"}' : '',
      stderr: '',
    });
  };
  const accounts: Record<string, { loginDir: string; store: string }> = {
    'claude-code#a1': { loginDir: '/d/acc/claude-code/a1/.claude', store: 'claude-a1' },
    'codex#c1': { loginDir: '/d/acc/codex/c1/.codex', store: 'codex-c1' },
  };
  const make = (envs: Record<string, string>[] = []) =>
    new LoginManager({
      binary: () => Promise.resolve('/bin/runtime'),
      env: { HOME: '/home/w', PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/w/.claude-own' },
      run,
      logger: createLogger({ sink: captureLines().sink }),
      spawnImpl: fakeSpawn(envs),
      account: (runtime, id) => accounts[`${runtime}#${id}`] ?? null,
    });

  it("the login env points the runtime at the account's own config dir", () => {
    expect(
      loginEnv('claude-code', { HOME: '/h', CLAUDE_CONFIG_DIR: '/own' }, '/acc/.claude').CLAUDE_CONFIG_DIR,
    ).toBe('/acc/.claude');
    expect(loginEnv('codex', { HOME: '/h' }, '/acc/.codex').CODEX_HOME).toBe('/acc/.codex');
    expect(loginEnv('claude-code', { HOME: '/h', CLAUDE_CONFIG_DIR: '/own' }).CLAUDE_CONFIG_DIR).toBe('/own');
  });

  it("login, status and logout of an added account run with its config dir; the default with the worker's", async () => {
    const envs: Record<string, string>[] = [];
    const m = make(envs);
    const updates: LoginUpdate[] = [];
    await m.start('00000000-0000-4000-8000-000000000001', 'claude-code', (u) => updates.push(u), 'a1');
    expect(envs[0]?.CLAUDE_CONFIG_DIR).toBe('/d/acc/claude-code/a1/.claude');
    expect(updates[0]?.login).toMatchObject({ runtime: 'claude-code', account: 'a1' });
    expect(updates.at(-1)).toMatchObject({
      state: 'succeeded',
      login: { account: 'a1', status: 'logged_in' },
    });
    runs.length = 0;
    const s = await m.status('codex', 'c1');
    expect(s).toMatchObject({ runtime: 'codex', account: 'c1', status: 'logged_in' });
    expect(runs[0]?.env.CODEX_HOME).toBe('/d/acc/codex/c1/.codex');
    runs.length = 0;
    await m.logout('claude-code', 'a1');
    expect(runs[0]?.args).toEqual(['auth', 'logout']);
    expect(runs[0]?.env.CLAUDE_CONFIG_DIR).toBe('/d/acc/claude-code/a1/.claude');
    runs.length = 0;
    await m.status('claude-code');
    expect(runs[0]?.env.CLAUDE_CONFIG_DIR).toBe('/home/w/.claude-own');
    // CAPABILITIES.remoteOps.login keeps only the configured logins (older masters: ≤ 4 entries).
    expect(m.report().every((r) => r.account === undefined)).toBe(true);
    expect(m.accountReport('claude-code', 'a1')).toMatchObject({ runtime: 'claude-code', account: 'a1' });
  });

  it('an unknown account is refused, never logged into the default store', async () => {
    const envs: Record<string, string>[] = [];
    const m = make(envs);
    const updates: LoginUpdate[] = [];
    await m.start('00000000-0000-4000-8000-000000000002', 'claude-code', (u) => updates.push(u), 'zz');
    expect(updates).toEqual([expect.objectContaining({ state: 'refused', reason: 'account_unknown' })]);
    expect(envs).toEqual([]);
    expect((await m.status('codex', 'zz')).reason).toBe('account_unknown');
  });

  it('expiry flags are per account: one account expired leaves the default (and another account) usable', () => {
    const m = make();
    expect(applyRunLogin(m, 'claude-code', 'expired', 'expired', true, 'a1')).toBe(true);
    expect(m.isExpired('claude-code', 'a1')).toBe(true);
    expect(m.isExpired('claude-code')).toBe(false);
    expect(m.expiredRuntimes()).toEqual([]);
    expect(m.expiredLogins()).toEqual([{ runtime: 'claude-code', account: 'a1' }]);
    expect(applyRunLogin(m, 'claude-code', 'ok', undefined, true, 'a1')).toBe(true);
    expect(m.isExpired('claude-code', 'a1')).toBe(false);
    m.markExpired('codex', 'login_expired', 'c1');
    m.forget('codex', 'c1');
    expect(m.isExpired('codex', 'c1')).toBe(false);
  });
});

describe('sandbox policy: exclusivity per account store (Windows per-job accounts)', () => {
  const POLICY = { allowedProfiles: ['container', 'runtime-sandbox', 'host-restricted'] as const };
  const caps = (
    attempts: NonNullable<WorkerSandboxCapabilities['attempts']>,
    hostAttempts: number,
  ): WorkerSandboxCapabilities => ({
    platform: 'win32',
    container: { ready: false },
    hostRestricted: { ready: true, filesystemConfinement: 'job_user', concurrency: 3, egressEnforced: false },
    runtimeSandboxes: [],
    runningAttempts: attempts.length,
    hostAttempts,
    attempts,
  });
  const job = (over: Partial<Parameters<typeof selectProfile>[0]> = {}) => ({
    profile: 'host-restricted' as const,
    runtime: 'claude-code' as RuntimeKind,
    sourceTrust: 'trusted' as const,
    needsEgress: true,
    hostExecutionOptIn: true,
    authMode: 'local-login' as const,
    family: 'f-b',
    projectId: 'p',
    ...over,
  });
  const running = (over: Record<string, unknown>) => ({
    family: 'f-a',
    projectId: 'p',
    profile: 'host-restricted' as const,
    runtime: 'claude-code' as RuntimeKind,
    authMode: 'local-login' as const,
    ...over,
  });

  it('two lent accounts run in parallel on two per-job accounts (unrelated jobs)', () => {
    const r = selectProfile(
      job({ loginStore: 'claude-a2', loginLent: true }),
      caps([running({ loginStore: 'claude-a1', loginLent: true })], 1),
      POLICY,
    );
    expect(r.ok).toBe(true);
  });

  it('the same account waits (one attempt per login store), even inside the family', () => {
    const r = selectProfile(
      job({ loginStore: 'claude-a1', loginLent: true, family: 'f-a' }),
      caps([running({ loginStore: 'claude-a1', loginLent: true })], 1),
      POLICY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.busy).toBe(true);
      expect(r.error.message).toMatch(/account to be free/);
    }
  });

  it('a lent account waits for an unrelated worker-account login (the configured store runs alone)', () => {
    const r = selectProfile(
      job({ loginStore: 'claude-a2', loginLent: true }),
      caps([running({ loginStore: 'claude', loginLent: false })], 0),
      POLICY,
    );
    expect(r.ok).toBe(false);
  });

  it('the configured store keeps addendum 7a: alone beside other families', () => {
    const r = selectProfile(job(), caps([running({ loginStore: 'claude-a1', loginLent: true })], 1), POLICY);
    expect(r.ok).toBe(false);
  });
});

describe('usage readings per account', () => {
  it('one snapshot per account; added accounts carry their id and store; default unchanged', () => {
    const c = new RuntimeUsageCollector({
      logger: createLogger({ sink: captureLines().sink }),
      localLogin: () => [],
      reader: () => null,
    });
    const reading = (p: number) => ({
      available: true,
      partial: false,
      windows: [{ id: 'five_hour', kind: 'session' as const, usedPercent: p }],
    });
    c.observe('claude-code', 'subscription', 'job', reading(10));
    c.observe('claude-code', 'subscription', 'job', reading(70), 'a1');
    const snaps = c.snapshots();
    expect(snaps).toEqual([
      expect.objectContaining({
        runtime: 'claude-code',
        store: 'claude',
        windows: [expect.objectContaining({ usedPercent: 10 })],
      }),
      expect.objectContaining({
        account: 'a1',
        store: 'claude-a1',
        windows: [expect.objectContaining({ usedPercent: 70 })],
      }),
    ]);
    expect(snaps[0]).not.toHaveProperty('account');
    c.forget('claude-code', 'a1');
    expect(c.snapshots()).toHaveLength(1);
  });

  it('probes each added account under its own store gate with its own reader', async () => {
    const stores: string[] = [];
    const c = new RuntimeUsageCollector({
      logger: createLogger({ sink: captureLines().sink }),
      localLogin: () => ['claude-code'],
      reader: () => ({
        readUsage: () => Promise.resolve({ available: true, partial: false, windows: [] }),
      }),
      accounts: () => [
        {
          runtime: 'claude-code',
          account: 'a1',
          store: 'claude-a1',
          reader: () => ({
            readUsage: () =>
              Promise.resolve({
                available: true,
                partial: false,
                windows: [{ id: 'seven_day', kind: 'weekly' as const, usedPercent: 33 }],
              }),
          }),
        },
      ],
      gate: {
        acquire: (store) => {
          stores.push(store);
          return Promise.resolve({ release: () => undefined, waitedMs: 0 });
        },
      },
    });
    await c.tick();
    expect(stores).toEqual(['claude', 'claude-a1']);
    expect(c.snapshots().find((x) => x.account === 'a1')?.windows[0]?.usedPercent).toBe(33);
  });
});
