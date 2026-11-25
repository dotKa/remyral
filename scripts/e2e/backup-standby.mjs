#!/usr/bin/env node
/* global setTimeout, clearTimeout */
// Warm standby end to end (p11-master-resilience, docs/ops/backup-restore.md §10–§11):
//
//   pnpm e2e:backup-standby [--keep]
//
// Builds infra/backup/Dockerfile, starts the PRODUCTION Postgres service with PG_WAL_ARCHIVE=on in a throw-away
// compose project, applies the real migrations, writes an audit chain, then: logical backup + encrypted secrets
// off-site → physical base backup (low-level API as the read-only remyral_backup role) off-site → more writes after
// the base → WAL shipped (gzip + age) to a signature-checking fake S3 → the weekly drill replays base + local WAL
// (standby checks) → the "fresh host": compose project down with its volume, `standby-restore.mjs fetch` (owner
// identity) + `restore` into a new labelled volume → compose postgres adopts that volume and has every row written
// after the base. Needs Docker and age/age-keygen.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eventHashHex, GENESIS_HASH_HEX } from '../../infra/backup/runner/lib/audit-chain.mjs';
import { leaseKeyKidFromPem } from '../../infra/backup/runner/lib/basebackup.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const RUN_ID = randomBytes(3).toString('hex');
const ENV = `e2esb${RUN_ID}`;
const PROJECT = `remyral-${ENV}`;
const IMAGE = `remyral-backup:e2e-sb-${RUN_ID}`;
const COMPOSE_FILE = join(ROOT, 'infra/coolify/compose.yaml');

const results = [];
const t0 = Date.now();
const log = (m) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}\n`);
class StepFailed extends Error {}
async function check(name, fn) {
  const start = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, ms: Date.now() - start });
    log(`PASS ${name}${detail ? ` — ${String(detail)}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - start });
    log(`FAIL ${name} — ${err instanceof Error ? err.message : String(err)}`);
    throw new StepFailed(name);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { input, env, timeoutMs = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
async function must(cmd, args, o) {
  const r = await run(cmd, args, o);
  if (r.code !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 4).join(' ')} … exited ${String(r.code)}: ${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join(' | ')}`,
    );
  return r;
}

// ---------------------------------------------------------------- layout

const WORK = mkdtempSync(join(tmpdir(), 'remyral-e2e-standby-'));
const OWNER = join(WORK, 'owner');
const DATA = join(WORK, 'data', ENV);
const BACKUPS = join(DATA, 'backups');
const CONFIG = join(DATA, 'backup-config');
for (const d of [OWNER, join(DATA, 'secrets'), CONFIG, BACKUPS]) mkdirSync(d, { recursive: true });
const hex = () => randomBytes(24).toString('hex');
const pw = {
  POSTGRES_SUPERUSER_PASSWORD: hex(),
  REMYRAL_DB_OWNER_PASSWORD: hex(),
  REMYRAL_DB_APP_PASSWORD: hex(),
  REMYRAL_DB_BACKUP_PASSWORD: hex(),
  REDIS_PASSWORD: hex(),
};
const STACK_ENV = join(DATA, 'stack.env');
writeFileSync(
  STACK_ENV,
  `${Object.entries({
    REMYRAL_ENV: ENV,
    REMYRAL_DOMAIN: 'backup-standby-e2e.invalid',
    REMYRAL_SECRETS_DIR: join(DATA, 'secrets'),
    REMYRAL_BACKUP_DIR: BACKUPS,
    REMYRAL_STACK_ENV_FILE: STACK_ENV,
    REMYRAL_BACKUP_CONFIG_DIR: CONFIG,
    REMYRAL_BACKUP_IMAGE: IMAGE,
    REMYRAL_PULL_POLICY: 'never',
    PG_WAL_ARCHIVE: 'on',
    ...pw,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
  { mode: 0o600 },
);
writeFileSync(join(DATA, 'secrets/totp.key'), `${randomBytes(32).toString('base64')}\n`, { mode: 0o400 });
const LEASE_PEM = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
writeFileSync(join(DATA, 'secrets/lease-signing.pem'), LEASE_PEM, { mode: 0o400 });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const compose = (...args) =>
  run('docker', ['compose', '-p', PROJECT, '--env-file', STACK_ENV, '-f', COMPOSE_FILE, ...args]);
const backupCmd = (...args) => compose('run', '--rm', '--no-TTY', 'backup', ...args);

async function pgContainer() {
  const ps = await must('docker', [
    'compose',
    '-p',
    PROJECT,
    '--env-file',
    STACK_ENV,
    '-f',
    COMPOSE_FILE,
    'ps',
    '-q',
    'postgres',
  ]);
  return ps.stdout.trim();
}
async function psqlAs(user, password, sql) {
  const r = await run(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      await pgContainer(),
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      user,
      '-d',
      'remyral',
      '-X',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: `${sql}\n`, env: { PGPASSWORD: password } },
  );
  if (r.code !== 0) throw new Error(`psql as ${user}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
const superSql = (sql) => psqlAs('postgres', pw.POSTGRES_SUPERUSER_PASSWORD, sql);

/** Minimal S3: PUT / HEAD / GET / ListObjectsV2 (path style), checks the signed payload hash and Content-MD5. */
const objects = new Map();
const s3 = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    if (!/^AWS4-HMAC-SHA256 Credential=E2EKEY\//.test(String(req.headers.authorization)))
      return res.writeHead(403).end();
    if (req.method === 'PUT') {
      if (sha256(body) !== req.headers['x-amz-content-sha256'])
        return res.writeHead(400).end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
      if (createHash('md5').update(body).digest('base64') !== req.headers['content-md5'])
        return res.writeHead(400).end('<Error><Code>BadDigest</Code></Error>');
      objects.set(decodeURIComponent(url.pathname), { body, sha: req.headers['x-amz-meta-sha256'] });
      return res.writeHead(200).end();
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const bucket = url.pathname.split('/')[1];
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(`/${bucket}/${prefix}`))
        .map((k) => k.slice(bucket.length + 2))
        .sort();
      return res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
    }
    const o = objects.get(decodeURIComponent(url.pathname));
    if (req.method === 'HEAD')
      return o
        ? res.writeHead(200, { 'content-length': String(o.body.length), 'x-amz-meta-sha256': o.sha }).end()
        : res.writeHead(404).end();
    if (req.method === 'GET')
      return o ? res.writeHead(200, { 'x-amz-meta-sha256': o.sha }).end(o.body) : res.writeHead(404).end();
    return res.writeHead(400).end();
  });
});

