import { createHash } from 'node:crypto';
import { renderSVG } from 'uqr';
import type { AuditEventInput, AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { DEFAULT_LOCKOUT, type LockoutPolicy } from './lockout.js';
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  describePolicyFailure,
  dummyHash,
  hashPassword,
  needsRehash,
  policyFailureParams,
  type ScryptParams,
  verifyPassword,
} from './password.js';
import type { RateLimiter } from './rate-limit.js';
import { generateRecoveryCodes, normalizeRecoveryCode } from './recovery-codes.js';
import type { SecretBox } from './secret-box.js';
import {
  type IssuedSession,
  type SessionLifetime,
  type SessionRecord,
  type SessionStage,
  type SessionUser,
  sessions,
  STANDARD_LIFETIME,
} from './sessions.js';
import {
  DEFAULT_LOGIN_PERSISTENCE,
  type LoginPersistencePolicy,
  revokeAllTrustedDevices,
  type TrustedDevice,
  trustedDevices,
  wellFormedDeviceToken,
} from './trusted-devices.js';
import {
  DEFAULT_STEP_UP_POLICY,
  sessionStepUp,
  type StepUpPolicy,
  type StepUpStatus,
  stepUpStatus,
} from './step-up.js';
import { base32Encode, generateTotpSecret, otpauthUri, totpStep, verifyTotp } from './totp.js';
import { type UserRecord, USERNAME_PATTERN, users } from './users.js';

export interface RequestContext {
  readonly ip: string;
  readonly userAgent: string | null;
}

export interface RateLimits {
  /** Attempts per IP across all login/second-factor/step-up endpoints. */
  readonly perIp: number;
  /** Attempts per account (username or user id). */
  readonly perAccount: number;
  readonly windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { perIp: 30, perAccount: 10, windowMs: 15 * 60_000 };

/** Second-factor failures allowed on one pending session before it is destroyed. */
export const MAX_MFA_FAILURES_PER_SESSION = 5;

export interface AuthServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly box: SecretBox;
  readonly limiter: RateLimiter;
  readonly clock?: () => Date;
  readonly passwordParams?: ScryptParams;
  readonly lockout?: LockoutPolicy;
  readonly rateLimits?: RateLimits;
  /** Injectable for tests (canary secret); defaults to 20 random bytes. */
  readonly totpSecretFactory?: () => Buffer;
  /** p5-remember-device: remember-me and trusted-device lifetimes (null = feature disabled). */
  /** p17-panel-settings: a function is read per login (the panel can change the lifetimes without a restart). */
  readonly persistence?: LoginPersistencePolicy | (() => LoginPersistencePolicy);
  /** p5-stepup-window: step-up windows per session type. */
  readonly stepUp?: StepUpPolicy;
}

/** A device trust issued or rotated by a login step; the route sets the `__Host-rtd` cookie. */
export interface IssuedDevice {
  /** The device row (the session established with it references it, p5-stepup-window). */
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** Outcome of a login step: the session, and what to do with the device cookie. */
export interface LoginStepResult {
  readonly session: IssuedSession;
  /** New device cookie value (created or rotated). */
  readonly device: IssuedDevice | null;
  /** The presented device cookie is useless (unknown, expired, reused, MFA reset): clear it. */
  readonly clearDevice: boolean;
  /** The signed-in user when `POST /auth/login` issued a full session (trusted device). */
  readonly user?: SessionUser;
}

export interface LoginOptions {
  /** "Remember me": the full session this login ends in gets the remember-me lifetime. */
  readonly remember?: boolean;
  /** The `__Host-rtd` cookie, if the browser sent one. */
  readonly deviceToken?: string | undefined;
}

/** The single, deliberately vague failure for every factor (ADR-0009 §6). */
export function invalidCredentials(details: Readonly<Record<string, unknown>> = {}): HttpError {
  return new HttpError(401, 'invalid_credentials', 'Invalid credentials.', {}, details);
}

/**
 * p9-stepup-rotation-logout: a replayed code is a benign double submit (not a guess) when the same session
 * itself consumed that time step within this window — its `mfa_at` (copied across the step-up rotation)
 * is the moment of that consumption.
 */
export const BENIGN_REPLAY_WINDOW_MS = 90_000;

/** Why a step-up code failed (only a full, stepped-in session ever sees it; the login keeps the generic 401). */
export type SecondFactorFailureReason = 'bad_totp' | 'replayed_totp' | 'bad_recovery_code';

export interface SecondFactorFailure {
  readonly reason: SecondFactorFailureReason;
  /** Further wrong codes this session may submit before it is ended. */
  readonly attemptsRemaining: number;
  readonly sessionTerminated: boolean;
}

function rateLimited(retryAfterMs: number): HttpError {
  return new HttpError(
    429,
    'rate_limited',
    'Too many attempts. Try again later.',
    {
      'retry-after': String(Math.ceil(retryAfterMs / 1000)),
    },
    {},
    { reason: 'attempts' },
  );
}

function totpAad(userId: string): string {
  return `totp:${userId}`;
}

export interface EnrollmentStart {
  readonly otpauthUri: string;
  readonly secret: string;
  readonly qrSvg: string;
}

/**
 * Login, enrollment, second-factor, recovery and step-up flows (ADR-0009). HTTP-agnostic: routes pass the
 * already-authenticated pending/full session where the flow requires one. Every outcome is audited.
 */
export class AuthService {
  private readonly pool: Pool;
  private readonly audit: AuditRecorder;
  private readonly box: SecretBox;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;
  private readonly params: ScryptParams;
  private readonly lockout: LockoutPolicy;
  private readonly limits: RateLimits;
  private readonly newSecret: () => Buffer;
  private readonly persistenceOf: () => LoginPersistencePolicy;
  private readonly stepUpPolicy: StepUpPolicy;

