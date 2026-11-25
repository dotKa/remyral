import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Redactor, SecretSet, type Logger, type Revealable } from '@remyral/observability';
import { errnoCode } from '../fs/ops.js';
import {
  AttemptTrailerError,
  BaseRefNotFoundError,
  DiskQuotaError,
  InvalidWorkspaceIdError,
  PullRequestHeadMovedError,
  PushRejectedError,
  RepositoryNotAllowedError,
  type SecretFinding,
  SecretScanError,
  UnsafePathError,
  UnsafeSymlinkError,
  WorkspaceError,
  WorkspaceExistsError,
} from './errors.js';
import { GitRunner, isBrokenRefFailure, type GitCall } from './git.js';
import { type GitAuthSource, staticGitAuth, withGitAuth } from './git-auth.js';
import {
  ATTEMPT_TRAILER_KEY,
  assertEpoch,
  assertSafeSegment,
  attemptBranch,
  attemptTrailerValue,
  withAttemptTrailer,
} from './ids.js';
import { PathLocks, type LockOptions } from './lock.js';
import { hasControlChars } from './repo-url.js';
import { assertRealDir, assertRealInside, ensureDirInside, isInside } from './paths.js';
import { ProjectAllowlist, resolveSubmoduleUrl, type RepoUrl } from './repo-url.js';
import { GitLogScan, prePushScanner, scanLogArgs } from './secret-scan.js';

export type SubmodulePolicy = 'skip' | 'allowlisted';
export type SymlinkPolicy = 'refuse-escaping' | 'allow';

export interface WorkspaceManagerOptions {
  /** Absolute workspace root from the worker config (ADR-0007: the only writable path granted). */
  root: string;
  /** Project id → allowed repository URLs. */
  projects: Readonly<Record<string, readonly string[]>>;
  /** Failed/cancelled workspaces kept for inspection (oldest removed first). Default 5. */
  retainFailed?: number;
  /** Free bytes required under the root before a checkout. Default 2 GiB. */
  minFreeBytes?: number;
  /** `skip` (default): submodules are never initialised. `allowlisted`: only if every URL is allowlisted. */
  submodules?: SubmodulePolicy;
  /** `refuse-escaping` (default): a checkout with a symlink pointing outside the worktree is refused. */
  symlinks?: SymlinkPolicy;
  /** Development/tests only: accept `file://` repositories. */
  allowFileUrls?: boolean;
  /** git executable or a resolver called per command (p5-live-fixes-2: config → worker-managed → PATH). */
  gitBinary?: string | (() => string | Promise<string>);
  sourceEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  freeBytes?: (path: string) => Promise<number>;
  lock?: LockOptions;
  logger?: Logger;
  clock?: () => Date;
  /** Timeout for network git commands (fetch, push). Default 15 min. */
  networkTimeoutMs?: number;
}

export interface PrepareRequest {
  projectId: string;
  jobId: string;
  attemptId: string;
  /** Lease epoch (ADR-0004 fencing token). */
  epoch: number;
  repository: {
    url: string;
    baseRef: string;
    /**
     * p6-automations-next (ADR-0026): an untrusted pull request head pinned to `headSha` (= `baseRef`). Fetched
     * from `refs/pull/<number>/head` into a separate quarantine mirror; the worktree is created at the SHA.
     */
    pullRequest?: { number: number; headSha: string } | undefined;
  };
  /** Per-job, per-repository short-lived token (T-WRK-4). Env/credential helper only. */
  gitToken?: Revealable;
  gitTokenUsername?: string;
  /**
   * p15-git-central: a fresh credential right before each network command (wins over `gitToken`), retried once
   * with a newly requested one when the remote refuses it.
   */
  gitAuth?: GitAuthSource;
  /** The job's redactor: git output attached to errors is redacted with it. */
  redactor?: Redactor;
  /**
   * p19-ide W2: an IDE workspace's checkout — the worktree is on this branch (`remyral/ide/<user>/<name>`) instead of
   * the attempt branch; an existing remote branch of that name is continued (the base is its tip, not `baseRef`).
   */
  ide?: { readonly branch: string };
  /**
   * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §2): what to do when the remote is an EMPTY repository
   * (no branches, no tags) and `baseRef` is a branch name. Absent: the old behaviour ({@link BaseRefNotFoundError}).
   * Present: the base branch starts as one empty, parentless commit (empty tree) — pushed to `refs/heads/<baseRef>`
   * only when `publish` is true (the job publishes its result under git flow) and only while that branch still does
   * not exist (`--force-with-lease=<ref>:`), else kept local to the attempt. A missing ref in a NON-empty repository
   * stays an error.
   */
  emptyRemote?: {
    readonly publish: boolean;
    /** Author and committer of the empty first commit (the job's git identity). */
    readonly author: { readonly name: string; readonly email: string };
  };
}

/** p19-ide W2: the only branch names an IDE checkout may carry (protocol IdeBranch). */
const IDE_BRANCH =
  /^remyral\/ide\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** p19-ide W2: what `ideGitStatus` reports. */
export interface IdeGitStatus {
  readonly branch: string;
  readonly head: string;
  /** Uncommitted changed paths (porcelain entries). */
  readonly changedFiles: number;
  /** Commits on the branch not on the remote branch (null: the remote branch is unknown). */
  readonly ahead: number | null;
}

/** p19-ide W4: what `ideGitDiff` reports (the uncommitted changes of an IDE checkout). */
export interface IdeGitDiff {
  readonly branch: string;
  readonly head: string;
  readonly files: readonly {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
    readonly additions: number | null;
    readonly deletions: number | null;
  }[];
  readonly untracked: readonly string[];
  readonly diff: string;
  readonly truncated: boolean;
}

/** A prepared attempt workspace. Plain data; safe to log (no secrets). */
export interface Workspace {
  readonly projectId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  /** Real absolute path of the worktree. */
  readonly path: string;
  /** `rac/<jobId>/<attemptId>` */
  readonly branch: string;
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly mirrorPath: string;
  /** p6-automations-next: the pinned pull request this worktree holds (quarantine mirror; never pushed). */
  readonly pullRequest?: { readonly number: number; readonly headSha: string } | undefined;
  /**
   * p18-project-bootstrap: the remote was an empty repository and the base is the empty first commit made for it —
   * `pushed` (it is now `refs/heads/<baseRef>` on the remote), `local` (kept in this workspace only) or `existing`
   * (another job created the branch meanwhile; the workspace uses that one). Absent: an ordinary base.
   */
  readonly emptyRepository?: 'pushed' | 'local' | 'existing' | undefined;
}

export interface CommitRequest {
  message: string;
  author: { name: string; email: string };
  /** Create a commit even with no changes, so the tip carries the attempt trailer. Default true. */
  allowEmpty?: boolean;
}

export interface PushRequest {
  /**
   * What the attempt branch is expected to be on the remote: `null` = must not
   * exist yet (first push), otherwise the sha this attempt pushed last.
   */
  expectedRemoteSha: string | null;
  gitToken?: Revealable;
  gitTokenUsername?: string;
  /** p15-git-central: see {@link PrepareRequest.gitAuth}. */
  gitAuth?: GitAuthSource;
  /** Job secret set: exact values are refused in pushed content, and git output is redacted. */
  secrets?: SecretSet;
  redactor?: Redactor;
}

export interface PushResult {
  branch: string;
  sha: string;
}

export type ReleaseOutcome =
  { status: 'succeeded'; artifactsCollected: boolean } | { status: 'failed' | 'cancelled' };

