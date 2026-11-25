import { createServer, type Server } from 'node:http';
import { PROTOCOL_VERSION } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import { RedisRateLimiter } from '../../src/auth/rate-limit.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { NotificationService, SmtpNotifier, WebhookNotifier } from '../../src/notifications/index.js';
import { SIGNATURE_HEADER, verifyWebhookSignature } from '../../src/notifications/webhook.js';
import { UsageStore } from '../../src/usage/index.js';
import { PgDeviceDirectory } from '../../src/workers/directory.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeSmtpServer, mailText, TEST_CERT } from '../helpers/fake-smtp.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { FACTS, TestKey } from '../helpers/raw-worker.js';

/**
 * p5-notifications: every producer notifies exactly the users the authorization model allows (project
 * scoping, decider roles, disabled accounts), the REST API only exposes one's own notifications, outbound
 * channels deliver signed webhooks and TLS e-mail through the retrying queue with a dead letter, and no
 * secret reaches a notification, a channel or the logs.
 */
const PW = 'quartz-meadow-lantern-7';
const ALPHA = 'alpha';
const BETA = 'beta';
const HOUR = 3_600_000;
const SECRET_IN_SUMMARY = `ghp_${'Zx9Qw8Er7Ty6'.repeat(3)}`;
const WEBHOOK_SECRET = Buffer.from('notification-webhook-test-secret-0123456789', 'utf8');
const SMTP_PASSWORD = 'CANARY-smtp-pass-73b1';
const WORKER = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Person {
  readonly id: string;
  readonly username: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let jobs: JobStore;
let approvals: ApprovalService;
let usage: UsageStore;
let svc: NotificationService;
let smtp: FakeSmtpServer;
let hook: Server;
let hookBase = '';
let hookStatus: number[] = [];
const hookRequests: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
const p = {} as Record<'owner' | 'admin' | 'opA' | 'viewerA' | 'opB' | 'disabledA', Person>;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { client, secret } = await enroll(h, username, PW);
  return { id, username, secret, client };
}

/** Fresh sessions for everyone (tests move the clock past the 30-minute idle timeout). */
async function relogin(): Promise<void> {
  for (const key of ['owner', 'admin', 'opA', 'viewerA', 'opB'] as const) {
    p[key].client = await fullLogin(h, p[key].username, PW, p[key].secret);
  }
}

