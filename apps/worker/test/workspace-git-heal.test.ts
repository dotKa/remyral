import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitCommandError, SecretScanError } from '../src/workspace/errors.js';
import { dubiousOwnershipPath, GitRunner, isBrokenRefFailure } from '../src/workspace/git.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { GitLogScan, prePushScanner, scanGitLog, scanLogArgs } from '../src/workspace/secret-scan.js';
import { createOrigin, git, type Origin } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

/**
 * p22-git-preflight (docs/design/p22-git-preflight.md §3): the worker heals its cached clone by itself — a ref to a
 * missing object is removed and the fetch retried once, a repository of its own root that another account owns is
 * trusted for exactly its path, and the pre-push secret scan walks only the attempt's own commits (streamed).
 */

const GIT_TIMEOUT = { timeout: 120_000 };
const AUTHOR = { name: 'Remyral Agent', email: 'agent@remyral.invalid' };
const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

async function setup(opts: { gitBinary?: string; root?: string; origin?: Origin } = {}) {
  const dir = await realpath(await tempDir('rw-heal-'));
  const origin = opts.origin ?? (await createOrigin(dir));
  const manager = await WorkspaceManager.create({
    root: opts.root ?? join(dir, 'root'),
    projects: { proj: [origin.url] },
    allowFileUrls: true,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    ...(opts.gitBinary === undefined ? {} : { gitBinary: opts.gitBinary }),
  });
  return { dir, origin, manager };
}

const request = (origin: Origin, attemptId: string, baseRef = 'main') => ({
  projectId: 'proj',
  jobId: 'job1',
  attemptId,
  epoch: 1,
  repository: { url: origin.url, baseRef },
});

describe('git failure parsing (p22-git-preflight)', () => {
  it('reads the repository path of a dubious-ownership refusal', () => {
    expect(
      dubiousOwnershipPath(
        "fatal: detected dubious ownership in repository at 'C:/remyral/root/mirrors/ab.git'\nTo add an exception…",
      ),
    ).toBe('C:/remyral/root/mirrors/ab.git');
    expect(dubiousOwnershipPath('fatal: could not read Username')).toBeNull();
  });

  it('recognises refs to missing objects', () => {
    expect(
      isBrokenRefFailure(new GitCommandError('fetch', 1, 'fatal: bad object refs/heads/rac/j/a\n')),
    ).toBe(true);
    expect(
      isBrokenRefFailure(
        new GitCommandError('for-each-ref', 128, 'fatal: missing object 1111111 for refs/heads/rac/j/a'),
      ),
    ).toBe(true);
    expect(isBrokenRefFailure(new GitCommandError('fetch', 128, 'fatal: bad object HEAD'))).toBe(false);
    expect(isBrokenRefFailure(new Error('bad object refs/heads/x'))).toBe(false);
  });

  it('bounds the scan by the base commit and refuses anything but a full sha', () => {
    const sha = 'a'.repeat(40);
    const args = scanLogArgs('refs/heads/rac/j/a', sha);
    expect(args.slice(args.indexOf('--not'))).toEqual(['--not', sha, '--remotes=origin', '--']);
    expect(() => scanLogArgs('refs/heads/rac/j/a', '--all')).toThrow(TypeError);
  });

  it('a streamed scan finds the same as a whole-log scan, across chunk and UTF-8 boundaries', () => {
    const log = [
      '\u0000remyral-commit ' + 'b'.repeat(40),
      'add config ü',
      '\u0000remyral-end-message',
      'diff --git a/c.js b/c.js',
      '+++ b/c.js',
      '@@ -0,0 +1,2 @@',
      '+const ok = "çğ";',
      `+const t = "${GH_TOKEN}";`,
      '',
    ].join('\n');
    const whole = scanGitLog(log, prePushScanner());
    expect(whole.map((f) => [f.commit, f.location])).toEqual([['b'.repeat(40), 'c.js:2']]);
    const bytes = Buffer.from(log, 'utf8');
    const scan = new GitLogScan(prePushScanner());
    for (let i = 0; i < bytes.length; i += 7) scan.write(bytes.subarray(i, i + 7));
    expect(scan.end()).toEqual(whole);
  });
});

