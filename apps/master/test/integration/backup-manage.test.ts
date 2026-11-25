import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { reasonSlug } from '../../src/backups/manage.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeS3 } from '../helpers/fake-s3.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import type { Notifier, OutboundMessage } from '../../src/notifications/notifier.js';

const PW = 'quartz-meadow-lantern-7';
const keys = generateKeyPairSync('ed25519');
const signer = new LeaseSigner(keys.privateKey);
const KEY = { accessKeyId: 'AKIABACKUP1234', secretAccessKey: 'backup-secret-0123456789abcdef' };
const R1 = `age1${'q'.repeat(58)}`;
const R2 = `age1${'p'.repeat(58)}`;
const BACKUP = 'remana-prod-20261012T023000Z';

interface Action {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly params: Record<string, unknown>;
}

/**
 * p17-host-actions part 3 against a real master (Postgres, Redis, migrations 0160–0161): backups from Ayarlar →
 * Yedekler — owners only, requests for the host applier (run with the owner's reason, drill, schedule / retention /
 * WAL / recipients, restore with typed confirmation and always-fresh step-up), the off-site target tested with the
 * storage round trip, stored sealed and handed to the host (the keys never in a response, the audit or the database
 * in clear), and the state without an applier.
 */
describeIntegration('p17-host-actions: backups from the console (integration)', { timeout: 60_000 }, () => {
  const h = new Harness();
  // An e-mail channel that only records (the owner never opts in: the time-lock notice is mandatory by e-mail).
  const mails: { message: OutboundMessage; to: string }[] = [];
  const mailer: Notifier = {
    channel: 'email',
    acceptsTarget: () => true,
    send: (message, to) => {
      mails.push({ message, to });
      return Promise.resolve();
    },
  };
  const s3 = new FakeS3({ bucket: 'remyral-backups', ...KEY });
  let hostDir: string;
  let statusDir: string;
  let owner: Client;
  let ownerSecret: string;
  let admin: Client;
  let adminSecret: string;

  const stepUp = async () => {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  };
  const heartbeat = async (backupExtra: Record<string, unknown> = {}) => {
    await writeFile(
      join(hostDir, 'status/applier.json'),
      `${JSON.stringify(
        {
          kind: 'remyral-host-applier/v1',
          version: '1.1.0',
          at: h.clock.now().toISOString(),
          domain: 'console.example.com',
          tls: 'letsencrypt',
          acmeEmail: '',
          httpsPort: '',
          addresses: [],
          kinds: [
            'domain-change',
            'upgrade',
            'rollback',
            'backup-run',
            'backup-drill',
            'backup-restore',
            'backup-config',
            'backup-offsite',
            'backup-change-cancel',
          ],
          current: '1.1.0',
          previous: '',
          releases: ['1.1.0'],
          backup: {
            BACKUP_TIME: '02:30',
            BACKUP_INTERVAL_MINUTES: '',
            BACKUP_KEEP_DAILY: '',
            BACKUP_KEEP_WEEKLY: '',
            BACKUP_KEEP_MONTHLY: '',
            BACKUP_KEEP_RECENT_HOURS: '',
            BACKUP_DRILL_ENABLED: '',
            BACKUP_DRILL_WEEKDAY: '',
            BACKUP_DRILL_TIME: '',
            PG_WAL_ARCHIVE: 'off',
            recipients: [R1],
            offsite: '',
            ...backupExtra,
          },
        },
        null,
        2,
      )}\n`,
    );
  };
  /** The host finishes the open request (applied). */
  const finish = async (kind: string, id: string, state = 'applied') => {
    await writeFile(
      join(hostDir, `status/${kind}-result.json`),
      `${JSON.stringify({
        kind: 'remyral-host-result/v1',
        request: kind,
        id,
        state,
        step: '',
        detail: 'done',
        at: `${h.clock.now().toISOString().slice(0, 19)}Z`,
        log: [],
      })}\n`,
    );
    await h.app.hostActions.tick();
  };
  const request = async (kind: string) =>
    JSON.parse(await readFile(join(hostDir, `requests/${kind}.json`), 'utf8')) as Record<string, string>;
  const auditOf = async (action: string) =>
    (
      await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        'SELECT metadata FROM audit_events WHERE action = $1 ORDER BY id',
        [action],
      )
    ).rows;
  const offsiteBody = (over: Record<string, unknown> = {}) => ({
    provider: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'remyral-backups',
    prefix: 'acme/prod',
    pathStyle: true,
    ...over,
  });

  beforeAll(async () => {
    await s3.start();
    hostDir = await mkdtemp(join(tmpdir(), 'remyral-host-'));
    statusDir = await mkdtemp(join(tmpdir(), 'remyral-backup-status-'));
    await mkdir(join(hostDir, 'requests'));
    await mkdir(join(hostDir, 'status'));
    const iso = (ms: number) => new Date(Date.parse('2026-10-12T12:00:00.000Z') - ms).toISOString();
    await writeFile(
      join(statusDir, 'status.json'),
      JSON.stringify({
        format: 'remana-backup-status/v1',
        env: 'prod',
        updatedAt: iso(0),
        lastBackup: null,
        lastSuccessfulBackup: null,
        backups: [
          {
            runId: BACKUP,
            reason: 'scheduled',
            startedAt: iso(10 * 3_600_000),
            finishedAt: iso(10 * 3_600_000 - 4000),
            durationMs: 4000,
            outcome: 'ok',
            tier: 'daily',
            schemaVersion: '0161',
            dbBytes: 1024,
            dbSha256: 'a'.repeat(64),
            secrets: 'ok',
            offsite: { status: 'not_configured', target: null, error: null },
            warnings: [],
            error: null,
          },
        ],
        lastDrill: null,
        lastSuccessfulDrill: null,
        drills: [],
      }),
    );
    await h.start({
      orchestration: { tickIntervalMs: 0, signer },
      consoleDomain: { hostDir },
      backups: { statusDir },
      notifications: { notifiers: [mailer] },
    });
    await h.createUser('owner1', PW, 'owner');
    ({ client: owner, secret: ownerSecret } = await enroll(h, 'owner1', PW));
    await h.createUser('admin1', PW, 'admin');
    ({ client: admin, secret: adminSecret } = await enroll(h, 'admin1', PW));
  });
  afterAll(async () => {
    await h.stop();
    await s3.stop();
    await rm(hostDir, { recursive: true, force: true });
    await rm(statusDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    h.clock.advance(1_000);
    await rm(join(hostDir, 'status/applier.json'), { force: true });
  });

  it('the reason slug the host gets', () => {
    expect(reasonSlug('Göç öncesi yedek!')).toBe('goc-oncesi-yedek');
    expect(reasonSlug('   ')).toBe('manual');
    expect(reasonSlug('x'.repeat(80))).toHaveLength(40);
  });

  it('without a host applier: management says so, and requests are refused; owners only', async () => {
    const r = await owner.req('GET', '/backups/manage');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ applier: { managed: false }, settings: null, open: null });
    expect((await admin.req('GET', '/backups/manage')).statusCode).toBe(403);
    expect((await admin.req('POST', '/backups/run', { reason: 'x' })).statusCode).toBe(403);
    await stepUp();
    const run = await owner.req('POST', '/backups/run', { reason: 'before the update' });
    expect(run.statusCode).toBe(503);
    expect(run.json()).toMatchObject({ error: 'host_applier_unavailable' });
  });

  it('backup now (the reason in the audit trail) and a drill: signed requests of their own kind', async () => {
    await heartbeat();
    await stepUp();
    const r = await owner.req('POST', '/backups/run', { reason: 'Göç öncesi yedek' });
    expect(r.statusCode).toBe(200);
    const a = r.json<Action>();
    expect(a).toMatchObject({
      kind: 'backup-run',
      params: { reason: 'Göç öncesi yedek', hostReason: 'panel-goc-oncesi-yedek' },
    });
    const bytes = await readFile(join(hostDir, 'requests/backup-run.json'));
    const sig = JSON.parse(await readFile(join(hostDir, 'requests/backup-run.sig.json'), 'utf8')) as {
      signature: string;
    };
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from('remyral-host-backup-run/v1\n'), bytes]),
        createPublicKey(keys.privateKey),
        Buffer.from(sig.signature, 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ reason: 'panel-goc-oncesi-yedek' });
    expect((await auditOf('host.backup-run.request'))[0]?.metadata).toMatchObject({
      reason: 'Göç öncesi yedek',
    });
    await finish('backup-run', a.id);
    await heartbeat();
    const unknown = await owner.req('POST', '/backups/drill', { backupId: 'remana-prod-20261011T023000Z' });
    expect(unknown.json()).toMatchObject({ error: 'backup_not_found' });
    const d = (await owner.req('POST', '/backups/drill', { backupId: BACKUP })).json<Action>();
    expect(await request('backup-drill')).toMatchObject({
      kind: 'remyral-host-backup-drill/v1',
      backupId: BACKUP,
    });
    await finish('backup-drill', d.id);
  });

  it('settings: at least two recipients; everything else within the runner rules; the host applies them', async () => {
    await heartbeat();
    const view = (await owner.req('GET', '/backups/manage')).json<{ settings: Record<string, unknown> }>();
    expect(view.settings).toMatchObject({ time: '02:30', walArchive: 'off', recipients: [R1] });
    await stepUp();
    const body = {
      time: '03:15',
      intervalMinutes: null,
      keepDaily: 10,
      keepWeekly: 6,
      keepMonthly: 12,
      keepRecentHours: null,
      drillEnabled: true,
      drillWeekday: 'sat',
      drillTime: '05:00',
      walArchive: true,
      recipients: [R1],
    };
    const few = await owner.req('PUT', '/backups/settings', body);
    expect(few.statusCode).toBe(400);
    expect(few.json()).toMatchObject({ error: 'backup_recipients_too_few' });
    const secretKey = await owner.req('PUT', '/backups/settings', {
      ...body,
      recipients: [R1, 'AGE-SECRET-KEY-1QQQQQQ'],
    });
    expect(secretKey.json()).toMatchObject({ error: 'invalid_backup_settings' });
    const nothing = await owner.req('PUT', '/backups/settings', {
      ...body,
      keepDaily: 0,
      keepWeekly: 0,
      keepMonthly: 0,
      recipients: [R1, R2],
    });
    expect(nothing.json()).toMatchObject({ error: 'invalid_backup_settings' });
    expect(
      (await owner.req('PUT', '/backups/settings', { ...body, time: '25:00', recipients: [R1, R2] }))
        .statusCode,
    ).toBe(400);
    const ok = await owner.req('PUT', '/backups/settings', { ...body, recipients: [R1, R2, R2] });
    expect(ok.statusCode).toBe(200);
    const a = ok.json<Action>();
    expect(await request('backup-config')).toMatchObject({
      time: '03:15',
      intervalMinutes: '',
      keepDaily: '10',
      drillEnabled: 'true',
      drillWeekday: 'sat',
      walArchive: 'on',
      recipients: `${R1},${R2}`,
    });
    expect(a.params).toMatchObject({ recipients: 2, walArchive: 'on' });
    await finish('backup-config', a.id);
  });

  it('restore: a known backup, the id typed again, and a fresh authenticator code', async () => {
    await heartbeat();
    await stepUp();
    expect(
      (
        await owner.req('POST', '/backups/restore', {
          backupId: BACKUP,
          confirm: 'remana-prod-20261012T023001Z',
        })
      ).json(),
    ).toMatchObject({ error: 'restore_confirmation_required' });
    expect(
      (
        await owner.req('POST', '/backups/restore', {
          backupId: 'remana-prod-20261011T023000Z',
          confirm: 'remana-prod-20261011T023000Z',
        })
      ).json(),
    ).toMatchObject({ error: 'backup_not_found' });
    const r = await owner.req('POST', '/backups/restore', { backupId: BACKUP, confirm: BACKUP });
    expect(r.statusCode).toBe(200);
    const a = r.json<Action>();
    expect(await request('backup-restore')).toMatchObject({ backupId: BACKUP, restoreDatabase: 'yes' });
    expect(a.params).toMatchObject({ backupId: BACKUP, backupSchema: '0161' });
    await finish('backup-restore', a.id);
    h.clock.advance(11 * 60_000);
    await heartbeat();
    const stale = await owner.req('POST', '/backups/restore', { backupId: BACKUP, confirm: BACKUP });
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up_required');
  });

  it('off-site: tested, sealed, handed to the host; the keys never come back', async () => {
    await heartbeat();
    await stepUp();
    const bad = await owner.req(
      'POST',
      '/backups/offsite/test',
      offsiteBody({ accessKeyId: 'AKIAWRONG000', secretAccessKey: 'wrong-secret-123456' }),
    );
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toMatchObject({ ok: false });
    const refused = await owner.req(
      'PUT',
      '/backups/offsite',
      offsiteBody({ accessKeyId: 'AKIAWRONG000', secretAccessKey: 'wrong-secret-123456' }),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'offsite_test_failed', result: { ok: false } });
    expect((await h.db.pool.query('SELECT 1 FROM backup_offsite_settings')).rowCount).toBe(0);
    expect((await owner.req('PUT', '/backups/offsite', offsiteBody())).json()).toMatchObject({
      error: 'offsite_keys_required',
    });
    expect(
      (
        await owner.req(
          'PUT',
          '/backups/offsite',
          offsiteBody({ ...KEY, secretAccessKey: 'has"quote\\backslash' }),
        )
      ).json(),
    ).toMatchObject({ error: 'invalid_offsite' });
    const saved = await owner.req('PUT', '/backups/offsite', offsiteBody(KEY));
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(KEY.secretAccessKey);
    const out = saved.json<{ test: { ok: boolean }; request: Action }>();
    expect(out.test.ok).toBe(true);
    expect(out.request).toMatchObject({
      kind: 'backup-offsite',
      params: { mode: 'set', bucket: 'remyral-backups' },
    });
    expect(JSON.stringify(out.request.params)).not.toContain(KEY.secretAccessKey);
    // The host request carries the keys (0600, the master-only requests directory) …
    expect(await request('backup-offsite')).toMatchObject({
      mode: 'set',
      endpoint: s3.url,
      prefix: 'acme/prod',
      pathStyle: 'true',
      accessKeyId: KEY.accessKeyId,
      secretAccessKey: KEY.secretAccessKey,
    });
    // … nothing else does: the view, the audit trail, the stored row.
    const view = await owner.req('GET', '/backups/manage');
    expect(view.body).not.toContain(KEY.secretAccessKey);
    expect(view.json()).toMatchObject({
      offsite: { config: { bucket: 'remyral-backups', prefix: 'acme/prod' }, keyIdHint: '1234' },
    });
    const audit = await auditOf('backups.offsite.set');
    expect(JSON.stringify(audit)).not.toContain(KEY.secretAccessKey);
    const row = await h.db.pool.query<{ secret: Buffer }>('SELECT secret FROM backup_offsite_settings');
    expect(row.rows[0]?.secret.toString('latin1')).not.toContain(KEY.secretAccessKey);
    await finish('backup-offsite', out.request.id);
    // Saving again without keys reuses the sealed ones.
    await heartbeat();
    const again = await owner.req('PUT', '/backups/offsite', offsiteBody({ prefix: 'acme/prod2' }));
    expect(again.statusCode).toBe(200);
    expect(await request('backup-offsite')).toMatchObject({
      prefix: 'acme/prod2',
      secretAccessKey: KEY.secretAccessKey,
    });
    await finish('backup-offsite', again.json<{ request: Action }>().request.id);
    await heartbeat();
    const cleared = await owner.req('DELETE', '/backups/offsite');
    expect(cleared.statusCode).toBe(200);
    expect(await request('backup-offsite')).toMatchObject({ mode: 'clear', secretAccessKey: '' });
    expect((await h.db.pool.query('SELECT 1 FROM backup_offsite_settings')).rowCount).toBe(0);
    expect(existsSync(join(hostDir, 'requests/backup-offsite.json'))).toBe(true);
  });

  it('time lock (p17-panel-settings Part 0): a waiting change is shown, every owner told by e-mail and reminded; cancel withdraws it', async () => {
    const ownerId = (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner1'"))
      .rows[0]?.id;
    expect(ownerId).toBeDefined();
    await h.db.pool.query(
      `INSERT INTO notification_targets (user_id, email, updated_at) VALUES ($1, 'owner@example.com', $2)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email`,
      [ownerId, h.clock.now()],
    );
    const REQ = '6f1c1f0e-6a43-4f38-9e1c-1d7c3cbd0a11';
    const sec = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
    const since = h.clock.now();
    const until = new Date(since.getTime() + 72 * 3_600_000);
    const pending = [
      { change: 'recipients', id: REQ, since: sec(since), until: sec(until), added: [R2], target: '' },
    ];
    await heartbeat({ pending, changes: [] });
    const view = (await owner.req('GET', '/backups/manage')).json<{
      settings: { pending: unknown[] };
    }>();
    expect(view.settings.pending).toEqual([
      { change: 'recipients', id: REQ, since: sec(since), until: sec(until), added: [R2], target: '' },
    ]);
    const list = await owner.req('GET', '/backups/pending-changes');
    expect(list.json()).toEqual({
      items: [
        {
          change: 'recipients',
          requestId: REQ,
          since: sec(since),
          until: sec(until),
          added: [R2],
          target: '',
        },
      ],
    });
    expect((await admin.req('GET', '/backups/pending-changes')).statusCode).toBe(403);

    const notices = async () =>
      (
        await h.db.pool.query<{ id: string; title: string; dedupe_key: string }>(
          `SELECT id, title, dedupe_key FROM notifications WHERE kind = 'backup.change_pending' AND recipient_id = $1
            ORDER BY created_at`,
          [ownerId],
        )
      ).rows;
    await h.app.backupChanges.tick();
    await h.app.backupChanges.tick();
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]?.title).toMatch(/new backup encryption key takes effect/);
    // E-mail although the owner never turned it on for this kind.
    const deliveries = await h.db.pool.query<{ channel: string }>(
      'SELECT channel FROM notification_deliveries WHERE notification_id = $1',
      [(await notices())[0]?.id],
    );
    expect(deliveries.rows.map((r) => r.channel)).toEqual(['email']);
    expect((await auditOf('backups.change.pending'))[0]?.metadata).toMatchObject({
      change: 'recipients',
      added: [R2],
    });
    // The admin (not an owner) is not told.
    expect(
      (
        await h.db.pool.query(
          `SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_id
            WHERE n.kind = 'backup.change_pending' AND u.username = 'admin1'`,
        )
      ).rowCount,
    ).toBe(0);
    // 24 h before it takes effect: one reminder.
    h.clock.advance(47 * 3_600_000);
    await heartbeat({ pending, changes: [] });
    await h.app.backupChanges.tick();
    expect(await notices()).toHaveLength(1);
    h.clock.advance(3_600_000 + 1_000);
    await heartbeat({ pending, changes: [] });
    await h.app.backupChanges.tick();
    await h.app.backupChanges.tick();
    expect((await notices()).map((n) => n.dedupe_key)).toEqual([
      `backup.change_pending:recipients:${sec(since)}`,
      `backup.change_pending:recipients:${sec(since)}:reminder`,
    ]);

    // Two days passed: sign in again.
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    admin = await fullLogin(h, 'admin1', PW, adminSecret);
    await heartbeat({ pending, changes: [] });
    // "İptal et": a signed backup-change-cancel request (owners; no step-up — it can only withdraw).
    expect((await admin.req('POST', '/backups/changes/cancel', { change: 'recipients' })).statusCode).toBe(
      403,
    );
    expect((await owner.req('POST', '/backups/changes/cancel', { change: 'everything' })).statusCode).toBe(
      400,
    );
    const c = await owner.req('POST', '/backups/changes/cancel', { change: 'recipients' });
    expect(c.statusCode).toBe(200);
    const a = c.json<Action>();
    expect(a).toMatchObject({ kind: 'backup-change-cancel', params: { change: 'recipients' } });
    const bytes = await readFile(join(hostDir, 'requests/backup-change-cancel.json'));
    const sig = JSON.parse(
      await readFile(join(hostDir, 'requests/backup-change-cancel.sig.json'), 'utf8'),
    ) as {
      signature: string;
    };
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from('remyral-host-backup-change-cancel/v1\n'), bytes]),
        createPublicKey(keys.privateKey),
        Buffer.from(sig.signature, 'base64url'),
      ),
    ).toBe(true);
    expect(Object.keys(JSON.parse(bytes.toString('utf8')) as object).sort()).toEqual(
      ['change', 'createdAt', 'expiresAt', 'id', 'kind', 'nonce'].sort(),
    );
    await finish('backup-change-cancel', a.id);
    // The host reports the outcome in its heartbeat: the notice is resolved and audited.
    await heartbeat({
      pending: [],
      changes: [{ change: 'recipients', state: 'cancelled', id: REQ, at: sec(h.clock.now()) }],
    });
    await h.app.backupChanges.tick();
    const row = await h.db.pool.query<{ resolved: string }>(
      'SELECT resolved FROM backup_change_notices WHERE request_id = $1',
      [REQ],
    );
    expect(row.rows[0]?.resolved).toBe('cancelled');
    expect(await auditOf('backups.change.cancelled')).toHaveLength(1);

    // A request the host accepted with a part waiting ends as 'scheduled' (final, audited as a success).
    await heartbeat();
    await stepUp();
    const cfg = await owner.req('PUT', '/backups/settings', {
      time: '03:15',
      intervalMinutes: null,
      keepDaily: 10,
      keepWeekly: 6,
      keepMonthly: 12,
      keepRecentHours: null,
      drillEnabled: true,
      drillWeekday: 'sat',
      drillTime: '05:00',
      walArchive: false,
      recipients: [R1, R2],
    });
    const sa = cfg.json<Action>();
    await finish('backup-config', sa.id, 'scheduled');
    const st = (await owner.req('GET', '/backups/manage')).json<{ recent: Action[] }>();
    expect(st.recent.find((x) => x.id === sa.id)?.state).toBe('scheduled');
    const ev = await h.db.pool.query<{ outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action = 'host.backup-config.scheduled'",
    );
    expect(ev.rows.map((r) => r.outcome)).toEqual(['success']);
  });
});
