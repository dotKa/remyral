// File and object names of backups (p10-backup-restore §3). Pure functions; unit-tested.
//
//   local:    db/remana-<env>-<stamp>.dump, db/remana-<env>-<stamp>.manifest.json,
//             secrets/remana-<env>-<stamp>.secrets.tar.age, drills/remana-<env>-<stamp>.drill.json
//   off-site: <prefix>/<tier>/<env>/<YYYY>/<MM>/<DD>/remana-<env>-<stamp>.<db.dump.age|secrets.tar.age|manifest.json>

export const ENV_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
// Frozen (p17-remyral-rebrand): backup ids name objects already stored off-site and on disk; retention, restore,
// drill and the WAL standby list them by this stem, so it stays `remana-<env>-<stamp>`.
export const ID_RE = /^remana-([a-z][a-z0-9-]{0,30})-(\d{8}T\d{6}Z)$/;
export const TIERS = ['monthly', 'weekly', 'daily', 'frequent'];
export const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}){0,4}$/;

export function assertEnv(env) {
  if (typeof env !== 'string' || !ENV_RE.test(env))
    throw new Error(`invalid environment name "${String(env)}"`);
  return env;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** UTC stamp `YYYYMMDDTHHMMSSZ` (second resolution). */
export function stampOf(date) {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export function parseStamp(stamp) {
  const m = STAMP_RE.exec(stamp);
  if (!m) throw new Error(`invalid stamp "${String(stamp)}"`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (stampOf(date) !== stamp) throw new Error(`invalid stamp "${stamp}"`);
  return date;
}

export function backupId(env, date) {
  return `remana-${assertEnv(env)}-${stampOf(date)}`;
}

/** `{ env, stamp, at }` or null for anything that is not a backup id. */
export function parseBackupId(id) {
  const m = ID_RE.exec(String(id));
  if (!m) return null;
  try {
    return { env: m[1], stamp: m[2], at: parseStamp(m[2]) };
  } catch {
    return null;
  }
}

/** Local paths of one backup, relative to the backup root. */
export function localFiles(id) {
  if (!parseBackupId(id)) throw new Error(`invalid backup id "${String(id)}"`);
  return {
    dump: `db/${id}.dump`,
    manifest: `db/${id}.manifest.json`,
    secrets: `secrets/${id}.secrets.tar.age`,
  };
}

export function drillReportFile(drillId) {
  if (!parseBackupId(drillId)) throw new Error(`invalid drill id "${String(drillId)}"`);
  return `drills/${drillId}.drill.json`;
}

/** ISO-8601 week key, e.g. `2026-W42` (weeks start Monday; week 1 contains the first Thursday). */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${String(d.getUTCFullYear())}-W${pad(week)}`;
}
export const dayKey = (date) => date.toISOString().slice(0, 10);
export const monthKey = (date) => date.toISOString().slice(0, 7);

/**
 * Off-site tier of a new backup taken at `at`, given the times of earlier successful backups: the first of the
 * UTC month is `monthly`, else the first of the ISO week `weekly`, else the first of the UTC day `daily`, else
 * `frequent`. Bucket lifecycle rules expire each tier prefix on its own.
 */
export function tierFor(at, previous) {
  const earlier = previous.filter((p) => p.getTime() < at.getTime());
  if (!earlier.some((p) => monthKey(p) === monthKey(at))) return 'monthly';
  if (!earlier.some((p) => isoWeek(p) === isoWeek(at))) return 'weekly';
  if (!earlier.some((p) => dayKey(p) === dayKey(at))) return 'daily';
  return 'frequent';
}

export const OFFSITE_KINDS = {
  db: 'db.dump.age',
  secrets: 'secrets.tar.age',
  manifest: 'manifest.json',
};

/** Off-site object key (lifecycle rules match on `<prefix>/<tier>/`). */
export function offsiteKey({ prefix, tier, id, kind }) {
  const parsed = parseBackupId(id);
  if (!parsed) throw new Error(`invalid backup id "${String(id)}"`);
  if (!TIERS.includes(tier)) throw new Error(`invalid tier "${String(tier)}"`);
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid off-site prefix "${String(prefix)}"`);
  const ext = OFFSITE_KINDS[kind];
  if (!ext) throw new Error(`invalid object kind "${String(kind)}"`);
  const d = parsed.at;
  return `${prefix}/${tier}/${parsed.env}/${pad(d.getUTCFullYear(), 4)}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${id}.${ext}`;
}
