import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createClaudeCodeAdapter,
  InvalidSpawnContextError,
  RuntimeCrashedError,
  SecretValue,
  VersionMismatchError,
  type ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
  type ProcessConfiner,
  type SequencedEvent,
  type SessionRef,
  type SpawnContext,
  type SpawnPlan,
  type SubtaskToolHost,
} from '../../../src/index.js';
import { collectUntilStopped, readUntil } from '../../../src/testing/index.js';
import {
  approvalTurn,
  basicTurn,
  FAKE_CLI,
  FakeClaudeSdk,
  longTurn,
  type FakeSdkOptions,
  type FakeTurnScript,
} from '../../fixtures/claude-code/fake-sdk.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const root = mkdtempSync(join(tmpdir(), 'remyral-claude-unit-'));
const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });

const opened: { adapter: ClaudeCodeAdapter; ref: SessionRef }[] = [];
afterEach(async () => {
  for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-claude-unit'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: mkdtempSync(join(root, 'ws-')),
    job: { runtime: 'claude-code', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: {
      startupMs: 5_000,
      cancelGraceMs: 500,
      cancelMs: 2_000,
      approvalMs: 5_000,
      maxDurationMs: 60_000,
    },
    allowUnverified: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function make(fake: FakeSdkOptions, extra: ClaudeCodeAdapterOptions = {}) {
  const sdk = new FakeClaudeSdk(fake);
  const adapter = createClaudeCodeAdapter({
    binaryPath: FAKE_CLI,
    sdkInfo,
    sdk,
    stateDir: join(root, 'state'),
    sourceEnv: {
      ...process.env,
      ANTHROPIC_API_KEY: 'worker-own-key-must-not-leak',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
    },
    ...extra,
  });
  return { adapter, sdk };
}

async function start(adapter: ClaudeCodeAdapter, c: SpawnContext, prompt = 'do it'): Promise<SessionRef> {
  await adapter.probe();
  const ref = await adapter.spawn(c);
  opened.push({ adapter, ref });
  await adapter.sendPrompt(ref, { text: prompt });
  return ref;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

async function readPids(
  workspace: string,
): Promise<{ cli: number; grandchild: number; argv: string[]; envNames: string[] }> {
  const file = join(workspace, '.fake-cli-pids.json');
  const end = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error('fake CLI did not record its pids');
    await new Promise((r) => setTimeout(r, 20));
  }
  return JSON.parse(readFileSync(file, 'utf8')) as {
    cli: number;
    grandchild: number;
    argv: string[];
    envNames: string[];
  };
}

const kinds = (events: SequencedEvent[]) => events.map((e) => e.event.kind);

describePosix('claude-code adapter: SDK options are explicit and hardened (ADR-0012 rule 3)', () => {
  it('passes settingSources [], explicit permissionMode, bypass disabled, pinned binary, no secrets in options', async () => {
    const { adapter, sdk } = make({ script: basicTurn });
    const secret = new SecretValue('sk-ant-canary-0123456789');
    const c = ctx({ secretEnv: { ANTHROPIC_API_KEY: secret } });
    const ref = await start(adapter, c);
    await collectUntilStopped(adapter, ref, 10_000);
    const o = sdk.calls[0]?.options;
    expect(o).toBeDefined();
    if (!o) return;
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
    expect(o.allowDangerouslySkipPermissions).toBe(false);
    expect(o.permissionPrompts).toBe('host');
    expect(o.settings).toEqual({ permissions: { disableBypassPermissionsMode: 'disable' } });
    expect(o.managedSettings).toEqual({ permissions: { disableBypassPermissionsMode: 'disable' } });
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({});
    // p14-codex-mcp-isolation: no plugins of the worker user (settingSources [] also keeps enabledPlugins and hooks out).
    expect(o.plugins).toEqual([]);
    expect(o.verbatimPrompts).toBe(true);
    expect(o.pathToClaudeCodeExecutable).toBe(FAKE_CLI);
    expect(o.cwd).toBe(c.workspaceRoot);
    expect(typeof o.canUseTool).toBe('function');
    expect(typeof o.spawnClaudeCodeProcess).toBe('function');
    // The worker's own credentials are never inherited; injected secrets never pass through SDK options.
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(o.env)).not.toContain(secret.reveal());
    expect(o.env?.CLAUDE_CONFIG_DIR).toMatch(/cfg-/);
  });

  it('p5-git-identity: the job commit identity from the job env is kept in the CLI env', async () => {
    const identity = {
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    };
    const { adapter, sdk } = make({ script: basicTurn }, { sourceEnv: { ...process.env, ...identity } });
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.calls[0]?.options.env).toMatchObject(identity);
  });

  it('deny-sensitive jobs run in dontAsk mode and never ask a human', async () => {
    const { adapter, sdk } = make({ script: approvalTurn });
    const ref = await start(adapter, ctx({ approvalPolicy: 'deny-sensitive' }));
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.calls[0]?.options.permissionMode).toBe('dontAsk');
    expect(kinds(events)).not.toContain('approval_request');
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
  });

  it('allow-all jobs run in bypassPermissions mode (ADR-0020): bypass not disabled, nobody asked', async () => {
    const { adapter, sdk } = make({ script: approvalTurn });
    const ref = await start(adapter, ctx({ approvalPolicy: 'allow-all' }));
    const events = await collectUntilStopped(adapter, ref, 10_000);
    const o = sdk.calls[0]?.options;
    expect(o?.permissionMode).toBe('bypassPermissions');
    expect(o?.allowDangerouslySkipPermissions).toBe(true);
    expect(o?.settings).toEqual({ permissions: {} });
    expect(o?.managedSettings).toEqual({ permissions: {} });
    // Everything else stays hardened.
    expect(o?.settingSources).toEqual([]);
    expect(o?.strictMcpConfig).toBe(true);
    expect(o?.permissionPrompts).toBe('host');
    expect(kinds(events)).not.toContain('approval_request');
    expect(kinds(events)).not.toContain('error');
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'allow' });
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
  });

  it('an allow-all job whose CLI reports default mode is aborted (fail closed)', async () => {
    const { adapter } = make({ script: longTurn, reportedPermissionMode: 'default' });
    const ref = await start(adapter, ctx({ approvalPolicy: 'allow-all' }));
    await collectUntilStopped(adapter, ref, 10_000);
    expect(await adapter.collectResult(ref)).toMatchObject({ errorCode: 'permission_mode_mismatch' });
  });

  it('ask-sensitive: a write into out/ of the workspace runs without asking; outside still asks', async () => {
    const write = (path: string) => () => [
      { kind: 'tool' as const, id: 'toolu_w', name: 'Write', input: { file_path: path, content: 'x' } },
    ];
    const inside = make({ script: write('out/summary.md') });
    const c = ctx();
    mkdirSync(join(c.workspaceRoot, 'out'));
    const ref = await start(inside.adapter, c);
    const events = await collectUntilStopped(inside.adapter, ref, 10_000);
    expect(kinds(events)).not.toContain('approval_request');
    expect(inside.sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'allow' });

    const out = make({ script: write('/etc/remyral-test') });
    const ref2 = await start(out.adapter, ctx());
    await readUntil(out.adapter, ref2, (e) => e.event.kind === 'approval_request', 5000);
    await out.adapter.requestApproval(ref2, {
      approvalId: 'toolu_w',
      decision: 'deny',
      decidedBy: 'a',
      reason: 'no',
    });
    await collectUntilStopped(out.adapter, ref2, 10_000);
    expect(out.sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
  });

  it('ask-all asks even for a workspace write', async () => {
    const { adapter } = make({
      script: () => [
        { kind: 'tool', id: 'toolu_w', name: 'Write', input: { file_path: 'a.md', content: 'x' } },
      ],
    });
    const ref = await start(adapter, ctx({ approvalPolicy: 'ask-all' }));
    const seen = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5000);
    expect(seen.at(-1)?.event).toMatchObject({ kind: 'approval_request', action: 'Write' });
    await adapter.requestApproval(ref, { approvalId: 'toolu_w', decision: 'approve', decidedBy: 'a' });
    await collectUntilStopped(adapter, ref, 10_000);
  });

  it('runtime-sandbox jobs get the Bash sandbox (fail closed, no network, no escape hatch)', async () => {
    const { adapter, sdk } = make({ script: basicTurn });
    const c = ctx({ sandboxProfile: 'runtime-sandbox' });
    const ref = await start(adapter, c);
    await collectUntilStopped(adapter, ref, 10_000);
    const sandbox = sdk.calls[0]?.options.sandbox;
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [] },
      filesystem: { allowWrite: [c.workspaceRoot], denyWrite: [join(c.workspaceRoot, '.git')] },
    });
    expect(sandbox?.filesystem?.denyRead?.length).toBeGreaterThan(0);
  });

  it('p6-warm-caches: the shared package cache dir is writable in the Bash sandbox, nothing else is added', async () => {
    const { adapter, sdk } = make({ script: basicTurn });
    const c = { ...ctx({ sandboxProfile: 'runtime-sandbox' }), extraWritableRoots: ['/d/caches/host/k'] };
    const ref = await start(adapter, c);
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.calls[0]?.options.sandbox?.filesystem?.allowWrite).toEqual([
      c.workspaceRoot,
      '/d/caches/host/k',
    ]);
  });

  it('a CLI that reports another permission mode is aborted (fail closed)', async () => {
    const { adapter } = make({ script: longTurn, reportedPermissionMode: 'bypassPermissions' });
    const ref = await start(adapter, ctx());
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'permission_mode_mismatch' }),
    );
    expect(await adapter.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'permission_mode_mismatch',
    });
  });
});

