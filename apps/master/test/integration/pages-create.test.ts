import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-pages-create against a real master (Postgres) and the local fake Cloudflare: `pages.create_project` (Direct
 * Upload, no source; exists → refused or adopted; use as this project's Pages target with the deploy-target right and
 * step-up; policy; stale after a target change) and `pages.add_domain` (attach + CNAME through the dns.upsert plan in
 * an allowed zone, refused zones and protected names, manual record outside the account, conflicts, validation
 * status read-back and the 24 h limit), plus the chat tool `draft_pages_project`.
 */
const PW = 'quartz-meadow-lantern-7';
const SITE = 'site';
const FRESH = 'fresh';

const cf = new FakeCloudflare();
let h: Harness;
let owner: Client;
let ownerSecret = '';
let ownerId = '';
let operator: Client;
let operatorId = '';
let operatorSecret = '';
let viewer: Client;
let zoneId = '';
let otherZoneId = '';
const bodies: string[] = [];

type Action = {
  id: string;
  kind: string;
  state: string;
  env: string | null;
  policy: { decision: string; reason: string };
  diff: Record<string, unknown>;
  target: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  rollbackAvailable: boolean;
};

async function call(c: Client, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
  const res = await c.req(method, url, body);
  bodies.push(res.body);
  return res;
}

async function stepUp(): Promise<void> {
  h.clock.advance(30_000);
  const res = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
  expect(res.statusCode, res.body).toBe(200);
}

async function request(c: Client, project: string, kind: string, params: Record<string, unknown>) {
  return call(c, 'POST', '/deploy/actions', {
    project,
    kind,
    params,
    idempotencyKey: `k-${randomUUID()}`,
  });
}

async function approve(id: string): Promise<Action> {
  const res = await call(owner, 'POST', `/deploy/actions/${id}/approve`, {});
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Action>();
}

async function targets(
  project: string,
): Promise<{ targets: Record<string, unknown> | null; version: number | null }> {
  return (await call(owner, 'GET', `/projects/${project}/deploy-targets`)).json();
}

async function putTargets(project: string, t: Record<string, unknown>): Promise<void> {
  await stepUp();
  const res = await call(owner, 'PUT', `/projects/${project}/deploy-targets`, { targets: t });
  expect(res.statusCode, res.body).toBe(200);
}

const SITE_TARGETS = (policy: Record<string, unknown> = {}, pages = 'site-web') => ({
  pages: { projectName: pages },
  dns: { zones: [{ id: zoneId, name: 'example.test' }], protectedNames: ['keep.example.test'] },
  policy,
});

