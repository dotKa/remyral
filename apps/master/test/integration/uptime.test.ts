import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const P = 'upt';
const OTHER = 'upq';

interface Monitor {
  id: string;
  project: string;
  name: string;
  type: string;
  status: string;
  paused: boolean;
  flapping: boolean;
  outputKey: string | null;
  consecutiveFailures: number;
  lastCheck: {
    ok: boolean | null;
    error: string | null;
    statusCode: number | null;
    detail: string | null;
  } | null;
  uptime: { h24: number | null; d7: number | null; d30: number | null };
  latencyAvg24h: number | null;
  sparkline: (number | null)[];
  openIncident: { id: string; cause: string } | null;
  createdBy: { type: string; id: string | null };
}

/**
 * p8-uptime against a real master (Postgres): monitors through the API with per-role authorization, the scheduler
 * (tick → checks → status, incidents, rollups), down / up notifications, provider status checks against the fake
 * Cloudflare / Coolify APIs, the SSRF guard on a real check (no request reaches an internal address), "Monitor this"
 * from Outputs and the status on the Outputs card, auto-monitoring, limits, check-now throttling, chat tools and a
 * chat watch on a monitor.
 */
describeIntegration('uptime (integration, p8-uptime)', { timeout: 180_000 }, () => {
  let h: Harness;
  let owner: Client;
  let op: Client;
  let viewer: Client;
  let outsider: Client;
  let ownerId = '';
  let opId = '';
  let viewerId = '';
  let ownerSecret = '';
  const cf = new FakeCloudflare();
  const coolify = new FakeCoolify();
  let target: Server;
  let base = '';
  let internal: Server;
  let internalHits = 0;
  let internalPort = 0;
  let health = 200;
  let hits = 0;

  async function login(name: string, role: Role, projects: string[] | null) {
    const id = await h.createUser(name, PW, role);
    if (projects !== null && role !== 'owner' && role !== 'admin') await h.grant(id, projects, role);
    const { secret } = await enroll(h, name, PW);
    return { id, secret, client: await fullLogin(h, name, PW, secret) };
  }

  async function create(c: Client, body: Record<string, unknown>) {
    return c.req('POST', '/uptime/monitors', body);
  }

  async function runDue(): Promise<number> {
    const n = await h.app.uptime.tick();
    await h.app.uptime.drain();
    return n;
  }

  async function get(id: string, c: Client = op): Promise<Monitor> {
    const res = await c.req('GET', `/uptime/monitors/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Monitor>();
  }

  async function notificationsOf(
    c: Client,
  ): Promise<{ kind: string; title: string; body: string; link: string | null }[]> {
    await h.app.notifications.runOnce();
    const res = await c.req('GET', '/notifications');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: { kind: string; title: string; body: string; link: string | null }[] }>().items;
  }

  beforeAll(async () => {
    target = createServer((req, res) => {
      hits++;
      if (req.url === '/health') res.writeHead(health, { 'content-type': 'text/plain' }).end('status: ok');
      else res.writeHead(200).end('<html>shop</html>');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${String((target.address() as AddressInfo).port)}`;
    internal = createServer((_req, res) => {
      internalHits++;
      res.writeHead(200).end('internal');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    internalPort = (internal.address() as AddressInfo).port;
    await cf.start();
    await coolify.start();
    coolify.addApp({ uuid: 'shopapp01', name: 'shop', fqdn: base, status: 'running:healthy' });
    cf.pagesProjects.set('shop-web', {
      name: 'shop-web',
      production_branch: 'main',
      domains: [],
      deployments: [{ id: 'pd1', environment: 'production', url: 'https://pd1.shop-web.pages.dev' }],
    });
    h = new Harness();
    await h.start({
      ops: { internalOrigins: [cf.base, coolify.base], cloudflareApi: `${cf.base}/client/v4` },
      uptime: { allowOrigins: [base], limits: { perProject: 12 } },
    });
    ({ id: ownerId, secret: ownerSecret, client: owner } = await login('owner.u', 'owner', null));
    ({ id: opId, client: op } = await login('op.u', 'operator', [P]));
    ({ id: viewerId, client: viewer } = await login('viewer.u', 'viewer', [P]));
    ({ client: outsider } = await login('outsider.u', 'operator', [OTHER]));
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    expect(
      (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
        .statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
        .statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await h.stop();
    target.closeAllConnections();
    internal.closeAllConnections();
    await new Promise<void>((r) =>
      target.close(() => {
        r();
      }),
    );
    await new Promise<void>((r) =>
      internal.close(() => {
        r();
      }),
    );
    await cf.stop();
    await coolify.stop();
  });

  describe('API and authorization', () => {
    it('operators create, viewers read only, outsiders see nothing; settings are validated', async () => {
      const bad = await create(op, {
        project: P,
        name: 'x',
        type: 'http',
        config: { url: 'http://example.com:6379/' },
      });
      expect(bad.statusCode).toBe(400);
      expect(
        (
          await create(op, {
            project: P,
            name: 'x',
            type: 'http',
            config: { url: 'https://u:p@example.com/' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await create(op, {
            project: P,
            name: 'x',
            type: 'http',
            config: { url: 'https://example.com/', method: 'HEAD', keyword: { text: 'a' } },
          })
        ).json(),
      ).toMatchObject({ error: 'invalid_monitor' });
      expect(
        (
          await create(op, {
            project: P,
            name: 'x',
            type: 'pages',
            config: { project: 'shop-web' },
            intervalSec: 30,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await create(viewer, {
            project: P,
            name: 'x',
            type: 'http',
            config: { url: 'https://example.com/' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await create(outsider, {
            project: P,
            name: 'x',
            type: 'http',
            config: { url: 'https://example.com/' },
          })
        ).statusCode,
      ).toBe(404);
      const res = await create(op, {
        project: P,
        name: 'Shop health',
        type: 'http',
        config: { url: `${base}/health`, keyword: { text: 'status: ok' } },
        retries: 1,
      });
      expect(res.statusCode, res.body).toBe(201);
      const m = res.json<Monitor>();
      expect(m).toMatchObject({ status: 'pending', paused: false, createdBy: { type: 'user', id: opId } });
      expect((await viewer.req('GET', `/uptime/monitors/${m.id}`)).statusCode).toBe(200);
      expect((await viewer.req('POST', `/uptime/monitors/${m.id}/check`)).statusCode).toBe(403);
      expect((await outsider.req('GET', `/uptime/monitors/${m.id}`)).statusCode).toBe(404);
      expect((await outsider.req('GET', '/uptime/monitors')).json<{ items: Monitor[] }>().items).toEqual([]);
      const { rows } = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 ORDER BY id`,
        [`uptime-monitor:${m.id}`],
      );
      expect(rows.map((r) => r.action)).toContain('uptime.monitor.create');
      await h.db.pool.query('DELETE FROM uptime_monitors WHERE id = $1', [m.id]);
    });
  });

  describe('scheduler, incidents and notifications', () => {
    let id = '';

    it('checks due monitors once per interval and records them', async () => {
      hits = 0;
      const res = await create(op, {
        project: P,
        name: 'Shop health',
        type: 'http',
        config: { url: `${base}/health`, keyword: { text: 'status: ok' } },
        retries: 1,
      });
      id = res.json<Monitor>().id;
      expect(await runDue()).toBe(1);
      let m = await get(id);
      expect(m.status).toBe('up');
      expect(m.lastCheck).toMatchObject({ ok: true, statusCode: 200, error: null });
      expect(hits).toBe(1);
      // Not due again before the interval.
      expect(await runDue()).toBe(0);
      h.clock.advance(61_000);
      expect(await runDue()).toBe(1);
      m = await get(id);
      expect(m.uptime.h24).toBe(100);
      expect(m.latencyAvg24h).not.toBeNull();
      expect(m.sparkline).toHaveLength(24);
      // The first "up" is not news.
      expect((await notificationsOf(op)).filter((n) => n.kind.startsWith('monitor.'))).toEqual([]);
    });

    it('goes down after retries + 1 failures with an incident and a monitor.down notification (operators only)', async () => {
      health = 503;
      h.clock.advance(61_000);
      await runDue();
      let m = await get(id);
      expect(m).toMatchObject({ status: 'up', consecutiveFailures: 1 });
      // A failure being confirmed is re-checked sooner (30 s), not after the full interval.
      h.clock.advance(31_000);
      await runDue();
      m = await get(id);
      expect(m.status).toBe('down');
      expect(m.lastCheck).toMatchObject({ ok: false, error: 'status', statusCode: 503 });
      expect(m.openIncident).toMatchObject({ cause: 'status' });
      const n = (await notificationsOf(op)).filter((x) => x.kind === 'monitor.down');
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ title: 'Down: Shop health', link: `/uptime/${id}` });
      expect(n[0]?.body).toContain('unexpected HTTP status');
      expect((await notificationsOf(viewer)).filter((x) => x.kind.startsWith('monitor.'))).toEqual([]);
      expect((await notificationsOf(outsider)).filter((x) => x.kind.startsWith('monitor.'))).toEqual([]);
      // Staying down: no second notification.
      h.clock.advance(61_000);
      await runDue();
      expect((await notificationsOf(op)).filter((x) => x.kind === 'monitor.down')).toHaveLength(1);
    });

    it('recovers with the incident closed, its duration and a monitor.up notification; uptime % and charts', async () => {
      health = 200;
      h.clock.advance(61_000);
      await runDue();
      const m = await get(id);
      expect(m.status).toBe('up');
      expect(m.openIncident).toBeNull();
      const inc = (await op.req('GET', `/uptime/monitors/${id}/incidents`)).json<{
        items: { endedAt: string | null; durationMs: number; cause: string }[];
      }>().items;
      expect(inc).toHaveLength(1);
      expect(inc[0]?.endedAt).not.toBeNull();
      expect(inc[0]?.durationMs).toBeGreaterThanOrEqual(120_000);
      const up = (await notificationsOf(op)).filter((x) => x.kind === 'monitor.up');
      expect(up).toHaveLength(1);
      expect(up[0]?.body).toMatch(/is up again after \d+ min/);
      expect(m.uptime.h24).toBeGreaterThan(0);
      expect(m.uptime.h24).toBeLessThan(100);
      const checks = (await viewer.req('GET', `/uptime/monitors/${id}/checks`)).json<{
        items: { ok: boolean }[];
      }>();
      expect(checks.items.length).toBeGreaterThanOrEqual(6);
      for (const range of ['24h', '7d', '30d', '90d']) {
        const s = await viewer.req('GET', `/uptime/monitors/${id}/series?range=${range}`);
        expect(s.statusCode, s.body).toBe(200);
        expect(s.json<{ points: unknown[] }>().points.length).toBeGreaterThan(0);
      }
    });

    it('check now: recorded, throttled per monitor; pause stops the schedule; delete removes everything', async () => {
      h.clock.advance(15_000);
      const now = await op.req('POST', `/uptime/monitors/${id}/check`);
      expect(now.statusCode, now.body).toBe(200);
      const again = await op.req('POST', `/uptime/monitors/${id}/check`);
      expect(again.statusCode).toBe(429);
      const paused = await op.req('PATCH', `/uptime/monitors/${id}`, { paused: true });
      expect(paused.json<Monitor>().paused).toBe(true);
      h.clock.advance(120_000);
      expect(await runDue()).toBe(0);
      expect(
        (await op.req('GET', `/uptime/monitors?project=${P}&status=paused`)).json<{ items: Monitor[] }>()
          .items,
      ).toHaveLength(1);
      expect((await op.req('DELETE', `/uptime/monitors/${id}`)).statusCode).toBe(204);
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM uptime_checks WHERE monitor_id = $1)::int
                + (SELECT count(*) FROM uptime_incidents WHERE monitor_id = $1)::int
                + (SELECT count(*) FROM uptime_rollups WHERE monitor_id = $1)::int AS n`,
        [id],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  describe('SSRF guard on real checks', () => {
    it('a URL that resolves to loopback is refused at check time; nothing reaches the internal service', async () => {
      internalHits = 0;
      const res = await create(op, {
        project: P,
        name: 'Sneaky',
        type: 'http',
        config: { url: `http://localhost:8080/` },
        retries: 0,
      });
      expect(res.statusCode, res.body).toBe(201);
      const tcp = await create(op, {
        project: P,
        name: 'Sneaky tcp',
        type: 'tcp',
        config: { host: '127.0.0.1', port: internalPort },
        retries: 0,
      });
      expect(tcp.statusCode, tcp.body).toBe(201);
      const meta = await create(op, {
        project: P,
        name: 'Metadata',
        type: 'http',
        config: { url: 'http://169.254.169.254/latest/meta-data/' },
        retries: 0,
      });
      h.clock.advance(1_000);
      await runDue();
      for (const r of [res, tcp, meta]) {
        const m = await get(r.json<Monitor>().id);
        expect(m.status).toBe('down');
        expect(m.lastCheck?.error).toBe('address_refused');
        await op.req('DELETE', `/uptime/monitors/${m.id}`);
      }
      expect(internalHits).toBe(0);
    });
  });

  let siteKey = '';
  describe('provider status, Outputs and auto-monitoring', () => {
    it('Pages and Coolify monitors read the provider status with the master-held tokens', async () => {
      const pages = await create(op, {
        project: P,
        name: 'Pages',
        type: 'pages',
        config: { project: 'shop-web' },
        retries: 0,
      });
      const app = await create(op, {
        project: P,
        name: 'App',
        type: 'coolify',
        config: { uuid: 'shopapp01' },
        retries: 0,
      });
      expect(pages.statusCode, pages.body).toBe(201);
      h.clock.advance(1_000);
      await runDue();
      let p = await get(pages.json<Monitor>().id);
      let a = await get(app.json<Monitor>().id);
      expect(p).toMatchObject({ status: 'up', lastCheck: { ok: true, detail: 'healthy' } });
      expect(a).toMatchObject({ status: 'up', lastCheck: { ok: true, detail: 'running:healthy' } });
      const site = cf.pagesProjects.get('shop-web');
      if (site?.deployments[0]) site.deployments[0].latest_stage = { name: 'build', status: 'failure' };
      const fake = coolify.apps.get('shopapp01');
      if (fake) fake.status = 'exited:unhealthy';
      h.clock.advance(301_000);
      await runDue();
      p = await get(pages.json<Monitor>().id);
      a = await get(app.json<Monitor>().id);
      expect(p).toMatchObject({ status: 'down', lastCheck: { ok: false, error: 'provider_down' } });
      expect(a).toMatchObject({ status: 'down', lastCheck: { detail: 'exited:unhealthy' } });
      // The provider API refusing the token is undecided: the status stays.
      if (fake) fake.status = 'running:healthy';
      coolify.failNext = { status: 401, match: /GET \/api\/v1\/applications\/shopapp01/ };
      h.clock.advance(301_000);
      await runDue();
      a = await get(app.json<Monitor>().id);
      expect(a).toMatchObject({ status: 'down', lastCheck: { ok: null, error: 'provider_auth' } });
      if (site?.deployments[0]) delete site.deployments[0].latest_stage;
      // Never a token in what the API returns.
      expect(JSON.stringify(a)).not.toContain(coolify.token);
      await op.req('DELETE', `/uptime/monitors/${p.id}`);
      await op.req('DELETE', `/uptime/monitors/${a.id}`);
    });

    async function deploy(project: string, at: Date): Promise<string> {
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
           state, requested_by_type, requested_by_id, via, idempotency_key, result, created_at, updated_at, finished_at)
         VALUES ($1, 'coolify.deploy', 'production', '{}', repeat('0', 64), $2, '{}', 'auto', 'fixture', 'succeeded',
           'user', $3, 'api', $4, '{}', $5, $5, $5) RETURNING id`,
        [
          project,
          JSON.stringify({ resources: [{ uuid: 'shopapp01', name: 'shop', fqdn: base }] }),
          ownerId,
          `fx-${randomUUID()}`,
          at,
        ],
      );
      return rows[0]?.id ?? '';
    }

    it('“Monitor this” on an Outputs site creates its http + provider monitors; the card shows status and uptime', async () => {
      await deploy(P, h.clock.now());
      const sites = (await op.req('GET', `/outputs?project=${P}&type=site`)).json<{
        items: { key: string; uptime: unknown }[];
      }>().items;
      expect(sites).toHaveLength(1);
      siteKey = sites[0]?.key ?? '';
      expect(sites[0]?.uptime).toBeNull();
      expect(
        (await viewer.req('POST', '/uptime/monitors/from-output', { project: P, key: siteKey })).statusCode,
      ).toBe(403);
      const res = await op.req('POST', '/uptime/monitors/from-output', { project: P, key: siteKey });
      expect(res.statusCode, res.body).toBe(200);
      const out = res.json<{ created: Monitor[]; existing: Monitor[] }>();
      expect(out.created.map((m) => m.type).sort()).toEqual(['coolify', 'http']);
      expect(out.created.every((m) => m.outputKey === siteKey)).toBe(true);
      // Again: nothing new.
      const again = (
        await op.req('POST', '/uptime/monitors/from-output', { project: P, key: siteKey })
      ).json<{
        created: Monitor[];
        existing: Monitor[];
      }>();
      expect(again.created).toEqual([]);
      expect(again.existing).toHaveLength(2);
      h.clock.advance(1_000);
      await runDue();
      const card = (await viewer.req('GET', `/outputs?project=${P}&type=site`)).json<{
        items: {
          uptime: {
            status: string;
            uptime24h: number | null;
            monitors: { type: string; detail: string | null }[];
          };
        }[];
      }>().items[0];
      expect(card?.uptime.status).toBe('up');
      expect(card?.uptime.uptime24h).toBe(100);
      expect(card?.uptime.monitors.find((m) => m.type === 'coolify')?.detail).toBe('running:healthy');
      expect(
        (await op.req('GET', `/uptime/monitors?project=${P}&outputKey=${encodeURIComponent(siteKey)}`)).json<{
          items: Monitor[];
        }>().items,
      ).toHaveLength(2);
    });

    it('auto-monitor deployed sites: admins only; sites deployed afterwards get monitors (system, audited)', async () => {
      const proj = 'upauto';
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        proj,
        h.clock.now(),
      ]);
      await h.grant(opId, [proj], 'operator');
      expect((await op.req('PUT', '/uptime/settings', { project: proj, autoMonitor: true })).statusCode).toBe(
        403,
      );
      // A site deployed before the switch is not picked up.
      await deploy(proj, h.clock.now());
      h.clock.advance(1_000);
      const on = await owner.req('PUT', '/uptime/settings', { project: proj, autoMonitor: true });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json()).toMatchObject({ autoMonitor: true });
      expect(await h.app.uptime.autoMonitor()).toBe(0);
      h.clock.advance(1_000);
      await deploy(proj, h.clock.now());
      expect(await h.app.uptime.autoMonitor()).toBe(2);
      const list = (await op.req('GET', `/uptime/monitors?project=${proj}`)).json<{ items: Monitor[] }>()
        .items;
      expect(list).toHaveLength(2);
      expect(list.every((m) => m.createdBy.type === 'system')).toBe(true);
      // Deleted monitors stay deleted until the site is deployed again.
      for (const m of list) await op.req('DELETE', `/uptime/monitors/${m.id}`);
      expect(await h.app.uptime.autoMonitor()).toBe(0);
      expect((await viewer.req('GET', `/uptime/settings?project=${P}`)).json()).toMatchObject({
        autoMonitor: false,
      });
    });

    it('a project holds at most the configured number of monitors', async () => {
      const proj = 'uplimit';
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        proj,
        h.clock.now(),
      ]);
      const made: string[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await create(owner, {
          project: proj,
          name: `m${String(i)}`,
          type: 'tcp',
          config: { host: 'example.com', port: 443 },
          paused: true,
        });
        expect(r.statusCode, r.body).toBe(201);
        made.push(r.json<Monitor>().id);
      }
      const over = await create(owner, {
        project: proj,
        name: 'too many',
        type: 'tcp',
        config: { host: 'example.com', port: 443 },
        paused: true,
      });
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ error: 'monitor_limit' });
      await h.db.pool.query('DELETE FROM uptime_monitors WHERE project = $1', [proj]);
    });
  });

  describe('chat', () => {
    let store: ChatStore;
    let tools: ChatTools;
    async function caller(userId: string, role: Role): Promise<ToolCaller> {
      const thread = await store.createThread(userId, 'uptime');
      return {
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
    }
    beforeAll(() => {
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        uptime: () => h.app.uptime,
      } as unknown as ChatToolsDeps);
    });

    it('list_monitors answers within the user’s projects; draft_monitor only drafts; confirming creates it', async () => {
      const viewerCaller = await caller(viewerId, 'viewer');
      const listed = await tools.run(viewerCaller, 'list_monitors', { project: P });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      const data = listed.ok ? (listed.data as { monitors: { name: string; status: string }[] }) : null;
      expect(data?.monitors.length).toBeGreaterThanOrEqual(2);
      expect((await tools.run(viewerCaller, 'list_monitors', { project: OTHER })).ok).toBe(false);
      expect(
        (
          await tools.run(viewerCaller, 'draft_monitor', {
            project: P,
            type: 'http',
            url: 'https://example.com/',
          })
        ).ok,
      ).toBe(false);
      const c = await caller(ownerId, 'owner');
      const refused = await tools.run(c, 'draft_monitor', {
        project: P,
        type: 'http',
        url: 'http://example.com:25/',
      });
      expect(refused.ok).toBe(false);
      const out = await tools.run(c, 'draft_monitor', {
        project: P,
        type: 'http',
        url: `${base}/`,
        intervalSec: 120,
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok || out.draft === undefined) throw new Error('no draft');
      expect(out.data).toMatchObject({ kind: 'monitor', monitor: { type: 'http', intervalSec: 120 } });
      const before = (await owner.req('GET', `/uptime/monitors?project=${P}`)).json<{ items: Monitor[] }>()
        .items.length;
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
      const conf = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
      expect(conf.statusCode, conf.body).toBe(200);
      const monitorId = conf.json<{ result: { monitorId: string } }>().result.monitorId;
      expect(
        (await owner.req('GET', `/uptime/monitors?project=${P}`)).json<{ items: Monitor[] }>().items.length,
      ).toBe(before + 1);
      await owner.req('DELETE', `/uptime/monitors/${monitorId}`);
      // The Outputs site variant drafts the whole set.
      const site = await tools.run(c, 'draft_monitor', { project: P, outputKey: siteKey });
      expect(site.ok, JSON.stringify(site)).toBe(true);
      expect(site.ok ? site.data : null).toMatchObject({ kind: 'monitor', outputKey: siteKey });
    });

    it('a chat watch on a monitor tells its user when it goes down and up again', async () => {
      health = 200;
      const res = await create(op, {
        project: P,
        name: 'Watched',
        type: 'http',
        config: { url: `${base}/health` },
        retries: 0,
      });
      const id = res.json<Monitor>().id;
      h.clock.advance(1_000);
      await runDue();
      const subject = await loadSubject(h.db.pool, { id: opId, role: 'operator' });
      const thread = await store.createThread(opId, 'watch');
      const w = await h.app.chatWatches.create(
        { userId: opId, subject, threadId: thread.id, turnId: null },
        { target: 'monitor', id, repeat: 'every' },
      );
      expect(w.watch.conditions).toEqual(['down']);
      // An outsider cannot watch it.
      const outsiderSubject = await loadSubject(h.db.pool, {
        id:
          (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'outsider.u'"))
            .rows[0]?.id ?? '',
        role: 'operator',
      });
      await expect(
        h.app.chatWatches.create(
          { userId: outsiderSubject.userId, subject: outsiderSubject, threadId: null, turnId: null },
          { target: 'monitor', id },
        ),
      ).rejects.toThrow(/Nothing to watch/);
      health = 500;
      h.clock.advance(61_000);
      await runDue();
      expect(await h.app.chatWatches.tick()).toBeGreaterThan(0);
      const msgs = await store.messages(thread.id);
      expect(msgs.map((m) => m.content).join('\n')).toMatch(/Down:\*\* Monitor Watched/);
      health = 200;
      await op.req('DELETE', `/uptime/monitors/${id}`);
    });
  });
});
