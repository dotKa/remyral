import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import type { Queryable } from '../db/pool.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import {
  classifyFailure,
  type FailureCause,
  type FailurePhase,
  type FailureVerdict,
  retryAllowedFor,
  retryDelaySec,
} from './classify.js';
import { recordAutoEvent } from './events.js';

/**
 * p15-auto-mode (docs/design/p15-auto-mode.md §3): automatic retries without a card or an approval. When an attempt
 * fails for a transient reason (or one the platform heals before the next run: a missing base ref), the job goes to
 * RETRY_WAIT instead of FAILED — at most `autonomy.autoRetryMax` times per job (security policy; Serbest / Dengeli 3,
 * Sıkı 0), after 1, 5, 20 … minutes. A machine-specific cause sends the next attempt to another eligible machine first
 * (the dispatcher ranks the failed machine last). Every retry is a row of `job_auto_retries`, a job timeline event
 * ("Otomatik yeniden deneme 2/3") and an audit entry `job.auto_retry` (actor system `self-heal`).
 *
 * The caller performs the transition (`attempt_retry`, retry-safe) in the same transaction: the attempt's workspace was
 * a scratch worktree on an attempt branch of its own (`rac/<job>/<attempt>`), so a new attempt cannot collide with it;
 * workspace jobs are retried only when their runtime never started (ADR-0004 §5).
 */

export const SELF_HEAL_ACTOR = { type: 'system', id: 'self-heal' } as const;

export interface RetryDecision {
  readonly number: number;
  readonly max: number;
  readonly cause: FailureCause;
  readonly machineSpecific: boolean;
  readonly retryAt: Date;
  readonly reason: string;
}

export interface AutoRetryDeps {
  readonly audit: AuditRecorder;
  readonly securityPolicy: SecurityPolicyReader;
  readonly clock?: () => Date;
}

export interface RetryInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string | null;
  readonly phase: FailurePhase;
  readonly code: string | null;
  readonly message: string;
}

export class AutoRetryService {
  readonly #clock: () => Date;

  constructor(private readonly deps: AutoRetryDeps) {
    this.#clock = deps.clock ?? (() => new Date());
  }

  /** The classification alone (no side effects). */
  classify(input: Pick<RetryInput, 'phase' | 'code' | 'message'>): FailureVerdict {
    return classifyFailure({ code: input.code, message: input.message, phase: input.phase });
  }