let prevHash = GENESIS_HASH_HEX;
let nextId = 1;
async function auditRows(n, tag) {
  const values = [];
  for (let i = 0; i < n; i += 1) {
    const row = {
      id: String(nextId),
      occurredAt: new Date(Date.UTC(2026, 9, 18, 0, 0, 0, nextId * 7)).toISOString(),
      actorType: 'system',
      actorId: null,
      action: 'e2e.standby',
      target: `${tag}-${String(nextId)}`,
      outcome: 'success',
      ip: null,
      userAgent: null,
      metadata: { run: RUN_ID, tag },
      prevHash,
    };
    const h = eventHashHex(row);
    values.push(
      `(${row.id}, '${row.occurredAt}', 'system', NULL, 'e2e.standby', '${row.target}', 'success', NULL, NULL, '${JSON.stringify(row.metadata)}'::jsonb, '\\x${prevHash}', '\\x${h}')`,
    );
    prevHash = h;
    nextId += 1;
  }
  await psqlAs(
    'remyral_app',
    pw.REMYRAL_DB_APP_PASSWORD,
    `INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, action, target, outcome, ip, user_agent, metadata, prev_hash, hash) VALUES ${values.join(',\n')};`,
  );
}

const readStandby = () => JSON.parse(readFileSync(join(BACKUPS, 'status/standby.json'), 'utf8'));
const S3_ENV = () =>
  [
    'BACKUP_S3_BUCKET=remyral-e2e',
    `BACKUP_S3_ENDPOINT=http://host.docker.internal:${String(s3.address().port)}`,
    'BACKUP_S3_ALLOW_HTTP=test-only',
    'BACKUP_S3_ACCESS_KEY_ID=E2EKEY',
    'BACKUP_S3_SECRET_ACCESS_KEY=e2e-secret',
    '',
  ].join('\n');

