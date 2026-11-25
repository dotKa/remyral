import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createClaudeCodeAdapter,
  InvalidSpawnContextError,
  SessionNotFoundError,
  SessionStateError,
  type ClaudeCodeAdapterOptions,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped, readUntil } from '../../../src/testing/index.js';
import {
  approvalTurn,
  basicTurn,
  FAKE_CLI,
  FakeClaudeSdk,
  type FakeSdkOptions,
} from '../../fixtures/claude-code/fake-sdk.js';

/** p10-approval-pause: park a stopped Claude Code session and resume it from a new adapter instance. */
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const root = mkdtempSync(join(tmpdir(), 'remyral-claude-park-'));
const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(workspaceRoot: string, overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-claude-park'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot,
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

function make(stateDir: string, fake: FakeSdkOptions, extra: ClaudeCodeAdapterOptions = {}) {
  const sdk = new FakeClaudeSdk(fake);
  const adapter = createClaudeCodeAdapter({
    binaryPath: FAKE_CLI,
    sdkInfo,
    sdk,
    stateDir,
    sourceEnv: { ...process.env },
    ...extra,
  });
  return { adapter, sdk };
}

describePosix('claude-code adapter: park and resume (p10-approval-pause)', () => {
  it('parks a session stopped while waiting for an approval and resumes it from a new instance', async () => {
    const stateDir = join(root, 'state-1');
    const ws = mkdtempSync(join(root, 'ws-'));
    const first = make(stateDir, { script: approvalTurn });
    await first.adapter.probe();
    const ref = await first.adapter.spawn(ctx(ws));
    await first.adapter.sendPrompt(ref, { text: 'push it' });
    await readUntil(first.adapter, ref, (e) => e.event.kind === 'approval_request', 5_000);
    await first.adapter.cancel(ref, 'paused');
    const parked = await first.adapter.parkSession(ref);
    const sessionId = first.sdk.queries[0]?.sessionId;
    expect(parked.runtime).toBe('claude-code');
    expect(parked.runtimeSessionId).toBe(sessionId);
    const rel = parked.state?.configDir ?? '';
    expect(rel).toMatch(/^cfg-/);
    expect(isAbsolute(rel)).toBe(false);
    const configDir = join(stateDir, rel);
    expect(first.sdk.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
    await first.adapter.cleanup(ref);
    // The transcripts survive the cleanup of the parked session.
    expect(existsSync(configDir)).toBe(true);

    const second = make(stateDir, { script: basicTurn });
    const resumed = await second.adapter.resumeParked(ctx(ws), parked);
    expect(resumed.runtimeSessionId).toBe(sessionId);
    const o = second.sdk.calls[0]?.options;
    expect(o?.resume).toBe(sessionId);
    expect(o?.sessionId).toBeUndefined();
    expect(o?.cwd).toBe(ws);
    expect(o?.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
    // No prompt was sent by the resume itself.
    await second.adapter.sendPrompt(resumed, { text: 'The owner approved it; re-run it now.' });
    await collectUntilStopped(second.adapter, resumed, 10_000);
    expect((await second.adapter.collectResult(resumed)).outcome).toBe('succeeded');
    await second.adapter.cleanup(resumed);
    // Not parked again: the resumed session owns the dir and removes it.
    expect(existsSync(configDir)).toBe(false);
  });

  it('the interrupt a pause asks for is not reported as an error (live 2026-10-18: error_during_execution)', async () => {
    const stateDir = join(root, 'state-interrupt');
    const ws = mkdtempSync(join(root, 'ws-'));
    const { adapter, sdk } = make(stateDir, { script: approvalTurn });
    await adapter.probe();
    const ref = await adapter.spawn(ctx(ws));
    await adapter.sendPrompt(ref, { text: 'push it' });
    await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5_000);
    await adapter.cancel(ref, 'paused');
    expect(sdk.queries[0]?.interrupts).toBeGreaterThan(0);
    const events = await collectUntilStopped(adapter, ref, 5_000);
    const errors = events.filter((e) => e.event.kind === 'error');
    expect(errors.map((e) => (e.event.kind === 'error' ? e.event.code : ''))).not.toContain(
      'error_during_execution',
    );
    expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
    await adapter.cleanup(ref);
  });

  it('refuses to park a running session or one that never reported a session id', async () => {
    const stateDir = join(root, 'state-2');
    const { adapter } = make(stateDir, { script: approvalTurn });
    await adapter.probe();
    const running = await adapter.spawn(ctx(mkdtempSync(join(root, 'ws-'))));
    await adapter.sendPrompt(running, { text: 'go' });
    await readUntil(adapter, running, (e) => e.event.kind === 'approval_request', 5_000);
    await expect(adapter.parkSession(running)).rejects.toBeInstanceOf(SessionStateError);
    await adapter.cleanup(running);

    const idle = await adapter.spawn(ctx(mkdtempSync(join(root, 'ws-'))));
    await adapter.cancel(idle);
    await expect(adapter.parkSession(idle)).rejects.toBeInstanceOf(SessionStateError);
    await adapter.cleanup(idle);
  });

  it('refuses tampered or missing parked state', async () => {
    const stateDir = join(root, 'state-3');
    mkdirSync(stateDir, { recursive: true });
    const { adapter } = make(stateDir, { script: basicTurn });
    const ws = mkdtempSync(join(root, 'ws-'));
    const base = {
      runtime: 'claude-code' as const,
      runtimeSessionId: '7f1d3c1e-0000-4000-8000-000000000001',
    };
    for (const configDir of ['/etc', '../outside', 'cfg-x/../../outside', '']) {
      await expect(adapter.resumeParked(ctx(ws), { ...base, state: { configDir } })).rejects.toBeInstanceOf(
        InvalidSpawnContextError,
      );
    }
    await expect(adapter.resumeParked(ctx(ws), base)).rejects.toBeInstanceOf(InvalidSpawnContextError);
    await expect(
      adapter.resumeParked(ctx(ws), { ...base, state: { configDir: 'cfg-missing' } }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      adapter.resumeParked(ctx(ws), { ...base, runtimeSessionId: '../x', state: { configDir: 'cfg-a' } }),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
    await expect(
      adapter.resumeParked(ctx(ws), { ...base, runtime: 'codex', state: { configDir: 'cfg-a' } }),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
  });

  it('gates the resume on the resume capability (unverified until live)', async () => {
    const stateDir = join(root, 'state-4');
    mkdirSync(join(stateDir, 'cfg-a'), { recursive: true });
    const { adapter, sdk } = make(stateDir, { script: basicTurn });
    await expect(
      adapter.resumeParked(ctx(mkdtempSync(join(root, 'ws-')), { allowUnverified: false }), {
        runtime: 'claude-code',
        runtimeSessionId: '7f1d3c1e-0000-4000-8000-000000000002',
        state: { configDir: 'cfg-a' },
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    expect(sdk.calls).toHaveLength(0);
  });
});
