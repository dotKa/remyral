import type { AuditEventInput, AuditRecorder } from '../audit/audit.js';
import type { Queryable } from '../db/pool.js';
import { newToken, type SessionLifetime, sha256 } from './sessions.js';

/**
 * p5-remember-device (docs/design/p5-remember-device.md): trusted devices ("Trust this device for 30
 * days") and the remember-me lifetime. The device token (256 bit) only exists in the `__Host-rtd` cookie;
 * the database stores its SHA-256. It replaces the TOTP step after a correct password, never step-up.
 */

export const DEVICE_COOKIE = '__Host-rtd';
export const MAX_TRUSTED_DEVICES = 10;
const DAY_MS = 24 * 60 * 60_000;

/** Both features; `null` = disabled (configured 0). */
export interface LoginPersistencePolicy {
  /** Lifetime of a device trust, fixed at creation. */
  readonly trustedDeviceMs: number | null;
  /** Lifetime of a "Remember me" full session. */
  readonly remember: SessionLifetime | null;
}

export const DEFAULT_LOGIN_PERSISTENCE: LoginPersistencePolicy = {
  trustedDeviceMs: 30 * DAY_MS,
  remember: { idleMs: 7 * DAY_MS, absoluteMs: 30 * DAY_MS },
};

/** Builds the policy from day counts (0 disables a feature). */
export function loginPersistenceFromDays(days: {
  readonly trustedDeviceDays: number;
  readonly rememberIdleDays: number;
  readonly rememberAbsoluteDays: number;
}): LoginPersistencePolicy {
  return {
    trustedDeviceMs: days.trustedDeviceDays > 0 ? days.trustedDeviceDays * DAY_MS : null,
    remember:
      days.rememberIdleDays > 0 && days.rememberAbsoluteDays > 0
        ? { idleMs: days.rememberIdleDays * DAY_MS, absoluteMs: days.rememberAbsoluteDays * DAY_MS }
        : null,
  };
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function wellFormedDeviceToken(token: string | undefined): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/**
 * Coarse, user-recognisable label ("Firefox on macOS") from a user agent. Deliberately lossy: no versions,
 * no device model, never the full string.
 */
export function deviceLabel(userAgent: string | null): string {
  const ua = (userAgent ?? '').slice(0, 1000);
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\/|Chromium\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua) && /Version\//.test(ua)
              ? 'Safari'
              : 'Unknown browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return os ? `${browser} on ${os}` : browser;
}

export interface TrustedDevice {
  readonly id: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly createdIp: string | null;
  readonly current: boolean;
}

/** Why a presented device token did not skip the code step (audited, never returned to the client). */
export type DeviceRejection =
  'unknown' | 'expired' | 'other_user' | 'mfa_reset' | 'reused' | 'password_change';

export type DeviceCheck =
  | { readonly ok: true; readonly id: string; readonly token: string; readonly expiresAt: Date }
  | {
      readonly ok: false;
      readonly reason: DeviceRejection;
      readonly clearCookie: boolean;
      /** The device row the token pointed at (deleted for expired / reused / MFA reset). */
      readonly deviceId?: string;
    };

interface DeviceRow {
  id: string;
  user_id: string;
  expires_at: Date;
  mfa_enrolled_at: Date;
}

function clip(ip: string | null): string | null {
  return ip === null ? null : ip.slice(0, 64);
}

