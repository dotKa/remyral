import { describe, expect, it } from 'vitest';
import {
  explainPlacement,
  formatDuration,
  OUTCOME_SCORING,
  place,
  type PlacementJob,
  type PlacementOutcomes,
  type PlacementWorker,
  score,
  speedReference,
} from '../src/placement.js';

/** p6-smart-routing (docs/design/p6-smart-routing.md §4): outcome statistics in placement scoring. */

const job: PlacementJob = {
  project: 'acme',
  runtime: 'codex',
  sandboxProfile: 'container',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
  kind: 'verify',
  model: 'gpt-fast',
};

function worker(id: string, over: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id,
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'linux',
    arch: 'x64',
    runtimes: [
      {
        runtime: 'codex',
        version: '0.162.1',
        installed: true,
        authenticated: 'yes',
        pinStatus: 'match',
        pinnedVersion: '0.162.1',
      },
    ],
    sandboxProfiles: ['container'],
    maxParallelJobs: 2,
    activeLeases: 0,
    allowedProjects: null,
    localProjects: ['acme'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    ...over,
  };
}

const stats = (samples: number, succeeded: number, p50: number | null = null): PlacementOutcomes => ({
  samples,
  succeeded,
  p50DurationSec: p50,
  scope: 'project',
});

describe('outcome scoring (p6-smart-routing)', () => {
  it('without statistics the score and ranking equal the pre-p6 formula exactly', () => {
    const w = worker('wrk_a', { activeLeases: 1, history: { succeeded: 3, failed: 1, lost: 0 } });
    const r = score(job, w);
    const expected = 0.5 * 0.5 + 0.3 * (4 / 6) + 0.2 * 0;
    expect(r.score).toBe(Math.round(expected * 1e6) / 1e6);
    expect(r.breakdown.success).toBe(0);
    expect(r.breakdown.speed).toBe(0);
  });

  it('statistics below the minimum sample size count as absent', () => {
    const few = worker('wrk_a', { outcomes: stats(OUTCOME_SCORING.minSamples - 1, 0, 10) });
    expect(score(job, few).score).toBe(score(job, worker('wrk_a')).score);
  });

  it('a machine performing exactly like the prior scores like an unknown one', () => {
    // priorRate 0.8: 8 of 10 succeeded → smoothed (8 + 3.2) / 14 = 0.8.
    const like = worker('wrk_a', { outcomes: stats(10, 8) });
    expect(score(job, like).breakdown.success).toBeCloseTo(0, 10);
  });

  it('prefers the machine with the better recorded success rate when everything else is equal', () => {
    const good = worker('wrk_b', { outcomes: stats(20, 20) });
    const bad = worker('wrk_a', { outcomes: stats(20, 6) });
    const r = place(job, [bad, good]);
    expect(r.kind).toBe('placed');
    if (r.kind !== 'placed') return;
    expect(r.ranked.map((x) => x.workerId)).toEqual(['wrk_b', 'wrk_a']);
    expect(r.explanation).toContain('20 of 20 earlier verify attempts with codex · gpt-fast succeeded here');
  });

  it('never overrides hard constraints: an ineligible machine with perfect statistics stays rejected', () => {
    const perfect = worker('wrk_a', { outcomes: stats(100, 100, 30), runtimes: [] });
    const plain = worker('wrk_b');
    const r = place(job, [perfect, plain]);
    expect(r.kind === 'placed' ? r.ranked.map((x) => x.workerId) : []).toEqual(['wrk_b']);
    expect(r.rejected.map((x) => x.workerId)).toEqual(['wrk_a']);
  });

  it('never overrides an explicit worker pin', () => {
    const pinned = { ...job, workers: ['wrk_b'] };
    const r = place(pinned, [worker('wrk_a', { outcomes: stats(50, 50, 10) }), worker('wrk_b')]);
    expect(r.kind === 'placed' ? r.ranked.map((x) => x.workerId) : []).toEqual(['wrk_b']);
    expect(r.kind === 'placed' ? r.explanation : '').toContain('pinned');
  });

  it('free capacity still dominates a modest outcome difference', () => {
    const busy = worker('wrk_a', { activeLeases: 1, outcomes: stats(20, 20) });
    const idle = worker('wrk_b', { outcomes: stats(20, 16) });
    const r = place(job, [busy, idle]);
    expect(r.kind === 'placed' ? r.ranked[0]?.workerId : null).toBe('wrk_b');
  });

  it('speed compares with the median of the eligible machines that have statistics', () => {
    const fast = worker('wrk_a', { outcomes: stats(10, 8, 60) });
    const slow = worker('wrk_b', { outcomes: stats(10, 8, 180) });
    expect(speedReference([fast, slow])).toBe(120);
    expect(speedReference([fast])).toBeNull();
    const r = place(job, [slow, fast]);
    expect(r.kind === 'placed' ? r.ranked.map((x) => x.workerId) : []).toEqual(['wrk_a', 'wrk_b']);
    expect(r.kind === 'placed' ? r.explanation : '').toContain('faster than the other machines with history');
  });

  it('is deterministic: the same facts in any order give the same ranking, scores and explanation', () => {
    const ws = [
      worker('wrk_c', { outcomes: stats(9, 7, 300), projectAffinity: 2 }),
      worker('wrk_a', { outcomes: stats(12, 12, 200) }),
      worker('wrk_b', { activeLeases: 1 }),
    ];
    const a = place(job, ws);
    const b = place(job, [...ws].reverse());
    expect(b).toEqual(a);
  });

  it('explains a lone machine, missing history and too-small history', () => {
    const one = place(job, [worker('wrk_a')]);
    expect(one.kind === 'placed' ? one.explanation : '').toBe(
      'chosen because it is the only eligible machine; 2 of 2 slots free; no outcome history yet for verify attempts with codex · gpt-fast',
    );
    const small = place({ ...job, kind: null, model: undefined }, [
      worker('wrk_a', { outcomes: stats(2, 2) }),
    ]);
    expect(small.kind === 'placed' ? small.explanation : '').toContain(
      'its outcome history is too small to count (2 of 5 unclassified attempts with codex)',
    );
  });

  it('explanation names the ranking and a fleet-wide scope', () => {
    const ws = [
      worker('wrk_a', { outcomes: { ...stats(30, 27, 250), scope: 'fleet' } }),
      worker('wrk_b', { activeLeases: 2, maxParallelJobs: 4 }),
    ];
    const r = place(job, ws);
    const text = r.kind === 'placed' ? r.explanation : '';
    expect(text).toMatch(/^chosen because it scored highest of 2 eligible machines \(\d\.\d\d vs \d\.\d\d\)/);
    expect(text).toContain('succeeded here across projects, median 4m 10s');
    expect(explainPlacement(job, [], [])).toBe('no eligible machine');
  });

  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(250)).toBe('4m 10s');
    expect(formatDuration(3900)).toBe('1h 5m');
  });
});
