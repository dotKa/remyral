import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import {
  createTelemetry,
  MetricHistory,
  RecentTraces,
  type Telemetry,
} from '@remyral/observability/telemetry';
import { createNodeFileOps, FileKeystore, loadOrCreateDeviceKey } from '@remyral/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Subject } from '../../src/authz/model.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { LogSink } from '../../src/system/logs.js';
import { instrumentPool } from '../../src/telemetry/instrument.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const GH_TOKEN = `ghp_${'Q'.repeat(36)}`;
const USER: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const spec = {
  runtime: 'claude-code',
  prompt: 'PROMPT-CANARY do the thing',
  repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/test' },
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 3600 },
};

interface Status {
  overall: string;
  problems: string[];
  components: { id: string; state: string; code: string | null }[];
  master: { releaseTag: string | null; uptimeSec: number };
  queue: { queued: number; oldestQueuedJobId: string | null; oldestQueuedSec: number } | null;
  workers: { online: number; offline: number } | null;
  errors: { httpRequests: number; http5xx: number; windowMinutes: number } | null;
  disk: { id: string; usedPercent: number; totalBytes: number }[];
  database: { sizeBytes: number } | null;
  redis: { usedMemoryBytes: number } | null;
  tracing: { enabled: boolean; exporting: boolean };
  logs: { enabled: boolean; retentionDays: number };
  versionFeed: { enabled: boolean } | null;
}

interface Logs {
  enabled: boolean;
  lines: {
    id: string;
    level: number;
    levelName: string;
    component: string | null;
    jobId: string | null;
    reqId: string | null;
    traceId: string | null;
    msg: string;
    fields: Record<string, unknown> | null;
  }[];
  nextBefore: string | null;
}

/**
 * p16-observability against a real master (Postgres, Redis, migration 0142): the status page aggregation, the log
 * capture → store → search path with redaction and retention, the recent-traces view, trace context end to end with a
 * fake (raw) worker, the assistant reads and the permission checks.
 */
