// Continuous WAL archiving for the warm standby (p11-master-resilience, docs/ops/backup-restore.md §10).
//
// Postgres (`PG_WAL_ARCHIVE=on`) copies every completed WAL segment durably into `/wal-archive` (archive_command,
// infra/coolify/compose.yaml). The backup daemon then, every ~30 s:
//   1. compresses each new segment into `<root>/wal/<name>.gz` (the local copy the restore drill replays),
//   2. encrypts it to the owner's PUBLIC keys and uploads it off-site as `<prefix>/wal/<env>/<name>.gz.age`
//      (S3/R2, payload hash signed, SHA-256 re-read with HEAD), in WAL order, stopping at the first failure,
//   3. removes the raw segment from `/wal-archive` (as the postgres user, who owns it) once the local copy exists,
//   4. prunes local copies older than the newest base backup's start segment — only after they were shipped (or
//      when no off-site target is configured: then the local copy since the newest base is all there is).
// Progress goes to `status/standby.json` (no secrets: names, times, counts, short errors).
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ageEncryptArgs } from './age.mjs';
import { assertEnv, PREFIX_RE } from './naming.mjs';
import { sha256File } from './pg.mjs';
import { errorText } from './status.mjs';

export const STANDBY_FORMAT = 'remana-backup-standby/v1';

/** A complete segment, a timeline history file, a backup history file, or a partial segment (promotion). */
const SEGMENT_RE = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/;
const HISTORY_RE = /^([0-9A-F]{8})\.history$/;
const BACKUP_RE = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})\.[0-9A-F]{8}\.backup$/;
const PARTIAL_RE = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})\.partial$/;

/**
 * Parses a WAL archive file name. Returns `{ name, kind, timeline, position }` (position: the 16-hex log/segment
 * part, comparable as a string across timelines; history files have none) or null for anything else (temporary
 * files of archive_command, stray files).
 */
export function parseWalName(name) {
  const s = String(name);
  let m = SEGMENT_RE.exec(s);
  if (m) return { name: s, kind: 'segment', timeline: m[1], position: `${m[2]}${m[3]}` };
  m = HISTORY_RE.exec(s);
  if (m) return { name: s, kind: 'history', timeline: m[1], position: null };
  m = BACKUP_RE.exec(s);
  if (m) return { name: s, kind: 'backup', timeline: m[1], position: `${m[2]}${m[3]}` };
  m = PARTIAL_RE.exec(s);
  if (m) return { name: s, kind: 'partial', timeline: m[1], position: `${m[2]}${m[3]}` };
  return null;
}