describePosix('claude-code adapter: auth modes (ADR-0014)', () => {
  it('never injects CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const { adapter } = make({ script: basicTurn });
    await adapter.probe();
    await expect(
      adapter.spawn(ctx({ secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: new SecretValue('oauth-token') } })),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
  });

  it('p13-runtime-accounts: local-login with an account dir runs with CLAUDE_CONFIG_DIR = that dir', async () => {
    const dir = join(root, 'runtime-accounts', 'claude-code', 'a1b2c3d4', '.claude');
    const { adapter, sdk } = make({ script: basicTurn }, { authMode: 'local-login', loginDir: dir });
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(dir);
    // secret-ref ignores it (its per-attempt config dir wins).
    const api = make({ script: basicTurn }, { loginDir: dir });
    const ref2 = await start(
      api.adapter,
      ctx({ secretEnv: { ANTHROPIC_API_KEY: new SecretValue('sk-ant-y') } }),
    );
    await collectUntilStopped(api.adapter, ref2, 10_000);
    expect(api.sdk.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toMatch(/cfg-/);
  });

  it('local-login refuses provider keys and uses no per-job config dir', async () => {
    const { CLAUDE_CONFIG_DIR: _ambient, ...sourceEnv } = process.env;
    const { adapter, sdk } = make({ script: basicTurn }, { authMode: 'local-login', sourceEnv });
    await adapter.probe();
    await expect(
      adapter.spawn(ctx({ secretEnv: { ANTHROPIC_API_KEY: new SecretValue('sk-ant-x') } })),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    // local-login probe reads only the runtime's own status (fake: loggedIn false).
    expect((await adapter.probe()).authenticated).toBe('no');
  });

  it('secret-ref secrets reach the CLI env through the spawner only, never argv', async () => {
    const plans: SpawnPlan[] = [];
    const confiner: ProcessConfiner = {
      kind: 'test:passthrough',
      confine: (plan) => {
        plans.push(plan);
        return Promise.resolve({ command: plan.command, args: plan.args, cwd: plan.cwd, env: plan.env });
      },
    };
    const { adapter } = make({ script: longTurn }, { confinerFor: () => confiner });
    const secret = new SecretValue('sk-ant-canary-abcdef');
    const c = ctx({ secretEnv: { ANTHROPIC_API_KEY: secret } });
    const ref = await start(adapter, c);
    const pids = await readPids(c.workspaceRoot);
    expect(pids.envNames).toContain('ANTHROPIC_API_KEY');
    expect(pids.envNames).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.stringify(pids.argv)).not.toContain(secret.reveal());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.secretNames).toEqual(['ANTHROPIC_API_KEY']);
    expect(plans[0]?.command).toBe(FAKE_CLI);
    await adapter.cancel(ref);
  });
});