export interface RetainedWorkspace {
  jobId: string;
  attemptId: string;
  path: string;
  status: 'failed' | 'cancelled';
  retainedAt: string;
  /** p5-research-workspace: a scratch directory (no mirror, no branch). Absent = git worktree. */
  kind?: 'scratch';
}

/**
 * p5-research-workspace: the empty per-attempt directory of a workspace job (no repository). Same place and
 * containment rules as a worktree: `jobs/<jobId>/<attemptId>/`, with `in/` (inputs) and `out/` (artifacts).
 */
export interface ScratchWorkspace {
  readonly kind: 'scratch';
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly path: string;
  readonly inDir: string;
  readonly outDir: string;
}

const META = '.remyral';
/**
 * p19-large-commit (an 847-file / 89 MiB result once failed at the commit step): staging, committing and
 * the pre-push scan of a large result (hundreds of images, thousands of files) take longer than the 120 s default of a
 * git command, above all on Windows.
 */
const LARGE_GIT_MS = 15 * 60_000;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Scoped workspace manager (p3-workspace; ADR-0004 §3, ADR-0007, ADR-0010, T-SBX-1/4/5, T-SEC-3, T-WRK-4).
 *
 * Layout under the (real) root:
 *   mirrors/<sha256(url)[:32]>.git   shared bare mirror per repository, fetched under a lock
 *   mirrors/<…>.git.lock             cross-process lock file
 *   jobs/<jobId>/<attemptId>/        git worktree on branch rac/<jobId>/<attemptId>
 *   .remyral/hooks-empty/             hooksPath on Windows (POSIX uses /dev/null)
 *   .remyral/retained/<job>__<attempt>.json   failed workspaces kept for inspection
 *
 * Upstream refs live under `refs/remotes/origin/*` in the mirror, so a fetch
 * (`--prune`) never touches the local `rac/*` branches checked out in worktrees.
 */
export class WorkspaceManager {
  readonly root: string;
  #allowlist: ProjectAllowlist;
  readonly #git: GitRunner;
  readonly #locks: PathLocks;
  #opts: WorkspaceManagerOptions;
  #retainFailed: number;
  #minFreeBytes: number;

  private constructor(root: string, git: GitRunner, opts: WorkspaceManagerOptions) {
    this.root = root;
    this.#opts = opts;
    this.#git = git;
    this.#allowlist = new ProjectAllowlist(opts.projects, { allowFileUrls: opts.allowFileUrls === true });
    this.#locks = new PathLocks(opts.lock);
    this.#retainFailed = opts.retainFailed ?? 5;
    this.#minFreeBytes = opts.minFreeBytes ?? 2 * 1024 ** 3;
  }

