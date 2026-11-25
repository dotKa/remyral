import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import type pg from 'pg';
import { HttpError } from '../http/errors.js';

/**
 * Storage policy of workspace projects (docs/design/p5-research-workspace-next.md §1): file retention and a
 * storage quota over the project's job files (artifacts + inputs). Pruning never deletes rows: the content is
 * dropped (`content = NULL`) and `pruned_at` / `pruned_reason` record why, so job pages still list the file as
 * "removed". Only files of finished jobs are ever pruned — a queued or running job keeps its inputs and outputs.
 * p6-outputs: output files someone pinned on the Outputs screen (`output_items.pinned`) are never pruned by the
 * retention or the quota (they still count against the quota).
 */

export const RETENTION_DAYS = { min: 1, max: 3650 } as const;
export const QUOTA_BYTES = { min: 10 * 1024 * 1024, max: 1024 * 1024 * 1024 * 1024 } as const;
/** Job states whose files may be pruned. */
const FINISHED = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
/** Files pruned per statement (the sweeper loops; one sweep is bounded by {@link SWEEP_MAX_FILES}). */
const BATCH = 500;
const SWEEP_MAX_FILES = 5_000;
/** The sweeper runs at most this often (it is a tick step; ticks are frequent). */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

export type PruneReason = 'retention' | 'quota';

export interface StoragePolicy {
  readonly retentionDays: number | null;
  readonly quotaBytes: number | null;
}

export interface StorageUsage {
  /** Stored bytes counted against the quota (artifacts + inputs of the project's jobs). */
  readonly bytes: number;
  readonly files: number;
  readonly artifactBytes: number;
  readonly artifactFiles: number;
  readonly inputBytes: number;
  readonly inputFiles: number;
  /** Files whose content was removed by retention or the quota (metadata kept). */
  readonly prunedFiles: number;
  readonly oldestAt: Date | null;
}

