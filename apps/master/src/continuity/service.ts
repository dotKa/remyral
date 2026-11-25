import {
  type CheckpointReportPayload,
  type ContinuityPolicy,
  type RecoverableJob,
  restartSummary,
  SESSION_CONTINUITY_FEATURE,
  type ToolCallNote,
  type WorkerRestartResume,
} from '@remyral/protocol';
import type { JobState } from '@remyral/scheduler';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { IllegalTransitionError, JobStoreError, VersionConflictError } from '../jobs/errors.js';
import { LEASE_HELD_UNTIL_SQL, type JobStore } from '../jobs/store.js';
import type { WorkerReplay } from '../workers/replay.js';

/**
 * p11-session-continuity (docs/design/p11-session-continuity.md, ADR-0042), master side.
 *
 * - **checkpoints** (CHECKPOINT_REPORT, control): stored per attempt (metadata only) when the reporting worker holds the
 *   job's live lease under that attempt and epoch; the newest 50 per attempt are kept.
 * - **restart detection** (orchestrator step `worker-restart`, before the LOST reconciliation): a connected worker whose
 *   HEARTBEAT lists an attempt it can resume (`recoverableJobs`) — the job's current attempt, under the lease epoch it
 *   ran with, on that worker — is parked: RUNNING / STARTING → PAUSED (`pause_confirmed`, worker actor, fenced by the
 *   epoch) or LOST → PAUSED (`reconcile_pause`), with a pause episode `worker_restart` that resumes at once. Pending
 *   in-run approval requests of the stopped run are cancelled (the resumed runtime asks again). An entry with a
 *   `problem` is recorded on the attempt and left to the classic reconciliation (retry only when verifiably safe).
 * - **resume** (orchestrator "resume-paused"): the same attempt on the same machine under a new epoch, with
 *   `execution.resume{cause: "worker_restart"}` — the same path as an approval or usage-limit resume.
 * - **retention**: a restart episode that could not resume within a day ends the job (cancelled, kept workspace
 *   discarded); a blocked one waits for a human (Restart from scratch / Cancel).
 */

const RECONCILER = { type: 'system', id: 'reconciler' } as const;
const SYSTEM = { type: 'system', id: 'session-continuity' } as const;
const KEEP_CHECKPOINTS = 50;
const RETAIN_MS = 24 * 3600_000;

type Tx = pg.PoolClient;

export interface RestartFacts {
  readonly checkpoint: number;
  readonly checkpointAt: string | null;
  readonly restarts: number;
  readonly unknownOutcome: readonly ToolCallNote[];
  readonly resume: 'session' | 'continuation';
  readonly detectedFrom: 'running' | 'lost';
}

export interface CheckpointView {
  readonly n: number;
  readonly epoch: number;
  readonly takenAt: string;
  readonly kind: 'git' | 'snapshot';
  readonly ref: string | null;
  readonly commit: string | null;
  readonly files: number;
  readonly bytes: number;
  readonly lastTool: ToolCallNote | null;
  readonly inFlight: number;
}

export interface RestartView {
  readonly pauseId: string;
  readonly status: string;
  readonly detectedAt: string;
  readonly pausedEpoch: number;
  readonly resumedEpoch: number | null;
  readonly checkpoint: number;
  readonly checkpointAt: string | null;
  readonly restarts: number;
  readonly resume: 'session' | 'continuation';
  readonly unknownOutcome: readonly ToolCallNote[];
  readonly blockedReason: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly summary: string;
}

export interface ContinuityView {
  readonly checkpoints: readonly CheckpointView[];
  readonly restarts: readonly RestartView[];
}

export interface PreparedRestartResume {
  readonly pauseId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly resume: WorkerRestartResume;
}

export interface ContinuityDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly jobs: JobStore;
  readonly replay: () => WorkerReplay;
  readonly clock?: () => Date;
  /** Checkpoint policy sent with every assignment to a `session-continuity-v1` worker (null: continuity off). */
  readonly policy: ContinuityPolicy | null;
}

