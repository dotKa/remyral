/**
 * Usage and cost vocabulary (docs/design/p6-cost.md, ADR-0008, ADR-0014).
 *
 * A usage record is one `usage` agent event (an increment) attributed to job, attempt, worker, project,
 * runtime, provider and model. Its dollar cost is never assumed: every record is put in exactly one
 * **cost class**, which carries the ADR-0008 provenance of the dollar value shown for it.
 */

/** ADR-0008 cost provenance (mirrors `CostProvenance` in @remyral/protocol). */
export const COST_PROVENANCES = ['reported-by-runtime', 'estimated-from-tokens', 'unknown'] as const;
export type CostProvenance = (typeof COST_PROVENANCES)[number];

/** ADR-0014 runtime auth modes. `local-login` = the owner's subscription: no per-run dollar cost. */
export const AUTH_MODES = ['secret-ref', 'local-login'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * - `reported`     — the runtime reported a dollar cost (provenance `reported-by-runtime`; it is the
 *                    runtime's own estimate, docs/compat §4.4).
 * - `estimated`    — we computed it from tokens and the admin-maintained price table
 *                    (provenance `estimated-from-tokens`).
 * - `unknown`      — neither is possible (see {@link UnknownCostReason}); a gap, never zero.
 * - `subscription` — `local-login` run: billed by the subscription, so there is no per-run dollar cost
 *                    (ADR-0014 §5). Counted in tokens/turns/time only; not a gap.
 */
export const COST_CLASSES = ['reported', 'estimated', 'unknown', 'subscription'] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const UNKNOWN_COST_REASONS = [
  /** Input or output token count not reported. */
  'tokens_missing',
  /** Provider or model not known, so no price can be selected. */
  'model_unknown',
  /** No price-table entry for (provider, model) effective at the record's time. */
  'price_missing',
  /** Cache tokens were reported but the price entry has no cache price. */
  'cache_price_missing',
] as const;
export type UnknownCostReason = (typeof UNKNOWN_COST_REASONS)[number];

export const GROUP_BYS = ['project', 'worker', 'runtime', 'provider', 'model'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

/** Prices are per million tokens. */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * One price-table entry: the USD price per million tokens for (provider, model) from `effectiveFrom`
 * until the next entry for the same pair. `source` says where the number came from (required: we never
 * ship guessed prices as facts).
 */
export interface PriceEntry {
  readonly provider: string;
  readonly model: string;
  readonly effectiveFrom: Date;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok: number | null;
  readonly cacheWriteUsdPerMTok: number | null;
  readonly source: string;
}

/** Token counts; `null` = not reported (a gap), `0` = reported as zero. */
export interface TokenCounts {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

/** The facts of one usage record that decide its cost class. */
export interface UsageFacts extends TokenCounts {
  readonly provider: string | null;
  readonly model: string | null;
  readonly authMode: AuthMode | null;
  /** Provenance the runtime/worker attached to the event. */
  readonly reportedProvenance: CostProvenance;
  /** Dollar value the event carried (meaningful only with `reported-by-runtime`). */
  readonly reportedCostUsd: number | null;
  readonly recordedAt: Date;
}

/** Normalises a provider id the same way on every path (lower case, trimmed). */
export function normalizeProvider(provider: string | null | undefined): string | null {
  if (provider === undefined || provider === null) return null;
  const p = provider.trim().toLowerCase();
  return p === '' ? null : p;
}
