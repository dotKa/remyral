import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_LOCALE, type Locale } from '@remyral/i18n';
import { z } from 'zod';
import { unauthorized } from '../http/route-auth.js';
import type { AuthzRule } from '../http/route-authz.js';
import {
  clearDeviceCookie,
  clearSessionCookies,
  requireStepUp,
  SESSION_COOKIE,
  setDeviceCookie,
  setSessionCookies,
} from './hooks.js';
import { type AuthService, type LoginStepResult, publicUser, type RequestContext } from './service.js';
import { idleExpiry, type IssuedSession, type SessionRecord } from './sessions.js';
import { stepUpStatus } from './step-up.js';
import { DEVICE_COOKIE } from './trusted-devices.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const Code = z.string().min(1).max(64);
const User = z.object({ id: z.string(), username: z.string(), role: z.string() });
/**
 * After the second factor: `authenticated` (full session) or `password_change_required` (the account still
 * holds a temporary password; only POST /auth/password/initial is reachable, p5-self-password).
 */
const Authenticated = z.object({
  status: z.enum(['authenticated', 'password_change_required']),
  csrfToken: z.string(),
  user: User,
});
const NewPassword = z.string().min(1).max(1024);
const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 429: ErrorBody };
/**
 * p9-stepup-rotation-logout: a failed step-up says why (`replayed_totp`: this code was already used — wait
 * for the next one) and how many wrong codes the session still has; `sessionTerminated`: it was ended.
 * Absent on a 401 that is not a code failure (session gone, account locked).
 */
const StepUpFailure = ErrorBody.extend({
  reason: z.enum(['bad_totp', 'replayed_totp']).optional(),
  attemptsRemaining: z.number().int().optional(),
  sessionTerminated: z.boolean().optional(),
});
/**
 * p5-stepup-window: `window` = a step-up is valid until `stepUpValidUntil`; `session` = one TOTP holds for
 * the rest of this remember-me / trusted-device session (`stepUpValidUntil` is then the session's end).
 */
const StepUpScope = z.enum(['window', 'session']);

