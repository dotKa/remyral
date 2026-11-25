import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p17-coolify-full (docs/design/p17-coolify-full.md) against a real master and the fake Coolify HTTP server: a project
 * application's storages (warnings, add volume / directory, remove with the typed name, the step-up event of a
 * destructive route), start / stop / restart, the probe-aware and version-aware refusals, the Coolify-wide routes
 * (resources, databases + backups, services + variables, projects / environments, servers, logs, deployments) with
 * RBAC, the control-plane deny list and the audit — and the assistant's tools through the real transport, including
 * the trigger scenario: "remyral-site-preview /data'ya kalıcı volume bağla".
 */
const PW = 'harbor-lantern-quartz-77';
const PROJECT = 'site';
const APP = 'webprev0001';
const CP = 'remyralmaster01';

const coolify = new FakeCoolify();
coolify.token = 'coolify-canary-token-9|FuLl0123456789AbCdE';

describeIntegration(
  'Coolify completely from Remyral (integration, p17-coolify-full)',
  { timeout: 240_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let operator: Client;
    let connectionId = '';

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    }
    const audits = async (action: string) =>
      (
        await h.db.pool.query<{ outcome: string; target: string; metadata: Record<string, unknown> }>(
          'SELECT outcome, target, metadata FROM audit_events WHERE action = $1 ORDER BY id',
          [action],
        )
      ).rows;
    const testConnection = async () => {
      const t = await owner.req('POST', `/integrations/coolify/connections/${connectionId}/test`);
      expect(t.statusCode, t.body).toBe(200);
      return t.json<Record<string, unknown>>();
    };
    const conn = () => `/integrations/coolify/connections/${connectionId}`;
    const appPath = `/projects/${PROJECT}/coolify/apps/${APP}`;

    beforeAll(async () => {
      await coolify.start();
      coolify.version = 'v4.5.0';
      coolify.abilities = { read: true, deploy: true, write: true, readSensitive: true };
      coolify.projects = [
        {
          uuid: 'proj000001',
          name: 'site',
          environments: [
            { id: 7, uuid: 'envuuid001', name: 'production' },
            { id: 8, uuid: 'envuuid002', name: 'preview' },
          ],
        },
        {
          uuid: 'projcp0001',
          name: 'remyral',
          environments: [{ id: 9, uuid: 'envuuid009', name: 'production' }],
        },
      ];
      coolify.addApp({
        uuid: APP,
        name: 'remyral-site-preview',
        environment_id: 8,
        runtimeLogs: 'listening on 3000',
      });
      coolify.envs.set(APP, [
        {
          uuid: 'env1',
          key: 'DATABASE_PATH',
          value: '/data/site.db',
          is_preview: false,
          is_buildtime: true,
          is_runtime: true,
          is_literal: false,
          is_multiline: false,
        },
      ]);
      coolify.addApp({ uuid: 'tmpapp0001', name: 'tmp-app', environment_id: 8 });
      coolify.storages.set('tmpapp0001', [
        { id: 900, uuid: 'st-tmp-1', type: 'persistent', name: 'tmpapp0001-cache', mount_path: '/cache' },
      ]);
      coolify.addApp({ uuid: CP, name: 'remyral-master', environment_id: 9 });
      coolify.addApp({ uuid: 'cpneighbor01', name: 'remyral-worker', environment_id: 9 });
      await h.start({
        securityPolicy: { preset: 'serbest' },
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          internalOrigins: [coolify.base],
          controlPlaneResources: [CP],
          limits: { perProjectPer10Min: 60 },
        },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      ownerId = await h.createUser('owner.full', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner.full', PW)).secret;
      owner = await fullLogin(h, 'owner.full', PW, ownerSecret);
      const opId = await h.createUser('oper.full', PW, 'operator');
      await h.grant(opId, [PROJECT], 'operator');
      operator = await fullLogin(h, 'oper.full', PW, (await enroll(h, 'oper.full', PW)).secret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
      await stepUp();
      const c = await owner.req('POST', '/integrations/coolify/connections', {
        label: 'Coolify (full)',
        url: coolify.base,
        projects: [PROJECT],
        isDefault: true,
        manageApps: true,
        token: coolify.token,
      });
      expect(c.statusCode, c.body).toBe(200);
      connectionId = c.json<{ id: string }>().id;
      await h.db.pool.query(
        `INSERT INTO project_deploy_targets (project, config, version, updated_by, updated_at) VALUES ($1, $2, 1, $3, now())`,
        [
          PROJECT,
          {
            coolify: {
              preview: { connection: connectionId, uuids: [APP, 'tmpapp0001'], tags: [] },
              production: null,
            },
          },
          ownerId,
        ],
      );
      const t = await testConnection();
      expect(t).toMatchObject({
        ok: true,
        version: 'v4.5.0',
        permissions: { read: true, deploy: true, write: true, readSensitive: true },
        features: { storages: 'full', volumeHostPath: false },
      });
    });
    afterAll(async () => {
      await h.stop();
      await coolify.stop();
    });

    describe('a project application: storages and start / stop / restart', () => {
      it('lists no storage and warns that the data path a variable names is not persistent', async () => {
        const r = await owner.req('GET', `${appPath}/storages`);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toMatchObject({
          name: 'remyral-site-preview',
          storages: [],
          dataWarnings: [{ path: '/data/site.db', source: 'env:DATABASE_PATH' }],
          features: { storages: 'full' },
          unsupported: null,
          env: 'preview',
        });
        expect(JSON.stringify(r.json())).not.toContain('postgres://');
        expect((await operator.req('GET', `${appPath}/storages`)).statusCode).toBe(403);
      });

      it('adds a volume at /data (audited, remembered, notice that the container data is not copied)', async () => {
        const r = await owner.req('POST', `${appPath}/storages`, {
          mount: 'volume',
          name: 'remyral-data',
          mountPath: '/data',
        });
        expect(r.statusCode, r.body).toBe(200);
        const out = r.json<{
          storage: { name: string; mountPath: string };
          warnings: string[];
          deploy: unknown;
        }>();
        expect(out.storage).toMatchObject({ name: `${APP}-remyral-data`, mountPath: '/data' });
        expect(out.deploy).toBeNull();
        expect(out.warnings.join(' ')).toMatch(
          /starts empty.*lost at that redeploy unless it is copied out first/,
        );
        expect(
          JSON.parse(
            coolify.requests.filter((x) => x.method === 'POST' && x.path.endsWith('/storages')).at(-1)
              ?.body ?? '',
          ),
        ).toEqual({
          type: 'persistent',
          name: 'remyral-data',
          mount_path: '/data',
        });
        const a = (await audits('ops.coolify.storage.add')).at(-1);
        expect(a).toMatchObject({
          outcome: 'success',
          target: `project:${PROJECT}`,
          metadata: {
            via: 'api',
            kind: 'application',
            resourceUuid: APP,
            mount: 'volume',
            name: 'remyral-data',
            mountPath: '/data',
          },
        });
        const rows = await h.db.pool.query('SELECT path FROM coolify_data_paths WHERE resource_uuid = $1', [
          APP,
        ]);
        expect(rows.rows).toEqual([{ path: '/data' }]);
        const again = await owner.req('GET', `${appPath}/storages`);
        expect(again.json()).toMatchObject({
          dataWarnings: [],
          storages: [{ mount: 'volume', mountPath: '/data' }],
        });
        const dup = await owner.req('POST', `${appPath}/storages`, {
          mount: 'volume',
          name: 'other',
          mountPath: '/data',
        });
        expect(dup.statusCode, dup.body).toBe(409);
        expect(dup.json()).toMatchObject({ error: 'storage_exists' });
      });

      it('a volume on a host path becomes a directory mount on Coolify 4.3+, with a redeploy through the deploy policy', async () => {
        const r = await owner.req('POST', `${appPath}/storages`, {
          mount: 'volume',
          name: 'uploads',
          mountPath: '/uploads',
          hostPath: '/srv/uploads',
          deploy: true,
        });
        expect(r.statusCode, r.body).toBe(200);
        const out = r.json<{
          storage: { mount: string };
          warnings: string[];
          deploy: { actionId: string | null } | null;
        }>();
        expect(out.storage.mount).toBe('directory');
        expect(out.warnings.join(' ')).toContain('directory mount instead');
        expect(out.deploy?.actionId).toEqual(expect.any(String));
        const ops = await h.db.pool.query<{ kind: string; params: Record<string, unknown> }>(
          'SELECT kind, params FROM ops_actions WHERE id = $1',
          [out.deploy?.actionId],
        );
        expect(ops.rows[0]).toMatchObject({
          kind: 'coolify.deploy',
          params: { env: 'preview', only: [APP] },
        });
      });

      it('removing a storage needs its name typed, says what is lost and is a destructive step-up event', async () => {
        const list = (await owner.req('GET', `${appPath}/storages`)).json<{
          storages: { uuid: string; name: string | null; mountPath: string }[];
        }>().storages;
        const vol = list.find((s) => s.mountPath === '/data');
        const wrong = await owner.req('DELETE', `${appPath}/storages/${vol?.uuid ?? ''}?confirm=data`);
        expect(wrong.statusCode, wrong.body).toBe(400);
        expect(wrong.json()).toMatchObject({ error: 'confirmation_mismatch' });
        await h.setSecurityPolicy({
          preset: 'serbest',
          stepUp: { windowMinutes: 5 },
          events: { 'coolify.destructive': true },
        });
        h.clock.advance(6 * 60_000);
        const noCode = await owner.req(
          'DELETE',
          `${appPath}/storages/${vol?.uuid ?? ''}?confirm=remyral-data`,
        );
        expect(noCode.statusCode, noCode.body).toBe(403);
        expect(noCode.json()).toMatchObject({ error: 'step_up_required' });
        // A non-destructive storage change stays waived (its event deploy.coolify is off in Serbest).
        const other = list.find((s) => s.mountPath === '/uploads');
        const patch = await owner.req('PATCH', `${appPath}/storages/${other?.uuid ?? ''}`, {
          mountPath: '/var/uploads',
        });
        expect(patch.statusCode, patch.body).toBe(200);
        await stepUp();
        const ok = await owner.req('DELETE', `${appPath}/storages/${vol?.uuid ?? ''}?confirm=remyral-data`);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(ok.json<{ lost: string }>().lost).toContain('no longer mounted at /data');
        await h.setSecurityPolicy({ preset: 'serbest' });
        expect(
          (await h.db.pool.query('SELECT 1 FROM coolify_data_paths WHERE path = $1', ['/data'])).rowCount,
        ).toBe(0);
        expect((await audits('ops.coolify.storage.remove')).map((x) => x.outcome)).toEqual([
          'failure',
          'success',
        ]);
      });

      it('stops and starts the application (deploy permission), audited per action', async () => {
        const stop = await owner.req('POST', `${appPath}/stop`);
        expect(stop.statusCode, stop.body).toBe(200);
        expect(coolify.apps.get(APP)?.status).toBe('exited');
        const start = await owner.req('POST', `${appPath}/start`);
        expect(start.statusCode, start.body).toBe(200);
        expect(start.json<{ deploymentUuid: string }>().deploymentUuid).toMatch(/^dep/);
        expect(coolify.lifecycleCalls.slice(-2)).toEqual([
          `applications ${APP} stop?docker_cleanup=false`,
          `applications ${APP} start`,
        ]);
        expect((await audits('ops.coolify.lifecycle.stop')).at(-1)).toMatchObject({
          outcome: 'success',
          target: `project:${PROJECT}`,
        });
        expect((await operator.req('POST', `${appPath}/restart`)).statusCode).toBe(403);
      });

      it('refuses before calling Coolify what the last test showed the token cannot do', async () => {
        coolify.abilities = { read: true, deploy: false, write: true, readSensitive: true };
        await testConnection();
        const before = coolify.lifecycleCalls.length;
        const r = await owner.req('POST', `${appPath}/restart`);
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json()).toMatchObject({ error: 'coolify_token_lacks_deploy' });
        expect(r.json<{ message: string }>().message).toContain('Keys & Tokens');
        expect(coolify.lifecycleCalls.length).toBe(before);
        coolify.abilities = { read: true, deploy: true, write: true, readSensitive: true };
        await testConnection();
      });

      it('an old Coolify without the storage API gets the exact manual step', async () => {
        coolify.version = 'v4.0.0-beta.420';
        coolify.storageApi = 'none';
        await testConnection();
        const view = await owner.req('GET', `${appPath}/storages`);
        expect(view.statusCode, view.body).toBe(200);
        expect(view.json<{ unsupported: string }>().unsupported).toContain(
          'Persistent Storage → + Add → Volume Mount',
        );
        const add = await owner.req('POST', `${appPath}/storages`, {
          mount: 'volume',
          name: 'remyral-data',
          mountPath: '/data',
        });
        expect(add.statusCode, add.body).toBe(409);
        expect(add.json()).toMatchObject({ error: 'coolify_storage_unsupported' });
        // Unknown version: the catch-all 404 decides.
        coolify.version = 'nightly';
        await testConnection();
        const unknown = await owner.req('GET', `${appPath}/storages`);
        expect(unknown.json<{ unsupported: string | null }>().unsupported).toContain(
          'destination path /data',
        );
        coolify.version = 'v4.5.0';
        coolify.storageApi = 'full';
        await testConnection();
      });

      it('deleting an application needs its typed name and says what is lost (volumes kept unless asked)', async () => {
        const wrong = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/tmpapp0001?confirm=tmp`);
        expect(wrong.statusCode, wrong.body).toBe(400);
        expect(wrong.json()).toMatchObject({
          error: 'confirmation_mismatch',
          params: { expected: 'tmp-app' },
        });
        expect(coolify.apps.has('tmpapp0001')).toBe(true);
        const ok = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/tmpapp0001?confirm=tmp-app`);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(ok.json<{ lost: string[] }>().lost).toEqual([
          'The application tmp-app in Coolify with its configuration.',
          'Its volumes are kept on the server (tmpapp0001-cache).',
        ]);
        expect(coolify.apps.has('tmpapp0001')).toBe(false);
      });

      it('is refused while the connection does not allow changes', async () => {
        await stepUp();
        expect((await owner.req('PUT', conn(), { manageApps: false })).statusCode).toBe(200);
        const r = await owner.req('POST', `${appPath}/restart`);
        expect(r.json()).toMatchObject({ error: 'coolify_manage_disabled' });
        await stepUp();
        expect((await owner.req('PUT', conn(), { manageApps: true })).statusCode).toBe(200);
        await testConnection();
      });
    });

    describe('the whole Coolify of a connection', () => {
      let db = '';
      let svc = '';

      it('lists every resource with the control plane marked; admins only', async () => {
        const r = await owner.req('GET', `${conn()}/resources`);
        expect(r.statusCode, r.body).toBe(200);
        const o = r.json<{
          applications: { uuid: string; controlPlane: boolean }[];
          connection: Record<string, unknown>;
        }>();
        expect(o.applications.find((a) => a.uuid === CP)?.controlPlane).toBe(true);
        expect(o.applications.find((a) => a.uuid === APP)?.controlPlane).toBe(false);
        expect(o.connection).toMatchObject({ version: 'v4.5.0', features: { storages: 'full' } });
        expect((await operator.req('GET', `${conn()}/resources`)).statusCode).toBe(403);
      });

      it('never changes the control plane; deleting next to it is refused', async () => {
        const r = await owner.req('POST', `${conn()}/resources/application/${CP}/storages`, {
          mount: 'volume',
          name: 'x',
          mountPath: '/x',
        });
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json()).toMatchObject({ error: 'control_plane_resource' });
        expect((await audits('ops.coolify.storage.add')).at(-1)).toMatchObject({
          outcome: 'denied',
          target: `coolify-connection:${connectionId}`,
        });
        const stop = await owner.req('POST', `${conn()}/resources/application/${CP}/stop`);
        expect(stop.statusCode).toBe(403);
      });

      it('creates a database (Coolify generates the password), changes, backs up and deletes it', async () => {
        const c = await owner.req('POST', `${conn()}/databases`, {
          engine: 'postgresql',
          server: 'srv0000001',
          coolifyProject: 'proj000001',
          environment: 'production',
          name: 'site-db',
          user: 'site',
          database: 'site',
        });
        expect(c.statusCode, c.body).toBe(200);
        db = c.json<{ uuid: string }>().uuid;
        expect(coolify.createdDatabases.at(-1)?.body).toEqual({
          server_uuid: 'srv0000001',
          project_uuid: 'proj000001',
          environment_name: 'production',
          name: 'site-db',
          postgres_user: 'site',
          postgres_db: 'site',
          instant_deploy: false,
        });
        const d = await owner.req('GET', `${conn()}/resources/database/${db}`);
        expect(d.statusCode, d.body).toBe(200);
        expect(d.body).not.toContain('generated-canary-password');
        // A password from the panel goes to Coolify and nowhere else.
        const withPw = await owner.req('POST', `${conn()}/databases`, {
          engine: 'redis',
          server: 'srv0000001',
          coolifyProject: 'proj000001',
          environment: 'production',
          password: 'panel-canary-password-123',
        });
        expect(withPw.statusCode, withPw.body).toBe(200);
        expect(coolify.createdDatabases.at(-1)?.body.redis_password).toBe('panel-canary-password-123');
        const allAudit = await h.db.pool.query(
          "SELECT metadata::text AS m FROM audit_events WHERE action LIKE 'ops.coolify.%'",
        );
        expect(allAudit.rows.map((x: { m: string }) => x.m).join('')).not.toContain(
          'panel-canary-password-123',
        );
        // Never into the control plane's environment.
        const cpEnv = await owner.req('POST', `${conn()}/databases`, {
          engine: 'postgresql',
          server: 'srv0000001',
          coolifyProject: 'projcp0001',
          environment: 'production',
        });
        expect(cpEnv.json()).toMatchObject({ error: 'control_plane_environment' });
        expect(
          (await owner.req('PATCH', `${conn()}/databases/${db}`, { limitsMemory: '512m' })).statusCode,
        ).toBe(200);
        const b = await owner.req('POST', `${conn()}/databases/${db}/backups`, {
          frequency: '0 3 * * *',
          retentionAmount: 7,
        });
        expect(b.statusCode, b.body).toBe(200);
        const bk = b.json<{ backupUuid: string }>().backupUuid;
        expect(
          (await owner.req('PATCH', `${conn()}/databases/${db}/backups/${bk}`, { backupNow: true }))
            .statusCode,
        ).toBe(200);
        expect((await audits('ops.coolify.backup.run')).at(-1)?.outcome).toBe('success');
        const ex = await owner.req('GET', `${conn()}/databases/${db}/backups/${bk}/executions`);
        expect(ex.json<{ items: unknown[] }>().items).toHaveLength(1);
        expect((await owner.req('DELETE', `${conn()}/databases/${db}/backups/${bk}`)).statusCode).toBe(200);
        const wrong = await owner.req('DELETE', `${conn()}/databases/${db}?confirm=nope`);
        expect(wrong.json()).toMatchObject({ error: 'confirmation_mismatch' });
        const del = await owner.req('DELETE', `${conn()}/databases/${db}?confirm=site-db`);
        expect(del.statusCode, del.body).toBe(200);
        expect(del.json<{ lost: string[] }>().lost.join(' ')).toContain('volumes are kept on the server');
        expect(coolify.deletedResources.at(-1)?.query.delete_volumes).toBe('false');
      });

      it('creates a one-click service, sets a variable (value never audited), restarts, stops and deletes it', async () => {
        const c = await owner.req('POST', `${conn()}/services`, {
          type: 'n8n',
          server: 'srv0000001',
          coolifyProject: 'proj000001',
          environment: 'production',
          name: 'automation',
        });
        expect(c.statusCode, c.body).toBe(200);
        svc = c.json<{ uuid: string }>().uuid;
        const e = await owner.req('PUT', `${conn()}/services/${svc}/envs`, {
          changes: [{ key: 'N8N_HOST', value: 'canary-value-n8n.example.com' }],
          restart: true,
        });
        expect(e.statusCode, e.body).toBe(200);
        expect(e.json()).toMatchObject({ created: ['N8N_HOST'] });
        expect(JSON.stringify(await audits('ops.coolify.service.envs'))).not.toContain('canary-value');
        expect(coolify.lifecycleCalls.at(-1)).toBe(`services ${svc} restart`);
        const logs = await owner.req('GET', `${conn()}/resources/service/${svc}/logs`);
        expect(logs.statusCode, logs.body).toBe(200);
        expect(logs.json()).toMatchObject({
          sub: 'n8n',
          logs: { text: expect.stringContaining(`log of ${svc}`) as unknown },
        });
        expect((await owner.req('POST', `${conn()}/resources/service/${svc}/stop`)).statusCode).toBe(200);
        const del = await owner.req(
          'DELETE',
          `${conn()}/services/${svc}?confirm=automation&deleteVolumes=true`,
        );
        expect(del.statusCode, del.body).toBe(200);
        expect(del.json<{ lost: string[] }>().lost.join(' ')).toContain('all data in them');
      });

      it('projects and environments: create, refuse a non-empty one, delete empty ones', async () => {
        const p = await owner.req('POST', `${conn()}/projects`, { name: 'scratch' });
        expect(p.statusCode, p.body).toBe(200);
        const uuid = p.json<{ uuid: string }>().uuid;
        expect(
          (await owner.req('POST', `${conn()}/projects/${uuid}/environments`, { name: 'staging' }))
            .statusCode,
        ).toBe(200);
        expect(
          (await owner.req('DELETE', `${conn()}/projects/${uuid}/environments/staging?confirm=staging`))
            .statusCode,
        ).toBe(200);
        // p22-coolify-env-exists: creating an environment that is already there is done (existed), not an error.
        const again = await owner.req('POST', `${conn()}/projects/proj000001/environments`, {
          name: 'production',
        });
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toMatchObject({ uuid: 'envuuid001', name: 'production', existed: true });
        expect(coolify.projects.find((x) => x.uuid === 'proj000001')?.environments).toHaveLength(2);
        const busy = await owner.req('DELETE', `${conn()}/projects/proj000001?confirm=site`);
        expect(busy.json()).toMatchObject({ error: 'coolify_project_not_empty' });
        const cp = await owner.req(
          'DELETE',
          `${conn()}/projects/projcp0001/environments/production?confirm=production`,
        );
        expect(cp.json()).toMatchObject({ error: 'coolify_environment_not_empty' });
        expect((await owner.req('DELETE', `${conn()}/projects/${uuid}?confirm=scratch`)).statusCode).toBe(
          200,
        );
      });

      it('server details, a server check, running deployments and cancelling one', async () => {
        const s = await owner.req('GET', `${conn()}/servers/srv0000001`);
        expect(s.statusCode, s.body).toBe(200);
        expect(s.body).not.toContain('secret log');
        expect((await owner.req('POST', `${conn()}/servers/srv0000001/validate`)).statusCode).toBe(200);
        expect(coolify.validated).toContain('srv0000001');
        coolify.deployments.set('dep-running-1', { status: 'in_progress', app: APP, logs: '[]', commit: '' });
        coolify.running = [
          {
            deployment_uuid: 'dep-running-1',
            status: 'in_progress',
            application_name: 'x',
            server_name: 'main',
          },
        ];
        const o = await owner.req('GET', `${conn()}/resources`);
        expect(o.json<{ deployments: unknown[] }>().deployments).toHaveLength(1);
        const cancel = await owner.req('POST', `${conn()}/deployments/dep-running-1/cancel`);
        expect(cancel.statusCode, cancel.body).toBe(200);
        expect((await audits('ops.coolify.deployment.cancel')).at(-1)?.outcome).toBe('success');
      });
    });

    describe('the assistant (coolify_* tools through the real transport)', () => {
      const engine = new FakeAssistantEngine();
      const dirs: string[] = [];
      let worker: RunningWorker | undefined;
      const tool = (name: string, input: Record<string, unknown>) =>
        `[[tool ${name} ${JSON.stringify(input)}]]`;

      async function thread(): Promise<string> {
        const r = await owner.req('POST', '/chat/threads', {});
        expect(r.statusCode, r.body).toBe(201);
        return r.json<{ id: string }>().id;
      }
      async function detail(id: string) {
        const r = await owner.req('GET', `/chat/threads/${id}`);
        return r.json<{
          messages: { seq: number; role: string; content: string }[];
          drafts: { id: string; kind: string; state: string; payload?: Record<string, unknown> }[];
          turn: unknown;
        }>();
      }
      async function ask(id: string, text: string): Promise<string> {
        const r = await owner.req('POST', `/chat/threads/${id}/messages`, { text });
        expect(r.statusCode, r.body).toBe(202);
        const seq = r.json<{ message: { seq: number } }>().message.seq;
        let last: string | undefined;
        await expect
          .poll(
            async () => {
              const d = await detail(id);
              const after = d.messages.filter(
                (m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'),
              );
              last = after.length === 0 ? undefined : after.map((m) => m.content).join('\n');
              return d.turn === null && last !== undefined;
            },
            { timeout: 20_000 },
          )
          .toBe(true);
        return last ?? '';
      }

      afterAll(async () => {
        await worker?.stop().catch(() => undefined);
        await removeDirs(dirs);
      });

      it('sets up the assistant machine', async () => {
        const url = await h.listen();
        const dataDir = await tempDataDir(dirs);
        const workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
        worker = await runRealWorker(url, dataDir, {
          capabilities: CAPS,
          assistant: { engine, clock: h.clock.now },
        });
        await stepUp();
        const s = await owner.req('PUT', '/chat/settings', {
          enabled: true,
          workerId,
          runtime: 'claude-code',
          modelProfile: null,
          expectedVersion: 1,
        });
        expect(s.statusCode, s.body).toBe(200);
        await expect
          .poll(
            async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available,
            {
              timeout: 20_000,
            },
          )
          .toBe(true);
      });

      it('trigger: "remyral-site-preview /data\'ya kalıcı volume bağla" → reads storages → a card to add remyral-data → /data with the redeploy notice', async () => {
        const t = await thread();
        const read = await ask(t, tool('coolify_resource', { resource: 'remyral-site-preview' }));
        expect(read).toContain('answered');
        expect(read).toContain('/data/site.db');
        expect(read).toContain('dataWarnings');
        expect(read).toContain('offer coolify_storage op add');
        const reply = await ask(
          t,
          tool('coolify_storage', {
            resource: 'remyral-site-preview',
            op: 'add',
            mount: 'volume',
            mountPath: '/data',
            propose: true,
          }),
        );
        expect(reply).toContain('answered');
        expect(reply).toContain('remyral-data');
        expect(reply).toContain('starts empty');
        expect(reply).toContain('Redeploy the application after this card');
        const d = (await detail(t)).drafts.at(-1);
        expect(d).toMatchObject({
          kind: 'coolify_change',
          state: 'proposed',
          payload: {
            op: 'resource',
            scope: 'connection',
            method: 'addStorage',
            kind: 'application',
            uuid: APP,
            args: { mount: 'volume', name: 'remyral-data', mountPath: '/data', deploy: false },
          },
        });
        const before = coolify.storages.get(APP)?.length ?? 0;
        const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(coolify.storages.get(APP)?.length).toBe(before + 1);
        expect(coolify.storages.get(APP)?.at(-1)).toMatchObject({
          name: `${APP}-remyral-data`,
          mount_path: '/data',
        });
        expect((await audits('ops.coolify.storage.add')).at(-1)).toMatchObject({
          outcome: 'success',
          metadata: { via: 'chat' },
        });
      });

      it('with the project named, the project application is changed under the project (redeploy through its policy)', async () => {
        const t = await thread();
        const reply = await ask(
          t,
          tool('coolify_storage', {
            project: PROJECT,
            resource: APP,
            op: 'add',
            mount: 'volume',
            volume: 'cache',
            mountPath: '/cache',
            deploy: true,
            execute: true,
          }),
        );
        expect(reply).toContain('executed');
        expect((await audits('ops.coolify.storage.add')).at(-1)).toMatchObject({
          target: `project:${PROJECT}`,
          metadata: { via: 'chat', mountPath: '/cache' },
        });
      });

      it('removing asks for the typed name; stopping without an explicit instruction stays a destructive card', async () => {
        const t = await thread();
        const st = coolify.storages.get(APP)?.find((s) => s.mount_path === '/data');
        const ask1 = await ask(
          t,
          tool('coolify_storage', { resource: APP, op: 'remove', storage: st?.uuid }),
        );
        expect(ask1).toContain('refused');
        expect(ask1).toContain(`typing “${APP}-remyral-data”`);
        await ask(
          t,
          tool('coolify_lifecycle', { resource: 'remyral-site-preview', action: 'stop', propose: true }),
        );
        const card = (await detail(t)).drafts.at(-1);
        expect(card).toMatchObject({
          state: 'proposed',
          payload: { method: 'lifecycle', destructive: true, args: { action: 'stop' } },
        });
        expect(coolify.apps.get(APP)?.status).not.toBe('exited');
      });

      it('p22-coolify-env-exists: no card to create an environment that already exists', async () => {
        const t = await thread();
        const reply = await ask(
          t,
          tool('coolify_infra', {
            op: 'environment_create',
            coolifyProject: 'site',
            environment: 'production',
          }),
        );
        expect(reply).toContain('already exists');
        expect(reply).toContain('nothing to create');
      });

      it('lists resources and reads a database; refuses a secret service variable and never asks for a password', async () => {
        const t = await thread();
        const list = await ask(t, tool('coolify_resources', { kind: 'application' }));
        expect(list).toContain('remyral-site-preview');
        expect(list).toMatch(/"controlPlane": true/);
        const secret = await ask(
          t,
          tool('coolify_service', {
            op: 'envs',
            resource: 'automation',
            changes: [{ key: 'API_TOKEN', value: 'x' }],
          }),
        );
        expect(secret).toContain('refused');
        const create = await ask(
          t,
          tool('coolify_database', {
            op: 'create',
            engine: 'postgresql',
            coolifyProject: 'proj000001',
            environment: 'production',
            name: 'chat-db',
            propose: true,
          }),
        );
        expect(create).toContain('Coolify generates the database password');
        const card = (await detail(t)).drafts.at(-1);
        expect(card?.payload).toMatchObject({
          scope: 'connection',
          method: 'createDatabase',
          args: { engine: 'postgresql', server: 'srv0000001' },
        });
      });
    });
  },
);
