// Unit tests of the warm standby (p11-master-resilience): WAL names, order, chains and gaps, shipping (fake age +
// fake S3 target), prune plan, base manifests and labels, the lease key id, the daemon's base schedule, off-site
// selection for a restore, the data directory script, recovery settings and the Cloudflare DNS cutover.
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE_FORMAT,
  baseBackupDue,
  baseObjectKeys,
  baseTarArgs,
  leaseKeyKidFromPem,
  parseBackupLabel,
  validateBaseManifest,
} from '../../infra/backup/runner/lib/basebackup.mjs';
import { parseOnOff } from '../../infra/backup/runner/lib/config.mjs';
import { S3Target } from '../../infra/backup/runner/lib/s3.mjs';
import { localRestoreCommand, recoveryConf } from '../../infra/backup/runner/lib/standby-drill.mjs';
import {
  compareWal,
  parseWalName,
  planWalPrune,
  readStandby,
  shipWal,
  walChainSince,
  walGaps,
  walNameOfKey,
  walObjectKey,
} from '../../infra/backup/runner/lib/wal.mjs';
import {
  cfListRequest,
  cfPatchRequest,
  cloudflareCutover,
  installationNames,
  newestBase,
  newestSecrets,
  pgdataFor,
  prepareDataDirScript,
  recordTypeFor,
  targetTimeSetting,
  walObjectsForBase,
} from '../ops/lib/standby.mjs';

const seg = (tl, log, s) =>
  `${tl.toString(16).toUpperCase().padStart(8, '0')}${log.toString(16).toUpperCase().padStart(8, '0')}${s.toString(16).toUpperCase().padStart(8, '0')}`;

describe('WAL names', () => {
  it('parses segments, history, backup history and partial files; rejects the rest', () => {
    expect(parseWalName('000000010000000000000004')).toEqual({
      name: '000000010000000000000004',
      kind: 'segment',
      timeline: '00000001',
      position: '0000000000000004',
    });
    expect(parseWalName('00000002.history')?.kind).toBe('history');
    expect(parseWalName('000000010000000000000004.00000028.backup')?.kind).toBe('backup');
    expect(parseWalName('000000010000000000000004.partial')?.kind).toBe('partial');
    for (const bad of ['000000010000000000000004.tmp', '00000001000000000000000g', '../x', '', 'x.history'])
      expect(parseWalName(bad)).toBeNull();
  });

  it('orders history first, then by position across timelines', () => {
    const names = [seg(2, 0, 5), seg(1, 0, 4), '00000002.history', seg(1, 1, 0), seg(1, 0, 0xff)];
    expect([...names].sort(compareWal)).toEqual([
      '00000002.history',
      seg(1, 0, 4),
      seg(2, 0, 5),
      seg(1, 0, 0xff),
      seg(1, 1, 0),
    ]);
  });

  it('the chain for a base: history files + everything at or after the start position', () => {
    const names = [
      seg(1, 0, 2),
      seg(1, 0, 3),
      `${seg(1, 0, 3)}.00000028.backup`,
      seg(1, 0, 4),
      '00000002.history',
      `${seg(1, 0, 5)}.partial`,
    ];
    expect(walChainSince(names, seg(1, 0, 3))).toEqual([
      '00000002.history',
      seg(1, 0, 3),
      `${seg(1, 0, 3)}.00000028.backup`,
      seg(1, 0, 4),
    ]);
    expect(() => walChainSince(names, '00000002.history')).toThrow(/start WAL/);
  });

  it('finds gaps, including across a log boundary', () => {
    expect(walGaps([seg(1, 0, 0xfe), seg(1, 0, 0xff), seg(1, 1, 0), seg(1, 1, 1)])).toEqual([]);
    expect(walGaps([seg(1, 0, 3), seg(1, 0, 5)])).toEqual([seg(1, 0, 4)]);
    expect(walGaps([seg(1, 0, 0xff), seg(1, 1, 1)])).toEqual([seg(1, 1, 0)]);
  });

  it('off-site keys round-trip and refuse unsafe names', () => {
    const key = walObjectKey({ prefix: 'remyral', env: 'prod', name: seg(1, 0, 7) });
    expect(key).toBe(`remyral/wal/prod/${seg(1, 0, 7)}.gz.age`);
    expect(walNameOfKey(key, 'prod')).toBe(seg(1, 0, 7));
    expect(walNameOfKey(key, 'staging')).toBeNull();
    expect(() => walObjectKey({ prefix: 'remyral', env: 'prod', name: '../etc' })).toThrow();
  });

  it('prune plan: only before the newest base, only shipped ones while off-site is configured, never history', () => {
    const local = ['00000001.history', seg(1, 0, 1), seg(1, 0, 2), seg(1, 0, 3), seg(1, 0, 4)];
    expect(
      planWalPrune({
        local,
        shipped: new Set([seg(1, 0, 1)]),
        keepFrom: seg(1, 0, 3),
        offsiteConfigured: true,
      }),
    ).toEqual([seg(1, 0, 1)]);
    expect(
      planWalPrune({ local, shipped: new Set(), keepFrom: seg(1, 0, 3), offsiteConfigured: false }),
    ).toEqual([seg(1, 0, 1), seg(1, 0, 2)]);
    expect(planWalPrune({ local, shipped: new Set(local), keepFrom: null, offsiteConfigured: true })).toEqual(
      [],
    );
  });

  it('parseOnOff', () => {
    expect(parseOnOff(undefined, 'X')).toBe(false);
    expect(parseOnOff('on', 'X')).toBe(true);
    expect(parseOnOff('OFF', 'X')).toBe(false);
    expect(() => parseOnOff('yes', 'X')).toThrow(/on or off/);
  });
});

