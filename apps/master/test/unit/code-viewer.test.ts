import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BitbucketProvider } from '../../src/gitflow/bitbucket-provider.js';
import { GitHubAppAuth } from '../../src/gitflow/github-app.js';
import { GitHubProvider } from '../../src/gitflow/github-provider.js';
import { GitLabProvider } from '../../src/gitflow/gitlab-provider.js';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { classifyBlob, classifyText, isRepoPath, ProviderError } from '../../src/gitflow/types.js';
import {
  codeRefId,
  codeRefLabel,
  languageOf,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_LINES,
  parseCodeRef,
  sliceLines,
} from '../../src/code/reference.js';

/**
 * p19-ide W1: provider `tree` / `blob` (GitHub, GitLab, Bitbucket against fixture responses — no network; plain git
 * against a real local bare repository), binary / size classification, and the `code` reference id and line cut.
 */
const SHA = 'a'.repeat(40);

type Route = (url: string) => { status: number; body?: unknown; text?: string };

function fetchOf(routes: Record<string, Route>, prefix: string) {
  const calls: string[] = [];
  const fn = (input: string, init: RequestInit): Promise<Response> => {
    const path = input.replace(prefix, '');
    calls.push(`${init.method ?? 'GET'} ${path}`);
    const handler =
      routes[`${init.method ?? 'GET'} ${path}`] ??
      routes[`${init.method ?? 'GET'} ${path.split('?')[0] ?? ''}`];
    if (handler === undefined)
      return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
    const r = handler(input);
    return Promise.resolve(
      new Response(r.text ?? JSON.stringify(r.body ?? {}), {
        status: r.status,
        headers: { 'content-type': r.text === undefined ? 'application/json' : 'text/plain' },
      }),
    );
  };
  return { fn, calls };
}

describe('paths, classification and references', () => {
  it('accepts repository-relative paths only', () => {
    for (const ok of ['a', 'src/app.ts', '.github/workflows/ci.yml', 'a b/c.md'])
      expect(isRepoPath(ok), ok).toBe(true);
    for (const bad of [
      '',
      '/etc/passwd',
      'a/../b',
      '../x',
      './a',
      'a//b',
      'a/',
      'a\\b',
      'a\u0000b',
      'x'.repeat(1025),
    ])
      expect(isRepoPath(bad), bad).toBe(false);
    expect(isRepoPath('', true)).toBe(true);
  });

  it('classifies bytes: text, NUL = binary, invalid UTF-8 = binary, over the cap = too large', () => {
    expect(classifyBlob(Buffer.from('héllo\n'), 7, 100)).toEqual({ state: 'text', text: 'héllo\n', size: 7 });
    expect(classifyBlob(Buffer.from([0x89, 0x50, 0x00, 0x01]), 4, 100).state).toBe('binary');
    expect(classifyBlob(Buffer.from([0xff, 0xfe, 0x41]), 3, 100).state).toBe('binary');
    expect(classifyBlob(Buffer.alloc(10, 0x41), 10, 5)).toEqual({ state: 'too_large', size: 10 });
    expect(classifyText('a�b', 4, 100).state).toBe('binary');
    expect(classifyText('ok', 2, 100).state).toBe('text');
  });

  it('round-trips a reference id and refuses malformed ones', () => {
    const ref = { source: 'repo' as const, ref: SHA, startLine: 40, endLine: 58, path: 'src/app.ts' };
    const id = codeRefId(ref);
    expect(id).toBe(`repo:${SHA}:40-58:src/app.ts`);
    expect(parseCodeRef(id)).toEqual(ref);
    expect(codeRefLabel(ref)).toBe('src/app.ts:40-58 · aaaaaaa');
    const wf = {
      source: 'workfiles' as const,
      ref: '00000000-0000-4000-8000-000000000001',
      startLine: 3,
      endLine: 3,
      path: 'out/a.md',
    };
    expect(parseCodeRef(codeRefId(wf))).toEqual(wf);
    expect(codeRefLabel(wf)).toBe('out/a.md:3');
    for (const bad of [
      `repo:${SHA}:0-2:a`,
      `repo:${SHA}:5-2:a`,
      `repo:main:1-2:a`,
      `repo:${SHA}:1-2:../etc/passwd`,
      `repo:${SHA}:1-2:/abs`,
      `other:${SHA}:1-2:a`,
      `workfiles:${SHA}:1-2:a`,
    ])
      expect(parseCodeRef(bad), bad).toBeNull();
  });

  it('cuts referenced lines to 400 lines and 24 KiB', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const s = sliceLines(text, 10, 12);
    expect(s).toMatchObject({
      text: 'line 10\nline 11\nline 12',
      endLine: 12,
      truncated: false,
      totalLines: 1000,
    });
    const long = sliceLines(text, 1, 1000);
    expect(long.endLine).toBe(MAX_REFERENCE_LINES);
    expect(long.truncated).toBe(true);
    const wide = Array.from({ length: 100 }, () => 'x'.repeat(1000)).join('\n');
    const w = sliceLines(wide, 1, 100);
    expect(Buffer.byteLength(w.text)).toBeLessThanOrEqual(MAX_REFERENCE_BYTES);
    expect(w.truncated).toBe(true);
    expect(sliceLines('a\nb\n', 2, 9)).toMatchObject({
      text: 'b',
      endLine: 2,
      truncated: true,
      totalLines: 2,
    });
    expect(languageOf('src/x.tsx')).toBe('tsx');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('README')).toBeNull();
  });
});

