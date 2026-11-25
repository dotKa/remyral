import {
  type AuthMode,
  type CostClass,
  type CostProvenance,
  type PriceEntry,
  type TokenCounts,
  TOKENS_PER_PRICE_UNIT,
  type UnknownCostReason,
  type UsageFacts,
} from './model.js';

/**
 * The features of a record (or of a bucket of identical records) that decide its cost class. The master
 * groups records by exactly these features in SQL and classifies each bucket with {@link classify}, so
 * per-record and aggregated views use the same rule.
 */
export interface CostFeatures {
  readonly authMode: AuthMode | null;
  /** Provenance `reported-by-runtime` and a dollar value present. */
  readonly hasReportedCost: boolean;
  /** Input and output token counts both reported. */
  readonly tokensComplete: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly usesCacheRead: boolean;
  readonly usesCacheWrite: boolean;
}

export interface CostVerdict {
  readonly costClass: CostClass;
  /** ADR-0008 provenance of the dollar value; `null` for `subscription` (no per-run dollar cost). */
  readonly provenance: CostProvenance | null;
  readonly unknownReason: UnknownCostReason | null;
}

export function costFeatures(f: UsageFacts): CostFeatures {
  return {
    authMode: f.authMode,
    hasReportedCost: f.reportedProvenance === 'reported-by-runtime' && f.reportedCostUsd !== null,
    tokensComplete: f.inputTokens !== null && f.outputTokens !== null,
    provider: f.provider,
    model: f.model,
    usesCacheRead: (f.cacheReadTokens ?? 0) > 0,
    usesCacheWrite: (f.cacheWriteTokens ?? 0) > 0,
  };
}

/**
 * Cost class rule (docs/design/p6-cost.md §3), first match wins:
 * 1. `local-login` → `subscription` (ADR-0014: tokens/turns/time only, no dollars).
 * 2. runtime-reported dollar value → `reported`.
 * 3. tokens incomplete → `unknown/tokens_missing`; provider/model unknown → `unknown/model_unknown`;
 *    no price → `unknown/price_missing`; cache tokens without cache price → `unknown/cache_price_missing`.
 * 4. otherwise → `estimated` from `price`.
 *
 * `price` must be the entry {@link selectPrice} picked for the record (or `null`).
 */
export function classify(features: CostFeatures, price: PriceEntry | null): CostVerdict {
  if (features.authMode === 'local-login') {
    return { costClass: 'subscription', provenance: null, unknownReason: null };
  }
  if (features.hasReportedCost) {
    return { costClass: 'reported', provenance: 'reported-by-runtime', unknownReason: null };
  }
  const unknown = (reason: UnknownCostReason): CostVerdict => ({
    costClass: 'unknown',
    provenance: 'unknown',
    unknownReason: reason,
  });
  if (!features.tokensComplete) return unknown('tokens_missing');
  if (features.provider === null || features.model === null) return unknown('model_unknown');
  if (price === null) return unknown('price_missing');
  if (
    (features.usesCacheRead && price.cacheReadUsdPerMTok === null) ||
    (features.usesCacheWrite && price.cacheWriteUsdPerMTok === null)
  ) {
    return unknown('cache_price_missing');
  }
  return { costClass: 'estimated', provenance: 'estimated-from-tokens', unknownReason: null };
}

/**
 * The price for (provider, model) at `at`: the entry with the latest `effectiveFrom` not after `at`.
 * Exact, case-sensitive match on the model id (no prefix/alias guessing); provider ids are lower case.
 */
export function selectPrice(
  prices: readonly PriceEntry[],
  provider: string | null,
  model: string | null,
  at: Date,
): PriceEntry | null {
  if (provider === null || model === null) return null;
  let best: PriceEntry | null = null;
  for (const p of prices) {
    if (p.provider !== provider || p.model !== model) continue;
    if (p.effectiveFrom.getTime() > at.getTime()) continue;
    if (best === null || p.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = p;
  }
  return best;
}

/** Linear in the token counts, so it is exact for sums of tokens priced with the same entry. */
export function estimateCostUsd(tokens: TokenCounts, price: PriceEntry): number {
  const part = (n: number | null, perMTok: number | null): number =>
    n === null || n === 0 || perMTok === null ? 0 : (n * perMTok) / TOKENS_PER_PRICE_UNIT;
  return (
    part(tokens.inputTokens, price.inputUsdPerMTok) +
    part(tokens.outputTokens, price.outputUsdPerMTok) +
    part(tokens.cacheReadTokens, price.cacheReadUsdPerMTok) +
    part(tokens.cacheWriteTokens, price.cacheWriteUsdPerMTok)
  );
}

export interface CostAssessment extends CostVerdict {
  /** Dollar cost for `reported`/`estimated`; `null` for `unknown` and `subscription`. */
  readonly costUsd: number | null;
  /** The price entry used for an `estimated` cost (and the one considered for `cache_price_missing`). */
  readonly price: PriceEntry | null;
}

/** Cost of one record against a price table. */
export function assessCost(facts: UsageFacts, prices: readonly PriceEntry[]): CostAssessment {
  const features = costFeatures(facts);
  const price = selectPrice(prices, facts.provider, facts.model, facts.recordedAt);
  const verdict = classify(features, price);
  switch (verdict.costClass) {
    case 'reported':
      return { ...verdict, costUsd: facts.reportedCostUsd, price: null };
    case 'estimated':
      return { ...verdict, costUsd: price ? estimateCostUsd(facts, price) : null, price };
    case 'unknown':
      return {
        ...verdict,
        costUsd: null,
        price: verdict.unknownReason === 'cache_price_missing' ? price : null,
      };
    case 'subscription':
      return { ...verdict, costUsd: null, price: null };
  }
}
