import { describe, expect, it } from 'vitest';
import {
  assessCost,
  classify,
  costFeatures,
  estimateCostUsd,
  type PriceEntry,
  selectPrice,
  type UsageFacts,
} from '../src/index.js';

/** Test prices: arbitrary round numbers, not real provider prices. */
const P1: PriceEntry = {
  provider: 'acme-ai',
  model: 'model-a',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  inputUsdPerMTok: 2,
  outputUsdPerMTok: 10,
  cacheReadUsdPerMTok: 0.5,
  cacheWriteUsdPerMTok: null,
  source: 'test fixture',
};
const P2: PriceEntry = { ...P1, effectiveFrom: new Date('2026-06-01T00:00:00Z'), inputUsdPerMTok: 1 };
const OTHER: PriceEntry = { ...P1, model: 'model-b', inputUsdPerMTok: 100 };
const PRICES = [P2, OTHER, P1];

function facts(over: Partial<UsageFacts> = {}): UsageFacts {
  return {
    provider: 'acme-ai',
    model: 'model-a',
    authMode: 'secret-ref',
    reportedProvenance: 'unknown',
    reportedCostUsd: null,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    recordedAt: new Date('2026-03-01T00:00:00Z'),
    ...over,
  };
}

describe('selectPrice', () => {
  it('picks the latest entry effective at the record time, exact model match only', () => {
    expect(selectPrice(PRICES, 'acme-ai', 'model-a', new Date('2026-03-01T00:00:00Z'))).toBe(P1);
    expect(selectPrice(PRICES, 'acme-ai', 'model-a', new Date('2026-06-01T00:00:00Z'))).toBe(P2);
    expect(selectPrice(PRICES, 'acme-ai', 'model-a', new Date('2025-12-31T23:59:59Z'))).toBeNull();
    expect(selectPrice(PRICES, 'acme-ai', 'model-a-latest', new Date('2026-07-01T00:00:00Z'))).toBeNull();
    expect(selectPrice(PRICES, 'other', 'model-a', new Date('2026-07-01T00:00:00Z'))).toBeNull();
    expect(selectPrice(PRICES, null, 'model-a', new Date('2026-07-01T00:00:00Z'))).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('is per million tokens and linear', () => {
    const t = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: null,
    };
    expect(estimateCostUsd(t, P1)).toBeCloseTo(2 + 1 + 1, 10);
    const half = {
      inputTokens: 500_000,
      outputTokens: 50_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: null,
    };
    expect(estimateCostUsd(half, P1) * 2).toBeCloseTo(estimateCostUsd(t, P1), 10);
  });
});

describe('cost classes (ADR-0008 provenance, ADR-0014 subscriptions)', () => {
  it('local-login is subscription: no dollars even when the runtime reported an estimate', () => {
    const a = assessCost(
      facts({ authMode: 'local-login', reportedProvenance: 'reported-by-runtime', reportedCostUsd: 3 }),
      PRICES,
    );
    expect(a).toMatchObject({
      costClass: 'subscription',
      provenance: null,
      costUsd: null,
      unknownReason: null,
    });
  });

  it('runtime-reported dollars win over our estimate', () => {
    const a = assessCost(facts({ reportedProvenance: 'reported-by-runtime', reportedCostUsd: 0.42 }), PRICES);
    expect(a).toMatchObject({ costClass: 'reported', provenance: 'reported-by-runtime', costUsd: 0.42 });
  });

  it('a dollar value with any other provenance is not trusted as reported; we estimate', () => {
    const a = assessCost(facts({ reportedProvenance: 'estimated-from-tokens', reportedCostUsd: 99 }), PRICES);
    expect(a.costClass).toBe('estimated');
    expect(a.provenance).toBe('estimated-from-tokens');
    expect(a.costUsd).toBeCloseTo(2 + 1, 10);
    expect(a.price).toBe(P1);
  });

  it('reported-by-runtime without a value falls back to estimation', () => {
    expect(assessCost(facts({ reportedProvenance: 'reported-by-runtime' }), PRICES).costClass).toBe(
      'estimated',
    );
  });

  it.each([
    ['tokens_missing', facts({ outputTokens: null })],
    ['tokens_missing', facts({ inputTokens: null, provider: null })],
    ['model_unknown', facts({ provider: null })],
    ['model_unknown', facts({ model: null })],
    ['price_missing', facts({ model: 'model-z' })],
    ['price_missing', facts({ recordedAt: new Date('2025-01-01T00:00:00Z') })],
    ['cache_price_missing', facts({ cacheWriteTokens: 10 })],
  ] as const)('unknown: %s', (reason, f) => {
    const a = assessCost(f, PRICES);
    expect(a).toMatchObject({
      costClass: 'unknown',
      provenance: 'unknown',
      unknownReason: reason,
      costUsd: null,
    });
  });

  it('zero cache tokens need no cache price', () => {
    expect(assessCost(facts({ cacheWriteTokens: 0 }), PRICES).costClass).toBe('estimated');
  });

  it('an empty price table never invents a cost', () => {
    expect(assessCost(facts(), [])).toMatchObject({ costClass: 'unknown', unknownReason: 'price_missing' });
  });

  it('classify on features is what assessCost uses', () => {
    const f = facts({ cacheReadTokens: 5 });
    expect(classify(costFeatures(f), P1).costClass).toBe('estimated');
    expect(classify(costFeatures(f), null).unknownReason).toBe('price_missing');
  });
});
