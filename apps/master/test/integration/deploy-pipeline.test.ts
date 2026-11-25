import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/index.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-deploy-pipeline (ADR-0028 phase 2) against a real master and fake Coolify / Cloudflare: automation deploy
 * targets (run → ops action → status polling → run outcome), deploy notifications (waiting / failed), a workflow's
 * deploy step after its verifier, static site bundles (commit, Pages deploy from the bundle, flagged bundles refused).
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const REPO = 'https://github.com/acme/shop.git';

const coolify = new FakeCoolify();
const cf = new FakeCloudflare();
const h = new Harness();
let owner: Client;
let ownerSecret = '';
let ownerId = '';
let adminId = '';

async function stepUp(): Promise<void> {
  h.clock.advance(30_000);
  expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
}

async function automation(target: Record<string, unknown>) {
  await stepUp();
  return owner.req('POST', '/automations', {
    project: PROJECT,
    name: `deploy ${randomUUID().slice(0, 6)}`,
    trigger: { kind: 'cron', cron: '0 3 * * *' },
    target,
  });
}

async function runNow(id: string) {
  await stepUp();
  const res = await owner.req('POST', `/automations/${id}/run`);
  expect(res.statusCode, res.body).toBeLessThan(300);
  const run = await h.db.pool.query<{
    id: string;
    state: string;
    ops_action_id: string | null;
    reason: string | null;
  }>(
    'SELECT id, state, ops_action_id::text AS ops_action_id, reason FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [id],
  );
  return run.rows[0];
}

const action = async (id: string) =>
  (
    await h.db.pool.query<{
      state: string;
      via: string;
      source: Record<string, unknown>;
      requested_by_id: string;
    }>('SELECT state, via, source, requested_by_id FROM ops_actions WHERE id = $1', [id])
  ).rows[0];

