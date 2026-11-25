import { createLogger, Redactor } from '@remyral/observability';
import type { SubtaskStatusPayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { JobSubtasks } from '../src/jobs/subtasks.js';
import { LOGIN_STORE_OF } from '../src/sandbox/login-stores.js';
import {
  type JobSandboxRequirements,
  type RunningAttempt,
  selectProfile,
  type WorkerSandboxCapabilities,
} from '../src/sandbox/policy.js';

/**
 * p9-subjob-local-login-deadlock (docs/design/p9-subjob-local-login.md §4–5): with per-job Windows accounts a
 * worker-account (local-login) attempt shares the machine only with its own job family, one attempt per login store;
 * the sub-job tool host stops waiting when the master reports `blocked_by_parent`.
 */

const PARENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const policy = { allowedProfiles: ['host-restricted', 'unconfined'] as const };

const caps = (
  attempts: readonly RunningAttempt[] | undefined,
  over: Partial<WorkerSandboxCapabilities> = {},
): WorkerSandboxCapabilities => {
  const list = attempts ?? [];
  return {
    platform: 'win32',
    container: { ready: false },
    hostRestricted: { ready: true, filesystemConfinement: 'job_user', egressEnforced: false, concurrency: 3 },
    runtimeSandboxes: [],
    unconfined: { ready: true },
    runningAttempts: list.length,
    hostAttempts: list.filter(
      (a) =>
        (a.profile === 'host-restricted' || a.profile === 'runtime-sandbox') && a.authMode !== 'local-login',
    ).length,
    ...(attempts === undefined ? {} : { attempts }),
    ...over,
  };
};

const running = (over: Partial<RunningAttempt> = {}): RunningAttempt => ({
  family: PARENT,
  projectId: 'genel',
  profile: 'host-restricted',
  runtime: 'claude-code',
  authMode: 'local-login',
  ...over,
});

const job = (over: Partial<JobSandboxRequirements> = {}): JobSandboxRequirements => ({
  profile: 'host-restricted',
  runtime: 'codex',
  sourceTrust: 'trusted',
  needsEgress: true,
  hostExecutionOptIn: true,
  authMode: 'local-login',
  family: PARENT,
  projectId: 'genel',
  ...over,
});

function refusal(j: JobSandboxRequirements, c: WorkerSandboxCapabilities): string {
  const r = selectProfile(j, c, policy);
  if (r.ok) return 'ok';
  expect(r.error.busy).toBe(true);
  return r.error.message;
}

describe('selectProfile: worker-account attempts per login store and job family (job_user)', () => {
  it('the live case: a Codex sub-job (local-login) starts beside its Claude Code parent (local-login)', () => {
    const r = selectProfile(job(), caps([running()]), policy);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.notes).toContain(
        'local-login: runs as the worker account beside its own job family (one attempt per login)',
      );
  });

  it('another family running → "the machine is running another job" (T-SBX-4, transient)', () => {
    expect(refusal(job({ family: OTHER }), caps([running()]))).toMatch(
      /: the machine is running another job: a subscription-login \(local-login\) attempt runs as the worker account and shares the machine only with its own parent \/ sub-jobs \(T-SBX-4\)/,
    );
    // The same root id in another project is not the family.
    expect(refusal(job({ projectId: 'other' }), caps([running()]))).toMatch(/running another job/);
    // An API-key attempt of another family on a slot also blocks a login attempt.
    expect(
      refusal(job(), caps([running({ family: OTHER, authMode: 'secret-ref', runtime: 'opencode' })])),
    ).toMatch(/running another job/);
    // A job without a family is a family of its own.
    const { family: _family, ...noFamily } = job();
    expect(refusal(noFamily, caps([running()]))).toMatch(/running another job/);
  });

  it('the same login store waits, inside the family too', () => {
    expect(refusal(job({ runtime: 'claude-code' }), caps([running()]))).toMatch(
      /: waiting for the Claude Code subscription login on this machine to be free: one attempt per login at a time .*\(T-SBX-4\)/,
    );
    expect(refusal(job({ runtime: 'codex' }), caps([running({ runtime: 'codex', family: OTHER })]))).toMatch(
      /: waiting for the Codex subscription login/,
    );
  });

  it('unconfined never shares, even within the family', () => {
    expect(refusal(job(), caps([running({ profile: 'unconfined', authMode: 'secret-ref' })]))).toMatch(
      /running another job/,
    );
    expect(
      refusal(
        job({ authMode: 'secret-ref', runtime: 'opencode' }),
        caps([running({ profile: 'unconfined', authMode: 'secret-ref' })]),
      ),
    ).toMatch(/worker account itself/);
  });

  it('API-key attempts: beside a login attempt of their own family yes, of another family no', () => {
    const apiKey = job({ authMode: 'secret-ref', runtime: 'opencode' });
    const ok = selectProfile(apiKey, caps([running()]), policy);
    expect(ok.ok).toBe(true);
    expect(refusal({ ...apiKey, family: OTHER }, caps([running()]))).toMatch(
      /an attempt that runs as the worker account itself .* is running; host attempts wait for it \(T-SBX-4\)/,
    );
    // Parent login + child login + a third API-key family member: still fine (two slots free).
    expect(selectProfile(apiKey, caps([running(), running({ runtime: 'codex' })]), policy).ok).toBe(true);
    // Without a login attempt: parallel on slots across families as before.
    expect(
      selectProfile(
        { ...apiKey, family: OTHER },
        caps([running({ authMode: 'secret-ref', runtime: 'opencode' })]),
        policy,
      ).ok,
    ).toBe(true);
  });

  it('without the attempt details the old rule applies (alone)', () => {
    expect(refusal(job(), caps(undefined, { runningAttempts: 1, hostAttempts: 0 }))).toMatch(
      /subscription logins \(local-login\) run one at a time/,
    );
    // Details that do not match the count are ignored (conservative).
    expect(refusal(job(), caps([running()], { runningAttempts: 2 }))).toMatch(/run one at a time/);
    expect(selectProfile(job(), caps([]), policy).ok).toBe(true);
  });

  it('macOS (Seatbelt) and no confinement are unchanged', () => {
    const seatbelt = caps([running({ family: OTHER, runtime: 'codex' })], {
      platform: 'darwin',
      hostRestricted: { ready: true, filesystemConfinement: 'seatbelt', egressEnforced: true },
    });
    expect(selectProfile(job(), seatbelt, policy).ok).toBe(true);
    const none = caps([running()], {
      hostRestricted: { ready: true, filesystemConfinement: 'none', egressEnforced: false },
    });
    expect(refusal(job(), none)).toMatch(/without filesystem confinement/);
  });

  it('login stores: one per runtime, Claude Code and Codex separate', () => {
    expect(LOGIN_STORE_OF).toEqual({
      'claude-code': 'claude',
      codex: 'codex',
      opencode: 'opencode',
      pi: 'pi',
    });
  });
});

