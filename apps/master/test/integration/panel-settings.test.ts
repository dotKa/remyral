import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/notifications/webhook.js';
import { LogSink } from '../../src/system/logs.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeSmtpServer, TEST_CERT } from '../helpers/fake-smtp.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const LOGS = { retentionDays: 7, minLevel: 'info', requests: 'problems', maxRows: 100_000 } as const;
const ENV_WEBHOOK_SECRET = 'env-webhook-secret-0123456789-abcdefghijklmnop';

interface Field {
  key: string;
  value: unknown;
  envValue: unknown;
  source: 'panel' | 'env';
  secretSet: boolean;
  restart: boolean;
}
interface Section {
  section: string;
  version: number;
  fields: Field[];
  info: Record<string, unknown>;
  generated?: Record<string, string>;
}

/**
 * p17-panel-settings (docs/design/p17-panel-settings.md §3–§7) against a real master: the master-stored settings over
 * the environment — precedence, validation, secrets (write-only, generated ones shown once), audit and history, authz
 * and step-up, and the consumers that read them at use time (webhook / push / SMTP channels, sessions, network,
 * workflows, logs, search).
 */
describeIntegration('p17-panel-settings: settings from the panel (integration)', { timeout: 60_000 }, () => {
  const h = new Harness();
  const smtp = new FakeSmtpServer({ mode: 'starttls' });
  let smtpPort = 0;
  let owner: Client;
  let ownerSecret: string;
  let admin: Client;
  let viewer: Client;
  const hooks: { url: string; headers: Record<string, string>; body: string }[] = [];

  const stepUp = async () => {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  };
  const section = async (name: string): Promise<Section> => {
    const r = await owner.req('GET', `/panel-settings/${name}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Section>();
  };
  const field = (s: Section, key: string): Field => {
    const f = s.fields.find((x) => x.key === key);
    if (f === undefined) throw new Error(`no field ${key}`);
    return f;
  };
  const save = (name: string, body: Record<string, unknown>, c: Client = owner, headers = {}) =>
    c.req('PUT', `/panel-settings/${name}`, body, headers);

  beforeAll(async () => {
    smtpPort = await smtp.start();
    await h.start({
      notifications: {
        webhookTestSeams: {
          fetchImpl: (url: string | URL | Request, init?: RequestInit) => {
            hooks.push({
              url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              body: typeof init?.body === 'string' ? init.body : '',
            });
            return Promise.resolve(new Response(null, { status: 204 }));
          },
        },
      },
      doctor: { smtpCa: TEST_CERT },
      panelEnv: {
        values: { 'notify.webhook.allowlist': ['https://env-hooks.example.com/r/'] },
        secrets: { 'notify.webhook.secret': ENV_WEBHOOK_SECRET },
      },
      observability: { logSink: new LogSink(LOGS), logStore: LOGS },
    });
    await h.createUser('owner1', PW, 'owner');
    ({ client: owner, secret: ownerSecret } = await enroll(h, 'owner1', PW));
    await h.createUser('admin1', PW, 'admin');
    ({ client: admin } = await enroll(h, 'admin1', PW));
    await h.createUser('viewer1', PW, 'viewer');
    ({ client: viewer } = await enroll(h, 'viewer1', PW));
  });
  afterAll(async () => {
    await h.stop();
    await smtp.stop();
  });
  beforeEach(() => {
    h.clock.advance(1_000);
  });

  it('views: the environment value and its source; secrets only as "set"; admins read, viewers do not', async () => {
    const n = await section('notifications');
    expect(field(n, 'notify.webhook.allowlist')).toMatchObject({
      value: ['https://env-hooks.example.com/r/'],
      envValue: ['https://env-hooks.example.com/r/'],
      source: 'env',
    });
    const secret = field(n, 'notify.webhook.secret');
    expect(secret).toMatchObject({ value: null, envValue: null, secretSet: true, source: 'env' });
    expect(JSON.stringify(n)).not.toContain(ENV_WEBHOOK_SECRET);
    // The rotation's next secret is managed by its own flow, never in the section.
    expect(n.fields.some((f) => f.key === 'notify.webhook.nextSecret')).toBe(false);
    expect((await admin.req('GET', '/panel-settings/logs')).statusCode).toBe(200);
    expect((await viewer.req('GET', '/panel-settings/logs')).statusCode).toBe(403);
    expect((await owner.req('GET', '/panel-settings/nothing')).statusCode).toBe(404);
  });

  it('saves: owners only, step-up, validation per key and across the section, stale versions refused', async () => {
    expect((await save('logs', { values: { 'logs.retentionDays': 3 } }, admin)).statusCode).toBe(403);
    h.clock.advance(11 * 60_000); // past the step-up window of the sign-in
    const noCode = await save('logs', { values: { 'logs.retentionDays': 3 } });
    expect(noCode.statusCode).toBe(403);
    expect(noCode.json()).toMatchObject({ error: 'step_up_required' });
    await stepUp();
    const bad = await save('logs', { values: { 'logs.retentionDays': 500 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_panel_setting' });
    expect((await save('logs', { values: { 'search.http.url': 'x' } })).statusCode).toBe(400);
    expect(
      (
        await save('workflows', { values: { 'workflow.engineV2ForV1': true, 'workflow.engineV2': false } })
      ).json(),
    ).toMatchObject({ error: 'invalid_panel_setting' });
    const v = (await section('logs')).version;
    expect((await save('logs', { values: { 'logs.level': 'warn' }, version: v + 5 })).statusCode).toBe(409);
  });

  it('precedence: a panel value wins, null returns to the environment; history and audit keep non-secret values', async () => {
    await stepUp();
    const r = await save('logs', { values: { 'logs.retentionDays': 3, 'logs.level': 'warn' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(field(r.json<Section>(), 'logs.retentionDays')).toMatchObject({
      value: 3,
      envValue: 7,
      source: 'panel',
    });
    // Applied without a restart: the log store's configuration follows.
    expect(h.app.logStore?.config).toMatchObject({ retentionDays: 3, minLevel: 'warn' });
    const back = await save('logs', { values: { 'logs.retentionDays': null, 'logs.level': null } });
    expect(field(back.json<Section>(), 'logs.retentionDays')).toMatchObject({ value: 7, source: 'env' });
    expect(h.app.logStore?.config).toMatchObject({ retentionDays: 7, minLevel: 'info' });
    const hist = (await owner.req('GET', '/panel-settings/history')).json<{
      items: { section: string; changes: Record<string, unknown> }[];
    }>();
    expect(hist.items.find((i) => i.section === 'logs')?.changes).toMatchObject({
      'logs.retentionDays': { from: 3, to: null },
    });
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'settings.panel.update' ORDER BY id",
    );
    expect(audit.rows.at(-1)?.metadata).toMatchObject({
      section: 'logs',
      keys: ['logs.retentionDays', 'logs.level'],
    });
  });

  it('webhook: a generated HMAC secret is shown once, signs deliveries, and is never readable again', async () => {
    await stepUp();
    const r = await save('notifications', {
      values: { 'notify.webhook.allowlist': ['https://hooks.example.com/r/'] },
      generate: ['notify.webhook.secret'],
    });
    expect(r.statusCode, r.body).toBe(200);
    const shown = r.json<Section>().generated?.['notify.webhook.secret'] ?? '';
    expect(shown.length).toBeGreaterThanOrEqual(48);
    const again = await section('notifications');
    expect(JSON.stringify(again)).not.toContain(shown);
    expect(field(again, 'notify.webhook.secret')).toMatchObject({ secretSet: true, source: 'panel' });
    const row = await h.db.pool.query<{ sealed: Buffer }>(
      "SELECT sealed FROM panel_settings WHERE key = 'notify.webhook.secret'",
    );
    expect(row.rows[0]?.sealed.toString('latin1')).not.toContain(shown);
    const audit = await h.db.pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE action = 'settings.panel.update'",
    );
    expect(JSON.stringify(audit.rows)).not.toContain(shown);
    // The allowlist applies at once: a URL on the new list is accepted, the environment's one is not any more.
    h.clock.advance(30_000);
    const ok = await owner.req('PUT', '/notifications/preferences', {
      webhookUrl: 'https://hooks.example.com/r/owner',
      kinds: [{ kind: 'alert', webhook: true }],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      (
        await owner.req('PUT', '/notifications/preferences', {
          webhookUrl: 'https://env-hooks.example.com/r/x',
        })
      ).statusCode,
    ).toBe(400);
    const ownerId = (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner1'"))
      .rows[0]?.id;
    await h.app.notifications.notify(h.db.pool, [ownerId ?? ''], {
      kind: 'alert',
      severity: 'info',
      title: 'Hello',
      body: 'Body',
      link: null,
      dedupeKey: 'panel-webhook-1',
    });
    await h.app.notifications.runOnce();
    const sent = hooks.at(-1);
    expect(sent?.url).toBe('https://hooks.example.com/r/owner');
    expect(
      verifyWebhookSignature(
        Buffer.from(shown, 'utf8'),
        sent?.headers['x-remyral-signature'] ?? '',
        sent?.body ?? '',
        Math.floor(h.clock.now().getTime() / 1000),
      ),
    ).toBe(true);
    // A webhook allowlist without any secret is refused.
    await stepUp();
    const typed = await save('notifications', { secrets: { 'notify.webhook.secret': 'short' } });
    expect(typed.statusCode).toBe(400);
  });

  it('push: the master generates the VAPID key pair; the public key is served; a key change asks first', async () => {
    await stepUp();
    expect((await owner.req('GET', '/notifications/push')).json()).toMatchObject({ available: false });
    const r = await save('notifications', {
      values: { 'push.subject': 'mailto:ops@example.com' },
      generate: ['push.vapidKey'],
    });
    expect(r.statusCode, r.body).toBe(200);
    const pub = r.json<Section>().generated?.['push.vapidKey'] ?? '';
    expect(pub).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(JSON.stringify(await section('notifications'))).not.toContain('PRIVATE KEY');
    const push = (await owner.req('GET', '/notifications/push')).json<{
      available: boolean;
      publicKey: string;
    }>();
    expect(push).toMatchObject({ available: true, publicKey: pub });
    // With a subscribed browser, a new key needs the owner's confirmation; then the subscriptions go.
    const ownerId = (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner1'"))
      .rows[0]?.id;
    await h.db.pool.query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_sealed, label, created_at, last_seen_at)
       VALUES (gen_random_uuid(), $1, 'https://fcm.googleapis.com/fcm/send/abc', $3, 'test', $2, $2)`,
      [ownerId, h.clock.now(), Buffer.alloc(64, 1)],
    );
    await stepUp();
    const ask = await save('notifications', { generate: ['push.vapidKey'] });
    expect(ask.statusCode).toBe(409);
    expect(ask.json()).toMatchObject({ error: 'push_key_change', details: { devices: 1 } });
    const done = await save('notifications', { generate: ['push.vapidKey'], confirm: ['push_resubscribe'] });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<Section>().generated?.['push.vapidKey']).not.toBe(pub);
    expect((await h.db.pool.query('SELECT 1 FROM push_subscriptions')).rowCount).toBe(0);
  });

  it('SMTP: one configuration (the support SMTP) for notifications and support; a test send', async () => {
    const none = (await owner.req('GET', '/panel-settings/mail')).json<Record<string, unknown>>();
    expect(none).toMatchObject({ source: 'none' });
    await stepUp();
    const put = await owner.req('PUT', '/support/settings', {
      smtp: {
        host: 'localhost',
        port: smtpPort,
        security: 'starttls',
        from: 'remyral@example.com',
        username: 'mailer',
        password: 'smtp-pass-123456',
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    const mail = await owner.req('GET', '/panel-settings/mail');
    expect(mail.json()).toMatchObject({ source: 'panel', host: 'localhost', passwordSet: true });
    expect(mail.body).not.toContain('smtp-pass-123456');
    // The e-mail channel is available without a restart.
    expect(h.app.notifications.channelAvailable('email')).toBe(true);
    const test = await owner.req('POST', '/panel-settings/mail/test', { to: 'owner@example.com' });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, source: 'panel' });
    expect(smtp.messages.at(-1)?.to).toEqual(['owner@example.com']);
    expect(smtp.messages.at(-1)?.auth).toEqual({ username: 'mailer', password: 'smtp-pass-123456' });
  });

  it('sessions and workers: remember-me / trusted-device days and the rotation approval apply at once', async () => {
    expect((await owner.req('GET', '/auth/options')).json()).toMatchObject({
      rememberMe: { idleDays: 7, absoluteDays: 30 },
      trustedDevice: { days: 30 },
    });
    await stepUp();
    expect(
      (
        await save('sessions', { values: { 'auth.rememberIdleDays': 40, 'auth.rememberAbsoluteDays': 30 } })
      ).json(),
    ).toMatchObject({ error: 'invalid_panel_setting' });
    const r = await save('sessions', {
      values: {
        'auth.rememberIdleDays': 3,
        'auth.rememberAbsoluteDays': 14,
        'auth.trustedDeviceDays': 0,
        'workers.rotationApproval': true,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await owner.req('GET', '/auth/options')).json()).toEqual({
      rememberMe: { idleDays: 3, absoluteDays: 14 },
      trustedDevice: null,
    });
    expect(h.app.panelSettings.get('workers.rotationApproval', false)).toBe(true);
  });

  it('network: the detected client IP is shown; a change that moves this request to another IP needs confirmation', async () => {
    const n = await section('network');
    expect(n.info).toMatchObject({ clientIp: '198.51.100.10' });
    await stepUp();
    expect(
      (await save('network', { values: { 'net.clientIpHeader': 'cf-connecting-ip' } })).json(),
    ).toMatchObject({ error: 'invalid_panel_setting' });
    expect((await save('network', { values: { 'net.clientIpSources': ['300.1.1.1/8'] } })).statusCode).toBe(
      400,
    );
    const xff = { 'x-forwarded-for': '203.0.113.5' };
    const ask = await save('network', { values: { 'net.trustProxyHops': 1 } }, owner, xff);
    expect(ask.statusCode).toBe(409);
    expect(ask.json()).toMatchObject({
      error: 'client_ip_would_change',
      details: { current: '198.51.100.10', after: '203.0.113.5' },
    });
    const ok = await save(
      'network',
      { values: { 'net.trustProxyHops': 1 }, confirm: ['client_ip_change'] },
      owner,
      xff,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    // From now on the forwarded address is the client IP (no restart).
    const after = (await owner.req('GET', '/panel-settings/network', undefined, xff)).json<Section>();
    expect(after.info).toMatchObject({ clientIp: '203.0.113.5' });
    await stepUp();
    expect(
      (
        await save(
          'network',
          { values: { 'net.trustProxyHops': null }, confirm: ['client_ip_change'] },
          owner,
          xff,
        )
      ).statusCode,
    ).toBe(200);
  });

  it('workflows and ops: engine-2 flags and the Coolify protection lists are read at use time', async () => {
    expect(h.app.workflows.engineFlags).toEqual({ v2: false, v2ForV1: false });
    await stepUp();
    const r = await save('workflows', { values: { 'workflow.engineV2': true } });
    expect(r.statusCode, r.body).toBe(200);
    expect(h.app.workflows.engineFlags).toEqual({ v2: true, v2ForV1: false });
    const ops = await save('ops', {
      values: { 'ops.internalOrigins': ['http://coolify:8000'], 'ops.controlPlaneUuids': ['abc123'] },
    });
    expect(ops.statusCode, ops.body).toBe(200);
    expect(field(ops.json<Section>(), 'ops.internalOrigins')).toMatchObject({
      value: ['http://coolify:8000'],
      source: 'panel',
    });
    expect((await save('ops', { values: { 'ops.internalOrigins': ['ftp://x'] } })).statusCode).toBe(400);
  });

  it('search: the HTTP embedding provider from the panel (all three or nothing), next to Bedrock', async () => {
    expect((await h.app.semanticSearch.providerInfo()).available).toBe(false);
    await stepUp();
    const missing = await save('search', { values: { 'search.provider': 'http' } });
    expect(missing.json()).toMatchObject({ error: 'invalid_panel_setting' });
    const r = await save('search', {
      values: {
        'search.provider': 'http',
        'search.http.url': 'http://127.0.0.1:9/v1/embeddings',
        'search.http.model': 'test-embed',
        'search.http.dimensions': 8,
      },
      secrets: { 'search.http.key': 'sk-test-0123456789' },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain('sk-test-0123456789');
    expect(await h.app.semanticSearch.providerInfo()).toMatchObject({
      available: true,
      provider: 'http',
      model: 'http:test-embed:8',
      source: 'panel',
    });
    // Back to the environment (none here): no provider.
    await stepUp();
    await save('search', {
      values: { 'search.provider': null, 'search.http.url': null, 'search.http.model': null },
      secrets: { 'search.http.key': null },
    });
    expect((await h.app.semanticSearch.providerInfo()).available).toBe(false);
  });

  it('another instance picks a save up on its tick (version check)', async () => {
    await h.db.pool.query(
      `INSERT INTO panel_settings (key, value, updated_at) VALUES ('jobs.loginWaitMinutes', '45', now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await h.db.pool.query('UPDATE panel_settings_state SET version = version + 1');
    expect(h.app.panelSettings.get('jobs.loginWaitMinutes', 0)).not.toBe(45);
    await h.app.panelSettings.tick();
    expect(h.app.panelSettings.get('jobs.loginWaitMinutes', 0)).toBe(45);
  });
});

describe('p17-panel-settings: live adapters (unit)', () => {
  it('LiveSet and liveList follow the current value', async () => {
    const { LiveSet, liveList } = await import('../../src/panel-settings/consumers.js');
    let v: readonly string[] = ['a'];
    const set = new LiveSet(() => v);
    const list = liveList(() => v);
    expect(set.has('a')).toBe(true);
    expect([...list]).toEqual(['a']);
    v = ['b', 'c'];
    expect(set.has('a')).toBe(false);
    expect(set.size).toBe(2);
    expect(list.length).toBe(2);
    expect(list.map((x) => x.toUpperCase())).toEqual(['B', 'C']);
    expect(list.includes('c')).toBe(true);
  });
});