interface EpisodeRow {
  id: string;
  job_id: string;
  attempt_id: string;
  worker_id: string;
  paused_epoch: number;
  status: string;
  requested_at: Date;
  retain_until: Date;
  active_ms: number;
  resumed_epoch: number | null;
  blocked_reason: string | null;
  ended_at: Date | null;
  end_reason: string | null;
  restart: RestartFacts | null;
}

export class SessionContinuityService {
  private readonly clock: () => Date;
  /** `attempt:epoch` problems already recorded (one note per left-over attempt). */
  readonly #noted = new Set<string>();

  constructor(private readonly deps: ContinuityDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** `execution.continuity` for an assignment to `workerId` (only to workers with the feature; null: none). */
  async policyFor(workerId: string, db: Queryable = this.deps.pool): Promise<ContinuityPolicy | null> {
    if (this.deps.policy === null) return null;
    const { rows } = await db.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, SESSION_CONTINUITY_FEATURE],
    );
    return rows[0]?.ok === true ? this.deps.policy : null;
  }

  // ------------------------------------------------------------------------------------------- checkpoints

  /** CHECKPOINT_REPORT: stored when the worker holds the live lease of that attempt and epoch. Returns whether stored. */
  async onCheckpoint(workerId: string, jobId: string, p: CheckpointReportPayload): Promise<boolean> {
    const now = this.clock();
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      `SELECT TRUE AS ok FROM leases l JOIN jobs j ON j.id = l.job_id
        WHERE j.id::text = $1 AND l.attempt_id::text = $2 AND l.epoch = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [jobId, p.attemptId, p.epoch, workerId, now],
    );
    if (rows[0]?.ok !== true) return false;
    await this.deps.pool.query(
      `INSERT INTO attempt_checkpoints (attempt_id, job_id, n, epoch, worker_id, taken_at, received_at, kind, ref,
                                        commit_sha, files, bytes, runtime_session_id, last_tool, in_flight, active_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (attempt_id, n) DO NOTHING`,
      [
        p.attemptId,
        jobId,
        p.n,
        p.epoch,
        workerId,
        new Date(Math.min(Date.parse(p.at), now.getTime())),
        now,
        p.kind,
        p.ref ?? null,
        p.commit ?? null,
        p.files,
        p.bytes,
        p.runtimeSessionId ?? null,
        p.lastTool === undefined ? null : JSON.stringify(p.lastTool),
        p.inFlight,
        p.activeMs,
      ],
    );
    await this.deps.pool.query(
      `DELETE FROM attempt_checkpoints WHERE attempt_id = $1 AND n <= (
         SELECT n FROM attempt_checkpoints WHERE attempt_id = $1 ORDER BY n DESC OFFSET $2 LIMIT 1)`,
      [p.attemptId, KEEP_CHECKPOINTS],
    );
    return true;
  }

  // ------------------------------------------------------------------------------------------- restart detection

  /**
   * One HEARTBEAT `recoverableJobs` entry of a connected worker. Returns `parked` when the job was parked for the
   * resume, `problem` when the worker cannot resume it (recorded once; the classic reconciliation decides), or
   * `ignored` (not this job's current attempt / lease any more, no feature, already handled).
   */
  async onRecoverable(workerId: string, e: RecoverableJob): Promise<'parked' | 'problem' | 'ignored'> {
    if (e.problem !== undefined) {
      await this.#noteProblem(workerId, e);
      return 'problem';
    }
    try {
      return await withTransaction(this.deps.pool, async (tx) => {
        const { rows } = await tx.query<{
          state: JobState;
          current_attempt_id: string | null;
          lease_epoch: number;
          a_worker: string | null;
          can: boolean | null;
          open: boolean;
        }>(
          `SELECT j.state, j.current_attempt_id, j.lease_epoch, a.worker_id AS a_worker,
                  (SELECT features ? $2 FROM workers WHERE id = $3) AS can,
                  EXISTS (SELECT 1 FROM job_pauses p WHERE p.job_id = j.id AND p.ended_at IS NULL) AS open
             FROM jobs j LEFT JOIN job_attempts a ON a.id = j.current_attempt_id
            WHERE j.id::text = $1 FOR UPDATE OF j`,
          [e.jobId, SESSION_CONTINUITY_FEATURE, workerId],
        );
        const job = rows[0];
        if (
          job === undefined ||
          job.current_attempt_id !== e.attemptId ||
          job.a_worker !== workerId ||
          job.lease_epoch !== e.epoch ||
          job.can !== true ||
          job.open
        ) {
          return 'ignored';
        }
        const now = this.clock();
        const reason = restartSummary(e.checkpoint, e.checkpointAt, now);
        const unknown =
          e.unknownOutcome.length === 0
            ? ''
            : `; ${String(e.unknownOutcome.length)} tool call(s) in flight with unknown outcome (${e.unknownOutcome
                .map((t) => t.toolName)
                .slice(0, 5)
                .join(', ')}) — the agent verifies before retrying`;
        let from: 'running' | 'lost';
        if (job.state === 'RUNNING' || job.state === 'STARTING') {
          from = 'running';
          await this.deps.jobs.transitionWithin(tx, e.jobId, 'pause_confirmed', {
            actor: { type: 'worker', id: workerId },
            epoch: e.epoch,
            reason: `${reason}${unknown}`.slice(0, 1000),
          });
        } else if (job.state === 'LOST') {
          from = 'lost';
          await this.deps.jobs.transitionWithin(tx, e.jobId, 'reconcile_pause', {
            actor: RECONCILER,
            reason: `${reason}${unknown}`.slice(0, 1000),
          });
        } else {
          return 'ignored';
        }
        const facts: RestartFacts = {
          checkpoint: e.checkpoint,
          checkpointAt: e.checkpointAt ?? null,
          restarts: e.restarts,
          unknownOutcome: e.unknownOutcome,
          resume: e.resume,
          detectedFrom: from,
        };
        await tx.query(
          `INSERT INTO job_pauses (job_id, attempt_id, worker_id, paused_epoch, request_id, status, requested_at, paused_at,
                                   retain_until, resume_mode, active_ms, runtime_session_id, cause, resume_at,
                                   resume_requested_at, restart)
           VALUES ($1, $2, $3, $4, NULL, 'resuming', $5, $5, $6, $7, $8, $9, 'worker_restart', $5, $5, $10)`,
          [
            e.jobId,
            e.attemptId,
            workerId,
            e.epoch,
            now,
            new Date(now.getTime() + RETAIN_MS),
            e.resume,
            Math.min(e.activeMs, 7 * 24 * 3600 * 1000),
            e.runtimeSessionId ?? null,
            JSON.stringify(facts),
          ],
        );
        // The stopped run's pending in-run approvals: the resumed runtime asks again (a new request).
        const closed = await tx.query<{ id: string; action: string }>(
          `UPDATE approval_requests SET status = 'cancelled', decided_at = $3,
                  decision_reason = 'the worker restarted; the resumed run asks again'
            WHERE job_id = $1 AND attempt_id = $2 AND kind = 'in_run' AND status = 'pending'
            RETURNING id, action`,
          [e.jobId, e.attemptId, now],
        );
        for (const r of closed.rows) {
          await this.deps.audit.record(
            {
              actor: SYSTEM,
              action: 'approval.cancel',
              target: `approval:${r.id}`,
              outcome: 'success',
              metadata: {
                requestId: r.id,
                jobId: e.jobId,
                action: r.action,
                kind: 'in_run',
                workerRestart: true,
              },
            },
            tx,
          );
        }
        await tx.query(`UPDATE job_runs SET recovery = $2, updated_at = $3 WHERE attempt_id = $1`, [
          e.attemptId,
          JSON.stringify({ decision: 'restart_resume', reason, at: now.toISOString() }),
          now,
        ]);
        await this.deps.audit.record(
          {
            actor: { type: 'worker', id: workerId },
            action: 'job.continuity.restart_detected',
            target: `job:${e.jobId}`,
            outcome: 'success',
            metadata: {
              attemptId: e.attemptId,
              epoch: e.epoch,
              checkpoint: e.checkpoint,
              restarts: e.restarts,
              from,
              resume: e.resume,
              unknownOutcome: e.unknownOutcome.map((t) => `${t.toolName}:${t.class}`).slice(0, 20),
              cancelledApprovals: closed.rows.length,
            },
          },
          tx,
        );
        return 'parked' as const;
      });
    } catch (err) {
      if (
        err instanceof IllegalTransitionError ||
        err instanceof VersionConflictError ||
        err instanceof JobStoreError
      ) {
        return 'ignored';
      }
      throw err;
    }
  }

  async #noteProblem(workerId: string, e: RecoverableJob): Promise<void> {
    const key = `${e.attemptId}:${String(e.epoch)}`;
    if (this.#noted.has(key)) return;
    this.#noted.add(key);
    if (this.#noted.size > 10_000) this.#noted.clear();
    const now = this.clock();
    const { rows } = await this.deps.pool.query<{ current_attempt_id: string | null }>(
      'SELECT current_attempt_id FROM jobs WHERE id::text = $1',
      [e.jobId],
    );
    if (rows[0]?.current_attempt_id !== e.attemptId) return;
    await this.deps.audit.record({
      actor: { type: 'worker', id: workerId },
      action: 'job.continuity.not_resumable',
      target: `job:${e.jobId}`,
      outcome: 'failure',
      metadata: { attemptId: e.attemptId, epoch: e.epoch, problem: (e.problem ?? '').slice(0, 300) },
    });
    await this.deps.pool.query(
      `UPDATE job_runs SET recovery = $2, updated_at = $3 WHERE attempt_id::text = $1`,
      [
        e.attemptId,
        JSON.stringify({
          decision: 'restart_not_resumable',
          reason: `Worker restarted — the attempt cannot be resumed: ${(e.problem ?? '').slice(0, 300)}`,
          at: now.toISOString(),
        }),
        now,
      ],
    );
  }

  // ------------------------------------------------------------------------------------------- resume dispatch

  async owns(pauseId: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ cause: string }>(
      'SELECT cause FROM job_pauses WHERE id = $1',
      [pauseId],
    );
    return rows[0]?.cause === 'worker_restart';
  }

  /** `resuming` worker-restart episodes of PAUSED jobs, oldest first. */
  async resumable(limit = 20): Promise<{ readonly pauseId: string; readonly jobId: string }[]> {
    const { rows } = await this.deps.pool.query<{ id: string; job_id: string }>(
      `SELECT p.id, p.job_id FROM job_pauses p JOIN jobs j ON j.id = p.job_id
        WHERE p.ended_at IS NULL AND p.cause = 'worker_restart' AND p.status = 'resuming' AND p.blocked_reason IS NULL
          AND j.state = 'PAUSED'
        ORDER BY p.resume_requested_at NULLS LAST, p.requested_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ pauseId: r.id, jobId: r.job_id }));
  }

  /** Re-validates a restart resume (job still paused on that attempt, machine still there and capable). */
  async prepareResume(pauseId: string): Promise<PreparedRestartResume | null> {
    return withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#episode(tx, pauseId);
      if (p === null || p.ended_at !== null || p.status !== 'resuming' || p.blocked_reason !== null)
        return null;
      const { rows } = await tx.query<{ state: JobState; current_attempt_id: string | null }>(
        'SELECT state, current_attempt_id FROM jobs WHERE id = $1 FOR UPDATE',
        [p.job_id],
      );
      const job = rows[0];
      if (job?.state !== 'PAUSED' || job.current_attempt_id !== p.attempt_id) return null;
      const { rows: w } = await tx.query<{
        state: string;
        archived: boolean;
        can: boolean;
        name: string | null;
      }>(
        `SELECT state, archived_at IS NOT NULL AS archived, (features ? $2) AS can, display_name AS name
           FROM workers WHERE id = $1`,
        [p.worker_id, SESSION_CONTINUITY_FEATURE],
      );
      const worker = w[0];
      if (worker === undefined || worker.archived || worker.state === 'quarantined' || !worker.can) {
        await this.#block(
          tx,
          p,
          `The machine ${worker?.name ?? p.worker_id} that keeps the workspace ${
            worker === undefined
              ? 'was removed'
              : worker.archived
                ? 'is archived'
                : worker.state === 'quarantined'
                  ? 'is quarantined'
                  : 'no longer runs a worker version that can resume after a restart'
          }; restart from scratch or cancel.`,
        );
        return null;
      }
      const facts = p.restart;
      return {
        pauseId: p.id,
        jobId: p.job_id,
        workerId: p.worker_id,
        resume: {
          cause: 'worker_restart',
          pausedEpoch: p.paused_epoch,
          checkpoint: facts?.checkpoint ?? 0,
          activeMs: Math.max(0, Math.min(p.active_ms, 7 * 24 * 3600 * 1000)),
          restart: Math.min(100, (facts?.restarts ?? 0) + 1),
        },
      };
    });
  }

  async blockResume(pauseId: string, reason: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const p = await this.#episode(tx, pauseId);
      if (p === null || p.ended_at !== null) return;
      await this.#block(tx, p, `The machine cannot resume it: ${reason.slice(0, 400)}`);
    });
  }

  /** Retention: restart episodes that did not resume within a day end the job (cancelled; workspace discarded). */
  async tick(limit = 20): Promise<number> {
    const now = this.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT p.id FROM job_pauses p JOIN jobs j ON j.id = p.job_id
        WHERE p.ended_at IS NULL AND p.cause = 'worker_restart' AND p.retain_until <= $1 AND j.state = 'PAUSED'
        LIMIT $2`,
      [now, limit],
    );
    let n = 0;
    for (const r of rows) {
      const done = await withTransaction(this.deps.pool, async (tx) => {
        const p = await this.#episode(tx, r.id);
        if (p === null || p.ended_at !== null) return false;
        const { rows: j } = await tx.query<{ state: JobState }>(
          'SELECT state FROM jobs WHERE id = $1 FOR UPDATE',
          [p.job_id],
        );
        if (j[0]?.state !== 'PAUSED') return false;
        await this.deps.jobs.transitionWithin(tx, p.job_id, 'cancel_requested', {
          actor: SYSTEM,
          reason: 'the attempt kept after a worker restart could not be resumed within a day',
        });
        await this.#discard(tx, p, 'not resumed within the retention after a worker restart');
        await tx.query(
          `UPDATE job_pauses SET status = 'expired', ended_at = $2, end_reason = 'not resumed within a day'
            WHERE id = $1 AND ended_at IS NULL`,
          [p.id, now],
        );
        return true;
      }).catch(() => false);
      if (done) n++;
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------- views

  async view(jobId: string, db: Queryable = this.deps.pool): Promise<ContinuityView> {
    const { rows: cp } = await db.query<{
      n: number;
      epoch: number;
      taken_at: Date;
      kind: 'git' | 'snapshot';
      ref: string | null;
      commit_sha: string | null;
      files: number;
      bytes: string;
      last_tool: ToolCallNote | null;
      in_flight: number;
    }>(
      `SELECT c.n, c.epoch, c.taken_at, c.kind, c.ref, c.commit_sha, c.files, c.bytes::text AS bytes, c.last_tool, c.in_flight
         FROM attempt_checkpoints c JOIN jobs j ON j.id = c.job_id
        WHERE c.job_id = $1 AND c.attempt_id = j.current_attempt_id
        ORDER BY c.n DESC LIMIT 20`,
      [jobId],
    );
    const { rows: eps } = await db.query<EpisodeRow>(
      `SELECT p.id, p.job_id, p.attempt_id, p.worker_id, p.paused_epoch, p.status, p.requested_at, p.retain_until,
              p.active_ms::int AS active_ms, p.resumed_epoch, p.blocked_reason, p.ended_at, p.end_reason, p.restart
         FROM job_pauses p WHERE p.job_id = $1 AND p.cause = 'worker_restart'
        ORDER BY p.requested_at DESC LIMIT 20`,
      [jobId],
    );
    return {
      checkpoints: cp.map((c) => ({
        n: c.n,
        epoch: c.epoch,
        takenAt: c.taken_at.toISOString(),
        kind: c.kind,
        ref: c.ref,
        commit: c.commit_sha,
        files: c.files,
        bytes: Number(c.bytes),
        lastTool: c.last_tool,
        inFlight: c.in_flight,
      })),
      restarts: eps.map((p) => ({
        pauseId: p.id,
        status: p.status,
        detectedAt: p.requested_at.toISOString(),
        pausedEpoch: p.paused_epoch,
        resumedEpoch: p.resumed_epoch,
        checkpoint: p.restart?.checkpoint ?? 0,
        checkpointAt: p.restart?.checkpointAt ?? null,
        restarts: p.restart?.restarts ?? 0,
        resume: p.restart?.resume ?? 'continuation',
        unknownOutcome: p.restart?.unknownOutcome ?? [],
        blockedReason: p.blocked_reason,
        endedAt: p.ended_at === null ? null : p.ended_at.toISOString(),
        endReason: p.end_reason,
        summary: restartSummary(p.restart?.checkpoint ?? 0, p.restart?.checkpointAt, p.requested_at),
      })),
    };
  }

  // ------------------------------------------------------------------------------------------- helpers

  async #episode(tx: Tx, pauseId: string): Promise<EpisodeRow | null> {
    const { rows } = await tx.query<EpisodeRow>(
      `SELECT p.id, p.job_id, p.attempt_id, p.worker_id, p.paused_epoch, p.status, p.requested_at, p.retain_until,
              p.active_ms::int AS active_ms, p.resumed_epoch, p.blocked_reason, p.ended_at, p.end_reason, p.restart
         FROM job_pauses p WHERE p.id = $1 AND p.cause = 'worker_restart' FOR UPDATE`,
      [pauseId],
    );
    return rows[0] ?? null;
  }

  async #block(tx: Tx, p: EpisodeRow, reason: string): Promise<void> {
    await tx.query(
      `UPDATE job_pauses SET status = 'paused', blocked_reason = $2 WHERE id = $1 AND ended_at IS NULL`,
      [p.id, reason.slice(0, 500)],
    );
    await this.deps.audit.record(
      {
        actor: SYSTEM,
        action: 'job.continuity.resume_blocked',
        target: `job:${p.job_id}`,
        outcome: 'failure',
        metadata: { pauseId: p.id, attemptId: p.attempt_id, reason: reason.slice(0, 300) },
      },
      tx,
    );
  }

  async #discard(tx: Tx, p: EpisodeRow, reason: string): Promise<void> {
    const exists = await tx.query('SELECT 1 FROM workers WHERE id = $1', [p.worker_id]);
    if ((exists.rowCount ?? 0) === 0) return;
    await this.deps.replay().enqueueWithin(
      tx,
      p.worker_id,
      'CANCEL_JOB',
      {
        attemptId: p.attempt_id,
        epoch: p.paused_epoch,
        reason: `kept attempt ended: ${reason}`.slice(0, 1000),
      },
      { jobId: p.job_id },
    );
  }
}
