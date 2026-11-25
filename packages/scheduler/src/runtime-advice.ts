/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md §3–5, ADR-0044): pure outcome math for runtime advice and
 * auto routing — what a good outcome is, recency-decayed Bayesian smoothing with a fleet prior, an approximate
 * credible interval, the advice for a project area and the auto-mode choice with bounded exploration. No I/O; the
 * master loads the samples and the constraints.
 */

/** What is known about a finished job beyond "succeeded". `null` = no such signal (not negative). */
export interface OutcomeSignals {
  readonly succeeded: boolean;
  /** p10 verification of the result: an override by a human counts as passed. */
  readonly verification: 'passed' | 'warned' | 'failed' | 'overridden' | null;
  /** The git flow's own verification of the branch. */
  readonly gitVerification: 'passed' | 'failed' | null;
  readonly ci: 'success' | 'failure' | 'timed_out' | null;
  /** merged / approved, or refused / discarded by a human (open = no signal). */
  readonly merge: 'merged' | 'rejected' | null;
  /** The same prompt was submitted again in the project within the rerun window (the result was corrected). */
  readonly rerun: boolean;
  /** A human 👍 (1) / 👎 (-1). */
  readonly rating: 1 | -1 | null;
}

export interface OutcomeJudgement {
  readonly good: boolean;
  /** Why (the first deciding signal first). */
  readonly reasons: readonly string[];
}

/**
 * A good outcome: the job succeeded and nothing later said otherwise — no failed verification, no failed CI, no
 * refused merge, not rerun within the window, not rated 👎. A 👎 is always bad; a 👍 on a succeeded job is good
 * whatever the automatic signals say (the human decides). A failed job is never good.
 */
export function judgeOutcome(s: OutcomeSignals): OutcomeJudgement {
  if (s.rating === -1) return { good: false, reasons: ['rated 👎'] };
  if (!s.succeeded) return { good: false, reasons: ['the job failed'] };
  if (s.rating === 1) return { good: true, reasons: ['rated 👍'] };
  const bad: string[] = [];
  if (s.verification === 'failed') bad.push('verification failed');
  if (s.gitVerification === 'failed') bad.push('branch verification failed');
  if (s.ci === 'failure' || s.ci === 'timed_out') bad.push('CI failed');
  if (s.merge === 'rejected') bad.push('merge refused or discarded');
  if (s.rerun) bad.push('rerun soon after (corrected)');
  if (bad.length > 0) return { good: false, reasons: bad };
  const good = ['succeeded'];
  if (s.verification === 'passed' || s.verification === 'overridden' || s.verification === 'warned') {
    good.push('verification passed');
  }
  if (s.merge === 'merged') good.push('merged');
  return { good: true, reasons: good };
}

/** One finished job as the math sees it. */
export interface OutcomeSample {
  readonly runtime: string;
  readonly model: string;
  readonly area: string | null;
  readonly good: boolean;
  /** Days between the job's end and now (≥ 0). */
  readonly ageDays: number;
  readonly durationSec: number | null;
  readonly costUsd: number | null;
}

export const ADVICE_MATH = {
  /** Pseudo-observations the fleet prior is worth at most. */
  priorStrength: 4,
  /** Prior when the fleet has no history either (uninformative). */
  emptyPrior: { rate: 0.5, strength: 2 },
  /** ≈95 % interval. */
  z: 1.96,
  /** Trend: the last N days against the N days before. */
  trendDays: 30,
} as const;

/** Recency decay: an outcome `halfLifeDays` old counts half; one twice as old a quarter. */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

export interface Prior {
  readonly rate: number;
  readonly strength: number;
}

/**
 * The fleet prior for a runtime (all projects' samples of it): its decayed good rate, worth at most
 * `priorStrength` pseudo-observations (fewer when the fleet itself has fewer). No fleet samples: 50 % worth 2.
 */
export function priorOf(fleet: readonly OutcomeSample[], halfLifeDays: number): Prior {
  let w = 0;
  let g = 0;
  for (const s of fleet) {
    const x = decayWeight(s.ageDays, halfLifeDays);
    w += x;
    if (s.good) g += x;
  }
  if (w <= 0) return ADVICE_MATH.emptyPrior;
  return { rate: g / w, strength: Math.min(ADVICE_MATH.priorStrength, w) };
}

