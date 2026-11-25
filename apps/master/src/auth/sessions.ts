import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import type { Role } from './users.js';

/**
 * Server-side sessions (ADR-0009 §8). The browser holds a 256-bit random id; the database stores only its
 * SHA-256, so a DB read does not yield usable session ids. Same for the CSRF token.
 */
/**
 * `password_change` (p5-self-password): both factors passed, but the account still holds a temporary
 * password; only POST /auth/password/initial is reachable (short pending lifetime like the other stages).
 */
export type SessionStage = 'mfa_pending' | 'enrollment' | 'password_change' | 'full';

export const SESSION_TIMEOUTS = {
  /** Full session idle timeout. */
  idleMs: 30 * 60_000,
  /** Full session absolute lifetime. */
  absoluteMs: 12 * 60 * 60_000,
  /** Lifetime of the intermediate login states (password accepted, second factor outstanding). */
  pendingMs: 5 * 60_000,
  /** last_seen_at is written at most this often. */
  touchIntervalMs: 60_000,
} as const;

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
}

export interface SessionRecord {
  readonly idHash: Buffer;
  readonly stage: SessionStage;
  readonly csrfHash: Buffer;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly mfaAt: Date | null;
  readonly mfaFailures: number;
  /** p5-remember-device: a "Remember me" session (longer idle/absolute lifetime). */
  readonly remember: boolean;
  /** Idle timeout of this session (full stage), stored with the row. */
  readonly idleTimeoutMs: number;
  /**
   * p5-stepup-window: the trusted device this session was established on (login with the device cookie, or
   * the second factor that created the trust). Cleared by the database when the device is revoked.
   */
  readonly trustedDeviceId: string | null;
  readonly user: SessionUser;
}

