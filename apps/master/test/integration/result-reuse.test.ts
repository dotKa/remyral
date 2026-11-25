import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import type { PreviewDeps } from '../../src/composer/preview.js';
import type { GitProvider } from '../../src/gitflow/types.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { promptDigest, ResultReuseService } from '../../src/reuse/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-result-reuse (docs/design/p6-result-reuse.md): digests recorded at submission; the reuse check (composer) with
 * its matching rules, trust and authorization; the chat draft's statement; the automation policy (skipped run with a
 * link, never for "Run now"); the workflow-step policy (own job cancelled, the earlier job's result used). Real
 * Postgres; the git provider is a fake whose branch head the test moves.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'reuse-alpha';
const OTHER = 'reuse-beta';
const REPO = 'https://git.example.test/acme/reuse.git';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TTL = 3_600_000;
const worker = (id: string): JobActor => ({ type: 'worker', id });

function spec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: 'codex',
    prompt: 'Update the README with the new install steps',
    repository: { url: REPO, baseRef: 'main', workBranch: `agent/${randomUUID().slice(0, 8)}` },
    sandboxProfile: 'container',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
    ...over,
  };
}

interface Check {
  match: { jobId: string; age: string; runtime: string; baseCommit: string | null } | null;
  reason: string | null;
}

