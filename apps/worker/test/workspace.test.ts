import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, Redactor, SecretSet } from '@remyral/observability';
import { describe, expect, it } from 'vitest';
import {
  AttemptTrailerError,
  BaseRefNotFoundError,
  DiskQuotaError,
  InvalidRepositoryUrlError,
  InvalidWorkspaceIdError,
  PushRejectedError,
  RepositoryNotAllowedError,
  SecretScanError,
  UnsafePathError,
  UnsafeSymlinkError,
  WorkspaceError,
  WorkspaceExistsError,
} from '../src/workspace/errors.js';
import { GitRunner } from '../src/workspace/git.js';
import { assertSafeSegment, attemptBranch, withAttemptTrailer } from '../src/workspace/ids.js';
import { PathLocks } from '../src/workspace/lock.js';
import { WorkspaceManager, validateBaseRef, type WorkspaceManagerOptions } from '../src/workspace/manager.js';
import { ProjectAllowlist, parseRepoUrl, resolveSubmoduleUrl } from '../src/workspace/repo-url.js';
import { prePushScanner, scanGitLog } from '../src/workspace/secret-scan.js';
import { createOrigin, git, remoteSha, upstreamCommit, type Origin } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
/** Real git under a loaded CI/dev machine can be slow. */
const GIT_TIMEOUT = { timeout: 120_000 };
const AUTHOR = { name: 'Remyral Worker', email: 'worker@example.com' };

async function setup(
  overrides: Partial<WorkspaceManagerOptions> = {},
  originFiles?: Record<string, string>,
): Promise<{ dir: string; origin: Origin; manager: WorkspaceManager; root: string }> {
  const dir = await realpath(await tempDir('rw-ws-'));
  const origin = await createOrigin(dir, 'origin', originFiles);
  const root = join(dir, 'root');
  const manager = await WorkspaceManager.create({
    root,
    projects: { proj: [origin.url] },
    allowFileUrls: true,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    ...overrides,
  });
  return { dir, origin, manager, root };
}

function request(
  origin: Origin,
  attemptId = 'a1',
  extra: { jobId?: string; baseRef?: string; epoch?: number } = {},
) {
  return {
    projectId: 'proj',
    jobId: extra.jobId ?? 'job1',
    attemptId,
    epoch: extra.epoch ?? 3,
    repository: { url: origin.url, baseRef: extra.baseRef ?? 'main' },
  };
}

describe.skipIf(isWindows)('workspace ids and naming (ADR-0004 §3)', GIT_TIMEOUT, () => {
  it('refuses ids that are unsafe as path segments or ref components', () => {
    for (const bad of [
      '',
      '..',
      '../x',
      'a/b',
      'a:b',
      '-x',
      '.hidden',
      'x.lock',
      'a..b',
      'x.',
      'a b',
      'a\\b',
    ]) {
      expect(() => {
        assertSafeSegment('jobId', bad);
      }, bad).toThrow(InvalidWorkspaceIdError);
    }
    expect(attemptBranch('job-1', 'att_2.x')).toBe('rac/job-1/att_2.x');
  });

  it('adds exactly one attempt trailer and strips agent-written ones', () => {
    expect(withAttemptTrailer('fix: thing', 'a1', 7)).toBe('fix: thing\n\nRemyral-Attempt: a1/7\n');
    expect(withAttemptTrailer('fix\n\nbody\n\nSigned-off-by: X <x@y>', 'a1', 7)).toBe(
      'fix\n\nbody\n\nSigned-off-by: X <x@y>\nRemyral-Attempt: a1/7\n',
    );
    const spoofed = withAttemptTrailer('fix\n\nRemyral-Attempt: other/99\nremyral-attempt : x/1', 'a1', 7);
    expect(spoofed).toBe('fix\n\nRemyral-Attempt: a1/7\n');
    expect(() => withAttemptTrailer('  \n', 'a1', 1)).toThrow(InvalidWorkspaceIdError);
  });

  it('validates baseRef so it can never become a git option', () => {
    for (const bad of [
      '-x',
      '--upload-pack=evil',
      'a..b',
      'a b',
      'x@{1}',
      'a:b',
      '/abs',
      'x.lock',
      'HEAD~1',
    ]) {
      expect(() => validateBaseRef(bad), bad).toThrow(InvalidWorkspaceIdError);
    }
    expect(validateBaseRef('release/1.2')).toBe('release/1.2');
  });
});

