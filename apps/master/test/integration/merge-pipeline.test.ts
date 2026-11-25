import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentAdapter,
  basicScript,
  FakeRuntimeAdapter,
  type SessionRef,
  type SessionResult,
  type SpawnContext,
} from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import type { BranchUpdate, GitProvider, PullRequestRef } from '../../src/gitflow/types.js';
import type { IntegrationView } from '../../src/integration/service.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  createBareRepo,
  JOB_CAPS,
  type JobWorker,
  jobSpec,
  PROJECT,
  REPO_URL,
  startJobWorker,
} from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';
import type { JobRecord } from '../../src/jobs/store.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;

/**
 * Fake runtime for the merge pipeline: `edit <path> <text>` lines are written into the worktree; a CONFLICT RESOLVER
 * prompt writes `resolutions`, a FIXER prompt writes `fixes`, a VERIFIER prompt writes the report with the next status
 * of `verify` into `remyral-verification/report.json` (returned through the site-bundle mechanism, like a real verifier).
 */
class ScriptedAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;
  readonly inner = new FakeRuntimeAdapter({ runtime: 'codex', script: basicScript });
  readonly prompts: string[] = [];
  verify: ('pass' | 'fail')[] = [];
  resolutions: Record<string, string> = {};
  fixes: Record<string, string> = {};
  /** Runs whose prompt matches wait for `release()` before they finish (a coordinator waiting for its sub-jobs). */
  hold: RegExp | null = null;
  readonly #held = new WeakSet<SessionRef>();
  #release: () => void = () => undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  probe() {
    return this.inner.probe();
  }
  capabilities() {
    return this.inner.capabilities();
  }
  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    const p = ctx.job.prompt;
    this.prompts.push(p);
    const put = async (path: string, text: string) => {
      await mkdir(dirname(join(ctx.workspaceRoot, path)), { recursive: true });
      await writeFile(join(ctx.workspaceRoot, path), text);
    };
    if (p.includes('You are a VERIFIER')) {
      const status = this.verify.shift() ?? 'pass';
      await put(
        'remyral-verification/report.json',
        JSON.stringify({
          version: 1,
          status,
          summary: status === 'pass' ? 'build and tests pass' : 'tests fail',
          checks: [{ id: 'test', status, detail: status === 'pass' ? 'all green' : '1 failed' }],
          findings:
            status === 'pass' ? [] : [{ severity: 'fail', kind: 'test', message: 'expected 1 got 2' }],
          screenshots: [],
        }),
      );
    } else if (p.includes('CONFLICT RESOLVER')) {
      for (const [path, text] of Object.entries(this.resolutions)) await put(path, text);
    } else if (p.includes('You are a FIXER')) {
      for (const [path, text] of Object.entries(this.fixes)) await put(path, text);
    } else {
      for (const line of p.split('\n')) {
        const m = /^edit (\S+) (.*)$/.exec(line);
        if (m?.[1] !== undefined) await put(m[1], `${m[2] ?? ''}\n`);
      }
    }
    const ref = await this.inner.spawn(ctx);
    if (this.hold?.test(p) === true) this.#held.add(ref);
    return ref;
  }
  sendPrompt(ref: SessionRef, prompt: { text: string }) {
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
    if (this.#held.has(ref)) await this.#gate;
    return this.inner.collectResult(ref);
  }
  cleanup(ref: SessionRef) {
    return this.inner.cleanup(ref);
  }
  getCost(ref: SessionRef) {
    return this.inner.getCost(ref);
  }
}

