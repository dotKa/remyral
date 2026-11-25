import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRecord } from '../auth/sessions.js';
import type { SessionStepUp } from '../auth/step-up.js';
import { HttpError } from './errors.js';

export function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Authentication required.');
}

/**
 * Per-route authentication level, declared in the route's `config.auth`. Routes that do not declare one
 * get `full` (secure by default): a session that passed password **and** TOTP (ADR-0009).
 *
 * - `public`      — /healthz, /readyz, /status (public uptime probe), POST /auth/login only.
 * - `mfa_pending` — second login step (password accepted, TOTP or recovery code outstanding).
 * - `enrollment`  — password accepted for an account without TOTP; only enrollment is reachable.
 * - `password_change` — both factors passed for an account created with a temporary password; only the
 *                   forced password change is reachable (p5-self-password).
 * - `device`      — `GET /v1/worker` only: the worker WebSocket. It is not reachable with a human session
 *                   and does not need one: the device authenticates in-band (HELLO → CHALLENGE → AUTH with
 *                   its Ed25519 key, ADR-0005) and an unauthenticated socket can send nothing but HELLO/AUTH
 *                   (docs/design/p2-transport.md). Plain HTTP requests to it get 426.
 *                   Also `GET /v1/worker/releases/:version/{manifest,artifact}` (p2-signed-updates): the
 *                   worker presents the single-worker, single-release download token it received over its
 *                   authenticated WebSocket; without a valid token the answer is 401.
 * - `full`        — everything else.
 */
export type RouteAuth = 'public' | 'device' | 'mfa_pending' | 'enrollment' | 'password_change' | 'full';

export interface AuthContext {
  readonly session: SessionRecord;
  /** p5-stepup-window: the step-up rule of this session (window or whole session). */
  readonly stepUp: SessionStepUp;
  /**
   * p15-autonomy (ADR-0056): the step-up event of this request's route (`dynamic` for the chat card confirmation;
   * absent: none). When the security policy does not protect it, `stepUp.waived` is set and `session.mfaAt` is the
   * request time (so every check behind the route passes); `realMfaAt` keeps the session's actual step-up time.
   */
  readonly stepUpEvent?: string;
  readonly realMfaAt?: Date | null;
  /**
   * p16-api-tokens (ADR-0058): set when the request was authenticated by `Authorization: Bearer ryl_…` instead of a
   * session cookie. `session` is then a session-shaped view of the token's principal (never a stored session).
   */
  readonly token?: TokenAuthInfo;
}

/** p16-api-tokens: the token a request was authenticated with (no secret). */
export interface TokenAuthInfo {
  readonly id: string;
  readonly kind: 'personal' | 'service';
  readonly name: string;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly grantedEvents: readonly string[];
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
    /**
     * p16-api-tokens: the class of the route's `requireStepUp` preHandler, copied here by the route registry (app.ts)
     * so the bearer authenticator knows the route asks for a code before its preHandlers run.
     */
    stepUpClass?: 'standard' | 'always-fresh';
  }
  interface FastifyRequest {
    /** Set by the authenticator for every non-public route; null on public routes. */
    auth: AuthContext | null;
  }
}

export interface Authenticator {
  /**
   * Called from a global `onRequest` hook for every route that is not `public`. Must throw an
   * `HttpError` (401/403) when the request does not satisfy `level`; may decorate the request.
   */
  authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    level: Exclude<RouteAuth, 'public' | 'device'>,
  ): Promise<void>;
}

/** Used until an authenticator is wired in: every non-public route is rejected. */
export const denyAllAuthenticator: Authenticator = {
  authenticate() {
    return Promise.reject(unauthorized());
  },
};

export function routeAuthLevel(request: FastifyRequest): RouteAuth {
  return request.routeOptions.config.auth ?? 'full';
}
