import type { ApiRateBudget } from './github-rate.js';
import type { FetchFn } from './github-app.js';
import {
  comparisonStatus,
  conflictsBetween,
  hostedCiState,
  mergeabilityFromHistory,
  targetStillContainsBase,
} from './hosted-common.js';
import {
  arr,
  bbqlString,
  globMatches,
  HostedHttp,
  num,
  obj,
  parseRawAuthor,
  refPath,
  sleep,
  str,
} from './hosted-http.js';
import { isTargetBranch, MERGE_TRAILER_KEY, SHA, trailerValues } from './refs.js';
import {
  type BlobRead,
  type BranchProtection,
  type BranchUpdate,
  type CiCheck,
  type CiStatus,
  type CommitInfo,
  type Comparison,
  capPatch,
  type FileChange,
  type GitProvider,
  type MergeCheck,
  type MergeInput,
  type MergeOutcome,
  type PatchText,
  ProviderError,
  type PullRequestRef,
  type TreeEntry,
  type TreeListing,
  classifyText,
  isRepoPath,
  type OpenPullRequest,
} from './types.js';

export interface BitbucketProviderOptions {
  /** `https://api.bitbucket.org` (tests: a fake). */
  readonly apiUrl: string;
  readonly workspace: string;
  readonly repoSlug: string;
  readonly token: () => Promise<string>;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** p22-harness-gaps: the connection's rate budget. */
  readonly budget?: ApiRateBudget;
  /** Waits between merge task polls (tests: 0). */
  readonly pollMs?: number;
}

/** Branch restriction kinds that keep a token with write access from rewriting the branch on its own. */
const PROTECTING = new Set([
  'push',
  'force',
  'delete',
  'restrict_merges',
  'require_passing_builds_to_merge',
  'require_approvals_to_merge',
  'require_default_reviewer_approvals_to_merge',
  'require_tasks_to_be_completed',
  'require_no_changes_requested',
  'enforce_merge_checks',
]);

function toCheck(o: Record<string, unknown>): CiCheck {
  const state = str(o.state);
  const name = (str(o.name) || str(o.key)).slice(0, 200);
  const url = typeof o.url === 'string' ? o.url : null;
  switch (state) {
    case 'SUCCESSFUL':
      return { name, status: 'completed', conclusion: 'success', url };
    case 'FAILED':
      return { name, status: 'completed', conclusion: 'failure', url };
    case 'STOPPED':
      return { name, status: 'completed', conclusion: 'cancelled', url };
    case 'INPROGRESS':
      return { name, status: 'in_progress', conclusion: null, url };
    default:
      return { name, status: 'pending', conclusion: null, url };
  }
}

/**
 * Bitbucket Cloud REST 2.0 implementation of {@link GitProvider} (docs/design/p16-git-providers.md §4; endpoints taken
 * from Atlassian's published OpenAPI document `https://api.bitbucket.org/swagger.json`, 2026-10-23, and Context7
 * `/websites/developer_atlassian_cloud_bitbucket` for authentication). **UNVERIFIED-LIVE**: tested against a local fake
 * backed by a real bare repository, not yet against bitbucket.org.
 *
 * Endpoints (under `/2.0/repositories/{workspace}/{repo}`): `GET/POST/DELETE refs/branches[/{name}]`, `GET commit/{c}`,
 * `GET commits/{rev}?exclude=`, `GET merge-base/{a}..{b}`, `GET diffstat/{head}..{base}` / `diff/…` (Bitbucket's
 * order: the side with the changes first), `GET commit/{c}/statuses`, `GET/POST/PUT pullrequests`,
 * `GET pullrequests/{id}/mergeability/checks`, `GET pullrequests/{id}/conflicts`, `POST pullrequests/{id}/merge`
 * (+ `merge/task-status/{task}` when it answers 202), `GET/POST pullrequests/{id}/comments`, `GET branch-restrictions`.
 */
export class BitbucketProvider implements GitProvider {
  readonly kind = 'bitbucket' as const;
  readonly #http: HostedHttp;
  readonly #o: BitbucketProviderOptions;

