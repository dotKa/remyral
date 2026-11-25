import type { Queryable } from '../../db/pool.js';

/**
 * p14-workflow-engine 14.4 (design §20): database helpers of the workflow operations — concurrency groups, failure
 * streaks, retention and the editor's metrics. The engine owns every transition; these read (and, for retention, prune
 * finished data) only.
 */

/** The advisory lock of a concurrency group (`(project, name, key)`), transaction-scoped at start and promotion. */
export function concurrencyLock(project: string, name: string, key: string | null): string {
  return `wfc:${JSON.stringify([project, name, key])}`;
}

/** Open (`active` + `paused`) and `queued` engine-2 runs of a concurrency group (sub-workflow runs are exempt). */
export async function groupCounts(
  db: Queryable,
  project: string,
  name: string,
  key: string | null,
): Promise<{ open: number; queued: number }> {
  const { rows } = await db.query<{ open: number; queued: number }>(
    `SELECT count(*) FILTER (WHERE state IN ('active', 'paused'))::int AS open,
            count(*) FILTER (WHERE state = 'queued')::int AS queued
       FROM workflow_runs
      WHERE engine = 2 AND project = $1 AND name = $2 AND concurrency_key IS NOT DISTINCT FROM $3
        AND parent_run_id IS NULL AND state IN ('queued', 'active', 'paused')`,
    [project, name, key],
  );
  return { open: rows[0]?.open ?? 0, queued: rows[0]?.queued ?? 0 };
}

