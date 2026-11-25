import { classify, type CostFeatures, estimateCostUsd } from './cost.js';
import type { CostClass, PriceEntry, UnknownCostReason } from './model.js';

/**
 * Records that share a group key and every {@link CostFeatures} value and were priced with the same
 * entry, summed. The master produces these with one SQL `GROUP BY`; everything else is computed here.
 */
export interface UsageBucket extends CostFeatures {
  /** Group key value (`null` = not known, e.g. provider not reported). */
  readonly key: string | null;
  /** Price entry selected for these records (`null` if none applies). */
  readonly price: PriceEntry | null;
  readonly records: number;
  /** Sums over the records that reported the value. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Records missing input or output tokens. */
  readonly tokensUnknownRecords: number;
  readonly turns: number;
  readonly turnsUnknownRecords: number;
  readonly wallTimeMs: number;
  readonly wallTimeUnknownRecords: number;
  /** Sum of runtime-reported dollars (only meaningful when `hasReportedCost`). */
  readonly reportedCostUsd: number;
}

export interface MissingPrice {
  readonly provider: string;
  readonly model: string;
  readonly reason: Extract<UnknownCostReason, 'price_missing' | 'cache_price_missing'>;
  readonly records: number;
}

export type CoverageCounts = Readonly<Record<CostClass, number>>;

export interface GroupSummary {
  readonly key: string | null;
  readonly records: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly tokensUnknownRecords: number;
  readonly turns: number;
  readonly turnsUnknownRecords: number;
  readonly wallTimeMs: number;
  readonly wallTimeUnknownRecords: number;
  /**
   * Known dollars: runtime-reported plus estimated. A lower bound whenever `coverage.unknown > 0`.
   * Subscription records contribute nothing (no per-run dollar cost).
   */
  readonly costUsd: { readonly reported: number; readonly estimated: number; readonly total: number };
  /**
   * p8-cost-efficiency: what the subscription (`local-login`) records of this group would have cost on API billing —
   * an **estimate**, never money spent (ADR-0014). Tokens × the price table where a price applies, else the runtime's
   * own API-equivalent figure (e.g. Claude Code's `total_cost_usd`), else not priced (`unpricedRecords`).
   */
  readonly apiEquivalent: {
    readonly usd: number;
    readonly fromPriceTable: number;
    readonly fromRuntime: number;
    readonly unpricedRecords: number;
  };
  /** Records per cost class (they sum to `records`). */
  readonly coverage: CoverageCounts;
  /** `coverage` as shares of `records` (0..1; all 0 when there are no records). */
  readonly coverageShare: CoverageCounts;
  readonly unknownReasons: Readonly<Partial<Record<UnknownCostReason, number>>>;
  readonly missingPrices: readonly MissingPrice[];
  readonly flags: {
    /** No record has an unknown dollar cost (subscription records do not make it incomplete). */
    readonly costComplete: boolean;
    /** Some records are subscription (`local-login`) usage. */
    readonly hasSubscription: boolean;
    /** Every record is subscription usage: show tokens/time, "no per-run cost". */
    readonly noPerRunCost: boolean;
    /** Some token, turn or wall-time values were not reported. */
    readonly metricsIncomplete: boolean;
  };
}

interface Acc {
  key: string | null;
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokensUnknownRecords: number;
  turns: number;
  turnsUnknownRecords: number;
  wallTimeMs: number;
  wallTimeUnknownRecords: number;
  reported: number;
  estimated: number;
  eqTable: number;
  eqRuntime: number;
  eqUnpriced: number;
  coverage: Record<CostClass, number>;
  unknownReasons: Partial<Record<UnknownCostReason, number>>;
  missing: Map<string, MissingPrice>;
}

function emptyAcc(key: string | null): Acc {
  return {
    key,
    records: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokensUnknownRecords: 0,
    turns: 0,
    turnsUnknownRecords: 0,
    wallTimeMs: 0,
    wallTimeUnknownRecords: 0,
    reported: 0,
    estimated: 0,
    eqTable: 0,
    eqRuntime: 0,
    eqUnpriced: 0,
    coverage: { reported: 0, estimated: 0, unknown: 0, subscription: 0 },
    unknownReasons: {},
    missing: new Map(),
  };
}

