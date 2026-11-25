import {
  APPROVAL_PAUSE_FEATURE,
  DEFAULT_ACCOUNT_ID,
  type JobPausedReport,
  RUNTIME_ACCOUNTS_FEATURE,
} from '@remyral/protocol';
import type { JobState } from '@remyral/scheduler';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import type { JobStore } from '../jobs/store.js';
import type { WorkerReplay } from '../workers/replay.js';
import { type AccountActor, RuntimeAccountError, type RuntimeAccountService } from './service.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §5): "Hesabı değiştir" — move a job to another runtime
 * account by hand (job page, chat card).
 *
 * - waiting (QUEUED / RETRY_WAIT / …): the job is pinned to the account; the next dispatch uses only it;
 * - PAUSED by a usage limit (or an earlier switch): the pause resumes with that account — at once in the same workspace
 *   on the same machine, else the job restarts on the account's machine as a new attempt;
 * - PAUSED for an approval / a worker restart: pinned (its resume on that machine uses the account);
 * - RUNNING / STARTING: a PAUSE_JOB `account_switch` stops the run and parks it (workspace + session kept); the
 *   confirmation resumes the same attempt with the account (same machine) or restarts it on the other machine.
 *
 * The pin is the person's explicit choice: honoured for an API-key account too (design §3.3). Audited
 * `job.account.switch`; the timeline says "account switch by a person: continuing with account <label> …".
 */

type Tx = pg.PoolClient;

const RETAIN_MS = 24 * 3600 * 1000;
const WAITING_STATES: readonly JobState[] = ['DRAFT', 'QUEUED', 'RETRY_WAIT', 'BLOCKED'];

export interface AccountSwitchDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly jobs: JobStore;
  readonly accounts: RuntimeAccountService;
  readonly replay: () => WorkerReplay;
  /** A paused attempt restarts as a new attempt anywhere (UsageLimitService.restartElsewhere). */
  readonly restartElsewhere: (pauseId: string, why: string) => Promise<boolean>;
  /** Ask the dispatcher to look at a job now. */
  readonly dispatch?: (jobId: string) => void;
}

export interface SwitchTarget {
  readonly workerId: string;
  readonly runtime?: string | undefined;
  readonly account: string;
}

export type SwitchResult = 'pinned' | 'resuming' | 'pausing' | 'restarting';

/** `job_pauses.account_switch`: where the switched attempt continues. */
export interface AccountSwitchFacts {
  readonly workerId: string;
  readonly runtime: string;
  readonly account: string;
  readonly label: string;
  readonly by: string;
}

export class AccountSwitchService {
  constructor(private readonly deps: AccountSwitchDeps) {}

