import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { fileURLToPath } from 'node:url';
import { parseWebhookEnvelope, type WebhookEnvelope } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { createWebhookSender, type WebhookSender } from '../../src/webhooks-out/sender.js';
import { WebhookService } from '../../src/webhooks-out/service.js';
import { verifySignature } from '../../src/webhooks-out/signing.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md) against the real master (Postgres + Redis) and a local HTTPS
 * receiver: signatures (and the rotation overlap), retries on the fake clock with a stable delivery id, auto-disable
 * with the admins' notification, the egress floor (private / loopback / metadata refused; the owner's internal
 * targets), one sender per delivery across two masters (and the fenced claim), redelivery, the test button, and the
 * events of a job lifecycle and of an automation's deploy.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'hooks-p';
const OTHER = 'hooks-q';
const fixtures = fileURLToPath(new URL('../fixtures/tls/', import.meta.url));
const CERT = readFileSync(`${fixtures}test-only-localhost.cert.pem`);
const KEY = readFileSync(`${fixtures}test-only-localhost.key.pem`);

interface Received {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly envelope: WebhookEnvelope;
}

/** A local HTTPS receiver: records every request and answers with the status `respond()` picks. */
class Receiver {
  readonly got: Received[] = [];
  respond: (r: Received) => number = () => 200;
  delayMs = 0;
  #server: Server | null = null;
  origin = '';

