import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient, Queryable } from '../db/pool.js';

/** Postgres notification channel for "job X has new live rows" (payload: the job id). */
export const LIVE_CHANNEL = 'remyral_live';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Wake = () => void;

/**
 * Wake-ups for open live streams (docs/design/p5-live.md §5). Writers call {@link notifyWithin} inside
 * their transaction: `pg_notify` is transactional, so listeners hear about a row only once it committed,
 * on every master replica. Streams also poll on a timer, so a lost notification (listener reconnecting)
 * delays a view by at most one poll interval and never loses data — the database is the source of truth
 * and the stream reads from its own cursor.
 */
export class LiveBus {
  readonly #subs = new Map<string, Set<Wake>>();
  #client: PoolClient | null = null;
  #stopped = false;
  #retry: NodeJS.Timeout | null = null;
  #starting: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly log: FastifyBaseLogger;
      /** Reconnect delay of the listener after an error. */
      readonly reconnectMs?: number;
    },
  ) {}

  static async notifyWithin(tx: Queryable, jobId: string): Promise<void> {
    await tx.query('SELECT pg_notify($1, $2)', [LIVE_CHANNEL, jobId]);
  }

  /** Starts the listener (idempotent); failures are logged and retried, never thrown. */
  start(): Promise<void> {
    if (this.#client !== null || this.#stopped) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.deps.pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel === LIVE_CHANNEL && msg.payload !== undefined) this.wake(msg.payload);
      });
      client.on('error', (err) => {
        this.deps.log.warn({ err }, 'live listener connection failed; reconnecting');
        this.#drop(true);
      });
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      if (this.#stopped) {
        client.release();
        return;
      }
      this.#client = client;
    } catch (err) {
      this.deps.log.warn({ err }, 'live listener could not start; streams fall back to polling');
      client?.release(true);
      this.#schedule();
    }
  }

  #drop(broken: boolean): void {
    const c = this.#client;
    this.#client = null;
    c?.removeAllListeners('notification');
    c?.release(broken);
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
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    await this.#starting;
    const c = this.#client;
    this.#client = null;
    if (c !== null) {
      await c.query(`UNLISTEN ${LIVE_CHANNEL}`).catch(() => undefined);
      c.removeAllListeners('notification');
      c.release();
    }
    this.#subs.clear();
  }

  /** Subscribes to wake-ups of one job; returns the unsubscribe function. */
  subscribe(rawJobId: string, wake: Wake): () => void {
    const jobId = rawJobId.toLowerCase();
    let set = this.#subs.get(jobId);
    if (set === undefined) {
      set = new Set();
      this.#subs.set(jobId, set);
    }
    set.add(wake);
    // The listener holds one pool connection: started with the first stream, not at boot.
    if (this.#client === null && this.#retry === null && this.#starting === null) void this.start();
    return () => {
      const s = this.#subs.get(jobId);
      if (s === undefined) return;
      s.delete(wake);
      if (s.size === 0) this.#subs.delete(jobId);
    };
  }

  /** Wakes the streams of a job (also called in-process after a local commit). */
  wake(jobId: string): void {
    if (!UUID.test(jobId)) return;
    const set = this.#subs.get(jobId.toLowerCase());
    if (set === undefined) return;
    for (const w of [...set]) w();
  }

  get listening(): boolean {
    return this.#client !== null;
  }
}
