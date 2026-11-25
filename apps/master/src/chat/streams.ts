import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { ConnectionCaps } from '../http/connection-caps.js';
import { HttpError } from '../http/errors.js';
import { comment, encodeFrame, retry } from '../live/sse.js';

/**
 * Live view of one chat thread over Server-Sent Events (p5-ops-chat): `ready` with the running turn's text so
 * far, then `turn`, `delta`, `tool`, `draft`, `message`, `done` and `error` frames as the assistant works.
 * Deltas are kept only in memory for the running turn; persisted messages are re-read through REST, so a
 * reconnect (EventSource does it automatically) loses nothing that matters. Several master replicas
 * (p5-ops-chat-next): `publish` also hands every event to the fan-out (the chat bus), and events from other
 * replicas arrive through `deliver`, so a view open on any replica follows a turn served by another one.
 */

export interface ChatStreamLimits {
  readonly maxPerUser: number;
  readonly maxTotal: number;
  readonly heartbeatMs: number;
  readonly maxAgeMs: number;
  readonly retryMs: number;
}

export const DEFAULT_CHAT_STREAM_LIMITS: ChatStreamLimits = {
  maxPerUser: 8,
  maxTotal: 500,
  heartbeatMs: 15_000,
  maxAgeMs: 10 * 60_000,
  retryMs: 3_000,
};

export type ChatEventName =
  | 'turn'
  | 'delta'
  | 'tool'
  | 'draft'
  | 'message'
  | 'done'
  | 'error'
  | 'thread'
  /** p6-chat-notify: the thread's watches changed (the view reloads them). */
  | 'watch'
  /**
   * p18-plan-mode: the conversation's plan changed — `{planId, rev, version, state, change, plan}` with the full plan
   * (bounded); a view replaces its plan when `rev` is newer. Older consoles ignore it.
   */
  | 'plan'
  /**
   * p17-chat-flow leftover (p18-plan-mode W4): a workflow approval step shown as a card here was decided or closed —
   * `{kind: 'workflow-approval', runId, nodeRunId, state}` (ids and a state word only); the card reads it again.
   */
  | 'flow'
  /**
   * p22-chat-queue: the conversation's waiting messages changed — `{change: 'queued' | 'edited' | 'removed' | 'held' |
   * 'delivered', ids, turnId?}` (ids only); the view reads them again. Older consoles ignore it.
   */
  | 'queue';

interface Conn {
  readonly threadId: string;
  send(event: ChatEventName, data: unknown): void;
  close(reason: string): void;
}

export class ChatStreams {
  readonly limits: ChatStreamLimits;
  readonly #byThread = new Map<string, Set<Conn>>();
  readonly #caps: ConnectionCaps;

  constructor(
    private readonly deps: {
      readonly log: FastifyBaseLogger;
      readonly limits?: Partial<ChatStreamLimits>;
    },
  ) {
    this.limits = { ...DEFAULT_CHAT_STREAM_LIMITS, ...deps.limits };
    this.#caps = new ConnectionCaps({ perKey: this.limits.maxPerUser, total: this.limits.maxTotal });
  }

  #fanout: ((threadId: string, event: ChatEventName, data: unknown) => void) | null = null;

  /** Where events also go (the chat bus to the other master replicas); null = this process only. */
  setFanout(fn: ((threadId: string, event: ChatEventName, data: unknown) => void) | null): void {
    this.#fanout = fn;
  }

  /** Pushes an event to every open stream of the thread here and on the other replicas. */
  publish(threadId: string, event: ChatEventName, data: unknown): void {
    this.deliver(threadId, event, data);
    this.#fanout?.(threadId, event, data);
  }

  /** Pushes an event to the open streams of this process only (never blocks: slow sockets buffer in Node). */
  deliver(threadId: string, event: ChatEventName, data: unknown): void {
    const conns = this.#byThread.get(threadId);
    if (conns === undefined) return;
    for (const c of conns) c.send(event, data);
  }

  subscribers(threadId: string): number {
    return this.#byThread.get(threadId)?.size ?? 0;
  }

  closeAll(): void {
    for (const set of this.#byThread.values()) for (const c of [...set]) c.close('shutdown');
  }

  /** Serves one stream; `ready` carries the snapshot the caller provides (running turn, partial text). */
  async serve(
    reply: FastifyReply,
    opts: {
      readonly threadId: string;
      readonly userId: string;
      readonly snapshot: () => unknown;
      /**
       * p16-chat-complete: a shared reader's view — events that carry rows (draft, message, tool, thread, watch) are
       * sent as a bare signal (`{}`: the console re-reads the thread through REST, filtered for the reader).
       */
      readonly reader?: boolean;
    },
  ): Promise<void> {
    const release = this.#caps.tryAcquire(opts.userId);
    if (release === null) {
      throw new HttpError(429, 'too_many_streams', 'Too many chat views are open. Close one and try again.');
    }
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v;
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
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const timers: NodeJS.Timeout[] = [];
    let set = this.#byThread.get(opts.threadId);
    if (set === undefined) {
      set = new Set();
      this.#byThread.set(opts.threadId, set);
    }
    const conns = set;
    const conn: Conn = {
      threadId: opts.threadId,
      send: (event, data) => {
        if (closed) return;
        const signalOnly =
          opts.reader === true &&
          (event === 'draft' ||
            event === 'message' ||
            event === 'tool' ||
            event === 'thread' ||
            event === 'watch' ||
            event === 'plan' ||
            event === 'queue');
        raw.write(encodeFrame({ event, data: signalOnly ? {} : data }));
      },
      close: (reason) => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        conns.delete(conn);
        if (conns.size === 0) this.#byThread.delete(opts.threadId);
        release();
        if (reason === 'max_age' || reason === 'shutdown')
          raw.write(encodeFrame({ event: 'bye', data: { reason } }));
        raw.end();
        resolveDone();
      },
    };
    conns.add(conn);
    raw.on('close', () => {
      conn.close('client');
    });
    timers.push(
      setInterval(() => {
        if (!closed) raw.write(comment('hb'));
      }, this.limits.heartbeatMs),
      setTimeout(() => {
        conn.close('max_age');
      }, this.limits.maxAgeMs),
    );
    for (const t of timers) t.unref();
    raw.write(retry(this.limits.retryMs));
    raw.write(encodeFrame({ event: 'ready', data: opts.snapshot() }));
    this.deps.log.debug({ threadId: opts.threadId }, 'chat stream opened');
    await done;
  }
}