describePosix('claude-code adapter: process tree, cancel, crash', () => {
  it('cleanup kills the CLI and its grandchild (owned process group)', async () => {
    const { adapter } = make({ script: longTurn });
    const c = ctx();
    const ref = await start(adapter, c);
    const pids = await readPids(c.workspaceRoot);
    expect(alive(pids.cli)).toBe(true);
    expect(alive(pids.grandchild)).toBe(true);
    await adapter.cleanup(ref);
    expect(await waitDead(pids.cli)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
  });

  it('cancel: interrupt() first, graceful when the CLI exits within the grace period', async () => {
    const { adapter, sdk } = make({ script: longTurn });
    const ref = await start(adapter, ctx());
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    const outcome = await adapter.cancel(ref, 'user');
    expect(outcome.mode).toBe('graceful');
    expect(sdk.queries[0]?.interrupts).toBe(1);
    expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
  });

  it('cancel: forced tree kill when interrupt hangs, within cancelMs', async () => {
    const { adapter } = make({ script: longTurn, ignoreInterrupt: true });
    const c = ctx();
    const ref = await start(adapter, c);
    const pids = await readPids(c.workspaceRoot);
    const t0 = Date.now();
    const outcome = await adapter.cancel(ref);
    expect(outcome.mode).toBe('forced');
    expect(Date.now() - t0).toBeLessThan(c.timeouts.cancelMs + 250);
    expect(await waitDead(pids.cli)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
    expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
  });

  it('a crashing CLI ends the session failed with runtime_crashed', async () => {
    const { adapter } = make({
      script: () => [{ kind: 'crash', message: 'Claude Code process exited with code 1' }],
    });
    const ref = await start(adapter, ctx());
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'runtime_crashed' }),
    );
    expect(await adapter.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'runtime_crashed',
    });
  });

  it('p22-runtime-diagnostics: a crash reports the real exit (signal) and its cause', async () => {
    const { adapter } = make({
      script: () => [{ kind: 'crash', message: 'Claude Code ended unexpectedly' }],
    });
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    const result = await adapter.collectResult(ref);
    expect(result).toMatchObject({
      outcome: 'failed',
      errorCode: 'runtime_crashed',
      exit: { code: null, signal: 'SIGKILL' },
      crash: { cause: 'killed', exit: { code: null, signal: 'SIGKILL' } },
    });
    expect(result.summary).toContain('signal SIGKILL');
  });

  it('p22-runtime-diagnostics: a CLI that dies during start-up is not "exit unknown"', async () => {
    const { adapter } = make({
      script: basicTurn,
      failInit: { message: 'Claude Code process terminated by signal SIGKILL', signal: 'SIGKILL' },
    });
    await adapter.probe();
    const err = await adapter.spawn(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeCrashedError);
    const crashed = err as RuntimeCrashedError;
    expect(crashed.message).not.toContain('exit unknown');
    expect(crashed.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(crashed.diagnosis).toMatchObject({ cause: 'killed' });
    expect(adapter.liveSessionCount).toBe(0);
  });

  it('p22-runtime-diagnostics: a start-up failure names a usage limit / an overloaded API', async () => {
    const limited = make({
      script: basicTurn,
      failInit: {
        message: 'Claude Code process exited with code 1. stderr: Claude AI usage limit reached|1767225600',
      },
    });
    await limited.adapter.probe();
    const a = (await limited.adapter.spawn(ctx()).catch((e: unknown) => e)) as RuntimeCrashedError;
    expect(a.diagnosis?.cause).toBe('usage_limit');
    const busy = make({
      script: basicTurn,
      failInit: {
        message: 'Claude Code process exited with code 1. stderr: API Error: 529 {"type":"overloaded_error"}',
      },
    });
    await busy.adapter.probe();
    const b = (await busy.adapter.spawn(ctx()).catch((e: unknown) => e)) as RuntimeCrashedError;
    expect(b.diagnosis?.cause).toBe('provider_overloaded');
    expect(b.diagnosis?.stderrTail.length).toBeLessThanOrEqual(2000);
  });

  it('max duration ends the session failed (max_duration_exceeded)', async () => {
    const { adapter } = make({ script: longTurn });
    const c = ctx({
      timeouts: {
        startupMs: 5_000,
        cancelGraceMs: 200,
        cancelMs: 1_000,
        approvalMs: 5_000,
        maxDurationMs: 300,
      },
    });
    const ref = await start(adapter, c);
    await collectUntilStopped(adapter, ref, 5_000);
    expect(await adapter.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'max_duration_exceeded',
    });
  });
});