describe('WAL shipping (fake age, fake S3 target)', () => {
  let root;
  let cfg;
  const puts = [];
  let failOn = null;
  const tools = {
    async run(cmd, args) {
      if (cmd === 'age') {
        const o = args.indexOf('-o');
        copyFileSync(args[o + 2], args[o + 1]);
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const target = {
    async putFile(key, path, meta) {
      if (failOn !== null && key.includes(failOn)) throw new Error('HTTP 503');
      puts.push({ key, bytes: readFileSync(path).length, ...meta });
      return { key };
    },
  };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'remyral-wal-'));
    cfg = {
      env: 'prod',
      root: join(root, 'backups'),
      statusDir: join(root, 'backups', 'status'),
      walArchiveDir: join(root, 'wal-archive'),
      drillUser: { uid: process.getuid(), gid: process.getgid() },
      walArchive: { enabled: true },
    };
    mkdirSync(cfg.walArchiveDir, { recursive: true });
    mkdirSync(cfg.root, { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const raw = (name) => {
    writeFileSync(join(cfg.walArchiveDir, name), Buffer.concat([Buffer.from(name), Buffer.alloc(65536)]));
  };

  it('compresses, uploads in order, removes raw files and records progress', async () => {
    raw(seg(1, 0, 1));
    raw(seg(1, 0, 2));
    writeFileSync(join(cfg.walArchiveDir, `${seg(1, 0, 3)}.tmp`), 'in progress');
    const off = { target, prefix: 'remyral', describe: 's3://b/remyral/ @ x' };
    const r = await shipWal(cfg, { tools, offsite: off, recipients: ['age1x'] });
    expect(r).toMatchObject({ converted: 2, shipped: 2, error: null });
    expect(puts.map((p) => p.key)).toEqual([
      `remyral/wal/prod/${seg(1, 0, 1)}.gz.age`,
      `remyral/wal/prod/${seg(1, 0, 2)}.gz.age`,
    ]);
    expect(puts[0].bytes).toBeLessThan(2000); // gzip of a zero tail
    expect(puts[0].sha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(cfg.root, 'wal', `${seg(1, 0, 1)}.gz`)))
        .digest('hex'),
    );
    expect(existsSync(join(cfg.walArchiveDir, seg(1, 0, 1)))).toBe(false);
    expect(existsSync(join(cfg.walArchiveDir, `${seg(1, 0, 3)}.tmp`))).toBe(true);
    const s = readStandby(cfg.statusDir, 'prod');
    expect(s).toMatchObject({
      lastShippedSegment: seg(1, 0, 2),
      pendingSegments: 0,
      localSegments: 2,
      gaps: [],
    });
    expect(s.offsite).toEqual({ configured: true, target: 's3://b/remyral/ @ x', lastError: null });
  });

  it('stops at the first failed upload (no hole off-site) and reports lag; retries later', async () => {
    raw(seg(1, 0, 3));
    raw(seg(1, 0, 4));
    failOn = seg(1, 0, 3);
    const off = { target, prefix: 'remyral', describe: 'd' };
    const r = await shipWal(cfg, {
      tools,
      offsite: off,
      recipients: ['age1x'],
      clock: () => new Date(Date.now() + 120_000),
    });
    expect(r.error).toMatch(/upload of 000000010000000000000003 failed: HTTP 503/);
    expect(puts.some((p) => p.key.includes(seg(1, 0, 4)))).toBe(false);
    const s = readStandby(cfg.statusDir, 'prod');
    expect(s.pendingSegments).toBe(2);
    expect(s.lagSeconds).toBeGreaterThanOrEqual(100);
    failOn = null;
    const r2 = await shipWal(cfg, { tools, offsite: off, recipients: ['age1x'] });
    expect(r2.shipped).toBe(2);
    expect(readStandby(cfg.statusDir, 'prod').pendingSegments).toBe(0);
  });

  it('prunes shipped copies older than the newest local base', async () => {
    mkdirSync(join(cfg.root, 'base'), { recursive: true });
    const id = 'remana-prod-20261018T020000Z';
    writeFileSync(join(cfg.root, 'base', `${id}.base.tar.gz`), 'x');
    writeFileSync(
      join(cfg.root, 'base', `${id}.base.json`),
      JSON.stringify({
        env: 'prod',
        startWalFile: seg(1, 0, 3),
        files: { base: { name: `${id}.base.tar.gz` } },
      }),
    );
    const r = await shipWal(cfg, {
      tools,
      offsite: { target, prefix: 'remyral', describe: 'd' },
      recipients: ['age1x'],
    });
    expect(r.pruned).toBe(2);
    expect(existsSync(join(cfg.root, 'wal', `${seg(1, 0, 1)}.gz`))).toBe(false);
    expect(existsSync(join(cfg.root, 'wal', `${seg(1, 0, 3)}.gz`))).toBe(true);
  });

  it('without recipients nothing leaves the host and the error says why', async () => {
    raw(seg(1, 0, 5));
    const r = await shipWal(cfg, {
      tools,
      offsite: { target, prefix: 'remyral', describe: 'd' },
      recipients: [],
    });
    expect(r.error).toMatch(/recipients\.txt is missing/);
    expect(puts.some((p) => p.key.includes(seg(1, 0, 5)))).toBe(false);
  });
});

describe('base backups', () => {
  const label = [
    'START WAL LOCATION: 0/4000028 (file 000000010000000000000004)',
    'CHECKPOINT LOCATION: 0/4000080',
    'BACKUP METHOD: streamed',
    'BACKUP FROM: primary',
    'START TIME: 2026-10-18 20:47:55 UTC',
    'LABEL: remyral x',
    'START TIMELINE: 1',
    '',
  ].join('\n');

  it('parses backup_label', () => {
    expect(parseBackupLabel(label)).toEqual({
      startLsn: '0/4000028',
      startWalFile: '000000010000000000000004',
      checkpointLsn: '0/4000080',
      timeline: 1,
      startTime: '2026-10-18 20:47:55 UTC',
      label: 'remyral x',
    });
    expect(() => parseBackupLabel('nothing')).toThrow(/START WAL/);
  });

  it('tar leaves out pg_wal contents, pid files and temporary directories; refuses odd paths', () => {
    const args = baseTarArgs('/pgdata/18/docker');
    expect(args.slice(0, 5)).toEqual(['-c', '-f', '-', '-C', '/pgdata/18/docker']);
    for (const x of ['./pg_wal/*', './postmaster.pid', './pg_replslot/*', './pg_stat_tmp/*', 'pgsql_tmp*'])
      expect(args).toContain(`--exclude=${x}`);
    expect(args.at(-1)).toBe('.');
    expect(() => baseTarArgs('/pg data;rm')).toThrow(/unsafe/);
  });

  it('lease key id: first 16 base64url chars of SHA-256 over the raw Ed25519 public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const want = createHash('sha256').update(raw).digest('base64url').slice(0, 16);
    expect(leaseKeyKidFromPem(privateKey.export({ format: 'pem', type: 'pkcs8' }))).toBe(want);
    expect(leaseKeyKidFromPem('not a key')).toBeNull();
  });

  it('validates manifests', () => {
    const id = 'remana-prod-20261018T020000Z';
    const m = {
      format: BASE_FORMAT,
      id,
      env: 'prod',
      startWalFile: '000000010000000000000004',
      timeline: 1,
      labelFile: label,
      tablespaceMap: null,
      leaseKeyKid: 'AbCdEfGhIjKlMn_-',
      files: { base: { name: `${id}.base.tar.gz`, bytes: 10, sha256: 'a'.repeat(64) } },
      offsite: null,
    };
    expect(validateBaseManifest(m)).toBe(m);
    expect(() => validateBaseManifest({ ...m, env: 'staging' })).toThrow(/id\/env/);
    expect(() => validateBaseManifest({ ...m, startWalFile: '00000001.history' })).toThrow(/startWalFile/);
    expect(() => validateBaseManifest({ ...m, files: { base: { ...m.files.base, name: '../x' } } })).toThrow(
      /files\.base\.name/,
    );
    expect(baseObjectKeys({ prefix: 'remyral', id })).toEqual({
      tar: `remyral/base/prod/${id}.base.tar.gz.age`,
      manifest: `remyral/base/prod/${id}.base.json`,
    });
  });

  it('daemon schedule: first base at once, then every 20 h; a failing one retries hourly', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    const h = (n) => new Date(now.getTime() - n * 3_600_000);
    expect(baseBackupDue({ now, lastSuccessAt: null, lastAttemptAt: null })).toBe(true);
    expect(baseBackupDue({ now, lastSuccessAt: null, lastAttemptAt: h(0.5) })).toBe(false);
    expect(baseBackupDue({ now, lastSuccessAt: null, lastAttemptAt: h(2) })).toBe(true);
    expect(baseBackupDue({ now, lastSuccessAt: h(10), lastAttemptAt: h(10) })).toBe(false);
    expect(baseBackupDue({ now, lastSuccessAt: h(21), lastAttemptAt: h(21) })).toBe(true);
    expect(baseBackupDue({ now, lastSuccessAt: h(30), lastAttemptAt: h(0.2) })).toBe(false);
  });
});