async function stepUp(x: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await x.client.req('POST', '/auth/step-up', { code: h.code(x.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

/** Notifications of `kind` grouped by recipient id. */
async function recipientsOf(kind: string, dedupePrefix = ''): Promise<string[]> {
  const { rows } = await h.db.pool.query<{ recipient_id: string }>(
    `SELECT recipient_id FROM notifications WHERE kind = $1 AND dedupe_key LIKE $2 || '%' ORDER BY recipient_id`,
    [kind, dedupePrefix],
  );
  return rows.map((r) => r.recipient_id);
}

function sorted(...ids: string[]): string[] {
  return [...ids].sort();
}

async function runningJob(project: string, workerId = 'worker-1', ttlMs = HOUR) {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt: `Deploy with token ${SECRET_IN_SUMMARY}`,
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/notify' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, workerId, ttlMs);
  const actor: JobActor = { type: 'worker', id: workerId };
  const epoch = grant.lease.epoch;
  await jobs.transition(job.id, 'lease_acked', { actor, epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch });
  return { jobId: job.id, attemptId: grant.attempt.id, epoch, actor };
}

describeIntegration('notifications (integration)', () => {
  beforeAll(async () => {
    smtp = new FakeSmtpServer({ mode: 'starttls' });
    const smtpPort = await smtp.start();
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        hookRequests.push({ headers: req.headers, body });
        res.writeHead(hookStatus.shift() ?? 204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const address = hook.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    hookBase = `http://127.0.0.1:${String(address.port)}`;

    h = new Harness();
    const clock = h.clock.now;
    await h.start({
      notifications: {
        publicUrl: 'https://remyral.example.com',
        options: { backoffBaseMs: 1_000, maxAttempts: 3, settleMs: 60_000 },
        notifiers: [
          new SmtpNotifier(
            {
              host: '127.0.0.1',
              port: smtpPort,
              security: 'starttls',
              from: 'remyral@example.com',
              username: 'mailer',
              password: SMTP_PASSWORD,
              ca: TEST_CERT,
            },
            clock,
          ),
          new WebhookNotifier(
            { allowlist: [`${hookBase}/hooks/`], secret: WEBHOOK_SECRET, allowInsecureHttp: true },
            clock,
          ),
        ],
      },
    });
    svc = h.app.notifications;
    const audit = new AuditLog(h.db.pool, clock);
    jobs = new JobStore({ pool: h.db.pool, audit, clock });
    approvals = new ApprovalService({ pool: h.db.pool, audit, jobs, clock });
    usage = new UsageStore({ pool: h.db.pool, audit, clock });

    p.owner = await person('owner', 'owner', []);
    p.admin = await person('admin', 'admin', []);
    p.opA = await person('op.alpha', 'operator', [ALPHA]);
    p.viewerA = await person('viewer.alpha', 'viewer', [ALPHA]);
    p.opB = await person('op.beta', 'operator', [BETA]);
    p.disabledA = await person('gone.alpha', 'operator', [ALPHA]);
    await h.db.pool.query('UPDATE users SET disabled_at = $2 WHERE id = $1', [p.disabledA.id, h.clock.now()]);
  });

  afterAll(async () => {
    await h.stop();
    await smtp.stop();
    await new Promise<void>((resolve) => {
      hook.close(() => {
        resolve();
      });
    });
  });

  describe('producers and recipients', () => {
    it('job failed: operators of the project and owner/admin; not viewers, other projects or disabled users', async () => {
      const r = await runningJob(ALPHA);
      await jobs.transition(r.jobId, 'attempt_failed', {
        actor: r.actor,
        epoch: r.epoch,
        reason: `exit 1 ${SECRET_IN_SUMMARY}`,
      });
      const report = await svc.runOnce();
      expect(report.events).toBeGreaterThan(0);
      expect(await recipientsOf('job.failed', `job.failed:${r.jobId}`)).toEqual(
        sorted(p.owner.id, p.admin.id, p.opA.id),
      );
      // Idempotent: a second pass over the same outbox creates nothing new.
      expect((await svc.runOnce()).created).toBe(0);
      const { rows } = await h.db.pool.query<{ title: string; body: string; link: string; severity: string }>(
        'SELECT title, body, link, severity FROM notifications WHERE recipient_id = $1 AND kind = $2',
        [p.opA.id, 'job.failed'],
      );
      expect(rows[0]).toMatchObject({ severity: 'warning', link: `/jobs/${r.jobId}` });
      expect(rows[0]?.title).toContain('Job failed');
      // The free-text failure reason and the prompt are never copied into a notification.
      expect(JSON.stringify(rows)).not.toContain(SECRET_IN_SUMMARY);
    });

    it('job lost (lease expired) is critical', async () => {
      const r = await runningJob(BETA, 'worker-2', 60_000);
      h.clock.advance(61_000);
      await jobs.transition(r.jobId, 'lease_expired', {
        actor: { type: 'system', id: 'sweeper' },
        epoch: r.epoch,
      });
      await svc.runOnce();
      expect(await recipientsOf('job.failed', `job.failed:${r.jobId}`)).toEqual(
        sorted(p.owner.id, p.admin.id, p.opB.id),
      );
      const { rows } = await h.db.pool.query<{ severity: string; title: string }>(
        "SELECT severity, title FROM notifications WHERE dedupe_key LIKE 'job.failed:' || $1 || '%' LIMIT 1",
        [r.jobId],
      );
      expect(rows[0]).toMatchObject({ severity: 'critical' });
      expect(rows[0]?.title).toContain('Job lost');
    });

    it('approval requested: only users who can decide it (approver role and project)', async () => {
      // In-run tool approval: approver role operator → owner, admin, alpha operator.
      const r = await runningJob(ALPHA, 'worker-3');
      const ev = await approvals.evaluate({
        action: 'bash',
        jobId: r.jobId,
        approvalKey: 'call-1',
        attemptId: r.attemptId,
        epoch: r.epoch,
        summary: `curl -H "Authorization: Bearer ${SECRET_IN_SUMMARY}" https://example.org`,
        risk: 'high',
        requestedBy: { type: 'runtime', id: 'worker-3' },
      });
      if (ev.outcome !== 'pending') throw new Error('expected pending');
      await svc.runOnce();
      expect(await recipientsOf('approval.requested', `approval.requested:${ev.requestId}`)).toEqual(
        sorted(p.owner.id, p.admin.id, p.opA.id),
      );
      const { rows } = await h.db.pool.query<{ body: string; title: string; link: string }>(
        'SELECT title, body, link FROM notifications WHERE dedupe_key = $1',
        [`approval.requested:${ev.requestId}`],
      );
      expect(rows[0]?.link).toBe(`/approvals/${ev.requestId}`);
      expect(JSON.stringify(rows)).not.toContain(SECRET_IN_SUMMARY);
      // No details (older worker): the body names the catalog action only, never the summary.
      expect(rows[0]?.body).not.toContain('agent says');

      // p10-approval-readable: with details, the agent's own description (labelled, bounded; redacted) is in the body.
      const ev2 = await approvals.evaluate({
        action: 'bash',
        jobId: r.jobId,
        approvalKey: 'call-1b',
        attemptId: r.attemptId,
        epoch: r.epoch,
        summary: 'Bash: whoami',
        risk: 'high',
        requestedBy: { type: 'runtime', id: 'worker-3' },
        details: {
          tool: 'Bash',
          description: `Run whoami and save output ${SECRET_IN_SUMMARY}`,
          command: 'whoami',
        },
      });
      if (ev2.outcome !== 'pending') throw new Error('expected pending');
      await svc.runOnce();
      const { rows: rows2 } = await h.db.pool.query<{ body: string }>(
        'SELECT body FROM notifications WHERE dedupe_key = $1 LIMIT 1',
        [`approval.requested:${ev2.requestId}`],
      );
      expect(rows2[0]?.body).toContain('The agent says (unverified): “Run whoami and save output');
      expect(JSON.stringify(rows2)).not.toContain(SECRET_IN_SUMMARY);

      // Gate merge: approver role admin → owner and admin only, even for the project's operator.
      const g = await runningJob(ALPHA, 'worker-4');
      await jobs.transition(g.jobId, 'run_finished', { actor: g.actor, epoch: g.epoch });
      await jobs.transition(g.jobId, 'verification_passed', { actor: g.actor, epoch: g.epoch });
      const merge = await approvals.evaluate({
        action: 'git.merge',
        jobId: g.jobId,
        summary: 'Merge',
        requestedBy: { type: 'system', id: 'integrator' },
      });
      if (merge.outcome !== 'pending') throw new Error('expected pending');
      await svc.runOnce();
      expect(await recipientsOf('approval.requested', `approval.requested:${merge.requestId}`)).toEqual(
        sorted(p.owner.id, p.admin.id),
      );
    });

    it('approval expiring soon: once, in the last quarter of the lifetime, to the deciders', async () => {
      const r = await runningJob(ALPHA, 'worker-5');
      const ev = await approvals.evaluate({
        action: 'bash',
        jobId: r.jobId,
        approvalKey: 'call-exp',
        attemptId: r.attemptId,
        epoch: r.epoch,
        summary: 'ls',
        requestedBy: { type: 'runtime', id: 'worker-5' },
      });
      if (ev.outcome !== 'pending') throw new Error('expected pending');
      const key = `approval.expiring:${ev.requestId}`;
      await svc.runOnce();
      expect(await recipientsOf('approval.expiring', key)).toEqual([]);
      // Lifetime 1 h: "soon" = the last 15 minutes.
      h.clock.advance(46 * 60_000);
      await svc.runOnce();
      expect(await recipientsOf('approval.expiring', key)).toEqual(sorted(p.owner.id, p.admin.id, p.opA.id));
      await svc.runOnce();
      expect(await recipientsOf('approval.expiring', key)).toHaveLength(3);
    });

    it('budget threshold: project members (viewers too) and owner/admin, per level', async () => {
      const actor = { id: p.owner.id, role: 'owner' as const, mfaAt: h.clock.now() };
      const { budget } = await usage.createBudget(
        actor,
        {
          name: 'Alpha tokens',
          metric: 'tokens',
          limit: 2000,
          scopeType: 'project',
          scopeValue: ALPHA,
          window: 'day',
        },
        {},
      );
      const { job } = await jobs.create({
        project: ALPHA,
        actor: CREATOR,
        submit: true,
        spec: {
          runtime: 'pi',
          prompt: 'x',
          repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/b' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      });
      const grant = await jobs.acquireLease(job.id, 'worker-6', HOUR);
      let seq = 0;
      const rec = (tokens: number) =>
        usage.recordUsage(
          {
            kind: 'usage',
            provenance: 'unknown',
            inputTokens: tokens,
            outputTokens: 0,
            provider: 'anthropic',
            model: 'm',
          },
          {
            jobId: job.id,
            attemptId: grant.attempt.id,
            workerId: 'worker-6',
            sourceEventId: `n-${String(++seq)}`,
          },
        );
      await rec(1700);
      await rec(400);
      await svc.runOnce();
      const prefix = `budget.threshold:${budget.id}`;
      const members = sorted(p.owner.id, p.admin.id, p.opA.id, p.viewerA.id);
      const { rows } = await h.db.pool.query<{ recipient_id: string; severity: string; title: string }>(
        'SELECT recipient_id, severity, title FROM notifications WHERE dedupe_key LIKE $1 ORDER BY severity, recipient_id',
        [`${prefix}%`],
      );
      expect(rows.filter((r) => r.severity === 'warning').map((r) => r.recipient_id)).toEqual(members);
      expect(rows.filter((r) => r.severity === 'critical').map((r) => r.recipient_id)).toEqual(members);
      // p8-cost-efficiency: new budgets pause new jobs at 100 % → `budget.paused`, and also announce 50 %.
      expect(rows.find((r) => r.severity === 'critical')?.title).toBe(
        'Budget exhausted: Alpha tokens — new jobs paused',
      );
      expect(rows.filter((r) => r.severity === 'info').map((r) => r.recipient_id)).toEqual(members);
    });

    it('worker pending enrollment: owners and admins only', async () => {
      const directory = new PgDeviceDirectory({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        limiter: new RedisRateLimiter(h.redis, `test:notify:${String(Date.now())}:`),
        clock: h.clock.now,
      });
      const key = new TestKey();
      const result = await directory.authenticate({
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        pairingCode: 'ABCD-EFGH',
        facts: { ...FACTS, hostname: 'build-mac-01' },
        workerVersion: '1.0.0',
        negotiatedVersion: PROTOCOL_VERSION,
        ip: '198.51.100.7',
        resumeFromSeq: 0,
      });
      expect(result.kind).toBe('pending');
      await svc.runOnce();
      expect(await recipientsOf('worker.pending')).toEqual(sorted(p.owner.id, p.admin.id));
      const { rows } = await h.db.pool.query<{ title: string }>(
        "SELECT title FROM notifications WHERE kind = 'worker.pending' LIMIT 1",
      );
      expect(rows[0]?.title).toBe('Worker waiting for approval: build-mac-01');
    });

    it('worker offline while holding a lease: admins plus operators of the affected project', async () => {
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
         VALUES ($1, 'linux-runner-3', 'busy', '{}'::jsonb, '1.0.0', $2, $2, $2)`,
        [WORKER, now],
      );
      const r = await runningJob(ALPHA, WORKER);
      // A worker without leases going offline is not announced.
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
         VALUES ('wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'idle-box', 'online', '{}'::jsonb, '1.0.0', $1, $1, $1)`,
        [now],
      );
      // Not connected to the hub: the sweep marks both offline.
      const affected = await h.app.fleetSessions.sweep();
      expect(affected).toEqual(expect.arrayContaining([WORKER, 'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb']));
      await svc.runOnce();
      expect(await recipientsOf('worker.offline')).toEqual(sorted(p.owner.id, p.admin.id, p.opA.id));
      const { rows } = await h.db.pool.query<{ body: string; recipient_id: string }>(
        "SELECT body, recipient_id FROM notifications WHERE kind = 'worker.offline'",
      );
      expect(rows.find((x) => x.recipient_id === p.opA.id)?.body).toContain(r.jobId.slice(0, 8));
      expect(JSON.stringify(rows)).not.toContain('idle-box');
      // Observed from state on every pass, but announced once per offline episode.
      await svc.runOnce();
      expect(await recipientsOf('worker.offline')).toHaveLength(3);
    });

    it('never marks shared outbox rows dispatched and advances its own cursor only past settled rows', async () => {
      const { rows } = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox WHERE dispatched_at IS NOT NULL',
      );
      expect(rows[0]?.n).toBe(0);
      const floorBefore = await h.db.pool.query<{ floor_id: string }>(
        "SELECT floor_id::text FROM notification_consumer WHERE name = 'outbox'",
      );
      h.clock.advance(2 * 60_000);
      await svc.runOnce();
      const floorAfter = await h.db.pool.query<{ floor_id: string; max: string }>(
        "SELECT c.floor_id::text, (SELECT max(id)::text FROM outbox) AS max FROM notification_consumer c WHERE name = 'outbox'",
      );
      expect(Number(floorAfter.rows[0]?.floor_id)).toBeGreaterThan(Number(floorBefore.rows[0]?.floor_id));
      expect(floorAfter.rows[0]?.floor_id).toBe(floorAfter.rows[0]?.max);
      const seen = await h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM notification_outbox_seen',
      );
      expect(seen.rows[0]?.n).toBe(0);
    });
  });

  describe('REST: own notifications only', () => {
    beforeAll(async () => {
      await relogin();
    });

    it('lists own notifications with the unread count and pages with a cursor', async () => {
      const res = await p.opA.client.req('GET', '/notifications?limit=2');
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{
        items: { id: string; kind: string }[];
        unreadCount: number;
        nextCursor: string | null;
      }>();
      expect(page.items).toHaveLength(2);
      expect(page.unreadCount).toBeGreaterThanOrEqual(5);
      expect(page.nextCursor).not.toBeNull();
      const next = await p.opA.client.req('GET', `/notifications?limit=2&cursor=${String(page.nextCursor)}`);
      const ids = next.json<{ items: { id: string }[] }>().items.map((i) => i.id);
      expect(ids).not.toContain(page.items[0]?.id);
      expect((await p.opA.client.req('GET', '/notifications?cursor=garbage')).statusCode).toBe(400);
      // Viewer sees only what was addressed to them (the budget alerts).
      const v = await p.viewerA.client.req('GET', '/notifications');
      expect(new Set(v.json<{ items: { kind: string }[] }>().items.map((i) => i.kind))).toEqual(
        // p8-cost-efficiency: the 100 % crossing of a pause-new budget is `budget.paused`.
        new Set(['budget.threshold', 'budget.paused']),
      );
    });

    it('marks read; another user’s notification answers 404 like a missing one', async () => {
      const mine = (await p.opA.client.req('GET', '/notifications?unread=true')).json<{
        items: { id: string }[];
        unreadCount: number;
      }>();
      const id = mine.items[0]?.id ?? '';
      const read = await p.opA.client.req('POST', `/notifications/${id}/read`);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ notification: { id }, unreadCount: mine.unreadCount - 1 });
      const other = await p.opB.client.req('POST', `/notifications/${id}/read`);
      const missing = await p.opB.client.req(
        'POST',
        '/notifications/00000000-0000-4000-8000-0000000000aa/read',
      );
      expect(other.statusCode).toBe(404);
      expect(other.json()).toEqual(missing.json());
      const all = await p.opA.client.req('POST', '/notifications/read-all');
      expect(all.json()).toMatchObject({ unreadCount: 0 });
      expect((await p.opA.client.req('GET', '/notifications')).json()).toMatchObject({ unreadCount: 0 });
      // CSRF applies to the write routes.
      const noCsrf = p.opA.client.clone();
      noCsrf.sendCsrf = false;
      expect((await noCsrf.req('POST', '/notifications/read-all')).statusCode).toBe(403);
    });
  });

  describe('preferences and outbound delivery', () => {
    it('defaults to in-app only; changing targets needs a step-up; allowlist and address are enforced', async () => {
      const prefs = await p.opA.client.req('GET', '/notifications/preferences');
      expect(prefs.statusCode).toBe(200);
      expect(prefs.json()).toMatchObject({
        channels: { email: { available: true, address: null }, webhook: { available: true, url: null } },
      });
      expect(
        prefs
          .json<{ kinds: { email: boolean; webhook: boolean }[] }>()
          .kinds.every((k) => !k.email && !k.webhook),
      ).toBe(true);

      h.clock.advance(11 * 60_000); // step-up lapsed
      const stale = await p.opA.client.req('PUT', '/notifications/preferences', { email: 'op@example.com' });
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      // Toggling kinds without changing targets needs no step-up.
      expect(
        (
          await p.opA.client.req('PUT', '/notifications/preferences', {
            kinds: [{ kind: 'job.failed', email: true }],
          })
        ).statusCode,
      ).toBe(200);

      await stepUp(p.opA);
      const badMail = await p.opA.client.req('PUT', '/notifications/preferences', {
        email: 'op@example.com\r\nBcc: x@y.z',
      });
      expect(badMail.json()).toMatchObject({ error: 'invalid_email' });
      const badHook = await p.opA.client.req('PUT', '/notifications/preferences', {
        webhookUrl: 'https://evil.example/hook',
      });
      expect(badHook.json()).toMatchObject({ error: 'webhook_not_allowed' });
      const ok = await p.opA.client.req('PUT', '/notifications/preferences', {
        email: 'op@example.com',
        webhookUrl: `${hookBase}/hooks/op-alpha`,
        kinds: [
          { kind: 'job.failed', email: true, webhook: true },
          { kind: 'approval.requested', webhook: true },
        ],
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ channels: { email: { address: 'op@example.com' } } });
      // Audit records that targets changed, never the address or URL.
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'notification.preferences.update' AND outcome = 'success' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]?.metadata).toMatchObject({ emailTarget: 'set', webhookTarget: 'set' });
      expect(JSON.stringify(rows)).not.toContain('op@example.com');
    });

    it('delivers opted-in kinds by TLS e-mail and signed webhook; other kinds stay in-app', async () => {
      const r = await runningJob(ALPHA, 'worker-7');
      await jobs.transition(r.jobId, 'attempt_failed', { actor: r.actor, epoch: r.epoch, reason: 'boom' });
      const before = smtp.messages.length;
      const report = await svc.runOnce();
      expect(report.sent).toBe(2); // opA: email + webhook for job.failed; nobody else opted in
      expect(smtp.messages).toHaveLength(before + 1);
      const mail = smtp.messages.at(-1);
      expect(mail).toMatchObject({
        to: ['op@example.com'],
        secure: true,
        auth: { username: 'mailer', password: SMTP_PASSWORD },
      });
      const text = mailText(mail?.data ?? '');
      expect(text).toContain(`https://remyral.example.com/jobs/${r.jobId}`);
      expect(text).not.toContain(SECRET_IN_SUMMARY);

      const req = hookRequests.at(-1);
      if (!req) throw new Error('no webhook request');
      const sig = String(req.headers[SIGNATURE_HEADER]);
      expect(verifyWebhookSignature(WEBHOOK_SECRET, sig, req.body, h.clock.now().getTime() / 1000)).toBe(
        true,
      );
      expect(JSON.parse(req.body)).toMatchObject({ kind: 'job.failed', recipient: { username: 'op.alpha' } });
      const { rows } = await h.db.pool.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM notification_deliveries WHERE status <> 'sent'",
      );
      expect(rows).toEqual([]);
    });

    it('retries transient failures with backoff and dead-letters after the last attempt or a permanent error', async () => {
      const deliveriesOf = async (jobId: string) =>
        (
          await h.db.pool.query<{
            channel: string;
            status: string;
            attempts: number;
            last_error: string | null;
          }>(
            `SELECT d.channel, d.status, d.attempts, d.last_error FROM notification_deliveries d
               JOIN notifications n ON n.id = d.notification_id
              WHERE n.dedupe_key LIKE 'job.failed:' || $1 || '%' AND d.channel = 'webhook'`,
            [jobId],
          )
        ).rows;

      // 503 then 200: retried once, then sent.
      hookStatus = [503];
      const a = await runningJob(ALPHA, 'worker-8');
      await jobs.transition(a.jobId, 'attempt_failed', { actor: a.actor, epoch: a.epoch, reason: 'x' });
      await svc.runOnce();
      expect(await deliveriesOf(a.jobId)).toEqual([
        { channel: 'webhook', status: 'pending', attempts: 1, last_error: 'http_503' },
      ]);
      await svc.deliverDue(); // not due yet (backoff)
      expect((await deliveriesOf(a.jobId))[0]?.attempts).toBe(1);
      h.clock.advance(1_000);
      await svc.deliverDue();
      expect((await deliveriesOf(a.jobId))[0]).toMatchObject({ status: 'sent', attempts: 2 });

      // Always 500: dead after maxAttempts (3).
      hookStatus = [500, 500, 500];
      const b = await runningJob(ALPHA, 'worker-9');
      await jobs.transition(b.jobId, 'attempt_failed', { actor: b.actor, epoch: b.epoch, reason: 'x' });
      await svc.runOnce();
      h.clock.advance(1_000);
      await svc.deliverDue();
      h.clock.advance(2_000);
      await svc.deliverDue();
      expect((await deliveriesOf(b.jobId))[0]).toMatchObject({
        status: 'dead',
        attempts: 3,
        last_error: 'http_500',
      });

      // 410 Gone: permanent, dead on the first attempt.
      hookStatus = [410];
      const c = await runningJob(ALPHA, 'worker-10');
      await jobs.transition(c.jobId, 'attempt_failed', { actor: c.actor, epoch: c.epoch, reason: 'x' });
      await svc.runOnce();
      expect((await deliveriesOf(c.jobId))[0]).toMatchObject({
        status: 'dead',
        attempts: 1,
        last_error: 'http_410',
      });
      expect(h.logs.text).toContain('notification delivery dead-lettered');
    });

    it('a channel that is not configured cannot be enabled', async () => {
      const bare = new NotificationService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      await expect(
        bare.updatePreferences(
          p.viewerA.id,
          { kinds: [{ kind: 'job.failed', email: true }] },
          { ip: null, userAgent: null },
        ),
      ).rejects.toMatchObject({ statusCode: 400, code: 'channel_unavailable' });
      expect((await bare.preferences(p.viewerA.id)).channels.email.available).toBe(false);
    });
  });

  it('canary: no secret, target address or channel credential in the logs', () => {
    const text = h.logs.text;
    expect(text).toContain('/notifications');
    for (const value of [
      SECRET_IN_SUMMARY,
      SMTP_PASSWORD,
      WEBHOOK_SECRET.toString('utf8'),
      'op@example.com',
      `${hookBase}/hooks/op-alpha`,
    ]) {
      expect(text, value).not.toContain(value);
    }
  });
});
