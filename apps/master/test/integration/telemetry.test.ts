import { createTelemetry, type Telemetry } from '@remyral/observability/telemetry';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { instrumentPool } from '../../src/telemetry/instrument.js';
import { type MetricsServer, startMetricsServer } from '../../src/telemetry/server.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

const USER: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const SYSTEM: JobActor = { type: 'system', id: 'reconciler' };
const PROMPT = 'PROMPT-CANARY fix the bug with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';
const spec = {
  runtime: 'claude-code',
  prompt: PROMPT,
  repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/test' },
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 3600 },
};

describeIntegration('p6-otel master telemetry (integration)', () => {
  const h = new Harness();
  const spans = new InMemorySpanExporter();
  let t: Telemetry;
  let store: JobStore;
  let server: MetricsServer;
  const TOKEN = 'metrics-token-0123456789abcdef';

  beforeAll(async () => {
    t = createTelemetry({ serviceName: 'remyral-master-test', spanExporter: spans, prometheus: true });
    await h.start({ telemetry: t });
    instrumentPool(h.db.pool, t);
    store = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    const handler = t.metricsHandler;
    if (handler === null) throw new Error('no prometheus handler');
    server = await startMetricsServer({ host: '127.0.0.1', port: 0, handler, token: TOKEN });
  });
  afterAll(async () => {
    await server.close();
    await h.stop();
    await t.shutdown();
  });

  const scrape = async (
    headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
    path = '/metrics',
  ) => fetch(`http://127.0.0.1:${String(server.port)}${path}`, { headers });

  it('records job lifecycle metrics and spans from committed transitions, without prompts', async () => {
    const metrics = h.app.metrics;
    if (metrics === null) throw new Error('metrics not wired');
    await metrics.tailTransitions(); // positions the cursor
    // One job to SUCCEEDED, one lost by lease expiry.
    const ok = (await store.create({ project: 'proj-a', spec, actor: USER, submit: true })).job.id;
    h.clock.advance(4_000);
    const { lease } = await store.acquireLease(ok, 'w-1', 300_000);
    const w: JobActor = { type: 'worker', id: 'w-1' };
    await store.transition(ok, 'lease_acked', { actor: w, epoch: lease.epoch });
    await store.transition(ok, 'runtime_started', { actor: w, epoch: lease.epoch });
    h.clock.advance(60_000);
    await store.transition(ok, 'run_finished', { actor: w, epoch: lease.epoch });
    await store.transition(ok, 'verification_passed', { actor: SYSTEM });
    await store.transition(ok, 'approval_granted', { actor: USER });
    const lost = (await store.create({ project: 'proj-a', spec, actor: USER, submit: true })).job.id;
    await store.acquireLease(lost, 'w-2', 1_000);
    h.clock.advance(5_000);
    await store.transition(lost, 'lease_expired', { actor: SYSTEM });
    expect(await metrics.tailTransitions()).toBeGreaterThanOrEqual(10);

    const body = await (await scrape()).text();
    expect(body).toMatch(/remyral_jobs\{[^}]*state="SUCCEEDED"[^}]*\} 1/);
    expect(body).toMatch(/remyral_jobs\{[^}]*state="LOST"[^}]*\} 1/);
    expect(body).toMatch(/remyral_lease_expiries_total(\{[^}]*\})? 1/);
    expect(body).toMatch(/remyral_job_failures_total\{[^}]*to="LOST"[^}]*\} 1/);
    expect(body).toMatch(/remyral_job_duration_seconds_count\{[^}]*outcome="SUCCEEDED"[^}]*\} 1/);
    // Queue wait of the first job: 4 s in QUEUED.
    expect(body).toMatch(/remyral_job_state_seconds_sum\{[^}]*state="QUEUED"[^}]*\} [4-9]/);
    expect(body).toMatch(/remyral_leases_active(\{[^}]*\})? 0/);
    expect(body).toContain('remyral_db_query_duration_seconds_bucket');
    expect(body).not.toContain('PROMPT-CANARY');

    const finished = spans.getFinishedSpans();
    const transitions = finished.filter((s) => s.name.startsWith('job.transition'));
    expect(
      transitions.some(
        (s) => s.attributes['remyral.job.id'] === ok && s.attributes['remyral.job.to'] === 'SUCCEEDED',
      ),
    ).toBe(true);
    expect(transitions.some((s) => s.attributes['remyral.worker.id'] === 'w-2')).toBe(true);
    const dump = JSON.stringify(finished.map((s) => ({ n: s.name, a: s.attributes, e: s.events })));
    expect(dump).not.toContain('PROMPT-CANARY');
    expect(dump).not.toContain('sk-ant-');
  });

  it('HTTP requests get a server span (route pattern) with database child spans and a duration metric', async () => {
    spans.reset();
    const res = await h.app.inject({ method: 'GET', url: '/status?probe=1' });
    expect(res.statusCode).toBe(200);
    const finished = spans.getFinishedSpans();
    const http = finished.find((s) => s.name === 'HTTP GET /status');
    expect(http?.attributes).toMatchObject({ 'http.route': '/status', 'http.response.status_code': 200 });
    const db = finished.find((s) => s.name === 'db select');
    expect(db?.spanContext().traceId).toBe(http?.spanContext().traceId);
    expect(JSON.stringify(finished.map((s) => s.attributes))).not.toContain('probe=1');
    const body = await (await scrape()).text();
    expect(body).toMatch(/remyral_http_server_duration_seconds_count\{[^}]*route="\/status"[^}]*\} 1/);
  });

  it('the metrics listener is separate, token-protected and serves nothing else', async () => {
    expect((await scrape({})).status).toBe(401);
    expect((await scrape({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await scrape(undefined, '/healthz')).status).toBe(404);
    // Not on the API port.
    expect((await h.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
  });
});
