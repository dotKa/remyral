import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNodeFileOps, FileSecretStore, NodeHttpExecutor, NodeSmtpExecutor } from '@remyral/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p14-workflow-engine 14.3 (ADR-0055 §5.2, design §19) end to end: engine-2 HTTP request / e-mail / code nodes become
 * `kind: "function"` jobs that only `function-v1` workers take (no AI slot), queue while no capable worker is online
 * and fail `no_worker` into the node's error branch after the queue timeout; a real worker daemon runs the HTTP node
 * against a local server (the worker's address check allows exactly that server; private / metadata addresses
 * stay refused, also after a redirect), attaches the vault credential only for its bound host, sends the same
 * Idempotency-Key on a retry, and the result artifact becomes the node's output. The K1 egress policy (default open,
 * project allowlist) is checked at save and at run, and its route needs an admin with an always-fresh step-up.
 */

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;
const HOST = 'api.example.test';
const TOKEN = 'wf-http-secret-0123456789abcdefXYZ';
const CRED = 'wf-http-e2e';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/app.git', baseRef: 'main' },
};
type Node = Record<string, unknown>;
const n = (id: string, type: string, config: Record<string, unknown> = {}, extra: Node = {}): Node => ({
  id,
  type,
  config,
  ...extra,
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describeIntegration(
  'workflow function nodes on workers (integration, p14 14.3)',
  { timeout: 300_000 },
  () => {
    let h: Harness;
    let url: string;
    let owner: Client;
    let secret: string;
    let operator: Client;
    let fileUrl: string;
    let w: JobWorker | undefined;
    let workerId = '';
    let server: Server;
    let port = 0;
    const seen: Seen[] = [];
    /** Status codes the next requests get (then 200 / 201). */
    const statuses: number[] = [];
    const dirs: string[] = [];
    const prefix = `wf${randomUUID().slice(0, 8)}`;

    async function stepUp(c: Client = owner): Promise<void> {
      h.clock.advance(31_000);
      expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }
    const doc = (name: string, nodes: Node[], edges: Node[]) => ({
      schemaVersion: 2,
      name,
      defaults: DEFAULTS,
      nodes,
      edges,
    });
    async function define(d: Record<string, unknown>): Promise<string> {
      await stepUp();
      const res = await owner.req('POST', '/workflows', { project: PROJECT, definition: d });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }
    async function start(id: string): Promise<string> {
      const res = await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ runId: string }>().runId;
    }
    interface NodeRun {
      node: string;
      state: string;
      attempt: number;
      output: { ports?: Record<string, unknown> } | null;
      error: { code: string; message: string } | null;
    }
    async function nodeRuns(runId: string, node: string): Promise<NodeRun[]> {
      const res = await owner.req('GET', `/workflows/runs/${runId}/node-runs?limit=100&node=${node}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ nodeRuns: NodeRun[] }>().nodeRuns;
    }
    const last = async (runId: string, node: string) => (await nodeRuns(runId, node)).at(-1);
    const runState = async (runId: string) =>
      (await owner.req('GET', `/workflows/runs/${runId}`)).json<{ run: { state: string } }>().run.state;
    async function setEgress(body: { mode: string; hosts: string[] }): Promise<void> {
      await stepUp();
      const res = await owner.req('PUT', `/projects/${PROJECT}/workflow-egress`, body);
      expect(res.statusCode, res.body).toBe(200);
    }
    async function functionJob(runId: string, node: string) {
      const { rows } = await h.db.pool.query<{ id: string; state: string; spec: Record<string, unknown> }>(
        `SELECT j.id, j.state::text AS state, j.spec FROM workflow_node_run_jobs l
           JOIN workflow_node_runs nr ON nr.id = l.node_run_id JOIN jobs j ON j.id = l.job_id
          WHERE nr.run_id = $1 AND nr.node_id = $2 ORDER BY l.created_at`,
        [runId, node],
      );
      return rows;
    }

    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
          if (req.url === '/redirect-to-metadata') {
            res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
            return;
          }
          const status = statuses.shift() ?? (req.method === 'POST' ? 201 : 200);
          res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'a=b' });
          // Echoes the authorization header back: the worker must redact the credential's exact value.
          res.end(JSON.stringify({ ok: status < 400, echo: req.headers.authorization ?? null, got: body }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
      h = new Harness();
      await h.start({
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: prefix,
          tickIntervalMs: 50,
          workflowEngine: { v2: true, v2ForV1: false },
          timing: {
            leaseTtlMs: 3_600_000,
            reconnectGraceMs: 60_000,
            retryBackoffMs: 0,
            effectRetryAfterMs: 0,
          },
        },
      });
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, secret);
      const opId = await h.createUser('oper1', PW, 'operator');
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
      await h.grant(opId, [PROJECT], 'operator');
      const op = await enroll(h, 'oper1', PW);
      operator = await fullLogin(h, 'oper1', PW, op.secret);
      fileUrl = await createBareRepo(dirs);
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at, allowed_hosts)
         VALUES ($1, 'API token', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $2),
                ('wf-smtp-e2e', 'SMTP', 'smtp', 'REMYRAL_SMTP_PASSWORD', 1, 'active', now(), now(), '{smtp.mail.example}')`,
        [CRED, [`${HOST}:${String(port)}`]],
      );
    });

    afterAll(async () => {
      await w?.stop().catch(() => undefined);
      await h.stop();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await removeDirs(dirs);
    });

    /** A real worker daemon advertising function-v1; its address check allows exactly the local test server. */
    async function startWorker(): Promise<JobWorker> {
      const dir = await tempDataDir(dirs);
      await stepUp();
      workerId = await pairRealWorker(h, url, owner, secret, dir);
      await new FileSecretStore(createNodeFileOps(), dir).set(`vault-${CRED}`, TOKEN);
      await h.db.pool.query(
        `INSERT INTO vault_credential_workers (credential_id, worker_id, version, key_id, sealed, sealed_digest, state,
         acked_version, acked_at, ack_outcome, updated_at)
         VALUES ($1, $2, 1, $3, '{"sealed":true}', $4, 'active', 1, now(), 'applied', now())`,
        [CRED, workerId, 'k'.repeat(22), 'd'.repeat(64)],
      );
      const egress = {
        lookup: (host: string) =>
          host === HOST
            ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
            : Promise.reject(new Error('ENOTFOUND')),
        isPublicAddress: (a: string) => a === '127.0.0.1',
      };
      w = await startJobWorker(url, dir, {
        fileUrl,
        features: ['function-v1'],
        functions: { http: new NodeHttpExecutor(egress), email: new NodeSmtpExecutor(egress) },
      });
      await expect.poll(() => h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
      return w;
    }

    describe('K1 egress policy (Projects → Policy → HTTP izin listesi)', () => {
      it('defaults to open; admins change it with an always-fresh step-up; private names are refused', async () => {
        const get = await operator.req('GET', `/projects/${PROJECT}/workflow-egress`);
        expect(get.statusCode, get.body).toBe(200);
        expect(get.json()).toMatchObject({ project: PROJECT, mode: 'open', hosts: [], updatedAt: null });
        // An operator may read, not change it.
        const op = await operator.req('PUT', `/projects/${PROJECT}/workflow-egress`, {
          mode: 'allowlist',
          hosts: [],
        });
        expect(op.statusCode).toBe(403);
        // Without a fresh step-up an admin is asked for one.
        h.clock.advance(10 * 60_000);
        const stale = await owner.req('PUT', `/projects/${PROJECT}/workflow-egress`, {
          mode: 'open',
          hosts: [],
        });
        expect(stale.statusCode, stale.body).toBe(403);
        expect(stale.json<{ error: string }>().error).toBe('step_up_required');
        for (const bad of [
          '127.0.0.1',
          '2130706433',
          'nas.local',
          'metadata.google.internal',
          '[::1]',
          'intranet',
        ]) {
          await stepUp();
          const res = await owner.req('PUT', `/projects/${PROJECT}/workflow-egress`, {
            mode: 'open',
            hosts: [bad],
          });
          expect(res.statusCode, `${bad}: ${res.body}`).toBe(422);
          expect(res.json<{ error: string }>().error).toBe('invalid_egress');
        }
        await setEgress({ mode: 'open', hosts: [`${HOST}:${String(port)}`] });
        const audit = await h.db.pool.query<{ metadata: { after: { hosts: string[] } } }>(
          "SELECT metadata FROM audit_events WHERE action = 'workflow.egress.update' ORDER BY id DESC LIMIT 1",
        );
        expect(audit.rows[0]?.metadata.after.hosts).toEqual([`${HOST}:${String(port)}`]);
      });
    });

    describe('function jobs', () => {
      it('the catalog lists the 14.3 nodes as executable and counts capable machines', async () => {
        const res = await owner.req('GET', '/workflows/catalog');
        expect(res.statusCode, res.body).toBe(200);
        const c = res.json<{ executable: string[]; functionWorkers: { http: { online: number } } }>();
        expect(c.executable).toEqual(
          expect.arrayContaining(['http.request', 'email.send', 'code.js', 'code.python']),
        );
        expect(c.functionWorkers.http.online).toBe(0);
      });

      it('with no capable worker the job waits in the queue, then the queue timeout routes to the error branch', async () => {
        const id = await define(
          doc(
            'no-worker',
            [
              n('start', 'trigger.manual'),
              n(
                'call',
                'http.request',
                { origin: `http://${HOST}:${String(port)}`, path: '/ping' },
                { queueTimeoutSec: 60 },
              ),
              n('ok', 'data.set', { fields: { ok: true } }),
              n('handled', 'data.set', { fields: { code: '{{ $input.code }}' } }),
            ],
            [
              { from: 'start', to: 'call' },
              { from: 'call', to: 'ok' },
              { from: 'call', fromPort: 'error', to: 'handled' },
            ],
          ),
        );
        const runId = await start(id);
        await expect.poll(async () => (await functionJob(runId, 'call')).length, { timeout: 20_000 }).toBe(1);
        const job = (await functionJob(runId, 'call'))[0];
        expect(job?.spec).toMatchObject({ kind: 'function', function: { type: 'http' } });
        expect(job?.spec.repository).toBeUndefined();
        expect(await last(runId, 'call')).toMatchObject({ state: 'waiting' });
        // Still queued (no function-v1 worker); after the node's queue timeout: cancelled, `no_worker` → error port.
        expect(['QUEUED', 'BLOCKED']).toContain((await functionJob(runId, 'call'))[0]?.state);
        h.clock.advance(61_000);
        await expect.poll(() => runState(runId), { timeout: 20_000 }).toBe('succeeded');
        expect(await last(runId, 'call')).toMatchObject({ state: 'failed', error: { code: 'no_worker' } });
        expect((await last(runId, 'handled'))?.output?.ports?.out).toEqual({ code: 'no_worker' });
        expect((await last(runId, 'ok'))?.state).toBe('skipped');
        await expect
          .poll(async () => (await functionJob(runId, 'call'))[0]?.state, { timeout: 10_000 })
          .toBe('CANCELLED');
      });

      it('the e-mail node builds its message from expressions; server and credential stay static', async () => {
        const id = await define(
          doc(
            'mail',
            [
              n('start', 'trigger.manual'),
              n(
                'send',
                'email.send',
                {
                  smtp: {
                    provider: 'custom',
                    host: 'smtp.mail.example',
                    port: 587,
                    tls: 'starttls',
                    username: 'bot@mail.example',
                    credential: 'wf-smtp-e2e',
                  },
                  from: { address: 'bot@mail.example', name: 'Remyral' },
                  to: '{{ ["a@x.example", "b@x.example"] }}',
                  bcc: 'audit@x.example',
                  subject: 'Run {{ $run.id }}\nBcc: evil@x.example',
                  text: 'Hello',
                },
                { queueTimeoutSec: 600 },
              ),
            ],
            [{ from: 'start', to: 'send' }],
          ),
        );
        const runId = await start(id);
        await expect.poll(async () => (await functionJob(runId, 'send')).length, { timeout: 20_000 }).toBe(1);
        const fn = (await functionJob(runId, 'send'))[0]?.spec.function as Record<string, unknown>;
        expect(fn).toMatchObject({
          type: 'email',
          smtp: { host: 'smtp.mail.example', port: 587, tls: 'starttls', username: 'bot@mail.example' },
          credential: { id: 'wf-smtp-e2e', allowedHosts: ['smtp.mail.example'] },
          message: { to: ['a@x.example', 'b@x.example'], cc: [], bcc: ['audit@x.example'] },
        });
        const message = fn.message as { subject: string; messageId: string };
        // A line break in the subject cannot add a header.
        expect(message.subject).not.toMatch(/[\r\n]/);
        expect(message.messageId).toMatch(/^<wf-[0-9a-f]{64}@remyral\.workflow>$/);
        const c = await owner.req('POST', `/workflows/runs/${runId}/cancel`, { reason: 'test done' });
        expect(c.statusCode, c.body).toBe(200);
      });

      it('save and run refuse targets outside the project allowlist and credentials not bound to the host', async () => {
        await setEgress({ mode: 'allowlist', hosts: ['other.example.test'] });
        await stepUp();
        const refused = await owner.req('POST', '/workflows', {
          project: PROJECT,
          definition: doc(
            'blocked',
            [n('start', 'trigger.manual'), n('call', 'http.request', { origin: `https://${HOST}` })],
            [{ from: 'start', to: 'call' }],
          ),
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json<{ issues: { path: string; code: string }[] }>().issues).toContainEqual({
          path: 'nodes.1.config.origin',
          code: 'egress_not_allowed',
        });
        await setEgress({ mode: 'open', hosts: [`${HOST}:${String(port)}`] });
        await stepUp();
        const unbound = await owner.req('POST', '/workflows', {
          project: PROJECT,
          definition: doc(
            'unbound',
            [
              n('start', 'trigger.manual'),
              n('call', 'http.request', {
                origin: 'https://elsewhere.example.test',
                auth: { credential: CRED },
              }),
            ],
            [{ from: 'start', to: 'call' }],
          ),
        });
        expect(unbound.statusCode).toBe(400);
        expect(unbound.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toContain(
          'credential_host_not_bound',
        );
        // A saved workflow whose host the policy later excludes fails at run time — no job, no request.
        const id = await define(
          doc(
            'later',
            [
              n('start', 'trigger.manual'),
              n('call', 'http.request', { origin: `http://${HOST}:${String(port)}` }),
            ],
            [{ from: 'start', to: 'call' }],
          ),
        );
        await setEgress({ mode: 'allowlist', hosts: ['other.example.test'] });
        const runId = await start(id);
        await expect.poll(() => runState(runId), { timeout: 20_000 }).toBe('failed');
        expect(await last(runId, 'call')).toMatchObject({ error: { code: 'egress_not_allowed' } });
        expect(await functionJob(runId, 'call')).toEqual([]);
        await setEgress({ mode: 'open', hosts: [`${HOST}:${String(port)}`] });
      });

      it('a real function-v1 worker runs the request: credential for its host, redacted echo, output downstream', async () => {
        await startWorker();
        const before = seen.length;
        const id = await define(
          doc(
            'call',
            [
              n('start', 'trigger.manual'),
              n('call', 'http.request', {
                method: 'POST',
                origin: `http://${HOST}:${String(port)}`,
                path: '/items/{{ 6 * 7 }}',
                query: { q: '{{ "a b&c" }}' },
                headers: { 'X-Run': '{{ $run.id }}' },
                body: { type: 'json', value: { $expr: '{"n": 1 + 1}' } },
                auth: { credential: CRED, placement: 'bearer' },
              }),
              n('use', 'data.transform', { expression: { $expr: '$.body.got' } }),
            ],
            [
              { from: 'start', to: 'call' },
              { from: 'call', to: 'use' },
            ],
          ),
        );
        const runId = await start(id);
        await expect.poll(() => runState(runId), { timeout: 60_000 }).toBe('succeeded');
        const req = seen.slice(before).find((s) => s.url.startsWith('/items/'));
        expect(req).toMatchObject({ method: 'POST', url: '/items/42?q=a+b%26c', body: '{"n":2}' });
        expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(req?.headers['idempotency-key']).toMatch(/^wf-[0-9a-f]{64}$/);
        expect(req?.headers['x-run']).toBe(runId);
        const out = (await last(runId, 'call'))?.output?.ports?.out as {
          status: number;
          headers: Record<string, string>;
          body: { echo: string | null };
        };
        expect(out.status).toBe(201);
        // The credential's exact value never comes back, and cookies are never kept.
        expect(JSON.stringify(out)).not.toContain(TOKEN);
        expect(out.headers['set-cookie']).toBeUndefined();
        expect((await last(runId, 'use'))?.output?.ports?.out).toBe('{"n":2}');
        // The job held no AI slot and went to the function-v1 worker.
        const job = (await functionJob(runId, 'call'))[0];
        expect(job?.state).toBe('SUCCEEDED');
        const placed = await h.db.pool.query<{ worker_id: string }>(
          'SELECT worker_id FROM job_attempts WHERE job_id = $1',
          [job?.id],
        );
        expect(placed.rows.map((r) => r.worker_id)).toEqual([workerId]);
      });

      it('a retried PUT sends the same Idempotency-Key; a redirect to the metadata address is refused', async () => {
        const before = seen.length;
        statuses.push(503);
        const id = await define(
          doc(
            'retry',
            [
              n('start', 'trigger.manual'),
              n(
                'put',
                'http.request',
                {
                  method: 'PUT',
                  origin: `http://${HOST}:${String(port)}`,
                  path: '/thing',
                  body: { type: 'text', value: 'x' },
                },
                { retry: { max: 2, initialSec: 0, on: ['http_status'] } },
              ),
              n('hop', 'http.request', {
                origin: `http://${HOST}:${String(port)}`,
                path: '/redirect-to-metadata',
              }),
              n('caught', 'data.set', { fields: { code: '{{ $input.code }}' } }),
            ],
            [
              { from: 'start', to: 'put' },
              { from: 'put', to: 'hop' },
              { from: 'hop', fromPort: 'error', to: 'caught' },
            ],
          ),
        );
        const runId = await start(id);
        await expect.poll(() => runState(runId), { timeout: 90_000 }).toBe('succeeded');
        const puts = seen.slice(before).filter((s) => s.method === 'PUT');
        expect(puts).toHaveLength(2);
        expect(puts[0]?.headers['idempotency-key']).toBe(puts[1]?.headers['idempotency-key']);
        expect((await nodeRuns(runId, 'put')).map((r) => `${String(r.attempt)}:${r.state}`)).toEqual([
          '1:failed',
          '2:succeeded',
        ]);
        expect(await functionJob(runId, 'put')).toHaveLength(2);
        // Only the first hop reached the server; the redirect target (169.254.169.254) was refused by the worker.
        const caught = (await last(runId, 'caught'))?.output?.ports?.out as { code: string };
        expect(['egress_refused', 'redirect_refused']).toContain(caught.code);
        expect(seen.slice(before).filter((s) => s.url === '/redirect-to-metadata')).toHaveLength(1);
      });
    });
  },
);