/** Data access for `trusted_devices` (migration 0025). Parameterised queries only. */
export const trustedDevices = {
  /**
   * Inserts a trust for `userId` and evicts the oldest beyond {@link MAX_TRUSTED_DEVICES}; expired rows of
   * the user are removed on the way. Returns the cookie value (never stored) and the number evicted.
   */
  async create(
    db: Queryable,
    d: {
      userId: string;
      now: Date;
      lifetimeMs: number;
      mfaEnrolledAt: Date;
      ip: string | null;
      userAgent: string | null;
    },
  ): Promise<{ id: string; token: string; expiresAt: Date; evicted: number }> {
    const token = newToken();
    const expiresAt = new Date(d.now.getTime() + d.lifetimeMs);
    await db.query('DELETE FROM trusted_devices WHERE user_id = $1 AND expires_at <= $2', [d.userId, d.now]);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO trusted_devices (user_id, token_hash, label, created_ip, created_at, last_used_at,
                                    last_used_ip, expires_at, mfa_enrolled_at)
       VALUES ($1, $2, $3, $4, $5, $5, $4, $6, $7) RETURNING id`,
      [d.userId, sha256(token), deviceLabel(d.userAgent), clip(d.ip), d.now, expiresAt, d.mfaEnrolledAt],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('trusted device insert returned no id');
    const evicted = await db.query(
      `DELETE FROM trusted_devices WHERE id IN (
         SELECT id FROM trusted_devices WHERE user_id = $1
          ORDER BY created_at DESC, id DESC OFFSET $2)`,
      [d.userId, MAX_TRUSTED_DEVICES],
    );
    return { id, token, expiresAt, evicted: evicted.rowCount ?? 0 };
  },

  /**
   * Checks a presented token for `user` and, if usable, rotates it (compare-and-swap on the hash: two
   * concurrent uses of one value cannot both succeed). A value replaced by an earlier rotation is reuse:
   * the device is deleted.
   */
  async consume(
    db: Queryable,
    token: string,
    user: { id: string; totpEnrolledAt: Date | null },
    ctx: { now: Date; ip: string | null },
  ): Promise<DeviceCheck> {
    const hash = sha256(token);
    const { rows } = await db.query<DeviceRow>(
      'SELECT id, user_id, expires_at, mfa_enrolled_at FROM trusted_devices WHERE token_hash = $1',
      [hash],
    );
    const row = rows[0];
    if (!row) {
      // Only a copy can still hold a rotated-away value: whoever presents it, the trust is withdrawn.
      const reused = await db.query<{ id: string }>(
        'DELETE FROM trusted_devices WHERE prev_token_hash = $1 RETURNING id',
        [hash],
      );
      const id = reused.rows[0]?.id;
      if (id === undefined) return { ok: false, reason: 'unknown', clearCookie: true };
      return { ok: false, reason: 'reused', clearCookie: true, deviceId: id };
    }
    if (row.user_id !== user.id) return { ok: false, reason: 'other_user', clearCookie: false };
    if (row.expires_at <= ctx.now) {
      await db.query('DELETE FROM trusted_devices WHERE id = $1', [row.id]);
      return { ok: false, reason: 'expired', clearCookie: true, deviceId: row.id };
    }
    if (user.totpEnrolledAt === null || row.mfa_enrolled_at.getTime() !== user.totpEnrolledAt.getTime()) {
      await db.query('DELETE FROM trusted_devices WHERE id = $1', [row.id]);
      return { ok: false, reason: 'mfa_reset', clearCookie: true, deviceId: row.id };
    }
    const next = newToken();
    const { rowCount } = await db.query(
      `UPDATE trusted_devices SET token_hash = $3, prev_token_hash = $2, last_used_at = $4, last_used_ip = $5
        WHERE id = $1 AND token_hash = $2`,
      [row.id, hash, sha256(next), ctx.now, clip(ctx.ip)],
    );
    // Lost the race against a concurrent use of the same value: treat like a reused token.
    if (rowCount !== 1) return { ok: false, reason: 'reused', clearCookie: true, deviceId: row.id };
    return { ok: true, id: row.id, token: next, expiresAt: row.expires_at };
  },

  /** Unexpired devices of a user, newest first; `current` marks the one matching `currentToken`. */
  async list(
    db: Queryable,
    userId: string,
    now: Date,
    currentToken: string | undefined,
  ): Promise<TrustedDevice[]> {
    const current = wellFormedDeviceToken(currentToken) ? sha256(currentToken) : null;
    const { rows } = await db.query<{
      id: string;
      label: string;
      created_at: Date;
      last_used_at: Date;
      expires_at: Date;
      created_ip: string | null;
      current: boolean;
    }>(
      `SELECT id, label, created_at, last_used_at, expires_at, created_ip,
              (token_hash = $3::bytea) IS TRUE AS current
         FROM trusted_devices WHERE user_id = $1 AND expires_at > $2
        ORDER BY created_at DESC, id DESC`,
      [userId, now, current],
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      createdIp: r.created_ip,
      current: r.current,
    }));
  },

  /** Deletes one device of `userId`; returns whether it existed and whether it was `currentToken`'s. */
  async revoke(
    db: Queryable,
    userId: string,
    id: string,
    currentToken: string | undefined,
  ): Promise<{ revoked: boolean; current: boolean }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { revoked: false, current: false };
    }
    const { rows } = await db.query<{ token_hash: Buffer }>(
      'DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2 RETURNING token_hash',
      [id, userId],
    );
    const row = rows[0];
    if (!row) return { revoked: false, current: false };
    return {
      revoked: true,
      current: wellFormedDeviceToken(currentToken) && sha256(currentToken).equals(row.token_hash),
    };
  },

  async deleteAllForUser(db: Queryable, userId: string): Promise<number> {
    const { rowCount } = await db.query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]);
    return rowCount ?? 0;
  },
};

/** Reasons for revoking every trusted device of an account (audit metadata). */
export type BulkRevokeReason =
  'user_all' | 'password_change' | 'admin_reset' | 'logout_all' | 'disabled' | 'role_elevation';

/**
 * Revokes every trusted device of `userId` inside the caller's transaction and, when there were any,
 * audits one `auth.trusted_device.revoke` event `{reason, devices}` in the same transaction.
 */
export async function revokeAllTrustedDevices(
  tx: Queryable,
  audit: AuditRecorder,
  e: {
    userId: string;
    reason: BulkRevokeReason;
    actor: AuditEventInput['actor'];
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<number> {
  const n = await trustedDevices.deleteAllForUser(tx, e.userId);
  if (n > 0) {
    await audit.record(
      {
        actor: e.actor,
        action: 'auth.trusted_device.revoke',
        target: `user:${e.userId}`,
        outcome: 'success',
        ip: e.ip ?? null,
        userAgent: e.userAgent ?? null,
        metadata: { reason: e.reason, devices: n },
      },
      tx,
    );
  }
  return n;
}
