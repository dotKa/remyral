#!/usr/bin/env node
/* global fetch, setTimeout */
// Standby restore of the control plane (p11-master-resilience, docs/ops/backup-restore.md §10–§11).
//
//   node scripts/ops/standby-restore.mjs fetch   --env prod --offsite FILE --identity FILE --out DIR [--base ID]
//   node scripts/ops/standby-restore.mjs restore --env prod --staging DIR [--target-time ISO] [--data-root /data/remyral] [--force]
//   node scripts/ops/standby-restore.mjs verify  --env prod --staging DIR [--data-root /data/remyral] [--pg-container C] [--url https://host/healthz]
//   node scripts/ops/standby-restore.mjs cutover --name HOST --ip ADDRESS [--zone-id ZONE] [--dry-run]
//
// fetch    (owner's machine, or the new host with the identity on tmpfs): newest complete base backup, every WAL
//          segment since its start and the newest secrets archive from the off-site bucket (S3/R2, read principal in
//          FILE = BACKUP_S3_* lines like offsite.env); ciphertext hashes verified, `age -d -i` decrypts, plaintext
//          hashes verified. The identity is only ever passed to age as a path.
// restore  (fresh host, root, Docker): secrets into <data-root>/<env>, the base into a NEW compose volume
//          <project>_pgdata (project/database from the restored stack.env: a pre-rename installation keeps
//          remana-<env> / remana — restore it with --data-root /data/remana; --project/--db override), WAL replay (to --target-time, else to the end of the archive), promotion, recovery
//          settings removed again, verify, container removed. Then `deploy.mjs` brings master/web/backup up.
// verify   secrets present, lease-signing key = the base's key id (workers' pinned lease keys and their identities in
//          the restored DB keep working), schema vs this checkout's migrations, audit chain, optional health URL.
// cutover  Cloudflare DNS (API v4): the console host's A/AAAA record → the new address. Token in CLOUDFLARE_API_TOKEN
//          (Zone → DNS → Edit, this zone only), zone in --zone-id or CLOUDFLARE_ZONE_ID. Workers reconnect on their own.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyAuditChain } from '../../infra/backup/runner/lib/audit-chain.mjs';
import { leaseKeyKidFromPem, validateBaseManifest } from '../../infra/backup/runner/lib/basebackup.mjs';
import { assertEnv } from '../../infra/backup/runner/lib/naming.mjs';
import { compareMigrations, loadMigrationFiles, sha256File } from '../../infra/backup/runner/lib/pg.mjs';
import { spawnTool } from '../../infra/backup/runner/lib/proc.mjs';
import { parseEnvFile, parseOffsiteConfig, S3Target } from '../../infra/backup/runner/lib/s3.mjs';
import { localRestoreCommand, recoveryConf } from '../../infra/backup/runner/lib/standby-drill.mjs';
import {
  cloudflareCutover,
  newestBase,
  newestSecrets,
  installationNames,
  pgdataFor,
  prepareDataDirScript,
  RECOVERY_SETTINGS,
  targetTimeSetting,
  walObjectsForBase,
} from './lib/standby.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The Postgres image of infra/coolify/compose.yaml (same digest; a restored cluster must run on the same build). */
export const PG_IMAGE =
  'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

const log = (m) => process.stderr.write(`${new Date().toISOString()} standby-restore: ${m}\n`);
const run = (cmd, args, opts = {}) => spawnTool(cmd, args, opts).done;

function opt(values, name) {
  const v = values[name];
  if (v === undefined || v === '') throw new Error(`--${name} is required`);
  return v;
}

// ---------------------------------------------------------------- fetch

