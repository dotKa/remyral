import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { bounded, type RateLimiter } from '../auth/rate-limit.js';
import { HttpError } from '../http/errors.js';
import { requestClass } from '../http/request-limits.js';
import type { WindowRule } from '../http/rate-policy.js';
import type { RedisClient } from '../redis.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §7): per-token request budgets and a per-token concurrency cap, on top
 * of the per-IP and per-user (principal) budgets of p7-rate-limit. Registered after authentication; only requests
 * authenticated by a token are counted.
 */
export type TokenBudgetClass = 'read' | 'write' | 'export';

export interface TokenLimitPolicy {
  readonly perToken: Readonly<Record<TokenBudgetClass, WindowRule>>;
  /** Requests of one token in flight at once (across replicas while Redis is up). */
  readonly concurrency: number;
}

const MIN = 60_000;
export const TOKEN_REQUEST_LIMITS: TokenLimitPolicy = {
  perToken: {
    read: { max: 600, windowMs: MIN },
    write: { max: 120, windowMs: MIN },
    export: { max: 20, windowMs: MIN },
  },
  concurrency: 8,
};

/** Scales the per-token budgets (RATE_LIMIT_SCALE, test harnesses); the concurrency cap is not scaled. */
export function scaleTokenLimits(policy: TokenLimitPolicy, factor: number): TokenLimitPolicy {
  const s = (r: WindowRule): WindowRule => ({
    max: Math.max(1, Math.round(r.max * factor)),
    windowMs: r.windowMs,
  });
  return {
    perToken: {
      read: s(policy.perToken.read),
      write: s(policy.perToken.write),
      export: s(policy.perToken.export),
    },
    concurrency: policy.concurrency,
  };
}

// ------------------------------------------------------------------ concurrency

export interface ConcurrencyGuard {
  /** Takes a slot of `key`; false when `max` slots are taken. */
  acquire(key: string, max: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export class MemoryConcurrencyGuard implements ConcurrencyGuard {
  readonly #inFlight = new Map<string, number>();

  acquire(key: string, max: number): Promise<boolean> {
    const n = this.#inFlight.get(key) ?? 0;
    if (n >= max) return Promise.resolve(false);
    this.#inFlight.set(key, n + 1);
    return Promise.resolve(true);
  }

  release(key: string): Promise<void> {
    const n = (this.#inFlight.get(key) ?? 0) - 1;
    if (n <= 0) this.#inFlight.delete(key);
    else this.#inFlight.set(key, n);
    return Promise.resolve();
  }
}

/**
 * Shared counter in Redis. The key's TTL is refreshed on every acquire: a slot leaked by a crashed replica heals once
 * the token has been idle for {@link SLOT_TTL_MS} (longer than the slowest request, p7 `requestMs` 30 s).
 */
const SLOT_TTL_MS = 60_000;

export class RedisConcurrencyGuard implements ConcurrencyGuard {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = 'remyral:',
    private readonly timeoutMs = 1_000,
  ) {}

  #key(key: string): string {
    return `${this.prefix}tc:${key}`;
  }

  async acquire(key: string, max: number): Promise<boolean> {
    const k = this.#key(key);
    const res = await bounded(
      this.redis.multi().incr(k).pexpire(k, SLOT_TTL_MS).exec(),
      this.timeoutMs,
      'token concurrency',
    );
    const incr = res?.[0];
    if (!incr || incr[0]) throw new Error('token concurrency command failed');
    if (Number(incr[1]) <= max) return true;
    await bounded(this.redis.decr(k), this.timeoutMs, 'token concurrency');
    return false;
  }

  async release(key: string): Promise<void> {
    const k = this.#key(key);
    const n = await bounded(this.redis.decr(k), this.timeoutMs, 'token concurrency');
    if (n < 0) await bounded(this.redis.set(k, '0', 'PX', SLOT_TTL_MS), this.timeoutMs, 'token concurrency');
  }
}

/** Redis first; while it fails, per-process slots (never unlimited). Remembers which one gave each slot. */
export class FallbackConcurrencyGuard implements ConcurrencyGuard {
  readonly #local = new MemoryConcurrencyGuard();
  readonly #localKeys = new Map<string, number>();