/** The caller's own session: always the subject's own resource (p5-rbac `session.self`). */
const SELF: AuthzRule = {
  action: 'session.self',
  resource: (request) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

function context(request: FastifyRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function statusOf(issued: IssuedSession): 'authenticated' | 'password_change_required' {
  return issued.stage === 'password_change' ? 'password_change_required' : 'authenticated';
}

/** Sets the session cookies and the device cookie as the login step decided (p5-remember-device). */
function applyLoginCookies(reply: FastifyReply, result: LoginStepResult, now: Date): void {
  setSessionCookies(reply, result.session, now);
  if (result.device) setDeviceCookie(reply, result.device, now);
  else if (result.clearDevice) clearDeviceCookie(reply);
}

const DAY_MS = 24 * 60 * 60_000;
const TrustDevice = z.boolean().optional();

function sessionOf(request: FastifyRequest): SessionRecord {
  const s = request.auth?.session;
  if (!s) throw unauthorized(); // unreachable: the auth hook ran before the handler
  return s;
}

/** JSON auth API (ADR-0009). The UI lives in apps/web. */
export function authRoutes(
  service: AuthService,
  clock: () => Date = () => new Date(),
  /** p14-i18n-foundation: the user's effective console language for `GET /auth/session` (default: Turkish). */
  localeOf: (userId: string) => Promise<Locale> = () => Promise.resolve(DEFAULT_LOCALE),
  /** p14-workflow-engine 14.1: server capabilities the console adapts to (`GET /auth/session` → `features`). */
  features: () => { workflowEngineV2: boolean } = () => ({ workflowEngineV2: false }),
  /**
   * p15-autonomy (ADR-0056): events the security policy does not protect (`GET /auth/session` → `stepUpWaived`), so
   * the console does not ask for a code up front where the master would not.
   */
  waivedEvents: () => Promise<readonly string[]> = () => Promise.resolve([]),
  /** p17-remyral-brand: the user's console colour theme (`GET /auth/session` → `theme`; default: follow the device). */
  themeOf: (userId: string) => Promise<'light' | 'dark' | 'system'> = () => Promise.resolve('system'),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['auth'];
    const csrf = [{ session: [], csrf: [] }];

    r.post(
      '/auth/login',
      {
        config: { auth: 'public' },
        schema: {
          tags,
          summary:
            'Step 1: username + password (optional "remember me"); a trusted device skips the code step',
          body: z.object({
            username: z.string().min(1).max(64),
            password: z.string().min(1).max(1024),
            remember: z.boolean().optional(),
          }),
          response: {
            200: z.object({
              status: z.enum(['mfa_required', 'enrollment_required', 'authenticated']),
              csrfToken: z.string(),
              // Only with `authenticated` (trusted device, p5-remember-device).
              user: User.optional(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const result = await service.login(
          request.body.username,
          request.body.password,
          context(request),
          request.cookies[SESSION_COOKIE],
          {
            ...(request.body.remember === undefined ? {} : { remember: request.body.remember }),
            deviceToken: request.cookies[DEVICE_COOKIE],
          },
        );
        applyLoginCookies(reply, result, clock());
        const issued = result.session;
        if (issued.stage === 'full') {
          return {
            status: 'authenticated' as const,
            csrfToken: issued.csrfToken,
            ...(result.user ? { user: publicUser(result.user) } : {}),
          };
        }
        return {
          status:
            issued.stage === 'mfa_pending' ? ('mfa_required' as const) : ('enrollment_required' as const),
          csrfToken: issued.csrfToken,
        };
      },
    );

    r.get(
      '/auth/options',
      {
        config: { auth: 'public' },
        schema: {
          tags,
          summary: 'Login options enabled on this master (remember me, trusted devices); no account data',
          response: {
            200: z.object({
              rememberMe: z.object({ idleDays: z.number(), absoluteDays: z.number() }).nullable(),
              trustedDevice: z.object({ days: z.number() }).nullable(),
            }),
          },
        },
      },
      () => {
        const o = service.options();
        return {
          rememberMe: o.remember
            ? { idleDays: o.remember.idleMs / DAY_MS, absoluteDays: o.remember.absoluteMs / DAY_MS }
            : null,
          trustedDevice: o.trustedDeviceMs === null ? null : { days: o.trustedDeviceMs / DAY_MS },
        };
      },
    );

    r.post(
      '/auth/totp/verify',
      {
        config: { auth: 'mfa_pending' },
        schema: {
          tags,
          summary: 'Step 2: TOTP code (optional "trust this device")',
          security: csrf,
          body: z.object({ code: Code, trustDevice: TrustDevice }),
          response: { 200: Authenticated, ...errors },
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const result = await service.verifyTotp(session, request.body.code, context(request), {
          trustDevice: request.body.trustDevice === true,
        });
        applyLoginCookies(reply, result, clock());
        return {
          status: statusOf(result.session),
          csrfToken: result.session.csrfToken,
          user: publicUser(session.user),
        };
      },
    );

    r.post(
      '/auth/recovery',
      {
        config: { auth: 'mfa_pending' },
        schema: {
          tags,
          summary: 'Step 2 (alternative): single-use recovery code (optional "trust this device")',
          security: csrf,
          body: z.object({ code: Code, trustDevice: TrustDevice }),
          response: { 200: Authenticated.extend({ remainingRecoveryCodes: z.number().int() }), ...errors },
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const result = await service.recover(session, request.body.code, context(request), {
          trustDevice: request.body.trustDevice === true,
        });
        applyLoginCookies(reply, result, clock());
        return {
          status: statusOf(result.session),
          csrfToken: result.session.csrfToken,
          user: publicUser(session.user),
          remainingRecoveryCodes: result.remainingRecoveryCodes,
        };
      },
    );

    r.post(
      '/auth/totp/enroll/start',
      {
        config: { auth: 'enrollment' },
        schema: {
          tags,
          summary: 'Mandatory TOTP enrollment: new secret, otpauth URI and QR code (SVG)',
          security: csrf,
          response: {
            200: z.object({ otpauthUri: z.string(), secret: z.string(), qrSvg: z.string() }),
            ...errors,
          },
        },
      },
      async (request) => service.enrollStart(sessionOf(request), context(request)),
    );

    r.post(
      '/auth/totp/enroll/confirm',
      {
        config: { auth: 'enrollment' },
        schema: {
          tags,
          summary: 'Confirm enrollment with a code; returns 10 recovery codes once',
          security: csrf,
          body: z.object({ code: Code }),
          response: { 200: Authenticated.extend({ recoveryCodes: z.array(z.string()) }), ...errors },
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const result = await service.enrollConfirm(session, request.body.code, context(request));
        setSessionCookies(reply, result.session, clock());
        return {
          status: statusOf(result.session),
          csrfToken: result.session.csrfToken,
          user: publicUser(session.user),
          recoveryCodes: result.recoveryCodes,
        };
      },
    );

    r.post(
      '/auth/step-up',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary:
            'Fresh TOTP for privileged actions (standard window, or the rest of a remember-me / trusted-device session)',
          security: csrf,
          body: z.object({ code: Code }),
          response: {
            200: z.object({
              stepUpValidUntil: z.string(),
              stepUpScope: StepUpScope,
              alwaysFreshValidUntil: z.string(),
              csrfToken: z.string(),
            }),
            ...errors,
            401: StepUpFailure,
          },
        },
      },
      async (request, reply) => {
        const result = await service.stepUp(sessionOf(request), request.body.code, context(request));
        // The session id and CSRF token rotate (privilege change); the cookies carry the new ones.
        setSessionCookies(reply, result.session, clock());
        const st = result.status;
        return {
          stepUpValidUntil: (st.validUntil ?? clock()).toISOString(),
          stepUpScope: st.scope,
          alwaysFreshValidUntil: (st.alwaysFreshValidUntil ?? clock()).toISOString(),
          csrfToken: result.session.csrfToken,
        };
      },
    );

    r.post(
      '/auth/password/initial',
      {
        config: { auth: 'password_change' },
        schema: {
          tags,
          summary: 'Replace a temporary password (required before anything else); issues the full session',
          security: csrf,
          body: z.object({ newPassword: NewPassword }),
          response: {
            200: z.object({ status: z.literal('authenticated'), csrfToken: z.string(), user: User }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const issued = await service.completeRequiredPasswordChange(
          session,
          request.body.newPassword,
          context(request),
        );
        setSessionCookies(reply, issued, clock());
        return {
          status: 'authenticated' as const,
          csrfToken: issued.csrfToken,
          user: publicUser(session.user),
        };
      },
    );

    r.post(
      '/auth/password',
      {
        config: { authz: SELF },
        // Always fresh (p5-stepup-window): a TOTP from the last 10 minutes on every session type, so a stolen
        // session alone — remembered or not — cannot change the password (ADR-0009 §10).
        preHandler: requireStepUp('always-fresh', clock),
        schema: {
          tags,
          summary: 'Change one’s own password; ends every other session and rotates this one',
          security: csrf,
          body: z.object({ currentPassword: NewPassword, newPassword: NewPassword }),
          response: { 200: z.object({ status: z.literal('changed'), csrfToken: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const issued = await service.changePassword(
          sessionOf(request),
          request.body.currentPassword,
          request.body.newPassword,
          context(request),
        );
        setSessionCookies(reply, issued, clock());
        return { status: 'changed' as const, csrfToken: issued.csrfToken };
      },
    );

    r.post(
      '/auth/logout',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'End this session',
          security: csrf,
          response: { 200: z.object({ status: z.literal('logged_out') }), ...errors },
        },
      },
      async (request, reply) => {
        await service.logout(sessionOf(request), context(request));
        clearSessionCookies(reply);
        return { status: 'logged_out' as const };
      },
    );

    r.post(
      '/auth/logout-all',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'End every session of this user and revoke every trusted device ("log out everywhere")',
          security: csrf,
          response: {
            200: z.object({ status: z.literal('logged_out'), revokedSessions: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const n = await service.logoutAll(sessionOf(request), context(request));
        clearSessionCookies(reply);
        clearDeviceCookie(reply); // every device trust was revoked
        return { status: 'logged_out' as const, revokedSessions: n };
      },
    );

    r.get(
      '/auth/session',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Current user and session timing',
          security: [{ session: [] }],
          response: {
            200: z.object({
              user: User,
              // p14-i18n-foundation (ADR-0053): the console language (the user's choice, else Turkish).
              locale: z.enum(['tr', 'en']),
              // p17-remyral-brand: the colour theme (system = follow prefers-color-scheme).
              theme: z.enum(['light', 'dark', 'system']),
              // p14-workflow-engine 14.1: server capabilities (the workflow editor offers the new node types only
              // when the new engine is on).
              features: z.object({ workflowEngineV2: z.boolean() }),
              session: z.object({
                createdAt: z.string(),
                expiresAt: z.string(),
                idleExpiresAt: z.string(),
                mfaAt: z.string().nullable(),
                stepUpValidUntil: z.string().nullable(),
                // p5-stepup-window: `session` = one TOTP holds for the rest of this session.
                stepUpScope: StepUpScope,
                // Account-security actions (always fresh) pass without a code until then.
                alwaysFreshValidUntil: z.string().nullable(),
                // p5-remember-device: "remembered" = Remember me (longer idle/absolute lifetime).
                type: z.enum(['standard', 'remembered']),
                // p15-autonomy: step-up events that pass without a code under the security policy.
                stepUpWaived: z.array(z.string()),
              }),
            }),
            401: ErrorBody,
          },
        },
      },
      async (request) => {
        const s = sessionOf(request);
        const auth = request.auth;
        if (!auth) throw unauthorized();
        const st = stepUpStatus(s, clock(), auth.stepUp);
        return {
          user: publicUser(s.user),
          locale: await localeOf(s.user.id),
          theme: await themeOf(s.user.id),
          features: features(),
          session: {
            createdAt: s.createdAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
            idleExpiresAt: idleExpiry({ ...s, lastSeenAt: clock() }).toISOString(),
            mfaAt: s.mfaAt?.toISOString() ?? null,
            stepUpValidUntil: st.validUntil?.toISOString() ?? null,
            stepUpScope: st.scope,
            alwaysFreshValidUntil: st.alwaysFreshValidUntil?.toISOString() ?? null,
            type: s.remember ? ('remembered' as const) : ('standard' as const),
            stepUpWaived: [...(await waivedEvents())],
          },
        };
      },
    );

    // ------------------------------------------------------------ trusted devices (p5-remember-device)

    const Device = z.object({
      id: z.string(),
      label: z.string(),
      createdAt: z.string(),
      lastUsedAt: z.string(),
      expiresAt: z.string(),
      createdIp: z.string().nullable(),
      /** This browser's device. */
      current: z.boolean(),
    });

    r.get(
      '/auth/devices',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Trusted devices of the current user',
          security: [{ session: [] }],
          response: { 200: z.object({ devices: z.array(Device) }), 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request) => {
        const devices = await service.listDevices(sessionOf(request), request.cookies[DEVICE_COOKIE]);
        return {
          devices: devices.map((d) => ({
            id: d.id,
            label: d.label,
            createdAt: d.createdAt.toISOString(),
            lastUsedAt: d.lastUsedAt.toISOString(),
            expiresAt: d.expiresAt.toISOString(),
            createdIp: d.createdIp,
            current: d.current,
          })),
        };
      },
    );

    r.delete(
      '/auth/devices/:id',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Revoke one trusted device (the code step is required again on it)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: z.object({ status: z.literal('revoked') }), 404: ErrorBody, ...errors },
        },
      },
      async (request, reply) => {
        const r = await service.revokeDevice(
          sessionOf(request),
          request.params.id,
          request.cookies[DEVICE_COOKIE],
          context(request),
        );
        if (r.current) clearDeviceCookie(reply);
        return { status: 'revoked' as const };
      },
    );

    r.post(
      '/auth/devices/revoke-all',
      {
        config: { authz: SELF },
        // Always fresh (p5-stepup-window): an account-security action. "Log out everywhere" (no step-up)
        // remains the kill switch that also revokes every device.
        preHandler: requireStepUp('always-fresh', clock),
        schema: {
          tags,
          summary: 'Revoke every trusted device of the current user',
          security: csrf,
          response: {
            200: z.object({ status: z.literal('revoked'), revoked: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const n = await service.revokeAllDevices(sessionOf(request), context(request));
        clearDeviceCookie(reply);
        return { status: 'revoked' as const, revoked: n };
      },
    );
  };
}
