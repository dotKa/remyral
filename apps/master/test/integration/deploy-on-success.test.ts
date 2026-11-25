import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-deploy-on-success (ADR-0030) against a real master and fake Coolify / Cloudflare: a job created with "deploy
 * when done" is deployed automatically once it succeeds — the creator's submission is the approval (production only
 * with the project switch and a fresh authenticator code), re-checked before running, bound to the job's own
 * secret-scanned site bundle — and the creator is told (job view, notification, chat thread).
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const REPO = 'https://github.com/acme/shop.git';

const coolify = new FakeCoolify();
const cf = new FakeCloudflare();
const h = new Harness();
let owner: Client;
let operator: Client;
let outsider: Client;
let ownerSecret = '';
let operatorSecret = '';
let ownerId = '';
let operatorId = '';
let ws: WorkspaceService;

const spec = (prompt = 'Build the landing page') => ({
  runtime: 'codex',
  prompt,
  repository: { url: REPO, baseRef: 'main', workBranch: `rac/site-${randomUUID().slice(0, 6)}` },
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  sourceTrust: 'trusted',
  limits: { maxDurationSec: 600 },
});

async function stepUp(c: Client = owner, secret = ownerSecret): Promise<void> {
  h.clock.advance(30_000);
  expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
}

async function targets(policy: Record<string, unknown> = {}, pages = 'shop-site'): Promise<void> {
  await stepUp();
  const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
    targets: {
      coolify: { preview: { uuids: ['shopprev01'] }, production: { uuids: ['shopprod01'] } },
      pages: { projectName: pages },
      policy,
    },
  });
  expect(t.statusCode, t.body).toBe(200);
}

async function submit(
  c: Client,
  deployOnSuccess: Record<string, unknown>,
  s: Record<string, unknown> = spec(),
) {
  return c.req('POST', '/jobs', { project: PROJECT, spec: s, deployOnSuccess });
}

async function created(c: Client, deployOnSuccess: Record<string, unknown>): Promise<string> {
  const res = await submit(c, deployOnSuccess);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ job: { id: string } }>().job.id;
}

/** The job built `site/index.html` (a site bundle committed like a worker's) and then succeeded. */
async function succeedWithSite(jobId: string, html = '<!doctype html><h1>Shop</h1>'): Promise<string> {
  const file = Buffer.from(html);
  const bundle = Buffer.from(
    JSON.stringify({
      version: 1,
      directory: 'site',
      files: [
        {
          path: 'index.html',
          contentType: 'text/html',
          sha256: createHash('sha256').update(file).digest('hex'),
          base64: file.toString('base64'),
        },
      ],
    }),
  );
  const attemptId = randomUUID();
  expect(
    await ws.stageChunk(
      h.db.pool,
      jobId,
      { attemptId, artifactId: 'ws-site-bundle', index: 0, data: bundle.toString('base64') },
      h.clock.now(),
    ),
  ).toBe('ok');
  const sha = createHash('sha256').update(bundle).digest('hex');
  expect(
    await ws.commitArtifact(
      h.db.pool,
      jobId,
      {
        attemptId,
        artifactId: 'ws-site-bundle',
        name: 'site-bundle.json',
        mediaType: 'application/json',
        sizeBytes: bundle.length,
        sha256: sha,
      },
      h.clock.now(),
    ),
  ).toBe('ok');
  await setJobState(jobId, 'SUCCEEDED');
  return sha;
}

async function setJobState(jobId: string, state: string): Promise<void> {
  await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [jobId, state]);
}

async function view(c: Client, jobId: string) {
  const res = await c.req('GET', `/jobs/${jobId}/deploy-on-success`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ deployOnSuccess: Record<string, unknown> | null }>().deployOnSuccess;
}

/** Tick, let the fake provider finish, poll, tick again. */
async function runToEnd(): Promise<void> {
  await h.app.deployOnSuccess.tick();
  for (const d of coolify.deployments.values()) d.status = 'finished';
  h.clock.advance(20_000);
  await h.app.ops.pollDeploying();
  await h.app.deployOnSuccess.tick();
}

