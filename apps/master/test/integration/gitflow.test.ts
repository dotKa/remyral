import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentAdapter,
  basicScript,
  FakeRuntimeAdapter,
  type SessionRef,
  type SessionResult,
  type SpawnContext,
} from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ApprovalService } from '../../src/approvals/service.js';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import type { GitProvider } from '../../src/gitflow/types.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  createBareRepo,
  type JobWorker,
  jobSpec,
  PROJECT,
  REPO_URL,
  startJobWorker,
} from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;

/**
 * Fake runtime that edits files: `edit <path> <line>` prompts (one per line) are written into the attempt
 * worktree when the session spawns. `hold` lets a test keep the run open before the result is collected.
 */
class EditingAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;
  hold: Promise<void> = Promise.resolve();
  /** Every prompt the platform sent (preambles included). */
  readonly prompts: string[] = [];
  readonly inner = new FakeRuntimeAdapter({ runtime: 'codex', script: basicScript });
  probe() {
    return this.inner.probe();
  }
  capabilities() {
    return this.inner.capabilities();
  }
  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    for (const line of ctx.job.prompt.split('\n')) {
      const m = /^edit (\S+) (.*)$/.exec(line);
      if (m?.[1] !== undefined) await writeFile(join(ctx.workspaceRoot, m[1]), `${m[2] ?? ''}\n`);
    }
    return this.inner.spawn(ctx);
  }
  sendPrompt(ref: SessionRef, prompt: { text: string }) {
    this.prompts.push(prompt.text);
    return this.inner.sendPrompt(ref, prompt);
  }
  events(ref: SessionRef, cursor?: Parameters<FakeRuntimeAdapter['events']>[1]) {
    return this.inner.events(ref, cursor);
  }
  requestApproval(ref: SessionRef, d: Parameters<FakeRuntimeAdapter['requestApproval']>[1]) {
    return this.inner.requestApproval(ref, d);
  }
  cancel(ref: SessionRef) {
    return this.inner.cancel(ref);
  }
  resume(ref: SessionRef, ctx: SpawnContext) {
    return this.inner.resume(ref, ctx);
  }
  async collectResult(ref: SessionRef): Promise<SessionResult> {
    await this.hold;
    return this.inner.collectResult(ref);
  }
  cleanup(ref: SessionRef) {
    return this.inner.cleanup(ref);
  }
  getCost(ref: SessionRef) {
    return this.inner.getCost(ref);
  }
}

/** Provider wrapper whose reads of attempt branches can be paused (to act between push and verification). */
class PausableProvider implements GitProvider {
  readonly kind = 'git' as const;
  gate: Promise<void> = Promise.resolve();
  constructor(private readonly p: GitProvider) {}
  async branchHead(b: string) {
    if (b.startsWith('rac/')) await this.gate;
    return this.p.branchHead(b);
  }
  commit(s: string) {
    return this.p.commit(s);
  }
  compare(a: string, b: string) {
    return this.p.compare(a, b);
  }
  testMerge(i: Parameters<GitProvider['testMerge']>[0]) {
    return this.p.testMerge(i);
  }
  ensurePullRequest(i: Parameters<GitProvider['ensurePullRequest']>[0]) {
    return this.p.ensurePullRequest(i);
  }
  checks(s: string) {
    return this.p.checks(s);
  }
  merge(i: Parameters<GitProvider['merge']>[0]) {
    return this.p.merge(i);
  }
  findMerge(t: string, id: string) {
    return this.p.findMerge(t, id);
  }
  deleteBranch(b: string, s: string) {
    return this.p.deleteBranch(b, s);
  }
}

