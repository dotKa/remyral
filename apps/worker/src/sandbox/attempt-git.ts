import { createHash } from 'node:crypto';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertSafeSegment } from '../workspace/ids.js';
import type { GitRunner } from '../workspace/git.js';
import type { Workspace } from '../workspace/manager.js';
import { assertRealInside, ensureDirInside, isInside } from '../workspace/paths.js';
import { GitMetadataTamperedError, SandboxRequestError } from './errors.js';

/**
 * Per-attempt git view (closes the T-SBX-4 gap flagged in p3-workspace.md).
 *
 * The workspace manager's worktree shares the mirror's objects, refs and config.
 * An agent that can write there could move another attempt's `rac/*` branch,
 * plant config (`core.sshCommand`, filter drivers, `url.*.insteadOf`) that the
 * worker's own later `git add`/`push` would honour, or repoint the worktree's
 * `.git` file at a directory it controls. So the agent never gets write access
 * to *any* git metadata the worker later executes git against:
 *
 *  - The runtime gets its own git dir `<root>/sandboxes/<job>/<attempt>/git`:
 *    HEAD → `refs/heads/rac/<job>/<attempt>` at the base commit, an index of the
 *    base tree, and `objects/info/alternates` → the mirror's object store, which
 *    is mounted/allowed **read-only**. The agent may commit there freely; its
 *    commits are scratch.
 *  - The trusted state (mirror + `worktrees/<id>` + the worktree's `.git` file)
 *    is never mounted (container) or is write-denied (Seatbelt). The worker
 *    records the result with its own `WorkspaceManager.commit()` — `git add -A`
 *    of the final files plus the attempt trailer — so the result is the working
 *    tree, never refs or config the agent wrote.
 *  - Defence in depth: `snapshotTrustedGit()` before the run and
 *    `assertTrustedGitUnchanged()` after it refuse commit/push if the worktree's
 *    `.git` file, the mirror config, the worktree metadata or this attempt's
 *    branch changed (a profile without filesystem confinement cannot prevent it,
 *    only detect it).
 *
 * Alternative considered: `git clone --shared` per attempt with push from the
 * clone. Rejected because the worker would then run push/secret-scan inside a
 * repository whose config the agent controls.
 */

/** Paths inside a job container. */
export const CONTAINER_WORKSPACE = '/workspace';
export const CONTAINER_GIT_DIR = '/remyral/git';

export interface AttemptGitView {
  /** `<root>/sandboxes/<jobId>/<attemptId>` — per-attempt scratch owned by the sandbox. */
  readonly sandboxDir: string;
  /** Agent-writable git dir (host path). */
  readonly gitDir: string;
  /** Mirror object store (read-only for the agent; the alternates target, same path in containers). */
  readonly mirrorObjects: string;
  /** File with `gitdir: /remyral/git`, bind-mounted read-only over `<worktree>/.git` in containers. */
  readonly containerDotGit: string;
  readonly branch: string;
  /** Environment for host profiles: the runtime's git uses the per-attempt dir. */
  readonly hostEnv: Readonly<Record<string, string>>;
}