const opsActionsOf = async (jobId: string) =>
  (
    await h.db.pool.query<{
      id: string;
      state: string;
      kind: string;
      env: string;
      decided_by: string | null;
      decision_reason: string | null;
      step_up_at: Date | null;
      params: Record<string, unknown>;
      idempotency_key: string;
    }>(
      `SELECT id::text AS id, state, kind, env, decided_by::text AS decided_by, decision_reason, step_up_at, params,
              idempotency_key
         FROM ops_actions WHERE source->>'jobId' = $1 ORDER BY created_at`,
      [jobId],
    )
  ).rows;

describeIntegration('deploy on success (integration)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await coolify.start();
    await cf.start();
    await h.start({
      ops: { internalOrigins: [coolify.base, cf.base], cloudflareApi: `${cf.base}/client/v4` },
    });
    ownerId = await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    operatorId = await h.createUser('op1', PW, 'operator');
    ({ secret: operatorSecret } = await enroll(h, 'op1', PW));
    operator = await fullLogin(h, 'op1', PW, operatorSecret);
    const outsiderId = await h.createUser('op.other', PW, 'operator');
    const { secret: outsiderSecret } = await enroll(h, 'op.other', PW);
    outsider = await fullLogin(h, 'op.other', PW, outsiderSecret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
    await h.grant(operatorId, [PROJECT], 'operator');
    await h.grant(outsiderId, ['other'], 'operator');
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())`,
      [PROJECT, REPO, ownerId],
    );
    coolify.addApp({ uuid: 'shopprev01', name: 'shop-preview' });
    coolify.addApp({ uuid: 'shopprod01', name: 'shop-prod' });
    for (const name of ['shop-site', 'other-site']) {
      cf.pagesProjects.set(name, { name, production_branch: 'main', domains: [], deployments: [] });
    }
    await stepUp();
    expect(
      (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
        .statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
        .statusCode,
    ).toBe(200);
    await targets();
    ws = new WorkspaceService({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      log: h.app.log,
    });
  });
  afterAll(async () => {
    await h.stop();
    await coolify.stop();
    await cf.stop();
  });

  it('preview to Pages: the job builds a site bundle, deploys itself when it succeeds and tells its creator', async () => {
    const res = await submit(operator, { target: 'pages' });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ job: { id: string }; deployOnSuccess: Record<string, unknown> }>();
    expect(body.deployOnSuccess).toMatchObject({ target: 'pages', env: 'preview', directory: 'site' });
    const jobId = body.job.id;
    const stored = await h.db.pool.query<{ spec: Record<string, unknown> }>(
      'SELECT spec FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(stored.rows[0]?.spec.siteBundle).toEqual({ directory: 'site' });
    // Nothing happens while the job runs.
    cf.reset();
    await h.app.deployOnSuccess.tick();
    expect(await view(operator, jobId)).toMatchObject({ state: 'pending', target: 'pages', env: 'preview' });
    expect(cf.requests).toHaveLength(0);

    const sha = await succeedWithSite(jobId);
    await h.app.deployOnSuccess.tick();
    const [act] = await opsActionsOf(jobId);
    expect(act).toMatchObject({ kind: 'pages.deploy', env: 'preview', state: 'deploying' });
    expect(act?.params).toMatchObject({ jobId, branch: 'remyral-preview', bundleSha256: sha });
    expect(act?.idempotency_key).toMatch(/^dos-/);
    expect(cf.requests.at(-1)?.body).toContain('"/index.html"');
    expect(await view(operator, jobId)).toMatchObject({ state: 'requested', opsActionId: act?.id });

    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    await h.app.deployOnSuccess.tick();
    const done = await view(operator, jobId);
    expect(done).toMatchObject({ state: 'succeeded', opsActionState: 'succeeded' });
    expect(String(done?.url)).toMatch(/^https:\/\/.+\.shop-site\.pages\.dev$/);

    await h.app.notifications.runOnce();
    const notes = await h.db.pool.query<{ recipient_id: string; link: string; body: string }>(
      "SELECT recipient_id::text AS recipient_id, link, body FROM notifications WHERE kind = 'deploy.succeeded'",
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({ recipient_id: operatorId, link: `/jobs/${jobId}` });
    expect(notes.rows[0]?.body).toContain(String(done?.url));
    const audit = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events WHERE target = $1 AND action LIKE 'ops.preapproval.%' ORDER BY id`,
      [`job:${jobId}`],
    );
    expect(audit.rows).toEqual([
      { action: 'ops.preapproval.create', outcome: 'success' },
      { action: 'ops.preapproval.finish', outcome: 'success' },
    ]);

    // Replay: further ticks never deploy again.
    cf.reset();
    await h.app.deployOnSuccess.tick();
    await h.app.deployOnSuccess.tick();
    expect(await opsActionsOf(jobId)).toHaveLength(1);
    expect(cf.requests).toHaveLength(0);
  });

  it('production needs the project switch, the approve right and a fresh authenticator code at creation', async () => {
    const jobsBefore = (await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs')).rows[0]
      ?.n;
    const off = await submit(owner, { target: 'pages', env: 'production' });
    expect(off.statusCode).toBe(409);
    expect(off.json<{ error: string }>().error).toBe('production_auto_deploy_off');
    // A refused deploy creates no job.
    expect((await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs')).rows[0]?.n).toBe(
      jobsBefore,
    );

    await targets({ autoDeployProductionOnSuccess: true });
    // An operator cannot approve production in advance.
    await stepUp(operator, operatorSecret);
    const op = await submit(operator, { target: 'pages', env: 'production' });
    expect(op.statusCode).toBe(403);
    expect(op.json<{ error: string }>().error).toBe('deploy_approval_forbidden');
    // The owner needs an always-fresh code.
    h.clock.advance(11 * 60_000);
    const stale = await submit(owner, { target: 'pages', env: 'production' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ error: string }>().error).toBe('step_up_required');
    await stepUp();
    const jobId = await created(owner, { target: 'pages', env: 'production' });
    expect(await view(owner, jobId)).toMatchObject({
      env: 'production',
      covers: 'approval_step_up',
      stepUp: true,
    });

    await succeedWithSite(jobId);
    cf.reset();
    await h.app.deployOnSuccess.tick();
    // Runs at once: no card, decided by the creator in advance.
    const [act] = await opsActionsOf(jobId);
    expect(act).toMatchObject({
      kind: 'pages.deploy',
      env: 'production',
      state: 'deploying',
      decided_by: ownerId,
      decision_reason: 'Pre-approved at job creation (deploy on success).',
    });
    expect(act?.step_up_at).not.toBeNull();
    expect(act?.params).toMatchObject({ branch: 'main' });
    const approve = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.action.approve' AND target = $1
          AND metadata->>'preApproved' = 'true'`,
      [`ops-action:${act?.id ?? ''}`],
    );
    expect(approve.rows[0]?.n).toBe(1);
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    await h.app.deployOnSuccess.tick();
    expect(await view(owner, jobId)).toMatchObject({ state: 'succeeded' });
  });

  it('switch turned off or target changed after creation: refused, nothing deployed', async () => {
    await stepUp();
    const prod = await created(owner, { target: 'pages', env: 'production' });
    const changed = await created(owner, { target: 'pages' });
    await succeedWithSite(prod);
    await succeedWithSite(changed);
    await targets({ autoDeployProductionOnSuccess: false }, 'other-site');
    cf.reset();
    await h.app.deployOnSuccess.tick();
    expect(await view(owner, prod)).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('turned off') as unknown,
    });
    expect(await view(owner, changed)).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('target changed') as unknown,
    });
    expect(await opsActionsOf(prod)).toHaveLength(0);
    expect(await opsActionsOf(changed)).toHaveLength(0);
    expect(cf.requests).toHaveLength(0);
    await targets();
  });

  it('failed job → skipped; flagged or missing bundle → no deploy; a creator who lost access → refused', async () => {
    const failed = await created(operator, { target: 'pages' });
    await setJobState(failed, 'FAILED');
    const flagged = await created(operator, { target: 'pages' });
    await succeedWithSite(flagged);
    await h.db.pool.query("UPDATE job_artifacts SET redacted = true WHERE job_id = $1 AND kind = 'site'", [
      flagged,
    ]);
    const missing = await created(operator, { target: 'pages' });
    await setJobState(missing, 'SUCCEEDED');
    const lost = await created(operator, { target: 'coolify' });
    cf.reset();
    coolify.reset();
    await h.app.deployOnSuccess.tick();
    // The creator is demoted to viewer before their job finishes.
    await setJobState(lost, 'SUCCEEDED');
    await h.db.pool.query('UPDATE project_memberships SET role = $3 WHERE user_id = $1 AND project_id = $2', [
      operatorId,
      PROJECT,
      'viewer',
    ]);
    await h.app.deployOnSuccess.tick();
    await h.db.pool.query('UPDATE project_memberships SET role = $3 WHERE user_id = $1 AND project_id = $2', [
      operatorId,
      PROJECT,
      'operator',
    ]);
    expect(await view(operator, failed)).toMatchObject({ state: 'skipped' });
    expect(await view(operator, flagged)).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('secret') as unknown,
    });
    expect(await view(operator, missing)).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('no site bundle') as unknown,
    });
    expect(await view(operator, lost)).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('no longer request deploys') as unknown,
    });
    for (const j of [failed, flagged, missing, lost]) expect(await opsActionsOf(j)).toHaveLength(0);
    expect(cf.requests).toHaveLength(0);
    expect(coolify.calls(/POST/)).toEqual([]);
  });

  it('a policy stricter than at creation: the deploy waits for an approval like any other card', async () => {
    const jobId = await created(operator, { target: 'pages' });
    await succeedWithSite(jobId);
    await targets({ previewDeploy: 'approval' });
    cf.reset();
    await h.app.deployOnSuccess.tick();
    const [act] = await opsActionsOf(jobId);
    expect(act).toMatchObject({ state: 'awaiting_approval', decided_by: null });
    expect(cf.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(await view(operator, jobId)).toMatchObject({
      state: 'requested',
      opsActionState: 'awaiting_approval',
    });
    await stepUp();
    const denied = await owner.req('POST', `/deploy/actions/${act?.id ?? ''}/deny`, { reason: 'not now' });
    expect(denied.statusCode, denied.body).toBe(200);
    await h.app.deployOnSuccess.tick();
    expect(await view(operator, jobId)).toMatchObject({
      state: 'failed',
      reason: 'An approver denied the deploy.',
    });
    await targets();
  });

  it('Coolify preview: deploys the configured app and reports its address', async () => {
    const jobId = await created(operator, { target: 'coolify' });
    await setJobState(jobId, 'SUCCEEDED');
    coolify.reset();
    await runToEnd();
    expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=shopprev01']);
    expect(await view(operator, jobId)).toMatchObject({
      state: 'succeeded',
      url: 'https://shopprev01.example.test',
    });
  });

  it('refuses bad requests: untrusted sources, unknown fields, other projects, missing targets; GET is project-scoped', async () => {
    const untrusted = await submit(owner, { target: 'pages' }, { ...spec(), sourceTrust: 'untrusted' });
    expect(untrusted.statusCode).toBe(400);
    expect(untrusted.json<{ error: string }>().error).toBe('deploy_needs_trusted_source');
    const junk = await submit(owner, { target: 'pages', project: 'other' });
    expect(junk.statusCode).toBe(400);
    const jobId = await created(operator, { target: 'pages' });
    expect((await outsider.req('GET', `/jobs/${jobId}/deploy-on-success`)).statusCode).toBe(404);
    const plain = await owner.req('POST', '/jobs', { project: PROJECT, spec: spec() });
    expect(plain.statusCode).toBe(201);
    expect(await view(owner, plain.json<{ job: { id: string } }>().job.id)).toBeNull();
    await setJobState(jobId, 'CANCELLED');
    await h.app.deployOnSuccess.tick();
    expect(await view(operator, jobId)).toMatchObject({ state: 'skipped' });
  });

  it('chat: draft_job offers deploy on success; confirming approves it and the thread gets the live link', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      ops: () => app.ops,
      deployOnSuccess: () => app.deployOnSuccess,
      preview: () => ({
        db: h.db.pool,
        candidates: (project: string) => app.orchestrator.candidates(project),
        quotas: (project: string, runtime: never) => app.quotas.preview(project, runtime),
        policyOf: () => Promise.resolve(null),
      }),
    } as unknown as ChatToolsDeps);
    const thread = await store.createThread(ownerId, 'site');
    const caller = {
      userId: ownerId,
      subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
    const out = await tools.run(caller, 'draft_job', {
      project: PROJECT,
      title: 'Landing page',
      prompt: 'Build a landing page into site/.',
      runtime: 'codex',
      deployOnSuccess: { target: 'pages' },
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    expect(out.draft.payload).toMatchObject({
      deployOnSuccess: { target: 'pages', env: 'preview', directory: 'site' },
      spec: { siteBundle: { directory: 'site' } },
    });
    expect(out.data).toMatchObject({ deployOnSuccess: { policyLevel: 'auto' } });
    // Production while the switch is off: the draft says why.
    expect(
      await tools.run(caller, 'draft_job', {
        project: PROJECT,
        title: 'Landing page',
        prompt: 'Build it.',
        runtime: 'codex',
        deployOnSuccess: { target: 'pages', env: 'production' },
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });

    await stepUp();
    const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
    expect(conf.statusCode, conf.body).toBe(200);
    const result = conf.json<{ result: { jobId: string; deployOnSuccess: Record<string, unknown> } }>()
      .result;
    expect(result.deployOnSuccess).toMatchObject({ target: 'pages', env: 'preview' });
    const row = await h.db.pool.query<{ via: string; source: Record<string, unknown> }>(
      'SELECT via, source FROM job_deploy_on_success WHERE job_id = $1',
      [result.jobId],
    );
    expect(row.rows[0]).toMatchObject({
      via: 'chat',
      source: { chatThreadId: thread.id, draftId: out.draft.id },
    });
    await succeedWithSite(result.jobId);
    await runToEnd();
    const v = await view(owner, result.jobId);
    expect(v).toMatchObject({ state: 'succeeded' });
    const msgs = await store.messages(thread.id);
    const note = msgs.find((m) => m.meta?.notice === 'deploy-on-success');
    expect(note?.role).toBe('assistant');
    expect(note?.content).toContain(String(v?.url));
    expect(note?.content).toContain(result.jobId.slice(0, 8));
  });

  it('automations: a job target deploys each run’s job on success (saved approval, re-checked per run)', async () => {
    await stepUp();
    const res = await owner.req('POST', '/automations', {
      project: PROJECT,
      name: 'nightly site',
      trigger: { kind: 'cron', cron: '0 3 * * *' },
      target: { kind: 'job', spec: spec('Rebuild the site'), deployOnSuccess: { target: 'pages' } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ automation: { id: string } }>().automation.id;
    const detail = await owner.req('GET', `/automations/${id}`);
    expect(detail.json()).toMatchObject({
      targetSpec: {
        spec: { siteBundle: { directory: 'site' } },
        deployOnSuccess: { target: 'pages', env: 'preview', directory: 'site' },
      },
    });
    await stepUp();
    const run = await owner.req('POST', `/automations/${id}/run`);
    expect(run.statusCode, run.body).toBeLessThan(300);
    const job = await h.db.pool.query<{ job_id: string }>(
      'SELECT job_id::text AS job_id FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id],
    );
    const jobId = job.rows[0]?.job_id ?? '';
    const pre = await h.db.pool.query<{ via: string; source: Record<string, unknown> }>(
      'SELECT via, source FROM job_deploy_on_success WHERE job_id = $1',
      [jobId],
    );
    expect(pre.rows[0]).toMatchObject({ via: 'automation', source: { automationId: id } });
    await succeedWithSite(jobId);
    await runToEnd();
    expect(await view(owner, jobId)).toMatchObject({ state: 'succeeded' });
  });

  it('p10-publish-bundle: draft_job publishes on a custom domain — one confirmation with a code covers create → deploy → domain → CNAME', async () => {
    const zone = cf.addZone('shopzone.example');
    await stepUp();
    const cur = (await owner.req('GET', `/projects/${PROJECT}/deploy-targets`)).json<{ version: number }>();
    const put = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
      targets: {
        coolify: { preview: { uuids: ['shopprev01'] }, production: { uuids: ['shopprod01'] } },
        pages: { projectName: 'shop-site' },
        dns: { zones: [{ id: zone, name: 'shopzone.example' }], protectedNames: [] },
      },
      expectedVersion: cur.version,
    });
    expect(put.statusCode, put.body).toBe(200);
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      ops: () => app.ops,
      deployOnSuccess: () => app.deployOnSuccess,
      preview: () => ({
        db: h.db.pool,
        candidates: (project: string) => app.orchestrator.candidates(project),
        quotas: (project: string, runtime: never) => app.quotas.preview(project, runtime),
        policyOf: () => Promise.resolve(null),
      }),
    } as unknown as ChatToolsDeps);
    const thread = await store.createThread(ownerId, 'publish');
    const caller = {
      userId: ownerId,
      subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
    const out = await tools.run(caller, 'draft_job', {
      project: PROJECT,
      title: 'Deck',
      prompt: 'Build the deck into site/.',
      runtime: 'codex',
      deployOnSuccess: {
        target: 'pages',
        pagesProject: 'shop-deck',
        createIfMissing: true,
        domain: 'deck.shopzone.example',
      },
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    expect(out.draft.payload).toMatchObject({
      deployOnSuccess: {
        target: 'pages',
        pagesProject: 'shop-deck',
        createIfMissing: true,
        domain: 'deck.shopzone.example',
        dns: 'auto',
      },
    });
    const card = (out.data as { deployOnSuccess: { policyLevel: string; chain: string[] } }).deployOnSuccess;
    // DNS is involved: the one confirmation needs a fresh authenticator code.
    expect(card.policyLevel).toBe('approval_step_up');
    expect(card.chain).toHaveLength(4);
    expect(card.chain[0]).toContain('Create the Pages project shop-deck');
    expect(card.chain[3]).toContain('CNAME deck.shopzone.example');

    await stepUp();
    const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
    expect(conf.statusCode, conf.body).toBe(200);
    const jobId = conf.json<{ result: { jobId: string } }>().result.jobId;
    expect(await view(owner, jobId)).toMatchObject({
      covers: 'approval_step_up',
      stepUp: true,
      publish: {
        pagesProject: 'shop-deck',
        createIfMissing: true,
        domain: 'deck.shopzone.example',
        dns: 'auto',
      },
      requestedByAgent: false,
    });
    await succeedWithSite(jobId);
    await runToEnd();
    const all = await opsActionsOf(jobId);
    expect(all.find((a) => a.kind === 'pages.publish')).toMatchObject({
      state: 'succeeded',
      decided_by: ownerId,
      decision_reason: 'Pre-approved at job creation (deploy on success).',
    });
    // Every step ran under that one approval (same timestamp on the fake clock: compared as a set).
    expect(
      all
        .filter((a) => a.kind !== 'pages.publish')
        .map((k) => [k.kind, k.decided_by, k.decision_reason])
        .sort(),
    ).toEqual(
      [
        ['pages.add_domain', ownerId, 'Approved with its publish bundle.'],
        ['pages.create_project', ownerId, 'Approved with its publish bundle.'],
        ['pages.deploy', null, null],
      ].sort(),
    );
    const v = await view(owner, jobId);
    expect(v).toMatchObject({ state: 'succeeded' });
    expect(String(v?.url)).toMatch(/shop-deck\.pages\.dev$/);
    expect(cf.zones.get(zone)?.records).toEqual([
      expect.objectContaining({
        type: 'CNAME',
        name: 'deck.shopzone.example',
        content: 'shop-deck.pages.dev',
      }),
    ]);
    const note = (await store.messages(thread.id)).find((m) => m.meta?.notice === 'deploy-on-success');
    expect(note?.content).toContain('https://deck.shopzone.example');
  });

  it('p10-publish-bundle: the job’s agent asks to publish — recorded, and on success ONE approval runs the chain', async () => {
    const res = await operator.req('POST', '/jobs', { project: PROJECT, spec: spec('Build the docs site') });
    expect(res.statusCode, res.body).toBe(201);
    const jobId = res.json<{ job: { id: string } }>().job.id;
    const job = { jobId, project: PROJECT, createdByType: 'user', createdById: operatorId, spec: spec() };
    // Untrusted sources and jobs not created by a person never publish.
    expect(
      await h.app.deployOnSuccess.requestByAgent(
        { ...job, spec: { ...spec(), sourceTrust: 'untrusted' } },
        {},
      ),
    ).toMatchObject({ status: 'refused', reason: 'untrusted' });
    expect(
      await h.app.deployOnSuccess.requestByAgent({ ...job, createdByType: 'system', createdById: null }, {}),
    ).toMatchObject({ status: 'refused', reason: 'creator_not_person' });
    expect(await h.app.deployOnSuccess.requestByAgent(job, { pagesProject: 'not-ours' })).toMatchObject({
      status: 'refused',
      reason: 'pages_project_not_allowed',
    });
    const ok = await h.app.deployOnSuccess.requestByAgent(job, { domain: 'docs.shopzone.example' });
    expect(ok.status).toBe('ok');
    expect(ok.detail).toMatch(/ONE approval by a project admin with a fresh authenticator code/);
    expect(await h.app.deployOnSuccess.requestByAgent(job, {})).toMatchObject({
      status: 'refused',
      reason: 'already_requested',
    });
    expect(await view(operator, jobId)).toMatchObject({
      covers: 'none',
      via: 'job',
      requestedByAgent: true,
      publish: { pagesProject: null, domain: 'docs.shopzone.example', dns: 'auto' },
    });
    await succeedWithSite(jobId);
    await h.app.deployOnSuccess.tick();
    const bundle = (await opsActionsOf(jobId)).find((a) => a.kind === 'pages.publish');
    expect(bundle).toMatchObject({ state: 'awaiting_approval', decided_by: null });
    await stepUp();
    const appr = await owner.req('POST', `/deploy/actions/${bundle?.id ?? ''}/approve`, {});
    expect(appr.statusCode, appr.body).toBe(200);
    await runToEnd();
    expect(await view(operator, jobId)).toMatchObject({ state: 'succeeded' });
    // The preview deploy is auto (no decision needed); the domain + CNAME ran under the one approval.
    const kids = (await opsActionsOf(jobId)).filter((a) => a.kind !== 'pages.publish');
    expect(kids.map((k) => [k.kind, k.state, k.decided_by]).sort()).toEqual(
      [
        ['pages.add_domain', 'deploying', ownerId],
        ['pages.deploy', 'succeeded', null],
      ].sort(),
    );
  });
});
