import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/service.js';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import type { Subject } from '../../src/authz/model.js';
import { GitFlowService } from '../../src/gitflow/service.js';
import type { GitProvider, PullRequestRef } from '../../src/gitflow/types.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { SecurityPolicyService } from '../../src/security-policy/service.js';
import { ConflictResolveService } from '../../src/self-heal/conflict-resolve.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec, PROJECT, REPO_URL } from '../helpers/job-worker.js';

const PW = 'quartz-meadow-lantern-7';
const W1 = 'worker-a';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

/**
 * p22-conflict-resolve (docs/design/p22-conflict-resolve.md): a verified result that conflicts with its target gets one
 * conflict-resolution job (by a person, or by auto mode); when that job merges the source job is superseded — its
 * decision withdrawn, the waiting job cancelled, its pull request closed by the platform; a resolve job that ends
 * without merging leaves the source as it was. Real Postgres; the git provider is a fake that records the close.
 */
describeIntegration('conflict resolution jobs (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let jobs: JobStore;
  let policy: SecurityPolicyService;
  let gitflow: GitFlowService;
  let svc: ConflictResolveService;
  let owner: Client;
  let ownerId: string;
  let subject: Subject;
  let creator: JobActor;
  const closed: { pr: PullRequestRef; comment: string }[] = [];
  const fake = {
    closePullRequest: (pr: PullRequestRef, comment: string) => {
      closed.push({ pr, comment });
      return Promise.resolve();
    },
  } as unknown as GitProvider;

  /** A job in AWAITING_APPROVAL whose verified result conflicts with main (and its decision opened by git flow). */
  async function conflictingJob(prompt = 'add the filters'): Promise<string> {
    const { job } = await jobs.create({
      project: PROJECT,
      spec: jobSpec({ prompt }),
      actor: creator,
      submit: true,
    });
    const grant = await jobs.acquireLease(job.id, W1, 3_600_000);
    const actor: JobActor = { type: 'worker', id: W1 };
    const epoch = grant.lease.epoch;
    await jobs.transition(job.id, 'lease_acked', { actor, epoch });
    await jobs.transition(job.id, 'runtime_started', { actor, epoch });
    await jobs.transition(job.id, 'run_finished', { actor, epoch });
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, base_captured_at, attempt_id, epoch,
                            branch, head_sha, verification, verified_at, changes, merge_state, merge_check,
                            merge_checked_at, pr_number, pr_url, created_at, updated_at)
       VALUES ($1, $2, 'git', 'main', $3, $4, $5, $6, $7, $8, 'passed', $4, $9, 'conflicts', $10, $4, 7,
               'https://github.com/acme/app/pull/7', $4, $4)`,
      [
        job.id,
        PROJECT,
        BASE,
        now,
        grant.attempt.id,
        epoch,
        `rac/${job.id}/${grant.attempt.id}`,
        HEAD,
        JSON.stringify({
          commits: [],
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
          totals: { files: 1, additions: 1, deletions: 0 },
          truncated: false,
        }),
        JSON.stringify({
          baseSha: 'c'.repeat(40),
          headSha: HEAD,
          files: ['src/a.ts', 'README.md'],
          headCommits: [],
          baseCommits: [{ sha: 'c'.repeat(40), subject: 'nonce signatures' }],
          precision: 'exact',
          reason: null,
        }),
      ],
    );
    await jobs.transition(job.id, 'verification_passed', {
      actor: { type: 'system', id: 'verifier' },
      reason: 't',
    });
    await gitflow.openDecisions();
    return job.id;
  }

  async function state(id: string): Promise<string> {
    const j = await jobs.get(id);
    return j?.state ?? 'missing';
  }

  async function markMerged(jobId: string): Promise<void> {
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO job_git (job_id, project, provider, target_branch, verification, merged_sha, merged_at, created_at,
                            updated_at)
       VALUES ($1, $2, 'git', 'main', 'passed', $3, $4, $4, $4)
       ON CONFLICT (job_id) DO UPDATE SET merged_sha = EXCLUDED.merged_sha, merged_at = EXCLUDED.merged_at`,
      [jobId, PROJECT, 'd'.repeat(40), now],
    );
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({ gitflow: { providers: () => fake, timing: { refreshIntervalMs: 0 } } });
    ownerId = await h.createUser('owner.cr', PW, 'owner');
    const { secret } = await enroll(h, 'owner.cr', PW);
    owner = await fullLogin(h, 'owner.cr', PW, secret);
    creator = { type: 'user', id: ownerId };
    subject = await loadSubject(h.db.pool, { id: ownerId, role: 'owner' });
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      PROJECT,
      h.clock.now(),
    ]);
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 1800, $3, $4)`,
      [PROJECT, REPO_URL, ownerId, h.clock.now()],
    );
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    policy = new SecurityPolicyService({ pool: h.db.pool, audit, clock: h.clock.now, cacheMs: 0 });
    const approvals = new ApprovalService({
      pool: h.db.pool,
      audit,
      jobs,
      clock: h.clock.now,
      securityPolicy: policy,
    });
    gitflow = new GitFlowService({
      pool: h.db.pool,
      jobs,
      approvals,
      audit,
      providers: () => fake,
      clock: h.clock.now,
      log: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
      } as unknown as FastifyBaseLogger,
      leaseTtlMs: 60_000,
    });
    svc = new ConflictResolveService({
      pool: h.db.pool,
      audit,
      jobs,
      securityPolicy: policy,
      supersede: () => (a, b) => gitflow.supersede(a, b),
      clock: h.clock.now,
      since: new Date(h.clock.now().getTime() - 60_000),
    });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('a person opens one resolve job from the current target; its prompt merges the verified head', async () => {
    const src = await conflictingJob('add the WhatsApp filters');
    const pending = await h.db.pool.query<{ status: string }>(
      `SELECT status FROM approval_requests WHERE job_id = $1 AND kind = 'gate'`,
      [src],
    );
    expect(pending.rows.map((r) => r.status)).toEqual(['pending']);
    const out = await svc.resolve(src, { subject });
    const job = await jobs.get(out.jobId);
    expect(job?.state).toBe('QUEUED');
    expect(job?.spec.title).toBe('Resolve conflicts: add the WhatsApp filters');
    expect(job?.spec.repository?.baseRef).toBe('main');
    expect(job?.spec.prompt).toContain(`git merge --no-commit --no-ff ${HEAD}`);
    expect(job?.spec.prompt).toContain('- README.md');
    expect(job?.spec.prompt).toContain('add the WhatsApp filters');
    await expect(svc.resolve(src, { subject })).rejects.toMatchObject({ code: 'already_resolving' });
    // The source stays waiting until the resolution merges.
    expect(await state(src)).toBe('AWAITING_APPROVAL');
    expect(await svc.view(src)).toMatchObject({ resolveJobId: out.jobId, state: 'created' });
  });

  it('when the resolve job merges, the source is superseded and its pull request closed by the platform', async () => {
    const src = await conflictingJob();
    const out = await svc.resolve(src, { subject });
    expect(await svc.finish()).toBe(0);
    await markMerged(out.jobId);
    closed.length = 0;
    expect(await svc.finish()).toBe(1);
    expect(await state(src)).toBe('CANCELLED');
    const t = await h.db.pool.query<{ trigger: string; reason: string }>(
      `SELECT trigger, reason FROM job_transitions WHERE job_id = $1 ORDER BY version DESC LIMIT 1`,
      [src],
    );
    expect(t.rows[0]?.trigger).toBe('cancel_requested');
    expect(t.rows[0]?.reason).toContain(out.jobId);
    const gate = await h.db.pool.query<{ status: string }>(
      `SELECT status FROM approval_requests WHERE job_id = $1 AND kind = 'gate'`,
      [src],
    );
    expect(gate.rows.map((r) => r.status)).toEqual(['cancelled']);
    const mr = await h.db.pool.query<{ status: string }>(
      'SELECT status FROM git_merge_requests WHERE job_id = $1',
      [src],
    );
    expect(mr.rows.map((r) => r.status)).toEqual(['cancelled']);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.pr.number).toBe(7);
    expect(closed[0]?.comment).toContain(out.jobId);
    expect(await svc.view(src)).toMatchObject({ state: 'merged', prClosed: true });
    const ev = await owner.req('GET', `/jobs/${src}/autonomy`);
    expect(ev.statusCode, ev.body).toBe(200);
    const body = ev.json<{
      conflictResolve: { state: string } | null;
      conflictResolvable: boolean;
      events: { kind: string; detail: Record<string, unknown> }[];
    }>();
    expect(body.conflictResolve?.state).toBe('merged');
    expect(body.conflictResolvable).toBe(false);
    expect(body.events.filter((e) => e.kind === 'conflict_resolve').map((e) => e.detail.state)).toEqual([
      'created',
      'merged',
    ]);
    const of = (await owner.req('GET', `/jobs/${out.jobId}/autonomy`)).json<{ conflictResolveOf: string }>();
    expect(of.conflictResolveOf).toBe(src);
  });

  it('a resolve job that ends without merging leaves the source as it was; it can be resolved again', async () => {
    const src = await conflictingJob();
    const out = await svc.resolve(src, { subject });
    await jobs.transition(out.jobId, 'cancel_requested', { actor: creator, reason: 'not now' });
    expect(await svc.finish()).toBe(1);
    expect(await state(src)).toBe('AWAITING_APPROVAL');
    expect(await svc.view(src)).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('CANCELLED') as unknown,
    });
    const again = await svc.resolve(src, { subject });
    expect(again.jobId).not.toBe(out.jobId);
  });

  it('refuses a result that does not conflict', async () => {
    const src = await conflictingJob();
    await h.db.pool.query(`UPDATE job_git SET merge_state = 'clean' WHERE job_id = $1`, [src]);
    await expect(svc.resolve(src, { subject })).rejects.toMatchObject({ code: 'not_resolvable' });
  });

  it('auto mode opens one resolve job per conflicting result as its creator; off, nothing', async () => {
    await h.setSecurityPolicy({ preset: 'serbest', autonomy: { autoMode: false } });
    const src = await conflictingJob();
    expect(await svc.openAuto()).toBe(0);
    await h.setSecurityPolicy({ preset: 'serbest', autonomy: { autoMode: true } });
    expect(await svc.openAuto()).toBe(1);
    const v = await svc.view(src);
    expect(v?.state).toBe('created');
    const created = await jobs.get(v?.resolveJobId ?? '');
    expect(created?.createdBy).toMatchObject({ type: 'user', id: ownerId });
    expect(await svc.openAuto()).toBe(0);
    await h.setSecurityPolicy({ preset: 'serbest', autonomy: { autoMode: false } });
  });

  it('POST /jobs/:id/resolve-conflicts (the console button)', async () => {
    const src = await conflictingJob();
    const before = (await owner.req('GET', `/jobs/${src}/autonomy`)).json<{ conflictResolvable: boolean }>();
    expect(before.conflictResolvable).toBe(true);
    const res = await owner.req('POST', `/jobs/${src}/resolve-conflicts`);
    expect(res.statusCode, res.body).toBe(201);
    const again = await owner.req('POST', `/jobs/${src}/resolve-conflicts`);
    expect(again.statusCode).toBe(409);
  });
});
