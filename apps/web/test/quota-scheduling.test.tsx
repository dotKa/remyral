import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseScheduling } from '../src/api/jobs';
import { offPeakProblem, parseOffPeak } from '../src/api/offPeak';
import { schedulingLines } from '../src/screens/chat/drafts';
import { buildSpec, emptyDraft, validateJob } from '../src/screens/composer/draft';
import { queueState } from '../src/screens/job/queueState';

/**
 * p6-quota-scheduling: the job page says why a queued job waits — "Waiting for quota until …" or "Deferred to the
 * off-peak window" with "Run now" — and which fallback runtime a job ran with.
 */

const UNTIL = '2026-10-16T15:00:00.000Z';

const orchestration = (reasons: unknown[], runs: unknown[] = []) => ({
  schedule: { status: 'waiting', reasons, workerId: null, evaluatedAt: UNTIL },
  runs,
  runNow: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseScheduling / queueState', () => {
  it('reads the earliest pause end as "waiting for quota"', () => {
    const s = parseScheduling(
      orchestration([
        {
          code: 'provider_paused',
          permanent: false,
          message: 'm',
          workers: ['w1'],
          until: '2026-10-16T18:00:00.000Z',
        },
        { code: 'provider_paused', permanent: false, message: 'm', workers: ['w2'], until: UNTIL },
      ]),
    );
    expect(queueState('QUEUED', s)).toEqual({ kind: 'quota', until: UNTIL });
    expect(queueState('RUNNING', s)).toBeNull();
  });

  it('a deferral wins; odd or missing blocks read as null', () => {
    const s = parseScheduling(
      orchestration([
        { code: 'deferred_off_peak', permanent: false, message: 'm', workers: [], until: UNTIL },
      ]),
    );
    expect(queueState('QUEUED', s)).toEqual({ kind: 'deferred', until: UNTIL });
    expect(parseScheduling(undefined)).toBeNull();
    expect(parseScheduling({ schedule: 'x', runs: 'y' })).toEqual({
      status: null,
      reasons: [],
      runtimeChoice: null,
      runNow: false,
    });
  });

  it('keeps the runtime choice of the latest attempt', () => {
    const s = parseScheduling(
      orchestration(
        [],
        [{ runtimeChoice: { index: 1, runtime: 'pi', reason: 'codex: provider_paused [w1]' } }],
      ),
    );
    expect(s?.runtimeChoice).toEqual({
      index: 1,
      runtime: 'pi',
      model: null,
      reason: 'codex: provider_paused [w1]',
    });
  });
});

describe('drafts and settings', () => {
  it('the composer sends fallbacks and the deferral; validation refuses the job runtime as fallback', () => {
    const d = { ...emptyDraft(), runtime: 'claude-code', fallbacks: ['codex', 'pi'], deferrable: true };
    expect(buildSpec(d)).toMatchObject({
      fallbacks: [{ runtime: 'codex' }, { runtime: 'pi' }],
      deferrable: true,
    });
    expect(buildSpec(emptyDraft())).not.toHaveProperty('fallbacks');
    expect(validateJob({ ...d, fallbacks: ['claude-code'] }).fallbacks).toBeDefined();
  });

  it('chat drafts show the fallback chain and the off-peak deferral', () => {
    expect(
      schedulingLines({
        fallbacks: [{ runtime: 'codex', model: 'gpt-5.5' }, { runtime: 'pi' }],
        deferrable: true,
      }),
    ).toEqual([
      { label: 'Fallback', value: 'codex · gpt-5.5 → pi' },
      { label: 'When', value: "the project's off-peak window" },
    ]);
    expect(schedulingLines({})).toEqual([]);
  });

  it('off-peak window input checks', () => {
    expect(offPeakProblem({ start: '22:00', end: '07:00', timeZone: 'Europe/Istanbul' })).toBeNull();
    expect(offPeakProblem({ start: '22:00', end: '22:00', timeZone: 'UTC' })).not.toBeNull();
    expect(offPeakProblem({ start: '25:00', end: '07:00', timeZone: 'UTC' })).not.toBeNull();
    expect(
      parseOffPeak({ window: null, open: false, nextStart: null, updatedBy: null, updatedAt: null }).window,
    ).toBeNull();
  });
});
