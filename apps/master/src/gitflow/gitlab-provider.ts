import type { ApiRateBudget } from './github-rate.js';
import type { FetchFn } from './github-app.js';
import { arr, countDiffLines, HostedHttp, num, obj, sleep, str } from './hosted-http.js';
import {
  comparisonStatus,
  conflictsBetween,
  hostedCiState,
  mergeabilityFromHistory,
  targetStillContainsBase,
} from './hosted-common.js';
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
  classifyBlob,
  isRepoPath,
  type OpenPullRequest,
} from './types.js';

export interface GitLabProviderOptions {
  /** Instance URL (`https://gitlab.com`, `https://git.example.com/gitlab`), no `/api/v4`. */
  readonly baseUrl: string;
  /** `group[/sub…]/project`. */
  readonly projectPath: string;
  readonly token: () => Promise<string>;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** p22-harness-gaps: the connection's rate budget. */
  readonly budget?: ApiRateBudget;
  /** Waits between merge status reads (tests: 0). */
  readonly pollMs?: number;
}

/** detailed_merge_status values that mean "GitLab has not decided yet". */
const UNDECIDED = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing']);

/** Commit status → check (GitLab CI jobs and external statuses use the same states). */
function toCheck(o: Record<string, unknown>): CiCheck {
  const s = str(o.status);
  const url = typeof o.target_url === 'string' ? o.target_url : null;
  const name = str(o.name).slice(0, 200);
  switch (s) {
    case 'success':
      return { name, status: 'completed', conclusion: 'success', url };
    case 'failed':
      // An allowed failure does not fail the pipeline.
      return { name, status: 'completed', conclusion: o.allow_failure === true ? 'neutral' : 'failure', url };
    case 'canceled':
      return { name, status: 'completed', conclusion: 'cancelled', url };
    case 'skipped':
      return { name, status: 'completed', conclusion: 'skipped', url };
    case 'manual':
      // A manual job waits for a person; it never blocks the pipeline's result on its own.
      return { name, status: 'completed', conclusion: 'neutral', url };
    case 'running':
      return { name, status: 'in_progress', conclusion: null, url };
    case 'created':
    case 'pending':
    case 'scheduled':
    case 'waiting_for_resource':
      return { name, status: 'queued', conclusion: null, url };
    default:
      return { name, status: 'pending', conclusion: null, url };
  }
}

/**
 * GitLab REST v4 implementation of {@link GitProvider} (docs/design/p16-git-providers.md §3; endpoints verified with
 * Context7 `/websites/gitlab_19_3`, 2026-10-23). **UNVERIFIED-LIVE**: tested against a local fake GitLab backed by a
 * real bare repository, not yet against gitlab.com.
 *
 * Endpoints (under `/projects/:path`): `GET repository/branches/:b`, `POST/DELETE repository/branches`,
 * `GET repository/commits/:sha`, `GET repository/commits?ref_name=`, `GET repository/merge_base?refs[]=`,
 * `GET repository/compare?from=&to=`, `GET repository/commits/:sha/statuses`, `GET/POST/PUT merge_requests`,
 * `PUT merge_requests/:iid/merge` (with `sha` = the approved head: a moved head answers 409),
 * `GET/POST merge_requests/:iid/notes`, `GET /projects/:path` (default branch).
 */
export class GitLabProvider implements GitProvider {
  readonly kind = 'gitlab' as const;
  readonly #http: HostedHttp;
  readonly #o: GitLabProviderOptions;

  constructor(opts: GitLabProviderOptions) {
    this.#o = opts;
    this.#http = new HostedHttp({
      name: 'GitLab',
      apiRoot: `${opts.baseUrl.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(opts.projectPath)}`,
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
    const r = await this.#req('GET', `/repository/branches/${encodeURIComponent(branch)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#http.fail('read branch', r.status);
    const j = obj(r.json);
    const sha = str(obj(j.commit).id);
    if (str(j.name) !== branch || !SHA.test(sha)) return null;
    return sha;
  }

  async commit(sha: string): Promise<CommitInfo> {
    if (!SHA.test(sha)) throw new ProviderError('invalid sha', false);
    const r = await this.#req('GET', `/repository/commits/${sha}`);
    if (r.status !== 200) this.#http.fail('read commit', r.status);
    return toCommit(obj(r.json));
  }

