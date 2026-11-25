/**
 * p17-runtime-verify: the capability scenario set (src/verification) against the fake runtimes of every runtime — the
 * same stand-ins the contract kit uses (Claude Code: fake SDK + owned fake CLI; Codex: the fake app-server speaking the
 * generated protocol; Pi / OpenCode: the fixture processes), on a platform the static tables do not cover, plus a
 * failing capability, a declared-unsupported one and the time / token budgets. No model is called.
 */
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptId, type CapabilityCheckResult, JobId, type RuntimeKind } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  adapterRevision,
  type AgentAdapter,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createOpenCodeAdapter,
  createPiAdapter,
  abortableSleep,
  declaredStatuses,
  defaultVerificationPrompts,
  runCapabilityVerification,
  type SpawnContext,
  type VerificationOptions,
  type VerificationPrompts,
  type VerificationSession,
  raceTimeout,
} from '../src/index.js';
import {
  approvalTurn,
  basicTurn,
  FAKE_CLI,
  FakeClaudeSdk,
  longTurn,
  type FakeTurnScript,
} from './fixtures/claude-code/fake-sdk.js';
import { codexTestStateDir, FAKE_APP_SERVER } from './fixtures/codex/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(here, 'fixtures', 'pi', 'fake-pi.mjs');
const FAKE_OC = join(here, 'fixtures', 'opencode', 'fake-opencode.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-verify-'));
const codexState = codexTestStateDir();
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(codexState, { recursive: true, force: true });
});
const posix = process.platform !== 'win32';

const TIMEOUTS = {
  startupMs: 10_000,
  cancelGraceMs: 500,
  cancelMs: 3_000,
  approvalMs: 5_000,
  maxDurationMs: 60_000,
};

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function context(runtime: RuntimeKind, ws: string) {
  return (
    _session: VerificationSession,
    input: { signal: AbortSignal; approvalPolicy: SpawnContext['approvalPolicy'] },
  ): SpawnContext => ({
    jobId: JobId.parse('verify-test'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: ws,
    job: { runtime, prompt: 'verification', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: input.approvalPolicy,
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: TIMEOUTS,
    allowUnverified: true,
    signal: input.signal,
  });
}

/** Scripted prompts of the fakes; nothing is written to disk by them, so file / text checks are off. */
function scripted(task: string, long: string, resume: string): Partial<VerificationPrompts> {
  return {
    task,
    long,
    resume,
    followUp: 'follow-up',
    expectFile: null,
    expectResumeText: null,
    longMarker: 'sleep 600',
  };
}

const claudeScript: FakeTurnScript = (prompt, turn) =>
  prompt.includes('long')
    ? longTurn(prompt, turn)
    : prompt.includes('resume')
      ? basicTurn(prompt, turn)
      : approvalTurn(prompt, turn);

const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });

const RUNTIMES: Record<
  RuntimeKind,
  { adapter: (s: VerificationSession) => AgentAdapter; prompts: Partial<VerificationPrompts> }
> = {
  'claude-code': {
    adapter: () =>
      createClaudeCodeAdapter({
        authMode: 'secret-ref',
        binaryPath: FAKE_CLI,
        sdkInfo,
        sdk: new FakeClaudeSdk({ script: claudeScript }),
        stateDir: join(root, 'claude', randomUUID()),
        credentialConfigured: true,
      }),
    prompts: scripted('approval task', 'long command', 'resume question'),
  },
  codex: {
    adapter: () =>
      createCodexAdapter({
        authMode: 'secret-ref',
        codexPath: FAKE_APP_SERVER,
        stateDir: codexState,
        credentialConfigured: true,
      }),
    prompts: scripted(
      'Verification: approval for one sensitive action.',
      'Verification: long command until cancelled.',
      'Verification: reply with the word done.',
    ),
  },
  pi: {
    adapter: () =>
      createPiAdapter({
        command: process.execPath,
        commandArgs: [FAKE_PI],
        stateDir: join(root, 'pi', randomUUID()),
        authMode: 'secret-ref',
        model: 'remyral-faux/scripted',
        // The case p17 exists for: a platform the static table has not contract-tested (all `unverified`).
        platform: { os: 'win32', arch: 'x64' },
      }),
    prompts: scripted('faux:approval', 'faux:longtool', 'faux:basic resume'),
  },
  opencode: {
    adapter: () =>
      createOpenCodeAdapter({
        command: process.execPath,
        commandArgs: [FAKE_OC],
        stateDir: join(root, 'oc', randomUUID()),
        authMode: 'secret-ref',
        model: 'fake/scripted',
        platform: { os: 'win32', arch: 'x64' },
      }),
    prompts: scripted('faux:approval', 'faux:longtool', 'faux:basic resume'),
  },
};

