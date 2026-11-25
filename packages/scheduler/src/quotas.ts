/**
 * Quotas (p4-quotas, docs/design/p4-quotas.md): pure concurrency limits, fair ordering across projects,
 * per-job run limits and provider pauses. No I/O; the master loads the facts and enforces the verdicts.
 */
import type { PlacementReason, ReasonSummary } from './placement.js';

/** Per-job run limits (JobSpec.limits, narrowed by project/global defaults: the smallest value wins). */
export interface JobLimits {
  readonly maxCostUsd?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxWallTimeSec?: number | undefined;
}

export const JOB_LIMIT_KEYS = ['maxCostUsd', 'maxTokens', 'maxTurns', 'maxWallTimeSec'] as const;
export type JobLimitKey = (typeof JOB_LIMIT_KEYS)[number];

/** A provider account (e.g. one Claude subscription) used by several workers: it counts once. */
export interface ProviderAccount {
  readonly id: string;
  readonly runtime: string;
  readonly provider?: string | undefined;
  /** Concurrent jobs across every member worker (absent = unlimited). */
  readonly maxConcurrent?: number | undefined;
  readonly workers: readonly string[];
}

export interface QuotaPolicy {
  readonly projects: Readonly<
    Record<
      string,
      {
        readonly maxConcurrent?: number | undefined;
        /** Fair-share weight (default 1). */
        readonly weight?: number | undefined;
        readonly jobLimits?: JobLimits | undefined;
      }
    >
  >;
  readonly runtimes: Readonly<Record<string, { readonly maxConcurrent?: number | undefined }>>;
  readonly accounts: readonly ProviderAccount[];
  /** Applies to every job (after the project's limits). */
  readonly jobLimits?: JobLimits | undefined;
  readonly budgets: {
    /**
     * A budget or job limit whose figure is incomplete (p6-cost `unknown`: some records lack the metric,
     * e.g. unknown-cost records for a dollar budget) and whose known part is below 100 %: `warn` (default:
     * admit/continue, record and notify) or `block` (hold new jobs / stop the running job).
     */
    readonly incomplete: 'warn' | 'block';
    /** A scope budget at ≥ 100 %: hold new jobs only (default) or also stop running ones. */
    readonly onExceeded: 'refuse_new' | 'stop_running';
  };
  readonly providerPause: {
    /** Pause length when the runtime gives no reset time. */
    readonly defaultBackoffSec: number;
    /** Upper bound for any pause (a worker-reported reset time is clamped to it). */
    readonly maxPauseSec: number;
  };
  readonly fairness: {
    /** A queued job gains one priority point per this many seconds of waiting (within its project). */
    readonly agingSec: number;
    /** Jobs a project started in this window count towards its share (fairness memory). */
    readonly windowSec: number;
  };
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  projects: {},
  runtimes: {},
  accounts: [],
  budgets: { incomplete: 'warn', onExceeded: 'refuse_new' },
  providerPause: { defaultBackoffSec: 900, maxPauseSec: 86_400 },
  fairness: { agingSec: 60, windowSec: 600 },
};

/** The smallest defined value per limit (a job can only be narrowed, never widened, by defaults). */
export function effectiveJobLimits(...sources: readonly (JobLimits | undefined)[]): JobLimits {
  const out: Partial<Record<JobLimitKey, number>> = {};
  for (const s of sources) {
    if (s === undefined) continue;
    for (const k of JOB_LIMIT_KEYS) {
      const v = s[k];
      if (v === undefined || !Number.isFinite(v) || v < 0) continue;
      const cur = out[k];
      out[k] = cur === undefined ? v : Math.min(cur, v);
    }
  }
  return out;
}

/** What a job consumed so far (sums over its usage records; unknown counts mean "not reported"). */
export interface JobConsumption {
  readonly records: number;
  readonly tokens: number;
  readonly tokensUnknownRecords: number;
  readonly turns: number;
  readonly turnsUnknownRecords: number;
  /** Known dollars (reported + estimated); a lower bound when `costComplete` is false. */
  readonly costUsd: number;
  readonly costComplete: boolean;
  /** Wall time since the job's first attempt started (master clock). */
  readonly wallTimeMs: number;
}

