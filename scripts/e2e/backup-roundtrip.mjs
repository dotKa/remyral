#!/usr/bin/env node
/* global setTimeout, clearTimeout */
// Backup → restore round trip (p1-backups, docs/ops/backups.md §8):
//
//   pnpm e2e:backup [--keep]
//
// Uses the PRODUCTION Postgres service definition (infra/coolify/compose.yaml, including its initdb hook
// that creates remyral_owner / remyral_app / remyral_backup) in a throw-away compose project, applies the
// real master migrations as remyral_owner, writes data as remyral_app, then runs infra/backup/backup.sh
// exactly as the systemd unit does — but against a `file://` target instead of S3 (same create-only
// interface in infra/backup/lib.sh; no MinIO, to keep Docker/disk usage small). The owner's age identity
// exists only in the "owner" directory; the "server" directory holds public recipients only.
// Then: restore into a FRESH Postgres container, restore the recovery secrets, and run the DR path
// (bring up a new compose project from the restored stack.env, restore into it, log in with the restored
// passwords). Negative checks: tampered ciphertext, wrong identity, private key on the server, overwrite.
// Needs Docker and `age`/`age-keygen` (brew install age). Does not touch the dev stack or its DB.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });

const RUN_ID = randomBytes(3).toString('hex');
const ENV = `e2e-${RUN_ID}`;
const PROJECT = `remyral-${ENV}`;
const DR_PROJECT = `remyral-e2e-dr-${RUN_ID}`;
const FRESH_NAME = `remyral-e2e-restore-${RUN_ID}`;
const COMPOSE_FILE = join(ROOT, 'infra/coolify/compose.yaml');
const BACKUP_SH = join(ROOT, 'infra/backup/backup.sh');
const RESTORE_SH = join(ROOT, 'infra/backup/restore.sh');
const LIB_SH = join(ROOT, 'infra/backup/lib.sh');
const ROLE_SQL = join(ROOT, 'infra/backup/sql/backup-role.sql');
const PG_IMAGE =
  'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

// ---------------------------------------------------------------- reporting

const results = [];
const t0 = Date.now();
const log = (msg) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}\n`);
class StepFailed extends Error {}
async function check(name, fn) {
  const start = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail: String(detail), ms: Date.now() - start });
    log(`PASS ${name}${detail ? ` — ${String(detail)}` : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail, ms: Date.now() - start });
    log(`FAIL ${name} — ${detail}`);
    throw new StepFailed(name);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------- processes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command to completion; never uses a shell. */
function run(cmd, args, { input, env, timeoutMs = 300_000 } = {}) {
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
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')} … exited ${String(r.code)}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`,
    );
  }
  return r;
}

// ---------------------------------------------------------------- layout: owner vs server

const WORK = mkdtempSync(join(tmpdir(), 'remyral-e2e-backup-'));
const OWNER = join(WORK, 'owner'); // the owner's Mac: identities live only here
const SERVER = join(WORK, 'server'); // the control-plane host: public recipients only
const BUCKET = join(WORK, 'bucket'); // stand-in for s3://<bucket>
const DATA = join(SERVER, 'data/remyral', ENV);
const STATE = join(SERVER, 'var/lib/remyral-backup', ENV);
const CONFIG = join(SERVER, 'etc/remyral/backup', `${ENV}.env`);
const RECIPIENTS = join(SERVER, 'etc/remyral/backup/recipients.txt');
for (const d of [OWNER, join(DATA, 'secrets'), dirname(CONFIG), BUCKET]) mkdirSync(d, { recursive: true });

const hex = () => randomBytes(24).toString('hex');
const passwords = {
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
    REMYRAL_DOMAIN: 'backup-e2e.invalid',
    REMYRAL_SECRETS_DIR: join(DATA, 'secrets'),
    REMYRAL_BACKUP_DIR: join(DATA, 'backups'),
    ...passwords,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
  { mode: 0o600 },
);
writeFileSync(join(DATA, 'secrets/totp.key'), `${randomBytes(32).toString('base64')}\n`, { mode: 0o400 });
writeFileSync(join(DATA, 'secrets/lease-signing.pem'), `fake-pem-${hex()}\n`, { mode: 0o400 });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const backupEnv = {}; // backup.sh reads everything from CONFIG

// ---------------------------------------------------------------- docker helpers

const compose = (project, envFile, ...args) =>
  must('docker', ['compose', '-p', project, '--env-file', envFile, '-f', COMPOSE_FILE, ...args]);
