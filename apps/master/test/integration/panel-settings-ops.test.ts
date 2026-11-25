import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Notifier, OutboundMessage } from '../../src/notifications/notifier.js';
import { verifyWebhookSignature } from '../../src/notifications/webhook.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';

interface Outcome {
  status: 'applied' | 'pending';
  temporaryPassword: string | null;
  requestId: string | null;
}
interface Job {
  id: string;
  kind: string;
  state: string;
  dryRun: boolean;
  progress: { done: number; total: number | null; lines: string[] };
  report: unknown;
  error: string | null;
}

/**
 * p17-panel-settings Parts 4–7 against a real master: account recovery of other users (authz, always-fresh step-up,
 * second-owner approval, one-time password, notifications), key rotation (webhook HMAC overlap, skills panel key with
 * the old key kept trusted, the host procedures), the workflow pre-check and the maintenance jobs (dry run first, one
 * at a time per kind, cancel, interrupted).
 */
describeIntegration(
  'p17-panel-settings: recovery, keys, maintenance (integration)',
  { timeout: 90_000 },
  () => {
    const h = new Harness();
    const mails: { message: OutboundMessage; to: string }[] = [];
    const mailer: Notifier = {
      channel: 'email',
      acceptsTarget: () => true,
      send: (message, to) => {
        mails.push({ message, to });
        return Promise.resolve();
      },
    };
    const hooks: { headers: Record<string, string>; body: string }[] = [];
    const users: Record<string, { client: Client; secret: string; id: string }> = {};

    const fresh = async (name: string) => {
      h.clock.advance(30_000);
      const u = users[name];
      if (u === undefined) throw new Error(name);
      expect((await u.client.req('POST', '/auth/step-up', { code: h.code(u.secret) })).statusCode).toBe(200);
      return u.client;
    };
    const add = async (name: string, role: 'owner' | 'admin' | 'operator' | 'viewer') => {
      const id = await h.createUser(name, PW, role);
      const { client, secret } = await enroll(h, name, PW);
      users[name] = { client, secret, id };
      await h.db.pool.query(
        `INSERT INTO notification_targets (user_id, email, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email`,
        [id, `${name}@example.com`],
      );
    };
    const job = async (c: Client, id: string): Promise<Job> => {
      for (let i = 0; i < 200; i++) {
        const j = (await c.req('GET', `/maintenance/jobs/${id}`)).json<Job>();
        if (j.state !== 'running') return j;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('job did not finish');
    };

    beforeAll(async () => {
      await h.start({
        notifications: {
          notifiers: [mailer],
          webhookTestSeams: {
            fetchImpl: (_url: string | URL | Request, init?: RequestInit) => {
              hooks.push({
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                body: typeof init?.body === 'string' ? init.body : '',
              });
              return Promise.resolve(new Response(null, { status: 204 }));
            },
          },
        },
      });
      await add('owner1', 'owner');
      await add('owner2', 'owner');
      await add('admin1', 'admin');
      await add('op1', 'operator');
      await add('viewer1', 'viewer');
    });
    afterAll(async () => {
      await h.stop();
    });
    beforeEach(() => {
      h.clock.advance(1_000);
    });

    it('recovery: who may recover whom; always-fresh step-up; nobody recovers themselves', async () => {
      const op = users.op1?.id ?? '';
      const owner2 = users.owner2?.id ?? '';
      expect(
        (await users.viewer1?.client.req('POST', `/users/${op}/recover`, { action: 'unlock' }))?.statusCode,
      ).toBe(403);
      h.clock.advance(11 * 60_000);
      const stale = await users.owner1?.client.req('POST', `/users/${op}/recover`, { action: 'unlock' });
      expect(stale?.json()).toMatchObject({ error: 'step_up_required' });
      const admin = await fresh('admin1');
      expect((await admin.req('POST', `/users/${op}/recover`, { action: 'unlock' })).json()).toMatchObject({
        status: 'applied',
      });
      expect(
        (await admin.req('POST', `/users/${owner2}/recover`, { action: 'unlock' })).json(),
      ).toMatchObject({
        error: 'recovery_not_allowed',
      });
      const owner = await fresh('owner1');
      expect(
        (await owner.req('POST', `/users/${users.owner1?.id ?? ''}/recover`, { action: 'reset-mfa' })).json(),
      ).toMatchObject({ error: 'self_change' });
    });

    it('recovery: an authenticator reset ends the sessions; a password reset is shown once and must be replaced', async () => {
      const op = users.op1?.id ?? '';
      const owner = await fresh('owner1');
      const r = await owner.req('POST', `/users/${op}/recover`, {
        action: 'reset-mfa',
        reason: 'lost phone',
      });
      expect(r.json()).toMatchObject({ status: 'applied', temporaryPassword: null });
      const u = await h.db.pool.query<{ totp_enabled: boolean }>(
        'SELECT totp_enabled FROM users WHERE id = $1',
        [op],
      );
      expect(u.rows[0]?.totp_enabled).toBe(false);
      expect((await users.op1?.client.req('GET', '/auth/session'))?.statusCode).toBe(401);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'user.recover.reset-mfa'",
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ username: 'op1', reason: 'lost phone' });
      // The user is told, by e-mail whatever the preference.
      await h.app.notifications.runOnce();
      expect(mails.some((m) => m.to === 'op1@example.com' && m.message.kind === 'account.recovery')).toBe(
        true,
      );
      const owner2 = await fresh('owner1');
      const p = await owner2.req('POST', `/users/${op}/recover`, { action: 'reset-password' });
      const out = p.json<Outcome>();
      expect(out.status).toBe('applied');
      expect(out.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
      const all = await h.db.pool.query<{ metadata: unknown }>('SELECT metadata FROM audit_events');
      expect(JSON.stringify(all.rows)).not.toContain(out.temporaryPassword ?? 'x');
      const login = await h
        .client()
        .req('POST', '/auth/login', { username: 'op1', password: out.temporaryPassword });
      expect(login.statusCode).toBe(200);
      const flag = await h.db.pool.query<{ password_change_required: boolean }>(
        'SELECT password_change_required FROM users WHERE id = $1',
        [op],
      );
      expect(flag.rows[0]?.password_change_required).toBe(true);
    });

    it('recovery: resetting another owner waits for a third owner; neither the requester nor the target approves', async () => {
      const owner2 = users.owner2?.id ?? '';
      // Two owners: the other owner is the only one who could approve and is the one locked out → applied directly.
      const direct = await (
        await fresh('owner1')
      ).req('POST', `/users/${owner2}/recover`, { action: 'unlock' });
      expect(direct.json()).toMatchObject({ status: 'applied' });
      await add('owner3', 'owner');
      const req = await (
        await fresh('owner1')
      ).req('POST', `/users/${owner2}/recover`, { action: 'reset-mfa' });
      const out = req.json<Outcome>();
      expect(out).toMatchObject({ status: 'pending' });
      const again = await (
        await fresh('owner1')
      ).req('POST', `/users/${owner2}/recover`, { action: 'reset-mfa' });
      expect(again.json()).toMatchObject({ error: 'recovery_pending' });
      const list = (await users.owner3?.client.req('GET', '/users/recovery-requests'))?.json<{
        items: { id: string; target: { username: string } }[];
      }>();
      expect(list?.items.map((i) => i.target.username)).toEqual(['owner2']);
      const self = await (
        await fresh('owner1')
      ).req('POST', `/users/recovery-requests/${out.requestId ?? ''}/approve`);
      expect(self.json()).toMatchObject({ error: 'recovery_second_owner' });
      const ok = await (
        await fresh('owner3')
      ).req('POST', `/users/recovery-requests/${out.requestId ?? ''}/approve`);
      expect(ok.json()).toMatchObject({ status: 'applied' });
      const u = await h.db.pool.query<{ totp_enabled: boolean }>(
        'SELECT totp_enabled FROM users WHERE id = $1',
        [owner2],
      );
      expect(u.rows[0]?.totp_enabled).toBe(false);
      expect(
        (
          await (await fresh('owner3')).req('POST', `/users/recovery-requests/${out.requestId ?? ''}/approve`)
        ).json(),
      ).toMatchObject({ error: 'recovery_not_pending' });
    });

    it('keys: the panel rotates the webhook HMAC with an overlap; the lease and master keys show their host procedure', async () => {
      const owner = await fresh('owner1');
      const keys = (await owner.req('GET', '/panel-settings/keys')).json<{
        items: { item: string; online: boolean; procedure: string[]; keyId: string | null }[];
      }>();
      expect(keys.items.find((i) => i.item === 'leaseSigning')).toMatchObject({ online: false });
      expect(keys.items.find((i) => i.item === 'leaseSigning')?.procedure.join('\n')).toContain(
        'lease-signing.pem',
      );
      expect(keys.items.find((i) => i.item === 'totp')).toMatchObject({ online: false });
      expect((await owner.req('POST', '/panel-settings/keys/leaseSigning/rotate')).json()).toMatchObject({
        error: 'key_rotation_offline',
      });
      // A webhook channel with a first key, and a subscriber.
      const first = await owner.req('PUT', '/panel-settings/notifications', {
        values: { 'notify.webhook.allowlist': ['https://hooks.example.com/r/'] },
        generate: ['notify.webhook.secret'],
      });
      const oldKey =
        first.json<{ generated: Record<string, string> }>().generated['notify.webhook.secret'] ?? '';
      h.clock.advance(30_000);
      expect(
        (
          await owner.req('PUT', '/notifications/preferences', {
            webhookUrl: 'https://hooks.example.com/r/o1',
            kinds: [{ kind: 'alert', webhook: true }],
          })
        ).statusCode,
      ).toBe(200);
      const dry = (await owner.req('GET', '/panel-settings/keys/webhookHmac/dry-run?action=prepare')).json<{
        effect: string[];
      }>();
      expect(dry.effect.join(' ')).toContain('1 receiver');
      expect(
        (await owner.req('GET', '/panel-settings/keys/webhookHmac/dry-run?action=activate')).json(),
      ).toMatchObject({ error: 'key_rotation_not_prepared' });
      const prep = await (await fresh('owner1')).req('POST', '/panel-settings/keys/webhookHmac/prepare');
      expect(prep.statusCode, prep.body).toBe(200);
      const next = prep.json<{ secret: string }>().secret;
      expect(next.length).toBeGreaterThanOrEqual(48);
      const send = async (key: string) => {
        await h.app.notifications.notify(h.db.pool, [users.owner1?.id ?? ''], {
          kind: 'alert',
          severity: 'info',
          title: 't',
          body: 'b',
          link: null,
          dedupeKey: key,
        });
        await h.app.notifications.runOnce();
        return hooks.at(-1);
      };
      const now = () => Math.floor(h.clock.now().getTime() / 1000);
      const during = await send('rot-1');
      expect(
        verifyWebhookSignature(
          Buffer.from(oldKey),
          during?.headers['x-remyral-signature'] ?? '',
          during?.body ?? '',
          now(),
        ),
      ).toBe(true);
      expect(
        verifyWebhookSignature(
          Buffer.from(next),
          during?.headers['x-remyral-signature-next'] ?? '',
          during?.body ?? '',
          now(),
        ),
      ).toBe(true);
      await (await fresh('owner1')).req('POST', '/panel-settings/keys/webhookHmac/activate');
      const after = await send('rot-2');
      expect(
        verifyWebhookSignature(
          Buffer.from(next),
          after?.headers['x-remyral-signature'] ?? '',
          after?.body ?? '',
          now(),
        ),
      ).toBe(true);
      expect(after?.headers['x-remyral-signature-next']).toBeUndefined();
      const audit = await h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'keys.webhook-hmac.%' ORDER BY id",
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'keys.webhook-hmac.prepare',
        'keys.webhook-hmac.activate',
      ]);
    });

    it('keys: a new skills panel key from the master; the old one stays trusted until retired', async () => {
      expect(h.app.skills.panelKeyId).toBeNull();
      const first = await (await fresh('owner1')).req('POST', '/panel-settings/keys/skillsPanel/rotate');
      const pub1 = first.json<{ publicKey: string }>().publicKey;
      expect(pub1).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const id1 = h.app.skills.panelKeyId;
      expect(id1).not.toBeNull();
      const dry = (
        await users.owner1?.client.req('GET', '/panel-settings/keys/skillsPanel/dry-run?action=rotate')
      )?.json<{
        effect: string[];
      }>();
      expect(dry?.effect.join(' ')).toContain('stays trusted');
      const second = await (await fresh('owner1')).req('POST', '/panel-settings/keys/skillsPanel/rotate');
      const pub2 = second.json<{ publicKey: string }>().publicKey;
      expect(pub2).not.toBe(pub1);
      expect(h.app.skills.panelKeyId).not.toBe(id1);
      const view = (await users.owner1?.client.req('GET', '/panel-settings/keys'))?.json<{
        items: { item: string; retired: string[]; publicKey: string | null }[];
      }>();
      expect(view?.items.find((i) => i.item === 'skillsPanel')).toMatchObject({
        publicKey: pub2,
        retired: [pub1],
      });
      await (await fresh('owner1')).req('POST', '/panel-settings/keys/skillsPanel/retire');
      const later = (await users.owner1?.client.req('GET', '/panel-settings/keys'))?.json<{
        items: { item: string; retired: string[] }[];
      }>();
      expect(later?.items.find((i) => i.item === 'skillsPanel')?.retired).toEqual([]);
      // The private key is never in a response or the audit trail.
      const audit = await h.db.pool.query<{ metadata: unknown }>('SELECT metadata FROM audit_events');
      expect(JSON.stringify(audit.rows)).not.toContain('PRIVATE KEY');
    });

    it('workflows: the pre-check runs from the panel and gates engine 2 for version-1 workflows', async () => {
      const r = await users.admin1?.client.req('POST', '/panel-settings/workflows/check');
      expect(r?.statusCode).toBe(200);
      expect(r?.json()).toMatchObject({ failures: [], openRuns: { engine1: 0, engine2: 0 } });
      const owner = await fresh('owner1');
      const on = await owner.req('PUT', '/panel-settings/workflows', {
        values: { 'workflow.engineV2': true, 'workflow.engineV2ForV1': true },
      });
      expect(on.statusCode, on.body).toBe(200);
      expect(h.app.workflows.engineFlags).toEqual({ v2: true, v2ForV1: true });
    });

    it('maintenance: a dry run first, the real run after it, one job of a kind at a time, cancel, interrupted', async () => {
      const owner = await fresh('owner1');
      expect((await users.viewer1?.client.req('GET', '/maintenance/jobs'))?.statusCode).toBe(403);
      expect(
        (await owner.req('POST', '/maintenance/jobs', { kind: 'search-backfill', dryRun: true })).json(),
      ).toMatchObject({ error: 'maintenance_unavailable' });
      const real = await owner.req('POST', '/maintenance/jobs', {
        kind: 'blobs-migrate',
        params: { mode: 'to-store', kinds: ['artifact'] },
        dryRun: false,
      });
      expect(real.json()).toMatchObject({ error: 'maintenance_dry_run_required' });
      const dry = await owner.req('POST', '/maintenance/jobs', {
        kind: 'blobs-migrate',
        params: { mode: 'to-store', kinds: ['artifact'] },
        dryRun: true,
      });
      expect(dry.statusCode, dry.body).toBe(200);
      const dj = await job(owner, dry.json<Job>().id);
      expect(dj).toMatchObject({ state: 'done', dryRun: true, error: null });
      expect(dj.report).toEqual([expect.objectContaining({ kind: 'artifact', candidates: 0, moved: 0 })]);
      const go = await owner.req('POST', '/maintenance/jobs', {
        kind: 'blobs-migrate',
        params: { kinds: ['artifact'], mode: 'to-store' },
        dryRun: false,
      });
      expect(go.statusCode, go.body).toBe(200);
      expect((await job(owner, go.json<Job>().id)).state).toBe('done');
      // One at a time per kind; a running job can be cancelled; a job whose master stopped is failed "interrupted".
      const id = '11111111-1111-4111-8111-111111111111';
      await h.db.pool.query(
        `INSERT INTO maintenance_jobs (id, kind, params, dry_run, state, started_at, heartbeat_at)
       VALUES ($1, 'memory-autolearn', '{}', true, 'running', $2, $2)`,
        [id, h.clock.now()],
      );
      expect(
        (await owner.req('POST', '/maintenance/jobs', { kind: 'memory-autolearn', dryRun: true })).json(),
      ).toMatchObject({ error: 'maintenance_running' });
      const c = await owner.req('POST', `/maintenance/jobs/${id}/cancel`);
      expect(c.statusCode, c.body).toBe(200);
      const row = await h.db.pool.query<{ cancel_requested: boolean }>(
        'SELECT cancel_requested FROM maintenance_jobs WHERE id = $1',
        [id],
      );
      expect(row.rows[0]?.cancel_requested).toBe(true);
      h.clock.advance(3 * 60_000);
      await h.app.maintenance.tick();
      expect((await owner.req('GET', `/maintenance/jobs/${id}`)).json()).toMatchObject({
        state: 'failed',
        error: 'interrupted: the master that ran it stopped',
      });
      const audit = await h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'maintenance.%' ORDER BY id",
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'maintenance.blobs-migrate.start',
          'maintenance.blobs-migrate.done',
          'maintenance.cancel',
          'maintenance.memory-autolearn.failed',
        ]),
      );
    });
  },
);
