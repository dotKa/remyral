import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { BUNDLE_APPROVAL_REASON } from '../../src/ops/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p10-publish-bundle (ADR-0038) against a real master (Postgres) and the local fake Cloudflare: one `pages.publish`
 * stands for "create the Pages project if missing → deploy an uploaded site → attach a custom domain → write its
 * CNAME", is approved ONCE (with a fresh code when production or DNS is involved) and then runs every step as its own
 * pre-approved child action, re-checked at execution; a failure stops the chain, a changed precondition is refused,
 * and DNS "Run at once" is limited to CNAMEs pointing at the project's own Pages projects. Plus the 424 provider
 * errors with the DNS permission hint and the Test connection DNS probe.
 */
const PW = 'quartz-meadow-lantern-7';
const SITE = 'pubsite';

const cf = new FakeCloudflare();
let h: Harness;
let owner: Client;
let ownerSecret = '';
let ownerId = '';
let operator: Client;
let operatorId = '';
let zoneId = '';
const bodies: string[] = [];

type Action = {
  id: string;
  kind: string;
  state: string;
  env: string | null;
  policy: { decision: string; reason: string };
  diff: Record<string, unknown>;
  target: Record<string, unknown>;
  source: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  decidedBy: { id: string; username: string | null } | null;
  decisionReason: string | null;
};
type StepState = { step: string; state: string; actionId?: string; error?: string; note?: string };

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const page = (s: string) => Buffer.from(`<!doctype html><title>${s}</title><h1>${s}</h1>`, 'utf8');

async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
  const res = await c.req(method, url, body);
  bodies.push(res.body);
  return res;
}

async function stepUp(c: Client = owner, secret = ownerSecret): Promise<void> {
  h.clock.advance(30_000);
  const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
  expect(res.statusCode, res.body).toBe(200);
}

