import type { Queryable } from '../db/pool.js';
import type { ProjectGitConfig } from '../gitflow/config-store.js';
import { parseRepoUrl, sameRepository } from '../gitflow/refs.js';
import { type GitProvider, ProviderError } from '../gitflow/types.js';
import type { JobRecord } from '../jobs/store.js';
import type { RemoteProbe } from './remote-probe.js';

/**
 * p22-git-preflight (docs/design/p22-git-preflight.md §1): before a repository job is dispatched, the master checks that
 * the job's repository can be read with what the platform will hand the worker — so a job that can never fetch fails
 * at once with a reason a person can act on, instead of starting a runtime on a machine and failing there with
 * `git fetch failed (exit 128): fatal: could not read Username for 'https://github.com'` (test server, 14 days to
 * 2026-11-01: 12 jobs; plus 3 × "Invalid username or token" on push).
 *
 * The credential the worker gets for a job (orchestration/session.ts CREDENTIAL_REQUEST, gitflow/credentials.ts):
 * - the project's GitHub App installation / GitLab / Bitbucket connection — only for the project's configured
 *   repository and only for a trusted source (or a platform report job: read-only); checked here by asking the
 *   provider for the repository (its default branch) with that connection; a definite refusal (401/403/404/422, a
 *   GitHub App installation that does not include the repository) → `repo_access_denied`;
 * - a vault repository credential of the project (p15-git-central) — sealed to the workers, the master cannot test it:
 *   assumed present;
 * - nothing → the worker reads anonymously: an anonymous `ls-remote` (RemoteProbe) that the remote refuses →
 *   `repo_credentials_missing` (a private repository with no credential path for this job).
 *
 * Everything that is not a definite refusal (network, 5xx, rate limit, ssh URLs, plain git providers, a provider that
 * cannot be built) passes: the preflight never fails a job on a guess. Verdicts are cached per project + repository
 * (pass 10 min, refusal 2 min) so dispatch does not turn into one provider request per queued job and tick.
 */

export type RepoAccessCode = 'repo_credentials_missing' | 'repo_access_denied';

/** Why a job has no credential path (shown with `repo_credentials_missing`). */
export type RepoAccessWhy =
  'no_connection' | 'other_repository' | 'untrusted_source' | 'connection_refused' | 'not_installed';

export type RepoAccessVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: RepoAccessCode;
      readonly why: RepoAccessWhy;
      /** `github` / `gitlab` / `bitbucket` (the project's connection) or `anonymous`. */
      readonly via: string;
      readonly host: string;
      /** English, identifiers only (the transition reason; the UI translates the code). */
      readonly reason: string;
    };

export interface RepoAccessDeps {
  readonly pool: Queryable;
  readonly probe: RemoteProbe;
  /** The project's git provider and configuration (gitflow), null when the project has none. */
  readonly providerFor: (
    project: string,
  ) => Promise<{ readonly provider: GitProvider; readonly config: ProjectGitConfig } | null>;
  readonly clock?: () => number;
}

const PASS_MS = 10 * 60_000;
const FAIL_MS = 2 * 60_000;
const DENIED_STATUS = new Set([401, 403, 404, 422]);

export class RepoAccessPreflight {
  readonly #cache = new Map<string, { readonly until: number; readonly verdict: RepoAccessVerdict }>();
  readonly #clock: () => number;

  constructor(private readonly deps: RepoAccessDeps) {
    this.#clock = deps.clock ?? (() => Date.now());
  }

  async check(job: JobRecord): Promise<RepoAccessVerdict> {
    const repo = job.spec.repository;
    if (repo === undefined) return { ok: true };
    const parsed = parseRepoUrl(repo.url);
    // ssh: deploy keys / the machine's own key — nothing the control plane can test anonymously.
    if (parsed?.protocol !== 'https') return { ok: true };
    const facts = await this.#facts(job);
    const key = [job.project, parsed.key.toLowerCase(), facts.eligible ? 'c' : 'n'].join('\u0000');
    const now = this.#clock();
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.until > now) return cached.verdict;
    const verdict = await this.#check(job, repo.url, parsed.host, facts);
    if (this.#cache.size > 5_000) this.#cache.clear();
    this.#cache.set(key, { until: now + (verdict.ok ? PASS_MS : FAIL_MS), verdict });
    return verdict;
  }

