import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BaseRefNotFoundError } from '../src/workspace/errors.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, git, remoteSha } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

/**
 * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §2): a job on an EMPTY repository (a missing `main` is
 * expected there, not an error) starts from an empty first commit of its base branch instead of failing
 * with BaseRefNotFoundError; the commit is pushed as the branch's first commit only when the job publishes, and only
 * while the branch does not exist. A missing ref of a non-empty repository stays an error.
 */

const GIT_TIMEOUT = { timeout: 120_000 };
const AUTHOR = { name: 'Remyral Agent', email: 'agent@remyral.invalid' };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function head(bare: string, ref: string): string | null {
  try {
    return git(bare, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null;
  }
}

async function emptyOrigin(dir: string): Promise<{ bare: string; url: string }> {
  const bare = join(dir, 'empty.git');
  await mkdir(bare, { recursive: true });
  git(bare, ['init', '--bare', '-b', 'main']);
  return { bare, url: pathToFileURL(bare).href };
}

async function setup(): Promise<{
  dir: string;
  origin: { bare: string; url: string };
  manager: WorkspaceManager;
}> {
  const dir = await realpath(await tempDir('rw-empty-'));
  const origin = await emptyOrigin(dir);
  const manager = await WorkspaceManager.create({
    root: join(dir, 'root'),
    projects: { proj: [origin.url] },
    allowFileUrls: true,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
  });
  return { dir, origin, manager };
}

const req = (
  url: string,
  attemptId: string,
  extra: {
    baseRef?: string;
    emptyRemote?: { publish: boolean; author: { name: string; email: string } };
  } = {},
) => ({
  projectId: 'proj',
  jobId: 'job1',
  attemptId,
  epoch: 1,
  repository: { url, baseRef: extra.baseRef ?? 'main' },
  ...(extra.emptyRemote === undefined ? {} : { emptyRemote: extra.emptyRemote }),
});

describe.skipIf(isWindows)('empty repositories (p18-project-bootstrap)', GIT_TIMEOUT, () => {
  it('creates the base branch as one empty first commit and publishes the work on top of it', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare(
      req(origin.url, 'a1', { emptyRemote: { publish: true, author: AUTHOR } }),
    );
    expect(ws.emptyRepository).toBe('pushed');
    // The remote's main is exactly the empty first commit: no parent, empty tree, the job's identity.
    expect(head(origin.bare, 'refs/heads/main')).toBe(ws.baseCommit);
    expect(git(origin.bare, ['rev-list', '--parents', '-n', '1', 'main'])).toBe(ws.baseCommit);
    expect(git(origin.bare, ['rev-parse', 'main^{tree}'])).toBe(EMPTY_TREE);
    expect(git(origin.bare, ['log', '-1', '--format=%an <%ae>|%s', 'main'])).toBe(
      'Remyral Agent <agent@remyral.invalid>|Initial commit',
    );
    // The worktree is empty (only git's link file).
    expect((await readdir(ws.path)).filter((n) => n !== '.git')).toEqual([]);

    // The job's work goes on the attempt branch as usual, a descendant of the new base.
    await writeFile(join(ws.path, 'index.html'), '<h1>hi</h1>\n');
    const sha = await manager.commit(ws, { message: 'feat: first page', author: AUTHOR });
    const pushed = await manager.push(ws, { expectedRemoteSha: null });
    expect(pushed.sha).toBe(sha);
    expect(head(origin.bare, `refs/heads/${ws.branch}`)).toBe(sha);
    expect(git(origin.bare, ['merge-base', '--is-ancestor', ws.baseCommit, sha])).toBe('');
    // main itself is untouched by the job's work (it reaches main only through the pull request / merge).
    expect(head(origin.bare, 'refs/heads/main')).toBe(ws.baseCommit);

    // The next attempt finds an ordinary base.
    const next = await manager.prepare(
      req(origin.url, 'a2', { emptyRemote: { publish: true, author: AUTHOR } }),
    );
    expect(next.emptyRepository).toBeUndefined();
    expect(next.baseCommit).toBe(ws.baseCommit);
  });

  it('keeps the empty base local when the job does not publish', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare(
      req(origin.url, 'a1', { emptyRemote: { publish: false, author: AUTHOR } }),
    );
    expect(ws.emptyRepository).toBe('local');
    expect(git(ws.path, ['rev-parse', 'HEAD^{tree}'])).toBe(EMPTY_TREE);
    expect(git(origin.bare, ['for-each-ref'])).toBe('');
  });

  it('without the option an empty repository stays an error that says the repository is empty', async () => {
    const { origin, manager } = await setup();
    const err = await manager.prepare(req(origin.url, 'a1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaseRefNotFoundError);
    expect((err as BaseRefNotFoundError).emptyRepository).toBe(true);
    expect((err as Error).message).toContain('the repository is empty');
    expect(git(origin.bare, ['for-each-ref'])).toBe('');
  });

  it('a full sha base of an empty repository is still refused', async () => {
    const { origin, manager } = await setup();
    await expect(
      manager.prepare(
        req(origin.url, 'a1', {
          baseRef: 'a'.repeat(40),
          emptyRemote: { publish: true, author: AUTHOR },
        }),
      ),
    ).rejects.toThrow(BaseRefNotFoundError);
    expect(git(origin.bare, ['for-each-ref'])).toBe('');
  });

  it('a missing branch of a NON-empty repository stays an error (nothing is created)', async () => {
    const dir = await realpath(await tempDir('rw-empty-'));
    const origin = await createOrigin(dir);
    const manager = await WorkspaceManager.create({
      root: join(dir, 'root'),
      projects: { proj: [origin.url] },
      allowFileUrls: true,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    const err = await manager
      .prepare(req(origin.url, 'a1', { baseRef: 'develop', emptyRemote: { publish: true, author: AUTHOR } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaseRefNotFoundError);
    expect((err as BaseRefNotFoundError).emptyRepository).toBe(false);
    expect(remoteSha(origin, 'refs/heads/develop')).toBeNull();
  });

  it('a repository with only a tag is not empty', async () => {
    const { origin, manager } = await setup();
    // A tag without any branch (pushed from a scratch clone).
    const dir = await realpath(await tempDir('rw-empty-tag-'));
    git(dir, ['init', '-b', 'scratch']);
    git(dir, ['commit', '--allow-empty', '-m', 'x']);
    git(dir, ['tag', 'v0']);
    git(dir, ['push', origin.url, 'refs/tags/v0']);
    const err = await manager
      .prepare(req(origin.url, 'a1', { emptyRemote: { publish: true, author: AUTHOR } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaseRefNotFoundError);
    expect((err as BaseRefNotFoundError).emptyRepository).toBe(false);
  });
});
