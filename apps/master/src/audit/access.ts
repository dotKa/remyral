import type { FastifyRequest } from 'fastify';
import type { RateLimiter } from '../auth/rate-limit.js';
import { requestStepUpFresh } from '../auth/hooks.js';
import type { SessionRecord } from '../auth/sessions.js';
import type { Role } from '../auth/users.js';
import { HttpError } from '../http/errors.js';
import { unauthorized } from '../http/route-auth.js';
import type { AuditRecorder } from './audit.js';

/**
 * Per-handler authorization for the read/export APIs (docs/design/p5-search-audit.md §2): role, then
 * step-up, then rate limit. Denials of privileged routes are written to the audit log before the error is
 * returned.
 */

export interface RateRule {
  readonly max: number;
  readonly windowMs: number;
}

export interface AccessLimits {
  /** Exports per user (audit and job exports share the bucket). */
  readonly export: RateRule;
  /** Chain verifications per user. */
  readonly verify: RateRule;
}

export const DEFAULT_ACCESS_LIMITS: AccessLimits = {
  export: { max: 20, windowMs: 10 * 60_000 },
  verify: { max: 10, windowMs: 60_000 },
};

export interface AccessCheck {
  /**
   * Optional extra role gate. Since p5-rbac the route's central `config.authz` rule decides roles; this
   * remains for callers outside that hook.
   */
  readonly roles?: readonly Role[];
  readonly stepUp?: boolean;
  readonly rateLimit?: { readonly bucket: keyof AccessLimits };
  /** Audit action for denials (omit to not audit denials, e.g. ordinary reads). */
  readonly deniedAction?: string;
  readonly target?: string | null;
}

export const ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];
export const OPERATOR_ROLES: readonly Role[] = ['owner', 'admin', 'operator'];
export const ALL_ROLES: readonly Role[] = ['owner', 'admin', 'operator', 'viewer'];

export function sessionOf(request: FastifyRequest): SessionRecord {
  const s = request.auth?.session;
  if (!s) throw unauthorized(); // unreachable: the global auth hook ran first
  return s;
}

export function requestMeta(request: FastifyRequest): { ip: string; userAgent: string | null } {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export class AccessGate {
  constructor(
    private readonly deps: {
      readonly audit: AuditRecorder;
      readonly limiter: RateLimiter;
      readonly clock: () => Date;
      readonly limits?: AccessLimits;
    },
  ) {}

  private get limits(): AccessLimits {
    return this.deps.limits ?? DEFAULT_ACCESS_LIMITS;
  }

  async check(request: FastifyRequest, check: AccessCheck): Promise<SessionRecord> {
    const session = sessionOf(request);
    const deny = async (reason: string, err: HttpError): Promise<never> => {
      if (check.deniedAction) {
        await this.deps.audit.record({
          actor: { type: 'user', id: session.user.id },
          action: check.deniedAction,
          target: check.target ?? null,
          outcome: 'denied',
          ...requestMeta(request),
          metadata: { reason, role: session.user.role },
        });
      }
      throw err;
    };

    if (check.roles !== undefined && !check.roles.includes(session.user.role)) {
      await deny(
        'role',
        new HttpError(403, 'forbidden', 'Your role does not allow this.', {}, {}, { reason: 'role' }),
      );
    }
    if (check.stepUp) {
      if (!requestStepUpFresh(request, this.deps.clock())) {
        await deny(
          'step_up_required',
          new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.'),
        );
      }
    }
    if (check.rateLimit) {
      const rule = this.limits[check.rateLimit.bucket];
      const res = await this.deps.limiter.hit(
        `read-${check.rateLimit.bucket}`,
        session.user.id,
        rule.max,
        rule.windowMs,
      );
      if (!res.allowed) {
        await deny(
          'rate_limited',
          new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
            'retry-after': String(Math.ceil(res.retryAfterMs / 1000)),
          }),
        );
      }
    }
    return session;
  }
}
