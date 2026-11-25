/**
 * Git provider abstraction (docs/design/p4-git-flow.md §2). Everything the master needs to check a job's
 * changes on the remote and to integrate them — never a checkout of user code (AGENTS.md rule 1): the
 * GitHub implementation uses the REST API only; the plain-git implementation works on a bare object cache
 * with hooks and repository configuration disabled.
 *
 * Every method that reads the remote may throw {@link ProviderError}; `transient` errors are retried by the
 * caller within its deadline, everything else fails closed.
 */

/** p16-git-providers: GitLab (gitlab.com / self-managed) and Bitbucket Cloud through their REST APIs. */
export type ProviderKind = 'github' | 'git' | 'gitlab' | 'bitbucket';
export type MergeMethod = 'merge' | 'squash';

export interface CommitInfo {
  readonly sha: string;
  /** Full message (untrusted text from the repository). */
  readonly message: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string; readonly date: string | null };
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed' | 'renamed' | 'other';
  readonly additions: number;
  readonly deletions: number;
  /** Previous path of a rename. */
  readonly previousPath?: string;
}

export interface Comparison {
  /** `ahead`: head descends from base; `identical`; `behind`: base descends from head; `diverged`. */
  readonly status: 'ahead' | 'identical' | 'behind' | 'diverged';
  readonly mergeBase: string;
  /** Commits reachable from head but not base (oldest first; capped by the provider). */
  readonly commits: readonly CommitInfo[];
  readonly files: readonly FileChange[];
  /** True when the provider capped commits or files. */
  readonly truncated: boolean;
}

export interface CommitRef {
  readonly sha: string;
  readonly subject: string;
}

/** Result of a test merge of `headSha` onto the current target branch. */
export type MergeCheck =
  | { readonly state: 'clean'; readonly baseSha: string; readonly headSha: string }
  | {
      readonly state: 'conflicts';
      readonly baseSha: string;
      readonly headSha: string;
      /** Conflicting paths (plain git: exact; GitHub: files changed on both sides — see the design note). */
      readonly files: readonly string[];
      /** Commits of the attempt that touch the files. */
      readonly headCommits: readonly CommitRef[];
      /** Commits that landed on the target branch since the merge base and touch the files. */
      readonly baseCommits: readonly CommitRef[];
      /** `exact` (computed merge) or `approximate` (provider only reports "not mergeable"). */
      readonly precision: 'exact' | 'approximate';
    }
  | {
      /** The target branch was rewritten: the base at job start is no longer part of its history. */
      readonly state: 'base_moved';
      readonly baseSha: string;
      readonly headSha: string;
      readonly reason: string;
    }
  /** The provider is still computing mergeability (GitHub `mergeable: null`); ask again later. */
  | { readonly state: 'unknown'; readonly baseSha: string; readonly headSha: string };

export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

export type CiState = 'none' | 'pending' | 'success' | 'failure' | 'unavailable';

export interface CiCheck {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed' | 'pending';
  readonly conclusion: string | null;
  readonly url: string | null;
}

export interface CiStatus {
  readonly state: CiState;
  readonly checks: readonly CiCheck[];
}

export interface MergeInput {
  readonly targetBranch: string;
  /** Head the approval was given for; the provider refuses if the branch moved (sha guard). */
  readonly headSha: string;
  /** Branch the head lives on (`rac/<job>/<attempt>`). */
  readonly headBranch: string;
  readonly method: MergeMethod;
  readonly pullRequest: PullRequestRef | null;
  readonly title: string;
  /** Message body; ends with the `Remyral-Merge: <id>` trailer (idempotency on retry). */
  readonly message: string;
  /**
   * p5-git-identity: author/committer of a merge commit the master creates itself (plain git remotes), when the
   * project or the workspace sets an identity. GitHub merges through its API with the App's identity (ignored).
   */
  readonly committer?: { readonly name: string; readonly email: string } | undefined;
}

export type MergeOutcome =
  | { readonly merged: true; readonly sha: string }
  | {
      readonly merged: false;
      /** head_moved (sha guard), base_moved, conflicts, not_mergeable, forbidden, rejected. */
      readonly reason: 'head_moved' | 'base_moved' | 'conflicts' | 'not_mergeable' | 'forbidden' | 'rejected';
      readonly detail: string;
    };

export interface PatchText {
  readonly text: string;
  /** Cut at the byte cap, or the provider left files out (GitHub omits large patches). */
  readonly truncated: boolean;
}

/** Caps text at `maxBytes` UTF-8 bytes (on a line boundary when possible). */
export function capPatch(text: string, maxBytes: number, truncated = false): PatchText {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated };
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  const nl = cut.lastIndexOf('\n');
  return { text: nl > 0 ? cut.slice(0, nl + 1) : cut, truncated: true };
}

