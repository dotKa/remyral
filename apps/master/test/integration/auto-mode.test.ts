import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/service.js';
import { AuditLog } from '../../src/audit/audit.js';
import { withTransaction } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { attemptBranch, attemptTrailerValue } from '../../src/gitflow/refs.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { SecurityPolicyService } from '../../src/security-policy/service.js';
import { AutoFixService } from '../../src/self-heal/auto-fix.js';
import { BaseRefHealer } from '../../src/self-heal/base-ref.js';
import { AutoRetryService, avoidedWorkers, SELF_HEAL_ACTOR } from '../../src/self-heal/retry.js';
import { createTestDatabase, describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, jobSpec, PROJECT, REPO_URL } from '../helpers/job-worker.js';
import { removeDirs } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const W1 = 'worker-a';
const W2 = 'worker-b';
/** A stored production policy document as written before migration 0126. */
const PROD_DOC = {
  preset: 'serbest',
  stepUp: { windowMinutes: 43200 },
  autonomy: { autoApprove: { deploy: false, 'tool.mcp': false, 'runtime.dangerous_tool': false } },
};

/**
 * p15-auto-mode (docs/design/p15-auto-mode.md): auto mode grants and its floor, migration 0126, automatic retries with
 * backoff (and the machine avoided next), base ref healing, the platform rebase of a diverged attempt, the auto-fix job
 * and the failure digest — real Postgres, the plain-git provider on a local bare repository.
 */
