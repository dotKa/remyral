import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p12-deploy-feedback (ADR-0048) against a real master and fake Coolify / Cloudflare: deploy logs (build, runtime,
 * health) — redacted, capped, operator-only, project resources only, control plane refused —, the failure summary and
 * the fix plan, the chat tools, the in-job tools of a job's agent (re-authorised, rate-limited, audited, a redeploy is a
 * request) and auto-fix (off by default, admin + step-up, one bounded fix job whose redeploy is never pre-approved).
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const REPO = 'https://github.com/acme/shop.git';
const CANARY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const coolify = new FakeCoolify();
const cf = new FakeCloudflare();
const h = new Harness();
let owner: Client;
let operator: Client;
let viewer: Client;
let outsider: Client;
let ownerSecret = '';
let ownerId = '';
let operatorId = '';

const spec = (over: Record<string, unknown> = {}) => ({
  runtime: 'codex',
  prompt: 'Change the shop',
  repository: { url: REPO, baseRef: 'main', workBranch: `rac/fb-${randomUUID().slice(0, 6)}` },
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  sourceTrust: 'trusted',
  limits: { maxDurationSec: 600 },
  ...over,
});

async function stepUp(c: Client = owner, secret = ownerSecret): Promise<void> {
  h.clock.advance(30_000);
  expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
}

async function setJobState(jobId: string, state: string): Promise<void> {
  await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [jobId, state]);
}

