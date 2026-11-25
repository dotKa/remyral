import { type JobResources, RuntimeKind } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p6-capacity-advice (docs/design/p6-capacity-advice.md §3): stores the measured peak memory of one attempt
 * (JOB_RESULT.resources) and rewrites the worker × runtime rollup. Runs inside the inbox transaction of the
 * JOB_RESULT, so a replayed result (same attempt) changes nothing: the sample insert is idempotent and the rollup
 * is only touched when the insert added a row.
 */

/** Newest attempts the rollup's `recent_peak_bytes` looks at. */
export const RECENT_ATTEMPTS = 20;
/** Samples kept per worker × runtime. */
export const KEPT_SAMPLES = 50;

export async function recordJobMemory(
  tx: Queryable,
  input: {
    readonly attemptId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly resources: JobResources;
    readonly now: Date;
  },
): Promise<boolean> {
  const job = await tx.query<{ runtime: string | null }>(
    `SELECT COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime
       FROM jobs j LEFT JOIN job_runs r ON r.attempt_id = $2
      WHERE j.id = $1`,
    [input.jobId, input.attemptId],
  );
  const runtime = RuntimeKind.safeParse(job.rows[0]?.runtime);
  if (!runtime.success) return false;
  const inserted = await tx.query(
    `INSERT INTO job_memory_samples (attempt_id, job_id, worker_id, runtime, peak_bytes, samples, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (attempt_id) DO NOTHING`,
    [
      input.attemptId,
      input.jobId,
      input.workerId,
      runtime.data,
      input.resources.peakMemoryBytes,
      input.resources.samples,
      input.now,
    ],
  );
  if (inserted.rowCount !== 1) return false;
  await tx.query(
    `INSERT INTO worker_runtime_memory AS m
            (worker_id, runtime, attempts, recent_peak_bytes, max_peak_bytes, last_peak_bytes, updated_at)
     SELECT $1, $2, 1,
            (SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY peak_bytes) FROM (SELECT peak_bytes FROM job_memory_samples
                                           WHERE worker_id = $1 AND runtime = $2
                                           ORDER BY recorded_at DESC, attempt_id LIMIT $5) r),
            $3, $3, $4
     ON CONFLICT (worker_id, runtime) DO UPDATE
       SET attempts = m.attempts + 1,
           recent_peak_bytes = EXCLUDED.recent_peak_bytes,
           max_peak_bytes = GREATEST(m.max_peak_bytes, EXCLUDED.max_peak_bytes),
           last_peak_bytes = EXCLUDED.last_peak_bytes,
           updated_at = EXCLUDED.updated_at`,
    [input.workerId, runtime.data, input.resources.peakMemoryBytes, input.now, RECENT_ATTEMPTS],
  );
  await tx.query(
    `DELETE FROM job_memory_samples WHERE worker_id = $1 AND runtime = $2 AND attempt_id NOT IN (
       SELECT attempt_id FROM job_memory_samples WHERE worker_id = $1 AND runtime = $2
        ORDER BY recorded_at DESC, attempt_id LIMIT $3)`,
    [input.workerId, runtime.data, KEPT_SAMPLES],
  );
  return true;
}

export interface RuntimeMemoryRow {
  readonly runtime: RuntimeKind;
  readonly attempts: number;
  readonly recentPeakBytes: number;
  readonly maxPeakBytes: number;
}

/** Per worker: the rollup rows. */
export async function workerMemory(db: Queryable): Promise<Map<string, RuntimeMemoryRow[]>> {
  const { rows } = await db.query<{
    worker_id: string;
    runtime: string;
    attempts: number;
    recent_peak_bytes: string;
    max_peak_bytes: string;
  }>(
    // The recent peak is the 90th percentile of the newest samples, computed here so rows written before that rule
    // (when it was the maximum) read the same way; the stored value is the fallback when no sample is kept.
    `SELECT m.worker_id, m.runtime, m.attempts, m.max_peak_bytes,
            coalesce((SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY r.peak_bytes)
                        FROM (SELECT s.peak_bytes FROM job_memory_samples s
                               WHERE s.worker_id = m.worker_id AND s.runtime = m.runtime
                               ORDER BY s.recorded_at DESC, s.attempt_id LIMIT $1) r),
                     m.recent_peak_bytes) AS recent_peak_bytes
       FROM worker_runtime_memory m
      ORDER BY m.worker_id, m.runtime`,
    [RECENT_ATTEMPTS],
  );
  const out = new Map<string, RuntimeMemoryRow[]>();
  for (const r of rows) {
    const runtime = RuntimeKind.safeParse(r.runtime);
    if (!runtime.success) continue;
    const list = out.get(r.worker_id) ?? [];
    list.push({
      runtime: runtime.data,
      attempts: r.attempts,
      recentPeakBytes: Number(r.recent_peak_bytes),
      maxPeakBytes: Number(r.max_peak_bytes),
    });
    out.set(r.worker_id, list);
  }
  return out;
}