async function main() {
  log(`run ${RUN_ID}, work dir ${WORK}`);
  await new Promise((resolve) => s3.listen(0, '0.0.0.0', resolve));

  await check('image builds', async () => {
    await must('docker', ['build', '-q', '-f', join(ROOT, 'infra/backup/Dockerfile'), '-t', IMAGE, ROOT], {
      timeoutMs: 900_000,
    });
    return IMAGE;
  });

  await check('owner key + off-site target', async () => {
    await must('age-keygen', ['-o', join(OWNER, 'identity.txt')]);
    const pub = (await must('age-keygen', ['-y', join(OWNER, 'identity.txt')])).stdout.trim();
    writeFileSync(join(CONFIG, 'recipients.txt'), `${pub}\n`, { mode: 0o644 });
    writeFileSync(join(CONFIG, 'offsite.env'), S3_ENV(), { mode: 0o600 });
    return `${pub.slice(0, 12)}…`;
  });

  await check('production postgres with PG_WAL_ARCHIVE=on: archive_mode on, base-backup grants', async () => {
    const up = await compose('up', '-d', '--wait', 'postgres');
    assert(up.code === 0, up.stderr);
    const mode = await superSql(
      "SELECT current_setting('archive_mode') || ' ' || current_setting('archive_timeout')",
    );
    assert(mode === 'on 3min', mode);
    const grant = await superSql(
      "SELECT has_function_privilege('remyral_backup', 'pg_backup_start(text, boolean)', 'EXECUTE') AND has_function_privilege('remyral_backup', 'pg_backup_stop(boolean)', 'EXECUTE')",
    );
    assert(grant === 't', 'remyral_backup lacks the base-backup grants');
    const dir = join(ROOT, 'apps/master/migrations');
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    await psqlAs(
      'remyral_owner',
      pw.REMYRAL_DB_OWNER_PASSWORD,
      'CREATE TABLE schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());',
    );
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const [, version, name] = /^(\d{4})_(.+)\.sql$/.exec(f);
      await psqlAs(
        'remyral_owner',
        pw.REMYRAL_DB_OWNER_PASSWORD,
        `BEGIN;\n${sql}\n;INSERT INTO schema_migrations (version, name, checksum) VALUES ('${version}', '${name}', '${sha256(sql)}');\nCOMMIT;`,
      );
    }
    await psqlAs(
      'remyral_app',
      pw.REMYRAL_DB_APP_PASSWORD,
      "INSERT INTO users (username, role, password_hash) VALUES ('owner1', 'owner', '$scrypt$e2e');",
    );
    await auditRows(200, 'before-base');
    return `${String(files.length)} migrations, 200 audit events, ${mode}`;
  });

  await check(
    'logical backup with encrypted secrets off-site (standby restore takes the secrets from it)',
    async () => {
      const r = await backupCmd('run', '--reason', 'e2e');
      const out = JSON.parse(r.stdout || '{}');
      assert(
        r.code === 0 && out.outcome === 'ok' && out.offsite.status === 'uploaded',
        `${r.stdout}${r.stderr}`,
      );
      return out.runId;
    },
  );

  let base;
  await check(
    'physical base backup (low-level API as read-only remyral_backup), encrypted off-site',
    async () => {
      const r = await backupCmd('base', '--reason', 'e2e');
      base = JSON.parse(r.stdout || '{}');
      assert(
        r.code === 0 && base.outcome === 'ok' && base.offsite.status === 'uploaded',
        `${r.stdout}${r.stderr}`,
      );
      const m = JSON.parse(readFileSync(join(BACKUPS, `base/${base.id}.base.json`), 'utf8'));
      assert(m.leaseKeyKid === leaseKeyKidFromPem(LEASE_PEM), `lease kid ${String(m.leaseKeyKid)}`);
      const keys = [...objects.keys()].filter((k) => k.includes('/base/'));
      assert(keys.length === 2, keys.join(' '));
      const enc = objects.get(keys.find((k) => k.endsWith('.age'))).body;
      assert(!enc.includes(Buffer.from('PG_VERSION')), 'base off-site is not encrypted');
      return `${base.id}: ${String(base.bytes)} B, starts ${base.startWalFile}, kid ${m.leaseKeyKid}`;
    },
  );

  await check(
    'writes after the base reach off-site as WAL (gzip + age), local copy kept, raw removed',
    async () => {
      await auditRows(25, 'after-base');
      await superSql('SELECT pg_switch_wal()');
      for (let i = 0; i < 30; i += 1) {
        if (Number(await superSql('SELECT archived_count FROM pg_stat_archiver')) > 0) break;
        await sleep(500);
      }
      const r = await backupCmd('wal-ship');
      const out = JSON.parse(r.stdout || '{}');
      assert(r.code === 0 && out.shipped > 0 && !out.error, `${r.stdout}${r.stderr}`);
      const sb = readStandby();
      assert(sb.lastShippedSegment && sb.pendingSegments === 0 && sb.gaps.length === 0, JSON.stringify(sb));
      const walKeys = [...objects.keys()].filter((k) => k.includes('/wal/'));
      assert(walKeys.length === out.shipped, `${String(walKeys.length)} objects`);
      const left = await must('docker', ['exec', await pgContainer(), 'ls', '/wal-archive']);
      assert(!/^[0-9A-F]{24}$/m.test(left.stdout), `raw segments left in the archive volume: ${left.stdout}`);
      return `${String(out.shipped)} WAL files shipped, last ${sb.lastShippedSegment}, lag ${String(sb.lagSeconds)} s`;
    },
  );

  await check('weekly drill: logical restore + standby replay (base + local WAL) pass', async () => {
    const r = await backupCmd('drill');
    const rep = JSON.parse(r.stdout || '{}');
    assert(r.code === 0 && rep.outcome === 'passed', `${r.stdout}${r.stderr}`);
    const names = rep.checks.map((c) => c.name);
    for (const n of [
      'standby_base_integrity',
      'standby_wal_chain',
      'standby_replay',
      'standby_schema',
      'standby_audit_chain',
    ])
      assert(names.includes(n), `missing ${n}: ${names.join(',')}`);
    assert(rep.standby?.outcome === 'passed', JSON.stringify(rep.standby));
    const audit = rep.checks.find((c) => c.name === 'standby_audit_chain').detail;
    assert(/225 events/.test(audit), audit);
    return `${rep.standby.replayedSegments} segments, ${String(rep.standby.restoreMs)} ms; ${audit}`;
  });

  await check(
    'fresh host: fetch (owner identity) + restore into a new volume; compose adopts it; rows after the base present',
    async () => {
      await compose('--profile', 'backup', 'down', '-v', '--remove-orphans');
      const staging = join(WORK, 'staging');
      const off = join(OWNER, 'offsite-read.env');
      writeFileSync(off, S3_ENV().replace('host.docker.internal', '127.0.0.1'), { mode: 0o600 });
      await must('node', [
        join(ROOT, 'scripts/ops/standby-restore.mjs'),
        'fetch',
        '--env',
        ENV,
        '--offsite',
        off,
        '--identity',
        join(OWNER, 'identity.txt'),
        '--out',
        staging,
      ]);
      assert(
        existsSync(join(staging, 'secrets.tar')) && existsSync(join(staging, 'base.tar.gz')),
        'staging incomplete',
      );
      const newHost = join(WORK, 'newhost');
      const r = await must('node', [
        join(ROOT, 'scripts/ops/standby-restore.mjs'),
        'restore',
        '--env',
        ENV,
        '--staging',
        staging,
        '--data-root',
        newHost,
      ]);
      assert(
        /OK +lease_key/.test(r.stdout) && /OK +audit_chain/.test(r.stdout) && !/FAIL/.test(r.stdout),
        r.stdout,
      );
      const up = await compose('up', '-d', '--wait', 'postgres');
      assert(up.code === 0, up.stderr);
      const n = await superSql("SELECT count(*) FROM audit_events WHERE target LIKE 'after-base-%'");
      assert(n === '25', `after-base rows: ${n}`);
      const rec = await superSql('SELECT pg_is_in_recovery()');
      assert(rec === 'f', 'restored server still in recovery');
      return `25/25 rows written after the base restored; ${r.stdout.split('\n').filter((l) => l.startsWith('OK')).length} checks OK`;
    },
  );
}

async function cleanup() {
  s3.close();
  await compose('--profile', 'backup', 'down', '-v', '--remove-orphans');
  await run('docker', ['rm', '-f', `${PROJECT}-standby-restore`]);
  await run('docker', ['volume', 'rm', `${PROJECT}_pgdata`]);
  await run('docker', ['image', 'rm', IMAGE]);
  // Files written by containers as root/uid 70 (bind mounts): remove them from a container.
  await run('docker', [
    'run',
    '--rm',
    '-v',
    `${WORK}:/w`,
    '--entrypoint',
    'sh',
    'postgres:18.6-alpine',
    '-c',
    'rm -rf /w/data /w/staging /w/newhost',
  ]);
  rmSync(WORK, { recursive: true, force: true });
}

try {
  await main();
} catch (err) {
  if (!(err instanceof StepFailed)) log(`ERROR ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  if (opts.keep) log(`--keep: project ${PROJECT}, work dir ${WORK}`);
  else await cleanup();
  const failed = results.filter((r) => !r.ok).length;
  log(`${String(results.length - failed)}/${String(results.length)} checks passed`);
  process.exit(failed === 0 && results.length > 0 ? 0 : 1);
}
