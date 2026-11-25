import { describe, expect, it } from 'vitest';
import {
  type BudgetDefinition,
  evaluateBudget,
  type GroupSummary,
  levelFor,
  summarize,
  type UsageBucket,
  windowBounds,
} from '../src/index.js';

const WINDOW = windowBounds('month', new Date('2026-10-13T12:00:00Z'));

function bucket(over: Partial<UsageBucket>): UsageBucket {
  return {
    key: 'k',
    authMode: 'secret-ref',
    hasReportedCost: true,
    tokensComplete: true,
    provider: 'acme-ai',
    model: 'model-a',
    usesCacheRead: false,
    usesCacheWrite: false,
    price: null,
    records: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokensUnknownRecords: 0,
    turns: 0,
    turnsUnknownRecords: 0,
    wallTimeMs: 0,
    wallTimeUnknownRecords: 0,
    reportedCostUsd: 0,
    ...over,
  };
}

function totals(...buckets: UsageBucket[]): GroupSummary {
  return summarize(buckets).totals;
}

const dollars = (limit: number): BudgetDefinition => ({
  metric: 'cost_usd',
  limit,
  scope: { type: 'project', value: 'acme' },
  window: 'month',
});

describe('windowBounds (UTC calendar windows)', () => {
  it('day, ISO week (Monday start) and month', () => {
    const at = new Date('2026-10-13T23:59:59.999Z'); // a Tuesday
    expect(windowBounds('day', at)).toEqual({
      start: new Date('2026-10-13T00:00:00Z'),
      end: new Date('2026-10-14T00:00:00Z'),
    });
    expect(windowBounds('week', at)).toEqual({
      start: new Date('2026-10-12T00:00:00Z'),
      end: new Date('2026-10-19T00:00:00Z'),
    });
    expect(windowBounds('week', new Date('2026-10-18T10:00:00Z'))).toEqual({
      start: new Date('2026-10-12T00:00:00Z'),
      end: new Date('2026-10-19T00:00:00Z'),
    }); // Sunday
    expect(windowBounds('month', at)).toEqual({
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
    });
    expect(windowBounds('month', new Date('2026-12-31T10:00:00Z')).end).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    );
  });
});

describe('evaluateBudget', () => {
  it('thresholds at 80 % and 100 %', () => {
    expect(levelFor(79.99, 100)).toBe('none');
    expect(levelFor(80, 100)).toBe('warning');
    expect(levelFor(100, 100)).toBe('exceeded');
    expect(evaluateBudget(dollars(10), totals(bucket({ reportedCostUsd: 5 })), WINDOW)).toMatchObject({
      status: 'under',
      level: 'none',
      ratio: 0.5,
      complete: true,
    });
    expect(evaluateBudget(dollars(10), totals(bucket({ reportedCostUsd: 8 })), WINDOW).status).toBe(
      'warning',
    );
    expect(evaluateBudget(dollars(10), totals(bucket({ reportedCostUsd: 12 })), WINDOW).status).toBe('over');
  });

  it('a dollar budget with unknown-cost records is never "under": it is unknown', () => {
    const e = evaluateBudget(
      dollars(10),
      totals(
        bucket({ reportedCostUsd: 1 }),
        bucket({ hasReportedCost: false, tokensComplete: false, tokensUnknownRecords: 1 }),
      ),
      WINDOW,
    );
    expect(e).toMatchObject({
      status: 'unknown',
      level: 'none',
      complete: false,
      unknownRecords: 1,
      used: 1,
    });
  });

  it('known consumption at 80 % with gaps reports level warning but status unknown', () => {
    const e = evaluateBudget(
      dollars(10),
      totals(bucket({ reportedCostUsd: 9 }), bucket({ hasReportedCost: false, price: null, model: 'x' })),
      WINDOW,
    );
    expect(e).toMatchObject({ status: 'unknown', level: 'warning' });
  });

  it('known part alone over the limit is "over" even with gaps (a lower bound is enough)', () => {
    const e = evaluateBudget(
      dollars(10),
      totals(bucket({ reportedCostUsd: 11 }), bucket({ hasReportedCost: false, price: null, model: 'x' })),
      WINDOW,
    );
    expect(e).toMatchObject({ status: 'over', level: 'exceeded', complete: false });
  });

  it('subscription records do not make a dollar budget unknown; they count zero dollars', () => {
    const e = evaluateBudget(
      dollars(10),
      totals(
        bucket({ reportedCostUsd: 1 }),
        bucket({ authMode: 'local-login', records: 5, inputTokens: 10_000 }),
      ),
      WINDOW,
    );
    expect(e).toMatchObject({ status: 'under', complete: true, used: 1, subscriptionRecords: 5, records: 6 });
  });

  it('token, turn and wall-time budgets count subscription usage and flag missing metrics', () => {
    const s = totals(
      bucket({
        authMode: 'local-login',
        inputTokens: 600,
        outputTokens: 300,
        cacheReadTokens: 10_000,
        turns: 3,
        wallTimeMs: 60_000,
      }),
      bucket({ inputTokens: 50, outputTokens: 50, turnsUnknownRecords: 1, wallTimeUnknownRecords: 1 }),
    );
    const tokens = evaluateBudget({ ...dollars(1000), metric: 'tokens' }, s, WINDOW);
    expect(tokens).toMatchObject({ used: 1000, status: 'over', complete: true });
    const turns = evaluateBudget({ ...dollars(10), metric: 'turns' }, s, WINDOW);
    expect(turns).toMatchObject({ used: 3, status: 'unknown', complete: false });
    const time = evaluateBudget({ ...dollars(50_000), metric: 'wall_time_ms' }, s, WINDOW);
    expect(time).toMatchObject({ used: 60_000, status: 'over' });
  });

  it('no records is complete and under', () => {
    expect(evaluateBudget(dollars(1), summarize([]).totals, WINDOW)).toMatchObject({
      status: 'under',
      used: 0,
      records: 0,
    });
  });

  it('rejects non-positive limits', () => {
    expect(() => evaluateBudget(dollars(0), summarize([]).totals, WINDOW)).toThrow(RangeError);
    expect(() => evaluateBudget(dollars(Number.NaN), summarize([]).totals, WINDOW)).toThrow(RangeError);
  });
});