  /** Validates the root (absolute, real directory, not group/world-writable) and creates the layout. */
  static async create(opts: WorkspaceManagerOptions): Promise<WorkspaceManager> {
    if (!isAbsolute(opts.root)) throw new UnsafePathError(opts.root, 'workspace root must be absolute');
    await ensureRoot(opts.root);
    const root = await realpath(opts.root);
    const platform = opts.platform ?? process.platform;
    if (platform !== 'win32') {
      const st = await lstat(root);
      if ((st.mode & 0o022) !== 0) {
        throw new UnsafePathError(
          root,
          `workspace root is writable by group/others (mode 0${(st.mode & 0o777).toString(8)})`,
        );
      }
      if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) {
        throw new UnsafePathError(
          root,
          `workspace root is owned by uid ${String(st.uid)}, not the worker user`,
        );
      }
    }
    for (const dir of [['mirrors'], ['jobs'], [META], [META, 'retained'], [META, 'hooks-empty']]) {
      await ensureDirInside(root, dir);
    }
    // p15-git-central: temporary deploy-key dirs a crash left behind (each lives for one fetch / push only).
    await removeStaleCredDirs(join(root, META, 'cred'), Date.now() - 60 * 60_000);
    const hooks = join(root, META, 'hooks-empty');
    if ((await readdir(hooks)).length > 0) {
      throw new UnsafePathError(hooks, 'the empty hooks directory is not empty (tampering?)');
    }
    if (platform !== 'win32') await chmod(hooks, 0o500);
    const git = new GitRunner({
      emptyHooksDir: hooks,
      platform,
      // p22-git-preflight: a mirror / worktree of this root another account owns is trusted for its exact path only.
      trustRoot: root,
      onTrusted: (path) => {
        opts.logger?.warn(
          'git refused a repository of the workspace root as owned by another account; trusted it',
          {
            path,
          },
        );
      },
      ...(opts.gitBinary === undefined ? {} : { binary: opts.gitBinary }),
      ...(opts.sourceEnv === undefined ? {} : { sourceEnv: opts.sourceEnv }),
    });
    return new WorkspaceManager(root, git, opts);
  }

  get git(): GitRunner {
    return this.#git;
  }

  /**
   * ADR-0015 hot reload: replaces the repository allowlist and workspace hygiene settings. The new allowlist is
   * validated completely before anything changes (an invalid entry throws and leaves the old one in place).
   * Attempts already running keep their prepared workspace.
   */
  reconfigure(
    opts: Pick<WorkspaceManagerOptions, 'projects' | 'retainFailed' | 'minFreeBytes' | 'submodules'>,
  ): void {
    const allowlist = new ProjectAllowlist(opts.projects, {
      allowFileUrls: this.#opts.allowFileUrls === true,
    });
    this.#allowlist = allowlist;
    this.#opts = { ...this.#opts, ...opts };
    this.#retainFailed = opts.retainFailed ?? 5;
    this.#minFreeBytes = opts.minFreeBytes ?? 2 * 1024 ** 3;
  }

  /** Validates `projectId` + `url` against the allowlist without touching disk. */
  checkRepository(projectId: string, url: string): RepoUrl {
    return this.#allowlist.check(projectId, url);
  }

  /**
   * Prepares the attempt workspace: allowlist → disk quota → mirror fetch (locked)
   * → `git worktree add -b rac/<job>/<attempt> <path> <baseCommit>` (no hooks, no
   * submodules unless policy allows and every URL is allowlisted) → symlink check.
   * Any failure removes what was created.
   */
  async prepare(req: PrepareRequest): Promise<Workspace> {
    assertSafeSegment('projectId', req.projectId);
    assertSafeSegment('jobId', req.jobId);
    assertSafeSegment('attemptId', req.attemptId);
    assertEpoch(req.epoch);
    const baseRef = validateBaseRef(req.repository.baseRef);
    const pull = req.repository.pullRequest;
    if (pull !== undefined) {
      if (!Number.isInteger(pull.number) || pull.number < 1 || pull.number > 2_147_483_647) {
        throw new InvalidWorkspaceIdError('pullRequest.number', 'must be a positive integer');
      }
      if (!/^[0-9a-f]{40}$/.test(pull.headSha) || baseRef !== pull.headSha) {
        throw new InvalidWorkspaceIdError('pullRequest.headSha', 'must be a full sha equal to baseRef');
      }
    }
    const repo = this.#allowlist.check(req.projectId, req.repository.url);
    if (req.ide !== undefined && (!IDE_BRANCH.test(req.ide.branch) || pull !== undefined)) {
      throw new InvalidWorkspaceIdError('ide.branch', 'must be remyral/ide/<user>/<name>');
    }
    const branch = req.ide?.branch ?? attemptBranch(req.jobId, req.attemptId);
    await this.checkDiskSpace();

    const jobDir = await ensureDirInside(this.root, ['jobs', req.jobId]);
    const path = join(jobDir, req.attemptId);
    if ((await lstat(path).catch(() => null)) !== null) throw new WorkspaceExistsError(path);

    // ADR-0026: untrusted pull request heads live in their own quarantine mirror, so the trusted mirror (which
    // host-profile jobs check out from) never receives their objects.
    const mirror = await this.#mirrorPath(repo, pull === undefined ? 'trusted' : 'pull');
    const auth = req.gitAuth ?? staticGitAuth(req.gitToken, req.gitTokenUsername);
    const state: { created: boolean; empty?: 'pushed' | 'local' | 'existing' } = { created: false };
    try {
      const baseCommit = await this.#locks.with(`${mirror}.lock`, async () => {
        await this.#ensureMirror(mirror);
        const refspecs =
          pull === undefined
            ? ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']
            : [`+refs/pull/${String(pull.number)}/head:refs/remotes/pull/${String(pull.number)}/head`];
        const fetch = () =>
          withGitAuth(auth, this.#authOpts('fetch', req.redactor, req.jobId), (fields) =>
            this.#git.run({
              cwd: mirror,
              args: [
                'fetch',
                ...(pull === undefined ? ['--prune'] : []),
                '--no-tags',
                '--',
                repo.url,
                ...refspecs,
              ],
              remote: repo,
              timeoutMs: this.#opts.networkTimeoutMs ?? 15 * 60_000,
              ceiling: dirname(mirror),
              ...fields,
            }),
          );
        try {
          await fetch();
        } catch (error) {
          // p22-git-preflight: a broken worker-owned ref of the cached clone is removed and the fetch retried once.
          if (!isBrokenRefFailure(error)) throw error;
          const pruned = await this.#pruneBrokenRefs(mirror);
          if (pruned.length === 0) throw error;
          this.#opts.logger?.warn(
            'cached clone had refs to missing objects; removed them and fetching again',
            {
              jobId: req.jobId,
              refs: pruned.slice(0, 20),
              count: pruned.length,
            },
          );
          await fetch();
        }
        let commit: string;
        if (pull !== undefined) commit = await this.#resolvePinned(mirror, pull, req.redactor);
        else if (req.ide !== undefined)
          commit =
            (await this.#remoteTip(mirror, req.ide.branch)) ??
            (await this.#resolveBase(mirror, baseRef, req.redactor));
        else {
          try {
            commit = await this.#resolveBase(mirror, baseRef, req.redactor);
          } catch (error) {
            // p18-project-bootstrap: only a branch base of a truly empty remote (no branches, no tags) starts empty.
            if (!(error instanceof BaseRefNotFoundError) || SHA.test(baseRef)) throw error;
            if (!(await this.#remoteIsEmpty(mirror))) throw error;
            if (req.emptyRemote === undefined) throw new BaseRefNotFoundError(baseRef, true);
            const boot = await this.#bootstrapEmpty(mirror, repo, baseRef, req, auth, fetch);
            state.empty = boot.how;
            commit = boot.commit;
          }
        }
        // Re-checked under the lock: a duplicate ASSIGN for the same attempt must not
        // reuse (or, on failure, delete) the first one's worktree.
        if ((await lstat(path).catch(() => null)) !== null) throw new WorkspaceExistsError(path);
        if (req.ide !== undefined) {
          // A local IDE branch a removed workspace left behind (never one checked out elsewhere: -D refuses that).
          await this.#git.run({
            cwd: mirror,
            args: ['branch', '-D', '--', branch],
            okCodes: [1],
            ceiling: dirname(mirror),
          });
        }
        state.created = true;
        await this.#git.run({
          cwd: mirror,
          args: ['worktree', 'add', '--no-track', '-b', branch, '--', path, commit],
          ceiling: dirname(mirror),
          ...redactorField(req.redactor),
        });
        return commit;
      });
      const real = await assertRealInside(this.root, path);
      if (real !== path) throw new UnsafePathError(path, `resolves to ${real}`);
      await assertRealDir(real);

      if ((this.#opts.symlinks ?? 'refuse-escaping') === 'refuse-escaping') {
        const escaping = await this.findEscapingSymlinks(real);
        if (escaping.length > 0) throw new UnsafeSymlinkError(escaping);
      }
      if ((this.#opts.submodules ?? 'skip') === 'allowlisted') {
        await this.#initSubmodules(real, req.projectId, repo, auth, req.redactor, req.jobId);
      }
      const ws: Workspace = {
        projectId: req.projectId,
        jobId: req.jobId,
        attemptId: req.attemptId,
        epoch: req.epoch,
        path: real,
        branch,
        repositoryUrl: repo.url,
        baseRef,
        baseCommit,
        mirrorPath: mirror,
        ...(pull === undefined ? {} : { pullRequest: { number: pull.number, headSha: pull.headSha } }),
        ...(state.empty === undefined ? {} : { emptyRepository: state.empty }),
      };
      this.#opts.logger?.info('workspace prepared', {
        jobId: ws.jobId,
        attemptId: ws.attemptId,
        branch,
        baseCommit,
        path: real,
        ...(state.empty === undefined ? {} : { emptyRepository: state.empty }),
      });
      return ws;
    } catch (error) {
      if (state.created) await this.#removeWorktree(mirror, path, branch).catch(() => undefined);
      await rmdir(jobDir).catch(() => undefined);
      throw error;
    }
  }

  /**
   * p10-approval-pause (ADR-0036): re-opens the kept worktree of a paused attempt for its resume (same attempt id,
   * new epoch). Nothing is fetched or checked out: the repository is checked against the allowlist again, the
   * worktree must still be a real directory inside the root, its `.git` file must point into the mirror's
   * `worktrees/`, and the attempt branch must exist. The caller compares the trusted-git snapshot it kept.
   */
  async reopen(req: {
    projectId: string;
    jobId: string;
    attemptId: string;
    epoch: number;
    repository: {
      url: string;
      baseRef: string;
      baseCommit: string;
      pullRequest?: { number: number; headSha: string } | undefined;
    };
  }): Promise<Workspace> {
    assertSafeSegment('projectId', req.projectId);
    assertEpoch(req.epoch);
    const baseRef = validateBaseRef(req.repository.baseRef);
    if (!SHA.test(req.repository.baseCommit)) {
      throw new InvalidWorkspaceIdError('baseCommit', 'must be a full lowercase hex sha');
    }
    const repo = this.#allowlist.check(req.projectId, req.repository.url);
    const pull = req.repository.pullRequest;
    const mirror = await this.#mirrorPath(repo, pull === undefined ? 'trusted' : 'pull');
    const path = await this.#checkedPath(req.jobId, req.attemptId);
    await assertRealDir(mirror);
    const dotGit = (await readFile(join(path, '.git'), 'utf8').catch(() => '')).trim();
    const m = /^gitdir: (.+)$/.exec(dotGit);
    const meta = m?.[1] === undefined ? null : isAbsolute(m[1]) ? m[1] : resolve(path, m[1]);
    if (meta === null || !isInside(join(mirror, 'worktrees'), meta)) {
      throw new UnsafePathError(path, 'the kept worktree is not a worktree of the repository mirror');
    }
    const branch = attemptBranch(req.jobId, req.attemptId);
    await this.#git.run({
      cwd: mirror,
      args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`],
      ceiling: dirname(mirror),
    });
    this.#opts.logger?.info('workspace reopened', { jobId: req.jobId, attemptId: req.attemptId, branch });
    return {
      projectId: req.projectId,
      jobId: req.jobId,
      attemptId: req.attemptId,
      epoch: req.epoch,
      path,
      branch,
      repositoryUrl: repo.url,
      baseRef,
      baseCommit: req.repository.baseCommit,
      mirrorPath: mirror,
      ...(pull === undefined ? {} : { pullRequest: { number: pull.number, headSha: pull.headSha } }),
    };
  }

  /** p10-approval-pause: re-opens the kept scratch directory of a paused workspace job (with `in/` and `out/`). */
  async reopenScratch(req: { jobId: string; attemptId: string; epoch: number }): Promise<ScratchWorkspace> {
    assertEpoch(req.epoch);
    const path = await this.#checkedPath(req.jobId, req.attemptId);
    const inDir = await ensureDirInside(this.root, ['jobs', req.jobId, req.attemptId, 'in']);
    const outDir = await ensureDirInside(this.root, ['jobs', req.jobId, req.attemptId, 'out']);
    this.#opts.logger?.info('scratch workspace reopened', { jobId: req.jobId, attemptId: req.attemptId });
    return {
      kind: 'scratch',
      jobId: req.jobId,
      attemptId: req.attemptId,
      epoch: req.epoch,
      path,
      inDir,
      outDir,
    };
  }

  /** Free space check under the root (T-SBX-5). */
  async checkDiskSpace(): Promise<void> {
    const free = await (this.#opts.freeBytes ?? defaultFreeBytes)(this.root);
    if (free < this.#minFreeBytes) throw new DiskQuotaError(free, this.#minFreeBytes);
  }

  /**
   * Symlinks in the worktree whose target is absolute or resolves outside the
   * worktree (`../../../.ssh`). Git already refuses to write *through* symlinks;
   * this stops a checkout from handing the agent a link to `~/.ssh` (T-SBX-1).
   */
  async findEscapingSymlinks(worktree: string): Promise<{ path: string; target: string }[]> {
    const { stdout } = await this.#git.run({
      cwd: worktree,
      args: ['ls-files', '-s', '-z'],
      ceiling: dirname(worktree),
    });
    const out: { path: string; target: string }[] = [];
    for (const entry of stdout.split('\0')) {
      const m = /^120000 [0-9a-f]+ \d+\t(.+)$/s.exec(entry);
      if (m === null) continue;
      const rel = m[1] ?? '';
      const full = join(worktree, rel);
      const target = await readlink(full).catch(() => null);
      if (target === null) continue;
      const resolved = resolve(dirname(full), target);
      if (isAbsolute(target) || !isInside(worktree, resolved)) out.push({ path: rel, target });
    }
    return out;
  }

  /**
   * Stages everything and commits with the attempt trailer
   * (`Remyral-Attempt: <attemptId>/<epoch>`, ADR-0004 §3). Hooks never run.
   * Returns the new tip sha.
   */
  async commit(ws: Workspace, req: CommitRequest): Promise<string> {
    const message = withAttemptTrailer(req.message, ws.attemptId, ws.epoch);
    const base = { cwd: ws.path, ceiling: dirname(ws.path) };
    await this.#git.run({ ...base, args: ['add', '-A', '--', '.'], timeoutMs: LARGE_GIT_MS });
    await this.#git.run({
      ...base,
      timeoutMs: LARGE_GIT_MS,
      args: [
        'commit',
        '--no-verify',
        '--cleanup=verbatim',
        ...(req.allowEmpty === false ? [] : ['--allow-empty']),
        '-F',
        '-',
      ],
      input: message,
      config: [
        ['user.name', req.author.name],
        ['user.email', req.author.email],
      ],
    });
    return (await this.#git.run({ ...base, args: ['rev-parse', '--verify', 'HEAD^{commit}'] })).stdout.trim();
  }

  /**
   * Pushes exactly `refs/heads/rac/<jobId>/<attemptId>` to the origin with
   * `--force-with-lease=<ref>:<expected>` (never without an expected value), after
   * (1) checking the tip carries this attempt's trailer and (2) a secret scan of
   * every commit not yet upstream (messages + added lines, pattern rules + the
   * job's exact secret values). Any finding refuses the push.
   */
  async push(ws: Workspace, req: PushRequest): Promise<PushResult> {
    // ADR-0026: a pinned pull request head (untrusted code) is never pushed, whatever the caller asks.
    if (ws.pullRequest !== undefined) {
      throw new WorkspaceError('refusing to push a pull request head workspace (untrusted source)');
    }
    if (req.expectedRemoteSha !== null && !SHA.test(req.expectedRemoteSha)) {
      throw new InvalidWorkspaceIdError('expectedRemoteSha', 'must be a full lowercase hex sha or null');
    }
    const repo = this.#allowlist.check(ws.projectId, ws.repositoryUrl);
    const ref = `refs/heads/${ws.branch}`;
    const base = { cwd: ws.path, ceiling: dirname(ws.path), ...redactorField(req.redactor) };
    const sha = (
      await this.#git.run({ ...base, args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`] })
    ).stdout.trim();

    const trailer = (
      await this.#git.run({
        ...base,
        args: ['log', '-1', `--format=%(trailers:key=${ATTEMPT_TRAILER_KEY},valueonly,separator=%x0a)`, sha],
      })
    ).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const expected = attemptTrailerValue(ws.attemptId, ws.epoch);
    if (trailer.length !== 1 || trailer[0] !== expected) throw new AttemptTrailerError(ws.branch, expected);

    const findings = await this.#scanUnpushed(base, ref, ws.baseCommit, req.secrets);
    if (findings.length > 0) {
      this.#opts.logger?.warn('pre-push secret scan refused the push', {
        jobId: ws.jobId,
        attemptId: ws.attemptId,
        findings: findings.length,
      });
      throw new SecretScanError(findings);
    }

    const lease = `--force-with-lease=${ref}:${req.expectedRemoteSha ?? ''}`;
    // p15-git-central: the push credential is requested now, right before the push (never the one from job start).
    const auth = req.gitAuth ?? staticGitAuth(req.gitToken, req.gitTokenUsername);
    const result = await withGitAuth(auth, this.#authOpts('push', req.redactor, ws.jobId), (fields) =>
      this.#git.run({
        ...base,
        args: [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-recurse-submodules',
          lease,
          '--',
          repo.url,
          `${ref}:${ref}`,
        ],
        remote: repo,
        timeoutMs: this.#opts.networkTimeoutMs ?? 15 * 60_000,
        okCodes: [1],
        ...fields,
      }),
    );
    const status = result.stdout.split('\n').find((l) => l.includes(`${ref}:${ref}`));
    if (result.code !== 0 || status === undefined || status.startsWith('!')) {
      const detail = (status ?? result.stderr).trim().slice(0, 300);
      const redacted = new Redactor({
        ...(req.secrets === undefined ? {} : { secrets: req.secrets }),
      }).redact(detail);
      throw new PushRejectedError(
        ws.branch,
        /stale info|fetch first/.test(detail) ? 'stale-lease' : 'rejected',
        redacted,
      );
    }
    this.#opts.logger?.info('attempt branch pushed', {
      jobId: ws.jobId,
      attemptId: ws.attemptId,
      branch: ws.branch,
      sha,
    });
    return { branch: ws.branch, sha };
  }

  /**
   * Ends the workspace. Success: deleted, but only after artifacts were collected.
   * Failed/cancelled: kept for inspection; only the newest `retainFailed` are kept.
   */
  async release(ws: Workspace, outcome: ReleaseOutcome): Promise<'deleted' | 'retained'> {
    const path = await this.#checkedPath(ws.jobId, ws.attemptId);
    if (outcome.status === 'succeeded') {
      if (!outcome.artifactsCollected) {
        throw new WorkspaceError(
          'refusing to delete a successful workspace before its artifacts were collected',
        );
      }
      await this.#locks.with(`${ws.mirrorPath}.lock`, () =>
        this.#removeWorktree(ws.mirrorPath, path, ws.branch),
      );
      await rmdir(dirname(path)).catch(() => undefined);
      return 'deleted';
    }
    const record: RetainedWorkspace = {
      jobId: ws.jobId,
      attemptId: ws.attemptId,
      path,
      status: outcome.status,
      retainedAt: (this.#opts.clock?.() ?? new Date()).toISOString(),
    };
    await writeFile(
      this.#retainedFile(ws.jobId, ws.attemptId),
      `${JSON.stringify({ ...record, mirrorPath: ws.mirrorPath, branch: ws.branch })}\n`,
      { mode: 0o600 },
    );
    await this.pruneRetained();
    return 'retained';
  }

  /**
   * p5-research-workspace: creates the attempt's empty scratch directory (ids validated, component-wise creation,
   * free-space check). A duplicate for the same attempt is refused without touching the first one.
   */
  async prepareScratch(req: { jobId: string; attemptId: string; epoch: number }): Promise<ScratchWorkspace> {
    assertSafeSegment('jobId', req.jobId);
    assertSafeSegment('attemptId', req.attemptId);
    assertEpoch(req.epoch);
    await this.checkDiskSpace();
    const jobDir = await ensureDirInside(this.root, ['jobs', req.jobId]);
    const path = join(jobDir, req.attemptId);
    if ((await lstat(path).catch(() => null)) !== null) throw new WorkspaceExistsError(path);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceExistsError(path);
      throw err;
    }
    const real = await this.#checkedPath(req.jobId, req.attemptId);
    const inDir = await ensureDirInside(this.root, ['jobs', req.jobId, req.attemptId, 'in']);
    const outDir = await ensureDirInside(this.root, ['jobs', req.jobId, req.attemptId, 'out']);
    this.#opts.logger?.info('scratch workspace prepared', { jobId: req.jobId, attemptId: req.attemptId });
    return {
      kind: 'scratch',
      jobId: req.jobId,
      attemptId: req.attemptId,
      epoch: req.epoch,
      path: real,
      inDir,
      outDir,
    };
  }

  /**
   * Ends a scratch workspace with the same rules as a worktree: success → deleted (only after its artifacts were
   * collected); failed/cancelled → kept for inspection, newest `retainFailed` kept.
   */
  async releaseScratch(ws: ScratchWorkspace, outcome: ReleaseOutcome): Promise<'deleted' | 'retained'> {
    const path = await this.#checkedPath(ws.jobId, ws.attemptId);
    if (outcome.status === 'succeeded') {
      if (!outcome.artifactsCollected) {
        throw new WorkspaceError(
          'refusing to delete a successful workspace before its artifacts were collected',
        );
      }
      await rm(path, { recursive: true, force: true });
      await rmdir(dirname(path)).catch(() => undefined);
      return 'deleted';
    }
    const record: RetainedWorkspace = {
      jobId: ws.jobId,
      attemptId: ws.attemptId,
      path,
      status: outcome.status,
      retainedAt: (this.#opts.clock?.() ?? new Date()).toISOString(),
      kind: 'scratch',
    };
    await writeFile(this.#retainedFile(ws.jobId, ws.attemptId), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    await this.pruneRetained();
    return 'retained';
  }

  /** Retained workspaces, newest first. */
  async listRetained(): Promise<(RetainedWorkspace & { mirrorPath: string; branch: string })[]> {
    const dir = join(this.root, META, 'retained');
    const out: (RetainedWorkspace & { mirrorPath: string; branch: string })[] = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(dir, name), 'utf8')) as RetainedWorkspace & {
          mirrorPath: string;
          branch: string;
        };
        out.push(rec);
      } catch {
        await rm(join(dir, name), { force: true });
      }
    }
    return out.sort((a, b) => b.retainedAt.localeCompare(a.retainedAt));
  }

  /** Deletes retained workspaces beyond `retainFailed` (oldest first). Returns how many were removed. */
  async pruneRetained(): Promise<number> {
    const all = await this.listRetained();
    let removed = 0;
    for (const rec of all.slice(this.#retainFailed)) {
      if (await this.#removeRetained(rec)) removed++;
    }
    return removed;
  }

  /**
   * p17-disk-selfclean: removes one retained (failed / cancelled, kept for inspection) workspace now — the disk
   * hygiene's oldest-first removal while the disk is low. False: no such record (or it could not be removed).
   */
  async removeRetained(jobId: string, attemptId: string): Promise<boolean> {
    const rec = (await this.listRetained()).find((r) => r.jobId === jobId && r.attemptId === attemptId);
    return rec === undefined ? false : this.#removeRetained(rec);
  }

  /** p17-disk-selfclean: where a retained workspace lives (`<root>/jobs/<jobId>/<attemptId>`). */
  retainedPath(jobId: string, attemptId: string): string {
    assertSafeSegment('jobId', jobId);
    assertSafeSegment('attemptId', attemptId);
    return join(this.root, 'jobs', jobId, attemptId);
  }

  async #removeRetained(rec: RetainedWorkspace & { mirrorPath?: string }): Promise<boolean> {
    let removed = false;
    try {
      assertSafeSegment('jobId', rec.jobId);
      assertSafeSegment('attemptId', rec.attemptId);
      const path = join(this.root, 'jobs', rec.jobId, rec.attemptId);
      if (rec.kind === 'scratch') {
        // A scratch directory: nothing but files of the attempt (checked: a real dir inside the root).
        if ((await lstat(path).catch(() => null)) !== null) {
          const real = await this.#checkedPath(rec.jobId, rec.attemptId);
          await rm(real, { recursive: true, force: true });
        }
        await rmdir(dirname(path)).catch(() => undefined);
        await rm(this.#retainedFile(rec.jobId, rec.attemptId), { force: true });
        return true;
      }
      const mirrorName = (rec.mirrorPath ?? '').split(/[\\/]/).at(-1) ?? '';
      if (!/^[0-9a-f]{32}\.git$/.test(mirrorName))
        throw new UnsafePathError(rec.mirrorPath ?? '', 'not a mirror path');
      const mirror = join(this.root, 'mirrors', mirrorName);
      if ((await lstat(path).catch(() => null)) !== null) await this.#checkedPath(rec.jobId, rec.attemptId);
      await this.#locks.with(`${mirror}.lock`, () =>
        this.#removeWorktree(mirror, path, attemptBranch(rec.jobId, rec.attemptId)),
      );
      await rmdir(dirname(path)).catch(() => undefined);
      removed = true;
    } catch (error) {
      this.#opts.logger?.warn('could not remove a retained workspace', {
        jobId: rec.jobId,
        attemptId: rec.attemptId,
        error,
      });
    }
    await rm(this.#retainedFile(rec.jobId, rec.attemptId), { force: true });
    return removed;
  }

  async #checkedPath(jobId: string, attemptId: string): Promise<string> {
    assertSafeSegment('jobId', jobId);
    assertSafeSegment('attemptId', attemptId);
    const path = join(this.root, 'jobs', jobId, attemptId);
    await assertRealDir(dirname(path));
    await assertRealDir(path);
    const real = await assertRealInside(this.root, path);
    if (real !== path) throw new UnsafePathError(path, `resolves to ${real}`);
    return real;
  }

  #retainedFile(jobId: string, attemptId: string): string {
    return join(this.root, META, 'retained', `${jobId}__${attemptId}.json`);
  }

  async #mirrorPath(repo: RepoUrl, kind: 'trusted' | 'pull' = 'trusted'): Promise<string> {
    const key = kind === 'pull' ? `pull:${repo.key}` : repo.key;
    const name = `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.git`;
    const dir = await ensureDirInside(this.root, ['mirrors']);
    return join(dir, name);
  }

  async #ensureMirror(mirror: string): Promise<void> {
    const st = await lstat(mirror).catch(() => null);
    if (st !== null) {
      await assertRealDir(mirror);
      // A bare repository has a HEAD file. An earlier attempt can leave the directory behind without one
      // (e.g. git was not installed yet: spawn ENOENT after the mkdir) - re-create it instead of failing
      // every later fetch with "not a git repository".
      if ((await lstat(join(mirror, 'HEAD')).catch(() => null)) !== null) return;
      await rm(mirror, { recursive: true, force: true });
    }
    await ensureDirInside(dirname(mirror), [mirror.split(/[\\/]/).at(-1) ?? '']);
    const ceiling = dirname(mirror);
    // Empty template: no sample hooks, no template config.
    await this.#git.run({
      cwd: mirror,
      args: ['init', '--bare', `--template=${join(this.root, META, 'hooks-empty')}`, '--', mirror],
      ceiling,
    });
    // Persisted for git commands the agent runs inside its worktree (defence in depth;
    // every command we run passes the same settings with -c).
    for (const [k, v] of [
      ['core.hooksPath', this.#git.hooksPath],
      ['core.fsmonitor', 'false'],
      ['gc.auto', '0'],
      ['transfer.fsckObjects', 'true'],
      ['submodule.recurse', 'false'],
    ] as const) {
      await this.#git.run({ cwd: mirror, args: ['config', '--', k, v], ceiling });
    }
  }

  async #resolveBase(mirror: string, baseRef: string, redactor: Redactor | undefined): Promise<string> {
    const candidates = SHA.test(baseRef)
      ? [`${baseRef}^{commit}`]
      : [`refs/remotes/origin/${baseRef}^{commit}`, `refs/tags/${baseRef}^{commit}`];
    for (const candidate of candidates) {
      const r = await this.#git.run({
        cwd: mirror,
        args: ['rev-parse', '--verify', '--quiet', '--end-of-options', candidate],
        okCodes: [1, 128],
        ceiling: dirname(mirror),
        ...redactorField(redactor),
      });
      const sha = r.stdout.trim();
      if (r.code === 0 && SHA.test(sha)) return sha;
    }
    throw new BaseRefNotFoundError(baseRef);
  }

  /** p19-ide W2: the fetched tip of `origin/<branch>`, or null when the remote has no such branch. */
  async #remoteTip(mirror: string, branch: string): Promise<string | null> {
    const r = await this.#git.run({
      cwd: mirror,
      args: [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `refs/remotes/origin/${branch}^{commit}`,
      ],
      okCodes: [1, 128],
      ceiling: dirname(mirror),
    });
    const sha = r.stdout.trim();
    return r.code === 0 && SHA.test(sha) ? sha : null;
  }

  /**
   * p19-ide W2: branch, head, uncommitted changes and commits ahead of the remote branch of an IDE checkout. Read-only
   * (hardened git: no hooks, no fsmonitor, no user config).
   */
  async ideGitStatus(ws: Workspace): Promise<IdeGitStatus> {
    if (!IDE_BRANCH.test(ws.branch)) throw new WorkspaceError('not an IDE checkout');
    const base = { cwd: ws.path, ceiling: dirname(ws.path) };
    const head = (
      await this.#git.run({ ...base, args: ['rev-parse', '--verify', 'HEAD^{commit}'] })
    ).stdout.trim();
    const porcelain = await this.#git.run({
      ...base,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    });
    const changedFiles = porcelain.stdout.split('\0').filter((e) => e.length > 3).length;
    const remote = await this.#remoteTip(ws.mirrorPath, ws.branch);
    let ahead: number | null;
    if (remote !== null) {
      const r = await this.#git.run({
        ...base,
        args: ['rev-list', '--count', `${remote}..${head}`],
        okCodes: [128],
      });
      ahead = r.code === 0 ? Number(r.stdout.trim()) : null;
    } else {
      const r = await this.#git.run({
        ...base,
        args: ['rev-list', '--count', `${ws.baseCommit}..${head}`],
        okCodes: [128],
      });
      ahead = r.code === 0 ? Number(r.stdout.trim()) : null;
    }
    return { branch: ws.branch, head, changedFiles, ahead: Number.isFinite(ahead) ? ahead : null };
  }

  /**
   * p19-ide W4 (`read_workspace_diff`): the uncommitted changes of an IDE checkout — the tracked files changed against
   * HEAD with their line counts, the untracked files, and `git diff HEAD` (no external diff, no textconv, no colour;
   * hardened git), cut to `maxChars`. Read-only: the index and the working tree are not touched (`GIT_OPTIONAL_LOCKS=0`).
   */
  async ideGitDiff(
    ws: Workspace,
    opts: { readonly path?: string; readonly maxChars: number; readonly maxFiles: number },
  ): Promise<IdeGitDiff> {
    if (!IDE_BRANCH.test(ws.branch)) throw new WorkspaceError('not an IDE checkout');
    const base = { cwd: ws.path, ceiling: dirname(ws.path) };
    const head = (
      await this.#git.run({ ...base, args: ['rev-parse', '--verify', 'HEAD^{commit}'] })
    ).stdout.trim();
    const scope = opts.path === undefined ? [] : ['--', opts.path];
    const common = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'];
    const status = await this.#git.run({
      ...base,
      args: ['--literal-pathspecs', 'diff', '--name-status', '-z', ...common, ...scope],
    });
    const numstat = await this.#git.run({
      ...base,
      args: ['--literal-pathspecs', 'diff', '--numstat', '-z', ...common, ...scope],
    });
    const counts = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const entry of numstat.stdout.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
      if (m === null) continue;
      counts.set(m[3] ?? '', {
        additions: m[1] === '-' ? null : Number(m[1]),
        deletions: m[2] === '-' ? null : Number(m[2]),
      });
    }
    const parts = status.stdout.split('\0');
    const files: IdeGitDiff['files'][number][] = [];
    let truncated = false;
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i] ?? '';
      const path = parts[i + 1] ?? '';
      if (code === '' || path === '') continue;
      if (files.length >= opts.maxFiles) {
        truncated = true;
        break;
      }
      const c = counts.get(path) ?? { additions: null, deletions: null };
      files.push({
        path,
        status:
          code === 'A'
            ? 'added'
            : code === 'M'
              ? 'modified'
              : code === 'D'
                ? 'deleted'
                : code.startsWith('R')
                  ? 'renamed'
                  : 'other',
        additions: c.additions,
        deletions: c.deletions,
      });
    }
    const others = await this.#git.run({
      ...base,
      args: ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', ...scope],
    });
    const untrackedAll = others.stdout.split('\0').filter((p) => p !== '');
    if (untrackedAll.length > opts.maxFiles) truncated = true;
    const text = (
      await this.#git.run({ ...base, args: ['--literal-pathspecs', 'diff', '-U3', ...common, ...scope] })
    ).stdout;
    if (text.length > opts.maxChars) truncated = true;
    return {
      branch: ws.branch,
      head,
      files,
      untracked: untrackedAll.slice(0, opts.maxFiles),
      diff: text.slice(0, opts.maxChars),
      truncated,
    };
  }

  /**
   * p19-ide W2 ("Gönder"): commits every change of an IDE checkout (when `message` is given and something changed;
   * hooks never run), refuses a branch the IDE user switched away from, scans every commit not on the remote (pattern
   * rules + `secrets`) and pushes exactly `refs/heads/<IDE branch>` — fast-forward only, never forced — with a token
   * the master minted for this push (credential helper, env only; never in the IDE's environment).
   */
  async idePush(
    ws: Workspace,
    req: {
      readonly message?: string;
      readonly author: { readonly name: string; readonly email: string };
      readonly gitAuth?: GitAuthSource;
      readonly gitToken?: Revealable;
      readonly gitTokenUsername?: string;
      readonly secrets?: SecretSet;
      readonly redactor?: Redactor;
    },
  ): Promise<{ branch: string; sha: string; committed: boolean }> {
    if (!IDE_BRANCH.test(ws.branch)) throw new WorkspaceError('not an IDE checkout');
    const repo = this.#allowlist.check(ws.projectId, ws.repositoryUrl);
    const ref = `refs/heads/${ws.branch}`;
    const base = { cwd: ws.path, ceiling: dirname(ws.path), ...redactorField(req.redactor) };
    const current = (
      await this.#git.run({ ...base, args: ['symbolic-ref', '--quiet', 'HEAD'], okCodes: [1, 128] })
    ).stdout.trim();
    if (current !== ref) {
      throw new WorkspaceError(`the IDE checkout is not on ${ws.branch} (switch back to it to send)`);
    }
    let committed = false;
    const status = await this.#git.run({
      ...base,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    });
    if (req.message !== undefined && status.stdout.length > 0) {
      await this.#git.run({ ...base, args: ['add', '-A', '--', '.'], timeoutMs: LARGE_GIT_MS });
      await this.#git.run({
        ...base,
        args: ['commit', '--no-verify', '--cleanup=strip', '-F', '-'],
        timeoutMs: LARGE_GIT_MS,
        input: req.message,
        config: [
          ['user.name', req.author.name],
          ['user.email', req.author.email],
        ],
      });
      committed = true;
    }
    const sha = (
      await this.#git.run({ ...base, args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`] })
    ).stdout.trim();
    const findings = await this.#scanUnpushed(base, ref, ws.baseCommit, req.secrets);
    if (findings.length > 0) {
      this.#opts.logger?.warn('pre-push secret scan refused the IDE push', {
        branch: ws.branch,
        findings: findings.length,
      });
      throw new SecretScanError(findings);
    }
    const auth = req.gitAuth ?? staticGitAuth(req.gitToken, req.gitTokenUsername);
    const result = await withGitAuth(auth, this.#authOpts('push', req.redactor, ws.jobId), (fields) =>
      this.#git.run({
        ...base,
        args: [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-recurse-submodules',
          '--',
          repo.url,
          `${ref}:${ref}`,
        ],
        remote: repo,
        timeoutMs: this.#opts.networkTimeoutMs ?? 15 * 60_000,
        okCodes: [1],
        ...fields,
      }),
    );
    const line = result.stdout.split('\n').find((l) => l.includes(`${ref}:${ref}`));
    if (result.code !== 0 || line === undefined || line.startsWith('!')) {
      const detail = (line ?? result.stderr).trim().slice(0, 300);
      const redacted = new Redactor({
        ...(req.secrets === undefined ? {} : { secrets: req.secrets }),
      }).redact(detail);
      throw new PushRejectedError(
        ws.branch,
        /fetch first|non-fast-forward/.test(detail) ? 'stale-lease' : 'rejected',
        redacted,
      );
    }
    // The mirror's view of the remote branch follows (ahead counts, the next push's secret scan range).
    await this.#locks
      .with(`${ws.mirrorPath}.lock`, () =>
        this.#git.run({
          cwd: ws.mirrorPath,
          args: ['update-ref', '--', `refs/remotes/origin/${ws.branch}`, sha],
          ceiling: dirname(ws.mirrorPath),
        }),
      )
      .catch(() => undefined);
    this.#opts.logger?.info('IDE branch pushed', { branch: ws.branch, sha, committed });
    return { branch: ws.branch, sha, committed };
  }

  /**
   * p18-project-bootstrap: the remote had no branches and no tags at the last fetch. `fetch --prune` mirrors the
   * remote's branches into `refs/remotes/origin/*` and its tags into `refs/tags/*` (local `rac/*` worktree branches live
   * under `refs/heads/*` and do not count).
   */
  async #remoteIsEmpty(mirror: string): Promise<boolean> {
    const r = await this.#git.run({
      cwd: mirror,
      args: ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/origin/', 'refs/tags/'],
      ceiling: dirname(mirror),
    });
    return r.stdout.trim() === '';
  }

  /**
   * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §2): the first commit of an empty repository's base
   * branch — an empty tree, no parent, a fixed message, the job's identity (nothing of the job or the repository is in
   * it, so no secret scan is needed). With `publish` it becomes `refs/heads/<baseRef>` on the remote with
   * `--force-with-lease=<ref>:` (created only while it still does not exist — never overwriting anything); when another
   * job created the branch meanwhile the lease refuses, the mirror is fetched again and that branch is the base. The
   * job's own work then goes through the ordinary attempt branch, verification and pull request onto this base.
   */
  async #bootstrapEmpty(
    mirror: string,
    repo: RepoUrl,
    baseRef: string,
    req: PrepareRequest,
    auth: GitAuthSource | undefined,
    refetch: () => Promise<unknown>,
  ): Promise<{ commit: string; how: 'pushed' | 'local' | 'existing' }> {
    const opts = req.emptyRemote;
    if (opts === undefined) throw new BaseRefNotFoundError(baseRef, true);
    const ceiling = dirname(mirror);
    const tree = (await this.#git.run({ cwd: mirror, args: ['mktree'], input: '', ceiling })).stdout.trim();
    const message = `Initial commit\n\nThe repository was empty. Remyral created this empty first commit of ${baseRef} so that the work of job ${req.jobId} can be reviewed as a pull request onto it.\n`;
    const commit = (
      await this.#git.run({
        cwd: mirror,
        args: ['commit-tree', '-F', '-', tree],
        input: message,
        config: [
          ['user.name', opts.author.name],
          ['user.email', opts.author.email],
        ],
        ceiling,
      })
    ).stdout.trim();
    if (!SHA.test(commit) || !SHA.test(tree))
      throw new WorkspaceError('could not create the empty first commit');
    if (!opts.publish) {
      this.#opts.logger?.info('empty repository: base starts from a local empty commit', {
        jobId: req.jobId,
        baseRef,
      });
      return { commit, how: 'local' };
    }
    const ref = `refs/heads/${baseRef}`;
    const result = await withGitAuth(auth, this.#authOpts('push', req.redactor, req.jobId), (fields) =>
      this.#git.run({
        cwd: mirror,
        args: [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-recurse-submodules',
          `--force-with-lease=${ref}:`,
          '--',
          repo.url,
          `${commit}:${ref}`,
        ],
        remote: repo,
        timeoutMs: this.#opts.networkTimeoutMs ?? 15 * 60_000,
        okCodes: [1],
        ceiling,
        ...fields,
      }),
    );
    const status = result.stdout.split('\n').find((l) => l.includes(`:${ref}`));
    if (result.code === 0 && status !== undefined && !status.startsWith('!')) {
      this.#opts.logger?.info('empty repository: created the first commit of the base branch', {
        jobId: req.jobId,
        baseRef,
        sha: commit,
      });
      return { commit, how: 'pushed' };
    }
    // Refused: most likely another job created the branch meanwhile (the lease says it exists now) — use it.
    await refetch();
    try {
      return { commit: await this.#resolveBase(mirror, baseRef, req.redactor), how: 'existing' };
    } catch (error) {
      if (!(error instanceof BaseRefNotFoundError)) throw error;
      const detail = (status ?? result.stderr).trim().slice(0, 300);
      throw new PushRejectedError(
        baseRef,
        /stale info|fetch first/.test(detail) ? 'stale-lease' : 'rejected',
        req.redactor === undefined ? detail : req.redactor.redact(detail),
      );
    }
  }

  /**
   * ADR-0026: the pinned head SHA must be a commit reachable from the fetched `refs/pull/<n>/head` (it is the tip,
   * or an ancestor when the PR moved on); otherwise the PR was force-pushed and the run is refused.
   */
  async #resolvePinned(
    mirror: string,
    pull: { number: number; headSha: string },
    redactor: Redactor | undefined,
  ): Promise<string> {
    const ref = `refs/remotes/pull/${String(pull.number)}/head`;
    const r = await this.#git.run({
      cwd: mirror,
      args: ['merge-base', '--is-ancestor', '--end-of-options', pull.headSha, ref],
      okCodes: [1, 128],
      ceiling: dirname(mirror),
      ...redactorField(redactor),
    });
    if (r.code !== 0) throw new PullRequestHeadMovedError(pull.number, pull.headSha);
    return pull.headSha;
  }

  /**
   * Pre-push secret scan of the commits of `ref` that are neither upstream nor reachable from the workspace's base
   * commit (p22-git-preflight: bounded to the attempt's own commits, streamed — see `scanLogArgs`).
   */
  async #scanUnpushed(
    base: Pick<GitCall, 'cwd' | 'ceiling' | 'redactor'>,
    ref: string,
    baseCommit: string,
    secrets: SecretSet | undefined,
  ): Promise<SecretFinding[]> {
    const scan = new GitLogScan(prePushScanner(secrets));
    await this.#git.run({
      ...base,
      args: scanLogArgs(ref, SHA.test(baseCommit) ? baseCommit : undefined),
      timeoutMs: LARGE_GIT_MS,
      onStdout: (chunk) => {
        scan.write(chunk);
      },
    });
    return scan.end();
  }

  /**
   * p22-git-preflight: removes the worker-owned refs of a cached clone that point at a missing object (`fatal: bad object
   * refs/heads/rac/…` on fetch: a worker killed while writing, a disk error). Only attempt branches (`refs/heads/rac/`),
   * the fetched remote branches and pull heads (`refs/remotes/`) and tags (`refs/tags/`, fetched again) — never an IDE
   * branch or anything else. One `cat-file --batch-check` decides which are broken; one `update-ref --stdin` deletes
   * them. Returns the removed refs.
   */
  async #pruneBrokenRefs(mirror: string): Promise<string[]> {
    const ceiling = dirname(mirror);
    const listed = await this.#git.run({
      cwd: mirror,
      args: ['for-each-ref', '--format=%(refname)', 'refs/heads/rac/', 'refs/remotes/', 'refs/tags/'],
      ceiling,
    });
    const refs = listed.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^refs\/(heads\/rac|remotes|tags)\/[^\s^~:?*[\\]+$/.test(l));
    if (refs.length === 0) return [];
    const checked = await this.#git.run({
      cwd: mirror,
      args: ['cat-file', '--batch-check=%(objecttype)'],
      input: `${refs.join('\n')}\n`,
      ceiling,
    });
    const answers = checked.stdout.split('\n');
    const broken = refs.filter((r, i) => answers[i]?.trim() === `${r} missing`);
    if (broken.length === 0) return [];
    await this.#git.run({
      cwd: mirror,
      args: ['update-ref', '--stdin'],
      input: broken.map((r) => `delete ${r}\n`).join(''),
      ceiling,
    });
    return broken;
  }

  /** p15-git-central: options of one authenticated network command (temp key dir, retry log). */
  #authOpts(purpose: 'fetch' | 'push', redactor: Redactor | undefined, jobId: string) {
    return {
      purpose,
      credDir: join(this.root, META, 'cred'),
      redactor,
      onRetry: (reason: string) => {
        this.#opts.logger?.warn('git credential refused by the remote; retrying once with a fresh one', {
          jobId,
          purpose,
          reason,
        });
      },
    };
  }

  async #initSubmodules(
    worktree: string,
    projectId: string,
    repo: RepoUrl,
    auth: GitAuthSource | undefined,
    redactor: Redactor | undefined,
    jobId: string,
  ): Promise<void> {
    if ((await lstat(join(worktree, '.gitmodules')).catch(() => null)) === null) return;
    const r = await this.#git.run({
      cwd: worktree,
      args: ['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.url$'],
      okCodes: [1],
      ceiling: dirname(worktree),
    });
    const urls = r.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf('\n') + 1));
    for (const raw of urls) {
      const resolved = resolveSubmoduleUrl(repo, raw);
      try {
        this.#allowlist.check(projectId, resolved);
      } catch (error) {
        if (error instanceof RepositoryNotAllowedError) {
          throw new RepositoryNotAllowedError(projectId, error.repository, `submodule: ${error.message}`);
        }
        throw error;
      }
    }
    if (urls.length === 0) return;
    // Non-recursive: nested .gitmodules would need the same check per level.
    await withGitAuth(auth, this.#authOpts('fetch', redactor, jobId), (fields) =>
      this.#git.run({
        cwd: worktree,
        args: ['submodule', 'update', '--init', '--no-recommend-shallow', '--'],
        remote: repo,
        timeoutMs: this.#opts.networkTimeoutMs ?? 15 * 60_000,
        ceiling: dirname(worktree),
        ...fields,
      }),
    );
  }

  async #removeWorktree(mirror: string, path: string, branch: string): Promise<void> {
    const ceiling = dirname(mirror);
    if ((await lstat(path).catch(() => null)) !== null) {
      if (!isInside(join(this.root, 'jobs'), path))
        throw new UnsafePathError(path, 'outside the jobs directory');
      // fs.rm does not follow symlinks; it removes links themselves.
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
    }
    if ((await lstat(mirror).catch(() => null)) === null) return;
    await this.#git.run({ cwd: mirror, args: ['worktree', 'prune'], ceiling });
    await this.#git.run({ cwd: mirror, args: ['branch', '-D', '--', branch], okCodes: [1], ceiling });
  }
}

