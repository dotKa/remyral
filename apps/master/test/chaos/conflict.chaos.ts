import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { redisUrlWithDb } from '../helpers/env.js';
import { ChaosCluster } from './helpers/cluster.js';

/**
 * p4-chaos 7 (A-ORCH-4/5, P4 gate "protected merge requires approval"): two jobs on two workers edit the
 * same file; a master restart sits between the merge request and the approval; then a zombie pushes onto the
 * approved attempt branch before the merge executes.
 */
describe('chaos: conflicting jobs and the protected merge', () => {
  const c = new ChaosCluster();

  beforeAll(async () => {
    await c.boot({ hintRedisUrl: redisUrlWithDb(13) });
  });
  afterEach(async (ctx) => {
    await c.endScenario('conflict', ctx.task.result?.state === 'fail');
  });
  afterAll(async () => {
    await c.stop();
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'z',
        GIT_AUTHOR_EMAIL: 'z@example.test',
        GIT_COMMITTER_NAME: 'z',
        GIT_COMMITTER_EMAIL: 'z@example.test',
      },
      encoding: 'utf8',
    }).trim();

  async function requestMerge(
    jobId: string,
  ): Promise<{ status: number; approvalId: string | null; body: string }> {
    const res = await c.admin.req('POST', `/jobs/${jobId}/merge`, { mode: 'merge' });
    const approvalId =
      res.statusCode === 202
        ? res.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId
        : null;
    return { status: res.statusCode, approvalId, body: res.body };
  }

  it('reviewable conflict, merge only with approval (surviving a master restart), moved head refused', async () => {
    await c.newWorker('c1');
    await c.newWorker('c2');
    const base = c.head('main');
    const [a, b] = await Promise.all([
      c.submit('edit README.md alpha wins\nrewrite the readme (alpha)'),
      c.submit('edit README.md beta wins\nrewrite the readme (beta)'),
    ]);
    await expect
      .poll(async () => [await c.state(a), await c.state(b)], { timeout: 60_000 })
      .toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
    // Both ran in parallel on different workers from the same base.
    const owners = new Set(
      c.ledger.spawns.filter((s) => s.jobId === a || s.jobId === b).map((s) => s.worker),
    );
    expect(owners.size).toBe(2);

    // Requesting the merge only opens an approval; the master restarts before anyone decides.
    const ra = await requestMerge(a);
    expect(ra.status, ra.body).toBe(202);
    expect(c.head('main')).toBe(base);
    await c.stopMaster();
    await c.startMaster();
    expect(c.head('main')).toBe(base);
    // Without a fresh step-up the approval is refused; nothing merges.
    c.clock.advance(11 * 60_000);
    await c.relogin();
    c.clock.advance(11 * 60_000);
    const stale = await c.admin.req('POST', `/approvals/${String(ra.approvalId)}/approve`, {});
    expect(stale.statusCode).toBe(403);
    expect(c.head('main')).toBe(base);
    await c.stepUp();
    const ok = await c.admin.req('POST', `/approvals/${String(ra.approvalId)}/approve`, {
      reason: 'reviewed',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await expect.poll(() => c.state(a)).toBe('SUCCEEDED');
    const mergedMain = c.head('main');
    expect(mergedMain).not.toBe(base);

    // The second job now conflicts: a reviewable record, the merge request is refused, main untouched.
    await c.app.gitflow.refresh(b, { force: true });
    const changes = (await c.admin.req('GET', `/jobs/${b}/changes`)).json<{
      branch: string;
      mergeCheck: { state: string; files: string[] };
    }>();
    expect(changes.mergeCheck).toMatchObject({ state: 'conflicts', files: ['README.md'] });
    const rb = await requestMerge(b);
    expect(rb.status).toBe(409);
    expect(rb.body).toContain('merge_conflicts');
    expect(c.head('main')).toBe(mergedMain);
    expect(await c.state(b)).toBe('AWAITING_APPROVAL');

    // A third job without a conflict: approval granted, but a zombie moves the attempt head in between.
    const third = await c.submit('edit third.txt third\nan unrelated file');
    await expect.poll(() => c.state(third)).toBe('AWAITING_APPROVAL');
    const branch = (await c.admin.req('GET', `/jobs/${third}/changes`)).json<{ branch: string }>().branch;
    const r3 = await requestMerge(third);
    expect(r3.status, r3.body).toBe(202);
    const work = await mkdtemp(join(tmpdir(), 'rw-chaos-zombie-'));
    c.dirs.push(work);
    git(work, 'init', '-q');
    git(work, 'fetch', '-q', c.fileUrl, `refs/heads/${branch}:refs/heads/x`);
    git(work, 'checkout', '-q', 'x');
    await writeFile(join(work, 'third.txt'), 'zombie\n');
    git(work, 'commit', '-qam', 'zombie push after the approval request');
    git(work, 'push', '-q', c.fileUrl, `x:refs/heads/${branch}`);
    await c.stepUp();
    expect((await c.admin.req('POST', `/approvals/${String(r3.approvalId)}/approve`, {})).statusCode).toBe(
      200,
    );
    await expect
      .poll(async () =>
        (await c.admin.req('GET', `/jobs/${third}/changes`))
          .json<{
            requests: { status: string; resultReason: string | null }[];
          }>()
          .requests.at(-1),
      )
      .toMatchObject({ status: 'refused', resultReason: expect.stringContaining('head_moved') as unknown });
    expect(c.head('main')).toBe(mergedMain);
    expect(await c.state(third)).toBe('AWAITING_APPROVAL');
    await c.assertInvariants();
  });
});
