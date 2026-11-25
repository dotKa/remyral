import { isLocale, type Locale } from '@remyral/i18n';
import { ApiError, apiRequest, int, nullableStr, obj, type RequestOptions, str, strArray } from './client';

/**
 * Typed wrappers for the master's auth routes (apps/master/src/auth/routes.ts). Response bodies are
 * checked structurally; the csrfToken in bodies is ignored because the cookie is the single source.
 */

export interface User {
  readonly id: string;
  readonly username: string;
  readonly role: string;
}

export type StepUpScope = 'window' | 'session';

export interface StepUpResult {
  readonly stepUpValidUntil: string;
  readonly stepUpScope: StepUpScope;
}

function scopeOf(v: unknown): StepUpScope {
  // Older masters do not send it: a fixed window.
  return v === 'session' ? 'session' : 'window';
}

export interface SessionInfo {
  readonly user: User;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly mfaAt: string | null;
  readonly stepUpValidUntil: string | null;
  /**
   * p5-stepup-window: `session` = one TOTP holds for the rest of this (remember-me / trusted-device)
   * session; `window` = until `stepUpValidUntil`.
   */
  readonly stepUpScope: StepUpScope;
  /** Account-security actions (always fresh, 10 min) pass without a code until then. */
  readonly alwaysFreshValidUntil: string | null;
  /** p5-remember-device: `remembered` = signed in with "Remember me" (longer lifetime). */
  readonly type: 'standard' | 'remembered';
  /**
   * p15-autonomy (ADR-0056): step-up events the security policy does not protect — the console then sends at once
   * instead of asking for a code first. Absent from an older master: none.
   */
  readonly stepUpWaived?: readonly string[];
  /**
   * p14-i18n-foundation (ADR-0053): the user's console language (their choice, else Turkish). Absent from an
   * older master — the console then keeps the browser's language.
   */
  readonly locale?: Locale;
  /** p17-remyral-brand: the account's colour theme (absent from an older master: this browser's choice stays). */
  readonly theme?: 'light' | 'dark' | 'system';
  /** p14-workflow-engine 14.1: capabilities of this master (absent from older masters: every flag off). */
  readonly features?: { readonly workflowEngineV2: boolean };
}

/** Login options enabled on the master (GET /auth/options); `null` = feature off. */
export interface LoginOptions {
  readonly rememberMe: { readonly idleDays: number; readonly absoluteDays: number } | null;
  readonly trustedDevice: { readonly days: number } | null;
}

/** A trusted device of the current user (GET /auth/devices). */
export interface TrustedDevice {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly createdIp: string | null;
  /** This browser. */
  readonly current: boolean;
}

export interface EnrollmentSetup {
  readonly otpauthUri: string;
  readonly secret: string;
  readonly qrSvg: string;
}

/**
 * After the password step: the next step, or — on a trusted device (p5-remember-device) — the signed-in
 * user directly.
 */
export type LoginOutcome =
  | { readonly status: 'mfa_required' | 'enrollment_required' }
  | { readonly status: 'authenticated'; readonly user: User };

/**
 * After the second factor. `passwordChangeRequired`: the account still holds a temporary password and the
 * session can only replace it (POST /auth/password/initial, p5-self-password).
 */
export interface SecondFactorResult {
  readonly user: User;
  readonly passwordChangeRequired: boolean;
}

type Opts = Omit<RequestOptions, 'body'>;

function user(v: unknown): User {
  const o = obj(v);
  return { id: str(o, 'id'), username: str(o, 'username'), role: str(o, 'role') };
}

function authenticated(v: unknown): {
  user: User;
  passwordChangeRequired: boolean;
  body: Record<string, unknown>;
} {
  const o = obj(v);
  if (o.status !== 'authenticated' && o.status !== 'password_change_required') {
    throw new Error('expected status authenticated');
  }
  return { user: user(o.user), passwordChangeRequired: o.status === 'password_change_required', body: o };
}

export function login(
  username: string,
  password: string,
  remember = false,
  opts: Opts = {},
): Promise<LoginOutcome> {
  return apiRequest(
    'POST',
    '/auth/login',
    (v): LoginOutcome => {
      const o = obj(v);
      const s = o.status;
      if (s === 'authenticated') return { status: s, user: user(o.user) };
      if (s !== 'mfa_required' && s !== 'enrollment_required') throw new Error('unexpected status');
      return { status: s };
    },
    { ...opts, body: remember ? { username, password, remember: true } : { username, password } },
  );
}

