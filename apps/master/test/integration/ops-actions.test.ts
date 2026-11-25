import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare, FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-deploy-integrations (ADR-0028) against a real master (Postgres) and local fake Coolify / Cloudflare servers:
 * token storage (encrypted, never returned / logged / audited), connection tests with the token's permissions, SSRF
 * rules for the Coolify URL, deploy targets, the policy matrix (preview auto, production approval + step-up, DNS
 * approval, delete approval + step-up, protected records and control-plane resources refused), the exact provider
 * calls, idempotency, rate limits, provider 401/403/429, status polling, logs redaction, rollback and expiry.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const CONSOLE = 'https://console.example.org';

const coolify = new FakeCoolify();
const cf = new FakeCloudflare();
let h: Harness;
let owner: Client;
let ownerSecret = '';
let admin: Client;
let adminSecret = '';
let operator: Client;
let viewer: Client;
let zoneId = '';
const bodies: string[] = [];

async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
  const res = await c.req(method, url, body);
  bodies.push(res.body);
  return res;
}

async function stepUp(c: Client, secret: string): Promise<void> {
  h.clock.advance(30_000);
  const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
  expect(res.statusCode, res.body).toBe(200);
}

type Action = {
  id: string;
  state: string;
  env: string | null;
  policy: { decision: string; reason: string };
  diff: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  rollbackAvailable: boolean;
  rollbackOf: string | null;
};

async function request(c: Client, kind: string, params: Record<string, unknown>, key = `k-${randomUUID()}`) {
  return call(c, 'POST', '/deploy/actions', { project: PROJECT, kind, params, idempotencyKey: key });
}

