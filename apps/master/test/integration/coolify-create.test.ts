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
 * p15-coolify-create (ADR-0057) against a real master and the fake Coolify HTTP server: the wizard's options and the
 * repository suggestion, creating an application (idempotent, linked to the deploy target, its first deploy through
 * the normal ops action that deploys only the new application), variables and domains of a linked application,
 * every refusal (manage off, connection not allowed, control-plane environment, protected domain, domain conflict,
 * not linked, RBAC, the security policy's code rule), the audit trail — and that no variable value is ever stored,
 * logged or audited. Then the assistant's coolify_* tools through the real transport (execute: true, the secret
 * refusal, the options answer). No real Coolify is called.
 */
const PW = 'harbor-lantern-quartz-41';
const PROJECT = 'shop';
const OTHER = 'other';
const CANARY = 'canary-secret-value-7b1e';
const REPO_URL = 'https://github.com/acme/shop';

const coolify = new FakeCoolify();
coolify.token = 'coolify-canary-token-9|MaNaGe0123456789AbC';

/** api.github.com stub for the build suggestion: the repository root and package.json. */
const githubFetch = (input: string): Response => {
  const u = new URL(input);
  if (u.pathname === '/repos/acme/shop/contents/') {
    return new Response(
      JSON.stringify([
        { type: 'file', name: 'package.json' },
        { type: 'file', name: 'vite.config.ts' },
        { type: 'dir', name: 'src' },
      ]),
      { status: 200 },
    );
  }
  if (u.pathname === '/repos/acme/shop/contents/package.json') {
    return new Response(
      JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '7.1.0' } }),
      {
        status: 200,
      },
    );
  }
  return new Response('{}', { status: 404 });
};

