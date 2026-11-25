import { createHash, randomBytes } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  describePolicyFailure,
  hashPassword,
  policyFailureParams,
  type ScryptParams,
} from '../auth/password.js';
import { base32Encode } from '../auth/totp.js';
import { USERNAME_PATTERN, users } from '../auth/users.js';

/**
 * p16-selfhost-onboarding (docs/design/p16-selfhost-onboarding.md §3, ADR-0063): the one-time setup token of a fresh
 * install. `remyral-ctl install` asks the master for one (`remyral-master setup:token`) and prints it once; the owner
 * opens `/setup` and creates the FIRST account (role owner) with it — no shell, no default password. The usual
 * first-login flow follows (authenticator enrollment is mandatory, ADR-0009).
 *
 * - Only SHA-256 of the token is stored; a new token replaces any unused one; single use; 24 h by default.
 * - Every operation refuses once any account exists (`setup_done`): the token can never add a second owner.
 * - Issue and claim serialise on one advisory lock, so two claims (or a claim and `admin:create`) cannot both win.
 */

export const SETUP_TOKEN_PATTERN = /^rst_[a-z2-7]{32}$/;
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60_000;
const LOCK_KEY = 'remyral.setup-token';
const SETUP_ACTOR = { type: 'system' as const, id: 'setup-token' };
const CLI_ACTOR = { type: 'system' as const, id: 'cli' };

export type SetupFailure =
  'setup_done' | 'invalid_setup_token' | 'invalid_username' | 'weak_password' | 'username_taken';

/** A refusal whose `message` is safe to show (never contains the token or the password). */
export class SetupError extends Error {
  override name = 'SetupError';
  constructor(
    readonly code: SetupFailure,
    message: string,
    /** Error-body params (the password policy reason, as the other password routes send it). */
    readonly params: ReturnType<typeof policyFailureParams> = {},
  ) {
    super(message);
  }
}

export const setupTokenHash = (token: string): Buffer =>
  createHash('sha256').update(`remyral-setup-token/v1\n${token}`).digest();

export function newSetupToken(random: (n: number) => Buffer = randomBytes): string {
  return `rst_${base32Encode(random(20)).toLowerCase()}`;
}

export interface SetupDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  readonly passwordParams?: ScryptParams;
  readonly random?: (n: number) => Buffer;
}

export class SetupService {
  constructor(private readonly deps: SetupDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** True while no account exists: the console offers `/setup`. */
  async required(): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ none: boolean }>(
      'SELECT NOT EXISTS (SELECT 1 FROM users) AS none',
    );
    return rows[0]?.none === true;
  }

  /** A new token (any unused one is withdrawn). The token itself is returned once and never stored. */
  async issue(opts: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: Date }> {
    const ttl = opts.ttlMs ?? SETUP_TOKEN_TTL_MS;
    if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 7 * 24 * 60 * 60_000) {
      throw new RangeError('setup token lifetime must be between 1 minute and 7 days');
    }
    const token = newSetupToken(this.deps.random);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttl);
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
      const { rows } = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
      if (rows[0]?.n !== '0')
        throw new SetupError('setup_done', 'This installation has an account already; sign in.');
      const withdrawn = await tx.query('DELETE FROM setup_tokens WHERE used_at IS NULL');
      await tx.query('INSERT INTO setup_tokens (token_hash, created_at, expires_at) VALUES ($1, $2, $3)', [
        setupTokenHash(token),
        now,
        expiresAt,
      ]);
      await this.deps.audit.record(
        {
          actor: CLI_ACTOR,
          action: 'setup.token.issue',
          target: 'setup',
          outcome: 'success',
          metadata: { expiresAt: expiresAt.toISOString(), withdrawn: withdrawn.rowCount ?? 0 },
        },
        tx,
      );
    });
    return { token, expiresAt };
  }

  /** Creates the first owner with a valid unused token. Audited as `user.create` + `setup.token.claim`. */
  async claim(
    input: { token: string; username: string; password: string },
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ userId: string; username: string }> {
    const token = input.token.trim();
    if (!USERNAME_PATTERN.test(input.username)) {
      throw new SetupError(
        'invalid_username',
        'Username must be 3-32 characters: a-z first, then a-z, 0-9, ".", "_" or "-".',
      );
    }
    const policy = checkPasswordPolicy(input.password, input.username);
    if (!policy.ok) {
      throw new SetupError(
        'weak_password',
        describePolicyFailure(policy.reason),
        policyFailureParams(policy.reason),
      );
    }
    // Hash before the transaction (slow); the token is checked inside it.
    const passwordHash = await hashPassword(
      input.password,
      this.deps.passwordParams ?? DEFAULT_SCRYPT_PARAMS,
    );
    const now = this.now();
    const audit = { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null };
    const outcome = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
      const { rows: count } = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
      if (count[0]?.n !== '0') return { ok: false as const, code: 'setup_done' as const };
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM setup_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
          FOR UPDATE`,
        [SETUP_TOKEN_PATTERN.test(token) ? setupTokenHash(token) : Buffer.alloc(32), now],
      );
      const row = rows[0];
      if (row === undefined) return { ok: false as const, code: 'invalid_setup_token' as const };
      const userId = await users.create(tx, { username: input.username, role: 'owner', passwordHash });
      if (userId === null) return { ok: false as const, code: 'username_taken' as const };
      await tx.query('UPDATE setup_tokens SET used_at = $2, used_by = $3 WHERE id = $1', [
        row.id,
        now,
        userId,
      ]);
      await this.deps.audit.record(
        {
          actor: SETUP_ACTOR,
          action: 'user.create',
          target: `user:${userId}`,
          outcome: 'success',
          ...audit,
          metadata: { username: input.username, role: 'owner', via: 'setup-token' },
        },
        tx,
      );
      await this.deps.audit.record(
        {
          actor: SETUP_ACTOR,
          action: 'setup.token.claim',
          target: `user:${userId}`,
          outcome: 'success',
          ...audit,
        },
        tx,
      );
      return { ok: true as const, userId };
    });
    if (!outcome.ok) {
      await this.deps.audit.record({
        actor: { type: 'anonymous' },
        action: 'setup.token.claim',
        target: 'setup',
        outcome: 'denied',
        ...audit,
        metadata: { reason: outcome.code },
      });
      // The messages equal the EN error catalog (packages/i18n errors), so the console shows them translated.
      if (outcome.code === 'setup_done') {
        throw new SetupError('setup_done', 'This installation has an account already; sign in.');
      }
      if (outcome.code === 'username_taken')
        throw new SetupError('username_taken', 'That username is taken.');
      throw new SetupError(
        'invalid_setup_token',
        'The setup token is wrong, used or expired. remyral-ctl setup-token on the server prints a new one.',
      );
    }
    return { userId: outcome.userId, username: input.username };
  }
}