export interface OutcomeCell {
  readonly runtime: string;
  /** Jobs counted (raw; the minimum sample rule uses this). */
  readonly n: number;
  readonly good: number;
  /** Decayed weight of the jobs and of the good ones. */
  readonly weight: number;
  readonly goodWeight: number;
  /** Smoothed good-outcome rate (posterior mean of Beta(prior + decayed counts)). */
  readonly rate: number;
  /** Approximate 95 % credible interval of the rate (normal approximation of the Beta, clamped to 0..1). */
  readonly low: number;
  readonly high: number;
  /** Raw good / n (null when n = 0). */
  readonly rawRate: number | null;
  readonly medianDurationSec: number | null;
  /** Mean cost of the jobs that reported one (null: none did). */
  readonly meanCostUsd: number | null;
  readonly prior: Prior;
  /** Raw good rate of the last `trendDays` and of the `trendDays` before (null: no jobs in that window). */
  readonly recent: { readonly n: number; readonly rate: number | null };
  readonly previous: { readonly n: number; readonly rate: number | null };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] ?? null) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** One runtime's cell (e.g. this project × area × runtime) smoothed towards its fleet prior. */
export function aggregateCell(
  runtime: string,
  samples: readonly OutcomeSample[],
  opts: { readonly halfLifeDays: number; readonly prior: Prior },
): OutcomeCell {
  let w = 0;
  let gw = 0;
  let good = 0;
  const durations: number[] = [];
  const costs: number[] = [];
  const recent = { n: 0, good: 0 };
  const previous = { n: 0, good: 0 };
  for (const s of samples) {
    const x = decayWeight(s.ageDays, opts.halfLifeDays);
    w += x;
    if (s.good) {
      gw += x;
      good += 1;
    }
    if (s.durationSec !== null) durations.push(s.durationSec);
    if (s.costUsd !== null) costs.push(s.costUsd);
    const bucket =
      s.ageDays < ADVICE_MATH.trendDays ? recent : s.ageDays < 2 * ADVICE_MATH.trendDays ? previous : null;
    if (bucket !== null) {
      bucket.n += 1;
      if (s.good) bucket.good += 1;
    }
  }
  const a = gw + opts.prior.rate * opts.prior.strength;
  const b = w - gw + (1 - opts.prior.rate) * opts.prior.strength;
  const mean = a + b > 0 ? a / (a + b) : opts.prior.rate;
  const sd = a + b > 0 ? Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1))) : 0.5;
  return {
    runtime,
    n: samples.length,
    good,
    weight: r4(w),
    goodWeight: r4(gw),
    rate: r4(mean),
    low: r4(Math.max(0, mean - ADVICE_MATH.z * sd)),
    high: r4(Math.min(1, mean + ADVICE_MATH.z * sd)),
    rawRate: samples.length === 0 ? null : r4(good / samples.length),
    medianDurationSec: median(durations),
    meanCostUsd:
      costs.length === 0 ? null : Math.round((costs.reduce((p, c) => p + c, 0) / costs.length) * 1e4) / 1e4,
    prior: opts.prior,
    recent: { n: recent.n, rate: recent.n === 0 ? null : r4(recent.good / recent.n) },
    previous: { n: previous.n, rate: previous.n === 0 ? null : r4(previous.good / previous.n) },
  };
}

/**
 * Cells per runtime for one scope (`local`: e.g. this project × area) with each runtime's prior from `fleet` (the
 * same runtime × area across all projects). Runtimes are those present in either set, sorted by name.
 */
export function aggregateByRuntime(
  local: readonly OutcomeSample[],
  fleet: readonly OutcomeSample[],
  halfLifeDays: number,
): OutcomeCell[] {
  const runtimes = [...new Set([...local, ...fleet].map((s) => s.runtime))].sort();
  return runtimes.map((rt) =>
    aggregateCell(
      rt,
      local.filter((s) => s.runtime === rt),
      {
        halfLifeDays,
        prior: priorOf(
          fleet.filter((s) => s.runtime === rt),
          halfLifeDays,
        ),
      },
    ),
  );
}

