import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient } from '../db/pool.js';
import type { ChatEventName } from './streams.js';

/**
 * Ops chat across master replicas (p5-ops-chat-next, "multi-replica turn affinity"). A worker holds exactly one
 * WebSocket to one replica, so the replica that holds the assistant worker's connection ("owner") is the only one
 * that can send ASSISTANT_TURN / CANCEL and it receives every ASSISTANT_UPDATE (deltas, tool calls, the answer).
 * This bus lets the other replicas use it, over Postgres LISTEN/NOTIFY on one channel (no new infrastructure,
 * like the live bus):
 *
 *  - `presence`: every replica announces, every few seconds and on connection changes, which workers it holds;
 *    a peer is alive while its announcements are fresh. Without peers the master behaves exactly as a single
 *    process (nothing is routed).
 *  - `dispatch` / `ack`: the replica that received a user message stores the turn and the message (as before)
 *    and asks the owner, by turn and message id only, to send it; the owner reloads everything from the
 *    database, signs with its own lease key (the worker trusts its connection's keys) and acknowledges.
 *  - `cancel` / `cancel_all`: Stop and the kill switch reach the owner.
 *  - `event`: every SSE event of a thread (turn, delta, tool, draft, message, done, error, thread) is fanned out
 *    so a view open on any replica follows the answer live.
 *
 * Notifications are best effort: a lost one costs at most live deltas of a view (persisted messages are always
 * re-read through REST, and an unacknowledged dispatch fails the turn as "could not be reached"). Payloads over
 * the NOTIFY limit are split into base64 chunks and reassembled; every replica numbers its messages, receivers
 * drop duplicates and their own messages. All messages are published on one dedicated connection, in order.
 */

export const CHAT_CHANNEL = 'remyral_chat';
/** Postgres limits a NOTIFY payload to 8000 bytes; stay below with room for the envelope. */
export const MAX_NOTIFY_BYTES = 7_500;

export type ChatBusMessage =
  /** `p`: the sender's announce period (ms); receivers expire it after 3 periods of silence (theirs, not their own). */
  | { readonly t: 'presence'; readonly w: readonly string[]; readonly p?: number }
  | { readonly t: 'bye' }
  | { readonly t: 'event'; readonly th: string; readonly ev: ChatEventName; readonly d: unknown }
  | {
      readonly t: 'dispatch';
      readonly to: string;
      readonly turn: string;
      readonly w: string;
      readonly msg: string;
    }
  | { readonly t: 'ack'; readonly to: string; readonly turn: string; readonly ok: boolean }
  | { readonly t: 'cancel'; readonly turn: string; readonly reason: string }
  | { readonly t: 'cancel_all'; readonly reason: string };

interface Envelope {
  readonly o: string;
  readonly n: number;
  readonly m: ChatBusMessage;
}

interface Chunk {
  readonly o: string;
  readonly n: number;
  readonly i: number;
  readonly k: number;
  readonly b: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes one message as NOTIFY payloads of at most `maxBytes` each (one, or base64 chunks). */
export function encodeFrames(
  origin: string,
  seq: number,
  m: ChatBusMessage,
  maxBytes = MAX_NOTIFY_BYTES,
): string[] {
  const whole = JSON.stringify({ o: origin, n: seq, m } satisfies Envelope);
  const bytes = Buffer.from(whole, 'utf8');
  if (bytes.length <= maxBytes) return [whole];
  // Envelope overhead of a chunk: origin, numbers, keys (< 200 bytes); base64 grows 4/3.
  const per = Math.max(1, Math.floor(((maxBytes - 200) * 3) / 4 / 3) * 3);
  const k = Math.ceil(bytes.length / per);
  const frames: string[] = [];
  for (let i = 0; i < k; i++) {
    const b = bytes.subarray(i * per, (i + 1) * per).toString('base64');
    frames.push(JSON.stringify({ o: origin, n: seq, i, k, b } satisfies Chunk));
  }
  return frames;
}

/**
 * Turns NOTIFY payloads back into messages: reassembles chunks (partial sets expire), drops malformed frames and
 * duplicates (a sequence number not above the last one delivered for that origin).
 */
export class FrameAssembler {
  readonly #last = new Map<string, number>();
  readonly #partial = new Map<string, { parts: (string | undefined)[]; got: number; at: number }>();