export type LimitVerdict =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'exceeded';
      readonly limit: JobLimitKey;
      readonly used: number;
      readonly max: number;
      readonly message: string;
    }
  /** The known part is below the limit but some records lack the metric: cannot be called safe. */
  | { readonly kind: 'incomplete'; readonly limit: JobLimitKey; readonly used: number; readonly max: number };

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '');
}

/**
 * Checks a running job against its limits (p6-cost semantics): a known lower bound at/over the limit is
 * `exceeded` even with gaps; an incomplete figure below the limit is `incomplete` (never "under"). Checked
 * in a fixed order (cost, tokens, turns, wall time); the first exceeded limit wins.
 */
export function checkJobLimits(limits: JobLimits, c: JobConsumption): LimitVerdict {
  const rows: [JobLimitKey, number, boolean, string][] = [
    ['maxCostUsd', c.costUsd, c.costComplete, 'cost (USD)'],
    ['maxTokens', c.tokens, c.tokensUnknownRecords === 0, 'tokens'],
    ['maxTurns', c.turns, c.turnsUnknownRecords === 0, 'turns'],
    ['maxWallTimeSec', c.wallTimeMs / 1000, true, 'wall time (s)'],
  ];
  let incomplete: LimitVerdict | null = null;
  for (const [key, used, complete, label] of rows) {
    const max = limits[key];
    if (max === undefined) continue;
    if (used >= max) {
      return {
        kind: 'exceeded',
        limit: key,
        used,
        max,
        message: `${label} ${fmt(used)}${complete ? '' : '+'} reached the job limit ${fmt(max)}`,
      };
    }
    if (!complete && incomplete === null) incomplete = { kind: 'incomplete', limit: key, used, max };
  }
  return incomplete ?? { kind: 'ok' };
}

/** Jobs counted against concurrency limits (attempt-open states, incl. LOST: it may still run). */
export interface ActiveJob {
  readonly project: string;
  readonly runtime: string;
  /** Worker of the current attempt. */
  readonly workerId: string | null;
}

export interface ConcurrencyJob {
  readonly project: string;
  readonly runtime: string;
}

export type QuotaReasonCode =
  | 'project_concurrency'
  | 'runtime_concurrency'
  | 'budget_exceeded'
  | 'budget_incomplete'
  | 'project_hold'
  | 'dependency_pending'
  // p6-quota-scheduling: a deferrable job waits for its project's off-peak window.
  | 'deferred_off_peak'
  // p9-queue-priority: the project's per-user / per-automation concurrency limits.
  | 'user_concurrency'
  | 'automation_concurrency'
  // p16-ops-safety: the model cost brake (block mode) holds new non-urgent jobs over a spend ceiling.
  | 'cost_brake';

/** A job-level hold: the job stays QUEUED (waiting) with this reason. */
export interface QuotaHold {
  readonly code: QuotaReasonCode;
  readonly message: string;
  /** p6-quota-scheduling: when the hold ends by itself (ISO-8601), when known. */
  readonly until?: string | undefined;
}

export function holdSummary(holds: readonly QuotaHold[]): ReasonSummary[] {
  return holds.map((h) => ({
    code: h.code,
    permanent: false,
    message: h.message,
    workers: [],
    ...(h.until === undefined ? {} : { until: h.until }),
  }));
}

/** Job-level concurrency limits (project, runtime). */
export function concurrencyHolds(
  job: ConcurrencyJob,
  active: readonly ActiveJob[],
  policy: QuotaPolicy,
): QuotaHold[] {
  const out: QuotaHold[] = [];
  const pmax = policy.projects[job.project]?.maxConcurrent;
  if (pmax !== undefined) {
    const n = active.filter((a) => a.project === job.project).length;
    if (n >= pmax) {
      out.push({
        code: 'project_concurrency',
        message: `project ${job.project} runs ${String(n)}/${String(pmax)} concurrent jobs`,
      });
    }
  }
  const rmax = policy.runtimes[job.runtime]?.maxConcurrent;
  if (rmax !== undefined) {
    const n = active.filter((a) => a.runtime === job.runtime).length;
    if (n >= rmax) {
      out.push({
        code: 'runtime_concurrency',
        message: `runtime ${job.runtime} runs ${String(n)}/${String(rmax)} concurrent jobs fleet-wide`,
      });
    }
  }
  return out;
}

