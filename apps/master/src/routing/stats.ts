import { type JobSpec, jobRoleOf } from '@remyral/protocol';
import { OUTCOME_SCORING, type PlacementOutcomes } from '@remyral/scheduler';
import type { Queryable } from '../db/pool.js';

/**
 * p6-smart-routing §3 (docs/design/p6-smart-routing.md): the `job_stats` outcome rollup.
 *
 * One row per project × runtime × model × kind × machine, updated incrementally in the transaction that ends an
 * attempt (`recordAttemptOutcome`, called by the job store). Durations go into a fixed histogram so p50 / p90 can be
 * estimated without keeping every sample; cost and tokens are the usage the runtime reported for the attempt up to
 * its end (usage events arrive before the result; a straggler after the end is not added).
 */

/** Upper bounds (seconds) of the duration histogram buckets; the last bucket is open (+inf). */
export const DURATION_BOUNDS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400] as const;
export const BUCKETS = DURATION_BOUNDS.length + 1;

export function bucketOf(sec: number): number {
  const i = DURATION_BOUNDS.findIndex((b) => sec <= b);
  return i === -1 ? DURATION_BOUNDS.length : i;
}

/**
 * The q-quantile (0 < q ≤ 1) estimated from the histogram by linear interpolation inside its bucket (the open last
 * bucket reports its lower bound). null for an empty histogram.
 */
export function quantile(hist: readonly number[], q: number): number | null {
  const n = hist.reduce((a, b) => a + b, 0);
  if (n === 0) return null;
  const target = q * n;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const c = hist[i] ?? 0;
    if (c > 0 && cum + c >= target) {
      const lower = i === 0 ? 0 : (DURATION_BOUNDS[i - 1] ?? 0);
      const upper = DURATION_BOUNDS[i];
      if (upper === undefined) return lower;
      return Math.round(lower + ((target - cum) / c) * (upper - lower));
    }
    cum += c;
  }
  return DURATION_BOUNDS[DURATION_BOUNDS.length - 1] ?? null;
}

/** Attempt outcomes that count: a retry is a failed attempt; cancelled / declined attempts say nothing. */
const COUNTED: Readonly<Record<string, 'succeeded' | 'failed'>> = {
  succeeded: 'succeeded',
  failed: 'failed',
  retry: 'failed',
};

export function statsKey(spec: Pick<JobSpec, 'runtime' | 'model' | 'role' | 'prompt' | 'kind'>): {
  runtime: string;
  model: string;
  kind: string;
} {
  return { runtime: spec.runtime, model: spec.model ?? '', kind: jobRoleOf(spec).role ?? '' };
}

/**
 * Adds one ended attempt to the rollup (idempotent per attempt is not needed: the attempt ends exactly once, in the
 * transaction of the transition that ends it). Returns false when the outcome does not count.
 */