/** p19-ide W1: one entry of a directory at a commit. */
export interface TreeEntry {
  /** Last path segment. */
  readonly name: string;
  /** Full path from the repository root ("/"-separated). */
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink' | 'submodule';
  /** Bytes (files; null when the provider does not say). */
  readonly size: number | null;
}

/** p19-ide W1: a directory listing (capped by the provider: GitHub lists at most 1 000 entries). */
export interface TreeListing {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
}

/**
 * p19-ide W1: a file at a commit. `text`: UTF-8 without NUL bytes, at most the caller's byte cap; `binary`: anything
 * else (shown as a summary); `too_large`: over the cap (never read whole). Untrusted repository content: callers redact
 * it and render it as text only.
 */
export type BlobRead =
  | { readonly state: 'text'; readonly text: string; readonly size: number }
  | { readonly state: 'binary'; readonly size: number }
  | { readonly state: 'too_large'; readonly size: number };

/** p19-ide W1: a repository-relative path the code viewer may read ("" = the root; no `..`, no absolute paths). */
export function isRepoPath(path: string, allowRoot = false): boolean {
  if (path === '') return allowRoot;
  if (path.length > 1024 || path.startsWith('/') || path.endsWith('/')) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** p19-ide W1: classifies bytes read from a provider (NUL or invalid UTF-8 = binary). */
export function classifyBlob(bytes: Uint8Array, size: number, maxBytes: number): BlobRead {
  if (size > maxBytes || bytes.length > maxBytes)
    return { state: 'too_large', size: Math.max(size, bytes.length) };
  if (bytes.subarray(0, 8000).includes(0)) return { state: 'binary', size };
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return { state: 'text', text, size };
  } catch {
    return { state: 'binary', size };
  }
}

/** p19-ide W1: the same for text a client already decoded (U+FFFD from a lossy decode counts as binary). */
export function classifyText(text: string, size: number, maxBytes: number): BlobRead {
  if (size > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes) return { state: 'too_large', size };
  if (text.includes('\u0000') || text.includes('\uFFFD')) return { state: 'binary', size };
  return { state: 'text', text, size };
}

