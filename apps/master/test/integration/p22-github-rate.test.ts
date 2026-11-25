import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { CiStatus, GitProvider, MergeCheck } from '../../src/gitflow/types.js';
import { JobStore } from '../../src/jobs/store.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p22-github-rate (docs/design/p22-github-rate.md) against a real master database: results waiting for approval are
 * re-checked every interval for their first 10 minutes and then less and less often, background re-checks wait while
 * the provider's budget is low, and a forced refresh still goes.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'rate-alpha';
const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);

class CountingProvider implements GitProvider {
  readonly kind = 'git' as const;
  readonly merges = new Map<string, number>();
  low = false;
  branchHead(b: string): Promise<string | null> {
    return Promise.resolve(b === 'main' ? BASE : HEAD);
  }
  testMerge(input: { readonly headBranch: string }): Promise<MergeCheck> {
    this.merges.set(input.headBranch, (this.merges.get(input.headBranch) ?? 0) + 1);
    return Promise.resolve({ state: 'clean', baseSha: BASE, headSha: HEAD });
  }
  checks(): Promise<CiStatus> {
    return Promise.resolve({ state: 'none', checks: [] });
  }
  backgroundBudgetLow(): boolean {
    return this.low;
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

describeIntegration('p22-github-rate (integration)', { timeout: 120_000 }, () => {
  const h = new Harness();
  const provider = new CountingProvider();
  const branch: Record<'fresh' | 'hour' | 'old', string> = { fresh: '', hour: '', old: '' };
  const ids: Record<'fresh' | 'hour' | 'old', string> = { fresh: '', hour: '', old: '' };

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 }, gitflow: { providers: () => provider } });
    const ownerId = await h.createUser('owner.rate', PW, 'owner');
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      PROJECT,
      h.clock.now(),
    ]);
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', 'https://example.com/acme/app.git', 'main', 'merge', false, 1800, $2, $3)`,
      [PROJECT, ownerId, h.clock.now()],
    );
    const jobs = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    const now = h.clock.now().getTime();
    const ages = { fresh: 0, hour: 30 * 60_000, old: 2 * 86_400_000 };
    for (const k of ['fresh', 'hour', 'old'] as const) {
      const id = (
        await jobs.create({
          project: PROJECT,
          actor: { type: 'user', id: ownerId },
          submit: true,
          spec: {
            runtime: 'codex',
            prompt: `Change ${k}`,
            repository: { url: 'https://example.com/acme/app.git', baseRef: 'main', workBranch: `w/${k}` },
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
        })
      ).job.id;
      ids[k] = id;
      branch[k] = `rac/${id}/a1`;
      await h.db.pool.query(
        `UPDATE jobs SET state = 'AWAITING_APPROVAL', version = version + 1 WHERE id = $1`,
        [id],
      );
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, branch, head_sha, verification,
                              verified_at, ci_state, created_at, updated_at)
         VALUES ($1, $2, 'git', 'main', $3, $4, $5, 'passed', $6, 'none', $6, $6)`,
        [id, PROJECT, BASE, branch[k], HEAD, new Date(now - ages[k])],
      );
    }
  });
  afterAll(async () => {
    await h.stop();
  });

  const counts = () => ({
    fresh: provider.merges.get(branch.fresh) ?? 0,
    hour: provider.merges.get(branch.hour) ?? 0,
    old: provider.merges.get(branch.old) ?? 0,
  });

  it('re-checks a waiting result less often as it ages', async () => {
    await h.app.gitflow.tick();
    expect(counts()).toEqual({ fresh: 1, hour: 1, old: 1 });
    h.clock.advance(31_000); // fresh: every 30 s
    await h.app.gitflow.tick();
    expect(counts()).toEqual({ fresh: 2, hour: 1, old: 1 });
    h.clock.advance(90_000); // t0 + 2 min 1 s — 10 min to 1 h: every 2 min
    await h.app.gitflow.tick();
    expect(counts()).toEqual({ fresh: 3, hour: 2, old: 1 });
    h.clock.advance(29 * 60_000); // t0 + 31 min — over a day: every 30 min
    await h.app.gitflow.tick();
    expect(counts()).toEqual({ fresh: 4, hour: 3, old: 2 });
  });

  it('skips background re-checks while the budget is low; a forced refresh still goes', async () => {
    provider.low = true;
    const before = counts();
    const checked = await h.db.pool.query<{ merge_checked_at: Date }>(
      'SELECT merge_checked_at FROM job_git WHERE job_id = $1',
      [ids.old],
    );
    h.clock.advance(2 * 3_600_000);
    await h.app.gitflow.tick();
    expect(counts()).toEqual(before);
    const after = await h.db.pool.query<{ merge_checked_at: Date }>(
      'SELECT merge_checked_at FROM job_git WHERE job_id = $1',
      [ids.old],
    );
    expect(after.rows[0]?.merge_checked_at).toEqual(checked.rows[0]?.merge_checked_at);
    await h.app.gitflow.refresh(ids.old, { force: true });
    expect(counts().old).toBe(before.old + 1);
    provider.low = false;
    await h.app.gitflow.tick();
    expect(counts().fresh).toBe(before.fresh + 1);
  });
});
