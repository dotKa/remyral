/**
 * OpenCode adapter against the fixture-driven stand-in (fixtures/opencode/
 * fake-opencode.mjs): runs everywhere, no OpenCode installation needed.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createOpenCodeAdapter,
  InvalidSpawnContextError,
  OC_PERMISSION_KEYS,
  SecretValue,
  SessionNotFoundError,
  UnsafeServerError,
  VersionMismatchError,
  type OpenCodeAdapterOptions,
} from '../src/index.js';
import { defineAdapterContractSuite } from '../src/testing/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'fake-opencode.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-fake-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FAST = {
  startupMs: 10_000,
  cancelGraceMs: 500,
  cancelMs: 3_000,
  approvalMs: 5_000,
  maxDurationMs: 60_000,
};

function adapter(extra: Partial<OpenCodeAdapterOptions> = {}, env: Record<string, string> = {}) {
  return createOpenCodeAdapter({
    command: process.execPath,
    commandArgs: [FAKE],
    stateDir: join(root, 'state', randomUUID()),
    authMode: 'secret-ref',
    model: 'fake/scripted',
    platform: { os: 'darwin', arch: 'arm64' },
    env,
    ...extra,
  });
}

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

const prompts = {
  basic: 'faux:basic contract',
  'long-running': 'faux:long',
  approval: 'faux:approval',
} as const;

defineAdapterContractSuite('opencode (fixture server, contract-tested platform)', () => adapter(), {
  prompts,
  timeouts: FAST,
});

defineAdapterContractSuite(
  'opencode (fixture server, platform not contract-tested: everything unverified)',
  () => adapter({ platform: { os: 'win32', arch: 'x64' } }),
  { prompts, timeouts: FAST },
);

defineAdapterContractSuite(
  'opencode (fixture server, version drift, policy allows unverified)',
  () => adapter({}, { FAKE_OC_VERSION: '1.20.0' }),
  { prompts, timeouts: FAST, makeContext: (base) => ({ ...base, allowUnverified: true }) },
);

describe('opencode adapter (fixture server)', { timeout: 30_000 }, () => {
  it('starts the server with our policy env: loopback, password env-only, project config off, private dirs', async () => {
    const envFile = join(root, `env-${randomUUID()}.json`);
    const secret = new SecretValue(`sk-${randomUUID()}`);
    const a = adapter({}, { FAKE_OC_ENV_FILE: envFile, OPENCODE_PERMISSION: '{"bash":"allow"}' });
    const ref = await a.spawn(
      spawnContext('opencode', workspace(), { timeouts: FAST, secretEnv: { OPENAI_API_KEY: secret } }),
    );
    const { argv, env } = JSON.parse(readFileSync(envFile, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(argv.slice(0, 3)).toEqual(['serve', '--hostname', '127.0.0.1']);
    expect(argv).toContain('--pure');
    expect(argv.join(' ')).not.toContain(secret.reveal());
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('set');
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    const permission = JSON.parse(env.OPENCODE_PERMISSION ?? '{}') as Record<string, string>;
    expect(Object.keys(permission).sort()).toEqual([...OC_PERMISSION_KEYS].sort());
    expect(permission.bash).toBe('ask'); // the operator env could not override it
    expect(permission.external_directory).toBe('deny');
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>;
    expect(config).toMatchObject({
      share: 'disabled',
      autoupdate: false,
      plugin: [],
      model: 'fake/scripted',
    });
    for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'OPENCODE_DB']) {
      expect(env[k]).toContain(join('storage'));
    }
    await a.cleanup(ref);
  });

  it('local-login keeps the user data dir (own auth.json) but private config/cache/state', async () => {
    const envFile = join(root, `env-${randomUUID()}.json`);
    const a = adapter(
      { authMode: 'local-login', inheritEnv: ['PATH'] },
      { FAKE_OC_ENV_FILE: envFile, XDG_DATA_HOME: '/home/owner/.local/share' },
    );
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    const { env } = JSON.parse(readFileSync(envFile, 'utf8')) as { env: Record<string, string> };
    expect(env.XDG_DATA_HOME).toBe('/home/owner/.local/share');
    expect(env.XDG_CONFIG_HOME).toContain('storage');
    expect((await a.probe()).authenticated).toBe('no');
    await a.cleanup(ref);
  });

  describe('p14-codex-mcp-isolation: MCP servers of the worker user ~/.opencode config', () => {
    function userHome(mcp: Record<string, unknown>): string {
      const home = join(root, 'home', randomUUID());
      mkdirSync(join(home, '.opencode'), { recursive: true });
      writeFileSync(join(home, '.opencode', 'opencode.json'), JSON.stringify({ mcp }));
      return home;
    }
    const launches = (log: string) =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { configContent: { mcp?: Record<string, unknown> } });

    it('are disabled: the server is restarted with each one off; operator entries stay as they are', async () => {
      const log = join(root, `launch-${randomUUID()}.jsonl`);
      const home = userHome({
        evil: { type: 'local', command: ['/bin/sh', '-c', 'touch /tmp/x'], enabled: true },
        'off.already': { type: 'local', command: ['true'], enabled: false },
      });
      const ops = { type: 'remote', url: 'https://ops.example.invalid/mcp', enabled: true };
      const a = adapter(
        { authMode: 'local-login', inheritEnv: ['PATH'], config: { mcp: { ops } } },
        { FAKE_OC_LAUNCH_LOG: log, HOME: home },
      );
      const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
      const runs = launches(log);
      expect(runs).toHaveLength(2);
      expect(runs[0]?.configContent.mcp).toEqual({ ops });
      expect(runs[1]?.configContent.mcp).toEqual({ evil: { enabled: false }, ops });
      await a.sendPrompt(ref, { text: 'faux:basic' });
      const events = (await drain(a, ref, 10_000)).map((e) => e.event);
      expect(events.some((e) => e.kind === 'error')).toBe(false);
      await a.cleanup(ref);
    });

    it('without any: one server start, no mcp key added', async () => {
      const log = join(root, `launch-${randomUUID()}.jsonl`);
      const a = adapter({}, { FAKE_OC_LAUNCH_LOG: log, HOME: join(root, 'home', randomUUID()) });
      const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
      const runs = launches(log);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.configContent.mcp).toBeUndefined();
      await a.cleanup(ref);
    });

    it('fail closed when one is still enabled after the restart', async () => {
      const home = userHome({ evil: { type: 'local', command: ['true'] } });
      const a = adapter({}, { HOME: home, FAKE_OC_IGNORE_MCP_OFF: '1' });
      await expect(a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }))).rejects.toThrow(
        /MCP servers of the user configuration are enabled: evil/,
      );
    });
  });

  it('refuses a workspace with OpenCode project config before starting any server', async () => {
    const envFile = join(root, `env-${randomUUID()}.json`);
    const ws = workspace();
    mkdirSync(join(ws, '.opencode', 'plugins'), { recursive: true });
    const a = adapter({}, { FAKE_OC_ENV_FILE: envFile });
    await expect(a.spawn(spawnContext('opencode', ws, { timeouts: FAST }))).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
    expect(existsSync(envFile)).toBe(false); // the server was never started
  });

  it('a tool that prints the server password does not leak it into events', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:leakpw' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    const result = events.find((e) => e.kind === 'tool_result');
    expect(result?.kind === 'tool_result' ? result.outputSummary : '').toBe('pw=[REDACTED]');
    await a.cleanup(ref);
  });

  it('refuses a fail-open server (anonymous request accepted)', async () => {
    const a = adapter({}, { FAKE_OC_FAIL_OPEN: '1' });
    await expect(a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }))).rejects.toBeInstanceOf(
      UnsafeServerError,
    );
  });

  it('refuses a server whose effective permission differs from the policy', async () => {
    const a = adapter({}, { FAKE_OC_DRIFT: '1' });
    await expect(a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }))).rejects.toThrow(/bash/);
  });

  it('refuses a version that differs from the pin unless policy allows unverified', async () => {
    const a = adapter({}, { FAKE_OC_VERSION: '1.18.35' });
    await expect(a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }))).rejects.toBeInstanceOf(
      VersionMismatchError,
    );
  });

  it('a crash mid-run is reported as runtime_crashed', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:crash' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'runtime_crashed' }));
    expect(await a.collectResult(ref)).toMatchObject({ outcome: 'failed', errorCode: 'runtime_crashed' });
    await a.cleanup(ref);
  });

  it('a consumed event with an invalid shape fails the session closed', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:badevent' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'runtime_protocol_error' }));
    expect((await a.collectResult(ref)).outcome).toBe('failed');
    await a.cleanup(ref);
  });

  it('a permission answered by someone else (password leaked to a tool) stops the job', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:selfapprove' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'approval_bypass_detected' }),
    );
    expect(await a.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'approval_bypass_detected',
    });
    await a.cleanup(ref);
  });

  it('a permission change during the run (PATCH /config by a tool) stops the job', async () => {
    const a = adapter({ policyCheckIntervalMs: 50 });
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:drift faux:long' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'approval_bypass_detected' }),
    );
    expect((await a.collectResult(ref)).outcome).toBe('failed');
    await a.cleanup(ref);
  });

  it('cancel falls back to the process-tree kill when abort is not answered', async () => {
    const a = adapter({}, { FAKE_OC_IGNORE_ABORT: '1' });
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:long' });
    await waitFor(a, ref, (e) => e.event.kind === 'status' && e.event.phase === 'running');
    const outcome = await a.cancel(ref);
    expect(outcome.mode).toBe('forced');
    expect((await a.collectResult(ref)).outcome).toBe('cancelled');
    await a.cleanup(ref);
  });

  it('without an offered approval capability permission requests are rejected, never surfaced', async () => {
    const a = adapter({ platform: { os: 'linux', arch: 'arm64' } });
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:approval' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events.some((e) => e.kind === 'approval_request')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: false }));
    await expect(
      a.requestApproval(ref, { approvalId: 'x', decision: 'approve', decidedBy: 't' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    await a.cleanup(ref);
  });

  it('follow-ups while busy are delivered into the running loop before the session ends', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:approval' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request');
    if (req.event.kind !== 'approval_request') throw new Error('unreachable');
    await a.sendPrompt(ref, { text: 'faux:history' });
    await a.requestApproval(ref, { approvalId: req.event.approvalId, decision: 'approve', decidedBy: 't' });
    const texts = (await drain(a, ref, 10_000))
      .map((e) => e.event)
      .flatMap((e) => (e.kind === 'message' && e.role === 'assistant' ? [e.text] : []));
    expect(texts).toEqual(['history:2']); // delivered with the next model request (as 1.19.0 does)
    await a.cleanup(ref);
  });

  // p15-message-delivery: follow-up receipts and refusals.
  const userTexts = (events: readonly { event: { kind: string; role?: string; text?: string } }[]) =>
    events.flatMap((e) =>
      e.event.kind === 'message' && e.event.role === 'user' ? [e.event.text ?? ''] : [],
    );

  it('p15: a follow-up while an approval is pending is read at the next model output', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:approval' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request');
    if (req.event.kind !== 'approval_request') throw new Error('unreachable');
    const receipts: { kind: string }[] = [];
    await a.sendPrompt(ref, { text: 'faux:history', onReceipt: (r) => receipts.push(r) });
    expect(receipts).toEqual([]);
    await a.requestApproval(ref, { approvalId: req.event.approvalId, decision: 'approve', decidedBy: 't' });
    const events = await drain(a, ref, 10_000);
    expect(userTexts(events)).toContain('faux:history');
    expect(receipts.map((r) => r.kind)).toEqual(['consumed']);
    await a.cleanup(ref);
  });

  it('p15: a refused follow-up throws and no longer ends the run (it used to fail the job)', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:approval' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request');
    if (req.event.kind !== 'approval_request') throw new Error('unreachable');
    await expect(a.sendPrompt(ref, { text: 'faux:refuse this' })).rejects.toThrow(/follow-up refused/);
    await a.requestApproval(ref, { approvalId: req.event.approvalId, decision: 'approve', decidedBy: 't' });
    const events = await drain(a, ref, 10_000);
    expect(userTexts(events)).not.toContain('faux:refuse this');
    expect(events.map((e) => e.event)).not.toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'prompt_rejected' }),
    );
    expect((await a.collectResult(ref)).outcome).toBe('succeeded');
    await a.cleanup(ref);
  });

  it('p15: after the run ended a follow-up is refused', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:basic' });
    await drain(a, ref, 10_000);
    await expect(a.sendPrompt(ref, { text: 'too late' })).rejects.toThrow();
    await a.cleanup(ref);
  });

  it('resume re-opens the stored session; unknown sessions are refused', async () => {
    const a = adapter();
    const ws = workspace();
    const ref = await a.spawn(spawnContext('opencode', ws, { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:basic' });
    await drain(a, ref, 10_000);
    await a.cleanup(ref);
    const resumed = await a.resume(ref, spawnContext('opencode', ws, { timeouts: FAST }));
    await a.sendPrompt(resumed, { text: 'faux:history' });
    const events = (await drain(a, resumed, 10_000)).map((e) => e.event);
    expect(events).toContainEqual({ kind: 'message', role: 'assistant', text: 'history:2' });
    await a.cleanup(resumed);
    await a.purgeTranscript(resumed);
    await expect(a.resume(ref, spawnContext('opencode', ws, { timeouts: FAST }))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('local-login usage is token-only; secret-ref reports the runtime estimate', async () => {
    for (const authMode of ['local-login', 'secret-ref'] as const) {
      const a = adapter({ authMode });
      const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
      await a.sendPrompt(ref, { text: 'faux:basic' });
      const usage = (await drain(a, ref, 10_000)).map((e) => e.event).filter((e) => e.kind === 'usage');
      expect(usage.length).toBe(2);
      expect(usage[0]).toMatchObject({
        inputTokens: 60,
        outputTokens: 7,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        turns: 1,
        provider: 'fake',
        model: 'scripted',
        authMode,
        provenance: authMode === 'local-login' ? 'estimated-from-tokens' : 'reported-by-runtime',
      });
      const cost = await a.getCost(ref);
      if (authMode === 'local-login') expect(cost.costUsd).toBeUndefined();
      else expect(cost.costUsd).toBeCloseTo(0.0024);
      await a.cleanup(ref);
    }
  });
});
