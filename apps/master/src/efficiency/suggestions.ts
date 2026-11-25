import type { Role } from '../authz/model.js';
import { metricAmount } from './text.js';
import type { BudgetMetric } from '@remyral/usage';

/**
 * p8-cost-efficiency §6 (docs/design/p8-cost-efficiency.md): efficiency suggestions derived by **deterministic rules**
 * from stored statistics — no LLM call. Each suggestion names its evidence (numbers) and, where an existing mechanism
 * allows it, a one-click action the console performs through that mechanism's own route (with its own authorization,
 * step-up and audit). Nothing here changes anything: suggestions are never applied automatically. Pure.
 */

/** Minimum attempts behind a runtime × model × kind figure before a rule uses it. */
export const MIN_SAMPLES = 10;
/** A cheaper model must cost at most this share of the current one per attempt … */
export const CHEAPER_RATIO = 0.6;
/** … and succeed at most this much less often (absolute). */
export const SUCCESS_TOLERANCE = 0.05;
/** An automation failing at least this share of at least MIN_RUNS runs is reported. */
export const FAILING_SHARE = 0.4;
export const MIN_RUNS = 5;
/** Repeated identical successful runs before suggesting result reuse. */
export const MIN_IDENTICAL_RUNS = 2;
/** A budget on pace for at least this share of its limit at the window end (after this share of the window). */
export const PACE_RATIO = 1;
export const PACE_MIN_ELAPSED = 0.2;

export interface StatsInput {
  readonly runtime: string;
  readonly model: string;
  readonly kind: string;
  readonly attempts: number;
  readonly succeeded: number;
  readonly costUsd: number;
  readonly costAttempts: number;
}

export interface ModelProfileInput {
  readonly id: string;
  readonly model: string;
  /** Runtimes the profile is for (empty: any). */
  readonly runtimes: readonly string[];
}

export interface AutomationInput {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly targetKind: string;
  readonly triggerKind: string;
  readonly reuseWithinHours: number | null;
  /** Finished runs in the look-back window. */
  readonly runs: number;
  readonly failed: number;
  /** Successful runs whose job had the same prompt digest as an earlier successful run of this automation. */
  readonly identicalSuccessRuns: number;
}

export interface WorkerInput {
  readonly id: string;
  readonly name: string;
  readonly effective: number | null;
  readonly recommended: number | null;
  /** p8-capacity-auto mode; `auto` machines are adjusted by the controller and skipped here. */
  readonly mode: string | null;
}

