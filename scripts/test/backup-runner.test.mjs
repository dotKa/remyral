// Unit tests of the backup runner (p10-backup-restore): naming, tiers, retention, schedule, manifest, recipients,
// SigV4, off-site config, S3 upload against a fake server, status reduction, migration and audit-chain checks.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageEncryptArgs, findIdentities, parseRecipients } from '../../infra/backup/runner/lib/age.mjs';
import {
  canonicalJson,
  eventHashHex,
  GENESIS_HASH_HEX,
  verifyAuditChain,
} from '../../infra/backup/runner/lib/audit-chain.mjs';
import { MANIFEST_FORMAT, validateManifest } from '../../infra/backup/runner/lib/manifest.mjs';
import {
  backupId,
  isoWeek,
  localFiles,
  offsiteKey,
  parseBackupId,
  parseStamp,
  stampOf,
  tierFor,
} from '../../infra/backup/runner/lib/naming.mjs';
import { compareMigrations } from '../../infra/backup/runner/lib/pg.mjs';
import { parseRetention, planRetention } from '../../infra/backup/runner/lib/retention.mjs';
import { parseEnvFile, parseOffsiteConfig, S3Target, signV4 } from '../../infra/backup/runner/lib/s3.mjs';
import {
  expectedIntervalMs,
  nextBackupAt,
  nextDailySlot,
  nextDrillAt,
  nextWeeklySlot,
  parseSchedule,
} from '../../infra/backup/runner/lib/schedule.mjs';
import { emptyStatus, recordBackup, recordDrill } from '../../infra/backup/runner/lib/status.mjs';

const D = (s) => new Date(s);
const RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