describeIntegration(
  'deploy pipeline: automations, workflow deploy steps, site bundles (integration)',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await coolify.start();
      await cf.start();
      await h.start({
        ops: { internalOrigins: [coolify.base, cf.base], cloudflareApi: `${cf.base}/client/v4` },
      });
      ownerId = await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      adminId = await h.createUser('admin1', PW, 'admin');
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())`,
        [PROJECT, REPO, ownerId],
      );
      coolify.addApp({ uuid: 'shopprev01', name: 'shop-preview' });
      coolify.addApp({ uuid: 'shopprod01', name: 'shop-prod' });
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
      const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: {
          coolify: { preview: { uuids: ['shopprev01'] }, production: { uuids: ['shopprod01'] } },
          pages: { projectName: 'shop-site' },
        },
      });
      expect(t.statusCode, t.body).toBe(200);
    });
    afterAll(async () => {
      await h.stop();
      await coolify.stop();
      await cf.stop();
    });

    it('an automation deploy target requests the ops action; polling ends the action and the run', async () => {
      const created = await automation({
        kind: 'deploy',
        action: 'coolify.deploy',
        params: { env: 'preview' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const a = created.json<{
        automation: { id: string; target: { kind: string; deployAction: unknown } };
      }>().automation;
      expect(a.target).toMatchObject({
        kind: 'deploy',
        deployAction: { kind: 'coolify.deploy', params: { env: 'preview' } },
      });
      coolify.reset();
      const run = await runNow(a.id);
      expect(run).toMatchObject({ state: 'running' });
      const act = await action(run?.ops_action_id ?? '');
      expect(act).toMatchObject({
        state: 'deploying',
        via: 'automation',
        requested_by_id: `automation:${a.id}`,
        source: { automationId: a.id, runId: run?.id, runAs: ownerId },
      });
      expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=shopprev01']);
      for (const d of coolify.deployments.values()) d.status = 'finished';
      h.clock.advance(20_000);
      expect(await h.app.ops.pollDeploying()).toBe(1);
      expect((await action(run?.ops_action_id ?? ''))?.state).toBe('succeeded');
      await h.app.automations.syncRuns();
      const after = await h.db.pool.query<{ state: string }>(
        'SELECT state FROM automation_runs WHERE id = $1',
        [run?.id],
      );
      expect(after.rows[0]?.state).toBe('succeeded');
    });

    it('refuses a deploy target the project cannot take, and parameters taken from nowhere', async () => {
      await h.db.pool.query(
        `UPDATE project_deploy_targets SET config = jsonb_set(config, '{coolify,production}', 'null') WHERE project = $1`,
        [PROJECT],
      );
      const bad = await automation({
        kind: 'deploy',
        action: 'coolify.deploy',
        params: { env: 'production' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).toContain('No Coolify production target');
      const junk = await automation({
        kind: 'deploy',
        action: 'coolify.deploy',
        params: { env: 'preview', url: 'x' },
      });
      expect(junk.statusCode).toBe(400);
      await h.db.pool.query(
        `UPDATE project_deploy_targets SET config = jsonb_set(config, '{coolify,production}', '{"uuids":["shopprod01"],"tags":[]}') WHERE project = $1`,
        [PROJECT],
      );
    });

    it('a production deploy from an automation waits for approval and notifies the approvers; a failure notifies operators', async () => {
      const created = await automation({
        kind: 'deploy',
        action: 'coolify.deploy',
        params: { env: 'production' },
      });
      const id = created.json<{ automation: { id: string } }>().automation.id;
      const run = await runNow(id);
      const act = await action(run?.ops_action_id ?? '');
      expect(act?.state).toBe('awaiting_approval');
      await h.app.notifications.runOnce();
      const waiting = await h.db.pool.query<{ user_id: string; link: string }>(
        "SELECT recipient_id::text AS user_id, link FROM notifications WHERE kind = 'deploy.waiting'",
      );
      expect(waiting.rows.map((r) => r.user_id).sort()).toEqual([adminId, ownerId].sort());
      expect(waiting.rows[0]?.link).toBe(`/deploys/${run?.ops_action_id ?? ''}`);

      // A preview deploy whose Coolify call fails: the action and the run fail, operators are told.
      const p = await automation({ kind: 'deploy', action: 'coolify.restart', params: { env: 'preview' } });
      coolify.failNext = { status: 500, match: /restart/ };
      const failedRun = await runNow(p.json<{ automation: { id: string } }>().automation.id);
      expect((await action(failedRun?.ops_action_id ?? ''))?.state).toBe('failed');
      await h.app.automations.syncRuns();
      const fr = await h.db.pool.query<{ state: string; reason: string }>(
        'SELECT state, reason FROM automation_runs WHERE id = $1',
        [failedRun?.id],
      );
      expect(fr.rows[0]).toMatchObject({ state: 'failed', reason: 'The deploy ended failed.' });
      await h.app.notifications.runOnce();
      const failed = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notifications WHERE kind = 'deploy.failed' AND link = $1",
        [`/deploys/${failedRun?.ops_action_id ?? ''}`],
      );
      expect(failed.rows[0]?.n).toBeGreaterThan(0);
    });

    it('a workflow deploy step runs after its verifier succeeded (as the workflow, with the creator recorded)', async () => {
      const definition = {
        name: 'ship',
        defaults: {
          runtime: 'codex',
          sandboxProfile: 'container',
          sourceTrust: 'trusted',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 600 },
          repository: { url: REPO, baseRef: 'main' },
        },
        nodes: [
          { id: 'build', role: 'executor', prompt: 'Build it.' },
          {
            id: 'check',
            role: 'verifier',
            prompt: 'Check it.',
            deploy: { kind: 'coolify.deploy', env: 'preview' },
          },
        ],
        edges: [{ from: 'build', to: 'check' }],
      };
      // Validation: a deploy step only on a verifier / integrator, Pages only with a site bundle.
      const wrong = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          ...definition,
          nodes: [
            { ...definition.nodes[0], deploy: { kind: 'coolify.deploy', env: 'preview' } },
            definition.nodes[1],
          ],
        },
      });
      expect(wrong.statusCode).toBe(400);
      const pages = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          ...definition,
          nodes: [definition.nodes[0], { ...definition.nodes[1], deploy: { kind: 'pages.deploy' } }],
        },
      });
      expect(pages.statusCode).toBe(400);
      const def = await owner.req('POST', '/workflows', { project: PROJECT, definition });
      expect(def.statusCode, def.body).toBe(201);
      const started = await owner.req('POST', `/workflows/${def.json<{ id: string }>().id}/runs`, {
        inputs: {},
      });
      expect(started.statusCode, started.body).toBe(201);
      const runId = started.json<{ runId: string }>().runId;
      coolify.reset();
      // No workers here: finish each node's job directly, then let the engine progress.
      for (const node of ['build', 'check']) {
        await h.app.workflows.progress();
        const j = await h.db.pool.query<{ job_id: string }>(
          'SELECT job_id::text AS job_id FROM workflow_job_links WHERE run_id = $1 AND node_id = $2',
          [runId, node],
        );
        await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [
          j.rows[0]?.job_id,
        ]);
        await h.app.workflows.progress();
      }
      const acts = await h.db.pool.query<{
        state: string;
        via: string;
        source: Record<string, unknown>;
        requested_by_id: string;
      }>("SELECT state, via, source, requested_by_id FROM ops_actions WHERE via = 'workflow'");
      expect(acts.rows).toEqual([
        {
          state: 'deploying',
          via: 'workflow',
          requested_by_id: `workflow:${runId}`,
          source: { workflowRunId: runId, nodeId: 'check', createdBy: ownerId },
        },
      ]);
      expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=shopprev01']);
      const audit = await h.db.pool.query<{ outcome: string }>(
        "SELECT outcome FROM audit_events WHERE action = 'workflow.deploy.request' AND target = $1",
        [`workflow-run:${runId}`],
      );
      expect(audit.rows.map((r) => r.outcome)).toEqual(['success']);
      // Idempotent: another progress pass does not deploy twice.
      await h.app.workflows.progress();
      expect(coolify.calls(/POST/)).toHaveLength(1);
    });

    it('site bundles: committed as kind "site" (never listed), published by pages.deploy; flagged bundles refused', async () => {
      const audit = new AuditLog(h.db.pool, h.clock.now);
      const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
      const { job } = await jobs.create({
        project: PROJECT,
        actor: { type: 'user', id: ownerId },
        submit: true,
        spec: {
          runtime: 'codex',
          prompt: 'Build the site',
          repository: { url: REPO, baseRef: 'main', workBranch: 'rac/site' },
          siteBundle: { directory: 'dist' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 600 },
        },
      });
      const file = Buffer.from('<!doctype html><h1>Shop</h1>');
      const bundle = Buffer.from(
        JSON.stringify({
          version: 1,
          directory: 'dist',
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
      const ws = new WorkspaceService({ pool: h.db.pool, audit, clock: h.clock.now, log: h.app.log });
      const attemptId = randomUUID();
      const stage = await ws.stageChunk(
        h.db.pool,
        job.id,
        { attemptId, artifactId: 'ws-site-bundle', index: 0, data: bundle.toString('base64') },
        h.clock.now(),
      );
      expect(stage).toBe('ok');
      const committed = await ws.commitArtifact(
        h.db.pool,
        job.id,
        {
          attemptId,
          artifactId: 'ws-site-bundle',
          name: 'site-bundle.json',
          mediaType: 'application/json',
          sizeBytes: bundle.length,
          sha256: createHash('sha256').update(bundle).digest('hex'),
        },
        h.clock.now(),
      );
      expect(committed).toBe('ok');
      expect((await ws.listArtifacts(job.id)).artifacts).toEqual([]);
      expect(await ws.artifactContent(job.id, 'ws-site-bundle')).toBeNull();
      await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [
        job.id,
      ]);
      cf.reset();
      await stepUp();
      const res = await owner.req('POST', '/deploy/actions', {
        project: PROJECT,
        kind: 'pages.deploy',
        params: { jobId: job.id },
        idempotencyKey: `k-${randomUUID()}`,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        state: 'deploying',
        diff: { source: 'site-bundle', files: [{ path: 'index.html' }] },
      });
      expect(cf.requests.at(-1)?.body).toContain('"/index.html"');
      // A bundle the master's own scan flags is never published.
      await h.db.pool.query("UPDATE job_artifacts SET redacted = true WHERE job_id = $1 AND kind = 'site'", [
        job.id,
      ]);
      const flagged = await owner.req('POST', '/deploy/actions', {
        project: PROJECT,
        kind: 'pages.deploy',
        params: { jobId: job.id },
        idempotencyKey: `k-${randomUUID()}`,
      });
      expect(flagged.statusCode).toBe(409);
      expect(flagged.body).toContain('artifacts_redacted');
      // A bundle with a wrong per-file hash is refused at commit.
      const bad = Buffer.from(
        bundle.toString().replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${'0'.repeat(64)}"`),
      );
      const a2 = randomUUID();
      await ws.stageChunk(
        h.db.pool,
        job.id,
        { attemptId: a2, artifactId: 'ws-site-bundle', index: 0, data: bad.toString('base64') },
        h.clock.now(),
      );
      expect(
        await ws.commitArtifact(
          h.db.pool,
          job.id,
          {
            attemptId: a2,
            artifactId: 'ws-site-bundle',
            name: 'site-bundle.json',
            mediaType: 'application/json',
            sizeBytes: bad.length,
            sha256: createHash('sha256').update(bad).digest('hex'),
          },
          h.clock.now(),
        ),
      ).toBe('invalid');
    });
  },
);
