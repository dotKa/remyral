import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../db/pool.js';
import type { RemoteBranchInspector, RemoteBranchState } from '../orchestration/remote-branch.js';
import type { GitCredential, GitCredentialProvider } from '../orchestration/session.js';
import { loadGitConfig, type ProjectGitConfig } from './config-store.js';
import { type GitHubAppAuth, WORKER_PERMISSIONS, WORKER_READ_PERMISSIONS } from './github-app.js';
import { githubRepo, isAttemptBranch, sameRepository } from './refs.js';
import type { ProviderFactory } from './service.js';

/**
 * Worker push credentials (ADR-0006 §3, T-WRK-4): a GitHub App installation token minted per request,
 * scoped to the job's one repository with `contents: write` + `metadata: read` only, delivered over the
 * non-durable JOB_CREDENTIAL path (never persisted, never logged). Only for jobs of a project configured
 * for GitHub whose repository matches, and only for `trusted` sources (ADR-0010 §3: no git write
 * credentials for untrusted sources). Everything else: no credential (`unavailable`).
 *
 * p6-automations-next (ADR-0026): an untrusted job that checks out a pinned pull request head
 * (`spec.repository.pullRequest`) gets a **read-only** token (`contents: read`, `metadata: read`) for the worker's
 * own fetch of `refs/pull/<n>/head` — the worker never pushes such a job and never hands the token to the runtime.
 *
 * p19-verifier-jobs: a platform report job (`report_only_jobs`: a verifier, an integration verifier, a post-deploy
 * screenshot job) gets a **read-only** token too, whatever its source trust (ADR-0010 only forbids write credentials):
 * it is never enrolled in git flow and never pushed, but it checks out the project's repository like any job of it.
 */
export class GitHubWorkerCredentials implements GitCredentialProvider {
  constructor(
    private readonly deps: {
      readonly db: Queryable;
      readonly apps: ReadonlyMap<string, GitHubAppAuth>;
      readonly log: FastifyBaseLogger;
    },
  ) {}

