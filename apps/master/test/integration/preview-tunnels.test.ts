import { randomUUID } from 'node:crypto';
import { type LeaseKey, type MasterToWorker, verifyTunnelStart, verifyTunnelStop } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p8-preview-tunnels (ADR-0032) against a real master (Postgres), a raw worker and a local fake Cloudflare API:
 * settings (preview zone must be visible to the token), the token's preview permissions in Test connection, opening a
 * preview from the job page and from the job's agent (PREVIEW_REQUEST fenced by the live lease), the exact Tunnel /
 * DNS / Access calls, TUNNEL_START carrying only that tunnel's connector token (signed, never stored or logged),
 * connector state, Access e-mail and service-token protection (secret encrypted, reveal with step-up), limits,
 * stable tunnels (approval, detach on job end, re-attach with a rotated secret), close, expiry and job-end sweeps.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const MIN = 60_000;
let CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-0000000000c1' };
const SYSTEM: JobActor = { type: 'system', id: 'reconciler' };

const cf = new FakeCloudflare();
let h: Harness;
let jobs: JobStore;
let owner: Client;
let ownerSecret = '';
let admin: Client;
let adminSecret = '';
let operator: Client;
let operatorId = '';
let operatorSecret = '';
let viewer: Client;
let worker: RawWorker;
let workerId = '';
let leaseKeys: LeaseKey[] = [];
let zoneId = '';
const bodies: string[] = [];

type Tunnel = {
  id: string;
  hostname: string;
  url: string;
  state: string;
  protection: string;
  stable: boolean;
  port: number | null;
  connector: { state: string } | null;
  serviceTokenClientId: string | null;
  expiresAt: string;
};
type Outcome = {
  action: { id: string; state: string; policy: { decision: string; reason: string } };
  tunnel: Tunnel | null;
};

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

function capabilities(connectors: { tunnelId: string; state: string; since: string }[] = []): void {
  worker.sendJson(
    worker.envelope(
      'CAPABILITIES',
      {
        runtimes: [],
        sandboxProfiles: ['host-restricted'],
        maxParallelJobs: 2,
        tools: [],
        features: ['preview-tunnels-v1'],
        previewTunnels: { cloudflared: { version: '2026.10.0', source: 'managed' }, connectors },
      },
      { workerId },
    ),
  );
}

async function runningJob(ttlMs = 60 * MIN, spec: Record<string, unknown> = {}) {
  const { job } = await jobs.create({
    project: PROJECT,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'claude-code',
      prompt: 'build the web app and run the dev server',
      repository: { url: 'https://example.com/acme/shop.git', baseRef: 'main', workBranch: 'rac/preview' },
      sandboxProfile: 'host-restricted',
      sourceTrust: 'trusted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
      ...spec,
    },
  });
  const grant = await jobs.acquireLease(job.id, workerId, ttlMs);
  const actor: JobActor = { type: 'worker', id: workerId };
  await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
  return { id: job.id, attemptId: grant.attempt.id, epoch: grant.lease.epoch };
}

async function open(c: Client, jobId: string, body: Record<string, unknown>) {
  return call(c, 'POST', `/jobs/${jobId}/previews`, { idempotencyKey: `k-${randomUUID()}`, ...body });
}

async function nextOf<T extends MasterToWorker['type']>(type: T) {
  try {
    return await worker.next(type, 10_000);
  } catch (err) {
    throw new Error(`${(err as Error).message}; received: ${worker.received.map((m) => m.type).join(', ')}`, {
      cause: err,
    });
  }
}

function previewRequest(
  job: { id: string; attemptId: string; epoch: number },
  op: Record<string, unknown>,
  requestId = randomUUID(),
): string {
  worker.sendJson(
    worker.envelope(
      'PREVIEW_REQUEST',
      { attemptId: job.attemptId, epoch: job.epoch, requestId, op },
      { workerId, jobId: job.id },
    ),
  );
  return requestId;
}

async function putTargets(previews: Record<string, unknown> | null, policy: Record<string, unknown> = {}) {
  await stepUp(owner, ownerSecret);
  const cur = await call(owner, 'GET', `/projects/${PROJECT}/deploy-targets`);
  const version = cur.json<{ version: number | null }>().version;
  return call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
    targets: { previews, policy },
    expectedVersion: version,
  });
}

