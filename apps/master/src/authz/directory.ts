import type { SecurityPolicyReader } from '../security-policy/service.js';
import { randomBytes } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  type ScryptParams,
} from '../auth/password.js';
import { sessions } from '../auth/sessions.js';
import { revokeAllTrustedDevices } from '../auth/trusted-devices.js';
import { type Role, USERNAME_PATTERN, users } from '../auth/users.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { MemoryMode, SemanticDefaultsService } from '../search/defaults.js';
import { validateEgress } from '../workspaces/service.js';
import {
  GLOBAL_ROLES,
  type ProjectRole,
  projectRoleOf,
  roleAtLeast,
  type Subject,
  visibleProjects,
} from './model.js';

/**
 * Projects, memberships and user accounts (docs/design/p5-rbac.md §5). Authorization (who may call what)
 * is decided by the route declarations; this service enforces the invariants that hold for every caller:
 * no self-demotion/self-disable, at least one active owner, memberships only for per-project accounts.
 * Every change and every refusal is audited.
 */

export const PROJECT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface Actor {
  readonly id: string;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly createdBy: { readonly id: string; readonly username: string } | null;
  readonly members: number;
  /** The caller's effective role in the project. */
  readonly myRole: Role;
  /** p5-research-workspace: `repository` (code) or `workspace` (research / general tasks, no repository). */
  readonly kind: 'repository' | 'workspace';
  /** p17-chat-github: the project's short description (null: none). */
  readonly description: string | null;
}

export interface MemberRecord {
  readonly userId: string;
  readonly username: string;
  readonly accountRole: Role;
  readonly role: ProjectRole;
  /** min(membership role, account role). */
  readonly effectiveRole: Role;
  readonly disabled: boolean;
  readonly grantedAt: Date;
  readonly grantedBy: string | null;
}

export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly totpEnrolled: boolean;
  readonly disabledAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly memberships: readonly { readonly project: string; readonly role: ProjectRole }[];
}

