import { type ApiRateBudget, hostRateBudgetOf } from './github-rate.js';
import { BitbucketProvider } from './bitbucket-provider.js';
import type { ProjectGitConfig } from './config-store.js';
import type { HostConnectionRef } from './git-hosts.js';
import type { FetchFn } from './github-app.js';
import { GitLabProvider } from './gitlab-provider.js';
import { hostedRepoPath } from './refs.js';
import {
  type BlobRead,
  type BranchProtection,
  type BranchUpdate,
  type CiStatus,
  type CommitInfo,
  type Comparison,
  type GitProvider,
  type MergeCheck,
  type MergeInput,
  type MergeOutcome,
  type PatchText,
  ProviderError,
  type PullRequestRef,
  type TreeListing,
} from './types.js';

/** What the hosted providers need from the connection store (no secret leaves it except to the HTTP call). */
export interface HostConnectionSource {
  ref(id: string): Promise<HostConnectionRef>;
  apiToken(id: string): Promise<string>;
}

export interface HostedProviderOptions {
  readonly hosts: HostConnectionSource;
  readonly fetch?: FetchFn;
  readonly pollMs?: number;
}

/**
 * p16-git-providers: the provider of a GitLab / Bitbucket project. The provider factory is synchronous, the connection
 * lives in the database: the real provider is built on first use (the connection's host and the repository path) and
 * kept for this configuration version; its token is read per request (rotation applies at once).
 */
export class HostedProvider implements GitProvider {
  readonly kind: 'gitlab' | 'bitbucket';
  #inner: Promise<GitLabProvider | BitbucketProvider> | null = null;
  readonly #budget: ApiRateBudget | null;

  constructor(
    private readonly config: ProjectGitConfig,
    private readonly opts: HostedProviderOptions,
  ) {
    if (config.provider !== 'gitlab' && config.provider !== 'bitbucket') {
      throw new ProviderError('not a hosted provider configuration', false);
    }
    this.kind = config.provider;
    this.#budget =
      config.hostConnectionId === null ? null : hostRateBudgetOf(config.provider, config.hostConnectionId);
  }

  /** p22-harness-gaps: background re-checks wait while the connection's budget is low. */
  backgroundBudgetLow(): boolean {
    return this.#budget?.low(Date.now()) ?? false;
  }

  #get(): Promise<GitLabProvider | BitbucketProvider> {
    this.#inner ??= this.#build().catch((err: unknown) => {
      this.#inner = null;
      throw err;
    });
    return this.#inner;
  }

  async #build(): Promise<GitLabProvider | BitbucketProvider> {
    const id = this.config.hostConnectionId;
    if (id === null) throw new ProviderError('the project has no GitLab / Bitbucket connection', false);
    let conn: HostConnectionRef;
    try {
      conn = await this.opts.hosts.ref(id);
    } catch {
      throw new ProviderError('the GitLab / Bitbucket connection of this project no longer exists', false);
    }
    if (conn.kind !== this.kind) throw new ProviderError('the connection is for another provider', false);
    const path = hostedRepoPath(this.config.repositoryUrl, conn);
    if (path === null) throw new ProviderError('the repository is not on the connection host', false);
    const token = () => this.opts.hosts.apiToken(id);
    const common = {
      token,
      ...(this.#budget === null ? {} : { budget: this.#budget }),
      ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
      ...(this.opts.pollMs === undefined ? {} : { pollMs: this.opts.pollMs }),
    };
    if (conn.kind === 'gitlab')
      return new GitLabProvider({ baseUrl: conn.baseUrl, projectPath: path, ...common });
    const [workspace, repoSlug] = path.split('/') as [string, string];
    return new BitbucketProvider({ apiUrl: conn.baseUrl, workspace, repoSlug, ...common });
  }

  async branchHead(branch: string): Promise<string | null> {
    return (await this.#get()).branchHead(branch);
  }
  async commit(sha: string): Promise<CommitInfo> {
    return (await this.#get()).commit(sha);
  }
  async compare(base: string, head: string): Promise<Comparison> {
    return (await this.#get()).compare(base, head);
  }
  async testMerge(input: Parameters<GitProvider['testMerge']>[0]): Promise<MergeCheck> {
    return (await this.#get()).testMerge(input);
  }
  async ensurePullRequest(
    input: Parameters<GitProvider['ensurePullRequest']>[0],
  ): Promise<PullRequestRef | null> {
    return (await this.#get()).ensurePullRequest(input);
  }
  async issueComment(number: number, body: string, marker: string) {
    return (await this.#get()).issueComment(number, body, marker);
  }
  async checks(sha: string): Promise<CiStatus> {
    return (await this.#get()).checks(sha);
  }
  async merge(input: MergeInput): Promise<MergeOutcome> {
    return (await this.#get()).merge(input);
  }
  async findMerge(targetBranch: string, mergeRequestId: string): Promise<string | null> {
    return (await this.#get()).findMerge(targetBranch, mergeRequestId);
  }
  async deleteBranch(branch: string, expectedSha: string): Promise<'deleted' | 'moved' | 'absent'> {
    return (await this.#get()).deleteBranch(branch, expectedSha);
  }
  async patch(base: string, head: string, maxBytes: number): Promise<PatchText> {
    return (await this.#get()).patch(base, head, maxBytes);
  }
  async tree(sha: string, path: string): Promise<TreeListing | null> {
    return (await this.#get()).tree(sha, path);
  }
  async blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    return (await this.#get()).blob(sha, path, maxBytes);
  }
  async branchProtection(branch: string): Promise<BranchProtection> {
    return (await this.#get()).branchProtection(branch);
  }
  async updateBranch(branch: string, sha: string, expected: string | null): Promise<BranchUpdate> {
    return (await this.#get()).updateBranch(branch, sha, expected);
  }
  async defaultBranch(): Promise<string | null> {
    return (await this.#get()).defaultBranch();
  }
  async isEmpty(): Promise<boolean> {
    return (await this.#get()).isEmpty();
  }
  async closePullRequest(pr: PullRequestRef, comment: string): Promise<void> {
    return (await this.#get()).closePullRequest(pr, comment);
  }
  async updatePullRequest(
    pr: PullRequestRef,
    input: { readonly title: string; readonly body: string },
  ): Promise<void> {
    return (await this.#get()).updatePullRequest(pr, input);
  }
}