  constructor(deps: AuthServiceDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.box = deps.box;
    this.limiter = deps.limiter;
    this.now = deps.clock ?? (() => new Date());
    this.params = deps.passwordParams ?? DEFAULT_SCRYPT_PARAMS;
    this.lockout = deps.lockout ?? DEFAULT_LOCKOUT;
    this.limits = deps.rateLimits ?? DEFAULT_RATE_LIMITS;
    this.newSecret = deps.totpSecretFactory ?? generateTotpSecret;
    const p = deps.persistence ?? DEFAULT_LOGIN_PERSISTENCE;
    this.persistenceOf = typeof p === 'function' ? p : () => p;
    this.stepUpPolicy = deps.stepUp ?? DEFAULT_STEP_UP_POLICY;
  }

  private get persistence(): LoginPersistencePolicy {
    return this.persistenceOf();
  }

  /** Public view of the login persistence options (GET /auth/options). */
  options(): LoginPersistencePolicy {
    return this.persistence;
  }

  /** Lifetime of the full session a login (remembered or not) ends in. */
  private lifetime(remember: boolean): SessionLifetime {
    return remember && this.persistence.remember ? this.persistence.remember : STANDARD_LIFETIME;
  }

  // ---------------------------------------------------------------- step 1: username + password

  async login(
    usernameInput: string,
    password: string,
    ctx: RequestContext,
    currentToken: string | undefined,
    opts: LoginOptions = {},
  ): Promise<LoginStepResult> {
    const username = usernameInput.trim().toLowerCase();
    const plausible = USERNAME_PATTERN.test(username);
    await this.enforceLimits('auth.login.password', ctx, plausible ? username : '(invalid)');

    const user = plausible ? await users.findByUsername(this.pool, username) : null;
    if (!user) {
      await verifyPassword(password, await dummyHash(this.params)); // equalise timing
      await this.record(ctx, {
        actor: { type: 'anonymous' },
        action: 'auth.login.password',
        outcome: 'failure',
        // An unknown "username" is often a password typed into the wrong field: store only a short hash
        // (enough to correlate repeated attempts), never the value.
        metadata: {
          reason: 'unknown_user',
          usernameHash: createHash('sha256').update(username).digest('hex').slice(0, 16),
        },
      });
      throw invalidCredentials();
    }

    const now = this.now();
    if (this.isLocked(user, now)) {
      await verifyPassword(password, user.passwordHash); // equalise timing
      await this.denyLocked(user, ctx, 'auth.login.password');
    }
    if (user.disabledAt !== null) {
      // Same generic answer as a wrong password: a disabled account is not confirmed to exist.
      await verifyPassword(password, user.passwordHash); // equalise timing
      await this.record(ctx, {
        actor: { type: 'user', id: user.id },
        action: 'auth.login.password',
        outcome: 'denied',
        metadata: { reason: 'disabled' },
      });
      throw invalidCredentials();
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.fail(user, ctx, 'auth.login.password', 'bad_password');
      throw invalidCredentials();
    }

    if (needsRehash(user.passwordHash, this.params)) {
      await users.setPasswordHash(this.pool, user.id, await hashPassword(password, this.params));
    }

    const remember = opts.remember === true && this.persistence.remember !== null;
    const deviceToken =
      this.persistence.trustedDeviceMs !== null && wellFormedDeviceToken(opts.deviceToken)
        ? opts.deviceToken
        : null;
    const actor = { type: 'user', id: user.id } as const;
    return withTransaction(this.pool, async (tx): Promise<LoginStepResult> => {
      if (currentToken) await sessions.deleteByToken(tx, currentToken); // rotate: never reuse a prior id

      // p5-remember-device: a trusted device replaces the TOTP step — only for an enrolled account that
      // needs no password change, and only with a valid, unexpired token of this user and MFA epoch.
      let clearDevice = false;
      if (deviceToken !== null) {
        const check = user.passwordChangeRequired
          ? ({ ok: false, reason: 'password_change', clearCookie: false } as const)
          : await trustedDevices.consume(tx, deviceToken, user, { now, ip: ctx.ip });
        if (check.ok) {
          await users.recordSuccessfulLogin(tx, user.id, now);
          // mfa_at stays NULL: a device token is not a fresh TOTP, so the first privileged action asks for
          // one. The session references the device: after that TOTP the step-up holds for the session
          // (p5-stepup-window) until the device is revoked.
          const issued = await sessions.create(tx, {
            userId: user.id,
            stage: 'full',
            now,
            mfaAt: null,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            remember,
            lifetime: this.lifetime(remember),
            trustedDeviceId: check.id,
          });
          await this.audit.record(
            this.event(ctx, actor, 'auth.login.password', 'success', { next: 'full', remember }),
            tx,
          );
          await this.audit.record(
            {
              ...this.event(ctx, actor, 'auth.login.trusted_device', 'success', { remember, rotated: true }),
              target: `trusted_device:${check.id}`,
            },
            tx,
          );
          return {
            session: issued,
            device: { id: check.id, token: check.token, expiresAt: check.expiresAt },
            clearDevice,
            user: { id: user.id, username: user.username, role: user.role },
          };
        }
        clearDevice = check.clearCookie;
        // expired / reused / MFA reset name the device row that was deleted (trust withdrawn).
        const revokedId = 'deviceId' in check ? check.deviceId : null;
        await this.audit.record(
          {
            ...this.event(ctx, actor, 'auth.login.trusted_device', 'failure', {
              reason: check.reason,
              revoked: revokedId !== null,
            }),
            target: revokedId === null ? null : `trusted_device:${revokedId}`,
          },
          tx,
        );
      }

      const stage = user.totpEnabled ? 'mfa_pending' : 'enrollment';
      const issued = await sessions.create(tx, {
        userId: user.id,
        stage,
        now,
        mfaAt: null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        remember,
      });
      await this.audit.record(
        this.event(ctx, actor, 'auth.login.password', 'success', { next: stage, remember }),
        tx,
      );
      return { session: issued, device: null, clearDevice };
    });
  }