export interface BudgetInput {
  readonly id: string;
  readonly name: string;
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly used: number;
  readonly status: string;
  readonly complete: boolean;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export interface MissingPriceInput {
  readonly provider: string;
  readonly model: string;
  readonly records: number;
}

export interface SuggestionInputs {
  readonly now: Date;
  readonly stats: readonly StatsInput[];
  readonly profiles: readonly ModelProfileInput[];
  /** Global routing rules by kind (their runtime order is kept when a cheaper profile is proposed). */
  readonly routing: ReadonlyMap<
    string,
    { readonly modelProfile: string | null; readonly runtimes: readonly string[] }
  >;
  readonly automations: readonly AutomationInput[];
  readonly workers: readonly WorkerInput[];
  readonly budgets: readonly BudgetInput[];
  readonly missingPrices: readonly MissingPriceInput[];
}

export type SuggestionAction =
  | {
      readonly kind: 'routing_rule';
      readonly role: string;
      readonly modelProfile: string;
      readonly runtimes: readonly string[];
    }
  | { readonly kind: 'pause_automation'; readonly automationId: string }
  | { readonly kind: 'enable_reuse'; readonly automationId: string; readonly hours: number }
  | { readonly kind: 'set_parallelism'; readonly workerId: string; readonly value: number }
  | { readonly kind: 'open'; readonly path: string };

export const SUGGESTION_RULES = [
  'cheaper_model',
  'failing_automation',
  'enable_reuse',
  'lower_parallelism',
  'budget_pace',
  'missing_price',
  'low_success',
] as const;
export type SuggestionRule = (typeof SUGGESTION_RULES)[number];

export interface Suggestion {
  /** Stable per rule and subject (the console may remember dismissals by it). */
  readonly id: string;
  readonly rule: SuggestionRule;
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, number | string>>;
  readonly action: SuggestionAction | null;
  /** Role the action needs (the action's own route decides; this only hides buttons that would be refused). */
  readonly actionRole: Role | null;
  /** The action's route asks for a fresh step-up. */
  readonly actionStepUp: boolean;
  /** For project-bound suggestions: the project (visibility filter). */
  readonly project: string | null;
}

const pct = (r: number): string => `${String(Math.round(r * 100))} %`;

function rate(s: { attempts: number; succeeded: number }): number {
  return s.attempts === 0 ? 0 : s.succeeded / s.attempts;
}

/** Sums the stats rows of each runtime × model × kind (rows come per project and machine). */
function rollup(stats: readonly StatsInput[]): StatsInput[] {
  const by = new Map<string, { -readonly [K in keyof StatsInput]: StatsInput[K] }>();
  for (const s of stats) {
    const k = `${s.runtime}\u0000${s.model}\u0000${s.kind}`;
    const acc = by.get(k);
    if (acc === undefined) by.set(k, { ...s });
    else {
      acc.attempts += s.attempts;
      acc.succeeded += s.succeeded;
      acc.costUsd += s.costUsd;
      acc.costAttempts += s.costAttempts;
    }
  }
  return [...by.values()];
}

function cheaperModels(inp: SuggestionInputs): Suggestion[] {
  const out: Suggestion[] = [];
  const rows = rollup(inp.stats).filter((s) => s.kind !== '' && s.model !== '' && s.attempts >= MIN_SAMPLES);
  const groups = new Map<string, StatsInput[]>();
  for (const r of rows)
    groups.set(`${r.runtime}\u0000${r.kind}`, [...(groups.get(`${r.runtime}\u0000${r.kind}`) ?? []), r]);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // The model most attempts of this runtime × kind used is "the current one".
    const current = [...list].sort((a, b) => b.attempts - a.attempts || a.model.localeCompare(b.model))[0];
    if (current === undefined || current.costAttempts === 0) continue;
    const currentCost = current.costUsd / current.costAttempts;
    if (!(currentCost > 0)) continue;
    const candidates = list
      .filter(
        (c) =>
          c !== current &&
          c.costAttempts > 0 &&
          c.costUsd / c.costAttempts <= currentCost * CHEAPER_RATIO &&
          rate(c) >= rate(current) - SUCCESS_TOLERANCE,
      )
      .sort(
        (a, b) => a.costUsd / a.costAttempts - b.costUsd / b.costAttempts || a.model.localeCompare(b.model),
      );
    const best = candidates[0];
    if (best === undefined) continue;
    const bestCost = best.costUsd / best.costAttempts;
    const profile = inp.profiles.find(
      (p) => p.model === best.model && (p.runtimes.length === 0 || p.runtimes.includes(best.runtime)),
    );
    const rule = inp.routing.get(best.kind);
    const saving = 1 - bestCost / currentCost;
    out.push({
      id: `cheaper_model:${best.runtime}:${best.kind}:${best.model}`,
      rule: 'cheaper_model',
      severity: 'info',
      title: `${best.kind} jobs on ${best.runtime} could use a cheaper model profile (${best.model})`,
      detail:
        `${best.model} cost ${pct(saving)} less per attempt than ${current.model} for ${best.kind} jobs on ${best.runtime} ` +
        `($${bestCost.toFixed(4)} vs $${currentCost.toFixed(4)}) at a similar success rate (${pct(rate(best))} of ` +
        `${String(best.attempts)} vs ${pct(rate(current))} of ${String(current.attempts)} attempts). ` +
        (profile === undefined
          ? 'No model catalog profile uses this model yet; add one on Settings → Models to route to it.'
          : `Routing ${best.kind} jobs to the profile "${profile.id}" applies to jobs that name no model.`),
      evidence: {
        runtime: best.runtime,
        kind: best.kind,
        currentModel: current.model,
        cheaperModel: best.model,
        currentCostPerAttemptUsd: currentCost,
        cheaperCostPerAttemptUsd: bestCost,
        currentSuccessRate: rate(current),
        cheaperSuccessRate: rate(best),
        cheaperAttempts: best.attempts,
      },
      action:
        profile === undefined
          ? { kind: 'open', path: '/settings/models' }
          : {
              kind: 'routing_rule',
              role: best.kind,
              modelProfile: profile.id,
              runtimes: rule?.runtimes ?? [],
            },
      actionRole: 'admin',
      actionStepUp: profile !== undefined,
      project: null,
    });
  }
  return out;
}

