import type { FastifyRequest } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { SessionRecord } from '../auth/sessions.js';
import { WAIVED_STEP_UP, type SessionStepUp } from '../auth/step-up.js';
import { HttpError } from '../http/errors.js';
import type { Authenticator, TokenAuthInfo } from '../http/route-auth.js';
import { eventForRoute, STEP_UP_EVENTS } from '../security-policy/events.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import { ipAllowed, normalizeIp } from './cidr.js';
import { bearerOf, parseToken } from './format.js';
import { scopeForAction } from './scopes.js';
import type { ApiTokenService, TokenLookup } from './service.js';
import type { TokenUsageCounter } from './usage.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §5–§7, ADR-0058): `Authorization: Bearer ryl_…` on full-session
 * routes. A request with a bearer header is judged by the token only (the cookie is ignored, no CSRF: a bearer header
 * is not an ambient credential). Everything else goes to the session authenticator unchanged.
 */

/** Failures of one (token or IP) × reason are audited once per this window; the rest are only logged. */
export const FAILURE_AUDIT_WINDOW_MS = 10 * 60_000;

/** A step-up rule nothing satisfies: a token that may not pass the route's event has no authenticator time. */
const NO_STEP_UP: SessionStepUp = { scope: 'window', maxAgeMs: 0, alwaysFreshMaxAgeMs: 0 };

export type TokenFailure =
  'malformed' | 'unknown' | 'rotated' | 'revoked' | 'expired' | 'principal_disabled' | 'ip_not_allowed';

export function invalidToken(): HttpError {
  return new HttpError(401, 'invalid_token', 'The API token is not valid.', {
    'www-authenticate': 'Bearer error="invalid_token"',
  });
}

export function tokenNotAllowed(): HttpError {
  return new HttpError(
    403,
    'token_not_allowed',
    'This endpoint is not available with an API token; use the console.',
  );
}

export function tokenScopeMissing(scope: string): HttpError {
  return new HttpError(
    403,
    'token_scope_missing',
    `This API token lacks the scope ${scope} for this endpoint.`,
    { 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}"` },
    {},
    { scope },
  );
}

export function tokenStepUpRefused(event: string): HttpError {
  return new HttpError(
    403,
    'token_step_up_refused',
    `This action asks for an authenticator code under the security policy (${event}); an API token cannot provide one.`,
    {},
    {},
    { event },
  );
}

export interface TokenAuthenticatorDeps {
  readonly tokens: ApiTokenService;
  readonly usage: TokenUsageCounter;
  readonly securityPolicy: SecurityPolicyReader;
  readonly audit: AuditRecorder;
  /** Samples failure audits (one per key per window). */
  readonly sampler: RateLimiter;
  readonly clock?: () => Date;
}

