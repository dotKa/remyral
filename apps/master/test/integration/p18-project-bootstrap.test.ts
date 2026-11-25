import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-project-bootstrap (docs/design/p18-project-bootstrap.md) on real Postgres and the real routes:
 *
 * - `describe_project_readiness`, `draft_project_network`, `draft_project_machines` answer only a turn on a worker with
 *   `assistant-project-setup-v1` (older worker: unavailable);
 * - readiness of a new repository project: no repository, network never decided; after the network card it is decided;
 * - opening the network is a card by default (`cardOnly: default`, always-fresh step-up); confirmed by the owner it
 *   writes through the console's repo-egress service (audited `project.repo_egress.update`);
 * - the machines card assigns a machine (a new worker configuration generation) and sets the preferred machines
 *   (audited `project.preferred_workers.update`); `GET/PUT /projects/:id/preferred-workers` with step-up;
 * - an operator may read the readiness but not change network or machines;
 * - `GET /projects/:id/git/state` without a repository: not_applicable.
 */
const PW = 'lantern-meadow-pebble-58';
const REPO = 'pb-leads';
const WS = 'pb-notes';
const W1 = 'wrk_pblinuxaaaaaaaaaaaaaaaaaaa';
const W2 = 'wrk_pbdesktopaaaaaaaaaaaaaaaaa';

