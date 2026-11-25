import type { Queryable } from '../db/pool.js';

/**
 * p15-auto-mode: what the platform did by itself for a job (`job_auto_events`, migration 0126) — the job page timeline
 * ("Otomatik mod onayladı", "Otomatik yeniden deneme 2/3", base ref healed, rebased, auto-fix job) and the failure
 * digest. Details hold identifiers, enums and numbers only (never runtime or repository text).
 */
export const AUTO_EVENT_KINDS = [
  'auto_approved',
  'auto_retry',
  'retry_exhausted',
  'base_ref',
  'auto_rebase',
  'auto_fix',
  'repo_access',
  // p22-conflict-resolve: a conflict-resolution job was opened / merged / failed for this job.
  'conflict_resolve',
] as const;
export type AutoEventKind = (typeof AUTO_EVENT_KINDS)[number];

export interface AutoEvent {
  readonly id: string;
  readonly kind: AutoEventKind;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly at: string;
}

export async function recordAutoEvent(
  db: Queryable,
  input: {
    readonly jobId: string;
    readonly kind: AutoEventKind;
    readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    readonly at: Date;
    /** Keep at most this many events of the kind per job (a chatty run's tool approvals). */
    readonly cap?: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO job_auto_events (job_id, kind, detail, created_at)
     SELECT $1::uuid, $2::text, $3::jsonb, $4::timestamptz
      WHERE $5::int IS NULL
         OR (SELECT count(*) FROM job_auto_events e WHERE e.job_id = $1::uuid AND e.kind = $2::text) < $5::int`,
    [input.jobId, input.kind, JSON.stringify(input.detail), input.at, input.cap ?? null],
  );
}

export async function listAutoEvents(db: Queryable, jobId: string, limit = 100): Promise<AutoEvent[]> {
  const { rows } = await db.query<{
    id: string;
    kind: AutoEventKind;
    detail: Record<string, string | number | boolean | null>;
    created_at: Date;
  }>(
    `SELECT e.id::text AS id, e.kind, e.detail, e.created_at FROM job_auto_events e WHERE e.job_id = $1
      ORDER BY e.id LIMIT $2`,
    [jobId, limit],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, detail: r.detail, at: r.created_at.toISOString() }));
}
