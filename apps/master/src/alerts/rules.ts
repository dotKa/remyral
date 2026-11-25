import type { Queryable } from '../db/pool.js';
import type { Severity } from '../notifications/model.js';
import { machineLink } from '../workers/console-links.js';
import { PLATFORM_JOB_SQL } from '../verify/report-only.js';

/**
 * Alert rules (docs/ops/slo.md "Alerting", docs/design/p6-observability.md §6). Each rule reads Postgres
 * (the source of truth) and returns the instances whose condition holds *now*; the evaluator turns the
 * difference to the stored state into fire/resolve notifications. Details are numbers and identifiers only.
 */
export const ALERT_RULES = [
  'worker.offline_with_work',
  'queue.backlog',
  'jobs.failure_spike',
  'budget.threshold',
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export interface AlertThresholds {
  /** Worker offline at least this long while it still has open attempts (SLO: 10 min). */
  readonly workerOfflineMs: number;
  /** A job waiting in QUEUED at least this long (SLO: 5 min). */
  readonly backlogMs: number;
  /** Failure-spike window (SLO: 30 min) and baseline period (7 days). */
  readonly failureWindowMs: number;
  readonly failureBaselineMs: number;
  /** Spike = failures in the window > factor × baseline average per window (SLO: 3×) … */
  readonly failureFactor: number;
  /** … and at least this many failures (no alarm for 1 failure on a quiet system). */
  readonly failureMinCount: number;
  /** Budget consumption ratios (SLO: 80 % notify; 100 % = exceeded). */
  readonly budgetWarnRatio: number;
  readonly budgetCriticalRatio: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  workerOfflineMs: 10 * 60_000,
  backlogMs: 5 * 60_000,
  failureWindowMs: 30 * 60_000,
  failureBaselineMs: 7 * 24 * 60 * 60_000,
  failureFactor: 3,
  failureMinCount: 3,
  budgetWarnRatio: 0.8,
  budgetCriticalRatio: 1,
};

export interface Condition {
  readonly rule: AlertRule;
  readonly instance: string;
  readonly severity: Severity;
  readonly details: Readonly<Record<string, number | string>>;
}

export interface BudgetSample {
  readonly id: string;
  readonly metric: string;
  readonly ratio: number;
  readonly complete: boolean;
}

export interface RuleContext {
  readonly db: Queryable;
  readonly now: Date;
  readonly t: AlertThresholds;
  readonly budgets: () => Promise<readonly BudgetSample[]>;
}

const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms);
const minutes = (ms: number): number => Math.round(ms / 6_000) / 10;

/** Workers offline ≥ threshold that still hold work (open attempts or unreleased leases). */
async function workerOfflineWithWork(c: RuleContext): Promise<Condition[]> {
  const { rows } = await c.db.query<{ id: string; since: Date; attempts: number; leases: number }>(
    `SELECT w.id, COALESCE(w.last_seen_at, w.connected_at, w.approved_at) AS since,
            (SELECT count(*)::int FROM job_attempts a WHERE a.worker_id = w.id AND a.state <> 'ended') AS attempts,
            (SELECT count(*)::int FROM leases l WHERE l.worker_id = w.id AND l.released_at IS NULL) AS leases
       FROM workers w
      WHERE w.state = 'offline' AND w.archived_at IS NULL
        AND COALESCE(w.last_seen_at, w.connected_at, w.approved_at) <= $1`,
    [ago(c.now, c.t.workerOfflineMs)],
  );
  return rows
    .filter((r) => r.attempts + r.leases > 0)
    .map((r) => ({
      rule: 'worker.offline_with_work' as const,
      instance: r.id,
      severity: 'critical' as const,
      details: {
        offlineMinutes: minutes(c.now.getTime() - r.since.getTime()),
        openAttempts: r.attempts,
        activeLeases: r.leases,
      },
    }));
}

