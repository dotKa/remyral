import { describe, expect, it } from 'vitest';
import {
  AssignedResume,
  AssignJob,
  credentialKey,
  decideUsageLimitAction,
  isUsageLimitResume,
  JobPausedReport,
  JobResult,
  USAGE_LIMIT_DEFAULT_POLICY,
  usageLimitJitterMs,
  UsageLimitPolicy,
  WorkerFeature,
} from '../src/index.js';

/** p11-usage-limit-fallback: the shared policy rules and the additive protocol fields. */

const NOW = new Date('2026-10-18T10:00:00.000Z');
const inHours = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

describe('decideUsageLimitAction', () => {
  const policy = (mode: UsageLimitPolicy['mode'], maxWaitHours = 6) => ({ mode, maxWaitHours });

  it('auto: waits for a known reset within the bound, else falls back when it can, else waits', () => {
    expect(
      decideUsageLimitAction(policy('auto'), { resetAt: inHours(2), now: NOW, fallbackAvailable: true }),
    ).toBe('wait');
    expect(
      decideUsageLimitAction(policy('auto'), { resetAt: inHours(6), now: NOW, fallbackAvailable: true }),
    ).toBe('wait');
    expect(
      decideUsageLimitAction(policy('auto'), { resetAt: inHours(30), now: NOW, fallbackAvailable: true }),
    ).toBe('fallback');
    expect(decideUsageLimitAction(policy('auto'), { resetAt: null, now: NOW, fallbackAvailable: true })).toBe(
      'fallback',
    );
    expect(
      decideUsageLimitAction(policy('auto'), { resetAt: inHours(30), now: NOW, fallbackAvailable: false }),
    ).toBe('wait');
    expect(
      decideUsageLimitAction(policy('auto', 1), { resetAt: inHours(2), now: NOW, fallbackAvailable: true }),
    ).toBe('fallback');
  });

  it('wait / fallback / fail as configured', () => {
    expect(
      decideUsageLimitAction(policy('wait'), { resetAt: inHours(100), now: NOW, fallbackAvailable: true }),
    ).toBe('wait');
    expect(
      decideUsageLimitAction(policy('fallback'), { resetAt: inHours(1), now: NOW, fallbackAvailable: true }),
    ).toBe('fallback');
    expect(
      decideUsageLimitAction(policy('fallback'), { resetAt: inHours(1), now: NOW, fallbackAvailable: false }),
    ).toBe('wait');
    expect(
      decideUsageLimitAction(policy('fail'), { resetAt: inHours(1), now: NOW, fallbackAvailable: true }),
    ).toBe('fail');
  });
});

describe('UsageLimitPolicy', () => {
  it('the default is auto, 6 h, no fallbacks, no paid fallback', () => {
    expect(UsageLimitPolicy.parse(USAGE_LIMIT_DEFAULT_POLICY)).toEqual({
      mode: 'auto',
      maxWaitHours: 6,
      fallbacks: [],
      allowPaidFallback: false,
    });
  });

  it('accepts the same runtime with another profile (subscription → API key), refuses duplicates and bounds', () => {
    expect(
      UsageLimitPolicy.safeParse({
        mode: 'fallback',
        maxWaitHours: 2,
        fallbacks: [
          { runtime: 'claude-code', model: 'anthropic-api' },
          { runtime: 'codex' },
          { runtime: 'opencode', model: 'kimi-k2' },
        ],
        allowPaidFallback: true,
      }).success,
    ).toBe(true);
    expect(
      UsageLimitPolicy.safeParse({
        mode: 'auto',
        maxWaitHours: 6,
        fallbacks: [{ runtime: 'codex' }, { runtime: 'codex' }],
        allowPaidFallback: false,
      }).success,
    ).toBe(false);
    expect(UsageLimitPolicy.safeParse({ ...USAGE_LIMIT_DEFAULT_POLICY, maxWaitHours: 200 }).success).toBe(
      false,
    );
    expect(UsageLimitPolicy.safeParse({ ...USAGE_LIMIT_DEFAULT_POLICY, extra: 1 }).success).toBe(false);
    expect(
      UsageLimitPolicy.safeParse({ ...USAGE_LIMIT_DEFAULT_POLICY, fallbacks: [{ runtime: 'openhands' }] })
        .success,
    ).toBe(false);
  });
});

describe('helpers', () => {
  it('jitter is stable per job and within 15–90 s', () => {
    const a = usageLimitJitterMs('8a0f6e0e-1111-4c4c-9c9c-000000000001');
    expect(usageLimitJitterMs('8a0f6e0e-1111-4c4c-9c9c-000000000001')).toBe(a);
    for (let i = 0; i < 50; i++) {
      const j = usageLimitJitterMs(`job-${String(i)}`);
      expect(j).toBeGreaterThanOrEqual(15_000);
      expect(j).toBeLessThanOrEqual(90_000);
    }
  });

  it('credential keys: a vault credential is global, a worker-store secret is per machine', () => {
    expect(credentialKey({ source: 'vault', id: 'cred_1' } as never, 'w1')).toBe('vault:cred_1');
    expect(credentialKey({ source: 'worker-store', name: 'ANTHROPIC' } as never, 'w1')).toBe(
      'store:ANTHROPIC@w1',
    );
  });
});

describe('protocol (additive in 1.0)', () => {
  it('the worker feature is known', () => {
    expect(WorkerFeature.safeParse('usage-limit-park-v1').success).toBe(true);
  });

  it('JOB_RESULT carries error.usageLimit and paused{cause: usage_limit} without an approval id', () => {
    const base = {
      attemptId: 'a1',
      epoch: 2,
      outcome: 'failed',
      summary: 'limit',
      commits: [],
      error: {
        code: 'provider_usage_limit',
        message: 'the provider usage limit was reached',
        resetAt: '2026-10-18T15:00:00.000Z',
        usageLimit: {
          scope: 'subscription',
          kind: 'session',
          store: 'claude',
          message: "You've hit your limit",
        },
      },
      paused: { cause: 'usage_limit', resume: 'session', activeMs: 1000 },
    };
    expect(JobResult.shape.payload.safeParse(base).success).toBe(true);
    // An approval pause still needs its approval id.
    expect(JobPausedReport.safeParse({ resume: 'session', activeMs: 0 }).success).toBe(false);
    expect(JobPausedReport.safeParse({ approvalId: 'x1', resume: 'session', activeMs: 0 }).success).toBe(
      true,
    );
    expect(
      JobResult.shape.payload.safeParse({
        ...base,
        error: { ...base.error, usageLimit: { scope: 'everything' } },
      }).success,
    ).toBe(false);
  });

  it('execution.resume is an approval or a usage-limit resume; execution.usageLimitPark', () => {
    const limit = AssignedResume.parse({
      cause: 'usage_limit',
      pausedEpoch: 3,
      limitedRuntime: 'claude-code',
      resetAt: '2026-10-18T15:00:00.000Z',
      activeMs: 5_000,
    });
    expect(isUsageLimitResume(limit)).toBe(true);
    const approval = AssignedResume.parse({
      pausedEpoch: 3,
      approvalId: 'a',
      action: 'runtime.dangerous_tool',
      summary: 's',
      decision: { decision: 'approve', decidedBy: 'owner' },
      activeMs: 0,
    });
    expect(isUsageLimitResume(approval)).toBe(false);
    const exec = AssignJob.shape.payload.shape.execution.unwrap().safeParse({
      hostExecutionOptIn: false,
      usageLimitPark: { retainUntil: '2026-10-25T10:00:00.000Z' },
      resume: limit,
    });
    expect(exec.success).toBe(true);
  });
});