  constructor(opts: BitbucketProviderOptions) {
    this.#o = opts;
    this.#http = new HostedHttp({
      name: 'Bitbucket',
      apiRoot: `${opts.apiUrl.replace(/\/+$/, '')}/2.0/repositories/${encodeURIComponent(opts.workspace)}/${encodeURIComponent(opts.repoSlug)}`,
      token: opts.token,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.budget === undefined ? {} : { budget: opts.budget }),
    });
  }

  /** p22-harness-gaps: see {@link GitProvider.backgroundBudgetLow}. */
  backgroundBudgetLow(): boolean {
    return this.#http.budgetLow();
  }

  #req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    return this.#http.request(method, path, body);
  }

  async branchHead(branch: string): Promise<string | null> {
    const r = await this.#req('GET', `/refs/branches/${refPath(branch)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#http.fail('read branch', r.status);
    const j = obj(r.json);
    const sha = str(obj(j.target).hash);
    if (str(j.name) !== branch || !SHA.test(sha)) return null;
    return sha;
  }

  async commit(sha: string): Promise<CommitInfo> {
    if (!SHA.test(sha)) throw new ProviderError('invalid sha', false);
    const r = await this.#req('GET', `/commit/${sha}`);
    if (r.status !== 200) this.#http.fail('read commit', r.status);
    return toCommit(obj(r.json));
  }

  async #mergeBase(a: string, b: string): Promise<string> {
    const r = await this.#req('GET', `/merge-base/${a}..${b}`);
    if (r.status !== 200) this.#http.fail('merge base', r.status);
    const hash = str(obj(r.json).hash);
    if (!SHA.test(hash)) throw new ProviderError('Bitbucket returned no merge base', false);
    return hash;
  }

  async compare(base: string, head: string): Promise<Comparison> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    const mergeBase = base === head ? base : await this.#mergeBase(base, head);
    const status = comparisonStatus(base, head, mergeBase);
    if (status === 'identical' || status === 'behind') {
      return { status, mergeBase, commits: [], files: [], truncated: false };
    }
    // Commits on head but not on base (newest first, like git log) — two pages at most.
    const commits: CommitInfo[] = [];
    let truncated = false;
    let next: string | null = `/commits/${head}?exclude=${base}&pagelen=100`;
    for (let page = 0; next !== null; page++) {
      if (page >= 2) {
        truncated = true;
        break;
      }
      const r = await this.#req('GET', next);
      if (r.status !== 200) this.#http.fail('list commits', r.status);
      const j = obj(r.json);
      for (const c of arr(j.values)) commits.push(toCommit(obj(c)));
      next = this.#nextPath(str(j.next));
    }
    // Files: Bitbucket's spec is `<side with changes>..<other side>` with a three-dot (merge-base) diff.
    const files: FileChange[] = [];
    let path: string | null = `/diffstat/${head}..${base}?topic=true&pagelen=500`;
    for (let page = 0; path !== null; page++) {
      if (page >= 2) {
        truncated = true;
        break;
      }
      const r = await this.#req('GET', path);
      if (r.status !== 200) this.#http.fail('diffstat', r.status);
      const j = obj(r.json);
      for (const d of arr(j.values)) files.push(toFile(obj(d)));
      path = this.#nextPath(str(j.next));
    }
    return {
      status,
      mergeBase,
      commits: commits.reverse(),
      files: files.slice(0, 300),
      truncated: truncated || files.length > 300,
    };
  }

  /** A `next` link → a path under this repository (refused when it points elsewhere). */
  #nextPath(next: string): string | null {
    if (next === '') return null;
    const marker = `/2.0/repositories/${encodeURIComponent(this.#o.workspace)}/${encodeURIComponent(this.#o.repoSlug)}`;
    try {
      const u = new URL(next);
      const root = new URL(this.#o.apiUrl);
      if (u.host !== root.host || !u.pathname.startsWith(marker)) return null;
      return `${u.pathname.slice(marker.length)}${u.search}`;
    } catch {
      return null;
    }
  }

  async patch(base: string, head: string, maxBytes: number): Promise<PatchText> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    const r = await this.#http.request('GET', `/diff/${head}..${base}?topic=true`, undefined, { text: true });
    if (r.status !== 200) this.#http.fail('diff', r.status);
    return capPatch(r.text, maxBytes);
  }

  async #pr(id: number): Promise<Record<string, unknown>> {
    const r = await this.#req('GET', `/pullrequests/${String(id)}`);
    if (r.status !== 200) this.#http.fail('read pull request', r.status);
    return obj(r.json);
  }

  /**
   * Bitbucket's mergeability checks (`git_mergeability_check`: PASSED = clean, FAILED = conflicts, PENDING / UNKNOWN =
   * ask again). The conflicting files come from the pull request's file conflicts (exact) when Bitbucket answers them,
   * else they are approximated like on GitHub (files changed on both sides).
   */
  async testMerge(input: {
    readonly targetBranch: string;
    readonly headSha: string;
    readonly headBranch: string;
    readonly baseAtStart: string;
    readonly pullRequest: PullRequestRef | null;
  }): Promise<MergeCheck> {
    const b = await targetStillContainsBase(this, input);
    if ('check' in b) return b.check;
    const base = b.base;
    if (input.pullRequest === null) return mergeabilityFromHistory(this, base, input.headSha);
    const pr = await this.#pr(input.pullRequest.number);
    if (str(pr.state) === 'MERGED') return { state: 'clean', baseSha: base, headSha: input.headSha };
    // Pull request hashes are abbreviated (12 characters).
    const prHead = str(obj(obj(pr.source).commit).hash);
    if (prHead.length < 7 || !input.headSha.startsWith(prHead)) {
      return mergeabilityFromHistory(this, base, input.headSha);
    }
    const r = await this.#req('GET', `/pullrequests/${String(input.pullRequest.number)}/mergeability/checks`);
    if (r.status !== 200) return { state: 'unknown', baseSha: base, headSha: input.headSha };
    const gitCheck = arr(obj(r.json).values)
      .map(obj)
      .find((c) => str(c.type) === 'git_mergeability_check');
    const status = str(gitCheck?.status);
    if (status === 'PASSED') return { state: 'clean', baseSha: base, headSha: input.headSha };
    if (status !== 'FAILED') return mergeabilityFromHistory(this, base, input.headSha);
    const conflicts = await this.#req('GET', `/pullrequests/${String(input.pullRequest.number)}/conflicts`);
    const exact =
      conflicts.status === 200
        ? arr(obj(conflicts.json).values)
            .map((c) => str(obj(c).path))
            .filter((p) => p !== '')
        : [];
    return conflictsBetween(this, base, input.headSha, exact.length > 0 ? exact : null);
  }

  async ensurePullRequest(input: {
    readonly headBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly body: string;
    readonly draft?: boolean;
  }): Promise<PullRequestRef | null> {
    const find = async (): Promise<PullRequestRef | null> => {
      const q = new URLSearchParams({
        state: 'OPEN',
        q: `source.branch.name = ${bbqlString(input.headBranch)} AND destination.branch.name = ${bbqlString(input.targetBranch)}`,
        pagelen: '5',
      });
      const r = await this.#req('GET', `/pullrequests?${q.toString()}`);
      if (r.status !== 200) this.#http.fail('list pull requests', r.status);
      const first = obj(arr(obj(r.json).values)[0]);
      const id = num(first.id);
      return id > 0 ? { number: id, url: str(obj(obj(first.links).html).href) } : null;
    };
    const existing = await find();
    if (existing !== null) return existing;
    const r = await this.#req('POST', '/pullrequests', {
      title: input.title.slice(0, 250),
      description: input.body.slice(0, 60_000),
      source: { branch: { name: input.headBranch } },
      destination: { branch: { name: input.targetBranch } },
      close_source_branch: false,
      ...(input.draft === true ? { draft: true } : {}),
    });
    if (r.status === 201 || r.status === 200) {
      const j = obj(r.json);
      return { number: num(j.id), url: str(obj(obj(j.links).html).href) };
    }
    if (r.status === 400 || r.status === 409) {
      const again = await find();
      if (again !== null) return again;
    }
    this.#http.fail('create pull request', r.status);
  }

  /**
   * p18-leftovers: `GET pullrequests?state=OPEN&sort=-updated_on` (Bitbucket Cloud "List pull requests"; source /
   * destination branch names, source.repository.full_name — Context7 developer_atlassian_cloud_bitbucket_rest_intro).
   * The listing's commit hash is short, so the head is compared by branch (same repository only). UNVERIFIED-LIVE.
   */
  async openPullRequests(limit: number): Promise<readonly OpenPullRequest[]> {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const q = new URLSearchParams({ state: 'OPEN', sort: '-updated_on', pagelen: String(n) });
    const r = await this.#req('GET', `/pullrequests?${q.toString()}`);
    if (r.status !== 200) this.#http.fail('list pull requests', r.status);
    const own = `${this.#o.workspace}/${this.#o.repoSlug}`.toLowerCase();
    return arr(obj(r.json).values)
      .slice(0, n)
      .map((x) => {
        const o = obj(x);
        const src = obj(o.source);
        const sha = str(obj(src.commit).hash);
        return {
          number: num(o.id),
          title: str(o.title).slice(0, 300),
          url: str(obj(obj(o.links).html).href),
          author: str(obj(o.author).display_name) || null,
          draft: o.draft === true,
          baseBranch: str(obj(obj(o.destination).branch).name),
          headBranch: str(obj(src.branch).name),
          headSha: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
          sameRepository: str(obj(src.repository).full_name).toLowerCase() === own,
          updatedAt: str(o.updated_on) || null,
        };
      })
      .filter((p) => p.number > 0 && p.baseBranch !== '');
  }

  async issueComment(
    number: number,
    body: string,
    marker: string,
  ): Promise<{ readonly id: number; readonly url: string; readonly created: boolean }> {
    if (!Number.isInteger(number) || number < 1) throw new ProviderError('invalid pull request', false);
    let path: string | null = `/pullrequests/${String(number)}/comments?pagelen=100`;
    for (let page = 0; path !== null && page < 3; page++) {
      const r = await this.#req('GET', path);
      if (r.status !== 200) this.#http.fail('list comments', r.status);
      const j = obj(r.json);
      const hit = arr(j.values)
        .map(obj)
        .find((c) => str(obj(c.content).raw).includes(marker));
      if (hit !== undefined) {
        return { id: num(hit.id), url: str(obj(obj(hit.links).html).href), created: false };
      }
      path = this.#nextPath(str(j.next));
    }
    const r = await this.#req('POST', `/pullrequests/${String(number)}/comments`, {
      content: { raw: `${body.slice(0, 60_000)}\n\n${marker}` },
    });
    if (r.status !== 201 && r.status !== 200) this.#http.fail('create comment', r.status);
    const j = obj(r.json);
    return { id: num(j.id), url: str(obj(obj(j.links).html).href), created: true };
  }

  async checks(sha: string): Promise<CiStatus> {
    if (!SHA.test(sha)) throw new ProviderError('invalid sha', false);
    const r = await this.#req('GET', `/commit/${sha}/statuses?pagelen=100`);
    if (r.status !== 200) return { state: 'unavailable', checks: [] };
    const checks = arr(obj(r.json).values).map((s) => toCheck(obj(s)));
    return { state: hostedCiState(checks), checks };
  }

  /**
   * `POST pullrequests/{id}/merge` has no head guard: the head is re-read right before (residual race documented). A
   * 202 (merge queue or a slow merge) is polled through its task-status link; 555 is a transient timeout — the retry
   * finds the merge by its `Remyral-Merge` trailer.
   */
  async merge(input: MergeInput): Promise<MergeOutcome> {
    if (input.pullRequest === null) {
      return { merged: false, reason: 'rejected', detail: 'no pull request for the attempt branch' };
    }
    const head = await this.branchHead(input.headBranch);
    if (head !== input.headSha) {
      return {
        merged: false,
        reason: 'head_moved',
        detail: `${input.headBranch} is at ${head ?? '(deleted)'}, approval was for ${input.headSha}`,
      };
    }
    const id = input.pullRequest.number;
    const r = await this.#req('POST', `/pullrequests/${String(id)}/merge`, {
      type: 'pullrequest_merge_parameters',
      message: `${input.title.slice(0, 250)}\n\n${input.message}`.slice(0, 60_000),
      close_source_branch: false,
      merge_strategy: input.method === 'squash' ? 'squash' : 'merge_commit',
    });
    const err = obj(obj(r.json).error);
    const detail = str(err.message).slice(0, 300);
    switch (r.status) {
      case 200:
        return this.#mergedSha(obj(r.json), input.targetBranch);
      case 202:
        return this.#pollTask(r.headers.get('location'), id, input.targetBranch);
      case 400:
        return { merged: false, reason: 'not_mergeable', detail: detail || 'pull request cannot be merged' };
      case 409:
        return { merged: false, reason: 'head_moved', detail: detail || 'a ref changed while merging' };
      case 401:
      case 403:
        return { merged: false, reason: 'forbidden', detail: detail || 'forbidden (branch restriction?)' };
      default:
        return { merged: false, reason: 'rejected', detail: `HTTP ${String(r.status)} ${detail}`.trim() };
    }
  }

  async #pollTask(location: string | null, id: number, target: string): Promise<MergeOutcome> {
    const prefix = `/pullrequests/${String(id)}/merge/task-status/`;
    const m = location === null ? null : /\/merge\/task-status\/([A-Za-z0-9{}_-]{1,128})\/?$/.exec(location);
    if (m?.[1] === undefined) {
      return { merged: false, reason: 'rejected', detail: 'Bitbucket queued the merge without a task link' };
    }
    for (let i = 0; i < 10; i++) {
      await sleep(this.#o.pollMs ?? 1000);
      const r = await this.#req('GET', `${prefix}${m[1]}`);
      if (r.status === 409)
        return { merged: false, reason: 'head_moved', detail: 'a ref changed while merging' };
      if (r.status !== 200) {
        return {
          merged: false,
          reason: 'not_mergeable',
          detail: str(obj(obj(r.json).error).message).slice(0, 300) || `merge task HTTP ${String(r.status)}`,
        };
      }
      const j = obj(r.json);
      if (str(j.task_status) === 'SUCCESS') return this.#mergedSha(obj(j.merge_result), target);
    }
    return { merged: false, reason: 'rejected', detail: 'Bitbucket has not finished the merge yet (queued)' };
  }

  async #mergedSha(pr: Record<string, unknown>, target: string): Promise<MergeOutcome> {
    if (str(pr.state) !== 'MERGED') {
      return { merged: false, reason: 'rejected', detail: 'Bitbucket did not merge the pull request' };
    }
    // The pull request names its merge commit abbreviated: the full hash is the target tip, checked to match.
    const short = str(obj(pr.merge_commit).hash);
    const tip = await this.branchHead(target);
    if (tip !== null && (short === '' || tip.startsWith(short))) return { merged: true, sha: tip };
    if (short !== '') {
      const c = await this.#req('GET', `/commit/${encodeURIComponent(short)}`);
      const full = str(obj(c.json).hash);
      if (c.status === 200 && SHA.test(full)) return { merged: true, sha: full };
    }
    return { merged: false, reason: 'rejected', detail: 'Bitbucket returned no merge commit' };
  }

  async findMerge(targetBranch: string, mergeRequestId: string): Promise<string | null> {
    const r = await this.#req('GET', `/commits/${refPath(targetBranch)}?pagelen=20`);
    if (r.status !== 200) this.#http.fail('list commits', r.status);
    for (const c of arr(obj(r.json).values)) {
      const o = obj(c);
      if (trailerValues(str(o.message), MERGE_TRAILER_KEY).includes(mergeRequestId)) {
        const sha = str(o.hash);
        return SHA.test(sha) ? sha : null;
      }
    }
    return null;
  }

  /**
   * p19-ide W1: `GET src/{commit}/{path}/` — a directory answers a paged listing (`commit_directory` / `commit_file`
   * values; the first 10 pages are read). UNVERIFIED-LIVE (fixtures only).
   */
  async tree(sha: string, path: string): Promise<TreeListing | null> {
    if (!SHA.test(sha) || !isRepoPath(path, true)) throw new ProviderError('invalid sha or path', false);
    const entries: TreeEntry[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.#req(
        'GET',
        `/src/${sha}/${path === '' ? '' : `${refPath(path)}/`}?pagelen=100&page=${String(page)}`,
      );
      if (r.status === 404) return page === 1 ? null : { entries, truncated: false };
      if (r.status !== 200) this.#http.fail('read directory', r.status);
      const j = obj(r.json);
      if (!Array.isArray(j.values)) return null;
      for (const e of arr(j.values)) {
        const o = obj(e);
        const full = str(o.path);
        if (!isRepoPath(full)) continue;
        const type = str(o.type);
        const symlink = arr(o.attributes).includes('link');
        entries.push({
          name: full.split('/').pop() ?? full,
          path: full,
          kind: type === 'commit_directory' ? 'dir' : symlink ? 'symlink' : 'file',
          size: type === 'commit_file' ? num(o.size) : null,
        });
      }
      if (typeof j.next !== 'string') return { entries, truncated: false };
    }
    return { entries, truncated: true };
  }

  /**
   * p19-ide W1: `GET src/{commit}/{path}?format=meta` (type and size), then the raw file when it is within the cap.
   * UNVERIFIED-LIVE (fixtures only).
   */
  async blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    if (!SHA.test(sha) || !isRepoPath(path)) throw new ProviderError('invalid sha or path', false);
    const meta = await this.#req('GET', `/src/${sha}/${refPath(path)}?format=meta`);
    if (meta.status === 404) return null;
    if (meta.status !== 200) this.#http.fail('read file', meta.status);
    const m = obj(meta.json);
    if (str(m.type) !== 'commit_file') return null;
    const size = num(m.size);
    if (size > maxBytes) return { state: 'too_large', size };
    const r = await this.#http.request('GET', `/src/${sha}/${refPath(path)}`, undefined, { text: true });
    if (r.status !== 200) this.#http.fail('read file', r.status);
    return classifyText(r.text, size, maxBytes);
  }

  async deleteBranch(branch: string, expectedSha: string): Promise<'deleted' | 'moved' | 'absent'> {
    const head = await this.branchHead(branch);
    if (head === null) return 'absent';
    if (head !== expectedSha) return 'moved';
    const r = await this.#req('DELETE', `/refs/branches/${refPath(branch)}`);
    if (r.status === 204) return 'deleted';
    if (r.status === 404) return 'absent';
    this.#http.fail('delete branch', r.status);
  }

  /** Branch restrictions whose glob pattern matches the branch (branching-model rules are not evaluated: `unknown`). */
  async branchProtection(branch: string): Promise<BranchProtection> {
    if ((await this.branchHead(branch)) === null) return { state: 'missing', classic: false, rules: [] };
    const r = await this.#req('GET', '/branch-restrictions?pagelen=100');
    if (r.status !== 200) return { state: 'unknown', classic: false, rules: [] };
    const all = arr(obj(r.json).values).map(obj);
    const modelRules = all.some((x) => str(x.branch_match_kind) === 'branching_model');
    const rules = [
      ...new Set(
        all
          .filter(
            (x) => str(x.branch_match_kind) !== 'branching_model' && globMatches(str(x.pattern), branch),
          )
          .map((x) => str(x.kind))
          .filter((k) => /^[a-z_]{1,64}$/.test(k)),
      ),
    ];
    if (rules.some((k) => PROTECTING.has(k))) return { state: 'protected', classic: false, rules };
    return { state: modelRules ? 'unknown' : 'unprotected', classic: false, rules };
  }

  /** Same rule as GitLab: create, or move a platform `int/…` branch by fast-forward only (delete + create). */
  async updateBranch(branch: string, sha: string, expected: string | null): Promise<BranchUpdate> {
    if (!SHA.test(sha) || (expected !== null && !SHA.test(expected)))
      throw new ProviderError('invalid sha', false);
    const head = await this.branchHead(branch);
    if (head === sha) return 'updated';
    if (head !== expected) return 'moved';
    if (expected !== null) {
      if (!branch.startsWith('int/')) return 'not_fast_forward';
      if ((await this.#mergeBase(expected, sha)) !== expected) return 'not_fast_forward';
      if ((await this.branchHead(branch)) !== expected) return 'moved';
      const del = await this.#req('DELETE', `/refs/branches/${refPath(branch)}`);
      if (del.status !== 204) this.#http.fail('delete branch', del.status);
    }
    const r = await this.#req('POST', '/refs/branches', { name: branch, target: { hash: sha } });
    if (r.status === 201 || r.status === 200) return 'updated';
    if (r.status === 400 || r.status === 409) return 'moved';
    this.#http.fail('create branch', r.status);
  }

  async updatePullRequest(
    pr: PullRequestRef,
    input: { readonly title: string; readonly body: string },
  ): Promise<void> {
    const r = await this.#req('PUT', `/pullrequests/${String(pr.number)}`, {
      title: input.title.slice(0, 250),
      description: input.body.slice(0, 60_000),
    });
    if (r.status !== 200) this.#http.fail('update pull request', r.status);
  }

  /** p22-conflict-resolve: a comment, then `POST pullrequests/{id}/decline`. UNVERIFIED-LIVE (fixtures only). */
  async closePullRequest(pr: PullRequestRef, comment: string): Promise<void> {
    const c = await this.#req('POST', `/pullrequests/${String(pr.number)}/comments`, {
      content: { raw: comment.slice(0, 60_000) },
    });
    if (c.status !== 201) this.#http.fail('comment on pull request', c.status);
    const r = await this.#req('POST', `/pullrequests/${String(pr.number)}/decline`);
    if (r.status !== 200) this.#http.fail('decline pull request', r.status);
  }

  /** p18-project-bootstrap: `GET …/refs/branches?pagelen=1` → no values. UNVERIFIED-LIVE (fixtures only). */
  async isEmpty(): Promise<boolean> {
    const r = await this.#req('GET', '/refs/branches?pagelen=1');
    if (r.status !== 200) this.#http.fail('list branches', r.status);
    const values = obj(r.json).values;
    return !Array.isArray(values) || values.length === 0;
  }

  async defaultBranch(): Promise<string | null> {
    const r = await this.#req('GET', '');
    if (r.status === 404) return null;
    if (r.status !== 200) this.#http.fail('read repository', r.status);
    const name = str(obj(obj(r.json).mainbranch).name);
    return isTargetBranch(name) ? name : null;
  }
}

function toCommit(o: Record<string, unknown>): CommitInfo {
  const author = obj(o.author);
  const user = obj(author.user);
  const raw = parseRawAuthor(str(author.raw));
  return {
    sha: str(o.hash),
    message: str(o.message),
    parents: arr(o.parents)
      .map((p) => str(obj(p).hash))
      .filter((p) => SHA.test(p)),
    author: {
      name: (raw.name || str(user.display_name)).slice(0, 200),
      email: raw.email.slice(0, 200),
      date: typeof o.date === 'string' ? o.date : null,
    },
  };
}

function toFile(o: Record<string, unknown>): FileChange {
  const s = str(o.status);
  const path = str(obj(o.new).path) || str(obj(o.old).path);
  const prev = str(obj(o.old).path);
  return {
    path,
    status: s === 'added' || s === 'removed' || s === 'modified' || s === 'renamed' ? s : 'other',
    additions: num(o.lines_added),
    deletions: num(o.lines_removed),
    ...(s === 'renamed' && prev !== '' ? { previousPath: prev } : {}),
  };
}