/** A Coolify preview deploy on success of a job created by the operator; the deployment then fails. */
async function failedCoolifyDeploy(): Promise<{ jobId: string; actionId: string }> {
  const res = await operator.req('POST', '/jobs', {
    project: PROJECT,
    spec: spec(),
    deployOnSuccess: { target: 'coolify' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const jobId = res.json<{ job: { id: string } }>().job.id;
  await setJobState(jobId, 'SUCCEEDED');
  await h.app.deployOnSuccess.tick();
  const { rows } = await h.db.pool.query<{ id: string }>(
    "SELECT id::text AS id FROM ops_actions WHERE source->>'jobId' = $1",
    [jobId],
  );
  const actionId = rows[0]?.id ?? '';
  for (const d of coolify.deployments.values()) {
    if (d.status === 'queued') {
      d.status = 'failed';
      d.logs = JSON.stringify([
        { output: 'npm run build', hidden: false },
        { output: `Error: Cannot find module './missing' token=${CANARY}`, hidden: false },
        { output: 'internal secret line', hidden: true },
      ]);
    }
  }
  h.clock.advance(20_000);
  await h.app.ops.pollDeploying();
  await h.app.deployOnSuccess.tick();
  return { jobId, actionId };
}

describeIntegration('deploy feedback (integration, p12-deploy-feedback)', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    await coolify.start();
    await cf.start();
    await h.start({
      ops: {
        internalOrigins: [coolify.base, cf.base],
        cloudflareApi: `${cf.base}/client/v4`,
        limits: { perProjectPer10Min: 500 },
      },
    });
    ownerId = await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    operatorId = await h.createUser('op1', PW, 'operator');
    const { secret: opSecret } = await enroll(h, 'op1', PW);
    operator = await fullLogin(h, 'op1', PW, opSecret);
    const viewerId = await h.createUser('view1', PW, 'viewer');
    viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
    const outsiderId = await h.createUser('op.other', PW, 'operator');
    outsider = await fullLogin(h, 'op.other', PW, (await enroll(h, 'op.other', PW)).secret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
    await h.grant(operatorId, [PROJECT], 'operator');
    await h.grant(viewerId, [PROJECT], 'viewer');
    await h.grant(outsiderId, ['other'], 'operator');
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())`,
      [PROJECT, REPO, ownerId],
    );
    coolify.addApp({
      uuid: 'shopprev01',
      name: 'shop-preview',
      git_branch: 'develop',
      runtimeLogs: [
        '2026-01-01T09:00:00.000000000Z boot old line',
        `2026-01-01T10:00:00.000000000Z TypeError: x is undefined (GITHUB_TOKEN=${CANARY})`,
        '    at main (server.js:10)',
      ].join('\n'),
    });
    coolify.addApp({ uuid: 'shopprod01', name: 'shop-prod' });
    coolify.addApp({ uuid: 'otherapp01', name: 'other-app', runtimeLogs: 'other project logs' });
    cf.pagesProjects.set('shop-site', {
      name: 'shop-site',
      production_branch: 'main',
      domains: [],
      deployments: [],
    });
    await stepUp();
    expect(
      (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
        .statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
        .statusCode,
    ).toBe(200);
    await stepUp();
    const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
      targets: {
        coolify: { preview: { uuids: ['shopprev01'] }, production: { uuids: ['shopprod01'] } },
        pages: { projectName: 'shop-site' },
        policy: {},
      },
    });
    expect(t.statusCode, t.body).toBe(200);
  });
  afterAll(async () => {
    await h.stop();
    await coolify.stop();
    await cf.stop();
  });

  it('build logs of a failed Coolify deploy: redacted, hidden lines dropped, operators only, project-scoped', async () => {
    const { actionId } = await failedCoolifyDeploy();
    const res = await operator.req('GET', `/deploy/actions/${actionId}/logs?kind=build`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      kind: string;
      provider: string;
      sources: { label: string; status: string; text: string }[];
      items: { logs: string }[];
    }>();
    expect(body.kind).toBe('build');
    expect(body.provider).toBe('coolify');
    expect(body.sources[0]?.status).toBe('failed');
    expect(body.sources[0]?.text).toContain("Cannot find module './missing'");
    expect(body.sources[0]?.text).not.toContain('internal secret line');
    expect(res.body).not.toContain(CANARY);
    // The p6 shape still answers (default kind = build).
    const old = await operator.req('GET', `/deploy/actions/${actionId}/logs`);
    expect(old.json<{ items: unknown[] }>().items).toHaveLength(1);
    // Viewers read the action, not its logs; other projects see nothing.
    expect((await viewer.req('GET', `/deploy/actions/${actionId}/logs`)).statusCode).toBe(403);
    expect((await outsider.req('GET', `/deploy/actions/${actionId}/logs`)).statusCode).toBe(404);
    expect((await viewer.req('GET', `/deploy/actions/${actionId}/failure`)).statusCode).toBe(200);
    const failure = (await operator.req('GET', `/deploy/actions/${actionId}/failure`)).json<{
      failure: string;
      summary: string;
      sourceJobId: string;
    }>();
    expect(failure.failure).toBe('deploy');
    expect(failure.summary).toContain('Coolify deploy (preview) failed');
  });

  it('runtime logs: the project’s own app only, since-filter, control plane and moved targets refused', async () => {
    const { actionId } = await failedCoolifyDeploy();
    coolify.reset();
    const res = await operator.req('GET', `/deploy/actions/${actionId}/logs?kind=runtime&lines=200`);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json<{ sources: { id: string; text: string }[] }>();
    expect(b.sources.map((s) => s.id)).toEqual(['shopprev01']);
    expect(b.sources[0]?.text).toContain('TypeError: x is undefined');
    expect(res.body).not.toContain(CANARY);
    expect(coolify.calls(/\/logs/)).toEqual([
      'GET /api/v1/applications/shopprev01/logs?lines=200&show_timestamps=true',
    ]);
    // since: only lines at or after the cut (continuation lines follow theirs).
    const now = h.clock.now().getTime();
    const app = coolify.apps.get('shopprev01');
    if (app !== undefined) {
      app.runtimeLogs = [
        `${new Date(now - 2 * 3_600_000).toISOString()} boot old line`,
        `${new Date(now - 10 * 60_000).toISOString()} TypeError: x is undefined`,
        '    at main (server.js:10)',
      ].join('\n');
    }
    const since = await operator.req('GET', `/deploy/actions/${actionId}/logs?kind=runtime&sinceMinutes=45`);
    const st = since.json<{ sources: { text: string }[] }>().sources[0]?.text ?? '';
    expect(st).not.toContain('boot old line');
    expect(st).toContain('at main (server.js:10)');
    // A control-plane resource (the integration's deny-list) is refused without reading its logs.
    await stepUp();
    expect(
      (
        await owner.req('PUT', '/integrations/ops/coolify', {
          url: coolify.base,
          denyResources: ['shopprev01'],
        })
      ).statusCode,
    ).toBe(200);
    coolify.reset();
    const refused = await operator.req('GET', `/deploy/actions/${actionId}/logs?kind=runtime`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe('refused');
    expect(coolify.calls(/\/logs/)).toHaveLength(0);
    await stepUp();
    await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, denyResources: [] });
    // Runtime logs exist for Coolify only.
    const pagesAction = await h.db.pool.query<{ id: string }>(
      `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
                                state, requested_by_type, requested_by_id, via, idempotency_key, created_at, updated_at)
       VALUES ($1, 'pages.deploy', 'preview', '{}', repeat('a', 64), '{"project":"shop-site"}', '{}', 'auto', 'test', 'failed',
               'user', $2, 'api', $3, now(), now()) RETURNING id::text AS id`,
      [PROJECT, ownerId, `t-${randomUUID()}`],
    );
    const pr = await operator.req(
      'GET',
      `/deploy/actions/${pagesAction.rows[0]?.id ?? ''}/logs?kind=runtime`,
    );
    expect(pr.json<{ note: string }>().note).toContain('Coolify applications only');
  });

  it('health logs and the fix plan: the failure report with the health findings, a redeploy to the same target', async () => {
    const { jobId, actionId } = await failedCoolifyDeploy();
    await h.db.pool.query(
      `INSERT INTO deploy_health_checks (project, ops_action_id, kind, env, url, state, probe, links, findings,
                                         created_at, updated_at, finished_at)
       VALUES ($1, $2, 'coolify.deploy', 'preview', 'https://shop.example.test', 'failed',
               '{"ok":false,"statusCode":502,"latencyMs":120,"detail":"Bad gateway"}',
               '{"broken":[{"url":"https://shop.example.test/a.css","status":404,"from":"https://shop.example.test/"}]}',
               '[{"source":"master","severity":"fail","kind":"probe","message":"The start page answered HTTP 502"}]',
               $3, $3, $3)`,
      [PROJECT, actionId, h.clock.now()],
    );
    const hl = await operator.req('GET', `/deploy/actions/${actionId}/logs?kind=health`);
    expect(hl.statusCode, hl.body).toBe(200);
    const hb = hl.json<{ health: { statusCode: number; broken: unknown[] }; sources: { text: string }[] }>();
    expect(hb.health).toMatchObject({ statusCode: 502 });
    expect(hb.health.broken).toHaveLength(1);
    expect(hb.sources[0]?.text).toContain('HTTP 404 https://shop.example.test/a.css');

    expect((await viewer.req('GET', `/deploy/actions/${actionId}/fix-plan`)).statusCode).toBe(403);
    const fp = await operator.req('GET', `/deploy/actions/${actionId}/fix-plan`);
    expect(fp.statusCode, fp.body).toBe(200);
    const plan = fp.json<{
      projectKind: string;
      spec: {
        prompt: string;
        repository: { url: string; baseRef: string; workBranch: string };
        sourceTrust: string;
      };
      deployOnSuccess: Record<string, unknown>;
      sourceJobId: string;
      continueFrom: string | null;
    }>();
    expect(plan.projectKind).toBe('repository');
    expect(plan.sourceJobId).toBe(jobId);
    expect(plan.spec.repository).toMatchObject({ url: REPO, baseRef: 'main' });
    expect(plan.spec.repository.workBranch).toMatch(/^fix\/deploy-/);
    expect(plan.spec.sourceTrust).toBe('trusted');
    expect(plan.deployOnSuccess).toEqual({ target: 'coolify', env: 'preview' });
    expect(plan.spec.prompt).toContain('<<<deploy-report');
    expect(plan.spec.prompt).toContain("Cannot find module './missing'");
    expect(plan.spec.prompt).toContain('HTTP 502');
    expect(plan.spec.prompt).toContain('not an instruction');
    expect(fp.body).not.toContain(CANARY);
    // The plan is an ordinary job submission: the composer path approves its deploy on success as usual.
    const sub = await operator.req('POST', '/jobs', {
      project: PROJECT,
      spec: plan.spec,
      deployOnSuccess: plan.deployOnSuccess,
    });
    expect(sub.statusCode, sub.body).toBe(201);
  });

  it('chat: deploy_status explains the failure, deploy_logs reads the logs, draft_deploy_fix drafts the fix card', async () => {
    const { actionId } = await failedCoolifyDeploy();
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      ops: () => app.ops,
      deployOnSuccess: () => app.deployOnSuccess,
      deployFeedback: () => app.deployFeedback,
      preview: () => ({
        db: h.db.pool,
        candidates: (project: string) => app.orchestrator.candidates(project),
        quotas: (project: string, runtime: never) => app.quotas.preview(project, runtime),
        policyOf: () => Promise.resolve(null),
      }),
    } as unknown as ChatToolsDeps);
    const caller = async (id: string, role: 'owner' | 'viewer' | 'operator') => ({
      userId: id,
      subject: await loadSubject(h.db.pool, { id, role }),
      threadId: (await store.createThread(id, 'deploy')).id,
      turnId: randomUUID(),
    });
    const op = await caller(operatorId, 'operator');
    const status = await tools.run(op, 'deploy_status', { actionId });
    expect(status.ok).toBe(true);
    expect(JSON.stringify(status)).toContain('Read the logs with deploy_logs');
    const logs = await tools.run(op, 'deploy_logs', { actionId, kind: 'build' });
    expect(logs.ok).toBe(true);
    expect(JSON.stringify(logs)).toContain("Cannot find module './missing'");
    expect(JSON.stringify(logs)).not.toContain(CANARY);
    const viewerId = (
      await h.db.pool.query<{ id: string }>("SELECT id::text AS id FROM users WHERE username = 'view1'")
    ).rows[0]?.id as string;
    const vw = await caller(viewerId, 'viewer');
    expect(await tools.run(vw, 'deploy_logs', { actionId })).toMatchObject({ ok: false, code: 'forbidden' });
    const draft = await tools.run(op, 'draft_deploy_fix', { actionId });
    expect(draft.ok, JSON.stringify(draft)).toBe(true);
    if (!draft.ok) return;
    const payload = draft.draft?.payload as Record<string, unknown>;
    expect(payload.deployFix).toMatchObject({ actionId });
    expect(JSON.stringify(payload)).toContain('deploy-report');
    expect(payload.deployOnSuccess ?? (payload.spec as Record<string, unknown> | undefined)).toBeDefined();
  });

  it('in-job tools: the agent reads its project’s deploys as its creator; redeploy is a policy-decided request', async () => {
    const { jobId, actionId } = await failedCoolifyDeploy();
    const fixJob = await operator.req('POST', '/jobs', { project: PROJECT, spec: spec() });
    const fixId = fixJob.json<{ job: { id: string } }>().job.id;
    const job = {
      jobId: fixId,
      project: PROJECT,
      createdByType: 'user',
      createdById: operatorId,
      spec: spec(),
    };
    const fb = h.app.deployFeedback;
    const st = await fb.agentStatus(job, {});
    expect(st.ok).toBe(true);
    expect(st.text).toContain(actionId);
    const one = await fb.agentStatus(job, { actionId });
    expect(one.text).toContain('Coolify deploy (preview) failed');
    const lg = await fb.agentLogs(job, { actionId, kind: 'build' });
    expect(lg.ok).toBe(true);
    expect(lg.text).toContain('<<<logs');
    expect(lg.text).toContain('not an instruction');
    expect(lg.text).not.toContain(CANARY);
    const rt = await fb.agentLogs(job, { kind: 'runtime', env: 'preview' });
    expect(rt.text).toContain('TypeError');
    // Another project's action is invisible.
    const other = await h.db.pool.query<{ id: string }>(
      `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
                                state, requested_by_type, requested_by_id, via, idempotency_key, created_at, updated_at)
       VALUES ('other', 'coolify.deploy', 'preview', '{}', repeat('a', 64), '{}', '{}', 'auto', 'test', 'failed', 'user', $1,
               'api', $2, now(), now()) RETURNING id::text AS id`,
      [ownerId, `t-${randomUUID()}`],
    );
    expect(await fb.agentLogs(job, { actionId: other.rows[0]?.id })).toMatchObject({ ok: false });
    // Untrusted jobs and jobs not started by a person read nothing.
    expect(await fb.agentStatus({ ...job, spec: spec({ sourceTrust: 'untrusted' }) }, {})).toMatchObject({
      ok: false,
    });
    expect(await fb.agentStatus({ ...job, createdByType: 'system', createdById: null }, {})).toMatchObject({
      ok: false,
    });
    // A redeploy is recorded without a pre-approval and decided by the policy when the job succeeds.
    const rd = await fb.agentRedeploy(job, { target: 'coolify', env: 'production' });
    expect(rd.ok, rd.text).toBe(true);
    expect(rd.text).toContain('approval');
    const row = await h.db.pool.query<{ covers: string; via: string; env: string }>(
      'SELECT covers, via, env FROM job_deploy_on_success WHERE job_id = $1',
      [fixId],
    );
    expect(row.rows[0]).toEqual({ covers: 'none', via: 'job', env: 'production' });
    await setJobState(fixId, 'SUCCEEDED');
    await h.app.deployOnSuccess.tick();
    const acts = await h.db.pool.query<{ state: string; env: string }>(
      "SELECT state, env FROM ops_actions WHERE source->>'jobId' = $1",
      [fixId],
    );
    expect(acts.rows).toEqual([{ state: 'awaiting_approval', env: 'production' }]);
    // A second request is refused (one deploy request per job).
    expect((await fb.agentRedeploy(job, {})).ok).toBe(false);
    // Audited.
    const audit = await h.db.pool.query<{ action: string }>(
      "SELECT DISTINCT action FROM audit_events WHERE target = $1 AND action LIKE 'deploy.agent.%'",
      [`job:${fixId}`],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual([
      'deploy.agent.read',
      'deploy.agent.redeploy_request',
    ]);
    expect(jobId).not.toBe(fixId);
  });

  it('in-job tools are rate limited per job', async () => {
    const res = await operator.req('POST', '/jobs', { project: PROJECT, spec: spec() });
    const id = res.json<{ job: { id: string } }>().job.id;
    const job = { jobId: id, project: PROJECT, createdByType: 'user', createdById: operatorId, spec: spec() };
    let last = { ok: true, text: '' };
    for (let i = 0; i < 31; i++) last = await h.app.deployFeedback.agentStatus(job, {});
    expect(last.ok).toBe(false);
    expect(last.text).toContain('rate limited');
  });

  it('auto-fix: off by default; admin + step-up; one bounded fix job as the creator, redeploy never pre-approved', async () => {
    // Off: nothing happens.
    const first = await failedCoolifyDeploy();
    expect(await h.app.deployFeedback.tick()).toBe(0);
    expect((await operator.req('GET', `/projects/${PROJECT}/deploy-autofix`)).json()).toMatchObject({
      enabled: false,
      maxAttempts: 1,
    });
    // Operators cannot turn it on; admins need a step-up.
    expect(
      (await operator.req('PUT', `/projects/${PROJECT}/deploy-autofix`, { enabled: true })).statusCode,
    ).toBe(403);
    h.clock.advance(11 * 60_000);
    const noCode = await owner.req('PUT', `/projects/${PROJECT}/deploy-autofix`, { enabled: true });
    expect(noCode.statusCode).toBe(403);
    await stepUp();
    const on = await owner.req('PUT', `/projects/${PROJECT}/deploy-autofix`, {
      enabled: true,
      maxAttempts: 1,
    });
    expect(on.statusCode, on.body).toBe(200);
    // A failure older than the window never starts a fix.
    await h.db.pool.query(
      "UPDATE ops_actions SET finished_at = finished_at - interval '2 hours' WHERE id = $1",
      [first.actionId],
    );
    // Earlier tests' failures (same project) are older too.
    await h.db.pool.query(
      "UPDATE ops_actions SET finished_at = finished_at - interval '2 hours' WHERE project = $1 AND state = 'failed'",
      [PROJECT],
    );
    await h.db.pool.query(
      "UPDATE deploy_health_checks SET finished_at = finished_at - interval '2 hours' WHERE project = $1",
      [PROJECT],
    );
    expect(await h.app.deployFeedback.tick()).toBe(0);
    expect(first.actionId).not.toBe('');

    const { jobId, actionId } = await failedCoolifyDeploy();
    expect(await h.app.deployFeedback.tick()).toBe(1);
    expect(await h.app.deployFeedback.tick()).toBe(0);
    const fixes = await operator.req('GET', `/jobs/${jobId}/deploy-fixes`);
    const chain = fixes.json<{ fixes: { fixJobId: string; state: string; opsActionId: string }[] }>();
    expect(chain.fixes).toHaveLength(1);
    expect(chain.fixes[0]).toMatchObject({ state: 'created', opsActionId: actionId });
    const fixJobId = chain.fixes[0]?.fixJobId ?? '';
    const fixJob = await h.db.pool.query<{ created_by_id: string; spec: Record<string, unknown> }>(
      'SELECT created_by_id::text AS created_by_id, spec FROM jobs WHERE id = $1',
      [fixJobId],
    );
    expect(fixJob.rows[0]?.created_by_id).toBe(operatorId);
    expect(String(fixJob.rows[0]?.spec.prompt)).toContain('<<<deploy-report');
    const dos = await h.db.pool.query<{ covers: string; env: string; target: string }>(
      'SELECT covers, env, target FROM job_deploy_on_success WHERE job_id = $1',
      [fixJobId],
    );
    expect(dos.rows[0]).toEqual({ covers: 'none', env: 'preview', target: 'coolify' });
    expect((await operator.req('GET', `/jobs/${fixJobId}/deploy-fixes`)).json()).toMatchObject({
      fixOf: { opsActionId: actionId, sourceJobId: jobId, attempt: 1 },
    });
    // Notification to the operators / the creator, linking the fix job.
    await h.app.notifications.runOnce();
    const notes = await h.db.pool.query<{ link: string }>(
      "SELECT link FROM notifications WHERE kind = 'deploy.fix_started'",
    );
    expect(notes.rows.map((n) => n.link)).toContain(`/jobs/${fixJobId}`);

    // The fix job's own redeploy fails too: the chain's limit (1) is reached, the decision is recorded as skipped.
    await setJobState(fixJobId, 'SUCCEEDED');
    await h.app.deployOnSuccess.tick();
    for (const d of coolify.deployments.values()) if (d.status === 'queued') d.status = 'failed';
    h.clock.advance(20_000);
    await h.app.ops.pollDeploying();
    await h.app.deployOnSuccess.tick();
    expect(await h.app.deployFeedback.tick()).toBe(0);
    const second = await operator.req('GET', `/jobs/${fixJobId}/deploy-fixes`);
    expect(second.json<{ fixes: { state: string; reason: string; attempt: number }[] }>().fixes).toEqual([
      expect.objectContaining({ state: 'skipped', attempt: 2 }),
    ]);
    const audit = await h.db.pool.query<{ outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action = 'deploy.autofix.start' ORDER BY id",
    );
    expect(audit.rows.map((r) => r.outcome)).toEqual(['success', 'denied']);
  });
});