describe('naming', () => {
  it('formats and parses UTC stamps and ids', () => {
    const at = D('2026-10-18T02:30:05.900Z');
    expect(stampOf(at)).toBe('20261018T023005Z');
    expect(parseStamp('20261018T023005Z').toISOString()).toBe('2026-10-18T02:30:05.000Z');
    expect(() => parseStamp('20261318T023005Z')).toThrow();
    const id = backupId('prod', at);
    expect(id).toBe('remana-prod-20261018T023005Z');
    expect(parseBackupId(id)).toMatchObject({ env: 'prod', stamp: '20261018T023005Z' });
    expect(parseBackupId('remyral-prod-2026')).toBeNull();
    expect(parseBackupId('../remana-prod-20261018T023005Z')).toBeNull();
    expect(() => backupId('Prod!', at)).toThrow(/environment/);
    expect(localFiles(id)).toEqual({
      dump: 'db/remana-prod-20261018T023005Z.dump',
      manifest: 'db/remana-prod-20261018T023005Z.manifest.json',
      secrets: 'secrets/remana-prod-20261018T023005Z.secrets.tar.age',
    });
  });

  it('computes ISO weeks across year boundaries', () => {
    expect(isoWeek(D('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(D('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(D('2026-10-18T12:00:00Z'))).toBe('2026-W42');
    expect(isoWeek(D('2026-10-19T00:00:00Z'))).toBe('2026-W43');
  });

  it('assigns lifecycle tiers: first of month, week, day, then frequent', () => {
    expect(tierFor(D('2026-10-18T02:30:00Z'), [])).toBe('monthly');
    const prev = [D('2026-10-01T02:30:00Z')];
    expect(tierFor(D('2026-10-18T02:30:00Z'), prev)).toBe('weekly');
    expect(tierFor(D('2026-10-18T02:30:00Z'), [...prev, D('2026-10-17T02:30:00Z')])).toBe('daily');
    expect(tierFor(D('2026-10-18T12:00:00Z'), [...prev, D('2026-10-18T02:30:00Z')])).toBe('frequent');
    // later backups do not count
    expect(tierFor(D('2026-10-18T02:30:00Z'), [D('2026-10-19T02:30:00Z')])).toBe('monthly');
  });

  it('builds lifecycle-friendly off-site keys and refuses unsafe parts', () => {
    const id = 'remana-prod-20261018T023005Z';
    expect(offsiteKey({ prefix: 'remyral', tier: 'daily', id, kind: 'db' })).toBe(
      'remyral/daily/prod/2026/10/18/remana-prod-20261018T023005Z.db.dump.age',
    );
    expect(offsiteKey({ prefix: 'org/remyral', tier: 'monthly', id, kind: 'manifest' })).toBe(
      'org/remyral/monthly/prod/2026/10/18/remana-prod-20261018T023005Z.manifest.json',
    );
    expect(() => offsiteKey({ prefix: '../x', tier: 'daily', id, kind: 'db' })).toThrow(/prefix/);
    expect(() => offsiteKey({ prefix: 'remyral', tier: 'yearly', id, kind: 'db' })).toThrow(/tier/);
  });
});

describe('retention (7 daily / 4 weekly / 3 monthly)', () => {
  const policy = parseRetention({});
  // one backup per day at 02:30 for 120 days, plus a second one on the newest day
  const days = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 9, 18, 2, 30) - i * 86_400_000));
  const backups = days.map((at) => ({ id: backupId('prod', at), at }));
  backups.push({ id: backupId('prod', D('2026-10-18T14:00:00Z')), at: D('2026-10-18T14:00:00Z') });
  const now = D('2026-10-18T15:00:00Z');

  it('keeps the newest per day, ISO week and month, and the newest overall', () => {
    const plan = planRetention(backups, policy, now);
    const kept = [...plan.keep.keys()].sort();
    // daily: 18.10 (14:00 run), 17..12.10; weekly adds Sundays 11.10, 04.10, 27.09 (W42 already = 18.10);
    // monthly: 2026-10 (18.10), 2026-09 (30.09), 2026-08 (31.08)
    expect(kept).toEqual(
      [
        '20260831T023000Z',
        '20260927T023000Z',
        '20260930T023000Z',
        '20261004T023000Z',
        '20261011T023000Z',
        '20261012T023000Z',
        '20261013T023000Z',
        '20261014T023000Z',
        '20261015T023000Z',
        '20261016T023000Z',
        '20261017T023000Z',
        '20261018T140000Z',
      ].map((s) => `remana-prod-${s}`),
    );
    expect(plan.keep.get('remana-prod-20261018T140000Z')).toEqual(
      expect.arrayContaining(['daily 2026-10-18', 'weekly 2026-W42', 'monthly 2026-10', 'newest']),
    );
    expect(plan.remove).toContain('remana-prod-20261018T023000Z');
    expect(plan.remove.length + plan.keep.size).toBe(backups.length);
  });

  it('keeps everything younger than keepRecentHours', () => {
    const plan = planRetention(backups, { ...policy, keepRecentHours: 24 }, now);
    expect(plan.keep.has('remana-prod-20261018T023000Z')).toBe(true);
  });

  it('never removes the only backup and validates the policy', () => {
    const one = [{ id: backupId('prod', now), at: now }];
    expect(planRetention(one, { daily: 0, weekly: 0, monthly: 1, keepRecentHours: 0 }, now).remove).toEqual(
      [],
    );
    expect(() =>
      parseRetention({ BACKUP_KEEP_DAILY: '0', BACKUP_KEEP_WEEKLY: '0', BACKUP_KEEP_MONTHLY: '0' }),
    ).toThrow();
    expect(() => parseRetention({ BACKUP_KEEP_DAILY: '-1' })).toThrow();
    expect(parseRetention({ BACKUP_KEEP_DAILY: '14' }).daily).toBe(14);
  });
});