describeIntegration('auto mode, retries and self-healing (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let jobs: JobStore;
  let policy: SecurityPolicyService;
  let approvals: ApprovalService;
  let retry: AutoRetryService;
  let owner: Client;
  let ownerId: string;
  let creator: JobActor;
  let fileUrl: string;
  let bare: string;
  let provider: LocalGitProvider;
  const dirs: string[] = [];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'h',
        GIT_AUTHOR_EMAIL: 'h@example.test',
        GIT_COMMITTER_NAME: 'h',
        GIT_COMMITTER_EMAIL: 'h@example.test',
      },
      encoding: 'utf8',
    }).trim();

  /** A commit on top of `from` (a branch or sha of the bare repository) pushed to `to`. */
  async function pushCommit(from: string, to: string, file: string, content: string, message: string) {
    const work = await mkdtemp(join(tmpdir(), 'rw-am-'));
    dirs.push(work);
    git(work, 'init', '-q');
    git(work, 'fetch', '-q', fileUrl, '+refs/heads/*:refs/remotes/o/*');
    git(work, 'checkout', '-q', /^[0-9a-f]{40}$/.test(from) ? from : `o/${from}`);
    await writeFile(join(work, file), content);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', message);
    git(work, 'push', '-q', '-f', fileUrl, `HEAD:refs/heads/${to}`);
    return git(work, 'rev-parse', 'HEAD');
  }
  const head = (branch: string) => git(bare, 'rev-parse', `refs/heads/${branch}`);

  async function must(id: string) {
    const j = await jobs.get(id);
    if (j === null) throw new Error(`job ${id} not found`);
    return j;
  }

  async function setPolicy(doc: Record<string, unknown>): Promise<void> {
    await h.setSecurityPolicy(doc);
  }

  async function runningJob(
    over: Record<string, unknown> = {},
    workerId = W1,
  ): Promise<{ jobId: string; attemptId: string; epoch: number }> {
    const { job } = await jobs.create({
      project: PROJECT,
      spec: jobSpec(over),
      actor: creator,
      submit: true,
    });
    const grant = await jobs.acquireLease(job.id, workerId, 3_600_000);
    const actor: JobActor = { type: 'worker', id: workerId };
    const epoch = grant.lease.epoch;
    await jobs.transition(job.id, 'lease_acked', { actor, epoch });
    await jobs.transition(job.id, 'runtime_started', { actor, epoch });
    return { jobId: job.id, attemptId: grant.attempt.id, epoch };
  }

  async function inRun(r: { jobId: string; attemptId: string; epoch: number }, action: string, key: string) {
    return approvals.evaluate({
      action,
      jobId: r.jobId,
      approvalKey: key,
      attemptId: r.attemptId,
      epoch: r.epoch,
      summary: `tool call ${action}`,
      requestedBy: { type: 'worker', id: W1 },
    });
  }

  async function failJob(jobId: string, reason: string): Promise<void> {
    const job = await jobs.get(jobId);
    if (job === null) throw new Error('no job');
    await jobs.transition(jobId, 'attempt_failed', {
      actor: { type: 'worker', id: W1 },
      epoch: job.leaseEpoch,
      reason,
    });
  }

  beforeAll(async () => {
    fileUrl = await createBareRepo(dirs);
    bare = fileURLToPath(fileUrl);
    const cacheDir = await mkdtemp(join(tmpdir(), 'rw-am-cache-'));
    dirs.push(cacheDir);
    provider = new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true });
    h = new Harness();
    await h.start({ gitflow: { providers: () => provider, timing: { refreshIntervalMs: 0 } } });
    ownerId = await h.createUser('owner.am', PW, 'owner');
    const { secret } = await enroll(h, 'owner.am', PW);
    owner = await fullLogin(h, 'owner.am', PW, secret);
    creator = { type: 'user', id: ownerId };
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at, auto_approve_execution) VALUES ($1, $1, $2, true)',
      [PROJECT, h.clock.now()],
    );
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 1800, $3, $4)`,
      [PROJECT, REPO_URL, ownerId, h.clock.now()],
    );
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    policy = new SecurityPolicyService({ pool: h.db.pool, audit, clock: h.clock.now, cacheMs: 0 });
    approvals = new ApprovalService({
      pool: h.db.pool,
      audit,
      jobs,
      clock: h.clock.now,
      securityPolicy: policy,
    });
    retry = new AutoRetryService({ audit, securityPolicy: policy, clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  describe('auto mode grants', () => {
    it('grants in-run tool approvals, MCP tools, deploys and merge decisions; audited and on the timeline', async () => {
      // The document's overrides (false) stay, but auto mode grants them anyway.
      await setPolicy({ ...PROD_DOC, autonomy: { ...PROD_DOC.autonomy, autoMode: true } });
      const r = await runningJob();
      for (const [i, action] of ['runtime.dangerous_tool', 'tool.mcp', 'deploy', 'secret.read'].entries()) {
        const ev = await inRun(r, action, `k${String(i)}`);
        expect(ev.outcome, action).toBe('allow');
      }
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'approval.evaluate' AND target = $1 ORDER BY id`,
        [`job:${r.jobId}`],
      );
      expect(audit.rows.map((x) => x.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'deploy', approvedVia: 'security_policy', autoMode: true }),
        ]),
      );
      const ev = await owner.req('GET', `/jobs/${r.jobId}/autonomy`);
      expect(ev.statusCode, ev.body).toBe(200);
      const body = ev.json<{ events: { kind: string; detail: Record<string, unknown> }[] }>();
      expect(body.events.filter((e) => e.kind === 'auto_approved').map((e) => e.detail.action)).toEqual([
        'runtime.dangerous_tool',
        'tool.mcp',
        'deploy',
        'secret.read',
      ]);
      expect(body.events.every((e) => e.detail.autoMode === true)).toBe(true);

      // A merge decision (gate) of a verified job.
      const g = await runningJob();
      await jobs.transition(g.jobId, 'run_finished', { actor: { type: 'worker', id: W1 }, epoch: g.epoch });
      await jobs.transition(g.jobId, 'verification_passed', {
        actor: { type: 'worker', id: W1 },
        epoch: g.epoch,
      });
      const merge = await approvals.evaluate({
        action: 'git.merge',
        jobId: g.jobId,
        summary: 'merge',
        requestedBy: { type: 'system', id: 'gitflow' },
      });
      expect(merge.outcome).toBe('allow');
      expect(merge.rule.sources).toContain('security_policy');
    });

    it('asks a person when auto mode is off (the prod overrides of before 0126)', async () => {
      // Serbest's own default is auto mode on: the owner's switch off.
      await setPolicy({ ...PROD_DOC, autonomy: { ...PROD_DOC.autonomy, autoMode: false } });
      const r = await runningJob();
      expect((await inRun(r, 'runtime.dangerous_tool', 'off1')).outcome).toBe('pending');
      expect((await inRun(r, 'deploy', 'off2')).outcome).toBe('pending');
    });

    it('keeps the floor: force push, deletes outside the workspace and machine administration still ask', async () => {
      await setPolicy({ preset: 'serbest', autonomy: { autoMode: true } });
      const r = await runningJob({ approvalPolicy: 'allow-all' });
      expect((await inRun(r, 'git.force_push', 'f1')).outcome).toBe('pending');
      expect((await inRun(r, 'fs.delete_outside_workspace', 'f2')).outcome).toBe('pending');
      const a = await runningJob();
      expect((await inRun(a, 'machine.admin', 'f3')).outcome).not.toBe('allow');
    });

    it('never applies to untrusted jobs or jobs that asked for more prompts', async () => {
      await setPolicy({ preset: 'serbest', autonomy: { autoMode: true } });
      const u = await runningJob({ sourceTrust: 'untrusted', sandboxProfile: 'container' });
      expect((await inRun(u, 'runtime.dangerous_tool', 'u1')).outcome).toBe('pending');
      const ask = await runningJob({ approvalPolicy: 'ask-all' });
      expect((await inRun(ask, 'runtime.dangerous_tool', 'u2')).outcome).toBe('pending');
    });
  });

  describe('automatic retries', () => {
    it('retries a runtime crash after 1, 5, 20 minutes, then gives up (retry_exhausted)', async () => {
      await setPolicy({ preset: 'serbest' });
      const r = await runningJob({}, W1);
      const delays: number[] = [];
      let attemptId = r.attemptId;
      for (let n = 1; n <= 4; n++) {
        const now = h.clock.now().getTime();
        const d = await withTransaction(h.db.pool, async (tx) => {
          const out = await retry.decideWithin(tx, {
            jobId: r.jobId,
            attemptId,
            workerId: n === 1 ? W1 : W2,
            phase: 'start',
            code: 'RuntimeCrashedError',
            message: 'RuntimeCrashedError: the runtime crashed at start',
          });
          if (out !== null)
            await jobs.transitionWithin(tx, r.jobId, 'attempt_retry', {
              actor: SELF_HEAL_ACTOR,
              retrySafe: true,
              reason: out.reason,
            });
          return out;
        });
        if (n === 4) {
          expect(d).toBeNull();
          break;
        }
        expect(d).toMatchObject({ number: n, max: 3, cause: 'runtime_crash', machineSpecific: true });
        delays.push(((d?.retryAt.getTime() ?? 0) - now) / 1000);
        expect((await jobs.get(r.jobId))?.state).toBe('RETRY_WAIT');
        // Not before the backoff …
        await h.app.orchestrator.promoteRetries();
        expect((await jobs.get(r.jobId))?.state).toBe('RETRY_WAIT');
        h.clock.advance((delays.at(-1) ?? 0) * 1000 + 1000);
        await h.app.orchestrator.promoteRetries();
        expect((await jobs.get(r.jobId))?.state).toBe('QUEUED');
        // … the next attempt (on another machine).
        const grant = await jobs.acquireLease(r.jobId, W2, 3_600_000);
        attemptId = grant.attempt.id;
        await jobs.transition(r.jobId, 'lease_acked', {
          actor: { type: 'worker', id: W2 },
          epoch: grant.lease.epoch,
        });
      }
      expect(delays).toEqual([60, 300, 1200]);
      expect(await avoidedWorkers(h.db.pool, r.jobId)).toEqual([W2, W1]);
      const view = (await owner.req('GET', `/jobs/${r.jobId}/autonomy`)).json<{
        retry: { used: number; max: number };
        events: { kind: string }[];
      }>();
      expect(view.retry).toMatchObject({ used: 3, max: 3 });
      expect(view.events.map((e) => e.kind)).toEqual([
        'auto_retry',
        'auto_retry',
        'auto_retry',
        'retry_exhausted',
      ]);
      const audit = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'job.auto_retry' AND target = $1`,
        [`job:${r.jobId}`],
      );
      expect(audit.rowCount).toBe(3);
    });

    it('does not retry permanent failures, and Sıkı retries nothing', async () => {
      await setPolicy({ preset: 'serbest' });
      const r = await runningJob();
      const permanent = await withTransaction(h.db.pool, (tx) =>
        retry.decideWithin(tx, {
          jobId: r.jobId,
          attemptId: r.attemptId,
          workerId: W1,
          phase: 'run',
          code: 'RepositoryNotAllowedError',
          message: 'repository not allowed',
        }),
      );
      expect(permanent).toBeNull();
      await setPolicy({ preset: 'siki' });
      const strict = await withTransaction(h.db.pool, (tx) =>
        retry.decideWithin(tx, {
          jobId: r.jobId,
          attemptId: r.attemptId,
          workerId: W1,
          phase: 'start',
          code: 'DiskQuotaError',
          message: 'not enough free disk space',
        }),
      );
      expect(strict).toBeNull();
    });
  });

  describe('base ref healing', () => {
    const healer = () =>
      new BaseRefHealer({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        providerFor: (p) => h.app.gitflow.providerFor(p),
      });
    async function queued(over: Record<string, unknown>): Promise<string> {
      const { job } = await jobs.create({
        project: PROJECT,
        spec: jobSpec(over),
        actor: creator,
        submit: true,
      });
      return job.id;
    }

    it('waits for the previous job whose work branch is the base, then builds on its verified head', async () => {
      const prev = await runningJob({
        repository: { url: REPO_URL, baseRef: 'main', workBranch: 'agent/chat-a1' },
      });
      const next = await queued({
        repository: { url: REPO_URL, baseRef: 'agent/chat-a1', workBranch: 'agent/chat-b' },
      });
      const wait = await healer().heal(await must(next));
      expect(wait).toMatchObject({ kind: 'wait', forJob: prev.jobId });
      const sha = head('main');
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, head_sha, verification, created_at, updated_at)
         VALUES ($1, $2, 'git', 'main', $3, 'passed', now(), now())`,
        [prev.jobId, PROJECT, sha],
      );
      const healed = await healer().heal(await must(next));
      expect(healed).toMatchObject({ kind: 'healed', to: sha, reason: 'previous_job_head' });
      expect((await jobs.get(next))?.spec.repository?.baseRef).toBe(sha);
      expect(await healer().heal(await must(next))).toEqual({ kind: 'ok' });
    });

    it('falls back to the project base branch when the previous job never published', async () => {
      const prev = await runningJob({
        repository: { url: REPO_URL, baseRef: 'main', workBranch: 'agent/chat-c1' },
      });
      await failJob(prev.jobId, 'GitCommandError: git push failed');
      const next = await queued({
        repository: { url: REPO_URL, baseRef: 'agent/chat-c1', workBranch: 'agent/chat-d' },
      });
      expect(await healer().heal(await must(next))).toMatchObject({
        kind: 'healed',
        to: 'main',
        reason: 'project_base',
      });
      const ev = (await owner.req('GET', `/jobs/${next}/autonomy`)).json<{
        events: { kind: string; detail: Record<string, unknown> }[];
      }>();
      expect(ev.events[0]).toMatchObject({
        kind: 'base_ref',
        detail: { from: 'agent/chat-c1', to: 'main', previousJob: prev.jobId },
      });
    });

    it('uses the repository’s default branch when the project base branch is missing, and records it', async () => {
      await h.db.pool.query("UPDATE project_git_configs SET base_branch = 'trunk' WHERE project = $1", [
        PROJECT,
      ]);
      try {
        const next = await queued({
          repository: { url: REPO_URL, baseRef: 'trunk', workBranch: 'agent/chat-e' },
        });
        expect(await healer().heal(await must(next))).toMatchObject({
          kind: 'healed',
          to: 'main',
          reason: 'repository_default',
        });
        const cfg = await h.db.pool.query<{ base_branch: string }>(
          'SELECT base_branch FROM project_git_configs WHERE project = $1',
          [PROJECT],
        );
        expect(cfg.rows[0]?.base_branch).toBe('main');
        const audit = await h.db.pool.query(
          "SELECT 1 FROM audit_events WHERE action = 'project.git.base_branch_healed'",
        );
        expect(audit.rowCount).toBe(1);
      } finally {
        await h.db.pool.query("UPDATE project_git_configs SET base_branch = 'main' WHERE project = $1", [
          PROJECT,
        ]);
      }
    });
  });

  describe('diverged verification', () => {
    async function verifyingDiverged(file: string, content: string) {
      const r = await runningJob();
      const base = await pushCommit('main', 'main', 'NOTES.md', `notes ${r.jobId}\n`, 'main moved on');
      const old = git(bare, 'rev-parse', `${base}~1`);
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, base_captured_at, created_at, updated_at)
         VALUES ($1, $2, 'git', 'main', $3, now(), now(), now())`,
        [r.jobId, PROJECT, base],
      );
      const branch = attemptBranch(r.jobId, r.attemptId);
      await pushCommit(
        old,
        branch,
        file,
        content,
        `agent work\n\nRemyral-Attempt: ${attemptTrailerValue(r.attemptId, r.epoch)}`,
      );
      await jobs.transition(r.jobId, 'run_finished', { actor: { type: 'worker', id: W1 }, epoch: r.epoch });
      return { ...r, base, branch };
    }

    it('rebases the attempt onto the base at job start and verifies it again', async () => {
      await setPolicy({ preset: 'siki' });
      const r = await verifyingDiverged('feature.txt', 'feature\n');
      expect(await h.app.gitflow.verify(r.jobId)).toBe('passed');
      expect((await jobs.get(r.jobId))?.state).toBe('AWAITING_APPROVAL');
      const now = head(r.branch);
      expect(git(bare, 'merge-base', '--is-ancestor', r.base, now) === '').toBe(true);
      expect(git(bare, 'log', '-1', '--format=%B', now)).toContain(
        `Remyral-Attempt: ${attemptTrailerValue(r.attemptId, r.epoch)}`,
      );
      const jg = await h.db.pool.query<{ auto_rebase: { outcome: string; to: string } }>(
        'SELECT auto_rebase FROM job_git WHERE job_id = $1',
        [r.jobId],
      );
      expect(jg.rows[0]?.auto_rebase).toMatchObject({ outcome: 'rebased', to: now });
    });

    it('a conflicting rebase stays a failure that names the conflicting files', async () => {
      await setPolicy({ preset: 'siki' });
      // NOTES.md is changed on main by verifyingDiverged and differently by the attempt.
      const r = await verifyingDiverged('NOTES.md', 'the agent’s notes\n');
      expect(await h.app.gitflow.verify(r.jobId)).toBe('failed');
      const t = await h.db.pool.query<{ reason: string }>(
        `SELECT reason FROM job_transitions WHERE job_id = $1 ORDER BY version DESC LIMIT 1`,
        [r.jobId],
      );
      expect(t.rows[0]?.reason).toMatch(/conflicts in 1 file\(s\): NOTES\.md/);
    });
  });

  describe('auto-fix job', () => {
    it('opens one fix job for a permanent failure, never twice, never for a refusal; notifies once', async () => {
      await setPolicy({ preset: 'serbest' });
      // Failures of the earlier tests are older than the service's start.
      h.clock.advance(5 * 60_000);
      const autoFix = new AutoFixService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        jobs,
        securityPolicy: policy,
        clock: h.clock.now,
        since: new Date(h.clock.now().getTime() - 1_000),
      });
      const a = await runningJob({ prompt: 'add the login page' });
      await failJob(a.jobId, 'run_failed: the tests do not pass');
      const refused = await runningJob();
      await failJob(refused.jobId, 'RepositoryNotAllowedError: repository x is not allowed for project acme');
      // p22-timeout-continuity: a job stopped by its time limit continues from its kept work, never as a fix job.
      const timedOut = await runningJob();
      await failJob(timedOut.jobId, 'max_duration_exceeded: run exceeded 3600000 ms of run time');
      expect(await autoFix.tick()).toBe(1);
      expect(await autoFix.tick()).toBe(0);
      const rows = await h.db.pool.query<{ source_job_id: string; fix_job_id: string | null; state: string }>(
        'SELECT source_job_id::text, fix_job_id::text, state FROM job_auto_fixes ORDER BY created_at',
      );
      const fix = rows.rows.find((x) => x.source_job_id === a.jobId);
      expect(fix?.state).toBe('created');
      expect(rows.rows.find((x) => x.source_job_id === refused.jobId)?.state).toBe('skipped');
      expect(rows.rows.find((x) => x.source_job_id === timedOut.jobId)?.state).toBe('skipped');
      const fixJob = await jobs.get(fix?.fix_job_id ?? '');
      const fixId = fix?.fix_job_id ?? '';
      expect(fixJob?.state).toBe('QUEUED');
      expect(fixJob?.spec.prompt).toContain('Find and fix the cause of the failure');
      expect(fixJob?.spec.prompt).toContain('the tests do not pass');
      expect(fixJob?.spec.prompt).toContain('add the login page');
      expect(fixJob?.spec.runtime).toBe('codex');
      expect(fixJob?.createdBy).toEqual({ type: 'user', id: ownerId });

      // The fix job fails too: no fix of the fix; the owner is told once.
      const grant = await jobs.acquireLease(fixId, W1, 3_600_000);
      await jobs.transition(fixId, 'lease_acked', {
        actor: { type: 'worker', id: W1 },
        epoch: grant.lease.epoch,
      });
      await jobs.transition(fixId, 'attempt_failed', {
        actor: { type: 'worker', id: W1 },
        epoch: grant.lease.epoch,
        reason: 'run_failed: still failing',
      });
      await autoFix.tick();
      await autoFix.tick();
      const after = await h.db.pool.query<{ state: string }>(
        'SELECT state FROM job_auto_fixes WHERE source_job_id = $1',
        [a.jobId],
      );
      expect(after.rows[0]?.state).toBe('failed');
      expect(
        (await h.db.pool.query('SELECT 1 FROM job_auto_fixes WHERE source_job_id = $1', [fixId])).rowCount,
      ).toBe(0);
      const out = await h.db.pool.query("SELECT 1 FROM outbox WHERE topic = 'self_heal.auto_fix'");
      expect(out.rowCount).toBe(1);
    });

    it('opens nothing when auto mode is off', async () => {
      await setPolicy({ preset: 'dengeli' });
      const autoFix = new AutoFixService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        jobs,
        securityPolicy: policy,
        clock: h.clock.now,
        since: new Date(h.clock.now().getTime() - 1_000),
      });
      const a = await runningJob();
      await failJob(a.jobId, 'run_failed: nope');
      expect(await autoFix.openFixes()).toBe(0);
    });
  });

  it('digest: failed, healed by themselves, waiting for a person (last 24 hours)', async () => {
    const before = (await owner.req('GET', '/autonomy/digest')).json<{
      failed: number;
      healed: number;
      waiting: number;
    }>();
    // One more failure, one healed job (automatic retry, then success), one pending approval.
    await setPolicy({ preset: 'siki' });
    const f = await runningJob();
    await failJob(f.jobId, 'run_failed: x');
    const healed = await runningJob();
    await h.db.pool.query(
      `INSERT INTO job_auto_events (job_id, kind, detail, created_at) VALUES ($1, 'auto_retry', '{}', $2)`,
      [healed.jobId, h.clock.now()],
    );
    await jobs.transition(healed.jobId, 'run_finished', {
      actor: { type: 'worker', id: W1 },
      epoch: healed.epoch,
    });
    await jobs.transition(healed.jobId, 'verification_passed_no_approval', {
      actor: { type: 'system', id: 'verifier' },
    });
    const w = await runningJob();
    expect((await inRun(w, 'deploy', 'dg')).outcome).toBe('pending');
    const res = await owner.req('GET', '/autonomy/digest');
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json<{ failed: number; healed: number; waiting: number }>();
    expect(after.failed - before.failed).toBe(1);
    expect(after.healed - before.healed).toBe(1);
    expect(after.waiting - before.waiting).toBe(1);
  });
});

describeIntegration('migration 0126 (integration)', () => {
  it('turns auto mode on, drops the three false overrides and is audited by the master as a system change', async () => {
    const db = await createTestDatabase({ migrated: false });
    const dir = await mkdtemp(join(tmpdir(), 'rw-mig-'));
    try {
      const src = fileURLToPath(new URL('../../migrations/', import.meta.url));
      await mkdir(dir, { recursive: true });
      for (const f of await readdir(src))
        if (f.endsWith('.sql') && f < '0126') await copyFile(join(src, f), join(dir, f));
      await migrate(db.pool, { dir });
      await db.pool.query('UPDATE security_policy SET document = $1, version = 7 WHERE id = 1', [
        JSON.stringify(PROD_DOC),
      ]);
      await db.pool.query(
        "INSERT INTO security_policy_versions (version, document, created_at, via) VALUES (7, $1, now(), 'console')",
        [JSON.stringify(PROD_DOC)],
      );
      await migrate(db.pool);
      const { rows } = await db.pool.query<{ document: unknown; version: number }>(
        'SELECT document, version FROM security_policy WHERE id = 1',
      );
      expect(rows[0]).toEqual({
        version: 8,
        document: { preset: 'serbest', stepUp: { windowMinutes: 43200 }, autonomy: { autoMode: true } },
      });
      const v = await db.pool.query<{ via: string; reason: string; audited_at: Date | null }>(
        'SELECT via, reason, audited_at FROM security_policy_versions WHERE version = 8',
      );
      expect(v.rows[0]).toMatchObject({ via: 'migration', audited_at: null });
      expect(v.rows[0]?.reason).toContain('owner decision 2026-10-22');
      const audit = new AuditLog(db.pool, () => new Date());
      const svc = new SecurityPolicyService({ pool: db.pool, audit, cacheMs: 0 });
      expect(await svc.auditMigrationVersions()).toBe(1);
      expect(await svc.auditMigrationVersions()).toBe(0);
      const a = await db.pool.query<{ actor_type: string; metadata: Record<string, unknown> }>(
        "SELECT actor_type, metadata FROM audit_events WHERE action = 'security.policy.update'",
      );
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0]?.actor_type).toBe('system');
      expect(a.rows[0]?.metadata).toMatchObject({
        via: 'migration',
        toVersion: 8,
        changed: expect.arrayContaining([
          'autonomy.autoApprove.deploy',
          'autonomy.autoApprove.tool.mcp',
          'autonomy.autoApprove.runtime.dangerous_tool',
        ]) as unknown,
      });
      expect((await svc.current()).autonomy).toMatchObject({ autoMode: true, autoRetryMax: 3 });
    } finally {
      await db.drop();
      await removeDirs([dir]);
    }
  });
});
