import { SpanKind } from '@opentelemetry/api';
import type { Telemetry } from '@remyral/observability/telemetry';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.js';

/**
 * Operational metrics of the control plane (p6-otel, docs/design/p6-observability.md §4).
 *
 * - **State gauges** (jobs by state, workers by state, pending approvals, queue age, budget consumption) are
 *   read from Postgres — the source of truth — when a reader collects (Prometheus scrape or OTLP interval),
 *   cached for `cacheMs` so frequent scrapes cost one round of queries.
 * - **Event metrics** (transitions, queue wait, job duration, lease expiries, failures) come from a tailer
 *   over the append-only `job_transitions` table: committed facts only, independent of which code path made
 *   the transition. Each tailed transition also becomes a short `job.transition` span carrying the job,
 *   attempt and worker ids, so a trace backend shows a job's lifecycle.
 *
 * Attributes are enumerations and identifiers only (state, runtime, outcome, budget id) — never prompts,
 * reasons, names or other free text.
 */
export interface MasterMetricsOptions {
  readonly pool: Pool;
  readonly telemetry: Telemetry;
  readonly log?: FastifyBaseLogger;
  readonly clock?: () => Date;
  /** Reuse a collected snapshot for this long (default 15 s). */
  readonly cacheMs?: number;
  /** Budget evaluation for `remyral_budget_consumption_ratio` (internal callers only, see UsageStore). */
  readonly budgets?: () => Promise<readonly { id: string; metric: string; scope: string; ratio: number }[]>;
}

interface Snapshot {
  readonly at: number;
  readonly jobs: readonly { state: string; n: number }[];
  readonly workers: readonly { state: string; n: number }[];
  readonly approvals: number;
  readonly oldestQueuedSec: number;
  readonly activeLeases: number;
  readonly budgets: readonly { id: string; metric: string; scope: string; ratio: number }[];
  /** p14-workflow-engine 14.4: open engine-2 runs by state, waiting node runs by kind, oldest overdue timer. */
  readonly workflowRuns: readonly { state: string; n: number }[];
  readonly workflowWaiting: readonly { kind: string; n: number }[];
  readonly workflowTimerLagSec: number;
}

const QUEUE_BUCKETS = [1, 5, 10, 20, 30, 60, 120, 300, 600, 1800, 3600];
const DURATION_BUCKETS = [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400];
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

interface TransitionRow {
  id: string;
  job_id: string;
  from_state: string | null;
  to_state: string;
  trigger: string;
  attempt_id: string | null;
  epoch: number | null;
  occurred_at: Date;
  previous_at: Date | null;
  created_at: Date;
  runtime: string | null;
  worker_id: string | null;
}

export class MasterMetrics {
  readonly #o: MasterMetricsOptions;
  readonly #now: () => Date;
  #snapshot: Snapshot | null = null;
  #inflight: Promise<Snapshot> | null = null;
  #cursor: string | null = null;
  readonly #transitions;
  readonly #stateSeconds;
  readonly #jobDuration;
  readonly #leaseExpiries;
  readonly #jobFailures;
  readonly #wfNodeDuration;
  readonly #wfNodeFailures;
  readonly #wfRunsFinished;
  /** p14-workflow-engine 14.4: tailer position over finished node runs / runs (ended_at, id). */
  #wfCursor: { at: Date; id: string } | null = null;
  #wfRunCursor: { at: Date; id: string } | null = null;

