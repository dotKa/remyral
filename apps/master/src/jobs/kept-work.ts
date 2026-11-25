import { TimeoutPartial } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p22-timeout-continuity (docs/design/p22-timeout-continuity.md): the unfinished work a job's current attempt kept when
 * its time limit stopped it — the worker's JOB_RESULT `partial` (a claim; the continuation checks the remote before it
 * starts from a pushed commit), with the machine that holds it.
 */
export interface KeptWork extends TimeoutPartial {
  /** The machine that ran the attempt (and keeps an unpushed commit under `ref`). */
  readonly workerId: string;
}

/** Kept work of the current attempts of `ids` (jobs without any are absent). */
export async function keptWorkOf(db: Queryable, ids: readonly string[]): Promise<Map<string, KeptWork>> {
  const out = new Map<string, KeptWork>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ id: string; partial: unknown; worker_id: string }>(
    `SELECT j.id::text AS id, r.result -> 'partial' AS partial, r.worker_id
       FROM jobs j JOIN job_runs r ON r.attempt_id = j.current_attempt_id
      WHERE j.id = ANY($1::uuid[]) AND r.result ? 'partial'`,
    [[...ids]],
  );
  for (const r of rows) {
    const p = TimeoutPartial.safeParse(r.partial);
    if (p.success) out.set(r.id, { ...p.data, workerId: r.worker_id });
  }
  return out;
}

/** The assistant's view of kept work (find_jobs / describe_job): where it is and what "continue" does with it. */
export function keptWorkLine(k: KeptWork): Record<string, unknown> {
  return {
    branch: k.branch,
    commit: k.commit,
    files: k.files,
    pushed: k.pushed,
    ...(k.pushed ? {} : { onlyOnMachine: k.workerId, notPushedBecause: k.reason ?? null }),
    continue: k.pushed
      ? 'draft_job_action continue starts the new job from this commit (the work is not lost)'
      : 'draft_job_action continue starts the new job from this commit on the same machine (the work is not lost)',
  };
}