/** An active provider pause (ADR-0014 §5: `provider_usage_limit`). */
export interface ProviderPause {
  readonly id: string;
  /** `worker_runtime`: one runtime on one worker; `account`: every member of a provider account. */
  readonly scope: 'worker_runtime' | 'account';
  readonly workerId: string | null;
  readonly runtime: string;
  readonly accountId: string | null;
  readonly resumeAt: Date;
}

/** The account a (worker, runtime) pair belongs to, if any (first match). */
export function accountOf(
  accounts: readonly ProviderAccount[],
  workerId: string,
  runtime: string,
): ProviderAccount | null {
  return accounts.find((a) => a.runtime === runtime && a.workers.includes(workerId)) ?? null;
}

/**
 * Worker-level quota exclusions for placement (transient): a paused runtime/account, a full provider
 * account. A subscription account shared by several workers counts once: its active jobs are summed over
 * every member worker.
 */
export function workerQuotaBlocks(
  workerId: string,
  runtime: string,
  policy: QuotaPolicy,
  active: readonly ActiveJob[],
  pauses: readonly ProviderPause[],
  now: Date,
): PlacementReason[] {
  const out: PlacementReason[] = [];
  const account = accountOf(policy.accounts, workerId, runtime);
  const live = pauses.filter((p) => p.resumeAt.getTime() > now.getTime() && p.runtime === runtime);
  const pause =
    live.find((p) => p.scope === 'worker_runtime' && p.workerId === workerId) ??
    (account === null ? undefined : live.find((p) => p.scope === 'account' && p.accountId === account.id));
  if (pause !== undefined) {
    out.push({
      code: 'provider_paused',
      permanent: false,
      message: `${runtime} paused after a provider usage limit${
        pause.scope === 'account' ? ` (account ${pause.accountId ?? ''})` : ''
      } until ${pause.resumeAt.toISOString()}`,
      until: pause.resumeAt.toISOString(),
    });
  }
  if (account?.maxConcurrent !== undefined) {
    const n = active.filter(
      (a) => a.runtime === runtime && a.workerId !== null && account.workers.includes(a.workerId),
    ).length;
    if (n >= account.maxConcurrent) {
      out.push({
        code: 'account_concurrency',
        permanent: false,
        message: `provider account ${account.id} runs ${String(n)}/${String(account.maxConcurrent)} concurrent jobs`,
      });
    }
  }
  return out;
}

/** When a pause ends: the runtime's reset time (clamped to [now + 60 s, now + max]) or the default backoff. */
export function pauseUntil(now: Date, resetAt: Date | null, policy: QuotaPolicy): Date {
  const max = now.getTime() + policy.providerPause.maxPauseSec * 1000;
  if (resetAt !== null && Number.isFinite(resetAt.getTime())) {
    return new Date(Math.min(Math.max(resetAt.getTime(), now.getTime() + 60_000), max));
  }
  return new Date(Math.min(now.getTime() + policy.providerPause.defaultBackoffSec * 1000, max));
}

export interface QueuedJob {
  readonly id: string;
  readonly project: string;
  readonly priority: number;
  readonly createdAt: Date;
}

/**
 * p9-queue-priority: the class of a stored numeric priority — urgent ≥ 50, background ≤ -50, else normal. Mirrors
 * `priorityClassOf` of @remyral/protocol (the scheduler has no protocol dependency; a master test pins both).
 */
export function priorityTier(priority: number): 'urgent' | 'normal' | 'background' {
  if (priority >= 50) return 'urgent';
  if (priority <= -50) return 'background';
  return 'normal';
}

const TIERS = ['urgent', 'normal', 'background'] as const;

/**
 * Fair dispatch order across projects (weighted fair share with aging), by class (p9-queue-priority):
 *
 * - Classes first: every urgent (Acil) job is tried before every normal one, background (Arka plan) jobs last — they
 *   only take what is left. The class comes from the stored priority; aging never moves a job into another class.
 * - Within a class and a project jobs keep their order by effective priority (priority + one point per `agingSec` of
 *   waiting), then age.
 * - Within a class, across projects the next job comes from the project with the lowest share
 *   `(load + picked) / weight`, where `load` is the project's active jobs plus the jobs it started within the
 *   fairness window (the master counts both). A project cannot buy precedence over another with a high priority
 *   inside a class, and a heavy project cannot starve a light one: every start raises its share. Ties: the project
 *   whose head job has the higher effective priority, then the older head job, then project id.
 */