describe('standby restore: selection and preparation', () => {
  const env = 'prod';
  const keys = [
    'remyral/base/prod/remana-prod-20261017T023000Z.base.json',
    'remyral/base/prod/remana-prod-20261017T023000Z.base.tar.gz.age',
    'remyral/base/prod/remana-prod-20261018T023000Z.base.tar.gz.age', // newest: manifest not uploaded yet
    'remyral/base/staging/remana-staging-20261019T023000Z.base.json',
    'remyral/base/staging/remana-staging-20261019T023000Z.base.tar.gz.age',
  ];

  it('newest complete base of the environment', () => {
    expect(newestBase(keys, env)).toEqual({
      id: 'remana-prod-20261017T023000Z',
      manifestKey: keys[0],
      tarKey: keys[1],
    });
    expect(newestBase(keys, env, 'remana-prod-20261018T023000Z')).toBeNull();
    expect(newestBase([], env)).toBeNull();
  });

  it('newest secrets archive across tiers', () => {
    expect(
      newestSecrets(
        [
          'remyral/weekly/prod/2026/10/12/remana-prod-20261012T023000Z.secrets.tar.age',
          'remyral/daily/prod/2026/10/18/remana-prod-20261018T023000Z.secrets.tar.age',
          'remyral/daily/staging/2026/10/19/remana-staging-20261019T023000Z.secrets.tar.age',
        ],
        env,
      ),
    ).toEqual({
      id: 'remana-prod-20261018T023000Z',
      key: 'remyral/daily/prod/2026/10/18/remana-prod-20261018T023000Z.secrets.tar.age',
    });
  });

  it('WAL objects for a base, in order', () => {
    const k = (n) => `remyral/wal/prod/${n}.gz.age`;
    const objs = walObjectsForBase(
      [k(seg(1, 0, 2)), k(seg(1, 0, 4)), k(seg(1, 0, 3)), k('00000001.history'), 'remyral/wal/prod/x.gz.age'],
      env,
      seg(1, 0, 3),
    );
    expect(objs.map((o) => o.name)).toEqual(['00000001.history', seg(1, 0, 3), seg(1, 0, 4)]);
  });

  it('data directory script refuses an existing cluster and writes the recovery files', () => {
    expect(pgdataFor('18.6')).toBe('/var/lib/postgresql/18/docker');
    expect(() => pgdataFor('16.2')).toThrow(/unsupported/);
    const s = prepareDataDirScript({ pgdata: '/var/lib/postgresql/18/docker', hasTablespaceMap: false });
    expect(s).toMatch(/refusing: \$D already holds a cluster/);
    expect(s).toMatch(/recovery\.signal/);
    expect(s).not.toMatch(/tablespace_map/);
    expect(() => prepareDataDirScript({ pgdata: '/tmp/x', hasTablespaceMap: false })).toThrow();
  });

  it('recovery settings: restore from gzip copies; a target time promotes there', () => {
    expect(localRestoreCommand('/staging/wal')).toBe(
      'test -f /staging/wal/%f.gz && gunzip -c /staging/wal/%f.gz > %p',
    );
    expect(() => localRestoreCommand("/x'; rm -rf /")).toThrow(/unsafe/);
    const c = recoveryConf({
      restoreCommand: "a'b",
      targetTime: targetTimeSetting('2026-10-18T10:00:00.123Z'),
    });
    expect(c).toContain("restore_command = 'a''b'");
    expect(c).toContain("recovery_target_time = '2026-10-18 10:00:00+00'");
    expect(c).toContain("recovery_target_action = 'promote'");
    expect(recoveryConf({ restoreCommand: 'x' })).not.toContain('recovery_target_time =');
    expect(() => targetTimeSetting('yesterday')).toThrow(/ISO/);
  });
});