describeIntegration('result reuse (integration, p6-result-reuse)', { timeout: 120_000 }, () => {
  const h = new Harness();
  let head = SHA_A;
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let viewer: Client;
  let operator: Client;
  let store: JobStore;
  let reuse: ResultReuseService;

  /** A fresh login (tests move the clock by hours) and a step-up. */
  async function stepUp(): Promise<void> {
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }

  /** Creates, (base-captures) and finishes a job SUCCEEDED; returns its id. */
  async function succeeded(project: string, s: Record<string, unknown>, inputs?: unknown): Promise<string> {
    const { job } = await store.create({
      project,
      spec: s,
      actor: { type: 'user', id: ownerId },
      submit: true,
      ...(inputs === undefined ? {} : { inputs: inputs as never }),
    });
    await finish(job.id);
    return job.id;
  }

  async function finish(jobId: string): Promise<void> {
    const job = await store.get(jobId);
    if (job === null) throw new Error('no job');
    await h.app.gitflow.prepareDispatch(job);
    const { lease } = await store.acquireLease(jobId, 'w-reuse', TTL);
    await store.transition(jobId, 'lease_acked', { actor: worker('w-reuse'), epoch: lease.epoch });
    await store.transition(jobId, 'runtime_started', { actor: worker('w-reuse'), epoch: lease.epoch });
    await store.transition(jobId, 'run_finished', { actor: worker('w-reuse'), epoch: lease.epoch });
    await store.transition(jobId, 'verification_passed_no_approval', { actor: { type: 'system', id: 't' } });
    expect((await store.get(jobId))?.state).toBe('SUCCEEDED');
  }

  async function check(client: Client, body: Record<string, unknown>) {
    return client.req('POST', '/jobs/reuse-check', { project: PROJECT, ...body });
  }

  beforeAll(async () => {
    const fake = {
      kind: 'git',
      branchHead: (branch: string) => Promise.resolve(branch === 'main' ? head : null),
    } as unknown as GitProvider;
    await h.start({ gitflow: { providers: () => fake } });
    ownerId = await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
    const opId = await h.createUser('op1', PW, 'operator');
    operator = await fullLogin(h, 'op1', PW, (await enroll(h, 'op1', PW)).secret);
    await h.grant(viewerId, [PROJECT], 'viewer');
    await h.grant(opId, [OTHER], 'operator');
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())`,
      [PROJECT, REPO, ownerId],
    );
    store = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    reuse = new ResultReuseService({
      db: h.db.pool,
      clock: h.clock.now,
      baseCommit: (p, r) => h.app.gitflow.resolveBaseCommit(p, r),
    });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('records the normalised prompt digest (and an inputs digest for workspace jobs) at submission', async () => {
    const res = await owner.req('POST', '/jobs', { project: PROJECT, spec: spec() });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string } }>().job.id;
    const ws = await owner.req('POST', '/jobs', {
      project: 'genel',
      spec: { ...spec(), repository: undefined },
      inputs: [{ name: 'notes.md', contentBase64: Buffer.from('# hi\n').toString('base64') }],
    });
    expect(ws.statusCode, ws.body).toBe(201);
    const wsId = ws.json<{ job: { id: string } }>().job.id;
    const { rows } = await h.db.pool.query<{
      id: string;
      prompt_digest: string;
      inputs_digest: string | null;
    }>('SELECT id, prompt_digest, inputs_digest FROM jobs WHERE id = ANY($1::uuid[])', [[id, wsId]]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(id)?.prompt_digest).toBe(
      promptDigest('  update THE readme\nwith the new   install steps '),
    );
    expect(byId.get(id)?.inputs_digest).toBeNull();
    expect(byId.get(wsId)?.inputs_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Clean up: these stay QUEUED and must not match later checks (they never succeed).
    for (const j of [id, wsId]) {
      await store.transition(j, 'cancel_requested', { actor: { type: 'user', id: ownerId }, reason: 'test' });
    }
  });

  describe('reuse check (composer)', () => {
    let earlier = '';
    beforeAll(async () => {
      head = SHA_A;
      earlier = await succeeded(PROJECT, spec());
      h.clock.advance(5 * 60_000);
    });

    it('offers an identical earlier success: same prompt up to case and whitespace, runtime, repository and base commit', async () => {
      const res = await check(owner, {
        spec: spec({ prompt: 'update the readme   with the NEW install steps\n' }),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<Check>()).toMatchObject({
        match: { jobId: earlier, age: '5 min ago', runtime: 'codex', baseCommit: SHA_A },
        reason: null,
      });
      // A base pinned to that commit matches only an earlier job pinned to it (never a guess about a branch).
      const pinned = spec({ repository: { url: REPO, baseRef: SHA_A, workBranch: 'x' } });
      expect((await check(owner, { spec: pinned })).json<Check>().match).toBeNull();
      const pinnedJob = await succeeded(PROJECT, pinned);
      expect((await check(owner, { spec: pinned })).json<Check>().match?.jobId).toBe(pinnedJob);
    });

    it('does not match a different prompt, runtime, model, repository or a moved base', async () => {
      const none = async (s: Record<string, unknown>, reason = 'no_match') => {
        const res = await check(owner, { spec: s });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json<Check>()).toEqual({ match: null, reason, windowHours: 72 });
      };
      await none(spec({ prompt: 'Update the README with the new install steps!' }));
      await none(spec({ runtime: 'claude-code' }));
      await none(spec({ model: 'gpt-other' }));
      // Another repository than the project's: its base cannot be known → never matched.
      await none(
        spec({
          repository: { url: 'https://git.example.test/acme/other.git', baseRef: 'main', workBranch: 'x' },
        }),
        'base_unknown',
      );
      head = SHA_B;
      await none(spec());
      head = SHA_A;
    });

    it('never for untrusted sources; viewers cannot check; other projects are hidden', async () => {
      const untrusted = await check(owner, { spec: spec({ sourceTrust: 'untrusted' }) });
      expect(untrusted.json<Check>()).toMatchObject({ match: null, reason: 'untrusted_source' });
      const noTrust = await check(owner, { spec: { ...spec(), sourceTrust: undefined } });
      expect(noTrust.json<Check>()).toMatchObject({ match: null, reason: 'untrusted_source' });
      expect((await check(viewer, { spec: spec() })).statusCode).toBe(403);
      expect((await check(operator, { spec: spec() })).statusCode).toBe(404);
      // An operator of another project never sees this project's job, even with the same spec there.
      const elsewhere = await operator.req('POST', '/jobs/reuse-check', { project: OTHER, spec: spec() });
      expect(elsewhere.json<Check>().match).toBeNull();
    });

    it('a job that depends on another, a failed job and a job outside the window are never offered', async () => {
      const s = spec({ prompt: 'Summarise the changelog' });
      const { job: up } = await store.create({
        project: PROJECT,
        spec: s,
        actor: { type: 'user', id: ownerId },
      });
      const { job: dependent } = await store.create({
        project: PROJECT,
        spec: s,
        actor: { type: 'user', id: ownerId },
      });
      await store.addDependency(dependent.id, up.id, { type: 'system', id: 't' });
      await store.transition(dependent.id, 'submit', { actor: { type: 'user', id: ownerId } });
      await finish(dependent.id);
      expect((await reuse.find({ project: PROJECT, spec: s, withinHours: 72 })).kind).toBe('none');
      const done = await succeeded(PROJECT, s);
      expect(await reuse.find({ project: PROJECT, spec: s, withinHours: 72 })).toMatchObject({ jobId: done });
      h.clock.advance(3 * 3_600_000);
      expect(await reuse.find({ project: PROJECT, spec: s, withinHours: 2 })).toEqual({
        kind: 'none',
        reason: 'no_match',
      });
    });

    it('workspace jobs match on the input files (names and content), not on their order', async () => {
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      const file = (name: string, text: string) => ({
        name,
        contentBase64: Buffer.from(text).toString('base64'),
      });
      const s = { ...spec({ prompt: 'Chart the numbers' }), repository: undefined };
      const res = await owner.req('POST', '/jobs', {
        project: 'genel',
        spec: s,
        inputs: [file('a.csv', '1,2\n'), file('b.csv', '3,4\n')],
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ job: { id: string } }>().job.id;
      await finish(id);
      const sha = async (t: string) => {
        const { createHash } = await import('node:crypto');
        return createHash('sha256').update(t).digest('hex');
      };
      const same = await owner.req('POST', '/jobs/reuse-check', {
        project: 'genel',
        spec: s,
        inputs: [
          { name: 'b.csv', sha256: await sha('3,4\n') },
          { name: 'a.csv', sha256: await sha('1,2\n') },
        ],
      });
      expect(same.json<Check>().match?.jobId).toBe(id);
      const changed = await owner.req('POST', '/jobs/reuse-check', {
        project: 'genel',
        spec: s,
        inputs: [{ name: 'a.csv', sha256: await sha('1,2\n') }],
      });
      expect(changed.json<Check>()).toMatchObject({ match: null, reason: 'no_match' });
      const repoInputs = await check(owner, {
        spec: spec(),
        inputs: [{ name: 'a.csv', sha256: await sha('x') }],
      });
      // p19-repo-job-inputs: repository jobs take inputs too — such a job is never offered for reuse.
      expect(repoInputs.statusCode).toBe(200);
      expect(repoInputs.json<Check>()).toMatchObject({ match: null, reason: 'not_eligible' });
    });
  });

  it('chat: a job draft states the identical recent success (and still runs anew when confirmed)', async () => {
    head = SHA_A;
    const prompt = 'Bump the lint rules';
    const earlier = await succeeded(PROJECT, spec({ prompt }));
    const chat = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    const preview = (): PreviewDeps => ({
      db: h.db.pool,
      candidates: (project) => app.orchestrator.candidates(project),
      quotas: (project, runtime) => app.quotas.preview(project, runtime),
      policyOf: () => Promise.resolve(null),
    });
    const tools = new ChatTools({
      db: h.db.pool,
      store: chat,
      clock: h.clock.now,
      preview,
      reuse,
    } as unknown as ChatToolsDeps);
    const thread = await chat.createThread(ownerId, 'reuse');
    const out = await tools.run(
      {
        userId: ownerId,
        subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      },
      'draft_job',
      { project: PROJECT, title: 'Lint', prompt, runtime: 'codex' },
    );
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    expect((out.draft.payload as { reuse?: { jobId: string } }).reuse?.jobId).toBe(earlier);
    expect((out.data as { identicalResult?: { jobId: string; note: string } }).identicalResult).toMatchObject(
      {
        jobId: earlier,
      },
    );
  });

  describe('automation policy', () => {
    it('skips a scheduled run with a link when an identical job succeeded within N hours; Run now still runs', async () => {
      head = SHA_A;
      const template = spec({ prompt: 'Nightly dependency audit' });
      const earlier = await succeeded(PROJECT, template);
      await stepUp();
      const created = await owner.req('POST', '/automations', {
        project: PROJECT,
        name: 'audit',
        trigger: { kind: 'cron', cron: '0 * * * *' },
        target: { kind: 'job', spec: template },
        reuseWithinHours: 24,
      });
      expect(created.statusCode, created.body).toBe(201);
      const a = created.json<{ automation: { id: string; reuseWithinHours: number; nextRunAt: string } }>()
        .automation;
      expect(a.reuseWithinHours).toBe(24);
      h.clock.advance(Date.parse(a.nextRunAt) - h.clock.now().getTime() + 1_000);
      expect(await h.app.automations.fireDue()).toBe(1);
      await h.app.automations.idle();
      const run = await h.db.pool.query<{
        state: string;
        job_id: string | null;
        reused_job_id: string;
        reason: string;
      }>('SELECT state, job_id, reused_job_id, reason FROM automation_runs WHERE automation_id = $1', [a.id]);
      expect(run.rows).toHaveLength(1);
      expect(run.rows[0]).toMatchObject({ state: 'skipped', job_id: null, reused_job_id: earlier });
      expect(run.rows[0]?.reason).toContain(`identical job succeeded`);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'automation.fire' AND target = $1`,
        [`automation:${a.id}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ skipped: 'identical_result', reusedJobId: earlier });
      // "Run now" is the user asking for a run: never skipped.
      await stepUp();
      const now = await owner.req('POST', `/automations/${a.id}/run`, {});
      expect(now.statusCode, now.body).toBe(202);
      expect(now.json<{ jobId: string | null }>().jobId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('is refused on workflow targets and off by default', async () => {
      await stepUp();
      const def = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          name: 'reuse-refused',
          defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
          nodes: [{ id: 'a', role: 'executor', prompt: 'x' }],
          edges: [],
        },
      });
      expect(def.statusCode, def.body).toBe(201);
      const wf = def.json<{ id: string }>().id;
      const refused = await owner.req('POST', '/automations', {
        project: PROJECT,
        name: 'wf',
        trigger: { kind: 'cron', cron: '0 * * * *' },
        target: { kind: 'workflow', workflowId: wf, inputs: {}, repository: { url: REPO, baseRef: 'main' } },
        reuseWithinHours: 4,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ error: string }>().error).toBe('reuse_job_targets_only');
      const plain = await owner.req('POST', '/automations', {
        project: PROJECT,
        name: 'plain',
        trigger: { kind: 'cron', cron: '0 * * * *' },
        target: { kind: 'job', spec: spec() },
      });
      expect(
        plain.json<{ automation: { reuseWithinHours: number | null } }>().automation.reuseWithinHours,
      ).toBeNull();
    });
  });

  it('workflow step policy: a root step reuses an identical earlier step job; its own job is cancelled unrun', async () => {
    head = SHA_A;
    await stepUp();
    const def = await owner.req('POST', '/workflows', {
      project: PROJECT,
      definition: {
        name: 'reuse-steps',
        defaults: {
          runtime: 'codex',
          sandboxProfile: 'container',
          sourceTrust: 'trusted',
          limits: { maxDurationSec: 600 },
          repository: { url: REPO, baseRef: 'main' },
          reuseWithinHours: 12,
        },
        nodes: [{ id: 'docs', role: 'executor', prompt: 'Regenerate the API docs for run {{run.id}}' }],
        edges: [],
      },
    });
    expect(def.statusCode, def.body).toBe(201);
    const wf = def.json<{ id: string }>().id;
    // The run view (both workflow engines answer it the same way, p14-workflow-engine).
    const nodeOf = async (runId: string) => {
      const n = (await owner.req('GET', `/workflows/runs/${runId}`))
        .json<{ nodes: { id: string; jobId: string; reusedJobId: string | null; state: string }[] }>()
        .nodes.find((x) => x.id === 'docs');
      return n === undefined ? undefined : { job_id: n.jobId, reused_job_id: n.reusedJobId, state: n.state };
    };
    const first = await h.app.workflows.startRun({ type: 'user', id: ownerId }, wf, { inputs: {} });
    const firstJob = (await nodeOf(first))?.job_id ?? '';
    await finish(firstJob);
    await h.app.workflows.progress();
    expect(await nodeOf(first)).toMatchObject({ state: 'succeeded', reused_job_id: null });

    const second = await h.app.workflows.startRun({ type: 'user', id: ownerId }, wf, { inputs: {} });
    await h.app.workflows.progress();
    const n = await nodeOf(second);
    expect(n).toMatchObject({ state: 'succeeded', job_id: firstJob, reused_job_id: firstJob });
    const own = await h.db.pool.query<{ state: string }>(
      `SELECT j.state::text AS state FROM workflow_job_links wj JOIN jobs j ON j.id = wj.job_id
        WHERE wj.run_id = $1 AND wj.node_id = 'docs'`,
      [second],
    );
    // Engine 1 created the step's job up front and cancelled it; engine 2 never creates it (lazy jobs).
    const engine = (await owner.req('GET', `/workflows/runs/${second}`)).json<{ run: { engine: number } }>()
      .run.engine;
    expect(own.rows.map((r) => r.state)).toEqual(engine === 2 ? [] : ['CANCELLED']);
    const view = await owner.req('GET', `/workflows/runs/${second}`);
    expect(view.json<{ nodes: { reusedJobId: string | null }[] }>().nodes[0]?.reusedJobId).toBe(firstJob);
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'workflow.step.reuse' AND target = $1`,
      [`workflow-run:${second}`],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ node: 'docs', reusedJobId: firstJob });
  });
});