  async switchAccount(jobId: string, target: SwitchTarget, actor: AccountActor): Promise<SwitchResult> {
    const now = this.deps.clock();
    const job = await this.#job(jobId);
    if (job === null) throw new RuntimeAccountError(404, 'job_not_found', 'Job not found.');
    // p22-coolify-env-exists (prod 2026-11-02: a card confirmed after its job had succeeded answered 500 from the
    // jobs_guard_update trigger): a finished job has no account to move.
    if (job.state === 'SUCCEEDED' || job.state === 'FAILED' || job.state === 'CANCELLED') {
      throw new RuntimeAccountError(
        409,
        'job_finished',
        `The job has already finished (${job.state}); there is no account to move.`,
      );
    }
    const runtime = target.runtime ?? job.runtime;
    if (runtime !== 'claude-code' && runtime !== 'codex') {
      throw new RuntimeAccountError(
        409,
        'switch_not_possible',
        'Only Claude Code and Codex jobs have accounts.',
      );
    }
    if (runtime !== job.runtime) {
      throw new RuntimeAccountError(
        409,
        'switch_not_possible',
        `The job runs ${job.runtime}; pick an account of that runtime.`,
      );
    }
    const account = await this.deps.accounts.get(target.workerId, runtime, target.account);
    if (account === null || !account.supported) {
      throw new RuntimeAccountError(
        account === null ? 404 : 409,
        account === null ? 'account_not_found' : 'worker_update_required',
        account === null ? 'No such account.' : 'That machine needs a newer worker release for accounts.',
      );
    }
    if (account.paused) {
      throw new RuntimeAccountError(409, 'account_paused', 'That account is paused; resume it first.');
    }
    if (
      job.workerId === target.workerId &&
      (job.account ?? DEFAULT_ACCOUNT_ID) === target.account &&
      (job.state === 'RUNNING' || job.state === 'STARTING' || job.state === 'PAUSED')
    ) {
      throw new RuntimeAccountError(409, 'same_account', 'The job already runs with that account.');
    }
    const pin = {
      workerId: target.workerId,
      runtime,
      account: target.account,
      by: actor.userId,
      at: now.toISOString(),
    };
    const facts: AccountSwitchFacts = {
      workerId: target.workerId,
      runtime,
      account: target.account,
      label: account.label,
      by: actor.userId,
    };
    const outcome = await withTransaction(
      this.deps.pool,
      async (tx): Promise<{ result: SwitchResult; pauseId?: string }> => {
        const { rows } = await tx.query<{ state: JobState; current_attempt_id: string | null }>(
          'SELECT state, current_attempt_id FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId],
        );
        const state = rows[0]?.state;
        if (state === undefined) throw new RuntimeAccountError(404, 'job_not_found', 'Job not found.');
        // jobs rows change only with a version bump (jobs_guard_update).
        await tx.query(
          'UPDATE jobs SET account_pin = $2, version = version + 1, updated_at = $3 WHERE id = $1',
          [jobId, JSON.stringify(pin), now],
        );
        let result: SwitchResult = 'pinned';
        let pauseId: string | undefined;
        if (state === 'PAUSED') {
          const { rows: pr } = await tx.query<{
            id: string;
            cause: string;
            worker_id: string;
            runtime: string | null;
          }>(
            `SELECT id, cause, worker_id, usage_limit->>'runtime' AS runtime FROM job_pauses
            WHERE job_id = $1 AND ended_at IS NULL FOR UPDATE`,
            [jobId],
          );
          const p = pr[0];
          if (p !== undefined && (p.cause === 'usage_limit' || p.cause === 'account_switch')) {
            pauseId = p.id;
            if (p.worker_id === target.workerId) {
              await tx.query(
                `UPDATE job_pauses SET status = 'resuming', blocked_reason = NULL, resume_requested_at = $2,
                      resume_requested_by = $3, resume_options = $4
                WHERE id = $1`,
                [
                  p.id,
                  now,
                  actor.userId,
                  JSON.stringify([{ runtime, index: 0, origin: 'job', account: target.account }]),
                ],
              );
              result = 'resuming';
            } else {
              result = 'restarting';
            }
          }
        } else if (state === 'RUNNING' || state === 'STARTING') {
          result = 'pausing';
          await this.#requestPause(tx, jobId, facts, now);
        } else if (!WAITING_STATES.includes(state) && state !== 'RESERVED') {
          throw new RuntimeAccountError(
            409,
            'switch_not_possible',
            `A ${state} job cannot change its account.`,
          );
        }
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'job.account.switch',
            target: `job:${jobId}`,
            outcome: 'success',
            ip: actor.ip ?? null,
            userAgent: actor.userAgent ?? null,
            metadata: {
              from: { workerId: job.workerId, account: job.account ?? DEFAULT_ACCOUNT_ID },
              to: { workerId: target.workerId, runtime, account: target.account, kind: account.kind },
              state,
              result,
            },
          },
          tx,
        );
        return pauseId === undefined ? { result } : { result, pauseId };
      },
    );
    if (outcome.result === 'restarting' && outcome.pauseId !== undefined) {
      await this.deps.restartElsewhere(
        outcome.pauseId,
        `moved by a person to the ${runtime} account ${account.label} on ${account.workerName}`,
      );
    }
    if (outcome.result !== 'pausing') this.deps.dispatch?.(jobId);
    return outcome.result;
  }

  /**
   * JOB_RESULT.paused with `cause: "account_switch"` (inside the inbox transaction): PAUSED; on the same machine the
   * same attempt resumes with the account at once, else the pause is blocked so the tick restarts it there.
   */
  async confirmWithin(
    tx: Tx,
    input: {
      readonly jobId: string;
      readonly attemptId: string;
      readonly epoch: number;
      readonly workerId: string;
      readonly report: JobPausedReport;
    },
  ): Promise<boolean> {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      attempt_id: string;
      paused_epoch: number;
      worker_id: string;
      account_switch: AccountSwitchFacts | null;
    }>(
      `SELECT id, status, attempt_id, paused_epoch, worker_id, account_switch FROM job_pauses
        WHERE job_id = $1 AND ended_at IS NULL AND cause = 'account_switch' FOR UPDATE`,
      [input.jobId],
    );
    const p = rows[0];
    if (
      p === undefined ||
      p.status !== 'pausing' ||
      p.attempt_id !== input.attemptId ||
      p.paused_epoch !== input.epoch ||
      p.worker_id !== input.workerId ||
      p.account_switch === null
    ) {
      return false;
    }
    const now = this.deps.clock();
    const f = p.account_switch;
    const here = f.workerId === input.workerId;
    await this.deps.jobs.transitionWithin(tx, input.jobId, 'pause_confirmed', {
      actor: { type: 'worker', id: input.workerId },
      epoch: input.epoch,
      reason: (here
        ? `account switch by a person: continuing with account ${f.label} in the same workspace`
        : `account switch by a person: continuing with account ${f.label} on ${f.workerId} as a new attempt`
      ).slice(0, 1000),
    });
    await tx.query(
      `UPDATE job_pauses
          SET status = $2, paused_at = $3, resume_mode = $4, active_ms = $5, runtime_session_id = $6,
              resume_requested_at = CASE WHEN $2 = 'resuming' THEN $3::timestamptz ELSE NULL END,
              resume_options = $7, blocked_reason = $8
        WHERE id = $1`,
      [
        p.id,
        here ? 'resuming' : 'paused',
        now,
        input.report.resume,
        input.report.activeMs,
        input.report.runtimeSessionId ?? null,
        JSON.stringify([{ runtime: f.runtime, index: 0, origin: 'job', account: f.account }]),
        here ? null : `continues with an account of another machine (${f.workerId})`,
      ],
    );
    await this.deps.audit.record(
      {
        actor: { type: 'worker', id: input.workerId },
        action: 'job.account.switch.paused',
        target: `job:${input.jobId}`,
        outcome: 'success',
        metadata: { pauseId: p.id, attemptId: input.attemptId, epoch: input.epoch, to: f },
      },
      tx,
    );
    return true;
  }

  async #requestPause(tx: Tx, jobId: string, facts: AccountSwitchFacts, now: Date): Promise<void> {
    const { rows } = await tx.query<{
      attempt_id: string;
      epoch: number;
      worker_id: string;
      features: unknown;
    }>(
      `SELECT l.attempt_id, l.epoch, l.worker_id, w.features FROM leases l JOIN workers w ON w.id = l.worker_id
        WHERE l.job_id = $1 AND l.released_at IS NULL ORDER BY l.epoch DESC LIMIT 1`,
      [jobId],
    );
    const lease = rows[0];
    if (lease === undefined)
      throw new RuntimeAccountError(409, 'switch_not_possible', 'The job holds no lease now.');
    const f = Array.isArray(lease.features) ? (lease.features as string[]) : [];
    if (!f.includes(APPROVAL_PAUSE_FEATURE) || !f.includes(RUNTIME_ACCOUNTS_FEATURE)) {
      throw new RuntimeAccountError(
        409,
        'worker_update_required',
        'The machine running the job cannot pause it for an account switch (worker update needed); cancel and run it again instead.',
      );
    }
    const open = await tx.query('SELECT 1 FROM job_pauses WHERE job_id = $1 AND ended_at IS NULL', [jobId]);
    if ((open.rowCount ?? 0) > 0) {
      throw new RuntimeAccountError(409, 'switch_not_possible', 'The job is already being paused.');
    }
    const retainUntil = new Date(now.getTime() + RETAIN_MS);
    await tx.query(
      `INSERT INTO job_pauses (job_id, attempt_id, worker_id, paused_epoch, request_id, status, requested_at,
                               retain_until, cause, resume_at, account_switch)
       VALUES ($1, $2, $3, $4, NULL, 'pausing', $5, $6, 'account_switch', $5, $7)`,
      [jobId, lease.attempt_id, lease.worker_id, lease.epoch, now, retainUntil, JSON.stringify(facts)],
    );
    await this.deps.replay().enqueueWithin(
      tx,
      lease.worker_id,
      'PAUSE_JOB',
      {
        attemptId: lease.attempt_id,
        epoch: lease.epoch,
        cause: 'account_switch',
        reason: `moved to another ${facts.runtime} account by a person`,
        retainUntil: retainUntil.toISOString(),
      },
      { jobId },
    );
    for (const ms of [50, 1_000]) {
      setTimeout(() => {
        try {
          this.deps.replay().kick(lease.worker_id);
        } catch {
          // no session: delivered on reconnect
        }
      }, ms).unref();
    }
  }

  async #job(jobId: string): Promise<{
    state: JobState;
    runtime: string;
    workerId: string | null;
    account: string | null;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      state: JobState;
      runtime: string;
      worker_id: string | null;
      account: string | null;
    }>(
      `SELECT j.state, COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime, r.worker_id,
              r.runtime_choice->>'account' AS account
         FROM jobs j LEFT JOIN job_runs r ON r.attempt_id = j.current_attempt_id WHERE j.id = $1`,
      [jobId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : { state: r.state, runtime: r.runtime, workerId: r.worker_id, account: r.account };
  }
}
