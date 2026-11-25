import { randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { hashPassword, type ScryptParams } from '../auth/password.js';
import { sessions } from '../auth/sessions.js';
import { revokeAllTrustedDevices } from '../auth/trusted-devices.js';
import { type Role, users } from '../auth/users.js';
import { temporaryPassword } from '../authz/directory.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';

/**
 * p17-panel-settings Part 4 (docs/design/p17-panel-settings.md §6): recovering another user's account from the panel
 * (Ayarlar → Kullanıcılar) instead of `admin:reset` on the host — the same three operations:
 *
 * - `reset-mfa`: the authenticator and the recovery codes go (enrolment again at the next sign-in);
 * - `reset-password`: a one-time password (144 random bits, the account-creation rule) is generated and shown **once**
 *   to the person who applies the request; the user must replace it at the first sign-in;
 * - `unlock`: the failed sign-in lock goes.
 *
 * Each ends the user's sessions and trusted devices (not `unlock`), is audited (`user.recover.<action>`, never the
 * password) and notifies the user (in-app and by e-mail whatever the preference) and every owner.
 *
 * Who: owners recover anyone but themselves; admins recover operators and viewers only (the role model: account
 * changes are an owner's, the admin keeps day-to-day unlocks of the people they work with). An **owner** target
 * needs a second owner's approval while a third active owner exists (one who is neither the requester nor the
 * target); with exactly two owners the other owner is the only one who could approve and is the one locked out, so
 * the requester's always-fresh authenticator code is the control (decision recorded in the design note). The route
 * asks for an always-fresh step-up for every one of these.
 */

export const RECOVERY_ACTIONS = ['reset-mfa', 'reset-password', 'unlock'] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export interface RecoveryActor {
  readonly userId: string;
  readonly role: Role;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export type RecoveryOutcome =
  | {
      readonly status: 'applied';
      readonly temporaryPassword: string | null;
      readonly revokedSessions: number;
    }
  | { readonly status: 'pending'; readonly requestId: string };

export interface RecoveryRequestView {
  readonly id: string;
  readonly action: RecoveryAction;
  readonly target: { readonly id: string; readonly username: string };
  readonly requestedBy: string | null;
  readonly reason: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

const TTL_MS = 24 * 60 * 60_000;
const ACTION_TEXT: Readonly<Record<RecoveryAction, string>> = {
  'reset-mfa': 'authenticator reset',
  'reset-password': 'password reset',
  unlock: 'unlock',
};

export class UserRecoveryService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly notifications: () => NotificationService | null;
      readonly passwordParams?: ScryptParams;
      readonly log?: { warn(obj: unknown, msg: string): void };
    },
  ) {}

  private async target(
    db: Queryable,
    id: string,
  ): Promise<{ id: string; username: string; role: Role; kind: string; disabled: boolean }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'Not found.');
    const { rows } = await db.query<{
      id: string;
      username: string;
      role: Role;
      kind: string;
      disabled_at: Date | null;
    }>('SELECT id, username, role, kind, disabled_at FROM users WHERE id = $1 FOR UPDATE', [id]);
    const r = rows[0];
    if (r === undefined || r.kind !== 'human') throw new HttpError(404, 'not_found', 'Not found.');
    return { id: r.id, username: r.username, role: r.role, kind: r.kind, disabled: r.disabled_at !== null };
  }

  /** Owners for anyone but themselves; admins for operators and viewers. */
  private allowed(actor: RecoveryActor, target: { id: string; role: Role }): void {
    if (actor.userId === target.id) {
      throw new HttpError(409, 'self_change', 'You cannot change or disable your own account here.');
    }
    const ok =
      actor.role === 'owner' ||
      (actor.role === 'admin' && (target.role === 'operator' || target.role === 'viewer'));
    if (!ok) {
      throw new HttpError(403, 'recovery_not_allowed', 'Only an owner can recover this account.');
    }
  }

  /** Active owners other than `a` and `b` (the ones who can approve a reset of an owner). */
  private async thirdOwners(db: Queryable, a: string, b: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'owner' AND kind = 'human' AND disabled_at IS NULL AND id <> $1 AND id <> $2
        ORDER BY id`,
      [a, b],
    );
    return rows.map((r) => r.id);
  }

  async recover(
    actor: RecoveryActor,
    targetId: string,
    input: { readonly action: RecoveryAction; readonly reason?: string },
  ): Promise<RecoveryOutcome> {
    const reason = (input.reason ?? '').trim().slice(0, 300);
    const now = this.deps.clock();
    const pending = await withTransaction(this.deps.pool, async (tx) => {
      const t = await this.target(tx, targetId);
      this.allowed(actor, t);
      if (t.role !== 'owner') return null;
      const approvers = await this.thirdOwners(tx, actor.userId, t.id);
      if (approvers.length === 0) return null;
      const id = randomUUID();
      const { rowCount } = await tx.query(
        `INSERT INTO user_recovery_requests (id, target_id, action, reason, state, requested_by, requested_at, expires_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
         ON CONFLICT (target_id, action) WHERE state = 'pending' DO NOTHING`,
        [id, t.id, input.action, reason, actor.userId, now, new Date(now.getTime() + TTL_MS)],
      );
      if (rowCount === 0) {
        throw new HttpError(
          409,
          'recovery_pending',
          'The same recovery already waits for an owner’s approval.',
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          action: `user.recover.${input.action}.request`,
          target: `user:${t.id}`,
          outcome: 'success',
          metadata: { username: t.username, requestId: id, reason, approvers: approvers.length },
        },
        tx,
      );
      return { id, approvers, username: t.username };
    });
    if (pending !== null) {
      await this.tell(pending.approvers, {
        dedupeKey: `account.recovery:request:${pending.id}`,
        title: `Approval needed: ${ACTION_TEXT[input.action]} for ${pending.username}`,
        body: `Another owner asked for an ${ACTION_TEXT[input.action]} of the owner account ${pending.username}. It applies only after a second owner approves it (Settings → Users).`,
        mandatoryEmail: false,
      });
      return { status: 'pending', requestId: pending.id };
    }
    return this.apply(actor, targetId, input.action, reason, null);
  }

  /** Applies a recovery (checks again: who may, not oneself). */
  private async apply(
    actor: RecoveryActor,
    targetId: string,
    action: RecoveryAction,
    reason: string,
    requestId: string | null,
  ): Promise<RecoveryOutcome> {
    const password = action === 'reset-password' ? await this.newPassword(targetId) : null;
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const t = await this.target(tx, targetId);
      this.allowed(actor, t);
      if (password !== null && password.username !== t.username) throw new Error('target changed');
      if (action === 'reset-mfa') await users.resetMfa(tx, t.id);
      if (password !== null) {
        await users.setPasswordHash(tx, t.id, password.hash);
        await tx.query('UPDATE users SET password_change_required = true WHERE id = $1', [t.id]);
      }
      await users.unlock(tx, t.id);
      let revokedSessions = 0;
      let revokedDevices = 0;
      if (action !== 'unlock') {
        revokedSessions = await sessions.deleteAllForUser(tx, t.id);
        revokedDevices = await revokeAllTrustedDevices(tx, this.deps.audit, {
          userId: t.id,
          reason: 'admin_reset',
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
        });
      }
      if (requestId !== null) {
        const { rowCount } = await tx.query(
          `UPDATE user_recovery_requests SET state = 'applied', decided_by = $2, decided_at = $3
            WHERE id = $1 AND state = 'pending'`,
          [requestId, actor.userId, this.deps.clock()],
        );
        if (rowCount === 0)
          throw new HttpError(409, 'recovery_not_pending', 'This request is not waiting any more.');
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          action: `user.recover.${action}`,
          target: `user:${t.id}`,
          outcome: 'success',
          // Never the temporary password (it exists only in the response).
          metadata: {
            username: t.username,
            targetRole: t.role,
            reason,
            revokedSessions,
            revokedDevices,
            ...(requestId === null ? {} : { requestId }),
          },
        },
        tx,
      );
      return { username: t.username, revokedSessions };
    });
    await this.tell([targetId], {
      dedupeKey: `account.recovery:${action}:${targetId}:${String(this.deps.clock().getTime())}`,
      title: `Your account: ${ACTION_TEXT[action]} by an administrator`,
      body:
        action === 'reset-password'
          ? 'An administrator reset your password and ended your sessions. Sign in with the one-time password they give you and choose a new one. If you did not expect this, contact an owner at once.'
          : action === 'reset-mfa'
            ? 'An administrator reset your authenticator and ended your sessions. Set up the authenticator again at the next sign-in. If you did not expect this, contact an owner at once.'
            : 'An administrator removed the sign-in lock of your account.',
      mandatoryEmail: true,
    });
    const owners = (await globalRecipients(this.deps.pool, 'owner')).filter((id) => id !== targetId);
    await this.tell(owners, {
      dedupeKey: `account.recovery:owners:${action}:${targetId}:${String(this.deps.clock().getTime())}`,
      title: `${ACTION_TEXT[action]}: ${out.username}`,
      body: `An administrator applied an ${ACTION_TEXT[action]} to the account ${out.username} (audited).`,
      mandatoryEmail: false,
    });
    return {
      status: 'applied',
      temporaryPassword: password?.plain ?? null,
      revokedSessions: out.revokedSessions,
    };
  }

  private async newPassword(targetId: string): Promise<{ username: string; plain: string; hash: string }> {
    const { rows } = await this.deps.pool.query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [targetId],
    );
    const username = rows[0]?.username;
    if (username === undefined) throw new HttpError(404, 'not_found', 'Not found.');
    const plain = temporaryPassword(username);
    const hash = await hashPassword(plain, this.deps.passwordParams);
    return { username, plain, hash };
  }

  async pending(): Promise<RecoveryRequestView[]> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      "UPDATE user_recovery_requests SET state = 'expired', decided_at = $1 WHERE state = 'pending' AND expires_at <= $1",
      [now],
    );
    const { rows } = await this.deps.pool.query<{
      id: string;
      action: RecoveryAction;
      target_id: string;
      target_name: string;
      by_name: string | null;
      reason: string;
      requested_at: Date;
      expires_at: Date;
    }>(
      `SELECT r.id, r.action, r.target_id, t.username AS target_name, b.username AS by_name, r.reason, r.requested_at,
              r.expires_at
         FROM user_recovery_requests r JOIN users t ON t.id = r.target_id LEFT JOIN users b ON b.id = r.requested_by
        WHERE r.state = 'pending' ORDER BY r.requested_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      target: { id: r.target_id, username: r.target_name },
      requestedBy: r.by_name,
      reason: r.reason,
      requestedAt: r.requested_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }));
  }

  /** A second owner approves (not the requester, not the target): the recovery applies now. */
  async approve(actor: RecoveryActor, requestId: string): Promise<RecoveryOutcome> {
    if (actor.role !== 'owner')
      throw new HttpError(403, 'recovery_not_allowed', 'Only an owner can recover this account.');
    const r = await this.request(requestId);
    if (r.requested_by === actor.userId || r.target_id === actor.userId) {
      throw new HttpError(
        409,
        'recovery_second_owner',
        'Another owner than the one who asked (and than the account itself) must approve.',
      );
    }
    return this.apply(actor, r.target_id, r.action, r.reason, r.id);
  }

  async cancel(actor: RecoveryActor, requestId: string): Promise<void> {
    if (actor.role !== 'owner')
      throw new HttpError(403, 'recovery_not_allowed', 'Only an owner can recover this account.');
    await this.request(requestId);
    await withTransaction(this.deps.pool, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE user_recovery_requests SET state = 'cancelled', decided_by = $2, decided_at = $3
          WHERE id = $1 AND state = 'pending'`,
        [requestId, actor.userId, this.deps.clock()],
      );
      if (rowCount === 0)
        throw new HttpError(409, 'recovery_not_pending', 'This request is not waiting any more.');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          action: 'user.recover.cancel',
          target: `recovery:${requestId}`,
          outcome: 'success',
        },
        tx,
      );
    });
  }

  private async request(id: string): Promise<{
    id: string;
    target_id: string;
    action: RecoveryAction;
    reason: string;
    requested_by: string | null;
  }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'Not found.');
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      id: string;
      target_id: string;
      action: RecoveryAction;
      reason: string;
      requested_by: string | null;
      state: string;
      expires_at: Date;
    }>(
      'SELECT id, target_id, action, reason, requested_by, state, expires_at FROM user_recovery_requests WHERE id = $1',
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'not_found', 'Not found.');
    if (r.state !== 'pending' || r.expires_at.getTime() <= now.getTime()) {
      throw new HttpError(409, 'recovery_not_pending', 'This request is not waiting any more.');
    }
    return r;
  }

  private async tell(
    recipients: readonly string[],
    n: { dedupeKey: string; title: string; body: string; mandatoryEmail: boolean },
  ): Promise<void> {
    const svc = this.deps.notifications();
    if (svc === null || recipients.length === 0) return;
    await svc
      .notify(
        this.deps.pool,
        recipients,
        {
          kind: 'account.recovery',
          severity: 'critical',
          title: n.title,
          body: n.body,
          link: '/settings/users',
          dedupeKey: n.dedupeKey,
        },
        n.mandatoryEmail ? { mandatory: ['email'] } : {},
      )
      .catch((err: unknown) => {
        this.deps.log?.warn({ err }, 'account recovery notification failed');
      });
  }
}
