import { Redactor, redactDeep } from '@remyral/observability';
import { type Pool, withTransaction } from '../db/pool.js';

/**
 * p16-observability (docs/design/p16-observability.md §3): the console's log search over the master's own recent log
 * lines.
 *
 * - **Capture** ({@link LogSink}): `redactingLogStream` hands every line — already redacted (pino paths + the shared
 *   pattern redactor) — to the sink, synchronously and without I/O. The sink keeps lines at or above `minLevel`, drops
 *   the request lifecycle pair (`incoming request` / `request completed`) of healthy fast requests unless
 *   `requests: 'all'` (a 2xx in < 1 s is noise; its reqId lines of the handler stay), rate-limits (token bucket) and
 *   queues at most `maxQueue` lines (overflow is counted, never blocks logging).
 * - **Store** ({@link LogStore}): batches of up to 500 lines a second go into the UNLOGGED table `master_log_lines`
 *   (migration 0142); lines older than `retentionDays` and rows above `maxRows` are deleted every ten minutes in
 *   bounded batches.
 * - **Search**: bounded (time window ≤ retention, ≤ 500 rows, 5 s statement timeout) with filters level, component,
 *   reqId, jobId, workerId, traceId and text (case-insensitive substring of the message and the fields); every string
 *   of the answer passes the Redactor again.
 */

export const LOG_LEVEL_NUMBERS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LogLevelName = keyof typeof LOG_LEVEL_NUMBERS;

export interface LogStoreConfig {
  /** 0 = the store is off (nothing captured). */
  readonly retentionDays: number;
  readonly minLevel: LogLevelName;
  readonly requests: 'problems' | 'all';
  readonly maxRows: number;
  /** Sustained lines per second taken (burst: 10×). */
  readonly ratePerSec?: number;
  readonly maxQueue?: number;
}

export const DEFAULT_LOG_STORE: LogStoreConfig = {
  retentionDays: 7,
  minLevel: 'info',
  requests: 'problems',
  maxRows: 2_000_000,
};

export interface LogLine {
  readonly at: Date;
  readonly level: number;
  readonly component: string | null;
  readonly reqId: string | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly traceId: string | null;
  readonly msg: string;
  readonly fields: Record<string, unknown> | null;
}

const ID = /^[A-Za-z0-9_.:@-]{1,64}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const MAX_MSG = 2048;
const MAX_FIELDS_JSON = 8192;
const SLOW_REQUEST_MS = 1000;
/** Envelope keys that become columns (or are not worth keeping). */
const DROPPED = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'v', 'trace_id', 'span_id']);
const COLUMNS = new Set(['component', 'reqId', 'jobId', 'workerId']);

const idOf = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);

/** Normalises one redacted pino object into a stored line (null: not a log object). */
export function toLogLine(o: Record<string, unknown>, now: () => Date = () => new Date()): LogLine | null {
  const level = typeof o.level === 'number' && Number.isFinite(o.level) ? Math.round(o.level) : null;
  if (level === null) return null;
  const at = typeof o.time === 'number' && Number.isFinite(o.time) ? new Date(o.time) : now();
  const rawMsg = typeof o.msg === 'string' ? o.msg : typeof o.message === 'string' ? o.message : '';
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (DROPPED.has(k) || COLUMNS.has(k) || k === 'message') continue;
    rest[k] = v;
  }
  let fields: Record<string, unknown> | null = Object.keys(rest).length === 0 ? null : rest;
  if (fields !== null) {
    const json = JSON.stringify(fields);
    if (json.length > MAX_FIELDS_JSON)
      fields = { truncated: true, bytes: json.length, keys: Object.keys(rest).slice(0, 40) };
  }
  return {
    at: Number.isNaN(at.getTime()) ? now() : at,
    level: Math.max(0, Math.min(100, level)),
    component: idOf(o.component),
    reqId: idOf(o.reqId),
    jobId: idOf(o.jobId),
    workerId: idOf(o.workerId),
    traceId: typeof o.trace_id === 'string' && TRACE_ID.test(o.trace_id) ? o.trace_id : null,
    msg: rawMsg.slice(0, MAX_MSG),
    fields,
  };
}