describe('schedule', () => {
  const daily = parseSchedule({});
  it('defaults: nightly 02:30 UTC, drill Sunday 04:00', () => {
    expect(daily).toMatchObject({
      timeOfDay: { h: 2, m: 30 },
      intervalMinutes: null,
      drill: { enabled: true, weekday: 0 },
    });
    expect(expectedIntervalMs(daily)).toBe(86_400_000);
    expect(() => parseSchedule({ BACKUP_TIME: '25:00' })).toThrow();
    expect(() => parseSchedule({ BACKUP_INTERVAL_MINUTES: '5' })).toThrow();
    expect(parseSchedule({ BACKUP_INTERVAL_MINUTES: '60' }).intervalMinutes).toBe(60);
  });

  it('computes daily and weekly slots', () => {
    expect(nextDailySlot(D('2026-10-18T01:00:00Z'), { h: 2, m: 30 }).toISOString()).toBe(
      '2026-10-18T02:30:00.000Z',
    );
    expect(nextDailySlot(D('2026-10-18T02:30:00Z'), { h: 2, m: 30 }).toISOString()).toBe(
      '2026-10-19T02:30:00.000Z',
    );
    // 2026-10-18 is a Sunday
    expect(nextWeeklySlot(D('2026-10-18T05:00:00Z'), 0, { h: 4, m: 0 }).toISOString()).toBe(
      '2026-10-25T04:00:00.000Z',
    );
    expect(nextWeeklySlot(D('2026-10-14T05:00:00Z'), 0, { h: 4, m: 0 }).toISOString()).toBe(
      '2026-10-18T04:00:00.000Z',
    );
  });

  it('runs the next nightly slot, catches up after a missed night, never retries within the hour', () => {
    const now = D('2026-10-18T12:00:00Z');
    expect(
      nextBackupAt({
        now,
        lastAttemptAt: D('2026-10-18T02:30:00Z'),
        lastSuccessAt: D('2026-10-18T02:31:00Z'),
        schedule: daily,
      }).toISOString(),
    ).toBe('2026-10-19T02:30:00.000Z');
    // nothing for two days → now
    expect(
      nextBackupAt({
        now,
        lastAttemptAt: D('2026-10-16T02:30:00Z'),
        lastSuccessAt: D('2026-10-16T02:31:00Z'),
        schedule: daily,
      }),
    ).toBe(now);
    // first start ever → now
    expect(nextBackupAt({ now, lastAttemptAt: null, lastSuccessAt: null, schedule: daily })).toBe(now);
    // failing for a while but tried 10 minutes ago → wait for the regular slot
    expect(
      nextBackupAt({
        now,
        lastAttemptAt: D('2026-10-18T11:50:00Z'),
        lastSuccessAt: D('2026-10-15T02:31:00Z'),
        schedule: daily,
      }).toISOString(),
    ).toBe('2026-10-19T02:30:00.000Z');
    const hourly = parseSchedule({ BACKUP_INTERVAL_MINUTES: '60' });
    expect(
      nextBackupAt({
        now,
        lastAttemptAt: D('2026-10-18T11:30:00Z'),
        lastSuccessAt: D('2026-10-18T11:31:00Z'),
        schedule: hourly,
      }).toISOString(),
    ).toBe('2026-10-18T12:30:00.000Z');
  });

  it('drills weekly, the first one as soon as a backup exists', () => {
    const now = D('2026-10-18T12:00:00Z');
    expect(nextDrillAt({ now, lastDrillAt: null, hasBackup: false, schedule: daily })).toBeNull();
    expect(nextDrillAt({ now, lastDrillAt: null, hasBackup: true, schedule: daily })).toBe(now);
    expect(
      nextDrillAt({
        now,
        lastDrillAt: D('2026-10-18T04:00:00Z'),
        hasBackup: true,
        schedule: daily,
      })?.toISOString(),
    ).toBe('2026-10-25T04:00:00.000Z');
    expect(
      nextDrillAt({
        now,
        lastDrillAt: null,
        hasBackup: true,
        schedule: parseSchedule({ BACKUP_DRILL_ENABLED: 'false' }),
      }),
    ).toBeNull();
  });
});

function manifest(overrides = {}) {
  return {
    format: MANIFEST_FORMAT,
    id: 'remana-prod-20261018T023005Z',
    env: 'prod',
    createdAt: '2026-10-18T02:30:05.000Z',
    finishedAt: '2026-10-18T02:30:09.000Z',
    tier: 'daily',
    postgres: {},
    schema: { version: '0075', count: 75 },
    auditHead: { id: '42', hash: 'a'.repeat(64) },
    tables: { jobs: 3, audit_events: 42 },
    fingerprints: [{ table: 'jobs', id: 'x', sha256: 'b'.repeat(64) }],
    files: {
      db: { name: 'db/remana-prod-20261018T023005Z.dump', bytes: 10, sha256: 'c'.repeat(64) },
      secrets: {
        name: 'secrets/remana-prod-20261018T023005Z.secrets.tar.age',
        bytes: 5,
        sha256: 'd'.repeat(64),
        plaintextSha256: 'e'.repeat(64),
      },
    },
    recipients: [RECIPIENT],
    offsite: null,
    ...overrides,
  };
}

