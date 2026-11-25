import { randomUUID } from 'node:crypto';
import {
  type LeaseKey,
  type MasterToWorker,
  ServiceSpec,
  verifyServiceControl,
  verifyServiceStart,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, toolSummary } from '../../src/chat/tools.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import type { ServiceEvent } from '../../src/services/events.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p15-services against a real master (Postgres) and a raw worker: start from a running job's worktree (signed
 * SERVICE_START, no job slot), RBAC (viewer reads, operator starts, outsider 404), SERVICE_STATUS → state / URL /
 * events / the watches' URL source, logs round trip, stop / restart / extend (signed SERVICE_CONTROL, new revision),
 * CAPABILITIES reconciliation (re-send, stop unknown), a job agent's SERVICE_REQUEST (fenced, creator re-authorized,
 * only its own services), the expiry sweep, ASSIGN_JOB execution.services and the audit trail.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const MIN = 60_000;
const h = new Harness();
let jobs: JobStore;
let owner: Client;
let operator: Client;
let operatorId = '';
let viewer: Client;
let outsider: Client;
let worker: RawWorker;
let workerId = '';
let leaseKeys: LeaseKey[] = [];
let ownerSecret = '';
const events: ServiceEvent[] = [];

type Start = Extract<MasterToWorker, { type: 'SERVICE_START' }>;
type Control = Extract<MasterToWorker, { type: 'SERVICE_CONTROL' }>;

async function stepUp(c: Client, secret: string): Promise<void> {
  h.clock.advance(30_000);
  expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
}

function capabilities(
  services: { serviceId: string; revision: number; state: string; since: string; network?: boolean }[],
  features: string[] = ['services-v1'],
): void {
  worker.sendJson(
    worker.envelope(
      'CAPABILITIES',
      {
        runtimes: [],
        sandboxProfiles: ['host-restricted'],
        maxParallelJobs: 1,
        tools: [],
        features,
        services: { max: 8, services },
      },
      { workerId },
    ),
  );
}

function status(serviceId: string, p: Record<string, unknown>): void {
  worker.sendJson(
    worker.envelope(
      'SERVICE_STATUS',
      { serviceId, revision: 1, restarts: 0, at: new Date().toISOString(), health: 'unknown', ...p },
      { workerId },
    ),
  );
}

