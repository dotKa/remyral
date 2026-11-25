import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubAppAuth } from '../../src/gitflow/github-app.js';
import { GitHubProvider } from '../../src/gitflow/github-provider.js';
import { ApiRateBudget, reserveOf } from '../../src/gitflow/github-rate.js';

/** p22-github-rate (docs/design/p22-github-rate.md): the installation budget, the pause and the reserve. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const SHA = 'a'.repeat(40);
const REF = `/repos/acme/app/git/ref/heads/main`;

function setup(answer: () => { status: number; headers?: Record<string, string> }) {
  let now = T0;
  const calls: string[] = [];
  const fetchFn = (input: string, init: RequestInit): Promise<Response> => {
    const path = input.replace('https://api.github.com', '');
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path.endsWith('/access_tokens')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: 'ghs_fixtureRate0001',
            expires_at: '2026-11-02T23:00:00Z',
            permissions: {},
          }),
          { status: 201 },
        ),
      );
    }
    const a = answer();
    return Promise.resolve(
      new Response(
        JSON.stringify(
          a.status === 200 ? { ref: 'refs/heads/main', object: { sha: SHA, type: 'commit' } } : {},
        ),
        { status: a.status, headers: a.headers ?? {} },
      ),
    );
  };
  const clock = () => new Date(now);
  const auth = new GitHubAppAuth({ appId: '1', privateKey, fetch: fetchFn, clock });
  const make = (repo: string) =>
    new GitHubProvider({ owner: 'acme', repo, installationId: 42, auth, fetch: fetchFn, clock });
  return {
    p: make('app'),
    other: make('site'),
    calls: () => calls.filter((c) => !c.endsWith('/access_tokens')),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('p22-github-rate', () => {
  it('pauses every request of the installation until the reset GitHub names, then resumes', async () => {
    let limited = true;
    const s = setup(() =>
      limited
        ? {
            status: 403,
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor((T0 + 10 * 60_000) / 1000)),
            },
          }
        : { status: 200, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } },
    );
    await expect(s.p.branchHead('main')).rejects.toMatchObject({
      transient: true,
      message: expect.stringContaining('API rate limit exhausted') as unknown,
    });
    expect(s.calls()).toEqual([`GET ${REF}`]);
    // Paused: neither this provider nor another repository of the same installation reaches GitHub.
    await expect(s.p.branchHead('main')).rejects.toMatchObject({
      transient: true,
      message: expect.stringContaining('not sent') as unknown,
    });
    await expect(s.other.branchHead('main')).rejects.toMatchObject({ transient: true });
    expect(s.calls()).toHaveLength(1);
    expect(s.p.backgroundBudgetLow()).toBe(true);
    // After the reset the requests go again.
    limited = false;
    s.advance(10 * 60_000 + 1);
    await expect(s.p.branchHead('main')).resolves.toBe(SHA);
    expect(s.calls()).toHaveLength(2);
    expect(s.p.backgroundBudgetLow()).toBe(false);
  });

  it('honours a secondary limit (403 with retry-after) and a 429', async () => {
    let status = 403;
    const s = setup(() => ({ status, headers: { 'retry-after': '30' } }));
    await expect(s.p.branchHead('main')).rejects.toMatchObject({ transient: true, status: 403 });
    s.advance(29_000);
    await expect(s.p.branchHead('main')).rejects.toMatchObject({ transient: true });
    expect(s.calls()).toHaveLength(1);
    s.advance(2_000);
    status = 429;
    await expect(s.p.branchHead('main')).rejects.toMatchObject({ transient: true, status: 429 });
    expect(s.calls()).toHaveLength(2);
  });

  it('reports a low budget below the reserve, and not after the window resets', () => {
    const b = new ApiRateBudget();
    const reset = String(Math.floor((T0 + 30 * 60_000) / 1000));
    const h = (remaining: number) =>
      new Headers({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset': reset,
      });
    expect(b.low(T0)).toBe(false);
    expect(b.note(200, h(reserveOf(5000)), T0)).toBe(false);
    expect(b.low(T0)).toBe(false);
    b.note(200, h(reserveOf(5000) - 1), T0);
    expect(b.low(T0)).toBe(true);
    expect(b.pausedUntil(T0)).toBeNull();
    expect(b.low(T0 + 30 * 60_000 + 1)).toBe(false);
    expect(reserveOf(5000)).toBe(1000);
    expect(reserveOf(600)).toBe(200);
  });

  it('a permission 403 is not a rate limit and pauses nothing', async () => {
    const s = setup(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '4000' } }));
    await expect(s.p.branchHead('main')).rejects.toMatchObject({ transient: false, status: 403 });
    await expect(s.p.branchHead('main')).rejects.toMatchObject({ transient: false });
    expect(s.calls()).toHaveLength(2);
    expect(s.p.backgroundBudgetLow()).toBe(false);
  });
});
