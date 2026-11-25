import { describe, expect, it } from 'vitest';
import { ApiRateBudget, hostRateBudgetOf } from '../../src/gitflow/github-rate.js';
import { HostedHttp } from '../../src/gitflow/hosted-http.js';

/** p22-harness-gaps: GitLab / Bitbucket answers spend a per-connection budget like GitHub's (p22-github-rate). */
const T0 = Date.parse('2026-11-02T12:00:00.000Z');

function setup(
  name: 'GitLab' | 'Bitbucket',
  answer: () => { status: number; headers?: Record<string, string> },
) {
  let now = T0;
  let calls = 0;
  const budget = new ApiRateBudget();
  const http = new HostedHttp({
    name,
    apiRoot: 'https://git.example.com/api',
    token: () => Promise.resolve('fixture-token'),
    budget,
    clock: () => new Date(now),
    fetch: () => {
      calls++;
      const a = answer();
      return Promise.resolve(new Response('{}', { status: a.status, headers: a.headers ?? {} }));
    },
  });
  return {
    http,
    budget,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('p22-harness-gaps: hosted rate budget', () => {
  it('GitLab: a 429 pauses until RateLimit-Reset; requests in the pause never leave', async () => {
    let limited = true;
    const s = setup('GitLab', () =>
      limited
        ? {
            status: 429,
            headers: {
              'ratelimit-limit': '2000',
              'ratelimit-remaining': '0',
              'ratelimit-reset': String(Math.floor((T0 + 120_000) / 1000)),
            },
          }
        : { status: 200, headers: { 'ratelimit-limit': '2000', 'ratelimit-remaining': '1999' } },
    );
    await expect(s.http.request('GET', '/repository/branches/main')).rejects.toMatchObject({
      transient: true,
      status: 429,
      message: expect.stringContaining('API rate limit exhausted') as unknown,
    });
    await expect(s.http.request('GET', '/repository/branches/main')).rejects.toMatchObject({
      message: expect.stringContaining('not sent') as unknown,
    });
    expect(s.calls()).toBe(1);
    expect(s.http.budgetLow()).toBe(true);
    limited = false;
    s.advance(120_001);
    await expect(s.http.request('GET', '/repository/branches/main')).resolves.toMatchObject({ status: 200 });
    expect(s.http.budgetLow()).toBe(false);
  });

  it('GitLab: below the reserve the background budget is low (no pause)', async () => {
    const s = setup('GitLab', () => ({
      status: 200,
      headers: {
        'ratelimit-limit': '2000',
        'ratelimit-remaining': '150',
        'ratelimit-reset': String(Math.floor((T0 + 60_000) / 1000)),
      },
    }));
    await s.http.request('GET', '/repository/branches/main');
    expect(s.http.budgetLow()).toBe(true);
    expect(s.budget.pausedUntil(T0)).toBeNull();
  });

  it('Bitbucket: a bare 429 pauses for a minute; Retry-After when sent', async () => {
    let headers: Record<string, string> = {};
    const s = setup('Bitbucket', () => ({ status: 429, headers }));
    await expect(s.http.request('GET', '/refs/branches/main')).rejects.toMatchObject({ transient: true });
    s.advance(59_000);
    await expect(s.http.request('GET', '/refs/branches/main')).rejects.toMatchObject({ transient: true });
    expect(s.calls()).toBe(1);
    s.advance(2_000);
    headers = { 'retry-after': '5' };
    await expect(s.http.request('GET', '/refs/branches/main')).rejects.toMatchObject({ transient: true });
    expect(s.calls()).toBe(2);
    expect(s.budget.pausedUntil(T0 + 61_000)).toBe(T0 + 66_000);
  });

  it('a 5xx stays transient and pauses nothing; one budget per connection', async () => {
    const s = setup('GitLab', () => ({ status: 502 }));
    await expect(s.http.request('GET', '/x')).rejects.toMatchObject({ transient: true, status: 502 });
    await expect(s.http.request('GET', '/x')).rejects.toMatchObject({ status: 502 });
    expect(s.calls()).toBe(2);
    expect(hostRateBudgetOf('gitlab', 'c1')).toBe(hostRateBudgetOf('gitlab', 'c1'));
    expect(hostRateBudgetOf('gitlab', 'c1')).not.toBe(hostRateBudgetOf('bitbucket', 'c1'));
  });
});