async function runningJob(): Promise<{ id: string; attemptId: string; epoch: number }> {
  const { job } = await jobs.create({
    project: PROJECT,
    actor: { type: 'user', id: operatorId },
    submit: true,
    spec: {
      runtime: 'claude-code',
      prompt: 'run the dev server and keep it up',
      repository: { url: 'https://example.com/acme/shop.git', baseRef: 'main', workBranch: 'rac/svc' },
      sandboxProfile: 'host-restricted',
      sourceTrust: 'trusted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, workerId, 60 * MIN);
  const actor: JobActor = { type: 'worker', id: workerId };
  await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
  return { id: job.id, attemptId: grant.attempt.id, epoch: grant.lease.epoch };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function nextStart(serviceId: string): Promise<Start> {
  for (;;) {
    const m = await worker.next('SERVICE_START', 10_000);
    if (m.payload.spec.serviceId === serviceId) return m;
  }
}

async function nextControl(serviceId: string): Promise<Control> {
  for (;;) {
    const m = await worker.next('SERVICE_CONTROL', 10_000);
    if (m.payload.serviceId === serviceId) return m;
  }
}

const startBody = (fromJobId: string, over: Record<string, unknown> = {}) => ({
  fromJobId,
  request: {
    name: 'web',
    command: 'pnpm dev --port 5173',
    port: 5173,
    tunnel: 'quick',
    health: { kind: 'http', path: '/' },
    secretEnv: { API_KEY: 'secret:vault-abc' },
    ...over,
  },
});

describeIntegration('services (integration, p15-services)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    const url = await h.listen();
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    await h.createUser('owner1', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
    // p19-project-env "Job-level references": a service's vault secret must be one the project gives its jobs.
    await h.db.pool.query(
      `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
       VALUES ('abc', 'abc', 'generic', 'API_KEY', 1, 'active', now(), now())`,
    );
    await h.db.pool.query(
      "INSERT INTO project_env_credentials (project, credential_id, created_at) VALUES ($1, 'abc', now())",
      [PROJECT],
    );
    operatorId = await h.createUser('oper1', PW, 'operator');
    await h.grant(operatorId, [PROJECT], 'operator');
    operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
    const vw = await h.createUser('view1', PW, 'viewer');
    await h.grant(vw, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
    const out = await h.createUser('oper2', PW, 'operator');
    await h.grant(out, ['other'], 'operator');
    outsider = await fullLogin(h, 'oper2', PW, (await enroll(h, 'oper2', PW)).secret);

    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'SRVC-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp(owner, ownerSecret);
    expect(
      (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'SRVC-ABCD' })).statusCode,
    ).toBe(200);
    const est = await worker.next('SESSION_ESTABLISHED');
    leaseKeys = [...(est.payload.leaseKeys ?? [])];
    capabilities([]);
    await waitFor(async () => {
      const r = await h.db.pool.query<{ ok: boolean }>(
        `SELECT features ? 'services-v1' AS ok FROM workers WHERE id = $1`,
        [workerId],
      );
      return r.rows[0]?.ok === true;
    });
    h.app.services.events.subscribe({}, (e) => events.push(e));
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('ASSIGN_JOB execution.services only for services-v1 workers and repository agent jobs', async () => {
    const spec = { runtime: 'claude-code', sandboxProfile: 'host-restricted' } as never;
    expect(await h.app.services.assignment(PROJECT, spec, workerId)).toEqual({
      tools: true,
      tunnels: ['none', 'quick'],
    });
    expect(
      await h.app.services.assignment(
        PROJECT,
        { ...(spec as object), sandboxProfile: 'container' } as never,
        workerId,
      ),
    ).toBeNull();
    expect(
      await h.app.services.assignment(
        PROJECT,
        { ...(spec as object), kind: 'integration' } as never,
        workerId,
      ),
    ).toBeNull();
  });

  it('start from a running job: RBAC, signed SERVICE_START, no job slot, status → URL, events, logs', async () => {
    const job = await runningJob();
    const before = await h.db.pool.query<{ n: number }>(
      'SELECT running_jobs AS n FROM workers WHERE id = $1',
      [workerId],
    );
    // Viewer reads but cannot start; an operator of another project does not see the project.
    expect((await viewer.req('POST', `/projects/${PROJECT}/services`, startBody(job.id))).statusCode).toBe(
      403,
    );
    expect((await outsider.req('POST', `/projects/${PROJECT}/services`, startBody(job.id))).statusCode).toBe(
      404,
    );
    // Invalid input is refused before anything is stored.
    const bad = await operator.req('POST', `/projects/${PROJECT}/services`, startBody(job.id, { port: 22 }));
    expect(bad.statusCode).toBe(400);
    // A vault credential the project does not give its jobs is refused (names only).
    const foreign = await operator.req(
      'POST',
      `/projects/${PROJECT}/services`,
      startBody(job.id, { secretEnv: { OTHER_KEY: 'secret:vault-not-bound' } }),
    );
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({
      error: 'vault_credential_not_available',
      params: { env: 'OTHER_KEY' },
    });
    const res = await operator.req('POST', `/projects/${PROJECT}/services`, startBody(job.id));
    expect(res.statusCode, res.body).toBe(200);
    const svc = res.json<{ service: { id: string; state: string; workerId: string; sourceJobId: string } }>()
      .service;
    expect(svc).toMatchObject({ state: 'pending', workerId, sourceJobId: job.id });
    // The same name again: refused.
    expect((await operator.req('POST', `/projects/${PROJECT}/services`, startBody(job.id))).statusCode).toBe(
      409,
    );

    const start = await nextStart(svc.id);
    const spec = ServiceSpec.parse(start.payload.spec);
    expect(spec).toMatchObject({
      source: { kind: 'job', jobId: job.id, attemptId: job.attemptId },
      tunnel: 'quick',
      secretEnv: { API_KEY: 'secret:vault-abc' },
      sandboxProfile: 'host-restricted',
    });
    expect(start.payload.gitToken).toBeUndefined();
    expect(
      verifyServiceStart(
        { workerId, revision: start.payload.revision, issuedAt: start.payload.issuedAt, spec },
        start.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    // A service is not a job: the machine's job count is untouched.
    const after = await h.db.pool.query<{ n: number }>(
      'SELECT running_jobs AS n FROM workers WHERE id = $1',
      [workerId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    status(svc.id, {
      state: 'running',
      health: 'healthy',
      pid: 4242,
      startedAt: new Date().toISOString(),
      tunnel: { state: 'running', url: 'https://bright-fox.trycloudflare.com' },
      cpuPercent: 2.5,
      memoryBytes: 50 * 1024 * 1024,
    });
    const view = await waitFor(async () => {
      const r = await viewer.req('GET', `/services/${svc.id}`);
      const v = r.json<{ service: { state: string; url: string | null; memoryBytes: number } }>().service;
      return v.state === 'running' ? v : null;
    });
    expect(view.url).toBe('https://bright-fox.trycloudflare.com');
    expect(view.memoryBytes).toBe(50 * 1024 * 1024);
    expect(events.filter((e) => e.serviceId === svc.id).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['service.url_up', 'service.healthy']),
    );
    // The watches' URL source: visible to project members only.
    const sub = await loadSubject(h.db.pool, { id: operatorId, role: 'operator' });
    expect(await h.app.services.resolveUrl(sub, svc.id)).toMatchObject({
      project: PROJECT,
      url: 'https://bright-fox.trycloudflare.com',
      up: true,
    });
    // Lists: per project and per machine; the outsider sees nothing.
    const list = (await viewer.req('GET', `/projects/${PROJECT}/services`)).json<{
      services: { id: string }[];
    }>();
    expect(list.services.map((s) => s.id)).toContain(svc.id);
    const byWorker = (await owner.req('GET', `/services?worker=${workerId}`)).json<{
      services: { id: string }[];
    }>();
    expect(byWorker.services.map((s) => s.id)).toContain(svc.id);
    expect((await outsider.req('GET', '/services')).json<{ services: unknown[] }>().services).toEqual([]);
    expect((await outsider.req('GET', `/services/${svc.id}`)).statusCode).toBe(404);

    // Logs round trip.
    const logs = viewer.req('GET', `/services/${svc.id}/logs?lines=50`);
    const req = await worker.next('SERVICE_LOGS_REQUEST', 10_000);
    expect(req.payload).toMatchObject({ serviceId: svc.id, lines: 50 });
    worker.sendJson(
      worker.envelope(
        'SERVICE_LOGS',
        {
          requestId: req.payload.requestId,
          serviceId: svc.id,
          status: 'ok',
          lines: [{ at: new Date().toISOString(), stream: 'stdout', text: 'ready on :5173' }],
          truncated: false,
        },
        { workerId },
      ),
    );
    const lr = await logs;
    expect(lr.statusCode, lr.body).toBe(200);
    expect(lr.json<{ lines: { text: string }[] }>().lines[0]?.text).toBe('ready on :5173');

    // Extend: a new revision with the new lifetime; restart: the current spec and a signed restart.
    const ext = await operator.req('POST', `/services/${svc.id}/extend`, { untilStopped: true });
    expect(ext.statusCode, ext.body).toBe(200);
    const s2 = await nextStart(svc.id);
    expect(s2.payload.revision).toBe(2);
    expect(s2.payload.spec.expiresAt).toBeNull();
    // Stop (signed), then restart.
    expect((await viewer.req('POST', `/services/${svc.id}/stop`, {})).statusCode).toBe(403);
    expect((await operator.req('POST', `/services/${svc.id}/stop`, {})).statusCode).toBe(200);
    const stop = await nextControl(svc.id);
    expect(stop.payload.op).toBe('stop');
    expect(
      verifyServiceControl(
        { workerId, serviceId: svc.id, op: 'stop', issuedAt: stop.payload.issuedAt },
        stop.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    status(svc.id, { state: 'stopped', revision: 2 });
    expect((await operator.req('POST', `/services/${svc.id}/restart`, {})).statusCode).toBe(200);
    await nextStart(svc.id);
    expect((await nextControl(svc.id)).payload.op).toBe('restart');
    const audit = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target = $1 ORDER BY id`,
      [`service:${svc.id}`],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['service.start', 'service.extend', 'service.stop', 'service.restart']),
    );
    // Secrets never appear as values anywhere (only the reference was ever given).
    const row = await h.db.pool.query<{ spec: unknown }>('SELECT spec FROM services WHERE id = $1', [svc.id]);
    expect(JSON.stringify(row.rows[0]?.spec)).toContain('secret:vault-abc');

    // The project stops giving the credential: a restart from the stored spec re-checks it and stops the service.
    await h.db.pool.query(
      "DELETE FROM project_env_credentials WHERE project = $1 AND credential_id = 'abc'",
      [PROJECT],
    );
    try {
      expect((await operator.req('POST', `/services/${svc.id}/restart`, {})).statusCode).toBe(200);
      const after = await h.db.pool.query<{ desired: string; stop_reason: string | null }>(
        'SELECT desired, stop_reason FROM services WHERE id = $1',
        [svc.id],
      );
      expect(after.rows[0]).toEqual({
        desired: 'stopped',
        stop_reason: 'vault_credential_not_available: API_KEY',
      });
    } finally {
      await h.db.pool.query(
        "INSERT INTO project_env_credentials (project, credential_id, created_at) VALUES ($1, 'abc', now())",
        [PROJECT],
      );
    }
    // Given again: it starts again (later tests use it).
    expect((await operator.req('POST', `/services/${svc.id}/restart`, {})).statusCode).toBe(200);
    expect((await h.db.pool.query('SELECT desired FROM services WHERE id = $1', [svc.id])).rows[0]).toEqual({
      desired: 'running',
    });
  });

  it('reconnect reconciliation: wanted services re-sent, unknown ones removed', async () => {
    const job = await runningJob();
    const res = await operator.req(
      'POST',
      `/projects/${PROJECT}/services`,
      startBody(job.id, { name: 'api', tunnel: 'none', port: 3000 }),
    );
    const id = res.json<{ service: { id: string } }>().service.id;
    await nextStart(id);
    const stray = randomUUID();
    capabilities([{ serviceId: stray, revision: 1, state: 'running', since: new Date().toISOString() }]);
    const again = await nextStart(id);
    expect(again.payload.revision).toBe(1);
    expect((await nextControl(stray)).payload.op).toBe('remove');
    // A status from a service this machine does not own is answered with a remove.
    status(randomUUID(), { state: 'running' });
    await worker.next('SERVICE_CONTROL', 10_000);
  });

  it('a job agent: SERVICE_REQUEST fenced by the live lease; only its own services', async () => {
    const job = await runningJob();
    const ask = async (op: Record<string, unknown>, epoch = job.epoch) => {
      const requestId = randomUUID();
      worker.sendJson(
        worker.envelope(
          'SERVICE_REQUEST',
          { attemptId: job.attemptId, epoch, requestId, op },
          { workerId, jobId: job.id },
        ),
      );
      for (;;) {
        const m = await worker.next('SERVICE_RESULT', 10_000);
        if (m.payload.requestId === requestId) return m.payload;
      }
    };
    expect(await ask({ kind: 'list' }, job.epoch + 5)).toMatchObject({
      status: 'refused',
      reason: 'stale_lease',
    });
    const started = await ask({
      kind: 'start',
      request: { name: 'agent-api', command: 'node server.js', port: 4000, tunnel: 'quick' },
    });
    expect(started.status, JSON.stringify(started)).toBe('ok');
    const mine = started.services?.[0];
    expect(mine).toMatchObject({ name: 'agent-api', startedByThisJob: true });
    await nextStart(mine?.id ?? '');
    const row = await h.db.pool.query<{ created_via: string; created_by_id: string }>(
      'SELECT created_via, created_by_id FROM services WHERE id = $1',
      [mine?.id],
    );
    expect(row.rows[0]).toEqual({
      created_via: 'job',
      created_by_id: `system:job:${job.id}`.replace('system:', ''),
    });
    // Another job's service (the earlier `web`) cannot be stopped from here.
    expect(await ask({ kind: 'stop', name: 'web' })).toMatchObject({
      status: 'refused',
      reason: 'not_this_job',
    });
    expect(await ask({ kind: 'stop', name: 'agent-api' })).toMatchObject({ status: 'ok' });
    expect((await nextControl(mine?.id ?? '')).payload.op).toBe('stop');
    const list = await ask({ kind: 'list' });
    expect(list.services?.some((s) => s.name === 'web' && !s.startedByThisJob)).toBe(true);
  });

  it('the sweep stops services past their lifetime', async () => {
    const job = await runningJob();
    const res = await operator.req(
      'POST',
      `/projects/${PROJECT}/services`,
      startBody(job.id, { name: 'short', tunnel: 'none', ttlMinutes: 5 }),
    );
    const id = res.json<{ service: { id: string; expiresAt: string } }>().service.id;
    await nextStart(id);
    h.clock.advance(6 * MIN);
    expect(await h.app.services.sweep()).toBeGreaterThanOrEqual(1);
    expect((await nextControl(id)).payload).toMatchObject({ op: 'stop', reason: 'expired' });
    const r = await h.db.pool.query<{ desired: string; state: string }>(
      'SELECT desired, state FROM services WHERE id = $1',
      [id],
    );
    expect(r.rows[0]).toEqual({ desired: 'stopped', state: 'expired' });
    expect(events.some((e) => e.serviceId === id && e.kind === 'service.down')).toBe(true);
  });

  it('remove, and refusals: no repository, job not running', async () => {
    const list = (await operator.req('GET', `/projects/${PROJECT}/services`)).json<{
      services: { id: string; name: string }[];
    }>();
    const web = list.services.find((s) => s.name === 'web');
    expect((await operator.req('POST', `/services/${web?.id ?? ''}/stop`, { remove: true })).statusCode).toBe(
      200,
    );
    expect((await nextControl(web?.id ?? '')).payload.op).toBe('remove');
    expect((await operator.req('GET', `/services/${web?.id ?? ''}`)).statusCode).toBe(404);
    const noRepo = await operator.req('POST', `/projects/${PROJECT}/services`, {
      worker: workerId,
      request: { name: 'repo', command: 'x' },
    });
    expect(noRepo.statusCode).toBe(409);
    expect(noRepo.json<{ error: string }>().error).toBe('service_no_repository');
    const gone = await operator.req(
      'POST',
      `/projects/${PROJECT}/services`,
      startBody(randomUUID(), { name: 'gone' }),
    );
    expect(gone.json<{ error: string }>().error).toBe('service_job_not_running');
  });

  it("chat: start_service / stop_service are service_action cards (execute: true flags a direct run), confirmed with the user's own role", async () => {
    const job = await runningJob();
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      services: () => h.app.services,
    } as unknown as ChatToolsDeps);
    const caller = async (id: string, role: 'operator' | 'viewer') => {
      const thread = await store.createThread(id, 'services');
      return {
        userId: id,
        subject: await loadSubject(h.db.pool, { id, role }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
    };
    const op = await caller(operatorId, 'operator');
    const out = await tools.run(op, 'start_service', {
      project: PROJECT,
      fromJobId: job.id,
      name: 'chat-web',
      command: 'pnpm dev',
      port: 5174,
      tunnel: 'quick',
      execute: true,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no card');
    // p15-autonomy: the chat service runs a card with execute: true at once (ChatDirectActions → confirm).
    expect(out.execute).toBe(true);
    expect(out.draft.kind).toBe('service_action');
    expect(out.draft.payload).toMatchObject({ op: 'start', project: PROJECT, request: { name: 'chat-web' } });
    expect(toolSummary('start_service', out)).toContain('draft card');
    // Nothing started before the confirmation.
    expect(
      (await h.app.services.list(op.subject, { project: PROJECT })).some((v) => v.name === 'chat-web'),
    ).toBe(false);
    const viewerRow = await h.db.pool.query<{ id: string }>(`SELECT id FROM users WHERE username = 'view1'`);
    const vw = await caller(viewerRow.rows[0]?.id ?? '', 'viewer');
    expect(
      await tools.run(vw, 'start_service', { project: PROJECT, name: 'nope', command: 'true', port: 5175 }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    const confirmed = await operator.req('POST', `/chat/drafts/${out.draft.id}/confirm`, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const result = confirmed.json<{ result: { op: string; serviceId: string; name: string } }>().result;
    expect(result).toMatchObject({ op: 'start', name: 'chat-web' });
    const id = result.serviceId;
    await nextStart(id);
    const listed = await tools.run(op, 'list_services', { project: PROJECT });
    expect(JSON.stringify(listed)).toContain('chat-web');
    expect(await tools.run(vw, 'stop_service', { project: PROJECT, name: 'chat-web' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const stop = await tools.run(op, 'stop_service', { project: PROJECT, name: 'chat-web', execute: true });
    if (!stop.ok || stop.draft === undefined) throw new Error('no stop card');
    expect(stop.draft.payload).toMatchObject({ op: 'stop', serviceId: id, remove: false });
    // Another user cannot confirm the operator's card.
    expect((await viewer.req('POST', `/chat/drafts/${stop.draft.id}/confirm`, {})).statusCode).toBe(404);
    const stopped = await operator.req('POST', `/chat/drafts/${stop.draft.id}/confirm`, {});
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await nextControl(id)).payload.op).toBe('stop');
    const a = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE target = $1 AND action = 'service.start' AND metadata->>'via' = 'chat'`,
      [`service:${id}`],
    );
    expect(a.rowCount).toBe(1);
  });

  it('p21-service-egress: the project network policy goes with the start (service-egress-v1 only); a change re-sends it', async () => {
    const job = await runningJob();
    const res = await operator.req(
      'POST',
      `/projects/${PROJECT}/services`,
      startBody(job.id, { name: 'netweb', tunnel: 'none', port: 5180 }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json<{ service: { id: string; network: string } }>().service.id;
    // A machine without service-egress-v1: no spec.network (its strict spec would refuse it), model APIs only.
    const plain = await nextStart(id);
    expect(plain.payload.spec.network).toBeUndefined();
    const view = async () =>
      (await operator.req('GET', `/services/${id}`)).json<{ service: { network: string } }>().service.network;
    expect(await view()).toBe('model_apis_only');

    // The machine is updated and restarted the service from its old record (no policy): the reconnect gives it a new
    // revision carrying the policy (default none), still signed.
    capabilities(
      [{ serviceId: id, revision: 1, state: 'running', since: new Date().toISOString(), network: false }],
      ['services-v1', 'service-egress-v1'],
    );
    const updated = await nextStart(id);
    expect(updated.payload.revision).toBe(2);
    expect(updated.payload.spec.network).toEqual({ mode: 'none', hosts: [] });
    expect(
      verifyServiceStart(
        {
          workerId,
          revision: updated.payload.revision,
          issuedAt: updated.payload.issuedAt,
          spec: ServiceSpec.parse(updated.payload.spec),
        },
        updated.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    expect(await view()).toBe('project');

    // An admin allows the package registries: the running service gets a new revision with the npm hosts.
    await stepUp(owner, ownerSecret);
    const put = await owner.req('PUT', `/projects/${PROJECT}/repo-egress`, {
      mode: 'allowlist',
      presets: ['npm'],
      hosts: [],
    });
    expect(put.statusCode, put.body).toBe(200);
    const next = await nextStart(id);
    expect(next.payload.revision).toBe(updated.payload.revision + 1);
    expect(next.payload.spec.network).toMatchObject({
      mode: 'allowlist',
      hosts: expect.arrayContaining(['registry.npmjs.org']),
    });

    // p21-service-exit: a one-shot command that exited by itself (policy never → stopped, still wanted) is ended for
    // the watches, with its exit code — not "not up yet" until the lifetime runs out.
    const sub = await loadSubject(h.db.pool, { id: operatorId, role: 'operator' });
    status(id, { revision: next.payload.revision, state: 'stopped', exitCode: 0, detail: 'exited' });
    const ended = await waitFor(async () => (await h.app.services.resolveUrl(sub, id))?.ended ?? null);
    expect(ended).toMatchObject({ state: 'stopped', exitCode: 0 });
  });
});