/** baseRef from the job spec: a branch/tag name or a full commit sha. Never an option. */
export function validateBaseRef(baseRef: string): string {
  if (
    baseRef.length === 0 ||
    baseRef.length > 255 ||
    baseRef.startsWith('-') ||
    baseRef.startsWith('/') ||
    baseRef.endsWith('/') ||
    baseRef.endsWith('.lock') ||
    baseRef.includes('..') ||
    baseRef.includes('@{') ||
    baseRef.includes('//') ||
    hasControlChars(baseRef) ||
    /[\s~^:?*[\\]/.test(baseRef)
  ) {
    throw new InvalidWorkspaceIdError('baseRef', 'must be a valid branch/tag name or a full commit sha');
  }
  return baseRef;
}

function redactorField(redactor: Redactor | undefined): Pick<GitCall, 'redactor'> {
  return redactor === undefined ? {} : { redactor };
}

/** p15-git-central: removes per-command credential dirs older than `before` (ms epoch). Never throws. */
async function removeStaleCredDirs(dir: string, before: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (st !== null && st.mtimeMs < before)
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureRoot(root: string): Promise<void> {
  const st = await lstat(root).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (st === null) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return;
  }
  // The root itself may be a symlink chosen by the admin (e.g. /var → /private/var); its target must be a directory.
  const real = await realpath(root);
  await assertRealDir(real);
}

async function defaultFreeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return s.bavail * s.bsize;
}