  constructor(o: MasterMetricsOptions) {
    this.#o = o;
    this.#now = o.clock ?? (() => new Date());
    const m = o.telemetry.meter;
    this.#transitions = m.createCounter('remyral_job_transitions', {
      description: 'Committed job state transitions',
    });
    this.#stateSeconds = m.createHistogram('remyral_job_state_seconds', {
      description: 'Time a job spent in a state before leaving it (QUEUED = queue wait, RUNNING = run time)',
      unit: 's',
      advice: { explicitBucketBoundaries: QUEUE_BUCKETS },
    });
    this.#jobDuration = m.createHistogram('remyral_job_duration_seconds', {
      description: 'Job creation to terminal state, by outcome and runtime',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    });
    this.#leaseExpiries = m.createCounter('remyral_lease_expiries', {
      description: 'Leases that expired without renewal (job moved to LOST)',
    });
    this.#jobFailures = m.createCounter('remyral_job_failures', {
      description: 'Jobs that reached FAILED or LOST, by runtime',
    });
    // p14-workflow-engine 14.4 (design §20.4): engine-2 node runs and runs (node types and closed codes only).
    this.#wfNodeDuration = m.createHistogram('remyral_workflow_node_duration_seconds', {
      description: 'Workflow node run duration (start to end), by node type and final state',
      unit: 's',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 60, 300, 1800, 3600, 86400] },
    });
    this.#wfNodeFailures = m.createCounter('remyral_workflow_node_failures', {
      description: 'Workflow node runs that failed, by node type and error code',
    });
    this.#wfRunsFinished = m.createCounter('remyral_workflow_runs_finished', {
      description: 'Engine-2 workflow runs that finished, by state',
    });

    const jobs = m.createObservableGauge('remyral_jobs', { description: 'Jobs by state' });
    const workers = m.createObservableGauge('remyral_workers', { description: 'Paired workers by state' });
    const online = m.createObservableGauge('remyral_workers_online', {
      description: 'Workers online or busy',
    });
    const approvals = m.createObservableGauge('remyral_approvals_pending', {
      description: 'Pending approval requests',
    });
    const queueAge = m.createObservableGauge('remyral_queue_oldest_seconds', {
      description: 'Age of the oldest QUEUED job (0 when none)',
      unit: 's',
    });
    const leases = m.createObservableGauge('remyral_leases_active', { description: 'Unreleased job leases' });
    const budget = m.createObservableGauge('remyral_budget_consumption_ratio', {
      description: 'Budget consumption (used / limit) of enabled budgets in their current window',
    });
    const wfRuns = m.createObservableGauge('remyral_workflow_runs', {
      description: 'Open engine-2 workflow runs by state (queued, active, paused)',
    });
    const wfWaiting = m.createObservableGauge('remyral_workflow_node_runs_waiting', {
      description: 'Waiting workflow node runs of active runs, by wait kind',
    });
    const wfLag = m.createObservableGauge('remyral_workflow_timer_lag_seconds', {
      description: 'How far the oldest overdue timer of an active workflow run is behind (0 when none)',
      unit: 's',
    });
    m.addBatchObservableCallback(
      async (r) => {
        let s: Snapshot;
        try {
          s = await this.snapshot();
        } catch (err) {
          this.#o.log?.warn({ err }, 'metrics snapshot failed');
          return;
        }
        for (const j of s.jobs) r.observe(jobs, j.n, { state: j.state });
        for (const w of s.workers) r.observe(workers, w.n, { state: w.state });
        r.observe(
          online,
          s.workers.filter((w) => w.state === 'online' || w.state === 'busy').reduce((a, w) => a + w.n, 0),
        );
        r.observe(approvals, s.approvals);
        r.observe(queueAge, s.oldestQueuedSec);
        r.observe(leases, s.activeLeases);
        for (const b of s.budgets)
          r.observe(budget, b.ratio, { budget_id: b.id, metric: b.metric, scope: b.scope });
        for (const w of s.workflowRuns) r.observe(wfRuns, w.n, { state: w.state });
        for (const w of s.workflowWaiting) r.observe(wfWaiting, w.n, { kind: w.kind });
        r.observe(wfLag, s.workflowTimerLagSec);
      },
      [jobs, workers, online, approvals, queueAge, leases, budget, wfRuns, wfWaiting, wfLag],
    );
  }

  /** The cached (or freshly read) state snapshot; also used by the alert evaluator's tests. */
  async snapshot(): Promise<Snapshot> {
    const cacheMs = this.#o.cacheMs ?? 15_000;
    const now = Date.now();
    if (this.#snapshot !== null && now - this.#snapshot.at < cacheMs) return this.#snapshot;
    this.#inflight ??= this.#read().finally(() => {
      this.#inflight = null;
    });
    this.#snapshot = await this.#inflight;
    return this.#snapshot;
  }

  async #read(): Promise<Snapshot> {
    const db = this.#o.pool;
    const at = this.#now();
    const [jobs, workers, approvals, queued, leases, wfRuns, wfWaiting, wfLag] = await Promise.all([
      db.query<{ state: string; n: number }>(
        "SELECT state::text AS state, count(*)::int AS n FROM jobs WHERE state <> 'DRAFT' GROUP BY state",
      ),
      // p5-fleet-archive: archived workers are out of the fleet (they would count as quarantined forever).
      db.query<{ state: string; n: number }>(
        'SELECT state, count(*)::int AS n FROM workers WHERE archived_at IS NULL GROUP BY state',
      ),
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_requests WHERE status = 'pending'"),
      db.query<{ oldest: Date | null }>(
        "SELECT min(state_changed_at) AS oldest FROM jobs WHERE state = 'QUEUED'",
      ),
      db.query<{ n: number }>('SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL'),
      db.query<{ state: string; n: number }>(
        `SELECT state, count(*)::int AS n FROM workflow_runs
          WHERE engine = 2 AND state IN ('queued', 'active', 'paused') GROUP BY state`,
      ),
      db.query<{ kind: string; n: number }>(
        `SELECT nr.wait_kind AS kind, count(*)::int AS n FROM workflow_node_runs nr
           JOIN workflow_runs r ON r.id = nr.run_id
          WHERE r.engine = 2 AND r.state = 'active' AND nr.state = 'waiting' GROUP BY nr.wait_kind`,
      ),
      db.query<{ oldest: Date | null }>(
        `SELECT min(nr.due_at) AS oldest FROM workflow_node_runs nr JOIN workflow_runs r ON r.id = nr.run_id
          WHERE r.engine = 2 AND r.state = 'active' AND nr.state IN ('waiting', 'retry_wait')
            AND nr.wait_kind IS DISTINCT FROM 'job' AND nr.due_at <= $1`,
        [at],
      ),
    ]);
    const lagFrom = wfLag.rows[0]?.oldest ?? null;
    const oldest = queued.rows[0]?.oldest ?? null;
    let budgets: Snapshot['budgets'] = [];
    if (this.#o.budgets) {
      try {
        budgets = await this.#o.budgets();
      } catch (err) {
        this.#o.log?.warn({ err }, 'budget metrics unavailable');
      }
    }
    return {
      at: Date.now(),
      jobs: jobs.rows,
      workers: workers.rows,
      approvals: approvals.rows[0]?.n ?? 0,
      oldestQueuedSec: oldest === null ? 0 : Math.max(0, (at.getTime() - oldest.getTime()) / 1000),
      activeLeases: leases.rows[0]?.n ?? 0,
      budgets,
      workflowRuns: wfRuns.rows,
      workflowWaiting: wfWaiting.rows,
      workflowTimerLagSec: lagFrom === null ? 0 : Math.max(0, (at.getTime() - lagFrom.getTime()) / 1000),
    };
  }

  /**
   * One tailer pass over `job_transitions` (the first pass only positions the cursor at the end: history
   * before this process started is not replayed into counters). Returns the number of rows processed.
   */
  async tailTransitions(limit = 500): Promise<number> {
    let wf = 0;
    try {
      wf = await this.tailWorkflows(limit);
    } catch (err) {
      this.#o.log?.warn({ err }, 'workflow metrics tailer failed');
    }
    return wf + (await this.#tailJobs(limit));
  }

  /**
   * p14-workflow-engine 14.4: one pass over finished engine-2 node runs and runs (by `ended_at`, then id); the first
   * pass only positions the cursors. Copied node runs of re-runs are not counted. Returns the rows processed.
   */
  async tailWorkflows(limit = 500): Promise<number> {
    const db = this.#o.pool;
    if (this.#wfCursor === null || this.#wfRunCursor === null) {
      const { rows } = await db.query<{ nr: Date | null; r: Date | null }>(
        `SELECT (SELECT max(ended_at) FROM workflow_node_runs) AS nr,
                (SELECT max(ended_at) FROM workflow_runs WHERE engine = 2) AS r`,
      );
      const zero = new Date(0);
      this.#wfCursor = { at: rows[0]?.nr ?? zero, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
      this.#wfRunCursor = { at: rows[0]?.r ?? zero, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
      return 0;
    }
    const nodes = await db.query<{
      id: string;
      node_type: string;
      state: string;
      code: string | null;
      started_at: Date | null;
      ended_at: Date;
      copied_from: string | null;
    }>(
      `SELECT id, node_type, state, error->>'code' AS code, started_at, ended_at, copied_from FROM workflow_node_runs
        WHERE ended_at IS NOT NULL AND (ended_at, id) > ($1::timestamptz, $2::uuid)
        ORDER BY ended_at, id LIMIT $3`,
      [this.#wfCursor.at, this.#wfCursor.id, limit],
    );
    const type = (t: string): string => (/^[a-z]+\.[A-Za-z]{1,40}$/.test(t) ? t : 'other');
    const code = (c: string | null): string => (c !== null && /^[a-z][a-z0-9_]{0,47}$/.test(c) ? c : 'other');
    for (const n of nodes.rows) {
      this.#wfCursor = { at: n.ended_at, id: n.id };
      if (n.copied_from !== null || n.state === 'skipped') continue;
      if (n.started_at !== null)
        this.#wfNodeDuration.record(Math.max(0, (n.ended_at.getTime() - n.started_at.getTime()) / 1000), {
          type: type(n.node_type),
          state: n.state,
        });
      if (n.state === 'failed') this.#wfNodeFailures.add(1, { type: type(n.node_type), code: code(n.code) });
    }
    const runs = await db.query<{ id: string; state: string; ended_at: Date }>(
      `SELECT id, state, ended_at FROM workflow_runs
        WHERE engine = 2 AND ended_at IS NOT NULL AND (ended_at, id) > ($1::timestamptz, $2::uuid)
        ORDER BY ended_at, id LIMIT $3`,
      [this.#wfRunCursor.at, this.#wfRunCursor.id, limit],
    );
    for (const r of runs.rows) {
      this.#wfRunCursor = { at: r.ended_at, id: r.id };
      this.#wfRunsFinished.add(1, { state: r.state });
    }
    return nodes.rows.length + runs.rows.length;
  }

  async #tailJobs(limit: number): Promise<number> {
    const db = this.#o.pool;
    if (this.#cursor === null) {
      const { rows } = await db.query<{ max: string | null }>(
        'SELECT max(id)::text AS max FROM job_transitions',
      );
      this.#cursor = rows[0]?.max ?? '0';
      return 0;
    }
    const { rows } = await db.query<TransitionRow>(
      `SELECT t.id::text AS id, t.job_id, t.from_state::text AS from_state, t.to_state::text AS to_state,
              t.trigger, t.attempt_id, t.epoch, t.occurred_at,
              (SELECT p.occurred_at FROM job_transitions p
                WHERE p.job_id = t.job_id AND p.version < t.version ORDER BY p.version DESC LIMIT 1) AS previous_at,
              j.created_at, j.spec->>'runtime' AS runtime,
              (SELECT a.worker_id FROM job_attempts a WHERE a.id = t.attempt_id) AS worker_id
         FROM job_transitions t JOIN jobs j ON j.id = t.job_id
        WHERE t.id > $1 ORDER BY t.id LIMIT $2`,
      [this.#cursor, limit],
    );
    const runtime = (r: TransitionRow): string =>
      r.runtime !== null && /^[a-z0-9-]{1,32}$/.test(r.runtime) ? r.runtime : 'unknown';
    for (const r of rows) {
      this.#cursor = r.id;
      const from = r.from_state ?? 'NONE';
      this.#transitions.add(1, { from, to: r.to_state, trigger: r.trigger });
      if (r.previous_at !== null && r.from_state !== null) {
        this.#stateSeconds.record(Math.max(0, (r.occurred_at.getTime() - r.previous_at.getTime()) / 1000), {
          state: r.from_state,
          runtime: runtime(r),
        });
      }
      if (TERMINAL.has(r.to_state)) {
        this.#jobDuration.record(Math.max(0, (r.occurred_at.getTime() - r.created_at.getTime()) / 1000), {
          outcome: r.to_state,
          runtime: runtime(r),
        });
      }
      if (r.trigger === 'lease_expired') this.#leaseExpiries.add(1);
      if (r.to_state === 'FAILED' || r.to_state === 'LOST')
        this.#jobFailures.add(1, { to: r.to_state, runtime: runtime(r) });
      if (this.#o.telemetry.tracing) {
        const span = this.#o.telemetry.tracer.startSpan(`job.transition ${r.to_state}`, {
          kind: SpanKind.INTERNAL,
          startTime: r.occurred_at,
          attributes: {
            'remyral.job.id': r.job_id,
            'remyral.job.from': from,
            'remyral.job.to': r.to_state,
            'remyral.job.trigger': r.trigger,
            'remyral.runtime': runtime(r),
            ...(r.attempt_id === null ? {} : { 'remyral.attempt.id': r.attempt_id }),
            ...(r.epoch === null ? {} : { 'remyral.attempt.epoch': r.epoch }),
            ...(r.worker_id === null ? {} : { 'remyral.worker.id': r.worker_id }),
          },
        });
        span.end(r.occurred_at);
      }
    }
    return rows.length;
  }

  /** Background tailer; returns a stop function. Errors are reported, never thrown. */
  start(intervalMs: number, onError: (err: unknown) => void): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.tailTransitions()
        .catch(onError)
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}
