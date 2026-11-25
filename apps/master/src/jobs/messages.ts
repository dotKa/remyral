import { createHash, randomUUID } from 'node:crypto';
import {
  JOB_MESSAGE_FEATURE,
  JOB_MESSAGE_RECEIPTS_FEATURE,
  jobMessageAdvances,
  type JobMessageDeliveryStatus,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { WorkerReplay } from '../workers/replay.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';

/**
 * Talk to a job's agent (p5-ops-chat §6, p15-message-delivery): a human message delivered as a sequenced JOB_MESSAGE to
 * the worker holding the job's current lease (fenced by attempt and epoch). The worker hands it to the adapter's own
 * follow-up prompt (`interactive_prompt`).
 *
 * p15-message-delivery: every message is a `job_messages` row with its delivery state —
 * `waiting` (held here until the agent runs: queued, paused, retry wait), `sent` (outbox), `received` (outbox ACK /
 * worker receipt), `delivered` (runtime accepted it), `read` (the agent took it), `failed` (code + detail). A replayed
 * POST with the same `clientId` is the same message. Workers with `job-message-receipts-v1` report the steps after
 * `received`; for older workers the state stops at `received` (the job's events still show the message).
 *
 * Authorization: `jobs.message` (operator+ in the job's project) on the route, CSRF; audited with the
 * message's length and hash (the text itself becomes part of the job's event stream, like the prompt).
 */

export interface JobMessageStatus {
  readonly supported: boolean;
  readonly reason: string | null;
  /** `live`: the agent runs (sent now); `queue`: held until it runs; null: not available. */
  readonly mode: 'live' | 'queue' | null;
}

export interface JobMessageView {
  readonly id: string;
  readonly text: string;
  readonly source: 'panel' | 'chat';
  readonly sentBy: string;
  readonly sentByName: string | null;
  readonly status: JobMessageDeliveryStatus;
  readonly code: string | null;
  readonly detail: string | null;
  /** The worker reports delivery steps (false: the state stops at `received`). */
  readonly receipts: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobMessageLimits {
  readonly perUser: { readonly max: number; readonly windowMs: number };
  readonly perJob: { readonly max: number; readonly windowMs: number };
}

export const DEFAULT_JOB_MESSAGE_LIMITS: JobMessageLimits = {
  perUser: { max: 30, windowMs: 10 * 60_000 },
  perJob: { max: 10, windowMs: 60_000 },
};

/** Messages held for a job that does not run yet. */
export const MAX_WAITING_MESSAGES = 20;
/** A sent / received message of an attempt that is gone is closed after this grace (late receipts win). */
const ORPHAN_GRACE_MS = 30_000;

/** The agent runs: a message is sent at once. */
const LIVE_STATES = new Set(['STARTING', 'RUNNING']);
/** The agent will run (again): a message waits here until it does. */
const QUEUE_STATES = new Set(['DRAFT', 'QUEUED', 'BLOCKED', 'RESERVED', 'RETRY_WAIT', 'PAUSED']);

interface Row {
  state: string;
  project: string;
  runtime: string;
  kind: string | null;
  attempt_id: string | null;
  epoch: number;
  worker_id: string | null;
  features: unknown;
  prompt_status: string | null;
}

interface MessageRow {
  id: string;
  job_id: string;
  text: string;
  source: 'panel' | 'chat';
  sent_by: string;
  sent_by_name: string | null;
  status: JobMessageDeliveryStatus;
  code: string | null;
  detail: string | null;
  receipts: boolean;
  attempt_id: string | null;
  worker_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const JOB_ROW_SQL = `SELECT j.state, j.project, COALESCE(jr.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime,
        j.spec->>'kind' AS kind,
        j.current_attempt_id::text AS attempt_id, j.lease_epoch AS epoch, a.worker_id, w.features,
        (SELECT r.capabilities->'interactive_prompt'->>'status' FROM worker_runtimes r
          WHERE r.worker_id = a.worker_id
            AND r.runtime = COALESCE(jr.runtime_choice->>'runtime', j.spec->>'runtime') AND r.present
          ORDER BY r.last_reported_at DESC LIMIT 1) AS prompt_status
   FROM jobs j
   LEFT JOIN job_attempts a ON a.id = j.current_attempt_id
   LEFT JOIN job_runs jr ON jr.attempt_id = j.current_attempt_id
   LEFT JOIN workers w ON w.id = a.worker_id
  WHERE j.id = $1`;

function featuresOf(r: { features: unknown }): unknown[] {
  return Array.isArray(r.features) ? (r.features as unknown[]) : [];
}

function view(r: MessageRow): JobMessageView {
  return {
    id: r.id,
    text: r.text,
    source: r.source,
    sentBy: r.sent_by,
    sentByName: r.sent_by_name,
    status: r.status,
    code: r.code,
    detail: r.detail,
    receipts: r.receipts,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class JobMessageService {
  readonly #limits: JobMessageLimits;

  constructor(
    private readonly deps: {
      readonly db: Pool;
      readonly audit: AuditRecorder;
      readonly limiter: RateLimiter;
      readonly replay: () => WorkerReplay;
      readonly limits?: JobMessageLimits;
      readonly clock?: () => Date;
    },
  ) {
    this.#limits = deps.limits ?? DEFAULT_JOB_MESSAGE_LIMITS;
  }

  #now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async #row(jobId: string, db: Queryable = this.deps.db): Promise<Row> {
    const { rows } = await db.query<Row>(JOB_ROW_SQL, [jobId]);
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
    return r;
  }

  #check(r: Row): JobMessageStatus {
    if (r.kind === 'interactive-openhands' || r.runtime === 'openhands') {
      // ADR-0023: historical OpenHands jobs are read-only.
      return { supported: false, reason: 'OpenHands was removed from the platform (ADR-0023).', mode: null };
    }
    if (LIVE_STATES.has(r.state) && r.attempt_id !== null && r.worker_id !== null) {
      if (!featuresOf(r).includes(JOB_MESSAGE_FEATURE)) {
        return {
          supported: false,
          reason: 'The worker running this job must be updated to take messages.',
          mode: null,
        };
      }
      if (r.prompt_status === 'unsupported') {
        return {
          supported: false,
          reason: `${r.runtime} does not accept follow-up prompts while running.`,
          mode: null,
        };
      }
      return { supported: true, reason: null, mode: 'live' };
    }
    if (QUEUE_STATES.has(r.state) || (LIVE_STATES.has(r.state) && r.attempt_id === null)) {
      return { supported: true, reason: null, mode: 'queue' };
    }
    return {
      supported: false,
      reason:
        r.state === 'CANCELLING'
          ? 'The job is being cancelled; the agent takes no more messages.'
          : 'The agent has finished this run; it takes no more messages. Continue the job to start a new run.',
      mode: null,
    };
  }

  async status(jobId: string): Promise<JobMessageStatus> {
    return this.#check(await this.#row(jobId));
  }

  /** The job's messages, oldest first (the last 100). */
  async list(jobId: string): Promise<JobMessageView[]> {
    const { rows } = await this.deps.db.query<MessageRow>(
      `SELECT * FROM (
         SELECT m.id::text AS id, m.job_id::text AS job_id, m.text, m.source, m.sent_by::text AS sent_by,
                u.username AS sent_by_name, m.status, m.code, m.detail, m.receipts, m.attempt_id::text AS attempt_id,
                m.worker_id, m.created_at, m.updated_at
           FROM job_messages m LEFT JOIN users u ON u.id = m.sent_by
          WHERE m.job_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100) t
        ORDER BY created_at, id`,
      [jobId],
    );
    return rows.map(view);
  }

  async send(
    jobId: string,
    text: string,
    actor: ActorContext,
    opts: { readonly source?: 'panel' | 'chat'; readonly clientId?: string } = {},
  ): Promise<{ messageId: string; status: JobMessageDeliveryStatus }> {
    if (opts.clientId !== undefined) {
      const { rows } = await this.deps.db.query<{ id: string; status: JobMessageDeliveryStatus }>(
        'SELECT id::text AS id, status FROM job_messages WHERE job_id = $1 AND client_id = $2',
        [jobId, opts.clientId],
      );
      const same = rows[0];
      if (same !== undefined) return { messageId: same.id, status: same.status };
    }
    const pre = this.#check(await this.#row(jobId));
    if (!pre.supported) {
      throw new HttpError(409, 'job_input_unavailable', pre.reason ?? 'The job cannot take messages.');
    }
    for (const [bucket, key, rule] of [
      ['job-message-user', actor.userId, this.#limits.perUser],
      ['job-message-job', jobId, this.#limits.perJob],
    ] as const) {
      const hit = await this.deps.limiter.hit(bucket, key, rule.max, rule.windowMs);
      if (!hit.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many messages to running jobs; try again later.',
          {
            'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
          },
          {},
          { reason: 'job_messages' },
        );
      }
    }
    const messageId = randomUUID();
    const now = this.#now();
    const source = opts.source ?? 'panel';
    const out = await withTransaction(this.deps.db, async (tx) => {
      // No job row lock (the inbox locks workers → jobs; enqueue locks the worker row): a lease that changes right
      // now is caught by the worker's attempt/epoch fence and the tick (the message then waits for the next run).
      const r = await this.#row(jobId, tx);
      const check = this.#check(r);
      if (!check.supported) {
        throw new HttpError(409, 'job_input_unavailable', check.reason ?? 'The job cannot take messages.');
      }
      if (check.mode === 'queue') {
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM job_messages WHERE job_id = $1 AND status = 'waiting'`,
          [jobId],
        );
        if (Number(rows[0]?.n ?? 0) >= MAX_WAITING_MESSAGES) {
          throw new HttpError(
            409,
            'job_input_unavailable',
            `At most ${String(MAX_WAITING_MESSAGES)} messages can wait for the agent to start.`,
          );
        }
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO job_messages (id, job_id, client_id, source, sent_by, text, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'waiting', $7, $7)
         ON CONFLICT (job_id, client_id) DO NOTHING RETURNING id::text AS id`,
        [messageId, jobId, opts.clientId ?? null, source, actor.userId, text, now],
      );
      if (inserted.rows[0] === undefined) return null; // a concurrent retry with the same clientId won
      if (check.mode === 'live' && r.attempt_id !== null && r.worker_id !== null) {
        await this.#dispatch(tx, { id: messageId, jobId, text, sentBy: actor.userId }, r);
        return { status: 'sent' as const, workerId: r.worker_id, row: r };
      }
      return { status: 'waiting' as const, workerId: null, row: r };
    });
    if (out === null) {
      const { rows } = await this.deps.db.query<{ id: string; status: JobMessageDeliveryStatus }>(
        'SELECT id::text AS id, status FROM job_messages WHERE job_id = $1 AND client_id = $2',
        [jobId, opts.clientId ?? null],
      );
      return { messageId: rows[0]?.id ?? messageId, status: rows[0]?.status ?? 'waiting' };
    }
    if (out.workerId !== null) this.deps.replay().kick(out.workerId);
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'job.message',
      target: `job:${jobId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        messageId,
        source,
        delivery: out.status,
        project: out.row.project,
        workerId: out.row.worker_id,
        attemptId: out.row.attempt_id,
        length: text.length,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
      },
    });
    return { messageId, status: out.status };
  }

  /** Puts one message in the worker's outbox (inside the caller's transaction; kick after commit). */
  async #dispatch(
    tx: Queryable,
    m: { readonly id: string; readonly jobId: string; readonly text: string; readonly sentBy: string },
    r: Row,
  ): Promise<void> {
    if (r.attempt_id === null || r.worker_id === null) throw new Error('no live attempt');
    const receipts = featuresOf(r).includes(JOB_MESSAGE_RECEIPTS_FEATURE);
    const seq = await this.deps.replay().enqueueWithin(
      tx,
      r.worker_id,
      'JOB_MESSAGE',
      {
        attemptId: r.attempt_id,
        epoch: r.epoch,
        messageId: m.id,
        text: m.text,
        sentBy: m.sentBy,
        ...(receipts ? { receipts: true } : {}),
      },
      { jobId: m.jobId },
    );
    await tx.query(
      `UPDATE job_messages SET status = 'sent', code = NULL, detail = NULL, attempt_id = $2, epoch = $3,
              worker_id = $4, outbox_seq = $5, receipts = $6, updated_at = $7
        WHERE id = $1`,
      [m.id, r.attempt_id, r.epoch, r.worker_id, seq, receipts, this.#now()],
    );
  }

  /** The worker acknowledged its outbox through `throughSeq`: sent messages reached the machine. */
  async onAcked(workerId: string, throughSeq: number): Promise<void> {
    await this.deps.db.query(
      `UPDATE job_messages SET status = 'received', updated_at = $3
        WHERE worker_id = $1 AND status = 'sent' AND outbox_seq <= $2`,
      [workerId, throughSeq, this.#now()],
    );
  }

  /** JOB_MESSAGE_STATUS: only for a message this master sent to this worker for this attempt. */
  async onStatus(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'JOB_MESSAGE_STATUS' }>,
  ): Promise<void> {
    const p = message.payload;
    await withTransaction(this.deps.db, async (tx) => {
      const { rows } = await tx.query<{ status: JobMessageDeliveryStatus }>(
        `SELECT status FROM job_messages
          WHERE id = $1 AND job_id::text = $2 AND worker_id = $3 AND attempt_id::text = $4 AND epoch = $5
          FOR UPDATE`,
        [p.messageId, message.jobId, session.workerId, p.attemptId, p.epoch],
      );
      const cur = rows[0];
      if (cur === undefined || !jobMessageAdvances(cur.status, p.status)) return;
      const now = this.#now();
      if (p.status === 'failed' && (p.code === 'attempt_superseded' || p.code === 'job_not_running')) {
        // The machine never handed it to an agent: it waits for the job's next run if there is one.
        const job = this.#check(await this.#row(message.jobId, tx));
        if (job.supported && (cur.status === 'sent' || cur.status === 'received')) {
          await tx.query(
            `UPDATE job_messages SET status = 'waiting', code = NULL, detail = NULL, attempt_id = NULL, epoch = NULL,
                    worker_id = NULL, outbox_seq = NULL, updated_at = $2 WHERE id = $1`,
            [p.messageId, now],
          );
          return;
        }
      }
      await tx.query(
        'UPDATE job_messages SET status = $2, code = $3, detail = $4, updated_at = $5 WHERE id = $1',
        [p.messageId, p.status, p.code ?? null, p.detail ?? null, now],
      );
    });
  }

  /**
   * Orchestrator step: held messages go out once the agent runs (or fail when the job ended first); messages of an
   * attempt that is gone are re-queued (never handed to an agent) or closed (`run_ended` / `job_ended`).
   */
  async tick(): Promise<number> {
    const now = this.#now();
    let changed = 0;
    const { rows: waiting } = await this.deps.db.query<{ id: string; job_id: string }>(
      `SELECT id::text AS id, job_id::text AS job_id FROM job_messages WHERE status = 'waiting'
        ORDER BY created_at LIMIT 200`,
    );
    const kicks = new Set<string>();
    for (const w of waiting) {
      const done = await withTransaction(this.deps.db, async (tx) => {
        const m = await tx.query<{ text: string; sent_by: string }>(
          `SELECT text, sent_by::text AS sent_by FROM job_messages WHERE id = $1 AND status = 'waiting'
            FOR UPDATE SKIP LOCKED`,
          [w.id],
        );
        const row = m.rows[0];
        if (row === undefined) return false;
        const r = await this.#row(w.job_id, tx).catch(() => null);
        const check = r === null ? null : this.#check(r);
        if (r !== null && check?.mode === 'live' && r.worker_id !== null) {
          await this.#dispatch(tx, { id: w.id, jobId: w.job_id, text: row.text, sentBy: row.sent_by }, r);
          kicks.add(r.worker_id);
          return true;
        }
        if (check?.mode === 'queue') return false;
        await tx.query(
          `UPDATE job_messages SET status = 'failed', code = $2, detail = $3, updated_at = $4 WHERE id = $1`,
          [
            w.id,
            check?.reason?.includes('updated') === true
              ? 'worker_update_required'
              : check?.reason?.includes('does not accept') === true
                ? 'unsupported'
                : 'job_ended',
            check?.reason ?? 'The job no longer exists.',
            now,
          ],
        );
        return true;
      });
      if (done) changed += 1;
    }
    for (const k of kicks) this.deps.replay().kick(k);
    // Sent / received messages whose attempt is no longer the job's live one.
    const { rows: orphans } = await this.deps.db.query<{
      id: string;
      job_id: string;
      status: JobMessageDeliveryStatus;
      receipts: boolean;
    }>(
      `SELECT m.id::text AS id, m.job_id::text AS job_id, m.status, m.receipts
         FROM job_messages m JOIN jobs j ON j.id = m.job_id
        WHERE m.status IN ('sent', 'received') AND m.updated_at < $1
          AND (j.current_attempt_id IS DISTINCT FROM m.attempt_id OR j.state NOT IN ('STARTING', 'RUNNING'))
        LIMIT 200`,
      [new Date(now.getTime() - ORPHAN_GRACE_MS)],
    );
    for (const o of orphans) {
      // An older worker never reports beyond `received`: what happened after that is unknown — left as is.
      if (o.status === 'received' && !o.receipts) continue;
      const job = await this.#row(o.job_id).catch(() => null);
      const check = job === null ? null : this.#check(job);
      if (o.status === 'sent' && check?.supported === true) {
        // The machine never got it: it waits for the job's next run.
        await this.deps.db.query(
          `UPDATE job_messages SET status = 'waiting', attempt_id = NULL, epoch = NULL, worker_id = NULL,
                  outbox_seq = NULL, updated_at = $2 WHERE id = $1 AND status = 'sent'`,
          [o.id, now],
        );
      } else {
        await this.deps.db.query(
          `UPDATE job_messages SET status = 'failed', code = $2, detail = $3, updated_at = $4
            WHERE id = $1 AND status IN ('sent', 'received')`,
          [
            o.id,
            o.status === 'sent' ? 'job_ended' : 'run_ended',
            o.status === 'sent'
              ? 'The job ended before the machine received the message.'
              : 'The run ended before the agent took the message.',
            now,
          ],
        );
      }
      changed += 1;
    }
    return changed;
  }
}