function options(runtime: RuntimeKind, over: Partial<VerificationOptions> = {}): VerificationOptions {
  const ws = workspace();
  return {
    runtime,
    adapter: RUNTIMES[runtime].adapter,
    context: context(runtime, ws),
    workspace: ws,
    budget: { maxDurationSec: 120, maxTokens: 1_000_000 },
    prompts: RUNTIMES[runtime].prompts,
    processes: () => Promise.resolve([]),
    settleMs: 50,
    sessionTimeoutMs: 20_000,
    ...over,
  };
}

const byCap = (results: readonly CapabilityCheckResult[]) =>
  Object.fromEntries(results.map((r) => [r.capability, r.status]));

describe.skipIf(!posix)('capability verification against the fake runtimes', { timeout: 90_000 }, () => {
  for (const runtime of ['claude-code', 'codex', 'pi', 'opencode'] as const) {
    it(`${runtime}: one result per capability, declared-unsupported skipped, the rest passed`, async () => {
      const progress: string[] = [];
      const run = await runCapabilityVerification(
        options(runtime, {
          onProgress: (step) => {
            progress.push(step);
          },
        }),
      );
      expect(run.results.map((r) => r.capability)).toEqual([
        'streaming',
        'interactive_prompt',
        'approval',
        'cancel',
        'safe_cancel',
        'resume',
        'cost_reporting',
        'artifacts',
      ]);
      const declared = declaredStatuses(runtime);
      for (const r of run.results) {
        expect(r.reason.length).toBeGreaterThan(0);
        if (declared[r.capability] === 'unsupported') expect(r.status).toBe('skipped');
        else
          expect({ cap: r.capability, status: r.status, reason: r.reason }).toMatchObject({
            status: 'passed',
          });
      }
      expect(run.stoppedBy).toBeUndefined();
      expect(run.probe?.runtime).toBe(runtime);
      expect(progress).toContain('task');
      expect(progress).toContain('long');
      expect(adapterRevision(runtime)).toMatch(/^[a-z0-9][a-z0-9._+/-]+$/);
    });
  }

  it('a capability that does not hold fails with its reason (a tool process survives the cancel)', async () => {
    const run = await runCapabilityVerification(
      options('pi', { processes: () => Promise.resolve(['/bin/sh -c sleep 600', 'sleep 600']) }),
    );
    const safe = run.results.find((r) => r.capability === 'safe_cancel');
    expect(safe?.status).toBe('failed');
    expect(safe?.reason).toContain('still runs');
    expect(byCap(run.results).cancel).toBe('passed');
  });

  it('a check on disk fails honestly when the fake did not write the file', async () => {
    const run = await runCapabilityVerification(
      options('pi', { prompts: { ...RUNTIMES.pi.prompts, expectFile: 'hello.txt' } }),
    );
    const approval = run.results.find((r) => r.capability === 'approval');
    expect(approval).toMatchObject({ status: 'failed' });
    expect(approval?.reason).toContain('hello.txt');
  });

  it('a declared-unsupported capability is skipped without running', async () => {
    const run = await runCapabilityVerification(
      options('pi', { declared: { resume: 'unsupported', interactive_prompt: 'unsupported' } }),
    );
    expect(byCap(run.results)).toMatchObject({
      resume: 'skipped',
      interactive_prompt: 'skipped',
      streaming: 'passed',
    });
  });

  it('the token budget stops the run: what is not decided is skipped, never passed or failed', async () => {
    const run = await runCapabilityVerification(
      options('pi', { budget: { maxDurationSec: 120, maxTokens: 1000 } }),
    );
    // The fixture reports ~1500 tokens on the task's first turn: the run stops there.
    expect(run.stoppedBy).toBe('token_budget');
    expect(run.results.some((r) => r.status === 'failed')).toBe(false);
    expect(run.results.some((r) => r.status === 'skipped' && r.reason.includes('token budget'))).toBe(true);
    expect(byCap(run.results).cancel).toBe('skipped');
  });

  it('the time budget stops the run and an external cancel is reported as such', async () => {
    let clock = 0;
    const timed = await runCapabilityVerification(
      options('pi', {
        budget: { maxDurationSec: 60, maxTokens: 1_000_000 },
        // The run's clock jumps past the deadline once the long session starts.
        now: () => clock,
        onProgress: (step) => {
          if (step === 'long') clock = 61_000;
        },
      }),
    );
    expect(timed.stoppedBy).toBe('time_budget');
    expect(timed.results.every((r) => r.status !== 'failed')).toBe(true);
    expect(byCap(timed.results)).toMatchObject({ streaming: 'passed', cancel: 'skipped' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runCapabilityVerification(options('pi', { signal: controller.signal }));
    expect(cancelled.stoppedBy).toBe('cancelled');
    expect(cancelled.results.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('a failure recorded before the stop stays failed (it must revoke an older pass)', async () => {
    let clock = 0;
    const run = await runCapabilityVerification(
      options('pi', {
        prompts: { ...RUNTIMES.pi.prompts, expectFile: 'hello.txt' },
        budget: { maxDurationSec: 60, maxTokens: 1_000_000 },
        // approval fails on the missing file; then the time budget runs out before the resume.
        now: () => clock,
        onProgress: (step) => {
          if (step === 'resume') clock = 61_000;
        },
      }),
    );
    expect(run.stoppedBy).toBe('time_budget');
    const approval = run.results.find((r) => r.capability === 'approval');
    expect(approval).toMatchObject({ status: 'failed' });
    expect(approval?.reason).toContain('hello.txt');
    expect(byCap(run.results)).toMatchObject({ streaming: 'passed', resume: 'skipped', cancel: 'skipped' });
  });

  it('default prompts name a per-run marker for the platform', () => {
    expect(defaultVerificationPrompts('linux', 177)).toMatchObject({
      longMarker: 'sleep 177',
      expectFile: 'hello.txt',
    });
    expect(defaultVerificationPrompts('win32', 181).longMarker).toBe('Start-Sleep -Seconds 181');
  });
});

describe('declared tables (the ceiling evidence may lift to)', () => {
  it('declare every capability, never `unverified`, and keep what the static table calls unsupported', async () => {
    const { claudeCodeCapabilities, codexCapabilities, piCapabilities, opencodeCapabilities } =
      await import('../src/index.js');
    const key = { os: 'win32', arch: 'x64' } as const;
    const statics = {
      'claude-code': claudeCodeCapabilities({ runtime: 'claude-code', version: '2.1.310', ...key }),
      codex: codexCapabilities({ runtime: 'codex', version: '0.164.0', ...key }),
      pi: piCapabilities('1.4.0', key.os, key.arch),
      opencode: opencodeCapabilities('1.19.4', key.os, key.arch),
    };
    for (const runtime of ['claude-code', 'codex', 'pi', 'opencode'] as const) {
      const declared = declaredStatuses(runtime);
      for (const [cap, status] of Object.entries(declared)) {
        expect(status).not.toBe('unverified');
        const s = statics[runtime].capabilities[cap as keyof typeof declared].status;
        if (s === 'unsupported') expect(status).toBe('unsupported');
      }
    }
  });
});

describe('verified overlay (an attempt admitted on master-side evidence)', () => {
  const overlay = {
    runtimeVersion: '1.4.0',
    os: 'win32',
    arch: 'x64',
    adapterVersion: adapterRevision('pi'),
    capabilities: ['streaming', 'cancel', 'approval', 'artifacts'] as const,
  };
  const pi = (verified?: typeof overlay) =>
    createPiAdapter({
      command: process.execPath,
      commandArgs: [FAKE_PI],
      stateDir: join(root, 'pi', randomUUID()),
      authMode: 'secret-ref',
      platform: { os: 'win32', arch: 'x64' },
      ...(verified === undefined
        ? {}
        : { verified: { ...verified, capabilities: [...verified.capabilities] } }),
    });

  it.skipIf(!posix)('lifts exactly the listed unverified capabilities to the declared status', async () => {
    const caps = (await pi(overlay).probe()).capabilities.capabilities;
    expect(caps.streaming.status).toBe('supported');
    expect(caps.cancel.status).toBe('supported');
    expect(caps.approval.status).toBe('degraded');
    expect(caps.streaming.reason).toContain('panel verification');
    // Not listed: stays unverified; declared unsupported: stays unsupported.
    expect(caps.resume.status).toBe('unverified');
    expect(caps.artifacts.status).toBe('unsupported');
    const plain = (await pi().probe()).capabilities.capabilities;
    expect(plain.streaming.status).toBe('unverified');
  });

  it.skipIf(!posix)('does nothing for another version, platform or adapter revision', async () => {
    for (const other of [
      { ...overlay, runtimeVersion: '1.5.0' },
      { ...overlay, arch: 'arm64' },
      { ...overlay, adapterVersion: 'pi-adapter/0' },
    ]) {
      expect((await pi(other).probe()).capabilities.capabilities.streaming.status).toBe('unverified');
    }
  });
});

describe('verification timers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a finished sleep removes its abort listener (waitFor sleeps every 100 ms on one signal)', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    for (let i = 0; i < 50; i += 1) await abortableSleep(1, signal);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    // An abort still ends a pending sleep at once.
    const pending = abortableSleep(60_000, signal);
    controller.abort();
    await pending;
  });

  it('the losing timeout of a race is cleared once the work settles', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    await expect(raceTimeout(Promise.resolve('ok'), 60_000, stop.signal, 'late')).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    const late = raceTimeout(new Promise<never>(() => undefined), 60_000, stop.signal, 'late');
    const settled = late.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toBe('late');
    expect(vi.getTimerCount()).toBe(0);
  });
});
