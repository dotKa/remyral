/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §7): successful token uses are counted, not audited. A per-process
 * accumulator: the first use of a token within {@link USAGE_FLUSH_MS} is written at once (so "last used" shows up
 * right away), later uses are added up and written by the periodic flush (and on shutdown). At most one UPDATE per
 * token per minute per master replica.
 */
export const USAGE_FLUSH_MS = 60_000;

export interface UsageSink {
  addUses(
    entries: readonly { id: string; count: number; lastAt: Date; lastIp: string | null }[],
  ): Promise<void>;
}

interface Pending {
  count: number;
  lastAt: Date;
  lastIp: string | null;
}

export class TokenUsageCounter {
  readonly #pending = new Map<string, Pending>();
  /** When each token was last written by this process. */
  readonly #writtenAt = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: UsageSink,
    private readonly onError: (err: unknown) => void,
    private readonly flushMs = USAGE_FLUSH_MS,
  ) {}

  /** Counts one use; writes immediately when the token was not written within the flush interval. */
  record(id: string, at: Date, ip: string | null): void {
    const p = this.#pending.get(id);
    if (p === undefined) this.#pending.set(id, { count: 1, lastAt: at, lastIp: ip });
    else {
      p.count += 1;
      if (at >= p.lastAt) {
        p.lastAt = at;
        p.lastIp = ip;
      }
    }
    const last = this.#writtenAt.get(id);
    if (last === undefined || at.getTime() - last >= this.flushMs) {
      void this.flush([id]).catch(this.onError);
    }
  }

  /** Writes the pending uses (of `ids`, or all). */
  async flush(ids?: readonly string[]): Promise<void> {
    const keys = ids ?? [...this.#pending.keys()];
    const entries: { id: string; count: number; lastAt: Date; lastIp: string | null }[] = [];
    for (const id of keys) {
      const p = this.#pending.get(id);
      if (p === undefined) continue;
      this.#pending.delete(id);
      this.#writtenAt.set(id, p.lastAt.getTime());
      entries.push({ id, ...p });
    }
    // Bounded memory: forget write times older than two intervals.
    if (this.#writtenAt.size > 10_000) {
      const cutoff = Date.now() - 2 * this.flushMs;
      for (const [k, v] of this.#writtenAt) if (v < cutoff) this.#writtenAt.delete(k);
    }
    await this.sink.addUses(entries);
  }

  start(): void {
    if (this.#timer !== null || this.flushMs <= 0) return;
    this.#timer = setInterval(() => {
      void this.flush().catch(this.onError);
    }, this.flushMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.flush();
  }
}
