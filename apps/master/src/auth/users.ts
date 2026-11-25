import type { Queryable } from '../db/pool.js';
import { type LockoutPolicy, lockoutDurationMs } from './lockout.js';

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'admin', 'operator', 'viewer'];

/** Lower-case, 3–32 chars; mirrors the CHECK constraint in migration 0002. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_.-]{2,31}$/;

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly passwordHash: string;
  readonly totpSecretEnc: Buffer | null;
  readonly totpEnabled: boolean;
  /** When the current TOTP enrollment was confirmed (the "MFA epoch" trusted devices are bound to). */
  readonly totpEnrolledAt: Date | null;
  readonly lastTotpStep: number | null;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  /** Set when an owner disabled the account (p5-rbac-api): no login, no sessions. */
  readonly disabledAt: Date | null;
  /** Set for accounts created with a temporary password (p5-self-password): change it before anything else. */
  readonly passwordChangeRequired: boolean;
}

interface UserRow {
  id: string;
  username: string;
  role: Role;
  password_hash: string;
  totp_secret_enc: Buffer | null;
  totp_enabled: boolean;
  totp_enrolled_at: Date | null;
  last_totp_step: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  disabled_at: Date | null;
  password_change_required: boolean;
}

const COLUMNS =
  'id, username, role, password_hash, totp_secret_enc, totp_enabled, totp_enrolled_at, last_totp_step, failed_attempts, locked_until, disabled_at, password_change_required';

function toRecord(r: UserRow): UserRecord {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    passwordHash: r.password_hash,
    totpSecretEnc: r.totp_secret_enc,
    totpEnabled: r.totp_enabled,
    totpEnrolledAt: r.totp_enrolled_at,
    lastTotpStep: r.last_totp_step === null ? null : Number(r.last_totp_step),
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
    disabledAt: r.disabled_at,
    passwordChangeRequired: r.password_change_required,
  };
}

/** Data access for `users` and `recovery_codes`. Parameterised queries only. */
export const users = {
  /**
   * The login lookup: people only. p16-api-tokens: a service account (`kind = 'service'`) is never returned, so it can
   * never sign in — the login answers exactly as for an unknown user.
   */
  async findByUsername(db: Queryable, username: string): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE username = $1 AND kind = 'human'`,
      [username],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async findById(db: Queryable, id: string): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  },

  /** Returns the new id, or null if the username is taken. */
  async create(
    db: Queryable,
    u: {
      username: string;
      role: Role;
      passwordHash: string;
      createdBy?: string | null;
      /** Temporary password handed over by someone else: force a change at first login. */
      passwordChangeRequired?: boolean;
    },
  ): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (username, role, password_hash, created_by, password_change_required)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [u.username, u.role, u.passwordHash, u.createdBy ?? null, u.passwordChangeRequired ?? false],
    );
    return rows[0]?.id ?? null;
  },

  async setPasswordHash(db: Queryable, id: string, passwordHash: string): Promise<void> {
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      id,
      passwordHash,
    ]);
  },

  /**
   * A password change by the account holder (p5-self-password): new hash, the forced-change flag cleared,
   * lockout counters reset.
   */
  async changePassword(db: Queryable, id: string, passwordHash: string, now: Date): Promise<void> {
    await db.query(
      `UPDATE users SET password_hash = $2, password_change_required = false, password_changed_at = $3,
              failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [id, passwordHash, now],
    );
  },

  /** Counts a failed factor and applies the lockout policy. */
  async recordFailure(
    db: Queryable,
    id: string,
    now: Date,
    policy: LockoutPolicy,
  ): Promise<{ failedAttempts: number; lockedUntil: Date | null }> {
    const { rows } = await db.query<{ failed_attempts: number }>(
      'UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = now() WHERE id = $1 RETURNING failed_attempts',
      [id],
    );
    const failedAttempts = rows[0]?.failed_attempts ?? 0;
    const ms = lockoutDurationMs(failedAttempts, policy);
    if (ms === 0) return { failedAttempts, lockedUntil: null };
    const lockedUntil = new Date(now.getTime() + ms);
    await db.query('UPDATE users SET locked_until = $2 WHERE id = $1', [id, lockedUntil]);
    return { failedAttempts, lockedUntil };
  },

  async recordSuccessfulLogin(db: Queryable, id: string, now: Date): Promise<void> {
    await db.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = $2, updated_at = now() WHERE id = $1',
      [id, now],
    );
  },

  /** Atomically advances last_totp_step; false if `step` was already used (replay or concurrent use). */
  async consumeTotpStep(db: Queryable, id: string, step: number): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE users SET last_totp_step = $2, updated_at = now()
        WHERE id = $1 AND (last_totp_step IS NULL OR last_totp_step < $2)`,
      [id, step],
    );
    return rowCount === 1;
  },

  async setPendingTotpSecret(db: Queryable, id: string, secretEnc: Buffer): Promise<boolean> {
    const { rowCount } = await db.query(
      'UPDATE users SET totp_secret_enc = $2, updated_at = now() WHERE id = $1 AND NOT totp_enabled',
      [id, secretEnc],
    );
    return rowCount === 1;
  },

  async enableTotp(db: Queryable, id: string, step: number, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE users SET totp_enabled = true, totp_enrolled_at = $3, last_totp_step = $2, updated_at = now()
        WHERE id = $1 AND NOT totp_enabled AND totp_secret_enc IS NOT NULL`,
      [id, step, now],
    );
    return rowCount === 1;
  },

  /** Shell-access recovery (admin:reset --reset-mfa): forces re-enrollment at next login. */
  async resetMfa(db: Queryable, id: string): Promise<void> {
    await db.query(
      `UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_enrolled_at = NULL,
              last_totp_step = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    await db.query('DELETE FROM recovery_codes WHERE user_id = $1', [id]);
  },

  async unlock(db: Queryable, id: string): Promise<void> {
    await db.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
      [id],
    );
  },

  async replaceRecoveryCodes(db: Queryable, userId: string, hashes: readonly Buffer[]): Promise<void> {
    await db.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const h of hashes) {
      await db.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, h]);
    }
  },

  /** Marks a matching unused code as used; false if none matched. Single use is enforced in SQL. */
  async consumeRecoveryCode(db: Queryable, userId: string, hash: Buffer, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      'UPDATE recovery_codes SET used_at = $3 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
      [userId, hash, now],
    );
    return rowCount === 1;
  },

  async countUnusedRecoveryCodes(db: Queryable, userId: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [userId],
    );
    return rows[0]?.n ?? 0;
  },
};