describeIntegration('preview tunnels (integration, p8-preview-tunnels)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await cf.start();
    h = new Harness();
    await h.start({
      installers: { publicOrigin: 'https://console.example.test' },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      ops: {
        internalOrigins: [cf.base],
        cloudflareApi: `${cf.base}/client/v4`,
        controlPlaneAddresses: ['203.0.113.10'],
        limits: { perProjectPer10Min: 200 },
      },
    });
    const url = await h.listen();
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    await h.createUser('owner1', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.createUser('admin1', PW, 'admin');
    adminSecret = (await enroll(h, 'admin1', PW)).secret;
    admin = await fullLogin(h, 'admin1', PW, adminSecret);
    operatorId = await h.createUser('oper1', PW, 'operator');
    await h.grant(operatorId, [PROJECT], 'operator');
    operatorSecret = (await enroll(h, 'oper1', PW)).secret;
    operator = await fullLogin(h, 'oper1', PW, operatorSecret);
    const vw = await h.createUser('view1', PW, 'viewer');
    await h.grant(vw, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
    // The job creator is the operator (re-authorized for agent-opened previews).
    CREATOR = { type: 'user', id: operatorId };

    zoneId = cf.addZone('preview.example.test');
    cf.addRecord(zoneId, {
      type: 'A',
      name: 'www.preview.example.test',
      content: '192.0.2.1',
      ttl: 1,
      proxied: true,
    });

    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'PRVW-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp(owner, ownerSecret);
    expect(
      (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'PRVW-ABCD' })).statusCode,
    ).toBe(200);
    const est = await worker.next('SESSION_ESTABLISHED');
    leaseKeys = [...(est.payload.leaseKeys ?? [])];
    capabilities();
    for (let i = 0; i < 100; i++) {
      const { rows } = await h.db.pool.query<{ preview_tunnels: unknown }>(
        'SELECT preview_tunnels FROM workers WHERE id = $1',
        [workerId],
      );
      if (rows[0]?.preview_tunnels != null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
    await cf.stop();
  });

  it('Test connection reports the preview permissions the token lacks, by name', async () => {
    await stepUp(owner, ownerSecret);
    const save = await call(owner, 'PUT', '/integrations/ops/cloudflare', {
      accountId: cf.account,
      token: cf.token,
    });
    expect(save.statusCode, save.body).toBe(200);
    cf.tunnelAccess = false;
    cf.serviceTokenAccess = false;
    const t1 = await call(owner, 'POST', '/integrations/ops/cloudflare/test', {});
    expect(t1.statusCode, t1.body).toBe(200);
    const r1 = t1.json<{
      previews: { tunnels: boolean; accessApps: boolean; serviceTokens: boolean; missing: string[] };
      warnings: string[];
    }>();
    expect(r1.previews).toEqual({
      tunnels: false,
      accessApps: true,
      serviceTokens: false,
      missing: ['Account → Cloudflare Tunnel → Edit', 'Account → Access: Service Tokens → Edit'],
    });
    expect(r1.warnings.join(' ')).toContain('Cloudflare Tunnel → Edit');
    cf.tunnelAccess = true;
    cf.serviceTokenAccess = true;
    const t2 = await call(owner, 'POST', '/integrations/ops/cloudflare/test', {});
    expect(t2.json<{ previews: { missing: string[] } }>().previews.missing).toEqual([]);
  });

  it('settings: the preview zone must be visible to the token; viewers read, admins write with step-up', async () => {
    const bad = await putTargets({ zone: { id: 'f'.repeat(32), name: 'other.example.test' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe('zone_not_permitted');
    const ok = await putTargets({
      zone: { id: zoneId, name: 'preview.example.test' },
      prefix: 'pv',
      accessEmails: ['Owner@Example.test'],
      maxActive: 4,
      maxPerJob: 2,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const view = await call(viewer, 'GET', `/projects/${PROJECT}/previews`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({
      settings: {
        zone: { name: 'preview.example.test' },
        prefix: 'pv',
        accessEmails: ['owner@example.test'],
        agentsMayOpen: true,
        previewTunnel: 'auto',
        stableTunnel: 'approval',
      },
      tunnels: [],
    });
  });

  it('a person opens a public preview of a running job: exact Cloudflare calls, signed TUNNEL_START, no token stored', async () => {
    const job = await runningJob();
    const avail = await call(viewer, 'GET', `/jobs/${job.id}/previews`);
    expect(avail.json()).toMatchObject({ available: { ok: true, reason: null }, tunnels: [] });
    expect((await open(viewer, job.id, { port: 5173 })).statusCode).toBe(403);
    expect((await open(operator, job.id, { port: 22 })).statusCode).toBe(400);
    expect((await open(operator, job.id, { port: 5432 })).statusCode).toBe(400);
    cf.reset();
    const res = await open(operator, job.id, { port: 5173, name: 'web-app' });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<Outcome>();
    expect(out.action).toMatchObject({ state: 'succeeded', policy: { decision: 'auto' } });
    const t = out.tunnel as Tunnel;
    expect(t).toMatchObject({ state: 'active', protection: 'none', stable: false, port: 5173 });
    expect(t.hostname).toMatch(/^pv-web-app-[a-z0-9]{10}\.preview\.example\.test$/);
    expect(t.url).toBe(`https://${t.hostname}`);
    // Exactly: tunnel, its one ingress rule, the CNAME — nothing else written.
    expect(cf.calls(/^(POST|PUT|PATCH|DELETE) /)).toEqual([
      `POST /client/v4/accounts/${cf.account}/cfd_tunnel`,
      expect.stringMatching(
        new RegExp(`^PUT /client/v4/accounts/${cf.account}/cfd_tunnel/[^/]+/configurations$`),
      ),
      `POST /client/v4/zones/${zoneId}/dns_records`,
    ]);
    const tunnel = [...cf.tunnels.values()].at(-1);
    expect(tunnel?.config).toEqual({
      ingress: [
        {
          hostname: t.hostname,
          service: 'http://localhost:5173',
          originRequest: { httpHostHeader: 'localhost:5173' },
        },
        { service: 'http_status:404' },
      ],
    });
    const cname = cf.zones.get(zoneId)?.records.find((r) => r.name === t.hostname);
    expect(cname).toMatchObject({
      type: 'CNAME',
      content: `${tunnel?.id ?? ''}.cfargotunnel.com`,
      proxied: true,
    });
    const start = await nextOf('TUNNEL_START');
    const p = start.payload;
    expect(p).toMatchObject({
      tunnelId: t.id,
      jobId: job.id,
      attemptId: job.attemptId,
      port: 5173,
      hostname: t.hostname,
      check: 'declared',
    });
    expect(p.connectorToken).toBe(cf.tunnelTokenOf(tunnel?.id ?? ''));
    expect(verifyTunnelStart({ workerId, ...p }, p.signature, leaseKeys)).toBe('ok');
    expect(verifyTunnelStart({ workerId, ...p, port: 5174 }, p.signature, leaseKeys)).toBe('bad_signature');
    // The connector token is nowhere on the master: rows, audit, logs, responses.
    const dump =
      JSON.stringify((await h.db.pool.query('SELECT row_to_json(t) AS r FROM preview_tunnels t')).rows) +
      JSON.stringify((await h.db.pool.query('SELECT metadata FROM audit_events')).rows) +
      JSON.stringify((await h.db.pool.query('SELECT result, diff, params FROM ops_actions')).rows);
    expect(dump).not.toContain(p.connectorToken);
    expect(h.logs.text).not.toContain(p.connectorToken);
    expect(bodies.join('\n')).not.toContain(p.connectorToken);
    // Connector state from the worker.
    worker.sendJson(
      worker.envelope(
        'TUNNEL_STATUS',
        { tunnelId: t.id, state: 'running', restarts: 0, at: h.clock.now().toISOString() },
        { workerId },
      ),
    );
    await expect
      .poll(
        async () =>
          (await call(viewer, 'GET', `/jobs/${job.id}/previews`)).json<{ tunnels: Tunnel[] }>().tunnels[0]
            ?.connector?.state,
      )
      .toBe('running');
    // The Outputs read model lists it as a live preview site.
    const outputs = await call(viewer, 'GET', `/outputs?project=${PROJECT}&type=site`);
    expect(outputs.statusCode, outputs.body).toBe(200);
    expect(outputs.body).toContain(t.hostname);
    // Close: connector stopped, every resource deleted (the tunnel delete revokes the token).
    cf.reset();
    const closed = await call(operator, 'POST', `/previews/${t.id}/close`, {
      idempotencyKey: `c-${randomUUID()}`,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<Outcome>().tunnel?.state).toBe('closed');
    const stop = await nextOf('TUNNEL_STOP');
    expect(stop.payload.tunnelId).toBe(t.id);
    expect(
      verifyTunnelStop(
        { workerId, tunnelId: t.id, issuedAt: stop.payload.issuedAt },
        stop.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    expect(cf.calls(/^DELETE /)).toEqual([
      expect.stringMatching(/\/dns_records\//),
      expect.stringMatching(/\/cfd_tunnel\/[^/]+\/connections$/),
      expect.stringMatching(/\/cfd_tunnel\/[^/]+$/),
    ]);
    expect(tunnel?.deleted).toBe(true);
    const { rows } = await h.db.pool.query<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_events WHERE action LIKE 'preview.%' OR (action LIKE 'ops.action.%' AND target LIKE 'ops-action:%') ORDER BY occurred_at, id",
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'ops.action.request',
        'preview.tunnel.open',
        'ops.action.execute',
        'preview.tunnel.close',
      ]),
    );
  });

  it("the job's agent opens a preview over its live lease; stale leases and the agent switch are enforced", async () => {
    const job = await runningJob();
    const stale = previewRequest(
      { ...job, epoch: job.epoch + 1 },
      { kind: 'open', port: 3000, check: 'owned' },
    );
    const r0 = await nextOf('PREVIEW_RESULT');
    expect(r0.payload).toMatchObject({ requestId: stale, status: 'refused', reason: 'stale_lease' });
    // A port not declared by a human cannot skip the ownership check.
    previewRequest(job, { kind: 'open', port: 3000, check: 'declared' });
    expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
      status: 'refused',
      reason: 'not_declared',
    });
    const req = previewRequest(job, { kind: 'open', port: 3000, check: 'owned', name: 'api' });
    const r1 = await nextOf('PREVIEW_RESULT');
    expect(r1.payload).toMatchObject({ requestId: req, status: 'ok' });
    const info = r1.payload.tunnels?.[0];
    expect(info).toMatchObject({ name: 'api', protection: 'none', state: 'active', port: 3000 });
    const start = await nextOf('TUNNEL_START');
    expect(start.payload).toMatchObject({ tunnelId: info?.id, check: 'owned', port: 3000 });
    // The same port again: the same preview (no second tunnel).
    const before = cf.tunnels.size;
    previewRequest(job, { kind: 'open', port: 3000, check: 'owned' });
    expect((await nextOf('PREVIEW_RESULT')).payload.tunnels?.[0]?.id).toBe(info?.id);
    await nextOf('TUNNEL_START');
    expect(cf.tunnels.size).toBe(before);
    // Limit per job (2): a second port is fine, a third is refused.
    previewRequest(job, { kind: 'open', port: 3001, check: 'owned' });
    expect((await nextOf('PREVIEW_RESULT')).payload.status).toBe('ok');
    await nextOf('TUNNEL_START');
    previewRequest(job, { kind: 'open', port: 3002, check: 'owned' });
    const limited = await nextOf('PREVIEW_RESULT');
    expect(limited.payload).toMatchObject({ status: 'refused' });
    expect(limited.payload.detail).toContain('limit 2');
    // list, close by name.
    previewRequest(job, { kind: 'list' });
    expect((await nextOf('PREVIEW_RESULT')).payload.tunnels).toHaveLength(2);
    previewRequest(job, { kind: 'close', name: 'api' });
    expect((await nextOf('PREVIEW_RESULT')).payload.status).toBe('ok');
    await nextOf('TUNNEL_STOP');
    // The job ends: the sweep closes its remaining job-bound preview.
    await jobs.transition(job.id, 'cancel_requested', { actor: SYSTEM }).catch(() => undefined);
    await h.db.pool.query(
      "UPDATE leases SET expires_at = acquired_at + interval '1 millisecond' WHERE job_id = $1 AND released_at IS NULL",
      [job.id],
    );
    h.clock.advance(1000);
    expect(await h.app.previews.sweep()).toBeGreaterThanOrEqual(1);
    await nextOf('TUNNEL_STOP');
    const left = await call(viewer, 'GET', `/jobs/${job.id}/previews`);
    expect(left.json<{ tunnels: Tunnel[] }>().tunnels.every((x) => x.state === 'closed')).toBe(true);
    // Agents switched off: refused, people can still open one.
    await putTargets({
      zone: { id: zoneId, name: 'preview.example.test' },
      agentsMayOpen: false,
      accessEmails: ['owner@example.test'],
    });
    const job2 = await runningJob();
    previewRequest(job2, { kind: 'open', port: 3000, check: 'owned' });
    expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
      status: 'refused',
      reason: 'agents_disabled',
    });
    await putTargets({
      zone: { id: zoneId, name: 'preview.example.test' },
      prefix: 'pv',
      accessEmails: ['owner@example.test'],
      maxActive: 4,
      maxPerJob: 2,
    });
  });

  it('Access e-mail and service-token protection; the service token is encrypted, handed to its job, revealed with step-up', async () => {
    const job = await runningJob();
    cf.reset();
    const acc = await open(operator, job.id, { port: 8080, protect: 'access' });
    expect(acc.statusCode, acc.body).toBe(200);
    await nextOf('TUNNEL_START');
    const app = [...cf.accessApps.values()].at(-1);
    expect(app?.body).toMatchObject({
      type: 'self_hosted',
      domain: acc.json<Outcome>().tunnel?.hostname,
      policies: [{ decision: 'allow', include: [{ email: { email: 'owner@example.test' } }] }],
    });
    const req = previewRequest(job, {
      kind: 'open',
      port: 8081,
      check: 'owned',
      protect: 'service-token',
      name: 'backend',
    });
    const r = await nextOf('PREVIEW_RESULT');
    expect(r.payload).toMatchObject({ requestId: req, status: 'ok' });
    const st = r.payload.tunnels?.[0]?.serviceToken;
    const token = [...cf.serviceTokens.values()].at(-1);
    expect(st).toMatchObject({ clientSecret: token?.clientSecret });
    expect(typeof st?.clientId).toBe('string');
    const stApp = [...cf.accessApps.values()].at(-1);
    expect(stApp?.body.policies).toEqual([
      {
        name: 'Remyral preview: service token',
        decision: 'non_identity',
        include: [{ service_token: { token_id: token?.id } }],
      },
    ]);
    await nextOf('TUNNEL_START');
    const id = r.payload.tunnels?.[0]?.id ?? '';
    const raw = await h.db.pool.query<{ s: Buffer }>(
      'SELECT service_token_secret AS s FROM preview_tunnels WHERE id = $1',
      [id],
    );
    expect(raw.rows[0]?.s.toString('utf8')).not.toContain(token?.clientSecret ?? 'x');
    // Reveal: project admin with an always-fresh code; operators never.
    expect((await call(operator, 'POST', `/previews/${id}/reveal`, {})).statusCode).toBe(403);
    h.clock.advance(11 * MIN);
    expect((await call(admin, 'POST', `/previews/${id}/reveal`, {})).statusCode).toBe(403);
    await stepUp(admin, adminSecret);
    const shown = await admin.req('POST', `/previews/${id}/reveal`, {});
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json()).toEqual({ clientId: st?.clientId, clientSecret: token?.clientSecret });
    expect(shown.headers['cache-control']).toBe('no-store');
    // The secret never reaches audit, logs or other responses.
    const audit = JSON.stringify((await h.db.pool.query('SELECT metadata FROM audit_events')).rows);
    expect(audit).not.toContain(token?.clientSecret ?? 'x');
    expect(h.logs.text).not.toContain(token?.clientSecret ?? 'x');
    expect(bodies.join('\n')).not.toContain(token?.clientSecret ?? 'x');
    // Close: the Access app and the service token go too.
    cf.reset();
    await call(operator, 'POST', `/previews/${id}/close`, { idempotencyKey: `c-${randomUUID()}` });
    await nextOf('TUNNEL_STOP');
    expect(cf.calls(/^DELETE /)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/access\/apps\//),
        expect.stringMatching(/\/access\/service_tokens\//),
      ]),
    );
    expect(cf.serviceTokens.has(token?.id ?? '')).toBe(false);
    const after = await h.db.pool.query<{ s: Buffer | null }>(
      'SELECT service_token_secret AS s FROM preview_tunnels WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.s).toBeNull();
  });

  it('stable preview: reserving needs approval; it detaches when the job ends and re-attaches with a rotated secret', async () => {
    const job = await runningJob();
    const req = previewRequest(job, {
      kind: 'open',
      port: 4000,
      check: 'owned',
      stable: true,
      name: 'apk-api',
    });
    const pending = await nextOf('PREVIEW_RESULT');
    expect(pending.payload).toMatchObject({ requestId: req, status: 'pending', reason: 'awaiting_approval' });
    const actionId = pending.payload.actionId ?? '';
    expect((await call(operator, 'POST', `/deploy/actions/${actionId}/approve`, {})).statusCode).toBe(403);
    const ok = await call(admin, 'POST', `/deploy/actions/${actionId}/approve`, { reason: 'APK backend' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ state: string }>().state).toBe('succeeded');
    const start1 = await nextOf('TUNNEL_START');
    const hostname = start1.payload.hostname;
    expect(hostname).toMatch(/^pv-apk-api-[a-z0-9]{10}\.preview\.example\.test$/);
    const lifetime = Date.parse(start1.payload.expiresAt) - h.clock.now().getTime();
    expect(lifetime).toBeGreaterThan(29 * 24 * 60 * MIN);
    // The job ends: the stable preview keeps its hostname, its connector stops.
    await h.db.pool.query(
      "UPDATE leases SET expires_at = acquired_at + interval '1 millisecond' WHERE job_id = $1 AND released_at IS NULL",
      [job.id],
    );
    h.clock.advance(1000);
    await h.app.previews.sweep();
    await nextOf('TUNNEL_STOP');
    const idle = (await call(viewer, 'GET', `/projects/${PROJECT}/previews`))
      .json<{ tunnels: Tunnel[] }>()
      .tunnels.find((x) => x.hostname === hostname);
    expect(idle).toMatchObject({ state: 'idle', stable: true, port: null });
    // A later job serves the same name: no new approval, the same hostname, a rotated secret (new token).
    const job2 = await runningJob();
    cf.reset();
    previewRequest(job2, { kind: 'open', port: 4100, check: 'owned', stable: true, name: 'apk-api' });
    const again = await nextOf('PREVIEW_RESULT');
    expect(again.payload).toMatchObject({ status: 'ok' });
    expect(again.payload.tunnels?.[0]?.url).toBe(`https://${hostname}`);
    expect(cf.calls(/^(PATCH|PUT|POST) /)).toEqual([
      expect.stringMatching(/^PATCH .*\/cfd_tunnel\/[^/]+$/),
      expect.stringMatching(/^PUT .*\/configurations$/),
    ]);
    const start2 = await nextOf('TUNNEL_START');
    expect(start2.payload).toMatchObject({ hostname, port: 4100, jobId: job2.id });
    expect(start2.payload.connectorToken).not.toBe(start1.payload.connectorToken);
    // Expiry closes it for good.
    h.clock.advance(31 * 24 * 60 * MIN);
    await h.app.previews.sweep();
    const row = await h.db.pool.query<{ state: string; close_reason: string }>(
      'SELECT state, close_reason FROM preview_tunnels WHERE hostname = $1',
      [hostname],
    );
    expect(row.rows[0]).toMatchObject({ state: 'closed', close_reason: 'expired' });
  });

  it('reconnect: a worker that lost its connector gets TUNNEL_START again; unknown connectors are stopped', async () => {
    // A month passed in the previous test: sign in again.
    operator = await fullLogin(h, 'oper1', PW, operatorSecret);
    worker.received.length = 0;
    const job = await runningJob();
    const res = await open(operator, job.id, { port: 5000 });
    const t = res.json<Outcome>().tunnel as Tunnel;
    await nextOf('TUNNEL_START');
    const ghost = randomUUID();
    capabilities([{ tunnelId: ghost, state: 'running', since: h.clock.now().toISOString() }]);
    // Every open preview of this machine without a running connector is started again (earlier tests left some).
    const restarted: string[] = [];
    for (let i = 0; i < 8 && !restarted.includes(t.id); i++)
      restarted.push((await nextOf('TUNNEL_START')).payload.tunnelId);
    expect(restarted).toContain(t.id);
    const stop = await nextOf('TUNNEL_STOP');
    expect(stop.payload.tunnelId).toBe(ghost);
    worker.received.length = 0;
    // Project limit (4 open): further opens are refused with the reason, as refused ops actions.
    let refused = null as Outcome | null;
    for (let i = 0; i < 6 && refused === null; i++) {
      const j = await runningJob();
      const o = (await open(operator, j.id, { port: 6000 + i })).json<Outcome>();
      if (o.action.state === 'refused') refused = o;
      else if (o.action.state !== 'succeeded') throw new Error(JSON.stringify(o));
      else await nextOf('TUNNEL_START');
    }
    expect(refused?.action.policy.reason).toContain('limit 4');
  });

  it('publish_site (ADR-0038): execution.previews.publish for trusted jobs with a Pages project on site-publish-v1 workers; op publish is handed to deploy on success', async () => {
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    worker.received.length = 0;
    const spec = (over: Record<string, unknown> = {}) =>
      ({
        runtime: 'claude-code',
        prompt: 'build the site',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        ...over,
      }) as never;
    const setFeatures = (features: string[]) =>
      h.db.pool.query('UPDATE workers SET features = $2 WHERE id = $1', [workerId, JSON.stringify(features)]);
    await setFeatures(['preview-tunnels-v1', 'site-publish-v1']);
    // No Pages project yet: exactly the preview assignment of before (no publish key).
    const before = await h.app.previews.assignment(PROJECT, spec(), workerId);
    expect(before).not.toBeNull();
    expect(before).not.toHaveProperty('publish');
    expect(
      await h.app.previews.assignment(PROJECT, spec({ sandboxProfile: 'container' }), workerId),
    ).toBeNull();
    // p22-previews-inputs: a worker that publishes container ports gets the preview assignment for container jobs.
    await setFeatures(['preview-tunnels-v1', 'site-publish-v1', 'preview-container-v1']);
    expect(await h.app.previews.assignment(PROJECT, spec({ sandboxProfile: 'container' }), workerId)).toEqual(
      before,
    );
    await setFeatures(['preview-tunnels-v1', 'site-publish-v1']);
    // A Pages target: publish for trusted jobs, also in the container profile (publish only).
    await stepUp(owner, ownerSecret);
    const cur = await call(owner, 'GET', `/projects/${PROJECT}/deploy-targets`);
    const curBody = cur.json<{ targets: Record<string, unknown>; version: number }>();
    expect(
      (
        await call(owner, 'PUT', `/projects/${PROJECT}/deploy-targets`, {
          targets: { ...curBody.targets, pages: { projectName: 'shop-site' } },
          expectedVersion: curBody.version,
        })
      ).statusCode,
    ).toBe(200);
    expect(await h.app.previews.assignment(PROJECT, spec(), workerId)).toMatchObject({
      ...before,
      publish: true,
    });
    expect(await h.app.previews.assignment(PROJECT, spec({ sandboxProfile: 'container' }), workerId)).toEqual(
      {
        tools: false,
        declaredPorts: [],
        protections: ['none'],
        publish: true,
      },
    );
    expect(
      await h.app.previews.assignment(
        PROJECT,
        spec({ sandboxProfile: 'container', sourceTrust: 'untrusted' }),
        workerId,
      ),
    ).toBeNull();
    await setFeatures(['preview-tunnels-v1']);
    expect(await h.app.previews.assignment(PROJECT, spec(), workerId)).not.toHaveProperty('publish');
    await setFeatures(['preview-tunnels-v1', 'site-publish-v1']);

    // PREVIEW_REQUEST op publish: fenced by the lease, then handed to deploy on success (stubbed here; the publish
    // bundle itself is tested in publish-bundle.test.ts).
    const dos = h.app.deployOnSuccess as unknown as Record<string, unknown>;
    const original = dos.requestByAgent;
    const seen: unknown[] = [];
    let answer = {
      status: 'ok',
      reason: 'recorded',
      detail: 'When this job succeeds, the master publishes it.',
    };
    dos.requestByAgent = (job: unknown, raw: unknown) => {
      seen.push([job, raw]);
      return Promise.resolve(answer);
    };
    try {
      const job = await runningJob();
      previewRequest({ ...job, epoch: job.epoch + 1 }, { kind: 'publish' });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
        status: 'refused',
        reason: 'stale_lease',
      });
      expect(seen).toHaveLength(0);
      const req = previewRequest(job, {
        kind: 'publish',
        env: 'preview',
        domain: 'site.preview.example.test',
      });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
        requestId: req,
        status: 'ok',
        reason: 'recorded',
        detail: 'When this job succeeds, the master publishes it.',
      });
      expect(seen[0]).toEqual([
        {
          jobId: job.id,
          project: PROJECT,
          createdByType: 'user',
          createdById: operatorId,
          spec: expect.objectContaining({ sourceTrust: 'trusted' }) as unknown,
        },
        { env: 'preview', domain: 'site.preview.example.test' },
      ]);
      answer = {
        status: 'refused',
        reason: 'creator_forbidden',
        detail: 'The job creator may not request deploys.',
      };
      previewRequest(job, { kind: 'publish' });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
        status: 'refused',
        reason: 'creator_forbidden',
      });
    } finally {
      dos.requestByAgent = original;
    }
  });

  it('p12-deploy-feedback: deploy tools are assigned to deploy-feedback-v1 workers and their ops reach the feedback service', async () => {
    const spec = (over: Record<string, unknown> = {}) =>
      ({
        runtime: 'codex',
        prompt: 'fix the deploy',
        sandboxProfile: 'container',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        ...over,
      }) as never;
    const setFeatures = (features: string[]) =>
      h.db.pool.query('UPDATE workers SET features = $2 WHERE id = $1', [workerId, JSON.stringify(features)]);
    // The project has a Pages target (set above): container jobs get the deploy tools only (no preview tools).
    await setFeatures(['preview-tunnels-v1', 'deploy-feedback-v1']);
    expect(await h.app.previews.assignment(PROJECT, spec(), workerId)).toEqual({
      tools: false,
      declaredPorts: [],
      protections: ['none'],
      deploy: true,
    });
    expect(await h.app.previews.assignment(PROJECT, spec({ sourceTrust: 'untrusted' }), workerId)).toBeNull();
    await setFeatures(['preview-tunnels-v1']);
    expect(await h.app.previews.assignment(PROJECT, spec(), workerId)).toBeNull();
    await setFeatures(['preview-tunnels-v1', 'site-publish-v1', 'deploy-feedback-v1']);

    const fb = h.app.deployFeedback as unknown as Record<string, unknown>;
    const saved = { s: fb.agentStatus, l: fb.agentLogs, r: fb.agentRedeploy };
    const seen: unknown[] = [];
    fb.agentStatus = (job: unknown, a: unknown) => {
      seen.push(['status', job, a]);
      return Promise.resolve({ ok: true, text: 'status text' });
    };
    fb.agentLogs = (job: unknown, a: unknown) => {
      seen.push(['logs', job, a]);
      return Promise.resolve({ ok: true, text: 'log text' });
    };
    fb.agentRedeploy = (job: unknown, a: unknown) => {
      seen.push(['redeploy', job, a]);
      return Promise.resolve({ ok: false, reason: 'already_requested', text: 'already' });
    };
    try {
      const job = await runningJob();
      previewRequest({ ...job, epoch: job.epoch + 1 }, { kind: 'deploy_status' });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
        status: 'refused',
        reason: 'stale_lease',
      });
      expect(seen).toHaveLength(0);
      previewRequest(job, { kind: 'deploy_status' });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({ status: 'ok', detail: 'status text' });
      const actionId = randomUUID();
      previewRequest(job, { kind: 'deploy_logs', actionId, logKind: 'runtime', lines: 50 });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({ status: 'ok', detail: 'log text' });
      previewRequest(job, { kind: 'redeploy', target: 'pages' });
      expect((await nextOf('PREVIEW_RESULT')).payload).toMatchObject({
        status: 'refused',
        reason: 'already_requested',
      });
      expect(seen.map((x) => (x as unknown[])[0])).toEqual(['status', 'logs', 'redeploy']);
      expect((seen[1] as unknown[])[2]).toMatchObject({ actionId, kind: 'runtime', lines: 50 });
      expect((seen[0] as unknown[])[1]).toMatchObject({
        jobId: job.id,
        project: PROJECT,
        createdById: operatorId,
      });
    } finally {
      fb.agentStatus = saved.s;
      fb.agentLogs = saved.l;
      fb.agentRedeploy = saved.r;
    }
  });
});