describe('manifest', () => {
  it('accepts a complete manifest and rejects tampered fields', () => {
    expect(validateManifest(manifest()).id).toBe('remana-prod-20261018T023005Z');
    expect(() => validateManifest(manifest({ env: 'staging' }))).toThrow(/env/);
    expect(() => validateManifest(manifest({ format: 'x' }))).toThrow(/format/);
    expect(() => validateManifest(manifest({ tables: { 'jobs;drop': 1 } }))).toThrow(/tables/);
    expect(() => validateManifest(manifest({ auditHead: { id: '1', hash: 'zz' } }))).toThrow(/auditHead/);
    expect(() => validateManifest(manifest({ recipients: ['AGE-SECRET-KEY-1'] }))).toThrow(/recipients/);
    expect(
      validateManifest(manifest({ auditHead: null, files: { ...manifest().files, secrets: null } }))
        .auditHead,
    ).toBeNull();
  });
});

describe('age recipients', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'remyral-bk-age-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts public keys and comments, refuses private keys and junk', () => {
    expect(parseRecipients(`# owner\n${RECIPIENT}\n\n${RECIPIENT}\n`)).toEqual([RECIPIENT]);
    expect(() => parseRecipients(`${RECIPIENT}\nAGE-SECRET-KEY-1QQQ\n`)).toThrow(/PRIVATE/);
    expect(() => parseRecipients('ssh-ed25519 AAAA\n')).toThrow(/not an age1/);
    expect(() => parseRecipients('# nothing\n')).toThrow(/no age1/);
    expect(ageEncryptArgs([RECIPIENT, RECIPIENT], '/o', '/i')).toEqual([
      '-r',
      RECIPIENT,
      '-r',
      RECIPIENT,
      '-o',
      '/o',
      '/i',
    ]);
  });

  it('finds an age identity stored next to the backups', () => {
    mkdirSync(join(dir, 'secrets/sub'), { recursive: true });
    writeFileSync(join(dir, 'secrets/totp.key'), 'abc');
    expect(findIdentities(dir)).toEqual([]);
    writeFileSync(join(dir, 'secrets/sub/identity.txt'), '# created\nAGE-SECRET-KEY-1ABC\n');
    expect(findIdentities(dir)).toEqual(['secrets/sub/identity.txt']);
  });
});