export interface GitProvider {
  readonly kind: ProviderKind;
  /** Current sha of `refs/heads/<branch>` or null when it does not exist. */
  branchHead(branch: string): Promise<string | null>;
  commit(sha: string): Promise<CommitInfo>;
  /** `base...head`: what head adds on top of the merge base with base. */
  compare(base: string, head: string): Promise<Comparison>;
  /** Test merge of `headSha` onto `targetBranch` (no ref is written). */
  testMerge(input: {
    readonly targetBranch: string;
    readonly headSha: string;
    readonly headBranch: string;
    readonly baseAtStart: string;
    readonly pullRequest: PullRequestRef | null;
  }): Promise<MergeCheck>;
  /** Opens (or finds the open) pull request head → base; null when the provider has none (plain git). */
  ensurePullRequest(input: {
    readonly headBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly body: string;
    /** p14-workflow-engine 14.2: open a new pull request as a draft (default false). */
    readonly draft?: boolean;
  }): Promise<PullRequestRef | null>;
  /**
   * p14-workflow-engine 14.2 (optional, `github.comment` node): comments on pull request / issue `number` unless one of
   * its comments already carries `marker` (a hidden HTML comment) — the retry after a crash finds it instead of
   * posting twice.
   */
  issueComment?(
    number: number,
    body: string,
    marker: string,
  ): Promise<{ readonly id: number; readonly url: string; readonly created: boolean }>;
  /** CI checks of a commit. */
  checks(sha: string): Promise<CiStatus>;
  /** Integrates `headSha` into the target branch; never force-pushes the target. */
  merge(input: MergeInput): Promise<MergeOutcome>;
  /** Commit at the tip of the target branch whose message carries `Remyral-Merge: <id>` (retry check). */
  findMerge(targetBranch: string, mergeRequestId: string): Promise<string | null>;
  /** Deletes `refs/heads/<branch>` only if it still points at `expectedSha`. Approval-gated by the caller. */
  deleteBranch(branch: string, expectedSha: string): Promise<'deleted' | 'moved' | 'absent'>;
  /**
   * p5-live (optional): unified diff of what head adds on top of the merge base with base, as text capped
   * at `maxBytes` (UTF-8). Untrusted repository content: callers redact and render it as text only.
   */
  patch?(base: string, head: string, maxBytes: number): Promise<PatchText>;
  /**
   * p5-github-connect (optional): whether the target branch has a protection rule on the provider (ADR-0010
   * relies on it: installation tokens cannot be limited to one branch).
   */
  branchProtection?(branch: string): Promise<BranchProtection>;
  /**
   * p11-merge-pipeline (optional): points `refs/heads/<branch>` at `sha` — created when `expected` is null (refused when
   * it exists), else only while it is still at `expected` and only as a fast-forward (never forced). Used for the
   * integration branch `int/<root8>`, never for a target branch.
   */
  updateBranch?(branch: string, sha: string, expected: string | null): Promise<BranchUpdate>;
  /**
   * p15-auto-mode (optional): the repository's default branch (its `HEAD`), or null when the remote does not say.
   */
  defaultBranch?(): Promise<string | null>;
  /**
   * p18-project-bootstrap (optional): whether the repository is EMPTY — it has no branch at all (a freshly created
   * repository without a first commit). A job of such a repository starts from an empty first commit of its base
   * branch (worker `workspace-empty-repo-v1`). Errors propagate (callers treat them as "unknown").
   */
  isEmpty?(): Promise<boolean>;
  /**
   * p22-github-rate (optional): true while the provider's API budget is exhausted or below the reserve kept for work
   * that cannot wait; background re-checks (the merge-state refresh) are skipped meanwhile. Absent: never low.
   */
  backgroundBudgetLow?(): boolean;
  /**
   * p15-auto-mode (optional): re-applies what `headSha` adds on top of its merge base with `onto` as one commit on top
   * of `onto` (the head commit's message — trailers included — and author), and moves the attempt branch `branch`
   * (`rac/<job>/<attempt>` only) to it while it is still at `headSha`. `conflicts`: nothing is written.
   */
  rebaseOnto?(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly onto: string;
  }): Promise<RebaseOutcome>;
  /**
   * p15-workspace-retention (optional): writes `files` as one new commit on top of `parent` (null: a root commit) —
   * every other path of the parent's tree unchanged — and returns its sha. No ref moves: the caller points a branch at
   * it with {@link updateBranch}. Paths are relative, "/"-separated and already validated by the caller.
   */
  commitFiles?(input: {
    readonly parent: string | null;
    readonly files: readonly { readonly path: string; readonly content: Buffer }[];
    readonly message: string;
    readonly author?: { readonly name: string; readonly email: string };
  }): Promise<string>;
  /**
   * p19-ide W1 (optional): the entries of directory `path` ("" = the root) at commit `sha`, or null when `path` is not
   * a directory there. Read-only; nothing is checked out.
   */
  tree?(sha: string, path: string): Promise<TreeListing | null>;
  /**
   * p19-ide W1 (optional): file `path` at commit `sha` (≤ `maxBytes` read), or null when it is not a file there.
   */
  blob?(sha: string, path: string, maxBytes: number): Promise<BlobRead | null>;
  /**
   * p18-leftovers (optional): the open pull / merge requests of the repository, newest change first (at most
   * `limit`). Read-only; the Kod tab lists them and opens each as a compare of its base and head.
   */
  openPullRequests?(limit: number): Promise<readonly OpenPullRequest[]>;
  /**
   * p22-conflict-resolve (optional): closes an open pull / merge request without merging it, after leaving `comment`
   * on it (GitHub: issue comment + `state: closed`; GitLab: note + `state_event: close`; Bitbucket: comment + decline).
   * Absent: the platform cannot close it (the console says so).
   */
  closePullRequest?(pr: PullRequestRef, comment: string): Promise<void>;
  /** p11-merge-pipeline (optional): replaces the title and description of an open pull request. */
  updatePullRequest?(
    pr: PullRequestRef,
    input: { readonly title: string; readonly body: string },
  ): Promise<void>;
}

/**
 * p18-leftovers: an open pull / merge request of the repository. Titles and names are provider text (untrusted): the
 * console renders them as text. `headSha` is the head commit when the provider gives a full sha (else null: compare by
 * `headBranch`, only from the same repository).
 */
export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string | null;
  /** The head lives in this repository (not a fork). */
  readonly sameRepository: boolean;
  readonly updatedAt: string | null;
}

/** p15-auto-mode: the outcome of {@link GitProvider.rebaseOnto}. */
export type RebaseOutcome =
  | { readonly state: 'rebased'; readonly sha: string }
  | { readonly state: 'conflicts'; readonly files: readonly string[] }
  | { readonly state: 'moved'; readonly detail: string };

/** `moved`: the branch is not at the expected sha (or exists when it should not); `not_fast_forward`: refused. */
export type BranchUpdate = 'updated' | 'moved' | 'not_fast_forward';

export interface BranchProtection {
  /** `protected`: classic branch protection or an active ruleset; `missing`: no such branch; `unknown`: no answer. */
  readonly state: 'protected' | 'unprotected' | 'missing' | 'unknown';
  /** Classic branch protection is on. */
  readonly classic: boolean;
  /** Types of the ruleset rules that apply to the branch (`pull_request`, `non_fast_forward`, …). */
  readonly rules: readonly string[];
}

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    /** Network/5xx/rate limit: worth retrying within a deadline. */
    readonly transient: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}
