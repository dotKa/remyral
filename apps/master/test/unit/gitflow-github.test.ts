import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubAppAuth, MASTER_PERMISSIONS, WORKER_PERMISSIONS } from '../../src/gitflow/github-app.js';
import { ciState, GitHubProvider } from '../../src/gitflow/github-provider.js';
import { ProviderError } from '../../src/gitflow/types.js';

/**
 * GitHub provider and App auth against recorded/fixture REST responses (UNVERIFIED-LIVE: shapes follow
 * docs.github.com REST "Pulls", "Git refs", "Commits", "Checks", "Apps" pages, API version 2022-11-28).
 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = new Date('2026-10-13T10:00:00.000Z');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const START = 'c'.repeat(40);
const MERGED = 'd'.repeat(40);

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fixtureFetch(
  routes: Record<
    string,
    (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }
  >,
) {
  const calls: Call[] = [];
  const fetchFn = (input: string, init: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: input,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const path = input.replace('https://api.github.com', '');
    const key = `${call.method} ${path}`;
    const handler = routes[key] ?? routes[`${call.method} ${path.split('?')[0] ?? ''}`];
    if (handler === undefined)
      return Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
    const r = handler(call);
    return Promise.resolve(
      new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
        status: r.status,
        headers: r.headers ?? {},
      }),
    );
  };
  return { calls, fetchFn };
}

const TOKEN_ROUTE = {
  'POST /app/installations/42/access_tokens': () => ({
    status: 201,
    body: { token: 'ghs_fixtureInstallationToken0001', expires_at: '2026-10-13T11:00:00Z', permissions: {} },
  }),
};

function provider(routes: Parameters<typeof fixtureFetch>[0]) {
  const f = fixtureFetch({ ...TOKEN_ROUTE, ...routes });
  const auth = new GitHubAppAuth({ appId: '12345', privateKey, fetch: f.fetchFn, clock: () => NOW });
  const p = new GitHubProvider({ owner: 'acme', repo: 'app', installationId: 42, auth, fetch: f.fetchFn });
  return { p, calls: f.calls };
}

const R = '/repos/acme/app';

describe('GitHub App auth', () => {
  it('signs an RS256 app JWT (iat − 60 s, exp + 9 min, iss = app id)', () => {
    const auth = new GitHubAppAuth({ appId: '12345', privateKey, clock: () => NOW });
    const [h, p, s] = auth.jwt().split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    const now = NOW.getTime() / 1000;
    expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: '12345' });
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(createPublicKey(privateKey), Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('mints a token for exactly one repository with explicit permissions; caches only when asked', async () => {
    const f = fixtureFetch(TOKEN_ROUTE);
    const auth = new GitHubAppAuth({ appId: '12345', privateKey, fetch: f.fetchFn, clock: () => NOW });
    const t = await auth.installationToken(42, 'app', WORKER_PERMISSIONS);
    expect(t.token).toBe('ghs_fixtureInstallationToken0001');
    expect(f.calls[0]?.body).toEqual({
      repositories: ['app'],
      permissions: { contents: 'write', metadata: 'read' },
    });
    expect(f.calls[0]?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    await auth.installationToken(42, 'app', WORKER_PERMISSIONS);
    expect(f.calls).toHaveLength(2); // worker tokens are never cached
    await auth.installationToken(42, 'app', MASTER_PERMISSIONS, { cache: true });
    await auth.installationToken(42, 'app', MASTER_PERMISSIONS, { cache: true });
    expect(f.calls).toHaveLength(3);
    expect(JSON.stringify(auth)).not.toContain('PRIVATE');
  });

  it('refuses non-RSA keys and reports token errors without the response body', async () => {
    const ed = generateKeyPairSync('ed25519').privateKey;
    expect(() => new GitHubAppAuth({ appId: '1', privateKey: ed })).toThrow(/RSA/);
    const f = fixtureFetch({
      'POST /app/installations/42/access_tokens': () => ({
        status: 401,
        body: { message: 'secret-ish detail' },
      }),
    });
    const auth = new GitHubAppAuth({ appId: '1', privateKey, fetch: f.fetchFn });
    const err = await auth.installationToken(42, 'app', WORKER_PERMISSIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).not.toContain('secret-ish');
    expect((err as ProviderError).transient).toBe(false);
  });
});

describe('GitHub provider (fixtures)', () => {
  it('reads a branch head with the exact-match ref endpoint; 404 = absent', async () => {
    const { p, calls } = provider({
      [`GET ${R}/git/ref/heads/rac/j1/a1`]: () => ({
        status: 200,
        body: { ref: 'refs/heads/rac/j1/a1', object: { sha: HEAD, type: 'commit' } },
      }),
    });
    expect(await p.branchHead('rac/j1/a1')).toBe(HEAD);
    expect(await p.branchHead('rac/j1/zz')).toBeNull();
    expect(calls[1]?.headers.authorization).toBe('Bearer ghs_fixtureInstallationToken0001');
    expect(calls[1]?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('creates a PR from the attempt branch, or finds the existing one (422 race)', async () => {
    let listed = 0;
    const { p, calls } = provider({
      [`GET ${R}/pulls`]: () => {
        listed++;
        return {
          status: 200,
          body: listed === 1 ? [] : [{ number: 7, html_url: 'https://github.com/acme/app/pull/7' }],
        };
      },
      [`POST ${R}/pulls`]: () => ({ status: 422, body: { message: 'A pull request already exists' } }),
    });
    expect(
      await p.ensurePullRequest({ headBranch: 'rac/j1/a1', targetBranch: 'main', title: 't', body: 'b' }),
    ).toEqual({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
    });
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'));
    expect(post?.body).toMatchObject({ head: 'rac/j1/a1', base: 'main', maintainer_can_modify: false });
    expect(calls.find((c) => c.method === 'GET' && c.url.includes('/pulls?'))?.url).toContain(
      'head=acme%3Arac%2Fj1%2Fa1',
    );

    const created = provider({
      [`GET ${R}/pulls`]: () => ({ status: 200, body: [] }),
      [`POST ${R}/pulls`]: () => ({
        status: 201,
        body: { number: 9, html_url: 'https://github.com/acme/app/pull/9' },
      }),
    });
    expect(
      (
        await created.p.ensurePullRequest({
          headBranch: 'rac/x/y',
          targetBranch: 'main',
          title: 't',
          body: 'b',
        })
      )?.number,
    ).toBe(9);
  });

  it('combines check runs and commit statuses into one CI state', async () => {
    const { p } = provider({
      [`GET ${R}/commits/${HEAD}/check-runs`]: () => ({
        status: 200,
        body: {
          total_count: 2,
          check_runs: [
            { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' },
            { name: 'lint', status: 'in_progress', conclusion: null, html_url: null },
          ],
        },
      }),
      [`GET ${R}/commits/${HEAD}/status`]: () => ({
        status: 403,
        body: { message: 'Resource not accessible' },
      }),
    });
    const ci = await p.checks(HEAD);
    expect(ci.state).toBe('pending');
    expect(ci.checks.map((c) => c.name)).toEqual(['build', 'lint']);
    expect(ciState([])).toBe('none');
    expect(ciState([{ name: 'a', status: 'completed', conclusion: 'failure', url: null }])).toBe('failure');
    expect(ciState([{ name: 'a', status: 'completed', conclusion: 'skipped', url: null }])).toBe('success');
    expect(
      ciState([
        { name: 'a', status: 'in_progress', conclusion: null, url: null },
        { name: 'b', status: 'completed', conclusion: 'timed_out', url: null },
      ]),
    ).toBe('failure');
  });

  const mergeRoutes = (status: number, body: unknown) => ({
    [`GET ${R}/git/ref/heads/rac/j1/a1`]: () => ({
      status: 200,
      body: { ref: 'refs/heads/rac/j1/a1', object: { sha: HEAD, type: 'commit' } },
    }),
    [`PUT ${R}/pulls/7/merge`]: () => ({ status, body }),
  });
  const mergeInput = {
    targetBranch: 'main',
    headSha: HEAD,
    headBranch: 'rac/j1/a1',
    method: 'squash' as const,
    pullRequest: { number: 7, url: 'u' },
    title: 'title',
    message: 'body\n\nRemyral-Merge: m1\n',
  };

  it('merges with the sha precondition and the configured method', async () => {
    const { p, calls } = provider(
      mergeRoutes(200, { sha: MERGED, merged: true, message: 'Pull Request successfully merged' }),
    );
    expect(await p.merge(mergeInput)).toEqual({ merged: true, sha: MERGED });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      sha: HEAD,
      merge_method: 'squash',
      commit_title: 'title',
      commit_message: 'body\n\nRemyral-Merge: m1\n',
    });
  });

  it('maps 405 (not mergeable) and 409 (head moved) to refusals, never success', async () => {
    const a = provider(mergeRoutes(405, { message: 'Pull Request is not mergeable' }));
    expect(await a.p.merge(mergeInput)).toEqual({
      merged: false,
      reason: 'not_mergeable',
      detail: 'Pull Request is not mergeable',
    });
    const b = provider(
      mergeRoutes(409, { message: 'Head branch was modified. Review and try the merge again.' }),
    );
    expect(await b.p.merge(mergeInput)).toMatchObject({ merged: false, reason: 'head_moved' });
    const c = provider(mergeRoutes(403, { message: 'Protected branch' }));
    expect(await c.p.merge(mergeInput)).toMatchObject({ merged: false, reason: 'forbidden' });
  });

  it('refuses before calling merge when the branch head already moved (sha guard)', async () => {
    const { p, calls } = provider({
      [`GET ${R}/git/ref/heads/rac/j1/a1`]: () => ({
        status: 200,
        body: { ref: 'refs/heads/rac/j1/a1', object: { sha: BASE, type: 'commit' } },
      }),
    });
    expect(await p.merge(mergeInput)).toMatchObject({ merged: false, reason: 'head_moved' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('test merge: clean, conflicts (approximated by files changed on both sides), base rewritten, still computing', async () => {
    const base = {
      [`GET ${R}/git/ref/heads/main`]: () => ({
        status: 200,
        body: { ref: 'refs/heads/main', object: { sha: BASE, type: 'commit' } },
      }),
      [`GET ${R}/compare/${START}...${BASE}`]: () => ({
        status: 200,
        body: { status: 'ahead', commits: [], files: [] },
      }),
    };
    const input = {
      targetBranch: 'main',
      headSha: HEAD,
      headBranch: 'rac/j1/a1',
      baseAtStart: START,
      pullRequest: { number: 7, url: 'u' },
    };
    const pull = (mergeable: boolean | null) => () => ({
      status: 200,
      body: { number: 7, merged: false, mergeable, mergeable_state: 'dirty', head: { sha: HEAD } },
    });
    expect((await provider({ ...base, [`GET ${R}/pulls/7`]: pull(true) }).p.testMerge(input)).state).toBe(
      'clean',
    );
    // p22-output-delivery §1: while GitHub still computes `mergeable`, the history answers what it can — overlapping
    // paths stay unknown (re-checked later), disjoint paths are clean.
    const sides = (ours: string[], theirs: string[]) => ({
      [`GET ${R}/compare/${BASE}...${HEAD}`]: () => ({
        status: 200,
        body: {
          status: 'diverged',
          merge_base_commit: { sha: START },
          commits: [],
          files: ours.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0 })),
        },
      }),
      [`GET ${R}/compare/${HEAD}...${BASE}`]: () => ({
        status: 200,
        body: {
          status: 'diverged',
          merge_base_commit: { sha: START },
          commits: [],
          files: theirs.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0 })),
        },
      }),
    });
    expect(
      (
        await provider({
          ...base,
          ...sides(['README.md', 'leads/a.csv'], ['README.md']),
          [`GET ${R}/pulls/7`]: pull(null),
        }).p.testMerge(input)
      ).state,
    ).toBe('unknown');
    expect(
      (
        await provider({
          ...base,
          ...sides(['leads/a.csv'], ['README.md']),
          [`GET ${R}/pulls/7`]: pull(null),
        }).p.testMerge(input)
      ).state,
    ).toBe('clean');
    // No pull request (it could not be opened): the same history answer instead of "unknown" forever.
    expect(
      (
        await provider({ ...base, ...sides(['leads/a.csv'], ['README.md']) }).p.testMerge({
          ...input,
          pullRequest: null,
        })
      ).state,
    ).toBe('clean');
    const conflict = await provider({
      ...base,
      [`GET ${R}/pulls/7`]: pull(false),
      [`GET ${R}/compare/${BASE}...${HEAD}`]: () => ({
        status: 200,
        body: {
          status: 'diverged',
          merge_base_commit: { sha: START },
          commits: [
            {
              sha: HEAD,
              commit: { message: 'ours\n', author: { name: 'a', email: 'a@x', date: null } },
              parents: [],
            },
          ],
          files: [
            { filename: 'README.md', status: 'modified', additions: 1, deletions: 1 },
            { filename: 'a.txt', status: 'added', additions: 1, deletions: 0 },
          ],
        },
      }),
      [`GET ${R}/compare/${HEAD}...${BASE}`]: () => ({
        status: 200,
        body: {
          status: 'diverged',
          commits: [
            {
              sha: BASE,
              commit: { message: 'theirs\n', author: { name: 'b', email: 'b@x', date: null } },
              parents: [],
            },
          ],
          files: [{ filename: 'README.md', status: 'modified', additions: 2, deletions: 0 }],
        },
      }),
    }).p.testMerge(input);
    expect(conflict).toMatchObject({
      state: 'conflicts',
      files: ['README.md'],
      precision: 'approximate',
      headCommits: [{ sha: HEAD, subject: 'ours' }],
      baseCommits: [{ sha: BASE, subject: 'theirs' }],
    });
    const rewritten = await provider({
      ...base,
      [`GET ${R}/compare/${START}...${BASE}`]: () => ({
        status: 200,
        body: { status: 'diverged', commits: [], files: [] },
      }),
    }).p.testMerge(input);
    expect(rewritten.state).toBe('base_moved');
  });

  it('treats 5xx / rate limits as transient and other errors as final', async () => {
    const { p } = provider({ [`GET ${R}/git/commits/${HEAD}`]: () => ({ status: 502 }) });
    await expect(p.commit(HEAD)).rejects.toMatchObject({ transient: true, status: 502 });
    const limited = provider({
      [`GET ${R}/git/commits/${HEAD}`]: () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    });
    await expect(limited.p.commit(HEAD)).rejects.toMatchObject({ transient: true });
    const gone = provider({ [`GET ${R}/git/commits/${HEAD}`]: () => ({ status: 422 }) });
    await expect(gone.p.commit(HEAD)).rejects.toMatchObject({ transient: false });
  });

  it('finds an earlier merge by its Remyral-Merge trailer and deletes a branch only at the expected sha', async () => {
    const { p, calls } = provider({
      [`GET ${R}/commits`]: () => ({
        status: 200,
        body: [
          { sha: BASE, commit: { message: 'other' } },
          { sha: MERGED, commit: { message: 'Merge\n\nRemyral-Merge: m1\n' } },
        ],
      }),
      [`GET ${R}/git/ref/heads/rac/j1/a1`]: () => ({
        status: 200,
        body: { ref: 'refs/heads/rac/j1/a1', object: { sha: HEAD, type: 'commit' } },
      }),
      [`DELETE ${R}/git/refs/heads/rac/j1/a1`]: () => ({ status: 204 }),
    });
    expect(await p.findMerge('main', 'm1')).toBe(MERGED);
    expect(await p.findMerge('main', 'm2')).toBeNull();
    expect(await p.deleteBranch('rac/j1/a1', BASE)).toBe('moved');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await p.deleteBranch('rac/j1/a1', HEAD)).toBe('deleted');
  });
});
