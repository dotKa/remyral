import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { createNodeFileOps, FileSecretStore, NodeHttpExecutor, NodeSmtpExecutor } from '@remyral/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p15-chat-vault (docs/design/p15-chat-vault.md) end to end: master ↔ a real assistant worker (scripted fake engine) and
 * a real function-v1 worker. A raw key in a message never reaches the transcript, the model, the audit log or the
 * notifications; `{{credential:NAME}}` tokens become chips and a metadata block (never a value); `@` mentions list
 * credentials for administrators only; `run_http_request` with a credential runs at once on the user's command as a
 * function job on the worker, which attaches the credential for its bound host and redacts its exact value from the
 * echoed response; a "save to vault" card is completed only by the browser (the master refuses to run it).
 */
const PW = 'cobalt-lantern-meadow-58';
const HINT_DB = 12;
const HOST = 'api.example.test';
const TOKEN = 'chat-http-secret-0123456789abcdefXYZ';
const CRED = 'api-token';
const NAME = 'API_TOKEN';
const RAW = 'sk-proj-FAKE-test-only-not-a-real-key-89';

interface Message {
  seq: number;
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  kind: string;
  state: string;
  result: Record<string, unknown> | null;
}
interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
}

describeIntegration(
  'vault credentials in the chat (integration, p15-chat-vault)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    const engine = new FakeAssistantEngine();
    const dirs: string[] = [];
    const seen: Seen[] = [];
    let assistant: RunningWorker | undefined;
    let fn: JobWorker | undefined;
    let owner: Client;
    let secret = '';
    let op: Client;
    let server: Server;
    let port = 0;
    let url = '';

    async function stepUp(): Promise<void> {
      h.clock.advance(31_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }
    async function thread(c: Client): Promise<string> {
      const r = await c.req('POST', '/chat/threads', {});
      expect(r.statusCode, r.body).toBe(201);
      return r.json<{ id: string }>().id;
    }
    async function detail(c: Client, id: string): Promise<{ messages: Message[]; drafts: Draft[] }> {
      const r = await c.req('GET', `/chat/threads/${id}`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    }
    async function ask(
      c: Client,
      id: string,
      text: string,
      extra: Record<string, unknown> = {},
    ): Promise<string> {
      const r = await c.req('POST', `/chat/threads/${id}/messages`, { text, ...extra });
      expect(r.statusCode, r.body).toBe(202);
      const seq = r.json<{ message: Message }>().message.seq;
      let after: Message[] = [];
      await expect
        .poll(
          async () => {
            const d = await c.req('GET', `/chat/threads/${id}`);
            const body = d.json<{ messages: Message[]; turn: unknown }>();
            // The answer and, when a draft failed its checks, the draft-invalid notice after it.
            after = body.messages.filter(
              (m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'),
            );
            return body.turn === null && after.length > 0;
          },
          { timeout: 70_000 },
        )
        .toBe(true);
      return after.map((m) => m.content).join('\n');
    }
    const tool = (name: string, input: Record<string, unknown>) =>
      `[[tool ${name} ${JSON.stringify(input)}]]`;

    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push({ url: req.url ?? '', headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        // Echoes the authorization header: the worker must redact the credential's exact value.
        res.end(JSON.stringify({ ok: true, echo: req.headers.authorization ?? null, path: req.url }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
      await h.start({
        securityPolicy: { preset: 'serbest' },
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: `cv${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
          timing: { leaseTtlMs: 3_600_000, reconnectGraceMs: 60_000, retryBackoffMs: 0 },
        },
      });
      url = await h.listen();
      await h.createUser('owner.vault', PW);
      ({ secret } = await enroll(h, 'owner.vault', PW));
      owner = await fullLogin(h, 'owner.vault', PW, secret);
      const opId = await h.createUser('op.vault', PW, 'operator');
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
      await h.grant(opId, [PROJECT], 'operator');
      const o = await enroll(h, 'op.vault', PW);
      op = await fullLogin(h, 'op.vault', PW, o.secret);
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at, allowed_hosts)
       VALUES ($1, $2, 'http-auth', $2, 1, 'active', now(), now(), $3),
              ('openai-runtime', 'OPENAI_RUNTIME', 'openai', 'OPENAI_API_KEY', 1, 'active', now(), now(), NULL)`,
        [CRED, NAME, [`${HOST}:${String(port)}`]],
      );
    });

    afterAll(async () => {
      await fn?.stop().catch(() => undefined);
      await assistant?.stop().catch(() => undefined);
      await h.stop();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await removeDirs(dirs);
    });

    it('sets up the assistant machine, a function machine holding the credential, and the HTTP list', async () => {
      const aDir = await tempDataDir(dirs);
      await stepUp();
      const assistantId = await pairRealWorker(h, url, owner, secret, aDir);
      assistant = await runRealWorker(url, aDir, {
        capabilities: CAPS,
        assistant: { engine, clock: h.clock.now },
      });
      await stepUp();
      const s = await owner.req('PUT', '/chat/settings', {
        enabled: true,
        workerId: assistantId,
        runtime: 'claude-code',
        modelProfile: null,
        expectedVersion: 1,
      });
      expect(s.statusCode, s.body).toBe(200);
      const fDir = await tempDataDir(dirs);
      await stepUp();
      const fnId = await pairRealWorker(h, url, owner, secret, fDir);
      await new FileSecretStore(createNodeFileOps(), fDir).set(`vault-${CRED}`, TOKEN);
      await h.db.pool.query(
        `INSERT INTO vault_credential_workers (credential_id, worker_id, version, key_id, sealed, sealed_digest, state,
       acked_version, acked_at, ack_outcome, updated_at)
       VALUES ($1, $2, 1, $3, '{"sealed":true}', $4, 'active', 1, now(), 'applied', now())`,
        [CRED, fnId, 'k'.repeat(22), 'd'.repeat(64)],
      );
      const egress = {
        lookup: (host: string) =>
          host === HOST
            ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
            : Promise.reject(new Error('ENOTFOUND')),
        isPublicAddress: (a: string) => a === '127.0.0.1',
      };
      fn = await startJobWorker(url, fDir, {
        fileUrl: await createBareRepo(dirs),
        features: ['function-v1'],
        functions: { http: new NodeHttpExecutor(egress), email: new NodeSmtpExecutor(egress) },
      });
      await expect.poll(() => h.app.fleetSessions.hasReported(fnId), { timeout: 15_000 }).toBe(true);
      await stepUp();
      const e = await owner.req('PUT', `/projects/${PROJECT}/workflow-egress`, {
        mode: 'open',
        hosts: [`${HOST}:${String(port)}`],
      });
      expect(e.statusCode, e.body).toBe(200);
      await expect
        .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
          timeout: 20_000,
        })
        .toBe(true);
    });

    describe('redaction', () => {
      it('a raw key never reaches the transcript, the model, the audit log or the notifications', async () => {
        const t = await thread(owner);
        const reply = await ask(owner, t, `my key is ${RAW} — remember it`);
        expect(reply).not.toContain(RAW);
        const d = await detail(owner, t);
        const user = d.messages.find((m) => m.role === 'user');
        expect(user?.content).toContain('{{secret:removed:openai}}');
        expect(user?.meta?.secretsRemoved).toBe(1);
        const turns = engine.sessions.flatMap((s) => s.turns);
        expect(JSON.stringify(turns)).not.toContain(RAW);
        for (const table of [
          'chat_messages',
          'chat_threads',
          'audit_events',
          'notifications',
          'chat_turns',
        ]) {
          const { rows } = await h.db.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} t WHERE t::text LIKE $1`,
            [`%${RAW}%`],
          );
          expect(rows[0]?.n, table).toBe('0');
        }
      });
    });

    describe('credential references', () => {
      it('a {{credential:NAME}} token becomes a chip and a metadata block — never a value', async () => {
        const t = await thread(owner);
        await ask(owner, t, `use {{credential:${NAME}}} for the API`);
        const user = (await detail(owner, t)).messages.find((m) => m.role === 'user');
        expect(user?.meta?.credentials).toEqual([
          { name: NAME, id: CRED, kind: 'http-auth', allowedHosts: [`${HOST}:${String(port)}`], machines: 1 },
        ]);
        const last = engine.sessions.flatMap((s) => s.turns).at(-1);
        expect(last?.context ?? '').toContain(NAME);
        expect(last?.context ?? '').toContain('run_http_request');
        expect(JSON.stringify(last)).not.toContain(TOKEN);
      });

      it('@ mentions list credentials for administrators only (name and kind, no value)', async () => {
        const a = await owner.req('GET', '/chat/mentions?q=API&type=credential');
        expect(a.statusCode, a.body).toBe(200);
        expect(a.json<{ items: unknown[] }>().items).toEqual([
          {
            type: 'credential',
            id: CRED,
            project: null,
            label: NAME,
            detail: `http-auth · ${HOST}:${String(port)}`,
          },
        ]);
        const b = await op.req('GET', '/chat/mentions?q=API&type=credential');
        expect(b.statusCode, b.body).toBe(200);
        expect(b.json<{ items: unknown[] }>().items).toEqual([]);
        // A mention of a credential is resolved for the sender: the operator's is dropped.
        const t = await thread(op);
        await ask(op, t, `@${NAME} hi`, { mentions: [{ type: 'credential', id: CRED }] });
        const user = (await detail(op, t)).messages.find((m) => m.role === 'user');
        expect(user?.meta?.mentions).toBeUndefined();
      });
    });

    describe('run_http_request', () => {
      it('runs at once with the credential on the function machine; the echoed value is redacted', async () => {
        const t = await thread(owner);
        const before = seen.length;
        const reply = await ask(
          owner,
          t,
          `@${NAME} ile şu endpoint'e istek at ${tool('run_http_request', {
            project: PROJECT,
            url: `http://${HOST}:${String(port)}/v1/status?x=1`,
            credential: NAME,
          })}`,
        );
        expect(reply).toContain('executed');
        expect(reply).toMatch(/"status": ?200/);
        expect(reply).not.toContain(TOKEN);
        const req = seen.slice(before).find((s) => s.url.startsWith('/v1/status'));
        expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const d = (await detail(owner, t)).drafts.find((x) => x.kind === 'http_request');
        expect(d?.state).toBe('confirmed');
        const jobId = String(d?.result?.jobId);
        const job = await h.db.pool.query<{ spec: unknown; state: string }>(
          'SELECT spec, state::text AS state FROM jobs WHERE id = $1',
          [jobId],
        );
        expect(job.rows[0]?.state).toBe('SUCCEEDED');
        expect(JSON.stringify(job.rows[0]?.spec)).not.toContain(TOKEN);
        for (const table of ['chat_messages', 'chat_drafts', 'audit_events', 'job_artifacts', 'jobs']) {
          const { rows } = await h.db.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} t WHERE t::text LIKE $1`,
            [`%${TOKEN}%`],
          );
          expect(rows[0]?.n, table).toBe('0');
        }
        // http_request_result reads it again (only the caller's own chat requests).
        const again = await ask(owner, t, tool('http_request_result', { jobId }));
        expect(again).toMatch(/"status": ?200/);
        const other = await ask(op, await thread(op), tool('http_request_result', { jobId }));
        expect(other).toContain('refused');
      });

      it('refuses runtime-kind credentials, unbound hosts, credentials for non-admins and secrets in headers', async () => {
        const t = await thread(owner);
        const kind = await ask(
          owner,
          t,
          tool('run_http_request', {
            project: PROJECT,
            url: `http://${HOST}:${String(port)}/`,
            credential: 'OPENAI_RUNTIME',
          }),
        );
        expect(kind).toContain('refused');
        expect(kind).toContain('http-auth');
        const host = await ask(
          owner,
          t,
          tool('run_http_request', { project: PROJECT, url: 'https://api.other.test/x', credential: NAME }),
        );
        expect(host).toContain('credential_host_not_bound');
        const header = await ask(
          owner,
          t,
          tool('run_http_request', {
            project: PROJECT,
            url: `http://${HOST}:${String(port)}/`,
            headers: { Authorization: 'Bearer x' },
          }),
        );
        expect(header).toContain('refused');
        const o = await ask(
          op,
          await thread(op),
          tool('run_http_request', {
            project: PROJECT,
            url: `http://${HOST}:${String(port)}/`,
            credential: NAME,
          }),
        );
        expect(o).toContain('administrators');
      });
    });

    describe('save to vault', () => {
      it('the card is completed by the browser only; the master links it to the created credential', async () => {
        const t = await thread(owner);
        // The model proposes the card (a user message never carries tool input; the master scrubs `secret: …` there).
        engine.script(/bunu kasaya kaydet/, async ({ call }) => {
          const r = await call('propose_credential_save', {
            secret: 'pasted-1',
            name: 'OPENAI_API_KEY',
            kind: 'http-auth',
            allowedHosts: ['api.openai.com'],
          });
          return `Tool propose_credential_save: ${r.content}`;
        });
        const reply = await ask(owner, t, 'bunu kasaya kaydet {{secret:pasted-1:openai}}');
        expect(reply).toContain('NOT executed');
        const d = (await detail(owner, t)).drafts.find((x) => x.kind === 'credential_save');
        expect(d?.state).toBe('proposed');
        // Confirming it on the master is refused: only the browser can seal.
        const c = await owner.req('POST', `/chat/drafts/${String(d?.id)}/confirm`, {});
        expect(c.statusCode, c.body).toBe(409);
        // The browser created the credential (POST /vault/credentials, sealed there) and links it.
        const { rows } = await h.db.pool.query<{ id: string }>(
          "SELECT id::text AS id FROM users WHERE username = 'owner.vault'",
        );
        await h.db.pool.query(
          `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, created_by, updated_at, allowed_hosts)
         VALUES ('openai-api-key', 'OPENAI_API_KEY', 'http-auth', 'OPENAI_API_KEY', 1, 'active', now(), $1, now(), '{api.openai.com}')`,
          [rows[0]?.id],
        );
        const bad = await op.req('POST', `/chat/drafts/${String(d?.id)}/credential-saved`, {
          credentialId: 'openai-api-key',
        });
        expect(bad.statusCode).toBe(403);
        const ok = await owner.req('POST', `/chat/drafts/${String(d?.id)}/credential-saved`, {
          credentialId: 'openai-api-key',
        });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(ok.json<{ draft: Draft }>().draft.state).toBe('confirmed');
        const again = await owner.req('POST', `/chat/drafts/${String(d?.id)}/credential-saved`, {
          credentialId: 'openai-api-key',
        });
        expect(again.statusCode).toBe(409);
        const note = (await detail(owner, t)).messages.at(-1);
        expect(note?.content).toContain('{{credential:OPENAI_API_KEY}}');
      });
    });
  },
);
