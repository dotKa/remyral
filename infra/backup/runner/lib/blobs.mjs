// p17-object-storage (docs/design/p17-object-storage.md §8): the master's local blob directory (job outputs and other
// files when no object storage is configured) is part of the backup. Blobs are immutable files under id-based keys
// (written once, removed only by the master's blob GC), so the runner mirrors them incrementally: every new file is
// encrypted to the owner's age keys into <root>/blobs/data/<key>.age and, with an off-site target, uploaded to
// <prefix>/blobs/<env>/<key>.age. A blob the master deleted is kept for `keepDeletedDays` (an older database backup
// may still name it), then removed from the local mirror. Object storage (S3 / R2 / MinIO) is not copied here: the
// bucket is its own system of record (versioning + lifecycle, docs/ops/backup-restore.md §12).
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ageEncryptArgs } from './age.mjs';
import { S3Target } from './s3.mjs';

const DAY = 86_400_000;

async function sha256Of(path) {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const c of createReadStream(path)) {
    h.update(c);
    bytes += c.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

/** Regular files below `dir` (relative, `/`-separated), skipping dot entries (in-flight uploads, temp files). */
export function listBlobFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = statSync(p);
        out.push({
          rel: relative(dir, p).split(sep).join('/'),
          size: st.size,
          mtimeMs: Math.trunc(st.mtimeMs),
        });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function readIndex(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return typeof v === 'object' && v !== null && typeof v.files === 'object' ? v : { files: {} };
  } catch {
    return { files: {} };
  }
}

function writeIndex(path, index) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Mirrors the blob directory into the backup (encrypted) and off-site. Never throws for a failed file (counted and
 * reported); returns a summary for status.json. Bounded per run (`maxFiles` new files; the rest follow next run).
 */
export async function mirrorBlobs(
  cfg,
  { tools, recipients, off, clock = () => new Date(), log = () => undefined, maxFiles = 5000 },
) {
  const src = cfg.blobDir;
  if (!src || !existsSync(src))
    return { status: 'not_configured', files: 0, bytes: 0, copied: 0, failed: 0, removed: 0 };
  if (recipients.length === 0) {
    return {
      status: 'failed',
      error: 'blob copies are encrypted to the owner key: recipients.txt is missing',
      files: 0,
      bytes: 0,
      copied: 0,
      failed: 0,
      removed: 0,
    };
  }
  const root = join(cfg.root, 'blobs');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const indexPath = join(root, 'index.json');
  const index = readIndex(indexPath);
  const now = clock();
  const files = listBlobFiles(src);
  const present = new Set(files.map((f) => f.rel));
  const target = off && !off.error ? new S3Target(off) : null;
  let copied = 0;
  let failed = 0;
  let bytes = 0;
  const errors = [];
  for (const f of files) {
    bytes += f.size;
    const known = index.files[f.rel];
    const local = known && known.size === f.size && known.mtimeMs === f.mtimeMs && !known.deletedAt;
    if (local && (target === null || known.offsite === true)) continue;
    if (copied >= maxFiles) break;
    const out = join(dataDir, `${f.rel}.age`);
    try {
      if (!local) {
        mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
        const tmp = `${out}.partial`;
        rmSync(tmp, { force: true });
        await tools.run('age', ageEncryptArgs(recipients, tmp, join(src, f.rel)));
        renameSync(tmp, out);
      }
      let offsite = false;
      if (target !== null) {
        const enc = await sha256Of(out);
        const key = `${off.prefix ? `${off.prefix.replace(/\/+$/, '')}/` : ''}blobs/${cfg.env}/${f.rel}.age`;
        await target.putFile(key, out, { bytes: enc.bytes, sha256: enc.sha256 });
        offsite = true;
      }
      index.files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, offsite, copiedAt: now.toISOString() };
      copied += 1;
    } catch (err) {
      failed += 1;
      if (errors.length < 5)
        errors.push(`${f.rel}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
    }
  }
  // Blobs the master deleted: kept for keepDeletedDays, then removed from the local mirror.
  let removed = 0;
  for (const [rel, e] of Object.entries(index.files)) {
    if (present.has(rel)) {
      if (e.deletedAt) delete e.deletedAt;
      continue;
    }
    if (!e.deletedAt) e.deletedAt = now.toISOString();
    else if (now.getTime() - Date.parse(e.deletedAt) > cfg.blobKeepDeletedDays * DAY) {
      rmSync(join(dataDir, `${rel}.age`), { force: true });
      index.files = Object.fromEntries(Object.entries(index.files).filter(([k]) => k !== rel));
      removed += 1;
    }
  }
  writeIndex(indexPath, index);
  if (copied > 0 || failed > 0)
    log(`blobs: ${String(copied)} copied, ${String(failed)} failed, ${String(removed)} removed`);
  return {
    status: failed > 0 ? 'partial' : 'ok',
    files: files.length,
    bytes,
    copied,
    failed,
    removed,
    offsite: target !== null,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