  constructor(
    private readonly primary: ConcurrencyGuard,
    private readonly onFallback: (err: unknown) => void,
  ) {}

  async acquire(key: string, max: number): Promise<boolean> {
    try {
      return await this.primary.acquire(key, max);
    } catch (err) {
      this.onFallback(err);
      const ok = await this.#local.acquire(key, max);
      if (ok) this.#localKeys.set(key, (this.#localKeys.get(key) ?? 0) + 1);
      return ok;
    }
  }

  async release(key: string): Promise<void> {
    const local = this.#localKeys.get(key) ?? 0;
    if (local > 0) {
      if (local === 1) this.#localKeys.delete(key);
      else this.#localKeys.set(key, local - 1);
      await this.#local.release(key);
      return;
    }
    await this.primary.release(key).catch(this.onFallback);
  }
}

// ------------------------------------------------------------------ hooks

export interface TokenLimiterDeps {
  readonly limiter: RateLimiter;
  readonly guard: ConcurrencyGuard;
  readonly policy: TokenLimitPolicy;
  readonly audit?: AuditRecorder;
  /**
   * p16-ops-safety: the owner's per-token budgets of reads and writes (requests per minute, security policy `limits`,
   * already scaled like the policy); a class it does not name, and exports, keep the policy's budget.
   */
  readonly ownerLimits?: () => Promise<Partial<Record<'read' | 'write', number>>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** p16-api-tokens: the token's concurrency slot is held by this request. */
    apiTokenSlot?: string | undefined;
  }
}

function budgetClass(request: FastifyRequest): TokenBudgetClass {
  const cls = requestClass(request);
  return cls === 'read' || cls === 'export' ? cls : 'write';
}

/** Per-token budget and concurrency (register after authentication). */
export function registerTokenLimiter(app: FastifyInstance, deps: TokenLimiterDeps): void {
  app.addHook('onRequest', async (request) => {
    const token = request.auth?.token;
    if (token === undefined) return;
    const cls = budgetClass(request);
    let rule = deps.policy.perToken[cls];
    if (deps.ownerLimits !== undefined && cls !== 'export') {
      const max = (await deps.ownerLimits())[cls];
      if (max !== undefined) rule = { max: Math.max(1, Math.round(max)), windowMs: 60_000 };
    }
    const r = await deps.limiter.hit(`req-token:${cls}`, token.id, rule.max, rule.windowMs);
    if (!r.allowed) {
      request.log.warn({ rateClass: cls, scope: 'token', count: r.count }, 'request rate limited');
      if (deps.audit !== undefined && (r.count === undefined || r.count === rule.max + 1)) {
        await deps.audit.record({
          actor: { type: 'user', id: token.principalId },
          action: 'http.rate_limited',
          outcome: 'denied',
          target: `${request.method} ${request.routeOptions.url ?? '(unrouted)'}`,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          metadata: {
            rateClass: cls,
            scope: 'token',
            viaApi: token.id,
            limit: rule.max,
            windowMs: rule.windowMs,
          },
        });
      }
      throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
        'retry-after': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))),
      });
    }
    if (!(await deps.guard.acquire(token.id, deps.policy.concurrency))) {
      throw new HttpError(
        429,
        'token_busy',
        `This API token already has ${String(deps.policy.concurrency)} requests in progress; wait for one to finish.`,
        { 'retry-after': '1' },
        {},
        { max: deps.policy.concurrency },
      );
    }
    request.apiTokenSlot = token.id;
  });
  const release = async (request: FastifyRequest): Promise<void> => {
    const slot = request.apiTokenSlot;
    if (slot === undefined) return;
    request.apiTokenSlot = undefined;
    await deps.guard.release(slot);
  };
  app.addHook('onResponse', release);
  app.addHook('onRequestAbort', release);
}