describe('Cloudflare DNS cutover', () => {
  const zoneId = '0123456789abcdef0123456789abcdef';
  const recordId = 'fedcba9876543210fedcba9876543210';

  it('builds the lookup and update requests', () => {
    expect(recordTypeFor('203.0.113.9')).toBe('A');
    expect(recordTypeFor('2001:db8::1')).toBe('AAAA');
    expect(() => recordTypeFor('remyral.example.com')).toThrow(/not an IP/);
    expect(cfListRequest({ zoneId, name: 'Remyral.Example.com', type: 'A' }).url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name.exact=remyral.example.com`,
    );
    expect(cfPatchRequest({ zoneId, recordId, ip: '203.0.113.9' })).toEqual({
      method: 'PATCH',
      url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
      body: { content: '203.0.113.9' },
    });
    expect(() => cfListRequest({ zoneId: 'nope', name: 'x', type: 'A' })).toThrow(/zone id/);
  });

  function fakeFetch(records, { patchOk = true } = {}) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ?? null });
      if (init.method === 'GET')
        return { ok: true, status: 200, json: async () => ({ success: true, result: records }) };
      const body = JSON.parse(init.body);
      return patchOk
        ? {
            ok: true,
            status: 200,
            json: async () => ({ success: true, result: { ...records[0], content: body.content } }),
          }
        : {
            ok: false,
            status: 403,
            json: async () => ({
              success: false,
              errors: [{ code: 10000, message: 'Authentication error' }],
            }),
          };
    };
    return { impl, calls };
  }

  it('points the one record at the new address, keeps proxied, sends the token only as a header', async () => {
    const f = fakeFetch([{ id: recordId, content: '198.51.100.4', proxied: true }]);
    const r = await cloudflareCutover({
      token: 'tok',
      zoneId,
      name: 'remyral.example.com',
      ip: '203.0.113.9',
      fetchImpl: f.impl,
    });
    expect(r).toEqual({ recordId, from: '198.51.100.4', to: '203.0.113.9', proxied: true, changed: true });
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(f.calls.every((c) => c.auth === 'Bearer tok' && !c.url.includes('tok'))).toBe(true);
    expect(JSON.parse(f.calls[1].body)).toEqual({ content: '203.0.113.9' });
  });

  it('dry run and no-op change make no PATCH; ambiguous records and API errors fail', async () => {
    const one = [{ id: recordId, content: '198.51.100.4', proxied: false }];
    let f = fakeFetch(one);
    expect(
      (
        await cloudflareCutover({
          token: 't',
          zoneId,
          name: 'h.example.com',
          ip: '203.0.113.9',
          dryRun: true,
          fetchImpl: f.impl,
        })
      ).changed,
    ).toBe(false);
    expect(f.calls).toHaveLength(1);
    f = fakeFetch(one);
    await cloudflareCutover({
      token: 't',
      zoneId,
      name: 'h.example.com',
      ip: '198.51.100.4',
      fetchImpl: f.impl,
    });
    expect(f.calls).toHaveLength(1);
    f = fakeFetch([...one, { ...one[0], id: '1'.repeat(32) }]);
    await expect(
      cloudflareCutover({ token: 't', zoneId, name: 'h.example.com', ip: '203.0.113.9', fetchImpl: f.impl }),
    ).rejects.toThrow(/exactly one A record/);
    f = fakeFetch(one, { patchOk: false });
    await expect(
      cloudflareCutover({ token: 't', zoneId, name: 'h.example.com', ip: '203.0.113.9', fetchImpl: f.impl }),
    ).rejects.toThrow(/HTTP 403/);
    await expect(cloudflareCutover({ token: '', zoneId, name: 'h', ip: '203.0.113.9' })).rejects.toThrow(
      /CLOUDFLARE_API_TOKEN/,
    );
  });
});

describe('S3 read side (list, download)', () => {
  let server;
  let cfg;
  const store = new Map([
    ['/b/remyral/wal/prod/a.gz.age', Buffer.from('aaa')],
    ['/b/remyral/wal/prod/b.gz.age', Buffer.from('bbbb')],
    ['/b/other/x', Buffer.from('x')],
  ]);
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (!String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=K/'))
        return res.writeHead(403).end();
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix');
        const all = [...store.keys()].map((k) => k.slice(3)).filter((k) => k.startsWith(prefix));
        const token = url.searchParams.get('continuation-token');
        const page = token ? all.slice(1) : all.slice(0, 1);
        const more = !token && all.length > 1;
        return res
          .writeHead(200)
          .end(
            `<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>${String(more)}</IsTruncated>${more ? '<NextContinuationToken>t2</NextContinuationToken>' : ''}</ListBucketResult>`,
          );
      }
      const body = store.get(url.pathname);
      if (!body) return res.writeHead(404).end();
      return res
        .writeHead(200, { 'x-amz-meta-sha256': createHash('sha256').update(body).digest('hex') })
        .end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cfg = {
      bucket: 'b',
      region: 'auto',
      endpoint: new URL(`http://127.0.0.1:${String(server.address().port)}`),
      pathStyle: true,
      prefix: 'remyral',
      accessKeyId: 'K',
      secretAccessKey: 'S',
    };
  });
  afterAll(() => server.close());

  it('lists every page under a prefix and downloads with the hash checked', async () => {
    const t = new S3Target(cfg);
    expect(await t.list('remyral/wal/prod/')).toEqual([
      'remyral/wal/prod/a.gz.age',
      'remyral/wal/prod/b.gz.age',
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'remyral-s3get-'));
    const r = await t.getToFile('remyral/wal/prod/b.gz.age', join(dir, 'b'));
    expect(r.bytes).toBe(4);
    expect(r.sha256).toBe(r.metaSha256);
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('bbbb');
    await expect(t.getToFile('remyral/missing', join(dir, 'm'))).rejects.toThrow(/HTTP 404/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('p17-remyral-rebrand: names of the restored installation', () => {
  it('reads the pinned project and database, recognises a pre-rename stack.env, defaults to remyral', () => {
    expect(installationNames('REMYRAL_PROJECT=remana-prod\nREMYRAL_DB_NAME=remana\n', 'prod')).toEqual({
      project: 'remana-prod',
      db: 'remana',
    });
    expect(installationNames('REMANA_ENV=prod\nREMANA_DB_APP_PASSWORD=x\n', 'prod')).toEqual({
      project: 'remana-prod',
      db: 'remana',
    });
    expect(installationNames('REMYRAL_ENV=staging\n', 'staging')).toEqual({
      project: 'remyral-staging',
      db: 'remyral',
    });
    expect(installationNames('', 'prod')).toEqual({ project: 'remyral-prod', db: 'remyral' });
  });
});
