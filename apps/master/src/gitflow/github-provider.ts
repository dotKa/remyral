import type { FetchFn, GitHubAppAuth } from './github-app.js';
import { MASTER_PERMISSIONS } from './github-app.js';
import { type ApiRateBudget, rateBudgetOf } from './github-rate.js';
import { mergeabilityFromHistory } from './hosted-common.js';
import { isAttemptBranch, isTargetBranch, MERGE_TRAILER_KEY, SHA, subjectOf, trailerValues } from './refs.js';
import {
  type BlobRead,
  type BranchProtection,
  type BranchUpdate,
  type CiCheck,
  type CiStatus,
  type CommitInfo,
  type Comparison,
  type FileChange,
  type GitProvider,
  type MergeCheck,
  type MergeInput,
  type MergeOutcome,
  type PatchText,
  ProviderError,
  type PullRequestRef,
  type RebaseOutcome,
  type TreeEntry,
  type TreeListing,
  capPatch,
  classifyBlob,
  isRepoPath,
  type OpenPullRequest,
} from './types.js';

export interface GitHubProviderOptions {
  readonly owner: string;
  readonly repo: string;
  readonly installationId: number;
  readonly auth: GitHubAppAuth;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** p22-github-rate: the rate-limit pause and reserve read this clock (tests). */
  readonly clock?: () => Date;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** Ruleset rule types that keep a token with `contents: write` from rewriting the branch on its own. */
const PROTECTING_RULES = new Set([
  'update',
  'deletion',
  'non_fast_forward',
  'pull_request',
  'required_status_checks',
]);

/** Check-run conclusions that count as passing. */
const PASSING = new Set(['success', 'neutral', 'skipped']);

/**
 * GitHub REST implementation of {@link GitProvider} (plain `fetch`, no SDK). **UNVERIFIED-LIVE**: every
 * endpoint is implemented from the REST documentation and tested against recorded fixtures
 * (`test/unit/gitflow-github.test.ts`); it has not run against a real repository yet.
 *
 * Endpoints: `GET git/ref/heads/{branch}`, `GET git/commits/{sha}`, `GET compare/{base}...{head}`,
 * `GET/POST pulls`, `GET pulls/{n}`, `PUT pulls/{n}/merge` (with `sha` = the approved head: a moved head
 * answers 409), `GET commits/{sha}/check-runs`, `GET commits/{sha}/status`, `GET commits?sha=`,
 * `DELETE git/refs/heads/{branch}`.
 */
export class GitHubProvider implements GitProvider {
  readonly kind = 'github' as const;
  readonly #o: GitHubProviderOptions;
  readonly #fetch: FetchFn;
  readonly #base: string;
  readonly #budget: ApiRateBudget;
  readonly #now: () => number;