/** The oldest open runs of a group (cancelOldest). */
export async function oldestOpen(
  db: Queryable,
  project: string,
  name: string,
  key: string | null,
  limit: number,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM workflow_runs
      WHERE engine = 2 AND project = $1 AND name = $2 AND concurrency_key IS NOT DISTINCT FROM $3
        AND parent_run_id IS NULL AND state IN ('active', 'paused')
      ORDER BY created_at, id LIMIT $4`,
    [project, name, key, limit],
  );
  return rows.map((r) => r.id);
}

/** The 1-based place of a queued run among its group's queued runs (null: not queued). */
export async function queuePosition(db: Queryable, runId: string): Promise<number | null> {
  const { rows } = await db.query<{ pos: number | null }>(
    `SELECT (SELECT count(*)::int FROM workflow_runs q
              WHERE q.engine = 2 AND q.state = 'queued' AND q.project = r.project AND q.name = r.name
                AND q.concurrency_key IS NOT DISTINCT FROM r.concurrency_key AND q.parent_run_id IS NULL
                AND (q.created_at, q.id) <= (r.created_at, r.id)) AS pos
       FROM workflow_runs r WHERE r.id = $1 AND r.state = 'queued'`,
    [runId],
  );
  return rows[0]?.pos ?? null;
}

/**
 * Failed top-level runs in a row of a workflow, newest first (cancelled runs neither count nor break the streak), and
 * the streak's identity for the alert's dedupe key: the succeeded run that ended the previous streak (`start` when
 * there is none) — stable however the failed runs of the streak are ordered.
 */
export async function failureStreak(
  db: Queryable,
  project: string,
  name: string,
): Promise<{ count: number; streakId: string }> {
  const { rows } = await db.query<{ id: string; state: string }>(
    `SELECT id, state FROM workflow_runs
      WHERE engine = 2 AND project = $1 AND name = $2 AND parent_run_id IS NULL AND ended_at IS NOT NULL
        AND state IN ('succeeded', 'failed')
      ORDER BY ended_at DESC, (state = 'failed') DESC, id DESC LIMIT 101`,
    [project, name],
  );
  let count = 0;
  for (const r of rows) {
    if (r.state !== 'failed') return { count, streakId: r.id };
    count++;
  }
  return { count, streakId: 'start' };
}

/** The value a pruned field becomes. */
export const PRUNED = { $pruned: true } as const;

/** Whether a stored value (or anything inside a node run's input / output) was pruned by retention. */
export function isPruned(v: unknown): boolean {
  return v !== null && typeof v === 'object' && (v as { $pruned?: unknown }).$pruned === true;
}

/**
 * What a terminal node run keeps of its input after retention: AI steps their role, prepared definition, placement,
 * planner parent and reused job (the run view stays drawable); every other input only the marker.
 */
export function prunedInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && 'role' in input && 'spec' in input) {
    const a = input as {
      role?: unknown;
      spec?: { runtime?: unknown };
      def?: unknown;
      placement?: unknown;
      parent?: unknown;
      reusedJobId?: unknown;
    };
    const def = a.def as { prompt?: unknown } | undefined;
    return {
      $pruned: true,
      role: a.role,
      // Only the runtime of the prepared job (the prompt carried run data).
      spec: { runtime: a.spec?.runtime ?? null },
      // The prompt of a planned task carries run data (it was written by the planner): dropped.
      ...(def === undefined ? {} : { def: { ...def, prompt: '' } }),
      ...(a.placement === undefined ? {} : { placement: a.placement }),
      ...(a.parent === undefined ? {} : { parent: a.parent }),
      ...(a.reusedJobId === undefined ? {} : { reusedJobId: a.reusedJobId }),
    };
  }
  return { ...PRUNED };
}

/** What a terminal node run keeps of its output after retention (AI steps: job ids, branch and planner expansion). */
export function prunedOutput(output: unknown): Record<string, unknown> | null {
  if (output === null || output === undefined) return null;
  if (typeof output === 'object' && !('ports' in output)) {
    const o = output as { jobId?: unknown; attemptId?: unknown; branch?: unknown; expansion?: unknown };
    return {
      $pruned: true,
      ...(o.jobId === undefined ? {} : { jobId: o.jobId }),
      ...(o.attemptId === undefined ? {} : { attemptId: o.attemptId }),
      ...(o.branch === undefined ? {} : { branch: o.branch }),
      ...(o.expansion === undefined ? {} : { expansion: o.expansion }),
    };
  }
  return { ...PRUNED };
}

/** Finished top-level engine-2 runs whose data is due for pruning (oldest first), with their retention days. */
export async function runsDueForPruning(
  db: Queryable,
  now: Date,
  defaultDays: number,
  limit: number,
): Promise<{ id: string; days: number }[]> {
  // Retention: the run's version's `settings.retentionDays`, else the project's, else the default. A run whose parent
  // is still open is skipped (the parent may still read its outputs). p18-multi-project: a run of a project that
  // attached the workflow keeps its data for that attachment's `retentionDays`, else as the definition / its project.
  const { rows } = await db.query<{ id: string; days: number }>(
    `SELECT r.id, COALESCE((a.overrides ->> 'retentionDays')::int, (d.definition #>> '{settings,retentionDays}')::int,
                           p.workflow_data_retention_days, $2::int) AS days
       FROM workflow_runs r
       JOIN workflow_definitions d ON d.id = r.definition_id
       JOIN projects p ON p.id = r.project
       LEFT JOIN workflow_attachments a ON a.id = r.attachment_id
      WHERE r.engine = 2 AND r.data_pruned_at IS NULL AND r.ended_at IS NOT NULL
        AND r.state IN ('succeeded', 'failed', 'cancelled')
        AND r.ended_at <= $1::timestamptz - make_interval(days => COALESCE((a.overrides ->> 'retentionDays')::int,
              (d.definition #>> '{settings,retentionDays}')::int, p.workflow_data_retention_days, $2::int))
        AND NOT EXISTS (SELECT 1 FROM workflow_runs pr WHERE pr.id = r.parent_run_id
                         AND pr.state IN ('queued', 'active', 'paused'))
      ORDER BY r.ended_at LIMIT $3`,
    [now, defaultDays, limit],
  );
  return rows;
}

/** One finished run's data pruned (node runs, payloads, received webhook bodies, trigger data, outputs). */
export async function pruneRun(db: Queryable, runId: string, now: Date): Promise<{ nodeRuns: number }> {
  const { rows } = await db.query<{ id: string; input: unknown; output: unknown }>(
    `SELECT id, input, output FROM workflow_node_runs
      WHERE run_id = $1 AND state IN ('succeeded', 'failed', 'skipped', 'cancelled')
        AND NOT (COALESCE(input ? '$pruned', false))`,
    [runId],
  );
  for (const r of rows) {
    await db.query('UPDATE workflow_node_runs SET input = $2, output = $3 WHERE id = $1', [
      r.id,
      JSON.stringify(prunedInput(r.input)),
      (() => {
        const o = prunedOutput(r.output);
        return o === null ? null : JSON.stringify(o);
      })(),
    ]);
  }
  await db.query(
    `UPDATE workflow_payloads SET content = NULL, pruned_at = $2 WHERE run_id = $1 AND content IS NOT NULL`,
    [runId, now],
  );
  await db.query(
    `UPDATE workflow_waits SET received = $2 WHERE received IS NOT NULL
        AND node_run_id IN (SELECT id FROM workflow_node_runs WHERE run_id = $1)`,
    [runId, JSON.stringify(PRUNED)],
  );
  await db.query(
    `UPDATE workflow_runs SET data_pruned_at = $2,
            trigger_data = CASE WHEN trigger_data IS NULL THEN NULL ELSE $3::jsonb END,
            outputs = CASE WHEN outputs IS NULL THEN NULL ELSE $3::jsonb END
      WHERE id = $1 AND data_pruned_at IS NULL`,
    [runId, now, JSON.stringify(PRUNED)],
  );
  return { nodeRuns: rows.length };
}

/** The editor's metrics of a workflow (every version) over the last `days` days (§20.4). */
export interface WorkflowMetricsView {
  readonly days: number;
  readonly runs: Record<'queued' | 'active' | 'paused' | 'succeeded' | 'failed' | 'cancelled', number>;
  readonly failureStreak: number;
  readonly alertAfter: number;
  readonly nodes: readonly {
    node: string;
    type: string;
    runs: number;
    failed: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  }[];
  readonly recentFailures: readonly { runId: string; endedAt: string; reason: string | null }[];
}

export async function workflowMetrics(
  db: Queryable,
  w: { project: string; name: string; alertAfter: number },
  days: number,
  now: Date,
): Promise<WorkflowMetricsView> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [runs, nodes, failures, streak] = await Promise.all([
    db.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM workflow_runs
        WHERE engine = 2 AND project = $1 AND name = $2 AND parent_run_id IS NULL
          AND (state IN ('queued', 'active', 'paused') OR ended_at >= $3)
        GROUP BY state`,
      [w.project, w.name, since],
    ),
    // Node runs that executed (copies of a re-run excluded), latest attempts and retries alike.
    db.query<{
      node_id: string;
      node_type: string;
      runs: number;
      failed: number;
      p50: number | null;
      p95: number | null;
      max: number | null;
    }>(
      `SELECT nr.node_id, nr.node_type, count(*)::int AS runs,
              count(*) FILTER (WHERE nr.state = 'failed')::int AS failed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM nr.ended_at - nr.started_at) * 1000)
                FILTER (WHERE nr.started_at IS NOT NULL) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM nr.ended_at - nr.started_at) * 1000)
                FILTER (WHERE nr.started_at IS NOT NULL) AS p95,
              max(extract(epoch FROM nr.ended_at - nr.started_at) * 1000) AS max
         FROM workflow_node_runs nr JOIN workflow_runs r ON r.id = nr.run_id
        WHERE r.engine = 2 AND r.project = $1 AND r.name = $2 AND nr.copied_from IS NULL
          AND nr.ended_at IS NOT NULL AND nr.ended_at >= $3 AND nr.state IN ('succeeded', 'failed')
        GROUP BY nr.node_id, nr.node_type
        ORDER BY nr.node_id LIMIT 200`,
      [w.project, w.name, since],
    ),
    db.query<{ id: string; ended_at: Date; reason: string | null }>(
      `SELECT id, ended_at, reason FROM workflow_runs
        WHERE engine = 2 AND project = $1 AND name = $2 AND parent_run_id IS NULL AND state = 'failed'
          AND ended_at >= $3
        ORDER BY ended_at DESC LIMIT 10`,
      [w.project, w.name, since],
    ),
    failureStreak(db, w.project, w.name),
  ]);
  const by = Object.fromEntries(runs.rows.map((r) => [r.state, r.n]));
  const ms = (v: number | null): number | null => (v === null ? null : Math.round(v));
  return {
    days,
    runs: {
      queued: by.queued ?? 0,
      active: by.active ?? 0,
      paused: by.paused ?? 0,
      succeeded: by.succeeded ?? 0,
      failed: by.failed ?? 0,
      cancelled: by.cancelled ?? 0,
    },
    failureStreak: streak.count,
    alertAfter: w.alertAfter,
    nodes: nodes.rows.map((n) => ({
      node: n.node_id,
      type: n.node_type,
      runs: n.runs,
      failed: n.failed,
      p50Ms: ms(n.p50),
      p95Ms: ms(n.p95),
      maxMs: ms(n.max),
    })),
    recentFailures: failures.rows.map((f) => ({
      runId: f.id,
      endedAt: f.ended_at.toISOString(),
      reason: f.reason === null ? null : f.reason.slice(0, 300),
    })),
  };
}
