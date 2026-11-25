import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitExec, GitExecError } from './git-exec.js';
import { isAttemptBranch, isTargetBranch, MERGE_TRAILER_KEY, SHA, trailerValues } from './refs.js';
import {
  type BlobRead,
  type BranchUpdate,
  type CiStatus,
  type CommitInfo,
  type CommitRef,
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
  classifyText,
  isRepoPath,
} from './types.js';

export interface LocalGitProviderOptions {
  /** Remote URL (https/ssh; `file://` only with `allowFileUrls`). */
  readonly url: string;
  /** Directory for bare object caches (created 0700). */
  readonly cacheDir: string;
  /** Tests and local development only. */
  readonly allowFileUrls?: boolean;
  readonly gitBinary?: string;
  /** Identity of merge commits the master creates. */
  readonly committer?: { readonly name: string; readonly email: string };
  /** CI status source (plain git remotes have none; tests inject one). */
  readonly checks?: (sha: string) => Promise<CiStatus>;
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
}

const MAX_COMMITS = 250;
const MAX_FILES = 300;

/**
 * Plain git remote (self-hosted, and the end-to-end test provider). Reads go to a bare object cache on
 * the master — objects only: no worktree, no checkout, no hooks, no filters, attributes from the empty
 * tree (git-exec.ts). Ref state is always read from the remote (`ls-remote`), objects are fetched on
 * demand. Merges are computed with `git merge-tree` and published with a plain (never forced) push of a
 * commit whose parent is the target's current head, so a target that moved meanwhile rejects the push.
 */
export class LocalGitProvider implements GitProvider {
  readonly kind = 'git' as const;
  readonly #git: GitExec;
  readonly #opts: LocalGitProviderOptions;
  readonly #cache: string;
  #queue: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | null = null;

