import { classifyDecline, type DeclineKind } from '@remyral/protocol';
import type { BusyDecline } from '@remyral/scheduler';
import type { Queryable } from '../db/pool.js';
import { slotLease } from './facts.js';

/**
 * p9-queue-priority §1 (docs/design/p9-queue-priority.md): decline = wait. Every LEASE_ACK `accepted: false` is
 * recorded with its kind — the worker's own `declineKind`, else the master's classification of the text (workers
 * ≤ 1.0.27). A permanent decline keeps the worker away from the job (`declined_before`, as before p9); a transient one
 * only until the worker runs fewer jobs than when it declined, or its retry time passes.
 */
export async function recordDecline(
  tx: Queryable,
  d: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly workerId: string;
    readonly reason: string | undefined;
    readonly declineKind: DeclineKind | undefined;
    readonly retryAfterMs: number | undefined;
    readonly now: Date;
  },
): Promise<{ readonly kind: DeclineKind; readonly retryAt: Date | null }> {
  const c = classifyDecline(d.reason, d.declineKind, d.retryAfterMs);
  // The worker's slot-holding leases after this one was released (lease_declined closes it). p9-queue-local-login-
  // accounting: another busy-declined job's pending re-ask is not counted — otherwise its decline a moment later looks
  // like a freed slot and this job is asked again at once (the re-ask loop seen live on 2026-10-17).
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM leases l JOIN jobs j ON j.id = l.job_id
      WHERE l.worker_id = $1 AND l.job_id <> $2 AND ${slotLease('l', 'j')}`,
    [d.workerId, d.jobId],
  );
  const retryAt = c.retryAfterMs === null ? null : new Date(d.now.getTime() + c.retryAfterMs);
  await tx.query(
    `INSERT INTO job_declines (attempt_id, job_id, worker_id, kind, classified_by, active_leases, retry_at, declined_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (attempt_id) DO NOTHING`,
    [
      d.attemptId,
      d.jobId,
      d.workerId,
      c.kind,
      d.declineKind === undefined ? 'legacy_text' : 'worker',
      rows[0]?.n ?? 0,
      retryAt,
      d.now,
    ],
  );
  return { kind: c.kind, retryAt };
}

export interface DeclineFacts {
  /** Workers that declined permanently (never asked again for this job). */
  readonly declinedBy: string[];
  /** Workers whose latest decline was transient and whose retry time has not passed. */
  readonly busy: BusyDecline[];
}

/** p9-queue-local-login-accounting: the longest wait between re-asks of a worker that keeps declining as busy. */
export const MAX_BUSY_BACKOFF_MS = 300_000;

/**
 * The wait after the `n`-th consecutive busy decline of a job by one worker: the worker's `retryAfterMs`, doubled
 * with every further decline, at most {@link MAX_BUSY_BACKOFF_MS} (never shorter than the worker asked for). A
 * running job of that worker ending still re-asks at once (the active-count rule).
 */
export function busyBackoffMs(retryAfterMs: number, n: number): number {
  const doubled = retryAfterMs * 2 ** Math.min(Math.max(n - 1, 0), 16);
  return Math.max(retryAfterMs, Math.min(doubled, MAX_BUSY_BACKOFF_MS));
}

/**
 * The declines of a job for placement. Declines recorded before p9 (no `job_declines` row) are classified from their
 * text now; a transient one of those counts as made while the worker ran one job, for the default retry time.
 * Consecutive busy declines by the same worker back off exponentially ({@link busyBackoffMs}).
 */
export async function declineFacts(db: Queryable, jobId: string, now: Date): Promise<DeclineFacts> {
  const { rows } = await db.query<{
    worker_id: string | null;
    reason: string | null;
    occurred_at: Date;
    kind: DeclineKind | null;
    active_leases: number | null;
    retry_at: Date | null;
  }>(
    `SELECT t.actor_id AS worker_id, t.reason, t.occurred_at, d.kind, d.active_leases, d.retry_at
       FROM job_transitions t LEFT JOIN job_declines d ON d.attempt_id = t.attempt_id
      WHERE t.job_id = $1 AND t.trigger = 'lease_declined'
      ORDER BY t.version`,
    [jobId],
  );
  const declinedBy = new Set<string>();
  const latest = new Map<string, BusyDecline | null>();
  const streak = new Map<string, number>();
  for (const r of rows) {
    const workerId = r.worker_id ?? '';
    let kind = r.kind;
    let retryAt = r.retry_at;
    let active = r.active_leases;
    if (kind === null) {
      const c = classifyDecline(r.reason ?? undefined);
      kind = c.kind;
      retryAt = c.retryAfterMs === null ? null : new Date(r.occurred_at.getTime() + c.retryAfterMs);
      active = 1;
    }
    if (kind === 'permanent') {
      declinedBy.add(workerId);
      continue;
    }
    const n = (streak.get(workerId) ?? 0) + 1;
    streak.set(workerId, n);
    if (retryAt !== null) {
      const base = Math.max(1_000, retryAt.getTime() - r.occurred_at.getTime());
      retryAt = new Date(r.occurred_at.getTime() + busyBackoffMs(base, n));
    }
    latest.set(
      workerId,
      retryAt !== null && retryAt.getTime() > now.getTime()
        ? {
            workerId,
            activeLeases: active ?? 0,
            until: retryAt.toISOString(),
            ...(r.reason === null ? {} : { reason: r.reason.slice(0, 300) }),
          }
        : null,
    );
  }
  return {
    declinedBy: [...declinedBy],
    busy: [...latest.values()].filter((b): b is BusyDecline => b !== null && !declinedBy.has(b.workerId)),
  };
}
