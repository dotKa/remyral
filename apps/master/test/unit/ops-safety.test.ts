import { describe, expect, it } from 'vitest';
import { breakerVerdict, type MachineEvidence } from '../../src/releases/breaker.js';
import { levelOf } from '../../src/ops-safety/cost-brake.js';
import { crossedThreshold, stateOf } from '../../src/ops-safety/expiry.js';
import {
  applyPatch,
  changedPaths,
  DEFAULT_ROLLOUT,
  effectivePolicy,
  PRESETS,
  SecurityPolicyPatch,
} from '../../src/security-policy/model.js';

const DAY = 86_400_000;
const now = new Date('2026-10-23T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);

function m(workerId: string, verdict: MachineEvidence['verdict']): MachineEvidence {
  return { workerId, verdict, status: 'succeeded', reason: null, fromVersion: '1.0.0', finishedAt: null };
}

describe('p16-ops-safety: expiry thresholds', () => {
  it('names the tightest threshold crossed (30 / 14 / 7 / 1), 0 when overdue, none before 30 days', () => {
    expect(crossedThreshold(at(45), now)).toBeNull();
    expect(crossedThreshold(at(30), now)).toBe(30);
    expect(crossedThreshold(at(20), now)).toBe(30);
    expect(crossedThreshold(at(14), now)).toBe(14);
    expect(crossedThreshold(at(3), now)).toBe(7);
    expect(crossedThreshold(at(0.5), now)).toBe(1);
    expect(crossedThreshold(at(0), now)).toBe(0);
    expect(crossedThreshold(at(-3), now)).toBe(0);
  });

  it('maps days left to a state', () => {
    expect(stateOf(null, now)).toBe('ok');
    expect(stateOf(at(60), now)).toBe('ok');
    expect(stateOf(at(20), now)).toBe('soon');
    expect(stateOf(at(7), now)).toBe('urgent');
    expect(stateOf(at(-1), now)).toBe('expired');
  });
});

describe('p16-ops-safety: rollout breaker verdict', () => {
  const none = { before: { total: 0, failed: 0 }, after: { total: 0, failed: 0 } };

  it('trips on the failing share of judged machines, at least minFailures', () => {
    const v = breakerVerdict(
      [m('a', 'ok'), m('b', 'update_failed'), m('c', 'pending')],
      none,
      DEFAULT_ROLLOUT,
    );
    expect(v).toMatchObject({
      trip: 'update_failures',
      judged: 2,
      failing: 1,
      pending: 1,
      failurePercent: 50,
    });
    const many = [...Array.from({ length: 9 }, (_, i) => m(`ok${String(i)}`, 'ok')), m('x', 'crash_loop')];
    expect(breakerVerdict(many, none, DEFAULT_ROLLOUT).trip).toBeNull();
    expect(
      breakerVerdict([m('a', 'heartbeat_lost')], none, { ...DEFAULT_ROLLOUT, minFailures: 2 }).trip,
    ).toBeNull();
  });

  it('trips on a job failure spike over the previous version, with enough jobs', () => {
    const jobs = { before: { total: 20, failed: 2 }, after: { total: 6, failed: 3 } };
    expect(breakerVerdict([m('a', 'ok')], jobs, DEFAULT_ROLLOUT).trip).toBe('job_failures');
    const few = { before: { total: 20, failed: 2 }, after: { total: 4, failed: 4 } };
    expect(breakerVerdict([m('a', 'ok')], few, DEFAULT_ROLLOUT).trip).toBeNull();
    const steady = { before: { total: 20, failed: 8 }, after: { total: 10, failed: 5 } };
    expect(breakerVerdict([m('a', 'ok')], steady, DEFAULT_ROLLOUT).trip).toBeNull();
  });

  it('never trips while the breaker is off', () => {
    expect(
      breakerVerdict([m('a', 'update_failed')], none, { ...DEFAULT_ROLLOUT, breaker: false }).trip,
    ).toBeNull();
  });
});

describe('p16-ops-safety: cost brake levels', () => {
  it('warning from warnPercent, exceeded at the ceiling', () => {
    expect(levelOf(0.5, 1, 80)).toBe('ok');
    expect(levelOf(0.8, 1, 80)).toBe('warning');
    expect(levelOf(1, 1, 80)).toBe('exceeded');
  });
});

describe('p16-ops-safety: security policy sections', () => {
  it('defaults are the same in every preset and non-blocking', () => {
    for (const p of Object.values(PRESETS)) {
      expect(p.costBrake.mode).toBe('warn');
      expect(p.rollout.breaker).toBe(true);
      expect(p.limits).toMatchObject({ userReadPerMinute: 600, userWritePerMinute: 120, chatPerMinute: 10 });
    }
  });

  it('stores only overrides and names the changed paths', () => {
    const patch = SecurityPolicyPatch.parse({
      costBrake: { mode: 'block', dailyUsd: 20 },
      limits: { chatPerHour: 60 },
      rollout: { failurePercent: 50 },
    });
    const doc = applyPatch({ preset: 'dengeli' }, patch);
    expect(doc).toEqual({
      preset: 'dengeli',
      limits: { chatPerHour: 60 },
      costBrake: { mode: 'block', dailyUsd: 20 },
      rollout: { failurePercent: 50 },
    });
    const before = effectivePolicy({ preset: 'dengeli' });
    const after = effectivePolicy(doc);
    expect(after.customized).toBe(true);
    expect(changedPaths(before, after)).toEqual([
      'limits.chatPerHour',
      'costBrake.mode',
      'costBrake.dailyUsd',
      'rollout.failurePercent',
    ]);
    // A preset change resets them.
    expect(applyPatch(doc, SecurityPolicyPatch.parse({ preset: 'siki' }))).toEqual({ preset: 'siki' });
    expect(SecurityPolicyPatch.safeParse({ costBrake: { mode: 'stop' } }).success).toBe(false);
    expect(SecurityPolicyPatch.safeParse({ limits: { chatPerMinute: 0 } }).success).toBe(false);
  });
});