describeIntegration(
  'p16-observability: status page, log search, traces (integration)',
  { timeout: 90_000 },
  () => {
    const h = new Harness();
    const spans = new InMemorySpanExporter();
    const recent = new RecentTraces({ slowMs: 0 });
    const history = new MetricHistory({
      names: ['remyral_http_server_duration_seconds', 'remyral_db_query_errors', 'remyral_chat_turns'],
    });
    const sink = new LogSink({ retentionDays: 7, minLevel: 'info', requests: 'problems', maxRows: 10_000 });
    let t: Telemetry;
    let url: string;
    let owner: Client;
    let viewer: Client;
    let secret: string;
    let disk: string;
    let webStatus = 200;
    const dirs: string[] = [];

    beforeAll(async () => {
      disk = await mkdtemp(join(tmpdir(), 'remyral-disk-'));
      t = createTelemetry({
        serviceName: 'remyral-master-test',
        spanExporter: spans,
        spanProcessors: [recent],
        metricReaders: [history],
      });
      await h.start({
        telemetry: t,
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
        logTap: (line) => {
          sink.push(line);
        },
        observability: {
          logSink: sink,
          logStore: { retentionDays: 7, minLevel: 'info', requests: 'problems', maxRows: 10_000 },
          recentTraces: recent,
          history,
          releaseTag: 'abcdef123456',
          webUrl: 'http://remyral-test-web:8080/index.html',
          webFetch: () => Promise.resolve(new Response('ok', { status: webStatus })),
          diskPaths: { data: disk, root: '/' },
          // The developer machine's own disk may be nearly full: disk states are not what this suite checks.
          statusThresholds: { diskWarn: 101, diskFail: 101 },
        },
      });
      instrumentPool(h.db.pool, t);
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, secret);
      await h.createUser('viewer1', PW, 'viewer');
      const v = await enroll(h, 'viewer1', PW);
      viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    });
    afterAll(async () => {
      await h.stop();
      await t.shutdown();
      await rm(disk, { recursive: true, force: true });
      await removeDirs(dirs);
    });

    describe('status page', () => {
      it('owners and admins read it; viewers and anonymous callers are refused', async () => {
        expect((await viewer.req('GET', '/system/status')).statusCode).toBe(403);
        expect((await viewer.req('GET', '/system/logs')).statusCode).toBe(403);
        expect((await viewer.req('GET', '/system/traces')).statusCode).toBe(403);
        expect((await h.client().req('GET', '/system/status')).statusCode).toBe(401);
        expect((await owner.req('GET', '/system/status')).statusCode).toBe(200);
      });

      it('aggregates services, queue, disk, database, Redis, the release tag and the last hour from metrics', async () => {
        const store = new JobStore({
          pool: h.db.pool,
          audit: new AuditLog(h.db.pool, h.clock.now),
          clock: h.clock.now,
        });
        const queued = (await store.create({ project: 'proj-a', spec, actor: USER, submit: true })).job.id;
        h.clock.advance(600_000);
        await history.sample();
        await owner.req('GET', '/system/traces');
        await history.sample();
        webStatus = 200;
        const s = (await owner.req('GET', '/system/status')).json<Status>();
        const comp = Object.fromEntries(s.components.map((c) => [c.id, c.state]));
        expect(comp).toMatchObject({
          master: 'ok',
          web: 'ok',
          postgres: 'ok',
          redis: 'ok',
          backup: 'not_configured',
        });
        expect(s.master.releaseTag).toBe('abcdef123456');
        expect(s.queue).toMatchObject({ queued: 1, oldestQueuedJobId: queued });
        expect(s.queue?.oldestQueuedSec).toBeGreaterThanOrEqual(600);
        expect(s.problems).toContain('queue_backlog');
        expect(s.overall).toBe('warning');
        expect(s.errors?.httpRequests).toBeGreaterThanOrEqual(1);
        expect(s.errors?.http5xx).toBe(0);
        expect(s.disk.map((d) => d.id).sort()).toEqual(['data', 'root']);
        expect(s.disk[0]?.totalBytes).toBeGreaterThan(0);
        expect(s.database?.sizeBytes).toBeGreaterThan(0);
        expect(s.redis?.usedMemoryBytes).toBeGreaterThan(0);
        expect(s.tracing).toMatchObject({ enabled: true, exporting: true });
        expect(s.logs).toMatchObject({ enabled: true, retentionDays: 7 });
        expect(JSON.stringify(s)).not.toContain('PROMPT-CANARY');
        await store.transition(queued, 'cancel_requested', { actor: USER }).catch(() => undefined);
      });

      it('a failing dependency fails its line, not the page', async () => {
        webStatus = 503;
        const s = (await owner.req('GET', '/system/status')).json<Status>();
        expect(s.components.find((c) => c.id === 'web')).toMatchObject({
          state: 'failing',
          code: 'http_503',
        });
        expect(s.overall).toBe('failing');
        expect(s.problems).toContain('web');
        webStatus = 200;
      });
    });

    describe('log search', () => {
      it('captures redacted lines with their ids; healthy requests are dropped, problems kept', async () => {
        const store = h.app.logStore;
        if (store === null) throw new Error('log store not wired');
        await store.flush();
        await h.db.pool.query('DELETE FROM master_log_lines');
        const log = h.app.log.child({ component: 'orchestrator', jobId: 'job-obs-1' });
        log.error({ detail: `token ${GH_TOKEN}`, password: 'hunter2' }, `dispatch failed using ${GH_TOKEN}`);
        log.warn('lease about to expire');
        log.debug('below the stored level');
        const ok = await owner.req('GET', '/system/traces');
        expect(ok.statusCode).toBe(200);
        const missing = await owner.req('GET', '/system/traces/0123456789abcdef0123456789abcdef');
        expect(missing.statusCode).toBe(404);
        expect(await store.flush()).toBeGreaterThan(0);

        const byJob = (await owner.req('GET', '/system/logs?jobId=job-obs-1')).json<Logs>();
        expect(byJob.enabled).toBe(true);
        expect(byJob.lines.map((l) => l.msg)).toEqual([
          'lease about to expire',
          expect.stringContaining('dispatch failed'),
        ]);
        const dump = JSON.stringify(byJob);
        expect(dump).not.toContain(GH_TOKEN);
        expect(dump).not.toContain('hunter2');
        expect(byJob.lines[1]?.component).toBe('orchestrator');

        const errors = (await owner.req('GET', '/system/logs?level=error&q=DISPATCH%20FAILED')).json<Logs>();
        expect(errors.lines).toHaveLength(1);
        expect(errors.lines[0]?.levelName).toBe('error');

        // The 200 request left no request lines; the 404 left its pair (same reqId).
        const all = (await owner.req('GET', '/system/logs?limit=500')).json<Logs>();
        const completed = all.lines.filter((l) => l.msg === 'request completed');
        expect(completed).toHaveLength(1);
        const reqId = completed[0]?.reqId ?? '';
        const pair = (await owner.req('GET', `/system/logs?reqId=${reqId}`)).json<Logs>();
        expect(pair.lines.map((l) => l.msg).sort()).toEqual(['incoming request', 'request completed']);
        expect(all.lines.some((l) => l.msg === 'below the stored level')).toBe(false);
      });

      it('pages with nextBefore, validates its query and refuses an inverted range', async () => {
        const page = (await owner.req('GET', '/system/logs?limit=1')).json<Logs>();
        expect(page.lines).toHaveLength(1);
        expect(page.nextBefore).not.toBeNull();
        const next = (
          await owner.req('GET', `/system/logs?limit=1&before=${page.nextBefore ?? ''}`)
        ).json<Logs>();
        expect(next.lines[0]?.id).not.toBe(page.lines[0]?.id);
        expect((await owner.req('GET', '/system/logs?level=loud')).statusCode).toBe(400);
        expect((await owner.req('GET', `/system/logs?jobId=${'x'.repeat(100)}`)).statusCode).toBe(400);
        const inverted = await owner.req(
          'GET',
          '/system/logs?since=2026-10-12T12:00:00Z&until=2026-10-11T12:00:00Z',
        );
        expect(inverted.statusCode).toBe(400);
      });

      it('purges lines past the retention and above the row cap', async () => {
        const store = h.app.logStore;
        if (store === null) throw new Error('log store not wired');
        // Log lines carry the wall-clock time (pino), so retention is measured against it.
        const now = new Date();
        await h.db.pool.query(
          `INSERT INTO master_log_lines (at, level, msg) VALUES ($1, 30, 'ancient'), ($2, 30, 'recent')`,
          [new Date(now.getTime() - 8 * 86_400_000), new Date(now.getTime() - 86_400_000)],
        );
        expect(await store.purge()).toBeGreaterThanOrEqual(1);
        const { rows } = await h.db.pool.query<{ msg: string }>(
          "SELECT msg FROM master_log_lines WHERE msg IN ('ancient', 'recent')",
        );
        expect(rows.map((r) => r.msg)).toEqual(['recent']);
      });
    });

    describe('traces', () => {
      it('lists recent traces with sanitized spans and shows one in detail', async () => {
        await owner.req('GET', '/system/status');
        const list = (await owner.req('GET', '/system/traces?kind=slow')).json<{
          enabled: boolean;
          traces: { traceId: string; root: string }[];
        }>();
        expect(list.enabled).toBe(true);
        const http = list.traces.find((x) => x.root === 'HTTP GET /system/status');
        expect(http).toBeDefined();
        const detail = (await owner.req('GET', `/system/traces/${http?.traceId ?? ''}`)).json<{
          spans: { name: string; attributes: Record<string, unknown> }[];
        }>();
        expect(detail.spans.some((s) => s.name === 'db select')).toBe(true);
        expect(JSON.stringify(detail)).not.toContain('PROMPT-CANARY');
      });

      it('trace context travels master → worker (envelope) → master (worker.message span) with a fake worker', async () => {
        const dataDir = await tempDataDir(dirs);
        const workerId = await pairRealWorker(h, url, owner, secret, dataDir);
        const key = (await loadOrCreateDeviceKey(new FileKeystore(createNodeFileOps(), dataDir))).key;
        const raw = await RawWorker.connect(url, key);
        try {
          expect((await raw.handshake()).type).toBe('SESSION_ESTABLISHED');
          spans.reset();
          // A durable message queued inside a span (as the orchestrator's job.dispatch does for ASSIGN_JOB).
          let dispatchTrace = '';
          let dispatchSpan = '';
          await t.span('job.dispatch', { 'remyral.job.id': 'job-trace-1' }, async (span) => {
            dispatchTrace = span.spanContext().traceId;
            dispatchSpan = span.spanContext().spanId;
            await h.app.fleetSessions.replay.enqueue(
              workerId,
              'CANCEL_JOB',
              { attemptId: '00000000-0000-4000-8000-0000000000aa', epoch: 1, reason: 'trace test' },
              { jobId: 'job-trace-1' },
            );
          });
          const cancel = await raw.next('CANCEL_JOB', 10_000);
          expect(cancel.traceparent).toBe(`00-${dispatchTrace}-${dispatchSpan}-01`);
          const { rows } = await h.db.pool.query<{ traceparent: string | null }>(
            "SELECT traceparent FROM worker_outbox WHERE worker_id = $1 AND type = 'CANCEL_JOB'",
            [workerId],
          );
          expect(rows[0]?.traceparent).toBe(cancel.traceparent);
          // The worker answers continuing the trace: the master's message span joins it.
          const workerSpan = 'b7ad6b7169203331';
          raw.sendJson(
            raw.envelope(
              'HEARTBEAT',
              {
                state: 'online',
                runningJobs: [],
                load: { cpuPercent: 1, memoryFreeBytes: 1, diskFreeBytes: 1 },
              },
              { workerId, traceparent: `00-${dispatchTrace}-${workerSpan}-01` },
            ),
          );
          await expect
            .poll(() => spans.getFinishedSpans().find((s) => s.name === 'worker.message HEARTBEAT'))
            .toBeDefined();
          const hb = spans.getFinishedSpans().find((s) => s.name === 'worker.message HEARTBEAT');
          expect(hb?.spanContext().traceId).toBe(dispatchTrace);
          expect(hb?.parentSpanContext?.spanId).toBe(workerSpan);
          expect(hb?.parentSpanContext?.isRemote).toBe(true);
          // The in-process view merges both parts under the one trace id.
          await expect.poll(() => recent.get(dispatchTrace)?.spans.length ?? 0).toBeGreaterThanOrEqual(2);
        } finally {
          raw.close();
        }
      });
    });

    describe('assistant reads (system_status, search_logs)', () => {
      const subject = (role: 'owner' | 'viewer'): Subject => ({
        userId: '00000000-0000-4000-8000-000000000009',
        role,
        memberships: new Map(),
      });

      it('owners get the snapshot and redacted log lines; viewers are refused', async () => {
        const admin = h.app.chatAdmin;
        expect(await admin.read(subject('viewer'), 'system_status', {})).toMatchObject({
          ok: false,
          code: 'forbidden',
        });
        expect(await admin.read(subject('viewer'), 'search_logs', {})).toMatchObject({
          ok: false,
          code: 'forbidden',
        });
        const s = await admin.read(subject('owner'), 'system_status', {});
        expect(s.ok).toBe(true);
        expect(JSON.stringify(s)).toContain('/settings/system');
        h.app.log.child({ component: 'ops', jobId: 'job-obs-2' }).error(`deploy failed ${GH_TOKEN}`);
        await h.app.logStore?.flush();
        const l = await admin.read(subject('owner'), 'search_logs', { jobId: 'job-obs-2', level: 'error' });
        expect(l.ok).toBe(true);
        const dump = JSON.stringify(l);
        expect(dump).toContain('deploy failed');
        expect(dump).not.toContain(GH_TOKEN);
        expect(await admin.read(subject('owner'), 'search_logs', { since: 'yesterday' })).toMatchObject({
          ok: false,
          code: 'invalid',
        });
      });
    });
  },
);
