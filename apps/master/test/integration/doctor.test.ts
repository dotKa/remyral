import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { SupportService } from '../../src/doctor/support.js';
import { LogSink } from '../../src/system/logs.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeSmtpServer, mailHeader, TEST_CERT } from '../helpers/fake-smtp.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p16-doctor (docs/design/p16-doctor.md, ADR-0062) against the real master (Postgres + Redis), a raw protocol worker
 * and a local fake SMTP server (STARTTLS with the test-only certificate):
 *  - checks find seeded problems (a job waiting for an approval with nothing to decide, an offline machine, an expired
 *    API token, a worker clock five minutes behind from its heartbeat);
 *  - the machine doctor (doctor.run → OPS_UPDATE doctor) is redacted and shown;
 *  - the support bundle: sections, unticking, job prompts only on request, every seeded secret absent (raw log rows,
 *    the configuration, the SMTP password, a prompt), download audited;
 *  - the support settings: owner only, the password sealed and never returned;
 *  - sending: attachment + cc + audit (who, to whom, size, sections, hash), the attachment cap (summary only), the
 *    security policy's step-up (event support.report: none in Serbest, a code in Sıkı);
 *  - the daily light run notifies owners and admins only about new (or returning) problems.
 */
const PW = 'harbor-lantern-quartz-41';
const GH = `ghp_${'D'.repeat(36)}`;
const DB_PASSWORD = 'pg-Sup3rS3cret-pass';
const SMTP_PASSWORD = 'smtp-Pa55word-xyz';
const PROMPT_SECRET = `sk-${'z'.repeat(36)}9876`;
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

interface Finding {
  check: string;
  code: string;
  severity: string;
  message: string;
  subject?: string;
  fix?: string;
  params?: Record<string, string | number | boolean>;
}
interface Run {
  id: string;
  summary: { error: number; warning: number };
  findings: Finding[];
  workers: { workerId: string; state: string; report: { findings: Finding[] } | null }[];
  newProblems: number;
}
interface Preview {
  id: string;
  files: { path: string; section: string; bytes: number; sha256: string }[];
  sections: string[];
  sizeBytes: number;
  sha256: string;
  summary: string;
  overCap: boolean;
  recipient: string;
  ccAddress: string | null;
  smtpReady: boolean;
}

/** Reads a zip (local headers; stored or deflated entries). */
function unzip(zip: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let p = 0;
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const method = zip.readUInt16LE(p + 8);
    const size = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extra = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extra;
    const body = zip.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'));
    p = start + size;
  }
  return out;
}

/** The base64 attachment of a captured multipart message. */
function attachment(data: string): Buffer | null {
  const m = /Content-Disposition: attachment; filename="[^"]+"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(
    data,
  );
  return m?.[1] === undefined ? null : Buffer.from(m[1].replace(/\r\n/g, ''), 'base64');
}

