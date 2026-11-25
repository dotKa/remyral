import { createHash } from 'node:crypto';
import { DependencyUnavailableError } from '../infra/dependency-health.js';
import type { RedisClient } from '../redis.js';

/** Fixed-window counters for per-IP and per-account auth rate limits (ADR-0009 §7). */
export interface RateLimiter {
  /** Counts one hit; `allowed` is false once `limit` hits happened within the window. */
  hit(bucket: string, key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  /** Hits in the current window including this one (p7-rate-limit: audit only the first refusal). */
  readonly count?: number;
}

/**
 * Waits at most `ms` for `p` (the command itself is not cancelled: its late answer or error is dropped). Exported for
 * the readiness probe.
 */
export async function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  p.catch(() => undefined);
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what}: no answer from Redis within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keys are hashed so usernames/IPs are not stored in Redis in clear. */
function keyOf(prefix: string, bucket: string, key: string): string {
  return `${prefix}rl:${bucket}:${createHash('sha256').update(key).digest('base64url').slice(0, 32)}`;
}

/**
 * Redis-backed limiter shared by all master replicas. Fails closed: if Redis is unavailable the caller
 * gets an exception and the request is rejected rather than allowed unlimited attempts (p22-ops-hygiene: a
 * {@link DependencyUnavailableError}, answered as 503 + Retry-After by the error handler).
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = 'remyral:',
    /**
     * p11-fixes-a: how long a hit waits for Redis. An unresponsive Redis (a paused container keeps its socket open, so
     * the client never sees a disconnect) made every request wait forever in the limiter hook. After this the hit
     * throws: the request limiter falls back to per-process windows, the credential limits fail closed.
     */
    private readonly timeoutMs = 1_000,
  ) {}

  /**
   * p22-ops-hygiene: every failure is a {@link DependencyUnavailableError} — the HTTP error handler answers it with
   * 503 + Retry-After (fail closed, as before) and the outage is logged once per transition, not once per request.
   */
  async hit(bucket: string, key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const k = keyOf(this.prefix, bucket, key);
    let res: Awaited<ReturnType<ReturnType<RedisClient['multi']>['exec']>>;
    try {
      res = await bounded(
        this.redis.multi().incr(k).pexpire(k, windowMs, 'NX').pttl(k).exec(),
        this.timeoutMs,
        'rate limiter',
      );
    } catch (err) {
      throw new DependencyUnavailableError(
        'redis',
        err instanceof Error ? err.message : 'rate limiter: Redis call failed',
      );
    }
    if (!res) throw new DependencyUnavailableError('redis', 'rate limiter: Redis transaction aborted');
    const [incr, , ttl] = res;
    if (!incr || incr[0] || !ttl || ttl[0]) {
      throw new DependencyUnavailableError('redis', 'rate limiter: Redis command failed');
    }
    const count = Number(incr[1]);
    const pttl = Number(ttl[1]);
    return { allowed: count <= limit, retryAfterMs: count <= limit ? 0 : Math.max(pttl, 1000), count };
  }
}

/** In-process limiter for unit tests. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(bucket: string, key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const k = `${bucket}:${key}`;
    const t = this.now();
    let w = this.windows.get(k);
    if (!w || w.resetAt <= t) {
      // Bounded memory (it is also the Redis-outage fallback): drop expired windows when the map grows.
      if (this.windows.size >= 10_000) {
        for (const [key, win] of this.windows) if (win.resetAt <= t) this.windows.delete(key);
      }
      w = { count: 0, resetAt: t + windowMs };
      this.windows.set(k, w);
    }
    w.count += 1;
    const allowed = w.count <= limit;
    return Promise.resolve({ allowed, retryAfterMs: allowed ? 0 : w.resetAt - t, count: w.count });
  }
}

/**
 * p7-rate-limit: the general request limiter. Uses the shared Redis limiter; while Redis is unavailable it
 * falls back to per-process windows (bounded, not shared between replicas) instead of either refusing all
 * traffic or allowing unlimited requests. The credential-attempt limits (AuthService) keep failing closed.
 */
const FALLBACK_HOLD_MS = 5_000;

export class FallbackRateLimiter implements RateLimiter {
  readonly #fallback: MemoryRateLimiter;
  #lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly primary: RateLimiter,
    private readonly onFallback: (err: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.#fallback = new MemoryRateLimiter(now);
  }

  /** p11-fixes-a: after a primary failure the fallback is used without asking Redis until then (no pile-up). */
  #primaryAfter = Number.NEGATIVE_INFINITY;

  async hit(bucket: string, key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (this.now() < this.#primaryAfter) return this.#fallback.hit(bucket, key, limit, windowMs);
    try {
      return await this.primary.hit(bucket, key, limit, windowMs);
    } catch (err) {
      const t = this.now();
      this.#primaryAfter = t + FALLBACK_HOLD_MS;
      if (t - this.#lastWarnAt >= 60_000) {
        this.#lastWarnAt = t;
        this.onFallback(err);
      }
      return this.#fallback.hit(bucket, key, limit, windowMs);
    }
  }
}
