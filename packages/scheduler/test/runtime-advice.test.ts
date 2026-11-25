import { describe, expect, it } from 'vitest';
import {
  adviseRuntime,
  aggregateByRuntime,
  aggregateCell,
  chooseAutoRuntime,
  decayWeight,
  judgeOutcome,
  type OutcomeSample,
  type OutcomeSignals,
  priorOf,
} from '../src/index.js';

/** p11-runtime-advice (docs/design/p11-runtime-advice.md §3–5): outcome judgement, smoothing, advice, auto. */

const ok: OutcomeSignals = {
  succeeded: true,
  verification: null,
  gitVerification: null,
  ci: null,
  merge: null,
  rerun: false,
  rating: null,
};

function samples(
  runtime: string,
  good: number,
  bad: number,
  extra: Partial<OutcomeSample> = {},
): OutcomeSample[] {
  const mk = (g: boolean): OutcomeSample => ({
    runtime,
    model: '',
    area: 'frontend',
    good: g,
    ageDays: 0,
    durationSec: 600,
    costUsd: 0.4,
    ...extra,
  });
  return [...Array.from({ length: good }, () => mk(true)), ...Array.from({ length: bad }, () => mk(false))];
}

describe('judgeOutcome', () => {
  it('succeeded with no later negative signal is good', () => {
    expect(judgeOutcome(ok)).toEqual({ good: true, reasons: ['succeeded'] });
    expect(judgeOutcome({ ...ok, verification: 'passed', merge: 'merged' }).reasons).toEqual([
      'succeeded',
      'verification passed',
      'merged',
    ]);
  });
  it.each([
    [{ succeeded: false }, 'the job failed'],
    [{ verification: 'failed' as const }, 'verification failed'],
    [{ gitVerification: 'failed' as const }, 'branch verification failed'],
    [{ ci: 'failure' as const }, 'CI failed'],
    [{ merge: 'rejected' as const }, 'merge refused or discarded'],
    [{ rerun: true }, 'rerun soon after (corrected)'],
    [{ rating: -1 as const }, 'rated 👎'],
  ])('%o is bad', (s, reason) => {
    const j = judgeOutcome({ ...ok, ...s });
    expect(j.good).toBe(false);
    expect(j.reasons).toContain(reason);
  });
  it('a human 👍 on a succeeded job wins over automatic signals; never on a failed one', () => {
    expect(judgeOutcome({ ...ok, rerun: true, rating: 1 }).good).toBe(true);
    expect(judgeOutcome({ ...ok, succeeded: false, rating: 1 }).good).toBe(false);
    expect(judgeOutcome({ ...ok, verification: 'overridden' }).good).toBe(true);
  });
});

describe('aggregation math', () => {
  it('decays by half-life', () => {
    expect(decayWeight(0, 60)).toBe(1);
    expect(decayWeight(60, 60)).toBeCloseTo(0.5);
    expect(decayWeight(120, 60)).toBeCloseTo(0.25);
  });

  it('smooths towards the fleet prior (Beta posterior mean) with an interval', () => {
    const prior = { rate: 0.5, strength: 4 };
    const c = aggregateCell('codex', samples('codex', 8, 2), { halfLifeDays: 60, prior });
    // (8 + 2) / (10 + 4)
    expect(c.rate).toBeCloseTo(10 / 14, 4);
    expect(c.rawRate).toBe(0.8);
    expect(c.low).toBeLessThan(c.rate);
    expect(c.high).toBeGreaterThan(c.rate);
    expect(c.high).toBeLessThanOrEqual(1);
    expect(c.medianDurationSec).toBe(600);
    expect(c.meanCostUsd).toBe(0.4);
    // No samples: the prior itself.
    expect(aggregateCell('pi', [], { halfLifeDays: 60, prior }).rate).toBe(0.5);
  });

  it('the interval narrows with more samples', () => {
    const prior = { rate: 0.5, strength: 4 };
    const small = aggregateCell('a', samples('a', 4, 1), { halfLifeDays: 60, prior });
    const big = aggregateCell('a', samples('a', 40, 10), { halfLifeDays: 60, prior });
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });

  it('old outcomes weigh less than recent ones', () => {
    const prior = { rate: 0.5, strength: 2 };
    const s = [...samples('a', 0, 10, { ageDays: 365 }), ...samples('a', 5, 0, { ageDays: 1 })];
    const c = aggregateCell('a', s, { halfLifeDays: 30, prior });
    expect(c.rawRate).toBeCloseTo(1 / 3, 3);
    expect(c.rate).toBeGreaterThan(0.6);
  });

  it('fleet prior: decayed rate capped at priorStrength; empty fleet = 50% worth 2', () => {
    expect(priorOf([], 60)).toEqual({ rate: 0.5, strength: 2 });
    const p = priorOf(samples('a', 9, 1), 60);
    expect(p.rate).toBeCloseTo(0.9);
    expect(p.strength).toBe(4);
    expect(priorOf(samples('a', 1, 0), 60).strength).toBe(1);
  });

  it('trend compares the last 30 days with the 30 before', () => {
    const s = [...samples('a', 3, 1, { ageDays: 5 }), ...samples('a', 1, 3, { ageDays: 40 })];
    const c = aggregateCell('a', s, { halfLifeDays: 60, prior: { rate: 0.5, strength: 2 } });
    expect(c.recent).toEqual({ n: 4, rate: 0.75 });
    expect(c.previous).toEqual({ n: 4, rate: 0.25 });
  });

  it('aggregateByRuntime takes each runtime its own fleet prior', () => {
    const cells = aggregateByRuntime(
      samples('codex', 2, 0),
      [...samples('codex', 2, 8), ...samples('pi', 5, 0)],
      60,
    );
    expect(cells.map((c) => c.runtime)).toEqual(['codex', 'pi']);
    expect(cells[0]?.prior.rate).toBeCloseTo(0.2);
    expect(cells[1]?.n).toBe(0);
  });
});