/** Which of "Remember me" / "Trust this device" the master offers (public, no account data). */
export function getLoginOptions(opts: Opts = {}): Promise<LoginOptions> {
  return apiRequest(
    'GET',
    '/auth/options',
    (v) => {
      const o = obj(v);
      const rm = o.rememberMe === null ? null : obj(o.rememberMe);
      const td = o.trustedDevice === null ? null : obj(o.trustedDevice);
      return {
        rememberMe: rm ? { idleDays: int(rm, 'idleDays'), absoluteDays: int(rm, 'absoluteDays') } : null,
        trustedDevice: td ? { days: int(td, 'days') } : null,
      };
    },
    opts,
  );
}

export function listTrustedDevices(opts: Opts = {}): Promise<TrustedDevice[]> {
  return apiRequest(
    'GET',
    '/auth/devices',
    (v) => {
      const list = obj(v).devices;
      if (!Array.isArray(list)) throw new Error('expected devices');
      return list.map((d) => {
        const o = obj(d);
        if (typeof o.current !== 'boolean') throw new Error('expected current');
        return {
          id: str(o, 'id'),
          label: str(o, 'label'),
          createdAt: str(o, 'createdAt'),
          lastUsedAt: str(o, 'lastUsedAt'),
          expiresAt: str(o, 'expiresAt'),
          createdIp: nullableStr(o, 'createdIp'),
          current: o.current,
        };
      });
    },
    opts,
  );
}

export function revokeTrustedDevice(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'DELETE',
    `/auth/devices/${encodeURIComponent(id)}`,
    (v) => {
      if (obj(v).status !== 'revoked') throw new Error('unexpected status');
    },
    opts,
  );
}

export function revokeAllTrustedDevices(opts: Opts = {}): Promise<{ revoked: number }> {
  return apiRequest(
    'POST',
    '/auth/devices/revoke-all',
    (v) => {
      const o = obj(v);
      if (o.status !== 'revoked') throw new Error('unexpected status');
      return { revoked: int(o, 'revoked') };
    },
    opts,
  );
}

/** Body of the second-factor steps; `trustDevice` only when the user ticked the box. */
function secondFactorBody(code: string, trustDevice: boolean): Record<string, unknown> {
  return trustDevice ? { code, trustDevice: true } : { code };
}

export function verifyTotp(code: string, trustDevice = false, opts: Opts = {}): Promise<SecondFactorResult> {
  return apiRequest(
    'POST',
    '/auth/totp/verify',
    (v) => {
      const a = authenticated(v);
      return { user: a.user, passwordChangeRequired: a.passwordChangeRequired };
    },
    { ...opts, body: secondFactorBody(code, trustDevice) },
  );
}

export function loginWithRecoveryCode(
  code: string,
  trustDevice = false,
  opts: Opts = {},
): Promise<SecondFactorResult & { remainingRecoveryCodes: number }> {
  return apiRequest(
    'POST',
    '/auth/recovery',
    (v) => {
      const a = authenticated(v);
      return {
        user: a.user,
        passwordChangeRequired: a.passwordChangeRequired,
        remainingRecoveryCodes: int(a.body, 'remainingRecoveryCodes'),
      };
    },
    { ...opts, body: secondFactorBody(code, trustDevice) },
  );
}

export function startEnrollment(opts: Opts = {}): Promise<EnrollmentSetup> {
  return apiRequest(
    'POST',
    '/auth/totp/enroll/start',
    (v) => {
      const o = obj(v);
      return { otpauthUri: str(o, 'otpauthUri'), secret: str(o, 'secret'), qrSvg: str(o, 'qrSvg') };
    },
    opts,
  );
}

export function confirmEnrollment(
  code: string,
  opts: Opts = {},
): Promise<SecondFactorResult & { recoveryCodes: string[] }> {
  return apiRequest(
    'POST',
    '/auth/totp/enroll/confirm',
    (v) => {
      const a = authenticated(v);
      return {
        user: a.user,
        passwordChangeRequired: a.passwordChangeRequired,
        recoveryCodes: strArray(a.body, 'recoveryCodes'),
      };
    },
    { ...opts, body: { code } },
  );
}

/**
 * p9-stepup-rotation-logout: why a step-up code failed, from the 401 body (older masters send none).
 * `replayed_totp`: the code was already used — wait for the next one; `attemptsRemaining`: further wrong
 * codes before the session is ended; `sessionTerminated`: it just was.
 */
export interface StepUpFailure {
  readonly reason: 'bad_totp' | 'replayed_totp';
  readonly attemptsRemaining: number | null;
  readonly sessionTerminated: boolean;
}