describeIntegration('p18 project bootstrap (integration)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let opId = '';

  const stepUp = async (c: Client, secret: string): Promise<void> => {
    h.clock.advance(31_000);
    const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  };
  const audits = async (action: string) =>
    (
      await h.db.pool.query<{ metadata: Record<string, unknown>; outcome: string }>(
        'SELECT metadata, outcome FROM audit_events WHERE action = $1 ORDER BY id',
        [action],
      )
    ).rows;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 } });
    ownerId = await h.createUser('owner.pb', PW);
    ownerSecret = (await enroll(h, 'owner.pb', PW)).secret;
    owner = await fullLogin(h, 'owner.pb', PW, ownerSecret);
    opId = await h.createUser('op.pb', PW, 'operator');
    await h.grant(opId, [REPO, WS], 'operator');
    await h.db.pool.query(
      `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()), ($2, $2, now()) ON CONFLICT DO NOTHING`,
      [REPO, WS],
    );
    await h.db.pool.query(`UPDATE projects SET kind = 'workspace' WHERE id = $1`, [WS]);
    await h.db.pool.query(
      `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'none', now()) ON CONFLICT DO NOTHING`,
      [WS],
    );
    const now = new Date();
    for (const [id, os] of [
      [W1, 'linux'],
      [W2, 'win32'],
    ] as const) {
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, approved_at, created_at, updated_at)
         VALUES ($1, $1, 'online', $2::jsonb, '1.2.3', $3, $3, $3) ON CONFLICT DO NOTHING`,
        [id, JSON.stringify({ os, arch: 'x64' }), now],
      );
    }
  });
  afterAll(async () => {
    await h.stop();
  });

  const tools = (): ChatTools => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    return new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      opsTools: () => app.chatOpsTools,
      projectSetup: () => app.chatProjectSetup,
    } as unknown as ChatToolsDeps);
  };
  const ctx = async (userId: string, role: 'owner' | 'operator', extra: Record<string, unknown> = {}) => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    return {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role }),
      threadId: (await store.createThread(userId, 'bootstrap')).id,
      turnId: randomUUID(),
      ...extra,
    };
  };
  const payloadOf = async (draftId: string | undefined) =>
    (
      await h.db.pool.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM chat_drafts WHERE id = $1',
        [draftId ?? null],
      )
    ).rows[0]?.payload;

  it('an older worker gets "unavailable"; the readiness of a new repository project lists what is missing', async () => {
    const c = await ctx(ownerId, 'owner');
    const legacy = await tools().run(c, 'describe_project_readiness', { project: REPO });
    expect(!legacy.ok && legacy.code).toBe('unavailable');

    const r = await tools().run({ ...c, projectSetup: true }, 'describe_project_readiness', {
      project: REPO,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const data = (r.ok ? r.data : {}) as {
      repository: { linked: boolean };
      network: { decided: boolean; mode: string };
      machines: { id: string }[];
      missing: string[];
    };
    expect(data.repository).toEqual({ linked: false });
    expect(data.network).toMatchObject({ mode: 'none', decided: false });
    expect(data.missing).toEqual(expect.arrayContaining(['repository', 'network']));

    const state = await owner.req('GET', `/projects/${REPO}/git/state`);
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json<{ state: string }>().state).toBe('not_applicable');
  });

  it('opening the network is a card by default; confirmed it writes through the console service', async () => {
    const c = await ctx(ownerId, 'owner', { projectSetup: true });
    const out = await tools().run(c, 'draft_project_network', {
      project: REPO,
      mode: 'allowlist',
      presets: ['npm', 'github'],
      hosts: ['api.stripe.com'],
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const draftId = out.ok ? out.draft?.id : undefined;
    expect(await payloadOf(draftId)).toMatchObject({
      op: 'project.network',
      event: 'projects.policy',
      cardOnly: 'default',
      project: REPO,
    });
    await stepUp(owner, ownerSecret);
    const confirmed = await owner.req('POST', `/chat/drafts/${draftId ?? ''}/confirm`, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const egress = await owner.req('GET', `/projects/${REPO}/repo-egress`);
    expect(egress.json<{ mode: string; presets: string[]; hosts: string[] }>()).toMatchObject({
      mode: 'allowlist',
      presets: ['npm', 'github'],
      hosts: ['api.stripe.com'],
    });
    expect((await audits('project.repo_egress.update')).at(-1)?.outcome).toBe('success');

    const again = await tools().run(c, 'describe_project_readiness', { project: REPO });
    const data = (again.ok ? again.data : {}) as { network: { decided: boolean }; missing: string[] };
    expect(data.network.decided).toBe(true);
    expect(data.missing).not.toContain('network');
  });

  it('the machines card assigns a machine and sets the preferred machines', async () => {
    const c = await ctx(ownerId, 'owner', { projectSetup: true });
    const out = await tools().run(c, 'draft_project_machines', { project: WS, add: [W1], preferred: [W1] });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const draftId = out.ok ? out.draft?.id : undefined;
    expect(await payloadOf(draftId)).toMatchObject({
      op: 'project.machines',
      event: 'machines.config',
      add: [W1],
      preferred: [W1],
    });
    await stepUp(owner, ownerSecret);
    const confirmed = await owner.req('POST', `/chat/drafts/${draftId ?? ''}/confirm`, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const list = await owner.req('GET', `/projects/${WS}/workers`);
    const items = list.json<{ items: { workerId: string; assigned: boolean }[] }>().items;
    expect(items.find((w) => w.workerId === W1)?.assigned).toBe(true);
    expect(items.find((w) => w.workerId === W2)?.assigned).toBe(false);
    const pref = await owner.req('GET', `/projects/${WS}/preferred-workers`);
    expect(pref.json<{ workerIds: string[] }>().workerIds).toEqual([W1]);
    expect((await audits('project.preferred_workers.update')).at(-1)?.metadata).toMatchObject({
      project: WS,
      after: [W1],
    });
  });

  it('the preferred machines route: step-up, enrolled machines only, an empty list removes the preference', async () => {
    await stepUp(owner, ownerSecret);
    const bad = await owner.req('PUT', `/projects/${WS}/preferred-workers`, { workerIds: ['wrk_nowhere'] });
    expect(bad.statusCode, bad.body).toBe(400);
    const ok = await owner.req('PUT', `/projects/${WS}/preferred-workers`, { workerIds: [W2, W1] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ workerIds: string[] }>().workerIds).toEqual([W2, W1].sort());
    const cleared = await owner.req('PUT', `/projects/${WS}/preferred-workers`, { workerIds: [] });
    expect(cleared.json<{ workerIds: string[] }>().workerIds).toEqual([]);
  });

  it('an operator reads the readiness but changes neither network nor machines', async () => {
    const c = await ctx(opId, 'operator', { projectSetup: true });
    const read = await tools().run(c, 'describe_project_readiness', { project: WS });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const net = await tools().run(c, 'draft_project_network', { project: REPO, mode: 'web' });
    expect(!net.ok && net.code).toBe('forbidden');
    const machines = await tools().run(c, 'draft_project_machines', { project: WS, add: [W2] });
    expect(!machines.ok && machines.code).toBe('forbidden');
  });
});