function automations(inp: SuggestionInputs): Suggestion[] {
  const out: Suggestion[] = [];
  for (const a of inp.automations) {
    if (a.runs >= MIN_RUNS && a.failed / a.runs >= FAILING_SHARE) {
      out.push({
        id: `failing_automation:${a.id}`,
        rule: 'failing_automation',
        severity: 'warning',
        title: `Automation "${a.name}" fails ${pct(a.failed / a.runs)} of its runs`,
        detail: `${String(a.failed)} of ${String(a.runs)} finished runs in the last 30 days failed (project ${a.project}). Look at a failed run, or pause it until it is fixed — every failed run costs a slot and tokens.`,
        evidence: { automationId: a.id, runs: a.runs, failed: a.failed, failureShare: a.failed / a.runs },
        action: { kind: 'pause_automation', automationId: a.id },
        actionRole: 'operator',
        actionStepUp: false,
        project: a.project,
      });
    }
    if (
      a.targetKind === 'job' &&
      (a.triggerKind === 'cron' || a.triggerKind === 'at') &&
      a.reuseWithinHours === null &&
      a.identicalSuccessRuns >= MIN_IDENTICAL_RUNS
    ) {
      out.push({
        id: `enable_reuse:${a.id}`,
        rule: 'enable_reuse',
        severity: 'info',
        title: `Automation "${a.name}" repeats identical work — enable result reuse`,
        detail: `${String(a.identicalSuccessRuns)} successful runs in the last 30 days ran the same prompt as an earlier successful run. With "skip if an identical successful run exists within 24 h" such runs are skipped and linked to the earlier job (never silently).`,
        evidence: { automationId: a.id, identicalSuccessRuns: a.identicalSuccessRuns, runs: a.runs },
        action: { kind: 'enable_reuse', automationId: a.id, hours: 24 },
        actionRole: 'operator',
        actionStepUp: true,
        project: a.project,
      });
    }
  }
  return out;
}

function parallelism(inp: SuggestionInputs): Suggestion[] {
  return inp.workers.flatMap((w): Suggestion[] => {
    if (w.mode === 'auto' || w.effective === null || w.recommended === null) return [];
    if (w.effective <= w.recommended) return [];
    return [
      {
        id: `lower_parallelism:${w.id}`,
        rule: 'lower_parallelism',
        severity: 'warning',
        title: `${w.name} runs ${String(w.effective)} jobs in parallel; its measured capacity is ${String(w.recommended)}`,
        detail: `Above the recommended value jobs compete for memory and CPU: they get slower, time out or fail, which costs retries. Lower the machine to ${String(w.recommended)} parallel jobs (or switch it to automatic capacity).`,
        evidence: { workerId: w.id, effective: w.effective, recommended: w.recommended },
        action: { kind: 'set_parallelism', workerId: w.id, value: w.recommended },
        actionRole: 'admin',
        actionStepUp: true,
        project: null,
      },
    ];
  });
}

