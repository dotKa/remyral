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
 * p15-coolify-dedupe (docs/design/p15-coolify-dedupe.md) against a real master and the fake Coolify HTTP server: the
 * duplicate guard (same repository + branch, same name, allowDuplicate), the application logs (the last deploy
 * action's deployment, Coolify's newer one, the container output — redacted), the settings change, deleting an
 * application (volumes kept, deny list, another project's target, unlink, audit) — and the assistant's tools through
 * the real transport (no card for a duplicate, a same-turn retry replays, logs, update, delete only as asked).
 * Production incident 2026-10-22: five applications for one app, each failed deploy answered with a new one.
 */
const PW = 'harbor-lantern-quartz-52';
const PROJECT = 'sahne';
const OTHER = 'sahne-other';
const REPO_URL = 'https://github.com/acme/sahne';
const TOKEN_IN_LOG = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const RUNTIME_SECRET = 'sk_live_FAKEtestOnlyNotARealKey012345';

const coolify = new FakeCoolify();
coolify.token = 'coolify-canary-token-7|DeDuPe0123456789AbC';

describeIntegration(
  'Coolify duplicate guard, logs, settings and delete (integration, p15-coolify-dedupe)',
  { timeout: 240_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let operator: Client;
    let connectionId = '';
    let appA = '';
    let appB = '';

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
      ports: '3000',
      name: 'sahne-metin',
      deploy: true,
      idempotencyKey: 'dedupe-create-0001',
      ...over,
    });
    const audits = async (action: string) =>
      (
        await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
          'SELECT outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
          [action],
        )
      ).rows;
    const targets = async () =>
      (await owner.req('GET', `/projects/${PROJECT}/deploy-targets`)).json<{
        targets: { coolify: { preview: { uuids: string[] } | null; production: { uuids: string[] } | null } };
      }>().targets.coolify;

    beforeAll(async () => {
      await coolify.start();
      coolify.abilities = { read: true, deploy: true, write: true };
      coolify.projects = [
        {
          uuid: 'proj000001',
          name: 'sahne',
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
      coolify.addApp({ uuid: 'remyralmaster01', name: 'remyral-master', environment_id: 9 });
      coolify.addApp({ uuid: 'cpneighbor01', name: 'remyral-worker', environment_id: 9 });
      coolify.addApp({ uuid: 'foreign0001', name: 'someone-else', environment_id: 7 });
      await h.start({
        securityPolicy: { preset: 'serbest' },
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          internalOrigins: [coolify.base],
          controlPlaneResources: ['remyralmaster01'],
          limits: { perProjectPer10Min: 60 },
        },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      ownerId = await h.createUser('owner.dedupe', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner.dedupe', PW)).secret;
      owner = await fullLogin(h, 'owner.dedupe', PW, ownerSecret);
      const opId = await h.createUser('oper.dedupe', PW, 'operator');
      await h.grant(opId, [PROJECT], 'operator');
      operator = await fullLogin(h, 'oper.dedupe', PW, (await enroll(h, 'oper.dedupe', PW)).secret);
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
      await stepUp();
      const c = await owner.req('POST', '/integrations/coolify/connections', {
        label: 'Coolify (dedupe)',
        url: coolify.base,
        projects: [PROJECT],
        isDefault: true,
        token: coolify.token,
      });
      expect(c.statusCode, c.body).toBe(200);
      connectionId = c.json<{ id: string }>().id;
      await stepUp();
      const on = await owner.req('PUT', `/integrations/coolify/connections/${connectionId}`, {
        manageApps: true,
      });
      expect(on.statusCode, on.body).toBe(200);
    });
    afterAll(async () => {
      await h.stop();
      await coolify.stop();
    });

    it('creates the first application (linked, first deploy requested)', async () => {
      const res = await owner.req('POST', `/projects/${PROJECT}/coolify/apps`, wizard());
      expect(res.statusCode, res.body).toBe(201);
      appA = res.json<{ appUuid: string }>().appUuid;
      expect((await targets()).preview?.uuids).toEqual([appA]);
      expect(coolify.created).toHaveLength(1);
    });

    it('refuses a second application for the same repository + branch, naming the existing one', async () => {
      const res = await owner.req(
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({ name: 'sahne-metin-deploy', idempotencyKey: 'dedupe-create-0002' }),
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'coolify_app_exists',
        params: { uuid: appA, name: 'sahne-metin', environment: 'preview' },
        existing: [{ uuid: appA, name: 'sahne-metin', linked: 'preview', match: ['repository'] }],
      });
      expect(res.json<{ message: string }>().message).toContain('Do not create another one');
      expect(coolify.created).toHaveLength(1);
      const a = (await audits('ops.coolify.app.create')).at(-1);
      expect(a).toMatchObject({ outcome: 'denied', metadata: { reason: 'duplicate' } });
      // Nothing was recorded as a creation attempt.
      const rows = await h.db.pool.query(
        "SELECT 1 FROM coolify_app_creations WHERE idempotency_key = 'dedupe-create-0002'",
      );
      expect(rows.rowCount).toBe(0);
    });

    it('refuses the same name on another branch; allowDuplicate creates a second one when asked', async () => {
      const byName = await owner.req(
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({ source: { type: 'repository', branch: 'dev' }, idempotencyKey: 'dedupe-create-0003' }),
      );
      expect(byName.statusCode, byName.body).toBe(409);
      expect(byName.json()).toMatchObject({ existing: [{ uuid: appA, match: ['name'] }] });
      const second = await owner.req(
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({
          name: 'sahne-metin-2',
          link: 'none',
          deploy: false,
          allowDuplicate: true,
          idempotencyKey: 'dedupe-create-0004',
        }),
      );
      expect(second.statusCode, second.body).toBe(201);
      appB = second.json<{ appUuid: string }>().appUuid;
      expect(second.json()).toMatchObject({ request: { allowDuplicate: true } });
      expect(coolify.created).toHaveLength(2);
      // Another environment of the same Coolify project is no duplicate.
      const prod = await owner.req(
        'POST',
        `/projects/${PROJECT}/coolify/apps`,
        wizard({
          env: 'production',
          environment: 'production',
          name: 'sahne-prod',
          deploy: false,
          idempotencyKey: 'dedupe-create-0005',
        }),
      );
      expect(prod.statusCode, prod.body).toBe(201);
    });

    it('reads the last deployment log and the container output of an application, redacted', async () => {
      const res = await owner.req('GET', `/projects/${PROJECT}/coolify/apps/${appA}/logs`);
      expect(res.statusCode, res.body).toBe(200);
      const v = res.json<{
        deployment: { uuid: string; from: string; actionId: string | null; text: string } | null;
        runtime: unknown;
        notes: string[];
        linked: string;
      }>();
      expect(v.linked).toBe('preview');
      expect(v.deployment).toMatchObject({ from: 'action' });
      expect(v.deployment?.actionId).not.toBeNull();
      expect(v.deployment?.text).toContain('Building image');
      expect(v.deployment?.text).not.toContain('internal'); // hidden lines dropped
      expect(res.body).not.toContain(TOKEN_IN_LOG);
      expect(v.runtime).toBeNull();
      expect(v.notes.join(' ')).toContain('No running container');

      // A newer deployment started in Coolify itself wins; the container output is redacted too.
      coolify.deployments.set('depcoolify1', {
        status: 'failed',
        app: appA,
        commit: 'fff0000',
        logs: JSON.stringify([{ output: 'Error: Cannot find module server.js', hidden: false }]),
      });
      const app = coolify.apps.get(appA);
      if (app !== undefined)
        app.runtimeLogs = `2026-10-22T10:00:00Z boot\n2026-10-22T10:00:01Z key=${RUNTIME_SECRET}`;
      const again = await owner.req('GET', `/projects/${PROJECT}/coolify/apps/${appA}/logs?lines=50`);
      const w = again.json<{
        deployment: { uuid: string; from: string; status: string; text: string };
        runtime: { text: string };
      }>();
      expect(w.deployment).toMatchObject({ uuid: 'depcoolify1', from: 'coolify', status: 'failed' });
      expect(w.deployment.text).toContain('Cannot find module');
      expect(w.runtime.text).toContain('boot');
      expect(again.body).not.toContain(RUNTIME_SECRET);

      // The unlinked second application was created by the project: readable. Someone else's is not.
      expect(
        (await owner.req('GET', `/projects/${PROJECT}/coolify/apps/${appB}/logs?kind=deployment`)).statusCode,
      ).toBe(200);
      const foreign = await owner.req('GET', `/projects/${PROJECT}/coolify/apps/foreign0001/logs`);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ error: 'app_not_linked' });
      expect((await operator.req('GET', `/projects/${PROJECT}/coolify/apps/${appA}/logs`)).statusCode).toBe(
        403,
      );
    });

    it('changes the build settings of the linked application and redeploys only it', async () => {
      const res = await owner.req('PATCH', `/projects/${PROJECT}/coolify/apps/${appA}`, {
        buildPack: 'dockerfile',
        dockerfileLocation: '/docker/Dockerfile',
        baseDirectory: '/apps/web',
        ports: '8080',
        startCommand: 'node dist/server.js',
        healthCheck: { enabled: true, path: '/health' },
        deploy: true,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ changed: string[] }>().changed).toEqual(
        expect.arrayContaining([
          'build_pack',
          'dockerfile_location',
          'base_directory',
          'ports_exposes',
          'start_command',
        ]),
      );
      expect(res.json<{ deployActionId: string | null }>().deployActionId).not.toBeNull();
      expect(coolify.apps.get(appA)).toMatchObject({
        build_pack: 'dockerfile',
        dockerfile_location: '/docker/Dockerfile',
        base_directory: '/apps/web',
        ports_exposes: '8080',
        start_command: 'node dist/server.js',
        health_check_enabled: true,
        health_check_path: '/health',
      });
      expect(coolify.calls(/POST \/api\/v1\/deploy\?/).at(-1)).toBe(`POST /api/v1/deploy?uuid=${appA}`);
      const a = (await audits('ops.coolify.app.update')).at(-1);
      expect(a).toMatchObject({
        outcome: 'success',
        metadata: { changes: { startCommand: '(set)', ports: '8080' } },
      });
      expect(JSON.stringify(a)).not.toContain('node dist/server.js');
      // The details show the settings for the editor.
      const d = (await owner.req('GET', `/projects/${PROJECT}/coolify/apps/${appA}`)).json<{
        application: { buildPack: string; dockerfileLocation: string; startCommand: string };
      }>();
      expect(d.application).toMatchObject({
        buildPack: 'dockerfile',
        dockerfileLocation: '/docker/Dockerfile',
      });

      const bad = await owner.req('PATCH', `/projects/${PROJECT}/coolify/apps/${appA}`, {
        custom_docker_run_options: '-v /:/h',
      });
      expect(bad.statusCode).toBe(400);
      const unlinked = await owner.req('PATCH', `/projects/${PROJECT}/coolify/apps/${appB}`, { ports: '80' });
      expect(unlinked.statusCode).toBe(404);
      expect(
        (await operator.req('PATCH', `/projects/${PROJECT}/coolify/apps/${appA}`, { ports: '80' }))
          .statusCode,
      ).toBe(403);
    });

    it('never deletes the control plane, nor an application another project deploys', async () => {
      // Pretend the project once "created" the control-plane application and a neighbour of it.
      for (const [uuid, key] of [
        ['remyralmaster01', 'fake-cp-0001'],
        ['cpneighbor01', 'fake-cp-0002'],
      ] as const) {
        await h.db.pool.query(
          `INSERT INTO coolify_app_creations (id, project, connection_id, idempotency_key, env, request, state, app_uuid,
           via, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'production', '{}', 'created', $4, 'api', now(), now())`,
          [PROJECT, connectionId, key, uuid],
        );
      }
      const cp = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/remyralmaster01`);
      expect(cp.statusCode, cp.body).toBe(403);
      expect(cp.json()).toMatchObject({ error: 'control_plane_resource' });
      const neighbour = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/cpneighbor01`);
      expect(neighbour.statusCode, neighbour.body).toBe(403);
      expect(neighbour.json()).toMatchObject({ error: 'control_plane_environment' });
      expect(coolify.deleted).toEqual([]);
      expect((await audits('ops.coolify.app.delete')).map((a) => a.outcome)).toEqual(['denied', 'denied']);

      await h.db.pool.query(
        `INSERT INTO project_deploy_targets (project, config, version, updated_by, updated_at)
       VALUES ($1, $2, 1, $3, now())`,
        [
          OTHER,
          { coolify: { preview: { connection: null, uuids: [appB], tags: [] }, production: null } },
          ownerId,
        ],
      );
      const elsewhere = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/${appB}`);
      expect(elsewhere.statusCode, elsewhere.body).toBe(409);
      expect(elsewhere.json()).toMatchObject({ error: 'app_used_elsewhere' });
      await h.db.pool.query('DELETE FROM project_deploy_targets WHERE project = $1', [OTHER]);
      expect((await operator.req('DELETE', `/projects/${PROJECT}/coolify/apps/${appB}`)).statusCode).toBe(
        403,
      );
      expect((await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/foreign0001`)).statusCode).toBe(
        404,
      );
      expect(coolify.deleted).toEqual([]);
    });

    it('deletes the unlinked duplicate (volumes kept) and the linked one (unlinked from the target)', async () => {
      const b = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/${appB}`);
      expect(b.statusCode, b.body).toBe(200);
      expect(b.json()).toMatchObject({
        appUuid: appB,
        unlinked: [],
        creations: 1,
        options: { deleteVolumes: false },
      });
      expect(coolify.deleted.at(-1)).toEqual({
        uuid: appB,
        query: {
          delete_configurations: 'true',
          delete_volumes: 'false',
          docker_cleanup: 'true',
          delete_connected_networks: 'true',
        },
      });
      const list = (await owner.req('GET', `/projects/${PROJECT}/coolify/apps`)).json<{
        creations: { appUuid: string | null; deletedAt: string | null }[];
      }>();
      expect(list.creations.find((c) => c.appUuid === appB)?.deletedAt).not.toBeNull();
      // Deleted: no longer an application of the project.
      expect((await owner.req('GET', `/projects/${PROJECT}/coolify/apps/${appB}/logs`)).statusCode).toBe(404);

      const a = await owner.req('DELETE', `/projects/${PROJECT}/coolify/apps/${appA}?deleteVolumes=true`);
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json()).toMatchObject({ unlinked: ['preview'], options: { deleteVolumes: true } });
      expect(coolify.deleted.at(-1)?.query.delete_volumes).toBe('true');
      expect((await targets()).preview).toBeNull();
      const audit = (await audits('ops.coolify.app.delete')).filter((x) => x.outcome === 'success');
      expect(audit.map((x) => x.metadata.appUuid)).toEqual([appB, appA]);
      expect(audit.at(-1)?.metadata).toMatchObject({ unlinked: ['preview'], via: 'api' });
    });

    describe('the assistant (coolify_* tools through the real transport)', () => {
      const engine = new FakeAssistantEngine();
      const dirs: string[] = [];
      let worker: RunningWorker | undefined;
      let appC = '';
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

      it('the same create twice in one turn gives two cards with one key: confirming both creates once', async () => {
        const t = await thread();
        const call = tool('coolify_create_app', {
          project: PROJECT,
          env: 'preview',
          name: 'sahne-chat',
          deploy: true,
          // The assistant's own suggestion: a card (p15-chat-execute-default would otherwise run it at once).
          propose: true,
        });
        await ask(t, `${call} ${call}`);
        const drafts = (await detail(t)).drafts;
        expect(drafts).toHaveLength(2);
        const keys = drafts.map((d) => (d.payload?.request as { idempotencyKey: string }).idempotencyKey);
        expect(keys[0]).toBe(keys[1]);
        const before = coolify.created.length;
        for (const d of drafts) {
          const ok = await owner.req('POST', `/chat/drafts/${d.id}/confirm`);
          expect(ok.statusCode, ok.body).toBe(200);
        }
        expect(coolify.created.length).toBe(before + 1);
        appC = coolify.created.at(-1)?.uuid ?? '';
        expect((await targets()).preview?.uuids).toEqual([appC]);
      });

      it('a create for the same repository + branch makes no card and names the application to fix', async () => {
        const t = await thread();
        const before = coolify.created.length;
        const reply = await ask(
          t,
          tool('coolify_create_app', {
            project: PROJECT,
            env: 'preview',
            name: 'sahne-metin-main',
            execute: true,
          }),
        );
        expect(reply).toContain('refused');
        expect(reply).toContain(appC);
        expect(reply).toContain('coolify_deploy_logs');
        expect((await detail(t)).drafts).toEqual([]);
        expect(coolify.created.length).toBe(before);
      });

      it('reads the logs, fixes the same application and redeploys it', async () => {
        const t = await thread();
        const logs = await ask(t, tool('coolify_deploy_logs', { project: PROJECT, env: 'preview' }));
        expect(logs).toContain('answered');
        expect(logs).toContain(appC);
        expect(logs).toContain('Building image');
        expect(logs).not.toContain(TOKEN_IN_LOG);
        const fixed = await ask(
          t,
          tool('coolify_update_app', {
            project: PROJECT,
            appUuid: appC,
            ports: '4000',
            deploy: true,
            execute: true,
          }),
        );
        expect(fixed).toContain('executed');
        expect(coolify.apps.get(appC)?.ports_exposes).toBe('4000');
        expect((await audits('ops.coolify.app.update')).at(-1)?.metadata).toMatchObject({
          via: 'chat',
          appUuid: appC,
        });
        const secret = await ask(
          t,
          tool('coolify_update_app', {
            project: PROJECT,
            appUuid: appC,
            startCommand: `API_KEY=${TOKEN_IN_LOG} node s.js`,
          }),
        );
        expect(secret).toContain('secret');
        expect((await detail(t)).drafts.filter((d) => d.state === 'proposed')).toEqual([]);
      });

      it('delete without execute stays a destructive card; it runs when the user confirms', async () => {
        const t = await thread();
        await ask(t, tool('coolify_delete_app', { project: PROJECT, appUuid: appC }));
        const d = (await detail(t)).drafts[0];
        expect(d).toMatchObject({
          kind: 'coolify_change',
          state: 'proposed',
          payload: { op: 'delete_app', destructive: true },
        });
        expect(coolify.apps.has(appC)).toBe(true);
        const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(coolify.apps.has(appC)).toBe(false);
        expect((await targets()).preview).toBeNull();
        expect((await audits('ops.coolify.app.delete')).at(-1)).toMatchObject({
          outcome: 'success',
          metadata: { appUuid: appC, via: 'chat', unlinked: ['preview'] },
        });
        // Without an appUuid nothing is guessed.
        const none = await ask(t, tool('coolify_delete_app', { project: PROJECT }));
        expect(none).toContain('refused');
      });
    });
  },
);
