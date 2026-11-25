import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { CiStatus, GitProvider, MergeCheck } from '../../src/gitflow/types.js';
import { JobStore } from '../../src/jobs/store.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p22-github-webhook (docs/design/p22-github-webhook.md) against a real master database: a GitHub delivery marks the
 * waiting results it concerns for a re-check (and nothing else), and on GitHub the timer is only a slow fallback.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'hook-alpha';
const OTHER = 'hook-beta';
const BASE = '1'.repeat(40);
const HEADS = { a: 'a'.repeat(40), b: 'b'.repeat(40), old: 'c'.repeat(40) };

class CountingProvider implements GitProvider {
  readonly kind = 'github' as const;
  readonly merges = new Map<string, number>();
  branchHead(b: string): Promise<string | null> {
    if (b === 'main') return Promise.resolve(BASE);
    const k = (Object.keys(branchOf) as (keyof typeof HEADS)[]).find((x) => branchOf[x] === b);
    return Promise.resolve(k === undefined ? null : HEADS[k]);
  }
  testMerge(input: { readonly headBranch: string; readonly headSha: string }): Promise<MergeCheck> {
    this.merges.set(input.headBranch, (this.merges.get(input.headBranch) ?? 0) + 1);
    return Promise.resolve({ state: 'clean', baseSha: BASE, headSha: input.headSha });
  }
  checks(): Promise<CiStatus> {
    return Promise.resolve({ state: 'none', checks: [] });
  }
  commit(): never {
    throw new Error('unused');
  }
  compare(): never {
    throw new Error('unused');
  }
  ensurePullRequest(): Promise<null> {
    return Promise.resolve(null);
  }
  merge(): never {
    throw new Error('unused');
  }
  findMerge(): never {
    throw new Error('unused');
  }
  deleteBranch(): never {
    throw new Error('unused');
  }
}

const branchOf: Record<keyof typeof HEADS, string> = { a: '', b: '', old: '' };

describeIntegration('p22-github-webhook (integration)', { timeout: 120_000 }, () => {
  const h = new Harness();
  const provider = new CountingProvider();
  const ids: Record<keyof typeof HEADS, string> = { a: '', b: '', old: '' };

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 }, gitflow: { providers: () => provider } });
    const ownerId = await h.createUser('owner.hook', PW, 'owner');
    for (const [project, repo] of [
      [PROJECT, 'Acme/App'],
      [OTHER, 'acme/site'],
    ] as const) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        project,
        h.clock.now(),
      ]);
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                          require_ci, ci_timeout_sec, github_app_id, github_installation_id,
                                          github_key_ref, updated_by, updated_at)
         VALUES ($1, 1, 'github', $2, 'main', 'merge', false, 1800, '1', 42, 'default', $3, $4)`,
        [project, `https://github.com/${repo}.git`, ownerId, h.clock.now()],
      );
    }
    const jobs = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    const now = h.clock.now().getTime();
    const ages = { a: 0, b: 0, old: 8 * 86_400_000 };
    for (const k of ['a', 'b', 'old'] as const) {
      const id = (
        await jobs.create({
          project: PROJECT,
          actor: { type: 'user', id: ownerId },
          submit: true,
          spec: {
            runtime: 'codex',
            prompt: `Change ${k}`,
            repository: { url: 'https://github.com/Acme/App.git', baseRef: 'main', workBranch: `w/${k}` },
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
        })
      ).job.id;
      ids[k] = id;
      branchOf[k] = `rac/${id}/a1`;
      await h.db.pool.query(
        `UPDATE jobs SET state = 'AWAITING_APPROVAL', version = version + 1 WHERE id = $1`,
        [id],
      );
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, branch, head_sha, verification,
                              verified_at, ci_state, pr_number, merge_checked_at, created_at, updated_at)
         VALUES ($1, $2, 'github', 'main', $3, $4, $5, 'passed', $6, 'none', $7, $8, $6, $6)`,
        [
          id,
          PROJECT,
          BASE,
          branchOf[k],
          HEADS[k],
          new Date(now - ages[k]),
          k === 'b' ? 7 : null,
          h.clock.now(),
        ],
      );
    }
  });
  afterAll(async () => {
    await h.stop();
  });

  const counts = () => ({
    a: provider.merges.get(branchOf.a) ?? 0,
    b: provider.merges.get(branchOf.b) ?? 0,
    old: provider.merges.get(branchOf.old) ?? 0,
  });
  const flow = () => h.app.gitflow;

  it('marks only what a delivery concerns; the loop re-checks it at once', async () => {
    // Just checked: nothing is due on the timer.
    await flow().tick();
    expect(counts()).toEqual({ a: 0, b: 0, old: 0 });
    // The attempt branch of a moved.
    expect(await flow().onGitHubEvent('acme/app', 'push', { ref: `refs/heads/${branchOf.a}` })).toBe(1);
    await flow().tick();
    expect(counts()).toEqual({ a: 1, b: 0, old: 0 });
    // b's pull request changed; CI of a's head changed.
    expect(await flow().onGitHubEvent('acme/app', 'pull_request', { number: 7, pull_request: {} })).toBe(1);
    expect(
      await flow().onGitHubEvent('acme/app', 'check_suite', { check_suite: { head_sha: HEADS.a } }),
    ).toBe(1);
    await flow().tick();
    expect(counts()).toEqual({ a: 2, b: 1, old: 0 });
    // Another repository, a tag, an unrelated event: nothing.
    expect(await flow().onGitHubEvent('acme/site', 'push', { ref: 'refs/heads/main' })).toBe(0);
    expect(await flow().onGitHubEvent('acme/app', 'push', { ref: 'refs/tags/v1' })).toBe(0);
    expect(await flow().onGitHubEvent('acme/app', 'issues', { issue: {} })).toBe(0);
    // The target branch moved: every waiting result on it, the old one too.
    expect(await flow().onGitHubEvent('acme/app', 'push', { ref: 'refs/heads/main' })).toBe(3);
    await flow().tick();
    expect(counts()).toEqual({ a: 3, b: 2, old: 1 });
  });

  it('on GitHub without a delivery for 2 hours each result is asked about once, at any age', async () => {
    const before = counts();
    h.clock.advance(60 * 60_000); // 1 h: no delivery yet, not due
    await flow().tick();
    expect(counts()).toEqual(before);
    h.clock.advance(60 * 60_000 + 1_000); // 2 h since the last check: every result once, the 8-day-old one too
    await flow().tick();
    expect(counts()).toEqual({ a: before.a + 1, b: before.b + 1, old: before.old + 1 });
    await flow().tick();
    expect(counts()).toEqual({ a: before.a + 1, b: before.b + 1, old: before.old + 1 });
    // A delivery in between resets a result's 2 hours.
    h.clock.advance(60 * 60_000);
    await flow().onGitHubEvent('acme/app', 'push', { ref: `refs/heads/${branchOf.a}` });
    await flow().tick();
    h.clock.advance(60 * 60_000 + 1_000);
    await flow().tick();
    expect(counts()).toEqual({ a: before.a + 2, b: before.b + 2, old: before.old + 2 });
    h.clock.advance(60 * 60_000);
    await flow().tick();
    expect(counts()).toEqual({ a: before.a + 3, b: before.b + 2, old: before.old + 2 });
  });
});