  /**
   * Issues a device trust after a successful second factor (inside its transaction) when asked for, the
   * feature is enabled and the new session is a full one (never for a pending password change).
   */
  private async maybeTrustDevice(
    tx: Queryable,
    user: UserRecord,
    session: IssuedSession,
    trustDevice: boolean,
    now: Date,
    ctx: RequestContext,
  ): Promise<IssuedDevice | null> {
    const stage = session.stage;
    const lifetimeMs = this.persistence.trustedDeviceMs;
    const enrolledAt = user.totpEnrolledAt;
    if (!trustDevice || lifetimeMs === null || stage !== 'full' || enrolledAt === null) return null;
    const created = await trustedDevices.create(tx, {
      userId: user.id,
      now,
      lifetimeMs,
      mfaEnrolledAt: enrolledAt,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    const actor = { type: 'user', id: user.id } as const;
    await this.audit.record(
      {
        ...this.event(ctx, actor, 'auth.trusted_device.create', 'success', {
          expiresAt: created.expiresAt.toISOString(),
        }),
        target: `trusted_device:${created.id}`,
      },
      tx,
    );
    if (created.evicted > 0) {
      await this.audit.record(
        {
          ...this.event(ctx, actor, 'auth.trusted_device.revoke', 'success', {
            reason: 'evicted',
            devices: created.evicted,
          }),
          target: `user:${user.id}`,
        },
        tx,
      );
    }
    // p5-stepup-window: the session this second factor ends in is established on the now-trusted device.
    await sessions.bindTrustedDevice(tx, session.token, created.id);
    return { id: created.id, token: created.token, expiresAt: created.expiresAt };
  }

  // ---------------------------------------------------------------- step 2: TOTP

  async verifyTotp(
    session: SessionRecord,
    code: string,
    ctx: RequestContext,
    opts: { readonly trustDevice?: boolean } = {},
  ): Promise<LoginStepResult> {
    const user = await this.loadForSecondFactor(session, ctx, 'auth.login.totp');
    const now = this.now();
    const step = await this.checkTotp(user, session, code, ctx, 'auth.login.totp');
    return withTransaction(this.pool, async (tx): Promise<LoginStepResult> => {
      await users.recordSuccessfulLogin(tx, user.id, now);
      await sessions.delete(tx, session.idHash);
      const stage = afterSecondFactor(user);
      const issued = await sessions.create(tx, {
        userId: user.id,
        stage,
        now,
        mfaAt: now,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        remember: session.remember,
        lifetime: this.lifetime(session.remember),
      });
      await this.audit.record(
        this.event(ctx, { type: 'user', id: user.id }, 'auth.login.totp', 'success', { step, next: stage }),
        tx,
      );
      const device = await this.maybeTrustDevice(tx, user, issued, opts.trustDevice === true, now, ctx);
      return { session: issued, device, clearDevice: false };
    });
  }

  async recover(
    session: SessionRecord,
    code: string,
    ctx: RequestContext,
    opts: { readonly trustDevice?: boolean } = {},
  ): Promise<LoginStepResult & { remainingRecoveryCodes: number }> {
    const user = await this.loadForSecondFactor(session, ctx, 'auth.login.recovery');
    const now = this.now();
    const normalized = normalizeRecoveryCode(code);
    const result = normalized
      ? await withTransaction(this.pool, async (tx) => {
          if (!(await users.consumeRecoveryCode(tx, user.id, this.box.mac(normalized), now))) return null;
          await users.recordSuccessfulLogin(tx, user.id, now);
          await sessions.delete(tx, session.idHash);
          // mfa_at stays NULL: a recovery code is not a fresh TOTP, so step-up still requires one.
          const stage = afterSecondFactor(user);
          const issued = await sessions.create(tx, {
            userId: user.id,
            stage,
            now,
            mfaAt: null,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            remember: session.remember,
            lifetime: this.lifetime(session.remember),
          });
          const remaining = await users.countUnusedRecoveryCodes(tx, user.id);
          await this.audit.record(
            this.event(ctx, { type: 'user', id: user.id }, 'auth.login.recovery', 'success', {
              remainingRecoveryCodes: remaining,
            }),
            tx,
          );
          const device = await this.maybeTrustDevice(tx, user, issued, opts.trustDevice === true, now, ctx);
          return { session: issued, device, clearDevice: false, remainingRecoveryCodes: remaining };
        })
      : null;
    if (!result) {
      await this.secondFactorFailed(user, session, ctx, 'auth.login.recovery', 'bad_recovery_code');
      throw invalidCredentials();
    }
    return result;
  }

  // ---------------------------------------------------------------- enrollment (mandatory, ADR-0009 §4)

  async enrollStart(session: SessionRecord, ctx: RequestContext): Promise<EnrollmentStart> {
    const user = await users.findById(this.pool, session.user.id);
    if (!user || user.totpEnabled) throw invalidCredentials();
    const secret = this.newSecret();
    const ok = await withTransaction(this.pool, async (tx) => {
      const stored = await users.setPendingTotpSecret(
        tx,
        user.id,
        this.box.encrypt(secret, totpAad(user.id)),
      );
      if (stored) {
        await this.audit.record(
          this.event(ctx, { type: 'user', id: user.id }, 'auth.totp.enroll.start', 'success', {}),
          tx,
        );
      }
      return stored;
    });
    if (!ok) throw invalidCredentials();
    const uri = otpauthUri(secret, user.username);
    return { otpauthUri: uri, secret: base32Encode(secret), qrSvg: renderSVG(uri, { ecc: 'M', border: 2 }) };
  }

  async enrollConfirm(
    session: SessionRecord,
    code: string,
    ctx: RequestContext,
  ): Promise<{ session: IssuedSession; recoveryCodes: string[] }> {
    const user = await this.loadForSecondFactor(session, ctx, 'auth.totp.enroll.confirm');
    if (user.totpEnabled || !user.totpSecretEnc) throw invalidCredentials();
    const now = this.now();
    const secret = this.box.decrypt(user.totpSecretEnc, totpAad(user.id));
    const step = verifyTotp(secret, code, now.getTime(), null);
    if (step === null) {
      await this.secondFactorFailed(user, session, ctx, 'auth.totp.enroll.confirm', 'bad_totp');
      throw invalidCredentials();
    }
    const codes = generateRecoveryCodes();
    const issued = await withTransaction(this.pool, async (tx) => {
      if (!(await users.enableTotp(tx, user.id, step, now))) return null;
      await users.replaceRecoveryCodes(
        tx,
        user.id,
        codes.map((c) => this.box.mac(normalizeRecoveryCode(c) ?? c)),
      );
      await users.recordSuccessfulLogin(tx, user.id, now);
      await sessions.delete(tx, session.idHash);
      const s = await sessions.create(tx, {
        userId: user.id,
        stage: afterSecondFactor(user),
        now,
        mfaAt: now,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        remember: session.remember,
        lifetime: this.lifetime(session.remember),
      });
      await this.audit.record(
        this.event(ctx, { type: 'user', id: user.id }, 'auth.totp.enroll.confirm', 'success', {
          recoveryCodesIssued: codes.length,
        }),
        tx,
      );
      return s;
    });
    if (!issued) throw invalidCredentials();
    return { session: issued, recoveryCodes: codes };
  }

  // ---------------------------------------------------------------- step-up (ADR-0009 §10)

  /**
   * A fresh TOTP lifts the session to "stepped up" — for the standard window, or for the rest of a
   * remember-me / trusted-device session (p5-stepup-window). That is a privilege change, so the session id
   * is rotated (p7-rate-limit session hardening, OWASP): a cookie captured before the step-up never carries
   * the elevated state. The absolute expiry, the session type and the device binding are kept.
   */
  async stepUp(
    session: SessionRecord,
    code: string,
    ctx: RequestContext,
  ): Promise<{ status: StepUpStatus; session: IssuedSession }> {
    const user = await this.loadForSecondFactor(session, ctx, 'auth.step_up');
    const step = await this.checkTotp(user, session, code, ctx, 'auth.step_up');
    const now = this.now();
    const issued = await withTransaction(this.pool, async (tx) => {
      const rotated = await sessions.rotate(tx, session, {
        now,
        mfaAt: now,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const status = stepUpStatus({ ...session, mfaAt: now }, now, sessionStepUp(session, this.stepUpPolicy));
      await this.audit.record(
        this.event(ctx, { type: 'user', id: user.id }, 'auth.step_up', 'success', {
          step,
          rotated: true,
          scope: status.scope,
        }),
        tx,
      );
      return { rotated, status };
    });
    return { status: issued.status, session: issued.rotated };
  }

  // ---------------------------------------------------------------- password change (p5-self-password)

  /**
   * Self-service change from a full session (`POST /auth/password`; the route also requires a step-up
   * within 10 minutes). Checks the policy, then the current password (a wrong one counts towards the
   * lockout like a failed login). On success the hash is replaced, every session of the user is revoked
   * and a new full session is issued (rotation).
   */
  async changePassword(
    session: SessionRecord,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const action = 'auth.password.change';
    await this.enforceLimits(action, ctx, `user:${session.user.id}`);
    const user = await users.findById(this.pool, session.user.id);
    if (!user || user.disabledAt !== null) throw invalidCredentials();
    if (this.isLocked(user, this.now())) {
      await verifyPassword(currentPassword, user.passwordHash); // equalise timing
      await this.denyLocked(user, ctx, action);
    }
    await this.checkNewPassword(user, newPassword, ctx, action, false);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await this.fail(user, ctx, action, 'bad_current');
      throw invalidCredentials();
    }
    // The current password is proven: comparing the strings avoids a second scrypt run.
    const reused = newPassword.normalize('NFC') === currentPassword.normalize('NFC');
    await this.rejectReuse(user, reused, ctx, action, false);
    return this.replacePassword(user, session, newPassword, ctx, false);
  }

  /**
   * The forced change of a temporary password (`POST /auth/password/initial`, `password_change` session):
   * both factors were just verified, so the current password is not asked again. Issues the full session.
   */
  async completeRequiredPasswordChange(
    session: SessionRecord,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const action = 'auth.password.change';
    await this.enforceLimits(action, ctx, `user:${session.user.id}`);
    const user = await users.findById(this.pool, session.user.id);
    if (!user || user.disabledAt !== null || !user.passwordChangeRequired) throw invalidCredentials();
    if (this.isLocked(user, this.now())) await this.denyLocked(user, ctx, action);
    await this.checkNewPassword(user, newPassword, ctx, action, true);
    await this.rejectReuse(user, await verifyPassword(newPassword, user.passwordHash), ctx, action, true);
    return this.replacePassword(user, session, newPassword, ctx, true);
  }

  private async checkNewPassword(
    user: UserRecord,
    newPassword: string,
    ctx: RequestContext,
    action: string,
    forced: boolean,
  ): Promise<void> {
    const policy = checkPasswordPolicy(newPassword, user.username);
    if (policy.ok) return;
    await this.record(ctx, {
      actor: { type: 'user', id: user.id },
      action,
      outcome: 'denied',
      metadata: { reason: `policy_${policy.reason}`, forced },
    });
    throw new HttpError(
      400,
      'weak_password',
      describePolicyFailure(policy.reason),
      {},
      {},
      policyFailureParams(policy.reason),
    );
  }

  private async rejectReuse(
    user: UserRecord,
    reused: boolean,
    ctx: RequestContext,
    action: string,
    forced: boolean,
  ): Promise<void> {
    if (!reused) return;
    await this.record(ctx, {
      actor: { type: 'user', id: user.id },
      action,
      outcome: 'denied',
      metadata: { reason: 'reused', forced },
    });
    throw new HttpError(400, 'password_reused', 'Choose a password different from the current one.');
  }

  private async replacePassword(
    user: UserRecord,
    session: SessionRecord,
    newPassword: string,
    ctx: RequestContext,
    forced: boolean,
  ): Promise<IssuedSession> {
    const hash = await hashPassword(newPassword, this.params);
    const now = this.now();
    return withTransaction(this.pool, async (tx) => {
      await users.changePassword(tx, user.id, hash, now);
      // Every other session (other browsers, a stolen cookie) ends; this one is replaced by a new id.
      const revoked = await sessions.deleteAllForUser(tx, user.id);
      // A changed password ends every device trust as well (p5-remember-device).
      await revokeAllTrustedDevices(tx, this.audit, {
        userId: user.id,
        reason: 'password_change',
        actor: { type: 'user', id: user.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const issued = await sessions.create(tx, {
        userId: user.id,
        stage: 'full',
        now,
        // The step-up / second factor this session proved stays valid under its session's rule (the
        // route required an always-fresh step-up, i.e. a TOTP from the last 10 minutes).
        mfaAt: session.mfaAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        // The session type (remembered or not) is kept; the device binding is not (all trust revoked).
        remember: session.remember,
        lifetime: this.lifetime(session.remember),
        trustedDeviceId: null,
      });
      await this.audit.record(
        this.event(ctx, { type: 'user', id: user.id }, 'auth.password.change', 'success', {
          forced,
          // The caller's own (replaced) session is not counted as "other".
          revokedOtherSessions: Math.max(0, revoked - 1),
        }),
        tx,
      );
      return issued;
    });
  }

  // ---------------------------------------------------------------- logout

  async logout(session: SessionRecord, ctx: RequestContext): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await sessions.delete(tx, session.idHash);
      await this.audit.record(
        this.event(ctx, { type: 'user', id: session.user.id }, 'auth.logout', 'success', {}),
        tx,
      );
    });
  }

  /** Ends every session of the user and revokes every trusted device ("log out everywhere"). */
  async logoutAll(session: SessionRecord, ctx: RequestContext): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      const n = await sessions.deleteAllForUser(tx, session.user.id);
      const devices = await revokeAllTrustedDevices(tx, this.audit, {
        userId: session.user.id,
        reason: 'logout_all',
        actor: { type: 'user', id: session.user.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.audit.record(
        this.event(ctx, { type: 'user', id: session.user.id }, 'auth.logout_all', 'success', {
          revokedSessions: n,
          revokedDevices: devices,
        }),
        tx,
      );
      return n;
    });
  }

  // ---------------------------------------------------------------- trusted devices (p5-remember-device)

  async listDevices(session: SessionRecord, currentToken: string | undefined): Promise<TrustedDevice[]> {
    return trustedDevices.list(this.pool, session.user.id, this.now(), currentToken);
  }

  /** Revokes one of the caller's devices; 404 for unknown ids and other users' devices. */
  async revokeDevice(
    session: SessionRecord,
    id: string,
    currentToken: string | undefined,
    ctx: RequestContext,
  ): Promise<{ current: boolean }> {
    const actor = { type: 'user', id: session.user.id } as const;
    const result = await withTransaction(this.pool, async (tx) => {
      const r = await trustedDevices.revoke(tx, session.user.id, id, currentToken);
      if (r.revoked) {
        await this.audit.record(
          {
            ...this.event(ctx, actor, 'auth.trusted_device.revoke', 'success', {
              reason: 'user',
              current: r.current,
            }),
            target: `trusted_device:${id}`,
          },
          tx,
        );
      }
      return r;
    });
    if (!result.revoked) throw new HttpError(404, 'device_not_found', 'Trusted device not found.');
    return { current: result.current };
  }

  async revokeAllDevices(session: SessionRecord, ctx: RequestContext): Promise<number> {
    return withTransaction(this.pool, (tx) =>
      revokeAllTrustedDevices(tx, this.audit, {
        userId: session.user.id,
        reason: 'user_all',
        actor: { type: 'user', id: session.user.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    );
  }

  // ---------------------------------------------------------------- helpers

  private isLocked(user: UserRecord, now: Date): boolean {
    return user.lockedUntil !== null && user.lockedUntil > now;
  }

  private async enforceLimits(action: string, ctx: RequestContext, account: string): Promise<void> {
    const { perIp, perAccount, windowMs } = this.limits;
    const byIp = await this.limiter.hit('auth-ip', ctx.ip, perIp, windowMs);
    const byAccount = await this.limiter.hit('auth-account', account, perAccount, windowMs);
    if (byIp.allowed && byAccount.allowed) return;
    await this.record(ctx, {
      actor: { type: 'anonymous' },
      action: 'auth.rate_limited',
      outcome: 'denied',
      metadata: { for: action, scope: byIp.allowed ? 'account' : 'ip' },
    });
    throw rateLimited(Math.max(byIp.retryAfterMs, byAccount.retryAfterMs));
  }

  private async loadForSecondFactor(
    session: SessionRecord,
    ctx: RequestContext,
    action: string,
  ): Promise<UserRecord> {
    await this.enforceLimits(action, ctx, `user:${session.user.id}`);
    const user = await users.findById(this.pool, session.user.id);
    if (!user || user.disabledAt !== null) throw invalidCredentials();
    if (this.isLocked(user, this.now())) await this.denyLocked(user, ctx, action);
    return user;
  }

  /** Verifies a TOTP code with replay protection; on failure counts it and throws the generic error. */
  private async checkTotp(
    user: UserRecord,
    session: SessionRecord,
    code: string,
    ctx: RequestContext,
    action: string,
  ): Promise<number> {
    if (!user.totpEnabled || !user.totpSecretEnc) throw invalidCredentials();
    const secret = this.box.decrypt(user.totpSecretEnc, totpAad(user.id));
    const nowMs = this.now().getTime();
    const step = verifyTotp(secret, code, nowMs, user.lastTotpStep);
    if (step !== null && (await users.consumeTotpStep(this.pool, user.id, step))) return step;
    const replayStep = verifyTotp(secret, code, nowMs, null);
    const reason: SecondFactorFailureReason = replayStep === null ? 'bad_totp' : 'replayed_totp';
    // p9-stepup-rotation-logout: the same session consumed this very step moments ago (login code reused
    // for the first step-up, a double submit) — not a guess, so it neither ends the session nor locks the
    // account. A replay of a step another session consumed, or of an older step, still counts.
    const benign =
      replayStep !== null && this.consumedByThisSession(session, replayStep, user.lastTotpStep, nowMs);
    const failure = benign
      ? await this.benignReplay(user, session, ctx, action)
      : await this.secondFactorFailed(user, session, ctx, action, reason);
    // Only a step-up (a full session that already passed both factors) learns why and how many tries are
    // left; the login's second factor keeps the generic answer.
    throw invalidCredentials(action === 'auth.step_up' ? { ...failure } : {});
  }

  private consumedByThisSession(
    session: SessionRecord,
    replayStep: number,
    lastTotpStep: number | null,
    nowMs: number,
  ): boolean {
    const mfaAt = session.mfaAt?.getTime();
    if (mfaAt === undefined || lastTotpStep !== replayStep) return false;
    if (nowMs - mfaAt < 0 || nowMs - mfaAt > BENIGN_REPLAY_WINDOW_MS) return false;
    // The step consumed at `mfa_at` lies within the verification window (±1 step) of that moment.
    return Math.abs(totpStep(mfaAt) - replayStep) <= 1;
  }

  private async benignReplay(
    user: UserRecord,
    session: SessionRecord,
    ctx: RequestContext,
    action: string,
  ): Promise<SecondFactorFailure> {
    await this.record(ctx, {
      actor: { type: 'user', id: user.id },
      action,
      outcome: 'failure',
      metadata: { reason: 'replayed_totp', counted: false },
    });
    return {
      reason: 'replayed_totp',
      attemptsRemaining: Math.max(0, MAX_MFA_FAILURES_PER_SESSION - session.mfaFailures),
      sessionTerminated: false,
    };
  }

  private async secondFactorFailed(
    user: UserRecord,
    session: SessionRecord,
    ctx: RequestContext,
    action: string,
    reason: SecondFactorFailureReason,
  ): Promise<SecondFactorFailure> {
    const failures = await sessions.incrementMfaFailures(this.pool, session.idHash);
    const terminate = failures >= MAX_MFA_FAILURES_PER_SESSION;
    if (terminate) await sessions.delete(this.pool, session.idHash);
    await this.fail(user, ctx, action, reason, { sessionTerminated: terminate, counted: true });
    return {
      reason,
      attemptsRemaining: Math.max(0, MAX_MFA_FAILURES_PER_SESSION - failures),
      sessionTerminated: terminate,
    };
  }

  private async fail(
    user: UserRecord,
    ctx: RequestContext,
    action: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const now = this.now();
    const { failedAttempts, lockedUntil } = await users.recordFailure(this.pool, user.id, now, this.lockout);
    await this.record(ctx, {
      actor: { type: 'user', id: user.id },
      action,
      outcome: 'failure',
      metadata: { reason, failedAttempts, ...extra },
    });
    if (lockedUntil) {
      await this.record(ctx, {
        actor: { type: 'user', id: user.id },
        action: 'auth.lockout',
        outcome: 'denied',
        metadata: { failedAttempts, lockedUntil: lockedUntil.toISOString() },
      });
    }
  }

  private async denyLocked(user: UserRecord, ctx: RequestContext, action: string): Promise<never> {
    await this.record(ctx, {
      actor: { type: 'user', id: user.id },
      action,
      outcome: 'denied',
      metadata: { reason: 'locked', lockedUntil: user.lockedUntil?.toISOString() ?? null },
    });
    throw invalidCredentials();
  }

  private event(
    ctx: RequestContext,
    actor: AuditEventInput['actor'],
    action: string,
    outcome: AuditEventInput['outcome'],
    metadata: Record<string, unknown>,
  ): AuditEventInput {
    return { actor, action, outcome, ip: ctx.ip, userAgent: ctx.userAgent, metadata };
  }

  private async record(ctx: RequestContext, e: Omit<AuditEventInput, 'ip' | 'userAgent'>): Promise<void> {
    await this.audit.record({ ...e, ip: ctx.ip, userAgent: ctx.userAgent });
  }
}

/** Stage after a successful second factor: a temporary password must be replaced first. */
export function afterSecondFactor(user: UserRecord): SessionStage {
  return user.passwordChangeRequired ? 'password_change' : 'full';
}

export function publicUser(u: SessionUser): { id: string; username: string; role: string } {
  return { id: u.id, username: u.username, role: u.role };
}