  constructor(opts: LocalGitProviderOptions) {
    const url = opts.url;
    if (!/^(https|ssh):\/\//.test(url) && !(opts.allowFileUrls === true && url.startsWith('file://'))) {
      throw new TypeError('plain git provider: only https/ssh repository URLs');
    }
    this.#opts = opts;
    this.#git = new GitExec({
      allowFile: opts.allowFileUrls === true,
      ...(opts.gitBinary === undefined ? {} : { binary: opts.gitBinary }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    this.#cache = join(opts.cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.git`);
  }

  /** Serialises cache mutations of this provider instance. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #ensureCache(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#opts.cacheDir, { recursive: true, mode: 0o700 });
      const template = join(this.#opts.cacheDir, '.template-empty');
      await mkdir(template, { recursive: true, mode: 0o700 });
      if ((await readdir(template)).length > 0)
        throw new ProviderError('template directory not empty', false);
      const st = await lstat(this.#cache).catch(() => null);
      if (st === null) {
        await this.#git.run({
          cwd: this.#opts.cacheDir,
          args: ['init', '--bare', '--quiet', `--template=${template}`, '--', this.#cache],
          ceiling: this.#opts.cacheDir,
        });
        await chmod(this.#cache, 0o700);
      } else if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new ProviderError('git cache path is not a directory', false);
      }
    })();
    try {
      await this.#ready;
    } catch (err) {
      this.#ready = null;
      throw err;
    }
  }

  async #run(
    args: readonly string[],
    extra: { okCodes?: number[]; input?: string; env?: Record<string, string> } = {},
  ) {
    await this.#ensureCache();
    try {
      return await this.#git.run({
        cwd: this.#cache,
        args,
        ceiling: this.#opts.cacheDir,
        ...(extra.okCodes === undefined ? {} : { okCodes: extra.okCodes }),
        ...(extra.input === undefined ? {} : { input: extra.input }),
        ...(extra.env === undefined ? {} : { env: extra.env }),
      });
    } catch (err) {
      if (err instanceof GitExecError) {
        const network = ['ls-remote', 'fetch', 'push'].includes(err.subcommand);
        throw new ProviderError(`${err.message}: ${err.stderr.trim().slice(0, 300)}`, network);
      }
      throw err;
    }
  }

  async #has(sha: string): Promise<boolean> {
    const r = await this.#run(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`], {
      okCodes: [1, 128],
    });
    return r.code === 0;
  }

  /** Makes sure the commits are in the cache (one fetch of all heads when any is missing). */
  async #ensure(shas: readonly string[]): Promise<void> {
    for (const s of shas) if (!SHA.test(s)) throw new ProviderError('invalid sha', false);
    let missing = false;
    for (const s of shas) if (!(await this.#has(s))) missing = true;
    if (!missing) return;
    // Not under #locked: merge/delete hold that queue while they call #ensure. Concurrent fetches into
    // the same refs are serialised by git's own ref locks (a loser fails as a transient ProviderError).
    await this.#run([
      'fetch',
      '--quiet',
      '--no-tags',
      '--prune',
      '--',
      this.#opts.url,
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    for (const s of shas) {
      if (!(await this.#has(s)))
        throw new ProviderError(`commit ${s.slice(0, 12)} not found on the remote`, false);
    }
  }

  async branchHead(branch: string): Promise<string | null> {
    const ref = `refs/heads/${branch}`;
    const r = await this.#run(['ls-remote', '--heads', '--end-of-options', this.#opts.url, ref]);
    for (const line of r.stdout.split('\n')) {
      const [sha, name] = line.split('\t');
      if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
    }
    return null;
  }

  async commit(sha: string): Promise<CommitInfo> {
    await this.#ensure([sha]);
    const r = await this.#run(['cat-file', 'commit', sha]);
    return parseCommitObject(sha, r.stdout);
  }

  async #isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.#run(['merge-base', '--is-ancestor', a, b], { okCodes: [1] });
    return r.code === 0;
  }

  async compare(base: string, head: string): Promise<Comparison> {
    await this.#ensure([base, head]);
    const mb = await this.#run(['merge-base', base, head], { okCodes: [1] });
    const mergeBase = mb.stdout.trim();
    let status: Comparison['status'];
    if (base === head) status = 'identical';
    else if (await this.#isAncestor(base, head)) status = 'ahead';
    else if (await this.#isAncestor(head, base)) status = 'behind';
    else status = 'diverged';
    const log = await this.#run([
      'log',
      `--max-count=${String(MAX_COMMITS + 1)}`,
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x00',
      `${base}..${head}`,
    ]);
    const commits = parseLog(log.stdout).reverse();
    const files = mergeBase === '' ? [] : await this.#diffFiles(mergeBase, head);
    return {
      status,
      mergeBase,
      commits: commits.slice(-MAX_COMMITS),
      files: files.slice(0, MAX_FILES),
      truncated: commits.length > MAX_COMMITS || files.length > MAX_FILES,
    };
  }

  async patch(base: string, head: string, maxBytes: number): Promise<PatchText> {
    if (!SHA.test(base) || !SHA.test(head)) throw new ProviderError('invalid sha', false);
    await this.#ensure([base, head]);
    const mb = (await this.#run(['merge-base', base, head], { okCodes: [1] })).stdout.trim();
    const r = await this.#run([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-M',
      SHA.test(mb) ? mb : base,
      head,
    ]);
    return capPatch(r.stdout, maxBytes);
  }

  /** p19-ide W1: the object type at `sha:path` (`tree`, `blob`, `commit`) or null when there is none. */
  async #typeAt(sha: string, path: string): Promise<string | null> {
    const r = await this.#run(
      ['cat-file', '-t', '--end-of-options', path === '' ? `${sha}^{tree}` : `${sha}:${path}`],
      {
        okCodes: [1, 128],
      },
    );
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** p19-ide W1: `git ls-tree --long -z` of a directory at a commit (objects only, nothing checked out). */
  async tree(sha: string, path: string): Promise<TreeListing | null> {
    if (!SHA.test(sha) || !isRepoPath(path, true)) throw new ProviderError('invalid sha or path', false);
    await this.#ensure([sha]);
    if ((await this.#typeAt(sha, path)) !== 'tree') return null;
    const r = await this.#run([
      'ls-tree',
      '-z',
      '--long',
      '--end-of-options',
      path === '' ? sha : `${sha}:${path}`,
    ]);
    const entries: TreeEntry[] = [];
    for (const rec of r.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode = '', type = '', , size = '-'] = rec.slice(0, tab).split(/\s+/);
      const name = rec.slice(tab + 1);
      const full = path === '' ? name : `${path}/${name}`;
      if (!isRepoPath(full)) continue;
      const kind: TreeEntry['kind'] =
        type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
      entries.push({
        name,
        path: full,
        kind,
        size: kind === 'file' && /^\d+$/.test(size) ? Number(size) : null,
      });
      if (entries.length >= 5000) return { entries, truncated: true };
    }
    return { entries, truncated: false };
  }

