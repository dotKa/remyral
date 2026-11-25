import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { type Authenticator, unauthorized } from '../http/route-auth.js';
import type { IssuedDevice } from './service.js';
import { type IssuedSession, sessions, sha256 } from './sessions.js';
import { eventForRoute } from '../security-policy/events.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import {
  DEFAULT_STEP_UP_POLICY,
  maxAgeFor,
  policyStepUp,
  sessionStepUp,
  WAIVED_STEP_UP,
  type StepUpClass,
  stepUpFreshAt,
  type StepUpPolicy,
} from './step-up.js';
import { DEVICE_COOKIE } from './trusted-devices.js';

/** `__Host-` prefix: browser enforces Secure, Path=/ and no Domain attribute. */
export const SESSION_COOKIE = '__Host-ras';
export const CSRF_COOKIE = '__Host-ras-csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function setSessionCookies(reply: FastifyReply, issued: IssuedSession, now: Date): void {
  const maxAge = Math.max(1, Math.floor((issued.expiresAt.getTime() - now.getTime()) / 1000));
  const base = { secure: true, sameSite: 'strict' as const, path: '/', maxAge };
  void reply.setCookie(SESSION_COOKIE, issued.token, { ...base, httpOnly: true });
  // Readable by the web app so it can echo it in the X-CSRF-Token header (double submit).
  void reply.setCookie(CSRF_COOKIE, issued.csrfToken, { ...base, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply): void {
  const base = { secure: true, sameSite: 'strict' as const, path: '/' };
  void reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  void reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}

/**
 * p5-remember-device: the trusted-device cookie. Same flags as the session cookie; Max-Age = remaining
 * lifetime of the trust. It is only read by `POST /auth/login` and the device routes.
 */
export function setDeviceCookie(reply: FastifyReply, device: IssuedDevice, now: Date): void {
  const maxAge = Math.max(1, Math.floor((device.expiresAt.getTime() - now.getTime()) / 1000));
  void reply.setCookie(DEVICE_COOKIE, device.token, {
    secure: true,
    sameSite: 'strict',
    path: '/',
    httpOnly: true,
    maxAge,
  });
}

export function clearDeviceCookie(reply: FastifyReply): void {
  void reply.clearCookie(DEVICE_COOKIE, { secure: true, sameSite: 'strict', path: '/', httpOnly: true });
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `requireAuth`: resolves the session cookie for every non-public route, checks that the session is in
 * the stage the route needs (a pending login can never reach a `full` route) and, for state-changing
 * methods, validates the CSRF double-submit token (header == cookie == hash stored with the session).
 */
export function createSessionAuthenticator(deps: {
  pool: Pool;
  audit: AuditRecorder;
  clock?: () => Date;
  /** p5-stepup-window: step-up windows per session type (default 10 min / long-lived: whole session). */
  stepUp?: StepUpPolicy;
  /**
   * p15-autonomy (ADR-0056): the security policy — its step-up settings replace the server's where set, and a route
   * whose event it does not protect is waived. Absent: the server's step-up policy for every route (as before).
   */
  securityPolicy?: SecurityPolicyReader;
}): Authenticator {
  const stepUpPolicy = deps.stepUp ?? DEFAULT_STEP_UP_POLICY;
  const now = deps.clock ?? (() => new Date());
  return {
    async authenticate(request, _reply, level) {
      const token = request.cookies[SESSION_COOKIE];
      if (!token) throw unauthorized();
      const t = now();
      const session = await sessions.find(deps.pool, token, t);
      // p9-stepup-rotation-logout: an unknown/expired id is answered with a plain 401 and NO clearing
      // Set-Cookie. The id may simply be one a step-up rotated away while this request (another tab, a poll,
      // a stream reconnect, a double submit) was already on its way; clearing the cookie here deleted the
      // browser's NEW session cookie and signed the user out minutes later. A dead cookie is harmless (it
      // grants nothing and expires by Max-Age); logout and logout-all still clear the cookies explicitly.
      if (!session) throw unauthorized();
      if (session.stage !== level) throw unauthorized();

      if (!SAFE_METHODS.has(request.method)) {
        const header = request.headers[CSRF_HEADER];
        const cookie = request.cookies[CSRF_COOKIE];
        const valid =
          typeof header === 'string' &&
          typeof cookie === 'string' &&
          safeEqual(Buffer.from(header), Buffer.from(cookie)) &&
          safeEqual(sha256(header), session.csrfHash);
        if (!valid) {
          await deps.audit.record({
            actor: { type: 'user', id: session.user.id },
            action: 'auth.csrf',
            outcome: 'denied',
            target: `${request.method} ${request.routeOptions.url ?? request.url}`,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
          throw new HttpError(403, 'csrf_failed', 'CSRF validation failed.');
        }
      }

      if (deps.securityPolicy === undefined || level !== 'full') {
        request.auth = { session, stepUp: sessionStepUp(session, stepUpPolicy) };
      } else {
        const policy = await deps.securityPolicy.current();
        const config = request.routeOptions.config as { authz?: { action?: string } } | undefined;
        const url = request.routeOptions.url;
        const event =
          url === undefined ? undefined : eventForRoute(request.method, url, config?.authz?.action);
        if (event !== undefined && event !== 'dynamic' && !policy.events[event]) {
          // Waived: the request passes every step-up check behind this route (services re-check `mfaAt`).
          request.auth = {
            session: { ...session, mfaAt: t },
            stepUp: WAIVED_STEP_UP,
            stepUpEvent: event,
            realMfaAt: session.mfaAt,
          };
        } else {
          request.auth = {
            session,
            stepUp: policyStepUp(session, stepUpPolicy, policy.stepUp),
            ...(event === undefined ? {} : { stepUpEvent: event }),
          };
        }
      }
      await sessions.touch(deps.pool, session, t);
    },
  };
}

const STEP_UP_CLASS = Symbol('stepUpClass');

/** The step-up class of a `requireStepUp` hook (for the route registry), undefined for other functions. */
export function stepUpClassOf(fn: unknown): StepUpClass | undefined {
  if (typeof fn !== 'function') return undefined;
  return (fn as { [STEP_UP_CLASS]?: StepUpClass })[STEP_UP_CLASS];
}

export function stepUpRequiredError(): HttpError {
  return new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.');
}

/**
 * The request's session satisfies a step-up of class `cls` at `now` (ADR-0009 §10, p5-stepup-window): the
 * session's own rule (standard window, or the whole session for remember-me / trusted-device sessions);
 * always-fresh actions need a TOTP from the last 10 minutes on every session type.
 */
export function requestStepUpFresh(
  request: FastifyRequest,
  now: Date,
  cls: StepUpClass = 'standard',
): boolean {
  const auth = request.auth;
  if (!auth) return false;
  return stepUpFreshAt(auth.session.mfaAt, now, maxAgeFor(auth.stepUp, cls));
}

/** Accepted step-up age for the request's session (for services that re-check `mfaAt` themselves). */
export function requestStepUpMaxAge(
  request: FastifyRequest,
  cls: StepUpClass = 'standard',
): number | undefined {
  const auth = request.auth;
  return auth ? maxAgeFor(auth.stepUp, cls) : undefined;
}

/**
 * `requireStepUp()`: privileged routes need a TOTP verification within the session's step-up window;
 * `requireStepUp('always-fresh')` for account-security routes (ALWAYS_FRESH_ROUTES in step-up.ts).
 */
export function requireStepUp(
  cls: StepUpClass = 'standard',
  clock: () => Date = () => new Date(),
): preHandlerAsyncHookHandler {
  const hook = async function stepUpHook(request: FastifyRequest) {
    if (!requestStepUpFresh(request, clock(), cls)) throw stepUpRequiredError();
    await Promise.resolve();
  };
  Object.defineProperty(hook, STEP_UP_CLASS, { value: cls });
  return hook;
}

/**
 * The step-up fields of a service actor (`mfaAt` + the session's accepted age), for services that check
 * the step-up themselves inside their transaction (context, usage, approvals, skills, search).
 */
export function stepUpFields(request: FastifyRequest): {
  mfaAt: Date | null;
  stepUpMaxAgeMs?: number;
  alwaysFreshMaxAgeMs?: number;
} {
  const auth = request.auth;
  if (!auth) return { mfaAt: null };
  return {
    mfaAt: auth.session.mfaAt,
    stepUpMaxAgeMs: auth.stepUp.maxAgeMs,
    alwaysFreshMaxAgeMs: auth.stepUp.alwaysFreshMaxAgeMs,
  };
}

/**
 * p15-autonomy: the session's actual step-up (not the waived request view) — for work that outlives the request and
 * is judged per action later (the assistant's direct actions, judged by each card's own event).
 */
export function realStepUpFields(request: FastifyRequest): {
  mfaAt: Date | null;
  stepUpMaxAgeMs?: number;
  alwaysFreshMaxAgeMs?: number;
} {
  const auth = request.auth;
  if (!auth) return { mfaAt: null };
  if (auth.stepUp.waived === true) return { mfaAt: auth.realMfaAt ?? null };
  return stepUpFields(request);
}
