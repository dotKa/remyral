import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  describePolicyFailure,
  hashPassword,
  type ScryptParams,
} from '../auth/password.js';
import { sessions } from '../auth/sessions.js';
import { revokeAllTrustedDevices } from '../auth/trusted-devices.js';
import { type Role, ROLES, USERNAME_PATTERN, users } from '../auth/users.js';

/** Operator-facing failure with a message that is safe to print (never contains the password). */
export class AdminError extends Error {
  override name = 'AdminError';
}

export interface AdminDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly passwordParams?: ScryptParams;
}

const CLI_ACTOR = { type: 'system' as const, id: 'cli' };

export function validateUsername(username: string): string {
  if (!USERNAME_PATTERN.test(username)) {
    throw new AdminError('username must be 3-32 chars: a-z first, then a-z, 0-9, ".", "_" or "-"');
  }
  return username;
}

export function parseRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role))
    throw new AdminError(`role must be one of ${ROLES.join(', ')}`);
  return role as Role;
}

export function validateNewPassword(password: string, confirmation: string, username: string): void {
  if (password !== confirmation) throw new AdminError('passwords do not match');
  const policy = checkPasswordPolicy(password, username);
  if (!policy.ok) throw new AdminError(describePolicyFailure(policy.reason));
}

export async function assertUserAbsent(pool: Pool, username: string): Promise<void> {
  if (await users.findByUsername(pool, username)) throw new AdminError(`user "${username}" already exists`);
}

/** Creates a user (no TOTP yet: enrollment is forced at first login). Refuses existing usernames. */
export async function createUser(
  deps: AdminDeps,
  input: { username: string; role: Role; password: string },
): Promise<string> {
  const policy = checkPasswordPolicy(input.password, input.username);
  if (!policy.ok) throw new AdminError(describePolicyFailure(policy.reason));
  const passwordHash = await hashPassword(input.password, deps.passwordParams ?? DEFAULT_SCRYPT_PARAMS);
  return withTransaction(deps.pool, async (tx) => {
    const id = await users.create(tx, { username: input.username, role: input.role, passwordHash });
    if (!id) throw new AdminError(`user "${input.username}" already exists`);
    await deps.audit.record(
      {
        actor: CLI_ACTOR,
        action: 'user.create',
        target: `user:${id}`,
        outcome: 'success',
        metadata: { username: input.username, role: input.role },
      },
      tx,
    );
    return id;
  });
}

export interface ResetOptions {
  readonly username: string;
  readonly resetMfa: boolean;
  readonly unlock: boolean;
  readonly newPassword?: string;
}

/**
 * Shell-access recovery (docs/ops/admin-bootstrap.md): optionally resets TOTP (forcing re-enrollment and
 * invalidating recovery codes), sets a new password and/or clears the lockout. Always revokes every
 * session of the user. Audited as one event.
 */
export async function resetUser(deps: AdminDeps, opts: ResetOptions): Promise<{ revokedSessions: number }> {
  if (!opts.resetMfa && !opts.unlock && opts.newPassword === undefined) {
    throw new AdminError('nothing to do: pass --reset-mfa, --reset-password and/or --unlock');
  }
  const user = await users.findByUsername(deps.pool, opts.username);
  if (!user) throw new AdminError(`user "${opts.username}" does not exist`);
  const passwordHash =
    opts.newPassword === undefined
      ? undefined
      : await hashPassword(opts.newPassword, deps.passwordParams ?? DEFAULT_SCRYPT_PARAMS);
  return withTransaction(deps.pool, async (tx) => {
    if (opts.resetMfa) await users.resetMfa(tx, user.id);
    if (passwordHash !== undefined) await users.setPasswordHash(tx, user.id, passwordHash);
    if (opts.unlock || passwordHash !== undefined) await users.unlock(tx, user.id);
    const revokedSessions = await sessions.deleteAllForUser(tx, user.id);
    // p5-remember-device: shell recovery (MFA reset, new password, unlock) also ends every device trust.
    const revokedDevices = await revokeAllTrustedDevices(tx, deps.audit, {
      userId: user.id,
      reason: 'admin_reset',
      actor: CLI_ACTOR,
    });
    await deps.audit.record(
      {
        actor: CLI_ACTOR,
        action: 'user.reset',
        target: `user:${user.id}`,
        outcome: 'success',
        metadata: {
          username: user.username,
          // A list of values, not `passwordReset: true`: keys containing "password" are redacted.
          resets: [
            ...(opts.resetMfa ? ['mfa'] : []),
            ...(passwordHash !== undefined ? ['password'] : []),
            ...(opts.unlock || passwordHash !== undefined ? ['lockout'] : []),
          ],
          revokedSessions,
          revokedDevices,
        },
      },
      tx,
    );
    return { revokedSessions };
  });
}