  /** p19-ide W1: `git cat-file -s` then `git cat-file blob` (only when within `maxBytes`). */
  async blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    if (!SHA.test(sha) || !isRepoPath(path)) throw new ProviderError('invalid sha or path', false);
    await this.#ensure([sha]);
    if ((await this.#typeAt(sha, path)) !== 'blob') return null;
    const size = Number(
      (await this.#run(['cat-file', '-s', '--end-of-options', `${sha}:${path}`])).stdout.trim(),
    );
    if (!Number.isFinite(size)) return null;
    if (size > maxBytes) return { state: 'too_large', size };
    const r = await this.#run(['cat-file', 'blob', '--end-of-options', `${sha}:${path}`]);
    return classifyText(r.stdout, size, maxBytes);
  }

  async #diffFiles(from: string, to: string): Promise<FileChange[]> {
    const names = await this.#run([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '-M',
      from,
      to,
    ]);
    const nums = await this.#run([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      '-M',
      from,
      to,
    ]);
    const counts = new Map<string, { a: number; d: number }>();
    const t = nums.stdout.split('\0');
    for (let i = 0; i < t.length; i++) {
      const head = t[i] ?? '';
      if (head === '') continue;
      const [a, d, p] = head.split('\t');
      let path = p ?? '';
      if (path === '') {
        // rename: "<a>\t<d>\t\0old\0new\0"
        i += 2;
        path = t[i] ?? '';
      }
      counts.set(path, { a: a === '-' ? 0 : Number(a), d: d === '-' ? 0 : Number(d) });
    }
    const out: FileChange[] = [];
    const s = names.stdout.split('\0');
    for (let i = 0; i < s.length; i++) {
      const code = s[i] ?? '';
      if (code === '') continue;
      const kind = code[0];
      if (kind === 'R' || kind === 'C') {
        const prev = s[i + 1] ?? '';
        const path = s[i + 2] ?? '';
        i += 2;
        const c = counts.get(path);
        out.push({ path, previousPath: prev, status: 'renamed', additions: c?.a ?? 0, deletions: c?.d ?? 0 });
        continue;
      }
      const path = s[i + 1] ?? '';
      i += 1;
      const c = counts.get(path);
      out.push({
        path,
        status: kind === 'A' ? 'added' : kind === 'D' ? 'removed' : kind === 'M' ? 'modified' : 'other',
        additions: c?.a ?? 0,
        deletions: c?.d ?? 0,
      });
    }
    return out;
  }

  async #commitsTouching(range: string, files: readonly string[]): Promise<CommitRef[]> {
    if (files.length === 0) return [];
    const r = await this.#run([
      'log',
      '--max-count=50',
      '--format=%H%x00%s%x00',
      range,
      '--',
      ...files.slice(0, 100),
    ]);
    const parts = r.stdout.split('\0');
    const out: CommitRef[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = (parts[i] ?? '').trim();
      if (SHA.test(sha)) out.push({ sha, subject: (parts[i + 1] ?? '').slice(0, 200) });
    }
    return out;
  }

  /** `git merge-tree --write-tree`: exit 0 = clean (first line = tree), exit 1 = conflicts. */
  async #mergeTree(base: string, head: string): Promise<{ clean: boolean; tree: string; files: string[] }> {
    const r = await this.#run(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, head],
      {
        okCodes: [1],
      },
    );
    const parts = r.stdout.split('\0').filter((p) => p !== '');
    const tree = (parts[0] ?? '').trim();
    if (!SHA.test(tree)) throw new ProviderError('merge-tree returned no tree', false);
    return { clean: r.code === 0, tree, files: [...new Set(parts.slice(1))] };
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
    await this.#ensure([base, input.headSha, input.baseAtStart]);
    if (!(await this.#isAncestor(input.baseAtStart, base))) {
      return {
        state: 'base_moved',
        baseSha: base,
        headSha: input.headSha,
        reason: `${input.targetBranch} was rewritten: the base at job start is no longer in its history`,
      };
    }
    if (await this.#isAncestor(input.headSha, base))
      return { state: 'clean', baseSha: base, headSha: input.headSha };
    const m = await this.#mergeTree(base, input.headSha);
    if (m.clean) return { state: 'clean', baseSha: base, headSha: input.headSha };
    const mb = (await this.#run(['merge-base', base, input.headSha], { okCodes: [1] })).stdout.trim();
    return {
      state: 'conflicts',
      baseSha: base,
      headSha: input.headSha,
      files: m.files.slice(0, MAX_FILES),
      headCommits: SHA.test(mb) ? await this.#commitsTouching(`${mb}..${input.headSha}`, m.files) : [],
      baseCommits: SHA.test(mb) ? await this.#commitsTouching(`${mb}..${base}`, m.files) : [],
      precision: 'exact',
    };
  }

  ensurePullRequest(): Promise<PullRequestRef | null> {
    return Promise.resolve(null);
  }

  checks(sha: string): Promise<CiStatus> {
    return this.#opts.checks?.(sha) ?? Promise.resolve({ state: 'none', checks: [] });
  }

  merge(input: MergeInput): Promise<MergeOutcome> {
    return this.#locked(async () => {
      const head = await this.branchHead(input.headBranch);
      if (head !== input.headSha) {
        return {
          merged: false,
          reason: 'head_moved',
          detail: `${input.headBranch} is at ${head ?? '(deleted)'}, approval was for ${input.headSha}`,
        };
      }
      const base = await this.branchHead(input.targetBranch);
      if (base === null)
        return { merged: false, reason: 'base_moved', detail: `${input.targetBranch} is missing` };
      await this.#ensure([base, input.headSha]);
      if (await this.#isAncestor(input.headSha, base)) return { merged: true, sha: base };
      const m = await this.#mergeTree(base, input.headSha);
      if (!m.clean) {
        return {
          merged: false,
          reason: 'conflicts',
          detail: `conflicts in ${m.files.slice(0, 20).join(', ')}`,
        };
      }
      const who = input.committer ??
        this.#opts.committer ?? { name: 'Remyral Git Flow', email: 'gitflow@remyral.invalid' };
      const date = (this.#opts.clock?.() ?? new Date()).toISOString();
      const env = {
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
        GIT_COMMITTER_DATE: date,
      };
      const parents = input.method === 'squash' ? ['-p', base] : ['-p', base, '-p', input.headSha];
      const created = await this.#run(['commit-tree', m.tree, ...parents, '-F', '-'], {
        input: `${input.title}\n\n${input.message}`,
        env,
      });
      const sha = created.stdout.trim();
      if (!SHA.test(sha)) throw new ProviderError('commit-tree returned no sha', false);
      // Plain push: never forced. The new commit's first parent is `base`, so the update is a fast-forward
      // only while the target still points at `base`; if it moved, the remote rejects it.
      const push = await this.#run(
        [
          'push',
          '--porcelain',
          '--no-verify',
          '--',
          this.#opts.url,
          `${sha}:refs/heads/${input.targetBranch}`,
        ],
        { okCodes: [1] },
      );
      const status = push.stdout.split('\n').find((l) => l.includes(`refs/heads/${input.targetBranch}`));
      if (push.code !== 0 || status === undefined || status.startsWith('!')) {
        return {
          merged: false,
          reason: 'base_moved',
          detail: `push to ${input.targetBranch} rejected: ${(status ?? push.stderr).trim().slice(0, 200)}`,
        };
      }
      return { merged: true, sha };
    });
  }

  async findMerge(targetBranch: string, mergeRequestId: string): Promise<string | null> {
    const head = await this.branchHead(targetBranch);
    if (head === null) return null;
    await this.#ensure([head]);
    const log = await this.#run([
      'log',
      '--first-parent',
      '--max-count=20',
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x00',
      head,
    ]);
    for (const c of parseLog(log.stdout)) {
      if (trailerValues(c.message, MERGE_TRAILER_KEY).includes(mergeRequestId)) return c.sha;
    }
    return null;
  }

  /** p11-merge-pipeline: create / fast-forward a branch with a lease on the expected value (never forced). */
  updateBranch(branch: string, sha: string, expected: string | null): Promise<BranchUpdate> {
    if (!SHA.test(sha) || (expected !== null && !SHA.test(expected))) {
      throw new ProviderError('invalid sha', false);
    }
    return this.#locked(async () => {
      const head = await this.branchHead(branch);
      if (head === sha) return 'updated';
      if (head !== expected) return 'moved';
      await this.#ensure(expected === null ? [sha] : [sha, expected]);
      if (expected !== null && !(await this.#isAncestor(expected, sha))) return 'not_fast_forward';
      const ref = `refs/heads/${branch}`;
      const push = await this.#run(
        [
          'push',
          '--porcelain',
          '--no-verify',
          `--force-with-lease=${ref}:${expected ?? ''}`,
          '--',
          this.#opts.url,
          `${sha}:${ref}`,
        ],
        { okCodes: [1] },
      );
      const status = push.stdout.split('\n').find((l) => l.includes(ref));
      if (push.code !== 0 || status === undefined || status.startsWith('!')) return 'moved';
      return 'updated';
    });
  }

  /**
   * p15-workspace-retention: the files as one commit on top of `parent` in the cache (a temporary index: `read-tree`
   * of the parent, `hash-object -w` + `update-index --cacheinfo` per file, `write-tree`, `commit-tree`). Nothing is
   * pushed here: {@link updateBranch} pushes the commit.
   */
  commitFiles(input: {
    readonly parent: string | null;
    readonly files: readonly { readonly path: string; readonly content: Buffer }[];
    readonly message: string;
    readonly author?: { readonly name: string; readonly email: string };
  }): Promise<string> {
    if (input.parent !== null && !SHA.test(input.parent)) throw new ProviderError('invalid sha', false);
    return this.#locked(async () => {
      if (input.parent !== null) await this.#ensure([input.parent]);
      const tmp = await mkdtemp(join(this.#opts.cacheDir, 'files-'));
      try {
        const env = { GIT_INDEX_FILE: join(tmp, 'index') };
        if (input.parent !== null) await this.#run(['read-tree', `${input.parent}^{tree}`], { env });
        for (const [i, f] of input.files.entries()) {
          const blob = join(tmp, `b${String(i)}`);
          await writeFile(blob, f.content);
          const h = (await this.#run(['hash-object', '-w', '--', blob])).stdout.trim();
          await this.#run(['update-index', '--add', '--cacheinfo', `100644,${h},${f.path}`], { env });
        }
        const tree = (await this.#run(['write-tree'], { env })).stdout.trim();
        const who = input.author ??
          this.#opts.committer ?? { name: 'Remyral Git Flow', email: 'gitflow@remyral.invalid' };
        const date = (this.#opts.clock?.() ?? new Date()).toISOString();
        const created = await this.#run(
          ['commit-tree', tree, ...(input.parent === null ? [] : ['-p', input.parent]), '-F', '-'],
          {
            input: input.message,
            env: {
              GIT_AUTHOR_NAME: who.name,
              GIT_AUTHOR_EMAIL: who.email,
              GIT_AUTHOR_DATE: date,
              GIT_COMMITTER_NAME: who.name,
              GIT_COMMITTER_EMAIL: who.email,
              GIT_COMMITTER_DATE: date,
            },
          },
        );
        const sha = created.stdout.trim();
        if (!SHA.test(sha)) throw new ProviderError('commit-tree returned no sha', false);
        return sha;
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /** p18-project-bootstrap: the remote has no branch (`ls-remote --heads` lists nothing). */
  async isEmpty(): Promise<boolean> {
    const r = await this.#run(['ls-remote', '--heads', '--end-of-options', this.#opts.url]);
    return r.stdout.trim() === '';
  }

  /** p15-auto-mode: the remote's `HEAD` branch (`ls-remote --symref`). */
  async defaultBranch(): Promise<string | null> {
    const r = await this.#run(['ls-remote', '--symref', '--end-of-options', this.#opts.url, 'HEAD']);
    for (const line of r.stdout.split('\n')) {
      const m = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line.trim());
      if (m?.[1] !== undefined && isTargetBranch(m[1])) return m[1];
    }
    return null;
  }

  /**
   * p15-auto-mode: the attempt's changes (head vs. its merge base with `onto`) as one commit on `onto`, computed with
   * `git merge-tree` in the object cache (no checkout), pushed to the attempt branch with a lease on `headSha`.
   */
  rebaseOnto(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly onto: string;
  }): Promise<RebaseOutcome> {
    if (!isAttemptBranch(input.branch)) throw new ProviderError('only attempt branches are rebased', false);
    if (!SHA.test(input.headSha) || !SHA.test(input.onto)) throw new ProviderError('invalid sha', false);
    return this.#locked(async () => {
      const head = await this.branchHead(input.branch);
      if (head !== input.headSha)
        return { state: 'moved', detail: `${input.branch} is at ${head ?? '(deleted)'}` };
      await this.#ensure([input.headSha, input.onto]);
      if (await this.#isAncestor(input.onto, input.headSha)) return { state: 'rebased', sha: input.headSha };
      const m = await this.#mergeTree(input.onto, input.headSha);
      if (!m.clean) return { state: 'conflicts', files: m.files.slice(0, MAX_FILES) };
      const original = parseCommitObject(
        input.headSha,
        (await this.#run(['cat-file', 'commit', input.headSha])).stdout,
      );
      const who = this.#opts.committer ?? { name: 'Remyral Git Flow', email: 'gitflow@remyral.invalid' };
      const date = (this.#opts.clock?.() ?? new Date()).toISOString();
      const created = await this.#run(['commit-tree', m.tree, '-p', input.onto, '-F', '-'], {
        input: original.message,
        env: {
          GIT_AUTHOR_NAME: original.author.name || who.name,
          GIT_AUTHOR_EMAIL: original.author.email || who.email,
          GIT_AUTHOR_DATE: original.author.date ?? date,
          GIT_COMMITTER_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
          GIT_COMMITTER_DATE: date,
        },
      });
      const sha = created.stdout.trim();
      if (!SHA.test(sha)) throw new ProviderError('commit-tree returned no sha', false);
      const ref = `refs/heads/${input.branch}`;
      const push = await this.#run(
        [
          'push',
          '--porcelain',
          '--no-verify',
          `--force-with-lease=${ref}:${input.headSha}`,
          '--',
          this.#opts.url,
          `${sha}:${ref}`,
        ],
        { okCodes: [1] },
      );
      const status = push.stdout.split('\n').find((l) => l.includes(ref));
      if (push.code !== 0 || status === undefined || status.startsWith('!'))
        return { state: 'moved', detail: `push to ${input.branch} rejected` };
      return { state: 'rebased', sha };
    });
  }

  async deleteBranch(branch: string, expectedSha: string): Promise<'deleted' | 'moved' | 'absent'> {
    if (!SHA.test(expectedSha)) throw new ProviderError('invalid sha', false);
    return this.#locked(async () => {
      const head = await this.branchHead(branch);
      if (head === null) return 'absent';
      if (head !== expectedSha) return 'moved';
      const ref = `refs/heads/${branch}`;
      const push = await this.#run(
        [
          'push',
          '--porcelain',
          '--no-verify',
          `--force-with-lease=${ref}:${expectedSha}`,
          '--',
          this.#opts.url,
          `:${ref}`,
        ],
        { okCodes: [1] },
      );
      const status = push.stdout.split('\n').find((l) => l.includes(ref));
      if (push.code !== 0 || status === undefined || status.startsWith('!')) return 'moved';
      return 'deleted';
    });
  }
}

