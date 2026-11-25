import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { ConnectionCaps } from '../http/connection-caps.js';
import { HttpError } from '../http/errors.js';
import { CONNECTION_CAPS } from '../http/rate-policy.js';
import type { LiveBus } from './bus.js';
import { comment, encodeFrame, retry } from './sse.js';
import type { LiveStore } from './store.js';
import { itemJson } from './wire.js';

export interface StreamLimits {
  /** Concurrent streams per user (per master process). */
  readonly maxPerUser: number;
  /** Concurrent streams in total (per master process). */
  readonly maxTotal: number;
  /** A client more than this many rows behind the head gets `behind` and is closed. */
  readonly maxLag: number;
  /** Rows read per page. */
  readonly pageSize: number;
  readonly heartbeatMs: number;
  /** Fallback poll when no notification arrives (multi-replica, listener reconnecting). */
  readonly pollMs: number;
  /** After this the stream says `bye` and closes; EventSource reconnects (re-authenticated). */
  readonly maxAgeMs: number;
  /** Client reconnect delay sent as `retry:`. */
  readonly retryMs: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  // p7-rate-limit: the connection caps live in the central policy (rate-policy.ts CONNECTION_CAPS).
  maxPerUser: CONNECTION_CAPS.liveStream.perKey,
  maxTotal: CONNECTION_CAPS.liveStream.total,
  maxLag: 2_000,
  pageSize: 200,
  heartbeatMs: 15_000,
  pollMs: 2_000,
  maxAgeMs: 10 * 60_000,
  retryMs: 3_000,
};

type CloseReason = 'client' | 'behind' | 'max_age' | 'shutdown' | 'error';

interface Conn {
  readonly userId: string;
  close(reason: CloseReason): void;
}

/**
 * Live job streams over Server-Sent Events (docs/design/p5-live.md §5): backfill from the cursor, then the
 * live tail woken by the bus (or the poll fallback). Pull-based: the next page is read only after the
 * socket drained, so no connection buffers more than one page; a client that falls more than `maxLag`
 * rows behind gets `event: behind` and is closed (the console reloads through REST).
 */
export class LiveStreams {
  readonly limits: StreamLimits;
  readonly #conns = new Set<Conn>();
  readonly #caps: ConnectionCaps;

  constructor(
    private readonly deps: {
      readonly store: LiveStore;
      readonly bus: LiveBus;
      readonly log: FastifyBaseLogger;
      readonly limits?: Partial<StreamLimits>;
    },
  ) {
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...deps.limits };
    this.#caps = new ConnectionCaps({ perKey: this.limits.maxPerUser, total: this.limits.maxTotal });
  }

  stats(): { total: number; users: number } {
    const s = this.#caps.stats();
    return { total: s.total, users: s.keys };
  }

  /** Closes every open stream (server shutdown). */
  closeAll(): void {
    for (const c of [...this.#conns]) c.close('shutdown');
  }

  /**
   * Serves one stream. Throws (before anything is written) `429 too_many_streams` over the limits;
   * otherwise hijacks the reply and resolves once the stream ended.
   */
  async serve(
    reply: FastifyReply,
    opts: { readonly jobId: string; readonly userId: string; readonly after: number | null },
  ): Promise<void> {
    const { jobId, userId } = opts;
    const l = this.limits;
    // The slot is taken before the first await, so concurrent opens cannot overshoot the caps.
    const release = this.#caps.tryAcquire(userId);
    if (release === null) {
      this.deps.log.info(
        { jobId, userId, open: this.#caps.count(userId) },
        'live stream refused: connection limit',
      );
      throw new HttpError(
        429,
        'too_many_streams',
        'Too many live views are open. Close another job view and try again.',
        {},
        {},
        { reason: 'live' },
      );
    }
    const store = this.deps.store;
    let head: number;
    let lastJob: Awaited<ReturnType<LiveStore['jobState']>>;
    try {
      head = await store.head(jobId);
      lastJob = await store.jobState(jobId);
    } catch (err) {
      release();
      throw err;
    }
    let cursor = opts.after === null ? head : Math.min(opts.after, head);

    // From here on the reply is ours: the global onSend hook does not run, so set the headers here
    // (security headers that hooks already put on the reply are kept).
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) headers[k] = v;
    }
    reply.hijack();
    const raw: ServerResponse = reply.raw;
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    });
    raw.socket?.setNoDelay(true);

    let closed = false;
    // A function, not the variable: the flag flips in callbacks while the pump awaits.
    const isClosed = (): boolean => closed;
    const wakeAgain = (): boolean => again;
    let pumping = false;
    let again = false;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const timers: NodeJS.Timeout[] = [];

    const conn: Conn = {
      userId,
      close: (reason) => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        unsubscribe();
        this.#conns.delete(conn);
        release();
        if (reason === 'max_age' || reason === 'shutdown') {
          raw.write(encodeFrame({ event: 'bye', data: { reason } }));
        }
        raw.end();
        this.deps.log.debug({ jobId, userId, reason }, 'live stream closed');
        resolveDone();
      },
    };
    this.#conns.add(conn);

    const write = async (chunk: string): Promise<void> => {
      if (closed) return;
      if (raw.write(chunk)) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          raw.off('drain', finish);
          raw.off('close', finish);
          resolve();
        };
        raw.once('drain', finish);
        raw.once('close', finish);
      });
    };

    const behind = async (h: number): Promise<void> => {
      await write(encodeFrame({ event: 'behind', data: { head: h, cursor } }));
      conn.close('behind');
    };

    const pump = async (): Promise<void> => {
      if (pumping) {
        again = true;
        return;
      }
      pumping = true;
      try {
        do {
          again = false;
          const job = await store.jobState(jobId);
          if (isClosed()) return;
          if (job !== null && (lastJob === null || job.version !== lastJob.version)) {
            lastJob = job;
            await write(encodeFrame({ event: 'job', data: job }));
          }
          for (;;) {
            if (isClosed()) return;
            const h = await store.head(jobId);
            if (h - cursor > l.maxLag) {
              await behind(h);
              return;
            }
            if (h <= cursor) break;
            const items = await store.since(jobId, cursor, l.pageSize);
            if (isClosed()) return;
            for (const item of items) {
              cursor = item.streamSeq;
              await write(encodeFrame({ id: item.streamSeq, event: item.type, data: itemJson(item) }));
              if (isClosed()) return;
            }
            if (items.length < l.pageSize) break;
          }
        } while (wakeAgain() && !isClosed());
      } catch (err) {
        this.deps.log.warn({ err, jobId }, 'live stream read failed');
        conn.close('error');
      } finally {
        pumping = false;
      }
    };

    const unsubscribe = this.deps.bus.subscribe(jobId, () => {
      void pump();
    });
    raw.on('close', () => {
      conn.close('client');
    });
    timers.push(
      setInterval(() => {
        if (!closed) raw.write(comment('hb'));
      }, l.heartbeatMs),
      setInterval(() => {
        void pump();
      }, l.pollMs),
      setTimeout(() => {
        conn.close('max_age');
      }, l.maxAgeMs),
    );
    for (const t of timers) t.unref();

    await write(retry(l.retryMs));
    await write(encodeFrame({ event: 'ready', data: { head, cursor, job: lastJob, maxAgeMs: l.maxAgeMs } }));
    if (head - cursor > l.maxLag) {
      await behind(head);
    } else {
      void pump();
    }
    await done;
  }
}
