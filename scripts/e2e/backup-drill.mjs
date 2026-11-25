#!/usr/bin/env node
/* global setTimeout, clearTimeout */
// Backup service + restore drill end to end (p10-backup-restore, docs/ops/backup-restore.md §7):
//
//   pnpm e2e:backup-drill [--keep]
//
// Builds infra/backup/Dockerfile, starts the PRODUCTION Postgres service (infra/coolify/compose.yaml, initdb hook
// with the read-only remyral_backup role) in a throw-away compose project, applies the real migrations, writes a
// valid audit hash chain, then runs the `backup` compose service exactly as configured (caps, read-only root,
// mounts): backup → encrypted secrets archive (decrypted here with the "owner" identity only) → off-site copy to a
// signature-verifying fake S3 on the host → restore drill inside the container (no TCP listener) → the drill as
// its own compose project (network_mode: none) → tamper and private-key refusals → daemon heartbeat.
// Needs Docker and age/age-keygen. Does not touch the dev stack.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const RUN_ID = randomBytes(3).toString('hex');
const ENV = `e2ebk${RUN_ID}`;
const PROJECT = `remyral-${ENV}`;
const DRILL_PROJECT = `remyral-${ENV}-drill`;
const IMAGE = `remyral-backup:e2e-${RUN_ID}`;
const COMPOSE_FILE = join(ROOT, 'infra/coolify/compose.yaml');
const DRILL_FILE = join(ROOT, 'infra/backup/drill.compose.yaml');

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

function run(cmd, args, { input, env, timeoutMs = 600_000 } = {}) {
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
      `${cmd} ${args.slice(0, 4).join(' ')} … exited ${String(r.code)}: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}`,
    );
  return r;
}

// ---------------------------------------------------------------- layout

const WORK = mkdtempSync(join(tmpdir(), 'remyral-e2e-bkdrill-'));
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
    REMYRAL_DOMAIN: 'backup-drill-e2e.invalid',
    REMYRAL_SECRETS_DIR: join(DATA, 'secrets'),
    REMYRAL_BACKUP_DIR: BACKUPS,
    REMYRAL_STACK_ENV_FILE: join(DATA, 'stack.env'),
    REMYRAL_BACKUP_CONFIG_DIR: CONFIG,
    REMYRAL_BACKUP_IMAGE: IMAGE,
    REMYRAL_PULL_POLICY: 'never',
    ...pw,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
  { mode: 0o600 },
);
const TOTP = `${randomBytes(32).toString('base64')}\n`;
writeFileSync(join(DATA, 'secrets/totp.key'), TOTP, { mode: 0o400 });
writeFileSync(join(DATA, 'secrets/lease-signing.pem'), `fake-pem-${hex()}\n`, { mode: 0o400 });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const compose = (...args) =>
  run('docker', ['compose', '-p', PROJECT, '--env-file', STACK_ENV, '-f', COMPOSE_FILE, ...args]);
const backupCmd = (...args) => compose('run', '--rm', '--no-TTY', 'backup', ...args);

async function psqlAs(user, password, sql) {
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
  const r = await run(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      ps.stdout.trim(),
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

/** Minimal S3 on the host: PUT/HEAD, multipart not needed (small objects); checks payload hash and MD5. */
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
      objects.set(url.pathname, { body, sha: req.headers['x-amz-meta-sha256'] });
      return res.writeHead(200).end();
    }
    if (req.method === 'HEAD') {
      const o = objects.get(url.pathname);
      return o
        ? res.writeHead(200, { 'content-length': String(o.body.length), 'x-amz-meta-sha256': o.sha }).end()
        : res.writeHead(404).end();
    }
    return res.writeHead(400).end();
  });
});

const listDir = (d) => (existsSync(d) ? readdirSync(d) : []);
const readStatus = () => JSON.parse(readFileSync(join(BACKUPS, 'status/status.json'), 'utf8'));