/** Jobs waiting in QUEUED longer than the threshold (one global instance). */
async function queueBacklog(c: RuleContext): Promise<Condition[]> {
  const { rows } = await c.db.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(state_changed_at) AS oldest
       FROM jobs WHERE state = 'QUEUED' AND state_changed_at <= $1`,
    [ago(c.now, c.t.backlogMs)],
  );
  const r = rows[0];
  if (!r || r.n === 0 || r.oldest === null) return [];
  return [
    {
      rule: 'queue.backlog',
      instance: 'global',
      severity: 'warning',
      details: { waitingJobs: r.n, oldestWaitMinutes: minutes(c.now.getTime() - r.oldest.getTime()) },
    },
  ];
}

/**
 * FAILED/LOST transitions in the window versus the baseline average per window. p19-verifier-jobs: platform verifier
 * jobs (and fix jobs opened for them) are not counted — a verifier that cannot read a repository is not a job failure.
 */
async function failureSpike(c: RuleContext): Promise<Condition[]> {
  const windowStart = ago(c.now, c.t.failureWindowMs);
  const baselineStart = ago(windowStart, c.t.failureBaselineMs);
  const { rows } = await c.db.query<{ recent: number; baseline: number }>(
    `SELECT count(*) FILTER (WHERE occurred_at > $1 AND occurred_at <= $3)::int AS recent,
            count(*) FILTER (WHERE occurred_at > $2 AND occurred_at <= $1)::int AS baseline
       FROM job_transitions
      WHERE to_state IN ('FAILED', 'LOST') AND occurred_at > $2 AND occurred_at <= $3
        AND NOT ${PLATFORM_JOB_SQL('job_transitions', 'job_id')}`,
    [windowStart, baselineStart, c.now],
  );
  const recent = rows[0]?.recent ?? 0;
  const baselineTotal = rows[0]?.baseline ?? 0;
  const perWindow = baselineTotal / (c.t.failureBaselineMs / c.t.failureWindowMs);
  if (recent < c.t.failureMinCount || recent <= c.t.failureFactor * perWindow) return [];
  return [
    {
      rule: 'jobs.failure_spike',
      instance: 'global',
      severity: 'warning',
      details: {
        failuresInWindow: recent,
        windowMinutes: minutes(c.t.failureWindowMs),
        baselinePerWindow: Math.round(perWindow * 100) / 100,
      },
    },
  ];
}

/** Enabled budgets at ≥ warn ratio in their current window (critical at ≥ critical ratio). */
async function budgetThreshold(c: RuleContext): Promise<Condition[]> {
  const out: Condition[] = [];
  for (const b of await c.budgets()) {
    if (!Number.isFinite(b.ratio) || b.ratio < c.t.budgetWarnRatio) continue;
    out.push({
      rule: 'budget.threshold',
      instance: b.id,
      severity: b.ratio >= c.t.budgetCriticalRatio ? 'critical' : 'warning',
      details: {
        percentUsed: Math.round(b.ratio * 1000) / 10,
        metric: /^[a-z_]{1,32}$/.test(b.metric) ? b.metric : 'other',
        complete: b.complete ? 'yes' : 'no',
      },
    });
  }
  return out;
}

export const RULES: Readonly<Record<AlertRule, (c: RuleContext) => Promise<Condition[]>>> = {
  'worker.offline_with_work': workerOfflineWithWork,
  'queue.backlog': queueBacklog,
  'jobs.failure_spike': failureSpike,
  'budget.threshold': budgetThreshold,
};

/** Console link per rule (relative paths only, validated by the notification model again). */
export function alertLink(rule: AlertRule, instance: string): string {
  switch (rule) {
    case 'worker.offline_with_work':
      return machineLink(instance);
    case 'queue.backlog':
    case 'jobs.failure_spike':
      return '/jobs';
    case 'budget.threshold':
      return '/usage';
  }
}

export const RULE_TITLE: Readonly<Record<AlertRule, string>> = {
  'worker.offline_with_work': 'Worker offline with work',
  'queue.backlog': 'Job queue backlog',
  'jobs.failure_spike': 'Job failure spike',
  'budget.threshold': 'Budget threshold',
};