export async function createAttemptGitView(opts: {
  root: string;
  ws: Workspace;
  git: GitRunner;
}): Promise<AttemptGitView> {
  const { root, ws, git } = opts;
  assertSafeSegment('jobId', ws.jobId);
  assertSafeSegment('attemptId', ws.attemptId);
  await assertRealInside(root, ws.path);
  const jobDir = await ensureDirInside(root, ['sandboxes', ws.jobId]);
  const sandboxDir = join(jobDir, ws.attemptId);
  if ((await lstat(sandboxDir).catch(() => null)) !== null) {
    throw new SandboxRequestError('attempt', `sandbox dir already exists: ${sandboxDir}`);
  }
  await ensureDirInside(root, ['sandboxes', ws.jobId, ws.attemptId]);
  const gitDir = join(sandboxDir, 'git');
  const mirrorObjects = join(ws.mirrorPath, 'objects');
  try {
    await git.run({
      cwd: sandboxDir,
      args: ['init', '--quiet', '--bare', '--template=', '--', gitDir],
      ceiling: sandboxDir,
    });
    const base = { cwd: gitDir, ceiling: sandboxDir };
    await writeFile(join(gitDir, 'objects', 'info', 'alternates'), `${mirrorObjects}\n`, { mode: 0o600 });
    await git.run({ ...base, args: ['update-ref', `refs/heads/${ws.branch}`, ws.baseCommit] });
    await git.run({ ...base, args: ['symbolic-ref', 'HEAD', `refs/heads/${ws.branch}`] });
    await git.run({ ...base, args: ['read-tree', ws.baseCommit] });
    await git.run({ ...base, args: ['config', 'core.bare', 'false'] });
    await git.run({ ...base, args: ['config', 'gc.auto', '0'] });
    const containerDotGit = join(sandboxDir, 'dotgit');
    await writeFile(containerDotGit, `gitdir: ${CONTAINER_GIT_DIR}\n`, { mode: 0o644 });
    return {
      sandboxDir,
      gitDir,
      mirrorObjects,
      containerDotGit,
      branch: ws.branch,
      hostEnv: { GIT_DIR: gitDir, GIT_WORK_TREE: ws.path },
    };
  } catch (error) {
    await rm(sandboxDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * p10-approval-pause (ADR-0036): re-opens the kept git view of a paused attempt (its sandbox dir survived the pause
 * with the agent's scratch git dir). The dir must be a real directory at `<root>/sandboxes/<job>/<attempt>` with a
 * git dir whose alternates still point at the attempt's mirror.
 */
export async function openAttemptGitView(opts: { root: string; ws: Workspace }): Promise<AttemptGitView> {
  const { root, ws } = opts;
  assertSafeSegment('jobId', ws.jobId);
  assertSafeSegment('attemptId', ws.attemptId);
  await assertRealInside(root, ws.path);
  const sandboxDir = join(root, 'sandboxes', ws.jobId, ws.attemptId);
  const st = await lstat(sandboxDir).catch(() => null);
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
    throw new SandboxRequestError('attempt', `the kept sandbox dir is missing: ${sandboxDir}`);
  }
  const real = await assertRealInside(root, sandboxDir);
  if (real !== sandboxDir || !isInside(join(root, 'sandboxes'), real)) {
    throw new SandboxRequestError('attempt', `the kept sandbox dir resolves elsewhere: ${sandboxDir}`);
  }
  const gitDir = join(sandboxDir, 'git');
  const mirrorObjects = join(ws.mirrorPath, 'objects');
  const alternates = (await readFile(join(gitDir, 'objects', 'info', 'alternates'), 'utf8').catch(() => ''))
    .split('\n')[0]
    ?.trim();
  if (alternates !== mirrorObjects) {
    throw new SandboxRequestError('attempt', 'the kept git view does not belong to this attempt');
  }
  return {
    sandboxDir,
    gitDir,
    mirrorObjects,
    containerDotGit: join(sandboxDir, 'dotgit'),
    branch: ws.branch,
    hostEnv: { GIT_DIR: gitDir, GIT_WORK_TREE: ws.path },
  };
}

/** Removes the per-attempt sandbox dir (scratch git dir, tmp, home). */
export async function disposeAttemptGitView(root: string, view: AttemptGitView): Promise<void> {
  const real = await assertRealInside(root, view.sandboxDir).catch(() => null);
  if (real === null) return;
  if (!isInside(join(root, 'sandboxes'), real)) return;
  await rm(real, { recursive: true, force: true });
  await rm(dirname(real), { recursive: false }).catch(() => undefined);
}

export interface TrustedGitSnapshot {
  readonly worktree: string;
  readonly entries: Readonly<Record<string, string>>;
}

async function digest(path: string): Promise<string> {
  const st = await lstat(path).catch(() => null);
  if (st === null) return 'absent';
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isFile()) return `type:${st.isDirectory() ? 'dir' : 'other'}`;
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Hashes the git metadata the worker trusts for this attempt: the worktree's
 * `.git` file, the mirror config, this worktree's metadata files and this
 * attempt's branch ref.
 */
export async function snapshotTrustedGit(ws: Workspace): Promise<TrustedGitSnapshot> {
  const dotGit = join(ws.path, '.git');
  const content = (await readFile(dotGit, 'utf8').catch(() => '')).trim();
  const m = /^gitdir: (.+)$/.exec(content);
  if (m?.[1] === undefined) throw new GitMetadataTamperedError([dotGit]);
  const wtMeta = isAbsolute(m[1]) ? m[1] : resolve(ws.path, m[1]);
  if (!isInside(join(ws.mirrorPath, 'worktrees'), wtMeta)) throw new GitMetadataTamperedError([dotGit]);
  const files = [
    dotGit,
    join(ws.mirrorPath, 'config'),
    join(ws.mirrorPath, 'config.worktree'),
    join(ws.mirrorPath, 'commondir'),
    join(ws.mirrorPath, 'info', 'attributes'),
    join(wtMeta, 'config.worktree'),
    join(wtMeta, 'commondir'),
    join(wtMeta, 'gitdir'),
    join(wtMeta, 'HEAD'),
    join(ws.mirrorPath, 'refs', 'heads', ...ws.branch.split('/')),
  ];
  const entries: Record<string, string> = {};
  for (const f of files) entries[f] = await digest(f);
  return { worktree: ws.path, entries };
}

export async function assertTrustedGitUnchanged(snapshot: TrustedGitSnapshot): Promise<void> {
  const changed: string[] = [];
  for (const [path, before] of Object.entries(snapshot.entries)) {
    if ((await digest(path)) !== before) changed.push(path);
  }
  if (changed.length > 0) throw new GitMetadataTamperedError(changed);
}