describeIntegration('doctor and the support report (integration, p16-doctor)', { timeout: 240_000 }, () => {
  const h = new Harness(Date.now());
  const smtp = new FakeSmtpServer({ mode: 'starttls' });
  const sink = new LogSink({ retentionDays: 7, minLevel: 'info', requests: 'problems', maxRows: 10_000 });
  let smtpPort = 0;
  let owner: Client;
  let admin: Client;
  let viewer: Client;
  let ownerSecret = '';
  let adminSecret = '';
  let ownerId = '';
  let worker: RawWorker;
  let workerId = '';
  let seq = 0;
  const offlineId = `wrk_${'a'.repeat(26)}`;
  let orphanJob = '';

  const stepUp = async (c: Client, secret: string): Promise<void> => {
    h.clock.advance(30_000);
    const r = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(r.statusCode, r.body).toBe(200);
  };
  const runDoctor = async (machines = false): Promise<Run> => {
    const r = await admin.req('POST', '/doctor/runs', { machines });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Run>();
  };
  const find = (run: Run, check: string, code?: string) =>
    run.findings.filter((f) => f.check === check && (code === undefined || f.code === code));

  async function insertJob(
    state: string,
    minutesAgo: number,
    prompt = 'Fix the login page.',
  ): Promise<string> {
    const id = randomUUID();
    const at = new Date(h.clock.now().getTime() - minutesAgo * 60_000);
    await h.db.pool.query(
      `INSERT INTO jobs (id, project, spec, state, created_by_type, created_at, updated_at, state_changed_at)
       VALUES ($1, 'doc-p', $2, $3, 'user', $4, $4, $4)`,
      [id, JSON.stringify({ runtime: 'codex', prompt, title: 'Login fix' }), state, at],
    );
    return id;
  }

  beforeAll(async () => {
    smtpPort = await smtp.start();
    await h.start({
      securityPolicy: { preset: 'serbest' },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      observability: {
        logSink: sink,
        logStore: { retentionDays: 7, minLevel: 'info', requests: 'problems', maxRows: 10_000 },
        statusThresholds: { diskWarn: 101, diskFail: 101 },
      },
      doctor: {
        smtpCa: TEST_CERT,
        smtpTimeoutMs: 10_000,
        config: {
          nodeEnv: 'test',
          port: 3000,
          databaseUrl: `postgres://remyral:${DB_PASSWORD}@db:5432/remyral`,
          redisUrl: `redis://:${DB_PASSWORD}@redis:6379`,
          totpKeyFile: '/run/secrets/totp',
          notifications: {
            intervalMs: 5000,
            publicUrl: 'https://remyral.example.com/path?x=1',
            smtp: { host: 'mail.example.com', port: 587, security: 'starttls', password: SMTP_PASSWORD },
            webhook: null,
            push: null,
          },
          leaseTtlMs: 60_000,
        },
      },
    });
    const url = await h.listen();
    ownerId = await h.createUser('doc-owner', PW, 'owner');
    ({ secret: ownerSecret } = await enroll(h, 'doc-owner', PW));
    owner = await fullLogin(h, 'doc-owner', PW, ownerSecret);
    await h.createUser('doc-admin', PW, 'admin');
    ({ secret: adminSecret } = await enroll(h, 'doc-admin', PW));
    admin = await fullLogin(h, 'doc-admin', PW, adminSecret);
    await h.createUser('doc-viewer', PW, 'viewer');
    const v = await enroll(h, 'doc-viewer', PW);
    viewer = await fullLogin(h, 'doc-viewer', PW, v.secret);
    await h.db.pool.query(
      `INSERT INTO notification_targets (user_id, email, updated_at) VALUES ($1, 'owner@customer.example', now())`,
      [ownerId],
    );

    // A connected machine (raw protocol client) that knows the doctor.
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'DOCT-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp(owner, ownerSecret);
    expect(
      (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'DOCT-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['remote-ops-v1', 'doctor-v1'],
        },
        { workerId },
      ),
    );
    // expect.poll works only inside a test.
    for (let i = 0; i < 100; i++) {
      const f =
        (
          await h.db.pool.query<{ f: string[] }>('SELECT features AS f FROM workers WHERE id = $1', [
            workerId,
          ])
        ).rows[0]?.f ?? [];
      if (f.includes('doctor-v1')) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Seeded problems.
    orphanJob = await insertJob('AWAITING_APPROVAL', 120);
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
       VALUES ($1, 'pi-5', 'offline', '{}', '1.0.0', $2, $2, $2)`,
      [offlineId, new Date(h.clock.now().getTime() - 3_600_000)],
    );
    await h.db.pool.query(
      `INSERT INTO api_tokens (kind, principal_id, name, scopes, hint, secret_hash, expires_at, created_at)
       VALUES ('personal', $1, 'ci-old', '{read}', 'ryl_pat_ab…yz', $2, $3, $4)`,
      [
        ownerId,
        randomBytes(32),
        new Date(h.clock.now().getTime() - 86_400_000),
        new Date(h.clock.now().getTime() - 40 * 86_400_000),
      ],
    );
    // Log lines with secrets that bypassed the capture redaction (written raw): the bundle redacts them again.
    await h.db.pool.query(
      `INSERT INTO master_log_lines (at, level, component, msg, fields) VALUES
         (now(), 50, 'orchestrator', $1, $2), (now(), 40, 'inbox', 'lease about to expire', NULL)`,
      [
        `dispatch failed with ${GH}`,
        JSON.stringify({ password: 'hunter2-hunter2', url: `https://x:${DB_PASSWORD}@h` }),
      ],
    );
    await insertJob('FAILED', 30, `Deploy with key ${PROMPT_SECRET} please`);
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
    await smtp.stop();
  });

  it('permissions: viewers and anonymous callers are refused; admins run; only owners change the settings', async () => {
    expect((await viewer.req('GET', '/doctor')).statusCode).toBe(403);
    expect((await viewer.req('POST', '/support/reports', {})).statusCode).toBe(403);
    const anon = await h.app.inject({ method: 'GET', url: '/doctor' });
    expect(anon.statusCode).toBe(401);
    expect((await admin.req('GET', '/doctor')).statusCode).toBe(200);
    expect((await admin.req('GET', '/support/settings')).statusCode).toBe(200);
    const put = await admin.req('PUT', '/support/settings', { email: 'x@example.com' });
    expect(put.statusCode).toBe(403);
  });

  it('checks find the seeded problems and a worker clock five minutes behind', async () => {
    worker.sendJson(
      worker.envelope(
        'HEARTBEAT',
        {
          state: 'online',
          runningJobs: [],
          load: { cpuPercent: 1, memoryFreeBytes: 1e9, diskFreeBytes: 5e10 },
        },
        { workerId, ts: new Date(h.clock.now().getTime() - 5 * 60_000).toISOString() },
      ),
    );
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ s: number | null }>(
              'SELECT clock_skew_ms AS s FROM workers WHERE id = $1',
              [workerId],
            )
          ).rows[0]?.s ?? 0,
      )
      .toBeGreaterThan(250_000);
    const run = await runDoctor();
    expect(find(run, 'db.reachable', 'ok')).toHaveLength(1);
    expect(find(run, 'db.migrations', 'ok')).toHaveLength(1);
    expect(find(run, 'queue.approval_orphan', 'nothing_to_decide').map((f) => f.subject)).toContain(
      orphanJob,
    );
    expect(find(run, 'workers.offline', 'offline').map((f) => f.subject)).toContain(offlineId);
    const token = find(run, 'expiry', 'expired');
    expect(token.length).toBeGreaterThan(0);
    expect(token[0]?.severity).toBe('error');
    const skew = find(run, 'workers.clock', 'skew');
    expect(skew.map((f) => f.subject)).toContain(workerId);
    expect(skew[0]?.severity).toBe('error');
    // Worst first; the stored run is the same.
    expect(run.findings[0]?.severity).toBe('error');
    const stored = (await admin.req('GET', `/doctor/runs/${run.id}`)).json<Run>();
    expect(stored.findings).toHaveLength(run.findings.length);
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'doctor.run' AND target = $1`,
      [`doctor:${run.id}`],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('p17-disk-selfclean: a machine still low after its own cleanup says what uses the space', async () => {
    const lowId = `wrk_${'d'.repeat(26)}`;
    const GiB = 1024 ** 3;
    const hygiene = {
      enabled: true,
      thresholdBytes: 2 * GiB,
      marginBytes: GiB,
      targetBytes: 3 * GiB,
      freeBytes: GiB / 2,
      checkedAt: '2026-10-25T10:00:00.000Z',
      running: false,
      lastRun: {
        trigger: 'low_disk',
        startedAt: '2026-10-25T09:59:00.000Z',
        finishedAt: '2026-10-25T10:00:00.000Z',
        freeBefore: GiB / 4,
        freeAfter: GiB / 2,
        freedBytes: GiB / 4,
        freed: [{ category: 'logs', bytes: GiB / 4, items: 2 }],
        stillLow: true,
        errors: 0,
      },
      nextLowDiskAt: null,
      nextDailyAt: null,
      usage: {
        at: '2026-10-25T10:00:00.000Z',
        dataDir: [
          { name: 'runtimes', bytes: 3 * GiB },
          { name: 'workspace-root', bytes: 40 * GiB },
        ],
        workspaceRoot: [
          { name: 'mirrors', bytes: 30 * GiB },
          { name: 'jobs', bytes: 10 * GiB },
        ],
      },
    };
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at, load,
                            disk_hygiene, disk_hygiene_at)
       VALUES ($1, 'tiny-disk', 'online', '{}', '1.1.3', $2, $2, $2, $3, $4, $2)`,
      [
        lowId,
        h.clock.now(),
        JSON.stringify({
          cpuPercent: 1,
          memoryFreeBytes: 1e9,
          diskFreeBytes: GiB / 2,
          workspaceDisk: { freeBytes: GiB / 2, minFreeBytes: 2 * GiB },
        }),
        JSON.stringify(hygiene),
      ],
    );
    try {
      const run = await runDoctor();
      const after = find(run, 'workers.disk', 'disk_low_after_cleanup').filter((x) => x.subject === lowId);
      expect(after).toHaveLength(1);
      expect(after[0]?.severity).toBe('error');
      expect(after[0]?.params).toMatchObject({
        name: 'tiny-disk',
        freedMiB: 256,
        largest: 'workspace/mirrors',
        largestMiB: 30 * 1024,
      });
      // Without a report that stayed low: the plain finding, whose fix names the cleanup.
      await h.db.pool.query('UPDATE workers SET disk_hygiene = NULL WHERE id = $1', [lowId]);
      const plain = find(await runDoctor(), 'workers.disk', 'disk_low').filter((x) => x.subject === lowId);
      expect(plain).toHaveLength(1);
      expect(plain[0]?.fix).toContain('Clean now');
    } finally {
      await h.db.pool.query('DELETE FROM workers WHERE id = $1', [lowId]);
    }
  });

  it('a machine doctor: doctor.run to a doctor-v1 worker, its report redacted and shown', async () => {
    const r = await admin.req('POST', `/doctor/machines/${workerId}`, {});
    expect(r.statusCode, r.body).toBe(202);
    const { opId, source } = r.json<{ opId: string; source: string }>();
    expect(source).toBe('doctor');
    let c: OpsCommand = await worker.next('OPS_COMMAND');
    while (c.payload.op.kind !== 'doctor.run') c = await worker.next('OPS_COMMAND');
    const finding = {
      check: 'master.dns',
      code: 'dns_failed',
      severity: 'error',
      message: `lookup failed ${GH}`,
    };
    worker.sendJson(
      worker.envelope(
        'OPS_UPDATE',
        {
          commandId: c.payload.commandId,
          seq: ++seq,
          kind: 'doctor.run',
          state: 'succeeded',
          doctor: {
            schemaVersion: 1,
            collectedAt: new Date().toISOString(),
            mode: 'remote',
            workerVersion: '1.0.75',
            host: { platform: 'linux', release: '6.8', arch: 'x64', node: 'v24.11.0' },
            master: 'https://remyral.example.com',
            summary: { ok: 0, info: 0, warning: 0, error: 1 },
            findings: [finding],
          },
        },
        { workerId },
      ),
    );
    await expect
      .poll(
        async () =>
          (await admin.req('GET', `/doctor/machines/${workerId}/ops/${opId}`)).json<{ state: string }>()
            .state,
      )
      .toBe('succeeded');
    const v = (await admin.req('GET', `/doctor/machines/${workerId}/ops/${opId}`)).json<{
      report: { findings: Finding[] };
    }>();
    expect(v.report.findings[0]?.code).toBe('dns_failed');
    expect(JSON.stringify(v)).not.toContain(GH);
    // An offline machine is not asked.
    const off = await admin.req('POST', `/doctor/machines/${offlineId}`, {});
    expect(off.statusCode).toBe(409);
  });

  it('the support bundle: sections, redaction, unticking, prompts only on request, download audited', async () => {
    const r = await admin.req('POST', '/support/reports', {
      description: `Jobs fail since Monday. My token is ${GH}`,
      hours: 24,
    });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json<Preview>();
    const paths = p.files.map((f) => f.path);
    for (const want of [
      'report.md',
      'doctor.json',
      'status.json',
      'versions.json',
      'config.json',
      'logs.jsonl',
      'failed-jobs.json',
      'description.txt',
      'manifest.json',
    ])
      expect(paths).toContain(want);
    expect(paths.some((x) => x.startsWith('workers/'))).toBe(true);
    expect(p.sections).not.toContain('job_prompts');
    // A fresh install has no support address: the report is only downloaded until the owner enters one.
    expect(p.recipient).toBeNull();
    expect(p.summary).toContain('# Remyral support report');
    expect(p.summary).not.toContain(GH);
    const dl = await admin.req('GET', `/support/reports/${p.id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const zip = dl.rawPayload;
    expect(createHash('sha256').update(zip).digest('hex')).toBe(p.sha256);
    const files = unzip(zip);
    const all = [...files.values()].join('\n');
    for (const secret of [
      GH,
      DB_PASSWORD,
      'hunter2-hunter2',
      SMTP_PASSWORD,
      PROMPT_SECRET,
      'Deploy with key',
    ])
      expect(all, secret).not.toContain(secret);
    expect(all).toContain('[REDACTED');
    const config = JSON.parse(files.get('config.json') ?? '{}') as { settings: Record<string, unknown> };
    expect(config.settings.databaseUrl).toBe(true);
    expect(config.settings['notifications.publicUrl']).toBe('https://remyral.example.com');
    expect(config.settings['notifications.smtp.host']).toBe('mail.example.com');
    expect(config.settings).not.toHaveProperty('totpKeyFile');
    expect(files.get('logs.jsonl')).toContain('dispatch failed');
    const failed = JSON.parse(files.get('failed-jobs.json') ?? '{}') as { jobs: Record<string, unknown>[] };
    expect(failed.jobs.length).toBeGreaterThan(0);
    expect(failed.jobs[0]).not.toHaveProperty('prompt');
    const manifest = JSON.parse(files.get('manifest.json') ?? '{}') as {
      files: { path: string; sha256: string }[];
    };
    expect(manifest.files.find((f) => f.path === 'doctor.json')?.sha256).toBe(
      p.files.find((f) => f.path === 'doctor.json')?.sha256,
    );
    const downloaded = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'support.report.download' AND target = $1`,
      [`support-report:${p.id}`],
    );
    expect(downloaded.rowCount).toBe(1);

    // Unticking: only the chosen sections (plus the summary and the manifest).
    const only = (await admin.req('POST', '/support/reports', { sections: ['doctor'] })).json<Preview>();
    expect(only.files.map((f) => f.path).sort()).toEqual(['doctor.json', 'manifest.json', 'report.md']);
    expect((await admin.req('POST', '/support/reports', { sections: [] })).statusCode).toBe(400);
    // Job prompts only when ticked — and still redacted.
    const withPrompts = (
      await admin.req('POST', '/support/reports', { sections: ['job_prompts'] })
    ).json<Preview>();
    const pz = unzip((await admin.req('GET', `/support/reports/${withPrompts.id}/download`)).rawPayload);
    const fj = pz.get('failed-jobs.json') ?? '';
    expect(fj).toContain('Deploy with key');
    expect(fj).not.toContain(PROMPT_SECRET);
  });

  it('support settings: owner only, the SMTP password sealed and never returned', async () => {
    expect((await admin.req('GET', '/support/settings')).json()).toMatchObject({
      email: null,
      defaultEmail: null,
    });
    await stepUp(owner, ownerSecret);
    const r = await owner.req('PUT', '/support/settings', {
      email: 'support@vendor.example',
      smtp: {
        host: '127.0.0.1',
        port: smtpPort,
        security: 'starttls',
        from: 'remyral@customer.example',
        username: 'mailer',
        password: SMTP_PASSWORD,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain(SMTP_PASSWORD);
    const s = (await admin.req('GET', '/support/settings')).json<{
      email: string;
      smtpSource: string;
      smtp: { passwordSet: boolean };
    }>();
    expect(s).toMatchObject({
      email: 'support@vendor.example',
      smtpSource: 'settings',
      smtp: { passwordSet: true },
    });
    const row = await h.db.pool.query<{ sealed: Buffer }>(
      'SELECT smtp_password_sealed AS sealed FROM support_settings',
    );
    expect(row.rows[0]?.sealed.toString('latin1')).not.toContain(SMTP_PASSWORD);
    expect((await owner.req('PUT', '/support/settings', { email: 'not-an-address' })).statusCode).toBe(422);
    const audit = await h.db.pool.query<{ m: Record<string, unknown> }>(
      `SELECT metadata AS m FROM audit_events WHERE action = 'support.settings.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(JSON.stringify(audit.rows[0]?.m)).not.toContain(SMTP_PASSWORD);
  });

  it('sends by e-mail: attachment, cc, audit; Serbest asks no code, Sıkı asks a fresh one', async () => {
    const p = (
      await owner.req('POST', '/support/reports', { description: 'Machines go offline at night.' })
    ).json<Preview>();
    expect(p.smtpReady).toBe(true);
    expect(p.ccAddress).toBe('owner@customer.example');
    smtp.messages.length = 0;
    h.clock.advance(20 * 60_000);
    const sent = await owner.req('POST', `/support/reports/${p.id}/send`, { ccMe: true });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json<{ attached: boolean; to: string; cc: string }>()).toMatchObject({
      attached: true,
      to: 'support@vendor.example',
      cc: 'owner@customer.example',
    });
    expect(smtp.messages).toHaveLength(1);
    const m = smtp.messages[0];
    expect(m?.secure).toBe(true);
    expect(m?.auth).toEqual({ username: 'mailer', password: SMTP_PASSWORD });
    expect(m?.to).toEqual(['support@vendor.example', 'owner@customer.example']);
    expect(mailHeader(m?.data ?? '', 'Cc')).toBe('owner@customer.example');
    const zip = attachment(m?.data ?? '');
    expect(zip).not.toBeNull();
    expect(
      createHash('sha256')
        .update(zip ?? Buffer.alloc(0))
        .digest('hex'),
    ).toBe(p.sha256);
    expect(unzip(zip ?? Buffer.alloc(0)).get('description.txt')).toContain('Machines go offline');
    const audit = await h.db.pool.query<{ actor_id: string; m: Record<string, unknown> }>(
      `SELECT actor_id, metadata AS m FROM audit_events WHERE action = 'support.report.send' AND outcome = 'success' AND target = $1`,
      [`support-report:${p.id}`],
    );
    expect(audit.rows[0]?.actor_id).toBe(ownerId);
    expect(audit.rows[0]?.m).toMatchObject({
      to: 'support@vendor.example',
      cc: 'owner@customer.example',
      sizeBytes: p.sizeBytes,
      sha256: p.sha256,
      attached: true,
    });

    // A viewer can never send.
    expect((await viewer.req('POST', `/support/reports/${p.id}/send`, {})).statusCode).toBe(403);
    // Sıkı: a fresh code.
    await h.setSecurityPolicy({ preset: 'siki' });
    h.clock.advance(20 * 60_000);
    const refused = await owner.req('POST', `/support/reports/${p.id}/send`, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('step_up_required');
    await stepUp(owner, ownerSecret);
    expect((await owner.req('POST', `/support/reports/${p.id}/send`, {})).statusCode).toBe(200);
    await h.setSecurityPolicy({ preset: 'serbest' });

    // Cleared (null): nothing is e-mailed, the report stays downloadable.
    await stepUp(owner, ownerSecret);
    const cleared = await owner.req('PUT', '/support/settings', { email: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ email: null, smtpSource: 'settings' });
    const unset = await owner.req('POST', `/support/reports/${p.id}/send`, {});
    expect(unset.statusCode).toBe(409);
    expect(unset.json()).toMatchObject({ error: 'support_email_missing' });
    expect(
      (await owner.req('PUT', '/support/settings', { email: 'support@vendor.example' })).statusCode,
    ).toBe(200);
  });

  it('the attachment cap: a larger bundle is not attached; the mail carries the summary only', async () => {
    const got: { rcpt: readonly string[]; message: string }[] = [];
    const svc = new SupportService({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      sealKey: randomBytes(32),
      doctor: h.app.doctor.service,
      status: () => Promise.resolve(null),
      logs: () => null,
      config: null,
      securityPreset: () => Promise.resolve('serbest'),
      releaseTag: null,
      notificationSmtp: { host: '127.0.0.1', port: 1, security: 'starttls', from: 'n@customer.example' },
      maxAttachmentBytes: 200,
      submit: (_smtp, rcpt, message) => {
        got.push({ rcpt, message });
        return Promise.resolve();
      },
    });
    await h.db.pool.query(
      'UPDATE support_settings SET smtp_host = NULL, smtp_port = NULL, smtp_security = NULL, smtp_from = NULL, smtp_username = NULL, smtp_password_sealed = NULL',
    );
    const actor = { userId: ownerId, ip: '127.0.0.1', userAgent: null };
    const p = await svc.build(actor, { sections: ['doctor', 'versions'] });
    expect(p.overCap).toBe(true);
    const r = await svc.send(actor, p.id);
    expect(r.attached).toBe(false);
    expect(got).toHaveLength(1);
    expect(got[0]?.message).not.toContain('Content-Disposition: attachment');
    expect(
      Buffer.from(
        (got[0]?.message ?? '').split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '',
        'base64',
      ).toString('utf8'),
    ).toContain('NOT attached');
  });

  it('the daily light run notifies only new problems, once', async () => {
    const notes = async () =>
      (
        await h.db.pool.query<{ body: string }>(
          `SELECT body FROM notifications WHERE kind = 'doctor.problem' ORDER BY created_at`,
        )
      ).rows;
    const first = await h.app.doctor.service.daily();
    expect(first?.scope).toBe('light');
    expect(first?.newProblems).toBeGreaterThan(0);
    const after1 = await notes();
    expect(after1.length).toBeGreaterThan(0);
    // Not due again yet.
    expect(await h.app.doctor.service.daily()).toBeNull();
    h.clock.advance(24 * 3_600_000);
    const second = await h.app.doctor.service.daily();
    expect(second?.newProblems).toBe(0);
    expect((await notes()).length).toBe(after1.length);
    // A new problem: notified alone.
    const fresh = await insertJob('AWAITING_APPROVAL', 90);
    h.clock.advance(24 * 3_600_000);
    const third = await h.app.doctor.service.daily();
    expect(third?.newProblems).toBe(1);
    const latest = await notes();
    expect(latest.length).toBe(after1.length * 2);
    expect(latest.at(-1)?.body).toContain(fresh);
    // Resolved then back: notified again.
    await h.db.pool.query("UPDATE jobs SET state = 'CANCELLED', version = version + 1 WHERE id = $1", [
      fresh,
    ]);
    h.clock.advance(24 * 3_600_000);
    expect((await h.app.doctor.service.daily())?.newProblems).toBe(0);
    const resolved = await h.db.pool.query<{ r: Date | null }>(
      'SELECT resolved_at AS r FROM doctor_problems WHERE subject = $1',
      [fresh],
    );
    expect(resolved.rows[0]?.r).not.toBeNull();
    expect((await h.app.doctor.service.latest('daily'))?.newProblems).toBe(0);
  });
});
