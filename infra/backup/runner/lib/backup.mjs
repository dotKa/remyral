// One backup run (p10-backup-restore §3): consistent pg_dump + manifest, encrypted secrets archive, optional
// off-site copy, local retention, status.json.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ageEncryptArgs, findIdentities } from './age.mjs';
import { loadOffsite, loadRecipients } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { mirrorBlobs } from './blobs.mjs';
import { buildManifest, validateManifest } from './manifest.mjs';
import { backupId, localFiles, offsiteKey, parseBackupId, tierFor } from './naming.mjs';
import { dumpWithSnapshot, sha256File } from './pg.mjs';
import { localTools } from './proc.mjs';
import { planRetention } from './retention.mjs';
import { S3Target } from './s3.mjs';
import { errorText, readStatus, recordBackup, writeStatus } from './status.mjs';

const noop = () => undefined;

export function ensureDirs(cfg) {
  for (const d of [
    cfg.root,
    join(cfg.root, 'db'),
    join(cfg.root, 'secrets'),
    join(cfg.root, 'drills'),
    join(cfg.root, '.tmp'),
  ]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // 0711: the drill's throw-away server runs as the postgres user and must traverse the root to reach
  // `.drill/<id>` (its own 0700 dir); it can list nothing here, and db/ and secrets/ stay 0700.
  chmodSync(cfg.root, 0o711);
}

/** Local backups of this environment that are complete (dump + valid manifest), newest first. */
export function listBackups(cfg) {
  const dir = join(cfg.root, 'db');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const m = /^(remana-[a-z0-9-]+-\d{8}T\d{6}Z)\.manifest\.json$/.exec(f);
    if (!m) continue;
    const parsed = parseBackupId(m[1]);
    if (!parsed || parsed.env !== cfg.env) continue;
    try {
      const manifest = validateManifest(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (manifest.id !== m[1] || !existsSync(join(cfg.root, localFiles(m[1]).dump))) continue;
      out.push({ id: m[1], at: parsed.at, manifest });
    } catch {
      // an unreadable manifest is not a usable backup
    }
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function removeBackupFiles(cfg, id) {
  const f = localFiles(id);
  for (const p of [f.dump, `${f.dump}.partial`, f.manifest, f.secrets, `${f.secrets}.partial`]) {
    rmSync(join(cfg.root, p), { force: true });
  }
}

function writeJson0600(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** tar of the secrets entries streamed into age; the plaintext only exists in the pipe. */
async function archiveSecrets(cfg, tools, recipients, outPath) {
  const entries = cfg.secretEntries.filter((e) => existsSync(join(cfg.source, e)));
  if (entries.length === 0) throw new Error(`nothing to archive in ${cfg.source}`);
  const partial = `${outPath}.partial`;
  rmSync(partial, { force: true });
  const tar = tools.spawn('tar', ['-c', '-f', '-', '-C', cfg.source, ...entries], { stdout: 'stream' });
  const age = tools.spawn('age', ageEncryptArgs(recipients, partial), { stdin: 'pipe' });
  const plain = createHash('sha256');
  let plainBytes = 0;
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      plain.update(chunk);
      plainBytes += chunk.length;
      cb(null, chunk);
    },
  });
  await Promise.all([pipeline(tar.child.stdout, hasher, age.child.stdin), tar.done, age.done]);
  chmodSync(partial, 0o600);
  renameSync(partial, outPath);
  const c = await sha256File(outPath);
  return { entries, plaintextSha256: plain.digest('hex'), plaintextBytes: plainBytes, ...c };
}

function storageStats(cfg) {
  let bytes = 0;
  let count = 0;
  for (const sub of ['db', 'secrets']) {
    const dir = join(cfg.root, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`remana-${cfg.env}-`)) continue;
      try {
        bytes += statSync(join(dir, f)).size;
        if (f.endsWith('.manifest.json')) count += 1;
      } catch {
        // raced with retention
      }
    }
  }
  let freeBytes;
  try {
    const s = statfsSync(cfg.root);
    freeBytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    freeBytes = null;
  }
  return { backups: count, bytes, freeBytes };
}

/** Applies local retention; returns the removed ids. Never touches another environment's files. */
export function applyRetention(cfg, now) {
  const all = listBackups(cfg);
  const plan = planRetention(all, cfg.retention, now);
  for (const id of plan.remove) removeBackupFiles(cfg, id);
  return plan.remove;
}