export function notFound(what: 'project' | 'user' | 'membership'): HttpError {
  return new HttpError(404, `${what}_not_found`, `The ${what} does not exist.`);
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

/**
 * Temporary password for a new account: 24 base64url characters (144 random bits). Shown once to the
 * creating owner; never stored except as its scrypt hash, never logged or audited.
 */
export function temporaryPassword(username: string): string {
  for (;;) {
    const candidate = randomBytes(18).toString('base64url');
    if (checkPasswordPolicy(candidate, username).ok) return candidate;
  }
}

export class Directory {
  private readonly pool: Pool;
  private readonly audit: AuditRecorder;
  private readonly clock: () => Date;
  private readonly passwordParams: ScryptParams;
  private readonly semanticDefaults: SemanticDefaultsService | null;
  private readonly securityPolicy: SecurityPolicyReader | null;

  constructor(deps: {
    pool: Pool;
    audit: AuditRecorder;
    clock?: () => Date;
    passwordParams?: ScryptParams;
    /** p10-semantic-defaults-chat: project knowledge settings of new projects (absent: none written). */
    semanticDefaults?: SemanticDefaultsService;
    /** p15-autonomy (ADR-0056): autonomy defaults of new projects (absent: confined, no auto-approve). */
    securityPolicy?: SecurityPolicyReader;
  }) {
    this.securityPolicy = deps.securityPolicy ?? null;
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.passwordParams = deps.passwordParams ?? DEFAULT_SCRYPT_PARAMS;
    this.semanticDefaults = deps.semanticDefaults ?? null;
  }

  // --- projects -----------------------------------------------------------------------------------

  async listProjects(subject: Subject): Promise<ProjectRecord[]> {
    const visible = visibleProjects(subject);
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      created_at: Date;
      created_by: string | null;
      created_by_username: string | null;
      members: number;
      kind: 'repository' | 'workspace';
      description: string | null;
    }>(
      `SELECT p.id, p.name, p.kind, p.description, p.created_at, p.created_by, u.username AS created_by_username,
              (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS members
         FROM projects p LEFT JOIN users u ON u.id = p.created_by
        WHERE $1::text[] IS NULL OR p.id = ANY($1::text[])
        ORDER BY p.id
        LIMIT 1000`,
      [visible],
    );
    return rows.flatMap((r) => {
      const myRole = projectRoleOf(subject, r.id);
      if (myRole === null) return [];
      return [
        {
          id: r.id,
          name: r.name,
          createdAt: r.created_at,
          createdBy:
            r.created_by === null
              ? null
              : { id: r.created_by, username: r.created_by_username ?? '(deleted)' },
          members: r.members,
          myRole,
          kind: r.kind,
          description: r.description,
        },
      ];
    });
  }

  async createProject(
    actor: Actor,
    input: {
      id: string;
      name: string;
      kind?: 'repository' | 'workspace' | undefined;
      egress?: unknown;
      allowHosts?: unknown;
      /** p10-semantic-defaults-chat: unchecked in the form = false (explicit off); omitted = the platform default. */
      searchCapture?: boolean | undefined;
      memorySuggestions?: boolean | undefined;
      /** p17-chat-github: a short description (≤ 500 characters). */
      description?: string | undefined;
      /** p17-chat-github: created from a chat card (audited `via: 'chat'`). */
      via?: 'chat' | undefined;
    },
    meta: RequestMeta,
  ): Promise<{
    id: string;
    name: string;
    createdAt: Date;
    kind: 'repository' | 'workspace';
    searchCapture: boolean | null;
    memoryMode: MemoryMode | null;
  }> {
    const name = input.name.trim();
    if (!PROJECT_ID.test(input.id) || name.length === 0 || name.length > 200) {
      throw new HttpError(400, 'bad_request', 'The request is invalid.');
    }
    const description = input.description?.trim() ?? '';
    if (description.length > 500 || /\p{Cc}/u.test(description.replace(/\n/g, ''))) {
      throw new HttpError(400, 'bad_request', 'The request is invalid.');
    }
    const kind = input.kind ?? 'repository';
    if (kind === 'repository' && (input.egress !== undefined || input.allowHosts !== undefined)) {
      throw new HttpError(
        400,
        'bad_request',
        'egress and allowHosts are settings of workspace projects.',
        {},
        {},
        { reason: 'egress' },
      );
    }
    // p5-research-workspace: a new workspace has no web access unless the admin chooses it.
    const egress =
      kind === 'workspace'
        ? validateEgress({ egress: input.egress ?? 'none', allowHosts: input.allowHosts })
        : null;
    const now = this.clock();
    const policy = this.securityPolicy === null ? null : await this.securityPolicy.current();
    const autonomy =
      policy === null
        ? null
        : {
            hostExecution: policy.autonomy.newProjectsHostExecution,
            autoApprove: policy.autonomy.newProjectsAutoApprove,
          };
    let knowledge: { searchCapture: boolean; memoryMode: MemoryMode } | null = null;
    const created = await withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO projects (id, name, kind, created_by, created_at, description) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.id, name, kind, actor.id, now, description === '' ? null : description],
      );
      if (rows.length === 0) return false;
      // p15-autonomy: the security policy's defaults for new projects (host execution, "never ask" jobs allowed).
      if (autonomy !== null && (autonomy.hostExecution || autonomy.autoApprove)) {
        await tx.query('UPDATE projects SET host_execution = $2, auto_approve_execution = $3 WHERE id = $1', [
          input.id,
          autonomy.hostExecution,
          autonomy.autoApprove,
        ]);
      }
      if (egress !== null) {
        await tx.query(
          `INSERT INTO project_workspaces (project, egress, allow_hosts, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, egress.egress, JSON.stringify(egress.allowHosts), actor.id, now],
        );
      }
      if (this.semanticDefaults !== null) {
        knowledge = await this.semanticDefaults.applyOnCreate(
          tx,
          input.id,
          { searchCapture: input.searchCapture, memorySuggestions: input.memorySuggestions },
          actor.id,
        );
      }
      await this.record(tx, actor, 'project.create', `project:${input.id}`, 'success', meta, {
        name,
        kind,
        ...(description === '' ? {} : { description: true }),
        ...(input.via === undefined ? {} : { via: input.via }),
        ...(autonomy === null
          ? {}
          : { hostExecution: autonomy.hostExecution, autoApprove: autonomy.autoApprove }),
        ...(egress === null ? {} : { egress: egress.egress, allowHosts: egress.allowHosts }),
        ...(knowledge === null
          ? {}
          : { searchCapture: knowledge.searchCapture, memorySuggestions: knowledge.memoryMode }),
      });
      return true;
    });
    if (!created) {
      await this.refused(actor, 'project.create', `project:${input.id}`, meta, 'exists');
      throw conflict('project_exists', 'A project with this id already exists.');
    }
    const k = knowledge as { searchCapture: boolean; memoryMode: MemoryMode } | null;
    return {
      id: input.id,
      name,
      createdAt: now,
      kind,
      searchCapture: k?.searchCapture ?? null,
      memoryMode: k?.memoryMode ?? null,
    };
  }

  async members(projectId: string): Promise<MemberRecord[]> {
    await this.requireProject(this.pool, projectId);
    const { rows } = await this.pool.query<{
      user_id: string;
      username: string;
      account_role: Role;
      role: ProjectRole;
      disabled_at: Date | null;
      granted_at: Date;
      granted_by: string | null;
    }>(
      `SELECT m.user_id, u.username, u.role AS account_role, m.role, u.disabled_at, m.granted_at, g.username AS granted_by
         FROM project_memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN users g ON g.id = m.granted_by
        WHERE m.project_id = $1
        ORDER BY u.username`,
      [projectId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      accountRole: r.account_role,
      role: r.role,
      effectiveRole:
        projectRoleOf(
          { userId: r.user_id, role: r.account_role, memberships: new Map([[projectId, r.role]]) },
          projectId,
        ) ?? r.role,
      disabled: r.disabled_at !== null,
      grantedAt: r.granted_at,
      grantedBy: r.granted_by,
    }));
  }

  /** Grants or changes a membership (upsert). Owner/admin accounts are global and get no memberships. */
  async setMember(
    actor: Actor,
    projectId: string,
    input: { userId: string; role: ProjectRole },
    meta: RequestMeta,
  ): Promise<MemberRecord[]> {
    const target = `project:${projectId}`;
    await withTransaction(this.pool, async (tx) => {
      await this.requireProject(tx, projectId);
      const user = await this.findUser(tx, input.userId);
      if (!user) throw notFound('user');
      if (GLOBAL_ROLES.has(user.role)) {
        throw new HttpError(
          400,
          'global_role',
          'Owner and admin accounts already have access to every project.',
        );
      }
      const { rows } = await tx.query<{ previous: ProjectRole | null }>(
        `WITH prev AS (SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2)
         INSERT INTO project_memberships (project_id, user_id, role, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by,
                                                         granted_at = EXCLUDED.granted_at
         RETURNING (SELECT role FROM prev) AS previous`,
        [projectId, input.userId, input.role, actor.id, this.clock()],
      );
      await this.record(tx, actor, 'project.member.set', target, 'success', meta, {
        userId: input.userId,
        username: user.username,
        role: input.role,
        previousRole: rows[0]?.previous ?? null,
      });
    }).catch(async (err: unknown) => {
      if (err instanceof HttpError) {
        await this.refused(actor, 'project.member.set', target, meta, err.code, { userId: input.userId });
      }
      throw err;
    });
    return this.members(projectId);
  }

  async removeMember(
    actor: Actor,
    projectId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<MemberRecord[]> {
    const target = `project:${projectId}`;
    await withTransaction(this.pool, async (tx) => {
      await this.requireProject(tx, projectId);
      const { rows } = await tx.query<{ role: ProjectRole }>(
        'DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2 RETURNING role',
        [projectId, userId],
      );
      const removed = rows[0];
      if (!removed) throw notFound('membership');
      await this.record(tx, actor, 'project.member.remove', target, 'success', meta, {
        userId,
        previousRole: removed.role,
      });
    }).catch(async (err: unknown) => {
      if (err instanceof HttpError) {
        await this.refused(actor, 'project.member.remove', target, meta, err.code, { userId });
      }
      throw err;
    });
    return this.members(projectId);
  }

  // --- users --------------------------------------------------------------------------------------

  async listUsers(): Promise<UserSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      username: string;
      role: Role;
      totp_enabled: boolean;
      disabled_at: Date | null;
      locked_until: Date | null;
      last_login_at: Date | null;
      created_at: Date;
      memberships: { project: string; role: ProjectRole }[] | null;
    }>(
      `SELECT u.id, u.username, u.role, u.totp_enabled, u.disabled_at, u.locked_until, u.last_login_at, u.created_at,
              (SELECT json_agg(json_build_object('project', m.project_id, 'role', m.role) ORDER BY m.project_id)
                 FROM project_memberships m WHERE m.user_id = u.id) AS memberships
         FROM users u
        -- p16-api-tokens: service accounts are listed in Ayarlar → Servis hesapları, not among people.
        WHERE u.kind = 'human'
        ORDER BY u.username
        LIMIT 1000`,
    );
    const now = this.clock();
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      totpEnrolled: r.totp_enabled,
      disabledAt: r.disabled_at,
      lockedUntil: r.locked_until !== null && r.locked_until > now ? r.locked_until : null,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
      memberships: r.memberships ?? [],
    }));
  }

  /**
   * Creates an account with a generated temporary password (returned once). The account has no TOTP, so
   * its first login lands in mandatory enrollment exactly like the bootstrap owner (ADR-0009 §4), followed
   * by the mandatory replacement of the temporary password (p5-self-password).
   */
  async createUser(
    actor: Actor,
    input: { username: string; role: Role },
    meta: RequestMeta,
  ): Promise<{ id: string; username: string; role: Role; temporaryPassword: string }> {
    const username = input.username.trim().toLowerCase();
    const target = `user:${username}`;
    if (!USERNAME_PATTERN.test(username)) {
      await this.refused(actor, 'user.create', target, meta, 'invalid_username');
      throw new HttpError(
        400,
        'invalid_username',
        'Username must be 3-32 characters: a-z first, then a-z, 0-9, ".", "_" or "-".',
      );
    }
    const password = temporaryPassword(username);
    const passwordHash = await hashPassword(password, this.passwordParams);
    const id = await withTransaction(this.pool, async (tx) => {
      const created = await users.create(tx, {
        username,
        role: input.role,
        passwordHash,
        createdBy: actor.id,
        // p5-self-password: the creator knows this password; the user must replace it at first login.
        passwordChangeRequired: true,
      });
      if (created === null) return null;
      await this.record(tx, actor, 'user.create', `user:${created}`, 'success', meta, {
        username,
        role: input.role,
        mfaEnrollment: 'required_at_first_login',
        firstLoginSteps: ['totp_enrollment', 'password_change'],
      });
      return created;
    });
    if (id === null) {
      await this.refused(actor, 'user.create', target, meta, 'exists');
      throw conflict('user_exists', 'A user with this username already exists.');
    }
    return { id, username, role: input.role, temporaryPassword: password };
  }

  async setRole(actor: Actor, userId: string, role: Role, meta: RequestMeta): Promise<UserSummary> {
    await this.changeAccount(actor, userId, 'user.role.change', meta, async (tx, user) => {
      if (user.role === role) return { previousRole: user.role, role };
      if (user.role === 'owner') await this.requireAnotherOwner(tx, userId);
      await tx.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [userId, role]);
      if (GLOBAL_ROLES.has(role)) {
        // Global accounts have no memberships (they see every project).
        await tx.query('DELETE FROM project_memberships WHERE user_id = $1', [userId]);
      }
      // p7-rate-limit session hardening: an elevation ends every session of the account, so the higher
      // privilege is only ever used from a session established (password + TOTP) after the change; a
      // cookie stolen before it stays low-privileged. A demotion applies immediately (the role is read on
      // every request) and keeps the sessions.
      const elevated = !roleAtLeast(user.role, role);
      const revokedSessions = elevated ? await sessions.deleteAllForUser(tx, userId) : 0;
      // p5-remember-device: the same applies to device trust — the elevated account proves TOTP again.
      const revokedDevices = elevated
        ? await revokeAllTrustedDevices(tx, this.audit, {
            userId,
            reason: 'role_elevation',
            actor: { type: 'user', id: actor.id },
            ip: meta.ip,
            userAgent: meta.userAgent,
          })
        : 0;
      return {
        previousRole: user.role,
        role,
        ...(elevated ? { revokedSessions, revokedDevices } : {}),
      };
    });
    return this.userSummary(userId);
  }

  async disable(actor: Actor, userId: string, meta: RequestMeta): Promise<UserSummary> {
    await this.changeAccount(actor, userId, 'user.disable', meta, async (tx, user) => {
      if (user.disabledAt !== null) return { alreadyDisabled: true };
      if (user.role === 'owner') await this.requireAnotherOwner(tx, userId);
      await tx.query('UPDATE users SET disabled_at = $2, updated_at = now() WHERE id = $1', [
        userId,
        this.clock(),
      ]);
      const revokedSessions = await sessions.deleteAllForUser(tx, userId);
      const revokedDevices = await revokeAllTrustedDevices(tx, this.audit, {
        userId,
        reason: 'disabled',
        actor: { type: 'user', id: actor.id },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { revokedSessions, revokedDevices };
    });
    return this.userSummary(userId);
  }

  async enable(actor: Actor, userId: string, meta: RequestMeta): Promise<UserSummary> {
    await this.changeAccount(actor, userId, 'user.enable', meta, async (tx, user) => {
      if (user.disabledAt === null) return { alreadyEnabled: true };
      await tx.query(
        'UPDATE users SET disabled_at = NULL, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
        [userId],
      );
      return {};
    });
    return this.userSummary(userId);
  }

  // --- internals ----------------------------------------------------------------------------------

  private async userSummary(userId: string): Promise<UserSummary> {
    const found = (await this.listUsers()).find((u) => u.id === userId);
    if (!found) throw notFound('user');
    return found;
  }

  /** Common frame for account changes: no self-change, row lock, audit success/refusal. */
  private async changeAccount(
    actor: Actor,
    userId: string,
    action: string,
    meta: RequestMeta,
    change: (
      tx: Queryable,
      user: { role: Role; disabledAt: Date | null; username: string },
    ) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const target = `user:${userId}`;
    try {
      if (userId === actor.id) {
        throw new HttpError(409, 'self_change', 'You cannot change or disable your own account here.');
      }
      await withTransaction(this.pool, async (tx) => {
        const user = await this.findUser(tx, userId, true);
        // p16-api-tokens: service accounts are changed on their own page (role ≤ admin, audited there).
        if (!user || user.kind !== 'human') throw notFound('user');
        const details = await change(tx, user);
        await this.record(tx, actor, action, target, 'success', meta, {
          username: user.username,
          ...details,
        });
      });
    } catch (err) {
      if (err instanceof HttpError) await this.refused(actor, action, target, meta, err.code);
      throw err;
    }
  }

  /** Refuses to remove the last active owner (serialised by locking every active owner row). */
  private async requireAnotherOwner(tx: Queryable, userId: string): Promise<void> {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'owner' AND disabled_at IS NULL ORDER BY id FOR UPDATE",
    );
    if (!rows.some((r) => r.id !== userId)) {
      throw conflict('last_owner', 'At least one active owner account must remain.');
    }
  }

  private async findUser(
    db: Queryable,
    userId: string,
    forUpdate = false,
  ): Promise<{ role: Role; disabledAt: Date | null; username: string; kind: 'human' | 'service' } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const { rows } = await db.query<{
      role: Role;
      disabled_at: Date | null;
      username: string;
      kind: 'human' | 'service';
    }>(`SELECT role, disabled_at, username, kind FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [
      userId,
    ]);
    const r = rows[0];
    return r ? { role: r.role, disabledAt: r.disabled_at, username: r.username, kind: r.kind } : null;
  }

  private async requireProject(db: Queryable, projectId: string): Promise<void> {
    if (!PROJECT_ID.test(projectId)) throw notFound('project');
    const { rows } = await db.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (rows.length === 0) throw notFound('project');
  }

  private async record(
    tx: Queryable,
    actor: Actor,
    action: string,
    target: string,
    outcome: 'success' | 'denied',
    meta: RequestMeta,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        actor: { type: 'user', id: actor.id },
        action,
        target,
        outcome,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata,
      },
      tx,
    );
  }

  private async refused(
    actor: Actor,
    action: string,
    target: string,
    meta: RequestMeta,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.record({
      actor: { type: 'user', id: actor.id },
      action,
      target,
      outcome: 'denied',
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { reason, ...extra },
    });
  }
}
