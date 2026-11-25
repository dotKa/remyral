/**
 * Concurrent-connection caps for long-lived connections (SSE streams, proxied WebSockets, worker sockets),
 * per master process (p7-rate-limit; limits in rate-policy.ts CONNECTION_CAPS). One instance per
 * connection kind; a slot is held from acquisition until its release function runs (idempotent).
 */
export interface ConnectionCapRule {
  /** Concurrent connections per key (user id or client IP). */
  readonly perKey: number;
  /** Concurrent connections in total. */
  readonly total: number;
}

export class ConnectionCaps {
  readonly #perKey = new Map<string, number>();
  #total = 0;

  constructor(readonly rule: ConnectionCapRule) {}

  /** A release function when a slot is free for `key`, otherwise null (nothing is held). */
  tryAcquire(key: string): (() => void) | null {
    const mine = this.#perKey.get(key) ?? 0;
    if (mine >= this.rule.perKey || this.#total >= this.rule.total) return null;
    this.#perKey.set(key, mine + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      const n = (this.#perKey.get(key) ?? 1) - 1;
      if (n <= 0) this.#perKey.delete(key);
      else this.#perKey.set(key, n);
    };
  }

  count(key?: string): number {
    return key === undefined ? this.#total : (this.#perKey.get(key) ?? 0);
  }

  stats(): { total: number; keys: number } {
    return { total: this.#total, keys: this.#perKey.size };
  }
}