describe('repository URLs and allowlist', GIT_TIMEOUT, () => {
  it('canonicalizes equivalent URLs', () => {
    const a = parseRepoUrl('https://GitHub.com/org/repo.git');
    const b = parseRepoUrl('https://github.com/org/repo/');
    expect(a.key).toBe(b.key);
    expect(parseRepoUrl('ssh://git@github.com:22/org/repo.git').url).toBe(
      'ssh://git@github.com:22/org/repo.git',
    );
  });

  it('refuses credentials, insecure schemes, scp-like syntax, queries and traversal', () => {
    for (const bad of [
      'https://x-access-token:ghp_secret@github.com/org/repo',
      'https://user@github.com/org/repo',
      'http://github.com/org/repo',
      'git://github.com/org/repo',
      'ext::sh -c touch% /tmp/pwned',
      'git@github.com:org/repo.git',
      'https://github.com/org/repo?x=1',
      'https://github.com/org/repo#frag',
      'https://github.com/org/../other/repo',
      'https://github.com/org/%2e%2e/repo',
      'file:///tmp/repo',
      '-uhttps://x',
      'https://github.com/org/re po',
    ]) {
      expect(() => parseRepoUrl(bad), bad).toThrow(InvalidRepositoryUrlError);
    }
    expect(parseRepoUrl('file:///tmp/repo.git', { allowFileUrls: true }).protocol).toBe('file');
  });

  it('error messages never echo a password from a refused URL', () => {
    const list = new ProjectAllowlist({ p: ['https://github.com/org/repo'] });
    try {
      list.check('p', 'https://u:supersecretpassword@github.com/org/repo');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryNotAllowedError);
      expect(String(error)).not.toContain('supersecretpassword');
    }
  });

  it('allows only listed repositories of a known project', () => {
    const list = new ProjectAllowlist({ p: ['https://github.com/org/repo.git'], q: [] });
    expect(list.check('p', 'https://github.com/org/repo').url).toBe('https://github.com/org/repo');
    expect(() => list.check('p', 'https://github.com/org/other')).toThrow(RepositoryNotAllowedError);
    expect(() => list.check('q', 'https://github.com/org/repo')).toThrow(RepositoryNotAllowedError);
    expect(() => list.check('unknown', 'https://github.com/org/repo')).toThrow(/unknown project/);
  });

  it('resolves relative submodule URLs against the superproject', () => {
    const sup = parseRepoUrl('https://github.com/org/repo.git');
    expect(resolveSubmoduleUrl(sup, '../lib.git')).toBe('https://github.com/org/lib.git');
    expect(resolveSubmoduleUrl(sup, 'https://x.example/y')).toBe('https://x.example/y');
  });
});

