import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p13-multi-coolify (ADR-0050) against a real master and TWO fake Coolify servers: the p6 integration as the default
 * connection, an external connection with its own token, per-connection deploy / status / logs / rollback, the
 * control-plane deny-list on every connection, project ↔ connection authorization, SSRF rules, uptime monitors, chat
 * tools, SSO links and audit — and no token in any response, log or audit row.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const OTHER = 'other';
const CONSOLE = 'https://console.example.org';

const server = new FakeCoolify();
const external = new FakeCoolify();
external.token = 'coolify-canary-token-2|ExTeRnAl0123456789QwE';
let h: Harness;
let owner: Client;
let ownerSecret = '';
let operator: Client;
let operatorId = '';
let externalId = '';
let defaultId = '';
const bodies: string[] = [];

type Conn = {
  id: string;
  label: string;
  isDefault: boolean;
  allProjects: boolean;
  projects: string[];
  usedBy: { project: string; envs: string[] }[];
  controlPlane: boolean;
  lastTest: Record<string, unknown> | null;
};
type Action = {
  id: string;
  state: string;
  target: Record<string, unknown>;
  diff: Record<string, unknown>;
  policy: { decision: string; reason: string };
  rollbackAvailable: boolean;
};

async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
  const res = await c.req(method, url, body);
  bodies.push(res.body);
  return res;
}

async function stepUp(): Promise<void> {
  h.clock.advance(30_000);
  expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
}

async function deploy(c: Client, env: 'preview' | 'production', project = PROJECT) {
  return call(c, 'POST', '/deploy/actions', {
    project,
    kind: 'coolify.deploy',
    params: { env },
    idempotencyKey: `k-${randomUUID()}`,
  });
}

