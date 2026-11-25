// Physical base backup for the warm standby (p11-master-resilience, docs/ops/backup-restore.md §10). A logical
// dump cannot be replayed with WAL; a base backup can. Non-exclusive low-level API over one psql session (the
// session must stay open from start to stop; if it dies, Postgres aborts the backup):
//
//   SELECT pg_backup_start(label, true)     -- fast checkpoint
//   tar of PGDATA (read-only mount), without the directories the PG docs say to omit
//   SELECT … FROM pg_backup_stop(true)       -- waits until the last needed WAL segment is archived
//
// backup_label (and tablespace_map) are returned by pg_backup_stop and stored in the manifest; the restore writes
// them into the data directory. Output: `<root>/base/<id>.base.tar.gz` (local, plaintext like the local dumps) and
// off-site `<prefix>/base/<env>/<id>.base.tar.gz.age` + `<id>.base.json` (uploaded last: present ⇒ complete).
import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ageEncryptArgs } from './age.mjs';
import { loadOffsite, loadRecipients } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { backupId, parseBackupId, PREFIX_RE } from './naming.mjs';
import { PsqlSession, sha256File } from './pg.mjs';
import { localTools } from './proc.mjs';
import { S3Target } from './s3.mjs';
import { errorText } from './status.mjs';
import { parseWalName, updateStandby } from './wal.mjs';

export const BASE_FORMAT = 'remana-base-manifest/v1';

/** What a base backup leaves out (PostgreSQL docs, "Making a Base Backup Using the Low Level API"). */
export const BASE_EXCLUDES = [
  './pg_wal/*',
  './pg_replslot/*',
  './pg_dynshmem/*',
  './pg_notify/*',
  './pg_serial/*',
  './pg_snapshots/*',
  './pg_stat_tmp/*',
  './pg_subtrans/*',
  './postmaster.pid',
  './postmaster.opts',
  './backup_label',
  './tablespace_map',
  'pgsql_tmp*',
  'pg_internal.init',
];

/** argv of the tar that archives PGDATA (GNU tar; files changing while read are expected and fine). */
export function baseTarArgs(pgdata) {
  if (!/^\/[A-Za-z0-9/._-]+$/.test(pgdata)) throw new Error('unsafe PGDATA path');
  return [
    '-c',
    '-f',
    '-',
    '-C',
    pgdata,
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    '--warning=no-file-shrank',
    ...BASE_EXCLUDES.map((e) => `--exclude=${e}`),
    '.',
  ];
}

/** Parses backup_label: `{ startLsn, startWalFile, checkpointLsn, timeline, startTime, label }`. */
export function parseBackupLabel(text) {
  const t = String(text);
  const start = /^START WAL LOCATION: ([0-9A-F]+\/[0-9A-F]+) \(file ([0-9A-F]{24})\)$/m.exec(t);
  const tl = /^START TIMELINE: (\d+)$/m.exec(t);
  if (!start || !tl) throw new Error('backup_label without START WAL LOCATION / START TIMELINE');
  return {
    startLsn: start[1],
    startWalFile: start[2],
    checkpointLsn: /^CHECKPOINT LOCATION: ([0-9A-F]+\/[0-9A-F]+)$/m.exec(t)?.[1] ?? null,
    timeline: Number(tl[1]),
    startTime: /^START TIME: (.+)$/m.exec(t)?.[1] ?? null,
    label: /^LABEL: (.+)$/m.exec(t)?.[1] ?? null,
  };
}

/**
 * `kid` of the lease-signing key (same algorithm as @remyral/protocol `leaseKeyId`: the first 16 base64url characters
 * of SHA-256 over the raw Ed25519 public key). Proves after a restore that workers' pinned lease keys still verify.
 * Null when the file is missing or not an Ed25519 private key.
 */
export function leaseKeyKidFromPem(pem) {
  try {
    const pub = createPublicKey(createPrivateKey(pem));
    if (pub.asymmetricKeyType !== 'ed25519') return null;
    const x = pub.export({ format: 'jwk' }).x;
    if (typeof x !== 'string') return null;
    return createHash('sha256').update(Buffer.from(x, 'base64url')).digest('base64url').slice(0, 16);
  } catch {
    return null;
  }
}

export function baseFiles(id) {
  if (!parseBackupId(id)) throw new Error(`invalid base backup id "${String(id)}"`);
  return { tar: `${id}.base.tar.gz`, manifest: `${id}.base.json` };
}