export async function recordAttemptOutcome(
  tx: Queryable,
  a: {
    readonly project: string;
    readonly spec: JobSpec;
    readonly attemptId: string;
    readonly workerId: string;
    readonly outcome: string;
    readonly startedAt: Date;
    readonly endedAt: Date;
  },
): Promise<boolean> {
  const counted = COUNTED[a.outcome];
  if (counted === undefined) return false;
  const key = statsKey(a.spec);
  const sec = Math.max(0, (a.endedAt.getTime() - a.startedAt.getTime()) / 1000);
  const hist = Array.from({ length: BUCKETS }, (_, i) => (i === bucketOf(sec) ? 1 : 0));
  const usage = await tx.query<{
    cost: string | null;
    cost_n: number;
    input: string | null;
    output: string | null;
  }>(
    `SELECT sum(cost_usd)::text AS cost, count(cost_usd)::int AS cost_n,
            sum(input_tokens)::text AS input, sum(output_tokens)::text AS output
       FROM usage_records WHERE attempt_id = $1`,
    [a.attemptId],
  );
  const u = usage.rows[0];
  const ok = counted === 'succeeded' ? 1 : 0;
  await tx.query(
    `INSERT INTO job_stats (project, runtime, model, kind, worker_id, attempts, succeeded, failed, duration_hist,
                            duration_sum_sec, cost_usd, cost_attempts, input_tokens, output_tokens, first_at, last_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::int[], $9, $10, $11, $12, $13, $14, $14)
     ON CONFLICT (project, runtime, model, kind, worker_id) DO UPDATE SET
       attempts = job_stats.attempts + 1,
       succeeded = job_stats.succeeded + EXCLUDED.succeeded,
       failed = job_stats.failed + EXCLUDED.failed,
       duration_hist = (SELECT array_agg(x + y ORDER BY i)
                          FROM unnest(job_stats.duration_hist, EXCLUDED.duration_hist) WITH ORDINALITY AS t(x, y, i)),
       duration_sum_sec = job_stats.duration_sum_sec + EXCLUDED.duration_sum_sec,
       cost_usd = job_stats.cost_usd + EXCLUDED.cost_usd,
       cost_attempts = job_stats.cost_attempts + EXCLUDED.cost_attempts,
       input_tokens = job_stats.input_tokens + EXCLUDED.input_tokens,
       output_tokens = job_stats.output_tokens + EXCLUDED.output_tokens,
       last_at = GREATEST(job_stats.last_at, EXCLUDED.last_at)`,
    [
      a.project,
      key.runtime,
      key.model,
      key.kind,
      a.workerId,
      ok,
      1 - ok,
      hist,
      sec,
      u?.cost ?? '0',
      (u?.cost_n ?? 0) > 0 ? 1 : 0,
      u?.input ?? '0',
      u?.output ?? '0',
      a.endedAt,
    ],
  );
  return true;
}

interface StatsRow {
  project: string;
  runtime: string;
  model: string;
  kind: string;
  worker_id: string;
  attempts: number;
  succeeded: number;
  failed: number;
  duration_hist: number[];
  duration_sum_sec: number;
  cost_usd: string;
  cost_attempts: number;
  input_tokens: string;
  output_tokens: string;
  last_at: Date;
}

function sumHist(rows: readonly { duration_hist: readonly number[] }[]): number[] {
  const out = Array.from({ length: BUCKETS }, () => 0);
  for (const r of rows) r.duration_hist.forEach((c, i) => (out[i] = (out[i] ?? 0) + c));
  return out;
}

/**
 * Placement facts: per machine, the outcomes of `runtime × model × kind` in this project when it has at least the
 * minimum sample size, else across all projects (scope `fleet`). Machines without any row are absent.
 */
