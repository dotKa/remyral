import { isSequencedMasterType, type MasterToWorker, type WorkerToMaster } from '@remyral/protocol';
import { activeTraceparent } from '@remyral/observability/telemetry';
import type { FastifyBaseLogger } from 'fastify';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { CloseCode } from './connection.js';
import type { WorkerHub } from './hub.js';
import type { MasterPayload, WorkerSession } from './types.js';
import { pgSafe } from './pg-safe.js';

/** Worker → master sequenced message types (protocol SEQUENCED_WORKER_TYPES). */
export type SequencedWorkerMessage = Extract<
  WorkerToMaster,
  { type: 'LEASE_ACK' | 'EVENT' | 'LOG_CHUNK' | 'JOB_RESULT' | 'ARTIFACT_REF' | 'ARTIFACT_CHUNK' }
>;
export type SequencedMasterType = Extract<
  MasterToWorker['type'],
  | 'ASSIGN_JOB'
  | 'RENEW_LEASE'
  | 'CANCEL_JOB'
  | 'APPROVAL_DECISION'
  | 'UPDATE_POLICY'
  | 'JOB_MESSAGE'
  | 'SET_APPROVAL_POLICY'
  | 'SET_TIME_LIMIT'
  | 'PAUSE_JOB'
>;

/**
 * Applies one sequenced worker message, inside the transaction that also
 * advances the worker's cursor — so every seq takes effect exactly once.
 * p4 replaces the default journal with job-store routing (fencing by epoch).
 */
export interface InboxSink {
  /**
   * May return a callback that runs once the transaction committed (p4: replies to the worker, effects in
   * other services). It is not part of the exactly-once guarantee; it must be idempotent and must not throw.
   */
  handle(
    tx: Queryable,
    workerId: string,
    message: SequencedWorkerMessage,
    receivedAt: Date,
  ): Promise<AfterCommit | undefined>;
}

export type AfterCommit = (session: WorkerSession) => Promise<void>;

