import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter, RateLimitResult } from '../auth/rate-limit.js';
import { HttpError } from './errors.js';
import {
  classifyUnrouted,
  type RequestLimitPolicy,
  type RouteClass,
  type WindowRule,
} from './rate-policy.js';

/**
 * p7-rate-limit central request limiter (docs/design/p7-hardening.md §1). Two `onRequest` hooks:
 *  - per client IP, registered **before** authentication (an anonymous flood never reaches the session
 *    lookup); `request.ip` is the trusted client IP (src/http/client-ip.ts, TRUST_PROXY_HOPS);
 *  - per user, registered **after** authentication (needs the session's user id).
 * Budgets come from the route's class (rate-policy.ts). Refusals are 429 with `retry-after`; the first
 * refusal of a window is audited (`http.rate_limited`), the rest only logged, so a flood cannot flood the
 * audit log.
 */
export interface RequestLimiterDeps {
  readonly limiter: RateLimiter;
  readonly policy: RequestLimitPolicy;
  readonly audit?: AuditRecorder;
  /**
   * p16-ops-safety: the owner's per-person budgets of the `read` and `write` classes (requests per minute, from the
   * security policy `limits`, already scaled like the policy); a class it does not name keeps the policy's budget.
   */
  readonly ownerLimits?: () => Promise<Partial<Record<'read' | 'write', number>>>;
}

export function requestClass(request: FastifyRequest): RouteClass {
  if (request.is404) return classifyUnrouted(request.method);
  return request.routeOptions.config.rateClass ?? classifyUnrouted(request.method);
}

function refused(r: RateLimitResult): HttpError {
  return new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
    'retry-after': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))),
  });
}

async function enforce(
  deps: RequestLimiterDeps,
  request: FastifyRequest,
  cls: RouteClass,
  scope: 'ip' | 'user',
  key: string,
  rule: WindowRule,
): Promise<void> {
  const r = await deps.limiter.hit(`req-${scope}:${cls}`, key, rule.max, rule.windowMs);
  if (r.allowed) return;
  const userId = request.auth?.session.user.id ?? null;
  request.log.warn({ rateClass: cls, scope, count: r.count }, 'request rate limited');
  // Audit only the first refusal of the window (count is unknown for limiters that do not report it).
  if (deps.audit !== undefined && (r.count === undefined || r.count === rule.max + 1)) {
    await deps.audit.record({
      actor: userId === null ? { type: 'anonymous' } : { type: 'user', id: userId },
      action: 'http.rate_limited',
      outcome: 'denied',
      target: `${request.method} ${request.routeOptions.url ?? '(unrouted)'}`,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      metadata: { rateClass: cls, scope, limit: rule.max, windowMs: rule.windowMs },
    });
  }
  throw refused(r);
}

/** Per-IP hook; register before the authentication hook. */
export function registerIpLimiter(app: FastifyInstance, deps: RequestLimiterDeps): void {
  app.addHook('onRequest', async (request) => {
    const cls = requestClass(request);
    const rule = deps.policy[cls].perIp;
    if (rule === null) return;
    await enforce(deps, request, cls, 'ip', request.ip, rule);
  });
}

/** Per-user hook; register after the authentication hook. */
export function registerUserLimiter(app: FastifyInstance, deps: RequestLimiterDeps): void {
  app.addHook('onRequest', async (request) => {
    const userId = request.auth?.session.user.id;
    if (userId === undefined) return;
    const cls = requestClass(request);
    let rule = deps.policy[cls].perUser;
    if (rule === null) return;
    if (deps.ownerLimits !== undefined && (cls === 'read' || cls === 'write')) {
      const max = (await deps.ownerLimits())[cls];
      if (max !== undefined) rule = { max: Math.max(1, Math.round(max)), windowMs: 60_000 };
    }
    await enforce(deps, request, cls, 'user', userId, rule);
  });
}