describe('SigV4', () => {
  it('reproduces the AWS documentation example (GET object with Range)', () => {
    const h = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      date: D('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('off-site configuration', () => {
  const base = {
    BACKUP_S3_BUCKET: 'remyral-backups',
    BACKUP_S3_ACCESS_KEY_ID: 'AKID',
    BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
  };
  it('parses KEY=VALUE files', () => {
    expect(parseEnvFile('# c\nexport A_B="x y"\nC=\'z\'\nD=e=f\n')).toEqual({ A_B: 'x y', C: 'z', D: 'e=f' });
    expect(() => parseEnvFile('garbage')).toThrow();
  });
  it('AWS: region endpoint, virtual-hosted; R2: endpoint, region auto, path style', () => {
    const aws = parseOffsiteConfig({ ...base, BACKUP_S3_REGION: 'eu-central-1' });
    expect(aws.endpoint.href).toBe('https://s3.eu-central-1.amazonaws.com/');
    expect(aws.pathStyle).toBe(false);
    expect(aws.describe).toBe('s3://remyral-backups/remana/ @ s3.eu-central-1.amazonaws.com');
    const r2 = parseOffsiteConfig({ ...base, BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com' });
    expect(r2).toMatchObject({ region: 'auto', pathStyle: true, prefix: 'remana' });
    expect(new S3Target(r2).url('remana/daily/x').href).toBe(
      'https://acc.r2.cloudflarestorage.com/remyral-backups/remana/daily/x',
    );
    expect(new S3Target(aws).url('remana/daily/x').href).toBe(
      'https://remyral-backups.s3.eu-central-1.amazonaws.com/remana/daily/x',
    );
  });
  it('refuses plain http (except loopback), missing secrets and bad names', () => {
    expect(() => parseOffsiteConfig({ ...base, BACKUP_S3_ENDPOINT: 'http://s3.example.com' })).toThrow(
      /https/,
    );
    expect(parseOffsiteConfig({ ...base, BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9000' }).endpoint.port).toBe(
      '9000',
    );
    expect(() =>
      parseOffsiteConfig({ ...base, BACKUP_S3_REGION: 'us-east-1', BACKUP_S3_SECRET_ACCESS_KEY: '' }),
    ).toThrow(/SECRET/);
    expect(() => parseOffsiteConfig({ ...base, BACKUP_S3_BUCKET: 'Bad_Bucket' })).toThrow(/bucket/);
    expect(() => parseOffsiteConfig(base)).toThrow(/REGION/);
  });
});

describe('S3 upload against a verifying fake server', () => {
  const SECRET = 'test-secret-key';
  const objects = new Map();
  const uploads = new Map();
  const seen = [];
  let server;
  let cfg;
  let dir;

  function verifySignature(req, body) {
    const auth = String(req.headers.authorization);
    const m =
      /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(
        auth,
      );
    if (!m) return false;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const headers = {};
    for (const n of m[4].split(';'))
      if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n)) headers[n] = req.headers[n];
    const date = D(
      String(req.headers['x-amz-date']).replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        '$1-$2-$3T$4:$5:$6Z',
      ),
    );
    const again = signV4({
      method: req.method,
      url,
      headers,
      payloadSha256: String(req.headers['x-amz-content-sha256']),
      accessKeyId: m[1],
      secretAccessKey: SECRET,
      region: m[3],
      date,
    });
    const payloadOk = createHash('sha256').update(body).digest('hex') === req.headers['x-amz-content-sha256'];
    const md5 = req.headers['content-md5'];
    const md5Ok = md5 === undefined || createHash('md5').update(body).digest('base64') === md5;
    return again.authorization === auth && payloadOk && md5Ok;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'remyral-bk-s3-'));
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x');
        seen.push(`${req.method} ${url.pathname}${url.search}`);
        if (!verifySignature(req, body)) {
          res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
          return;
        }
        const key = url.pathname;
        if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
          const up = uploads.get(url.searchParams.get('uploadId'));
          up.parts.set(Number(url.searchParams.get('partNumber')), body);
          res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
        } else if (req.method === 'PUT') {
          objects.set(key, { body, sha: req.headers['x-amz-meta-sha256'] });
          res.writeHead(200).end();
        } else if (req.method === 'POST' && url.searchParams.has('uploads')) {
          uploads.set('U1', { key, sha: req.headers['x-amz-meta-sha256'], parts: new Map() });
          res
            .writeHead(200)
            .end('<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>');
        } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
          const up = uploads.get(url.searchParams.get('uploadId'));
          const parts = [...up.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
          objects.set(up.key, { body: Buffer.concat(parts), sha: up.sha });
          res
            .writeHead(200)
            .end('<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>');
        } else if (req.method === 'HEAD') {
          const o = objects.get(key);
          if (!o) res.writeHead(404).end();
          else
            res.writeHead(200, { 'content-length': String(o.body.length), 'x-amz-meta-sha256': o.sha }).end();
        } else res.writeHead(400).end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cfg = parseOffsiteConfig({
      BACKUP_S3_BUCKET: 'bkt',
      BACKUP_S3_ACCESS_KEY_ID: 'AKID',
      BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
      BACKUP_S3_ENDPOINT: `http://127.0.0.1:${String(server.address().port)}`,
    });
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('single PUT with signed payload hash, Content-MD5 and HEAD verification', async () => {
    const file = join(dir, 'small.bin');
    const data = Buffer.from('hello backup');
    writeFileSync(file, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const t = new S3Target(cfg);
    await expect(
      t.putFile('remyral/daily/prod/a.bin', file, { bytes: data.length, sha256 }),
    ).resolves.toMatchObject({ bytes: data.length });
    expect(objects.get('/bkt/remyral/daily/prod/a.bin').body.equals(data)).toBe(true);
  });

  it('multipart upload reassembles the parts in order', async () => {
    const file = join(dir, 'big.bin');
    const data = Buffer.alloc(2500, 7);
    data.write('start');
    writeFileSync(file, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const t = new S3Target(cfg, { singlePutMax: 1000, partSize: 1000 });
    await t.putFile('remyral/daily/prod/big.bin', file, { bytes: data.length, sha256 });
    expect(objects.get('/bkt/remyral/daily/prod/big.bin').body.equals(data)).toBe(true);
    expect(seen.filter((s) => s.includes('partNumber')).length).toBe(3);
  });

  it('fails on a wrong secret and when HEAD disagrees', async () => {
    const t = new S3Target({ ...cfg, secretAccessKey: 'wrong' });
    await expect(t.putBuffer('remyral/x.json', Buffer.from('{}'), 'application/json')).rejects.toThrow(
      /403 SignatureDoesNotMatch/,
    );
    const file = join(dir, 'c.bin');
    writeFileSync(file, 'abc');
    await expect(
      new S3Target(cfg).putFile('remyral/c.bin', file, { bytes: 3, sha256: 'f'.repeat(64) }),
    ).rejects.toThrow();
  });
});

describe('status reduction', () => {
  it('tracks last and last successful runs, bounded history', () => {
    let s = emptyStatus('prod');
    s = recordBackup(s, { runId: 'a', outcome: 'ok' });
    s = recordBackup(s, { runId: 'b', outcome: 'failed' });
    expect(s.lastBackup.runId).toBe('b');
    expect(s.lastSuccessfulBackup.runId).toBe('a');
    s = recordBackup(s, { runId: 'c', outcome: 'partial' });
    expect(s.lastSuccessfulBackup.runId).toBe('c');
    for (let i = 0; i < 30; i += 1) s = recordBackup(s, { runId: `x${String(i)}`, outcome: 'ok' });
    expect(s.backups).toHaveLength(20);
    s = recordDrill(s, { runId: 'd1', outcome: 'passed' });
    s = recordDrill(s, { runId: 'd2', outcome: 'failed' });
    expect([s.lastDrill.runId, s.lastSuccessfulDrill.runId]).toEqual(['d2', 'd1']);
  });
});

describe('migration check', () => {
  it('fails on unknown or edited applied migrations, reports pending ones', () => {
    const files = [
      { version: '0001', checksum: 'a' },
      { version: '0002', checksum: 'b' },
      { version: '0003', checksum: 'c' },
    ];
    expect(compareMigrations([{ version: '0001', checksum: 'a' }], files)).toEqual({
      ok: true,
      unknown: [],
      mismatched: [],
      pending: ['0002', '0003'],
    });
    expect(
      compareMigrations(
        [
          { version: '0001', checksum: 'x' },
          { version: '0009', checksum: 'z' },
        ],
        files,
      ),
    ).toMatchObject({
      ok: false,
      unknown: ['0009'],
      mismatched: ['0001'],
    });
  });
});

describe('audit chain', () => {
  function chain(n) {
    const rows = [];
    let prev = GENESIS_HASH_HEX;
    for (let i = 1; i <= n; i += 1) {
      const r = {
        id: String(i),
        occurredAt: `2026-10-18T00:00:0${String(i % 10)}.123Z`,
        actorType: 'user',
        actorId: 'u1',
        action: 'auth.login',
        target: null,
        outcome: 'success',
        ip: '10.0.0.1',
        userAgent: null,
        metadata: { b: [1, { z: true, a: 'x' }], a: null },
        prevHash: prev,
      };
      r.hash = eventHashHex(r);
      prev = r.hash;
      rows.push(r);
    }
    return rows;
  }
  const queryFor = (rows) => async (sql) => {
    const after = Number(/e\.id > (\d+)/.exec(sql)[1]);
    const limit = Number(/LIMIT (\d+)\) r$/.exec(sql)[1]);
    return rows.filter((r) => Number(r.id) > after).slice(0, limit);
  };

  it('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it('verifies an intact chain across batches and reports the head', async () => {
    const rows = chain(5);
    await expect(verifyAuditChain(queryFor(rows), 2)).resolves.toEqual({
      ok: true,
      checked: 5,
      headId: '5',
      headHash: rows[4].hash,
    });
    await expect(verifyAuditChain(queryFor([]), 2)).resolves.toEqual({
      ok: true,
      checked: 0,
      headId: null,
      headHash: null,
    });
  });

  it('detects an edited row and a deleted row', async () => {
    const edited = chain(4);
    edited[2] = { ...edited[2], action: 'auth.logout' };
    await expect(verifyAuditChain(queryFor(edited), 10)).resolves.toMatchObject({
      ok: false,
      brokenAtId: '3',
      reason: 'hash_mismatch',
    });
    const gap = chain(4).filter((r) => r.id !== '2');
    await expect(verifyAuditChain(queryFor(gap), 10)).resolves.toMatchObject({
      ok: false,
      brokenAtId: '3',
      reason: 'prev_hash_mismatch',
    });
  });
});