/** Default sink: append to `worker_inbox` (unique per worker+seq and worker+messageId). */
export const journalSink: InboxSink = {
  async handle(tx, workerId, message, receivedAt) {
    await tx.query(
      `INSERT INTO worker_inbox (worker_id, seq, message_id, type, job_id, payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        workerId,
        message.seq,
        message.messageId,
        message.type,
        message.jobId,
        JSON.stringify(message.payload),
        receivedAt,
      ],
    );
    return undefined;
  },
};

export class MasterOutboxFullError extends Error {
  constructor(workerId: string) {
    super(`outbox for worker ${workerId} is full`);
    this.name = 'MasterOutboxFullError';
  }
}

export interface ReplayLimits {
  /** Processed messageIds remembered per worker (ADR-0004 §4 bounded window). */
  dedupeWindow: number;
  /** Out-of-order messages held per session while waiting for the gap to fill. */
  maxReorder: number;
  /** Unacknowledged master → worker messages per worker. */
  maxOutbox: number;
  /** ACKs are coalesced over this delay. */
  ackDelayMs: number;
}

export const DEFAULT_REPLAY_LIMITS: ReplayLimits = {
  dedupeWindow: 1024,
  maxReorder: 256,
  maxOutbox: 10_000,
  ackDelayMs: 50,
};

interface SessionState {
  /** Highest worker seq processed (mirrors workers.last_worker_seq after commit). */
  last: number;
  buffer: Map<number, SequencedWorkerMessage>;
  ackTimer: NodeJS.Timeout | null;
  /** Highest master seq handed to this session's socket. */
  lastSent: number;
  pump: Promise<void>;
  closed: boolean;
}

/**
 * Resume cursors and replay in both directions (p2-replay, ADR-0004 §4, ADR-0011).
 *
 * Worker → master: each sequenced message is processed once, in seq order, in one
 * transaction with the cursor (`workers.last_worker_seq`) and a bounded window of
 * processed messageIds. Duplicates (by messageId, or seq ≤ cursor) are acknowledged
 * without effect; a messageId reused with another seq is a protocol violation;
 * messages ahead of a gap wait in a bounded reorder buffer.
 *
 * Master → worker: `enqueue` assigns the next seq durably (`worker_outbox`); a
 * per-session pump sends rows after the worker's resume cursor strictly in order;
 * the worker's ACK (and HELLO.resumeFromSeq) trims the outbox.
 */
export class WorkerReplay {
  readonly #sessions = new Map<string, SessionState>();
  readonly #limits: ReplayLimits;

  constructor(
    private readonly deps: {
      pool: Pool;
      hub: WorkerHub;
      clock: () => Date;
      log: FastifyBaseLogger;
      sink?: InboxSink;
      limits?: Partial<ReplayLimits>;
      /**
       * p15-message-delivery: the worker acknowledged master seqs ≤ `throughSeq` (after the outbox trim). Must not
       * throw; failures are logged.
       */
      onAcked?: (workerId: string, throughSeq: number) => Promise<void>;
    },
  ) {
    this.#limits = { ...DEFAULT_REPLAY_LIMITS, ...deps.limits };
  }

  /** Highest worker seq processed: the resume cursor for SESSION_ESTABLISHED. */
  async resumeCursor(workerId: string): Promise<number> {
    const { rows } = await this.deps.pool.query<{ last: string }>(
      'SELECT last_worker_seq::text AS last FROM workers WHERE id = $1',
      [workerId],
    );
    return Number(rows[0]?.last ?? 0);
  }

  async onSessionStart(session: WorkerSession): Promise<void> {
    await this.#catchUpNumbering(session);
    const last = await this.resumeCursor(session.workerId);
    const state: SessionState = {
      last,
      buffer: new Map(),
      ackTimer: null,
      lastSent: session.workerResumeFromSeq,
      pump: Promise.resolve(),
      closed: false,
    };
    this.#sessions.set(session.connectionId, state);
    // HELLO.resumeFromSeq is an implicit ACK of everything the worker already processed.
    await this.#trim(session.workerId, session.workerResumeFromSeq);
    this.#pump(session, state);
    await state.pump;
  }

  /**
   * p11-master-resilience (ADR-0039): the worker already processed master seqs this database never issued — Postgres
   * was restored from a backup (standby restore) and lost the newest part of `worker_outbox`. Without this the worker
   * would ignore every new message as a duplicate (and its ACK would look like a protocol violation). The pending rows
   * are renumbered to follow the worker's cursor (delivered again: at-least-once, fenced by epoch on the worker) and
   * numbering continues after them.
   */
  async #catchUpNumbering(session: WorkerSession): Promise<void> {
    const seen = session.workerResumeFromSeq;
    const shifted = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ next: string }>(
        'SELECT next_master_seq::text AS next FROM workers WHERE id = $1 FOR UPDATE',
        [session.workerId],
      );
      const next = Number(rows[0]?.next ?? 1);
      if (rows[0] === undefined || seen < next) return null;
      const pending = await tx.query<{ first: string | null; n: string }>(
        'SELECT min(seq)::text AS first, count(*)::text AS n FROM worker_outbox WHERE worker_id = $1',
        [session.workerId],
      );
      const first = Number(pending.rows[0]?.first ?? next);
      const count = Number(pending.rows[0]?.n ?? 0);
      // Every pending seq is < next ≤ seen < seen + 1: the shifted range never collides with the old one.
      const offset = seen + 1 - first;
      if (count > 0) {
        await tx.query('UPDATE worker_outbox SET seq = seq + $2 WHERE worker_id = $1', [
          session.workerId,
          offset,
        ]);
      }
      await tx.query('UPDATE workers SET next_master_seq = $2, acked_master_seq = $3 WHERE id = $1', [
        session.workerId,
        seen + 1 + count,
        seen,
      ]);
      return { next, count };
    });
    if (shifted !== null) {
      this.deps.log.warn(
        {
          workerId: session.workerId,
          workerCursor: seen,
          masterNext: shifted.next,
          renumbered: shifted.count,
        },
        'worker is ahead of the master outbox (database restored from a backup?); numbering caught up',
      );
    }
  }

  onSessionEnd(session: WorkerSession): void {
    const state = this.#sessions.get(session.connectionId);
    if (state === undefined) return;
    state.closed = true;
    if (state.ackTimer !== null) clearTimeout(state.ackTimer);
    this.#sessions.delete(session.connectionId);
  }

  // ------------------------------------------------------------- worker → master

  async onSequenced(session: WorkerSession, message: SequencedWorkerMessage): Promise<void> {
    const state = this.#sessions.get(session.connectionId);
    if (state === undefined) {
      // Cannot happen (session start runs before any message); never drop silently — force a resume.
      session.close(CloseCode.overloaded, 'session not ready; reconnect and resume');
      return;
    }
    if (message.seq < 1) {
      this.#violation(session, `${message.type} must carry seq >= 1`);
      return;
    }
    const outcome = await this.#apply(session, state, message);
    if (outcome === 'violation') return;
    if (outcome === 'gap') {
      if (!state.buffer.has(message.seq)) state.buffer.set(message.seq, message);
      if (state.buffer.size > this.#limits.maxReorder) {
        this.deps.log.warn(
          { workerId: session.workerId, held: state.buffer.size },
          'reorder buffer overflow',
        );
        session.close(CloseCode.overloaded, 'reorder buffer full; reconnect and resume');
      }
      return;
    }
    // Drain messages that were waiting for this one.
    for (
      let next = state.buffer.get(state.last + 1);
      next !== undefined;
      next = state.buffer.get(state.last + 1)
    ) {
      state.buffer.delete(next.seq);
      if ((await this.#apply(session, state, next)) === 'violation') return;
    }
    for (const seq of state.buffer.keys()) if (seq <= state.last) state.buffer.delete(seq);
    this.#scheduleAck(session, state);
  }

  async #apply(
    session: WorkerSession,
    state: SessionState,
    raw: SequencedWorkerMessage,
  ): Promise<'processed' | 'duplicate' | 'gap' | 'violation'> {
    // NUL bytes / lone surrogates would fail the transaction and loop the connection forever.
    const message = pgSafe(raw);
    const now = this.deps.clock();
    const out: { after?: AfterCommit | undefined } = {};
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const cur = await tx.query<{ last: string }>(
        'SELECT last_worker_seq::text AS last FROM workers WHERE id = $1 FOR UPDATE',
        [session.workerId],
      );
      const last = Number(cur.rows[0]?.last ?? 0);
      const seen = await tx.query<{ seq: string }>(
        'SELECT seq::text AS seq FROM worker_processed_messages WHERE worker_id = $1 AND message_id = $2',
        [session.workerId, message.messageId],
      );
      const seenRow = seen.rows[0];
      if (seenRow !== undefined) {
        return {
          kind: Number(seenRow.seq) === message.seq ? ('duplicate' as const) : ('violation' as const),
          last,
        };
      }
      if (message.seq <= last) return { kind: 'duplicate' as const, last };
      if (message.seq > last + 1) return { kind: 'gap' as const, last };
      out.after = await (this.deps.sink ?? journalSink).handle(tx, session.workerId, message, now);
      await tx.query(
        `INSERT INTO worker_processed_messages (worker_id, message_id, seq, processed_at) VALUES ($1, $2, $3, $4)`,
        [session.workerId, message.messageId, message.seq, now],
      );
      await tx.query('UPDATE workers SET last_worker_seq = $2 WHERE id = $1', [
        session.workerId,
        message.seq,
      ]);
      await tx.query('DELETE FROM worker_processed_messages WHERE worker_id = $1 AND seq <= $2', [
        session.workerId,
        message.seq - this.#limits.dedupeWindow,
      ]);
      return { kind: 'processed' as const, last: message.seq };
    });
    state.last = Math.max(state.last, result.last);
    if (result.kind === 'violation') {
      this.#violation(session, `messageId ${message.messageId} reused with a different seq`);
      return 'violation';
    }
    if (result.kind === 'processed') {
      const run = out.after;
      if (run !== undefined) {
        await run(session).catch((err: unknown) => {
          this.deps.log.warn({ err, workerId: session.workerId }, 'post-commit step failed');
        });
      }
      // Messages the sink queued for this worker inside the transaction (enqueueWithin).
      this.#pump(session, state);
    }
    if (result.kind === 'duplicate') {
      this.deps.log.debug(
        { workerId: session.workerId, seq: message.seq },
        'duplicate worker message acknowledged',
      );
      this.#scheduleAck(session, state);
    }
    return result.kind;
  }

  #scheduleAck(session: WorkerSession, state: SessionState): void {
    if (state.ackTimer !== null || state.closed) return;
    state.ackTimer = setTimeout(() => {
      state.ackTimer = null;
      if (state.closed) return;
      session.send('ACK', { throughSeq: state.last }).catch(() => undefined);
    }, this.#limits.ackDelayMs);
  }

  #violation(session: WorkerSession, reason: string): void {
    this.deps.log.warn({ workerId: session.workerId, reason }, 'worker replay protocol violation');
    session.close(CloseCode.protocolViolation, reason);
  }

  // ------------------------------------------------------------- master → worker

  /** Worker acknowledged master seqs ≤ `throughSeq`. */
  async onAck(session: WorkerSession, throughSeq: number): Promise<void> {
    const { rows } = await this.deps.pool.query<{ next: string }>(
      'SELECT next_master_seq::text AS next FROM workers WHERE id = $1',
      [session.workerId],
    );
    if (throughSeq >= Number(rows[0]?.next ?? 1)) {
      this.#violation(session, `ACK for master seq ${String(throughSeq)} that was never sent`);
      return;
    }
    await this.#trim(session.workerId, throughSeq);
  }

  async #trim(workerId: string, throughSeq: number): Promise<void> {
    if (throughSeq < 1) return;
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE workers SET acked_master_seq = GREATEST(acked_master_seq, $2)
          WHERE id = $1 AND $2 < next_master_seq`,
        [workerId, throughSeq],
      );
      await tx.query('DELETE FROM worker_outbox WHERE worker_id = $1 AND seq <= $2', [workerId, throughSeq]);
    });
    await this.deps.onAcked?.(workerId, throughSeq).catch((err: unknown) => {
      this.deps.log.warn({ err, workerId }, 'acknowledgement hook failed');
    });
  }

  /**
   * Durably queue a sequenced master → worker message and deliver it if the worker
   * is connected (otherwise on its next session). Returns the assigned seq.
   */
  async enqueue<T extends SequencedMasterType>(
    workerId: string,
    type: T,
    payload: MasterPayload<T>,
    options: { jobId?: string; traceparent?: string } = {},
  ): Promise<number> {
    const seq = await withTransaction(this.deps.pool, (tx) =>
      this.enqueueWithin(tx, workerId, type, payload, options),
    );
    this.kick(workerId);
    return seq;
  }

  /**
   * Same as {@link enqueue}, inside the caller's transaction (the message exists iff the caller commits).
   * Call {@link kick} after the commit to deliver it to a live session.
   */
  async enqueueWithin<T extends SequencedMasterType>(
    tx: Queryable,
    workerId: string,
    type: T,
    payload: MasterPayload<T>,
    options: { jobId?: string; traceparent?: string } = {},
  ): Promise<number> {
    if (!isSequencedMasterType(type)) throw new TypeError(`${type} is not a sequenced message type`);
    const r = await tx.query<{ seq: string; pending: string }>(
      `UPDATE workers SET next_master_seq = next_master_seq + 1 WHERE id = $1
       RETURNING (next_master_seq - 1)::text AS seq, (next_master_seq - 1 - acked_master_seq)::text AS pending`,
      [workerId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`unknown worker ${workerId}`);
    if (Number(row.pending) > this.#limits.maxOutbox) throw new MasterOutboxFullError(workerId);
    // p16-observability: the trace of the span that queued the message travels with it (also when replayed).
    const traceparent = options.traceparent ?? activeTraceparent() ?? null;
    await tx.query(
      `INSERT INTO worker_outbox (worker_id, seq, type, job_id, payload, created_at, traceparent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        workerId,
        row.seq,
        type,
        options.jobId ?? null,
        JSON.stringify(payload),
        this.deps.clock(),
        traceparent,
      ],
    );
    return Number(row.seq);
  }

  /** Deliver queued outbox rows to the worker's live session, if any. */
  kick(workerId: string): void {
    const session = this.deps.hub.get(workerId)?.session;
    if (!session) return;
    const state = this.#sessions.get(session.connectionId);
    if (state !== undefined) this.#pump(session, state);
  }

  /** Send outbox rows after `state.lastSent`, strictly in seq order, one pump at a time per session. */
  #pump(session: WorkerSession, state: SessionState): void {
    state.pump = state.pump
      .then(async () => {
        for (;;) {
          if (state.closed) return;
          const { rows } = await this.deps.pool.query<{
            seq: string;
            type: SequencedMasterType;
            job_id: string | null;
            payload: Record<string, unknown>;
            traceparent: string | null;
          }>(
            `SELECT seq::text AS seq, type, job_id, payload, traceparent FROM worker_outbox
              WHERE worker_id = $1 AND seq > $2 ORDER BY worker_outbox.seq LIMIT 100`,
            [session.workerId, state.lastSent],
          );
          for (const row of rows) {
            if (isClosed(state)) return; // the socket may have closed while sending
            await session.send(row.type, row.payload as never, {
              seq: Number(row.seq),
              ...(row.job_id === null ? {} : { jobId: row.job_id }),
              ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
            });
            state.lastSent = Number(row.seq);
          }
          if (rows.length < 100) return;
        }
      })
      .catch((err: unknown) => {
        this.deps.log.warn(
          { err, workerId: session.workerId },
          'master outbox pump stopped; resumes on reconnect',
        );
      });
  }

  /** Waits for the session's pump (tests). */
  async settled(connectionId: string): Promise<void> {
    await this.#sessions.get(connectionId)?.pump;
  }
}

/** Read through a function so the check is not narrowed away across awaits. */
function isClosed(state: { closed: boolean }): boolean {
  return state.closed;
}