describe('JobSubtasks: blocked_by_parent stops the wait at once', () => {
  const redactor = new Redactor();
  const logger = createLogger({ level: 'error', redactor, sink: () => undefined });
  const SUB = '00000000-0000-4000-8000-0000000000e2';

  function host(states: Omit<SubtaskStatusPayload, 'attemptId' | 'epoch' | 'requestId'>[]) {
    let h: JobSubtasks | null = null;
    let n = 0;
    h = new JobSubtasks({
      channel: {
        request: (_jobId, payload) => {
          const a = states[Math.min(n++, states.length - 1)];
          if (a !== undefined) {
            queueMicrotask(() => {
              h?.onStatus({
                attemptId: payload.attemptId,
                epoch: payload.epoch,
                requestId: payload.requestId,
                ...a,
              });
            });
          }
          return Promise.resolve();
        },
      },
      jobId: 'job-1',
      attemptId: 'att-1',
      epoch: () => 1,
      assigned: { runtimes: ['claude-code'], depthLeft: 1 },
      root: '/tmp',
      inDir: null,
      fetchInput: () => Promise.resolve({ status: 'refused', data: Buffer.alloc(0), eof: true }),
      redactor,
      logger,
      answerTimeoutMs: 200,
      pollMs: 1,
    });
    return { h, calls: () => n };
  }

  it('request_subtask(wait) returns the master detail instead of waiting until its budget ends', async () => {
    const detail = 'This sub-job cannot start while this job runs: it can only run on WIN-WORKER-1 …';
    const { h, calls } = host([
      { state: 'queued', subtaskId: SUB, title: 'Images', runtime: 'claude-code' },
      { state: 'queued', subtaskId: SUB, title: 'Images', runtime: 'claude-code' },
      { state: 'queued', subtaskId: SUB, title: 'Images', reason: 'blocked_by_parent', detail },
    ]);
    const out = await h.request({
      title: 'Images',
      prompt: 'p',
      runtime: 'claude-code',
      wait: true,
      waitSec: 600,
    });
    expect(out.ok).toBe(false);
    expect(out.text).toContain(detail);
    expect(out.text).toContain('Not waiting: this sub-job cannot start before this job ends.');
    expect(calls()).toBe(3);
  });

  it('wait_subtask too; a plain queued answer keeps waiting', async () => {
    const { h } = host([
      { state: 'queued', subtaskId: SUB },
      { state: 'queued', subtaskId: SUB, reason: 'blocked_by_parent', detail: 'blocked' },
    ]);
    const out = await h.wait(SUB, 60);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/: queued\.\nblocked\nNot waiting/);
  });
});
