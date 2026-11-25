import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubAppAuth } from '../../src/gitflow/github-app.js';
import { GitHubProvider } from '../../src/gitflow/github-provider.js';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { ProviderError } from '../../src/gitflow/types.js';

/**
 * p11-merge-pipeline: the provider operations the integration uses — create / fast-forward the integration branch
 * (never forced, refused when it moved) and update the one pull request's description. GitHub against fixture REST
 * responses (UNVERIFIED-LIVE: `POST git/refs`, `PATCH git/refs/heads/{b}` with `force: false`, `PATCH pulls/{n}`, per
 * docs.github.com "Git references" / "Pulls", API 2022-11-28); plain git against real repositories.
 */

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = new Date('2026-10-18T10:00:00.000Z');
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const START = 'c'.repeat(40);
const R = '/repos/acme/app';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function github(routes: Record<string, () => { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (input: string, init: RequestInit): Promise<Response> => {
    const call = {
      method: init.method ?? 'GET',
      url: input,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${input.replace('https://api.github.com', '')}`;
    if (key.startsWith('POST /app/installations/')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ token: 'ghs_fixtureToken000000000001', expires_at: '2026-10-18T11:00:00Z' }),
          {
            status: 201,
          },
        ),
      );
    }
    const handler = routes[key];
    const r = handler === undefined ? { status: 404, body: { message: 'Not Found' } } : handler();
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status }));
  };
  const auth = new GitHubAppAuth({ appId: '12345', privateKey, fetch: fetchFn, clock: () => NOW });
  return {
    p: new GitHubProvider({ owner: 'acme', repo: 'app', installationId: 42, auth, fetch: fetchFn }),
    calls,
  };
}

describe('GitHub provider: integration branch and PR (fixtures)', () => {
  it('creates the branch with POST git/refs; an existing one is refused without a write', async () => {
    let at: string | null = null;
    const { p, calls } = github({
      [`GET ${R}/git/ref/heads/int/abcd1234`]: () =>
        at === null
          ? { status: 404 }
          : { status: 200, body: { ref: 'refs/heads/int/abcd1234', object: { sha: at, type: 'commit' } } },
      [`POST ${R}/git/refs`]: () => {
        at = HEAD;
        return { status: 201, body: {} };
      },
    });
    expect(await p.updateBranch('int/abcd1234', HEAD, null)).toBe('updated');
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))?.body).toEqual({
      ref: 'refs/heads/int/abcd1234',
      sha: HEAD,
    });
    const before = calls.length;
    expect(await p.updateBranch('int/abcd1234', OTHER, null)).toBe('moved');
    expect(calls.slice(before).every((c) => c.method === 'GET' || c.url.includes('/app/'))).toBe(true);
    // Already there: a no-op success.
    expect(await p.updateBranch('int/abcd1234', HEAD, START)).toBe('updated');
  });

  it('fast-forwards with force: false after checking the expected value; 422 is not a fast-forward', async () => {
    let status = 200;
    const { p, calls } = github({
      [`GET ${R}/git/ref/heads/int/abcd1234`]: () => ({
        status: 200,
        body: { ref: 'refs/heads/int/abcd1234', object: { sha: START, type: 'commit' } },
      }),
      [`PATCH ${R}/git/refs/heads/int/abcd1234`]: () => ({ status, body: {} }),
    });
    expect(await p.updateBranch('int/abcd1234', HEAD, OTHER)).toBe('moved');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(await p.updateBranch('int/abcd1234', HEAD, START)).toBe('updated');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sha: HEAD, force: false });
    status = 422;
    expect(await p.updateBranch('int/abcd1234', HEAD, START)).toBe('not_fast_forward');
    await expect(p.updateBranch('int/abcd1234', 'nope', START)).rejects.toBeInstanceOf(ProviderError);
  });

  it('updates the pull request title and description', async () => {
    const { p, calls } = github({ [`PATCH ${R}/pulls/7`]: () => ({ status: 200, body: { number: 7 } }) });
    await p.updatePullRequest(
      { number: 7, url: 'https://github.com/acme/app/pull/7' },
      { title: 't', body: 'b' },
    );
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ title: 't', body: 'b' });
  });
});

describe.skipIf(process.platform === 'win32')(
  'plain git provider: integration branch (real git)',
  { timeout: 60_000 },
  () => {
    let dir: string;
    let url: string;
    let provider: LocalGitProvider;
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'h',
          GIT_AUTHOR_EMAIL: 'h@example.test',
          GIT_COMMITTER_NAME: 'h',
          GIT_COMMITTER_EMAIL: 'h@example.test',
        },
      }).trim();

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'rm-int-prov-'));
      const bare = join(dir, 'origin.git');
      git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
      url = pathToFileURL(bare).href;
      const work = join(dir, 'w');
      git(dir, 'init', '-q', '-b', 'main', work);
      await writeFile(join(work, 'a.txt'), 'a\n');
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'base');
      git(work, 'push', '-q', url, 'main');
      await writeFile(join(work, 'a.txt'), 'b\n');
      git(work, 'commit', '-q', '-am', 'second');
      git(work, 'push', '-q', url, 'HEAD:refs/heads/rac/x/1');
      git(work, 'checkout', '-q', '-b', 'side', 'HEAD~1');
      await writeFile(join(work, 'c.txt'), 'c\n');
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'side');
      git(work, 'push', '-q', url, 'side:refs/heads/rac/y/1');
      provider = new LocalGitProvider({ url, cacheDir: join(dir, 'cache'), allowFileUrls: true });
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('creates, fast-forwards, refuses a moved branch and a non-fast-forward', async () => {
      const base = (await provider.branchHead('main')) ?? '';
      const second = (await provider.branchHead('rac/x/1')) ?? '';
      const side = (await provider.branchHead('rac/y/1')) ?? '';
      expect(await provider.updateBranch('int/abcd1234', base, null)).toBe('updated');
      expect(await provider.branchHead('int/abcd1234')).toBe(base);
      expect(await provider.updateBranch('int/abcd1234', second, null)).toBe('moved');
      expect(await provider.updateBranch('int/abcd1234', second, side)).toBe('moved');
      expect(await provider.updateBranch('int/abcd1234', second, base)).toBe('updated');
      expect(await provider.branchHead('int/abcd1234')).toBe(second);
      // `side` does not descend from `second`: never forced.
      expect(await provider.updateBranch('int/abcd1234', side, second)).toBe('not_fast_forward');
      expect(await provider.branchHead('int/abcd1234')).toBe(second);
    });
  },
);