function add(acc: Acc, b: UsageBucket): void {
  acc.records += b.records;
  acc.inputTokens += b.inputTokens;
  acc.outputTokens += b.outputTokens;
  acc.cacheReadTokens += b.cacheReadTokens;
  acc.cacheWriteTokens += b.cacheWriteTokens;
  acc.tokensUnknownRecords += b.tokensUnknownRecords;
  acc.turns += b.turns;
  acc.turnsUnknownRecords += b.turnsUnknownRecords;
  acc.wallTimeMs += b.wallTimeMs;
  acc.wallTimeUnknownRecords += b.wallTimeUnknownRecords;

  const verdict = classify(b, b.price);
  acc.coverage[verdict.costClass] += b.records;
  if (verdict.costClass === 'reported') acc.reported += b.reportedCostUsd;
  if (verdict.costClass === 'estimated' && b.price) acc.estimated += estimateCostUsd(b, b.price);
  if (verdict.costClass === 'subscription') {
    // What the same tokens would cost on API billing: classify as if API-billed (same price rules, same gaps).
    const asApi = classify({ ...b, authMode: 'secret-ref', hasReportedCost: false }, b.price);
    if (asApi.costClass === 'estimated' && b.price) acc.eqTable += estimateCostUsd(b, b.price);
    else if (b.hasReportedCost) acc.eqRuntime += b.reportedCostUsd;
    else acc.eqUnpriced += b.records;
  }
  if (verdict.unknownReason !== null) {
    const r = verdict.unknownReason;
    acc.unknownReasons[r] = (acc.unknownReasons[r] ?? 0) + b.records;
    if ((r === 'price_missing' || r === 'cache_price_missing') && b.provider !== null && b.model !== null) {
      const k = `${r}\u0000${b.provider}\u0000${b.model}`;
      const prev = acc.missing.get(k);
      acc.missing.set(k, {
        provider: b.provider,
        model: b.model,
        reason: r,
        records: (prev?.records ?? 0) + b.records,
      });
    }
  }
}

/** Rounds away binary noise from summed floats (micro-dollar precision is far below display precision). */
function money(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function finish(acc: Acc): GroupSummary {
  const share = (n: number): number => (acc.records === 0 ? 0 : n / acc.records);
  const c = acc.coverage;
  return {
    key: acc.key,
    records: acc.records,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    tokensUnknownRecords: acc.tokensUnknownRecords,
    turns: acc.turns,
    turnsUnknownRecords: acc.turnsUnknownRecords,
    wallTimeMs: acc.wallTimeMs,
    wallTimeUnknownRecords: acc.wallTimeUnknownRecords,
    costUsd: {
      reported: money(acc.reported),
      estimated: money(acc.estimated),
      total: money(acc.reported + acc.estimated),
    },
    apiEquivalent: {
      usd: money(acc.eqTable + acc.eqRuntime),
      fromPriceTable: money(acc.eqTable),
      fromRuntime: money(acc.eqRuntime),
      unpricedRecords: acc.eqUnpriced,
    },
    coverage: { ...c },
    coverageShare: {
      reported: share(c.reported),
      estimated: share(c.estimated),
      unknown: share(c.unknown),
      subscription: share(c.subscription),
    },
    unknownReasons: { ...acc.unknownReasons },
    missingPrices: [...acc.missing.values()].sort(
      (a, b) =>
        b.records - a.records || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
    flags: {
      costComplete: c.unknown === 0,
      hasSubscription: c.subscription > 0,
      noPerRunCost: acc.records > 0 && c.subscription === acc.records,
      metricsIncomplete:
        acc.tokensUnknownRecords > 0 || acc.turnsUnknownRecords > 0 || acc.wallTimeUnknownRecords > 0,
    },
  };
}

export interface UsageSummary {
  readonly groups: readonly GroupSummary[];
  readonly totals: GroupSummary;
}

/**
 * Groups buckets by key and computes totals, dollars and coverage flags. Groups are ordered by known
 * dollars, then input+output tokens (both descending), then key (unknown key last).
 */
export function summarize(buckets: readonly UsageBucket[]): UsageSummary {
  const groups = new Map<string | null, Acc>();
  const totals = emptyAcc(null);
  for (const b of buckets) {
    let acc = groups.get(b.key);
    if (!acc) {
      acc = emptyAcc(b.key);
      groups.set(b.key, acc);
    }
    add(acc, b);
    add(totals, b);
  }
  const out = [...groups.values()].map(finish);
  out.sort(
    (a, b) =>
      b.costUsd.total - a.costUsd.total ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) ||
      (a.key ?? '').localeCompare(b.key ?? ''),
  );
  return { groups: out, totals: finish(totals) };
}