describePosix('claude-code adapter: follow-up messages during a run (p5-live-fixes-2)', () => {
  const slowTurn: FakeTurnScript = (prompt, turn) => [
    ...(turn === 1 ? [{ kind: 'block', ms: 300 } as const] : []),
    ...basicTurn(prompt, turn),
  ];
  const texts = (events: readonly SequencedEvent[]) =>
    events.flatMap((e) => (e.event.kind === 'message' ? [e.event.text] : []));
  const notDelivered = (events: readonly SequencedEvent[]) =>
    events.filter((e) => e.event.kind === 'error' && e.event.code === 'message_not_delivered');

  for (const echo of [true, false]) {
    it(`a message sent mid-turn reaches the agent at the next turn boundary (uuid echo: ${String(echo)})`, async () => {
      // Like the real CLI: prompts not yet started are dropped when the input ends.
      const { adapter } = make(
        { script: slowTurn, dropQueuedOnInputEnd: true, echoUserMessageUuids: echo },
        { followUpGraceMs: 2_000 },
      );
      const ref = await start(adapter, ctx());
      await new Promise((r) => setTimeout(r, 50));
      await adapter.sendPrompt(ref, { text: 'also update the docs' });
      const events = await collectUntilStopped(adapter, ref, 10_000);
      expect(texts(events)).toContain(
        'Message queued for the agent; it is delivered at the next turn boundary.',
      );
      expect(texts(events)).toContain('ack: also update the docs');
      expect(notDelivered(events)).toHaveLength(0);
      expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
    });
  }

  it('a message the agent never took is reported as not delivered when the run ends', async () => {
    // The CLI is killed mid-turn (forced cancel): the queued follow-up never starts a turn.
    const { adapter } = make({ script: longTurn, ignoreInterrupt: true });
    const ref = await start(adapter, ctx());
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    await adapter.sendPrompt(ref, { text: 'stop after this' });
    await adapter.cancel(ref, 'user');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    const nd = notDelivered(events);
    expect(nd).toHaveLength(1);
    expect(nd[0]?.event).toMatchObject({
      message: 'Not delivered: the run ended before the agent took the message.',
    });
  });

  // p15-message-delivery: receipts per case.
  for (const echo of [true, false]) {
    it(`p15: a mid-turn message is reported consumed once the next turn takes it (uuid echo: ${String(echo)})`, async () => {
      const { adapter } = make(
        { script: slowTurn, dropQueuedOnInputEnd: true, echoUserMessageUuids: echo },
        { followUpGraceMs: 2_000 },
      );
      const ref = await start(adapter, ctx());
      await new Promise((r) => setTimeout(r, 50));
      const receipts: unknown[] = [];
      await adapter.sendPrompt(ref, { text: 'also lint', onReceipt: (r) => receipts.push(r) });
      // Queued, not consumed while the first turn still runs.
      expect(receipts).toEqual([]);
      await collectUntilStopped(adapter, ref, 10_000);
      expect(receipts).toEqual([{ kind: 'consumed' }]);
    });
  }

  it('p15: a message the run never reached is reported dropped (exactly once)', async () => {
    const { adapter } = make({ script: longTurn, ignoreInterrupt: true });
    const ref = await start(adapter, ctx());
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    const receipts: { kind: string }[] = [];
    await adapter.sendPrompt(ref, { text: 'stop after this', onReceipt: (r) => receipts.push(r) });
    await adapter.cancel(ref, 'user');
    await collectUntilStopped(adapter, ref, 10_000);
    expect(receipts.map((r) => r.kind)).toEqual(['dropped']);
  });

  it('p15: a message while an approval is pending is queued and taken after the decision', async () => {
    const once: FakeTurnScript = (prompt, turn) =>
      turn === 1 ? approvalTurn(prompt, turn) : basicTurn(prompt, turn);
    const { adapter } = make({ script: once }, { followUpGraceMs: 2_000 });
    const ref = await start(adapter, ctx());
    await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5000);
    const receipts: { kind: string }[] = [];
    await adapter.sendPrompt(ref, { text: 'use the staging remote', onReceipt: (r) => receipts.push(r) });
    expect(receipts).toEqual([]);
    await adapter.requestApproval(ref, { approvalId: 'toolu_push_1', decision: 'approve', decidedBy: 'a' });
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(texts(events)).toContain('ack: use the staging remote');
    expect(receipts.map((r) => r.kind)).toEqual(['consumed']);
  });

  it('p15: after the turn finished (input ended) a message is refused, never accepted silently', async () => {
    const { adapter } = make({ script: basicTurn });
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    const receipts: unknown[] = [];
    await expect(
      adapter.sendPrompt(ref, { text: 'too late', onReceipt: (r) => receipts.push(r) }),
    ).rejects.toThrow(/cannot send a prompt|turn has finished/);
    expect(receipts).toEqual([]);
  });
});

