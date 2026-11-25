import { jobRoleOf } from '@remyral/protocol';
import {
  type BudgetBilling,
  type GroupSummary,
  type PeriodGrain,
  periodKey,
  periodsBetween,
  summarize,
  type UsageBucket,
} from '@remyral/usage';
import type { Queryable } from '../db/pool.js';
import { loadCatalog } from '../models/service.js';
import { loadRoutingRules } from '../routing/rules.js';
import { listJobStats } from '../routing/stats.js';
import type { UsageFilter, UsageStore } from '../usage/store.js';
import { type Suggestion, suggest, type WorkerInput } from './suggestions.js';
import { PLATFORM_JOB_SQL } from '../verify/report-only.js';

/**
 * p8-cost-efficiency (docs/design/p8-cost-efficiency.md §4–§6): the cost & efficiency dashboard — spend and usage
 * trends, breakdowns by project / runtime / model / job kind / automation / machine, top expensive and slowest jobs,
 * outcomes and cost per successful job, success rates per runtime × model (job_stats), savings counters and the
 * rule-based suggestions. Read-only; every query is limited to the caller's visible projects.
 *
 * Semantics: **spend** is the usage recorded in the period (the p6-cost rules: dollars only for API-billed records
 * with a known cost, unknown is a gap and never zero, subscription records are tokens / turns / time plus a clearly
 * labelled API-equivalent estimate). **Outcomes** are the jobs that finished in the period; their cost per success
 * uses each job's whole usage.
 */

export const DIMENSIONS = ['project', 'runtime', 'model', 'kind', 'automation', 'worker'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Jobs considered per query (breakdowns, top lists); beyond it the result says `truncated`. */
export const MAX_JOBS = 5000;
/** Assumed human wait per auto-approved command when no human decision was measured in the period. */
export const DEFAULT_APPROVAL_WAIT_SEC = 120;
const LOOKBACK_MS = 30 * 86_400_000;

export interface DashboardQuery {
  readonly from: Date;
  readonly to: Date;
  readonly grain: PeriodGrain;
  readonly timeZone: string;
  /** p5-rbac: visible projects (null = all). */
  readonly projects: readonly string[] | null;
  readonly project?: string | undefined;
  readonly billing?: BudgetBilling | undefined;
  readonly dimension: Dimension;
}

export interface Spend {
  readonly records: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly turns: number;
  readonly wallTimeMs: number;
  /** Known dollars (API-billed: runtime-reported + estimated from the price table). A lower bound unless complete. */
  readonly costUsd: number;
  readonly costComplete: boolean;
  readonly unknownCostRecords: number;
  readonly subscriptionRecords: number;
  /** What the subscription records would cost on API billing — an estimate, never money spent. */
  readonly apiEquivalentUsd: number;
  readonly apiEquivalentUnpricedRecords: number;
  readonly metricsIncomplete: boolean;
}

export interface TrendPoint extends Spend {
  readonly key: string;
  readonly start: string;
  readonly end: string;
}

export interface BreakdownRow {
  readonly key: string | null;
  readonly label: string;
  readonly spend: Spend;
  /** Jobs with usage in the period. */
  readonly jobs: number;
  /** Jobs that finished in the period. */
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly successRate: number | null;
  /** Known dollars per successful job (their whole usage); null without a successful job. */
  readonly costPerSuccessUsd: number | null;
  readonly costPerSuccessComplete: boolean;
  /** API-equivalent estimate per successful job (subscription usage). */
  readonly apiEquivalentPerSuccessUsd: number | null;
}

export interface TopJob {
  readonly jobId: string;
  readonly project: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly kind: string | null;
  readonly automationId: string | null;
  readonly automationName: string | null;
  readonly workerId: string | null;
  readonly state: string;
  readonly finishedAt: string | null;
  readonly durationSec: number | null;
  readonly costUsd: number;
  readonly costComplete: boolean;
  readonly apiEquivalentUsd: number;
  readonly tokens: number;
}

export interface SuccessRate {
  readonly runtime: string | null;
  readonly model: string | null;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly successRate: number | null;
  readonly p50DurationSec: number | null;
  readonly p90DurationSec: number | null;
  readonly costPerAttemptUsd: number | null;
}

export interface Savings {
  readonly reuse: {
    readonly hits: number;
    readonly automationRuns: number;
    readonly workflowSteps: number;
    /** Estimated: the reused jobs' own run time and known cost, once per hit. */
    readonly estimatedSeconds: number;
    readonly estimatedCostUsd: number;
    readonly estimatedApiEquivalentUsd: number;
  };
  readonly warmCaches: {
    /** Attempts started with the shared package cache offered (trusted, non-container, project switch on). */
    readonly runs: number;
  };
  readonly safeAutoApprove: {
    readonly approvals: number;
    readonly medianHumanWaitSec: number;
    /** False: no human decision in the period, the default wait was assumed. */
    readonly measured: boolean;
    readonly estimatedSecondsSaved: number;
  };
}

export interface Outcomes {
  readonly finished: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly successRate: number | null;
  readonly costPerSuccessUsd: number | null;
  readonly costPerSuccessComplete: boolean;
  readonly apiEquivalentPerSuccessUsd: number | null;
}

export interface Dashboard {
  readonly range: {
    readonly from: string;
    readonly to: string;
    readonly grain: PeriodGrain;
    readonly timeZone: string;
  };
  readonly priceTableVersion: number;
  readonly totals: Spend;
  readonly trends: readonly TrendPoint[];
  readonly breakdown: { readonly dimension: Dimension; readonly rows: readonly BreakdownRow[] };
  readonly outcomes: Outcomes;
  readonly topCostly: readonly TopJob[];
  readonly slowest: readonly TopJob[];
  readonly successRates: readonly SuccessRate[];
  readonly savings: Savings;
  readonly missingPrices: readonly { provider: string; model: string; records: number }[];
  readonly truncated: boolean;
}

export interface EfficiencyDeps {
  readonly pool: Queryable;
  readonly usage: UsageStore;
  readonly clock: () => Date;
  /** Machines with their effective and recommended parallelism (p6-capacity-advice) and capacity mode. */
  readonly workers?: () => Promise<readonly WorkerInput[]>;
}

export function spendOf(g: GroupSummary): Spend {
  return {
    records: g.records,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    cacheReadTokens: g.cacheReadTokens,
    turns: g.turns,
    wallTimeMs: g.wallTimeMs,
    costUsd: g.costUsd.total,
    costComplete: g.flags.costComplete,
    unknownCostRecords: g.coverage.unknown,
    subscriptionRecords: g.coverage.subscription,
    apiEquivalentUsd: g.apiEquivalent.usd,
    apiEquivalentUnpricedRecords: g.apiEquivalent.unpricedRecords,
    metricsIncomplete: g.flags.metricsIncomplete,
  };
}

const EMPTY = spendOf(summarize([]).totals);

interface JobFact {
  readonly id: string;
  readonly project: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly kind: string | null;
  readonly automationId: string | null;
  readonly automationName: string | null;
  readonly workerId: string | null;
  readonly state: string;
  readonly finishedAt: Date | null;
  readonly durationSec: number | null;
  readonly errorCode: string | null;
}

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Job-level usage key: job id, runtime and machine of the record (`|` never occurs in either). */
const JOB_KEY = { sql: () => `r.job_id::text || '|' || r.runtime || '|' || r.worker_id` };
const JOB_ONLY = { sql: () => 'r.job_id::text' };

function splitKey(key: string | null): { jobId: string; runtime: string; workerId: string } | null {
  const parts = key?.split('|') ?? [];
  if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined || parts[2] === undefined)
    return null;
  return { jobId: parts[0], runtime: parts[1], workerId: parts[2] };
}