describe('GitHub tree / blob (fixtures)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const R = '/repos/acme/app';
  const provider = (routes: Record<string, Route>) => {
    const f = fetchOf(
      {
        'POST /app/installations/42/access_tokens': () => ({
          status: 201,
          body: {
            token: 'ghs_fixtureInstallationToken0001',
            expires_at: '2099-10-13T11:00:00Z',
            permissions: {},
          },
        }),
        ...routes,
      },
      'https://api.github.com',
    );
    const auth = new GitHubAppAuth({ appId: '1', privateKey, fetch: f.fn });
    return {
      p: new GitHubProvider({ owner: 'acme', repo: 'app', installationId: 42, auth, fetch: f.fn }),
      calls: f.calls,
    };
  };

  it('lists a directory and reads text, binary and too large files', async () => {
    const { p, calls } = provider({
      [`GET ${R}/contents/?ref=${SHA}`]: () => ({
        status: 200,
        body: [
          { type: 'file', name: 'README.md', path: 'README.md', size: 12 },
          { type: 'dir', name: 'src', path: 'src', size: 0 },
          { type: 'symlink', name: 'l', path: 'l', size: 3 },
          { type: 'file', name: 'bad', path: '../bad', size: 1 },
        ],
      }),
      [`GET ${R}/contents/src/a%20b.ts?ref=${SHA}`]: () => ({
        status: 200,
        body: {
          type: 'file',
          size: 6,
          encoding: 'base64',
          content: Buffer.from('x = 1\n').toString('base64'),
        },
      }),
      [`GET ${R}/contents/img.png?ref=${SHA}`]: () => ({
        status: 200,
        body: {
          type: 'file',
          size: 4,
          encoding: 'base64',
          content: Buffer.from([0x89, 0, 1, 2]).toString('base64'),
        },
      }),
      [`GET ${R}/contents/big.bin?ref=${SHA}`]: () => ({
        status: 200,
        body: { type: 'file', size: 5_000_000, encoding: 'none', content: '' },
      }),
      [`GET ${R}/contents/src?ref=${SHA}`]: () => ({ status: 200, body: [] }),
    });
    const t = await p.tree(SHA, '');
    expect(t?.entries.map((e) => [e.path, e.kind])).toEqual([
      ['README.md', 'file'],
      ['src', 'dir'],
      ['l', 'symlink'],
    ]);
    expect(await p.blob(SHA, 'src/a b.ts', 1024)).toEqual({ state: 'text', text: 'x = 1\n', size: 6 });
    expect((await p.blob(SHA, 'img.png', 1024))?.state).toBe('binary');
    expect(await p.blob(SHA, 'big.bin', 1024 * 1024)).toEqual({ state: 'too_large', size: 5_000_000 });
    // A directory is not a file, a missing path is null.
    expect(await p.blob(SHA, 'src', 1024)).toBeNull();
    expect(await p.blob(SHA, 'missing.ts', 1024)).toBeNull();
    expect(await p.tree(SHA, 'missing')).toBeNull();
    await expect(p.tree('main', '')).rejects.toBeInstanceOf(ProviderError);
    await expect(p.blob(SHA, '../x', 10)).rejects.toBeInstanceOf(ProviderError);
    expect(calls.every((c) => !c.includes('..'))).toBe(true);
  });
});