/** WAL order: history files first (tiny, needed by every restore), then by position, then timeline, then name. */
export function compareWal(a, b) {
  const pa = parseWalName(a);
  const pb = parseWalName(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.kind === 'history' || pb.kind === 'history') {
    if (pa.kind !== pb.kind) return pa.kind === 'history' ? -1 : 1;
    return pa.timeline < pb.timeline ? -1 : pa.timeline > pb.timeline ? 1 : 0;
  }
  if (pa.position !== pb.position) return pa.position < pb.position ? -1 : 1;
  if (pa.timeline !== pb.timeline) return pa.timeline < pb.timeline ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The files a restore from a base backup that starts in segment `startWalFile` needs: every history file and every
 * segment / backup history file at or after the start position (any timeline: restore_command asks by name).
 */
export function walChainSince(names, startWalFile) {
  const start = parseWalName(startWalFile);
  if (!start || start.kind !== 'segment') throw new Error(`invalid start WAL file "${String(startWalFile)}"`);
  return names
    .filter((n) => {
      const p = parseWalName(n);
      if (!p || p.kind === 'partial') return false;
      return p.kind === 'history' || p.position >= start.position;
    })
    .sort(compareWal);
}

/**
 * Gaps in a chain of complete segments of one timeline (a missing segment makes replay stop there). Returns the
 * names of the first missing segments (at most 10). Segments per log file: 0x100 for 16 MiB segments.
 */
export function walGaps(names, segmentsPerLog = 0x100) {
  const byTl = new Map();
  for (const n of names) {
    const p = parseWalName(n);
    if (p?.kind !== 'segment') continue;
    if (!byTl.has(p.timeline)) byTl.set(p.timeline, []);
    byTl.get(p.timeline).push(p.position);
  }
  const gaps = [];
  for (const [tl, positions] of byTl) {
    positions.sort();
    for (let i = 1; i < positions.length && gaps.length < 10; i += 1) {
      let log = parseInt(positions[i - 1].slice(0, 8), 16);
      let seg = parseInt(positions[i - 1].slice(8), 16) + 1;
      if (seg >= segmentsPerLog) {
        log += 1;
        seg = 0;
      }
      const want = `${log.toString(16).toUpperCase().padStart(8, '0')}${seg.toString(16).toUpperCase().padStart(8, '0')}`;
      if (want !== positions[i]) gaps.push(`${tl}${want}`);
    }
  }
  return gaps;
}

/** Off-site object key of one archived WAL file. */
export function walObjectKey({ prefix, env, name }) {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid off-site prefix "${String(prefix)}"`);
  assertEnv(env);
  if (!parseWalName(name)) throw new Error(`invalid WAL file name "${String(name)}"`);
  return `${prefix}/wal/${env}/${name}.gz.age`;
}

/** The WAL name of an off-site key (`…/wal/<env>/<name>.gz.age`), or null. */
export function walNameOfKey(key, env) {
  const m = new RegExp(`/wal/${assertEnv(env)}/([0-9A-F.a-z]+)\\.gz\\.age$`).exec(String(key));
  return m && parseWalName(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------- state

export function emptyStandby(env) {
  return {
    format: STANDBY_FORMAT,
    env,
    updatedAt: null,
    walArchive: { enabled: false },
    lastShippedSegment: null,
    lastShippedAt: null,
    lastArchivedSegment: null,
    lastArchivedAt: null,
    pendingSegments: 0,
    lagSeconds: 0,
    localSegments: 0,
    localBytes: 0,
    offsite: { configured: false, target: null, lastError: null },
    gaps: [],
    lastBaseBackup: null,
    lastSuccessfulBaseBackup: null,
  };
}

export function readStandby(statusDir, env) {
  try {
    const s = JSON.parse(readFileSync(join(statusDir, 'standby.json'), 'utf8'));
    if (s?.format === STANDBY_FORMAT && s.env === env) return { ...emptyStandby(env), ...s };
  } catch {
    // missing or unreadable
  }
  return emptyStandby(env);
}

export function writeStandby(statusDir, standby, now = new Date()) {
  mkdirSync(statusDir, { recursive: true, mode: 0o755 });
  const next = { ...standby, updatedAt: now.toISOString() };
  const tmp = join(statusDir, `.standby.${String(process.pid)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, join(statusDir, 'standby.json'));
  return next;
}

/** Read-modify-write of standby.json (one daemon process writes it; everything here is synchronous). */
export function updateStandby(cfg, fn, now = new Date()) {
  return writeStandby(cfg.statusDir, fn(readStandby(cfg.statusDir, cfg.env)), now);
}

const shippedFile = (cfg) => join(cfg.root, 'wal', '.shipped.json');

function readShipped(cfg) {
  try {
    const v = JSON.parse(readFileSync(shippedFile(cfg), 'utf8'));
    return new Set(Array.isArray(v) ? v.filter((n) => parseWalName(n)) : []);
  } catch {
    return new Set();
  }
}

function writeShipped(cfg, set) {
  const file = shippedFile(cfg);
  writeFileSync(`${file}.tmp`, JSON.stringify([...set].sort(compareWal)), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** `<root>/wal`: root-owned, readable by the drill user's group (the throw-away server replays from it). */
export function ensureWalDir(cfg) {
  const dir = join(cfg.root, 'wal');
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  try {
    chownSync(dir, 0, cfg.drillUser.gid);
    chmodSync(dir, 0o750);
  } catch {
    // not root (tests): the drill then runs as this user anyway
  }
  return dir;
}

async function gzipDurably(src, dst, gid) {
  const partial = `${dst}.partial`;
  rmSync(partial, { force: true });
  await pipeline(
    createReadStream(src),
    createGzip({ level: 6 }),
    createWriteStream(partial, { mode: 0o640 }),
  );
  const fd = openSync(partial, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chownSync(partial, 0, gid);
  } catch {
    // not root (tests)
  }
  chmodSync(partial, 0o640);
  renameSync(partial, dst);
}

/** Removes raw segments from the archive directory as the drill (= postgres) user, who owns them. */
async function removeRaw(tools, cfg, paths) {
  if (paths.length === 0) return;
  const script =
    'for (const p of process.argv.slice(1)) { try { require("node:fs").rmSync(p, { force: true }); } catch {} }';
  await tools.run(process.execPath, ['-e', script, ...paths], {
    uid: cfg.drillUser.uid,
    gid: cfg.drillUser.gid,
    allowFail: true,
  });
  // When the runner itself owns them (tests, or an archive dir owned by root), remove them directly.
  for (const p of paths) rmSync(p, { force: true });
}

/** The newest local base backup's start segment (null: none), from `<root>/base/*.base.json`. */
export function newestLocalBaseStart(cfg) {
  const dir = join(cfg.root, 'base');
  if (!existsSync(dir)) return null;
  const manifests = readdirSync(dir)
    .filter((f) => /^remana-[a-z0-9-]+-\d{8}T\d{6}Z\.base\.json$/.test(f))
    .sort();
  for (const f of manifests.reverse()) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (
        m.env === cfg.env &&
        parseWalName(m.startWalFile)?.kind === 'segment' &&
        existsSync(join(dir, m.files.base.name))
      )
        return m.startWalFile;
    } catch {
      // unreadable: not a usable base
    }
  }
  return null;
}

/**
 * Local prune plan (pure): which local copies may go. A file older than `keepFrom` (the newest base's start
 * segment) goes when it was shipped off-site, or when no off-site target is configured. History files stay.
 */
export function planWalPrune({ local, shipped, keepFrom, offsiteConfigured }) {
  if (keepFrom === null) return [];
  const start = parseWalName(keepFrom);
  if (start?.kind !== 'segment') return [];
  return local.filter((n) => {
    const p = parseWalName(n);
    if (!p || p.kind === 'history') return false;
    if (p.position >= start.position) return false;
    return !offsiteConfigured || shipped.has(n);
  });
}

/**
 * One shipping pass. `offsite`: `{ target: S3Target-like, prefix, describe }` or null; `recipients`: the owner's
 * public keys. Never throws for an upload failure (recorded in standby.json and returned).
 */
export async function shipWal(
  cfg,
  { tools, offsite, recipients, clock = () => new Date(), log = () => undefined },
) {
  const now = clock();
  const archiveDir = cfg.walArchiveDir;
  const localDir = ensureWalDir(cfg);
  mkdirSync(join(cfg.root, '.tmp'), { recursive: true, mode: 0o700 });
  const result = { converted: 0, shipped: 0, pruned: 0, error: null };

  // 1. raw → local compressed copy; 3. raw removed once the copy is durable.
  const raw = existsSync(archiveDir)
    ? readdirSync(archiveDir)
        .filter((n) => parseWalName(n))
        .sort(compareWal)
    : [];
  const done = [];
  let lastArchived = null;
  for (const n of raw) {
    const src = join(archiveDir, n);
    const dst = join(localDir, `${n}.gz`);
    try {
      if (!existsSync(dst)) {
        await gzipDurably(src, dst, cfg.drillUser.gid);
        result.converted += 1;
      }
      lastArchived = { name: n, at: statSync(src).mtime.toISOString() };
      done.push(src);
    } catch (err) {
      result.error = `local copy of ${n} failed: ${errorText(err)}`;
      break;
    }
  }
  await removeRaw(tools, cfg, done);

  // 2. off-site, in WAL order, stopping at the first failure (a hole would break the replay chain).
  const local = readdirSync(localDir)
    .filter((f) => f.endsWith('.gz') && parseWalName(f.slice(0, -3)))
    .map((f) => f.slice(0, -3))
    .sort(compareWal);
  const shipped = readShipped(cfg);
  let lastShipped = null;
  const offsiteReady = offsite !== null && recipients.length > 0;
  if (offsite !== null && recipients.length === 0 && !result.error)
    result.error = 'off-site WAL copies are encrypted to the owner key: recipients.txt is missing';
  if (offsiteReady) {
    for (const n of local) {
      if (shipped.has(n)) continue;
      const tmp = join(cfg.root, '.tmp', `wal-${n}.gz.age`);
      rmSync(tmp, { force: true });
      try {
        await tools.run('age', ageEncryptArgs(recipients, tmp, join(localDir, `${n}.gz`)));
        const enc = await sha256File(tmp);
        await offsite.target.putFile(walObjectKey({ prefix: offsite.prefix, env: cfg.env, name: n }), tmp, {
          bytes: enc.bytes,
          sha256: enc.sha256,
        });
        shipped.add(n);
        writeShipped(cfg, shipped);
        result.shipped += 1;
        lastShipped = { name: n, at: clock().toISOString() };
      } catch (err) {
        result.error = `off-site upload of ${n} failed: ${errorText(err)}`;
        break;
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }

  // 4. prune.
  const remove = planWalPrune({
    local,
    shipped,
    keepFrom: newestLocalBaseStart(cfg),
    offsiteConfigured: offsite !== null,
  });
  for (const n of remove) {
    rmSync(join(localDir, `${n}.gz`), { force: true });
    shipped.delete(n);
    result.pruned += 1;
  }
  if (remove.length > 0) writeShipped(cfg, shipped);

  // status
  const remaining = local.filter((n) => !remove.includes(n));
  const unshipped = offsite !== null ? remaining.filter((n) => !shipped.has(n)) : [];
  const pendingRaw = raw.length - done.length;
  let oldestPending = null;
  for (const n of unshipped) {
    try {
      const t = statSync(join(localDir, `${n}.gz`)).mtime.getTime();
      if (oldestPending === null || t < oldestPending) oldestPending = t;
    } catch {
      // pruned meanwhile
    }
  }
  if (pendingRaw > 0) {
    try {
      const t = statSync(join(archiveDir, raw[done.length])).mtime.getTime();
      if (oldestPending === null || t < oldestPending) oldestPending = t;
    } catch {
      // gone
    }
  }
  let localBytes = 0;
  for (const n of remaining) {
    try {
      localBytes += statSync(join(localDir, `${n}.gz`)).size;
    } catch {
      // pruned meanwhile
    }
  }
  updateStandby(
    cfg,
    (s) => ({
      ...s,
      walArchive: { enabled: true },
      lastArchivedSegment: lastArchived?.name ?? s.lastArchivedSegment,
      lastArchivedAt: lastArchived?.at ?? s.lastArchivedAt,
      lastShippedSegment: lastShipped?.name ?? s.lastShippedSegment,
      lastShippedAt: lastShipped?.at ?? s.lastShippedAt,
      pendingSegments: unshipped.length + pendingRaw,
      lagSeconds:
        oldestPending === null ? 0 : Math.max(0, Math.round((now.getTime() - oldestPending) / 1000)),
      localSegments: remaining.length,
      localBytes,
      offsite: {
        configured: offsite !== null,
        target: offsite?.describe ?? null,
        lastError: result.error,
      },
      gaps: walGaps(remaining),
    }),
    clock(),
  );
  if (result.converted || result.shipped || result.pruned || result.error)
    log(
      `wal: ${String(result.converted)} archived, ${String(result.shipped)} shipped, ${String(result.pruned)} pruned${result.error ? ` — ${result.error}` : ''}`,
    );
  return result;
}

/** SHA-256 of a buffer (hex). */
export const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
