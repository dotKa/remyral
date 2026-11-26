import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p22-vault-projects (docs/design/p22-vault-projects.md): a workflow HTTP / SMTP vault credential limited to some
 * projects, on real Postgres and the real master routes. `projects: null` keeps today's behaviour (every project); an
 * allowlist is enforced at workflow save, at shared-workflow slot binding, when the run builds the function job and
 * when that job is dispatched — an allowlist narrowed after the save wins at run time. The vault route validates and
 * audits the change and needs the vault's always-fresh step-up.
 */

const PW = 'quartz-meadow-lantern-7';
const A = 'vp-alpha';
const B = 'vp-beta';
const HOST = 'api.example.test';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};
type Node = Record<string, unknown>;
const http = (id: string, credential: string): Node => ({
  id,
  type: 'http.request',
  config: {
    origin: `https://${HOST}`,
    path: '/hook',
    method: 'GET',
    auth: { credential, placement: 'bearer' },
  },
});
const doc = (name: string, credential: string) => ({
  schemaVersion: 2,
  name,
  defaults: DEFAULTS,
  nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, http('call', credential)],
  edges: [{ from: 'start', to: 'call' }],
});
interface View {
  id: string;
  projects: string[] | null;
}

describeIntegration(
  'vault credentials bound to projects (integration, p22-vault-projects)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let secret: string;

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
      await h.createUser('owner1', PW);
      secret = (await enroll(h, 'owner1', PW)).secret;
      for (const p of [A, B])
        await h.db.pool.query(
          "INSERT INTO projects (id, name, created_at, kind) VALUES ($1, $1, now(), 'workspace') ON CONFLICT DO NOTHING",
          [p],
        );
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at, allowed_hosts)
       VALUES ('vp-open', 'Open token', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $1),
              ('vp-alpha-only', 'Alpha token', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $1),
              ('vp-narrowed', 'Narrowed later', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $1),
              ('vp-dispatch', 'Narrowed at dispatch', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $1),
              ('vp-generic', 'Generic', 'generic', 'SOME_TOKEN', 1, 'active', now(), now(), NULL)`,
        [[HOST]],
      );
    });
    afterAll(async () => {
      await h.stop();
    });
    beforeEach(async () => {
      owner = await fullLogin(h, 'owner1', PW, secret);
    });

    async function stepUp(): Promise<void> {
      h.clock.advance(31_000);
      const res = await owner.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode, res.body).toBe(200);
    }
    async function setProjects(id: string, projects: string[] | null) {
      await stepUp();
      return owner.req('PATCH', `/vault/credentials/${id}`, { projects });
    }
    async function define(project: string, d: Record<string, unknown>) {
      await stepUp();
      return owner.req('POST', '/workflows', { project, definition: d });
    }
    const progress = async (times = 3) => {
      for (let i = 0; i < times; i++) await h.app.workflows.progress();
    };
    async function callNode(runId: string) {
      const res = await owner.req('GET', `/workflows/runs/${runId}/node-runs?limit=100&node=call`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ nodeRuns: { state: string; error: { code: string } | null }[] }>().nodeRuns.at(-1);
    }
    async function fnJobs(runId: string) {
      const { rows } = await h.db.pool.query<{ id: string; state: string }>(
        `SELECT j.id, j.state::text AS state FROM workflow_node_run_jobs l
         JOIN workflow_node_runs nr ON nr.id = l.node_run_id JOIN jobs j ON j.id = l.job_id
        WHERE nr.run_id = $1 AND nr.node_id = 'call' ORDER BY l.created_at`,
        [runId],
      );
      return rows;
    }
    async function audits(action: string, outcome: string) {
      const { rows } = await h.db.pool.query<{ target: string; metadata: Record<string, unknown> }>(
        'SELECT target, metadata FROM audit_events WHERE action = $1 AND outcome = $2 ORDER BY occurred_at, id',
        [action, outcome],
      );
      return rows;
    }

    describe('the vault route', () => {
      it('lists null for every existing credential; sets, validates, audits and resets the allowlist (step-up)', async () => {
        const list = await owner.req('GET', '/vault/credentials');
        expect(list.statusCode, list.body).toBe(200);
        for (const c of list.json<{ items: View[] }>().items) expect(c.projects).toBeNull();
        // The vault's always-fresh step-up.
        h.clock.advance(11 * 60_000);
        const stale = await owner.req('PATCH', '/vault/credentials/vp-alpha-only', { projects: [A] });
        expect(stale.statusCode, stale.body).toBe(403);
        expect(stale.json<{ error: string }>().error).toBe('step_up_required');
        // Unknown projects, other kinds and an empty list are refused.
        const unknown = await setProjects('vp-alpha-only', [A, 'no-such-project']);
        expect(unknown.statusCode, unknown.body).toBe(400);
        expect(unknown.json<{ issues: { path: string; code: string }[] }>().issues).toEqual([
          { path: 'projects', code: 'unknown_project' },
        ]);
        const generic = await setProjects('vp-generic', [A]);
        expect(generic.statusCode, generic.body).toBe(400);
        expect(generic.json<{ issues: { code: string }[] }>().issues[0]?.code).toBe('not_allowed');
        expect((await setProjects('vp-alpha-only', [])).statusCode).toBe(400);
        const set = await setProjects('vp-alpha-only', [A, A]);
        expect(set.statusCode, set.body).toBe(200);
        expect(set.json<View>().projects).toEqual([A]);
        const audit = await audits('vault.credential.projects', 'success');
        expect(audit.at(-1)).toMatchObject({
          target: 'vp-alpha-only',
          metadata: { before: 'all', after: [A] },
        });
        // Back to every project and again.
        const reset = await setProjects('vp-narrowed', null);
        expect(reset.statusCode, reset.body).toBe(200);
        expect(reset.json<View>().projects).toBeNull();
      });
    });

    describe('workflow save', () => {
      it('null = every project; an allowlist refuses the save in another project (audited)', async () => {
        expect((await define(B, doc('open-b', 'vp-open'))).statusCode).toBe(201);
        expect((await define(A, doc('alpha-a', 'vp-alpha-only'))).statusCode).toBe(201);
        const refused = await define(B, doc('alpha-b', 'vp-alpha-only'));
        expect(refused.statusCode, refused.body).toBe(400);
        const body = refused.json<{ error: string; issues: { path: string; code: string }[] }>();
        expect(body.error).toBe('invalid_workflow');
        expect(body.issues).toContainEqual({
          path: 'nodes.1.config.auth.credential',
          code: 'credential_not_allowed_for_project',
        });
        const audit = await audits('workflow.define', 'denied');
        expect(audit.at(-1)?.metadata).toMatchObject({
          project: B,
          denial: 'credential_not_allowed_for_project',
        });
      });
    });

    describe('shared-workflow slot binding', () => {
      it('B cannot bind a credential limited to A; a credential for every project binds', async () => {
        await stepUp();
        const created = await owner.req('POST', '/workflows', {
          project: A,
          definition: doc('shared', 'vp-open'),
        });
        expect(created.statusCode, created.body).toBe(201);
        const id = created.json<{ id: string }>().id;
        await stepUp();
        expect((await owner.req('PUT', `/workflows/${id}/sharing`, { projects: [B] })).statusCode).toBe(200);
        await stepUp();
        const att = await owner.req('POST', `/projects/${B}/workflow-attachments`, {
          ownerProject: A,
          name: 'shared',
        });
        expect(att.statusCode, att.body).toBe(201);
        const attachmentId = att.json<{ attachment: { id: string } }>().attachment.id;
        await stepUp();
        const refused = await owner.req('PUT', `/workflow-attachments/${attachmentId}/credentials/vp-open`, {
          credentialId: 'vp-alpha-only',
        });
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json<{ error: string }>().error).toBe('credential_not_allowed_for_project');
        const audit = await audits('workflow.attachment.credential', 'denied');
        expect(audit.at(-1)?.metadata).toMatchObject({
          project: B,
          slot: 'vp-open',
          boundVaultId: 'vp-alpha-only',
          denial: 'credential_not_allowed_for_project',
        });
        await stepUp();
        const bound = await owner.req('PUT', `/workflow-attachments/${attachmentId}/credentials/vp-open`, {
          credentialId: 'vp-open',
        });
        expect(bound.statusCode, bound.body).toBe(200);
      });
    });

    describe('run time', () => {
      it('an allowlist narrowed after the save fails the node at its next run; no function job is created', async () => {
        const created = await define(A, doc('narrowed', 'vp-narrowed'));
        expect(created.statusCode, created.body).toBe(201);
        const id = created.json<{ id: string }>().id;
        expect((await setProjects('vp-narrowed', [B])).statusCode).toBe(200);
        const run = await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} });
        expect(run.statusCode, run.body).toBe(201);
        const runId = run.json<{ runId: string }>().runId;
        await progress();
        expect((await callNode(runId))?.error?.code).toBe('credential_not_allowed_for_project');
        expect(await fnJobs(runId)).toEqual([]);
        const audit = await audits('vault.credential.use', 'denied');
        expect(audit.at(-1)).toMatchObject({
          target: `workflow-run:${runId}`,
          metadata: { project: A, nodeId: 'call', denial: 'credential_not_allowed_for_project' },
        });
      });

      it('a queued function job whose credential was narrowed meanwhile is never dispatched (audited)', async () => {
        const created = await define(A, doc('dispatch', 'vp-dispatch'));
        expect(created.statusCode, created.body).toBe(201);
        const run = await owner.req('POST', `/workflows/${created.json<{ id: string }>().id}/runs`, {
          inputs: {},
        });
        expect(run.statusCode, run.body).toBe(201);
        const runId = run.json<{ runId: string }>().runId;
        await progress();
        const [job] = await fnJobs(runId);
        expect(job?.state).toBe('QUEUED');
        expect((await setProjects('vp-dispatch', [B])).statusCode).toBe(200);
        expect(await h.app.orchestrator.dispatch(job?.id ?? '')).toBe('infeasible');
        expect((await fnJobs(runId))[0]?.state).toBe('FAILED');
        const audit = await audits('job.credential.issue', 'denied');
        expect(audit.at(-1)).toMatchObject({
          target: `job:${job?.id ?? ''}`,
          metadata: {
            kind: 'vault',
            project: A,
            vaultId: 'vp-dispatch',
            denial: 'credential_not_allowed_for_project',
          },
        });
        // The node reads the refusal as its error (not a retryable "no worker").
        await progress();
        expect((await callNode(runId))?.error?.code).toBe('credential_not_allowed_for_project');
      });
    });
  },
);