interface Changes {
  enabled: boolean;
  branch: string | null;
  headSha: string | null;
  verification: { status: string; reason: string | null };
  commits: { sha: string; subject: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  totals: { files: number; additions: number; deletions: number };
  mergeCheck: {
    state: string | null;
    files: string[];
    headCommits: { sha: string }[];
    baseCommits: { sha: string }[];
  };
  merged: { sha: string } | null;
  requests: {
    id: string;
    approvalRequestId: string;
    mode: string;
    status: string;
    resultReason: string | null;
  }[];
}

/**
 * p4-git-flow end to end: real master (Postgres, BullMQ), real worker daemons over the WebSocket transport,
 * real worktrees, real pushes to a local bare repository, the plain-git provider on the master side and a
 * fake runtime that edits files.
 */
describeIntegration(
  'git flow: verification, conflicts, protected merge (integration)',
  { timeout: 120_000 },
  () => {
    let h: Harness;
    let url: string;
    let admin: Client;
    let secret: string;
    let fileUrl: string;
    let bare: string;
    let provider: PausableProvider;
    const dirs: string[] = [];
    const workers: JobWorker[] = [];

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

    /** Pushes a commit (changing `file`) on top of `branch` in the bare repository. */
    async function pushCommit(
      branch: string,
      file: string,
      content: string,
      message: string,
    ): Promise<string> {
      const work = await mkdtemp(join(tmpdir(), 'rw-gf-'));
      dirs.push(work);
      git(work, 'init', '-q');
      git(work, 'fetch', '-q', fileUrl, `refs/heads/${branch}:refs/heads/x`);
      git(work, 'checkout', '-q', 'x');
      await writeFile(join(work, file), content);
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', message);
      git(work, 'push', '-q', fileUrl, `x:refs/heads/${branch}`);
      return git(work, 'rev-parse', 'HEAD');
    }

    const head = (branch: string) => git(bare, 'rev-parse', `refs/heads/${branch}`);

    beforeAll(async () => {
      fileUrl = await createBareRepo(dirs);
      bare = fileURLToPath(fileUrl);
      const cacheDir = await mkdtemp(join(tmpdir(), 'rw-gf-cache-'));
      dirs.push(cacheDir);
      provider = new PausableProvider(new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true }));
      h = new Harness();
      await h.start({
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: `g${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
          timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
        },
        gitflow: { providers: () => provider, timing: { refreshIntervalMs: 0 } },
      });
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      admin = await fullLogin(h, 'owner1', PW, secret);
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        PROJECT,
        h.clock.now(),
      ]);
      const put = await admin.req('PUT', `/projects/${PROJECT}/git`, {
        expectedVersion: 0,
        provider: 'git',
        repositoryUrl: REPO_URL,
        baseBranch: 'main',
        mergeMethod: 'merge',
      });
      expect(put.statusCode, put.body).toBe(200);
    });
    afterEach(async () => {
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      provider.gate = Promise.resolve();
    });
    afterAll(async () => {
      await h.stop();
      await removeDirs(dirs);
    });

    async function newWorker(adapter: EditingAdapter): Promise<{ id: string; w: JobWorker }> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, admin, secret, dir);
      const w = await startJobWorker(url, dir, { fileUrl, adapter });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return { id, w };
    }

    async function submit(prompt: string): Promise<string> {
      const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec({ prompt }) });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ job: { id: string } }>().job.id;
    }

    async function state(id: string): Promise<string> {
      return (await admin.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
    }
    /** The state and the last transitions: a poll that times out then says how the job got there. */
    async function stateTrail(id: string): Promise<string> {
      const d = (await admin.req('GET', `/jobs/${id}`)).json<{
        job: { state: string };
        transitions: { trigger: string }[];
      }>();
      return `${d.job.state} [${d.transitions
        .slice(-6)
        .map((t) => t.trigger)
        .join(', ')}]`;
    }

    async function changes(id: string): Promise<Changes> {
      const res = await admin.req('GET', `/jobs/${id}/changes`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Changes>();
    }

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    async function lastTransition(
      id: string,
    ): Promise<{ trigger: string; reason: string | null; actor: { type: string } }> {
      const d = (await admin.req('GET', `/jobs/${id}`)).json<{
        transitions: { trigger: string; reason: string | null; actor: { type: string } }[];
      }>();
      const t = d.transitions.at(-1);
      if (t === undefined) throw new Error('no transitions');
      return t;
    }

    it('two jobs edit the same file: the first merges after approval + step-up, the second shows reviewable conflicts', async () => {
      const adapter = new EditingAdapter();
      await newWorker(adapter);
      const baseBefore = head('main');
      const a = await submit('edit README.md alpha version\nfix the readme');
      await expect.poll(() => state(a), { timeout: 30_000 }).toBe('AWAITING_APPROVAL');
      const b = await submit('edit README.md beta version\nrewrite the readme');
      await expect.poll(() => state(b), { timeout: 30_000 }).toBe('AWAITING_APPROVAL');

      // Verified on the remote, not on the worker's word.
      const ca = await changes(a);
      expect(ca).toMatchObject({
        enabled: true,
        verification: { status: 'passed' },
        totals: { files: 1 },
        mergeCheck: { state: 'clean' },
      });
      expect(ca.branch).toMatch(/^rac\//);
      expect(ca.headSha).toBe(head(ca.branch ?? ''));
      expect(git(bare, 'log', '-1', '--format=%B', ca.headSha ?? '')).toMatch(
        /Remyral-Attempt: [0-9a-f-]+\/1/,
      );
      expect(ca.files).toEqual([expect.objectContaining({ path: 'README.md', status: 'modified' })]);
      expect((await lastTransition(a)).trigger).toBe('verification_passed');

      // Requesting the merge only opens the approval; nothing is merged yet.
      const req = await admin.req('POST', `/jobs/${a}/merge`, { mode: 'merge' });
      expect(req.statusCode, req.body).toBe(202);
      const approvalId = req.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
      expect(head('main')).toBe(baseBefore);
      expect(await state(a)).toBe('AWAITING_APPROVAL');
      const approval = (await admin.req('GET', `/approvals/${approvalId}`)).json<{
        request: { action: string; approverRole: string; stepUp: boolean; summary: string };
      }>().request;
      expect(approval).toMatchObject({ action: 'git.merge', approverRole: 'admin', stepUp: true });
      expect(approval.summary).toContain('Merge rac/');

      // Step-up is mandatory (platform floor): a stale TOTP is refused, nothing happens.
      h.clock.advance(11 * 60_000);
      const stale = await admin.req('POST', `/approvals/${approvalId}/approve`, {});
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      expect(head('main')).toBe(baseBefore);
      await stepUp();
      const ok = await admin.req('POST', `/approvals/${approvalId}/approve`, { reason: 'reviewed' });
      expect(ok.statusCode, ok.body).toBe(200);
      await expect.poll(() => state(a), { timeout: 20_000 }).toBe('SUCCEEDED');
      const merged = await changes(a);
      expect(merged.merged?.sha).toBe(head('main'));
      expect(git(bare, 'merge-base', '--is-ancestor', ca.headSha ?? '', 'main')).toBe('');
      expect(await lastTransition(a)).toMatchObject({ trigger: 'approval_granted', actor: { type: 'user' } });

      // The second job now conflicts: a reviewable record, the merge request is refused, the job waits.
      await h.app.gitflow.refresh(b, { force: true });
      const cb = await changes(b);
      expect(cb.mergeCheck.state).toBe('conflicts');
      expect(cb.mergeCheck.files).toEqual(['README.md']);
      expect(cb.mergeCheck.headCommits.length).toBeGreaterThan(0);
      expect(cb.mergeCheck.baseCommits.length).toBeGreaterThan(0);
      // p15-merge-approvals: the merge request the master opened for b at verification is withdrawn and the loop
      // opens the "accept without merging" decision in its place (a person decides; deny rejects).
      await expect
        .poll(async () => (await changes(b)).requests.map((r) => `${r.mode}:${r.status}`).sort(), {
          timeout: 20_000,
        })
        .toEqual(['leave_open:pending', 'merge:cancelled']);
      const refused = await admin.req('POST', `/jobs/${b}/merge`, { mode: 'merge' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'merge_conflicts' });
      expect(await state(b)).toBe('AWAITING_APPROVAL');
      const mainAfter = head('main');
      expect(mainAfter).toBe(merged.merged?.sha);
      // A human may still accept it unmerged (PR stays open) — that also needs the approval.
      const leave = await admin.req('POST', `/jobs/${b}/merge`, { mode: 'leave_open' });
      expect(leave.statusCode, leave.body).toBe(202);
      const leaveId = leave.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
      await stepUp();
      expect((await admin.req('POST', `/approvals/${leaveId}/approve`, {})).statusCode).toBe(200);
      expect(await state(b)).toBe('SUCCEEDED');
      expect(head('main')).toBe(mainAfter);
    });

    /** One snapshot: the job's state and its pending merge approvals (same statement, so no gap between them). */
    async function decisionSnapshot(id: string): Promise<{ state: string; pending: string[] }> {
      const { rows } = await h.db.pool.query<{ state: string; pending: string[] }>(
        `SELECT j.state, COALESCE((SELECT array_agg(r.id::text) FROM approval_requests r
                  WHERE r.job_id = j.id AND r.status = 'pending' AND r.action = 'git.merge'), '{}') AS pending
           FROM jobs j WHERE j.id = $1`,
        [id],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('job not found');
      return r;
    }

    it('p15-merge-approvals: verification opens the merge approval in the same transition (needs-you, notification, decidable without the job page)', async () => {
      const adapter = new EditingAdapter();
      await newWorker(adapter);
      const baseBefore = head('main');
      const id = await submit('edit decide.txt decided\nadd a decision file');
      // Bug (prod 2026-10-22): AWAITING_APPROVAL with no approval row until someone opened the job page.
      let snap = await decisionSnapshot(id);
      await expect
        .poll(
          async () => {
            snap = await decisionSnapshot(id);
            return snap.state;
          },
          { timeout: 30_000, interval: 20 },
        )
        .toBe('AWAITING_APPROVAL');
      // The very first snapshot in AWAITING_APPROVAL already has it: committed with the transition.
      expect(snap.pending).toHaveLength(1);
      const approvalId = snap.pending[0] ?? '';
      expect(head('main')).toBe(baseBefore);

      // Senden bekleyenler lists it; the notification producer was told (outbox).
      const list = await admin.req('GET', '/approvals?status=pending');
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json<{ items: { id: string }[] }>().items.map((x) => x.id)).toContain(approvalId);
      const approval = (await admin.req('GET', `/approvals/${approvalId}`)).json<{
        request: { action: string; approverRole: string; stepUp: boolean; summary: string; kind: string };
      }>().request;
      expect(approval).toMatchObject({
        action: 'git.merge',
        kind: 'gate',
        approverRole: 'admin',
        stepUp: true,
      });
      expect(approval.summary).toContain('Merge rac/');
      const outbox = await h.db.pool.query(
        `SELECT 1 FROM outbox WHERE topic = 'approval.requested' AND payload->>'requestId' = $1`,
        [approvalId],
      );
      expect(outbox.rowCount).toBe(1);
      const c = await changes(id);
      expect(c.requests).toEqual([
        expect.objectContaining({ approvalRequestId: approvalId, status: 'pending', mode: 'merge' }),
      ]);
      // Idempotent: the job page's "Request merge" finds the same request; the loop does not open another.
      const again = await admin.req('POST', `/jobs/${id}/merge`, { mode: 'merge' });
      expect(again.statusCode, again.body).toBe(202);
      expect(again.json()).toMatchObject({ created: false, request: { approvalRequestId: approvalId } });
      await h.app.gitflow.tick();
      expect((await decisionSnapshot(id)).pending).toEqual([approvalId]);

      // Decided straight from the approval (what Senden bekleyenler, the needs-you card and chat do).
      await stepUp();
      const ok = await admin.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ship it' });
      expect(ok.statusCode, ok.body).toBe(200);
      await expect.poll(() => state(id), { timeout: 20_000 }).toBe('SUCCEEDED');
      expect((await changes(id)).merged?.sha).toBe(head('main'));
      expect(await lastTransition(id)).toMatchObject({
        trigger: 'approval_granted',
        actor: { type: 'user' },
      });

      // Item 2: the agent was told not to commit (the platform does), and the reported summary says so.
      expect(adapter.prompts.join('\n')).toContain(
        'Do not run git commit/push; leave your changes in the working tree — the platform commits and pushes them after the run.',
      );
      const run = await h.db.pool.query<{ summary: string }>(
        `SELECT result->>'summary' AS summary FROM job_runs WHERE job_id = $1`,
        [id],
      );
      expect(run.rows[0]?.summary).toContain('The platform committed and pushed the changes as rac/');
    });

    it('p15-merge-approvals: a job stuck in AWAITING_APPROVAL without a request is backfilled once; "accept without merging" supersedes the open merge request', async () => {
      const adapter = new EditingAdapter();
      await newWorker(adapter);
      // Reproduce the stuck state: the decision cannot be opened with the transition (it still commits).
      const approvals = (h.app.gitflow as unknown as { deps: { approvals: ApprovalService } }).deps.approvals;
      const spy = vi
        .spyOn(approvals, 'evaluateWithin')
        .mockRejectedValueOnce(new Error('simulated failure while opening the decision'));
      const id = await submit('edit stuck.txt stuck\nadd a stuck file');
      try {
        await expect.poll(() => state(id), { timeout: 30_000 }).toBe('AWAITING_APPROVAL');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      // The git-flow loop backfills it (once).
      await expect.poll(async () => (await decisionSnapshot(id)).pending.length, { timeout: 20_000 }).toBe(1);
      await h.app.gitflow.tick();
      await h.app.gitflow.tick();
      const [first] = (await decisionSnapshot(id)).pending;
      expect((await decisionSnapshot(id)).pending).toEqual([first]);

      // The owner prefers to keep the pull request open: the master's merge request is withdrawn, not a 409.
      const leave = await admin.req('POST', `/jobs/${id}/merge`, { mode: 'leave_open' });
      expect(leave.statusCode, leave.body).toBe(202);
      const leaveId = leave.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
      expect(leaveId).not.toBe(first);
      expect((await decisionSnapshot(id)).pending).toEqual([leaveId]);
      const reqs = (await changes(id)).requests;
      expect(reqs.map((r) => `${r.mode}:${r.status}`).sort()).toEqual([
        'leave_open:pending',
        'merge:cancelled',
      ]);
      await h.app.gitflow.tick();
      expect((await decisionSnapshot(id)).pending).toEqual([leaveId]);
      await stepUp();
      expect((await admin.req('POST', `/approvals/${leaveId}/approve`, {})).statusCode).toBe(200);
      expect(await state(id)).toBe('SUCCEEDED');
    });

    it('p15-merge-approvals: the security policy merges an allow-all job by itself (no human request, system transition)', async () => {
      await h.setSecurityPolicy({ preset: 'serbest' });
      try {
        const adapter = new EditingAdapter();
        await newWorker(adapter);
        // Hold verification, then switch the job to "never ask" (allow-all) the way the approval-mode switch records
        // it; the owner's security policy (Serbest) lets git.merge pass for such a job.
        let resume!: () => void;
        provider.gate = new Promise<void>((r) => {
          resume = r;
        });
        const id = await submit('edit auto.txt auto\nadd a file');
        await expect.poll(() => state(id), { timeout: 30_000 }).toBe('VERIFYING');
        const owner = await h.db.pool.query<{ id: string }>(`SELECT id FROM users WHERE username = 'owner1'`);
        await h.db.pool.query(
          `INSERT INTO job_approval_mode_changes (job_id, seq, from_mode, to_mode, actor_id, job_state, delivery,
             created_at) VALUES ($1, 1, 'ask-sensitive', 'allow-all', $2, 'VERIFYING', 'not_running', $3)`,
          [id, owner.rows[0]?.id, h.clock.now()],
        );
        resume();
        await expect.poll(() => state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
        expect(await lastTransition(id)).toMatchObject({
          trigger: 'approval_auto_granted',
          actor: { type: 'system' },
        });
        const c = await changes(id);
        expect(c.merged?.sha).toBe(head('main'));
        expect(c.requests).toEqual([
          expect.objectContaining({
            status: 'merged',
            mode: 'merge',
            approvalRequestId: null,
            requestedBy: null,
          }),
        ]);
        expect((await decisionSnapshot(id)).pending).toEqual([]);
        expect(await lastTransition(id)).toMatchObject({
          trigger: 'approval_auto_granted',
          actor: { type: 'system' },
        });
        const audit = await h.db.pool.query<{ outcome: string; metadata: { approvedVia?: string } }>(
          `SELECT outcome, metadata FROM audit_events WHERE action = 'git.merge' AND target = $1`,
          [`job:${id}`],
        );
        expect(audit.rows.map((r) => [r.outcome, r.metadata.approvedVia])).toEqual([
          ['success', 'security_policy'],
        ]);
      } finally {
        await h.setSecurityPolicy({ preset: 'siki' });
      }
    });

    it('head moved after approval → the merge is refused (sha guard), base untouched', async () => {
      const adapter = new EditingAdapter();
      await newWorker(adapter);
      const id = await submit('edit guard.txt guarded\nadd a file');
      await expect.poll(() => state(id), { timeout: 30_000 }).toBe('AWAITING_APPROVAL');
      const c = await changes(id);
      const req = await admin.req('POST', `/jobs/${id}/merge`, {});
      expect(req.statusCode, req.body).toBe(202);
      const approvalId = req.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
      // Someone (or a zombie attempt) pushes onto the attempt branch after the request.
      await pushCommit(c.branch ?? '', 'guard.txt', 'sneaky\n', 'sneak in a change');
      const before = head('main');
      await stepUp();
      expect((await admin.req('POST', `/approvals/${approvalId}/approve`, {})).statusCode).toBe(200);
      // p15-merge-approvals: after the refusal the platform may already have opened its next (leave-open) decision,
      // so look for the person's request, not the last one.
      const mine = async () => (await changes(id)).requests.find((r) => r.approvalRequestId === approvalId);
      await expect.poll(async () => (await mine())?.status, { timeout: 20_000 }).toBe('refused');
      expect((await mine())?.resultReason).toContain('head_moved');
      expect(head('main')).toBe(before);
      expect(await state(id)).toBe('AWAITING_APPROVAL');
      const audit = await h.db.pool.query<{ outcome: string }>(
        `SELECT outcome FROM audit_events WHERE action = 'git.merge' AND target = $1`,
        [`job:${id}`],
      );
      expect(audit.rows.map((r) => r.outcome)).toEqual(['denied']);
    });

    it('destructive branch deletion is refused without an approval; with a project rule it needs one', async () => {
      const adapter = new EditingAdapter();
      await newWorker(adapter);
      const id = await submit('edit drop.txt drop me\ntry something');
      await expect.poll(() => state(id), { timeout: 30_000 }).toBe('AWAITING_APPROVAL');
      const c = await changes(id);
      const branchHead = head(c.branch ?? '');
      // Platform default for git.force_push is deny: no request, nothing deleted.
      const denied = await admin.req('POST', `/jobs/${id}/discard`, { reason: 'not needed' });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'approval_required' });
      expect(head(c.branch ?? '')).toBe(branchHead);
      // The project allows it with an approval (floor: admin + step-up).
      await stepUp();
      const policy = await admin.req('PUT', `/projects/${PROJECT}/policy`, {
        expectedVersion: 0,
        rules: { 'git.force_push': { outcome: 'require_approval' } },
      });
      expect(policy.statusCode, policy.body).toBe(200);
      const req = await admin.req('POST', `/jobs/${id}/discard`, { reason: 'not needed' });
      expect(req.statusCode, req.body).toBe(202);
      expect(head(c.branch ?? '')).toBe(branchHead);
      const approvalId = req.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
      await stepUp();
      expect((await admin.req('POST', `/approvals/${approvalId}/approve`, {})).statusCode).toBe(200);
      await expect.poll(() => state(id), { timeout: 20_000 }).toBe('FAILED');
      expect(() => head(c.branch ?? '')).toThrow();
      expect((await changes(id)).requests.at(-1)?.status).toBe('discarded');
    });

    it('a stale-epoch commit on the attempt branch (old attempt pushes after a re-lease) fails verification', async () => {
      const adapter = new EditingAdapter();
      let release!: () => void;
      adapter.hold = new Promise<void>((r) => {
        release = r;
      });
      const { id: workerId, w } = await newWorker(adapter);
      const id = await submit('edit stale.txt stale\nslow work');
      await expect.poll(() => state(id), { timeout: 30_000 }).toBe('RUNNING');
      // Partition → lease expiry → the worker comes back with the attempt → resumed under epoch 2.
      await h.app.workerHub.disconnect(workerId, 4503, 'test partition');
      h.clock.advance(31_000);
      await h.app.orchestrator.tick();
      await expect
        .poll(
          async () =>
            (await admin.req('GET', `/jobs/${id}`)).json<{ job: { leaseEpoch: number } }>().job.leaseEpoch,
          {
            timeout: 30_000,
          },
        )
        .toBe(2);
      try {
        await expect.poll(() => stateTrail(id), { timeout: 20_000 }).toMatch(/^RUNNING /);
      } catch (err) {
        // Diagnostics for the resume-vs-retry path: the reconciler's reasons and what the worker logged about leases.
        const reasons = (await admin.req('GET', `/jobs/${id}`))
          .json<{ transitions: { trigger: string; reason: string | null }[] }>()
          .transitions.slice(-6)
          .map((t) => `${t.trigger}: ${t.reason ?? ''}`);
        const leaseLines = w.lines
          .filter((l) => /lease|fenc|stale|renew|session/i.test(String(l.msg)))
          .slice(-20)
          .map((l) => JSON.stringify(l).slice(0, 300));
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\ntransitions:\n${reasons.join('\n')}\nworker:\n${leaseLines.join('\n')}`,
          { cause: err },
        );
      }
      // The worker adopted the new epoch (RENEW_LEASE) before the run ends.
      await expect.poll(() => w.runner.runningJobs()[0]?.epoch, { timeout: 20_000 }).toBe(2);
      // Hold verification, let the run finish and push (trailer …/2).
      let resume!: () => void;
      provider.gate = new Promise<void>((r) => {
        resume = r;
      });
      release();
      await expect.poll(() => state(id), { timeout: 30_000 }).toBe('VERIFYING');
      const attempt = (await admin.req('GET', `/jobs/${id}`)).json<{ job: { currentAttemptId: string } }>()
        .job.currentAttemptId;
      const branch = `rac/${id}/${attempt}`;
      expect(git(bare, 'log', '-1', '--format=%B', `refs/heads/${branch}`)).toContain(
        `Remyral-Attempt: ${attempt}/2`,
      );
      // The superseded epoch-1 process pushes after the re-lease.
      await pushCommit(branch, 'stale.txt', 'old epoch\n', `zombie\n\nRemyral-Attempt: ${attempt}/1`);
      resume();
      await expect.poll(() => state(id), { timeout: 20_000 }).toBe('FAILED');
      const t = await lastTransition(id);
      expect(t.trigger).toBe('verification_failed');
      expect(t.reason).toContain(`${attempt}/1`);
      expect((await changes(id)).verification.status).toBe('failed');
    });
  },
);