/** The in-process capture queue (synchronous, bounded; never throws into the logger). */
export class LogSink {
  #min: number;
  #all: boolean;
  readonly #rate: number;
  readonly #burst: number;
  readonly #maxQueue: number;
  #enabled: boolean;
  readonly #now: () => number;
  readonly #queue: LogLine[] = [];
  /** `incoming request` lines waiting for their `request completed` (problems mode). */
  readonly #held = new Map<string, LogLine>();
  #tokens: number;
  #refilledAt: number;
  #captured = 0;
  #dropped = 0;
  #filtered = 0;

  constructor(cfg: LogStoreConfig, now: () => number = Date.now) {
    this.#enabled = cfg.retentionDays > 0;
    this.#min = LOG_LEVEL_NUMBERS[cfg.minLevel];
    this.#all = cfg.requests === 'all';
    this.#rate = Math.max(1, cfg.ratePerSec ?? 200);
    this.#burst = this.#rate * 10;
    this.#maxQueue = Math.max(100, cfg.maxQueue ?? 10_000);
    this.#now = now;
    this.#tokens = this.#burst;
    this.#refilledAt = now();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** p17-panel-settings: retention 0 / > 0 (off / on), the level and the request lines, changed at run time. */
  configure(cfg: Pick<LogStoreConfig, 'retentionDays' | 'minLevel' | 'requests'>): void {
    this.#enabled = cfg.retentionDays > 0;
    this.#min = LOG_LEVEL_NUMBERS[cfg.minLevel];
    this.#all = cfg.requests === 'all';
    if (!this.#enabled) this.#queue.length = 0;
  }

  /** One redacted log object (from `redactingLogStream`). */
  push(o: Record<string, unknown>): void {
    if (!this.#enabled) return;
    try {
      const line = toLogLine(o, () => new Date(this.#now()));
      if (line === null || line.level < this.#min) {
        this.#filtered++;
        return;
      }
      if (!this.#all && line.reqId !== null && line.level < LOG_LEVEL_NUMBERS.warn) {
        if (line.msg === 'incoming request') {
          if (this.#held.size >= 1000) {
            const oldest = this.#held.keys().next().value;
            if (oldest !== undefined) this.#held.delete(oldest);
          }
          this.#held.set(line.reqId, line);
          return;
        }
        if (line.msg === 'request completed') {
          const incoming = this.#held.get(line.reqId) ?? null;
          this.#held.delete(line.reqId);
          if (!problemRequest(o)) {
            this.#filtered += incoming === null ? 1 : 2;
            return;
          }
          if (incoming !== null) this.#take(incoming);
        }
      }
      this.#take(line);
    } catch {
      this.#dropped++;
    }
  }

  #take(line: LogLine): void {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#refilledAt) / 1000) * this.#rate);
    this.#refilledAt = now;
    if (this.#tokens < 1 || this.#queue.length >= this.#maxQueue) {
      this.#dropped++;
      return;
    }
    this.#tokens -= 1;
    this.#queue.push(line);
    this.#captured++;
  }

  /** Takes up to `max` queued lines (oldest first). */
  drain(max: number): LogLine[] {
    return this.#queue.splice(0, Math.max(0, max));
  }

  /** Puts lines back in front (a failed insert), as far as the queue has room. */
  requeue(lines: readonly LogLine[]): void {
    const room = Math.max(0, this.#maxQueue - this.#queue.length);
    this.#queue.unshift(...lines.slice(0, room));
    this.#dropped += Math.max(0, lines.length - room);
  }

  stats(): { queued: number; captured: number; dropped: number; filtered: number } {
    return {
      queued: this.#queue.length,
      captured: this.#captured,
      dropped: this.#dropped,
      filtered: this.#filtered,
    };
  }
}

function problemRequest(o: Record<string, unknown>): boolean {
  const res = o.res as { statusCode?: unknown } | undefined;
  const status = typeof res?.statusCode === 'number' ? res.statusCode : 0;
  const ms = typeof o.responseTime === 'number' ? o.responseTime : 0;
  return status >= 400 || status === 0 || ms >= SLOW_REQUEST_MS;
}

export interface LogSearch {
  /** Minimum level (name). */
  readonly level?: LogLevelName;
  readonly component?: string;
  readonly reqId?: string;
  readonly jobId?: string;
  readonly workerId?: string;
  readonly traceId?: string;
  /** Case-insensitive substring of the message or the fields. */
  readonly text?: string;
  readonly since?: Date;
  readonly until?: Date;
  /** Cursor: only lines with a smaller id (the previous page's `nextBefore`). */
  readonly before?: string;
  readonly limit?: number;
}

export interface LogView {
  readonly id: string;
  readonly at: string;
  readonly level: number;
  readonly levelName: LogLevelName | 'other';
  readonly component: string | null;
  readonly reqId: string | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly traceId: string | null;
  readonly msg: string;
  readonly fields: Record<string, unknown> | null;
}

export interface LogSearchResult {
  readonly lines: readonly LogView[];
  /** Pass as `before` for the next (older) page; null when this page was the last. */
  readonly nextBefore: string | null;
  readonly since: string;
  readonly until: string;
}

export function levelName(n: number): LogLevelName | 'other' {
  for (const [name, v] of Object.entries(LOG_LEVEL_NUMBERS)) if (v === n) return name as LogLevelName;
  return 'other';
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface LogStoreDeps {
  readonly pool: Pool;
  readonly sink: LogSink;
  readonly config: LogStoreConfig;
  readonly clock?: () => Date;
  readonly redactor?: Redactor;
  readonly onError?: (err: unknown, what: 'flush' | 'purge') => void;
}

export class LogStore {
  #d: LogStoreDeps;
  readonly #now: () => Date;
  readonly #redactor: Redactor;
  #flushing: Promise<number> | null = null;
  #lastError: { at: string; what: string } | null = null;
  #purged = 0;

  constructor(d: LogStoreDeps) {
    this.#d = d;
    this.#now = d.clock ?? (() => new Date());
    this.#redactor = d.redactor ?? new Redactor();
  }

  get enabled(): boolean {
    return this.#d.sink.enabled;
  }

  get config(): LogStoreConfig {
    return this.#d.config;
  }

  /** p17-panel-settings: the panel's retention / level / request lines (the sink filters from the next line on). */
  configure(cfg: Pick<LogStoreConfig, 'retentionDays' | 'minLevel' | 'requests'>): void {
    this.#d = { ...this.#d, config: { ...this.#d.config, ...cfg } };
    this.#d.sink.configure(cfg);
  }

  /** Writes queued lines (single-flight); returns how many were written. */
  flush(): Promise<number> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flush(): Promise<number> {
    let written = 0;
    for (let round = 0; round < 10; round++) {
      const batch = this.#d.sink.drain(500);
      if (batch.length === 0) break;
      try {
        await this.#d.pool.query(
          `INSERT INTO master_log_lines (at, level, component, req_id, job_id, worker_id, trace_id, msg, fields)
           SELECT * FROM unnest($1::timestamptz[], $2::smallint[], $3::text[], $4::text[], $5::text[], $6::text[],
                                $7::text[], $8::text[], $9::jsonb[])`,
          [
            batch.map((l) => l.at),
            batch.map((l) => l.level),
            batch.map((l) => l.component),
            batch.map((l) => l.reqId),
            batch.map((l) => l.jobId),
            batch.map((l) => l.workerId),
            batch.map((l) => l.traceId),
            batch.map((l) => l.msg.replaceAll('\u0000', '')),
            batch.map((l) => (l.fields === null ? null : JSON.stringify(l.fields).replaceAll('\\u0000', ''))),
          ],
        );
        written += batch.length;
      } catch (err) {
        this.#d.sink.requeue(batch);
        this.#lastError = { at: this.#now().toISOString(), what: 'flush' };
        throw err;
      }
    }
    return written;
  }

  /** Deletes lines past the retention and rows above `maxRows`, in bounded batches; returns rows deleted. */
  async purge(): Promise<number> {
    const cut = new Date(this.#now().getTime() - this.#d.config.retentionDays * 86_400_000);
    let deleted = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const r = await this.#d.pool.query(
          `DELETE FROM master_log_lines WHERE id IN (SELECT id FROM master_log_lines WHERE at < $1 LIMIT 10000)`,
          [cut],
        );
        deleted += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < 10000) break;
      }
      const top = await this.#d.pool.query<{ max: string | null }>(
        'SELECT max(id)::text AS max FROM master_log_lines',
      );
      const max = top.rows[0]?.max ?? null;
      if (max !== null) {
        const floor = BigInt(max) - BigInt(this.#d.config.maxRows);
        if (floor > 0n) {
          for (let i = 0; i < 50; i++) {
            const r = await this.#d.pool.query(
              `DELETE FROM master_log_lines WHERE id IN (SELECT id FROM master_log_lines WHERE id <= $1 LIMIT 10000)`,
              [floor.toString()],
            );
            deleted += r.rowCount ?? 0;
            if ((r.rowCount ?? 0) < 10000) break;
          }
        }
      }
    } catch (err) {
      this.#lastError = { at: this.#now().toISOString(), what: 'purge' };
      throw err;
    }
    this.#purged += deleted;
    return deleted;
  }

  /** Background flush (default every second) and purge (default every 10 minutes); returns a stop function. */
  start(flushMs = 1000, purgeMs = 600_000): () => void {
    const report = (what: 'flush' | 'purge') => (err: unknown) => {
      this.#d.onError?.(err, what);
    };
    const f = setInterval(() => {
      this.flush().catch(report('flush'));
    }, flushMs);
    const p = setInterval(() => {
      this.purge().catch(report('purge'));
    }, purgeMs);
    f.unref();
    p.unref();
    return () => {
      clearInterval(f);
      clearInterval(p);
    };
  }

  async search(q: LogSearch): Promise<LogSearchResult> {
    const now = this.#now();
    const oldest = new Date(now.getTime() - Math.max(1, this.#d.config.retentionDays) * 86_400_000);
    const until = q.until !== undefined && q.until < now ? q.until : now;
    let since = q.since ?? new Date(until.getTime() - 86_400_000);
    if (since < oldest) since = oldest;
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const where: string[] = ['at >= $1', 'at <= $2'];
    const params: unknown[] = [since, until];
    const add = (sql: (n: string) => string, v: unknown): void => {
      params.push(v);
      where.push(sql(`$${String(params.length)}`));
    };
    if (q.level !== undefined) add((n) => `level >= ${n}`, LOG_LEVEL_NUMBERS[q.level]);
    if (q.component !== undefined) add((n) => `component = ${n}`, q.component);
    if (q.reqId !== undefined) add((n) => `req_id = ${n}`, q.reqId);
    if (q.jobId !== undefined) add((n) => `job_id = ${n}`, q.jobId);
    if (q.workerId !== undefined) add((n) => `worker_id = ${n}`, q.workerId);
    if (q.traceId !== undefined) add((n) => `trace_id = ${n}`, q.traceId);
    if (q.before !== undefined && /^\d{1,19}$/.test(q.before)) add((n) => `id < ${n}::bigint`, q.before);
    if (q.text !== undefined && q.text.trim() !== '') {
      add(
        (n) => `(msg ILIKE ${n} ESCAPE '\\' OR fields::text ILIKE ${n} ESCAPE '\\')`,
        `%${escapeLike(q.text.trim().slice(0, 200))}%`,
      );
    }
    params.push(limit + 1);
    const rows = await withTransaction(this.#d.pool, async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '5s'");
      const r = await tx.query<{
        id: string;
        at: Date;
        level: number;
        component: string | null;
        req_id: string | null;
        job_id: string | null;
        worker_id: string | null;
        trace_id: string | null;
        msg: string;
        fields: Record<string, unknown> | null;
      }>(
        `SELECT id::text AS id, at, level, component, req_id, job_id, worker_id, trace_id, msg, fields
           FROM master_log_lines WHERE ${where.join(' AND ')}
          ORDER BY at DESC, id DESC LIMIT $${String(params.length)}`,
        params,
      );
      return r.rows;
    });
    const page = rows.slice(0, limit);
    return {
      lines: page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        level: r.level,
        levelName: levelName(r.level),
        component: r.component,
        reqId: r.req_id,
        jobId: r.job_id,
        workerId: r.worker_id,
        traceId: r.trace_id,
        msg: this.#redactor.redact(r.msg),
        fields:
          r.fields === null
            ? null
            : (redactDeep(r.fields, this.#redactor, { maxEntries: 100 }) as Record<string, unknown>),
      })),
      nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      since: since.toISOString(),
      until: until.toISOString(),
    };
  }

  /** Error / fatal lines stored in the last `windowMs` (status page); null when the store is off. */
  async errorCount(windowMs = 3_600_000): Promise<number | null> {
    if (!this.enabled) return null;
    const { rows } = await this.#d.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM master_log_lines WHERE at >= $1 AND level >= 50',
      [new Date(this.#now().getTime() - windowMs)],
    );
    return rows[0]?.n ?? 0;
  }

  stats(): ReturnType<LogSink['stats']> & {
    readonly purged: number;
    readonly lastError: { at: string; what: string } | null;
  } {
    return { ...this.#d.sink.stats(), purged: this.#purged, lastError: this.#lastError };
  }
}