  constructor(
    private readonly opts: {
      readonly partialTtlMs?: number;
      readonly maxPartial?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  accept(payload: string): Envelope | null {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== 'object') return null;
    const f = raw as Partial<Envelope & Chunk>;
    if (typeof f.o !== 'string' || f.o.length > 64 || typeof f.n !== 'number' || !Number.isSafeInteger(f.n)) {
      return null;
    }
    if (typeof f.b === 'string') return this.#chunk(f as Chunk);
    return this.#deliver(f as Envelope);
  }

  #chunk(c: Chunk): Envelope | null {
    if (!Number.isInteger(c.i) || !Number.isInteger(c.k) || c.k < 1 || c.k > 4096 || c.i < 0 || c.i >= c.k)
      return null;
    const now = this.opts.now?.() ?? Date.now();
    const ttl = this.opts.partialTtlMs ?? 30_000;
    for (const [key, p] of this.#partial) if (now - p.at > ttl) this.#partial.delete(key);
    const key = `${c.o}:${String(c.n)}`;
    let p = this.#partial.get(key);
    if (p === undefined) {
      if (this.#partial.size >= (this.opts.maxPartial ?? 256)) return null;
      p = { parts: new Array<string | undefined>(c.k).fill(undefined), got: 0, at: now };
      this.#partial.set(key, p);
    }
    if (p.parts.length !== c.k || p.parts[c.i] !== undefined) return null;
    p.parts[c.i] = c.b;
    p.got += 1;
    if (p.got < c.k) return null;
    this.#partial.delete(key);
    const json = Buffer.concat(p.parts.map((b) => Buffer.from(b ?? '', 'base64'))).toString('utf8');
    let env: unknown;
    try {
      env = JSON.parse(json);
    } catch {
      return null;
    }
    const e = env as Partial<Envelope>;
    if (e.o !== c.o || e.n !== c.n) return null;
    return this.#deliver(e as Envelope);
  }

  #deliver(e: Envelope): Envelope | null {
    if (!wellFormed(e.m)) return null;
    const last = this.#last.get(e.o);
    if (last !== undefined && e.n <= last) return null;
    this.#last.set(e.o, e.n);
    return e;
  }

  get pendingPartials(): number {
    return this.#partial.size;
  }
}

/** Shape check of a received message (other replicas are trusted, but a frame may be cut or stale). */
function wellFormed(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const m = raw as Record<string, unknown>;
  const str = (k: string): boolean => typeof m[k] === 'string';
  switch (m.t) {
    case 'presence':
      return Array.isArray(m.w);
    case 'bye':
      return true;
    case 'event':
      return str('th') && str('ev');
    case 'dispatch':
      return str('to') && str('turn') && str('w') && str('msg');
    case 'ack':
      return str('to') && str('turn') && typeof m.ok === 'boolean';
    case 'cancel':
      return str('turn') && str('reason');
    case 'cancel_all':
      return str('reason');
    default:
      return false;
  }
}

export type ChatBusHandler = (m: ChatBusMessage, origin: string) => void;

/** What ChatService needs from the bus (a fake in unit tests). */
export interface ChatReplicaBus {
  readonly replicaId: string;
  on(handler: ChatBusHandler): void;
  publish(m: ChatBusMessage): void;
  /** The live peer replica that holds the worker's connection, or null. */
  ownerOf(workerId: string): string | null;
  /** Publishes a dispatch and waits for the owner's acknowledgement (`null`: none in time). */
  dispatch(m: Extract<ChatBusMessage, { t: 'dispatch' }>, timeoutMs: number): Promise<boolean | null>;
  /** Announces the locally held workers now (a connection started or ended). */
  announce(): void;
  /** p16-chat-complete: whether `replicaId` is a live peer (its announcements are fresh). */
  alive?(replicaId: string): boolean;
}

export interface ChatBusOptions {
  readonly pool: Pool;
  readonly log: FastifyBaseLogger;
  /** Workers whose connection this replica holds. */
  readonly localWorkers: () => readonly string[];
  readonly replicaId?: string;
  /** Presence announcement period (default 5 s); a peer silent for 3 periods is gone. */
  readonly presenceMs?: number;
  readonly reconnectMs?: number;
}

export class ChatBus implements ChatReplicaBus {
  readonly replicaId: string;
  readonly #handlers: ChatBusHandler[] = [];
  readonly #peers = new Map<string, { workers: Set<string>; at: number; period: number }>();
  readonly #acks = new Map<string, (ok: boolean) => void>();
  readonly #assembler = new FrameAssembler();
  #client: PoolClient | null = null;
  #starting: Promise<void> | null = null;
  #chain: Promise<void> = Promise.resolve();
  #seq = 0;
  #stopped = false;
  #retry: NodeJS.Timeout | null = null;
  #presence: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ChatBusOptions) {
    this.replicaId = deps.replicaId ?? randomUUID();
  }

  get #presenceMs(): number {
    return this.deps.presenceMs ?? 5_000;
  }

  get listening(): boolean {
    return this.#client !== null;
  }

  on(handler: ChatBusHandler): void {
    this.#handlers.push(handler);
  }