function budgets(inp: SuggestionInputs): Suggestion[] {
  return inp.budgets.flatMap((b): Suggestion[] => {
    if (b.status === 'over') return [];
    const span = b.windowEnd.getTime() - b.windowStart.getTime();
    const elapsed = (inp.now.getTime() - b.windowStart.getTime()) / span;
    if (!(span > 0) || elapsed < PACE_MIN_ELAPSED || elapsed >= 1 || !(b.limit > 0)) return [];
    const projected = b.used / elapsed / b.limit;
    if (projected < PACE_RATIO) return [];
    return [
      {
        id: `budget_pace:${b.id}:${b.windowStart.toISOString()}`,
        rule: 'budget_pace',
        severity: 'warning',
        title: `Budget "${b.name}" is on pace for ${pct(projected)} of its limit`,
        detail: `${metricAmount(b.metric, b.used)} of ${metricAmount(b.metric, b.limit)} used after ${pct(elapsed)} of the window${b.complete ? '' : ' (at least — some usage has no figure)'}. At this pace it runs out before the window ends: raise it, or move work to a cheaper model or off-peak.`,
        evidence: {
          budgetId: b.id,
          used: b.used,
          limit: b.limit,
          elapsedShare: elapsed,
          projectedRatio: projected,
        },
        action: { kind: 'open', path: '/usage?tab=budgets' },
        actionRole: null,
        actionStepUp: false,
        project: null,
      },
    ];
  });
}

function prices(inp: SuggestionInputs): Suggestion[] {
  return inp.missingPrices.slice(0, 5).map((m) => ({
    id: `missing_price:${m.provider}:${m.model}`,
    rule: 'missing_price' as const,
    severity: 'info' as const,
    title: `Add a price for ${m.provider} / ${m.model}`,
    detail: `${String(m.records)} usage records of this model have no dollar figure, so spend and budgets are lower bounds. A price with its source on Usage → Prices fixes past and future estimates at once.`,
    evidence: { provider: m.provider, model: m.model, records: m.records },
    action: { kind: 'open' as const, path: '/usage?tab=prices' },
    actionRole: 'admin' as const,
    actionStepUp: false,
    project: null,
  }));
}

function lowSuccess(inp: SuggestionInputs): Suggestion[] {
  const by = new Map<string, { runtime: string; model: string; attempts: number; succeeded: number }>();
  for (const s of inp.stats) {
    const k = `${s.runtime}\u0000${s.model}`;
    const acc = by.get(k) ?? { runtime: s.runtime, model: s.model, attempts: 0, succeeded: 0 };
    acc.attempts += s.attempts;
    acc.succeeded += s.succeeded;
    by.set(k, acc);
  }
  return [...by.values()]
    .filter((s) => s.attempts >= MIN_SAMPLES && rate(s) < 0.5)
    .map((s) => ({
      id: `low_success:${s.runtime}:${s.model}`,
      rule: 'low_success' as const,
      severity: 'warning' as const,
      title: `${s.runtime}${s.model === '' ? '' : ` × ${s.model}`} succeeds only ${pct(rate(s))} of attempts`,
      detail: `${String(s.succeeded)} of ${String(s.attempts)} attempts succeeded. Check Usage → Outcomes for the kinds and machines involved; a routing rule can send those kinds to a runtime or model that does better.`,
      evidence: { runtime: s.runtime, model: s.model, attempts: s.attempts, successRate: rate(s) },
      action: { kind: 'open' as const, path: '/usage?tab=outcomes' },
      actionRole: null,
      actionStepUp: false,
      project: null,
    }));
}

const SEVERITY_RANK = { warning: 0, info: 1 } as const;

/** Every rule over the inputs; warnings first, then by rule order, then id (deterministic). */
export function suggest(inp: SuggestionInputs): Suggestion[] {
  const all = [
    ...cheaperModels(inp),
    ...automations(inp),
    ...parallelism(inp),
    ...budgets(inp),
    ...prices(inp),
    ...lowSuccess(inp),
  ];
  return all.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      SUGGESTION_RULES.indexOf(a.rule) - SUGGESTION_RULES.indexOf(b.rule) ||
      a.id.localeCompare(b.id),
  );
}