describe('adviseRuntime', () => {
  const cells = (claude: [number, number], codex: [number, number]) =>
    aggregateByRuntime(
      [...samples('claude-code', ...claude), ...samples('codex', ...codex, { durationSec: 300 })],
      [],
      60,
    );

  it('recommends the counted runtime with the best smoothed rate, with evidence', () => {
    const a = adviseRuntime({
      cells: cells([21, 2], [14, 5]),
      minSamples: 5,
      scope: "this project's frontend jobs",
    });
    expect(a.recommended).toBe('claude-code');
    expect(a.text).toMatch(
      /^Recommended runtime for this project's frontend jobs: Claude Code — \d+% good outcomes \(n=23\) vs Codex \d+% \(n=19\); median 10 min; est\. cost \$0\.40/u,
    );
    expect(a.options.map((o) => o.runtime)).toEqual(['claude-code', 'codex']);
  });

  it('min samples: an uncounted runtime is never recommended, however good', () => {
    const a = adviseRuntime({ cells: cells([4, 0], [5, 5]), minSamples: 5, scope: 'x' });
    expect(a.recommended).toBe('codex');
    expect(a.options.find((o) => o.runtime === 'claude-code')?.counted).toBe(false);
    const none = adviseRuntime({ cells: cells([2, 0], [1, 0]), minSamples: 5, scope: 'x' });
    expect(none.recommended).toBeNull();
    expect(none.confidence).toBe('insufficient');
    expect(none.text).toContain('Not enough history');
  });

  it('confidence: strong only when the intervals separate', () => {
    expect(adviseRuntime({ cells: cells([50, 0], [10, 40]), minSamples: 5, scope: 'x' }).confidence).toBe(
      'strong',
    );
    const weak = adviseRuntime({ cells: cells([6, 1], [5, 2]), minSamples: 5, scope: 'x' });
    expect(weak.confidence).toBe('weak');
    expect(weak.text).toContain('low confidence');
  });
});

describe('chooseAutoRuntime', () => {
  const cellsOf = aggregateByRuntime(
    [...samples('claude-code', 20, 2), ...samples('codex', 10, 10), ...samples('pi', 1, 0)],
    [],
    60,
  );
  const cell = (r: string) => cellsOf.find((c) => c.runtime === r) ?? null;
  const base = {
    minSamples: 5,
    explorationShare: 0.1,
    allowExploration: true,
    fallbackOrder: [] as string[],
  };

  it('picks the best expected outcome and explains it', () => {
    const d = chooseAutoRuntime({
      ...base,
      random: () => 0.99,
      candidates: ['claude-code', 'codex', 'pi'].map((r) => ({ runtime: r, cell: cell(r), excluded: null })),
    });
    expect(d.runtime).toBe('claude-code');
    expect(d.how).toBe('best');
    expect(d.reasons[0]).toMatch(/^best expected outcome: Claude Code \d+% good \(n=22\) vs Codex/u);
  });

  it('honours constraints: an excluded runtime is never chosen', () => {
    const d = chooseAutoRuntime({
      ...base,
      random: () => 0.99,
      candidates: [
        { runtime: 'claude-code', cell: cell('claude-code'), excluded: 'at its usage limit' },
        { runtime: 'codex', cell: cell('codex'), excluded: null },
      ],
    });
    expect(d.runtime).toBe('codex');
    expect(d.reasons).toContain('Claude Code skipped: at its usage limit');
    const none = chooseAutoRuntime({
      ...base,
      random: () => 0,
      candidates: [{ runtime: 'codex', cell: cell('codex'), excluded: 'not allowed' }],
    });
    expect(none.runtime).toBeNull();
    expect(none.how).toBe('none');
  });

  it('exploration is bounded by the share and never happens when not allowed', () => {
    const candidates = ['claude-code', 'codex', 'pi'].map((r) => ({
      runtime: r,
      cell: cell(r),
      excluded: null,
    }));
    let seed = 7;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let explored = 0;
    for (let i = 0; i < 2000; i++) {
      const d = chooseAutoRuntime({ ...base, random: rng, candidates });
      if (d.how === 'explore') {
        explored += 1;
        expect(d.runtime).toBe('pi');
      }
    }
    expect(explored / 2000).toBeGreaterThan(0.07);
    expect(explored / 2000).toBeLessThan(0.13);
    for (let i = 0; i < 200; i++) {
      expect(chooseAutoRuntime({ ...base, allowExploration: false, random: () => 0, candidates }).how).toBe(
        'best',
      );
    }
    expect(chooseAutoRuntime({ ...base, explorationShare: 0, random: () => 0, candidates }).how).toBe('best');
  });

  it('without counted history: the routing order, else the first available', () => {
    const fresh = ['codex', 'pi'].map((r) => ({ runtime: r, cell: null, excluded: null }));
    const d = chooseAutoRuntime({ ...base, random: () => 0, candidates: fresh, fallbackOrder: ['pi'] });
    expect(d).toMatchObject({ runtime: 'pi', how: 'fallback' });
    expect(chooseAutoRuntime({ ...base, random: () => 0, candidates: fresh }).runtime).toBe('codex');
  });
});
