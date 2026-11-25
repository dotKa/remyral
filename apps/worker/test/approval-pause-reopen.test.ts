import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAttemptGitView, openAttemptGitView } from '../src/sandbox/attempt-git.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

async function setup() {
  const dir = await realpath(await tempDir('rw-reopen-'));
  const origin = await createOrigin(dir, 'origin', { 'README.md': 'hello\n' });
  const manager = await WorkspaceManager.create({
    root: join(dir, 'root'),
    projects: { proj: [origin.url] },
    allowFileUrls: true,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
  });
  return { origin, manager };
}

describe.skipIf(isWindows)('p10-approval-pause: reopening a kept attempt', { timeout: 120_000 }, () => {
  it('reopens the worktree and its git view under a new epoch; refuses a foreign or missing one', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare({
      projectId: 'proj',
      jobId: 'job1',
      attemptId: 'a1',
      epoch: 1,
      repository: { url: origin.url, baseRef: 'main' },
    });
    const view = await createAttemptGitView({ root: manager.root, ws, git: manager.git });
    const reopened = await manager.reopen({
      projectId: 'proj',
      jobId: 'job1',
      attemptId: 'a1',
      epoch: 2,
      repository: { url: origin.url, baseRef: 'main', baseCommit: ws.baseCommit },
    });
    expect(reopened).toMatchObject({ path: ws.path, branch: ws.branch, mirrorPath: ws.mirrorPath, epoch: 2 });
    expect(await openAttemptGitView({ root: manager.root, ws: reopened })).toEqual(view);

    // Another project's allowlist, an unknown attempt, a tampered view: refused.
    await expect(
      manager.reopen({
        projectId: 'other',
        jobId: 'job1',
        attemptId: 'a1',
        epoch: 2,
        repository: { url: origin.url, baseRef: 'main', baseCommit: ws.baseCommit },
      }),
    ).rejects.toThrow();
    await expect(
      manager.reopen({
        projectId: 'proj',
        jobId: 'job1',
        attemptId: 'a9',
        epoch: 2,
        repository: { url: origin.url, baseRef: 'main', baseCommit: ws.baseCommit },
      }),
    ).rejects.toThrow();
    await writeFile(join(view.gitDir, 'objects', 'info', 'alternates'), '/elsewhere/objects\n');
    await expect(openAttemptGitView({ root: manager.root, ws: reopened })).rejects.toThrow(/does not belong/);
    await rm(view.sandboxDir, { recursive: true, force: true });
    await expect(openAttemptGitView({ root: manager.root, ws: reopened })).rejects.toThrow(/missing/);
  });

  it('reopens a scratch directory with in/ and out/', async () => {
    const { manager } = await setup();
    const s = await manager.prepareScratch({ jobId: 'job2', attemptId: 'a1', epoch: 1 });
    const again = await manager.reopenScratch({ jobId: 'job2', attemptId: 'a1', epoch: 3 });
    expect(again).toEqual({ ...s, epoch: 3 });
    await expect(manager.reopenScratch({ jobId: 'job2', attemptId: 'zz', epoch: 3 })).rejects.toThrow();
  });
});