async function pgContainer(project) {
  const r = await compose(project, STACK_ENV, 'ps', '-q', 'postgres');
  const id = r.stdout.trim();
  assert(/^[0-9a-f]{12,64}$/.test(id), `no postgres container in ${project}`);
  return id;
}
/** psql over TCP inside the container as a given role (password via env, never argv). */
async function psqlAs(container, user, password, sql, { db = 'remyral', allowFail = false } = {}) {
  const r = await run(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      user,
      '-d',
      db,
      '-X',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: `${sql}\n`, env: { PGPASSWORD: password } },
  );
  if (!allowFail && r.code !== 0) throw new Error(`psql as ${user}: ${r.stderr.trim()}`);
  return allowFail ? r : r.stdout.trim();
}
const psqlSu = async (container, sql) =>
  (
    await must(
      'docker',
      [
        'exec',
        '-i',
        '-u',
        'postgres',
        container,
        'psql',
        '-U',
        'postgres',
        '-d',
        'remyral',
        '-X',
        '-tA',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { input: sql },
    )
  ).stdout.trim();

/** One md5 per public table over its full content: equality ⇔ identical data. */
const FINGERPRINT_SQL = `
SELECT string_agg(t || '=' || n || ':' || h, ' ' ORDER BY t) FROM (
  SELECT c.relname AS t,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text AS n,
         (xpath('/row/h/text()', query_to_xml(format('SELECT coalesce(md5(string_agg(x::text, ''|'' ORDER BY x::text)), ''-'') AS h FROM public.%I x', c.relname), false, true, '')))[1]::text AS h
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'public' AND c.relkind = 'r') f;`;

const backup = (extraEnv = {}, args = []) =>
  run('bash', [BACKUP_SH, '--config', CONFIG, ...args], { env: { ...backupEnv, ...extraEnv } });
const restore = (args) => run('bash', [RESTORE_SH, ...args]);

let source;
let freshCreated = false;
let drStarted = false;
const snapshots = [];

async function main() {
  log(`run ${RUN_ID}, work dir ${WORK}`);

  await check('tools: docker, age, age-keygen present', async () => {
    for (const [cmd, args] of [
      ['docker', ['version', '--format', '{{.Server.Version}}']],
      ['age', ['--version']],
      ['age-keygen', ['--help']],
    ]) {
      const r = await run(cmd, args).catch(() => ({ code: 127 }));
      assert(cmd === 'age-keygen' ? r.code !== 127 : r.code === 0, `${cmd} not available`);
    }
  });

  await check(
    'owner keys: primary + break-glass identity off-host, server gets public keys only',
    async () => {
      const pubs = [];
      for (const name of ['identity.txt', 'break-glass.txt']) {
        await must('age-keygen', ['-o', join(OWNER, name)]);
        pubs.push((await must('age-keygen', ['-y', join(OWNER, name)])).stdout.trim());
      }
      writeFileSync(RECIPIENTS, `# owner primary, break-glass\n${pubs.join('\n')}\n`, { mode: 0o644 });
      writeFileSync(
        CONFIG,
        [
          `BACKUP_ENV=${ENV}`,
          `BACKUP_TARGET=file://${BUCKET}/remyral`,
          `BACKUP_RECIPIENTS_FILE=${RECIPIENTS}`,
          `BACKUP_STACK_ENV=${STACK_ENV}`,
          `BACKUP_SECRETS_BASE=${DATA}`,
          `BACKUP_STATE_DIR=${STATE}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      return pubs.map((p) => `${p.slice(0, 12)}…`).join(', ');
    },
  );

  await check('source: production postgres service + initdb hook (owner/app/backup roles)', async () => {
    await compose(PROJECT, STACK_ENV, 'up', '-d', '--wait', 'postgres');
    source = await pgContainer(PROJECT);
    const roles = await psqlSu(
      source,
      "SELECT string_agg(rolname || ':' || rolcanlogin || ':' || rolsuper, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'remyral_%';",
    );
    assert(
      roles === 'remyral_app:true:false,remyral_backup:true:false,remyral_owner:true:false',
      `roles: ${roles}`,
    );
    return roles;
  });

  await check(
    'one-off SQL (existing DBs): backup-role.sql is idempotent and keeps the role read-only',
    async () => {
      const r = await must(
        'docker',
        [
          'exec',
          '-i',
          '--env-file',
          STACK_ENV,
          '-u',
          'postgres',
          source,
          'psql',
          '-U',
          'postgres',
          '-d',
          'remyral',
          '-X',
          '-tA',
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          '-',
        ],
        { input: readFileSync(ROLE_SQL) },
      );
      const last = r.stdout.trim().split('\n').at(-1);
      assert(last === 'remyral_backup|t|f|f|t', `role state: ${last}`);
      return last;
    },
  );

  await check('schema: real master migrations applied as remyral_owner', async () => {
    const dir = join(ROOT, 'apps/master/migrations');
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    await psqlAs(
      source,
      'remyral_owner',
      passwords.REMYRAL_DB_OWNER_PASSWORD,
      'CREATE TABLE schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());',
    );
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const [, version, name] = /^(\d{4})_(.+)\.sql$/.exec(f);
      await psqlAs(
        source,
        'remyral_owner',
        passwords.REMYRAL_DB_OWNER_PASSWORD,
        `BEGIN;\n${sql}\n;INSERT INTO schema_migrations (version, name, checksum) VALUES ('${version}', '${name}', '${sha256(sql)}');\nCOMMIT;`,
      );
    }
    return `${String(files.length)} migrations, head ${files.at(-1)}`;
  });

  const seed = (from, to) =>
    psqlAs(
      source,
      'remyral_app',
      passwords.REMYRAL_DB_APP_PASSWORD,
      `INSERT INTO audit_events (id, occurred_at, actor_type, action, target, outcome, metadata, prev_hash, hash)
       SELECT g, now(), 'system', 'e2e.backup', 'row-' || g, 'success', jsonb_build_object('run', '${RUN_ID}'),
              sha256(('prev-' || g)::bytea), sha256(('hash-${RUN_ID}-' || g)::bytea)
         FROM generate_series(${String(from)}, ${String(to)}) g;`,
    );

  await check('data: remyral_app writes audit rows (append-only triggers active)', async () => {
    await seed(1, 400);
    const r = await psqlAs(
      source,
      'remyral_app',
      passwords.REMYRAL_DB_APP_PASSWORD,
      'DELETE FROM audit_events WHERE id = 1;',
      {
        allowFail: true,
      },
    );
    assert(r.code !== 0 && /append-only/.test(r.stderr), 'delete on audit_events was not rejected');
    return '400 rows';
  });

  await check('backup role: can read everything, cannot write, create or log in elsewhere', async () => {
    const pw = passwords.REMYRAL_DB_BACKUP_PASSWORD;
    const n = await psqlAs(source, 'remyral_backup', pw, 'SELECT count(*) FROM audit_events;');
    assert(n === '400', `count ${n}`);
    for (const sql of [
      "INSERT INTO schema_migrations (version, name, checksum) VALUES ('9999', 'x', 'x');",
      'CREATE TABLE evil (x int);',
      'CREATE TEMP TABLE evil (x int);',
      'SET default_transaction_read_only = off; UPDATE schema_migrations SET name = name;',
    ]) {
      const r = await psqlAs(source, 'remyral_backup', pw, sql, { allowFail: true });
      assert(r.code !== 0, `backup role could run: ${sql}`);
    }
    return 'read ok; insert/create/temp/update denied';
  });

  await check('backup.sh --dry-run prints the plan and uploads nothing', async () => {
    const r = await backup({}, ['--dry-run']);
    assert(r.code === 0, r.stderr);
    assert(/would upload .*daily\/e2e-[0-9a-f]+\/postgres\//.test(r.stderr), r.stderr);
    assert(!existsSync(join(BUCKET, 'remyral')), 'dry run wrote to the target');
    return r.stderr.trim().split('\n').at(-1).replace(/^.*: /, '');
  });

  await check('guard: backup.sh refuses a private key in the recipients file', async () => {
    const bad = join(SERVER, 'etc/remyral/backup/bad-recipients.txt');
    writeFileSync(bad, readFileSync(join(OWNER, 'identity.txt')), { mode: 0o600 });
    const r = await backup({ BACKUP_RECIPIENTS_FILE: bad });
    rmSync(bad);
    assert(r.code !== 0 && /PRIVATE key/.test(r.stderr), `exit ${String(r.code)}: ${r.stderr.trim()}`);
    return 'refused';
  });

  await check('backup #1 (daily tier): encrypted dump + manifest + encrypted secrets', async () => {
    const r = await backup();
    assert(r.code === 0, r.stderr.trim());
    snapshots.push({ fp: await psqlSu(source, FINGERPRINT_SQL), rows: 400 });
    const keys = listBucket();
    const dump = keys.filter((k) => /\/daily\/.*\/postgres\/.*\.dump\.age$/.test(k));
    const sec = keys.filter((k) => /\/daily\/.*\/secrets\/.*\.tar\.age$/.test(k));
    assert(dump.length === 1 && sec.length === 1, `objects: ${keys.join(', ')}`);
    for (const k of [...dump, ...sec]) {
      const head = readFileSync(join(BUCKET, k)).subarray(0, 21).toString();
      assert(head === 'age-encryption.org/v1', `${k} is not an age file`);
      const manifest = JSON.parse(
        readFileSync(join(BUCKET, k.replace(/\.(dump|tar)\.age$/, '.manifest.json')), 'utf8'),
      );
      assert(manifest.ciphertextSha256 === sha256(readFileSync(join(BUCKET, k))), 'manifest hash mismatch');
      assert(manifest.recipients.length === 2, 'manifest recipients');
    }
    const m = JSON.parse(readFileSync(join(BUCKET, dump[0].replace('.dump.age', '.manifest.json')), 'utf8'));
    assert(m.auditHead.startsWith('400:') && m.lastMigration.length === 4, JSON.stringify(m));
    // The tar of secrets contains the passwords: make sure none of them appears in any stored byte.
    for (const k of keys) {
      const bytes = readFileSync(join(BUCKET, k));
      for (const pw of Object.values(passwords))
        assert(!bytes.includes(pw), `${k} contains a plaintext secret`);
    }
    return `${dump[0].split('/').at(-1)} (${String(m.ciphertextBytes)} B), migration ${m.lastMigration}`;
  });

  await check('backup #2 (frequent tier): new data, secrets unchanged → not re-uploaded', async () => {
    await seed(401, 650);
    await sleep(1100); // object names have second resolution
    const r = await backup();
    assert(r.code === 0, r.stderr.trim());
    assert(/secrets=no/.test(r.stderr), 'secrets were uploaded again although unchanged');
    snapshots.push({ fp: await psqlSu(source, FINGERPRINT_SQL), rows: 650 });
    const frequent = listBucket().filter((k) => /\/frequent\/.*\/postgres\/.*\.dump\.age$/.test(k));
    assert(frequent.length === 1, `frequent dumps: ${String(frequent.length)}`);
    return frequent[0].split('/').at(-1);
  });

  await check('create-only target: an existing object is never overwritten', async () => {
    const key = listBucket().find((k) => k.endsWith('.dump.age'));
    const before = sha256(readFileSync(join(BUCKET, key)));
    const tmp = join(WORK, 'junk');
    writeFileSync(tmp, 'junk');
    const r = await run('bash', [
      '-c',
      `. "${LIB_SH}"; parse_target "file://${BUCKET}"; target_put "${tmp}" "${key}" application/octet-stream`,
    ]);
    assert(r.code !== 0 && /refusing to overwrite/.test(r.stderr), `overwrite allowed: ${r.stderr}`);
    assert(sha256(readFileSync(join(BUCKET, key))) === before, 'object changed');
    return 'refused';
  });

  await check('server holds no decryption key', async () => {
    const hits = grepTree(SERVER, 'AGE-SECRET-KEY-');
    assert(hits.length === 0, `private key material on the server: ${hits.join(', ')}`);
    return 'no AGE-SECRET-KEY under the server tree';
  });

  await check('restore latest into a FRESH Postgres container: identical data, roles, triggers', async () => {
    const r = await restore([
      'postgres',
      '--target',
      `file://${BUCKET}/remyral`,
      '--env',
      ENV,
      '--from',
      'latest',
      '--identity',
      join(OWNER, 'identity.txt'),
      '--fresh',
      '--name',
      FRESH_NAME,
      '--image',
      PG_IMAGE,
    ]);
    freshCreated = true;
    assert(r.code === 0, r.stderr.trim().split('\n').slice(-3).join(' | '));
    const fp = await psqlSu(FRESH_NAME, FINGERPRINT_SQL);
    assert(fp === snapshots[1].fp, 'restored data differs from the source at backup #2');
    const owners = await psqlSu(
      FRESH_NAME,
      "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname = 'public';",
    );
    assert(owners === 'remyral_owner', `owners ${owners}`);
    const grant = await psqlSu(
      FRESH_NAME,
      "SELECT has_table_privilege('remyral_app', 'audit_events', 'INSERT');",
    );
    assert(grant === 't', 'remyral_app lost its grants');
    const upd = await run('docker', [
      'exec',
      '-i',
      '-u',
      'postgres',
      FRESH_NAME,
      'psql',
      '-U',
      'postgres',
      '-d',
      'remyral',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'UPDATE audit_events SET action = action WHERE id = 1',
    ]);
    assert(upd.code !== 0 && /append-only/.test(upd.stderr), 'append-only trigger missing after restore');
    return `${fp.split(' ').length} tables identical; audit rows 650; trigger active`;
  });

  await check('break-glass identity restores the older daily dump (explicit object)', async () => {
    await must('docker', ['rm', '-f', '-v', FRESH_NAME]);
    const key = listBucket().find((k) => /\/daily\/.*\.dump\.age$/.test(k));
    const r = await restore([
      'postgres',
      '--target',
      `file://${BUCKET}/remyral`,
      '--from',
      key.replace(/^remyral\//, ''), // key relative to the target, as in docs/ops/backups.md §7
      '--identity',
      join(OWNER, 'break-glass.txt'),
      '--fresh',
      '--name',
      FRESH_NAME,
      '--image',
      PG_IMAGE,
    ]);
    assert(r.code === 0, r.stderr.trim().split('\n').slice(-3).join(' | '));
    const fp = await psqlSu(FRESH_NAME, FINGERPRINT_SQL);
    assert(fp === snapshots[0].fp, 'restored data differs from the source at backup #1');
    await must('docker', ['rm', '-f', '-v', FRESH_NAME]);
    freshCreated = false;
    return 'point-in-time of backup #1 (400 rows)';
  });

  await check('tamper: modified ciphertext and wrong identity are rejected', async () => {
    const key = listBucket().find((k) => /\/frequent\/.*\.dump\.age$/.test(k));
    const evil = join(WORK, 'evil/remyral');
    const ek = join(evil, key.replace(/^remyral\//, ''));
    mkdirSync(dirname(ek), { recursive: true });
    const ct = readFileSync(join(BUCKET, key));
    ct[ct.length - 100] ^= 0x01;
    writeFileSync(ek, ct);
    const mk = ek.replace('.dump.age', '.manifest.json');
    const manifest = readFileSync(join(BUCKET, key.replace('.dump.age', '.manifest.json')), 'utf8');
    writeFileSync(mk, manifest);
    const out = join(WORK, 'unused');
    let r = await restore([
      'postgres',
      '--from',
      `file://${ek}`,
      '--identity',
      join(OWNER, 'identity.txt'),
      '--container',
      'none',
    ]);
    assert(r.code !== 0 && /ciphertext hash does not match/.test(r.stderr), `hash check: ${r.stderr.trim()}`);
    // Attacker also fixes the manifest hash: age's authentication must still catch it.
    writeFileSync(
      mk,
      manifest.replace(/"ciphertextSha256": "[0-9a-f]+"/, `"ciphertextSha256": "${sha256(ct)}"`),
    );
    r = await restore([
      'postgres',
      '--from',
      `file://${ek}`,
      '--identity',
      join(OWNER, 'identity.txt'),
      '--container',
      'none',
    ]);
    assert(r.code !== 0 && /decryption failed/.test(r.stderr), `age auth: ${r.stderr.trim()}`);
    const stranger = join(WORK, 'stranger.txt');
    await must('age-keygen', ['-o', stranger]);
    r = await restore([
      'secrets',
      '--target',
      `file://${BUCKET}/remyral`,
      '--env',
      ENV,
      '--from',
      'latest',
      '--identity',
      stranger,
      '--out',
      out,
    ]);
    assert(r.code !== 0 && /decryption failed/.test(r.stderr), `wrong identity: ${r.stderr.trim()}`);
    return 'hash mismatch, MAC failure and foreign identity all refused';
  });

  const DR = join(WORK, 'dr');
  await check('secrets restore: stack.env and key files byte-identical, modes kept', async () => {
    const r = await restore([
      'secrets',
      '--target',
      `file://${BUCKET}/remyral`,
      '--env',
      ENV,
      '--from',
      'latest',
      '--identity',
      join(OWNER, 'identity.txt'),
      '--out',
      DR,
    ]);
    assert(r.code === 0, r.stderr.trim());
    for (const f of ['stack.env', 'secrets/totp.key', 'secrets/lease-signing.pem']) {
      assert(sha256(readFileSync(join(DR, f))) === sha256(readFileSync(join(DATA, f))), `${f} differs`);
      assert(
        (statSync(join(DR, f)).mode & 0o777) === (statSync(join(DATA, f)).mode & 0o777),
        `${f} mode differs`,
      );
    }
    return '3 files identical';
  });

  await check(
    'DR path: new compose project from restored stack.env, restore into it, log in as remyral_app',
    async () => {
      const drEnv = join(DR, 'stack.env');
      await must('docker', [
        'compose',
        '-p',
        DR_PROJECT,
        '--env-file',
        drEnv,
        '-f',
        COMPOSE_FILE,
        'up',
        '-d',
        '--wait',
        'postgres',
      ]);
      drStarted = true;
      const ctr = (
        await must('docker', [
          'compose',
          '-p',
          DR_PROJECT,
          '--env-file',
          drEnv,
          '-f',
          COMPOSE_FILE,
          'ps',
          '-q',
          'postgres',
        ])
      ).stdout.trim();
      const r = await restore([
        'postgres',
        '--target',
        `file://${BUCKET}/remyral`,
        '--env',
        ENV,
        '--from',
        'latest',
        '--identity',
        join(OWNER, 'identity.txt'),
        '--container',
        ctr,
      ]);
      assert(r.code === 0, r.stderr.trim().split('\n').slice(-3).join(' | '));
      const pwApp = /^REMYRAL_DB_APP_PASSWORD=(.+)$/m.exec(readFileSync(drEnv, 'utf8'))[1];
      const n = await psqlAs(ctr, 'remyral_app', pwApp, 'SELECT count(*) FROM audit_events;');
      assert(n === '650', `remyral_app sees ${n} rows`);
      const fp = await psqlSu(ctr, FINGERPRINT_SQL);
      assert(fp === snapshots[1].fp, 'DR data differs');
      const again = await restore([
        'postgres',
        '--target',
        `file://${BUCKET}/remyral`,
        '--env',
        ENV,
        '--from',
        'latest',
        '--identity',
        join(OWNER, 'identity.txt'),
        '--container',
        ctr,
      ]);
      assert(
        again.code !== 0 && /only into an empty database/.test(again.stderr),
        'restore into a non-empty DB was not refused',
      );
      return 'restored passwords work; data identical; second restore refused';
    },
  );
}

function listBucket() {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
      else out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(BUCKET, '');
  return out.sort();
}
function grepTree(dir, needle) {
  const hits = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    try {
      chmodSync(p, statSync(p).mode | 0o400);
      if (readFileSync(p).includes(needle)) hits.push(p);
    } catch {
      hits.push(`${p} (unreadable)`);
    }
  }
  return hits;
}

async function cleanup() {
  if (opts.keep) {
    log(`--keep: left ${PROJECT}, ${DR_PROJECT}, ${FRESH_NAME} and ${WORK}`);
    return;
  }
  if (freshCreated) await run('docker', ['rm', '-f', '-v', FRESH_NAME]);
  await run('docker', [
    'compose',
    '-p',
    PROJECT,
    '--env-file',
    STACK_ENV,
    '-f',
    COMPOSE_FILE,
    'down',
    '-v',
    '--remove-orphans',
  ]);
  if (drStarted) {
    await run('docker', [
      'compose',
      '-p',
      DR_PROJECT,
      '--env-file',
      STACK_ENV,
      '-f',
      COMPOSE_FILE,
      'down',
      '-v',
      '--remove-orphans',
    ]);
  }
  // Tar-restored files are 0400; make them removable.
  for (const e of readdirSync(WORK, { withFileTypes: true, recursive: true })) {
    try {
      chmodSync(join(e.parentPath, e.name), e.isDirectory() ? 0o700 : 0o600);
    } catch {
      /* ignore */
    }
  }
  rmSync(WORK, { recursive: true, force: true });
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  if (!(err instanceof StepFailed)) log(`ERROR ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await cleanup();
  const bad = results.filter((r) => !r.ok).length;
  process.stdout.write(
    `\n${failed || bad ? 'FAIL' : 'PASS'}: ${String(results.length - bad)}/${String(results.length)} checks passed\n`,
  );
  process.exitCode = failed || bad ? 1 : 0;
}