describePosix('claude-code adapter: approvals via canUseTool', () => {
  it('approve → tool allowed; the decision is the human one', async () => {
    const { adapter, sdk } = make({ script: approvalTurn });
    const ref = await start(adapter, ctx());
    const seen = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5000);
    const req = seen.at(-1)?.event;
    expect(req).toMatchObject({
      kind: 'approval_request',
      approvalId: 'toolu_push_1',
      action: 'Bash',
      risk: 'high',
      // p10-approval-readable: the structured fields (no description in this input).
      details: { tool: 'Bash', command: 'git push origin work', shell: 'posix' },
    });
    expect(req?.kind === 'approval_request' ? req.details?.description : 'n/a').toBeUndefined();
    await adapter.requestApproval(ref, {
      approvalId: 'toolu_push_1',
      decision: 'approve',
      decidedBy: 'alice',
    });
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'allow' });
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
  });

  it('p10-approval-readable: PowerShell with a description → details (description, full command, redacted)', async () => {
    const command = `$t = "tok-SECRETVALUE"; Invoke-WebRequest https://example.com -OutFile out\\page.html`;
    const { adapter } = make({
      script: () => [
        {
          kind: 'tool',
          id: 'toolu_ps_1',
          name: 'PowerShell',
          input: { command, description: 'Download the page', timeout: 1000 },
        },
      ],
    });
    const ref = await start(adapter, ctx({ secretEnv: { API_TOKEN: new SecretValue('tok-SECRETVALUE') } }));
    const seen = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5000);
    const req = seen.at(-1)?.event;
    if (req?.kind !== 'approval_request') throw new Error('no approval request');
    expect(req.details).toMatchObject({
      tool: 'PowerShell',
      description: 'Download the page',
      shell: 'powershell',
    });
    expect(req.details?.command).toContain('Invoke-WebRequest https://example.com -OutFile out\\page.html');
    expect(req.details?.command).not.toContain('SECRETVALUE');
    expect(req.details?.workspaceRoot).toBeDefined();
    await adapter.requestApproval(ref, { approvalId: 'toolu_ps_1', decision: 'deny', decidedBy: 'alice' });
    await collectUntilStopped(adapter, ref, 10_000);
  });

  it('no decision within approvalMs → deny (fail closed)', async () => {
    const { adapter, sdk } = make({ script: approvalTurn });
    const c = ctx({
      timeouts: {
        startupMs: 5_000,
        cancelGraceMs: 500,
        cancelMs: 2_000,
        approvalMs: 150,
        maxDurationMs: 60_000,
      },
    });
    const ref = await start(adapter, c);
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
  });

  it('without policy allowUnverified the (unverified) approval channel is not offered: deny + error, requestApproval rejects', async () => {
    const { adapter, sdk } = make({ script: approvalTurn });
    const ref = await start(adapter, ctx({ allowUnverified: false }));
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(kinds(events)).not.toContain('approval_request');
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'approval_unavailable' }),
    );
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
    await expect(
      adapter.requestApproval(ref, { approvalId: 'x', decision: 'approve', decidedBy: 'a' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });
});

