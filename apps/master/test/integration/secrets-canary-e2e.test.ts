import { randomBytes, randomUUID } from 'node:crypto';
import { createNodeFileOps, exposeJobSecret, FileSecretStore } from '@remyral/worker';
import { type FakeScript, type FakeStep, type LeakTarget } from '@remyral/agent-adapters';
import { scanText } from '@remyral/observability';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p7-secrets-scan canary end to end (A-SEC-3, T-SEC-1/2, T-INJ-1; docs/design/p7-hardening.md §2).
 *
 * Three canaries enter a full job run on a real worker daemon over the real transport:
 *  - JOB: a job secret (`spec.secretRefs`, value only in the worker's secret store) — no vendor format,
 *    so only the worker's exact-value redaction can catch it;
 *  - RUNTIME: the runtime credential (`runtimeAuth` secret-ref, injected as OPENAI_API_KEY);
 *  - GIT: the per-job git credential the master issues over the live session.
 * The (fake) agent leaks JOB and RUNTIME everywhere it can: messages (→ live logs), tool calls/results,
 * errors, memory (→ a memory suggestion; p11: the redacted one is dropped, the proposal audited), an approval request (→ approvals, notifications), the result summary, a
 * crash (→ failure notification). Afterwards none of them may appear in any text/json column of any
 * table, in the master or worker logs, or in any API response (every GET route of the registry plus the
 * SSE stream) — while the redaction markers prove the leaks happened.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;
const JOB_CANARY = `canary-job-${randomBytes(12).toString('hex')}`;
const RUNTIME_CANARY = ['sk', 'proj', randomBytes(30).toString('base64url').replace(/[-_]/g, 'q') + '7'].join(
  '-',
);
const GIT_CANARY = `ghs_${randomBytes(27).toString('hex').slice(0, 36)}`;
const CANARIES = [JOB_CANARY, RUNTIME_CANARY, GIT_CANARY];

/** Encodings a careless serializer might use. */
function variants(value: string): string[] {
  return [
    value,
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
    Buffer.from(value).toString('hex'),
    encodeURIComponent(value),
  ];
}
const FORBIDDEN = CANARIES.flatMap(variants);

const TARGETS: readonly LeakTarget[] = [
  'message',
  'tool_call',
  'tool_result',
  'error',
  'memory',
  'approval',
  'summary',
  'file',
];
const leakEverywhere: FakeStep[] = TARGETS.flatMap((into) => [
  { kind: 'leak-secret', envName: 'CANARY_JOB_SECRET', into },
  { kind: 'leak-secret', envName: 'OPENAI_API_KEY', into },
]);
const script: FakeScript = (prompt) =>
  prompt.includes('leak:crash')
    ? [{ kind: 'leak-secret', envName: 'CANARY_JOB_SECRET', into: 'crash' }]
    : [
        ...leakEverywhere,
        {
          kind: 'emit',
          event: {
            kind: 'usage',
            inputTokens: 10,
            outputTokens: 5,
            provenance: 'reported-by-runtime',
            model: 'gpt-test',
          },
        },
      ];

describeIntegration(
  'p7-secrets-scan: canary secrets never persist or leave the master (integration)',
  { timeout: 180_000 },
  () => {
    let h: Harness;
    let url: string;
    let admin: Client;
    let secret: string;
    let fileUrl: string;
    let worker: JobWorker | undefined;
    const dirs: string[] = [];
    const jobIds: string[] = [];
    const responses: { url: string; status: number; body: string }[] = [];

    async function state(id: string): Promise<string> {
      return (await admin.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
    }

    beforeAll(async () => {
      h = new Harness();
      await h.start({
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: `canary${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
          credentials: {
            issue: () => Promise.resolve({ token: GIT_CANARY, expiresAt: new Date(Date.now() + 600_000) }),
          },
          timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
        },
      });
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      admin = await fullLogin(h, 'owner1', PW, secret);
      fileUrl = await createBareRepo(dirs);
    });

    it('runs leaky jobs end to end (job secret, runtime credential, git credential)', async () => {
      const dir = await tempDataDir(dirs);
      await pairRealWorker(h, url, admin, secret, dir);
      const store = new FileSecretStore(createNodeFileOps(), dir);
      await store.set('canary-job', JOB_CANARY);
      // The machine's owner exposes this local secret to jobs (default deny: `remyral-worker secret expose`).
      await exposeJobSecret(createNodeFileOps(), dir, 'canary-job', null);
      await store.set('canary-runtime', RUNTIME_CANARY);
      worker = await startJobWorker(url, dir, {
        fileUrl,
        fake: { script },
        runtimeAuth: { codex: { mode: 'secret-ref', ref: 'secret:canary-runtime', env: 'OPENAI_API_KEY' } },
      });
      await expect
        .poll(() => h.app.fleetSessions.hasReported(worker?.daemon.workerId() ?? ''), { timeout: 15_000 })
        .toBe(true);

      // Step-up for approval decisions and exports.
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);

      const submit = async (prompt: string): Promise<string> => {
        const res = await admin.req('POST', '/jobs', {
          project: PROJECT,
          spec: jobSpec({ prompt, secretRefs: { CANARY_JOB_SECRET: 'secret:canary-job' } }),
        });
        expect(res.statusCode, res.body).toBe(201);
        const id = res.json<{ job: { id: string } }>().job.id;
        jobIds.push(id);
        return id;
      };

      // Job 1: leaks everywhere, waits for the approval it asked for (description carries the leak).
      const leaky = await submit('do the work leak:all');
      let approvalId: string | undefined;
      await expect
        .poll(
          async () => {
            approvalId = (await admin.req('GET', '/approvals?status=pending'))
              .json<{ items: { id: string; jobId: string }[] }>()
              .items.find((r) => r.jobId === leaky)?.id;
            return approvalId;
          },
          { timeout: 30_000 },
        )
        .toBeDefined();
      expect(
        (await admin.req('POST', `/approvals/${String(approvalId)}/approve`, { reason: 'ok' })).statusCode,
      ).toBe(200);
      await expect.poll(() => state(leaky), { timeout: 30_000 }).toBe('SUCCEEDED');
      // Job 2: the runtime crashes with the secret in its error → FAILED → failure notification.
      const crash = await submit('leak:crash');
      await expect.poll(() => state(crash), { timeout: 30_000 }).toBe('FAILED');
      await h.app.notifications.runOnce();

      // Every GET route of the registry, with this run's ids bound (plus a few query variants).
      const ids: Record<string, string> = {
        job: leaky,
        approval: String(approvalId),
        doc:
          (await admin.req('GET', '/context/docs?namespace=project:' + PROJECT)).json<{
            items: { id: string }[];
          }>().items[0]?.id ?? randomUUID(),
      };
      const skip = /^\/(v1\/worker|openapi\.json)/;
      for (const r of h.app.registeredRoutes) {
        if (r.method !== 'GET' || skip.test(r.url) || r.url === '/jobs/:id/stream') continue;
        const targets = r.url.startsWith('/jobs/:id') ? [leaky, crash] : [undefined];
        for (const jobId of targets) {
          const path = r.url.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
            if (r.url.startsWith('/jobs/') && name === 'id') return jobId ?? leaky;
            if (r.url.startsWith('/approvals/')) return ids.approval ?? '';
            if (r.url.startsWith('/context/docs/')) return name === 'version' ? '1' : (ids.doc ?? '');
            return name === 'version' ? '1' : randomUUID();
          });
          const query =
            r.url === '/context/bundle'
              ? `?project=${PROJECT}&runtime=codex`
              : r.url.startsWith('/context/')
                ? `?namespace=project:${PROJECT}&project=${PROJECT}`
                : r.url === '/audit/export' || r.url.endsWith('/export')
                  ? '?format=jsonl'
                  : '';
          const res = await admin.req('GET', `${path}${query}`);
          responses.push({ url: `${path}${query}`, status: res.statusCode, body: res.body });
        }
      }
      // The live stream (backfill of the leaky job) as a browser would read it.
      const ctrl = new AbortController();
      const sse = await fetch(`${url.replace('ws://', 'http://')}/jobs/${leaky}/stream?after=0`, {
        headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        signal: ctrl.signal,
      });
      let streamed = '';
      const reader = sse.body?.getReader();
      const until = Date.now() + 3_000;
      while (reader !== undefined && Date.now() < until && !streamed.includes('event: job')) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => {
            setTimeout(() => {
              r(null);
            }, 500);
          }),
        ]);
        if (chunk === null || chunk.done) continue;
        streamed += Buffer.from(chunk.value).toString('utf8');
      }
      ctrl.abort();
      responses.push({ url: `/jobs/${leaky}/stream`, status: sse.status, body: streamed });
    });

    afterAll(async () => {
      await worker?.stop().catch(() => undefined);
      await h.stop();
      await removeDirs(dirs);
    });

    it('the leaks happened and were redacted (the test can see them)', async () => {
      const { rows } = await h.db.pool.query<{ kind: string; t: string }>(
        'SELECT kind, payload::text AS t FROM job_events WHERE job_id = ANY($1)',
        [jobIds],
      );
      expect(rows.map((r) => r.t).join('\n')).toContain('[REDACTED:');
      const kinds = new Set(rows.map((r) => r.kind));
      for (const k of ['tool_call', 'tool_result', 'error', 'memory', 'approval_request', 'message']) {
        expect(kinds, k).toContain(k);
      }
      const logs = (await admin.req('GET', `/jobs/${jobIds[0] ?? ''}/logs`)).body;
      expect(logs).toContain('[REDACTED:');
      expect(
        (worker?.lines ?? []).some((l) => l.msg === 'git credential answer' && l.status === 'granted'),
      ).toBe(true);
    });

    it('no canary in any text/json column of any table', async () => {
      const { rows: columns } = await h.db.pool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        `SELECT c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY', 'bytea', 'USER-DEFINED')`,
      );
      expect(columns.length).toBeGreaterThan(50);
      const tables = new Set(columns.map((c) => c.table_name));
      for (const t of [
        'job_events',
        'job_log_chunks',
        'usage_records',
        'audit_events',
        'notifications',
        'context_documents',
        'approval_requests',
        'worker_inbox',
        'worker_outbox',
        'jobs',
      ]) {
        expect(tables, t).toContain(t);
      }
      const hits: string[] = [];
      for (const c of columns) {
        const expr =
          c.data_type === 'bytea' ? `encode("${c.column_name}", 'escape')` : `"${c.column_name}"::text`;
        for (const value of FORBIDDEN) {
          const { rows } = await h.db.pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM "${c.table_name}" WHERE strpos(${expr}, $1) > 0`,
            [value],
          );
          if (Number(rows[0]?.n) > 0) hits.push(`${c.table_name}.${c.column_name}`);
        }
      }
      expect(hits).toEqual([]);
      // The data is there (the scan is not vacuous).
      const counts = await h.db.pool.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM job_log_chunks) AS logs, (SELECT count(*) FROM usage_records) AS usage,
              (SELECT count(*) FROM notifications) AS notifications,
              (SELECT count(*) FROM audit_events WHERE action = 'memory.suggestion.propose'
                AND metadata->>'source' = 'agent' AND metadata->>'project' = '${PROJECT}') AS memory`,
      );
      for (const [k, v] of Object.entries(counts.rows[0] ?? {})) expect(Number(v), k).toBeGreaterThan(0);
    });

    it('no canary in the master logs or the worker logs (captured at trace / debug)', () => {
      const master = h.logs.text;
      const workerLogs = JSON.stringify(worker?.lines ?? []);
      expect(master.length).toBeGreaterThan(10_000);
      for (const value of FORBIDDEN) {
        expect(master.includes(value), 'master log').toBe(false);
        expect(workerLogs.includes(value), 'worker log').toBe(false);
      }
      // The scanner agrees (the same tool CI runs).
      expect(
        scanText(master, { canaries: CANARIES, highEntropy: false }).filter((f) => f.rule === 'canary'),
      ).toEqual([]);
    });

    it('no canary in any API response (every GET route of the registry, the SSE stream)', () => {
      expect(responses.length).toBeGreaterThan(40);
      expect(responses.filter((r) => r.status === 200).length).toBeGreaterThan(20);
      const leaks = responses.filter((r) => FORBIDDEN.some((v) => r.body.includes(v))).map((r) => r.url);
      expect(leaks).toEqual([]);
      const stream = responses.find((r) => r.url.startsWith('/jobs/') && r.url.endsWith('/stream'));
      expect(stream?.body).toContain('[REDACTED:');
    });
  },
);