function rate(succeeded: number, failed: number): number | null {
  return succeeded + failed === 0 ? null : succeeded / (succeeded + failed);
}

export class EfficiencyService {
  constructor(private readonly deps: EfficiencyDeps) {}

  #filter(q: Pick<DashboardQuery, 'projects' | 'project' | 'billing'>): UsageFilter {
    return {
      ...(q.project === undefined ? {} : { project: q.project }),
      ...(q.projects === null ? {} : { projects: q.projects }),
      ...(q.billing === undefined || q.billing === 'all' ? {} : { billing: q.billing }),
    };
  }

  // ------------------------------------------------------------------------------------- facts

  async #facts(ids: readonly string[]): Promise<Map<string, JobFact>> {
    const out = new Map<string, JobFact>();
    if (ids.length === 0) return out;
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      spec: Record<string, unknown>;
      state: string;
      state_changed_at: Date;
      automation_id: string | null;
      automation_name: string | null;
      worker_id: string | null;
      duration_sec: string | null;
      error_code: string | null;
    }>(
      `SELECT DISTINCT ON (j.id) j.id::text AS id, j.project, j.spec, j.state::text AS state, j.state_changed_at,
              COALESCE(ar.automation_id, war.automation_id)::text AS automation_id, au.name AS automation_name,
              (SELECT x.worker_id FROM job_attempts x WHERE x.job_id = j.id ORDER BY x.number DESC LIMIT 1) AS worker_id,
              (SELECT sum(EXTRACT(EPOCH FROM (x.ended_at - x.started_at)))::text FROM job_attempts x
                WHERE x.job_id = j.id AND x.ended_at IS NOT NULL) AS duration_sec,
              (SELECT jr.result -> 'error' ->> 'code' FROM job_runs jr JOIN job_attempts x ON x.id = jr.attempt_id
                WHERE x.job_id = j.id ORDER BY x.number DESC LIMIT 1) AS error_code
         FROM jobs j
         LEFT JOIN automation_runs ar ON ar.job_id = j.id
         LEFT JOIN workflow_job_links n ON n.job_id = j.id
         LEFT JOIN automation_runs war ON war.workflow_run_id = n.run_id
         LEFT JOIN automations au ON au.id = COALESCE(ar.automation_id, war.automation_id)
        WHERE j.id = ANY($1::uuid[])
        ORDER BY j.id`,
      [[...ids]],
    );
    for (const r of rows) {
      const spec = r.spec;
      const str = (k: string): string | null => (typeof spec[k] === 'string' ? spec[k] : null);
      const prompt = str('prompt');
      const role = jobRoleOf({
        ...(str('role') === null ? {} : { role: str('role') ?? undefined }),
        ...(prompt === null ? {} : { prompt }),
        ...(str('kind') === null ? {} : { kind: str('kind') ?? undefined }),
      }).role;
      out.set(r.id, {
        id: r.id,
        project: r.project,
        runtime: str('runtime') ?? 'unknown',
        model: str('model'),
        kind: role,
        automationId: r.automation_id,
        automationName: r.automation_name,
        workerId: r.worker_id,
        state: r.state,
        finishedAt: TERMINAL.includes(r.state) ? r.state_changed_at : null,
        durationSec: r.duration_sec === null ? null : Math.round(Number(r.duration_sec)),
        errorCode: r.error_code !== null && ERROR_CODE.test(r.error_code) ? r.error_code : null,
      });
    }
    return out;
  }

  /** Jobs that finished in [from, to) in the visible projects (newest first, capped). */
  async #finished(q: DashboardQuery): Promise<{ ids: string[]; truncated: boolean }> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM jobs
        WHERE state::text = ANY($1::text[]) AND state_changed_at >= $2 AND state_changed_at < $3
          AND ($4::text[] IS NULL OR project = ANY($4::text[])) AND ($5::text IS NULL OR project = $5)
        ORDER BY state_changed_at DESC LIMIT $6`,
      [TERMINAL, q.from, q.to, q.projects === null ? null : [...q.projects], q.project ?? null, MAX_JOBS + 1],
    );
    return { ids: rows.slice(0, MAX_JOBS).map((r) => r.id), truncated: rows.length > MAX_JOBS };
  }

  // ------------------------------------------------------------------------------------- dashboard

  async dashboard(q: DashboardQuery): Promise<Dashboard> {
    const filter = this.#filter(q);
    const [period, trend, finished] = await Promise.all([
      this.deps.usage.pricedBuckets(JOB_KEY, filter, q.from, q.to),
      this.trends(q),
      this.#finished(q),
    ]);
    const usageJobIds = new Set<string>();
    for (const b of period.buckets) {
      const k = splitKey(b.key);
      if (k !== null) usageJobIds.add(k.jobId);
    }
    const truncatedUsage = usageJobIds.size > MAX_JOBS;
    const factIds = [...new Set([...[...usageJobIds].slice(0, MAX_JOBS), ...finished.ids])];
    const facts = await this.#facts(factIds);
    // Whole usage of the jobs that finished in the period (cost per success, top lists).
    const finishedFacts = finished.ids.flatMap((id) => facts.get(id) ?? []);
    const oldest = finishedFacts.reduce<Date | null>(
      (m, f) => (m === null || (f.finishedAt !== null && f.finishedAt < m) ? f.finishedAt : m),
      null,
    );
    const lifetime =
      finishedFacts.length === 0
        ? { buckets: [] as UsageBucket[] }
        : await this.deps.usage.pricedBuckets(
            JOB_ONLY,
            { ...filter, jobIds: finishedFacts.map((f) => f.id) },
            new Date((oldest ?? q.from).getTime() - 400 * 86_400_000),
            new Date(this.deps.clock().getTime() + 1000),
          );
    const perJobLifetime = new Map(
      summarize(lifetime.buckets).groups.flatMap((g) => (g.key === null ? [] : [[g.key, g] as const])),
    );
    const modelOf = mainModels(lifetime.buckets);
    const perJobPeriod = new Map(
      summarize(period.buckets.map((b) => ({ ...b, key: splitKey(b.key)?.jobId ?? null }))).groups.flatMap(
        (g) => (g.key === null ? [] : [[g.key, g] as const]),
      ),
    );

    const totals = summarize(period.buckets).totals;
    return {
      range: { from: q.from.toISOString(), to: q.to.toISOString(), grain: q.grain, timeZone: q.timeZone },
      priceTableVersion: period.priceTableVersion,
      totals: spendOf(totals),
      trends: trend,
      breakdown: {
        dimension: q.dimension,
        rows: this.#breakdown(q.dimension, period.buckets, facts, finishedFacts, perJobLifetime, modelOf),
      },
      outcomes: this.#outcomes(finishedFacts, perJobLifetime),
      topCostly: [...perJobPeriod.entries()]
        .sort(
          ([, a], [, b]) =>
            b.costUsd.total - a.costUsd.total ||
            b.apiEquivalent.usd - a.apiEquivalent.usd ||
            b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
        )
        .slice(0, 10)
        .flatMap(([id, g]) => {
          const f = facts.get(id);
          return f === undefined ? [] : [topJob(f, g)];
        }),
      slowest: finishedFacts
        .filter((f) => f.durationSec !== null)
        .sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0) || a.id.localeCompare(b.id))
        .slice(0, 10)
        .map((f) => topJob(f, perJobLifetime.get(f.id) ?? null)),
      successRates: await this.successRates(q.projects, q.project),
      savings: await this.savings(q),
      missingPrices: totals.missingPrices.map((m) => ({
        provider: m.provider,
        model: m.model,
        records: m.records,
      })),
      truncated: finished.truncated || truncatedUsage,
    };
  }

  /** Usage per local calendar period (day / week / month in `timeZone`), gaps filled with empty periods. */
  async trends(q: DashboardQuery): Promise<TrendPoint[]> {
    const grain = q.grain;
    const { buckets } = await this.deps.usage.pricedBuckets(
      {
        // `grain` is one of three literals (validated); the zone is a bound parameter.
        sql: (params) => {
          params.push(q.timeZone);
          return `to_char(date_trunc('${grain}', r.recorded_at AT TIME ZONE $${String(params.length)}), 'YYYY-MM-DD')`;
        },
      },
      this.#filter(q),
      q.from,
      q.to,
    );
    const byKey = new Map(summarize(buckets).groups.map((g) => [g.key, g]));
    return periodsBetween(grain, q.from, q.to, q.timeZone, 400).map((p) => {
      const key = periodKey(p.start, q.timeZone);
      const g = byKey.get(key);
      return { key, start: p.start.toISOString(), end: p.end.toISOString(), ...(g ? spendOf(g) : EMPTY) };
    });
  }

  #dimensionOf(
    d: Dimension,
    f: JobFact | undefined,
    usage: { runtime: string; workerId: string; model: string | null } | null,
  ): { key: string | null; label: string } {
    switch (d) {
      case 'project':
        return { key: f?.project ?? null, label: f?.project ?? 'unknown' };
      case 'runtime': {
        const v = usage?.runtime ?? f?.runtime ?? null;
        return { key: v, label: v ?? 'unknown' };
      }
      case 'model': {
        const v = usage === null ? (f?.model ?? null) : usage.model;
        return { key: v, label: v ?? 'not reported' };
      }
      case 'kind':
        return { key: f?.kind ?? null, label: f?.kind ?? 'unclassified' };
      case 'automation':
        return f?.automationId
          ? { key: f.automationId, label: f.automationName ?? f.automationId }
          : { key: null, label: 'not an automation' };
      case 'worker': {
        const v = usage?.workerId ?? f?.workerId ?? null;
        return { key: v, label: v ?? 'unknown' };
      }
    }
  }

  #breakdown(
    d: Dimension,
    buckets: readonly UsageBucket[],
    facts: ReadonlyMap<string, JobFact>,
    finished: readonly JobFact[],
    lifetime: ReadonlyMap<string, GroupSummary>,
    modelOf: ReadonlyMap<string, string>,
  ): BreakdownRow[] {
    const labels = new Map<string | null, string>();
    const jobsOf = new Map<string | null, Set<string>>();
    const regrouped = buckets.map((b) => {
      const k = splitKey(b.key);
      const dim = this.#dimensionOf(d, k === null ? undefined : facts.get(k.jobId), {
        runtime: k?.runtime ?? 'unknown',
        workerId: k?.workerId ?? 'unknown',
        model: b.model,
      });
      labels.set(dim.key, dim.label);
      if (k !== null) jobsOf.set(dim.key, (jobsOf.get(dim.key) ?? new Set()).add(k.jobId));
      return { ...b, key: dim.key };
    });
    const spend = new Map(summarize(regrouped).groups.map((g) => [g.key, g]));
    const outcome = new Map<string | null, JobFact[]>();
    for (const f of finished) {
      const dim = this.#dimensionOf(
        d,
        f,
        d === 'model' ? { runtime: f.runtime, workerId: '', model: modelOf.get(f.id) ?? f.model } : null,
      );
      labels.set(dim.key, labels.get(dim.key) ?? dim.label);
      outcome.set(dim.key, [...(outcome.get(dim.key) ?? []), f]);
    }
    const keys = new Set<string | null>([...spend.keys(), ...outcome.keys()]);
    const rows = [...keys].map((key): BreakdownRow => {
      const done = outcome.get(key) ?? [];
      const o = this.#outcomes(done, lifetime);
      const g = spend.get(key);
      return {
        key,
        label: labels.get(key) ?? key ?? 'unknown',
        spend: g === undefined ? EMPTY : spendOf(g),
        jobs: jobsOf.get(key)?.size ?? 0,
        succeeded: o.succeeded,
        failed: o.failed,
        cancelled: o.cancelled,
        successRate: o.successRate,
        costPerSuccessUsd: o.costPerSuccessUsd,
        costPerSuccessComplete: o.costPerSuccessComplete,
        apiEquivalentPerSuccessUsd: o.apiEquivalentPerSuccessUsd,
      };
    });
    return rows.sort(
      (a, b) =>
        b.spend.costUsd - a.spend.costUsd ||
        b.spend.apiEquivalentUsd - a.spend.apiEquivalentUsd ||
        b.spend.inputTokens + b.spend.outputTokens - (a.spend.inputTokens + a.spend.outputTokens) ||
        b.succeeded + b.failed - (a.succeeded + a.failed) ||
        a.label.localeCompare(b.label),
    );
  }

  #outcomes(finished: readonly JobFact[], lifetime: ReadonlyMap<string, GroupSummary>): Outcomes {
    const succeeded = finished.filter((f) => f.state === 'SUCCEEDED');
    const failed = finished.filter((f) => f.state === 'FAILED').length;
    const cancelled = finished.filter((f) => f.state === 'CANCELLED').length;
    let cost = 0;
    let eq = 0;
    let complete = true;
    for (const f of succeeded) {
      const g = lifetime.get(f.id);
      if (g === undefined) continue;
      cost += g.costUsd.total;
      eq += g.apiEquivalent.usd;
      if (!g.flags.costComplete) complete = false;
    }
    const n = succeeded.length;
    return {
      finished: finished.length,
      succeeded: n,
      failed,
      cancelled,
      successRate: rate(n, failed),
      costPerSuccessUsd: n === 0 ? null : Math.round((cost / n) * 1e6) / 1e6,
      costPerSuccessComplete: complete,
      apiEquivalentPerSuccessUsd: n === 0 ? null : Math.round((eq / n) * 1e6) / 1e6,
    };
  }

  // ------------------------------------------------------------------------------------- job_stats

  /** Success rate per runtime × model from the job_stats rollup (all time; p6-smart-routing). */
  async successRates(projects: readonly string[] | null, project?: string): Promise<SuccessRate[]> {
    const rows = await listJobStats(this.deps.pool, {
      projects,
      project,
      runtime: undefined,
      kind: undefined,
      workerId: undefined,
      groupBy: ['runtime', 'model'],
      limit: 100,
    });
    return rows.map((r) => ({
      runtime: r.runtime,
      model: r.model,
      attempts: r.attempts,
      succeeded: r.succeeded,
      failed: r.failed,
      successRate: r.successRate,
      p50DurationSec: r.p50DurationSec,
      p90DurationSec: r.p90DurationSec,
      costPerAttemptUsd: r.costPerAttemptUsd,
    }));
  }

  // ------------------------------------------------------------------------------------- savings

  async savings(q: Pick<DashboardQuery, 'from' | 'to' | 'projects' | 'project'>): Promise<Savings> {
    const projects = q.projects === null ? null : [...q.projects];
    const project = q.project ?? null;
    const scope = (col: string, base: number): string =>
      `($${String(base)}::text[] IS NULL OR ${col} = ANY($${String(base)}::text[])) AND ($${String(base + 1)}::text IS NULL OR ${col} = $${String(base + 1)})`;
    const { rows: hits } = await this.deps.pool.query<{ job_id: string; source: 'automation' | 'workflow' }>(
      `SELECT r.reused_job_id::text AS job_id, 'automation' AS source FROM automation_runs r
        WHERE r.state = 'skipped' AND r.reused_job_id IS NOT NULL AND r.finished_at >= $1 AND r.finished_at < $2
          AND ${scope('r.project', 3)}
       UNION ALL
       SELECT n.reused_job_id::text, 'workflow' FROM workflow_nodes n JOIN jobs j ON j.id = n.reused_job_id
        WHERE n.reused_job_id IS NOT NULL AND n.updated_at >= $1 AND n.updated_at < $2 AND ${scope('j.project', 3)}
       UNION ALL
       SELECT nr.input->>'reusedJobId', 'workflow' FROM workflow_node_runs nr
         JOIN jobs j ON j.id = (nr.input->>'reusedJobId')::uuid
        WHERE nr.input ? 'reusedJobId' AND nr.updated_at >= $1 AND nr.updated_at < $2 AND ${scope('j.project', 3)}
        LIMIT 5000`,
      [q.from, q.to, projects, project],
    );
    const reusedIds = [...new Set(hits.map((h) => h.job_id))];
    const facts = await this.#facts(reusedIds);
    const life =
      reusedIds.length === 0
        ? new Map<string, GroupSummary>()
        : new Map(
            summarize(
              (
                await this.deps.usage.pricedBuckets(
                  JOB_ONLY,
                  { jobIds: reusedIds },
                  new Date(q.from.getTime() - 400 * 86_400_000),
                  new Date(this.deps.clock().getTime() + 1000),
                )
              ).buckets,
            ).groups.flatMap((g) => (g.key === null ? [] : [[g.key, g] as const])),
          );
    let seconds = 0;
    let cost = 0;
    let eq = 0;
    for (const h of hits) {
      seconds += facts.get(h.job_id)?.durationSec ?? 0;
      cost += life.get(h.job_id)?.costUsd.total ?? 0;
      eq += life.get(h.job_id)?.apiEquivalent.usd ?? 0;
    }

    const { rows: caches } = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_attempts a JOIN jobs j ON j.id = a.job_id JOIN projects p ON p.id = j.project
        WHERE a.started_at >= $1 AND a.started_at < $2 AND p.package_caches
          AND COALESCE(j.spec ->> 'sandboxProfile', 'container') <> 'container'
          AND COALESCE(j.spec ->> 'sourceTrust', 'trusted') = 'trusted' AND ${scope('j.project', 3)}`,
      [q.from, q.to, projects, project],
    );
    const { rows: auto } = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events e JOIN jobs j ON e.target = 'job:' || j.id::text
        WHERE e.action = 'approval.auto_safe' AND e.occurred_at >= $1 AND e.occurred_at < $2 AND ${scope('j.project', 3)}`,
      [q.from, q.to, projects, project],
    );
    const { rows: wait } = await this.deps.pool.query<{ median: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.decided_at - a.created_at)))::float8
                AS median
         FROM approval_requests a JOIN jobs j ON j.id = a.job_id
        WHERE a.action = 'runtime.dangerous_tool' AND a.status IN ('approved', 'denied')
          AND a.decided_at >= $1 AND a.decided_at < $2 AND ${scope('j.project', 3)}`,
      [q.from, q.to, projects, project],
    );
    const median = wait[0]?.median ?? null;
    const approvals = auto[0]?.n ?? 0;
    const waitSec = median === null ? DEFAULT_APPROVAL_WAIT_SEC : Math.round(median);
    return {
      reuse: {
        hits: hits.length,
        automationRuns: hits.filter((h) => h.source === 'automation').length,
        workflowSteps: hits.filter((h) => h.source === 'workflow').length,
        estimatedSeconds: seconds,
        estimatedCostUsd: Math.round(cost * 1e6) / 1e6,
        estimatedApiEquivalentUsd: Math.round(eq * 1e6) / 1e6,
      },
      warmCaches: { runs: caches[0]?.n ?? 0 },
      safeAutoApprove: {
        approvals,
        medianHumanWaitSec: waitSec,
        measured: median !== null,
        estimatedSecondsSaved: approvals * waitSec,
      },
    };
  }

  // ------------------------------------------------------------------------------------- suggestions

  /** Rule-based suggestions for the caller's visible projects (never applied automatically). */
  async suggestions(projects: readonly string[] | null): Promise<Suggestion[]> {
    const now = this.deps.clock();
    const since = new Date(now.getTime() - LOOKBACK_MS);
    const visible = (p: string | null): boolean => projects === null || (p !== null && projects.includes(p));
    const stats = await this.deps.pool.query<{
      runtime: string;
      model: string;
      kind: string;
      attempts: number;
      succeeded: number;
      cost_usd: string;
      cost_attempts: number;
    }>(
      `SELECT runtime, model, kind, sum(attempts)::int AS attempts, sum(succeeded)::int AS succeeded,
              sum(cost_usd)::text AS cost_usd, sum(cost_attempts)::int AS cost_attempts
         FROM job_stats WHERE ($1::text[] IS NULL OR project = ANY($1::text[]))
        GROUP BY runtime, model, kind`,
      [projects === null ? null : [...projects]],
    );
    const catalog = await loadCatalog(this.deps.pool);
    const routing = new Map(
      (await loadRoutingRules(this.deps.pool))
        .filter((r) => r.project === null)
        .map((r) => [r.role, { modelProfile: r.modelProfile, runtimes: [...r.runtimes] }] as const),
    );
    const { rows: autos } = await this.deps.pool.query<{
      id: string;
      name: string;
      project: string;
      target_kind: string;
      trigger_kind: string;
      reuse_within_hours: number | null;
      runs: number;
      failed: number;
      identical: number;
    }>(
      `SELECT a.id::text AS id, a.name, a.project, a.target_kind, a.trigger_kind, a.reuse_within_hours,
              (count(*) FILTER (WHERE r.state IN ('succeeded', 'failed', 'error')))::int AS runs,
              (count(*) FILTER (WHERE r.state IN ('failed', 'error')))::int AS failed,
              (count(*) FILTER (WHERE r.state = 'succeeded' AND EXISTS (
                  SELECT 1 FROM automation_runs r2 JOIN jobs j2 ON j2.id = r2.job_id JOIN jobs j ON j.id = r.job_id
                   WHERE r2.automation_id = a.id AND r2.state = 'succeeded' AND r2.created_at < r.created_at
                     AND r2.created_at >= r.created_at - interval '7 days'
                     AND j.prompt_digest IS NOT NULL AND j2.prompt_digest = j.prompt_digest)))::int AS identical
         FROM automations a JOIN automation_runs r ON r.automation_id = a.id AND r.created_at >= $1
        WHERE a.state = 'active' AND ($2::text[] IS NULL OR a.project = ANY($2::text[]))
        GROUP BY a.id`,
      [since, projects === null ? null : [...projects]],
    );
    const budgets = (
      await this.deps.usage.evaluateBudgetsOfScopes(
        ['global', 'project', 'runtime', 'provider', 'worker'],
        now,
      )
    ).filter(({ budget }) =>
      budget.scope.type === 'project' ? visible(budget.scope.value) : projects === null,
    );
    const period = await this.deps.usage.pricedBuckets(
      null,
      projects === null ? {} : { projects },
      since,
      new Date(now.getTime() + 1000),
    );
    const workers = projects === null && this.deps.workers !== undefined ? await this.deps.workers() : [];
    return suggest({
      now,
      stats: stats.rows.map((s) => ({
        runtime: s.runtime,
        model: s.model,
        kind: s.kind,
        attempts: s.attempts,
        succeeded: s.succeeded,
        costUsd: Number(s.cost_usd),
        costAttempts: s.cost_attempts,
      })),
      profiles: [...catalog.values()]
        .filter((c) => c.entry.enabled)
        .map((c) => ({ id: c.entry.id, model: c.entry.model, runtimes: [...c.entry.runtimes] })),
      routing,
      automations: autos.map((a) => ({
        id: a.id,
        name: a.name,
        project: a.project,
        targetKind: a.target_kind,
        triggerKind: a.trigger_kind,
        reuseWithinHours: a.reuse_within_hours,
        runs: a.runs,
        failed: a.failed,
        identicalSuccessRuns: a.identical,
      })),
      workers,
      budgets: budgets.map(({ budget, evaluation }) => ({
        id: budget.id,
        name: budget.name,
        metric: budget.metric,
        limit: budget.limit,
        used: evaluation.used,
        status: evaluation.status,
        complete: evaluation.complete,
        windowStart: evaluation.window.start,
        windowEnd: evaluation.window.end,
      })),
      missingPrices: summarize(period.buckets).totals.missingPrices.map((m) => ({
        provider: m.provider,
        model: m.model,
        records: m.records,
      })),
    }).filter((s) => visible(s.project) || s.project === null);
  }

  // ------------------------------------------------------------------------------------- export

  /** One row per job with usage in the period (CSV export, operator+). */
  async jobRows(q: DashboardQuery): Promise<{ header: string[]; rows: unknown[][] }> {
    const { buckets } = await this.deps.usage.pricedBuckets(JOB_ONLY, this.#filter(q), q.from, q.to);
    const groups = summarize(buckets)
      .groups.filter((g) => g.key !== null)
      .slice(0, MAX_JOBS);
    const facts = await this.#facts(groups.flatMap((g) => (g.key === null ? [] : [g.key])));
    const modelOf = mainModels(buckets);
    return {
      header: [
        'job_id',
        'project',
        'runtime',
        'model',
        'kind',
        'automation_id',
        'automation',
        'machine',
        'state',
        'finished_at',
        'duration_sec',
        'records',
        'input_tokens',
        'output_tokens',
        'turns',
        'wall_time_ms',
        'cost_usd_known',
        'cost_complete',
        'unknown_cost_records',
        'subscription_records',
        'api_equivalent_usd_estimate',
      ],
      rows: groups.map((g) => {
        const f = g.key === null ? undefined : facts.get(g.key);
        return [
          g.key,
          f?.project ?? '',
          f?.runtime ?? '',
          (g.key === null ? undefined : modelOf.get(g.key)) ?? f?.model ?? '',
          f?.kind ?? '',
          f?.automationId ?? '',
          f?.automationName ?? '',
          f?.workerId ?? '',
          f?.state ?? '',
          f?.finishedAt?.toISOString() ?? '',
          f?.durationSec ?? '',
          g.records,
          g.inputTokens,
          g.outputTokens,
          g.turns,
          g.wallTimeMs,
          g.costUsd.total,
          g.flags.costComplete,
          g.coverage.unknown,
          g.coverage.subscription,
          g.apiEquivalent.usd,
        ];
      }),
    };
  }

  /** Breakdown rows for the CSV export (viewer+). */
  static breakdownRows(d: Dashboard): { header: string[]; rows: unknown[][] } {
    return {
      header: [
        d.breakdown.dimension,
        'key',
        'records',
        'jobs',
        'input_tokens',
        'output_tokens',
        'turns',
        'wall_time_ms',
        'cost_usd_known',
        'cost_complete',
        'unknown_cost_records',
        'subscription_records',
        'api_equivalent_usd_estimate',
        'succeeded',
        'failed',
        'cancelled',
        'success_rate',
        'cost_per_success_usd',
        'api_equivalent_per_success_usd_estimate',
      ],
      rows: d.breakdown.rows.map((r) => [
        r.label,
        r.key ?? '',
        r.spend.records,
        r.jobs,
        r.spend.inputTokens,
        r.spend.outputTokens,
        r.spend.turns,
        r.spend.wallTimeMs,
        r.spend.costUsd,
        r.spend.costComplete,
        r.spend.unknownCostRecords,
        r.spend.subscriptionRecords,
        r.spend.apiEquivalentUsd,
        r.succeeded,
        r.failed,
        r.cancelled,
        r.successRate ?? '',
        r.costPerSuccessUsd ?? '',
        r.apiEquivalentPerSuccessUsd ?? '',
      ]),
    };
  }

  // ------------------------------------------------------------------------------------- report facts

  /** Jobs that failed in [from, to): id, project, runtime, error code (codes only, never runtime free text). */
  async failures(
    q: Pick<DashboardQuery, 'from' | 'to' | 'projects'>,
    limit = 10,
  ): Promise<{ jobId: string; project: string; runtime: string; errorCode: string | null; at: string }[]> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM jobs WHERE state = 'FAILED' AND state_changed_at >= $1 AND state_changed_at < $2
          AND ($3::text[] IS NULL OR project = ANY($3::text[])) AND NOT ${PLATFORM_JOB_SQL('jobs')}
        ORDER BY state_changed_at DESC LIMIT $4`,
      [q.from, q.to, q.projects === null ? null : [...q.projects], limit],
    );
    const facts = await this.#facts(rows.map((r) => r.id));
    return rows.flatMap((r) => {
      const f = facts.get(r.id);
      return f === undefined
        ? []
        : [
            {
              jobId: f.id,
              project: f.project,
              runtime: f.runtime,
              errorCode: f.errorCode,
              at: f.finishedAt?.toISOString() ?? '',
            },
          ];
    });
  }

  /** Ops actions (deploys, restarts, DNS) requested in [from, to). */
  async deployments(q: Pick<DashboardQuery, 'from' | 'to' | 'projects'>): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    items: { id: string; project: string; kind: string; env: string | null; state: string; at: string }[];
  }> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      kind: string;
      env: string | null;
      state: string;
      created_at: Date;
    }>(
      `SELECT id::text AS id, project, kind, env, state, created_at FROM ops_actions
        WHERE created_at >= $1 AND created_at < $2 AND ($3::text[] IS NULL OR project = ANY($3::text[]))
        ORDER BY created_at DESC LIMIT 500`,
      [q.from, q.to, q.projects === null ? null : [...q.projects]],
    );
    return {
      total: rows.length,
      succeeded: rows.filter((r) => r.state === 'succeeded').length,
      failed: rows.filter((r) => ['failed', 'refused', 'denied', 'expired'].includes(r.state)).length,
      items: rows.slice(0, 20).map((r) => ({
        id: r.id,
        project: r.project,
        kind: r.kind,
        env: r.env,
        state: r.state,
        at: r.created_at.toISOString(),
      })),
    };
  }
}

/** Per job (bucket key = job id): the usage-reported model that carried most of its tokens. */
function mainModels(buckets: readonly UsageBucket[]): Map<string, string> {
  const tokens = new Map<string, Map<string, number>>();
  for (const b of buckets) {
    if (b.key === null || b.model === null) continue;
    const m = tokens.get(b.key) ?? new Map<string, number>();
    m.set(b.model, (m.get(b.model) ?? 0) + b.inputTokens + b.outputTokens + b.records);
    tokens.set(b.key, m);
  }
  const out = new Map<string, string>();
  for (const [job, m] of tokens) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best !== undefined) out.set(job, best[0]);
  }
  return out;
}

function topJob(f: JobFact, g: GroupSummary | null): TopJob {
  return {
    jobId: f.id,
    project: f.project,
    runtime: f.runtime,
    model: f.model,
    kind: f.kind,
    automationId: f.automationId,
    automationName: f.automationName,
    workerId: f.workerId,
    state: f.state,
    finishedAt: f.finishedAt?.toISOString() ?? null,
    durationSec: f.durationSec,
    costUsd: g?.costUsd.total ?? 0,
    costComplete: g?.flags.costComplete ?? true,
    apiEquivalentUsd: g?.apiEquivalent.usd ?? 0,
    tokens: (g?.inputTokens ?? 0) + (g?.outputTokens ?? 0),
  };
}