describe.skipIf(isWindows)('hardened git runner', GIT_TIMEOUT, () => {
  it('builds a minimal env without daemon secrets and keeps the token out of argv', async () => {
    const dir = await tempDir('rw-git-');
    const runner = new GitRunner({
      emptyHooksDir: dir,
      sourceEnv: {
        PATH: '/usr/bin',
        HOME: '/home/w',
        AWS_SECRET_ACCESS_KEY: 'daemon-secret-value',
        GIT_DIR: '/evil',
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=/evil'",
      },
    });
    const remote = parseRepoUrl('https://github.com/org/repo');
    const token = { reveal: () => GH_TOKEN };
    const env = runner.env({ token });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.REMYRAL_GIT_TOKEN).toBe(GH_TOKEN);
    const argv = runner.argv({ cwd: dir, args: ['fetch'], remote, token });
    expect(argv.join(' ')).not.toContain(GH_TOKEN);
    expect(argv).toContain('core.hooksPath=/dev/null');
    expect(argv).toContain('protocol.file.allow=never');
    expect(argv).toContain('protocol.ext.allow=never');
  });

  it('credential helper answers with the token only for the scoped origin URL', async () => {
    const dir = await tempDir('rw-git-');
    const runner = new GitRunner({ emptyHooksDir: dir });
    const remote = parseRepoUrl('https://github.example/org/repo.git');
    const token = { reveal: () => GH_TOKEN };
    const fill = (url: string) =>
      runner.run({
        cwd: dir,
        args: ['credential', 'fill'],
        input: `url=${url}\n\n`,
        remote,
        token,
        okCodes: [128],
      });
    const ok = await fill('https://github.example/org/repo.git');
    expect(ok.stdout).toContain(`password=${GH_TOKEN}`);
    expect(ok.stdout).toContain('username=x-access-token');
    // Another host: no helper applies and prompting is disabled -> failure, no token.
    const other = await fill('https://evil.example/org/repo.git');
    expect(other.stdout).not.toContain(GH_TOKEN);
    expect(other.code).not.toBe(0);
  });

  it('redacts the token from failing command output', async () => {
    const dir = await tempDir('rw-git-');
    const runner = new GitRunner({ emptyHooksDir: dir });
    const err = await runner
      .run({ cwd: dir, args: ['rev-parse', '--verify', GH_TOKEN], token: { reveal: () => GH_TOKEN } })
      .catch((e: unknown) => e);
    expect(String(err)).toContain('git rev-parse failed');
    expect(String(err)).not.toContain(GH_TOKEN);
  });
});