/** The project's storage quota does not leave room for new files, even after removing old ones. */
export class StorageQuotaError extends HttpError {
  constructor(
    readonly project: string,
    readonly neededBytes: number,
    readonly quotaBytes: number,
  ) {
    super(
      413,
      'storage_quota_exceeded',
      `The storage quota of workspace ${project} (${formatBytes(quotaBytes)}) is full: files of jobs that are still running use it. Raise the quota in the project's workspace settings or wait for those jobs to finish.`,
    );
    this.name = 'StorageQuotaError';
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export async function loadPolicy(db: Queryable, project: string): Promise<StoragePolicy> {
  const { rows } = await db.query<{ days: number | null; quota: string | null }>(
    `SELECT artifact_retention_days AS days, storage_quota_bytes AS quota
       FROM project_workspaces WHERE project = $1`,
    [project],
  );
  const r = rows[0];
  return {
    retentionDays: r?.days ?? null,
    quotaBytes: r?.quota === null || r?.quota === undefined ? null : Number(r.quota),
  };
}

export async function storageUsage(db: Queryable, project: string): Promise<StorageUsage> {
  const { rows } = await db.query<{
    a_bytes: string;
    a_files: number;
    i_bytes: string;
    i_files: number;
    pruned: number;
    oldest: Date | null;
  }>(
    `WITH a AS (SELECT f.size_bytes, f.created_at, f.pruned_at FROM job_artifacts f JOIN jobs j ON j.id = f.job_id
                 WHERE j.project = $1),
          i AS (SELECT f.size_bytes, f.created_at, f.pruned_at FROM job_inputs f JOIN jobs j ON j.id = f.job_id
                 WHERE j.project = $1)
     SELECT (SELECT coalesce(sum(size_bytes), 0) FROM a WHERE pruned_at IS NULL) AS a_bytes,
            (SELECT count(*)::int FROM a WHERE pruned_at IS NULL) AS a_files,
            (SELECT coalesce(sum(size_bytes), 0) FROM i WHERE pruned_at IS NULL) AS i_bytes,
            (SELECT count(*)::int FROM i WHERE pruned_at IS NULL) AS i_files,
            (SELECT count(*)::int FROM a WHERE pruned_at IS NOT NULL)
              + (SELECT count(*)::int FROM i WHERE pruned_at IS NOT NULL) AS pruned,
            least((SELECT min(created_at) FROM a WHERE pruned_at IS NULL),
                  (SELECT min(created_at) FROM i WHERE pruned_at IS NULL)) AS oldest`,
    [project],
  );
  const r = rows[0];
  const artifactBytes = Number(r?.a_bytes ?? 0);
  const inputBytes = Number(r?.i_bytes ?? 0);
  return {
    bytes: artifactBytes + inputBytes,
    files: (r?.a_files ?? 0) + (r?.i_files ?? 0),
    artifactBytes,
    artifactFiles: r?.a_files ?? 0,
    inputBytes,
    inputFiles: r?.i_files ?? 0,
    prunedFiles: r?.pruned ?? 0,
    oldestAt: r?.oldest ?? null,
  };
}

interface Candidate {
  readonly t: 'a' | 'i';
  readonly k1: string;
  readonly k2: string;
  readonly size_bytes: number;
  readonly cum: string;
}

/**
 * The oldest stored files of the project's finished jobs whose sizes add up to at least `bytes` (oldest first);
 * empty when even all of them would not be enough.
 */
async function evictionPlan(db: Queryable, project: string, bytes: number): Promise<Candidate[]> {
  const { rows } = await db.query<Candidate>(
    `WITH files AS (
       SELECT 'a'::text AS t, f.attempt_id::text AS k1, f.artifact_id AS k2, f.size_bytes, f.created_at
         FROM job_artifacts f JOIN jobs j ON j.id = f.job_id
        WHERE j.project = $1 AND f.pruned_at IS NULL AND j.state::text = ANY($3::text[])
          AND NOT EXISTS (SELECT 1 FROM output_items o WHERE o.pinned AND o.job_id = f.job_id
                            AND o.artifact_id = f.artifact_id)
       UNION ALL
       SELECT 'i', f.job_id::text, f.input_id, f.size_bytes, f.created_at
         FROM job_inputs f JOIN jobs j ON j.id = f.job_id
        WHERE j.project = $1 AND f.pruned_at IS NULL AND j.state::text = ANY($3::text[])),
     ranked AS (SELECT t, k1, k2, size_bytes,
                       sum(size_bytes) OVER (ORDER BY created_at, t, k1, k2) AS cum FROM files)
     SELECT t, k1, k2, size_bytes, cum FROM ranked WHERE cum - size_bytes < $2 ORDER BY cum`,
    [project, bytes, FINISHED],
  );
  const total = Number(rows.at(-1)?.cum ?? 0);
  return total >= bytes ? rows : [];
}

async function pruneFiles(
  db: Queryable,
  files: readonly Pick<Candidate, 't' | 'k1' | 'k2'>[],
  reason: PruneReason,
  now: Date,
): Promise<void> {
  const a = files.filter((f) => f.t === 'a');
  const i = files.filter((f) => f.t === 'i');
  if (a.length > 0) {
    await db.query(
      // p17-object-storage: dropping the blob reference hands the blob to the blob GC (deleted from its store).
      `UPDATE job_artifacts f SET content = NULL, blob_key = NULL, pruned_at = $3, pruned_reason = $4
         FROM unnest($1::uuid[], $2::text[]) AS x(attempt_id, artifact_id)
        WHERE f.attempt_id = x.attempt_id AND f.artifact_id = x.artifact_id AND f.pruned_at IS NULL`,
      [a.map((f) => f.k1), a.map((f) => f.k2), now, reason],
    );
  }
  if (i.length > 0) {
    await db.query(
      `UPDATE job_inputs f SET content = NULL, blob_key = NULL, pruned_at = $3, pruned_reason = $4
         FROM unnest($1::uuid[], $2::text[]) AS x(job_id, input_id)
        WHERE f.job_id = x.job_id AND f.input_id = x.input_id AND f.pruned_at IS NULL`,
      [i.map((f) => f.k1), i.map((f) => f.k2), now, reason],
    );
  }
}

/**
 * Makes room for `bytes` new files of `project` inside the caller's transaction (serialised per project). Without a
 * quota: nothing. Over the quota: the oldest files of finished jobs are pruned (reason `quota`, audited) — all of
 * them or none; when finished jobs cannot free enough, {@link StorageQuotaError} and nothing changed.
 */
export async function reserveStorage(
  tx: Queryable,
  project: string,
  bytes: number,
  now: Date,
  audit: AuditRecorder | null,
): Promise<void> {
  if (bytes <= 0) return;
  const policy = await loadPolicy(tx, project);
  if (policy.quotaBytes === null) return;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ws-storage:${project}`]);
  const used = (await storageUsage(tx, project)).bytes;
  const over = used + bytes - policy.quotaBytes;
  if (over <= 0) return;
  const plan = await evictionPlan(tx, project, over);
  if (plan.length === 0) throw new StorageQuotaError(project, bytes, policy.quotaBytes);
  await pruneFiles(tx, plan, 'quota', now);
  await audit?.record(
    {
      actor: { type: 'system', id: 'workspace-storage' },
      action: 'workspace.files.prune',
      target: `project:${project}`,
      outcome: 'success',
      metadata: {
        reason: 'quota',
        files: plan.length,
        bytes: plan.reduce((n, f) => n + f.size_bytes, 0),
        quotaBytes: policy.quotaBytes,
        incomingBytes: bytes,
      },
    },
    tx,
  );
}

export interface SweepResult {
  readonly project: string;
  readonly reason: PruneReason;
  readonly files: number;
  readonly bytes: number;
}

/**
 * The storage sweeper (tick step `workspace-storage`): per workspace project with a policy, prunes files of finished
 * jobs older than the retention, then the oldest files while the project is over its quota (after a quota was
 * lowered); run files of ended workflow runs follow the retention too. Each project's pass is audited once.
 */
export class StorageSweeper {
  #lastRun = 0;

  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
    },
  ) {}

  /** Tick entry point: runs {@link sweep} at most every {@link SWEEP_INTERVAL_MS}. */
  async maybeSweep(): Promise<void> {
    const now = this.deps.clock().getTime();
    if (now - this.#lastRun < SWEEP_INTERVAL_MS) return;
    this.#lastRun = now;
    await this.sweep();
  }

  async sweep(): Promise<SweepResult[]> {
    const { rows } = await this.deps.pool.query<{ project: string }>(
      `SELECT w.project FROM project_workspaces w JOIN projects p ON p.id = w.project
        WHERE p.kind = 'workspace' AND (w.artifact_retention_days IS NOT NULL OR w.storage_quota_bytes IS NOT NULL)
        ORDER BY w.project`,
    );
    const out: SweepResult[] = [];
    for (const { project } of rows) {
      try {
        out.push(...(await this.#sweepProject(project)));
      } catch (err) {
        this.deps.log.error({ err, project }, 'workspace storage sweep failed');
      }
    }
    return out;
  }

  async #sweepProject(project: string): Promise<SweepResult[]> {
    const results: SweepResult[] = [];
    const now = this.deps.clock();
    const policy = await loadPolicy(this.deps.pool, project);
    if (policy.retentionDays !== null) {
      const cutoff = new Date(now.getTime() - policy.retentionDays * 86_400_000);
      let files = 0;
      let bytes = 0;
      while (files < SWEEP_MAX_FILES) {
        const { rows } = await this.deps.pool.query<Candidate>(
          `(SELECT 'a'::text AS t, f.attempt_id::text AS k1, f.artifact_id AS k2, f.size_bytes, '0' AS cum
              FROM job_artifacts f JOIN jobs j ON j.id = f.job_id
             WHERE j.project = $1 AND f.pruned_at IS NULL AND f.created_at < $2 AND j.state::text = ANY($3::text[])
               AND NOT EXISTS (SELECT 1 FROM output_items o WHERE o.pinned AND o.job_id = f.job_id
                                 AND o.artifact_id = f.artifact_id)
             LIMIT $4)
           UNION ALL
           (SELECT 'i', f.job_id::text, f.input_id, f.size_bytes, '0'
              FROM job_inputs f JOIN jobs j ON j.id = f.job_id
             WHERE j.project = $1 AND f.pruned_at IS NULL AND f.created_at < $2 AND j.state::text = ANY($3::text[])
             LIMIT $4)`,
          [project, cutoff, FINISHED, BATCH],
        );
        if (rows.length === 0) break;
        await pruneFiles(this.deps.pool, rows, 'retention', now);
        files += rows.length;
        bytes += rows.reduce((n, f) => n + f.size_bytes, 0);
      }
      const runFiles = await this.deps.pool.query(
        `UPDATE workflow_run_files f SET content = NULL, blob_key = NULL, pruned_at = $3
           FROM workflow_runs r
          WHERE r.id = f.run_id AND r.project = $1 AND f.pruned_at IS NULL AND f.created_at < $2
            AND r.ended_at IS NOT NULL`,
        [project, cutoff, now],
      );
      files += runFiles.rowCount ?? 0;
      if (files > 0) results.push({ project, reason: 'retention', files, bytes });
    }
    if (policy.quotaBytes !== null) {
      const pruned = await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ws-storage:${project}`]);
        const over = (await storageUsage(tx, project)).bytes - (policy.quotaBytes ?? 0);
        if (over <= 0) return null;
        // As much as finished jobs can free (a partial plan is fine here: running jobs keep their files).
        let plan = await evictionPlan(tx, project, over);
        if (plan.length === 0) plan = await evictionPlan(tx, project, await this.#evictable(tx, project));
        if (plan.length === 0) return null;
        await pruneFiles(tx, plan, 'quota', now);
        return { files: plan.length, bytes: plan.reduce((n, f) => n + f.size_bytes, 0) };
      });
      if (pruned !== null) results.push({ project, reason: 'quota', ...pruned });
    }
    for (const r of results) {
      await this.deps.audit.record({
        actor: { type: 'system', id: 'workspace-storage' },
        action: 'workspace.files.prune',
        target: `project:${project}`,
        outcome: 'success',
        metadata: {
          reason: r.reason,
          files: r.files,
          bytes: r.bytes,
          ...(r.reason === 'retention'
            ? { retentionDays: policy.retentionDays }
            : { quotaBytes: policy.quotaBytes }),
        },
      });
      this.deps.log.info(
        { project, reason: r.reason, files: r.files, bytes: r.bytes },
        'workspace files pruned',
      );
    }
    return results;
  }

  async #evictable(db: Queryable, project: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT coalesce(sum(size_bytes), 0) AS n FROM (
         SELECT f.size_bytes FROM job_artifacts f JOIN jobs j ON j.id = f.job_id
          WHERE j.project = $1 AND f.pruned_at IS NULL AND j.state::text = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM output_items o WHERE o.pinned AND o.job_id = f.job_id
                              AND o.artifact_id = f.artifact_id)
         UNION ALL
         SELECT f.size_bytes FROM job_inputs f JOIN jobs j ON j.id = f.job_id
          WHERE j.project = $1 AND f.pruned_at IS NULL AND j.state::text = ANY($2::text[])) x`,
      [project, FINISHED],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
