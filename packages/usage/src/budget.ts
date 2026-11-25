import type { GroupSummary } from './aggregate.js';
import { periodContaining } from './periods.js';

/**
 * Budget definitions and their evaluation (docs/design/p6-cost.md §5). Inputs for p4-quotas, which
 * enforces them; this module only answers "how much of the budget is used, and do we know for sure".
 *
 * Subscription (`local-login`) runs have no per-run dollar cost (ADR-0014 §5): budget them by tokens,
 * turns or wall time. A dollar budget ignores subscription records (they cost nothing per run), but any
 * record with an **unknown** dollar cost makes the dollar figure a lower bound — such a budget is never
 * reported as safely `under`/`warning`, only `unknown` (or `over` once the known part alone exceeds it).
 * The same holds for token/turn/time budgets when some records did not report that metric.
 */

export const BUDGET_METRICS = ['tokens', 'turns', 'wall_time_ms', 'cost_usd'] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export const BUDGET_SCOPE_TYPES = ['global', 'project', 'runtime', 'provider', 'worker'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

/**
 * Calendar windows in the budget's time zone (UTC unless set, p8-cost-efficiency); `week` starts on Monday 00:00
 * local (ISO 8601).
 */
export const BUDGET_WINDOWS = ['day', 'week', 'month'] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

/** Alert thresholds as fractions of the limit. */
export const BUDGET_THRESHOLDS = { warning: 0.8, exceeded: 1 } as const;

/**
 * p8-cost-efficiency: which usage a budget counts. `api` = everything that is not a subscription run (API-key
 * billed, or the auth mode was not reported — unknown is never assumed to be free); `subscription` = `local-login`
 * runs only (ADR-0014: budget them by tokens, turns or hours — a dollar budget over them is refused).
 */
export const BUDGET_BILLINGS = ['all', 'api', 'subscription'] as const;
export type BudgetBilling = (typeof BUDGET_BILLINGS)[number];

/**
 * p8-cost-efficiency: what happens when the known consumption reaches 100 %.
 * - `warn`              — notify only; nothing is held.
 * - `pause_new`         — new jobs in the budget's scope stay queued ("budget exhausted until …"); running jobs go on.
 * - `block_automations` — only jobs started by automations (and their workflow steps) are held, and automation runs
 *                         are skipped; jobs people start by hand still run.
 * Budgets created before p8 behave as `pause_new` (the p4-quotas behaviour).
 */
export const BUDGET_ON_EXCEEDED = ['warn', 'pause_new', 'block_automations'] as const;
export type BudgetOnExceeded = (typeof BUDGET_ON_EXCEEDED)[number];

/** Notification thresholds in percent of the limit: the p6 pair for older budgets, 50/80/100 for new ones. */
export const LEGACY_THRESHOLDS_PCT: readonly number[] = [80, 100];
export const DEFAULT_THRESHOLDS_PCT: readonly number[] = [50, 80, 100];
export const MAX_THRESHOLDS = 5;

/**
 * Normalises notification thresholds: integers 1–100, de-duplicated, ascending, 1–5 entries. Returns null when the
 * input is not acceptable (the caller reports a validation issue).
 */
export function normalizeThresholds(input: readonly number[]): number[] | null {
  if (input.length === 0 || input.length > MAX_THRESHOLDS) return null;
  if (!input.every((n) => Number.isInteger(n) && n >= 1 && n <= 100)) return null;
  return [...new Set(input)].sort((a, b) => a - b);
}

/** The thresholds (percent) that the known consumption has reached, ascending. */
export function thresholdsReached(thresholds: readonly number[], used: number, limit: number): number[] {
  if (!(limit > 0)) return [];
  return thresholds.filter((pct) => used >= (limit * pct) / 100);
}

/** The p6 level name for a threshold: 100 % → `exceeded`, ≥ 80 % → `warning`, below → `notice`. */
export function levelOfThreshold(pct: number): 'notice' | 'warning' | 'exceeded' {
  if (pct >= 100) return 'exceeded';
  if (pct >= 80) return 'warning';
  return 'notice';
}

export type BudgetScope =
  | { readonly type: 'global'; readonly value: null }
  | { readonly type: Exclude<BudgetScopeType, 'global'>; readonly value: string };

export interface BudgetDefinition {
  readonly metric: BudgetMetric;
  /** Positive limit in the metric's unit (tokens, turns, milliseconds or USD). */
  readonly limit: number;
  readonly scope: BudgetScope;
  readonly window: BudgetWindow;
  /** IANA zone of the calendar window (default UTC). */
  readonly timeZone?: string;
}

/** Threshold level reached by the *known* consumption (certain, whatever the unknown part adds). */
export const BUDGET_LEVELS = ['none', 'warning', 'exceeded'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/**
 * - `under`   — complete data, below 80 %.
 * - `warning` — complete data, at or above 80 % and below 100 %.
 * - `over`    — known consumption alone is at or above 100 % (true even with incomplete data).
 * - `unknown` — some records lack the metric and the known part is below 100 %: cannot be called safe.
 */
export type BudgetStatus = 'under' | 'warning' | 'over' | 'unknown';

export interface BudgetConsumption {
  /** Known consumption (sum over records that reported the metric). */
  readonly used: number;
  /** Records in scope and window. */
  readonly records: number;
  /** Records whose value for this metric is unknown. */
  readonly unknownRecords: number;
  /** Subscription records (excluded from dollar consumption). */
  readonly subscriptionRecords: number;
}

export interface BudgetEvaluation extends BudgetConsumption {
  readonly metric: BudgetMetric;
  readonly limit: number;
  /** used / limit (a lower bound when `complete` is false). */
  readonly ratio: number;
  readonly level: BudgetLevel;
  readonly status: BudgetStatus;
  readonly complete: boolean;
  readonly window: { readonly start: Date; readonly end: Date };
}

export interface WindowBounds {
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/** The calendar window containing `at` in `timeZone` (UTC by default; DST-aware, see periods.ts). */
export function windowBounds(window: BudgetWindow, at: Date, timeZone = 'UTC'): WindowBounds {
  if (timeZone === 'UTC') {
    const y = at.getUTCFullYear();
    const m = at.getUTCMonth();
    const d = at.getUTCDate();
    switch (window) {
      case 'day':
        return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
      case 'week': {
        const sinceMonday = (at.getUTCDay() + 6) % 7;
        return {
          start: new Date(Date.UTC(y, m, d - sinceMonday)),
          end: new Date(Date.UTC(y, m, d - sinceMonday + 7)),
        };
      }
      case 'month':
        return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
    }
  }
  return periodContaining(window, at, timeZone);
}

/** Consumption of `metric` in an aggregated summary of the budget's scope and window. */
export function consumptionOf(metric: BudgetMetric, s: GroupSummary): BudgetConsumption {
  const base = { records: s.records, subscriptionRecords: s.coverage.subscription };
  switch (metric) {
    case 'tokens':
      // Input + output; prompt-cache tokens are reported separately and not counted against the budget.
      return { ...base, used: s.inputTokens + s.outputTokens, unknownRecords: s.tokensUnknownRecords };
    case 'turns':
      return { ...base, used: s.turns, unknownRecords: s.turnsUnknownRecords };
    case 'wall_time_ms':
      return { ...base, used: s.wallTimeMs, unknownRecords: s.wallTimeUnknownRecords };
    case 'cost_usd':
      return { ...base, used: s.costUsd.total, unknownRecords: s.coverage.unknown };
  }
}

export function levelFor(used: number, limit: number): BudgetLevel {
  if (used >= limit * BUDGET_THRESHOLDS.exceeded) return 'exceeded';
  if (used >= limit * BUDGET_THRESHOLDS.warning) return 'warning';
  return 'none';
}

/** Pure evaluation of a budget against the summary of its scope for `window`. */
export function evaluateBudget(
  def: BudgetDefinition,
  summary: GroupSummary,
  window: WindowBounds,
): BudgetEvaluation {
  if (!(def.limit > 0) || !Number.isFinite(def.limit)) throw new RangeError('budget limit must be > 0');
  const c = consumptionOf(def.metric, summary);
  const complete = c.unknownRecords === 0;
  const level = levelFor(c.used, def.limit);
  let status: BudgetStatus;
  if (level === 'exceeded') status = 'over';
  else if (!complete) status = 'unknown';
  else status = level === 'warning' ? 'warning' : 'under';
  return {
    ...c,
    metric: def.metric,
    limit: def.limit,
    ratio: c.used / def.limit,
    level,
    status,
    complete,
    window: { start: window.start, end: window.end },
  };
}

export function levelRank(level: BudgetLevel): number {
  return BUDGET_LEVELS.indexOf(level);
}