export function baseObjectKeys({ prefix, id }) {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid off-site prefix "${String(prefix)}"`);
  const p = parseBackupId(id);
  if (!p) throw new Error(`invalid base backup id "${String(id)}"`);
  return {
    tar: `${prefix}/base/${p.env}/${id}.base.tar.gz.age`,
    manifest: `${prefix}/base/${p.env}/${id}.base.json`,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Validates a base manifest (local or downloaded); returns it or throws. */
export function validateBaseManifest(m) {
  const bad = (what) => {
    throw new Error(`invalid base manifest: ${what}`);
  };
  if (m === null || typeof m !== 'object' || m.format !== BASE_FORMAT) bad('format');
  const id = parseBackupId(m.id);
  if (!id || id.env !== m.env) bad('id/env');
  if (parseWalName(m.startWalFile)?.kind !== 'segment') bad('startWalFile');
  if (!Number.isInteger(m.timeline) || m.timeline < 1) bad('timeline');
  if (typeof m.labelFile !== 'string' || !m.labelFile.includes('START WAL LOCATION')) bad('labelFile');
  if (m.tablespaceMap !== null && typeof m.tablespaceMap !== 'string') bad('tablespaceMap');
  if (typeof m.files?.base?.name !== 'string' || m.files.base.name !== baseFiles(m.id).tar)
    bad('files.base.name');
  if (!Number.isSafeInteger(m.files.base.bytes) || !HEX64.test(m.files.base.sha256 ?? '')) bad('files.base');
  if (m.leaseKeyKid !== null && !/^[A-Za-z0-9_-]{16}$/.test(String(m.leaseKeyKid))) bad('leaseKeyKid');
  if (m.offsite !== null && m.offsite !== undefined) {
    if (!HEX64.test(m.offsite.sha256 ?? '') || !Number.isSafeInteger(m.offsite.bytes)) bad('offsite');
  }
  return m;
}

/** Local base backups (complete: manifest + tar), newest first. */
export function listBaseBackups(cfg) {
  const dir = join(cfg.root, 'base');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const m = /^(remana-[a-z0-9-]+-\d{8}T\d{6}Z)\.base\.json$/.exec(f);
    if (!m) continue;
    try {
      const manifest = validateBaseManifest(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (manifest.env !== cfg.env || !existsSync(join(dir, manifest.files.base.name))) continue;
      out.push({ id: m[1], at: parseBackupId(m[1]).at, manifest });
    } catch {
      // not a usable base
    }
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function ensureBaseDir(cfg) {
  const dir = join(cfg.root, 'base');
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  try {
    chownSync(dir, 0, cfg.drillUser.gid);
    chmodSync(dir, 0o750);
  } catch {
    // not root (tests)
  }
  return dir;
}

/**
 * One base backup. Never throws for a failed backup (recorded in standby.json and returned); throws only when the
 * lock is held by another task.
 */
export async function runBaseBackup(
  cfg,
  { tools = localTools, clock = () => new Date(), log = () => undefined, reason = 'scheduled' } = {},
) {
  const lock = acquireLock(cfg.root, 'base backup');
  const startedAt = clock();
  const id = backupId(cfg.env, startedAt);
  const files = baseFiles(id);
  const run = {
    id,
    reason,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    outcome: 'failed',
    bytes: null,
    startWalFile: null,
    offsite: { status: 'not_configured', error: null },
    error: null,
  };
  const dir = ensureBaseDir(cfg);
  const tarPath = join(dir, files.tar);
  let session = null;
  try {
    if (!cfg.pgdataDir || !existsSync(join(cfg.pgdataDir, 'PG_VERSION')))
      throw new Error(`no PostgreSQL data directory at ${String(cfg.pgdataDir)} (mount pgdata read-only)`);
    if (!cfg.pgEnv.PGPASSWORD) throw new Error('REMYRAL_DB_BACKUP_PASSWORD is not set');
    session = PsqlSession.open(tools, { env: cfg.pgEnv });
    await session.query('SET statement_timeout = 0');
    const serverVersion = await session.queryJson("SELECT to_json(current_setting('server_version'))");
    await session.query(`SELECT pg_backup_start('remyral ${id}', true)`);
    log(`base: backup started (${id})`);

    // tar → gzip → local file, hashed on the way.
    const partial = `${tarPath}.partial`;
    rmSync(partial, { force: true });
    const hash = createHash('sha256');
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    const tar = tools.spawn('tar', baseTarArgs(cfg.pgdataDir), { stdout: 'stream', allowFail: true });
    await Promise.all([
      pipeline(
        tar.child.stdout,
        createGzip({ level: 6 }),
        counter,
        createWriteStream(partial, { mode: 0o640 }),
      ),
      tar.done,
    ]);
    const tarExit = (await tar.done).code;
    // GNU tar: 1 = "some files differ" (changed while read) — expected for a live data directory.
    if (tarExit !== 0 && tarExit !== 1)
      throw new Error(`tar of the data directory exited ${String(tarExit)}`);
    const fd = openSync(partial, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    const stop = await session.queryJson(
      "SELECT json_build_object('lsn', lsn::text, 'labelfile', labelfile, 'spcmapfile', spcmapfile) FROM pg_backup_stop(true)",
    );
    const label = parseBackupLabel(stop.labelfile);
    const schema = await session
      .queryJson(
        "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN json_build_object('version', '', 'count', 0) ELSE (SELECT json_build_object('version', coalesce(max(version), ''), 'count', count(*)) FROM schema_migrations) END",
      )
      .catch(() => ({ version: '', count: 0 }));
    await session.close();
    session = null;
    try {
      chownSync(partial, 0, cfg.drillUser.gid);
    } catch {
      // not root (tests)
    }
    renameSync(partial, tarPath);

    const pemPath = join(cfg.source, 'secrets', 'lease-signing.pem');
    const leaseKeyKid = existsSync(pemPath) ? leaseKeyKidFromPem(readFileSync(pemPath, 'utf8')) : null;
    let manifest = {
      format: BASE_FORMAT,
      id,
      env: cfg.env,
      createdAt: startedAt.toISOString(),
      finishedAt: clock().toISOString(),
      serverVersion,
      schema,
      startLsn: label.startLsn,
      stopLsn: stop.lsn,
      startWalFile: label.startWalFile,
      timeline: label.timeline,
      labelFile: stop.labelfile,
      tablespaceMap: stop.spcmapfile && stop.spcmapfile.trim() !== '' ? stop.spcmapfile : null,
      leaseKeyKid,
      files: { base: { name: files.tar, bytes, sha256: hash.digest('hex'), compression: 'gzip' } },
      offsite: null,
    };
    validateBaseManifest(manifest);
    const writeManifest = () => {
      const p = join(dir, files.manifest);
      writeFileSync(`${p}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
      try {
        chownSync(`${p}.tmp`, 0, cfg.drillUser.gid);
      } catch {
        // not root (tests)
      }
      renameSync(`${p}.tmp`, p);
    };
    writeManifest();
    Object.assign(run, { bytes, startWalFile: label.startWalFile });
    log(`base: ${String(bytes)} bytes, starts in ${label.startWalFile}`);

    // off-site (encrypted; the manifest last)
    const off = loadOffsite(cfg);
    const rec = loadRecipients(cfg);
    if (off !== null) {
      if (off.error) run.offsite = { status: 'failed', error: off.error };
      else if (rec.recipients.length === 0)
        run.offsite = {
          status: 'failed',
          error: 'recipients.txt is missing (off-site copies are encrypted)',
        };
      else {
        const tmp = join(cfg.root, '.tmp', `${id}.base.tar.gz.age`);
        mkdirSync(join(cfg.root, '.tmp'), { recursive: true, mode: 0o700 });
        rmSync(tmp, { force: true });
        try {
          await tools.run('age', ageEncryptArgs(rec.recipients, tmp, tarPath));
          const enc = await sha256File(tmp);
          const keys = baseObjectKeys({ prefix: off.prefix, id });
          const target = new S3Target(off);
          await target.putFile(keys.tar, tmp, { bytes: enc.bytes, sha256: enc.sha256 });
          manifest = {
            ...manifest,
            offsite: {
              target: off.describe,
              key: keys.tar,
              bytes: enc.bytes,
              sha256: enc.sha256,
              encryption: 'age',
              uploadedAt: clock().toISOString(),
            },
          };
          await target.putBuffer(
            keys.manifest,
            Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
            'application/json',
          );
          writeManifest();
          run.offsite = { status: 'uploaded', error: null };
        } catch (err) {
          run.offsite = { status: 'failed', error: errorText(err) };
        } finally {
          rmSync(tmp, { force: true });
        }
      }
    }
    run.outcome = run.offsite.status === 'failed' ? 'partial' : 'ok';

    // Local retention: the newest base only (the WAL since it is what the drill replays).
    for (const b of listBaseBackups(cfg)) {
      if (b.id === id) continue;
      rmSync(join(dir, baseFiles(b.id).tar), { force: true });
      rmSync(join(dir, baseFiles(b.id).manifest), { force: true });
    }
  } catch (err) {
    run.outcome = 'failed';
    run.error = errorText(err);
    rmSync(`${tarPath}.partial`, { force: true });
    rmSync(tarPath, { force: true });
    rmSync(join(dir, files.manifest), { force: true });
  } finally {
    if (session !== null) await session.close().catch(() => undefined);
    const finished = clock();
    run.finishedAt = finished.toISOString();
    run.durationMs = finished.getTime() - startedAt.getTime();
    try {
      updateStandby(
        cfg,
        (s) => ({
          ...s,
          walArchive: { enabled: cfg.walArchive.enabled },
          lastBaseBackup: run,
          lastSuccessfulBaseBackup: run.outcome === 'failed' ? s.lastSuccessfulBaseBackup : run,
        }),
        finished,
      );
    } finally {
      lock.release();
    }
  }
  return run;
}

/** Whether the daemon should take a base backup now: none yet, or the newest successful one is ≥ 20 h old. */
export function baseBackupDue({ now, lastSuccessAt, lastAttemptAt, intervalMs = 20 * 3_600_000 }) {
  if (lastAttemptAt !== null && now.getTime() - lastAttemptAt.getTime() < 3_600_000 && lastSuccessAt === null)
    return false; // failing: at most one retry per hour
  if (lastSuccessAt === null) return true;
  if (
    lastAttemptAt !== null &&
    lastAttemptAt > lastSuccessAt &&
    now.getTime() - lastAttemptAt.getTime() < 3_600_000
  )
    return false;
  return now.getTime() - lastSuccessAt.getTime() >= intervalMs;
}