export function fairOrder(
  queued: readonly QueuedJob[],
  load: ReadonlyMap<string, number>,
  policy: QuotaPolicy,
  now: Date,
): string[] {
  const taken = new Map<string, number>(load);
  const out: string[] = [];
  for (const tier of TIERS) {
    out.push(
      ...fairOrderWithin(
        queued.filter((j) => priorityTier(j.priority) === tier),
        taken,
        policy,
        now,
      ),
    );
  }
  return out;
}

/** Effective priority: stored priority plus one point per `agingSec` of waiting. */
export function effectivePriority(j: QueuedJob, policy: QuotaPolicy, now: Date): number {
  const aging = Math.max(policy.fairness.agingSec, 1) * 1000;
  return j.priority + Math.floor(Math.max(0, now.getTime() - j.createdAt.getTime()) / aging);
}

function fairOrderWithin(
  queued: readonly QueuedJob[],
  taken: Map<string, number>,
  policy: QuotaPolicy,
  now: Date,
): string[] {
  const eff = (j: QueuedJob): number => effectivePriority(j, policy, now);
  const byProject = new Map<string, QueuedJob[]>();
  for (const j of queued) {
    const list = byProject.get(j.project) ?? [];
    list.push(j);
    byProject.set(j.project, list);
  }
  for (const list of byProject.values()) {
    list.sort(
      (a, b) => eff(b) - eff(a) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
  }
  const weight = (p: string): number => {
    const w = policy.projects[p]?.weight;
    return w !== undefined && w > 0 ? w : 1;
  };
  const out: string[] = [];
  const cursor = new Map<string, number>();
  for (;;) {
    let best: string | null = null;
    let bestShare = Infinity;
    let bestHead: QueuedJob | null = null;
    for (const [p, list] of byProject) {
      const i = cursor.get(p) ?? 0;
      const head = list[i];
      if (head === undefined) continue;
      const share = (taken.get(p) ?? 0) / weight(p);
      const better =
        best === null ||
        share < bestShare ||
        (share === bestShare &&
          bestHead !== null &&
          (eff(head) > eff(bestHead) ||
            (eff(head) === eff(bestHead) &&
              (head.createdAt.getTime() < bestHead.createdAt.getTime() ||
                (head.createdAt.getTime() === bestHead.createdAt.getTime() && p < best)))));
      if (better) {
        best = p;
        bestShare = share;
        bestHead = head;
      }
    }
    if (best === null || bestHead === null) break;
    out.push(bestHead.id);
    cursor.set(best, (cursor.get(best) ?? 0) + 1);
    taken.set(best, (taken.get(best) ?? 0) + 1);
  }
  return out;
}

/** p9-queue-priority: a project's optional per-user / per-automation concurrency limits (absent / null = off). */
export interface OwnerLimits {
  readonly maxPerUser?: number | null | undefined;
  readonly maxPerAutomation?: number | null | undefined;
}

/** Who started a job, for {@link ownerHolds}: the creating user and, for an automation job, the automation. */
export interface JobOwner {
  readonly project: string;
  readonly userId: string | null;
  readonly automationId: string | null;
}

/**
 * p9-queue-priority (plan §3.7): holds when the job's creator or automation already runs its project's limit. Counts
 * active jobs of the same project only (a person's jobs elsewhere do not count). A job an automation started counts
 * against the automation, not against the person who owns the automation.
 */
export function ownerHolds(job: JobOwner, active: readonly JobOwner[], limits: OwnerLimits): QuotaHold[] {
  const out: QuotaHold[] = [];
  const same = active.filter((a) => a.project === job.project);
  const u = limits.maxPerUser;
  if (u !== undefined && u !== null && job.userId !== null && job.automationId === null) {
    const n = same.filter((a) => a.userId === job.userId && a.automationId === null).length;
    if (n >= u) {
      out.push({
        code: 'user_concurrency',
        message: `${job.userId} already runs ${String(n)}/${String(u)} jobs in project ${job.project} (per-user limit)`,
      });
    }
  }
  const m = limits.maxPerAutomation;
  if (m !== undefined && m !== null && job.automationId !== null) {
    const n = same.filter((a) => a.automationId === job.automationId).length;
    if (n >= m) {
      out.push({
        code: 'automation_concurrency',
        message: `automation ${job.automationId} already runs ${String(n)}/${String(m)} jobs in project ${job.project} (per-automation limit)`,
      });
    }
  }
  return out;
}