async function main() {
  log(`run ${RUN_ID}, work dir ${WORK}`);

  await check('image: infra/backup/Dockerfile builds (postgres 18.6 + node + age)', async () => {
    await must('docker', ['build', '-q', '-f', join(ROOT, 'infra/backup/Dockerfile'), '-t', IMAGE, ROOT], {
      timeoutMs: 900_000,
    });
    const v = await must('docker', ['run', '--rm', '--entrypoint', 'node', IMAGE, '--version']);
    return `${IMAGE}, node ${v.stdout.trim()}`;
  });

  await check('owner key: identity stays with the owner, server gets the public key', async () => {
    await must('age-keygen', ['-o', join(OWNER, 'identity.txt')]);
    const pub = (await must('age-keygen', ['-y', join(OWNER, 'identity.txt')])).stdout.trim();
    writeFileSync(join(CONFIG, 'recipients.txt'), `# owner\n${pub}\n`, { mode: 0o644 });
    return `${pub.slice(0, 12)}…`;
  });

  await check('source: production postgres service, migrations, valid audit chain', async () => {
    const up = await compose('up', '-d', '--wait', 'postgres');
    assert(up.code === 0, up.stderr);
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
    let prev = GENESIS_HASH_HEX;
    const values = [];
    for (let i = 1; i <= 300; i += 1) {
      const row = {
        id: String(i),
        occurredAt: new Date(Date.UTC(2026, 9, 18, 0, 0, 0, i * 7)).toISOString(),
        actorType: 'system',
        actorId: null,
        action: 'e2e.backup',
        target: `row-${String(i)}`,
        outcome: 'success',
        ip: null,
        userAgent: null,
        metadata: { run: RUN_ID, n: i, nested: { b: [1, 2], a: 'x' } },
        prevHash: prev,
      };
      const h = eventHashHex(row);
      values.push(
        `(${row.id}, '${row.occurredAt}', 'system', NULL, 'e2e.backup', '${row.target}', 'success', NULL, NULL, '${JSON.stringify(row.metadata)}'::jsonb, '\\x${prev}', '\\x${h}')`,
      );
      prev = h;
    }
    await psqlAs(
      'remyral_app',
      pw.REMYRAL_DB_APP_PASSWORD,
      `INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, action, target, outcome, ip, user_agent, metadata, prev_hash, hash) VALUES ${values.join(',\n')};`,
    );
    return `${String(files.length)} migrations, 300 chained audit events`;
  });

  await check('config check: recipients, database as read-only remyral_backup', async () => {
    const r = await backupCmd('check');
    assert(r.code === 0, `${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert(out.database.user === 'remyral_backup' && out.database.readOnly === 'on', r.stdout);
    return `${out.offsite}, ${String(out.recipients)} recipient`;
  });

  let first;
  await check(
    'backup run (no off-site): consistent dump + manifest + encrypted secrets, status.json',
    async () => {
      const r = await backupCmd('run', '--reason', 'e2e');
      assert(r.code === 0, `${r.stdout}${r.stderr}`);
      first = JSON.parse(r.stdout);
      assert(
        first.outcome === 'ok' && first.secrets === 'ok' && first.offsite.status === 'not_configured',
        r.stdout,
      );
      const m = JSON.parse(readFileSync(join(BACKUPS, `db/${first.runId}.manifest.json`), 'utf8'));
      assert(
        m.tables.audit_events === 300 && m.auditHead.id === '300' && m.schema.count > 70,
        JSON.stringify(m.schema),
      );
      assert(
        m.fingerprints.some((f) => f.table === 'audit_events' && f.id === '300'),
        'fingerprint missing',
      );
      const status = readStatus();
      assert(status.lastSuccessfulBackup.runId === first.runId, 'status not updated');
      return `${first.runId}: ${String(first.dbBytes)} B, schema ${m.schema.version}, tier ${m.tier}`;
    },
  );

  await check('secrets archive: only the owner identity decrypts it; contents byte-identical', async () => {
    const enc = join(BACKUPS, `secrets/${first.runId}.secrets.tar.age`);
    const raw = readFileSync(enc);
    assert(!raw.includes(Buffer.from(TOTP.trim())), 'plaintext TOTP key in the archive');
    const out = join(WORK, 'restored');
    mkdirSync(out);
    await must('age', ['-d', '-i', join(OWNER, 'identity.txt'), '-o', join(out, 's.tar'), enc]);
    await must('tar', ['-x', '-f', join(out, 's.tar'), '-C', out]);
    assert(readFileSync(join(out, 'secrets/totp.key'), 'utf8') === TOTP, 'totp.key differs');
    assert(
      readFileSync(join(out, 'stack.env'), 'utf8').includes(pw.REMYRAL_DB_BACKUP_PASSWORD),
      'stack.env missing',
    );
    assert(existsSync(join(out, 'backup-config/recipients.txt')), 'backup-config missing');
    // a foreign identity cannot decrypt
    await must('age-keygen', ['-o', join(OWNER, 'other.txt')]);
    const bad = await run('age', ['-d', '-i', join(OWNER, 'other.txt'), '-o', join(out, 'x'), enc]);
    assert(bad.code !== 0, 'foreign identity decrypted the archive');
    return 'totp.key, lease-signing.pem, stack.env, backup-config restored';
  });

  await check(
    'restore drill in the service container: throw-away server, all checks pass, scratch removed',
    async () => {
      const r = await backupCmd('drill');
      const rep = JSON.parse(r.stdout || '{}');
      assert(r.code === 0 && rep.outcome === 'passed', `${r.stdout}${r.stderr}`);
      const names = rep.checks.map((c) => c.name).join(',');
      assert(
        names === 'dump_integrity,schema_version,migrations,row_counts,known_entities,audit_chain',
        names,
      );
      assert(listDir(join(BACKUPS, '.drill')).length === 0, 'drill scratch left behind');
      assert(readStatus().lastDrill.outcome === 'passed', 'status not updated');
      return `${rep.backupId}: restore ${String(rep.restoreMs)} ms, ${String(rep.restoredBytes)} B restored; ${rep.checks.find((c) => c.name === 'audit_chain').detail}`;
    },
  );

  await check(
    'off-site copy: encrypted dump + secrets + manifest, signed payload hashes verified',
    async () => {
      await new Promise((resolve) => s3.listen(0, '0.0.0.0', resolve));
      writeFileSync(
        join(CONFIG, 'offsite.env'),
        [
          'BACKUP_S3_BUCKET=remyral-e2e',
          `BACKUP_S3_ENDPOINT=http://host.docker.internal:${String(s3.address().port)}`,
          'BACKUP_S3_ALLOW_HTTP=test-only',
          'BACKUP_S3_ACCESS_KEY_ID=E2EKEY',
          'BACKUP_S3_SECRET_ACCESS_KEY=e2e-secret',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      await sleep(1100); // a new second → a new backup id
      const r = await backupCmd('run', '--reason', 'e2e-offsite');
      const run2 = JSON.parse(r.stdout || '{}');
      assert(
        r.code === 0 && run2.outcome === 'ok' && run2.offsite.status === 'uploaded',
        `${r.stdout}${r.stderr}`,
      );
      const keys = [...objects.keys()];
      assert(keys.length === 3 && keys.every((k) => k.startsWith(`/remyral-e2e/remyral/`)), keys.join(' '));
      const db = keys.find((k) => k.endsWith('.db.dump.age'));
      const local = readFileSync(join(BACKUPS, `db/${run2.runId}.dump`));
      assert(!objects.get(db).body.includes(local.subarray(0, 64)), 'off-site dump is not encrypted');
      await must('age', ['-d', '-i', join(OWNER, 'identity.txt'), '-o', join(WORK, 'offsite.dump'), '-'], {
        input: objects.get(db).body,
      });
      assert(
        sha256(readFileSync(join(WORK, 'offsite.dump'))) === sha256(local),
        'decrypted off-site dump differs',
      );
      rmSync(join(CONFIG, 'offsite.env'));
      return keys.map((k) => k.split('/').slice(3).join('/')).join(', ');
    },
  );

  await check('drill as its own compose project (network_mode none) passes', async () => {
    const r = await run('docker', [
      'compose',
      '-p',
      DRILL_PROJECT,
      '--env-file',
      STACK_ENV,
      '-f',
      DRILL_FILE,
      'run',
      '--rm',
      '--no-TTY',
      'drill',
    ]);
    const rep = JSON.parse(r.stdout || '{}');
    assert(r.code === 0 && rep.outcome === 'passed', `${r.stdout}${r.stderr}`);
    return `${rep.backupId} in ${String(rep.totalMs)} ms`;
  });

  await check('tampered dump: drill fails on integrity and reports it', async () => {
    const latest = readStatus().lastSuccessfulBackup.runId;
    const file = join(BACKUPS, `db/${latest}.dump`);
    const orig = readFileSync(file);
    const bad = Buffer.from(orig);
    bad[bad.length - 10] ^= 0xff;
    writeFileSync(file, bad);
    const r = await backupCmd('drill');
    writeFileSync(file, orig);
    const rep = JSON.parse(r.stdout || '{}');
    assert(r.code === 1 && rep.outcome === 'failed' && /manifest/.test(rep.error), `${r.stdout}${r.stderr}`);
    return rep.error;
  });

  await check('a private key next to the backups stops the run; nothing half-written remains', async () => {
    const before = listDir(join(BACKUPS, 'db')).length;
    writeFileSync(
      join(CONFIG, 'stray-identity.txt'),
      'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n',
      { mode: 0o600 },
    );
    await sleep(1100);
    const r = await backupCmd('run');
    rmSync(join(CONFIG, 'stray-identity.txt'));
    const out = JSON.parse(r.stdout || '{}');
    assert(
      r.code === 1 && out.outcome === 'failed' && /private key/.test(out.error),
      `${r.stdout}${r.stderr}`,
    );
    assert(listDir(join(BACKUPS, 'db')).length === before, 'partial files left');
    return out.error;
  });

  await check('daemon: starts with the release, heartbeats, stops cleanly', async () => {
    const up = await compose('up', '-d', '--no-deps', 'backup');
    assert(up.code === 0, up.stderr);
    for (let i = 0; i < 30 && !existsSync(join(BACKUPS, 'status/heartbeat.json')); i += 1) await sleep(1000);
    const hb = JSON.parse(readFileSync(join(BACKUPS, 'status/heartbeat.json'), 'utf8'));
    assert(hb.env === ENV && hb.nextBackupAt && hb.schedule.mode === 'daily', JSON.stringify(hb));
    const ps = await must('docker', [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      STACK_ENV,
      '-f',
      COMPOSE_FILE,
      'ps',
      '--format',
      '{{.Service}} {{.Publishers}}',
    ]);
    assert(!/backup .*\d+->/.test(ps.stdout), `backup publishes a port: ${ps.stdout}`);
    await must('docker', [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      STACK_ENV,
      '-f',
      COMPOSE_FILE,
      'stop',
      'backup',
    ]);
    return `next backup ${hb.nextBackupAt}, drill ${String(hb.nextDrillAt)}`;
  });
}

async function cleanup() {
  s3.close();
  await run('docker', [
    'compose',
    '-p',
    PROJECT,
    '--env-file',
    STACK_ENV,
    '-f',
    COMPOSE_FILE,
    '--profile',
    'backup',
    'down',
    '-v',
    '--remove-orphans',
  ]);
  await run('docker', [
    'compose',
    '-p',
    DRILL_PROJECT,
    '--env-file',
    STACK_ENV,
    '-f',
    DRILL_FILE,
    'down',
    '-v',
    '--remove-orphans',
  ]);
  await run('docker', ['image', 'rm', IMAGE]);
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