  /** Forgets the cached verdicts of a project (its git connection or credential changed). */
  forgetProject(project: string): void {
    for (const key of this.#cache.keys()) if (key.startsWith(`${project}\u0000`)) this.#cache.delete(key);
  }

  async #check(
    job: JobRecord,
    url: string,
    host: string,
    facts: { readonly eligible: boolean; readonly vault: boolean },
  ): Promise<RepoAccessVerdict> {
    if (facts.vault) return { ok: true };
    let why: RepoAccessWhy = 'no_connection';
    const git = await this.deps.providerFor(job.project).catch(() => null);
    if (git !== null) {
      // A plain-git provider hands the worker no credential at all ('no_connection').
      if (!sameRepository(git.config.repositoryUrl, url)) why = 'other_repository';
      else if (git.config.provider === 'git') why = 'no_connection';
      else if (!facts.eligible) why = 'untrusted_source';
      else return this.#viaConnection(git.provider, git.config, host);
    }
    const seen = await this.deps.probe.probe(url);
    if (seen.kind !== 'denied') return { ok: true };
    return {
      ok: false,
      code: 'repo_credentials_missing',
      why,
      via: 'anonymous',
      host,
      reason: `repo_credentials_missing: ${host} refuses to show the repository without credentials and the job gets none (${why.replace(/_/g, ' ')})`,
    };
  }

  /** The project's own connection asks the provider for the repository; only a definite refusal fails. */
  async #viaConnection(
    provider: GitProvider,
    config: ProjectGitConfig,
    host: string,
  ): Promise<RepoAccessVerdict> {
    if (provider.defaultBranch === undefined) return { ok: true };
    const denied = (why: RepoAccessWhy, detail: string): RepoAccessVerdict => ({
      ok: false,
      code: 'repo_access_denied',
      why,
      via: config.provider,
      host,
      reason: `repo_access_denied: the project's ${config.provider} connection cannot read the repository (${why.replace(/_/g, ' ')}, ${detail})`,
    });
    try {
      const branch = await provider.defaultBranch();
      // 404 of the repository through the connection: not installed for it / no access / gone.
      return branch === null && config.provider === 'github'
        ? denied('not_installed', 'HTTP 404')
        : { ok: true };
    } catch (err) {
      if (
        err instanceof ProviderError &&
        !err.transient &&
        err.status !== null &&
        DENIED_STATUS.has(err.status)
      ) {
        return denied(
          err.status === 404 || err.status === 422 ? 'not_installed' : 'connection_refused',
          `HTTP ${String(err.status)}`,
        );
      }
      return { ok: true };
    }
  }

  /**
   * Whether the project's connection would hand this job a credential (the gates of gitflow/credentials.ts: a trusted
   * source, a platform report job or a pinned pull request head) and whether the project has a vault credential the
   * job may use (git-central `repoGitAuth`: an active credential; read-only for an untrusted source).
   */
  async #facts(job: JobRecord): Promise<{ eligible: boolean; vault: boolean }> {
    const trusted = job.spec.sourceTrust === 'trusted';
    const { rows } = await this.deps.pool.query<{ report_only: boolean; vault: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM report_only_jobs r WHERE r.job_id = $1) AS report_only,
              EXISTS (SELECT 1 FROM project_repo_credentials c
                        JOIN vault_credentials v ON v.id = c.credential_id AND v.state = 'active'
                       WHERE c.project = $2 AND ($3 OR c.access = 'read')) AS vault`,
      [job.id, job.project, trusted],
    );
    const row = rows[0];
    return {
      eligible: trusted || row?.report_only === true || job.spec.repository?.pullRequest !== undefined,
      vault: row?.vault === true,
    };
  }
}