export function stepUpFailureOf(err: unknown): StepUpFailure | null {
  if (!(err instanceof ApiError) || err.status !== 401 || err.code !== 'invalid_credentials') return null;
  const d = err.details;
  if (d.reason !== 'bad_totp' && d.reason !== 'replayed_totp') return null;
  return {
    reason: d.reason,
    attemptsRemaining:
      typeof d.attemptsRemaining === 'number' && Number.isInteger(d.attemptsRemaining)
        ? d.attemptsRemaining
        : null,
    sessionTerminated: d.sessionTerminated === true,
  };
}

export const STEP_UP_SESSION_ENDED =
  'Too many wrong codes — this session was ended for safety. Sign in again.';

/** The dialog's text for a failed step-up code. */
export function stepUpFailureMessage(f: StepUpFailure): string {
  if (f.sessionTerminated) return STEP_UP_SESSION_ENDED;
  const left =
    f.attemptsRemaining === null
      ? ''
      : f.attemptsRemaining === 1
        ? ' 1 more wrong code ends this session.'
        : ` ${String(f.attemptsRemaining)} wrong codes left before this session ends.`;
  if (f.reason === 'replayed_totp')
    return `This code was already used — wait for the next code in your authenticator app.${left}`;
  return `That code is not right.${left}`;
}

export function stepUp(code: string, opts: Opts = {}): Promise<StepUpResult> {
  return apiRequest(
    'POST',
    '/auth/step-up',
    (v) => {
      const o = obj(v);
      return { stepUpValidUntil: str(o, 'stepUpValidUntil'), stepUpScope: scopeOf(o.stepUpScope) };
    },
    { ...opts, body: { code } },
  );
}

/** Forced replacement of a temporary password; returns the user of the new full session. */
export function completePasswordChange(newPassword: string, opts: Opts = {}): Promise<User> {
  return apiRequest(
    'POST',
    '/auth/password/initial',
    (v) => {
      const a = authenticated(v);
      if (a.passwordChangeRequired) throw new Error('unexpected status');
      return a.user;
    },
    { ...opts, body: { newPassword } },
  );
}

/**
 * Self-service change (needs a step-up within 10 minutes: callers wrap it in `useStepUp().run`). The master
 * ends every other session and rotates this one (new cookies).
 */
export function changePassword(currentPassword: string, newPassword: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'POST',
    '/auth/password',
    (v) => {
      if (obj(v).status !== 'changed') throw new Error('unexpected status');
    },
    { ...opts, body: { currentPassword, newPassword } },
  );
}

export function logout(opts: Opts = {}): Promise<void> {
  return apiRequest(
    'POST',
    '/auth/logout',
    (v) => {
      if (obj(v).status !== 'logged_out') throw new Error('unexpected status');
    },
    opts,
  );
}

export function logoutAll(opts: Opts = {}): Promise<{ revokedSessions: number }> {
  return apiRequest(
    'POST',
    '/auth/logout-all',
    (v) => {
      const o = obj(v);
      if (o.status !== 'logged_out') throw new Error('unexpected status');
      return { revokedSessions: int(o, 'revokedSessions') };
    },
    opts,
  );
}

export function getSession(opts: Opts = {}): Promise<SessionInfo> {
  return apiRequest(
    'GET',
    '/auth/session',
    (v) => {
      const o = obj(v);
      const s = obj(o.session);
      return {
        user: user(o.user),
        createdAt: str(s, 'createdAt'),
        expiresAt: str(s, 'expiresAt'),
        idleExpiresAt: str(s, 'idleExpiresAt'),
        mfaAt: nullableStr(s, 'mfaAt'),
        stepUpValidUntil: nullableStr(s, 'stepUpValidUntil'),
        stepUpScope: scopeOf(s.stepUpScope),
        alwaysFreshValidUntil:
          s.alwaysFreshValidUntil === undefined ? null : nullableStr(s, 'alwaysFreshValidUntil'),
        // Older masters do not send it: treat as standard.
        type: s.type === 'remembered' ? 'remembered' : 'standard',
        ...(Array.isArray(s.stepUpWaived)
          ? { stepUpWaived: s.stepUpWaived.filter((e): e is string => typeof e === 'string') }
          : {}),
        ...(isLocale(o.locale) ? { locale: o.locale } : {}),
        ...(o.theme === 'light' || o.theme === 'dark' || o.theme === 'system' ? { theme: o.theme } : {}),
        ...(typeof o.features === 'object' && o.features !== null
          ? {
              features: {
                workflowEngineV2: (o.features as { workflowEngineV2?: unknown }).workflowEngineV2 === true,
              },
            }
          : {}),
      };
    },
    opts,
  );
}