/** `git cat-file commit` output → CommitInfo. */
export function parseCommitObject(sha: string, raw: string): CommitInfo {
  const split = raw.indexOf('\n\n');
  const header = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? '' : raw.slice(split + 2);
  const parents: string[] = [];
  let author = { name: '', email: '', date: null as string | null };
  for (const line of header.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (m) {
        author = {
          name: (m[1] ?? '').slice(0, 200),
          email: (m[2] ?? '').slice(0, 200),
          date: new Date(Number(m[3]) * 1000).toISOString(),
        };
      }
    }
  }
  return { sha, message, parents, author };
}

/** `git log --format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x00` → commits (newest first). */
export function parseLog(raw: string): CommitInfo[] {
  const t = raw.split('\0');
  const out: CommitInfo[] = [];
  for (let i = 0; i + 5 < t.length; i += 6) {
    const sha = (t[i] ?? '').trim();
    if (!SHA.test(sha)) break;
    out.push({
      sha,
      parents: (t[i + 1] ?? '').split(' ').filter((p) => SHA.test(p)),
      author: {
        name: (t[i + 2] ?? '').slice(0, 200),
        email: (t[i + 3] ?? '').slice(0, 200),
        date: t[i + 4] === '' ? null : (t[i + 4] ?? null),
      },
      message: t[i + 5] ?? '',
    });
  }
  return out;
}