describeIntegration(
  'Cloudflare Pages project creation and domains (integration, p6-pages-create)',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await cf.start();
      h = new Harness();
      await h.start({
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          // OPS_PROTECTED_HOSTS: a second console host, protected like the PUBLIC_ORIGIN one.
          protectedHosts: ['console.example.org'],
          internalOrigins: [cf.base],
          cloudflareApi: `${cf.base}/client/v4`,
          controlPlaneAddresses: ['203.0.113.10'],
          limits: { perProjectPer10Min: 100 },
        },
      });
      ownerId = await h.createUser('owner1', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [SITE, FRESH], 'operator');
      operatorSecret = (await enroll(h, 'oper1', PW)).secret;
      operator = await fullLogin(h, 'oper1', PW, operatorSecret);
      const vw = await h.createUser('view1', PW, 'viewer');
      await h.grant(vw, [SITE, FRESH], 'viewer');
      viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);

      zoneId = cf.addZone('example.test');
      otherZoneId = cf.addZone('other.test');
      cf.addRecord(zoneId, {
        type: 'A',
        name: 'api.example.test',
        content: '192.0.2.5',
        ttl: 1,
        proxied: false,
      });
      cf.addRecord(zoneId, {
        type: 'CNAME',
        name: 'cp.example.test',
        content: '203.0.113.10',
        ttl: 1,
        proxied: false,
      });
      cf.pagesProjects.set('site-web', {
        name: 'site-web',
        production_branch: 'main',
        domains: [],
        deployments: [],
      });
      cf.pagesProjects.set('legacy-site', {
        name: 'legacy-site',
        production_branch: 'production',
        domains: ['legacy.example.test'],
        deployments: [],
      });
      await stepUp();
      expect(
        (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
          .statusCode,
      ).toBe(200);
      await putTargets(SITE, SITE_TARGETS());
    });
    afterAll(async () => {
      await h.stop();
      await cf.stop();
    });

    it('validates the name and options before any provider call; viewers cannot request', async () => {
      cf.reset();
      for (const name of ['Site', 'my_site', '-site', 'site-', 'a'.repeat(59), '']) {
        const res = await request(operator, FRESH, 'pages.create_project', { name });
        expect(res.statusCode, name).toBe(400);
        expect(res.body).toContain('invalid_params');
      }
      // p10-site-upload: "adopt" (with or without "use as target") is a deploy-target change — operators are
      // refused before any provider call.
      const adopt = await request(operator, FRESH, 'pages.create_project', { name: 'x1', ifExists: 'adopt' });
      expect(adopt.statusCode).toBe(403);
      expect(adopt.json()).toMatchObject({ error: 'targets_write_forbidden' });
      const extra = await request(operator, FRESH, 'pages.create_project', {
        name: 'x1',
        source: { type: 'github' },
      });
      expect(extra.statusCode).toBe(400);
      expect(cf.calls()).toEqual([]);
      expect((await request(viewer, FRESH, 'pages.create_project', { name: 'x1' })).statusCode).toBe(403);
    });

    it('creates a Direct Upload project after approval, even before the project has deploy targets', async () => {
      cf.reset();
      expect((await targets(FRESH)).targets).toBeNull();
      const pv = await call(operator, 'POST', '/deploy/actions/preview', {
        project: FRESH,
        kind: 'pages.create_project',
        params: { name: 'fresh-site' },
      });
      expect(pv.statusCode, pv.body).toBe(200);
      expect(pv.json()).toMatchObject({
        env: null,
        policy: { decision: 'approval' },
        diff: {
          action: 'create project',
          project: 'fresh-site',
          productionBranch: 'main',
          directUpload: true,
        },
      });
      const res = await request(operator, FRESH, 'pages.create_project', {
        name: 'fresh-site',
        productionBranch: 'live',
      });
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<Action>();
      expect(a).toMatchObject({
        state: 'awaiting_approval',
        policy: { decision: 'approval' },
        rollbackAvailable: false,
      });
      expect(cf.calls(/^POST/)).toEqual([]);
      const done = await approve(a.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'succeeded',
        result: {
          projectName: 'fresh-site',
          subdomain: 'fresh-site.pages.dev',
          productionBranch: 'live',
          created: true,
          deployTarget: false,
          links: ['https://fresh-site.pages.dev'],
        },
        rollbackAvailable: false,
      });
      const post = cf.requests.filter((r) => r.method === 'POST');
      expect(post.map((r) => r.path)).toEqual([`/client/v4/accounts/${cf.account}/pages/projects`]);
      // Direct Upload: name + production branch only, no source repository.
      expect(JSON.parse(post[0]?.body ?? '{}')).toEqual({ name: 'fresh-site', production_branch: 'live' });
      expect(post[0]?.auth).toBe(`Bearer ${cf.token}`);
      // p10-site-upload: without "use as target" the new project is kept as a further Pages project of this
      // project; the (absent) target is not set.
      expect(done.result).toMatchObject({ pagesProjectAdded: true });
      expect((await targets(FRESH)).targets).toMatchObject({ pages: null, pagesProjects: ['fresh-site'] });
    });

    it('refuses an existing name unless "adopt existing" is chosen; nothing is stored', async () => {
      const before = await h.db.pool.query('SELECT count(*)::int AS n FROM ops_actions');
      const res = await request(operator, FRESH, 'pages.create_project', { name: 'legacy-site' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'pages_project_exists' });
      expect(res.json<{ message: string }>().message).toContain('adopt existing');
      const after = await h.db.pool.query('SELECT count(*)::int AS n FROM ops_actions');
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('"use as this project’s Pages target" needs the deploy-target right and a step-up (operators refused, audited)', async () => {
      const res = await request(operator, FRESH, 'pages.create_project', {
        name: 'fresh-two',
        useAsTarget: true,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'targets_write_forbidden' });
      const audit = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'ops.action.request' AND target = $1
        ORDER BY id DESC LIMIT 1`,
        [`project:${FRESH}`],
      );
      expect(audit.rows[0]).toMatchObject({
        outcome: 'denied',
        metadata: { reason: 'targets_write_forbidden' },
      });
      // The owner needs a current step-up for it.
      h.clock.advance(11 * 60_000);
      const stale = await request(owner, FRESH, 'pages.create_project', {
        name: 'legacy-site',
        ifExists: 'adopt',
        useAsTarget: true,
      });
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toContain('step_up_required');
    });

    it('adopts an existing project as the target: the diff shows the target change; approval sets it (audited)', async () => {
      cf.reset();
      await stepUp();
      const res = await request(owner, FRESH, 'pages.create_project', {
        name: 'legacy-site',
        ifExists: 'adopt',
        useAsTarget: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<Action>();
      expect(a).toMatchObject({
        state: 'awaiting_approval',
        diff: {
          action: 'adopt project',
          productionBranch: 'production',
          existing: { domains: ['legacy.example.test'] },
          deployTarget: { from: null, to: 'legacy-site' },
        },
      });
      const done = await approve(a.id);
      expect(done).toMatchObject({
        state: 'succeeded',
        result: { adopted: true, created: false, deployTarget: true },
      });
      expect(cf.calls(/^POST/)).toEqual([]);
      expect((await targets(FRESH)).targets).toMatchObject({ pages: { projectName: 'legacy-site' } });
      const audit = await h.db.pool.query<{ actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, metadata FROM audit_events WHERE action = 'ops.targets.write' AND target = $1
        ORDER BY id DESC LIMIT 1`,
        [`project:${FRESH}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({
        change: { pages: { from: null, to: 'legacy-site' } },
        opsAction: a.id,
        requestedBy: { type: 'user', id: ownerId },
      });
      // Adopting the current target again is no change.
      await stepUp();
      const again = await request(owner, FRESH, 'pages.create_project', {
        name: 'legacy-site',
        ifExists: 'adopt',
        useAsTarget: true,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: 'no_change' });
    });

    it('a changed target between request and approval is stale: nothing is created', async () => {
      cf.reset();
      await stepUp();
      const res = await request(owner, SITE, 'pages.create_project', {
        name: 'site-next',
        useAsTarget: true,
      });
      const a = res.json<Action>();
      expect(a.diff).toMatchObject({ deployTarget: { from: 'site-web', to: 'site-next' } });
      await putTargets(SITE, SITE_TARGETS({}, 'site-other'));
      const done = await approve(a.id);
      expect(done).toMatchObject({ state: 'failed' });
      expect(done.error).toContain('changed');
      expect(cf.calls(/^POST/)).toEqual([]);
      expect(cf.pagesProjects.has('site-next')).toBe(false);
      await putTargets(SITE, SITE_TARGETS());
    });

    it('policy auto runs at once; the real pages.dev name (with Cloudflare’s suffix) is used', async () => {
      await putTargets(SITE, SITE_TARGETS({ pagesProject: 'auto' }, 'site-web'));
      cf.subdomainSuffix = '-7xq';
      const res = await request(owner, SITE, 'pages.create_project', {
        name: 'site-blog',
        useAsTarget: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<Action>()).toMatchObject({
        state: 'succeeded',
        policy: { decision: 'auto' },
        result: {
          subdomain: 'site-blog-7xq.pages.dev',
          deployTarget: true,
          links: ['https://site-blog-7xq.pages.dev'],
        },
      });
      cf.subdomainSuffix = '';
      expect((await targets(SITE)).targets).toMatchObject({ pages: { projectName: 'site-blog' } });
      await putTargets(SITE, SITE_TARGETS());
    });

    it('add_domain in an allowed zone: attach, then the CNAME to the pages.dev name; pending → active read-back', async () => {
      cf.reset();
      const res = await request(operator, SITE, 'pages.add_domain', { domain: 'WWW.example.test' });
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<Action>();
      expect(a).toMatchObject({
        state: 'awaiting_approval',
        policy: { decision: 'approval' },
        target: { project: 'site-web', domain: 'www.example.test', zone: 'example.test' },
        diff: {
          action: 'add domain',
          attach: 'attach',
          subdomain: 'site-web.pages.dev',
          dns: {
            action: 'create',
            type: 'CNAME',
            name: 'www.example.test',
            before: null,
            after: { content: 'site-web.pages.dev', proxied: true, ttl: 1 },
          },
        },
      });
      expect(cf.calls(/^POST/)).toEqual([]);
      const done = await approve(a.id);
      expect(done, JSON.stringify(done)).toMatchObject({
        state: 'deploying',
        result: { domain: 'www.example.test', status: 'pending', dns: { created: true } },
      });
      expect(cf.calls(/^POST/)).toEqual([
        `POST /client/v4/accounts/${cf.account}/pages/projects/site-web/domains`,
        `POST /client/v4/zones/${zoneId}/dns_records`,
      ]);
      const rec = cf.zones.get(zoneId)?.records.find((r) => r.name === 'www.example.test');
      expect(rec).toMatchObject({ type: 'CNAME', content: 'site-web.pages.dev', proxied: true });
      const still = (await call(operator, 'POST', `/deploy/actions/${a.id}/refresh`)).json<Action>();
      expect(still.state).toBe('deploying');
      const d = cf.pagesDomains.get('site-web')?.find((x) => x.name === 'www.example.test');
      if (d !== undefined) d.status = 'active';
      const active = (await call(operator, 'POST', `/deploy/actions/${a.id}/refresh`)).json<Action>();
      expect(active).toMatchObject({
        state: 'succeeded',
        result: { status: 'active', validation: { status: 'active' } },
      });
      // Attached and the CNAME already right → no change.
      const again = await request(operator, SITE, 'pages.add_domain', { domain: 'www.example.test' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: 'no_change' });
    });

    it('add_domain refuses other zones of the account, protected names and the console host; conflicts are explained', async () => {
      cf.reset();
      const other = await request(operator, SITE, 'pages.add_domain', { domain: 'app.other.test' });
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ error: 'zone_not_allowed' });
      expect(otherZoneId).not.toBe('');
      const conflict = await request(operator, SITE, 'pages.add_domain', { domain: 'api.example.test' });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: 'dns_conflict' });
      for (const domain of [
        'keep.example.test',
        'console.example.test',
        'console.example.org',
        'cp.example.test',
      ]) {
        const res = await request(operator, SITE, 'pages.add_domain', { domain });
        expect(res.statusCode, `${domain} ${res.body}`).toBe(201);
        expect(res.json<Action>(), domain).toMatchObject({
          state: 'refused',
          policy: { decision: 'refused' },
        });
      }
      expect(cf.calls(/^POST/)).toEqual([]);
    });

    it('a domain outside the account: attach only, the card names the record to add by hand; 24 h pending → failed', async () => {
      cf.reset();
      const res = await request(operator, SITE, 'pages.add_domain', { domain: 'shop.external.test' });
      const a = res.json<Action>();
      expect(a).toMatchObject({
        policy: { decision: 'approval' },
        diff: {
          dns: {
            action: 'manual',
            record: { type: 'CNAME', name: 'shop.external.test', content: 'site-web.pages.dev' },
          },
        },
      });
      const done = await approve(a.id);
      expect(done.state).toBe('deploying');
      expect(cf.calls(/^POST/)).toEqual([
        `POST /client/v4/accounts/${cf.account}/pages/projects/site-web/domains`,
      ]);
      h.clock.advance(25 * 60 * 60_000);
      // A day later the sessions are gone: sign in again.
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      operator = await fullLogin(h, 'oper1', PW, operatorSecret);
      const late = (await call(operator, 'POST', `/deploy/actions/${a.id}/refresh`)).json<Action>();
      expect(late.state).toBe('failed');
      expect(late.error).toContain('24 hours');
    });

    it('DNS skip, and the stricter DNS policy level when the domain also writes DNS', async () => {
      const skip = await request(operator, SITE, 'pages.add_domain', {
        domain: 'blog.example.test',
        dns: 'skip',
      });
      expect(skip.json<Action>()).toMatchObject({
        policy: { decision: 'approval' },
        diff: { dns: { action: 'skipped' } },
      });
      await putTargets(SITE, SITE_TARGETS({ dnsChange: 'approval_step_up', pagesProject: 'auto' }));
      const strict = await request(operator, SITE, 'pages.add_domain', { domain: 'docs.example.test' });
      expect(strict.json<Action>()).toMatchObject({ policy: { decision: 'approval_step_up' } });
      const autoOnly = await request(operator, SITE, 'pages.add_domain', {
        domain: 'docs2.example.test',
        dns: 'skip',
      });
      expect(autoOnly.json<Action>()).toMatchObject({ policy: { decision: 'auto' } });
      await putTargets(SITE, SITE_TARGETS());
    });

    it('add_domain needs a Pages target', async () => {
      await putTargets(SITE, { ...SITE_TARGETS(), pages: null });
      const res = await request(operator, SITE, 'pages.add_domain', { domain: 'x.example.test' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'no_pages_target' });
      await putTargets(SITE, SITE_TARGETS());
    });

    it('chat: draft_pages_project drafts a card (no provider write); use-as-target needs a project admin', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        ops: () => h.app.ops,
      } as unknown as ChatToolsDeps);
      const caller = async (userId: string, role: Role): Promise<ToolCaller> => ({
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: (await store.createThread(userId, 'pages')).id,
        turnId: randomUUID(),
      });
      cf.reset();
      const op = await caller(operatorId, 'operator');
      const denied = await tools.run(op, 'draft_pages_project', {
        project: SITE,
        operation: 'create',
        name: 'chat-site',
        useAsTarget: true,
      });
      expect(denied).toMatchObject({ ok: false, code: 'forbidden' });
      const c = await caller(ownerId, 'owner');
      const out = await tools.run(c, 'draft_pages_project', {
        project: SITE,
        operation: 'create',
        name: 'chat-site',
        useAsTarget: true,
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok || out.draft === undefined) throw new Error('no draft');
      expect(out.data).toMatchObject({
        kind: 'ops_action',
        action: 'pages.create_project',
        policy: { decision: 'approval' },
        diff: { action: 'create project', deployTarget: { from: 'site-web', to: 'chat-site' } },
      });
      expect(JSON.stringify(out.data)).not.toContain(cf.token);
      const dom = await tools.run(c, 'draft_pages_project', {
        project: SITE,
        operation: 'add_domain',
        domain: 'chat.example.test',
      });
      expect(dom.ok ? dom.data : dom).toMatchObject({
        action: 'pages.add_domain',
        diff: { dns: { action: 'create' } },
      });
      expect(await tools.run(c, 'draft_pages_project', { project: SITE, operation: 'create' })).toMatchObject(
        {
          ok: false,
          code: 'invalid',
        },
      );
      expect(cf.calls(/^POST/)).toEqual([]);
      // Confirming requests it (the confirmation carries the step-up); approval creates and sets the target.
      await stepUp();
      const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
      expect(conf.statusCode, conf.body).toBe(200);
      const r = conf.json<{ result: { actionId: string; state: string } }>().result;
      expect(r.state).toBe('awaiting_approval');
      expect((await approve(r.actionId)).state).toBe('succeeded');
      expect((await targets(SITE)).targets).toMatchObject({ pages: { projectName: 'chat-site' } });
    });

    it('never returns, stores or logs the Cloudflare token', async () => {
      for (const b of bodies) expect(b).not.toContain(cf.token);
      const rows = await h.db.pool.query<{ t: string }>(
        `SELECT row_to_json(a)::text AS t FROM ops_actions a
       UNION ALL SELECT row_to_json(e)::text FROM audit_events e`,
      );
      for (const r of rows.rows) expect(r.t).not.toContain(cf.token);
      expect(h.logs.text).not.toContain(cf.token);
    });
  },
);