describePosix('claude-code adapter: usage and cost provenance (ADR-0014 / p6-cost)', () => {
  it('secret-ref: per-model increments, cost reported-by-runtime', async () => {
    const { adapter } = make({ script: basicTurn });
    const ref = await start(adapter, ctx());
    const events = await collectUntilStopped(adapter, ref, 10_000);
    const usage = events.map((e) => e.event).filter((e) => e.kind === 'usage');
    expect(usage).toEqual([
      {
        kind: 'usage',
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 40,
        cacheWriteTokens: 8,
        turns: 2,
        durationMs: 120,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        authMode: 'secret-ref',
        costUsd: 0.0012,
        provenance: 'reported-by-runtime',
      },
    ]);
  });

  it('local-login: tokens only, no dollar figure anywhere', async () => {
    const { adapter } = make({ script: basicTurn }, { authMode: 'local-login' });
    const ref = await start(adapter, ctx());
    const events = await collectUntilStopped(adapter, ref, 10_000);
    const usage = events.map((e) => e.event).filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ authMode: 'local-login', provenance: 'estimated-from-tokens' });
    expect(usage[0]).not.toHaveProperty('costUsd');
  });

  it('getCost is unknown while cost_reporting is unverified (ADR-0008)', async () => {
    const { adapter } = make({ script: basicTurn });
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    expect(await adapter.getCost(ref)).toEqual({ provenance: 'unknown' });
  });
});