describe.skipIf(isWindows)('WorkspaceManager.prepare', GIT_TIMEOUT, () => {
  it('creates a worktree on rac/<job>/<attempt> from baseRef inside the root', async () => {
    const { origin, manager, root } = await setup();
    const ws = await manager.prepare(request(origin));
    expect(ws.path).toBe(join(root, 'jobs', 'job1', 'a1'));
    expect(ws.branch).toBe('rac/job1/a1');
    expect(ws.baseCommit).toBe(origin.initial);
    expect(git(ws.path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/rac/job1/a1');
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toBe('hello\n');
    // Upstream refs are remote-tracking refs in the mirror; local branches are only rac/*.
    expect(git(ws.mirrorPath, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe(
      'refs/heads/rac/job1/a1',
    );
    expect(git(ws.mirrorPath, ['rev-parse', 'refs/remotes/origin/main'])).toBe(origin.initial);
  });

  it('re-creates a mirror directory left behind without a repository (first attempt had no git)', async () => {
    const { origin, manager, root } = await setup();
    // What a failed first attempt leaves: the mirror directory exists but `git init` never ran.
    const first = await manager.prepare(request(origin, 'a0', { jobId: 'job0' }));
    await rm(first.mirrorPath, { recursive: true, force: true });
    await mkdir(first.mirrorPath);
    const ws = await manager.prepare(request(origin));
    expect(ws.mirrorPath).toBe(first.mirrorPath);
    expect(git(ws.mirrorPath, ['rev-parse', 'refs/remotes/origin/main'])).toBe(origin.initial);
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect(ws.path.startsWith(root)).toBe(true);
  });

  it('resolves tags and full shas as baseRef, and refuses unknown refs', async () => {
    const { origin, manager } = await setup();
    git(origin.work, ['tag', 'v1']);
    git(origin.work, ['push', 'origin', 'v1']);
    const second = await upstreamCommit(origin, { 'b.txt': 'b' });
    expect((await manager.prepare(request(origin, 'a1', { baseRef: 'v1' }))).baseCommit).toBe(origin.initial);
    expect((await manager.prepare(request(origin, 'a2', { baseRef: second }))).baseCommit).toBe(second);
    await expect(manager.prepare(request(origin, 'a3', { baseRef: 'nope' }))).rejects.toThrow(
      BaseRefNotFoundError,
    );
    // The failed attempt left nothing behind.
    await expect(lstat(join(manager.root, 'jobs', 'job1', 'a3'))).rejects.toThrow();
  });

  it('refuses repositories not on the project allowlist before touching disk', async () => {
    const { dir, manager, root } = await setup();
    const other = await createOrigin(dir, 'other');
    await expect(manager.prepare({ ...request(other), projectId: 'proj' })).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    await expect(manager.prepare({ ...request(other), projectId: 'nope' })).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(await readdir(join(root, 'mirrors'))).toEqual([]);
    expect(await readdir(join(root, 'jobs'))).toEqual([]);
  });

  it('checks free disk space before checkout', async () => {
    const { origin, manager, root } = await setup({
      freeBytes: () => Promise.resolve(1024),
      minFreeBytes: 4096,
    });
    await expect(manager.prepare(request(origin))).rejects.toThrow(DiskQuotaError);
    expect(await readdir(join(root, 'mirrors'))).toEqual([]);
  });

  it('never runs hooks: planted in the mirror, set via mirror config, or via a global config', async () => {
    const { dir, origin, manager } = await setup();
    const marker = join(dir, 'HOOK_RAN');
    const evilHooks = join(dir, 'evil-hooks');
    await mkdir(evilHooks);
    const ws1 = await manager.prepare(request(origin, 'a1'));
    for (const hookDir of [join(ws1.mirrorPath, 'hooks'), evilHooks]) {
      await mkdir(hookDir, { recursive: true });
      for (const hook of [
        'post-checkout',
        'pre-commit',
        'commit-msg',
        'post-commit',
        'pre-push',
        'reference-transaction',
        'pre-auto-gc',
      ]) {
        await writeFile(join(hookDir, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
      }
    }
    // An agent (or a malicious checkout) points the shared mirror's config at its hooks.
    git(ws1.mirrorPath, ['config', 'core.hooksPath', evilHooks]);
    // A user-level config with hooks/fsmonitor must be ignored too.
    const home = join(dir, 'home');
    await mkdir(home);
    await writeFile(
      join(home, '.gitconfig'),
      `[core]\n\thooksPath = ${evilHooks}\n\tfsmonitor = ${join(evilHooks, 'pre-commit')}\n`,
    );
    const withHome = await WorkspaceManager.create({
      root: manager.root,
      projects: { proj: [origin.url] },
      allowFileUrls: true,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      sourceEnv: { ...process.env, HOME: home, XDG_CONFIG_HOME: home },
    });
    const ws2 = await withHome.prepare(request(origin, 'a2'));
    await writeFile(join(ws2.path, 'x.txt'), 'x');
    await withHome.commit(ws2, { message: 'change', author: AUTHOR });
    await withHome.push(ws2, { expectedRemoteSha: null });
    await withHome.release(ws2, { status: 'succeeded', artifactsCollected: true });
    await expect(readFile(marker, 'utf8')).rejects.toThrow(/ENOENT/);
    // Control: plain git in the same worktree setup does run the planted hook.
    git(ws1.path, ['commit', '--allow-empty', '-m', 'control']);
    expect(await readFile(marker, 'utf8')).toContain('pre-commit');
  });

  it('refuses path traversal through ids', async () => {
    const { origin, manager } = await setup();
    await expect(manager.prepare(request(origin, '../../escape'))).rejects.toThrow(InvalidWorkspaceIdError);
    await expect(manager.prepare(request(origin, 'a1', { jobId: '..' }))).rejects.toThrow(
      InvalidWorkspaceIdError,
    );
    await expect(manager.prepare({ ...request(origin), projectId: '../proj' })).rejects.toThrow(
      InvalidWorkspaceIdError,
    );
  });

  it('refuses a planted symlink for the job directory or the jobs directory', async () => {
    const { dir, origin, manager, root } = await setup();
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'jobs', 'job1'));
    await expect(manager.prepare(request(origin))).rejects.toThrow(UnsafePathError);
    expect(await readdir(outside)).toEqual([]);

    const dir2 = await realpath(await tempDir('rw-ws-'));
    const root2 = join(dir2, 'root');
    await mkdir(root2, { mode: 0o700 });
    await symlink(outside, join(root2, 'jobs'));
    await expect(WorkspaceManager.create({ root: root2, projects: {}, allowFileUrls: true })).rejects.toThrow(
      UnsafePathError,
    );
  });

  it('refuses a group/world-writable workspace root', async () => {
    const dir = await tempDir('rw-ws-');
    const root = join(dir, 'root');
    await mkdir(root);
    await chmod(root, 0o777);
    await expect(WorkspaceManager.create({ root, projects: {} })).rejects.toThrow(
      /writable by group\/others/,
    );
  });

  it('refuses a checkout with symlinks escaping the worktree and cleans up', async () => {
    const { dir, origin, manager, root } = await setup();
    await symlink('../../../../../../../../home', join(origin.work, 'up'));
    await symlink('/etc/passwd', join(origin.work, 'abs'));
    await symlink('README.md', join(origin.work, 'inside'));
    git(origin.work, ['add', '-A']);
    git(origin.work, ['commit', '-m', 'links']);
    git(origin.work, ['push', 'origin', 'main']);
    const err = await manager.prepare(request(origin)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeSymlinkError);
    expect((err as UnsafeSymlinkError).entries.map((e) => e.path).sort()).toEqual(['abs', 'up']);
    await expect(lstat(join(root, 'jobs', 'job1', 'a1'))).rejects.toThrow();
    // Policy can allow them explicitly.
    const permissive = await WorkspaceManager.create({
      root,
      projects: { proj: [origin.url] },
      allowFileUrls: true,
      symlinks: 'allow',
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    expect((await permissive.prepare(request(origin, 'a2'))).path).toContain(dir);
  });

  it('isolates concurrent attempts of the same repository', async () => {
    const { origin, manager } = await setup();
    const [a, b, c] = await Promise.all(['a1', 'a2', 'a3'].map((id) => manager.prepare(request(origin, id))));
    if (a === undefined || b === undefined || c === undefined) throw new Error('missing workspace');
    expect(new Set([a.path, b.path, c.path]).size).toBe(3);
    expect(new Set([a.mirrorPath, b.mirrorPath, c.mirrorPath]).size).toBe(1);
    await writeFile(join(a.path, 'only-a.txt'), 'a');
    const shaA = await manager.commit(a, { message: 'a', author: AUTHOR });
    await expect(lstat(join(b.path, 'only-a.txt'))).rejects.toThrow();
    expect(git(b.path, ['rev-parse', 'HEAD'])).toBe(origin.initial);
    expect(git(c.path, ['status', '--porcelain'])).toBe('');
    expect(git(a.path, ['rev-parse', 'HEAD'])).toBe(shaA);
  });

  it('a duplicate prepare of the same attempt is refused and does not destroy the first', async () => {
    const { origin, manager } = await setup();
    const results = await Promise.allSettled([
      manager.prepare(request(origin)),
      manager.prepare(request(origin)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceExistsError);
    const ws = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<WorkspaceManager['prepare']>>>).value;
    expect(await readFile(join(ws.path, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('keeps the token out of mirror config, worktree files and logs', async () => {
    const lines: string[] = [];
    const redactor = new Redactor({ secrets: new SecretSet() });
    redactor.secrets.add(GH_TOKEN, 'REMYRAL_GIT_TOKEN');
    const logger = createLogger({ sink: (l) => lines.push(l), redactor, level: 'trace' });
    const { origin, manager } = await setup({ logger });
    const ws = await manager.prepare({ ...request(origin), gitToken: { reveal: () => GH_TOKEN }, redactor });
    const config = await readFile(join(ws.mirrorPath, 'config'), 'utf8');
    expect(config).not.toContain(GH_TOKEN);
    expect(config).not.toMatch(/credential/);
    expect(await readFile(join(ws.path, '.git'), 'utf8')).not.toContain(GH_TOKEN);
    expect(lines.join('\n')).not.toContain(GH_TOKEN);
  });
});

describe.skipIf(isWindows)('submodule policy', GIT_TIMEOUT, () => {
  function withSubmodule(origin: Origin, lib: Origin): void {
    git(origin.work, ['submodule', 'add', lib.url, 'lib']);
    git(origin.work, ['commit', '-m', 'add submodule']);
    git(origin.work, ['push', 'origin', 'main']);
  }

  it('skip: submodules are not initialised', async () => {
    const { dir, origin, manager } = await setup();
    const lib = await createOrigin(dir, 'lib', { 'lib.txt': 'lib\n' });
    withSubmodule(origin, lib);
    const ws = await manager.prepare(request(origin));
    expect(await readdir(join(ws.path, 'lib'))).toEqual([]);
  });

  it('allowlisted: refuses a submodule URL not on the allowlist, initialises an allowlisted one', async () => {
    const { dir, origin, root } = await setup();
    const lib = await createOrigin(dir, 'lib', { 'lib.txt': 'lib\n' });
    withSubmodule(origin, lib);
    const strict = await WorkspaceManager.create({
      root,
      projects: { proj: [origin.url] },
      allowFileUrls: true,
      submodules: 'allowlisted',
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    await expect(strict.prepare(request(origin, 'a1'))).rejects.toThrow(/submodule/);
    await expect(lstat(join(root, 'jobs', 'job1', 'a1'))).rejects.toThrow();
    const allowing = await WorkspaceManager.create({
      root,
      projects: { proj: [origin.url, lib.url] },
      allowFileUrls: true,
      submodules: 'allowlisted',
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    const ws = await allowing.prepare(request(origin, 'a2'));
    expect(await readFile(join(ws.path, 'lib', 'lib.txt'), 'utf8')).toBe('lib\n');
  });
});

describe.skipIf(isWindows)('commit, pre-push scan and push with lease', GIT_TIMEOUT, () => {
  it('pushes only rac/<job>/<attempt> with force-with-lease; a stale lease is refused', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare(request(origin));
    await writeFile(join(ws.path, 'feature.txt'), 'v1\n');
    const sha1 = await manager.commit(ws, { message: 'feat: v1', author: AUTHOR });
    expect(git(ws.path, ['log', '-1', '--format=%B'])).toBe('feat: v1\n\nRemyral-Attempt: a1/3');
    const pushed = await manager.push(ws, { expectedRemoteSha: null });
    expect(pushed).toEqual({ branch: 'rac/job1/a1', sha: sha1 });
    expect(remoteSha(origin, 'refs/heads/rac/job1/a1')).toBe(sha1);
    expect(remoteSha(origin, 'refs/heads/main')).toBe(origin.initial);

    // Second push needs the previously pushed sha as the lease.
    await writeFile(join(ws.path, 'feature.txt'), 'v2\n');
    const sha2 = await manager.commit(ws, { message: 'feat: v2', author: AUTHOR });
    await expect(manager.push(ws, { expectedRemoteSha: null })).rejects.toThrow(PushRejectedError);
    expect((await manager.push(ws, { expectedRemoteSha: sha1 })).sha).toBe(sha2);

    // A stale duplicate of the attempt (or anyone) moved the remote branch: our lease is stale.
    git(origin.work, ['fetch', 'origin', 'rac/job1/a1']);
    git(origin.work, ['checkout', '-q', '-B', 'other', 'FETCH_HEAD']);
    await upstreamCommit(origin, { 'other.txt': 'x' }, 'foreign', 'rac/job1/a1');
    const foreign = remoteSha(origin, 'refs/heads/rac/job1/a1');
    await writeFile(join(ws.path, 'feature.txt'), 'v3\n');
    await manager.commit(ws, { message: 'feat: v3', author: AUTHOR });
    const err = await manager.push(ws, { expectedRemoteSha: sha2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushRejectedError);
    expect((err as PushRejectedError).reason).toBe('stale-lease');
    expect(remoteSha(origin, 'refs/heads/rac/job1/a1')).toBe(foreign);
  });

  it('refuses to push a tip without this attempt’s trailer', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare(request(origin, 'a1', { epoch: 5 }));
    await writeFile(join(ws.path, 'f.txt'), 'f');
    git(ws.path, ['add', '-A']);
    git(ws.path, ['commit', '-m', 'agent commit\n\nRemyral-Attempt: a1/4']);
    await expect(manager.push(ws, { expectedRemoteSha: null })).rejects.toThrow(AttemptTrailerError);
    // The worker's marker commit fixes it.
    await manager.commit(ws, { message: 'chore: attempt result', author: AUTHOR });
    await expect(manager.push(ws, { expectedRemoteSha: null })).resolves.toBeDefined();
  });

  it('p19-large-commit: a result with many binary files commits and pushes; text files are still scanned', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare(request(origin, 'a1'));
    // 60 "images" of 256 KiB of binary noise: their bytes are never diffed as text.
    const noise = Buffer.alloc(256 * 1024);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
    await mkdir(join(ws.path, 'img'), { recursive: true });
    for (let i = 0; i < 60; i++) await writeFile(join(ws.path, 'img', `p${String(i)}.png`), noise);
    await writeFile(join(ws.path, 'index.html'), '<img src="img/p0.png">\n');
    await manager.commit(ws, { message: 'reskin', author: AUTHOR });
    await expect(manager.push(ws, { expectedRemoteSha: null })).resolves.toBeDefined();
    expect(remoteSha(origin, 'refs/heads/rac/job1/a1')).not.toBeNull();

    // A token in a text file next to the images is still refused.
    const ws2 = await manager.prepare(request(origin, 'a2'));
    await writeFile(join(ws2.path, 'logo.png'), noise);
    await writeFile(join(ws2.path, 'config.js'), `export const t = "${GH_TOKEN}";\n`);
    await manager.commit(ws2, { message: 'add', author: AUTHOR });
    await expect(manager.push(ws2, { expectedRemoteSha: null })).rejects.toThrow(SecretScanError);
  });

  it('pre-push scan refuses vendor tokens, PEM keys and the job’s exact secrets — even if later removed', async () => {
    const { origin, manager } = await setup();
    const canary = 'canary-provider-key-7f3a9c2e';
    const secrets = new SecretSet();
    secrets.add(canary, 'ANTHROPIC_API_KEY');

    const ws = await manager.prepare(request(origin, 'a1'));
    await writeFile(join(ws.path, 'config.js'), `export const t = "${GH_TOKEN}";\n`);
    await manager.commit(ws, { message: 'add config', author: AUTHOR });
    await writeFile(join(ws.path, 'config.js'), 'export const t = process.env.T;\n');
    await manager.commit(ws, { message: 'remove token', author: AUTHOR });
    const err = await manager.push(ws, { expectedRemoteSha: null, secrets }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretScanError);
    expect((err as SecretScanError).findings).toEqual([
      expect.objectContaining({ location: 'config.js:1', label: 'github-token' }),
    ]);
    expect(String(err)).not.toContain(GH_TOKEN);
    expect(remoteSha(origin, 'refs/heads/rac/job1/a1')).toBeNull();

    const ws2 = await manager.prepare(request(origin, 'a2'));
    await writeFile(join(ws2.path, 'notes.md'), `key is ${canary}\n`);
    await manager.commit(ws2, { message: 'notes', author: AUTHOR });
    const err2 = await manager.push(ws2, { expectedRemoteSha: null, secrets }).catch((e: unknown) => e);
    expect((err2 as SecretScanError).findings[0]?.label).toBe('ANTHROPIC_API_KEY');
    expect(String(err2)).not.toContain(canary);

    const ws3 = await manager.prepare(request(origin, 'a3'));
    await manager.commit(ws3, { message: `oops ${GH_TOKEN}`, author: AUTHOR });
    await expect(manager.push(ws3, { expectedRemoteSha: null })).rejects.toThrow(SecretScanError);

    const ws4 = await manager.prepare(request(origin, 'a4'));
    await writeFile(
      join(ws4.path, 'id_rsa'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
    );
    await manager.commit(ws4, { message: 'key', author: AUTHOR });
    await expect(manager.push(ws4, { expectedRemoteSha: null })).rejects.toThrow(/pem-private-key/);
  });

  it('does not scan content that is already upstream, and ignores benign code', async () => {
    const { origin, manager } = await setup({}, { 'legacy.txt': `${GH_TOKEN}\n` });
    const ws = await manager.prepare(request(origin));
    await writeFile(
      join(ws.path, 'app.ts'),
      'const password = readPassword();\nconst apiKey = env.API_KEY;\n',
    );
    await manager.commit(ws, { message: 'feat: app', author: AUTHOR });
    await expect(manager.push(ws, { expectedRemoteSha: null })).resolves.toBeDefined();
  });

  it('scanGitLog reports line numbers of added lines only', () => {
    const log = [
      '\u0000remyral-commit abc123',
      'subject',
      '\u0000remyral-end-message',
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,3 @@',
      ' keep',
      `-${GH_TOKEN}`,
      '+new',
      `+${GH_TOKEN}`,
    ].join('\n');
    expect(scanGitLog(log, prePushScanner())).toEqual([
      { commit: 'abc123', location: 'f:3', label: 'github-token' },
    ]);
  });
});

describe.skipIf(isWindows)('release and retention', GIT_TIMEOUT, () => {
  it('deletes a successful workspace only after artifacts were collected', async () => {
    const { origin, manager } = await setup();
    const ws = await manager.prepare(request(origin));
    await expect(manager.release(ws, { status: 'succeeded', artifactsCollected: false })).rejects.toThrow(
      WorkspaceError,
    );
    expect((await lstat(ws.path)).isDirectory()).toBe(true);
    expect(await manager.release(ws, { status: 'succeeded', artifactsCollected: true })).toBe('deleted');
    await expect(lstat(ws.path)).rejects.toThrow();
    expect(git(ws.mirrorPath, ['for-each-ref', 'refs/heads'])).toBe('');
    expect(git(ws.mirrorPath, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });

  it('keeps the newest N failed workspaces and removes older ones', async () => {
    let t = Date.parse('2026-10-13T00:00:00.000Z');
    const { origin, manager } = await setup({ retainFailed: 2, clock: () => new Date((t += 1000)) });
    const wss = [];
    for (const id of ['f1', 'f2', 'f3']) {
      const ws = await manager.prepare(request(origin, id));
      wss.push(ws);
      expect(await manager.release(ws, { status: id === 'f2' ? 'cancelled' : 'failed' })).toBe('retained');
    }
    const kept = await manager.listRetained();
    expect(kept.map((r) => r.attemptId)).toEqual(['f3', 'f2']);
    await expect(lstat(wss[0]?.path ?? '')).rejects.toThrow();
    expect((await lstat(wss[2]?.path ?? '')).isDirectory()).toBe(true);
    expect(
      git(wss[0]?.mirrorPath ?? '', ['for-each-ref', '--format=%(refname)', 'refs/heads'])
        .split('\n')
        .sort(),
    ).toEqual(['refs/heads/rac/job1/f2', 'refs/heads/rac/job1/f3']);
  });

  it('release refuses a workspace path replaced by a symlink', async () => {
    const { dir, origin, manager } = await setup();
    const ws = await manager.prepare(request(origin));
    const { rm } = await import('node:fs/promises');
    await rm(ws.path, { recursive: true, force: true });
    const outside = join(dir, 'precious');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, ws.path);
    await expect(manager.release(ws, { status: 'succeeded', artifactsCollected: true })).rejects.toThrow(
      UnsafePathError,
    );
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe.skipIf(isWindows)('mirror lock', GIT_TIMEOUT, () => {
  it('serializes holders and removes a lock file left by a dead process', async () => {
    const dir = await tempDir('rw-lock-');
    const lockPath = join(dir, 'm.lock');
    await writeFile(lockPath, '999999\n');
    const locks = new PathLocks({ isAlive: () => false });
    const order: string[] = [];
    await Promise.all([
      locks.with(lockPath, async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
      }),
      locks.with(lockPath, () => {
        order.push('b');
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    await expect(lstat(lockPath)).rejects.toThrow();
  });

  it('times out while a live process holds the lock', async () => {
    const dir = await tempDir('rw-lock-');
    const lockPath = join(dir, 'm.lock');
    await writeFile(lockPath, '1\n'); // pid 1 (init/launchd) is always alive
    const locks = new PathLocks({ timeoutMs: 50, isAlive: () => true });
    await expect(locks.with(lockPath, () => Promise.resolve())).rejects.toThrow(/timed out/);
  });
});