export async function outcomesFor(
  db: Queryable,
  key: { readonly project: string; readonly runtime: string; readonly model: string; readonly kind: string },
): Promise<Map<string, PlacementOutcomes>> {
  const { rows } = await db.query<StatsRow>(
    `SELECT project, worker_id, attempts, succeeded, duration_hist FROM job_stats
      WHERE runtime = $1 AND model = $2 AND kind = $3`,
    [key.runtime, key.model, key.kind],
  );
  const byWorker = new Map<string, StatsRow[]>();
  for (const r of rows) byWorker.set(r.worker_id, [...(byWorker.get(r.worker_id) ?? []), r]);
  const out = new Map<string, PlacementOutcomes>();
  for (const [worker, list] of [...byWorker.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const own = list.filter((r) => r.project === key.project);
    const ownN = own.reduce((n, r) => n + r.attempts, 0);
    const use = ownN >= OUTCOME_SCORING.minSamples ? own : list;
    out.set(worker, {
      samples: use.reduce((n, r) => n + r.attempts, 0),
      succeeded: use.reduce((n, r) => n + r.succeeded, 0),
      p50DurationSec: quantile(sumHist(use), 0.5),
      scope: use === own ? 'project' : 'fleet',
    });
  }
  return out;
}

export const STATS_GROUPS = ['runtime', 'model', 'kind', 'project', 'worker'] as const;
export type StatsGroup = (typeof STATS_GROUPS)[number];

export interface JobStatsRow {
  readonly runtime: string | null;
  readonly model: string | null;
  readonly kind: string | null;
  readonly project: string | null;
  readonly workerId: string | null;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly successRate: number | null;
  readonly p50DurationSec: number | null;
  readonly p90DurationSec: number | null;
  readonly meanDurationSec: number | null;
  readonly costUsd: number;
  /** Mean cost per attempt that reported a cost (null: none did). */
  readonly costPerAttemptUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastAt: string;
}

/**
 * The rollup for the API and Usage → Outcomes: filtered, grouped by the chosen dimensions (the others are summed and
 * reported as null), sorted by attempts. `projects`: the projects the caller may read (null = all).
 */
export async function listJobStats(
  db: Queryable,
  q: {
    readonly projects: readonly string[] | null;
    readonly project?: string | undefined;
    readonly runtime?: string | undefined;
    readonly kind?: string | undefined;
    readonly workerId?: string | undefined;
    readonly groupBy: readonly StatsGroup[];
    readonly limit: number;
  },
): Promise<JobStatsRow[]> {
  const { rows } = await db.query<StatsRow>(
    `SELECT project, runtime, model, kind, worker_id, attempts, succeeded, failed, duration_hist, duration_sum_sec,
            cost_usd::text AS cost_usd, cost_attempts, input_tokens::text AS input_tokens,
            output_tokens::text AS output_tokens, last_at
       FROM job_stats
      WHERE ($1::text[] IS NULL OR project = ANY($1))
        AND ($2::text IS NULL OR project = $2) AND ($3::text IS NULL OR runtime = $3)
        AND ($4::text IS NULL OR kind = $4) AND ($5::text IS NULL OR worker_id = $5)`,
    [
      q.projects === null ? null : [...q.projects],
      q.project ?? null,
      q.runtime ?? null,
      q.kind ?? null,
      q.workerId ?? null,
    ],
  );
  const g = new Set(q.groupBy);
  const groups = new Map<string, StatsRow[]>();
  for (const r of rows) {
    const k = JSON.stringify([
      g.has('runtime') ? r.runtime : null,
      g.has('model') ? r.model : null,
      g.has('kind') ? r.kind : null,
      g.has('project') ? r.project : null,
      g.has('worker') ? r.worker_id : null,
    ]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: JobStatsRow[] = [];
  for (const [k, list] of groups) {
    const [runtime, model, kind, project, workerId] = JSON.parse(k) as (string | null)[];
    const attempts = list.reduce((n, r) => n + r.attempts, 0);
    const succeeded = list.reduce((n, r) => n + r.succeeded, 0);
    const hist = sumHist(list);
    const durationSum = list.reduce((n, r) => n + r.duration_sum_sec, 0);
    const cost = list.reduce((n, r) => n + Number(r.cost_usd), 0);
    const costAttempts = list.reduce((n, r) => n + r.cost_attempts, 0);
    out.push({
      runtime: runtime ?? null,
      model: model ?? null,
      kind: kind ?? null,
      project: project ?? null,
      workerId: workerId ?? null,
      attempts,
      succeeded,
      failed: list.reduce((n, r) => n + r.failed, 0),
      successRate: attempts === 0 ? null : succeeded / attempts,
      p50DurationSec: quantile(hist, 0.5),
      p90DurationSec: quantile(hist, 0.9),
      meanDurationSec: attempts === 0 ? null : Math.round(durationSum / attempts),
      costUsd: Math.round(cost * 1e6) / 1e6,
      costPerAttemptUsd: costAttempts === 0 ? null : Math.round((cost / costAttempts) * 1e6) / 1e6,
      inputTokens: list.reduce((n, r) => n + Number(r.input_tokens), 0),
      outputTokens: list.reduce((n, r) => n + Number(r.output_tokens), 0),
      lastAt: new Date(Math.max(...list.map((r) => r.last_at.getTime()))).toISOString(),
    });
  }
  out.sort(
    (a, b) =>
      b.attempts - a.attempts ||
      JSON.stringify([a.runtime, a.model, a.kind, a.project, a.workerId]).localeCompare(
        JSON.stringify([b.runtime, b.model, b.kind, b.project, b.workerId]),
      ),
  );
  return out.slice(0, q.limit);
}