async function fetchCmd(v) {
  const env = assertEnv(opt(v, 'env'));
  const out = resolve(opt(v, 'out'));
  const identity = resolve(opt(v, 'identity'));
  if (!existsSync(identity)) throw new Error(`identity ${identity} not found`);
  const off = parseOffsiteConfig(parseEnvFile(readFileSync(resolve(opt(v, 'offsite')), 'utf8')));
  const s3 = new S3Target(off);
  mkdirSync(join(out, 'wal'), { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);

  const baseKeys = await s3.list(`${off.prefix}/base/${env}/`);
  const base = newestBase(baseKeys, env, v.base ?? null);
  if (!base) throw new Error(`no complete base backup under ${off.prefix}/base/${env}/`);
  log(`base ${base.id}`);
  await s3.getToFile(base.manifestKey, join(out, 'base.json'));
  const manifest = validateBaseManifest(JSON.parse(readFileSync(join(out, 'base.json'), 'utf8')));
  if (!manifest.offsite) throw new Error('the base manifest has no off-site record');

  const decrypt = async (enc, plain) => {
    await run('age', ['-d', '-i', identity, '-o', plain, enc]);
    rmSync(enc, { force: true });
    chmodSync(plain, 0o600);
  };
  const encBase = join(out, 'base.tar.gz.age');
  const got = await s3.getToFile(base.tarKey, encBase);
  if (got.sha256 !== manifest.offsite.sha256 || got.bytes !== manifest.offsite.bytes)
    throw new Error('the downloaded base differs from its manifest (ciphertext hash)');
  await decrypt(encBase, join(out, 'base.tar.gz'));
  const plain = await sha256File(join(out, 'base.tar.gz'));
  if (plain.sha256 !== manifest.files.base.sha256)
    throw new Error('the decrypted base differs from its manifest');

  const walKeys = await s3.list(`${off.prefix}/wal/${env}/`);
  const chain = walObjectsForBase(walKeys, env, manifest.startWalFile);
  if (!chain.some((c) => c.name === manifest.startWalFile))
    throw new Error(`the start segment ${manifest.startWalFile} is not off-site (yet)`);
  let n = 0;
  for (const { name, key } of chain) {
    const enc = join(out, 'wal', `${name}.gz.age`);
    const g = await s3.getToFile(key, enc);
    if (g.metaSha256 !== null && g.metaSha256 !== g.sha256)
      throw new Error(`${name}: ciphertext hash differs`);
    await decrypt(enc, join(out, 'wal', `${name}.gz`));
    n += 1;
  }
  log(`${String(n)} WAL files (${chain[0]?.name ?? '-'} … ${chain.at(-1)?.name ?? '-'})`);

  const secKeys = await s3.list(`${off.prefix}/`);
  const sec = newestSecrets(secKeys, env);
  if (sec) {
    const enc = join(out, 'secrets.tar.age');
    await s3.getToFile(sec.key, enc);
    await decrypt(enc, join(out, 'secrets.tar'));
    log(`secrets ${sec.id}`);
  } else log('WARNING: no secrets archive off-site (restore needs stack.env + secrets/ from elsewhere)');
  writeFileSync(
    join(out, 'standby.json'),
    `${JSON.stringify({ env, base: base.id, startWalFile: manifest.startWalFile, wal: chain.map((c) => c.name), secrets: sec?.id ?? null, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `fetched base ${base.id}, ${String(n)} WAL files, secrets ${sec?.id ?? 'none'} into ${out}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------- database helpers (docker exec psql)

function psqlJson(container, db = 'remyral') {
  return async (sql) => {
    const r = await run(
      'docker',
      [
        'exec',
        '-i',
        '-u',
        'postgres',
        '-e',
        'PGOPTIONS=-c TimeZone=UTC -c extra_float_digits=1 -c bytea_output=hex',
        container,
        'psql',
        '-U',
        'postgres',
        '-d',
        db,
        '-X',
        '-A',
        '-t',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdin: `${sql};\n` },
    );
    const text = r.stdout.trim();
    return text === '' ? null : JSON.parse(text);
  };
}

async function verifyDatabase(container, manifest, checks, db) {
  const q = psqlJson(container, db);
  const recovering = await q('SELECT to_json(pg_is_in_recovery())');
  checks.push({
    name: 'promoted',
    ok: recovering === false,
    detail: recovering ? 'still in recovery' : 'read-write primary',
  });
  const applied =
    (await q(
      "SELECT coalesce(json_agg(json_build_object('version', version, 'checksum', checksum) ORDER BY version), '[]'::json) FROM schema_migrations",
    )) ?? [];
  const cmp = compareMigrations(applied, loadMigrationFiles(join(ROOT, 'apps/master/migrations')));
  checks.push({
    name: 'schema',
    ok: cmp.ok && applied.length >= manifest.schema.count,
    detail: `${String(applied.length)} applied (base ${String(manifest.schema.count)}); unknown ${cmp.unknown.join(',') || '-'}; edited ${cmp.mismatched.join(',') || '-'}; pending ${cmp.pending.length ? cmp.pending.join(',') : '-'} (migrate runs them)`,
  });
  const counts = await q(
    "SELECT json_build_object('users', (SELECT count(*) FROM users), 'workers', (SELECT count(*) FROM workers), 'jobs', (SELECT count(*) FROM jobs))",
  );
  checks.push({
    name: 'rows',
    ok: counts.users > 0,
    detail: `users ${String(counts.users)}, workers ${String(counts.workers)}, jobs ${String(counts.jobs)}`,
  });
  const chain = await verifyAuditChain(q);
  checks.push({
    name: 'audit_chain',
    ok: chain.ok,
    detail: chain.ok
      ? `${String(chain.checked)} events, head ${chain.headId ?? '∅'}`
      : `broken at ${chain.brokenAtId}`,
  });
}

function verifySecrets(dir, manifest, checks) {
  for (const f of ['stack.env', 'secrets/totp.key', 'secrets/lease-signing.pem']) {
    checks.push({ name: `file:${f}`, ok: existsSync(join(dir, f)), detail: join(dir, f) });
  }
  const pem = join(dir, 'secrets/lease-signing.pem');
  if (existsSync(pem)) {
    const kid = leaseKeyKidFromPem(readFileSync(pem, 'utf8'));
    checks.push({
      name: 'lease_key',
      ok: kid !== null && (manifest.leaseKeyKid === null || kid === manifest.leaseKeyKid),
      detail: `kid ${kid ?? 'unreadable'}${manifest.leaseKeyKid ? ` (base ${manifest.leaseKeyKid})` : ''}`,
    });
  }
}

function printChecks(checks) {
  for (const c of checks)
    process.stdout.write(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(28)} ${c.detail}\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

// ---------------------------------------------------------------- restore

async function restoreCmd(v) {
  const env = assertEnv(opt(v, 'env'));
  const staging = resolve(opt(v, 'staging'));
  const dataRoot = resolve(v['data-root'] ?? '/data/remyral');
  const manifest = validateBaseManifest(JSON.parse(readFileSync(join(staging, 'base.json'), 'utf8')));
  if (manifest.env !== env) throw new Error(`the staged base is for ${manifest.env}, not ${env}`);
  const target = v['target-time'] ? targetTimeSetting(v['target-time']) : null;
  // 1. recovery secrets (stack.env, secrets/, backup-config/)
  const envDir = join(dataRoot, env);
  if (existsSync(join(envDir, 'stack.env')) && !v.force) {
    log(`${envDir}/stack.env exists: secrets left as they are (--force replaces them)`);
  } else if (existsSync(join(staging, 'secrets.tar'))) {
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    // As root (the real host): owners and modes as backed up (uid 10001, 0400). Not root (tests): modes only.
    const owner = process.getuid?.() === 0 ? ['--same-owner', '--numeric-owner'] : [];
    await run('tar', ['-x', '-p', ...owner, '-f', join(staging, 'secrets.tar'), '-C', envDir]);
    log(`secrets restored into ${envDir}`);
  } else throw new Error(`no ${staging}/secrets.tar and no ${envDir}/stack.env`);
  // p17: the compose project and database of the restored installation (its stack.env pins them; --project/--db win).
  const names = installationNames(readFileSync(join(envDir, 'stack.env'), 'utf8'), env);
  const project = v.project ?? names.project;
  const db = v.db ?? names.db;
  const volume = `${project}_pgdata`;
  const container = `${project}-standby-restore`;
  log(`installation: compose project ${project}, database ${db}`);

  // 2. a new pgdata volume, labelled like compose's own (compose then adopts it)
  const exists = await run('docker', ['volume', 'inspect', volume], { allowFail: true });
  if (exists.code === 0) {
    if (!v.force)
      throw new Error(
        `volume ${volume} already exists (an existing cluster is never overwritten; --force removes it)`,
      );
    await run('docker', ['rm', '-f', container], { allowFail: true });
    await run('docker', ['volume', 'rm', volume]);
  }
  await run('docker', [
    'volume',
    'create',
    '--label',
    `com.docker.compose.project=${project}`,
    '--label',
    'com.docker.compose.volume=pgdata',
    volume,
  ]);

  // 3. data directory: base + backup_label + recovery settings
  writeFileSync(join(staging, 'backup_label'), manifest.labelFile, { mode: 0o644 });
  if (manifest.tablespaceMap)
    writeFileSync(join(staging, 'tablespace_map'), manifest.tablespaceMap, { mode: 0o644 });
  writeFileSync(
    join(staging, 'recovery.conf'),
    recoveryConf({ restoreCommand: localRestoreCommand('/staging/wal'), targetTime: target }),
    { mode: 0o644 },
  );
  // The container's postgres user must read the staged files (only for the duration of the restore).
  for (const f of ['base.tar.gz', ...readdirSync(join(staging, 'wal')).map((n) => `wal/${n}`)])
    chmodSync(join(staging, f), 0o644);
  chmodSync(join(staging, 'wal'), 0o755);
  chmodSync(staging, 0o755);
  const pgdata = pgdataFor(manifest.serverVersion);
  const t0 = Date.now();
  await run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${volume}:/var/lib/postgresql`,
    '-v',
    `${staging}:/staging:ro`,
    '--entrypoint',
    '/bin/sh',
    PG_IMAGE,
    '-c',
    prepareDataDirScript({ pgdata, hasTablespaceMap: manifest.tablespaceMap !== null }),
  ]);

  // 4. replay + promotion (no network, no TCP listener)
  await run('docker', ['rm', '-f', container], { allowFail: true });
  await run('docker', [
    'run',
    '-d',
    '--name',
    container,
    '--network',
    'none',
    '-v',
    `${volume}:/var/lib/postgresql`,
    '-v',
    `${staging}:/staging:ro`,
    PG_IMAGE,
    'postgres',
    '-c',
    'listen_addresses=',
  ]);
  const checks = [];
  try {
    const q = psqlJson(container, db);
    const deadline = Date.now() + Number(v['timeout-minutes'] ?? 60) * 60_000;
    for (;;) {
      const r = await q('SELECT to_json(pg_is_in_recovery())').catch(() => true);
      if (r === false) break;
      if (Date.now() > deadline)
        throw new Error('recovery did not finish in time (docker logs ' + container + ')');
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    const replayed = await q('SELECT to_json(pg_last_xact_replay_timestamp())');
    log(
      `promoted after ${String(Math.round((Date.now() - t0) / 1000))} s; last replayed commit ${String(replayed)}`,
    );
    for (const s of RECOVERY_SETTINGS) await q(`ALTER SYSTEM RESET ${s}`);
    await q('SELECT to_json(pg_reload_conf())');
    await verifyDatabase(container, manifest, checks, db);
    verifySecrets(envDir, manifest, checks);
  } finally {
    await run('docker', ['stop', '-t', '60', container], { allowFail: true });
    await run('docker', ['rm', '-f', container], { allowFail: true });
    chmodSync(staging, 0o700);
  }
  const code = printChecks(checks);
  process.stdout.write(
    code === 0
      ? `\nrestored ${manifest.id} + WAL into volume ${volume} in ${String(Math.round((Date.now() - t0) / 1000))} s.\nNext: REMYRAL_DEPLOY_HOST=<new host> node scripts/deploy/deploy.mjs (owner's Mac), then cutover.\n`
      : '\nverification FAILED — do not switch traffic.\n',
  );
  return code;
}

// ---------------------------------------------------------------- verify

async function verifyCmd(v) {
  const env = assertEnv(opt(v, 'env'));
  const staging = resolve(opt(v, 'staging'));
  const dataRoot = resolve(v['data-root'] ?? '/data/remyral');
  const manifest = validateBaseManifest(JSON.parse(readFileSync(join(staging, 'base.json'), 'utf8')));
  const checks = [];
  verifySecrets(join(dataRoot, env), manifest, checks);
  const stackEnv = join(dataRoot, env, 'stack.env');
  const names = installationNames(existsSync(stackEnv) ? readFileSync(stackEnv, 'utf8') : '', env);
  const project = v.project ?? names.project;
  const db = v.db ?? names.db;
  let container = v['pg-container'];
  if (!container) {
    const ps = await run(
      'docker',
      [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.service=postgres',
      ],
      { allowFail: true },
    );
    container = ps.stdout.trim().split('\n')[0] || null;
  }
  if (container) await verifyDatabase(container, manifest, checks, db);
  else
    checks.push({
      name: 'database',
      ok: false,
      detail: 'no running postgres container (start the stack or pass --pg-container)',
    });
  if (v.url) {
    const res = await fetch(v.url).catch((e) => ({ ok: false, status: String(e.cause?.code ?? e.message) }));
    checks.push({ name: 'health', ok: res.ok === true, detail: `${v.url} → ${String(res.status)}` });
  }
  return printChecks(checks);
}

// ---------------------------------------------------------------- cutover

async function cutoverCmd(v) {
  const r = await cloudflareCutover({
    token: process.env.CLOUDFLARE_API_TOKEN ?? '',
    zoneId: v['zone-id'] ?? process.env.CLOUDFLARE_ZONE_ID ?? '',
    name: opt(v, 'name'),
    ip: opt(v, 'ip'),
    dryRun: v['dry-run'] === true,
  });
  process.stdout.write(
    `${r.changed ? 'updated' : v['dry-run'] ? 'dry run' : 'unchanged'}: ${opt(v, 'name')} ${r.from} → ${r.to} (proxied ${String(r.proxied)}, record ${r.recordId})\n`,
  );
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: 'string' },
      offsite: { type: 'string' },
      identity: { type: 'string' },
      out: { type: 'string' },
      base: { type: 'string' },
      staging: { type: 'string' },
      'target-time': { type: 'string' },
      'data-root': { type: 'string' },
      project: { type: 'string' },
      db: { type: 'string' },
      'timeout-minutes': { type: 'string' },
      'pg-container': { type: 'string' },
      url: { type: 'string' },
      force: { type: 'boolean', default: false },
      name: { type: 'string' },
      ip: { type: 'string' },
      'zone-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  switch (positionals[0]) {
    case 'fetch':
      return fetchCmd(values);
    case 'restore':
      return restoreCmd(values);
    case 'verify':
      return verifyCmd(values);
    case 'cutover':
      return cutoverCmd(values);
    default:
      process.stdout.write(
        readFileSync(new URL(import.meta.url), 'utf8')
          .split('\n')
          .slice(1, 22)
          .join('\n')
          .replace(/^\/\/ ?/gm, '') + '\n',
      );
      return positionals[0] === undefined || positionals[0] === 'help' ? 0 : 64;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`standby-restore: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
