import { randomUUID } from 'node:crypto';
import {
  MAX_TIME_LIMIT_SEC,
  MIN_TIME_LIMIT_SEC,
  SetTimeLimitPayload,
  TIME_LIMIT_FEATURE,
  type TimeLimitBinding,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { JobState } from '@remyral/scheduler';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import type { WorkerReplay } from '../workers/replay.js';
import type { WorkerSession } from '../workers/types.js';
import { CHANGED_TIME_LIMIT_SQL } from './approval-mode-sql.js';
import type { JobClockService, JobClockView } from './job-clock.js';
import { LEASE_HELD_UNTIL_SQL } from './store.js';

/**
 * p15-autonomy (docs/design/p15-autonomy.md §10): the time limit is editable from the card — change a job's time
 * limit (`limits.maxDurationSec`) before it starts and while it runs, without restarting it.
 *
 * - The spec stays immutable; each change is a row of `job_time_limit_changes` (seq per job), the latest wins (JobStore
 *   merges it into `JobRecord.spec`, so the master's wall-time backstop and the next attempt use it).
 * - A running attempt's worker (`time-limit-v1`) gets a signed SET_TIME_LIMIT in the same transaction and answers
 *   TIME_LIMIT_STATUS; an older worker keeps its own limit for this attempt (delivery `unsupported`, said on the card).
 * - Bounds: 1 minute … the security policy's `autonomy.maxJobMinutes` (≤ 7 days). Operator+ in the job's project
 *   (`jobs.timelimit`), audited `job.time_limit.change`; serialised with the dispatcher (advisory lock).
 */

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const DISPATCH_LOCK = 'remyral:dispatch';
const MAX_REASON = 1_000;

interface Row {
  id: string;
  project: string;
  state: JobState;
  lease_epoch: number;
  current_attempt_id: string | null;
  spec_sec: number | null;
  changed_sec: number | null;
  seq: number;
  runtime: string;
  kind: string | null;
  lease_worker: string | null;
  lease_live: boolean;
  features: unknown;
  started_at: Date | null;
}

export interface TimeLimitChangeView {
  readonly seq: number;
  readonly fromSec: number;
  readonly toSec: number;
  readonly actor: string | null;
  readonly delivery: 'not_running' | 'sent' | 'unsupported';
  readonly application: 'applied' | 'refused' | null;
  readonly remainingSec: number | null;
  readonly via: 'console' | 'chat' | 'auto';
  readonly createdAt: string;
}

export interface TimeLimitView {
  readonly jobId: string;
  readonly maxDurationSec: number;
  readonly originalSec: number;
  /** The security policy's cap (s). */
  readonly maxAllowedSec: number;
  readonly minSec: number;
  readonly canChange: boolean;
  readonly reason: string | null;
  /** Running: when the attempt started and whether its machine can take a live change. */
  readonly live: { readonly startedAt: string | null; readonly supportsLive: boolean } | null;
  readonly changes: TimeLimitChangeView[];
  /** p20-job-clock: run time, human waits, the time warning and "continue after a timeout" (null: not wired). */
  readonly clock: JobClockView | null;
}

export interface TimeLimitActor {
  readonly subject: Subject;
  readonly ip: string;
  readonly userAgent: string | null;
  readonly via?: 'console' | 'chat';
}

export interface TimeLimitInput {
  /** The new limit (s); or `addSec` to extend the current one. */
  readonly maxDurationSec?: number;
  readonly addSec?: number;
  readonly reason?: string;
}

export class TimeLimitService {
  readonly #clock: () => Date;

  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly replay: () => WorkerReplay;
      readonly signer: () => {
        signTimeLimit(b: TimeLimitBinding): { kid: string; signature: string };
      } | null;
      readonly securityPolicy: SecurityPolicyReader;
      readonly clock?: () => Date;
      /** p20-job-clock: the clock part of the view. */
      readonly jobClock?: () => JobClockService | null;
    },
  ) {
    this.#clock = deps.clock ?? (() => new Date());
  }

  /** The security policy's cap for job time limits (s). */
  async maxAllowedSec(): Promise<number> {
    const p = await this.deps.securityPolicy.current();
    return Math.min(MAX_TIME_LIMIT_SEC, p.autonomy.maxJobMinutes * 60);
  }

  async #row(db: Queryable, jobId: string, lock: boolean): Promise<Row | null> {
    const { rows } = await db.query<Row>(
      `SELECT j.id, j.project, j.state, j.lease_epoch, j.current_attempt_id::text AS current_attempt_id,
              (j.spec->'limits'->>'maxDurationSec')::int AS spec_sec, ${CHANGED_TIME_LIMIT_SQL('j')} AS changed_sec,
              COALESCE((SELECT max(c.seq) FROM job_time_limit_changes c WHERE c.job_id = j.id), 0)::int AS seq,
              j.spec->>'runtime' AS runtime, j.spec->>'kind' AS kind,
              l.worker_id AS lease_worker,
              (l.id IS NOT NULL AND l.epoch = j.lease_epoch AND ${LEASE_HELD_UNTIL_SQL('l')} > $2) AS lease_live,
              w.features, a.started_at
         FROM jobs j
         LEFT JOIN leases l ON l.job_id = j.id AND l.released_at IS NULL
         LEFT JOIN workers w ON w.id = l.worker_id
         LEFT JOIN job_attempts a ON a.id = j.current_attempt_id
        WHERE j.id = $1${lock ? '\n        FOR UPDATE OF j' : ''}`,
      [jobId, this.#clock()],
    );
    return rows[0] ?? null;
  }

  #current(r: Row): number {
    return r.changed_sec ?? r.spec_sec ?? 3600;
  }

  #supports(r: Row): boolean {
    const f = Array.isArray(r.features) ? (r.features as unknown[]) : [];
    return f.includes(TIME_LIMIT_FEATURE);
  }

  #stateProblem(r: Row): { reason: string; message: string; state?: string } | null {
    if (TERMINAL.has(r.state)) {
      const state = r.state.toLowerCase();
      return { reason: 'finished', message: `The job is ${state}.`, state };
    }
    if (r.state === 'CANCELLING') return { reason: 'cancelling', message: 'The job is being cancelled.' };
    return null;
  }

  async status(jobId: string, subject: Subject): Promise<TimeLimitView> {
    const r = await this.#row(this.deps.pool, jobId, false);
    if (r === null) throw new HttpError(404, 'job_not_found', 'Job not found.');
    const { rows } = await this.deps.pool.query<{
      seq: number;
      from_sec: number;
      to_sec: number;
      username: string | null;
      delivery: TimeLimitChangeView['delivery'];
      application: TimeLimitChangeView['application'];
      remaining_sec: number | null;
      via: 'console' | 'chat' | 'auto';
      created_at: Date;
    }>(
      `SELECT c.seq, c.from_sec, c.to_sec, u.username, c.delivery, c.application, c.remaining_sec, c.via, c.created_at
         FROM job_time_limit_changes c LEFT JOIN users u ON u.id = c.actor_id
        WHERE c.job_id = $1 ORDER BY c.seq`,
      [jobId],
    );
    const may = authorize(subject, 'jobs.timelimit', { project: r.project }).allow;
    const problem = this.#stateProblem(r);
    const running = r.lease_live && r.lease_worker !== null;
    return {
      jobId,
      maxDurationSec: this.#current(r),
      originalSec: r.spec_sec ?? this.#current(r),
      maxAllowedSec: await this.maxAllowedSec(),
      minSec: MIN_TIME_LIMIT_SEC,
      canChange: may && problem === null,
      reason: !may ? 'Your role cannot change the time limit of this job.' : (problem?.message ?? null),
      live: running
        ? { startedAt: r.started_at?.toISOString() ?? null, supportsLive: this.#supports(r) }
        : null,
      changes: rows.map((c) => ({
        seq: c.seq,
        fromSec: c.from_sec,
        toSec: c.to_sec,
        actor: c.username,
        delivery: c.delivery,
        application: c.application,
        remainingSec: c.remaining_sec,
        via: c.via,
        createdAt: c.created_at.toISOString(),
      })),
      clock: (await this.deps.jobClock?.()?.view(jobId, subject)) ?? null,
    };
  }

  async change(
    jobId: string,
    input: TimeLimitInput,
    actor: TimeLimitActor,
  ): Promise<{ changed: boolean; timeLimit: TimeLimitView }> {
    const userId = actor.subject.userId;
    const meta = { ip: actor.ip, userAgent: actor.userAgent };
    const reason =
      typeof input.reason === 'string' && input.reason.trim() !== ''
        ? input.reason.replaceAll('\u0000', '').trim().slice(0, MAX_REASON)
        : null;
    try {
      const max = await this.maxAllowedSec();
      const out = await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [DISPATCH_LOCK]);
        const r = await this.#row(tx, jobId, true);
        if (r === null) throw new HttpError(404, 'job_not_found', 'Job not found.');
        if (!authorize(actor.subject, 'jobs.timelimit', { project: r.project }).allow) {
          throw new HttpError(
            403,
            'forbidden',
            'Your role cannot change the time limit of this job.',
            {},
            {},
            { reason: 'time_limit' },
          );
        }
        const problem = this.#stateProblem(r);
        if (problem !== null) {
          const { message, ...params } = problem;
          throw new HttpError(409, 'job_not_changeable', message, {}, {}, params);
        }
        const from = this.#current(r);
        const to =
          input.maxDurationSec !== undefined
            ? Math.round(input.maxDurationSec)
            : from + Math.round(input.addSec ?? 0);
        if (!Number.isFinite(to) || to < MIN_TIME_LIMIT_SEC || to > max) {
          throw new HttpError(
            400,
            'time_limit_out_of_range',
            `The time limit must be between ${String(MIN_TIME_LIMIT_SEC / 60)} and ${String(Math.floor(max / 60))} minutes.`,
            {},
            {},
            { min: String(MIN_TIME_LIMIT_SEC / 60), max: String(Math.floor(max / 60)) },
          );
        }
        if (to === from) return { changed: false, kick: null as string | null };
        const { changeId, seq, running, live, delivery } = await this.#write(tx, r, {
          from,
          to,
          actorId: userId,
          via: actor.via ?? 'console',
          reason,
          changedBy: userId,
        });
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'job.time_limit.change',
            target: `job:${jobId}`,
            outcome: 'success',
            ...meta,
            metadata: {
              project: r.project,
              changeId,
              seq,
              fromSec: from,
              toSec: to,
              state: r.state,
              delivery,
              via: actor.via ?? 'console',
              ...(running ? { workerId: r.lease_worker, attemptId: r.current_attempt_id } : {}),
              ...(reason === null ? {} : { reason }),
            },
          },
          tx,
        );
        return { changed: true, kick: live ? r.lease_worker : null };
      });
      if (out.kick !== null) this.deps.replay().kick(out.kick);
      return { changed: out.changed, timeLimit: await this.status(jobId, actor.subject) };
    } catch (err) {
      if (err instanceof HttpError && err.code !== 'job_not_found') {
        await this.deps.audit.record({
          actor: { type: 'user', id: userId },
          action: 'job.time_limit.change',
          target: `job:${jobId.slice(0, 64)}`,
          outcome: 'denied',
          ...meta,
          metadata: { code: err.code },
        });
      }
      throw err;
    }
  }

  /**
   * One change row (and, for a running attempt on a `time-limit-v1` worker, the signed SET_TIME_LIMIT) inside the
   * caller's transaction, which holds the dispatch lock and the job row lock.
   */
  async #write(
    tx: Queryable,
    r: Row,
    c: {
      readonly from: number;
      readonly to: number;
      readonly actorId: string | null;
      readonly via: 'console' | 'chat' | 'auto';
      readonly reason: string | null;
      readonly changedBy: string;
    },
  ): Promise<{
    changeId: string;
    seq: number;
    running: boolean;
    live: boolean;
    delivery: 'not_running' | 'sent' | 'unsupported';
  }> {
    const now = this.#clock();
    const changeId = randomUUID();
    const seq = r.seq + 1;
    const running =
      r.lease_live &&
      r.lease_worker !== null &&
      r.current_attempt_id !== null &&
      (r.state === 'STARTING' || r.state === 'RUNNING');
    const live = running && this.#supports(r);
    const delivery = !running ? 'not_running' : live ? 'sent' : 'unsupported';
    await tx.query(
      `INSERT INTO job_time_limit_changes
         (id, job_id, seq, from_sec, to_sec, actor_id, job_state, attempt_id, epoch, worker_id, delivery, reason,
          via, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        changeId,
        r.id,
        seq,
        c.from,
        c.to,
        c.actorId,
        r.state,
        running ? r.current_attempt_id : null,
        running ? r.lease_epoch : null,
        running ? r.lease_worker : null,
        delivery,
        c.reason,
        c.via,
        now,
      ],
    );
    if (live && r.lease_worker !== null && r.current_attempt_id !== null) {
      const binding: TimeLimitBinding = {
        workerId: r.lease_worker,
        jobId: r.id,
        attemptId: r.current_attempt_id,
        epoch: r.lease_epoch,
        changeId,
        seq,
        maxDurationSec: c.to,
        changedBy: c.changedBy,
        issuedAt: now.toISOString(),
      };
      const { workerId: _w, jobId: _j, ...fields } = binding;
      const signer = this.deps.signer();
      const payload = SetTimeLimitPayload.parse({
        ...fields,
        ...(signer === null ? {} : { signature: signer.signTimeLimit(binding) }),
      });
      await this.deps.replay().enqueueWithin(tx, r.lease_worker, 'SET_TIME_LIMIT', payload, { jobId: r.id });
    }
    return { changeId, seq, running, live, delivery };
  }

  /** p22-timeout-continuity: how many times the platform extended this job by itself (`via = 'auto'`). */
  async autoExtends(jobId: string, db: Queryable = this.deps.pool): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_time_limit_changes WHERE job_id = $1 AND via = 'auto'`,
      [jobId],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * p22-timeout-continuity (security policy `autonomy.autoExtendTime`): the platform extends a running
   * job's limit from `fromSec` to `toSec` at its time warning. Refused (null) when the job no longer runs, its limit
   * changed meanwhile (a person decided), the job had `maxAutoExtends` automatic extensions already or `toSec` is above
   * the policy's maximum. Audited `job.time_limit.auto_extend` (system actor); the change row has no person (`via
   * 'auto'`).
   */
  async autoExtend(
    jobId: string,
    input: { readonly fromSec: number; readonly toSec: number; readonly maxAutoExtends: number },
  ): Promise<{ readonly n: number; readonly delivery: 'not_running' | 'sent' | 'unsupported' } | null> {
    const max = await this.maxAllowedSec();
    const out = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [DISPATCH_LOCK]);
      const r = await this.#row(tx, jobId, true);
      if (r === null || (r.state !== 'STARTING' && r.state !== 'RUNNING')) return null;
      const from = this.#current(r);
      if (from !== input.fromSec || input.toSec <= from || input.toSec > max) return null;
      const n = await this.autoExtends(jobId, tx);
      if (n >= input.maxAutoExtends) return null;
      const w = await this.#write(tx, r, {
        from,
        to: input.toSec,
        actorId: null,
        via: 'auto',
        reason:
          'extended at the time warning: the job is progressing (security policy autonomy.autoExtendTime)',
        changedBy: 'system:job-clock',
      });
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'job-clock' },
          action: 'job.time_limit.auto_extend',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: {
            project: r.project,
            changeId: w.changeId,
            seq: w.seq,
            fromSec: from,
            toSec: input.toSec,
            n: n + 1,
            max: input.maxAutoExtends,
            delivery: w.delivery,
            policy: 'autonomy.autoExtendTime',
            ...(w.running ? { workerId: r.lease_worker, attemptId: r.current_attempt_id } : {}),
          },
        },
        tx,
      );
      return { n: n + 1, delivery: w.delivery, kick: w.live ? r.lease_worker : null };
    });
    if (out === null) return null;
    if (out.kick !== null) this.deps.replay().kick(out.kick);
    return { n: out.n, delivery: out.delivery };
  }

  /** TIME_LIMIT_STATUS: only for a change this master sent to this worker for this attempt and epoch. */
  async onStatus(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'TIME_LIMIT_STATUS' }>,
  ): Promise<void> {
    const p = message.payload;
    const detail = p.detail.replaceAll('\u0000', '').slice(0, 2000);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `UPDATE job_time_limit_changes
          SET application = $7, remaining_sec = $8, application_detail = $9, applied_at = $10
        WHERE id = $1 AND job_id::text = $2 AND worker_id = $3 AND attempt_id::text = $4 AND epoch = $5 AND seq = $6
          AND delivery = 'sent' AND application IS NULL
        RETURNING id`,
      [
        p.changeId,
        message.jobId,
        session.workerId,
        p.attemptId,
        p.epoch,
        p.seq,
        p.outcome,
        p.remainingSec ?? null,
        detail,
        this.#clock(),
      ],
    );
    if (rows.length === 0) return;
    await this.deps.audit.record({
      actor: { type: 'worker', id: session.workerId },
      action: 'job.time_limit.applied',
      target: `job:${message.jobId}`,
      outcome: p.outcome === 'refused' ? 'denied' : 'success',
      metadata: {
        changeId: p.changeId,
        seq: p.seq,
        remainingSec: p.remainingSec ?? null,
        detail: detail.slice(0, 500),
      },
    });
  }
}