describePosix('claude-code adapter: version gate (ADR-0012 rule 1)', () => {
  it('a foreign SDK version is not the pin: all capabilities unverified, spawn refused unless allowed', async () => {
    const { adapter } = make(
      { script: basicTurn },
      { sdkInfo: () => ({ sdkVersion: '0.3.297', claudeCodeVersion: '2.1.297', packageDir: root }) },
    );
    const probe = await adapter.probe();
    expect(probe.versionMatchesPin).toBe(false);
    for (const entry of Object.values(probe.capabilities.capabilities)) {
      expect(['unverified', 'unsupported']).toContain(entry.status);
    }
    await expect(adapter.spawn(ctx({ allowUnverified: false }))).rejects.toBeInstanceOf(VersionMismatchError);
  });

  it('on the pin, artifacts are unsupported (worker git diff) and nothing is claimed supported', async () => {
    const { adapter } = make({ script: basicTurn });
    const probe = await adapter.probe();
    expect(probe.version).toBe('2.1.310');
    expect(probe.versionMatchesPin).toBe(true);
    expect(probe.capabilities.capabilities.artifacts.status).toBe('unsupported');
    for (const entry of Object.values(probe.capabilities.capabilities))
      expect(entry.status).not.toBe('supported');
  });
});

describePosix('claude-code adapter: p8-orchestration sub-job tools (ADR-0031)', () => {
  class McpSdk extends FakeClaudeSdk {
    readonly servers: { name: string; tools: { name: string }[] }[] = [];
    createSdkMcpServer = ((o: { name: string; tools: { name: string }[] }) => {
      this.servers.push(o);
      return { type: 'sdk', name: o.name };
    }) as never;
    tool = ((name: string) => ({ name })) as never;
  }
  const host: SubtaskToolHost = {
    request: () => Promise.resolve({ ok: true, text: 'queued' }),
    wait: () => Promise.resolve({ ok: true, text: 'running' }),
    cancel: () => Promise.resolve({ ok: true, text: 'cancelled' }),
  };

  it('registers the remyral-subtasks server and pre-approves exactly its tools, also in dontAsk mode', async () => {
    const sdk = new McpSdk({ script: basicTurn });
    const { adapter } = make({ script: basicTurn }, { sdk });
    const ref = await start(adapter, ctx({ subtaskTools: host, approvalPolicy: 'deny-sensitive' }));
    await collectUntilStopped(adapter, ref, 10_000);
    const o = sdk.calls[0]?.options;
    expect(Object.keys(o?.mcpServers ?? {})).toEqual(['remyral-subtasks']);
    expect(o?.allowedTools).toEqual([
      'mcp__remyral-subtasks__request_subtask',
      'mcp__remyral-subtasks__wait_subtask',
      'mcp__remyral-subtasks__cancel_subtask',
    ]);
    expect(o?.permissionMode).toBe('dontAsk');
    expect(sdk.servers[0]?.tools.map((t) => t.name)).toEqual([
      'request_subtask',
      'wait_subtask',
      'cancel_subtask',
    ]);
  });

  it('without sub-job tools nothing is registered or pre-approved', async () => {
    const sdk = new McpSdk({ script: basicTurn });
    const { adapter } = make({ script: basicTurn }, { sdk });
    const ref = await start(adapter, ctx());
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.calls[0]?.options.mcpServers).toEqual({});
    expect(sdk.calls[0]?.options.allowedTools).toBeUndefined();
    expect(sdk.servers).toHaveLength(0);
  });
});

describe('claude code auth status parsing (p14-login-status-consistency)', () => {
  it('reads the JSON object also when the CLI prints a notice around it, as the login relay does', async () => {
    const { parseAuthStatusJson } = await import('../../../src/runtimes/claude-code/adapter.js');
    expect(parseAuthStatusJson('{"loggedIn":true}\n')).toEqual({ loggedIn: true });
    expect(parseAuthStatusJson('Update available: 9.9.9\n{\n  "loggedIn": true\n}\n')).toEqual({
      loggedIn: true,
    });
    expect(() => parseAuthStatusJson('not json')).toThrow();
  });
});
