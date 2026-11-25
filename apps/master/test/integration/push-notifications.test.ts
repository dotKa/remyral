import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { type NotificationService, vapidKeysFromPem } from '../../src/notifications/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakePushService, type FakeSubscription } from '../helpers/fake-push.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p8-pwa (docs/design/p8-pwa.md): push subscriptions are per user and device, adding a new device needs a
 * step-up, only the owner sees and revokes them, revoking every session drops them, and the push channel
 * delivers RFC 8291-encrypted, VAPID-signed, minimal payloads to a fake push service only for kinds the
 * user enabled — with retries, gone-subscription cleanup and no secret in any payload.
 */
const PW = 'quartz-meadow-lantern-7';
const ALPHA = 'alpha';
const BETA = 'beta';
const SECRET = `ghp_${'Zx9Qw8Er7Ty6'.repeat(3)}`;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

interface Person {
  readonly id: string;
  readonly username: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let svc: NotificationService;
let jobs: JobStore;
let push: FakePushService;
const vapid = vapidKeysFromPem(
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString(),
);
const p = {} as Record<'owner' | 'opA' | 'opB', Person>;

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { client, secret } = await enroll(h, username, PW);
  return { id, username, secret, client };
}

async function stepUp(x: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await x.client.req('POST', '/auth/step-up', { code: h.code(x.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

/** A standard session older than the 10-minute step-up window. */
async function staleSession(x: Person): Promise<void> {
  x.client = await fullLogin(h, x.username, PW, x.secret);
  h.clock.advance(11 * 60_000);
  // Keep the session alive (idle timeout 30 min) without a new TOTP.
  expect((await x.client.req('GET', '/auth/session')).statusCode).toBe(200);
}

function body(s: FakeSubscription): {
  endpoint: string;
  expirationTime: null;
  keys: FakeSubscription['keys'];
} {
  return { endpoint: s.endpoint, expirationTime: null, keys: s.keys };
}

async function subscribe(x: Person, s: FakeSubscription): Promise<string> {
  await stepUp(x);
  const res = await x.client.req('POST', '/notifications/push/subscriptions', body(s));
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ device: { id: string } }>().device.id;
}

async function failJob(project: string): Promise<string> {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt: `Deploy with token ${SECRET}`,
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/push' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, 'worker-1', 3_600_000);
  const actor: JobActor = { type: 'worker', id: 'worker-1' };
  const epoch = grant.lease.epoch;
  await jobs.transition(job.id, 'lease_acked', { actor, epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch });
  await jobs.transition(job.id, 'attempt_failed', { actor, epoch, reason: `exit 1 ${SECRET}` });
  return job.id;
}

async function enablePush(x: Person, kinds: string[], on = true): Promise<void> {
  const res = await x.client.req('PUT', '/notifications/preferences', {
    kinds: kinds.map((kind) => ({ kind, push: on })),
  });
  expect(res.statusCode, res.body).toBe(200);
}

describeIntegration('web push (integration)', () => {
  beforeAll(async () => {
    push = new FakePushService();
    const origin = await push.start();
    h = new Harness();
    await h.start({
      notifications: {
        options: { backoffBaseMs: 1_000, maxAttempts: 3, settleMs: 60_000 },
        push: { vapid, subject: 'mailto:ops@example.com', endpointAllowlist: [origin] },
      },
    });
    svc = h.app.notifications;
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    p.owner = await person('owner', 'owner', []);
    p.opA = await person('op.alpha', 'operator', [ALPHA]);
    p.opB = await person('op.beta', 'operator', [BETA]);
  });

  afterAll(async () => {
    await h.stop();
    await push.stop();
  });

  describe('subscriptions', () => {
    it('exposes the VAPID public key and an empty device list', async () => {
      const res = await p.opA.client.req('GET', '/notifications/push');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true, publicKey: vapid.publicKey, devices: [] });
      const prefs = (await p.opA.client.req('GET', '/notifications/preferences')).json<{
        channels: { push: unknown };
        kinds: { push: boolean }[];
      }>();
      expect(prefs.channels.push).toEqual({ available: true, devices: 0 });
      expect(prefs.kinds.every((k) => !k.push)).toBe(true);
    });

    it('a new device needs a step-up; re-registering the same one does not', async () => {
      const s = push.subscribe();
      await staleSession(p.opA);
      const denied = await p.opA.client.req('POST', '/notifications/push/subscriptions', body(s));
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp(p.opA);
      const ok = await p.opA.client.req('POST', '/notifications/push/subscriptions', body(s), {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const created = ok.json<{
        device: { id: string; label: string; service: string };
        created: boolean;
      }>();
      expect(created.created).toBe(true);
      expect(created.device.label).toBe('Safari on iOS');
      expect(created.device.service).toBe('127.0.0.1');
      // Later, outside the step-up window: the app refreshes its subscription on every start.
      await staleSession(p.opA);
      const again = await p.opA.client.req('POST', '/notifications/push/subscriptions', body(s));
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ created: false, device: { id: created.device.id } });
      // The keys are sealed at rest: neither key appears in the row.
      const { rows } = await h.db.pool.query<{ keys_sealed: Buffer }>(
        'SELECT keys_sealed FROM push_subscriptions WHERE id = $1',
        [created.device.id],
      );
      const raw = rows[0]?.keys_sealed ?? Buffer.alloc(0);
      expect(raw.includes(Buffer.from(s.keys.auth, 'base64url'))).toBe(false);
      expect(raw.includes(Buffer.from(s.keys.p256dh, 'base64url'))).toBe(false);
      // Audited without the endpoint (a capability URL).
      const { rows: audit } = await h.db.pool.query<{ metadata: unknown }>(
        "SELECT metadata FROM audit_events WHERE action = 'notification.push.subscribe' AND actor_id = $1",
        [p.opA.id],
      );
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(s.endpoint);
    });

    it('refuses endpoints off the push service allowlist and malformed keys', async () => {
      await stepUp(p.opA);
      const s = push.subscribe();
      for (const endpoint of [
        'https://attacker.example.com/push/x',
        'http://169.254.169.254/latest/meta-data',
        `${push.origin.replace('127.0.0.1', 'localhost')}/push/x`,
        `http://user:pw@${push.origin.slice('http://'.length)}/push/x`,
      ]) {
        const res = await p.opA.client.req('POST', '/notifications/push/subscriptions', {
          ...body(s),
          endpoint,
        });
        expect(res.statusCode, endpoint).toBe(400);
        expect(res.json()).toMatchObject({ error: 'push_endpoint_not_allowed' });
      }
      const badKey = await p.opA.client.req('POST', '/notifications/push/subscriptions', {
        ...body(s),
        keys: { p256dh: `B${'A'.repeat(86)}`, auth: s.keys.auth },
      });
      expect(badKey.statusCode).toBe(400);
      expect(badKey.json()).toMatchObject({ error: 'invalid_push_subscription' });
    });

    it('only the owner lists and revokes a device; another user gets 404', async () => {
      const s = push.subscribe();
      const id = await subscribe(p.opB, s);
      const listA = (await p.opA.client.req('GET', '/notifications/push')).json<{
        devices: { id: string }[];
      }>();
      expect(listA.devices.map((d) => d.id)).not.toContain(id);
      const foreign = await p.opA.client.req('DELETE', `/notifications/push/subscriptions/${id}`);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ error: 'push_device_not_found' });
      const foreignEndpoint = await p.opA.client.req('POST', '/notifications/push/unsubscribe', {
        endpoint: s.endpoint,
      });
      expect(foreignEndpoint.json()).toEqual({ removed: false });
      const own = await p.opB.client.req('DELETE', `/notifications/push/subscriptions/${id}`);
      expect(own.statusCode).toBe(200);
      const listB = (await p.opB.client.req('GET', '/notifications/push')).json<{ devices: unknown[] }>();
      expect(listB.devices).toEqual([]);
    });

    it('an endpoint re-registered by another account (shared browser) moves to that account', async () => {
      const s = push.subscribe();
      const first = await subscribe(p.opB, s);
      const second = await subscribe(p.owner, s);
      expect(second).not.toBe(first);
      const listB = (await p.opB.client.req('GET', '/notifications/push')).json<{ devices: unknown[] }>();
      expect(listB.devices).toEqual([]);
      await p.owner.client.req('POST', '/notifications/push/unsubscribe', {
        endpoint: s.endpoint,
        reason: 'logout',
      });
      const listO = (await p.owner.client.req('GET', '/notifications/push')).json<{ devices: unknown[] }>();
      expect(listO.devices).toEqual([]);
    });
  });

  describe('delivery', () => {
    let phoneA: FakeSubscription;

    it('delivers an encrypted, VAPID-signed, minimal payload only for enabled kinds and permitted recipients', async () => {
      // Start from one device per user (the subscription tests left one for opA).
      const old = (await p.opA.client.req('GET', '/notifications/push')).json<{
        devices: { id: string }[];
      }>();
      for (const d of old.devices) {
        expect(
          (await p.opA.client.req('DELETE', `/notifications/push/subscriptions/${d.id}`)).statusCode,
        ).toBe(200);
      }
      phoneA = push.subscribe();
      await subscribe(p.opA, phoneA);
      const phoneB = push.subscribe();
      await subscribe(p.opB, phoneB);
      await enablePush(p.opB, ['job.failed']);

      // Not enabled yet for opA: in-app only.
      const first = await failJob(ALPHA);
      await svc.runOnce();
      expect(push.to(phoneA)).toHaveLength(0);

      await enablePush(p.opA, ['job.failed']);
      const jobId = await failJob(ALPHA);
      const report = await svc.runOnce();
      expect(report.sent).toBeGreaterThanOrEqual(1);
      const got = push.to(phoneA);
      expect(got).toHaveLength(1);
      const msg = got[0];
      expect(msg?.vapidValid).toBe(true);
      expect(msg?.vapidKey).toBe(vapid.publicKey);
      expect(msg?.headers['content-encoding']).toBe('aes128gcm');
      expect(msg?.headers.urgency).toBe('high');
      expect(Number(msg?.headers.ttl)).toBeGreaterThan(0);
      const payload = JSON.parse(msg?.payload ?? 'null') as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'body',
        'id',
        'kind',
        'link',
        'severity',
        'title',
        'ts',
        'v',
      ]);
      expect(payload).toMatchObject({
        v: 1,
        kind: 'job.failed',
        severity: 'warning',
        link: `/jobs/${jobId}`,
      });
      expect(String(payload.title)).toContain('Job failed');
      expect(String(payload.title).length).toBeLessThanOrEqual(80);
      expect(String(payload.body).length).toBeLessThanOrEqual(180);
      // Neither the prompt nor the failure reason (untrusted text with a token) reaches the device.
      expect(msg?.payload).not.toContain(SECRET);
      expect(msg?.payload).not.toContain(first);
      // opB is not in project alpha: nothing reaches their phone even though they enabled the kind.
      expect(push.to(phoneB)).toHaveLength(0);
    });

    it('retries a transient push service error and dead-letters nothing once it succeeds', async () => {
      push.statuses.set(push.tokenOf(phoneA), [503]);
      const before = push.to(phoneA).length;
      await failJob(ALPHA);
      const one = await svc.runOnce();
      expect(one.retried).toBe(1);
      h.clock.advance(2_000);
      const two = await svc.runOnce();
      expect(two.sent).toBe(1);
      const delivered = push.to(phoneA).slice(before);
      expect(delivered.map((r) => r.payload === null)).toEqual([true, false]);
    });

    it('a 410 Gone removes the subscription and dead-letters the delivery', async () => {
      push.statuses.set(push.tokenOf(phoneA), [410]);
      await failJob(ALPHA);
      const r = await svc.runOnce();
      expect(r.dead).toBe(1);
      const { rows } = await h.db.pool.query<{ last_error: string }>(
        "SELECT last_error FROM notification_deliveries WHERE channel = 'push' AND status = 'dead' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]?.last_error).toBe('push_gone');
      const list = (await p.opA.client.req('GET', '/notifications/push')).json<{ devices: unknown[] }>();
      expect(list.devices).toEqual([]);
      // No device left: later notifications queue no push delivery at all.
      const pending = await h.db.pool.query(
        "SELECT 1 FROM notification_deliveries WHERE channel = 'push' AND status = 'pending'",
      );
      await failJob(ALPHA);
      await svc.runOnce();
      const after = await h.db.pool.query(
        "SELECT 1 FROM notification_deliveries WHERE channel = 'push' AND status = 'pending'",
      );
      expect(after.rowCount).toBe(pending.rowCount);
    });

    it('test push reaches the own devices; 409 without any', async () => {
      const none = await p.opA.client.req('POST', '/notifications/push/test');
      expect(none.statusCode).toBe(409);
      const s = push.subscribe();
      await subscribe(p.opA, s);
      const res = await p.opA.client.req('POST', '/notifications/push/test');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ sent: 1 });
      expect(JSON.parse(push.to(s)[0]?.payload ?? '{}')).toMatchObject({
        kind: 'test',
        link: '/settings/devices',
      });
    });

    it('log out everywhere revokes every push device of the user', async () => {
      const list = (await p.opA.client.req('GET', '/notifications/push')).json<{ devices: unknown[] }>();
      expect(list.devices.length).toBeGreaterThan(0);
      const out = await p.opA.client.req('POST', '/auth/logout-all');
      expect(out.statusCode, out.body).toBeLessThan(300);
      const { rows } = await h.db.pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [
        p.opA.id,
      ]);
      expect(rows).toHaveLength(0);
    });
  });
});