  /**
   * Decides inside the caller's transaction whether the failed attempt is retried automatically; records the retry
   * when it is. Null: fail as before (permanent cause, policy off, retries used up — the last one is recorded as
   * `retry_exhausted` once).
   */
  async decideWithin(tx: pg.PoolClient | Queryable, input: RetryInput): Promise<RetryDecision | null> {
    const verdict = this.classify(input);
    const retryable =
      verdict.class === 'transient' || (verdict.class === 'heal' && verdict.cause === 'base_ref');
    if (!retryable) return null;
    const max = (await this.deps.securityPolicy.current()).autonomy.autoRetryMax;
    if (max <= 0) return null;
    const { rows } = await tx.query<{ kind: string | null; repo: boolean; used: number; exhausted: boolean }>(
      `SELECT j.spec->>'kind' AS kind, (j.spec ? 'repository') AS repo,
              (SELECT count(*)::int FROM job_auto_retries r WHERE r.job_id = j.id) AS used,
              EXISTS (SELECT 1 FROM job_auto_events e WHERE e.job_id = j.id AND e.kind = 'retry_exhausted') AS exhausted
         FROM jobs j WHERE j.id = $1`,
      [input.jobId],
    );
    const job = rows[0];
    if (job === undefined) return null;
    if (!retryAllowedFor({ kind: job.kind, hasRepository: job.repo }, input.phase)) return null;
    const now = this.#clock();
    // A replayed result of an attempt that was already retried: the same decision (idempotent).
    const prior = await tx.query<{
      number: number;
      max_attempts: number;
      cause: string;
      machine_specific: boolean;
      retry_at: Date;
    }>(
      'SELECT number, max_attempts, cause, machine_specific, retry_at FROM job_auto_retries WHERE attempt_id = $1',
      [input.attemptId],
    );
    const p = prior.rows[0];
    if (p !== undefined) {
      return {
        number: p.number,
        max: p.max_attempts,
        cause: p.cause as FailureCause,
        machineSpecific: p.machine_specific,
        retryAt: p.retry_at,
        reason: retryReason(p.number, p.max_attempts, p.cause),
      };
    }
    const effectiveMax = Math.min(max, 5);
    if (job.used >= effectiveMax) {
      if (!job.exhausted) {
        await recordAutoEvent(tx, {
          jobId: input.jobId,
          kind: 'retry_exhausted',
          detail: { cause: verdict.cause, attempts: job.used, max: effectiveMax },
          at: now,
        });
      }
      return null;
    }
    const number = job.used + 1;
    // A missing base ref is healed before the next dispatch: no reason to wait.
    const delaySec = verdict.cause === 'base_ref' ? 0 : retryDelaySec(number);
    const retryAt = new Date(now.getTime() + delaySec * 1000);
    await tx.query(
      `INSERT INTO job_auto_retries (job_id, number, attempt_id, worker_id, cause, machine_specific, max_attempts,
                                     retry_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.jobId,
        number,
        input.attemptId,
        input.workerId,
        verdict.cause,
        verdict.machineSpecific,
        effectiveMax,
        retryAt,
        now,
      ],
    );
    await recordAutoEvent(tx, {
      jobId: input.jobId,
      kind: 'auto_retry',
      detail: {
        number,
        max: effectiveMax,
        cause: verdict.cause,
        machineSpecific: verdict.machineSpecific,
        worker: input.workerId,
        retryAt: retryAt.toISOString(),
      },
      at: now,
    });
    await this.deps.audit.record(
      {
        actor: SELF_HEAL_ACTOR,
        action: 'job.auto_retry',
        target: `job:${input.jobId}`,
        outcome: 'success',
        metadata: {
          attemptId: input.attemptId,
          number,
          max: effectiveMax,
          cause: verdict.cause,
          phase: input.phase,
          machineSpecific: verdict.machineSpecific,
          workerId: input.workerId,
          retryAt: retryAt.toISOString(),
        },
      },
      tx,
    );
    return {
      number,
      max: effectiveMax,
      cause: verdict.cause,
      machineSpecific: verdict.machineSpecific,
      retryAt,
      reason: retryReason(number, effectiveMax, verdict.cause),
    };
  }
}

function retryReason(n: number, max: number, cause: string): string {
  return `automatic retry ${String(n)}/${String(max)} (${cause}): the failure is transient`;
}

/** SQL: the job may not be requeued before its automatic retry's time (used by the orchestrator's promotion). */
export const AUTO_RETRY_NOT_DUE_SQL = (alias: string, nowParam: string): string =>
  `EXISTS (SELECT 1 FROM job_auto_retries ar WHERE ar.job_id = ${alias}.id AND ar.retry_at > ${nowParam})`;

/** Machines the job's next attempt should avoid (machine-specific automatic retries), most recent first. */
export async function avoidedWorkers(db: Queryable, jobId: string): Promise<string[]> {
  const { rows } = await db.query<{ worker_id: string }>(
    `SELECT worker_id FROM job_auto_retries
      WHERE job_id = $1 AND machine_specific AND worker_id IS NOT NULL ORDER BY number DESC`,
    [jobId],
  );
  return [...new Set(rows.map((r) => r.worker_id))];
}

/** Ranked candidates with the avoided machines moved to the end (kept: the only eligible machine still runs it). */
export function rankAvoiding<T extends { readonly workerId: string }>(
  ranked: readonly T[],
  avoid: readonly string[],
): T[] {
  if (avoid.length === 0) return [...ranked];
  const set = new Set(avoid);
  return [...ranked.filter((c) => !set.has(c.workerId)), ...ranked.filter((c) => set.has(c.workerId))];
}