  async start(): Promise<void> {
    this.#server = createServer({ key: KEY, cert: CERT }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const r: Received = {
          path: req.url ?? '/',
          headers,
          body,
          envelope: JSON.parse(body) as WebhookEnvelope,
        };
        this.got.push(r);
        const answer = (): void => {
          res.writeHead(this.respond(r), { 'content-type': 'text/plain' });
          res.end('ok token=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
        };
        if (this.delayMs > 0) setTimeout(answer, this.delayMs);
        else answer();
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const a = this.#server.address();
    this.origin = `https://127.0.0.1:${String(typeof a === 'object' && a !== null ? a.port : 0)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server?.close(() => {
        resolve();
      }),
    );
  }

  of(path: string): Received[] {
    return this.got.filter((g) => g.path === path);
  }

  clear(): void {
    this.got.length = 0;
  }
}

interface Hook {
  id: string;
  state: string;
  consecutiveFailures: number;
  secretRevealed: boolean;
  previousValidUntil: string | null;
  headers: { name: string; value: string | null; secret: boolean }[];
}

describeIntegration('outgoing webhooks (integration, p16-webhooks-out)', { timeout: 180_000 }, () => {
  const rx = new Receiver();
  const coolify = new FakeCoolify();
  let h: Harness;
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let jobs: JobStore;
  let sender: WebhookSender;
  const now = (): number => Math.floor(h.clock.now().getTime() / 1000);

  const stepUp = async (): Promise<void> => {
    h.clock.advance(30_000);
    const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(r.statusCode, r.body).toBe(200);
  };
  const relogin = async (): Promise<void> => {
    owner = await fullLogin(h, 'wh-owner', PW, ownerSecret);
  };

  async function createHook(
    body: Record<string, unknown>,
  ): Promise<{ webhook: Hook; secret: string; status: number; raw: string }> {
    await stepUp();
    const r = await owner.req('POST', '/webhooks', body);
    const j = r.statusCode === 201 ? r.json<{ webhook: Hook; secret: string }>() : null;
    return {
      webhook: j?.webhook ?? ({} as Hook),
      secret: j?.secret ?? '',
      status: r.statusCode,
      raw: r.body,
    };
  }

  const spec = (n: string) => ({
    runtime: 'codex',
    prompt: 'Summarise the README.\n\nThen list the internal migration plan in section two, with every step.',
    repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: `rac/wh-${n}` },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 3600 },
  });
  const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

  async function runJob(
    project: string,
    outcome: 'succeed' | 'fail',
    reason = 'tests failed',
  ): Promise<string> {
    const { job } = await jobs.create({
      project,
      actor: CREATOR,
      submit: true,
      spec: spec(randomUUID().slice(0, 6)),
    });
    const grant = await jobs.acquireLease(job.id, 'worker-1', 3_600_000);
    const actor: JobActor = { type: 'worker', id: 'worker-1' };
    await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
    await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
    if (outcome === 'fail') {
      await jobs.transition(job.id, 'attempt_failed', { actor, epoch: grant.lease.epoch, reason });
    } else {
      await jobs.transition(job.id, 'run_finished', { actor, epoch: grant.lease.epoch });
      await jobs.transition(job.id, 'verification_passed_no_approval', {
        actor: { type: 'system', id: null },
        epoch: grant.lease.epoch,
      });
    }
    return job.id;
  }

  beforeAll(async () => {
    await rx.start();
    await coolify.start();
    sender = createWebhookSender({ ca: CERT });
    h = new Harness();
    await h.start({
      ops: { internalOrigins: [coolify.base] },
      notifications: { publicUrl: 'https://remyral.example.com' },
      // No jitter (random 0.5 → factor 1); auto-disable after 3 failed attempts in a row.
      webhooksOut: { sender, random: () => 0.5, options: { autoDisableAfter: 3 } },
    });
    ownerId = await h.createUser('wh-owner', PW, 'owner');
    ({ secret: ownerSecret } = await enroll(h, 'wh-owner', PW));
    owner = await fullLogin(h, 'wh-owner', PW, ownerSecret);
    await h.createUser('wh-admin', PW, 'admin');
    for (const p of [PROJECT, OTHER])
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [p]);
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
    await rx.stop();
    await coolify.stop();
  });

  // ------------------------------------------------------------------------------------------------ egress floor

  describe('targets', () => {
    it('refuses http, loopback, private, link-local / metadata, internal names and odd ports', async () => {
      for (const url of [
        'http://hooks.example.com/x',
        'https://127.0.0.1/x',
        'https://10.1.2.3/x',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/x',
        'https://metadata.google.internal/x',
        'https://localhost/x',
        'https://printer.lan/x',
        `${rx.origin}/x`,
        'https://hooks.example.com:9000/x',
        'https://user:pw@hooks.example.com/x',
      ]) {
        const r = await createHook({ name: 'bad', url, eventTypes: ['job.failed'] });
        expect(r.status, `${url}: ${r.raw}`).toBe(422);
        expect(r.raw).toContain('invalid_webhook');
      }
      const unknown = await createHook({
        name: 'x',
        url: 'https://hooks.example.com/x',
        eventTypes: ['job.exploded'],
      });
      expect(unknown.status).toBe(422);
    });

    it('a credential header must be secret; a reserved header is refused', async () => {
      const plain = await createHook({
        name: 'h',
        url: 'https://hooks.example.com/x',
        eventTypes: ['job.failed'],
        headers: [{ name: 'Authorization', value: 'Bearer abc' }],
      });
      expect(plain.status).toBe(422);
      expect(plain.raw).toContain('credential_must_be_secret');
      const reserved = await createHook({
        name: 'h',
        url: 'https://hooks.example.com/x',
        eventTypes: ['job.failed'],
        headers: [{ name: 'X-Remyral-Delivery', value: 'x' }],
      });
      expect(reserved.status).toBe(422);
    });

    it('the sender refuses a host that resolves to a non-public address (checked at connect time)', async () => {
      const res = await sender({
        url: `https://localhost:${rx.origin.split(':').pop() ?? '0'}/x`,
        headers: {},
        body: '{}',
        internal: false,
      });
      expect(res.error).toBe('address_refused');
      expect(rx.got).toHaveLength(0);
    });

    it('only an owner sets internal targets (exact https origins, audited); then the receiver is allowed', async () => {
      await stepUp();
      const bad = await owner.req('PUT', '/webhooks/settings', { internalOrigins: [`${rx.origin}/path`] });
      expect(bad.statusCode).toBe(422);
      const ok = await owner.req('PUT', '/webhooks/settings', { internalOrigins: [rx.origin] });
      expect(ok.statusCode, ok.body).toBe(200);
      const { rows } = await h.db.pool.query<{ metadata: { after: string[] } }>(
        "SELECT metadata FROM audit_events WHERE action = 'webhook.settings.update'",
      );
      expect(rows[0]?.metadata.after).toEqual([rx.origin]);
      const admin = await fullLogin(h, 'wh-admin', PW, (await enroll(h, 'wh-admin', PW)).secret);
      const denied = await admin.req('PUT', '/webhooks/settings', { internalOrigins: [] });
      expect(denied.statusCode).toBe(403);
      await relogin();
    });
  });

  // ------------------------------------------------------------------------------------------------ jobs + signature

  describe('a job lifecycle', () => {
    let hookId = '';
    let secret = '';

    it('creates a project webhook; the secret is shown once and stored sealed', async () => {
      const r = await createHook({
        name: 'jobs',
        url: `${rx.origin}/jobs`,
        project: PROJECT,
        eventTypes: ['job.created', 'job.started', 'job.succeeded', 'job.failed'],
        headers: [
          { name: 'X-Team', value: 'ops' },
          { name: 'Authorization', value: 'Bearer s3cr3t-receiver-token', secret: true },
        ],
      });
      expect(r.status, r.raw).toBe(201);
      hookId = r.webhook.id;
      secret = r.secret;
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(r.webhook.headers).toEqual([
        { name: 'X-Team', value: 'ops', secret: false, hint: null },
        expect.objectContaining({ name: 'Authorization', value: null, secret: true }),
      ]);
      const list = await owner.req('GET', '/webhooks');
      expect(list.body).not.toContain(secret);
      expect(list.body).not.toContain('s3cr3t-receiver-token');
      const { rows } = await h.db.pool.query<{ row: string }>(
        'SELECT row_to_json(s)::text AS row FROM webhook_subscriptions s WHERE id = $1',
        [hookId],
      );
      expect(rows[0]?.row).not.toContain(secret.slice(6));
      expect(rows[0]?.row).not.toContain('s3cr3t-receiver-token');
      const again = await owner.req('POST', `/webhooks/${hookId}/secret`);
      expect(again.statusCode).toBe(409);
    });

    it('delivers job.created → job.started → job.succeeded, signed, with links and no prompt', async () => {
      rx.clear();
      const jobId = await runJob(PROJECT, 'succeed');
      await runJob(OTHER, 'succeed'); // another project: not for this webhook
      await h.app.webhooksOut.runOnce();
      const got = rx.of('/jobs');
      expect(got.map((g) => g.envelope.type)).toEqual(['job.created', 'job.started', 'job.succeeded']);
      for (const g of got) {
        expect(parseWebhookEnvelope(g.envelope).ok).toBe(true);
        expect(verifySignature(secret, g.headers['x-remyral-signature'] ?? '', g.body, now())).toBe(true);
        expect(verifySignature(secret, g.headers['x-remyral-signature'] ?? '', `${g.body} `, now())).toBe(
          false,
        );
        expect(g.headers['x-remyral-event']).toBe(g.envelope.type);
        expect(g.headers['x-remyral-event-id']).toBe(g.envelope.id);
        expect(g.headers['x-remyral-attempt']).toBe('1');
        expect(g.headers['x-team']).toBe('ops');
        expect(g.headers.authorization).toBe('Bearer s3cr3t-receiver-token');
        // The job's short title (p15-job-titles), never its prompt.
        expect(g.body).not.toContain('internal migration plan');
        expect(g.envelope.project).toBe(PROJECT);
      }
      const done = got[2]?.envelope.data as { job: { id: string; link: string; state: string } };
      expect(done.job).toMatchObject({
        id: jobId,
        state: 'SUCCEEDED',
        link: `https://remyral.example.com/jobs/${jobId}`,
      });
      // A replayed request (old timestamp) does not verify.
      const first = got[0];
      expect(
        verifySignature(secret, first?.headers['x-remyral-signature'] ?? '', first?.body ?? '', now() + 3600),
      ).toBe(false);
      // Nothing more on the next pass (each event once).
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/jobs')).toHaveLength(3);
    });

    it('a failure reason is only in a webhook that includes details, redacted', async () => {
      const detailed = await createHook({
        name: 'details',
        url: `${rx.origin}/details`,
        eventTypes: ['job.failed'],
        includeDetails: true,
      });
      expect(detailed.status, detailed.raw).toBe(201);
      rx.clear();
      await runJob(PROJECT, 'fail', 'push failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
      await h.app.webhooksOut.runOnce();
      const plain = rx.of('/jobs').find((g) => g.envelope.type === 'job.failed');
      const rich = rx.of('/details').find((g) => g.envelope.type === 'job.failed');
      expect(plain?.envelope.data.reason).toBeUndefined();
      expect(String(rich?.envelope.data.reason)).toContain('push failed');
      expect(rich?.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
      // Same event, same id for both webhooks; different deliveries.
      expect(rich?.envelope.id).toBe(plain?.envelope.id);
      expect(rich?.headers['x-remyral-delivery']).not.toBe(plain?.headers['x-remyral-delivery']);
      await stepUp();
      expect((await owner.req('DELETE', `/webhooks/${detailed.webhook.id}`)).statusCode).toBe(200);
    });

    it('rotation: both secrets sign during the overlap, then only the new one', async () => {
      await stepUp();
      const rot = await owner.req('POST', `/webhooks/${hookId}/rotate`, { overlapHours: 1 });
      expect(rot.statusCode, rot.body).toBe(200);
      const next = rot.json<{ secret: string; webhook: Hook }>();
      expect(next.webhook.previousValidUntil).not.toBeNull();
      rx.clear();
      await runJob(PROJECT, 'succeed');
      await h.app.webhooksOut.runOnce();
      const during = rx.of('/jobs')[0];
      const sig = during?.headers['x-remyral-signature'] ?? '';
      expect(sig.match(/v1=/g)).toHaveLength(2);
      expect(verifySignature(secret, sig, during?.body ?? '', now())).toBe(true);
      expect(verifySignature(next.secret, sig, during?.body ?? '', now())).toBe(true);
      h.clock.advance(3_600_000 + 60_000);
      await relogin();
      rx.clear();
      await runJob(PROJECT, 'succeed');
      await h.app.webhooksOut.runOnce();
      const after = rx.of('/jobs')[0];
      const sig2 = after?.headers['x-remyral-signature'] ?? '';
      expect(sig2.match(/v1=/g)).toHaveLength(1);
      expect(verifySignature(secret, sig2, after?.body ?? '', now())).toBe(false);
      expect(verifySignature(next.secret, sig2, after?.body ?? '', now())).toBe(true);
      secret = next.secret;
    });

    it('the test button sends webhook.test at once (one attempt) and returns it', async () => {
      rx.clear();
      const t = await owner.req('POST', `/webhooks/${hookId}/test`);
      expect(t.statusCode, t.body).toBe(200);
      const body = t.json<{
        delivery: { status: string; test: boolean };
        attempts: { statusCode: number }[];
      }>();
      expect(body.delivery).toMatchObject({ status: 'succeeded', test: true });
      expect(body.attempts[0]?.statusCode).toBe(200);
      expect(rx.of('/jobs')[0]?.envelope.type).toBe('webhook.test');
    });

    it('pause stops queueing; resume needs the policy step and picks up new events only', async () => {
      expect((await owner.req('POST', `/webhooks/${hookId}/pause`)).statusCode).toBe(200);
      rx.clear();
      await runJob(PROJECT, 'succeed');
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/jobs')).toHaveLength(0);
      await stepUp();
      const res = await owner.req('POST', `/webhooks/${hookId}/resume`);
      expect(res.json<{ webhook: Hook }>().webhook.state).toBe('active');
      await runJob(PROJECT, 'succeed');
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/jobs').map((g) => g.envelope.type)).toEqual([
        'job.created',
        'job.started',
        'job.succeeded',
      ]);
    });
  });

  // ------------------------------------------------------------------------------------------------ retries

  describe('retries, idempotency, auto-disable, redelivery', () => {
    let hookId = '';

    it('retries with backoff on the fake clock; the delivery id is the same on every attempt', async () => {
      const r = await createHook({
        name: 'retry',
        url: `${rx.origin}/retry`,
        eventTypes: ['job.failed'],
      });
      expect(r.status, r.raw).toBe(201);
      hookId = r.webhook.id;
      rx.clear();
      let failing = true;
      rx.respond = (g) => (g.path === '/retry' && failing ? 503 : 200);
      await runJob(PROJECT, 'fail');
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(1);
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(1); // not due yet (1 minute)
      h.clock.advance(59_000);
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(1);
      h.clock.advance(2_000);
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(2);
      h.clock.advance(5 * 60_000 + 1_000);
      failing = false;
      await h.app.webhooksOut.runOnce();
      const all = rx.of('/retry');
      expect(all).toHaveLength(3);
      expect(new Set(all.map((g) => g.headers['x-remyral-delivery'])).size).toBe(1);
      expect(all.map((g) => g.headers['x-remyral-attempt'])).toEqual(['1', '2', '3']);
      expect(new Set(all.map((g) => g.body)).size).toBe(1);
      const deliveryId = all[0]?.headers['x-remyral-delivery'] ?? '';
      const d = await owner.req('GET', `/webhooks/${hookId}/deliveries/${deliveryId}`);
      expect(d.statusCode, d.body).toBe(200);
      const detail = d.json<{
        delivery: { status: string; attempts: number };
        attempts: { statusCode: number; error: string | null; responseExcerpt: string | null }[];
      }>();
      expect(detail.delivery).toMatchObject({ status: 'succeeded', attempts: 3 });
      expect(detail.attempts.map((a) => a.error)).toEqual(['http_503', 'http_503', null]);
      // The response excerpt is redacted.
      expect(detail.attempts[0]?.responseExcerpt).toContain('ok');
      expect(JSON.stringify(detail.attempts)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
      const w = (await owner.req('GET', `/webhooks/${hookId}`)).json<{ webhook: Hook }>().webhook;
      expect(w.consecutiveFailures).toBe(0);
    });

    it('redelivery sends the same delivery again (same id, next attempt number)', async () => {
      const list = (await owner.req('GET', `/webhooks/${hookId}/deliveries`)).json<{
        items: { id: string; status: string }[];
      }>();
      const target = list.items.find((i) => i.status === 'succeeded');
      rx.clear();
      const res = await owner.req('POST', `/webhooks/${hookId}/deliveries/${target?.id ?? ''}/redeliver`);
      expect(res.statusCode, res.body).toBe(200);
      const twice = await owner.req('POST', `/webhooks/${hookId}/deliveries/${target?.id ?? ''}/redeliver`);
      expect(twice.statusCode).toBe(409);
      await h.app.webhooksOut.runOnce();
      const got = rx.of('/retry');
      expect(got).toHaveLength(1);
      expect(got[0]?.headers['x-remyral-delivery']).toBe(target?.id);
      expect(got[0]?.headers['x-remyral-attempt']).toBe('4');
    });

    it('is turned off after 3 failed attempts in a row; admins are told; resume continues', async () => {
      rx.clear();
      rx.respond = (g) => (g.path === '/retry' ? 500 : 200);
      await runJob(PROJECT, 'fail');
      await runJob(PROJECT, 'fail');
      await runJob(PROJECT, 'fail');
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(3);
      const w = (await owner.req('GET', `/webhooks/${hookId}`)).json<{ webhook: Hook }>().webhook;
      expect(w).toMatchObject({ state: 'disabled', consecutiveFailures: 3 });
      const { rows } = await h.db.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM notifications WHERE kind = 'webhook.disabled'",
      );
      expect(Number(rows[0]?.n)).toBe(2); // the owner and the admin
      const audit = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'webhook.disabled'");
      expect(audit.rowCount).toBe(1);
      // Disabled: due retries are not sent.
      h.clock.advance(61_000);
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(3);
      rx.respond = () => 200;
      await stepUp();
      expect((await owner.req('POST', `/webhooks/${hookId}/resume`)).statusCode).toBe(200);
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(6);
      const after = (await owner.req('GET', `/webhooks/${hookId}`)).json<{ webhook: Hook }>().webhook;
      expect(after).toMatchObject({ state: 'active', consecutiveFailures: 0 });
    });

    it('a target that is no longer allowed is refused at send time', async () => {
      await stepUp();
      expect((await owner.req('PUT', '/webhooks/settings', { internalOrigins: [] })).statusCode).toBe(200);
      rx.clear();
      await runJob(PROJECT, 'fail');
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(0);
      const items = (await owner.req('GET', `/webhooks/${hookId}/deliveries?status=pending`)).json<{
        items: { lastError: string | null }[];
      }>().items;
      expect(items[0]?.lastError).toBe('target_refused');
      await stepUp();
      expect(
        (await owner.req('PUT', '/webhooks/settings', { internalOrigins: [rx.origin] })).statusCode,
      ).toBe(200);
      h.clock.advance(61_000);
      await h.app.webhooksOut.runOnce();
      expect(rx.of('/retry')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ multi-master

  describe('several masters', () => {
    it('two masters claim disjoint deliveries: each is sent exactly once', async () => {
      const r = await createHook({ name: 'mm', url: `${rx.origin}/mm`, eventTypes: ['job.created'] });
      expect(r.status, r.raw).toBe(201);
      const master = (): WebhookService =>
        new WebhookService({
          pool: h.db.pool,
          audit: new AuditLog(h.db.pool, h.clock.now),
          clock: h.clock.now,
          sealKey: h.box.deriveKey('webhooks-out'),
          sender,
          publicUrl: null,
          notifications: () => null,
          options: { deliverBatch: 3 },
        });
      const a = master();
      const b = master();
      rx.clear();
      rx.delayMs = 30;
      for (let i = 0; i < 12; i++)
        await jobs.create({ project: PROJECT, actor: CREATOR, submit: true, spec: spec(`mm${String(i)}`) });
      await h.app.webhooksOut.consume();
      for (let round = 0; round < 6; round++)
        await Promise.all([a.deliverDue(), b.deliverDue(), a.deliverDue(), b.deliverDue()]);
      rx.delayMs = 0;
      const ids = rx.of('/mm').map((g) => g.headers['x-remyral-delivery']);
      expect(ids).toHaveLength(12);
      expect(new Set(ids).size).toBe(12);
    });

    it('a sender whose lease ran out cannot overwrite the newer attempt (fenced)', async () => {
      let release: () => void = () => undefined;
      const stuck: WebhookSender = () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ status: 500, error: null, latencyMs: 1, body: null });
          };
        });
      const slow = new WebhookService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        sealKey: h.box.deriveKey('webhooks-out'),
        sender: stuck,
        publicUrl: null,
        notifications: () => null,
      });
      rx.clear();
      await jobs.create({ project: PROJECT, actor: CREATOR, submit: true, spec: spec('fence') });
      await h.app.webhooksOut.consume();
      const pending = slow.deliverDue();
      await new Promise((r) => setTimeout(r, 200));
      h.clock.advance(61_000); // past the 60 s lease
      await h.app.webhooksOut.deliverDue();
      expect(rx.of('/mm')).toHaveLength(1);
      release();
      await pending;
      const { rows } = await h.db.pool.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM webhook_deliveries WHERE event_type = 'job.created' ORDER BY seq DESC LIMIT 1",
      );
      expect(rows[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    });
  });

  // ------------------------------------------------------------------------------------------------ deploys

  describe('an automation deploy', () => {
    it('emits automation.run.started, deploy.started, deploy.succeeded and automation.run.succeeded', async () => {
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
           require_ci, ci_timeout_sec, updated_by, updated_at)
         VALUES ($1, 1, 'git', 'https://github.com/acme/hooks.git', 'main', 'merge', false, 3600, $2, now())`,
        [PROJECT, ownerId],
      );
      coolify.addApp({ uuid: 'hooksprev1', name: 'hooks-preview' });
      await stepUp();
      expect(
        (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
          .statusCode,
      ).toBe(200);
      const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: { coolify: { preview: { uuids: ['hooksprev1'] } } },
      });
      expect(t.statusCode, t.body).toBe(200);
      const hook = await createHook({
        name: 'deploys',
        url: `${rx.origin}/deploys`,
        project: PROJECT,
        eventTypes: [
          'deploy.started',
          'deploy.succeeded',
          'deploy.failed',
          'automation.run.started',
          'automation.run.succeeded',
        ],
      });
      expect(hook.status, hook.raw).toBe(201);
      await stepUp();
      const created = await owner.req('POST', '/automations', {
        project: PROJECT,
        name: 'nightly deploy',
        trigger: { kind: 'cron', cron: '0 3 * * *' },
        target: { kind: 'deploy', action: 'coolify.deploy', params: { env: 'preview' } },
      });
      expect(created.statusCode, created.body).toBe(201);
      const automationId = created.json<{ automation: { id: string } }>().automation.id;
      await stepUp();
      expect((await owner.req('POST', `/automations/${automationId}/run`)).statusCode).toBeLessThan(300);
      for (const d of coolify.deployments.values()) d.status = 'finished';
      h.clock.advance(20_000);
      expect(await h.app.ops.pollDeploying()).toBe(1);
      await h.app.automations.syncRuns();
      rx.clear();
      await h.app.webhooksOut.runOnce();
      const types = rx.of('/deploys').map((g) => g.envelope.type);
      expect(types).toEqual([
        'deploy.started',
        'automation.run.started',
        'deploy.succeeded',
        'automation.run.succeeded',
      ]);
      const ok = rx.of('/deploys').find((g) => g.envelope.type === 'deploy.succeeded');
      expect(parseWebhookEnvelope(ok?.envelope).ok).toBe(true);
      expect(ok?.envelope.data.deploy).toMatchObject({
        kind: 'coolify.deploy',
        env: 'preview',
        project: PROJECT,
        state: 'succeeded',
        target: 'hooks-preview',
        via: 'automation',
      });
      expect(ok?.body).not.toContain(coolify.token);
    });
  });

  it('documents the catalog in /openapi.json (webhooks) and on GET /webhooks/catalog', async () => {
    const doc = (await owner.req('GET', '/openapi.json')).json<{ webhooks: Record<string, unknown> }>();
    expect(Object.keys(doc.webhooks)).toContain('deploy.succeeded');
    const cat = (await owner.req('GET', '/webhooks/catalog')).json<{ events: { type: string }[] }>();
    expect(cat.events.length).toBeGreaterThan(20);
  });
});