/** Start → every part → complete; returns the upload id. */
async function upload(c: Client, label: string): Promise<string> {
  const files = [
    { path: 'index.html', content: page(label) },
    { path: 'assets/app.css', content: Buffer.from('body{margin:0}') },
  ];
  const s = await call(c, 'POST', `/projects/${SITE}/site-uploads`, {
    files: files.map((f) => ({ path: f.path, size: f.content.length, sha256: sha(f.content) })),
    label,
  });
  expect(s.statusCode, s.body).toBe(201);
  const up = s.json<{ id: string; partSize: number; partCount: number }>();
  const all = Buffer.concat(files.map((f) => f.content));
  for (let n = 0; n < up.partCount; n++) {
    const part = all.subarray(n * up.partSize, (n + 1) * up.partSize);
    const r = await c.req('PUT', `/projects/${SITE}/site-uploads/${up.id}/parts/${String(n)}`, part, {
      'content-type': 'application/octet-stream',
      'x-part-sha256': sha(part),
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  const done = await call(c, 'POST', `/projects/${SITE}/site-uploads/${up.id}/complete`, {});
  expect(done.statusCode, done.body).toBe(200);
  return up.id;
}

async function request(c: Client, kind: string, params: Record<string, unknown>) {
  return call(c, 'POST', '/deploy/actions', {
    project: SITE,
    kind,
    params,
    idempotencyKey: `k-${randomUUID()}`,
  });
}

async function get(id: string): Promise<Action> {
  const res = await call(owner, 'GET', `/deploy/actions/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Action>();
}

async function children(bundleId: string): Promise<Action[]> {
  const { rows } = await h.db.pool.query<{ id: string }>(
    // The fake clock gives every step the same time: order by the step itself.
    `SELECT id::text AS id FROM ops_actions WHERE source->>'publishBundle' = $1
      ORDER BY array_position(ARRAY['create', 'deploy', 'domain'], source->>'step')`,
    [bundleId],
  );
  return Promise.all(rows.map((r) => get(r.id)));
}

async function setTargets(policy: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  await stepUp();
  const cur = (await call(owner, 'GET', `/projects/${SITE}/deploy-targets`)).json<{
    version: number | null;
  }>();
  const put = await call(owner, 'PUT', `/projects/${SITE}/deploy-targets`, {
    targets: {
      pages: { projectName: 'pub-main' },
      dns: { zones: [{ id: zoneId, name: 'demo.test' }], protectedNames: ['keep.demo.test'] },
      policy,
      ...extra,
    },
    ...(cur.version === null ? {} : { expectedVersion: cur.version }),
  });
  expect(put.statusCode, put.body).toBe(200);
}

const records = (name: string) => [...(cf.zones.get(zoneId)?.records ?? [])].filter((r) => r.name === name);

async function poll(): Promise<void> {
  h.clock.advance(20_000);
  await h.app.ops.pollDeploying();
}

describeIntegration('publish bundle (integration, p10-publish-bundle)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await cf.start();
    h = new Harness();
    await h.start({
      installers: { publicOrigin: 'https://console.example.test' },
      ops: {
        internalOrigins: [cf.base],
        cloudflareApi: `${cf.base}/client/v4`,
        controlPlaneAddresses: ['203.0.113.10'],
        limits: { perProjectPer10Min: 200 },
      },
    });
    ownerId = await h.createUser('owner1', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    operatorId = await h.createUser('oper1', PW, 'operator');
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
      [SITE],
    );
    await h.grant(operatorId, [SITE], 'operator');
    operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
    zoneId = cf.addZone('demo.test');
    cf.pagesProjects.set('pub-main', {
      name: 'pub-main',
      production_branch: 'main',
      domains: [],
      deployments: [],
    });
    await stepUp();
    expect(
      (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
        .statusCode,
    ).toBe(200);
    await setTargets();
  });
  afterAll(async () => {
    await h.stop();
    await cf.stop();
  });

  it('one request, ONE approval with a fresh code: create → production deploy → domain → CNAME, each step pre-approved and linked', async () => {
    const uploadId = await upload(operator, 'presentation');
    const res = await request(operator, 'pages.publish', {
      uploadId,
      env: 'production',
      pagesProject: 'pub-new',
      createIfMissing: true,
      domain: 'deck.demo.test',
    });
    expect(res.statusCode, res.body).toBe(201);
    const a = res.json<Action>();
    expect(a).toMatchObject({ kind: 'pages.publish', state: 'awaiting_approval', env: 'production' });
    expect(a.policy.decision).toBe('approval_step_up');
    const steps = a.diff.steps as { step: string; decision: { decision: string } }[];
    expect(steps.map((s) => [s.step, s.decision.decision])).toEqual([
      ['create', 'approval'],
      ['deploy', 'approval_step_up'],
      ['domain', 'approval'],
    ]);
    expect(steps[2]).toMatchObject({ dns: { action: 'create', after: { content: 'pub-new.pages.dev' } } });
    // Nothing happened yet.
    expect(cf.pagesProjects.has('pub-new')).toBe(false);
    // An operator cannot approve; the owner needs a fresh code.
    expect((await call(operator, 'POST', `/deploy/actions/${a.id}/approve`, {})).statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    const stale = await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {});
    expect(stale.statusCode, stale.body).toBe(403);
    expect(stale.body).toContain('step_up_required');
    await stepUp();
    const ok = await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    let done = ok.json<Action>();
    if (done.state === 'deploying') {
      await poll();
      done = await get(a.id);
    }
    expect(done.state, JSON.stringify(done.result)).toBe('succeeded');
    const st = (done.result?.steps ?? []) as StepState[];
    expect(st.map((s) => [s.step, s.state])).toEqual([
      ['create', 'done'],
      ['deploy', 'done'],
      ['domain', 'done'],
    ]);
    expect(done.result?.links).toEqual(expect.arrayContaining(['https://deck.demo.test']));
    // Every step is its own action, decided by the bundle's approver without another approval, linked to it.
    const kids = await children(a.id);
    expect(kids.map((k) => k.kind)).toEqual(['pages.create_project', 'pages.deploy', 'pages.add_domain']);
    for (const k of kids) {
      expect(k.source).toMatchObject({ publishBundle: a.id });
      expect(k.decidedBy?.username).toBe('owner1');
      expect(k.decisionReason).toBe(BUNDLE_APPROVAL_REASON);
    }
    expect(kids[1]).toMatchObject({ env: 'production', state: 'succeeded' });
    // The project exists, was added as a further Pages project (target untouched), the CNAME is written.
    expect(cf.pagesProjects.get('pub-new')?.deployments).toHaveLength(1);
    const t = (await call(owner, 'GET', `/projects/${SITE}/deploy-targets`)).json<{
      targets: { pages: { projectName: string }; pagesProjects: string[] };
    }>().targets;
    expect(t.pages.projectName).toBe('pub-main');
    expect(t.pagesProjects).toContain('pub-new');
    expect(records('deck.demo.test')).toEqual([
      expect.objectContaining({ type: 'CNAME', content: 'pub-new.pages.dev', proxied: true }),
    ]);
    const audit = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.publish.step' AND target = $1`,
      [`ops-action:${a.id}`],
    );
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(3);
  });

  it('an existing Pages project that is not the project’s is never taken over; unknown names need createIfMissing', async () => {
    cf.pagesProjects.set('foreign', {
      name: 'foreign',
      production_branch: 'main',
      domains: [],
      deployments: [],
    });
    const uploadId = await upload(operator, 'x');
    const taken = await request(operator, 'pages.publish', {
      uploadId,
      pagesProject: 'foreign',
      createIfMissing: true,
    });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(taken.body).toContain('pages_project_exists');
    const notListed = await request(operator, 'pages.publish', { uploadId, pagesProject: 'brand-new' });
    expect(notListed.statusCode).toBe(403);
    expect(notListed.body).toContain('pages_project_not_allowed');
    // The console host and the project's protected names are refused.
    const prot = await request(operator, 'pages.publish', { uploadId, domain: 'keep.demo.test' });
    expect(prot.statusCode, prot.body).toBe(201);
    expect(prot.json<Action>()).toMatchObject({ state: 'refused' });
  });

  it('a failure in the middle stops the chain and tells (no domain attached)', async () => {
    const uploadId = await upload(operator, 'broken');
    const res = await request(operator, 'pages.publish', {
      uploadId,
      pagesProject: 'pub-fail',
      createIfMissing: true,
      domain: 'fail.demo.test',
      dns: 'skip',
    });
    const a = res.json<Action>();
    expect(a.policy.decision).toBe('approval');
    cf.failNext = {
      status: 500,
      match: /POST \/client\/v4\/accounts\/[^/]+\/pages\/projects\/pub-fail\/deployments$/,
    };
    cf.reset();
    await stepUp();
    const out = (await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {})).json<Action>();
    expect(out.state).toBe('failed');
    expect(out.error).toMatch(/Step deploy failed/);
    const st = (out.result?.steps ?? []) as StepState[];
    expect(st.map((s) => s.state)).toEqual(['done', 'failed', 'pending']);
    expect(cf.calls(/\/domains/)).toEqual([]);
    expect(cf.pagesDomains.get('pub-fail') ?? []).toEqual([]);
    const outbox = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE topic = 'ops.action' AND payload->>'actionId' = $1
         AND payload->>'event' = 'failed'`,
      [a.id],
    );
    expect(outbox.rows[0]?.n).toBe(1);
  });

  it('a step whose precondition changed after the approval is refused (DNS record written meanwhile)', async () => {
    const uploadId = await upload(operator, 'stale');
    const a = (
      await request(operator, 'pages.publish', { uploadId, domain: 'stale.demo.test' })
    ).json<Action>();
    expect(a.policy.decision).toBe('approval_step_up');
    // Keep the deploy running (Cloudflare does not answer the status read once).
    cf.failNext = {
      status: 500,
      match: /GET \/client\/v4\/accounts\/[^/]+\/pages\/projects\/pub-main\/deployments\/[^/]+$/,
    };
    await stepUp();
    const running = (await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {})).json<Action>();
    expect(running.state).toBe('deploying');
    // Someone writes the record before the domain step runs.
    cf.addRecord(zoneId, {
      type: 'CNAME',
      name: 'stale.demo.test',
      content: 'elsewhere.example.net',
      ttl: 1,
      proxied: false,
    });
    await poll();
    const out = await get(a.id);
    expect(out.state).toBe('failed');
    expect(out.error).toMatch(/target changed since the approval/);
    expect(records('stale.demo.test')).toEqual([
      expect.objectContaining({ content: 'elsewhere.example.net' }),
    ]);
    expect(cf.pagesDomains.get('pub-main')?.some((d) => d.name === 'stale.demo.test') ?? false).toBe(false);
  });

  it('a target changed before the approval: the whole bundle is not executed (stale)', async () => {
    const uploadId = await upload(operator, 'stale2');
    const a = (
      await request(operator, 'pages.publish', { uploadId, domain: 'early.demo.test' })
    ).json<Action>();
    cf.addRecord(zoneId, {
      type: 'CNAME',
      name: 'early.demo.test',
      content: 'other.example.net',
      ttl: 1,
      proxied: false,
    });
    cf.reset();
    await stepUp();
    const out = (await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {})).json<Action>();
    expect(out.state).toBe('failed');
    expect(out.error).toMatch(/target changed since the request/);
    expect(cf.calls(/POST .*deployments$/)).toEqual([]);
  });

  it('"Run at once" for every step: a preview publish with its CNAME runs without any approval; other DNS keeps its level', async () => {
    await setTargets({ previewDeploy: 'auto', pagesProject: 'auto', dnsChange: 'auto' });
    const uploadId = await upload(operator, 'auto');
    const res = await request(operator, 'pages.publish', {
      uploadId,
      pagesProject: 'pub-auto',
      createIfMissing: true,
      domain: 'auto.demo.test',
    });
    let a = res.json<Action>();
    expect(a.policy.decision).toBe('auto');
    if (a.state === 'deploying') {
      await poll();
      a = await get(a.id);
    }
    expect(a.state, JSON.stringify(a.result)).toBe('succeeded');
    expect(records('auto.demo.test')).toEqual([expect.objectContaining({ content: 'pub-auto.pages.dev' })]);
    // dns.upsert: a CNAME to an own pages.dev runs at once …
    const own = (
      await request(operator, 'dns.upsert', {
        zone: 'demo.test',
        type: 'CNAME',
        name: 'www2.demo.test',
        content: 'pub-main.pages.dev',
        proxied: true,
      })
    ).json<Action>();
    expect(own).toMatchObject({ state: 'succeeded', policy: { decision: 'auto' } });
    // … a foreign CNAME, an A record and a delete do not.
    const foreign = (
      await request(operator, 'dns.upsert', {
        zone: 'demo.test',
        type: 'CNAME',
        name: 'www3.demo.test',
        content: 'someone-else.pages.dev',
      })
    ).json<Action>();
    expect(foreign).toMatchObject({ state: 'awaiting_approval', policy: { decision: 'approval' } });
    const aRec = (
      await request(operator, 'dns.upsert', {
        zone: 'demo.test',
        type: 'A',
        name: 'www4.demo.test',
        content: '198.51.100.7',
      })
    ).json<Action>();
    expect(aRec.policy.decision).toBe('approval');
    const del = (
      await request(operator, 'dns.delete', { zone: 'demo.test', type: 'CNAME', name: 'www2.demo.test' })
    ).json<Action>();
    expect(del.policy.decision).toBe('approval_step_up');
    // Production never runs at once.
    const prod = (
      await request(operator, 'pages.publish', { uploadId, pagesProject: 'pub-auto', env: 'production' })
    ).json<Action>();
    expect(prod).toMatchObject({ state: 'awaiting_approval', policy: { decision: 'approval_step_up' } });
    await setTargets();
  });

  it('provider errors are 424 with the provider named and the DNS permission hint', async () => {
    cf.failNext = { status: 403, match: /GET \/client\/v4\/zones\/[^/]+\/dns_records/ };
    const res = await request(operator, 'dns.upsert', {
      zone: 'demo.test',
      type: 'CNAME',
      name: 'hint.demo.test',
      content: 'pub-main.pages.dev',
    });
    expect(res.statusCode, res.body).toBe(424);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe('cloudflare_forbidden');
    expect(body.message).toMatch(
      /^Cloudflare: list DNS records: .* — the token needs Zone → DNS → Edit for demo\.test$/,
    );
  });

  it('Test connection probes DNS read per allowed zone and explains the permission', async () => {
    const ok = await call(owner, 'POST', '/integrations/ops/cloudflare/test', {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ dns: unknown[] }>().dns).toEqual([
      { zone: 'demo.test', zoneId, ok: true, projects: [SITE] },
    ]);
    cf.failNext = { status: 403, match: /GET \/client\/v4\/zones\/[^/]+\/dns_records\?per_page=1$/ };
    const bad = (await call(owner, 'POST', '/integrations/ops/cloudflare/test', {})).json<{
      dns: { zone: string; ok: boolean; error?: string }[];
      dnsHint?: string;
      warnings: string[];
    }>();
    expect(bad.dns[0]).toMatchObject({ zone: 'demo.test', ok: false });
    expect(bad.dns[0]?.error).toContain('missing Zone → DNS → Edit for demo.test');
    expect(bad.dnsHint).toMatch(/DNS View.*Account DNS Settings.*DNS Firewall/);
    expect(bad.warnings.join(' ')).toContain('Zone → DNS → Edit for demo.test');
  });

  it('chat: draft_deploy pages.publish is ONE card for the whole chain; confirming requests it, one approval runs it', async () => {
    const uploadId = await upload(owner, 'chat');
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      ops: () => app.ops,
    } as unknown as ChatToolsDeps);
    const thread = await store.createThread(ownerId, 'publish');
    const caller = {
      userId: ownerId,
      subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
    const out = await tools.run(caller, 'draft_deploy', {
      project: SITE,
      action: 'pages.publish',
      uploadId,
      domain: 'chat.demo.test',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    const data = out.data as { action: string; policy: { decision: string }; diff: { steps: unknown[] } };
    expect(data).toMatchObject({ action: 'pages.publish', policy: { decision: 'approval_step_up' } });
    expect(data.diff.steps).toHaveLength(2);
    expect(
      await tools.run(caller, 'draft_deploy', {
        project: SITE,
        action: 'pages.publish',
        domain: 'x.demo.test',
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    await stepUp();
    const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
    expect(conf.statusCode, conf.body).toBe(200);
    const actionId = conf.json<{ result: { actionId: string; state: string } }>().result.actionId;
    expect((await get(actionId)).state).toBe('awaiting_approval');
    await stepUp();
    let a = (await call(owner, 'POST', `/deploy/actions/${actionId}/approve`, {})).json<Action>();
    if (a.state === 'deploying') {
      await poll();
      a = await get(actionId);
    }
    expect(a.state).toBe('succeeded');
    expect(records('chat.demo.test')).toEqual([expect.objectContaining({ content: 'pub-main.pages.dev' })]);
  });

  it('never leaks the Cloudflare token', () => {
    for (const b of bodies) expect(b).not.toContain(cf.token);
  });
});
