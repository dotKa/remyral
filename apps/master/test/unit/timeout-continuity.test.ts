import {
  AUTO_EXTEND_MAX_PER_JOB,
  BACKSTOP_SLACK_SEC,
  JobResult,
  TIMEOUT_DELIVERY_GRACE_SEC,
  TimeoutPartial,
  WorkerFeature,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { directDecision } from '../../src/chat/direct.js';
import { jobTimeAutoExtendedText } from '../../src/chat/flow.js';
import { reasonWords } from '../../src/chat/job-result.js';
import type { AutoExtendFacts } from '../../src/jobs/job-clock.js';
import { keptWorkLine } from '../../src/jobs/kept-work.js';
import { wallTimeGraceSec } from '../../src/quotas/service.js';
import {
  AUTONOMY_SCALARS,
  applyPatch,
  changedPaths,
  effectivePolicy,
} from '../../src/security-policy/model.js';

/** p22-timeout-continuity (docs/design/p22-timeout-continuity.md): the pure parts. */
describe('timeout continuity (p22-timeout-continuity)', () => {
  it('the backstop waits limit + grace + slack for a run-clock worker, nothing for an older one', () => {
    expect(TIMEOUT_DELIVERY_GRACE_SEC).toBe(120);
    expect(wallTimeGraceSec(['run-clock-v1', 'time-limit-v1'])).toBe(
      TIMEOUT_DELIVERY_GRACE_SEC + BACKSTOP_SLACK_SEC,
    );
    expect(wallTimeGraceSec(['time-limit-v1'])).toBe(0);
    expect(wallTimeGraceSec(null)).toBe(0);
    // Production 2026-11-01: the backstop fired at 3601 s of a 3600 s limit while the worker still had 16 s.
    expect(3601 >= 3600 + wallTimeGraceSec(['run-clock-v1'])).toBe(false);
  });

  it('JOB_RESULT partial: bounded, hidden refs only, additive', () => {
    expect(WorkerFeature.safeParse('timeout-delivery-v1').success).toBe(true);
    const ok = TimeoutPartial.safeParse({
      branch: 'rac/j/a',
      commit: 'a'.repeat(40),
      files: 124,
      pushed: true,
    });
    expect(ok.success).toBe(true);
    expect(
      TimeoutPartial.safeParse({
        branch: 'rac/j/a',
        commit: 'a'.repeat(40),
        files: 3,
        pushed: false,
        ref: 'refs/heads/main',
      }).success,
    ).toBe(false);
    expect(
      TimeoutPartial.safeParse({
        branch: 'rac/j/a',
        commit: 'b'.repeat(40),
        files: 3,
        pushed: false,
        ref: 'refs/remana/kept/att-1',
        reason: 'secret_scan',
      }).success,
    ).toBe(true);
    const result = JobResult.safeParse({
      protocolVersion: '1.0',
      type: 'JOB_RESULT',
      messageId: '00000000-0000-4000-8000-000000000001',
      seq: 3,
      ts: '2026-11-01T22:41:03.000Z',
      correlationId: 'c',
      workerId: 'wrk_q57',
      jobId: '5f2e9a10-0000-4000-8000-000000000000',
      payload: {
        attemptId: 'att-1',
        epoch: 1,
        outcome: 'failed',
        summary: 'Time limit reached',
        commits: [],
        error: { code: 'max_duration_exceeded', message: 'run exceeded' },
        partial: { branch: 'rac/j/a', commit: 'a'.repeat(40), files: 124, pushed: true },
      },
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('autonomy.autoExtendTime: on in serbest and dengeli, off in siki; patchable and reported', () => {
    expect(effectivePolicy({ preset: 'serbest' }).autonomy.autoExtendTime).toBe(true);
    expect(effectivePolicy({ preset: 'dengeli' }).autonomy.autoExtendTime).toBe(true);
    expect(effectivePolicy({ preset: 'siki' }).autonomy.autoExtendTime).toBe(false);
    expect(AUTONOMY_SCALARS).toContain('autoExtendTime');
    const off = applyPatch({ preset: 'serbest' }, { autonomy: { autoExtendTime: false } });
    expect(off).toEqual({ preset: 'serbest', autonomy: { autoExtendTime: false } });
    expect(changedPaths(effectivePolicy({ preset: 'serbest' }), effectivePolicy(off))).toEqual([
      'autonomy.autoExtendTime',
    ]);
    // Back to the preset's value: the override is dropped.
    expect(applyPatch(off, { autonomy: { autoExtendTime: true } })).toEqual({ preset: 'serbest' });
    expect(AUTO_EXTEND_MAX_PER_JOB).toBe(3);
  });

  it('the automatic extension note says how much, the new limit and how many are left (TR + EN)', () => {
    const f: AutoExtendFacts = {
      jobId: '5f2e9a10-0000-4000-8000-000000000000',
      title: 'x',
      project: 'p',
      limitSec: 3600,
      remainingSec: 500,
      progressing: true,
      maxAllowedSec: 7 * 24 * 3600,
      waiting: null,
      fromSec: 3600,
      toSec: 5400,
      n: 1,
      max: 3,
    };
    expect(jobTimeAutoExtendedText(f, '5f2e9a10', 'tr')).toContain('Süreyi otomatik uzattım: +30 dk');
    expect(jobTimeAutoExtendedText(f, '5f2e9a10', 'tr')).toContain('90 dk');
    expect(jobTimeAutoExtendedText(f, '5f2e9a10', 'tr')).toContain('1/3');
    expect(jobTimeAutoExtendedText(f, '5f2e9a10', 'en')).toContain('+30 min');
    expect(jobTimeAutoExtendedText({ ...f, n: 3 }, '5f2e9a10', 'tr')).toContain('karar senin');
  });

  it('the end note of a timed-out job with kept work says the work is not lost', () => {
    const end = {
      jobId: 'j',
      transitionId: '1',
      state: 'CANCELLED' as const,
      fromState: 'CANCELLING',
      trigger: 'cancel_confirmed',
      attempts: 1,
      timedOut: true,
      kept: { files: 124, branch: 'rac/j/a', pushed: true },
    };
    expect(reasonWords(end, 'tr')).toContain('yapılan iş kaybolmadı: 124 dosyalık');
    expect(reasonWords(end, 'tr')).toContain('rac/j/a');
    expect(reasonWords(end, 'en')).toContain('the work was not lost');
    expect(reasonWords({ ...end, kept: { ...end.kept, pushed: false } }, 'tr')).toContain(
      'yalnızca o makinede',
    );
    expect(reasonWords({ ...end, kept: null }, 'tr')).toContain('Aynı yerden devam et');
  });

  it("the assistant's view of kept work names the machine only when it was not pushed", () => {
    const base = { branch: 'rac/j/a', commit: 'a'.repeat(40), files: 2, workerId: 'wrk_1' };
    expect(keptWorkLine({ ...base, pushed: true })).not.toHaveProperty('onlyOnMachine');
    expect(
      keptWorkLine({ ...base, pushed: false, ref: 'refs/remana/kept/a', reason: 'push_failed' }),
    ).toMatchObject({ onlyOnMachine: 'wrk_1', notPushedBecause: 'push_failed' });
  });

  it('a follow-up turn extends a job at once only under autonomy.autoExtendTime', () => {
    const base = {
      tool: 'draft_time_limit' as const,
      execute: false,
      propose: false,
      byUser: false,
      proposeAware: true,
      followUp: true,
    };
    expect(directDecision({ ...base, autoExtendTime: true }).run).toBe('watch');
    expect(directDecision({ ...base, autoExtendTime: false }).run).toBeNull();
    // Another tool is not covered by the switch.
    expect(directDecision({ ...base, tool: 'draft_job', autoExtendTime: true }).run).toBeNull();
  });
});