describeIntegration(
  'several Coolify connections (integration, p13-multi-coolify)',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await server.start();
      await external.start();
      h = new Harness();
      await h.start({
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          // OPS_PROTECTED_HOSTS: a second console host, protected like the PUBLIC_ORIGIN one.
          protectedHosts: ['console.example.org'],
          internalOrigins: [server.base, external.base],
          controlPlaneResources: ['remyralmaster01'],
          limits: { perProjectPer10Min: 60 },
        },
      });
      await h.createUser('owner1', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [PROJECT], 'operator');
      operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [OTHER],
      );

      server.addApp({ uuid: 'shopprev01', name: 'shop-preview' });
      server.addApp({ uuid: 'remyralmaster01', name: 'remyral-master', fqdn: CONSOLE });
      external.addApp({ uuid: 'extprod001', name: 'ext-prod', runtimeLogs: 'external runtime line' });
      external.addApp({
        uuid: 'extcopy001',
        name: 'console-copy',
        fqdn: `${CONSOLE},https://x.example.test`,
      });
      external.addApp({ uuid: 'remyralmaster01', name: 'same-uuid-elsewhere' });
    });
    afterAll(async () => {
      await h.stop();
      await server.stop();
      await external.stop();
    });

    it('the p6 integration is the default connection; a second connection needs a fresh code and the SSRF rules', async () => {
      await stepUp();
      const legacy = await call(owner, 'PUT', '/integrations/ops/coolify', {
        url: server.base,
        token: server.token,
      });
      expect(legacy.statusCode, legacy.body).toBe(200);
      const list = (await call(owner, 'GET', '/integrations/coolify/connections')).json<{ items: Conn[] }>()
        .items;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        label: 'Sunucu Coolify (varsayılan)',
        isDefault: true,
        allProjects: true,
      });
      defaultId = list[0]?.id ?? '';

      const body = {
        label: 'Harici Coolify',
        url: external.base,
        team: null,
        openUrl: 'https://coolify.external.example/',
        projects: [PROJECT],
        token: external.token,
      };
      h.clock.advance(11 * 60_000);
      expect((await call(owner, 'POST', '/integrations/coolify/connections', body)).statusCode).toBe(403);
      await stepUp();
      for (const url of ['http://10.0.0.5:8000', 'https://127.0.0.1', 'https://u:p@coolify.example.com']) {
        const bad = await call(owner, 'POST', '/integrations/coolify/connections', { ...body, url });
        expect(bad.statusCode, url).toBe(400);
        expect(bad.json<{ error: string }>().error).toBe('invalid_url');
      }
      expect(
        (
          await call(owner, 'POST', '/integrations/coolify/connections', {
            ...body,
            openUrl: 'http://x.example',
          })
        ).statusCode,
      ).toBe(400);
      expect((await call(operator, 'POST', '/integrations/coolify/connections', body)).statusCode).toBe(403);
      const ok = await call(owner, 'POST', '/integrations/coolify/connections', body);
      expect(ok.statusCode, ok.body).toBe(200);
      const c = ok.json<Conn & Record<string, unknown>>();
      expect(c).toMatchObject({
        label: 'Harici Coolify',
        isDefault: false,
        allProjects: false,
        projects: [PROJECT],
      });
      expect(Object.keys(c)).not.toContain('token');
      externalId = c.id;
      expect((await call(owner, 'POST', '/integrations/coolify/connections', body)).statusCode).toBe(409);
      // Stored encrypted.
      const raw = await h.db.pool.query<{ secret: Buffer; secret_aad: string }>(
        'SELECT secret, secret_aad FROM coolify_connections WHERE id = $1',
        [externalId],
      );
      expect(raw.rows[0]?.secret.toString('utf8')).not.toContain(external.token);
      expect(raw.rows[0]?.secret_aad).toBe(`coolify-connection:${externalId}`);
      // The token is bound to its row: two rows' stored secrets swapped in the database decrypt for neither.
      const swap = () =>
        h.db.pool.query(
          `UPDATE coolify_connections c SET secret = o.secret, secret_aad = o.secret_aad
             FROM coolify_connections o WHERE c.id IN ($1, $2) AND o.id IN ($1, $2) AND o.id <> c.id`,
          [defaultId, externalId],
        );
      await swap();
      const swapped = (await call(owner, 'GET', '/integrations/coolify/connections')).json<{
        items: (Conn & { usable: boolean })[];
      }>().items;
      expect(swapped.map((x) => x.usable)).toEqual([false, false]);
      await swap();
      const back = (await call(owner, 'GET', '/integrations/coolify/connections')).json<{
        items: (Conn & { usable: boolean })[];
      }>().items;
      expect(back.map((x) => x.usable)).toEqual([true, true]);
    });

    it('Test connection per connection: the control-plane Coolify is flagged by what it serves', async () => {
      const a = (await call(owner, 'POST', `/integrations/coolify/connections/${defaultId}/test`)).json<
        Record<string, unknown>
      >();
      expect(a).toMatchObject({ ok: true, applications: 2, controlPlaneResources: 1 });
      const b = (await call(owner, 'POST', `/integrations/coolify/connections/${externalId}/test`)).json<
        Record<string, unknown>
      >();
      expect(b).toMatchObject({ ok: true, applications: 3 });
      expect(server.requests.every((r) => r.auth === `Bearer ${server.token}`)).toBe(true);
      expect(external.requests.every((r) => r.auth === `Bearer ${external.token}`)).toBe(true);
      const list = (await call(owner, 'GET', '/integrations/coolify/connections')).json<{ items: Conn[] }>()
        .items;
      // Both serve something on the deny-list (env uuid on both, console fqdn on the external one).
      expect(list.find((x) => x.id === defaultId)?.controlPlane).toBe(true);
    });

    it('deploy targets name a connection per environment; the project must be allowed to use it', async () => {
      await stepUp();
      const put = await call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: {
          coolify: {
            preview: { uuids: ['shopprev01'] },
            production: { connection: externalId, uuids: ['extprod001'] },
          },
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      const t = put.json<{ targets: { coolify: Record<string, { connection: string }> } }>().targets.coolify;
      expect(t.preview?.connection).toBe(defaultId);
      expect(t.production?.connection).toBe(externalId);
      // Another project may not use the external connection.
      const other = await call(owner, 'PUT', `/projects/${OTHER}/deploy-targets`, {
        targets: { coolify: { production: { connection: externalId, uuids: ['extprod001'] } } },
      });
      expect(other.statusCode).toBe(403);
      expect(other.json<{ error: string }>().error).toBe('coolify_connection_not_allowed');
      // The environment's control-plane uuids are refused on every connection.
      for (const connection of [defaultId, externalId]) {
        const cp = await call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
          targets: { coolify: { production: { connection, uuids: ['remyralmaster01'] } } },
        });
        expect(cp.statusCode).toBe(400);
        expect(cp.json<{ error: string }>().error).toBe('control_plane_resource');
      }
      const choices = (await call(operator, 'GET', `/projects/${PROJECT}/coolify-connections`)).json<{
        items: { id: string; label: string; host: string }[];
      }>().items;
      expect(choices.map((x) => x.label).sort()).toEqual(['Harici Coolify', 'Sunucu Coolify (varsayılan)']);
      expect(JSON.stringify(choices)).not.toContain('/api');
      const otherChoices = (await call(owner, 'GET', `/projects/${OTHER}/coolify-connections`)).json<{
        items: { id: string }[];
      }>().items;
      expect(otherChoices.map((x) => x.id)).toEqual([defaultId]);
      const list = (await call(owner, 'GET', '/integrations/coolify/connections')).json<{ items: Conn[] }>()
        .items;
      expect(list.find((x) => x.id === externalId)?.usedBy).toEqual([
        { project: PROJECT, envs: ['production'] },
      ]);
    });

    it('each environment deploys, polls, logs and rolls back on its own connection', async () => {
      server.reset();
      external.reset();
      const pv = (await deploy(operator, 'preview')).json<Action>();
      expect(pv.state).toBe('deploying');
      expect(pv.target.connection).toEqual({ id: defaultId, label: 'Sunucu Coolify (varsayılan)' });
      expect(server.calls(/POST \/api\/v1\/deploy/)).toEqual(['POST /api/v1/deploy?uuid=shopprev01']);
      expect(external.calls(/POST/)).toEqual([]);

      const prodRes = await deploy(operator, 'production');
      expect(prodRes.statusCode, prodRes.body).toBe(201);
      const prod = prodRes.json<Action>();
      expect(prod).toMatchObject({ state: 'awaiting_approval', diff: { connection: 'Harici Coolify' } });
      await stepUp();
      const ok = await call(owner, 'POST', `/deploy/actions/${prod.id}/approve`, {});
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<Action>().state).toBe('deploying');
      expect(external.calls(/POST \/api\/v1\/deploy/)).toEqual(['POST /api/v1/deploy?uuid=extprod001']);
      expect(server.calls(/POST \/api\/v1\/deploy/)).toEqual(['POST /api/v1/deploy?uuid=shopprev01']);

      // Both servers number their deployments dep1…: each action polls its own server.
      for (const d of external.deployments.values()) d.status = 'finished';
      const done = (await call(operator, 'POST', `/deploy/actions/${prod.id}/refresh`)).json<Action>();
      expect(done.state).toBe('succeeded');
      expect((await call(operator, 'POST', `/deploy/actions/${pv.id}/refresh`)).json<Action>().state).toBe(
        'deploying',
      );

      const build = await call(operator, 'GET', `/deploy/actions/${prod.id}/logs?kind=build`);
      expect(build.statusCode, build.body).toBe(200);
      const sources = build.json<{ sources: { label: string; text: string }[] }>().sources;
      expect(sources[0]?.label).toContain('Coolify «Harici Coolify» deployment');
      expect(sources[0]?.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      const runtime = await call(operator, 'GET', `/deploy/actions/${prod.id}/logs?kind=runtime`);
      expect(runtime.statusCode, runtime.body).toBe(200);
      expect(runtime.body).toContain('external runtime line');
      expect(external.calls(/\/logs/)).toEqual([
        'GET /api/v1/applications/extprod001/logs?lines=300&show_timestamps=true',
      ]);

      expect(done.rollbackAvailable).toBe(true);
      const rb = await call(operator, 'POST', `/deploy/actions/${prod.id}/rollback`, {
        idempotencyKey: `rb-${randomUUID()}`,
      });
      expect(rb.statusCode, rb.body).toBe(201);
      const back = rb.json<Action>();
      expect(back.target.connection).toMatchObject({ id: externalId });
      await stepUp();
      expect((await call(owner, 'POST', `/deploy/actions/${back.id}/approve`, {})).json<Action>().state).toBe(
        'deploying',
      );
      expect(external.calls(/rollback$/)).toEqual(['POST /api/v1/applications/extprod001/rollback']);
      expect(server.calls(/POST .*rollback/)).toEqual([]);
    });

    it('a resource serving the console host is refused on the external connection too', async () => {
      await stepUp();
      expect(
        (
          await call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
            targets: {
              coolify: {
                preview: { uuids: ['shopprev01'] },
                production: { connection: externalId, uuids: ['extcopy001'] },
              },
            },
          })
        ).statusCode,
      ).toBe(200);
      const r = (await deploy(operator, 'production')).json<Action>();
      expect(r.state).toBe('refused');
      expect(r.policy.reason).toContain('console host');
      await stepUp();
      await call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: {
          coolify: {
            preview: { uuids: ['shopprev01'] },
            production: { connection: externalId, uuids: ['extprod001'] },
          },
        },
      });
    });

    it('uptime monitors check through the project’s connection; another project may not use it', async () => {
      const m = await call(operator, 'POST', '/uptime/monitors', {
        project: PROJECT,
        name: 'ext prod',
        type: 'coolify',
        config: { uuid: 'extprod001' },
      });
      expect(m.statusCode, m.body).toBe(201);
      const mon = m.json<{ id: string; config: { connection: string }; coolifyConnection: string }>();
      expect(mon.config.connection).toBe(externalId);
      expect(mon.coolifyConnection).toBe('Harici Coolify');
      external.reset();
      const chk = await call(operator, 'POST', `/uptime/monitors/${mon.id}/check`);
      expect(chk.statusCode, chk.body).toBe(200);
      expect(external.calls(/GET \/api\/v1\/applications\/extprod001$/)).toHaveLength(1);
      const bad = await call(owner, 'POST', '/uptime/monitors', {
        project: OTHER,
        name: 'sneaky',
        type: 'coolify',
        config: { uuid: 'extprod001', connection: externalId },
      });
      expect(bad.statusCode).toBe(400);
    });

    it('chat tools name the Coolify by label and never see a token', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        ops: () => h.app.ops,
      } as unknown as ChatToolsDeps);
      const thread = await store.createThread(operatorId, 'deploys');
      const c: ToolCaller = {
        userId: operatorId,
        subject: await loadSubject(h.db.pool, { id: operatorId, role: 'operator' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
      const status = await tools.run(c, 'deploy_status', { project: PROJECT });
      expect(status.ok).toBe(true);
      expect(status.ok ? status.data : null).toMatchObject({
        coolifyConnections: { preview: 'Sunucu Coolify (varsayılan)', production: 'Harici Coolify' },
      });
      const draft = await tools.run(c, 'draft_deploy', {
        project: PROJECT,
        action: 'coolify.deploy',
        env: 'production',
      });
      expect(draft.ok, JSON.stringify(draft)).toBe(true);
      expect(draft.ok ? draft.data : null).toMatchObject({ diff: { connection: 'Harici Coolify' } });
      const text = JSON.stringify([status, draft]);
      expect(text).not.toContain(external.token);
      expect(text).not.toContain(server.token);
    });

    it('Open Coolify lists the connections with an https link (owner/admin)', async () => {
      const cfg = await call(owner, 'GET', '/coolify-sso/config');
      expect(cfg.statusCode).toBe(200);
      // No SSO gate here; the default's API base is http (internal) → not offered; the external one has an open URL.
      expect(cfg.json()).toEqual({
        enabled: false,
        url: null,
        connections: [
          {
            id: externalId,
            label: 'Harici Coolify',
            isDefault: false,
            sso: false,
            url: 'https://coolify.external.example/',
          },
        ],
      });
      expect((await call(operator, 'GET', '/coolify-sso/config')).statusCode).toBe(403);
    });

    it('unassigning or removing a connection stops its use; replacing the token re-encrypts; all audited', async () => {
      await stepUp();
      const un = await call(owner, 'PUT', `/integrations/coolify/connections/${externalId}`, {
        projects: [],
      });
      expect(un.statusCode, un.body).toBe(200);
      const refused = await deploy(operator, 'production');
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ error: string }>().error).toBe('coolify_connection_not_allowed');
      expect((await call(operator, 'GET', `/projects/${PROJECT}/coolify-connections`)).body).not.toContain(
        externalId,
      );
      await stepUp();
      const rot = await call(owner, 'PUT', `/integrations/coolify/connections/${externalId}`, {
        allProjects: true,
        token: external.token,
        isDefault: true,
      });
      expect(rot.statusCode, rot.body).toBe(200);
      expect(rot.json<Conn>()).toMatchObject({ isDefault: true, allProjects: true, lastTest: null });
      const list = (await call(owner, 'GET', '/integrations/coolify/connections')).json<{ items: Conn[] }>()
        .items;
      expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([externalId]);
      // Back to the server default; then remove the external one.
      await stepUp();
      await call(owner, 'PUT', `/integrations/coolify/connections/${defaultId}`, { isDefault: true });
      h.clock.advance(11 * 60_000);
      expect(
        (await call(owner, 'DELETE', `/integrations/coolify/connections/${externalId}`)).statusCode,
      ).toBe(403);
      await stepUp();
      expect(
        (await call(owner, 'DELETE', `/integrations/coolify/connections/${externalId}`)).statusCode,
      ).toBe(204);
      const gone = await deploy(operator, 'production');
      expect(gone.statusCode).toBe(409);
      expect(gone.json<{ error: string }>().error).toBe('coolify_connection_removed');
      const audit = await h.db.pool.query<{ action: string; metadata: unknown }>(
        `SELECT action, metadata FROM audit_events WHERE action LIKE 'ops.coolify_connection.%' ORDER BY occurred_at`,
      );
      const actions = audit.rows.map((r) => r.action);
      for (const a of ['create', 'update', 'test', 'remove'])
        expect(actions).toContain(`ops.coolify_connection.${a}`);
      const all = await h.db.pool.query<{ t: string }>('SELECT metadata::text AS t FROM audit_events');
      for (const tok of [server.token, external.token]) {
        for (const r of all.rows) expect(r.t).not.toContain(tok);
        for (const b of bodies) expect(b).not.toContain(tok);
        expect(h.logs.text).not.toContain(tok);
      }
    });
  },
);