/** The plain-git provider plus a fake GitHub pull request API (records every PR the platform opens). */
class FakeGitHubProvider implements GitProvider {
  readonly kind = 'git' as const;
  readonly opened: { headBranch: string; targetBranch: string; title: string; body: string }[] = [];
  readonly updated: { pr: PullRequestRef; body: string }[] = [];
  constructor(private readonly p: LocalGitProvider) {}
  branchHead(b: string) {
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
  ensurePullRequest(i: Parameters<GitProvider['ensurePullRequest']>[0]): Promise<PullRequestRef | null> {
    const existing = this.opened.findIndex(
      (o) => o.headBranch === i.headBranch && o.targetBranch === i.targetBranch,
    );
    if (existing >= 0)
      return Promise.resolve({
        number: 100 + existing,
        url: `https://github.example.test/pr/${String(100 + existing)}`,
      });
    this.opened.push({ ...i });
    const n = 100 + this.opened.length - 1;
    return Promise.resolve({ number: n, url: `https://github.example.test/pr/${String(n)}` });
  }
  updatePullRequest(pr: PullRequestRef, input: { title: string; body: string }): Promise<void> {
    this.updated.push({ pr, body: input.body });
    return Promise.resolve();
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
  updateBranch(b: string, sha: string, expected: string | null): Promise<BranchUpdate> {
    return this.p.updateBranch(b, sha, expected);
  }
}

/**
 * p11-merge-pipeline end to end: real master (Postgres, BullMQ), a real worker daemon over the WebSocket transport, real
 * worktrees and pushes to a local bare repository, the plain-git provider with a fake GitHub PR API, and a fake runtime.
 * A coordinator with three repository sub-jobs (two conflicting) → integration rounds → a conflict-resolution job →
 * verification → ONE pull request → the protected merge lands everything. A failing verification → a bounded fix job →
 * a stop for a human. A workflow's integrator step integrated by the master.
 */
describeIntegration('merge pipeline: master-managed integration (integration)', { timeout: 240_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  let bare: string;
  let provider: FakeGitHubProvider;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];
  const T = 60_000;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();
  const head = (branch: string) => git(bare, 'rev-parse', `refs/heads/${branch}`);
  const contains = (sha: string, ref: string) => {
    try {
      git(bare, 'merge-base', '--is-ancestor', sha, ref);
      return true;
    } catch {
      return false;
    }
  };
  const show = (ref: string, path: string) => git(bare, 'show', `${ref}:${path}`);

  beforeAll(async () => {
    fileUrl = await createBareRepo(dirs);
    bare = fileURLToPath(fileUrl);
    const cacheDir = await mkdtemp(join(tmpdir(), 'rm-mp-cache-'));
    dirs.push(cacheDir);
    provider = new FakeGitHubProvider(new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true }));
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `m${randomUUID().slice(0, 8)}`,
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
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function newWorker(adapter: ScriptedAdapter): Promise<void> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dir);
    const w = await startJobWorker(url, dir, {
      fileUrl,
      adapter,
      // p11-fixes-a: a 2-slot machine (default reserve 0 there; the family may use a reserved slot) runs a
      // coordinator waiting for its own sub-jobs and integration jobs without deadlock.
      capabilities: { ...JOB_CAPS, maxParallelJobs: 2 },
      features: ['integration-v1', 'site-bundle-v1'],
    });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
  }

  async function submit(prompt: string): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec({ prompt }) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  /** Test shortcut: records `child` as an agent-requested sub-job of `parent` (creation is covered by p8 suites). */
  async function link(parent: string, child: string, title: string, paths: string[] = []): Promise<void> {
    await h.db.pool.query(
      `INSERT INTO job_subtasks (child_job_id, parent_job_id, root_job_id, depth, request_id, parent_attempt_id,
                                 worker_id, title, wait, requires, placement, created_at, paths)
       VALUES ($1, $2, $2, 1, $3, $4, 'w', $5, true, '{}', '{}', $6, $7)`,
      [child, parent, randomUUID(), randomUUID(), title, h.clock.now(), paths],
    );
  }

