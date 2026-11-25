import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { GitFlowError, gitConfigConflict, invalidGitConfig, projectNotFound } from './errors.js';
import { repoPathInScope } from '@remyral/protocol';
import type { HostConnectionRef } from './git-hosts.js';
import { githubRepo, hostedRepoPath, isTargetBranch, parseRepoUrl } from './refs.js';
import type { MergeMethod, ProviderKind } from './types.js';

/**
 * Per-project git provider configuration (`PUT /projects/:id/git`, admin + step-up). Contains no secret: the
 * GitHub App private key is referenced by name (`keyRef`) — `default` is the key file of the master's own
 * configuration (ADR-0006), `panel` the App connected in Settings → Integrations whose key the master keeps
 * encrypted (ADR-0022).
 */
export interface ProjectGitConfig {
  readonly project: string;
  readonly version: number;
  readonly provider: ProviderKind;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly mergeMethod: MergeMethod;
  readonly requireCi: boolean;
  readonly ciTimeoutSec: number;
  readonly github: {
    readonly appId: string;
    readonly installationId: number;
    readonly keyRef: string;
  } | null;
  /** p16-git-providers: the GitLab / Bitbucket connection (Ayarlar → Entegrasyonlar) of a hosted provider. */
  readonly hostConnectionId: string | null;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface PutGitConfigInput {
  readonly provider: ProviderKind;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly mergeMethod?: MergeMethod;
  readonly requireCi?: boolean;
  readonly ciTimeoutSec?: number;
  readonly github?: { readonly installationId: number; readonly keyRef?: string; readonly appId?: string };
  /** p16-git-providers: required for `gitlab` / `bitbucket`, refused otherwise. */
  readonly hostConnectionId?: string;
  /** 0 when no configuration exists yet. */
  readonly expectedVersion: number;
}

export interface GitConfigPolicy {
  /**
   * App id behind a GitHub App key reference the master knows right now (`default`: key file, `panel`: connected
   * in Settings → Integrations, p5-github-connect); undefined = unknown on this master.
   */
  readonly githubAppId: (keyRef: string) => string | undefined;
  /** keyRef used when a request names none: `panel` while a panel App is connected (it takes precedence). */
  readonly defaultKeyRef: () => string;
  /**
   * Whether `installationId` is a known, active installation of the App behind `keyRef`; null when the master
   * does not track that App's installations (file-based key: checked by GitHub on the first token).
   */
  readonly checkInstallation?: (keyRef: string, installationId: number) => Promise<boolean | null>;
  /** Host of github.com or the GitHub Enterprise Server instance (repository URLs must use it). */
  readonly githubHost: string;
  /** Plain git remotes need the master to fetch objects (AGENTS.md rule 1): off unless enabled. */
  readonly allowPlainGit: boolean;
  /** p16-git-providers: a GitLab / Bitbucket connection by id (null: unknown). Absent: hosted providers refused. */
  readonly hostConnection?: (id: string) => Promise<HostConnectionRef | null>;
  /**
   * p16-git-providers: whether the repository lies in the connection's scope where the path cannot tell (a Bitbucket
   * project token: the repository's project key). null: not checked.
   */
  readonly checkHostRepository?: (connection: HostConnectionRef, repoPath: string) => Promise<boolean | null>;
}

interface Row {
  project: string;
  version: number;
  provider: ProviderKind;
  repository_url: string;
  base_branch: string;
  merge_method: MergeMethod;
  require_ci: boolean;
  ci_timeout_sec: number;
  github_app_id: string | null;
  github_installation_id: string | null;
  github_key_ref: string | null;
  host_connection_id: string | null;
  updated_by: string;
  updated_at: Date;
}

function toConfig(r: Row): ProjectGitConfig {
  return {
    project: r.project,
    version: r.version,
    provider: r.provider,
    repositoryUrl: r.repository_url,
    baseBranch: r.base_branch,
    mergeMethod: r.merge_method,
    requireCi: r.require_ci,
    ciTimeoutSec: r.ci_timeout_sec,
    github:
      r.github_installation_id === null || r.github_app_id === null || r.github_key_ref === null
        ? null
        : {
            appId: r.github_app_id,
            installationId: Number(r.github_installation_id),
            keyRef: r.github_key_ref,
          },
    hostConnectionId: r.host_connection_id ?? null,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function loadGitConfig(db: Queryable, project: string): Promise<ProjectGitConfig | null> {
  const { rows } = await db.query<Row>('SELECT * FROM project_git_configs WHERE project = $1', [project]);
  const r = rows[0];
  return r === undefined ? null : toConfig(r);
}

/** Who changed a project's repository (forwarded to listeners for their own audit trail). */
export interface RepositoryChangeActor {
  readonly userId: string;
  readonly ip: string;
  readonly userAgent: string | null;
}

export type RepositoryChangeListener = (
  project: string,
  actor: RepositoryChangeActor,
) => Promise<void> | void;

export class ProjectGitConfigStore {
  readonly #listeners: RepositoryChangeListener[] = [];

  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly policy: GitConfigPolicy;
    },
  ) {}

  /**
   * ADR-0015: called after a commit that registered a project's first repository or changed it (worker
   * configurations resolve project ids to this URL). Listener failures are logged by the listener, never thrown.
   */
  onRepositoryChanged(listener: RepositoryChangeListener): void {
    this.#listeners.push(listener);
  }

  get(project: string): Promise<ProjectGitConfig | null> {
    return loadGitConfig(this.deps.pool, project);
  }

  /** Validates, then writes version + 1 (optimistic). Audited with the non-secret fields. */
  async put(
    project: string,
    input: PutGitConfigInput,
    actor: { readonly id: string },
    meta: { readonly ip?: string | null; readonly userAgent?: string | null } = {},
  ): Promise<ProjectGitConfig> {
    const kind = await this.deps.pool.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [
      project,
    ]);
    if (kind.rows[0]?.kind === 'workspace') {
      // p5-research-workspace: a workspace has no repository (checked before validation: the clearer answer).
      throw new GitFlowError(
        409,
        'not_a_repository_project',
        'This project is a workspace; it has no repository to configure.',
      );
    }
    const issues: string[] = [];
    const url = parseRepoUrl(input.repositoryUrl);
    if (url === null) issues.push('repositoryUrl:invalid');
    if (!isTargetBranch(input.baseBranch)) issues.push('baseBranch:invalid');
    const ciTimeoutSec = input.ciTimeoutSec ?? 3600;
    if (!Number.isInteger(ciTimeoutSec) || ciTimeoutSec < 60 || ciTimeoutSec > 172_800) {
      issues.push('ciTimeoutSec:out_of_range');
    }
    let github: { appId: string; installationId: number; keyRef: string } | null = null;
    let hostConnectionId: string | null = null;
    if (input.provider === 'github') {
      const keyRef = input.github?.keyRef ?? this.deps.policy.defaultKeyRef();
      const appId = this.deps.policy.githubAppId(keyRef);
      if (input.github === undefined) issues.push('github:required');
      else if (!Number.isSafeInteger(input.github.installationId) || input.github.installationId <= 0) {
        issues.push('github.installationId:invalid');
      }
      if (appId === undefined) issues.push('github.keyRef:unknown_on_this_master');
      else if (input.github?.appId !== undefined && input.github.appId !== appId) {
        issues.push('github.appId:does_not_match_key');
      }
      if (
        url !== null &&
        (url.host !== this.deps.policy.githubHost || githubRepo(input.repositoryUrl) === null)
      ) {
        issues.push('repositoryUrl:not_a_github_repository');
      }
      if (issues.length === 0 && input.github !== undefined && this.deps.policy.checkInstallation) {
        const known = await this.deps.policy.checkInstallation(keyRef, input.github.installationId);
        if (known === false) issues.push('github.installationId:not_an_installation_of_this_app');
      }
      if (issues.length === 0 && appId !== undefined && input.github !== undefined) {
        github = { appId, installationId: input.github.installationId, keyRef };
      }
    } else if (input.provider === 'gitlab' || input.provider === 'bitbucket') {
      if (input.github !== undefined) issues.push('github:not_allowed_for_this_provider');
      const id = input.hostConnectionId;
      const conn =
        id === undefined || this.deps.policy.hostConnection === undefined
          ? null
          : await this.deps.policy.hostConnection(id).catch(() => null);
      if (id === undefined) issues.push('hostConnectionId:required');
      else if (conn === null) issues.push('hostConnectionId:unknown');
      else if (conn.kind !== input.provider) issues.push('hostConnectionId:wrong_provider');
      else if (url !== null) {
        const path = hostedRepoPath(input.repositoryUrl, conn);
        if (url.protocol !== 'https' || url.host !== conn.webHost || path === null) {
          issues.push('repositoryUrl:not_on_this_host');
        } else if (!repoPathInScope(conn.kind, conn.tokenKind, conn.scope, path)) {
          issues.push('repositoryUrl:outside_token_scope');
        } else if (this.deps.policy.checkHostRepository !== undefined) {
          const inScope = await this.deps.policy.checkHostRepository(conn, path).catch(() => null);
          if (inScope === false) issues.push('repositoryUrl:outside_token_scope');
        }
      }
      if (issues.length === 0 && conn !== null) hostConnectionId = conn.id;
    } else {
      if (!this.deps.policy.allowPlainGit) issues.push('provider:plain_git_disabled_on_this_master');
      if (input.github !== undefined) issues.push('github:not_allowed_for_plain_git');
    }
    if (
      input.provider !== 'gitlab' &&
      input.provider !== 'bitbucket' &&
      input.hostConnectionId !== undefined
    ) {
      issues.push('hostConnectionId:not_allowed_for_this_provider');
    }
    if (issues.length > 0) throw invalidGitConfig(issues);

    const previous: { url: string | null } = { url: null };
    const saved = await withTransaction(this.deps.pool, async (tx) => {
      const exists = await tx.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [project]);
      if (exists.rowCount !== 1) throw projectNotFound();
      if (exists.rows[0]?.kind === 'workspace') {
        // p5-research-workspace: a workspace has no repository.
        throw new GitFlowError(
          409,
          'not_a_repository_project',
          'This project is a workspace; it has no repository to configure.',
        );
      }
      const current = await tx.query<{ version: number; repository_url: string }>(
        'SELECT version, repository_url FROM project_git_configs WHERE project = $1 FOR UPDATE',
        [project],
      );
      const version = current.rows[0]?.version ?? 0;
      previous.url = current.rows[0]?.repository_url ?? null;
      if (version !== input.expectedVersion) throw gitConfigConflict();
      const now = this.deps.clock();
      const values = [
        project,
        version + 1,
        input.provider,
        input.repositoryUrl,
        input.baseBranch,
        input.mergeMethod ?? 'merge',
        input.requireCi ?? false,
        ciTimeoutSec,
        github?.appId ?? null,
        github?.installationId ?? null,
        github?.keyRef ?? null,
        actor.id,
        now,
        hostConnectionId,
      ];
      const { rows } = await tx.query<Row>(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
           require_ci, ci_timeout_sec, github_app_id, github_installation_id, github_key_ref, updated_by, updated_at,
           host_connection_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (project) DO UPDATE SET version = EXCLUDED.version, provider = EXCLUDED.provider,
           repository_url = EXCLUDED.repository_url, base_branch = EXCLUDED.base_branch,
           merge_method = EXCLUDED.merge_method, require_ci = EXCLUDED.require_ci,
           ci_timeout_sec = EXCLUDED.ci_timeout_sec, github_app_id = EXCLUDED.github_app_id,
           github_installation_id = EXCLUDED.github_installation_id, github_key_ref = EXCLUDED.github_key_ref,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at,
           host_connection_id = EXCLUDED.host_connection_id
         RETURNING *`,
        values,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('git config upsert returned no row');
      const saved = toConfig(row);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'project.git.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            version: saved.version,
            provider: saved.provider,
            repository: url?.key ?? null,
            baseBranch: saved.baseBranch,
            mergeMethod: saved.mergeMethod,
            requireCi: saved.requireCi,
            ...(saved.github === null
              ? {}
              : { installationId: saved.github.installationId, keyRef: saved.github.keyRef }),
            ...(saved.hostConnectionId === null ? {} : { hostConnectionId: saved.hostConnectionId }),
          },
        },
        tx,
      );
      return saved;
    });
    if (previous.url !== saved.repositoryUrl) {
      const actorContext = { userId: actor.id, ip: meta.ip ?? '', userAgent: meta.userAgent ?? null };
      for (const listener of this.#listeners) await listener(project, actorContext);
    }
    return saved;
  }
}
