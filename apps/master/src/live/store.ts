import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { decodeCursor, encodeCursor, escapeLike, searchTerms, SqlParams } from '../audit/sql.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { SequencedWorkerMessage } from '../workers/replay.js';
import { LiveBus } from './bus.js';
import { LiveRedactor } from './redact.js';

/**
 * Append-only store of a job's agent events and log chunks for the live view (docs/design/p5-live.md §3).
 * Writes happen inside the worker replay transaction (exactly once per worker seq), after the master's
 * pattern redaction pass; reads serve the SSE stream, the paginated REST routes and search.
 */

export const LOG_STREAMS = ['stdout', 'stderr', 'runtime'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const EVENT_KINDS = [
  'status',
  'message',
  'tool_call',
  'tool_result',
  'approval_request',
  'usage',
  'error',
  'memory',
  'artifact',
  'notice',
  // p14-mcp-core: metadata of one external MCP tool call (never arguments or results).
  'mcp_call',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Kinds that are always stored, even over the per-job event budget (they drive state and decisions). */
const ESSENTIAL: ReadonlySet<EventKind> = new Set(['status', 'approval_request', 'artifact', 'error']);

export interface LiveLimits {
  /** Stored log bytes per job; later chunks are dropped (one notice). Default 64 MiB. */
  readonly maxLogBytesPerJob: number;
  /** Stored events per job (essential kinds exempt). Default 50 000. */
  readonly maxEventsPerJob: number;
}

export const DEFAULT_LIVE_LIMITS: LiveLimits = {
  maxLogBytesPerJob: 64 * 1024 * 1024,
  maxEventsPerJob: 50_000,
};

export interface LogItem {
  readonly type: 'log';
  readonly streamSeq: number;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly epoch: number;
  readonly workerSeq: number;
  readonly stream: LogStream;
  readonly chunkSeq: number;
  readonly ts: Date;
  readonly text: string;
}

export interface ApprovalLink {
  readonly requestId: string;
  readonly status: string;
  readonly stepUp: boolean;
  readonly approverRole: string;
}

export interface EventItem {
  readonly type: 'event';
  readonly streamSeq: number;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly epoch: number;
  readonly workerSeq: number;
  readonly kind: EventKind;
  readonly payload: Record<string, unknown>;
  readonly ts: Date;
  /** For `approval_request`: the master's approval request (null until the effect created it). */
  readonly approval: ApprovalLink | null;
}

export type LiveItem = LogItem | EventItem;

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface LogQuery {
  readonly q?: string;
  readonly stream?: LogStream;
  readonly attemptNo?: number;
  readonly cursor?: string | null;
  readonly limit?: number;
  /** Last `limit` chunks (ascending), ignores `cursor`. */
  readonly tail?: boolean;
}

export interface EventQuery {
  readonly kind?: EventKind;
  readonly cursor?: string | null;
  readonly limit?: number;
  /** Last `limit` events (ascending), ignores `cursor`. */
  readonly tail?: boolean;
}

export const MAX_PAGE = 500;
const DEFAULT_PAGE = 200;
const MAX_TEXT = 131_072;

interface LogRow {
  s_seq: string;
  attempt_id: string;
  attempt_no: number;
  epoch: number;
  w_seq: string;
  stream: LogStream;
  c_seq: string;
  ts: Date;
  text: string;
}

interface EventRow {
  s_seq: string;
  attempt_id: string;
  attempt_no: number;
  epoch: number;
  w_seq: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  ts: Date;
  ar_id: string | null;
  ar_status: string | null;
  ar_step_up: boolean | null;
  ar_role: string | null;
}

// Text aliases differ from the column names: ORDER BY must sort the bigint columns, not the strings.
const LOG_COLUMNS = `stream_seq::text AS s_seq, attempt_id::text AS attempt_id, attempt_no, epoch,
  worker_seq::text AS w_seq, stream, chunk_seq::text AS c_seq, ts, text`;

const EVENT_SELECT = `SELECT e.stream_seq::text AS s_seq, e.attempt_id::text AS attempt_id, e.attempt_no,
    e.epoch, e.worker_seq::text AS w_seq, e.kind, e.payload, e.ts, ar.id::text AS ar_id,
    ar.status AS ar_status, ar.step_up AS ar_step_up, ar.approver_role AS ar_role
  FROM job_events e
  LEFT JOIN approval_requests ar
    ON e.kind = 'approval_request' AND ar.job_id = e.job_id AND ar.attempt_id = e.attempt_id
   AND ar.approval_key = e.payload->>'approvalId'`;

function logItem(r: LogRow, redact: LiveRedactor): LogItem {
  return {
    type: 'log',
    streamSeq: Number(r.s_seq),
    attemptId: r.attempt_id,
    attemptNo: r.attempt_no,
    epoch: r.epoch,
    workerSeq: Number(r.w_seq),
    stream: r.stream,
    chunkSeq: Number(r.c_seq),
    ts: r.ts,
    // Read-time pass again: rows stored before a rule existed are covered too.
    text: redact.text(r.text),
  };
}

function eventItem(r: EventRow, redact: LiveRedactor): EventItem {
  return {
    type: 'event',
    streamSeq: Number(r.s_seq),
    attemptId: r.attempt_id,
    attemptNo: r.attempt_no,
    epoch: r.epoch,
    workerSeq: Number(r.w_seq),
    kind: r.kind,
    payload: redact.deep(r.payload),
    ts: r.ts,
    approval:
      r.ar_id === null
        ? null
        : {
            requestId: r.ar_id,
            status: r.ar_status ?? 'pending',
            stepUp: r.ar_step_up ?? true,
            approverRole: r.ar_role ?? 'admin',
          },
  };
}

const NUM = /^(0|[1-9][0-9]{0,15})$/;

function orderCursor(c: string): { a: number; w: number; c: number } {
  return decodeCursor(c, (v) =>
    typeof v.a === 'string' &&
    typeof v.w === 'string' &&
    typeof v.c === 'string' &&
    NUM.test(v.a) &&
    NUM.test(v.w) &&
    NUM.test(v.c)
      ? { a: Number(v.a), w: Number(v.w), c: Number(v.c) }
      : null,
  );
}

export class LiveStore {
  readonly redactor: LiveRedactor;
  readonly limits: LiveLimits;
  readonly #warned = new Set<string>();

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly redactor?: LiveRedactor;
      readonly limits?: Partial<LiveLimits>;
    },
  ) {
    this.redactor = deps.redactor ?? new LiveRedactor();
    this.limits = { ...DEFAULT_LIVE_LIMITS, ...deps.limits };
  }

  // ------------------------------------------------------------------------------------- writes

  /**
   * Stores an accepted (fenced, `applied`) EVENT / LOG_CHUNK / ARTIFACT_REF inside the inbox transaction.
   * Returns true when a row was added (the caller's transaction then also carries the NOTIFY).
   * Duplicates (same message id, or the same chunk of the same attempt and stream) are no-ops.
   */
  async recordWithin(
    tx: Queryable,
    workerId: string,
    message: SequencedWorkerMessage,
    receivedAt: Date,
  ): Promise<boolean> {
    if (message.type !== 'EVENT' && message.type !== 'LOG_CHUNK' && message.type !== 'ARTIFACT_REF') {
      return false;
    }
    const jobId = message.jobId;
    const p = message.payload;
    const dup = await tx.query(
      message.type === 'LOG_CHUNK'
        ? `SELECT 1 FROM job_log_chunks WHERE (job_id = $1 AND message_id = $2)
             OR (attempt_id = $3 AND stream = $4 AND chunk_seq = $5) LIMIT 1`
        : 'SELECT 1 FROM job_events WHERE job_id = $1 AND message_id = $2',
      message.type === 'LOG_CHUNK'
        ? [jobId, message.messageId, p.attemptId, message.payload.stream, message.payload.chunkSeq]
        : [jobId, message.messageId],
    );
    if ((dup.rowCount ?? 0) > 0) return false;

    // Lock the job's head row (held until commit: stream_seq becomes visible in order).
    const head = await tx.query<{ log_bytes: string; event_count: number; log_limited: boolean }>(
      `INSERT INTO job_live_heads (job_id, head) VALUES ($1, 0)
       ON CONFLICT (job_id) DO UPDATE SET head = job_live_heads.head
       RETURNING log_bytes::text AS log_bytes, event_count, log_limited`,
      [jobId],
    );
    const h = head.rows[0];
    if (h === undefined) return false;
    const attempt = await tx.query<{ number: number }>(
      'SELECT number FROM job_attempts WHERE id = $1 AND job_id = $2',
      [p.attemptId, jobId],
    );
    const attemptNo = attempt.rows[0]?.number ?? 0;
    const base = {
      jobId,
      attemptId: p.attemptId,
      attemptNo,
      epoch: p.epoch,
      workerId,
      workerSeq: message.seq,
      messageId: message.messageId,
      ts: new Date(message.ts),
      receivedAt,
    };

    if (message.type === 'LOG_CHUNK') {
      const lp = message.payload;
      const size = Buffer.byteLength(lp.data, 'utf8');
      if (Number(h.log_bytes) + size > this.limits.maxLogBytesPerJob) {
        if (h.log_limited) return false;
        await tx.query('UPDATE job_live_heads SET log_limited = true WHERE job_id = $1', [jobId]);
        this.#warnOnce(jobId, 'live log budget of the job reached; further chunks are not stored');
        await this.#insertEvent(tx, { ...base, messageId: randomUUID(), workerSeq: 0 }, 'notice', {
          code: 'log_limit_reached',
          message: `Log output beyond ${String(this.limits.maxLogBytesPerJob)} bytes is not stored.`,
        });
        return true;
      }
      const prev = await tx.query<{ id: string; text: string }>(
        `SELECT id::text AS id, text FROM job_log_chunks
          WHERE attempt_id = $1 AND stream = $2 AND chunk_seq = $3`,
        [lp.attemptId, lp.stream, lp.chunkSeq - 1],
      );
      const before = prev.rows[0];
      const red = this.redactor.chunk(lp.data, before?.text ?? null);
      if (before !== undefined && red.previous !== null) {
        await tx.query('UPDATE job_log_chunks SET text = $2, size_bytes = $3 WHERE id = $1', [
          before.id,
          red.previous.slice(0, MAX_TEXT),
          Buffer.byteLength(red.previous, 'utf8'),
        ]);
      }
      const text = red.text.slice(0, MAX_TEXT);
      const seq = await this.#next(tx, jobId, { logBytes: size });
      const ins = await tx.query(
        `INSERT INTO job_log_chunks (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id,
                                     stream, chunk_seq, stream_seq, ts, received_at, text, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT DO NOTHING`,
        [
          jobId,
          base.attemptId,
          attemptNo,
          base.epoch,
          workerId,
          base.workerSeq,
          base.messageId,
          lp.stream,
          lp.chunkSeq,
          seq,
          base.ts,
          receivedAt,
          text,
          Buffer.byteLength(text, 'utf8'),
        ],
      );
      const stored = (ins.rowCount ?? 0) > 0;
      // p14-web-perf-2: the head keeps the chunk count (NULL until a pre-0116 head was counted once).
      if (stored) {
        await tx.query('UPDATE job_live_heads SET log_chunk_count = log_chunk_count + 1 WHERE job_id = $1', [
          jobId,
        ]);
      }
      return stored;
    }

    let kind: EventKind;
    let payload: Record<string, unknown>;
    if (message.type === 'EVENT') {
      const { kind: k, ...rest } = message.payload.event;
      kind = k;
      payload = { kind: k, ...rest };
    } else {
      const ap = message.payload;
      kind = 'artifact';
      payload = {
        kind: 'artifact',
        artifactId: ap.artifactId,
        name: ap.name,
        mediaType: ap.mediaType,
        sizeBytes: ap.sizeBytes,
        sha256: ap.sha256,
      };
    }
    if (h.event_count >= this.limits.maxEventsPerJob && !ESSENTIAL.has(kind)) {
      this.#warnOnce(jobId, 'live event budget of the job reached; further events are not stored');
      return false;
    }
    await this.#insertEvent(tx, base, kind, payload);
    return true;
  }

  async #insertEvent(
    tx: Queryable,
    b: {
      jobId: string;
      attemptId: string;
      attemptNo: number;
      epoch: number;
      workerId: string;
      workerSeq: number;
      messageId: string;
      ts: Date;
      receivedAt: Date;
    },
    kind: EventKind,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const payload = this.redactor.deep(raw);
    const json = JSON.stringify(payload);
    const seq = await this.#next(tx, b.jobId, { events: 1 });
    await tx.query(
      `INSERT INTO job_events (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id,
                               stream_seq, kind, payload, ts, received_at, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING`,
      [
        b.jobId,
        b.attemptId,
        b.attemptNo,
        b.epoch,
        b.workerId,
        b.workerSeq,
        b.messageId,
        seq,
        kind,
        json,
        b.ts,
        b.receivedAt,
        Buffer.byteLength(json, 'utf8'),
      ],
    );
  }

  async #next(tx: Queryable, jobId: string, add: { logBytes?: number; events?: number }): Promise<number> {
    const { rows } = await tx.query<{ head: string }>(
      `UPDATE job_live_heads SET head = head + 1, log_bytes = log_bytes + $2, event_count = event_count + $3
        WHERE job_id = $1 RETURNING head::text AS head`,
      [jobId, add.logBytes ?? 0, add.events ?? 0],
    );
    return Number(rows[0]?.head ?? 0);
  }

  #warnOnce(jobId: string, msg: string): void {
    if (this.#warned.has(jobId)) return;
    if (this.#warned.size > 10_000) this.#warned.clear();
    this.#warned.add(jobId);
    this.deps.log.warn({ jobId }, msg);
  }

  // ------------------------------------------------------------------------------------- reads

  async head(jobId: string, db: Queryable = this.deps.pool): Promise<number> {
    const { rows } = await db.query<{ head: string }>(
      'SELECT head::text AS head FROM job_live_heads WHERE job_id = $1',
      [jobId],
    );
    return Number(rows[0]?.head ?? 0);
  }

  /** Items with `stream_seq > after`, merged in stream order, at most `limit`. */
  async since(jobId: string, after: number, limit: number): Promise<LiveItem[]> {
    const [logs, events] = await Promise.all([
      this.deps.pool.query<LogRow>(
        `SELECT ${LOG_COLUMNS} FROM job_log_chunks WHERE job_id = $1 AND stream_seq > $2
          ORDER BY stream_seq LIMIT $3`,
        [jobId, after, limit],
      ),
      this.deps.pool.query<EventRow>(
        `${EVENT_SELECT} WHERE e.job_id = $1 AND e.stream_seq > $2 ORDER BY e.stream_seq LIMIT $3`,
        [jobId, after, limit],
      ),
    ]);
    const items: LiveItem[] = [
      ...logs.rows.map((r) => logItem(r, this.redactor)),
      ...events.rows.map((r) => eventItem(r, this.redactor)),
    ];
    items.sort((a, b) => a.streamSeq - b.streamSeq);
    return items.slice(0, limit);
  }

  /** Log chunks in canonical order `(attempt_no, worker_seq, chunk_seq)`, optionally searched. */
  async logs(jobId: string, query: LogQuery): Promise<Page<LogItem>> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const p = new SqlParams();
    const where = [`job_id = ${p.add(jobId)}`];
    if (query.stream !== undefined) where.push(`stream = ${p.add(query.stream)}`);
    if (query.attemptNo !== undefined) where.push(`attempt_no = ${p.add(query.attemptNo)}`);
    for (const term of searchTerms(query.q ?? '')) {
      where.push(`text ILIKE ${p.add(`%${escapeLike(term)}%`)} ESCAPE '\\'`);
    }
    const tail = query.tail === true;
    if (!tail && query.cursor) {
      const c = orderCursor(query.cursor);
      where.push(`(attempt_no, worker_seq, chunk_seq) > (${p.add(c.a)}, ${p.add(c.w)}, ${p.add(c.c)})`);
    }
    const order = tail ? 'DESC' : 'ASC';
    const sql = `SELECT ${LOG_COLUMNS} FROM job_log_chunks WHERE ${where.join(' AND ')}
      ORDER BY attempt_no ${order}, worker_seq ${order}, chunk_seq ${order} LIMIT ${p.add(limit + 1)}`;
    const rows = await this.#bounded<LogRow>(sql, p.values);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (tail) page.reverse();
    const items = page.map((r) => logItem(r, this.redactor));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        !tail && more && last !== undefined
          ? encodeCursor({
              a: String(last.attemptNo),
              w: String(last.workerSeq),
              c: String(last.chunkSeq),
            })
          : null,
    };
  }

  /** Events in canonical order `(attempt_no, worker_seq)`, with approval requests joined. */
  async events(jobId: string, query: EventQuery): Promise<Page<EventItem>> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const p = new SqlParams();
    const where = [`e.job_id = ${p.add(jobId)}`];
    if (query.kind !== undefined) where.push(`e.kind = ${p.add(query.kind)}`);
    const tail = query.tail === true;
    if (!tail && query.cursor) {
      const c = orderCursor(query.cursor);
      where.push(
        `(e.attempt_no, e.worker_seq, e.stream_seq) > (${p.add(c.a)}, ${p.add(c.w)}, ${p.add(c.c)})`,
      );
    }
    const order = tail ? 'DESC' : 'ASC';
    const sql = `${EVENT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY e.attempt_no ${order}, e.worker_seq ${order}, e.stream_seq ${order} LIMIT ${p.add(limit + 1)}`;
    const rows = await this.#bounded<EventRow>(sql, p.values);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (tail) page.reverse();
    const items = page.map((r) => eventItem(r, this.redactor));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        !tail && more && last !== undefined
          ? encodeCursor({
              a: String(last.attemptNo),
              w: String(last.workerSeq),
              c: String(last.streamSeq),
            })
          : null,
    };
  }

  /** A read with a 5 s statement timeout (search must not tie up the database). */
  async #bounded<R extends object>(sql: string, values: unknown[]): Promise<R[]> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '5s'`);
      const { rows } = await client.query<R>(sql, values);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async summary(jobId: string): Promise<{
    head: number;
    logChunks: number;
    logBytes: number;
    events: number;
    logLimited: boolean;
    artifacts: EventItem[];
    terminal: { supported: boolean; status: string | null };
  }> {
    const db = this.deps.pool;
    // p14-web-perf-2: the chunk count comes from the head row (was a count(*) over the job's chunks per call).
    const [heads, artifacts, terminal] = await Promise.all([
      db.query<{
        head: string;
        log_bytes: string;
        event_count: number;
        log_limited: boolean;
        log_chunks: string | null;
      }>(
        `SELECT head::text AS head, log_bytes::text AS log_bytes, event_count, log_limited,
                log_chunk_count::text AS log_chunks
           FROM job_live_heads WHERE job_id = $1`,
        [jobId],
      ),
      db.query<EventRow>(
        `${EVENT_SELECT} WHERE e.job_id = $1 AND e.kind = 'artifact' ORDER BY e.stream_seq LIMIT 100`,
        [jobId],
      ),
      // "Terminal" view: the runtime's `streaming` capability on the worker of the latest attempt.
      db.query<{ status: string | null }>(
        `SELECT r.capabilities->'streaming'->>'status' AS status
           FROM jobs j
           JOIN job_attempts a ON a.job_id = j.id
           LEFT JOIN job_runs jr ON jr.attempt_id = a.id
           JOIN worker_runtimes r ON r.worker_id = a.worker_id
                AND r.runtime = COALESCE(jr.runtime_choice->>'runtime', j.spec->>'runtime') AND r.present
          WHERE j.id = $1
          ORDER BY a.number DESC, r.last_reported_at DESC LIMIT 1`,
        [jobId],
      ),
    ]);
    const h = heads.rows[0];
    const status = terminal.rows[0]?.status ?? null;
    const logChunks =
      h === undefined ? 0 : h.log_chunks === null ? await this.#countChunks(jobId) : Number(h.log_chunks);
    return {
      head: Number(h?.head ?? 0),
      logChunks,
      logBytes: Number(h?.log_bytes ?? 0),
      events: h?.event_count ?? 0,
      logLimited: h?.log_limited ?? false,
      artifacts: artifacts.rows.map((r) => eventItem(r, this.redactor)),
      terminal: { supported: status === 'supported' || status === 'degraded', status },
    };
  }

  /**
   * A head from before migration 0116 has no chunk count yet: count once under the head row lock (a chunk insert
   * holds the same lock, so none is missed or counted twice) and store it.
   */
  async #countChunks(jobId: string): Promise<number> {
    return withTransaction(this.deps.pool, async (tx) => {
      const locked = await tx.query<{ n: string | null }>(
        'SELECT log_chunk_count::text AS n FROM job_live_heads WHERE job_id = $1 FOR UPDATE',
        [jobId],
      );
      const known = locked.rows[0]?.n;
      if (known !== null && known !== undefined) return Number(known);
      const { rows } = await tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM job_log_chunks WHERE job_id = $1',
        [jobId],
      );
      const n = Number(rows[0]?.n ?? 0);
      await tx.query(
        'UPDATE job_live_heads SET log_chunk_count = $2 WHERE job_id = $1 AND log_chunk_count IS NULL',
        [jobId, n],
      );
      return n;
    });
  }

  /** Current state and version of a job (the stream reports changes). */
  async jobState(jobId: string): Promise<{ state: string; version: number } | null> {
    const { rows } = await this.deps.pool.query<{ state: string; version: number }>(
      'SELECT state, version FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------------------------------- retention

  /**
   * Retention hook: deletes live rows of jobs that ended (SUCCEEDED/FAILED/CANCELLED) and did not change
   * for `retentionDays`, in bounded batches. Returns the number of rows removed.
   */
  async purge(now: Date, opts: { readonly retentionDays: number; readonly batch?: number }): Promise<number> {
    const cutoff = new Date(now.getTime() - opts.retentionDays * 86_400_000);
    const batch = opts.batch ?? 5_000;
    const { rows: jobs } = await this.deps.pool.query<{ id: string }>(
      `SELECT h.job_id::text AS id FROM job_live_heads h JOIN jobs j ON j.id = h.job_id
        WHERE j.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND j.state_changed_at < $1
          AND (h.purged_at IS NULL OR h.purged_at < j.state_changed_at)
        LIMIT 100`,
      [cutoff],
    );
    let removed = 0;
    for (const { id } of jobs) {
      for (const table of ['job_log_chunks', 'job_events'] as const) {
        // p6-outputs: run artifacts pinned on the Outputs screen keep their `artifact` event row.
        const keep =
          table === 'job_events'
            ? ` AND NOT (kind = 'artifact' AND EXISTS (SELECT 1 FROM output_items o WHERE o.pinned AND o.kind = 'run'
                 AND o.job_id = ${table}.job_id AND o.artifact_id = ${table}.payload->>'artifactId'))`
            : '';
        for (;;) {
          const r = await this.deps.pool.query(
            `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE job_id = $1${keep} LIMIT $2)`,
            [id, batch],
          );
          removed += r.rowCount ?? 0;
          if ((r.rowCount ?? 0) < batch) break;
        }
      }
      // Keep the head (stream sequences are never reused); reset the budgets.
      await this.deps.pool.query(
        `UPDATE job_live_heads SET log_bytes = 0, event_count = 0, log_limited = false, log_chunk_count = 0,
                purged_at = $2
          WHERE job_id = $1`,
        [id, now],
      );
    }
    return removed;
  }

  /** NOTIFY inside the caller's transaction (delivered on commit). */
  notifyWithin(tx: Queryable, jobId: string): Promise<void> {
    return LiveBus.notifyWithin(tx, jobId);
  }
}
