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
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
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
const HINT_DB = 13;

/** Fake runtime that writes files: `edit <path> <line>` prompt lines are written into the attempt worktree. */
class EditingAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;
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
  collectResult(ref: SessionRef): Promise<SessionResult> {
    return this.inner.collectResult(ref);
  }
  cleanup(ref: SessionRef) {
    return this.inner.cleanup(ref);
  }
  getCost(ref: SessionRef) {
    return this.inner.getCost(ref);
  }
}

/**
 * p22-output-delivery (docs/design/p22-output-delivery.md) end to end: real master, real worker daemon, real pushes to
 * a local bare repository, the plain-git provider. (1) a job with `delivery: "outputs"` lands its files in Outputs and
 * succeeds without a merge decision; (2) several merge decisions of one project approved together — the step-up is
 * asked once, every item is decided and audited on its own, the merges run one after another and a later one that
 * now conflicts is refused with its reason and comes back as an "accept without merging" decision.
 */
describeIntegration('output delivery and bulk merge approval (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  let bare: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();
  const head = (branch: string) => git(bare, 'rev-parse', `refs/heads/${branch}`);

  beforeAll(async () => {
    fileUrl = await createBareRepo(dirs);
    bare = fileURLToPath(fileUrl);
    const cacheDir = await mkdtemp(join(tmpdir(), 'rw-p22-cache-'));
    dirs.push(cacheDir);
    const provider = new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true });
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `p22${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      gitflow: { providers: () => provider, timing: { refreshIntervalMs: 0, mergePollMs: 0 } },
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
  // pairRealWorker uses expect.poll, which only runs inside a test: the worker is paired by the first test.
  let worker: Promise<void> | null = null;
  function ready(): Promise<void> {
    worker ??= (async () => {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, admin, secret, dir);
      workers.push(await startJobWorker(url, dir, { fileUrl, adapter: new EditingAdapter() }));
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    })();
    return worker;
  }
  afterAll(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
    await h.stop();
    await removeDirs(dirs);
  });

  async function submit(prompt: string, over: Record<string, unknown> = {}): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec({ prompt, ...over }) });
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
      transitions: { trigger: string; reason: string | null }[];
    }>();
    return `${d.job.state} [${d.transitions
      .slice(-4)
      .map((t) => `${t.trigger}: ${t.reason ?? ''}`)
      .join(' | ')}]`;
  }
  async function lastTransition(id: string): Promise<{ trigger: string; reason: string | null }> {
    const d = (await admin.req('GET', `/jobs/${id}`)).json<{
      transitions: { trigger: string; reason: string | null }[];
    }>();
    const t = d.transitions.at(-1);
    if (t === undefined) throw new Error('no transitions');
    return t;
  }
  async function pendingOf(jobId: string): Promise<{ id: string; summary: string }[]> {
    const list = (await admin.req('GET', '/approvals?status=pending')).json<{
      items: { id: string; jobId: string; summary: string }[];
    }>().items;
    return list.filter((a) => a.jobId === jobId);
  }
  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  it('delivery "outputs": the files land in Outputs, the job succeeds without a merge decision, main is untouched', async () => {
    await ready();
    const before = head('main');
    const id = await submit('edit leads.csv name,email\nedit notes.md # Leads\nproduce the lead package', {
      delivery: 'outputs',
    });
    await expect.poll(() => state(id), { timeout: 60_000 }).toBe('SUCCEEDED');
    const t = await lastTransition(id);
    expect(t.trigger).toBe('verification_passed_no_approval');
    expect(t.reason).toContain('delivered as outputs: 2 file(s) in Outputs');
    expect(t.reason).toContain('nothing merged');
    expect(await pendingOf(id)).toEqual([]);
    expect(head('main')).toBe(before);
    // No pull request or merge request was opened.
    const mr = await h.db.pool.query('SELECT 1 FROM git_merge_requests WHERE job_id = $1', [id]);
    expect(mr.rowCount).toBe(0);

    const list = await admin.req('GET', `/jobs/${id}/artifacts`);
    expect(list.statusCode, list.body).toBe(200);
    const artifacts = list.json<{ artifacts: { id: string; name: string; kind: string }[] }>().artifacts;
    expect(artifacts.map((a) => a.name).sort()).toEqual(['leads.csv', 'notes.md']);
    const csv = artifacts.find((a) => a.name === 'leads.csv');
    const body = await admin.req('GET', `/jobs/${id}/artifacts/${csv?.id ?? ''}`);
    expect(body.statusCode).toBe(200);
    expect(body.body).toBe('name,email\n');

    // Outputs lists them as files of the job.
    const outputs = await admin.req('GET', `/outputs?project=${PROJECT}&type=file&job=${id}`);
    expect(outputs.statusCode, outputs.body).toBe(200);
    // Every repository job also lists its attempt.diff (kind run); the delivered files are the two outputs.
    const items = outputs.json<{ items: { name: string }[] }>().items;
    expect(
      items
        .map((i) => i.name)
        .filter((n) => n !== 'attempt.diff')
        .sort(),
    ).toEqual(['leads.csv', 'notes.md']);

    const audit = await h.db.pool.query<{ metadata: { stored: number } }>(
      `SELECT metadata FROM audit_events WHERE action = 'job.outputs.deliver' AND target = $1`,
      [`job:${id}`],
    );
    expect(audit.rows[0]?.metadata.stored).toBe(2);
  });

  it('an unknown delivery is refused with the job', async () => {
    await ready();
    const res = await admin.req('POST', '/jobs', {
      project: PROJECT,
      spec: jobSpec({ delivery: 'nonsense' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('bulk merge approval: one step-up, each item decided and audited, merges one after another, a later conflict waits with its reason', async () => {
    await ready();
    const a = await submit('edit a.txt alpha\nadd a');
    const b = await submit('edit b.txt beta\nadd b');
    const c1 = await submit('edit shared.txt one\nwrite shared');
    const c2 = await submit('edit shared.txt two\nwrite shared differently');
    for (const id of [a, b, c1, c2]) {
      await expect.poll(() => state(id), { timeout: 60_000 }).toBe('AWAITING_APPROVAL');
      await expect.poll(async () => (await pendingOf(id)).length, { timeout: 10_000 }).toBe(1);
    }
    const ids = await Promise.all([a, b, c1, c2].map(async (j) => (await pendingOf(j))[0]?.id ?? ''));

    // The batch list shows the live merge check of each.
    const batch = await admin.req('GET', `/approvals/merge-batch?project=${PROJECT}`);
    expect(batch.statusCode, batch.body).toBe(200);
    const items = batch.json<{ items: { id: string; mergeState: string | null; stepUp: boolean }[] }>().items;
    expect(items.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(items.every((i) => i.mergeState === 'clean' && i.stepUp)).toBe(true);

    // A stale code: nothing is decided at all.
    h.clock.advance(11 * 60_000);
    const stale = await admin.req('POST', '/approvals/merge-batch', { project: PROJECT, ids });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: 'step_up_required' });
    for (const id of [a, b, c1, c2]) expect(await pendingOf(id)).toHaveLength(1);

    // One code, then the whole batch (plus an unknown id, reported and not decided).
    await stepUp();
    const foreign = randomUUID();
    const res = await admin.req('POST', '/approvals/merge-batch', {
      project: PROJECT,
      ids: [...ids, foreign],
    });
    expect(res.statusCode, res.body).toBe(200);
    const results = res.json<{ results: { id: string; outcome: string; code?: string }[] }>().results;
    expect(results.filter((r) => r.outcome === 'approved').map((r) => r.id)).toEqual(ids);
    expect(results.find((r) => r.id === foreign)).toMatchObject({
      outcome: 'refused',
      code: 'approval_not_found',
    });

    // Each item audited like a single approval, plus the summary row.
    const decided = await h.db.pool.query(
      `SELECT target FROM audit_events WHERE action = 'approval.decide' AND outcome = 'success' AND target = ANY($1)`,
      [ids.map((i) => `approval:${i}`)],
    );
    expect(decided.rowCount).toBe(4);
    const bulk = await h.db.pool.query<{ metadata: { approved: string[] } }>(
      `SELECT metadata FROM audit_events WHERE action = 'approval.decide_bulk' AND outcome = 'success'`,
    );
    expect(bulk.rows.at(-1)?.metadata.approved).toEqual(ids);

    // a, b and the first shared.txt merge; the second shared.txt now conflicts and is not merged.
    for (const id of [a, b, c1])
      await expect.poll(() => stateTrail(id), { timeout: 30_000 }).toMatch(/^SUCCEEDED /);
    expect(git(bare, 'show', 'main:a.txt')).toBe('alpha');
    expect(git(bare, 'show', 'main:b.txt')).toBe('beta');
    expect(git(bare, 'show', 'main:shared.txt')).toBe('one');
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ status: string; result_reason: string | null }>(
              `SELECT status, result_reason FROM git_merge_requests WHERE job_id = $1 ORDER BY created_at LIMIT 1`,
              [c2],
            )
          ).rows[0]?.status,
        { timeout: 30_000 },
      )
      .toBe('refused');
    expect(await state(c2)).toBe('AWAITING_APPROVAL');
    const reason = (
      await h.db.pool.query<{ result_reason: string }>(
        `SELECT result_reason FROM git_merge_requests WHERE job_id = $1 ORDER BY created_at LIMIT 1`,
        [c2],
      )
    ).rows[0]?.result_reason;
    expect(reason).toContain('conflicts: shared.txt');
    // The decision loop opens "accept without merging" for it, with the reason in its summary.
    await h.app.gitflow.tick();
    await expect.poll(async () => (await pendingOf(c2)).length, { timeout: 10_000 }).toBe(1);
    expect((await pendingOf(c2))[0]?.summary).toMatch(
      /earlier merge of this result was refused|cannot merge as is/,
    );
  });
});