export const RUNTIME_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  opencode: 'OpenCode',
};
export const runtimeLabel = (r: string): string => RUNTIME_LABEL[r] ?? r;

export function durationLabel(sec: number | null): string {
  if (sec === null) return '–';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.round(s / 60))} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${String(h)} h` : `${String(h)} h ${String(m)} min`;
}

const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

/** Ranking of eligible cells: smoothed rate, then faster, then cheaper, then name (deterministic). */
function better(a: OutcomeCell, b: OutcomeCell): number {
  return (
    b.rate - a.rate ||
    (a.medianDurationSec ?? Infinity) - (b.medianDurationSec ?? Infinity) ||
    (a.meanCostUsd ?? Infinity) - (b.meanCostUsd ?? Infinity) ||
    a.runtime.localeCompare(b.runtime)
  );
}

export interface RuntimeAdviceOption {
  readonly runtime: string;
  readonly n: number;
  readonly rate: number;
  readonly low: number;
  readonly high: number;
  readonly rawRate: number | null;
  readonly medianDurationSec: number | null;
  readonly meanCostUsd: number | null;
  /** Has at least the minimum samples (its record counts). */
  readonly counted: boolean;
}

export interface RuntimeAdvice {
  /** null: no runtime has enough history here. */
  readonly recommended: string | null;
  /** strong: the best interval is above the runner-up's; weak: it leads but the intervals overlap / no rival. */
  readonly confidence: 'strong' | 'weak' | 'insufficient';
  /** e.g. "this project's frontend jobs". */
  readonly scope: string;
  readonly options: readonly RuntimeAdviceOption[];
  readonly text: string;
}

/**
 * The advice for one scope: the counted runtime (≥ `minSamples`) with the best smoothed good-outcome rate, with the
 * evidence, e.g. "Recommended runtime for this project's frontend jobs: Claude Code — 91% good outcomes (n=23) vs
 * Codex 74% (n=19); median 12 min; est. cost $0.42". Advice only: it never changes a job.
 */
export function adviseRuntime(input: {
  readonly cells: readonly OutcomeCell[];
  readonly minSamples: number;
  readonly scope: string;
}): RuntimeAdvice {
  const counted = input.cells.filter((c) => c.n >= input.minSamples).sort(better);
  const rest = input.cells
    .filter((c) => c.n < input.minSamples)
    .sort((a, b) => b.n - a.n || a.runtime.localeCompare(b.runtime));
  const options: RuntimeAdviceOption[] = [...counted, ...rest].map((c) => ({
    runtime: c.runtime,
    n: c.n,
    rate: c.rate,
    low: c.low,
    high: c.high,
    rawRate: c.rawRate,
    medianDurationSec: c.medianDurationSec,
    meanCostUsd: c.meanCostUsd,
    counted: c.n >= input.minSamples,
  }));
  const best = counted[0];
  if (best === undefined) {
    const have = rest.filter((c) => c.n > 0);
    return {
      recommended: null,
      confidence: 'insufficient',
      scope: input.scope,
      options,
      text:
        `Not enough history for ${input.scope} yet (a runtime needs ${String(input.minSamples)} finished jobs here)` +
        (have.length === 0
          ? '.'
          : `: ${have.map((c) => `${runtimeLabel(c.runtime)} n=${String(c.n)}`).join(', ')}.`),
    };
  }
  const second = counted[1];
  const confidence = second !== undefined && best.low > second.high ? 'strong' : 'weak';
  const vs = counted
    .slice(1, 3)
    .map((c) => `${runtimeLabel(c.runtime)} ${pct(c.rate)} (n=${String(c.n)})`)
    .join(', ');
  const extras = [
    best.medianDurationSec === null ? null : `median ${durationLabel(best.medianDurationSec)}`,
    best.meanCostUsd === null ? null : `est. cost $${best.meanCostUsd.toFixed(2)}`,
  ].filter((x): x is string => x !== null);
  return {
    recommended: best.runtime,
    confidence,
    scope: input.scope,
    options,
    text:
      `Recommended runtime for ${input.scope}: ${runtimeLabel(best.runtime)} — ${pct(best.rate)} good outcomes ` +
      `(n=${String(best.n)})${vs === '' ? '' : ` vs ${vs}`}` +
      (extras.length === 0 ? '' : `; ${extras.join('; ')}`) +
      (confidence === 'weak' ? ' (low confidence)' : ''),
  };
}

export interface AutoCandidate {
  readonly runtime: string;
  readonly cell: OutcomeCell | null;
  /** Why auto mode may not pick it (not allowed, paid, at its usage limit, no machine); null = available. */
  readonly excluded: string | null;
}

export interface AutoDecision {
  readonly runtime: string | null;
  readonly how: 'best' | 'explore' | 'fallback' | 'none';
  readonly reasons: readonly string[];
  readonly considered: readonly {
    readonly runtime: string;
    readonly n: number;
    readonly rate: number | null;
    readonly excluded: string | null;
  }[];
}

/**
 * Auto mode (per project opt-in): among the available candidates pick the best counted one by expected outcome;
 * with probability `explorationShare` (one draw of `random`) pick the least-sampled uncounted one instead — never
 * when `allowExploration` is false (production deploy jobs) or when nothing is counted yet. Nothing counted: the
 * first available runtime of `fallbackOrder` (the routing rule / the project's usual runtime), else the first by name.
 */
export function chooseAutoRuntime(input: {
  readonly candidates: readonly AutoCandidate[];
  readonly minSamples: number;
  readonly explorationShare: number;
  readonly allowExploration: boolean;
  readonly random: () => number;
  readonly fallbackOrder: readonly string[];
}): AutoDecision {
  const considered = input.candidates.map((c) => ({
    runtime: c.runtime,
    n: c.cell?.n ?? 0,
    rate: c.cell?.rate ?? null,
    excluded: c.excluded,
  }));
  const excluded = input.candidates
    .filter((c) => c.excluded !== null)
    .map((c) => `${runtimeLabel(c.runtime)} skipped: ${c.excluded ?? ''}`);
  const avail = input.candidates.filter((c) => c.excluded === null);
  if (avail.length === 0) {
    return {
      runtime: null,
      how: 'none',
      reasons: ['no runtime is available for auto mode', ...excluded],
      considered,
    };
  }
  const counted = avail
    .filter(
      (c): c is AutoCandidate & { cell: OutcomeCell } => c.cell !== null && c.cell.n >= input.minSamples,
    )
    .sort((a, b) => better(a.cell, b.cell));
  const under = avail
    .filter((c) => (c.cell?.n ?? 0) < input.minSamples)
    .sort((a, b) => (a.cell?.n ?? 0) - (b.cell?.n ?? 0) || a.runtime.localeCompare(b.runtime));
  const best = counted[0];
  if (best === undefined) {
    const pick =
      input.fallbackOrder.find((r) => avail.some((c) => c.runtime === r)) ??
      avail.map((c) => c.runtime).sort()[0];
    return {
      runtime: pick ?? null,
      how: 'fallback',
      reasons: [
        `no runtime has ${String(input.minSamples)} finished jobs of this kind here yet; used ${runtimeLabel(pick ?? '')} (${
          input.fallbackOrder.includes(pick ?? '') ? 'routing order' : 'first available'
        })`,
        ...excluded,
      ],
      considered,
    };
  }
  const share = Math.min(Math.max(input.explorationShare, 0), 1);
  const explore = under[0];
  if (input.allowExploration && share > 0 && explore !== undefined && input.random() < share) {
    return {
      runtime: explore.runtime,
      how: 'explore',
      reasons: [
        `exploration (${String(Math.round(share * 100))}% of auto decisions): ${runtimeLabel(explore.runtime)} has only ${String(
          explore.cell?.n ?? 0,
        )} finished jobs here; best known is ${runtimeLabel(best.runtime)} ${pct(best.cell.rate)} (n=${String(best.cell.n)})`,
        ...excluded,
      ],
      considered,
    };
  }
  const second = counted[1];
  return {
    runtime: best.runtime,
    how: 'best',
    reasons: [
      `best expected outcome: ${runtimeLabel(best.runtime)} ${pct(best.cell.rate)} good (n=${String(best.cell.n)})` +
        (second === undefined
          ? ''
          : ` vs ${runtimeLabel(second.runtime)} ${pct(second.cell.rate)} (n=${String(second.cell.n)})`),
      ...excluded,
    ],
    considered,
  };
}
