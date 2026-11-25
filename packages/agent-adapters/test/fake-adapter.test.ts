import { tmpdir } from 'node:os';
import { AttemptId, JobId } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  approvalScript,
  CancelTimeoutError,
  CapabilityUnsupportedError,
  FakeRuntimeAdapter,
  InvalidSpawnContextError,
  longRunningScript,
  SecretValue,
  SessionNotFoundError,
  VersionMismatchError,
  type FakeAdapterOptions,
  type SpawnContext,
} from '../src/index.js';
import { collectUntilStopped, findSecretLeaks, readUntil } from '../src/testing/index.js';

function ctx(over: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-1'),
    attemptId: AttemptId.parse('a-1'),
    workspaceRoot: tmpdir(),
    job: { runtime: 'codex', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: { API_KEY: new SecretValue('sk-test-canary-0001') },
    timeouts: { startupMs: 1000, cancelGraceMs: 100, cancelMs: 500, approvalMs: 200, maxDurationMs: 60_000 },
    signal: new AbortController().signal,
    ...over,
  };
}

const make = (o: FakeAdapterOptions = {}) => new FakeRuntimeAdapter(o);

describe('FakeRuntimeAdapter specifics', () => {
  it('capabilities() is all-unverified before probe()', async () => {
    const a = make();
    expect(Object.values(a.capabilities().capabilities).every((e) => e.status === 'unverified')).toBe(true);
    await a.probe();
    expect(a.capabilities().capabilities.streaming.status).toBe('supported');
  });

  it('refuses a version that differs from the pin unless unverified is allowed', async () => {
    const a = make({ version: '2.0.0', pinnedVersion: '1.0.0' });
    const probe = await a.probe();
    expect(probe.versionMatchesPin).toBe(false);
    expect(probe.capabilities.capabilities.streaming.status).toBe('unverified');
    await expect(a.spawn(ctx())).rejects.toBeInstanceOf(VersionMismatchError);
    const ref = await a.spawn(ctx({ allowUnverified: true }));
    await a.cleanup(ref);
  });

  it('validates the spawn context (absolute workspace, runtime, repoConfig, timeouts)', async () => {
    const a = make();
    await expect(a.spawn(ctx({ workspaceRoot: 'relative/dir' }))).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
    await expect(
      a.spawn(ctx({ job: { runtime: 'pi', prompt: 'p', limits: { maxDurationSec: 1 } } })),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
    await expect(
      a.spawn(ctx({ repoConfig: 'use-repository-config' as unknown as 'ignore-repository-config' })),
    ).rejects.toThrow(/ADR-0012 rule 3/);
    await expect(
      a.spawn(
        ctx({
          timeouts: { startupMs: 1, cancelGraceMs: 500, cancelMs: 100, approvalMs: 1, maxDurationMs: 1 },
        }),
      ),
    ).rejects.toThrow(/cancelMs/);
  });

  it('approval denial and approval timeout both fail closed', async () => {
    const a = make({ script: approvalScript });
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    await readUntil(a, ref, (e) => e.event.kind === 'approval_request', 1000);
    await a.requestApproval(ref, { approvalId: 'appr-1', decision: 'deny', decidedBy: 'alice' });
    const events = (await collectUntilStopped(a, ref, 1000)).map((e) => e.event);
    expect(events).toContainEqual({
      kind: 'tool_result',
      callId: 'appr-1',
      ok: false,
      outputSummary: 'git.push denied',
    });

    const ref2 = await a.spawn(ctx());
    await a.sendPrompt(ref2, { text: 'go' });
    const events2 = (await collectUntilStopped(a, ref2, 2000)).map((e) => e.event);
    expect(events2).toContainEqual({
      kind: 'tool_result',
      callId: 'appr-1',
      ok: false,
      outputSummary: 'git.push denied',
    });
  });

  it('without an approval capability, a gated step is denied and requestApproval is rejected', async () => {
    const a = make({
      script: approvalScript,
      capabilities: { approval: { status: 'unsupported', reason: 'no channel' } },
    });
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    const events = (await collectUntilStopped(a, ref, 1000)).map((e) => e.event);
    expect(events.some((e) => e.kind === 'approval_request')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'approval_unavailable' }));
    await expect(
      a.requestApproval(ref, { approvalId: 'appr-1', decision: 'approve', decidedBy: 'x' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  it('slow cancel beyond the grace period is reported as forced', async () => {
    const a = make({ script: longRunningScript, cancel: { gracefulDelayMs: 10_000 } });
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    const t0 = Date.now();
    const out = await a.cancel(ref);
    expect(out.mode).toBe('forced');
    expect(Date.now() - t0).toBeLessThan(400);
    expect((await a.collectResult(ref)).outcome).toBe('cancelled');
  });

  it('a hanging cancel rejects with CancelTimeoutError after cancelMs', async () => {
    const a = make({ script: longRunningScript, cancel: { hang: true } });
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    await expect(a.cancel(ref)).rejects.toBeInstanceOf(CancelTimeoutError);
    await a.cleanup(ref);
    expect(a.liveSessionCount).toBe(0);
  });

  it('a crash step ends the session failed with an error event', async () => {
    const a = make({ script: () => [{ kind: 'crash', message: 'segfault' }] });
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    const events = (await collectUntilStopped(a, ref, 1000)).map((e) => e.event);
    expect(events).toContainEqual({ kind: 'error', code: 'runtime_crashed', message: 'segfault' });
    expect(await a.collectResult(ref)).toMatchObject({ outcome: 'failed', errorCode: 'runtime_crashed' });
  });

  it('cost: sums usage with provenance; unknown when cost_reporting is unsupported', async () => {
    const a = make({ costProvenance: 'estimated-from-tokens' });
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    await collectUntilStopped(a, ref, 1000);
    expect(await a.getCost(ref)).toEqual({
      provenance: 'estimated-from-tokens',
      costUsd: 0.0012,
      inputTokens: 120,
      outputTokens: 30,
    });
    const b = make({ capabilities: { cost_reporting: { status: 'unsupported', reason: 'tokens only' } } });
    const refB = await b.spawn(ctx());
    expect(await b.getCost(refB)).toEqual({ provenance: 'unknown' });
  });

  it('unknown or cleaned-up sessions reject with SessionNotFoundError', async () => {
    const a = make();
    const ref = await a.spawn(ctx());
    await a.cleanup(ref);
    await expect(a.sendPrompt(ref, { text: 'x' })).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(a.cancel(ref)).rejects.toBeInstanceOf(SessionNotFoundError);
    const it = a.events(ref)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('the canary detector catches a runtime that echoes a secret', async () => {
    const secretEnv = { API_KEY: new SecretValue('sk-leak-me-please') };
    const a = make({ script: () => [{ kind: 'leak-secret', envName: 'API_KEY' }] });
    const ref = await a.spawn(ctx({ secretEnv }));
    await a.sendPrompt(ref, { text: 'go' });
    const events = await collectUntilStopped(a, ref, 1000);
    expect(findSecretLeaks([events], secretEnv)).toEqual(['API_KEY in value #0']);
  });

  it('resume creates a new session continuing the runtime session id', async () => {
    const a = make();
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    await collectUntilStopped(a, ref, 1000);
    const resumed = await a.resume(ref, ctx());
    expect(resumed.runtimeSessionId).toBe(ref.runtimeSessionId);
    expect(resumed.sessionId).not.toBe(ref.sessionId);
  });
});

describe('FakeRuntimeAdapter follow-ups (p15-message-delivery)', () => {
  const twoStep = () =>
    [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'first' } },
      { kind: 'sleep', ms: 80 },
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'second' } },
    ] as const;

  it('steer: consumed at the next agent output', async () => {
    const a = make({ script: twoStep });
    await a.probe();
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    await readUntil(a, ref, (e) => e.event.kind === 'message' && e.event.role === 'assistant', 1000);
    const receipts: string[] = [];
    await a.sendPrompt(ref, { text: 'more', onReceipt: (r) => receipts.push(r.kind) });
    expect(receipts).toEqual([]);
    await collectUntilStopped(a, ref, 2000);
    expect(receipts).toEqual(['consumed']);
    await a.cleanup(ref);
  });

  it('next-turn: consumed at the turn boundary; dropped when the session is cancelled first', async () => {
    const a = make({ script: twoStep, followUps: 'next-turn' });
    await a.probe();
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    const receipts: string[] = [];
    await a.sendPrompt(ref, { text: 'more', onReceipt: (r) => receipts.push(r.kind) });
    const events = await collectUntilStopped(a, ref, 3000);
    expect(receipts).toEqual(['consumed']);
    expect(events.filter((e) => e.event.kind === 'message' && e.event.role === 'assistant')).toHaveLength(4);
    await a.cleanup(ref);

    const b = make({ script: longRunningScript, followUps: 'next-turn' });
    await b.probe();
    const r2 = await b.spawn(ctx());
    await b.sendPrompt(r2, { text: 'go' });
    const dropped: string[] = [];
    await b.sendPrompt(r2, { text: 'more', onReceipt: (r) => dropped.push(r.kind) });
    await b.cancel(r2);
    expect(dropped).toEqual(['dropped']);
    await b.cleanup(r2);
  });

  it('refuseFollowUps / a stopped session: the follow-up rejects and is not recorded', async () => {
    const a = make({ script: longRunningScript, refuseFollowUps: 'no steering now' });
    await a.probe();
    const ref = await a.spawn(ctx());
    await a.sendPrompt(ref, { text: 'go' });
    await expect(a.sendPrompt(ref, { text: 'more' })).rejects.toThrow('no steering now');
    await a.cancel(ref);
    const events = await collectUntilStopped(a, ref, 2000);
    expect(events.some((e) => e.event.kind === 'message' && e.event.text === 'more')).toBe(false);
    await expect(a.sendPrompt(ref, { text: 'later' })).rejects.toThrow();
    await a.cleanup(ref);
  });
});
