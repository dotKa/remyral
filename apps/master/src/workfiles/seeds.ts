import type { Queryable } from '../db/pool.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * p15-workspace-retention: records (inside the job's creation transaction) that `jobId` starts from the newest kept
 * working directory of `sourceJobId` — a follow-up, run again, fix or deploy retry. Nothing is recorded when the source
 * has none kept (the job then starts from an empty directory as before). Returns whether a seed was recorded.
 */
export async function recordWorkfilesSeed(
  tx: Queryable,
  jobId: string,
  sourceJobId: string,
  now: Date,
): Promise<boolean> {
  if (!UUID.test(sourceJobId) || sourceJobId === jobId) return false;
  const { rows } = await tx.query<{ attempt_id: string }>(
    `SELECT attempt_id::text AS attempt_id FROM job_workfiles
      WHERE job_id = $1 AND state = 'kept' ORDER BY kept_at DESC LIMIT 1`,
    [sourceJobId],
  );
  const a = rows[0];
  if (a === undefined) return false;
  await tx.query(
    `INSERT INTO job_workfile_seeds (job_id, source_job_id, source_attempt_id, created_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
    [jobId, sourceJobId, a.attempt_id, now],
  );
  return true;
}