  /** Starts listening and announcing (idempotent); failures are logged and retried, never thrown. */
  start(): Promise<void> {
    if (this.#client !== null || this.#stopped) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    if (this.#presence === null) {
      this.#presence = setInterval(() => {
        this.announce();
        this.#expirePeers();
      }, this.#presenceMs);
      this.#presence.unref();
    }
    return this.#starting;
  }

  async #start(): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.deps.pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel === CHAT_CHANNEL && msg.payload !== undefined) this.#receive(msg.payload);
      });
      client.on('error', (err) => {
        this.deps.log.warn({ err }, 'chat bus connection failed; reconnecting');
        this.#drop(true);
      });
      await client.query(`LISTEN ${CHAT_CHANNEL}`);
      if (this.#stopped) {
        client.release();
        return;
      }
      this.#client = client;
      this.announce();
    } catch (err) {
      this.deps.log.warn({ err }, 'chat bus could not start; replicas are not coordinated until it does');
      client?.release(true);
      this.#schedule();
    }
  }

  #drop(broken: boolean): void {
    const c = this.#client;
    this.#client = null;
    c?.removeAllListeners('notification');
    c?.release(broken);
    // Without a listener we cannot know who holds which worker: forget the peers (single-process behaviour).
    this.#peers.clear();
    if (!this.#stopped) this.#schedule();
  }

  #schedule(): void {
    if (this.#retry !== null || this.#stopped) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.start();
    }, this.deps.reconnectMs ?? 5_000);
    this.#retry.unref();
  }

  async stop(): Promise<void> {
    if (this.#client !== null) {
      this.publish({ t: 'bye' });
      await this.#chain;
    }
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    if (this.#presence !== null) clearInterval(this.#presence);
    this.#presence = null;
    await this.#starting;
    const c = this.#client;
    this.#client = null;
    if (c !== null) {
      await c.query(`UNLISTEN ${CHAT_CHANNEL}`).catch(() => undefined);
      c.removeAllListeners('notification');
      c.release();
    }
    for (const resolve of this.#acks.values()) resolve(false);
    this.#acks.clear();
    this.#peers.clear();
  }

  /** Sends on the dedicated connection, in order; silently dropped while not connected. */
  publish(m: ChatBusMessage): void {
    const client = this.#client;
    if (client === null) return;
    this.#seq += 1;
    const frames = encodeFrames(this.replicaId, this.#seq, m);
    this.#chain = this.#chain
      .then(async () => {
        for (const f of frames) await client.query('SELECT pg_notify($1, $2)', [CHAT_CHANNEL, f]);
      })
      .catch((err: unknown) => {
        this.deps.log.debug({ err, type: m.t }, 'chat bus message not sent');
      });
  }

  announce(): void {
    this.publish({ t: 'presence', w: [...this.deps.localWorkers()], p: this.#presenceMs });
  }

  ownerOf(workerId: string): string | null {
    this.#expirePeers();
    let best: { id: string; at: number } | null = null;
    for (const [id, p] of this.#peers) {
      if (p.workers.has(workerId) && (best === null || p.at > best.at)) best = { id, at: p.at };
    }
    return best?.id ?? null;
  }

  alive(replicaId: string): boolean {
    this.#expirePeers();
    return replicaId === this.replicaId || this.#peers.has(replicaId);
  }

  get peers(): number {
    this.#expirePeers();
    return this.#peers.size;
  }

  dispatch(m: Extract<ChatBusMessage, { t: 'dispatch' }>, timeoutMs: number): Promise<boolean | null> {
    if (this.#client === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#acks.delete(m.turn);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.#acks.set(m.turn, (ok) => {
        clearTimeout(timer);
        this.#acks.delete(m.turn);
        resolve(ok);
      });
      this.publish(m);
    });
  }

  #expirePeers(): void {
    const now = Date.now();
    for (const [id, p] of this.#peers) if (p.at < now - 3 * p.period) this.#peers.delete(id);
  }

  #receive(payload: string): void {
    const env = this.#assembler.accept(payload);
    if (env === null || env.o === this.replicaId) return;
    const m = env.m;
    switch (m.t) {
      case 'presence':
        this.#peers.set(env.o, {
          workers: new Set(Array.isArray(m.w) ? m.w.filter((w) => typeof w === 'string') : []),
          at: Date.now(),
          // Older frames carry no period: assume our own. Bounded so a bad value cannot pin a dead peer.
          period:
            typeof m.p === 'number' && Number.isFinite(m.p)
              ? Math.min(60_000, Math.max(100, m.p))
              : this.#presenceMs,
        });
        return;
      case 'bye':
        this.#peers.delete(env.o);
        return;
      case 'ack':
        if (m.to === this.replicaId && UUID.test(m.turn)) this.#acks.get(m.turn)?.(m.ok);
        return;
      case 'dispatch':
        if (m.to !== this.replicaId) return;
        break;
      default:
        break;
    }
    for (const h of this.#handlers) {
      try {
        h(m, env.o);
      } catch (err) {
        this.deps.log.error({ err, type: m.t }, 'chat bus handler failed');
      }
    }
  }
}