describeIntegration(
  'Coolify applications from Remyral (integration, p15-coolify-create)',
  { timeout: 240_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let operator: Client;
    let connectionId = '';
    let appUuid = '';
    const bodies: string[] = [];

    async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
      const res = await c.req(method, url, body);
      bodies.push(res.body);
      return res;
    }
    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    }
    const wizard = (over: Record<string, unknown> = {}) => ({
      env: 'preview',
      server: 'srv0000001',
      coolifyProject: 'proj000001',
      environment: 'preview',
      source: { type: 'repository' },
      buildPack: 'nixpacks',
      ports: '80',
      isStatic: true,
      publishDirectory: '/dist',
      domains: ['shop-preview.example.com'],
      healthCheck: { enabled: true, path: '/health' },
      envs: [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'STRIPE_SECRET', value: CANARY },
        { key: 'DATABASE_URL', shared: 'project.DATABASE_URL', scope: 'runtime' },
      ],
      deploy: true,
      idempotencyKey: 'web-create-0001',
      ...over,
    });
    const audits = async (action: string) =>
      (
        await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown>; actor_id: string }>(
          'SELECT outcome, metadata, actor_id FROM audit_events WHERE action = $1 ORDER BY id',
          [action],
        )
      ).rows;

    beforeAll(async () => {
      await coolify.start();
      coolify.abilities = { read: true, deploy: true, write: true };
      coolify.servers = [{ uuid: 'srv0000001', name: 'main', ip: '203.0.113.10' }];
      coolify.projects = [
        {
          uuid: 'proj000001',
          name: 'shop',
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
        // Deny-listed as a whole (its uuid on the control-plane list), with no application in it yet.
        {
          uuid: 'projcp0002',
          name: 'remyral-infra',
          environments: [{ id: 10, uuid: 'envuuid010', name: 'production' }],
        },
      ];
      coolify.githubApps = [{ uuid: 'gha0000001', name: 'acme-app' }];
      coolify.keys = [
        { uuid: 'key0000001', name: 'deploy', fingerprint: 'SHA256:abc', private_key: 'KEY-MATERIAL-CANARY' },
      ];
      coolify.addApp({ uuid: 'remyralmaster01', name: 'remyral-master', environment_id: 9 });
      coolify.addApp({ uuid: 'shopprev01', name: 'shop-old-preview', environment_id: 8 });
      coolify.addApp({
        uuid: 'taken00001',
        name: 'someone-else',
        fqdn: 'https://taken.example.com',
        environment_id: 7,
      });
      await h.start({
        securityPolicy: { preset: 'serbest' },
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          // OPS_PROTECTED_HOSTS: a second console host, protected like the PUBLIC_ORIGIN one.
          protectedHosts: ['console.example.org'],
          internalOrigins: [coolify.base],
          controlPlaneResources: ['remyralmaster01', 'projcp0002'],
          limits: { perProjectPer10Min: 60 },
        },
        skills: { githubFetch: (url) => Promise.resolve(githubFetch(url)) },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      ownerId = await h.createUser('owner.coolify', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner.coolify', PW)).secret;
      owner = await fullLogin(h, 'owner.coolify', PW, ownerSecret);
      const opId = await h.createUser('oper.coolify', PW, 'operator');
      await h.grant(opId, [PROJECT], 'operator');
      operator = await fullLogin(h, 'oper.coolify', PW, (await enroll(h, 'oper.coolify', PW)).secret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()), ($2, $2, now()) ON CONFLICT DO NOTHING',
        [PROJECT, OTHER],
      );
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now()) ON CONFLICT (project) DO NOTHING`,
        [PROJECT, REPO_URL, ownerId],
      );
    });
    afterAll(async () => {
      await h.stop();
      await coolify.stop();
    });

    it('a connection allowed for the project, first with "manage applications" off', async () => {
      await stepUp();
      const res = await call(owner, 'POST', '/integrations/coolify/connections', {
        label: 'Coolify (manage)',
        url: coolify.base,
        projects: [PROJECT],
        isDefault: true,
        token: coolify.token,
      });
      expect(res.statusCode, res.body).toBe(200);
      const c = res.json<{ id: string; manageApps: boolean }>();
      expect(c.manageApps).toBe(false);
      connectionId = c.id;
      // Test connection: a write token on a connection that does not manage applications is flagged.
      const t = (await call(owner, 'POST', `/integrations/coolify/connections/${connectionId}/test`)).json<{
        warnings: string[];
      }>();
      expect(t.warnings.join(' ')).toContain('can write');
      const off = await call(owner, 'POST', `/projects/${PROJECT}/coolify/apps`, wizard());
      expect(off.statusCode, off.body).toBe(409);
      expect(off.json()).toMatchObject({ error: 'coolify_manage_disabled' });
      expect(coolify.created).toHaveLength(0);
      await stepUp();
      const on = await call(owner, 'PUT', `/integrations/coolify/connections/${connectionId}`, {
        manageApps: true,
      });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json<{ manageApps: boolean }>().manageApps).toBe(true);
      expect((await audits('ops.coolify_connection.update')).at(-1)?.metadata).toMatchObject({
        manageApps: true,
      });
      const t2 = (await call(owner, 'POST', `/integrations/coolify/connections/${connectionId}/test`)).json<{
        warnings: string[];
      }>();
      expect(t2.warnings.join(' ')).not.toContain('can write');
    });

    it('the wizard reads servers, projects, environments, sources and the repository suggestion', async () => {
      const o = await call(
        owner,
        'GET',
        `/projects/${PROJECT}/coolify/options?coolifyProject=proj000001&server=srv0000001`,
      );
      expect(o.statusCode, o.body).toBe(200);
      expect(o.json()).toMatchObject({
        connection: { id: connectionId, manageApps: true },
        servers: [{ uuid: 'srv0000001', name: 'main' }],
        environments: [{ name: 'production' }, { name: 'preview' }],
        destinations: [],
        githubApps: [{ uuid: 'gha0000001' }],
        privateKeys: [{ uuid: 'key0000001', name: 'deploy' }],
        repository: { url: REPO_URL, branch: 'main' },
      });
      expect(o.body).not.toContain('KEY-MATERIAL-CANARY');
      const s = await call(owner, 'GET', `/projects/${PROJECT}/coolify/suggestion`);
      expect(s.json()).toMatchObject({
        buildPack: 'nixpacks',
        isStatic: true,
        publishDirectory: '/dist',
        ports: '80',
        basis: ['package.json', 'vite'],
        source: 'repository',
      });
      // Reads are project-admin: an operator of the project is refused.
      expect((await call(operator, 'GET', `/projects/${PROJECT}/coolify/options`)).statusCode).toBe(403);
    });

    it('creates the application, sets its variables, links it and requests the first deploy of only it', async () => {
      // The project already had a preview target with another application.
      await stepUp();
      const put = await call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: { coolify: { preview: { connection: connectionId, uuids: ['shopprev01'] } } },
      });
      expect(put.statusCode, put.body).toBe(200);
      const res = await call(owner, 'POST', `/projects/${PROJECT}/coolify/apps`, wizard());
      expect(res.statusCode, res.body).toBe(201);
      const v = res.json<{
        state: string;
        appUuid: string;
        result: { linked: boolean; deployActionId: string; deployState: string; envs: { created: string[] } };
      }>();
      expect(v).toMatchObject({ state: 'created', result: { linked: true } });
      appUuid = v.appUuid;
      expect(v.result.envs.created).toEqual(['NODE_ENV', 'STRIPE_SECRET', 'DATABASE_URL']);

      // Exactly the documented public-repository body.
      expect(coolify.created).toHaveLength(1);
      expect(coolify.created[0]).toMatchObject({
        kind: 'public',
        body: {
          project_uuid: 'proj000001',
          server_uuid: 'srv0000001',
          environment_name: 'preview',
          git_repository: REPO_URL,
          git_branch: 'main',
          build_pack: 'nixpacks',
          is_static: true,
          publish_directory: '/dist',
          ports_exposes: '80',
          domains: 'https://shop-preview.example.com',
          health_check_enabled: true,
          health_check_path: '/health',
          instant_deploy: false,
        },
      });
      expect(Object.keys(coolify.created[0]?.body ?? {})).not.toContain('force_domain_override');
      // Variables: values reached Coolify (and only Coolify); flags only where they differ.
      const envs = coolify.envs.get(appUuid) ?? [];
      expect(envs.map((e) => [e.key, e.value, e.is_buildtime, e.is_runtime])).toEqual([
        ['NODE_ENV', 'production', true, true],
        ['STRIPE_SECRET', CANARY, true, true],
        ['DATABASE_URL', '{{project.DATABASE_URL}}', false, true],
      ]);

      // Linked to the preview target next to the existing application, on the same connection.
      const t = (await call(owner, 'GET', `/projects/${PROJECT}/deploy-targets`)).json<{
        targets: { coolify: { preview: { connection: string; uuids: string[] } } };
      }>();
      expect(t.targets.coolify.preview).toMatchObject({
        connection: connectionId,
        uuids: ['shopprev01', appUuid],
      });

      // The first deploy: the normal ops action (preview → runs at once by the default policy), only the new app.
      const a = (await call(owner, 'GET', `/deploy/actions/${v.result.deployActionId}`)).json<{
        kind: string;
        state: string;
        params: Record<string, unknown>;
        target: { resources: { uuid: string }[] };
      }>();
      expect(a).toMatchObject({ kind: 'coolify.deploy', params: { env: 'preview', only: [appUuid] } });
      expect(a.target.resources.map((r) => r.uuid)).toEqual([appUuid]);
      expect(coolify.calls(/POST \/api\/v1\/deploy\?/)).toEqual([`POST /api/v1/deploy?uuid=${appUuid}`]);

      // Audited without a value.
      const audit = await audits('ops.coolify.app.create');
      expect(audit.at(-1)).toMatchObject({ outcome: 'success', actor_id: ownerId });
      expect(audit.at(-1)?.metadata).toMatchObject({
        endpoint: 'public',
        request: {
          envs: [
            { key: 'NODE_ENV', source: 'value' },
            { key: 'STRIPE_SECRET', source: 'value' },
            { key: 'DATABASE_URL', source: 'shared', shared: 'project.DATABASE_URL', scope: 'runtime' },
          ],
        },
      });
    });

    it('a retried request answers with the same creation (nothing is created twice)', async () => {
      const again = await call(owner, 'POST', `/projects/${PROJECT}/coolify/apps`, wizard());
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ appUuid, replayed: true, state: 'created' });
      expect(coolify.created).toHaveLength(1);
    });

    it('lists the linked applications and shows variables as keys and flags only', async () => {
      const l = (await call(owner, 'GET', `/projects/${PROJECT}/coolify/apps`)).json<{
        items: { uuid: string; manageApps: boolean; problem: string | null }[];
        creations: { appUuid: string }[];
      }>();
      expect(l.items.map((i) => i.uuid)).toEqual(['shopprev01', appUuid]);
      expect(l.items.every((i) => i.manageApps && i.problem === null)).toBe(true);
      expect(l.creations[0]?.appUuid).toBe(appUuid);
      const d = await call(owner, 'GET', `/projects/${PROJECT}/coolify/apps/${appUuid}`);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({
        env: 'preview',
        domains: ['https://shop-preview.example.com'],
        envs: [
          { key: 'NODE_ENV', shared: null },
          { key: 'STRIPE_SECRET', shared: null },
          { key: 'DATABASE_URL', shared: 'project.DATABASE_URL', runtime: true, buildtime: false },
        ],
      });
      expect(d.body).not.toContain(CANARY);
      expect(d.body).not.toContain('"production"');
    });

    it('sets, updates and removes variables (bulk for several existing ones) and redeploys on request', async () => {
      const res = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/envs`, {
        changes: [
          { key: 'NODE_ENV', value: 'staging' },
          { key: 'STRIPE_SECRET', value: `${CANARY}-2` },
          { key: 'LOG_LEVEL', value: 'debug' },
          { key: 'DATABASE_URL', remove: true },
          { key: 'NOT_THERE', remove: true },
        ],
        deploy: true,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        created: ['LOG_LEVEL'],
        updated: ['NODE_ENV', 'STRIPE_SECRET'],
        removed: ['DATABASE_URL'],
        unchanged: ['NOT_THERE'],
        failed: [],
      });
      expect(res.json<{ deployActionId: string | null }>().deployActionId).not.toBeNull();
      expect(coolify.calls(/envs/).filter((c) => c.includes('/bulk'))).toHaveLength(1);
      expect((coolify.envs.get(appUuid) ?? []).map((e) => `${e.key}=${e.value}`)).toEqual([
        'NODE_ENV=staging',
        `STRIPE_SECRET=${CANARY}-2`,
        'LOG_LEVEL=debug',
      ]);
      const a = (await audits('ops.coolify.app.envs')).at(-1);
      expect(a?.metadata).toMatchObject({ created: ['LOG_LEVEL'], removed: ['DATABASE_URL'], appUuid });
      // Twice the same key → refused before anything is sent.
      const dup = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/envs`, {
        changes: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      });
      expect(dup.json()).toMatchObject({ error: 'duplicate_env' });
    });

    it('replaces the domains; protected and conflicting domains are refused', async () => {
      const ok = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/domains`, {
        domains: ['https://shop-preview.example.com', 'www.shop-preview.example.com'],
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        domains: ['https://shop-preview.example.com', 'https://www.shop-preview.example.com'],
        previous: ['https://shop-preview.example.com'],
        deployActionId: null,
      });
      expect(coolify.apps.get(appUuid)?.fqdn).toBe(
        'https://shop-preview.example.com,https://www.shop-preview.example.com',
      );
      const console = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/domains`, {
        domains: ['https://console.example.test'],
      });
      expect(console.json()).toMatchObject({ error: 'protected_domain' });
      const fixed = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/domains`, {
        domains: ['https://console.example.org'],
      });
      expect(fixed.json()).toMatchObject({ error: 'protected_domain' });
      const conflict = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/domains`, {
        domains: ['https://taken.example.com'],
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: 'coolify_conflict' });
      expect(conflict.json<{ message: string }>().message).toContain('taken.example.com');
      expect((await audits('ops.coolify.app.domains')).map((a) => a.outcome)).toEqual(['success', 'failure']);
    });

    it('refuses the control plane, unknown places, other projects, unlinked applications and operators', async () => {
      const cp = await call(
        owner,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({
          coolifyProject: 'projcp0001',
          environment: 'production',
          idempotencyKey: 'web-create-cp01',
        }),
      );
      expect(cp.statusCode, cp.body).toBe(403);
      expect(cp.json()).toMatchObject({ error: 'control_plane_environment' });
      expect((await audits('ops.coolify.app.create')).at(-1)).toMatchObject({ outcome: 'denied' });
      const place = await call(
        owner,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({
          coolifyProject: 'projcp0002',
          environment: 'production',
          idempotencyKey: 'web-create-cp02',
        }),
      );
      expect(place.statusCode, place.body).toBe(403);
      expect(place.json()).toMatchObject({ error: 'control_plane_environment' });
      expect((await audits('ops.coolify.app.create')).at(-1)?.metadata).toMatchObject({
        reason: 'control_plane_place',
        resource: 'projcp0002',
      });
      const env = await call(
        owner,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({ environment: 'staging', idempotencyKey: 'web-create-env1' }),
      );
      expect(env.json()).toMatchObject({ error: 'unknown_environment' });
      const srv = await call(
        owner,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({ server: 'nosuchsrv1', idempotencyKey: 'web-create-srv1' }),
      );
      expect(srv.json()).toMatchObject({ error: 'unknown_server' });
      const dom = await call(
        owner,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({ domains: ['https://console.example.test'], idempotencyKey: 'web-create-dom1' }),
      );
      expect(dom.json()).toMatchObject({ error: 'protected_domain' });
      const conflict = await call(
        owner,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({
          domains: ['https://taken.example.com'],
          idempotencyKey: 'web-create-cfl1',
          deploy: false,
          allowDuplicate: true,
        }),
      );
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: 'coolify_conflict' });
      const failed = await h.db.pool.query<{ state: string }>(
        "SELECT state FROM coolify_app_creations WHERE idempotency_key = 'web-create-cfl1'",
      );
      expect(failed.rows[0]?.state).toBe('failed');
      const extra = await call(owner, 'POST', `/projects/${PROJECT}/coolify/apps`, {
        ...wizard({ idempotencyKey: 'web-create-xtra' }),
        custom_docker_run_options: '--privileged',
      });
      expect(extra.json()).toMatchObject({ error: 'invalid_request' });
      // Another project may not use the connection.
      const other = await call(
        owner,
        'POST',
        `/projects/${OTHER}/coolify/apps`,
        wizard({ idempotencyKey: 'web-other-0001' }),
      );
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ error: 'coolify_connection_not_allowed' });
      // A Coolify application the project's targets do not list.
      const notLinked = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/taken00001/envs`, {
        changes: [{ key: 'A', value: '1' }],
      });
      expect(notLinked.statusCode).toBe(404);
      expect(notLinked.json()).toMatchObject({ error: 'app_not_linked' });
      // The control-plane application is never changed, even when listed (the target refuses it anyway).
      const opCreate = await call(
        operator,
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({ idempotencyKey: 'web-oper-00001' }),
      );
      expect(opCreate.statusCode).toBe(403);
      const opEnv = await call(operator, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/envs`, {
        changes: [{ key: 'A', value: '1' }],
      });
      expect(opEnv.statusCode).toBe(403);
      expect(coolify.created).toHaveLength(1);
    });

    it('the security policy decides the code: Dengeli asks for one, Serbest does not', async () => {
      await h.setSecurityPolicy({ preset: 'dengeli', stepUp: { windowMinutes: 5 } });
      h.clock.advance(6 * 60_000);
      const asked = await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/domains`, {
        domains: ['https://shop-preview.example.com'],
      });
      expect(asked.statusCode).toBe(403);
      expect(asked.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp();
      expect(
        (
          await call(owner, 'PUT', `/projects/${PROJECT}/coolify/apps/${appUuid}/domains`, {
            domains: ['https://shop-preview.example.com'],
          })
        ).statusCode,
      ).toBe(200);
      await h.setSecurityPolicy({ preset: 'serbest' });
    });

    it('never stores, logs or audits a variable value', async () => {
      const tables = await h.db.pool.query<{ t: string }>(
        `SELECT string_agg(x::text, ' ') AS t FROM (
         SELECT request::text || coalesce(result::text, '') AS x FROM coolify_app_creations
         UNION ALL SELECT metadata::text FROM audit_events
         UNION ALL SELECT config::text FROM project_deploy_targets
         UNION ALL SELECT params::text || target::text || diff::text FROM ops_actions) s`,
      );
      expect(tables.rows[0]?.t ?? '').not.toContain(CANARY);
      expect(h.logs.text).not.toContain(CANARY);
      expect(h.logs.text).not.toContain(coolify.token);
      for (const b of bodies) {
        expect(b).not.toContain(CANARY);
        expect(b).not.toContain(coolify.token);
      }
    });

    describe('the assistant (coolify_* tools through the real transport)', () => {
      const engine = new FakeAssistantEngine();
      const dirs: string[] = [];
      let worker: RunningWorker | undefined;
      const tool = (name: string, input: Record<string, unknown>) =>
        `[[tool ${name} ${JSON.stringify(input)}]]`;

      async function thread(c: Client): Promise<string> {
        const r = await c.req('POST', '/chat/threads', {});
        expect(r.statusCode, r.body).toBe(201);
        return r.json<{ id: string }>().id;
      }
      async function detail(c: Client, id: string) {
        const r = await c.req('GET', `/chat/threads/${id}`);
        expect(r.statusCode, r.body).toBe(200);
        return r.json<{
          messages: { seq: number; role: string; content: string }[];
          drafts: {
            id: string;
            kind: string;
            state: string;
            payload?: unknown;
            result: Record<string, unknown> | null;
          }[];
          turn: unknown;
        }>();
      }
      async function ask(c: Client, id: string, text: string): Promise<string> {
        const r = await c.req('POST', `/chat/threads/${id}/messages`, { text });
        expect(r.statusCode, r.body).toBe(202);
        const seq = r.json<{ message: { seq: number } }>().message.seq;
        let last: string | undefined;
        await expect
          .poll(
            async () => {
              const d = await detail(c, id);
              last = d.messages
                .filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'))
                .at(-1)?.content;
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

      it('coolify_set_env with execute: true changes the variable at once (audited as chat)', async () => {
        const t = await thread(owner);
        const reply = await ask(
          owner,
          t,
          tool('coolify_set_env', {
            project: PROJECT,
            appUuid,
            changes: [{ key: 'FEATURE_FLAG', value: 'on' }],
            execute: true,
          }),
        );
        expect(reply).toContain('executed');
        const d = (await detail(owner, t)).drafts[0];
        expect(d).toMatchObject({ kind: 'coolify_change', state: 'confirmed' });
        expect(
          (coolify.envs.get(appUuid) ?? []).some((e) => e.key === 'FEATURE_FLAG' && e.value === 'on'),
        ).toBe(true);
        expect((await audits('ops.coolify.app.envs')).at(-1)?.metadata).toMatchObject({ via: 'chat' });
      });

      it('refuses a secret-looking value (no card), and asks for the server when there are several', async () => {
        const t = await thread(owner);
        const refused = await ask(
          owner,
          t,
          tool('coolify_set_env', {
            project: PROJECT,
            appUuid,
            changes: [{ key: 'API_TOKEN', value: `${CANARY}-chat` }],
            execute: true,
          }),
        );
        expect(refused).toContain('Değişkenler');
        expect((await detail(owner, t)).drafts).toEqual([]);
        expect((coolify.envs.get(appUuid) ?? []).some((e) => e.key === 'API_TOKEN')).toBe(false);

        coolify.servers = [...coolify.servers, { uuid: 'srv0000002', name: 'edge', ip: '203.0.113.11' }];
        const t2 = await thread(owner);
        const options = await ask(
          owner,
          t2,
          tool('coolify_create_app', { project: PROJECT, env: 'production', execute: true }),
        );
        expect(options).toContain('srv0000002');
        expect((await detail(owner, t2)).drafts).toEqual([]);
        coolify.servers = coolify.servers.slice(0, 1);
      });

      it('coolify_create_app fills the defaults and, proposed by the assistant, leaves a card to confirm', async () => {
        const t = await thread(owner);
        await ask(
          owner,
          t,
          tool('coolify_create_app', {
            project: PROJECT,
            env: 'production',
            domains: ['shop.example.com'],
            propose: true,
          }),
        );
        const d = (await detail(owner, t)).drafts[0];
        expect(d).toMatchObject({ kind: 'coolify_change', state: 'proposed' });
        expect(coolify.created).toHaveLength(1);
        const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(coolify.created).toHaveLength(2);
        expect(coolify.created[1]).toMatchObject({
          kind: 'public',
          body: {
            project_uuid: 'proj000001',
            server_uuid: 'srv0000001',
            environment_name: 'production',
            build_pack: 'nixpacks',
            is_static: true,
            domains: 'https://shop.example.com',
          },
        });
        const tg = (await call(owner, 'GET', `/projects/${PROJECT}/deploy-targets`)).json<{
          targets: { coolify: { production: { uuids: string[] } } };
        }>();
        expect(tg.targets.coolify.production.uuids).toEqual([coolify.created[1]?.uuid]);
      });
    });
  },
);
