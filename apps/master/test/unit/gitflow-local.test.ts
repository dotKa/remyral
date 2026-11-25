import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flagPaths } from '../../src/gitflow/flags.js';
import { LocalGitProvider, parseCommitObject } from '../../src/gitflow/local-provider.js';
import {
  attemptBranch,
  githubRepo,
  isTargetBranch,
  parseRepoUrl,
  sameRepository,
  trailerValues,
} from '../../src/gitflow/refs.js';

describe('git flow refs, trailers, flags', () => {
  it('names attempt branches safely and validates target branches', () => {
    expect(attemptBranch('j-1', 'a.2')).toBe('rac/j-1/a.2');
    expect(() => attemptBranch('../x', 'a')).toThrow();
    expect(isTargetBranch('main')).toBe(true);
    expect(isTargetBranch('release/1.2')).toBe(true);
    for (const bad of ['-main', 'a..b', 'rac/x/y', 'x.lock', 'a//b', 'a/', '@{u}', 'a b']) {
      expect(isTargetBranch(bad), bad).toBe(false);
    }
  });

  it('parses repository URLs like the worker and compares canonically', () => {
    expect(parseRepoUrl('https://GitHub.com/acme/app.git')?.key).toBe('github.com/acme/app');
    expect(sameRepository('https://github.com/acme/app', 'https://github.com/acme/app.git/')).toBe(true);
    expect(sameRepository('https://github.com/acme/app', 'https://github.com/acme/App')).toBe(false);
    for (const bad of [
      'http://x/y',
      'https://u:p@x/y',
      'https://x/a/../b',
      'file:///tmp/x',
      'https://x/y?q=1',
      'https://x/a%2fb',
    ]) {
      expect(parseRepoUrl(bad), bad).toBeNull();
    }
    expect(githubRepo('ssh://git@github.com/acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
    expect(githubRepo('https://github.com/acme/app/extra')).toBeNull();
  });

  it('reads trailers only from the trailer block', () => {
    expect(
      trailerValues('fix\n\nbody\n\nRemyral-Attempt: a/2\nSigned-off-by: x\n', 'Remyral-Attempt'),
    ).toEqual(['a/2']);
    // Mentioned in the body, not a trailer.
    expect(trailerValues('fix\n\nRemyral-Attempt: a/1 is old\nmore text\n', 'Remyral-Attempt')).toEqual([]);
    expect(trailerValues('only subject', 'Remyral-Attempt')).toEqual([]);
    expect(trailerValues('s\n\nRemyral-Attempt: a/1\nRemyral-Attempt: a/2', 'Remyral-Attempt')).toEqual([
      'a/1',
      'a/2',
    ]);
  });

  it('flags CI configuration, dependency manifests and repository policy files (T-INJ-3)', () => {
    const flags = flagPaths([
      { path: '.github/workflows/ci.yml' },
      { path: 'src/index.ts' },
      { path: 'web/package.json' },
      { path: 'AGENTS.md' },
      { path: 'new.lock', previousPath: 'Cargo.lock' },
    ]);
    expect(flags).toEqual([
      { path: '.github/workflows/ci.yml', kind: 'ci_config' },
      { path: 'web/package.json', kind: 'dependency_manifest' },
      { path: 'AGENTS.md', kind: 'repository_policy' },
      { path: 'Cargo.lock', kind: 'dependency_manifest' },
    ]);
  });

  it('parses commit objects', () => {
    const c = parseCommitObject(
      'f'.repeat(40),
      `tree ${'1'.repeat(40)}\nparent ${'2'.repeat(40)}\nauthor A B <a@b> 1760000000 +0000\ncommitter C <c@d> 1760000000 +0000\n\nsubject\n\nRemyral-Attempt: x/1\n`,
    );
    expect(c).toMatchObject({
      parents: ['2'.repeat(40)],
      author: { name: 'A B', email: 'a@b' },
      message: 'subject\n\nRemyral-Attempt: x/1\n',
    });
  });
});

describe('plain git provider (real git, local bare repository)', () => {
  let root: string;
  let bare: string;
  let url: string;
  let p: LocalGitProvider;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
      encoding: 'utf8',
    }).trim();
  let work: string;
  const commitOn = async (branch: string, files: Record<string, string>, msg: string): Promise<string> => {
    git(work, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    for (const [f, c] of Object.entries(files)) await writeFile(join(work, f), c);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', msg);
    git(work, 'push', '-q', 'origin', `${branch}:${branch}`);
    git(work, 'fetch', '-q', 'origin');
    return git(work, 'rev-parse', 'HEAD');
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rw-gfl-'));
    bare = join(root, 'r.git');
    url = pathToFileURL(bare).toString();
    git(root, 'init', '-q', '--bare', '--initial-branch=main', bare);
    work = join(root, 'w');
    await mkdir(work);
    git(work, 'init', '-q', '--initial-branch=main');
    await writeFile(join(work, 'f.txt'), 'a\nb\nc\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'remote', 'add', 'origin', bare);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'fetch', '-q', 'origin');
    p = new LocalGitProvider({ url, cacheDir: join(root, 'cache'), allowFileUrls: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses non-https/ssh URLs unless file URLs are explicitly allowed', () => {
    expect(() => new LocalGitProvider({ url, cacheDir: join(root, 'c2') })).toThrow();
    expect(
      () => new LocalGitProvider({ url: 'git://x/y', cacheDir: join(root, 'c2'), allowFileUrls: true }),
    ).toThrow();
  });

  it('compares, detects exact conflicts with both sides’ commits, ignores merge=union attributes, merges and guards', async () => {
    const start = git(work, 'rev-parse', 'origin/main');
    git(work, 'push', '-q', 'origin', 'main:refs/heads/rac/j/a');
    git(work, 'fetch', '-q', 'origin');
    // The attempt also tries to make conflicts disappear via .gitattributes.
    const head = await commitOn(
      'rac/j/a',
      { 'f.txt': 'a\nATTEMPT\nc\n', '.gitattributes': '* merge=union\n' },
      'attempt',
    );
    expect(await p.branchHead('rac/j/a')).toBe(head);
    expect(await p.branchHead('rac/j/missing')).toBeNull();
    const cmp = await p.compare(start, head);
    expect(cmp.status).toBe('ahead');
    expect(cmp.files.map((f) => f.path).sort()).toEqual(['.gitattributes', 'f.txt']);
    expect(cmp.commits.map((c) => c.sha)).toEqual([head]);

    const clean = await p.testMerge({
      targetBranch: 'main',
      headSha: head,
      headBranch: 'rac/j/a',
      baseAtStart: start,
      pullRequest: null,
    });
    expect(clean.state).toBe('clean');

    const theirs = await commitOn('main', { 'f.txt': 'a\nMAIN\nc\n' }, 'main moved');
    const conflict = await p.testMerge({
      targetBranch: 'main',
      headSha: head,
      headBranch: 'rac/j/a',
      baseAtStart: start,
      pullRequest: null,
    });
    expect(conflict).toMatchObject({
      state: 'conflicts',
      files: ['f.txt'],
      precision: 'exact',
      baseSha: theirs,
    });
    if (conflict.state === 'conflicts') {
      expect(conflict.headCommits.map((c) => c.sha)).toEqual([head]);
      expect(conflict.baseCommits.map((c) => c.sha)).toEqual([theirs]);
    }
    const refused = await p.merge({
      targetBranch: 'main',
      headSha: head,
      headBranch: 'rac/j/a',
      method: 'merge',
      pullRequest: null,
      title: 't',
      message: 'm',
    });
    expect(refused).toMatchObject({ merged: false, reason: 'conflicts' });
    expect(git(bare, 'rev-parse', 'main')).toBe(theirs);
  });

  it('merges a clean head (merge commit / squash), refuses a moved head, finds the merge by trailer', async () => {
    const start = git(bare, 'rev-parse', 'main');
    git(work, 'push', '-q', 'origin', 'main:refs/heads/rac/j/b');
    git(work, 'fetch', '-q', 'origin');
    const head = await commitOn('rac/j/b', { 'g.txt': 'new\n' }, 'add g');
    const moved = await p.merge({
      targetBranch: 'main',
      headSha: start,
      headBranch: 'rac/j/b',
      method: 'merge',
      pullRequest: null,
      title: 't',
      message: 'm',
    });
    expect(moved).toMatchObject({ merged: false, reason: 'head_moved' });
    const ok = await p.merge({
      targetBranch: 'main',
      headSha: head,
      headBranch: 'rac/j/b',
      method: 'merge',
      pullRequest: null,
      title: 'Merge',
      message: 'body\n\nRemyral-Merge: mr-1\n',
    });
    expect(ok.merged).toBe(true);
    const mergeSha = ok.merged ? ok.sha : '';
    expect(git(bare, 'rev-parse', 'main')).toBe(mergeSha);
    expect(git(bare, 'log', '-1', '--format=%P', 'main')).toBe(`${start} ${head}`);
    // No project / workspace identity: the master's own merge identity.
    expect(git(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main')).toBe(
      'Remyral Git Flow <gitflow@remyral.invalid>|Remyral Git Flow <gitflow@remyral.invalid>',
    );
    expect(await p.findMerge('main', 'mr-1')).toBe(mergeSha);
    expect(await p.findMerge('main', 'mr-2')).toBeNull();

    git(work, 'fetch', '-q', 'origin');
    git(work, 'push', '-q', 'origin', 'origin/main:refs/heads/rac/j/c');
    git(work, 'fetch', '-q', 'origin');
    const h2 = await commitOn('rac/j/c', { 'h.txt': 'h\n' }, 'add h');
    const squash = await p.merge({
      targetBranch: 'main',
      headSha: h2,
      headBranch: 'rac/j/c',
      method: 'squash',
      pullRequest: null,
      title: 'Squash',
      message: 'x',
      // p5-git-identity: the project's identity signs the merge commit too.
      committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect(squash.merged).toBe(true);
    expect(git(bare, 'log', '-1', '--format=%P', 'main')).toBe(mergeSha);
    expect(git(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main')).toBe(
      'Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>',
    );
  });

  it('deletes a branch only at the expected sha; reports a rewritten base', async () => {
    const head = git(bare, 'rev-parse', 'rac/j/c');
    expect(await p.deleteBranch('rac/j/c', 'e'.repeat(40))).toBe('moved');
    expect(await p.deleteBranch('rac/j/c', head)).toBe('deleted');
    expect(await p.deleteBranch('rac/j/c', head)).toBe('absent');
    // Rewrite main to an unrelated root: the base at job start is gone from its history.
    const orphan = join(root, 'o');
    await mkdir(orphan);
    git(orphan, 'init', '-q', '--initial-branch=main');
    await writeFile(join(orphan, 'x'), 'x');
    git(orphan, 'add', '.');
    git(orphan, 'commit', '-q', '-m', 'orphan');
    const start = git(bare, 'rev-parse', 'main');
    git(orphan, 'push', '-q', '-f', bare, 'main:main');
    const r = await p.testMerge({
      targetBranch: 'main',
      headSha: start,
      headBranch: 'rac/j/a',
      baseAtStart: start,
      pullRequest: null,
    });
    expect(r.state).toBe('base_moved');
  });
});