async function uploadOffsite(
  cfg,
  tools,
  { off, recipients, id, tier, dumpPath, secretsPath, manifest, log },
) {
  const target = new S3Target(off);
  const tmp = join(cfg.root, '.tmp', `${id}.db.dump.age`);
  rmSync(tmp, { force: true });
  try {
    await tools.run('age', ageEncryptArgs(recipients, tmp, dumpPath));
    const enc = await sha256File(tmp);
    const keys = {
      db: offsiteKey({ prefix: off.prefix, tier, id, kind: 'db' }),
      secrets: secretsPath ? offsiteKey({ prefix: off.prefix, tier, id, kind: 'secrets' }) : null,
      manifest: offsiteKey({ prefix: off.prefix, tier, id, kind: 'manifest' }),
    };
    log(`off-site: uploading ${keys.db} (${String(enc.bytes)} bytes)`);
    await target.putFile(keys.db, tmp, { bytes: enc.bytes, sha256: enc.sha256 });
    if (secretsPath) {
      await target.putFile(keys.secrets, secretsPath, {
        bytes: manifest.files.secrets.bytes,
        sha256: manifest.files.secrets.sha256,
      });
    }
    const offsite = {
      target: off.describe,
      tier,
      keys,
      db: { bytes: enc.bytes, sha256: enc.sha256, encryption: 'age' },
      uploadedAt: new Date().toISOString(),
    };
    const withOffsite = { ...manifest, offsite };
    await target.putBuffer(
      keys.manifest,
      Buffer.from(`${JSON.stringify(withOffsite, null, 2)}\n`, 'utf8'),
      'application/json',
    );
    return withOffsite;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Runs one backup. Never throws for a failed backup: the outcome is recorded in status.json and returned.
 * Throws only when the lock is held by another task.
 */
export async function runBackup(
  cfg,
  { tools = localTools, clock = () => new Date(), reason = 'scheduled', log = noop } = {},
) {
  ensureDirs(cfg);
  const lock = acquireLock(cfg.root, 'backup');
  const startedAt = clock();
  const id = backupId(cfg.env, startedAt);
  const files = localFiles(id);
  const run = {
    runId: id,
    reason,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    outcome: 'failed',
    tier: null,
    schemaVersion: null,
    dbBytes: null,
    dbSha256: null,
    secrets: 'missing',
    offsite: { status: 'not_configured', target: null, error: null },
    blobs: { status: 'not_configured' },
    warnings: [],
    error: null,
    removed: [],
  };
  try {
    if (existsSync(join(cfg.root, files.manifest))) throw new Error(`backup ${id} already exists`);
    if (!cfg.pgEnv.PGPASSWORD)
      throw new Error('REMYRAL_DB_BACKUP_PASSWORD is not set (docs/ops/backups.md §3)');
    const rec = loadRecipients(cfg);
    if (rec.fatal) throw new Error(rec.error);
    const identities = [...findIdentities(cfg.source).map((p) => join(cfg.source, p))];
    if (identities.length > 0) {
      throw new Error(
        `an age private key is stored next to the backups (${identities.slice(0, 3).join(', ')}); move it off the host`,
      );
    }

    // 1. database (consistent snapshot) → db/<id>.dump
    const dumpPath = join(cfg.root, files.dump);
    const fd = openSync(`${dumpPath}.partial`, 'wx', 0o600);
    let dump;
    try {
      dump = await dumpWithSnapshot({ tools, env: cfg.pgEnv, outFd: fd });
    } finally {
      closeSync(fd);
    }
    renameSync(`${dumpPath}.partial`, dumpPath);
    const db = await sha256File(dumpPath);
    log(`database: ${String(db.bytes)} bytes, schema ${dump.inspection.schema.version}`);

    // 2. recovery secrets → secrets/<id>.secrets.tar.age (owner's public keys only)
    let secrets = null;
    if (rec.recipients.length > 0) {
      try {
        const a = await archiveSecrets(cfg, tools, rec.recipients, join(cfg.root, files.secrets));
        secrets = {
          name: files.secrets,
          bytes: a.bytes,
          sha256: a.sha256,
          plaintextSha256: a.plaintextSha256,
          entries: a.entries,
          encryption: 'age',
        };
        run.secrets = 'ok';
      } catch (err) {
        run.secrets = 'failed';
        run.warnings.push(`secrets archive failed: ${errorText(err)}`);
      }
    } else {
      run.warnings.push(`secrets archive skipped: ${rec.error}`);
    }

    // 3. manifest
    const tier = tierFor(
      startedAt,
      listBackups(cfg)
        .filter((b) => b.id !== id)
        .map((b) => b.at),
    );
    let manifest = buildManifest({
      id,
      env: cfg.env,
      createdAt: startedAt,
      finishedAt: clock(),
      tier,
      dump,
      inspection: dump.inspection,
      db: { name: files.dump, bytes: db.bytes, sha256: db.sha256 },
      secrets,
      recipients: rec.recipients,
    });
    writeJson0600(join(cfg.root, files.manifest), manifest);
    Object.assign(run, {
      tier,
      schemaVersion: manifest.schema.version,
      dbBytes: db.bytes,
      dbSha256: db.sha256,
    });

    // 4. off-site copy (encrypted)
    const off = loadOffsite(cfg);
    if (off !== null) {
      const offTarget = off.error ? null : off.describe;
      run.offsite.target = offTarget;
      if (off.error) {
        run.offsite = { status: 'failed', target: null, error: off.error };
      } else if (rec.recipients.length === 0) {
        run.offsite = {
          status: 'failed',
          target: offTarget,
          error: 'off-site copies are encrypted to the owner key: recipients.txt is missing',
        };
      } else {
        try {
          manifest = await uploadOffsite(cfg, tools, {
            off,
            recipients: rec.recipients,
            id,
            tier,
            dumpPath,
            secretsPath: secrets ? join(cfg.root, files.secrets) : null,
            manifest,
            log,
          });
          writeJson0600(join(cfg.root, files.manifest), manifest);
          run.offsite = { status: 'uploaded', target: offTarget, error: null };
        } catch (err) {
          run.offsite = { status: 'failed', target: offTarget, error: errorText(err) };
        }
      }
    }
    // 5. p17-object-storage: the master's local blob directory, mirrored encrypted (and off-site).
    try {
      run.blobs = await mirrorBlobs(cfg, {
        tools,
        recipients: rec.recipients,
        off: off !== null && !off.error && rec.recipients.length > 0 ? off : null,
        clock,
        log,
      });
      if (run.blobs.status === 'failed' || run.blobs.status === 'partial') {
        run.warnings.push(
          `blob copy ${run.blobs.status}: ${run.blobs.error ?? `${String(run.blobs.failed)} file(s) failed`}`,
        );
      }
    } catch (err) {
      run.blobs = { status: 'failed', error: errorText(err) };
      run.warnings.push(`blob copy failed: ${errorText(err)}`);
    }
    run.outcome =
      run.secrets === 'ok' && run.offsite.status !== 'failed' && run.warnings.length === 0 ? 'ok' : 'partial';
    if (run.offsite.status === 'failed') run.warnings.push(`off-site copy failed: ${run.offsite.error}`);
  } catch (err) {
    run.outcome = 'failed';
    run.error = errorText(err);
    removeBackupFiles(cfg, id);
  } finally {
    const finished = clock();
    run.finishedAt = finished.toISOString();
    run.durationMs = finished.getTime() - startedAt.getTime();
    try {
      if (run.outcome !== 'failed') run.removed = applyRetention(cfg, finished);
    } catch (err) {
      run.warnings.push(`retention failed: ${errorText(err)}`);
    }
    try {
      let status = recordBackup(readStatus(cfg.statusDir, cfg.env), run);
      const rec = loadRecipients(cfg);
      const off = loadOffsite(cfg);
      status = {
        ...status,
        storage: storageStats(cfg),
        encryption: {
          configured: rec.recipients.length > 0,
          recipients: rec.recipients.length,
          error: rec.error,
        },
        offsite: {
          configured: off !== null,
          target: off && !off.error ? off.describe : null,
          lastUploadAt:
            run.offsite.status === 'uploaded' ? run.finishedAt : (status.offsite?.lastUploadAt ?? null),
          lastError: run.offsite.status === 'failed' ? run.offsite.error : null,
        },
      };
      writeStatus(cfg.statusDir, status, finished);
    } finally {
      lock.release();
    }
  }
  return run;
}