/** Idle and absolute lifetime of a full session. */
export interface SessionLifetime {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

export const STANDARD_LIFETIME: SessionLifetime = {
  idleMs: SESSION_TIMEOUTS.idleMs,
  absoluteMs: SESSION_TIMEOUTS.absoluteMs,
};

export interface IssuedSession {
  /** Opaque cookie value. Never logged, never stored. */
  readonly token: string;
  readonly csrfToken: string;
  readonly stage: SessionStage;
  readonly expiresAt: Date;
  readonly remember: boolean;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Idle deadline for a session (pending stages have only their short absolute lifetime). */
export function idleExpiry(
  s: Pick<SessionRecord, 'stage' | 'lastSeenAt' | 'expiresAt'> & { readonly idleTimeoutMs?: number },
): Date {
  if (s.stage !== 'full') return s.expiresAt;
  const idle = new Date(s.lastSeenAt.getTime() + (s.idleTimeoutMs ?? SESSION_TIMEOUTS.idleMs));
  return idle < s.expiresAt ? idle : s.expiresAt;
}

interface SessionRow {
  id_hash: Buffer;
  stage: SessionStage;
  csrf_hash: Buffer;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  mfa_at: Date | null;
  mfa_failures: number;
  remember: boolean;
  idle_timeout_s: number;
  trusted_device_id: string | null;
  user_id: string;
  username: string;
  role: Role;
}

export const sessions = {
  async create(
    db: Queryable,
    s: {
      userId: string;
      stage: SessionStage;
      now: Date;
      mfaAt: Date | null;
      ip: string | null;
      userAgent: string | null;
      /**
       * p5-remember-device: a remembered login. Pending stages only carry the flag (they keep their 5-minute
       * lifetime); a full session gets `lifetime`.
       */
      remember?: boolean;
      /** Lifetime of a full session (default: standard 30 min idle / 12 h absolute). */
      lifetime?: SessionLifetime;
      /** p5-stepup-window: the trusted device the session is established on. */
      trustedDeviceId?: string | null;
    },
  ): Promise<IssuedSession> {
    const token = newToken();
    const csrfToken = newToken();
    const full = s.lifetime ?? STANDARD_LIFETIME;
    const lifetime = s.stage === 'full' ? full.absoluteMs : SESSION_TIMEOUTS.pendingMs;
    const expiresAt = new Date(s.now.getTime() + lifetime);
    await db.query(
      `INSERT INTO sessions (id_hash, user_id, stage, csrf_hash, created_at, last_seen_at, expires_at, mfa_at, ip,
                             user_agent, remember, idle_timeout_s, trusted_device_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        sha256(token),
        s.userId,
        s.stage,
        sha256(csrfToken),
        s.now,
        expiresAt,
        s.mfaAt,
        s.ip,
        s.userAgent?.slice(0, 500) ?? null,
        s.remember ?? false,
        Math.max(1, Math.round(full.idleMs / 1000)),
        s.trustedDeviceId ?? null,
      ],
    );
    // Opportunistic cleanup keeps the table small without a separate job (each row's own idle timeout).
    await db.query(
      `DELETE FROM sessions
        WHERE expires_at < $1
           OR (stage = 'full' AND last_seen_at < $1 - make_interval(secs => idle_timeout_s))`,
      [s.now],
    );
    return { token, csrfToken, stage: s.stage, expiresAt, remember: s.remember ?? false };
  },

  /**
   * p7-rate-limit session hardening: replaces the session id (and CSRF token) after a privilege change
   * within the session (step-up). Stage, creation time and the **absolute expiry are kept**, so rotation
   * can never extend a session's lifetime. The old id stops working in the same transaction. The session
   * type (`remember`, idle timeout) and the trusted-device binding are kept (p5-stepup-window).
   */
  async rotate(
    db: Queryable,
    s: SessionRecord,
    opts: { now: Date; mfaAt: Date | null; ip: string | null; userAgent: string | null },
  ): Promise<IssuedSession> {
    const token = newToken();
    const csrfToken = newToken();
    const { rowCount } = await db.query(
      `INSERT INTO sessions (id_hash, user_id, stage, csrf_hash, created_at, last_seen_at, expires_at, mfa_at,
                             mfa_failures, ip, user_agent, remember, idle_timeout_s, trusted_device_id)
       SELECT $2, user_id, stage, $3, created_at, $4, expires_at, $5, mfa_failures, $6, $7, remember, idle_timeout_s,
              trusted_device_id
         FROM sessions WHERE id_hash = $1`,
      [
        s.idHash,
        sha256(token),
        sha256(csrfToken),
        opts.now,
        opts.mfaAt,
        opts.ip,
        opts.userAgent?.slice(0, 500) ?? null,
      ],
    );
    if (rowCount !== 1) throw new Error('session to rotate no longer exists');
    // p19-ide W2: the IDE origin's access (tickets, cookie sessions) belongs to the console session; it follows the
    // rotation instead of ending with the old id (migration 0186, ON DELETE CASCADE below).
    await db.query('UPDATE ide_access SET session_hash = $2 WHERE session_hash = $1', [
      s.idHash,
      sha256(token),
    ]);
    await db.query('DELETE FROM sessions WHERE id_hash = $1', [s.idHash]);
    return { token, csrfToken, stage: s.stage, expiresAt: s.expiresAt, remember: s.remember };
  },

  /** Looks up a live session; expired ones (idle or absolute) are deleted and reported as absent. */
  async find(db: Queryable, token: string, now: Date): Promise<SessionRecord | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const { rows } = await db.query<SessionRow>(
      `SELECT s.id_hash, s.stage, s.csrf_hash, s.created_at, s.last_seen_at, s.expires_at, s.mfa_at,
              s.mfa_failures, s.remember, s.idle_timeout_s, s.trusted_device_id, u.id AS user_id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND u.disabled_at IS NULL`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    const record: SessionRecord = {
      idHash: r.id_hash,
      stage: r.stage,
      csrfHash: r.csrf_hash,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      mfaAt: r.mfa_at,
      mfaFailures: r.mfa_failures,
      remember: r.remember,
      idleTimeoutMs: r.idle_timeout_s * 1000,
      trustedDeviceId: r.trusted_device_id,
      user: { id: r.user_id, username: r.username, role: r.role },
    };
    if (now >= idleExpiry(record)) {
      await db.query('DELETE FROM sessions WHERE id_hash = $1', [r.id_hash]);
      return null;
    }
    return record;
  },

  /** p5-stepup-window: records the trusted device a freshly issued session is established on. */
  async bindTrustedDevice(db: Queryable, token: string, deviceId: string): Promise<void> {
    await db.query('UPDATE sessions SET trusted_device_id = $2 WHERE id_hash = $1', [
      sha256(token),
      deviceId,
    ]);
  },

  async touch(db: Queryable, s: SessionRecord, now: Date): Promise<void> {
    if (s.stage !== 'full' || now.getTime() - s.lastSeenAt.getTime() < SESSION_TIMEOUTS.touchIntervalMs)
      return;
    await db.query('UPDATE sessions SET last_seen_at = $2 WHERE id_hash = $1', [s.idHash, now]);
  },

  async delete(db: Queryable, idHash: Buffer): Promise<void> {
    await db.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
  },

  async deleteByToken(db: Queryable, token: string): Promise<void> {
    if (!TOKEN_PATTERN.test(token)) return;
    await db.query('DELETE FROM sessions WHERE id_hash = $1', [sha256(token)]);
  },

  /**
   * Revokes every session of the user. p8-pwa: the user's push subscriptions go with them (same
   * transaction) — every path that ends all sessions (log out everywhere, password change, admin reset,
   * disable, role elevation) also stops notifications reaching the user's devices.
   */
  async deleteAllForUser(db: Queryable, userId: string): Promise<number> {
    await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
    const { rowCount } = await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return rowCount ?? 0;
  },

  async incrementMfaFailures(db: Queryable, idHash: Buffer): Promise<number> {
    const { rows } = await db.query<{ mfa_failures: number }>(
      'UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE id_hash = $1 RETURNING mfa_failures',
      [idHash],
    );
    return rows[0]?.mfa_failures ?? 0;
  },
};