/** Wraps the session authenticator: bearer tokens on `full` routes, the session for everything else. */
export function withBearerTokens(session: Authenticator, deps: TokenAuthenticatorDeps): Authenticator {
  const now = deps.clock ?? (() => new Date());

  const audit = async (
    request: FastifyRequest,
    action: 'api_token.auth' | 'api_token.denied',
    reason: string,
    token: Pick<TokenLookup, 'id' | 'principal'> | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const key = `${token?.id ?? `ip:${request.ip}`}:${reason}`;
    // A sampler failure audits (over-auditing beats losing a failure).
    const first = await deps.sampler
      .hit('api-token-audit', key, 1, FAILURE_AUDIT_WINDOW_MS)
      .then((r) => r.allowed)
      .catch(() => true);
    const route = `${request.method} ${request.routeOptions.url ?? '(unrouted)'}`;
    if (!first) {
      request.log.info(
        { reason, route, apiTokenRef: token?.id ?? null },
        'api token refused (not audited again)',
      );
      return;
    }
    await deps.audit.record({
      actor: token === null ? { type: 'anonymous' } : { type: 'user', id: token.principal.id },
      action,
      outcome: action === 'api_token.auth' ? 'failure' : 'denied',
      target: token === null ? route : `api-token:${token.id}`,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      metadata: { reason, route, ...extra },
    });
  };

  return {
    async authenticate(request, reply, level) {
      const bearer = level === 'full' ? bearerOf(request.headers.authorization) : undefined;
      if (bearer === undefined) {
        await session.authenticate(request, reply, level);
        return;
      }
      const t = now();
      const kind = parseToken(bearer);
      if (kind === null) {
        await audit(request, 'api_token.auth', 'malformed', null);
        throw invalidToken();
      }
      const found = await deps.tokens.lookup(bearer);
      if (found === null || found.kind !== kind) {
        await audit(request, 'api_token.auth', 'unknown', null);
        throw invalidToken();
      }
      const fail = async (reason: TokenFailure, err: HttpError): Promise<never> => {
        await audit(request, 'api_token.auth', reason, found);
        throw err;
      };
      if (found.revokedAt !== null) {
        await fail('revoked', new HttpError(401, 'token_revoked', 'This API token was revoked.'));
      }
      if (found.previousUntil !== null && found.previousUntil <= t) await fail('rotated', invalidToken());
      if (found.expiresAt <= t) {
        await fail('expired', new HttpError(401, 'token_expired', 'This API token has expired.'));
      }
      const wantPrincipal = found.kind === 'personal' ? 'human' : 'service';
      if (found.principal.kind !== wantPrincipal) await fail('unknown', invalidToken());
      if (found.principal.disabled) {
        await fail(
          'principal_disabled',
          new HttpError(401, 'principal_disabled', 'The account of this API token is disabled.'),
        );
      }
      if (!ipAllowed(request.ip, found.allowedCidrs)) {
        await fail(
          'ip_not_allowed',
          new HttpError(403, 'ip_not_allowed', 'This API token may not be used from this address.'),
        );
      }

      const config = request.routeOptions.config as {
        authz?: { action?: string };
        rateClass?: string;
        stepUpClass?: 'standard' | 'always-fresh';
      };
      const action = config.authz?.action;
      const deny = async (
        reason: string,
        err: HttpError,
        extra: Record<string, unknown> = {},
      ): Promise<never> => {
        await audit(request, 'api_token.denied', reason, found, { authz: action ?? null, ...extra });
        throw err;
      };
      if (!request.is404) {
        // Session-only routes (and SSE streams: poll instead) are never reachable with a token.
        const scope = scopeForAction(action);
        if (scope === null || config.rateClass === 'stream') await deny('session_only', tokenNotAllowed());
        else if (!found.scopes.includes(scope)) await deny('scope', tokenScopeMissing(scope), { scope });
      }

      // Step-up (§6): a token is a session that never entered a code. An event the policy waives passes as for
      // everyone; an event that asks passes only by an explicit grant (policy switch on, never the safe core).
      const url = request.routeOptions.url;
      const event = url === undefined ? undefined : eventForRoute(request.method, url, action);
      let passes = false;
      if (event !== undefined && event !== 'dynamic') {
        const policy = await deps.securityPolicy.current();
        passes =
          !policy.events[event] ||
          (policy.apiTokens.eventGrants &&
            !STEP_UP_EVENTS[event].core &&
            found.grantedEvents.includes(event));
      }
      if (config.stepUpClass !== undefined && !passes) {
        const name = event === undefined || event === 'dynamic' ? 'unmapped' : event;
        await deny('step_up', tokenStepUpRefused(name), { event: name });
      }

      const sessionView: SessionRecord = {
        idHash: Buffer.alloc(32),
        stage: 'full',
        csrfHash: Buffer.alloc(32),
        createdAt: t,
        lastSeenAt: t,
        expiresAt: found.expiresAt,
        mfaAt: passes ? t : null,
        mfaFailures: 0,
        remember: false,
        idleTimeoutMs: 0,
        trustedDeviceId: null,
        user: { id: found.principal.id, username: found.principal.username, role: found.principal.role },
      };
      const token: TokenAuthInfo = {
        id: found.id,
        kind: found.kind,
        name: found.name,
        principalId: found.principal.id,
        scopes: found.scopes,
        grantedEvents: found.grantedEvents,
      };
      request.auth = {
        session: sessionView,
        stepUp: passes ? WAIVED_STEP_UP : NO_STEP_UP,
        ...(event === undefined ? {} : { stepUpEvent: event }),
        realMfaAt: null,
        token,
      };
      deps.usage.record(found.id, t, normalizeIp(request.ip));
    },
  };
}