describe('GitLab / Bitbucket tree / blob (fixtures)', () => {
  it('GitLab: repository/tree pages and repository/files', async () => {
    const f = fetchOf(
      {
        [`GET /repository/tree?ref=${SHA}&per_page=100&page=1&path=src`]: () => ({
          status: 200,
          body: [
            { name: 'a.ts', path: 'src/a.ts', type: 'blob', mode: '100644' },
            { name: 'lib', path: 'src/lib', type: 'tree', mode: '040000' },
            { name: 'sub', path: 'src/sub', type: 'commit', mode: '160000' },
          ],
        }),
        [`GET /repository/files/src%2Fa.ts?ref=${SHA}`]: () => ({
          status: 200,
          body: { size: 3, encoding: 'base64', content: Buffer.from('ok\n').toString('base64') },
        }),
        [`GET /repository/files/big?ref=${SHA}`]: () => ({
          status: 200,
          body: { size: 9_000_000, encoding: 'base64', content: '' },
        }),
      },
      'https://git.example.test/api/v4/projects/acme%2Fapp',
    );
    const p = new GitLabProvider({
      baseUrl: 'https://git.example.test',
      projectPath: 'acme/app',
      token: () => Promise.resolve('t'),
      fetch: f.fn,
    });
    const t = await p.tree(SHA, 'src');
    expect(t?.entries.map((e) => [e.path, e.kind])).toEqual([
      ['src/a.ts', 'file'],
      ['src/lib', 'dir'],
      ['src/sub', 'submodule'],
    ]);
    expect(await p.blob(SHA, 'src/a.ts', 100)).toEqual({ state: 'text', text: 'ok\n', size: 3 });
    expect(await p.blob(SHA, 'big', 1024)).toEqual({ state: 'too_large', size: 9_000_000 });
    expect(await p.blob(SHA, 'nope', 1024)).toBeNull();
  });

  it('Bitbucket: src listing and meta + raw file', async () => {
    const f = fetchOf(
      {
        [`GET /src/${SHA}/?pagelen=100&page=1`]: () => ({
          status: 200,
          body: {
            values: [
              { type: 'commit_file', path: 'a.md', size: 5 },
              { type: 'commit_directory', path: 'src' },
            ],
          },
        }),
        [`GET /src/${SHA}/a.md?format=meta`]: () => ({ status: 200, body: { type: 'commit_file', size: 5 } }),
        [`GET /src/${SHA}/a.md`]: () => ({ status: 200, text: 'hi!!\n' }),
        [`GET /src/${SHA}/src?format=meta`]: () => ({ status: 200, body: { type: 'commit_directory' } }),
      },
      'https://api.bitbucket.test/2.0/repositories/acme/app',
    );
    const p = new BitbucketProvider({
      apiUrl: 'https://api.bitbucket.test',
      workspace: 'acme',
      repoSlug: 'app',
      token: () => Promise.resolve('t'),
      fetch: f.fn,
    });
    const t = await p.tree(SHA, '');
    expect(t?.entries.map((e) => [e.path, e.kind, e.size])).toEqual([
      ['a.md', 'file', 5],
      ['src', 'dir', null],
    ]);
    expect(await p.blob(SHA, 'a.md', 100)).toEqual({ state: 'text', text: 'hi!!\n', size: 5 });
    expect(await p.blob(SHA, 'src', 100)).toBeNull();
  });
});

describe('plain git tree / blob (real git, local bare repository)', () => {
  let root: string;
  let p: LocalGitProvider;
  let head: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rw-code-'));
    const bare = join(root, 'r.git');
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    git(root, 'init', '-q', '--bare', '--initial-branch=main', bare);
    const work = join(root, 'w');
    await mkdir(join(work, 'src', 'deep'), { recursive: true });
    await writeFile(join(work, 'README.md'), '# hi\n');
    await writeFile(join(work, 'src', 'app.ts'), 'export const a = 1;\n');
    await writeFile(join(work, 'src', 'deep', 'x.txt'), 'x\n');
    await writeFile(join(work, 'logo.bin'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
    await writeFile(join(work, 'big.txt'), 'y'.repeat(5000));
    git(work, 'init', '-q', '--initial-branch=main');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'remote', 'add', 'origin', bare);
    git(work, 'push', '-q', 'origin', 'main');
    head = git(work, 'rev-parse', 'HEAD');
    p = new LocalGitProvider({
      url: pathToFileURL(bare).toString(),
      cacheDir: join(root, 'cache'),
      allowFileUrls: true,
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists directories and reads files at a commit', async () => {
    const t = await p.tree(head, '');
    expect(t?.entries.map((e) => [e.path, e.kind]).sort()).toEqual([
      ['README.md', 'file'],
      ['big.txt', 'file'],
      ['logo.bin', 'file'],
      ['src', 'dir'],
    ]);
    expect(t?.entries.find((e) => e.path === 'README.md')?.size).toBe(5);
    const sub = await p.tree(head, 'src');
    expect(sub?.entries.map((e) => e.path).sort()).toEqual(['src/app.ts', 'src/deep']);
    expect(await p.tree(head, 'README.md')).toBeNull();
    expect(await p.tree(head, 'nope')).toBeNull();
    expect(await p.blob(head, 'src/app.ts', 1024)).toEqual({
      state: 'text',
      text: 'export const a = 1;\n',
      size: 20,
    });
    expect((await p.blob(head, 'logo.bin', 1024))?.state).toBe('binary');
    expect(await p.blob(head, 'big.txt', 1024)).toEqual({ state: 'too_large', size: 5000 });
    expect(await p.blob(head, 'src', 1024)).toBeNull();
    await expect(p.blob(head, '../r.git/config', 1024)).rejects.toBeInstanceOf(ProviderError);
  });
});