  async #mergeBase(a: string, b: string): Promise<string> {
    const q = new URLSearchParams();
    q.append('refs[]', a);
    q.append('refs[]', b);
    const r = await this.#req('GET', `/repository/merge_base?${q.toString()}`);
    if (r.status !== 200) this.#http.fail('merge base', r.status);
    const id = str(obj(r.json).id);
    if (!SHA.test(id)) throw new ProviderError('GitLab returned no merge base', false);
    return id;
  }

  async #compareRaw(base: string, head: string): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ from: base, to: head, straight: 'false' });
    const r = await this.#req('GET', `/repository/compare?${q.toString()}`);
    if (r.status !== 200) this.#http.fail('compare', r.status);
    return obj(r.json);
  }

  async compare(base: string, head: string): Promise<Comparison> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    const mergeBase = base === head ? base : await this.#mergeBase(base, head);
    const status = comparisonStatus(base, head, mergeBase);
    if (status === 'identical' || status === 'behind') {
      return { status, mergeBase, commits: [], files: [], truncated: false };
    }
    const j = await this.#compareRaw(base, head);
    let commits = arr(j.commits).map((c) => toCommit(obj(c)));
    // Oldest first (the GitHub order); GitLab's order is normalised by where the head commit is.
    if (commits.length > 1 && commits[0]?.sha === head) commits = commits.reverse();
    let partial = j.compare_timeout === true;
    const files: FileChange[] = arr(j.diffs).map((d) => {
      const o = obj(d);
      if (o.too_large === true || o.collapsed === true) partial = true;
      const path = str(o.new_path);
      const prev = str(o.old_path);
      const counts = countDiffLines(str(o.diff));
      return {
        path,
        status:
          o.new_file === true
            ? 'added'
            : o.deleted_file === true
              ? 'removed'
              : o.renamed_file === true
                ? 'renamed'
                : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        ...(o.renamed_file === true && prev !== '' ? { previousPath: prev } : {}),
      };
    });
    return {
      status,
      mergeBase,
      commits: commits.slice(-250),
      files: files.slice(0, 300),
      truncated: partial || commits.length > 250 || files.length > 300,
    };
  }

  async patch(base: string, head: string, maxBytes: number): Promise<PatchText> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    const j = await this.#compareRaw(base, head);
    let out = '';
    let omitted = j.compare_timeout === true;
    for (const d of arr(j.diffs)) {
      const o = obj(d);
      const path = str(o.new_path);
      const prev = str(o.old_path) || path;
      out += `diff --git a/${prev} b/${path}\n--- a/${prev}\n+++ b/${path}\n`;
      const diff = str(o.diff);
      if (diff === '' || o.too_large === true || o.collapsed === true) {
        omitted = true;
        out += '(patch not available from the provider)\n';
      } else {
        out += diff.endsWith('\n') ? diff : `${diff}\n`;
      }
    }
    return capPatch(out, maxBytes, omitted);
  }

  async #mr(iid: number): Promise<Record<string, unknown>> {
    const r = await this.#req('GET', `/merge_requests/${String(iid)}`);
    if (r.status !== 200) this.#http.fail('read merge request', r.status);
    return obj(r.json);
  }

  /**
   * GitLab's own mergeability (`detailed_merge_status`): `mergeable` = clean, `conflict` (or `has_conflicts`) =
   * conflicts with the files approximated (GitLab does not list them on this endpoint), `checking` / `unchecked` /
   * `preparing` = ask again. Policy states (CI must pass, approvals, drafts, discussions) are not git conflicts: the
   * merge itself reports them.
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
    const mr = await this.#mr(input.pullRequest.number);
    if (str(mr.state) === 'merged') return { state: 'clean', baseSha: base, headSha: input.headSha };
    const detailed = str(mr.detailed_merge_status);
    if (str(mr.sha) !== input.headSha || UNDECIDED.has(detailed) || detailed === '') {
      return mergeabilityFromHistory(this, base, input.headSha);
    }
    if (detailed === 'conflict' || mr.has_conflicts === true) {
      return conflictsBetween(this, base, input.headSha, null);
    }
    return { state: 'clean', baseSha: base, headSha: input.headSha };
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
        state: 'opened',
        source_branch: input.headBranch,
        target_branch: input.targetBranch,
        per_page: '5',
      });
      const r = await this.#req('GET', `/merge_requests?${q.toString()}`);
      if (r.status !== 200) this.#http.fail('list merge requests', r.status);
      const first = obj(arr(r.json)[0]);
      const iid = num(first.iid);
      return iid > 0 ? { number: iid, url: str(first.web_url) } : null;
    };
    const existing = await find();
    if (existing !== null) return existing;
    const title = input.title.slice(0, 250);
    const r = await this.#req('POST', '/merge_requests', {
      source_branch: input.headBranch,
      target_branch: input.targetBranch,
      // GitLab marks a draft by its title prefix.
      title: input.draft === true ? `Draft: ${title}` : title,
      description: input.body.slice(0, 60_000),
      remove_source_branch: false,
    });
    if (r.status === 201 || r.status === 200) {
      const j = obj(r.json);
      return { number: num(j.iid), url: str(j.web_url) };
    }
    // 409 "Another open merge request already exists for this source branch" (a concurrent creator).
    if (r.status === 409 || r.status === 422) {
      const again = await find();
      if (again !== null) return again;
    }
    this.#http.fail('create merge request', r.status);
  }

  /**
   * p18-leftovers: `GET merge_requests?state=opened&order_by=updated_at&sort=desc` (GitLab "List project merge requests";
   * fields iid, title, web_url, draft, author.username, source_branch, target_branch, sha, source_project_id,
   * target_project_id, updated_at — Context7 /websites/gitlab). UNVERIFIED-LIVE (fixtures only).
   */
  async openPullRequests(limit: number): Promise<readonly OpenPullRequest[]> {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const q = new URLSearchParams({
      state: 'opened',
      order_by: 'updated_at',
      sort: 'desc',
      per_page: String(n),
    });
    const r = await this.#req('GET', `/merge_requests?${q.toString()}`);
    if (r.status !== 200) this.#http.fail('list merge requests', r.status);
    return arr(r.json)
      .slice(0, n)
      .map((x) => {
        const o = obj(x);
        const sha = str(o.sha);
        return {
          number: num(o.iid),
          title: str(o.title).slice(0, 300),
          url: str(o.web_url),
          author: str(obj(o.author).username) || null,
          draft: o.draft === true || o.work_in_progress === true,
          baseBranch: str(o.target_branch),
          headBranch: str(o.source_branch),
          headSha: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
          sameRepository: num(o.source_project_id) === num(o.target_project_id),
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
    if (!Number.isInteger(number) || number < 1) throw new ProviderError('invalid merge request', false);
    for (let page = 1; page <= 3; page++) {
      const r = await this.#req(
        'GET',
        `/merge_requests/${String(number)}/notes?per_page=100&page=${String(page)}&sort=asc`,
      );
      if (r.status !== 200) this.#http.fail('list notes', r.status);
      const list = arr(r.json);
      const hit = list.map(obj).find((c) => str(c.body).includes(marker));
      if (hit !== undefined) return { id: num(hit.id), url: '', created: false };
      if (list.length < 100) break;
    }
    const r = await this.#req('POST', `/merge_requests/${String(number)}/notes`, {
      body: `${body.slice(0, 60_000)}\n\n${marker}`,
    });
    if (r.status !== 201 && r.status !== 200) this.#http.fail('create note', r.status);
    return { id: num(obj(r.json).id), url: '', created: true };
  }

  async checks(sha: string): Promise<CiStatus> {
    if (!SHA.test(sha)) throw new ProviderError('invalid sha', false);
    const r = await this.#req('GET', `/repository/commits/${sha}/statuses?per_page=100`);
    if (r.status !== 200) return { state: 'unavailable', checks: [] };
    const checks = arr(r.json).map((s) => toCheck(obj(s)));
    return { state: hostedCiState(checks), checks };
  }

  async merge(input: MergeInput): Promise<MergeOutcome> {
    if (input.pullRequest === null) {
      return { merged: false, reason: 'rejected', detail: 'no merge request for the attempt branch' };
    }
    const head = await this.branchHead(input.headBranch);
    if (head !== input.headSha) {
      return {
        merged: false,
        reason: 'head_moved',
        detail: `${input.headBranch} is at ${head ?? '(deleted)'}, approval was for ${input.headSha}`,
      };
    }
    const message = `${input.title.slice(0, 250)}\n\n${input.message}`.slice(0, 60_000);
    const iid = input.pullRequest.number;
    const r = await this.#req('PUT', `/merge_requests/${String(iid)}/merge`, {
      sha: input.headSha,
      squash: input.method === 'squash',
      merge_commit_message: message,
      squash_commit_message: message,
      should_remove_source_branch: false,
    });
    const detail = str(obj(r.json).message).slice(0, 300);
    switch (r.status) {
      case 200:
        return this.#mergedSha(iid, obj(r.json), input.targetBranch);
      case 405:
      case 422:
        return {
          merged: false,
          reason: 'not_mergeable',
          detail: detail || 'merge request cannot be merged',
        };
      case 409:
        return { merged: false, reason: 'head_moved', detail: detail || 'SHA does not match HEAD of source' };
      case 401:
      case 403:
        return { merged: false, reason: 'forbidden', detail: detail || 'forbidden (protected branch?)' };
      default:
        return { merged: false, reason: 'rejected', detail: `HTTP ${String(r.status)} ${detail}`.trim() };
    }
  }

  /** The merge commit (squash commit; the target head for a fast-forward project), waiting a little for GitLab. */
  async #mergedSha(iid: number, first: Record<string, unknown>, target: string): Promise<MergeOutcome> {
    let mr = first;
    for (let i = 0; i < 5 && str(mr.state) !== 'merged'; i++) {
      await sleep(this.#o.pollMs ?? 1000);
      mr = await this.#mr(iid);
    }
    if (str(mr.state) !== 'merged') {
      return {
        merged: false,
        reason: 'rejected',
        detail: 'GitLab accepted the merge but has not finished it yet',
      };
    }
    const sha =
      str(mr.merge_commit_sha) || str(mr.squash_commit_sha) || ((await this.branchHead(target)) ?? '');
    if (!SHA.test(sha))
      return { merged: false, reason: 'rejected', detail: 'GitLab returned no merge commit' };
    return { merged: true, sha };
  }

  async findMerge(targetBranch: string, mergeRequestId: string): Promise<string | null> {
    const q = new URLSearchParams({ ref_name: targetBranch, per_page: '20' });
    const r = await this.#req('GET', `/repository/commits?${q.toString()}`);
    if (r.status !== 200) this.#http.fail('list commits', r.status);
    for (const c of arr(r.json)) {
      const o = obj(c);
      if (trailerValues(str(o.message), MERGE_TRAILER_KEY).includes(mergeRequestId)) {
        const sha = str(o.id);
        return SHA.test(sha) ? sha : null;
      }
    }
    return null;
  }

  /**
   * p19-ide W1: `GET repository/tree?path=&ref=` (100 per page, at most 10 pages). UNVERIFIED-LIVE (fixtures only).
   */
  async tree(sha: string, path: string): Promise<TreeListing | null> {
    if (!SHA.test(sha) || !isRepoPath(path, true)) throw new ProviderError('invalid sha or path', false);
    const entries: TreeEntry[] = [];
    for (let page = 1; page <= 10; page++) {
      const q = new URLSearchParams({ ref: sha, per_page: '100', page: String(page) });
      if (path !== '') q.set('path', path);
      const r = await this.#req('GET', `/repository/tree?${q.toString()}`);
      if (r.status === 404) return page === 1 ? null : { entries, truncated: false };
      if (r.status !== 200) this.#http.fail('read directory', r.status);
      const list = arr(r.json);
      for (const e of list) {
        const o = obj(e);
        const full = str(o.path);
        const type = str(o.type);
        if (!isRepoPath(full)) continue;
        entries.push({
          name: str(o.name) || (full.split('/').pop() ?? full),
          path: full,
          kind:
            type === 'tree'
              ? 'dir'
              : type === 'commit'
                ? 'submodule'
                : str(o.mode) === '120000'
                  ? 'symlink'
                  : 'file',
          size: null,
        });
      }
      if (list.length < 100) return { entries, truncated: false };
    }
    return { entries, truncated: true };
  }

  /** p19-ide W1: `GET repository/files/:path?ref=` (base64 content). UNVERIFIED-LIVE (fixtures only). */
  async blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    if (!SHA.test(sha) || !isRepoPath(path)) throw new ProviderError('invalid sha or path', false);
    const r = await this.#req('GET', `/repository/files/${encodeURIComponent(path)}?ref=${sha}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#http.fail('read file', r.status);
    const o = obj(r.json);
    const size = num(o.size);
    if (size > maxBytes) return { state: 'too_large', size };
    if (str(o.encoding) !== 'base64') return { state: 'binary', size };
    return classifyBlob(Buffer.from(str(o.content), 'base64'), size, maxBytes);
  }

  async deleteBranch(branch: string, expectedSha: string): Promise<'deleted' | 'moved' | 'absent'> {
    // No compare-and-swap on GitLab's branch delete: re-checked right before (residual TOCTOU documented).
    const head = await this.branchHead(branch);
    if (head === null) return 'absent';
    if (head !== expectedSha) return 'moved';
    const r = await this.#req('DELETE', `/repository/branches/${encodeURIComponent(branch)}`);
    if (r.status === 204 || r.status === 200) return 'deleted';
    if (r.status === 404) return 'absent';
    this.#http.fail('delete branch', r.status);
  }

  /** `protected` from the branch itself (GitLab resolves wildcard rules for it). */
  async branchProtection(branch: string): Promise<BranchProtection> {
    const r = await this.#req('GET', `/repository/branches/${encodeURIComponent(branch)}`);
    if (r.status === 404) return { state: 'missing', classic: false, rules: [] };
    if (r.status !== 200) return { state: 'unknown', classic: false, rules: [] };
    const j = obj(r.json);
    if (j.protected === true) {
      return {
        state: 'protected',
        classic: true,
        rules:
          j.developers_can_push === true ? ['protected_branch', 'developers_can_push'] : ['protected_branch'],
      };
    }
    return { state: 'unprotected', classic: false, rules: [] };
  }

  /**
   * GitLab has no "move a branch" API. A new branch is created at `sha`; an existing branch is moved only when it is a
   * platform branch (`int/…`, the merge pipeline's integration branch) and the move is a fast-forward — by deleting and
   * re-creating it right after re-reading it (not atomic; residual race documented). Every other existing branch is
   * refused (`not_fast_forward`) rather than risking a target branch.
   */
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
      const del = await this.#req('DELETE', `/repository/branches/${encodeURIComponent(branch)}`);
      if (del.status !== 204 && del.status !== 200) this.#http.fail('delete branch', del.status);
    }
    const q = new URLSearchParams({ branch, ref: sha });
    const r = await this.#req('POST', `/repository/branches?${q.toString()}`);
    if (r.status === 201 || r.status === 200) return 'updated';
    if (r.status === 400 || r.status === 409) return 'moved';
    this.#http.fail('create branch', r.status);
  }

  async updatePullRequest(
    pr: PullRequestRef,
    input: { readonly title: string; readonly body: string },
  ): Promise<void> {
    const r = await this.#req('PUT', `/merge_requests/${String(pr.number)}`, {
      title: input.title.slice(0, 250),
      description: input.body.slice(0, 60_000),
    });
    if (r.status !== 200) this.#http.fail('update merge request', r.status);
  }

  /** p22-conflict-resolve: a note, then `PUT merge_requests/:iid` `state_event: close`. UNVERIFIED-LIVE (fixtures only). */
  async closePullRequest(pr: PullRequestRef, comment: string): Promise<void> {
    const c = await this.#req('POST', `/merge_requests/${String(pr.number)}/notes`, {
      body: comment.slice(0, 60_000),
    });
    if (c.status !== 201) this.#http.fail('comment on merge request', c.status);
    const r = await this.#req('PUT', `/merge_requests/${String(pr.number)}`, { state_event: 'close' });
    if (r.status !== 200) this.#http.fail('close merge request', r.status);
  }

  /** p18-project-bootstrap: `GET /projects/:id` → `empty_repo`. UNVERIFIED-LIVE (fixtures only). */
  async isEmpty(): Promise<boolean> {
    const r = await this.#req('GET', '');
    if (r.status !== 200) this.#http.fail('read project', r.status);
    return obj(r.json).empty_repo === true;
  }

  async defaultBranch(): Promise<string | null> {
    const r = await this.#req('GET', '');
    if (r.status === 404) return null;
    if (r.status !== 200) this.#http.fail('read project', r.status);
    const name = str(obj(r.json).default_branch);
    return isTargetBranch(name) ? name : null;
  }
}

function toCommit(o: Record<string, unknown>): CommitInfo {
  return {
    sha: str(o.id),
    message: str(o.message) || str(o.title),
    parents: arr(o.parent_ids)
      .map(str)
      .filter((p) => SHA.test(p)),
    author: {
      name: str(o.author_name).slice(0, 200),
      email: str(o.author_email).slice(0, 200),
      date:
        typeof o.authored_date === 'string'
          ? o.authored_date
          : typeof o.created_at === 'string'
            ? o.created_at
            : null,
    },
  };
}