  async issue(job: {
    readonly jobId: string;
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
  }): Promise<GitCredential | null> {
    const config = await loadGitConfig(this.deps.db, job.project);
    if (config?.provider !== 'github' || config.github === null) return null;
    if (!sameRepository(job.repositoryUrl, config.repositoryUrl)) return null;
    const { rows } = await this.deps.db.query<{
      trust: string | null;
      enrolled: boolean;
      pull_head: boolean;
      report_only: boolean;
    }>(
      `SELECT j.spec->>'sourceTrust' AS trust, EXISTS (SELECT 1 FROM job_git g WHERE g.job_id = j.id) AS enrolled,
              (j.spec->'repository'->'pullRequest') IS NOT NULL AS pull_head,
              EXISTS (SELECT 1 FROM report_only_jobs r WHERE r.job_id = j.id) AS report_only
         FROM jobs j WHERE j.id = $1`,
      [job.jobId],
    );
    const row = rows[0];
    // p19-verifier-jobs: a platform report job (verifier, screenshot job) is never enrolled in git flow and never pushes;
    // it gets a read-only token for its checkout of the project's repository (a private repository is otherwise
    // unreadable: "could not read Username for 'https://github.com'").
    const readOnly = (row?.pull_head === true && row.trust === 'untrusted') || row?.report_only === true;
    if (!readOnly && (row?.trust !== 'trusted' || !row.enrolled)) return null;
    const repo = githubRepo(config.repositoryUrl);
    const auth = this.deps.apps.get(config.github.keyRef);
    if (repo === null || auth === undefined || auth.appId !== config.github.appId) return null;
    try {
      const t = await auth.installationToken(
        config.github.installationId,
        repo.repo,
        readOnly ? WORKER_READ_PERMISSIONS : WORKER_PERMISSIONS,
      );
      return { token: t.token, username: 'x-access-token', expiresAt: t.expiresAt };
    } catch (err) {
      this.deps.log.warn(
        { jobId: job.jobId, err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
        'git flow: worker token could not be minted',
      );
      return null;
    }
  }

  /**
   * p19-ide W2: a write installation token (`contents: write`, `metadata: read`) for one push of an IDE workspace's
   * branch, for the project's own configured repository only. The IDE branch is the only ref the worker pushes.
   */
  async issueIdePush(req: {
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
    readonly workspaceId: string;
  }): Promise<GitCredential | null> {
    const config = await loadGitConfig(this.deps.db, req.project);
    if (config?.provider !== 'github' || config.github === null) return null;
    if (!sameRepository(req.repositoryUrl, config.repositoryUrl)) return null;
    const repo = githubRepo(config.repositoryUrl);
    const auth = this.deps.apps.get(config.github.keyRef);
    if (repo === null || auth === undefined || auth.appId !== config.github.appId) return null;
    try {
      const t = await auth.installationToken(config.github.installationId, repo.repo, WORKER_PERMISSIONS);
      return { token: t.token, username: 'x-access-token', expiresAt: t.expiresAt };
    } catch (err) {
      this.deps.log.warn(
        { workspaceId: req.workspaceId, err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
        'IDE: push token could not be minted',
      );
      return null;
    }
  }

  /** p15-services: see {@link readOnlyCheckoutToken}. */
  issueReadOnly(req: {
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
  }): Promise<GitCredential | null> {
    return readOnlyCheckoutToken(this.deps, req);
  }
}

/**
 * p15-services: GitHubWorkerCredentials.issueReadOnly — a read-only installation token (`contents: read`,
 * `metadata: read`) for a service checkout of the project's own configured repository.
 */
export async function readOnlyCheckoutToken(
  deps: {
    readonly db: Queryable;
    readonly apps: ReadonlyMap<string, GitHubAppAuth>;
    readonly log: FastifyBaseLogger;
  },
  req: { readonly project: string; readonly repositoryUrl: string },
): Promise<GitCredential | null> {
  const config = await loadGitConfig(deps.db, req.project);
  if (config?.provider !== 'github' || config.github === null) return null;
  if (!sameRepository(req.repositoryUrl, config.repositoryUrl)) return null;
  const repo = githubRepo(config.repositoryUrl);
  const auth = deps.apps.get(config.github.keyRef);
  if (repo === null || auth === undefined || auth.appId !== config.github.appId) return null;
  try {
    const t = await auth.installationToken(config.github.installationId, repo.repo, WORKER_READ_PERMISSIONS);
    return { token: t.token, username: 'x-access-token', expiresAt: t.expiresAt };
  } catch (err) {
    deps.log.warn(
      { project: req.project, err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
      'services: read-only checkout token could not be minted',
    );
    return null;
  }
}

/**
 * p16-git-providers (ADR-0061 §2): worker push credentials of GitLab / Bitbucket projects — the connection's push-only
 * token (or its API token when none is stored), read from the encrypted store on every CREDENTIAL_REQUEST (right before
 * each fetch / push, p15-git-central), delivered over the non-durable JOB_CREDENTIAL path as HTTPS basic credentials
 * (`oauth2` / `x-token-auth` + token). The same gates as the GitHub App path: the job's repository must be the
 * project's configured one, the source `trusted` and the job enrolled in the git flow. Hosts cannot mint a read-only
 * token on demand, so untrusted sources and read-only service checkouts get none (ADR-0010).
 */
export class HostedWorkerCredentials implements GitCredentialProvider {
  constructor(
    private readonly deps: {
      readonly db: Queryable;
      readonly hosts: () => { pushCredential(id: string): Promise<GitCredential | null> } | null;
      readonly log: FastifyBaseLogger;
    },
  ) {}

  async issue(job: {
    readonly jobId: string;
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
  }): Promise<GitCredential | null> {
    const config = await loadGitConfig(this.deps.db, job.project);
    if (
      (config?.provider !== 'gitlab' && config?.provider !== 'bitbucket') ||
      config.hostConnectionId === null
    ) {
      return null;
    }
    if (!sameRepository(job.repositoryUrl, config.repositoryUrl)) return null;
    const { rows } = await this.deps.db.query<{
      trust: string | null;
      enrolled: boolean;
      report_only: boolean;
    }>(
      `SELECT j.spec->>'sourceTrust' AS trust, EXISTS (SELECT 1 FROM job_git g WHERE g.job_id = j.id) AS enrolled,
              EXISTS (SELECT 1 FROM report_only_jobs r WHERE r.job_id = j.id) AS report_only
         FROM jobs j WHERE j.id = $1`,
      [job.jobId],
    );
    const row = rows[0];
    // p19-verifier-jobs: a trusted platform report job (never enrolled, never pushed: no `pushResult`) gets the same
    // connection credential for its fetch as a trusted job of the project; hosts mint no read-only token on demand.
    if (row?.trust !== 'trusted' || (!row.enrolled && !row.report_only)) return null;
    const hosts = this.deps.hosts();
    if (hosts === null) return null;
    try {
      return await hosts.pushCredential(config.hostConnectionId);
    } catch (err) {
      this.deps.log.warn(
        { jobId: job.jobId, err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
        'git flow: hosted push credential could not be read',
      );
      return null;
    }
  }

  /** p19-ide W2: the connection's push credential for one IDE push (the project's configured repository only). */
  async issueIdePush(req: {
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
    readonly workspaceId: string;
  }): Promise<GitCredential | null> {
    const config = await loadGitConfig(this.deps.db, req.project);
    if (
      (config?.provider !== 'gitlab' && config?.provider !== 'bitbucket') ||
      config.hostConnectionId === null ||
      !sameRepository(req.repositoryUrl, config.repositoryUrl)
    ) {
      return null;
    }
    const hosts = this.deps.hosts();
    if (hosts === null) return null;
    return hosts.pushCredential(config.hostConnectionId).catch(() => null);
  }
}

/** Chains credential providers: the first non-null answer wins. */
export function firstCredential(...providers: GitCredentialProvider[]): GitCredentialProvider {
  return {
    async issue(job) {
      for (const p of providers) {
        const c = await p.issue(job);
        if (c !== null) return c;
      }
      return null;
    },
    async issueReadOnly(req) {
      for (const p of providers) {
        const c = p.issueReadOnly === undefined ? null : await p.issueReadOnly(req);
        if (c !== null) return c;
      }
      return null;
    },
    async issueIdePush(req) {
      for (const p of providers) {
        const c = p.issueIdePush === undefined ? null : await p.issueIdePush(req);
        if (c !== null) return c;
      }
      return null;
    },
  };
}

/**
 * Remote inspection for lost attempts (p4-recovery) through the project's git provider (authenticated
 * GitHub API instead of an anonymous `ls-remote`, so private repositories answer `present`/`absent`
 * instead of `unknown`). Repositories without a git configuration use the fallback inspector.
 */
export class ProviderBranchInspector implements RemoteBranchInspector {
  constructor(
    private readonly deps: {
      readonly db: Queryable;
      readonly providers: ProviderFactory;
      readonly fallback: RemoteBranchInspector;
    },
  ) {}

  async inspect(repositoryUrl: string, branch: string): Promise<RemoteBranchState> {
    if (!isAttemptBranch(branch)) return 'unknown';
    const { rows } = await this.deps.db.query<{ project: string; repository_url: string }>(
      'SELECT project, repository_url FROM project_git_configs',
    );
    const match = rows.find((r) => sameRepository(r.repository_url, repositoryUrl));
    if (match === undefined) return this.deps.fallback.inspect(repositoryUrl, branch);
    let config: ProjectGitConfig | null;
    try {
      config = await loadGitConfig(this.deps.db, match.project);
      if (config === null) return 'unknown';
      return (await this.deps.providers(config).branchHead(branch)) === null ? 'absent' : 'present';
    } catch {
      return 'unknown';
    }
  }
}
