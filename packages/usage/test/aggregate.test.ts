import { describe, expect, it } from 'vitest';
import { type PriceEntry, summarize, type UsageBucket } from '../src/index.js';

const PRICE: PriceEntry = {
  provider: 'acme-ai',
  model: 'model-a',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  inputUsdPerMTok: 2,
  outputUsdPerMTok: 10,
  cacheReadUsdPerMTok: null,
  cacheWriteUsdPerMTok: null,
  source: 'test fixture',
};

function bucket(over: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key: 'proj-a',
    authMode: 'secret-ref',
    hasReportedCost: false,
    tokensComplete: true,
    provider: 'acme-ai',
    model: 'model-a',
    usesCacheRead: false,
    usesCacheWrite: false,
    price: PRICE,
    records: 1,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokensUnknownRecords: 0,
    turns: 1,
    turnsUnknownRecords: 0,
    wallTimeMs: 1000,
    wallTimeUnknownRecords: 0,
    reportedCostUsd: 0,
    ...over,
  };
}

describe('summarize', () => {
  it('sums metrics, splits reported/estimated dollars and counts coverage per group', () => {
    const s = summarize([
      bucket({ records: 2, inputTokens: 2_000_000 }), // estimated $4
      bucket({ hasReportedCost: true, reportedCostUsd: 1.5, records: 3, inputTokens: 30 }), // reported
      bucket({ price: null, model: 'model-z', records: 1, inputTokens: 7 }), // unknown price_missing
      bucket({ authMode: 'local-login', records: 4, inputTokens: 400, wallTimeMs: 4000 }), // subscription
      bucket({ key: 'proj-b', tokensComplete: false, tokensUnknownRecords: 2, records: 2, inputTokens: 5 }),
    ]);
    expect(s.groups.map((g) => g.key)).toEqual(['proj-a', 'proj-b']);
    const a = s.groups[0];
    expect(a).toBeDefined();
    if (!a) return;
    expect(a.records).toBe(10);
    expect(a.inputTokens).toBe(2_000_000 + 30 + 7 + 400);
    expect(a.costUsd).toEqual({ reported: 1.5, estimated: 4, total: 5.5 });
    expect(a.coverage).toEqual({ reported: 3, estimated: 2, unknown: 1, subscription: 4 });
    expect(a.coverageShare).toEqual({ reported: 0.3, estimated: 0.2, unknown: 0.1, subscription: 0.4 });
    expect(a.unknownReasons).toEqual({ price_missing: 1 });
    expect(a.missingPrices).toEqual([
      { provider: 'acme-ai', model: 'model-z', reason: 'price_missing', records: 1 },
    ]);
    expect(a.flags).toEqual({
      costComplete: false,
      hasSubscription: true,
      noPerRunCost: false,
      metricsIncomplete: false,
    });
    expect(a.wallTimeMs).toBe(1000 + 1000 + 1000 + 4000);

    const b = s.groups[1];
    expect(b?.coverage.unknown).toBe(2);
    expect(b?.unknownReasons).toEqual({ tokens_missing: 2 });
    expect(b?.missingPrices).toEqual([]);
    expect(b?.flags.metricsIncomplete).toBe(true);

    expect(s.totals.records).toBe(12);
    expect(s.totals.costUsd.total).toBe(5.5);
    expect(s.totals.coverage).toEqual({ reported: 3, estimated: 2, unknown: 3, subscription: 4 });
  });

  it('subscription-only groups are marked "no per-run cost", complete, with zero dollars', () => {
    const s = summarize([bucket({ key: 'sub', authMode: 'local-login', records: 3 })]);
    expect(s.groups[0]?.flags).toEqual({
      costComplete: true,
      hasSubscription: true,
      noPerRunCost: true,
      metricsIncomplete: false,
    });
    expect(s.groups[0]?.costUsd.total).toBe(0);
    expect(s.groups[0]?.coverageShare.subscription).toBe(1);
  });

  it('subscription usage gets an API-equivalent estimate, never counted as dollars spent (p8)', () => {
    const s = summarize([
      bucket({ authMode: 'local-login', records: 2, inputTokens: 1_000_000 }), // table: $2
      bucket({
        authMode: 'local-login',
        price: null,
        model: 'model-z',
        hasReportedCost: true,
        reportedCostUsd: 0.75,
      }), // runtime's own figure
      bucket({ authMode: 'local-login', price: null, model: 'model-y', records: 3 }), // unpriced
      bucket({ records: 1, inputTokens: 1_000_000 }), // API-billed: real estimate, not "equivalent"
    ]);
    expect(s.totals.costUsd.total).toBe(2);
    expect(s.totals.apiEquivalent).toEqual({
      usd: 2.75,
      fromPriceTable: 2,
      fromRuntime: 0.75,
      unpricedRecords: 3,
    });
    expect(s.totals.flags.costComplete).toBe(true);
  });

  it('estimates from summed tokens equal the sum of per-record estimates (linearity)', () => {
    const one = summarize([bucket({ inputTokens: 123_457, outputTokens: 98_765 })]).totals.costUsd.estimated;
    const three = summarize([bucket({ records: 3, inputTokens: 3 * 123_457, outputTokens: 3 * 98_765 })])
      .totals.costUsd.estimated;
    expect(three).toBeCloseTo(3 * one, 9);
  });

  it('orders by known dollars, then tokens, unknown key last; empty input gives empty totals', () => {
    const s = summarize([
      bucket({ key: null, inputTokens: 5_000_000 }),
      bucket({ key: 'cheap', price: null, model: 'x', inputTokens: 9_000_000 }),
      bucket({ key: 'z', inputTokens: 1 }),
      bucket({ key: 'a', inputTokens: 1 }),
    ]);
    expect(s.groups.map((g) => g.key)).toEqual([null, 'a', 'z', 'cheap']);
    const empty = summarize([]);
    expect(empty.groups).toEqual([]);
    expect(empty.totals.records).toBe(0);
    expect(empty.totals.coverageShare).toEqual({ reported: 0, estimated: 0, unknown: 0, subscription: 0 });
    expect(empty.totals.flags.costComplete).toBe(true);
  });
});