  constructor(opts: GitHubProviderOptions) {
    this.#o = opts;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#budget = rateBudgetOf(opts.auth, opts.installationId);
    this.#now = () => (opts.clock ?? (() => new Date()))().getTime();
    this.#base = `${opts.auth.apiBaseUrl}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  }

  /** p22-github-rate: background re-checks wait while this is true (paused, or below the reserve). */
  backgroundBudgetLow(): boolean {
    return this.#budget.low(this.#now());
  }

  async #request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    // p22-github-rate: while the installation is rate limited nothing reaches GitHub (a request there would only be
    // refused again and keep the limit exhausted).
    const paused = this.#budget.pausedUntil(this.#now());
    if (paused !== null) {
      throw new ProviderError(
        `GitHub ${method} not sent: the installation's API rate limit is exhausted until ${new Date(paused).toISOString()}`,
        true,
        403,
      );
    }
    const { token } = await this.#o.auth.installationToken(
      this.#o.installationId,
      this.#o.repo,
      MASTER_PERMISSIONS,
      {
        cache: true,
      },
    );
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'remyral-gitflow',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new ProviderError(`GitHub ${method} ${path.split('?')[0] ?? ''} failed (network)`, true);
    }
    const rateLimited = this.#budget.note(res.status, res.headers, this.#now());
    if (rateLimited) {
      const until = this.#budget.pausedUntil(this.#now());
      throw new ProviderError(
        `GitHub ${method} answered HTTP ${String(res.status)}: API rate limit exhausted` +
          (until === null ? '' : `; requests paused until ${new Date(until).toISOString()}`),
        true,
        res.status,
      );
    }
    if (res.status >= 500) {
      throw new ProviderError(`GitHub ${method} answered HTTP ${String(res.status)}`, true, res.status);
    }
    const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  }

  #fail(what: string, status: number): never {
    throw new ProviderError(`GitHub ${what}: HTTP ${String(status)}`, false, status);
  }

  async branchHead(branch: string): Promise<string | null> {
    const r = await this.#request('GET', `/git/ref/heads/${refPath(branch)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#fail('read ref', r.status);
    const o = obj(obj(r.json).object);
    const sha = str(o.sha);
    // `git/ref` (singular) matches exactly; a non-commit ref is not a branch head we accept.
    if (!SHA.test(sha) || str(o.type) !== 'commit' || str(obj(r.json).ref) !== `refs/heads/${branch}`)
      return null;
    return sha;
  }

  async commit(sha: string): Promise<CommitInfo> {
    if (!SHA.test(sha)) throw new ProviderError('invalid sha', false);
    const r = await this.#request('GET', `/git/commits/${sha}`);
    if (r.status !== 200) this.#fail('read commit', r.status);
    return toCommit(obj(r.json));
  }

  async patch(base: string, head: string, maxBytes: number): Promise<PatchText> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    const r = await this.#request('GET', `/compare/${base}...${head}?per_page=100`);
    if (r.status !== 200) this.#fail('compare', r.status);
    let out = '';
    let omitted = false;
    for (const f of arr(obj(r.json).files)) {
      const o = obj(f);
      const path = str(o.filename);
      const prev = str(o.previous_filename) || path;
      const patch = str(o.patch);
      out += `diff --git a/${prev} b/${path}\n--- a/${prev}\n+++ b/${path}\n`;
      if (patch === '') {
        // GitHub leaves out binary and very large patches.
        omitted = true;
        out += '(patch not available from the provider)\n';
      } else {
        out += patch.endsWith('\n') ? patch : `${patch}\n`;
      }
    }
    return capPatch(out, maxBytes, omitted);
  }

  async compare(base: string, head: string): Promise<Comparison> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    const r = await this.#request('GET', `/compare/${base}...${head}?per_page=100`);
    if (r.status !== 200) this.#fail('compare', r.status);
    const j = obj(r.json);
    const status = str(j.status);
    const commits = arr(j.commits).map((c) => {
      const o = obj(c);
      return toCommit({ ...obj(o.commit), sha: o.sha, parents: o.parents });
    });
    const files: FileChange[] = arr(j.files).map((f) => {
      const o = obj(f);
      const s = str(o.status);
      const prev = str(o.previous_filename);
      return {
        path: str(o.filename),
        status:
          s === 'added' || s === 'modified' || s === 'removed' || s === 'renamed'
            ? s
            : s === 'changed'
              ? 'modified'
              : 'other',
        additions: num(o.additions),
        deletions: num(o.deletions),
        ...(prev === '' ? {} : { previousPath: prev }),
      };
    });
    const total = num(j.total_commits);
    return {
      status: status === 'ahead' || status === 'identical' || status === 'behind' ? status : 'diverged',
      mergeBase: str(obj(j.merge_base_commit).sha),
      commits,
      files: files.slice(0, 300),
      truncated: total > commits.length || files.length >= 300,
    };
  }

  async #pull(n: number): Promise<Json> {
    const r = await this.#request('GET', `/pulls/${String(n)}`);
    if (r.status !== 200) this.#fail('read pull request', r.status);
    return obj(r.json);
  }

  async testMerge(input: {
    readonly targetBranch: string;
    readonly headSha: string;
    readonly headBranch: string;
    readonly baseAtStart: string;
    readonly pullRequest: PullRequestRef | null;
  }): Promise<MergeCheck> {
    const base = await this.branchHead(input.targetBranch);
    if (base === null) {
      return {
        state: 'base_moved',
        baseSha: input.baseAtStart,
        headSha: input.headSha,
        reason: `target branch ${input.targetBranch} does not exist on the remote`,
      };
    }
    const history = await this.compare(input.baseAtStart, base);
    if (history.status !== 'ahead' && history.status !== 'identical') {
      return {
        state: 'base_moved',
        baseSha: base,
        headSha: input.headSha,
        reason: `${input.targetBranch} was rewritten: the base at job start is no longer in its history`,
      };
    }
    // p22-output-delivery §1: without a pull request, or while GitHub still computes `mergeable` (null right after
    // the PR was opened or the base moved), the history decides what it can (fast-forward, disjoint paths).
    if (input.pullRequest === null) return mergeabilityFromHistory(this, base, input.headSha);
    const pr = await this.#pull(input.pullRequest.number);
    if (pr.merged === true) return { state: 'clean', baseSha: base, headSha: input.headSha };
    if (str(obj(pr.head).sha) !== input.headSha || pr.mergeable === null || pr.mergeable === undefined) {
      return mergeabilityFromHistory(this, base, input.headSha);
    }
    if (pr.mergeable === true) return { state: 'clean', baseSha: base, headSha: input.headSha };
    // GitHub only says "not mergeable": the conflicting files are approximated as the files changed on both
    // sides since the merge base (a superset of the real conflicts), with both sides' commits.
    const ours = await this.compare(base, input.headSha);
    const theirs = await this.compare(input.headSha, base);
    const theirFiles = new Set(theirs.files.map((f) => f.path));
    const files = ours.files.map((f) => f.path).filter((p) => theirFiles.has(p));
    return {
      state: 'conflicts',
      baseSha: base,
      headSha: input.headSha,
      files,
      headCommits: ours.commits.slice(-50).map((c) => ({ sha: c.sha, subject: subjectOf(c.message) })),
      baseCommits: theirs.commits.slice(-50).map((c) => ({ sha: c.sha, subject: subjectOf(c.message) })),
      precision: 'approximate',
    };
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
        state: 'open',
        head: `${this.#o.owner}:${input.headBranch}`,
        base: input.targetBranch,
        per_page: '5',
      });
      const r = await this.#request('GET', `/pulls?${q.toString()}`);
      if (r.status !== 200) this.#fail('list pull requests', r.status);
      const first = obj(arr(r.json)[0]);
      const n = num(first.number);
      return n > 0 ? { number: n, url: str(first.html_url) } : null;
    };
    const existing = await find();
    if (existing !== null) return existing;
    const r = await this.#request('POST', '/pulls', {
      title: input.title.slice(0, 250),
      head: input.headBranch,
      base: input.targetBranch,
      body: input.body.slice(0, 60_000),
      draft: input.draft === true,
      maintainer_can_modify: false,
    });
    if (r.status === 201) {
      const j = obj(r.json);
      return { number: num(j.number), url: str(j.html_url) };
    }
    // 422 "A pull request already exists" (concurrent creator): read it back.
    if (r.status === 422) {
      const again = await find();
      if (again !== null) return again;
    }
    this.#fail('create pull request', r.status);
  }

  /**
   * p18-leftovers: `GET pulls?state=open&sort=updated&direction=desc` (GitHub REST "List pull requests"). A fork's head
   * is compared by its sha (the base repository has it as `refs/pull/<n>/head`). UNVERIFIED-LIVE (fixtures only).
   */
  async openPullRequests(limit: number): Promise<readonly OpenPullRequest[]> {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const q = new URLSearchParams({ state: 'open', sort: 'updated', direction: 'desc', per_page: String(n) });
    const r = await this.#request('GET', `/pulls?${q.toString()}`);
    if (r.status !== 200) this.#fail('list pull requests', r.status);
    const own = `${this.#o.owner}/${this.#o.repo}`.toLowerCase();
    return arr(r.json)
      .slice(0, n)
      .map((x) => {
        const o = obj(x);
        const head = obj(o.head);
        const sha = str(head.sha);
        return {
          number: num(o.number),
          title: str(o.title).slice(0, 300),
          url: str(o.html_url),
          author: str(obj(o.user).login) || null,
          draft: o.draft === true,
          baseBranch: str(obj(o.base).ref),
          headBranch: str(head.ref),
          headSha: SHA.test(sha) ? sha : null,
          sameRepository: str(obj(head.repo).full_name).toLowerCase() === own,
          updatedAt: str(o.updated_at) || null,
        };
      })
      .filter((p) => p.number > 0 && p.baseBranch !== '');
  }

  async issueComment(
    number: number,
    body: string,
    marker: string,
  ): Promise<{ readonly id: number; readonly url: string; readonly created: boolean }> {
    if (!Number.isInteger(number) || number < 1) throw new ProviderError('invalid issue number', false);
    // The first 300 comments are searched for the marker (a replay follows the first attempt within minutes).
    for (let page = 1; page <= 3; page++) {
      const r = await this.#request(
        'GET',
        `/issues/${String(number)}/comments?per_page=100&page=${String(page)}`,
      );
      if (r.status !== 200) this.#fail('list comments', r.status);
      const list = arr(r.json);
      const hit = list.map(obj).find((c) => str(c.body).includes(marker));
      if (hit !== undefined) return { id: num(hit.id), url: str(hit.html_url), created: false };
      if (list.length < 100) break;
    }
    const r = await this.#request('POST', `/issues/${String(number)}/comments`, {
      body: `${body.slice(0, 60_000)}\n\n${marker}`,
    });
    if (r.status !== 201) this.#fail('create comment', r.status);
    const j = obj(r.json);
    return { id: num(j.id), url: str(j.html_url), created: true };
  }

  async checks(sha: string): Promise<CiStatus> {
    if (!SHA.test(sha)) throw new ProviderError('invalid sha', false);
    const runs = await this.#request('GET', `/commits/${sha}/check-runs?per_page=100`);
    if (runs.status !== 200) {
      return { state: 'unavailable', checks: [] };
    }
    const checks: CiCheck[] = arr(obj(runs.json).check_runs).map((c) => {
      const o = obj(c);
      const status = str(o.status);
      return {
        name: str(o.name).slice(0, 200),
        status:
          status === 'queued' || status === 'in_progress' || status === 'completed' ? status : 'pending',
        conclusion: typeof o.conclusion === 'string' ? o.conclusion : null,
        url: typeof o.html_url === 'string' ? o.html_url : null,
      };
    });
    // Legacy commit statuses need the "Commit statuses: read" permission; without it (403/404) they are
    // simply not seen, which can only make the result stricter (fewer passing signals).
    const st = await this.#request('GET', `/commits/${sha}/status`);
    if (st.status === 200) {
      for (const s of arr(obj(st.json).statuses)) {
        const o = obj(s);
        const state = str(o.state);
        checks.push({
          name: str(o.context).slice(0, 200),
          status: state === 'pending' ? 'pending' : 'completed',
          conclusion: state === 'pending' ? null : state === 'success' ? 'success' : 'failure',
          url: typeof o.target_url === 'string' ? o.target_url : null,
        });
      }
    }
    return { state: ciState(checks), checks };
  }

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
    const r = await this.#request('PUT', `/pulls/${String(input.pullRequest.number)}/merge`, {
      sha: input.headSha,
      merge_method: input.method,
      commit_title: input.title.slice(0, 250),
      commit_message: input.message.slice(0, 60_000),
    });
    const message = str(obj(r.json).message).slice(0, 300);
    switch (r.status) {
      case 200: {
        const sha = str(obj(r.json).sha);
        if (obj(r.json).merged !== true || !SHA.test(sha)) {
          return { merged: false, reason: 'rejected', detail: message || 'GitHub did not merge' };
        }
        return { merged: true, sha };
      }
      case 405:
        return { merged: false, reason: 'not_mergeable', detail: message || 'pull request is not mergeable' };
      case 409:
        return { merged: false, reason: 'head_moved', detail: message || 'head branch was modified' };
      case 403:
        return { merged: false, reason: 'forbidden', detail: message || 'forbidden (branch protection?)' };
      default:
        return { merged: false, reason: 'rejected', detail: `HTTP ${String(r.status)} ${message}`.trim() };
    }
  }

  async findMerge(targetBranch: string, mergeRequestId: string): Promise<string | null> {
    const q = new URLSearchParams({ sha: targetBranch, per_page: '20' });
    const r = await this.#request('GET', `/commits?${q.toString()}`);
    if (r.status !== 200) this.#fail('list commits', r.status);
    for (const c of arr(r.json)) {
      const o = obj(c);
      if (trailerValues(str(obj(o.commit).message), MERGE_TRAILER_KEY).includes(mergeRequestId)) {
        const sha = str(o.sha);
        return SHA.test(sha) ? sha : null;
      }
    }
    return null;
  }

  /**
   * p5-github-connect: classic protection (`GET branches/{b}` → `protected`) or ruleset rules that apply to the
   * branch (`GET rules/branches/{b}`). A rule that restricts updates, deletions, force pushes or requires a PR
   * or checks counts as protection.
   */
  async branchProtection(branch: string): Promise<BranchProtection> {
    const b = await this.#request('GET', `/branches/${refPath(branch)}`);
    if (b.status === 404) return { state: 'missing', classic: false, rules: [] };
    if (b.status !== 200) return { state: 'unknown', classic: false, rules: [] };
    const classic = obj(b.json).protected === true;
    const r = await this.#request('GET', `/rules/branches/${refPath(branch)}?per_page=100`);
    const rules =
      r.status === 200
        ? [...new Set(arr(r.json).map((x) => str(obj(x).type)))].filter((t) => /^[a-z_]{1,64}$/.test(t))
        : [];
    const guarding = rules.some((t) => PROTECTING_RULES.has(t));
    if (classic || guarding) return { state: 'protected', classic, rules };
    return { state: r.status === 200 ? 'unprotected' : 'unknown', classic, rules };
  }

  /**
   * p11-merge-pipeline: `POST git/refs` (create; 422 when it exists) or `PATCH git/refs/heads/{b}` with `force: false`
   * (fast-forward only; 422 otherwise) after re-reading the current value (GitHub has no compare-and-swap on refs — the
   * fast-forward rule is what keeps the update from discarding work).
   */
  async updateBranch(branch: string, sha: string, expected: string | null): Promise<BranchUpdate> {
    if (!SHA.test(sha) || (expected !== null && !SHA.test(expected))) {
      throw new ProviderError('invalid sha', false);
    }
    const head = await this.branchHead(branch);
    if (head === sha) return 'updated';
    if (head !== expected) return 'moved';
    if (expected === null) {
      const r = await this.#request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
      if (r.status === 201) return 'updated';
      if (r.status === 422) return 'moved';
      this.#fail('create ref', r.status);
    }
    const r = await this.#request('PATCH', `/git/refs/heads/${refPath(branch)}`, { sha, force: false });
    if (r.status === 200) return 'updated';
    if (r.status === 422 || r.status === 409) return 'not_fast_forward';
    this.#fail('update ref', r.status);
  }

  /** p11-merge-pipeline: `PATCH pulls/{n}` with the generated title and description. */
  async updatePullRequest(
    pr: PullRequestRef,
    input: { readonly title: string; readonly body: string },
  ): Promise<void> {
    const r = await this.#request('PATCH', `/pulls/${String(pr.number)}`, {
      title: input.title.slice(0, 250),
      body: input.body.slice(0, 60_000),
    });
    if (r.status !== 200) this.#fail('update pull request', r.status);
  }

  /**
   * p22-conflict-resolve: `POST issues/{n}/comments` then `PATCH pulls/{n}` `state: closed` (a closed pull request
   * answers 200 again). UNVERIFIED-LIVE (fixtures only).
   */
  async closePullRequest(pr: PullRequestRef, comment: string): Promise<void> {
    const c = await this.#request('POST', `/issues/${String(pr.number)}/comments`, {
      body: comment.slice(0, 60_000),
    });
    if (c.status !== 201) this.#fail('comment on pull request', c.status);
    const r = await this.#request('PATCH', `/pulls/${String(pr.number)}`, { state: 'closed' });
    if (r.status !== 200) this.#fail('close pull request', r.status);
  }

  /**
   * p18-project-bootstrap: `GET /repos/{o}/{r}/branches?per_page=1` → an empty list for an empty repository (the git
   * database endpoints answer 409 "Git Repository is empty" there instead). UNVERIFIED-LIVE (fixtures only).
   */
  async isEmpty(): Promise<boolean> {
    const r = await this.#request('GET', '/branches?per_page=1');
    if (r.status === 409) return true;
    if (r.status !== 200) this.#fail('list branches', r.status);
    return arr(r.json).length === 0;
  }

  /** p15-auto-mode: `GET /repos/{o}/{r}` → `default_branch`. UNVERIFIED-LIVE (fixtures only). */
  async defaultBranch(): Promise<string | null> {
    const r = await this.#request('GET', '');
    if (r.status === 404) return null;
    if (r.status !== 200) this.#fail('read repository', r.status);
    const name = str(obj(r.json).default_branch);
    return isTargetBranch(name) ? name : null;
  }

  /**
   * p15-auto-mode: the merge result of head into `onto` on a temporary branch (`POST merges`; 409 = conflicts), its tree
   * as one commit on `onto` with the head commit's message and author (`POST git/commits`), then `PATCH git/refs`
   * (forced: the attempt branch is rewritten) after re-reading that it is still at `headSha` (GitHub has no
   * compare-and-swap on refs; residual race documented). The temporary branch is deleted in every case.
   * UNVERIFIED-LIVE (fixtures only).
   */
  async rebaseOnto(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly onto: string;
  }): Promise<RebaseOutcome> {
    if (!isAttemptBranch(input.branch)) throw new ProviderError('only attempt branches are rebased', false);
    if (!SHA.test(input.headSha) || !SHA.test(input.onto)) throw new ProviderError('invalid sha', false);
    if ((await this.branchHead(input.branch)) !== input.headSha)
      return { state: 'moved', detail: `${input.branch} moved` };
    const tmp = `remyral-rebase/${input.headSha.slice(0, 12)}-${Date.now().toString(36)}`;
    const created = await this.#request('POST', '/git/refs', { ref: `refs/heads/${tmp}`, sha: input.onto });
    if (created.status !== 201) this.#fail('create temporary ref', created.status);
    try {
      const merged = await this.#request('POST', '/merges', {
        base: tmp,
        head: input.headSha,
        commit_message: 'remyral: rebase preview',
      });
      if (merged.status === 409) return { state: 'conflicts', files: [] };
      if (merged.status === 204) return { state: 'rebased', sha: input.headSha };
      if (merged.status !== 201) this.#fail('merge preview', merged.status);
      const tree = str(obj(obj(obj(merged.json).commit).tree).sha);
      if (!SHA.test(tree)) throw new ProviderError('merge preview returned no tree', false);
      const original = await this.commit(input.headSha);
      const commit = await this.#request('POST', '/git/commits', {
        message: original.message,
        tree,
        parents: [input.onto],
        ...(original.author.name === ''
          ? {}
          : {
              author: {
                name: original.author.name,
                email: original.author.email,
                ...(original.author.date === null ? {} : { date: original.author.date }),
              },
            }),
      });
      if (commit.status !== 201) this.#fail('create commit', commit.status);
      const sha = str(obj(commit.json).sha);
      if (!SHA.test(sha)) throw new ProviderError('create commit returned no sha', false);
      if ((await this.branchHead(input.branch)) !== input.headSha)
        return { state: 'moved', detail: `${input.branch} moved` };
      const moved = await this.#request('PATCH', `/git/refs/heads/${refPath(input.branch)}`, {
        sha,
        force: true,
      });
      if (moved.status !== 200) this.#fail('update attempt ref', moved.status);
      return { state: 'rebased', sha };
    } finally {
      await this.#request('DELETE', `/git/refs/heads/${refPath(tmp)}`).catch(() => undefined);
    }
  }

  /**
   * p15-workspace-retention: `POST git/blobs` (base64) per file, `POST git/trees` with `base_tree` = the parent's tree
   * (other paths unchanged), `POST git/commits` (Context7 `/websites/github_en_rest`, 2026-10-22). No ref is moved.
   */
  async commitFiles(input: {
    readonly parent: string | null;
    readonly files: readonly { readonly path: string; readonly content: Buffer }[];
    readonly message: string;
    readonly author?: { readonly name: string; readonly email: string };
  }): Promise<string> {
    if (input.parent !== null && !SHA.test(input.parent)) throw new ProviderError('invalid sha', false);
    let baseTree: string | null = null;
    if (input.parent !== null) {
      const c = await this.#request('GET', `/git/commits/${input.parent}`);
      if (c.status !== 200) this.#fail('read commit', c.status);
      baseTree = str(obj(obj(c.json).tree).sha);
      if (!SHA.test(baseTree)) throw new ProviderError('GitHub returned no tree for the parent', false);
    }
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
    for (const f of input.files) {
      const b = await this.#request('POST', '/git/blobs', {
        content: f.content.toString('base64'),
        encoding: 'base64',
      });
      if (b.status !== 201) this.#fail('create blob', b.status);
      const sha = str(obj(b.json).sha);
      if (!SHA.test(sha)) throw new ProviderError('GitHub returned no blob sha', false);
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha });
    }
    const t = await this.#request('POST', '/git/trees', {
      ...(baseTree === null ? {} : { base_tree: baseTree }),
      tree,
    });
    if (t.status !== 201) this.#fail('create tree', t.status);
    const treeSha = str(obj(t.json).sha);
    if (!SHA.test(treeSha)) throw new ProviderError('GitHub returned no tree sha', false);
    const commit = await this.#request('POST', '/git/commits', {
      message: input.message,
      tree: treeSha,
      parents: input.parent === null ? [] : [input.parent],
      ...(input.author === undefined
        ? {}
        : { author: { name: input.author.name, email: input.author.email } }),
    });
    if (commit.status !== 201) this.#fail('create commit', commit.status);
    const sha = str(obj(commit.json).sha);
    if (!SHA.test(sha)) throw new ProviderError('GitHub returned no commit sha', false);
    return sha;
  }

  /**
   * p19-ide W1: `GET contents/{path}?ref={sha}` (Context7 `/websites/github_en_rest`, 2026-10-28): an array for a
   * directory (at most 1 000 entries), an object for a file. UNVERIFIED-LIVE (fixtures only).
   */
  async tree(sha: string, path: string): Promise<TreeListing | null> {
    if (!SHA.test(sha) || !isRepoPath(path, true)) throw new ProviderError('invalid sha or path', false);
    const r = await this.#request('GET', `/contents/${contentPath(path)}?ref=${sha}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#fail('read directory', r.status);
    if (!Array.isArray(r.json)) return null;
    const entries: TreeEntry[] = [];
    for (const e of arr(r.json)) {
      const o = obj(e);
      const name = str(o.name);
      const full = str(o.path);
      const type = str(o.type);
      if (name === '' || !isRepoPath(full)) continue;
      entries.push({
        name,
        path: full,
        kind:
          type === 'dir'
            ? 'dir'
            : type === 'symlink'
              ? 'symlink'
              : type === 'submodule'
                ? 'submodule'
                : 'file',
        size: type === 'file' ? num(o.size) : null,
      });
    }
    return { entries, truncated: entries.length >= 1000 };
  }

  /**
   * p19-ide W1: `GET contents/{path}?ref={sha}` — base64 content for files ≤ 1 MB; above that GitHub sends no content
   * (`encoding: none`) and the file is `too_large` here. UNVERIFIED-LIVE (fixtures only).
   */
  async blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    if (!SHA.test(sha) || !isRepoPath(path)) throw new ProviderError('invalid sha or path', false);
    const r = await this.#request('GET', `/contents/${contentPath(path)}?ref=${sha}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#fail('read file', r.status);
    if (Array.isArray(r.json)) return null;
    const o = obj(r.json);
    if (str(o.type) !== 'file') return null;
    const size = num(o.size);
    if (size > maxBytes || str(o.encoding) !== 'base64') return { state: 'too_large', size };
    return classifyBlob(Buffer.from(str(o.content), 'base64'), size, maxBytes);
  }

  async deleteBranch(branch: string, expectedSha: string): Promise<'deleted' | 'moved' | 'absent'> {
    // GitHub's ref deletion has no compare-and-swap: re-check right before (residual TOCTOU documented).
    const head = await this.branchHead(branch);
    if (head === null) return 'absent';
    if (head !== expectedSha) return 'moved';
    const r = await this.#request('DELETE', `/git/refs/heads/${refPath(branch)}`);
    if (r.status === 204) return 'deleted';
    if (r.status === 422 || r.status === 404) return 'absent';
    this.#fail('delete ref', r.status);
  }
}

/** A repository path for `contents/{path}` (each segment encoded; "" = the root). */
function contentPath(path: string): string {
  return path === '' ? '' : path.split('/').map(encodeURIComponent).join('/');
}

function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function toCommit(o: Json): CommitInfo {
  const author = obj(o.author);
  return {
    sha: str(o.sha),
    message: str(o.message),
    parents: arr(o.parents)
      .map((p) => str(obj(p).sha))
      .filter((p) => SHA.test(p)),
    author: {
      name: str(author.name).slice(0, 200),
      email: str(author.email).slice(0, 200),
      date: typeof author.date === 'string' ? author.date : null,
    },
  };
}

/** Failure wins; then anything unfinished; success needs at least one signal. */
export function ciState(checks: readonly CiCheck[]): CiStatus['state'] {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.status === 'completed' && c.conclusion !== null && !PASSING.has(c.conclusion))) {
    return 'failure';
  }
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return 'success';
}