  async function state(id: string): Promise<string> {
    return (await admin.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
  }

  async function integrationOf(jobId: string): Promise<IntegrationView | null> {
    const res = await admin.req('GET', `/jobs/${jobId}/integration`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ integration: IntegrationView | null }>().integration;
  }

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  /** The existing protected merge of the integration's head job (approval + step-up). */
  async function protectedMerge(jobId: string): Promise<void> {
    const req = await admin.req('POST', `/jobs/${jobId}/merge`, { mode: 'merge' });
    expect(req.statusCode, req.body).toBe(202);
    const approvalId = req.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
    await stepUp();
    const ok = await admin.req('POST', `/approvals/${approvalId}/approve`, {
      reason: 'reviewed the integration',
    });
    expect(ok.statusCode, ok.body).toBe(200);
  }

  it('coordinator + 3 sub-jobs: clean merges, a conflict resolved by a resolution job, tests, ONE PR, protected merge', async () => {
    const adapter = new ScriptedAdapter();
    adapter.resolutions = { 'README.md': 'from B and C\n' };
    adapter.verify = ['pass'];
    const baseBefore = head('main');
    // Jobs first (no worker yet), so the sub-job links exist before anything is verified.
    const root = await submit('edit core.txt core\ncoordinate the feature');
    const a = await submit('edit a.txt A\ntask A: the API');
    const b = await submit('edit README.md from B\ntask B: the docs');
    const c = await submit('edit README.md from C\ntask C: the readme intro');
    await link(root, a, 'Task A: the API', ['src/api/', 'a.txt']);
    h.clock.advance(1_000);
    await link(root, b, 'Task B: the docs', ['README.md']);
    h.clock.advance(1_000);
    await link(root, c, 'Task C: the readme intro', ['README.md']);
    await newWorker(adapter);

    await expect.poll(async () => (await integrationOf(root))?.state, { timeout: 2 * T }).toBe('ready');
    const v = (await integrationOf(root)) as IntegrationView;
    // The order: the clean sibling first, the overlapping ones after it, the coordinator last.
    expect(v.branches.map((x) => [x.jobId, x.state])).toEqual([
      [a, 'merged'],
      [b, 'merged'],
      [c, 'resolved'],
      [root, 'merged'],
    ]);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]?.jobIds).toEqual([b, c]);
    expect(v.branches[2]?.conflictFiles).toEqual(['README.md']);
    expect(v.jobs.map((j) => j.kind)).toEqual(['integrate', 'resolve', 'integrate', 'verify']);
    expect(v.resolutionRounds).toBe(1);
    expect(v.verification).toMatchObject({ state: 'passed', summary: 'build and tests pass' });
    // p11-fixes-a: the verifier only reports — no git flow, no pushed report commit, no approval gate.
    const verifyJob = v.jobs.find((j) => j.kind === 'verify')?.jobId ?? '';
    const vj = await h.db.pool.query<{ state: string; git: boolean; marker: string | null }>(
      `SELECT j.state::text AS state, EXISTS (SELECT 1 FROM job_git g WHERE g.job_id = j.id) AS git,
              (SELECT purpose FROM report_only_jobs r WHERE r.job_id = j.id) AS marker
         FROM jobs j WHERE j.id = $1`,
      [verifyJob],
    );
    expect(vj.rows[0]).toEqual({ state: 'SUCCEEDED', git: false, marker: 'integration-verify' });
    expect(v.branch).toBe(`int/${root.replace(/-/g, '').slice(0, 8)}`);

    // The integration branch is real: every member's verified commit is in it, the conflict resolved.
    expect(head(v.branch)).toBe(v.headSha);
    for (const x of v.branches) expect(contains(x.sha, v.branch)).toBe(true);
    expect(show(v.branch, 'README.md')).toBe('from B and C');
    expect(show(v.branch, 'a.txt')).toBe('A');
    expect(show(v.branch, 'core.txt')).toBe('core');
    expect(head('main')).toBe(baseBefore);

    // The resolution job got both sides and the markers as data; the integration step ran no agent.
    const resolution = adapter.prompts.find((p) => p.includes('CONFLICT RESOLVER')) ?? '';
    expect(resolution).toContain('README.md');
    expect(resolution).toContain('from C');
    expect(resolution).toContain('task C: the readme intro');
    expect(adapter.prompts.some((p) => p.startsWith('Platform integration step'))).toBe(false);

    // ONE pull request, for the integration branch only — none for the sub-jobs or the coordinator.
    expect(provider.opened.map((o) => [o.headBranch, o.targetBranch])).toEqual([[v.branch, 'main']]);
    expect(provider.opened[0]?.body).toContain('Task A: the API');
    expect(provider.opened[0]?.body).toContain('conflicts resolved by');
    expect(provider.opened[0]?.body).toContain('**passed**');
    expect(v.pullRequest?.number).toBe(100);
    expect(v.mergeJobId).not.toBeNull();

    // Merging stays a human decision: the existing protected merge of the head job (approval + step-up).
    await protectedMerge(v.mergeJobId ?? '');
    await expect.poll(async () => (await integrationOf(root))?.state, { timeout: T }).toBe('merged');
    expect(contains(v.headSha ?? '', 'main')).toBe(true);
    for (const id of [a, b, c, root]) await expect.poll(() => state(id), { timeout: T }).toBe('SUCCEEDED');
    const audit = await h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'integration.%' ORDER BY id",
    );
    expect(new Set(audit.rows.map((r) => r.action))).toEqual(
      new Set([
        'integration.start',
        'integration.job.create',
        'integration.branch.update',
        'integration.publish',
        'integration.finish',
      ]),
    );
  });

  it('a failing verification opens one bounded fix job, then stops for a human; cancel and retry rules', async () => {
    await stepUp();
    const settings = await admin.req('PUT', `/projects/${PROJECT}/integration-settings`, {
      mode: 'master',
      order: 'completion',
      maxResolutions: 2,
      maxFixes: 1,
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const read = await admin.req('GET', `/projects/${PROJECT}/integration-settings`);
    expect(read.json()).toMatchObject({ settings: { order: 'completion', maxFixes: 1 }, canEdit: true });

    const adapter = new ScriptedAdapter();
    adapter.verify = ['fail', 'fail'];
    adapter.fixes = { 'fix.txt': 'tried\n' };
    adapter.hold = /coordinate/;
    const root = await submit('coordinate the second feature');
    const child = await submit('edit b.txt B\ntask: b');
    await link(root, child, 'Task: b', ['b.txt']);
    await newWorker(adapter);
    // The coordinator waits for its sub-job (as a real one does with wait_subtask), then finishes without changes.
    await expect.poll(() => state(child), { timeout: T }).toBe('AWAITING_APPROVAL');
    adapter.release();

    await expect.poll(async () => (await integrationOf(root))?.state, { timeout: 2 * T }).toBe('needs_human');
    const v = (await integrationOf(root)) as IntegrationView;
    expect(v.orderMode).toBe('completion');
    expect(v.jobs.map((j) => j.kind)).toEqual(['integrate', 'verify', 'fix', 'verify']);
    expect(v.fixRounds).toBe(1);
    expect(v.reason).toContain('verification failed');
    expect(v.verification?.state).toBe('failed');
    // The fix's verified result was taken (fast-forward), no PR was opened for this integration.
    expect(show(v.branch, 'fix.txt')).toBe('tried');
    expect(provider.opened.some((o) => o.headBranch === v.branch)).toBe(false);
    const fixPrompt = adapter.prompts.find((p) => p.includes('You are a FIXER')) ?? '';
    expect(fixPrompt).toContain('check test: fail — 1 failed');

    // A viewer-level read works; cancel ends it; a cancelled integration cannot be retried.
    const cancel = await admin.req('POST', `/integrations/${v.id}/cancel`, { reason: 'will fix by hand' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json<{ integration: IntegrationView }>().integration.state).toBe('cancelled');
    const again = await admin.req('POST', `/integrations/${v.id}/cancel`, {});
    expect(again.statusCode).toBe(409);
    const retry = await admin.req('POST', `/integrations/${v.id}/retry`, {});
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: 'not_retryable' });
  });

  it('a sub-job tree that can no longer be integrated gets its own pull request (owner report 2026-10-23)', async () => {
    const own = (id: string) => h.app.integration.ownPullRequest({ id, project: PROJECT } as JobRecord);
    const setState = (id: string, s: string) =>
      h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [id, s]);
    // A coordinator with one live sub-job: both wait for the master's integration (no own PR).
    const root = await submit('coordinate a tree that loses its only sub-job');
    const child = await submit('task: the only sub-job');
    await link(root, child, 'The only sub-job');
    expect(await own(root)).toBe(false);
    expect(await own(child)).toBe(false);
    // Its only sub-job is cancelled: #discover never starts an integration, so the coordinator merges on its own.
    await setState(child, 'CANCELLED');
    expect(await own(root)).toBe(true);
    // A sub-job whose coordinator failed: no integration will come either.
    const root2 = await submit('coordinate a tree whose coordinator fails');
    const child2 = await submit('task: a verified sub-job');
    await link(root2, child2, 'A verified sub-job');
    expect(await own(child2)).toBe(false);
    await setState(root2, 'FAILED');
    expect(await own(child2)).toBe(true);
  });

  it('a workflow integrator step is integrated by the master (no integrator agent), then merged', async () => {
    await stepUp();
    await admin.req('PUT', `/projects/${PROJECT}/integration-settings`, {
      mode: 'master',
      order: 'dependency',
      maxResolutions: 2,
      maxFixes: 1,
    });
    const adapter = new ScriptedAdapter();
    adapter.verify = ['pass'];
    await newWorker(adapter);
    const def = await admin.req('POST', '/workflows', {
      project: PROJECT,
      definition: {
        name: 'merge-pipeline',
        defaults: {
          runtime: 'codex',
          sandboxProfile: 'host-restricted',
          sourceTrust: 'trusted',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 600 },
          repository: { url: REPO_URL, baseRef: 'main' },
        },
        nodes: [
          { id: 'one', role: 'executor', prompt: 'edit w1.txt one' },
          { id: 'two', role: 'executor', prompt: 'edit w2.txt two' },
          { id: 'merge', role: 'integrator', prompt: 'Integrate the branches.' },
        ],
        edges: [
          { from: 'one', to: 'merge' },
          { from: 'two', to: 'merge' },
        ],
      },
    });
    expect(def.statusCode, def.body).toBe(201);
    const run = await admin.req('POST', `/workflows/${def.json<{ id: string }>().id}/runs`, { inputs: {} });
    expect(run.statusCode, run.body).toBe(201);
    const runId = run.json<{ runId: string }>().runId;
    const integration = async () =>
      (await admin.req('GET', `/workflows/runs/${runId}/integration`)).json<{
        integration: IntegrationView | null;
      }>().integration;
    await expect.poll(async () => (await integration())?.state, { timeout: 2 * T }).toBe('ready');
    const v = (await integration()) as IntegrationView;
    expect(v.source).toBe('workflow');
    expect(v.branches).toHaveLength(2);
    expect(show(v.branch, 'w1.txt')).toBe('one');
    expect(show(v.branch, 'w2.txt')).toBe('two');
    const runView = (await admin.req('GET', `/workflows/runs/${runId}`)).json<{
      run: { state: string; engine: number };
      nodes: { id: string; state: string; jobId: string | null }[];
    }>();
    const node = runView.nodes.find((n) => n.id === 'merge');
    expect(node?.state).toBe('awaiting_merge');
    // The integrator's own agent job never ran (engine 1 cancels its up-front job; engine 2 never creates one).
    if (node?.jobId === null) expect(runView.run).toMatchObject({ engine: 2 });
    else expect(await state(node?.jobId ?? '')).toBe('CANCELLED');
    expect(adapter.prompts.some((p) => p.includes('Integrate the branches.'))).toBe(false);
    expect(provider.opened.filter((o) => o.headBranch === v.branch)).toHaveLength(1);

    await protectedMerge(v.mergeJobId ?? '');
    await expect
      .poll(
        async () =>
          (await admin.req('GET', `/workflows/runs/${runId}`)).json<{ run: { state: string } }>().run.state,
        {
          timeout: T,
        },
      )
      .toBe('succeeded');
    expect(contains(v.headSha ?? '', 'main')).toBe(true);
  });
});