describeIntegration(
  'deploy integrations: Coolify / Cloudflare ops actions (integration, p6-deploy-integrations)',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await coolify.start();
      await cf.start();
      h = new Harness();
      await h.start({
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          // OPS_PROTECTED_HOSTS: a second console host, protected like the PUBLIC_ORIGIN one.
          protectedHosts: ['console.example.org'],
          internalOrigins: [coolify.base, cf.base],
          cloudflareApi: `${cf.base}/client/v4`,
          controlPlaneResources: ['remyralmaster01'],
          controlPlaneAddresses: ['203.0.113.10'],
          limits: { perProjectPer10Min: 40 },
        },
      });
      await h.createUser('owner1', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      await h.createUser('admin1', PW, 'admin');
      adminSecret = (await enroll(h, 'admin1', PW)).secret;
      admin = await fullLogin(h, 'admin1', PW, adminSecret);
      const op = await h.createUser('oper1', PW, 'operator');
      await h.grant(op, [PROJECT], 'operator');
      operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
      const vw = await h.createUser('view1', PW, 'viewer');
      await h.grant(vw, [PROJECT], 'viewer');
      viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);

      coolify.addApp({ uuid: 'shopprev01', name: 'shop-preview', tags: ['shop-preview'] });
      coolify.addApp({ uuid: 'shopprod01', name: 'shop-prod', fqdn: 'https://shop.example.test' });
      coolify.addApp({ uuid: 'remyralmaster01', name: 'remyral-master', fqdn: CONSOLE });
      coolify.addApp({
        uuid: 'sneaky0001',
        name: 'console-copy',
        fqdn: `${CONSOLE},https://x.example.test`,
        tags: ['sneaky'],
      });
      zoneId = cf.addZone('example.org');
      cf.addRecord(zoneId, {
        type: 'A',
        name: 'console.example.org',
        content: '198.18.0.77',
        ttl: 1,
        proxied: true,
      });
      cf.addRecord(zoneId, {
        type: 'A',
        name: 'shop.example.org',
        content: '192.0.2.1',
        ttl: 1,
        proxied: true,
      });
      cf.addRecord(zoneId, {
        type: 'TXT',
        name: 'example.org',
        content: 'v=spf1 include:_spf.example ~all',
        ttl: 1,
        proxied: false,
      });
      cf.pagesProjects.set('shop-site', {
        name: 'shop-site',
        production_branch: 'main',
        domains: ['shop-site.example.test'],
        deployments: [{ id: 'pd-old', environment: 'production', url: 'https://old.shop-site.pages.dev' }],
      });
    });
    afterAll(async () => {
      await h.stop();
      await coolify.stop();
      await cf.stop();
    });

    it('connects Coolify: admin only, always-fresh step-up, https/public URL rule, encrypted token', async () => {
      expect((await operator.req('GET', '/integrations/ops')).statusCode).toBe(403);
      const body = { url: coolify.base, token: coolify.token, team: 'Root Team' };
      h.clock.advance(11 * 60_000);
      const stale = await call(owner, 'PUT', '/integrations/ops/coolify', body);
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toContain('step_up_required');
      await stepUp(owner, ownerSecret);
      // SSRF: http to a non-allowlisted origin, a private address, credentials in the URL.
      for (const url of [
        'http://coolify.example.test',
        'https://127.0.0.1:8000',
        'https://169.254.169.254',
        'https://u:p@coolify.example.test',
      ]) {
        const res = await call(owner, 'PUT', '/integrations/ops/coolify', { ...body, url });
        expect(res.statusCode, url).toBe(400);
        expect(res.body).toContain('invalid_url');
      }
      const ok = await call(owner, 'PUT', '/integrations/ops/coolify', body);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        provider: 'coolify',
        usable: true,
        settings: { url: coolify.base, team: 'Root Team' },
      });
      const { rows } = await h.db.pool.query<{ secret: Buffer; config: unknown }>(
        'SELECT secret, config FROM ops_integrations',
      );
      for (const r of rows) {
        expect(r.secret.toString('latin1')).not.toContain(coolify.token);
        expect(JSON.stringify(r.config)).not.toContain(coolify.token);
      }
    });

    it('tests the Coolify connection: version, team and the token permissions (read, deploy, not write)', async () => {
      coolify.reset();
      const res = await call(admin, 'POST', '/integrations/ops/coolify/test');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        version: 'v4.0.0-beta.fake',
        team: 'Root Team',
        permissions: { read: true, deploy: true, write: false, readSensitive: true },
        warnings: [],
      });
      expect(coolify.requests.every((r) => r.auth === `Bearer ${coolify.token}`)).toBe(true);
      expect(coolify.calls()).toEqual([
        'GET /api/v1/version',
        'GET /api/v1/team',
        'GET /api/v1/applications',
        expect.stringMatching(/^POST \/api\/v1\/deployments\/remyral-probe-[0-9a-f]{16}\/cancel$/),
        expect.stringMatching(/^PATCH \/api\/v1\/applications\/remyral-probe-[0-9a-f]{16}$/),
        // p17-coolify-full: the read:sensitive probe on the logs route.
        expect.stringMatching(/^GET \/api\/v1\/applications\/remyral-probe-[0-9a-f]{16}\/logs\?lines=1$/),
        'GET /api/v1/applications',
      ]);
      coolify.abilities.write = true;
      const wide = (await call(admin, 'POST', '/integrations/ops/coolify/test')).json<{
        warnings: string[];
      }>();
      expect(wide.warnings.join(' ')).toContain('can write');
      coolify.abilities.write = false;
      const status = await call(admin, 'GET', '/integrations/ops');
      expect(status.json()).toMatchObject({
        coolify: { lastTest: { ok: true } },
        cloudflare: null,
        controlPlaneResources: ['remyralmaster01'],
        protectedHosts: expect.arrayContaining(['console.example.org', 'console.example.test']) as unknown,
      });
    });

    it('connects Cloudflare and lists permitted zones and Pages access', async () => {
      await stepUp(owner, ownerSecret);
      const bad = await call(owner, 'PUT', '/integrations/ops/cloudflare', {
        accountId: 'nope',
        token: cf.token,
      });
      expect(bad.statusCode).toBe(400);
      const res = await call(owner, 'PUT', '/integrations/ops/cloudflare', {
        accountId: cf.account,
        token: cf.token,
      });
      expect(res.statusCode, res.body).toBe(200);
      const test = await call(owner, 'POST', '/integrations/ops/cloudflare/test');
      expect(test.json()).toMatchObject({
        ok: true,
        tokenStatus: 'active',
        zones: [{ id: zoneId, name: 'example.org' }],
        pages: { access: true, projects: ['shop-site'] },
      });
    });

    it('deploy targets: project admin + step-up; control-plane resources and invisible zones refused', async () => {
      const targets = {
        coolify: {
          preview: { uuids: [], tags: ['shop-preview'] },
          production: { uuids: ['shopprod01'], tags: [] },
        },
        pages: { projectName: 'shop-site' },
        dns: { zones: [{ id: zoneId, name: 'example.org' }], protectedNames: ['mail.example.org'] },
      };
      expect(
        (await call(operator, 'PUT', `/projects/${PROJECT}/deploy-targets`, { targets })).statusCode,
      ).toBe(403);
      await stepUp(admin, adminSecret);
      const cp = await call(admin, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: { ...targets, coolify: { preview: { uuids: ['remyralmaster01'], tags: [] } } },
      });
      expect(cp.statusCode).toBe(400);
      expect(cp.body).toContain('control_plane_resource');
      const zone = await call(admin, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: { ...targets, dns: { zones: [{ id: 'f'.repeat(32), name: 'other.test' }] } },
      });
      expect(zone.statusCode).toBe(400);
      expect(zone.body).toContain('zone_not_permitted');
      const ok = await call(admin, 'PUT', `/projects/${PROJECT}/deploy-targets`, { targets });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        version: 1,
        targets: {
          policy: { previewDeploy: 'auto', productionDeploy: 'approval_step_up', dnsChange: 'approval' },
        },
      });
      expect((await call(viewer, 'GET', `/projects/${PROJECT}/deploy-targets`)).json()).toMatchObject({
        version: 1,
      });
    });

    it('preview deploy runs at once (auto): exact Coolify calls by uuid, idempotent per key', async () => {
      expect((await request(viewer, 'coolify.deploy', { env: 'preview' })).statusCode).toBe(403);
      coolify.reset();
      const key = `k-${randomUUID()}`;
      const res = await request(operator, 'coolify.deploy', { env: 'preview', ref: 'v1.2' }, key);
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<Action>();
      expect(a).toMatchObject({ state: 'deploying', env: 'preview', policy: { decision: 'auto' } });
      expect(coolify.calls()).toEqual([
        'GET /api/v1/applications?tag=shop-preview',
        'GET /api/v1/applications/shopprev01/rollback-images',
        'POST /api/v1/deploy?uuid=shopprev01',
      ]);
      // Same key, same request: the first record, no second deploy.
      const again = await request(operator, 'coolify.deploy', { env: 'preview', ref: 'v1.2' }, key);
      expect(again.statusCode).toBe(200);
      expect(again.json<Action>().id).toBe(a.id);
      expect(coolify.calls(/POST \/api\/v1\/deploy/)).toHaveLength(1);
      const conflict = await request(operator, 'coolify.deploy', { env: 'preview', force: true }, key);
      expect(conflict.statusCode).toBe(409);
      // Status polling: queued → finished.
      const depId = (a.result?.deployments as { deploymentUuid: string }[])[0]?.deploymentUuid ?? '';
      expect((await call(operator, 'POST', `/deploy/actions/${a.id}/refresh`)).json<Action>().state).toBe(
        'deploying',
      );
      const dep = coolify.deployments.get(depId);
      if (dep) dep.status = 'finished';
      const done = (await call(operator, 'POST', `/deploy/actions/${a.id}/refresh`)).json<Action>();
      expect(done).toMatchObject({ state: 'succeeded', rollbackAvailable: true });
      // Logs: hidden lines dropped, secrets redacted.
      const logs = await call(operator, 'GET', `/deploy/actions/${a.id}/logs`);
      expect(logs.statusCode, logs.body).toBe(200);
      expect(logs.body).toContain('Building image');
      expect(logs.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(logs.body).not.toContain('internal');
      expect((await viewer.req('GET', `/deploy/actions/${a.id}/logs`)).statusCode).toBe(403);
    });

    it('production deploy waits for approval with an always-fresh step-up; operators cannot approve', async () => {
      coolify.reset();
      const res = await request(operator, 'coolify.deploy', { env: 'production' });
      const a = res.json<Action>();
      expect(a).toMatchObject({ state: 'awaiting_approval', policy: { decision: 'approval_step_up' } });
      expect(a.diff).toMatchObject({
        resources: [{ uuid: 'shopprod01', name: 'shop-prod', currentCommit: 'abc1234' }],
      });
      expect(coolify.calls(/POST/)).toEqual([]);
      expect((await call(operator, 'POST', `/deploy/actions/${a.id}/approve`, {})).statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      const stale = await call(admin, 'POST', `/deploy/actions/${a.id}/approve`, {});
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toContain('step_up_required');
      await stepUp(admin, adminSecret);
      const ok = await call(admin, 'POST', `/deploy/actions/${a.id}/approve`, { reason: 'release 1.2' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<Action>().state).toBe('deploying');
      expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=shopprod01']);
      // Decided once.
      expect((await call(admin, 'POST', `/deploy/actions/${a.id}/approve`, {})).statusCode).toBe(409);
    });

    it('p15-auto-mode: a production deploy runs at once under auto mode, approved via the security policy', async () => {
      coolify.reset();
      await h.setSecurityPolicy({ preset: 'siki', autonomy: { autoMode: true } });
      try {
        const res = await request(operator, 'coolify.deploy', { env: 'production' });
        const a = res.json<Action>();
        expect(a.state).not.toBe('awaiting_approval');
        expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=shopprod01']);
        const audit = await h.db.pool.query<{ actor_type: string; metadata: Record<string, unknown> }>(
          "SELECT actor_type, metadata FROM audit_events WHERE action = 'ops.action.approve' AND target = $1",
          [`ops-action:${a.id}`],
        );
        expect(audit.rows[0]).toMatchObject({
          actor_type: 'system',
          metadata: { approvedVia: 'security_policy', autoMode: true, env: 'production' },
        });
      } finally {
        await h.setSecurityPolicy({ preset: 'siki' });
      }
    });

    it('control-plane resources are refused whatever the configuration (deny-list and console fqdn)', async () => {
      await stepUp(admin, adminSecret);
      await call(admin, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: {
          coolify: {
            preview: { uuids: [], tags: ['sneaky'] },
            production: { uuids: ['shopprod01'], tags: [] },
          },
          pages: { projectName: 'shop-site' },
          dns: { zones: [{ id: zoneId, name: 'example.org' }], protectedNames: ['mail.example.org'] },
        },
        expectedVersion: 1,
      });
      coolify.reset();
      const a = (await request(operator, 'coolify.deploy', { env: 'preview' })).json<Action>();
      expect(a).toMatchObject({ state: 'refused', policy: { decision: 'refused' } });
      expect(a.policy.reason).toContain('console.example.org');
      expect(coolify.calls(/POST/)).toEqual([]);
      const ev = await h.db.pool.query<{ outcome: string }>(
        "SELECT outcome FROM audit_events WHERE action = 'ops.action.request' AND target = $1",
        [`ops-action:${a.id}`],
      );
      expect(ev.rows[0]?.outcome).toBe('denied');
      await stepUp(admin, adminSecret);
      const restore = await call(admin, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: {
          coolify: {
            preview: { uuids: [], tags: ['shop-preview'] },
            production: { uuids: ['shopprod01'], tags: [] },
          },
          pages: { projectName: 'shop-site' },
          dns: { zones: [{ id: zoneId, name: 'example.org' }], protectedNames: ['mail.example.org'] },
        },
      });
      expect(restore.statusCode).toBe(200);
    });

    it('provider errors: 403 (missing deploy permission) and 429 (Retry-After) fail the action visibly', async () => {
      coolify.failNext = { status: 403, match: /POST \/api\/v1\/deploy/ };
      const f = (await request(operator, 'coolify.deploy', { env: 'preview' })).json<Action>();
      expect(f.state).toBe('failed');
      expect(f.error).toContain('lacks the permission');
      expect(f.result).toMatchObject({ provider: 'coolify', status: 403 });
      coolify.failNext = { status: 429, retryAfter: 42, match: /POST \/api\/v1\/deploy/ };
      const r = (await request(operator, 'coolify.deploy', { env: 'preview' })).json<Action>();
      expect(r).toMatchObject({ state: 'failed', result: { code: 'rate_limited', retryAfterSec: 42 } });
      coolify.failNext = { status: 401, match: /GET \/api\/v1\/applications/ };
      const u = await request(operator, 'coolify.deploy', { env: 'preview' });
      // p10-publish-bundle: 424 (a proxy in front of the console replaces 5xx bodies), with the provider named.
      expect(u.statusCode).toBe(424);
      expect(u.body).toContain('coolify_unauthorized');
      expect(u.json<{ message: string }>().message).toMatch(/^Coolify: /);
    });

    it('DNS upsert: always approval, diff against the current record, one-click rollback', async () => {
      cf.reset();
      const res = await request(operator, 'dns.upsert', {
        zone: 'example.org',
        type: 'A',
        name: 'shop.example.org',
        content: '192.0.2.2',
        proxied: true,
      });
      const a = res.json<Action>();
      expect(a).toMatchObject({
        state: 'awaiting_approval',
        policy: { decision: 'approval' },
        diff: {
          action: 'update',
          before: { content: '192.0.2.1', proxied: true },
          after: { content: '192.0.2.2', ttl: 1, proxied: true },
        },
      });
      expect(cf.calls(/PATCH|POST|DELETE/)).toEqual([]);
      const ok = await call(admin, 'POST', `/deploy/actions/${a.id}/approve`, {});
      expect(ok.json<Action>()).toMatchObject({ state: 'succeeded', rollbackAvailable: true });
      expect(cf.calls(/PATCH/)).toHaveLength(1);
      expect(JSON.parse(cf.requests.find((r) => r.method === 'PATCH')?.body ?? '{}')).toEqual({
        type: 'A',
        name: 'shop.example.org',
        content: '192.0.2.2',
        ttl: 1,
        proxied: true,
      });
      const rb = await call(operator, 'POST', `/deploy/actions/${a.id}/rollback`, {
        idempotencyKey: `rb-${randomUUID()}`,
      });
      expect(rb.statusCode, rb.body).toBe(201);
      const back = rb.json<Action>();
      expect(back).toMatchObject({
        rollbackOf: a.id,
        state: 'awaiting_approval',
        diff: { after: { content: '192.0.2.1' } },
      });
      expect((await call(admin, 'POST', `/deploy/actions/${back.id}/approve`, {})).json<Action>().state).toBe(
        'succeeded',
      );
      expect(cf.zones.get(zoneId)?.records.find((r) => r.name === 'shop.example.org')?.content).toBe(
        '192.0.2.1',
      );
    });

    it('DNS: stale diff is not executed; a new record rolls back to a delete', async () => {
      const a = (
        await request(operator, 'dns.upsert', {
          zone: 'example.org',
          type: 'CNAME',
          name: 'docs.example.org',
          content: 'shop-site.pages.dev',
        })
      ).json<Action>();
      expect(a.diff).toMatchObject({ action: 'create', before: null });
      expect((await call(admin, 'POST', `/deploy/actions/${a.id}/approve`, {})).json<Action>().state).toBe(
        'succeeded',
      );
      const rb = (
        await call(operator, 'POST', `/deploy/actions/${a.id}/rollback`, {
          idempotencyKey: `rb-${randomUUID()}`,
        })
      ).json<Action>();
      expect(rb).toMatchObject({ policy: { decision: 'approval_step_up' }, diff: { action: 'delete' } });
      // Someone changes the record in Cloudflare before the approval: nothing is deleted.
      const rec = cf.zones.get(zoneId)?.records.find((r) => r.name === 'docs.example.org');
      if (rec) rec.content = 'elsewhere.example.test';
      await stepUp(admin, adminSecret);
      const stale = (await call(admin, 'POST', `/deploy/actions/${rb.id}/approve`, {})).json<Action>();
      expect(stale).toMatchObject({ state: 'failed' });
      expect(stale.error).toContain('changed since the request');
      expect(cf.calls(/DELETE/)).toEqual([]);
    });

    it('protected records are refused: console host, SPF, project names, records pointing at the control plane', async () => {
      const cases: Record<string, unknown>[] = [
        { zone: 'example.org', type: 'A', name: 'console.example.org', content: '192.0.2.9' },
        { zone: 'example.org', type: 'TXT', name: 'example.org', content: 'v=spf1 -all' },
        { zone: 'example.org', type: 'A', name: 'mail.example.org', content: '192.0.2.9' },
        { zone: 'example.org', type: 'CNAME', name: 'alias.example.org', content: 'console.example.org' },
        { zone: 'example.org', type: 'A', name: 'origin.example.org', content: '198.18.0.77' },
        { zone: 'example.org', type: 'A', name: 'origin2.example.org', content: '203.0.113.10' },
        { zone: 'example.org', type: 'TXT', name: '_dmarc.example.org', content: 'v=DMARC1; p=none' },
      ];
      cf.reset();
      for (const params of cases) {
        const a = (await request(operator, 'dns.upsert', params)).json<Action>();
        expect(a.state, JSON.stringify(params)).toBe('refused');
      }
      const del = (
        await request(operator, 'dns.delete', { zone: 'example.org', type: 'TXT', name: 'example.org' })
      ).json<Action>();
      expect(del.state).toBe('refused');
      const outside = await request(operator, 'dns.upsert', {
        zone: 'example.org',
        type: 'A',
        name: 'x.other.test',
        content: '192.0.2.1',
      });
      expect(outside.statusCode).toBe(400);
      const zone = await request(operator, 'dns.upsert', {
        zone: 'other.test',
        type: 'A',
        name: 'x.other.test',
        content: '192.0.2.1',
      });
      expect(zone.statusCode).toBe(403);
      // Refused before anything is written: only reads reached Cloudflare.
      expect(cf.calls(/^(PATCH|POST|DELETE) /)).toEqual([]);
    });

    it("Pages deploy from a succeeded job's output files, production rollback to the previous deployment", async () => {
      const audit = new AuditLog(h.db.pool, h.clock.now);
      const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
      const { job } = await jobs.create({
        project: PROJECT,
        actor: { type: 'system', id: 'test' },
        submit: true,
        spec: {
          runtime: 'codex',
          prompt: 'Build the site',
          repository: { url: 'https://example.com/acme/site.git', baseRef: 'main', workBranch: 'rac/site' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 600 },
        },
      });
      const attempt = randomUUID();
      for (const [i, [name, content]] of [
        ['dist/index.html', '<h1>hi</h1>'],
        ['dist/app.js', 'console.log(1)'],
      ].entries()) {
        await h.db.pool.query(
          `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind, redacted, content, created_at)
         VALUES ($1, $2, $3, $4, 'text/plain', $5, repeat('a', 64), 'output', false, $6, now())`,
          [
            attempt,
            job.id,
            `ws-a${String(i)}`,
            name,
            Buffer.byteLength(content ?? ''),
            Buffer.from(content ?? ''),
          ],
        );
      }
      const early = await request(operator, 'pages.deploy', { jobId: job.id });
      expect(early.statusCode).toBe(409);
      expect(early.body).toContain('job_not_finished');
      await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [
        job.id,
      ]);
      cf.reset();
      const preview = (
        await request(operator, 'pages.deploy', { jobId: job.id, directory: 'dist' })
      ).json<Action>();
      expect(preview).toMatchObject({ env: 'preview', state: 'deploying', policy: { decision: 'auto' } });
      expect(cf.calls()).toEqual([
        'GET /client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects/shop-site',
        'GET /client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects/shop-site/upload-token',
        'POST /client/v4/pages/assets/check-missing',
        'POST /client/v4/pages/assets/upload',
        'POST /client/v4/pages/assets/upsert-hashes',
        'POST /client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects/shop-site/deployments',
      ]);
      const deploy = cf.requests.at(-1)?.body ?? '';
      expect(deploy).toContain('"/index.html"');
      expect(deploy).toContain('"/app.js"');
      expect(deploy).toContain('remyral-preview');
      const prod = (
        await request(operator, 'pages.deploy', { jobId: job.id, directory: 'dist', branch: 'main' })
      ).json<Action>();
      expect(prod).toMatchObject({
        env: 'production',
        state: 'awaiting_approval',
        policy: { decision: 'approval_step_up' },
      });
      await stepUp(admin, adminSecret);
      const done = (await call(admin, 'POST', `/deploy/actions/${prod.id}/approve`, {})).json<Action>();
      expect(done).toMatchObject({ state: 'deploying', result: { previousDeploymentId: 'pd-old' } });
      expect(
        (await call(operator, 'POST', `/deploy/actions/${prod.id}/refresh`)).json<Action>(),
      ).toMatchObject({ state: 'succeeded', rollbackAvailable: true });
      const rb = (
        await call(operator, 'POST', `/deploy/actions/${prod.id}/rollback`, {
          idempotencyKey: `rb-${randomUUID()}`,
        })
      ).json<Action>();
      expect(rb).toMatchObject({ state: 'awaiting_approval', diff: { toDeployment: 'pd-old' } });
      await stepUp(admin, adminSecret);
      expect((await call(admin, 'POST', `/deploy/actions/${rb.id}/approve`, {})).json<Action>().state).toBe(
        'succeeded',
      );
      expect(cf.calls(/rollback/)).toEqual([
        'POST /client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects/shop-site/deployments/pd-old/rollback',
      ]);
      // Redacted artifacts are never published.
      await h.db.pool.query(
        "UPDATE job_artifacts SET redacted = true WHERE job_id = $1 AND name = 'dist/app.js'",
        [job.id],
      );
      const red = await request(operator, 'pages.deploy', { jobId: job.id, directory: 'dist' });
      expect(red.statusCode).toBe(409);
      expect(red.body).toContain('artifacts_redacted');
    });

    it('deny, expiry, listing (project-scoped) and the rate limit', async () => {
      const a = (await request(operator, 'coolify.restart', { env: 'production' })).json<Action>();
      expect(a.state).toBe('awaiting_approval');
      const d = await call(admin, 'POST', `/deploy/actions/${a.id}/deny`, { reason: 'not now' });
      expect(d.json<Action>().state).toBe('denied');
      const b = (await request(operator, 'coolify.restart', { env: 'production' })).json<Action>();
      await h.db.pool.query('UPDATE ops_actions SET expires_at = $2 WHERE id = $1', [
        b.id,
        new Date(h.clock.now().getTime() - 60_000),
      ]);
      const list = await call(viewer, 'GET', `/deploy/actions?project=${PROJECT}`);
      expect(list.statusCode).toBe(200);
      const items = list.json<{ items: Action[] }>().items;
      expect(items.find((x) => x.id === b.id)?.state).toBe('expired');
      expect((await call(admin, 'POST', `/deploy/actions/${b.id}/approve`, {})).statusCode).toBe(409);
      let limited = 0;
      for (let i = 0; i < 45 && limited === 0; i++) {
        const r = await request(operator, 'coolify.restart', { env: 'production' });
        if (r.statusCode === 429) {
          limited++;
          expect(r.headers['retry-after']).toBeDefined();
        }
      }
      expect(limited).toBe(1);
    });

    it('removing an integration needs always-fresh step-up; tokens never appear in responses, logs or audit', async () => {
      h.clock.advance(11 * 60_000);
      expect((await call(owner, 'DELETE', '/integrations/ops/coolify')).statusCode).toBe(403);
      const all = bodies.join('\n');
      for (const t of [coolify.token, cf.token]) {
        expect(all).not.toContain(t);
        expect(h.logs.text).not.toContain(t);
        const { rows } = await h.db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'",
          [t],
        );
        expect(rows[0]?.n).toBe(0);
        const ops = await h.db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM ops_actions WHERE (params::text || target::text || diff::text || coalesce(result::text, '')) LIKE '%' || $1 || '%'",
          [t],
        );
        expect(ops.rows[0]?.n).toBe(0);
      }
      await stepUp(owner, ownerSecret);
      expect((await call(owner, 'DELETE', '/integrations/ops/cloudflare')).statusCode).toBe(204);
      expect((await call(owner, 'GET', '/integrations/ops')).json()).toMatchObject({ cloudflare: null });
    });
  },
);
