import { execFileSync } from 'node:child_process';
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTrustedGitUnchanged,
  createAttemptGitView,
  disposeAttemptGitView,
  snapshotTrustedGit,
} from '../src/sandbox/attempt-git.js';
import { GitMetadataTamperedError } from '../src/sandbox/errors.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, git } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

const T = { timeout: 120_000 };

/** git as the *agent* would run it: inside the worktree with the view's env. */
function agentGit(cwd: string, env: Readonly<Record<string, string>>, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      ...env,
    },
  }).trim();
}

async function setup() {
  const dir = await realpath(await tempDir('rw-sbx-git-'));
  const origin = await createOrigin(dir, 'origin', { 'README.md': 'hello\n', 'src/a.txt': 'a\n' });
  const manager = await WorkspaceManager.create({
    root: join(dir, 'root'),
    projects: { proj: [origin.url] },
    allowFileUrls: true,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
  });
  const prepare = (attemptId: string) =>
    manager.prepare({
      projectId: 'proj',
      jobId: 'job1',
      attemptId,
      epoch: 1,
      repository: { url: origin.url, baseRef: 'main' },
    });
  return { dir, origin, manager, prepare };
}

describe.skipIf(isWindows)('per-attempt git view (T-SBX-4)', T, () => {
  it('gives the agent its own git dir: commits land there, never in the shared mirror', async () => {
    const { manager, prepare } = await setup();
    const ws = await prepare('a1');
    const other = await prepare('a2');
    const snapshot = await snapshotTrustedGit(ws);
    const view = await createAttemptGitView({ root: manager.root, ws, git: manager.git });

    expect(view.gitDir.startsWith(join(manager.root, 'sandboxes', 'job1', 'a1'))).toBe(true);
    expect(await readFile(join(view.gitDir, 'objects', 'info', 'alternates'), 'utf8')).toBe(
      `${ws.mirrorPath}/objects\n`,
    );
    expect(await readFile(view.containerDotGit, 'utf8')).toBe('gitdir: /remyral/git\n');
    // Clean status from a subdirectory too (GIT_WORK_TREE pins the root).
    expect(agentGit(join(ws.path, 'src'), view.hostEnv, ['status', '--porcelain'])).toBe('');
    expect(agentGit(ws.path, view.hostEnv, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(ws.branch);

    await writeFile(join(ws.path, 'new.txt'), 'agent work\n');
    agentGit(ws.path, view.hostEnv, ['add', '-A']);
    agentGit(ws.path, view.hostEnv, ['commit', '-q', '-m', 'agent commit']);
    const agentSha = agentGit(ws.path, view.hostEnv, ['rev-parse', 'HEAD']);
    // The agent even tries to move the other attempt's branch — only in its own git dir.
    agentGit(ws.path, view.hostEnv, ['update-ref', `refs/heads/${other.branch}`, agentSha]);

    // Mirror untouched: this attempt's and the other attempt's branch, and the object is absent.
    expect(git(ws.mirrorPath, ['rev-parse', `refs/heads/${ws.branch}`])).toBe(ws.baseCommit);
    expect(git(ws.mirrorPath, ['rev-parse', `refs/heads/${other.branch}`])).toBe(other.baseCommit);
    expect(() => git(ws.mirrorPath, ['cat-file', '-e', agentSha])).toThrow();
    await assertTrustedGitUnchanged(snapshot);

    // The worker records the result from the working tree with its own trusted commit.
    const tip = await manager.commit(ws, {
      message: 'result',
      author: { name: 'W', email: 'w@example.com' },
    });
    expect(git(ws.mirrorPath, ['show', `${tip}:new.txt`])).toBe('agent work');
    expect(git(ws.mirrorPath, ['rev-parse', `${tip}^`])).toBe(ws.baseCommit);

    await disposeAttemptGitView(manager.root, view);
    expect(await lstat(view.sandboxDir).catch(() => null)).toBeNull();
  });

  it('detects tampering with the trusted metadata (repointed .git file, mirror config, branch)', async () => {
    const { manager, prepare } = await setup();
    const ws = await prepare('a1');
    const snap = await snapshotTrustedGit(ws);
    await writeFile(join(ws.path, '.git'), `gitdir: ${join(manager.root, 'evil')}\n`);
    await expect(assertTrustedGitUnchanged(snap)).rejects.toBeInstanceOf(GitMetadataTamperedError);

    const ws2 = await prepare('a2');
    const snap2 = await snapshotTrustedGit(ws2);
    await appendFile(join(ws2.mirrorPath, 'config'), '[core]\n\tsshCommand = touch /tmp/pwned\n');
    const err = await assertTrustedGitUnchanged(snap2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitMetadataTamperedError);
    expect((err as GitMetadataTamperedError).paths).toContain(join(ws2.mirrorPath, 'config'));

    const ws3 = await prepare('a3');
    // The appended config above changes every snapshot of this mirror; take a fresh one.
    const snap3 = await snapshotTrustedGit(ws3);
    git(ws3.path, ['commit', '--allow-empty', '-q', '-m', 'sneaky']);
    await expect(assertTrustedGitUnchanged(snap3)).rejects.toBeInstanceOf(GitMetadataTamperedError);
  });

  it('refuses a second view for the same attempt and a snapshot of a non-worktree', async () => {
    const { manager, prepare } = await setup();
    const ws = await prepare('a1');
    await createAttemptGitView({ root: manager.root, ws, git: manager.git });
    await expect(createAttemptGitView({ root: manager.root, ws, git: manager.git })).rejects.toThrow(
      /already exists/,
    );
    await writeFile(join(ws.path, '.git'), 'garbage');
    await expect(snapshotTrustedGit(ws)).rejects.toBeInstanceOf(GitMetadataTamperedError);
  });
});