describe.skipIf(isWindows)('cached clone self-heal (p22-git-preflight)', GIT_TIMEOUT, () => {
  it('removes attempt refs to missing objects and fetches again', async () => {
    const { origin, manager } = await setup();
    const ws1 = await manager.prepare(request(origin, 'a1'));
    // A worker killed while writing left two attempt branches pointing at objects that do not exist.
    for (const name of ['old1', 'old2']) {
      await mkdir(join(ws1.mirrorPath, 'refs', 'heads', 'rac', 'gone'), { recursive: true });
      await writeFile(join(ws1.mirrorPath, 'refs', 'heads', 'rac', 'gone', name), `${'1'.repeat(40)}\n`);
    }
    git(origin.work, ['commit', '--allow-empty', '-m', 'upstream moved']);
    git(origin.work, ['push', 'origin', 'main']);

    const ws2 = await manager.prepare(request(origin, 'a2'));
    expect(ws2.baseCommit).toBe(git(origin.work, ['rev-parse', 'HEAD']));
    const refs = git(ws1.mirrorPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/rac/']);
    expect(refs).not.toContain('rac/gone');
    // The live attempt branches are untouched.
    expect(refs).toContain('refs/heads/rac/job1/a1');
    expect(refs).toContain('refs/heads/rac/job1/a2');
  });

  it('trusts exactly the mirror path when git calls it dubiously owned, never a path outside the root', async () => {
    const first = await setup();
    await first.manager.prepare(request(first.origin, 'a1'));
    // git as another account would see it: every repository is "owned by someone else".
    const wrapper = join(first.dir, 'git-other-owner.sh');
    await writeFile(wrapper, '#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec git "$@"\n');
    await chmod(wrapper, 0o755);
    const other = await setup({ gitBinary: wrapper, root: first.manager.root, origin: first.origin });

    const ws = await other.manager.prepare(request(first.origin, 'a2'));
    expect(ws.baseCommit).toBe(first.origin.initial);
    const trusted = other.manager.git.safeDirectories;
    expect(trusted.length).toBeGreaterThan(0);
    expect(trusted.every((p) => p.startsWith(`${first.manager.root}/`))).toBe(true);
    expect(trusted).not.toContain('*');

    // A repository outside the trust root stays refused.
    const runner = new GitRunner({
      binary: wrapper,
      emptyHooksDir: join(first.dir, 'hooks'),
      trustRoot: first.manager.root,
    });
    await expect(runner.run({ cwd: first.origin.work, args: ['status'] })).rejects.toThrow(
      /dubious ownership/,
    );
    expect(runner.safeDirectories).toEqual([]);
  });

  it('scans only the attempt’s own commits even when the base is no longer under refs/remotes', async () => {
    const dir = await realpath(await tempDir('rw-heal-scan-'));
    const origin = await createOrigin(dir);
    // An old upstream commit carries a token (already public — not this attempt's content).
    await writeFile(join(origin.work, 'old.js'), `export const t = "${GH_TOKEN}";\n`);
    git(origin.work, ['add', '-A']);
    git(origin.work, ['commit', '-m', 'old token']);
    git(origin.work, ['push', 'origin', 'main']);
    const { manager } = await setup({ origin, root: join(dir, 'root') });
    const ws = await manager.prepare(request(origin, 'a1'));
    // The base branch was squash-merged / deleted: the mirror has no remote ref containing the base any more.
    git(ws.mirrorPath, ['update-ref', '-d', 'refs/remotes/origin/main']);
    await writeFile(join(ws.path, 'new.js'), 'export const ok = 1;\n');
    await manager.commit(ws, { message: 'feat: clean change', author: AUTHOR });
    await expect(manager.push(ws, { expectedRemoteSha: null })).resolves.toBeDefined();

    // A token in the attempt's own commit is still refused.
    const ws2 = await manager.prepare(request(origin, 'a2'));
    await writeFile(join(ws2.path, 'leak.js'), `export const t = "${GH_TOKEN}";\n`);
    await manager.commit(ws2, { message: 'add', author: AUTHOR });
    await expect(manager.push(ws2, { expectedRemoteSha: null })).rejects.toThrow(SecretScanError);
  });
});
