import { DEFAULT_GIT_IDENTITY, type GitIdentityValue } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import type { ActorContext } from '../workers/fleet.js';
import {
  readDefaultGitIdentity,
  readProjectGitIdentity,
  resolveGitIdentity,
  type ResolvedGitIdentity,
  type StoredGitIdentity,
  validateGitIdentity,
} from './store.js';

export interface ProjectGitIdentityView extends StoredGitIdentity {
  readonly project: string;
  /** What the project's jobs commit with now (the project's own, the workspace default or Remyral Agent). */
  readonly effective: ResolvedGitIdentity;
}

export interface DefaultGitIdentityView extends StoredGitIdentity {
  /** What a project without its own identity commits with (this default or Remyral Agent). */
  readonly effective: ResolvedGitIdentity;
}

const same = (a: GitIdentityValue | null, b: GitIdentityValue | null): boolean =>
  a === null || b === null ? a === b : a.name === b.name && a.email === b.email;

/**
 * p5-git-identity: reads and changes the per-project commit identity and the workspace-wide default. Changes are
 * audited with before/after in the same transaction (`project.git_identity.update`, `settings.git_identity.update`).
 * New identities apply to jobs dispatched afterwards (the master resolves them at ASSIGN_JOB).
 */
export class GitIdentityService {
  constructor(
    private readonly deps: { readonly pool: Pool; readonly audit: AuditRecorder; readonly clock: () => Date },
  ) {}

  async project(project: string): Promise<ProjectGitIdentityView> {
    const stored = await readProjectGitIdentity(this.deps.pool, project);
    return { project, ...stored, effective: await resolveGitIdentity(this.deps.pool, project) };
  }

  /** Sets (or with null clears, inheriting the default) the project's identity. Admin + step-up (route). */
  async setProject(
    project: string,
    input: { readonly name: string; readonly email: string } | null,
    actor: ActorContext,
  ): Promise<ProjectGitIdentityView> {
    const next = input === null ? null : validateGitIdentity(input);
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await readProjectGitIdentity(tx, project, true);
      await tx.query(
        `UPDATE projects SET git_author_name = $2, git_author_email = $3, git_identity_updated_by = $4,
                git_identity_updated_at = $5
          WHERE id = $1`,
        [project, next?.name ?? null, next?.email ?? null, actor.userId, this.deps.clock()],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.git_identity.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { before: before.identity, after: next, changed: !same(before.identity, next) },
        },
        tx,
      );
    });
    return this.project(project);
  }

  async workspaceDefault(): Promise<DefaultGitIdentityView> {
    const stored = await readDefaultGitIdentity(this.deps.pool);
    return {
      ...stored,
      effective:
        stored.identity === null
          ? { identity: { ...DEFAULT_GIT_IDENTITY }, source: 'default' }
          : { identity: stored.identity, source: 'workspace' },
    };
  }

  /** Sets (or with null removes) the workspace-wide default. Admin + step-up (route). */
  async setWorkspaceDefault(
    input: { readonly name: string; readonly email: string } | null,
    actor: ActorContext,
  ): Promise<DefaultGitIdentityView> {
    const next = input === null ? null : validateGitIdentity(input);
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await readDefaultGitIdentity(tx, true);
      if (next === null) {
        await tx.query('DELETE FROM git_identity_default WHERE id = 1');
      } else {
        await tx.query(
          `INSERT INTO git_identity_default (id, name, email, updated_by, updated_at) VALUES (1, $1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
             updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [next.name, next.email, actor.userId, this.deps.clock()],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'settings.git_identity.update',
          target: 'settings:git-identity',
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { before: before.identity, after: next, changed: !same(before.identity, next) },
        },
        tx,
      );
    });
    return this.workspaceDefault();
  }
}
