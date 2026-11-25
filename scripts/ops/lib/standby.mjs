import { preRenameNames } from './pre-rename-backups.mjs'; // p17-prerename-backups (see that file)
/* global fetch */
// Pure parts of the standby restore (p11-master-resilience, scripts/ops/standby-restore.mjs): choosing the newest
// complete base backup, the WAL chain it needs and the newest secrets archive from an off-site listing; the data
// directory preparation script; the Cloudflare DNS cutover requests. Unit-tested in scripts/test/backup-standby.test.mjs.
import { isIP } from 'node:net';
import { parseBackupId } from '../../../infra/backup/runner/lib/naming.mjs';
import {
  compareWal,
  parseWalName,
  walChainSince,
  walNameOfKey,
} from '../../../infra/backup/runner/lib/wal.mjs';

const ID = '(remana-[a-z][a-z0-9-]{0,30}-\\d{8}T\\d{6}Z)';

/**
 * Newest base backup of `env` whose manifest AND encrypted archive are both present (the manifest is uploaded last,
 * so its presence means the upload completed). Returns `{ id, manifestKey, tarKey }` or null.
 */
export function newestBase(keys, env, wanted = null) {
  const re = new RegExp(`/base/${env}/${ID}\\.base\\.json$`);
  const set = new Set(keys);
  const found = [];
  for (const k of keys) {
    const m = re.exec(k);
    if (!m) continue;
    const p = parseBackupId(m[1]);
    if (!p || p.env !== env) continue;
    const tarKey = k.replace(/\.base\.json$/, '.base.tar.gz.age');
    if (!set.has(tarKey)) continue;
    if (wanted !== null && m[1] !== wanted) continue;
    found.push({ id: m[1], at: p.at, manifestKey: k, tarKey });
  }
  found.sort((a, b) => b.at.getTime() - a.at.getTime());
  const top = found[0];
  return top ? { id: top.id, manifestKey: top.manifestKey, tarKey: top.tarKey } : null;
}

/** Newest encrypted secrets archive of `env` (any tier), at or before `notAfter` when given. `{ id, key }` or null. */
export function newestSecrets(keys, env) {
  const re = new RegExp(`/${ID}\\.secrets\\.tar\\.age$`);
  let best = null;
  for (const k of keys) {
    const m = re.exec(k);
    const p = m ? parseBackupId(m[1]) : null;
    if (!p || p.env !== env) continue;
    if (best === null || p.at > best.at) best = { id: m[1], key: k, at: p.at };
  }
  return best === null ? null : { id: best.id, key: best.key };
}

/** The off-site WAL objects a restore from `startWalFile` needs, in WAL order: `[{ name, key }]`. */
export function walObjectsForBase(keys, env, startWalFile) {
  const byName = new Map();
  for (const k of keys) {
    const n = walNameOfKey(k, env);
    if (n) byName.set(n, k);
  }
  return walChainSince([...byName.keys()], startWalFile)
    .sort(compareWal)
    .map((name) => ({ name, key: byName.get(name) }));
}

/** PGDATA of the official image for a server version (`18.6` → /var/lib/postgresql/18/docker). */
export function pgdataFor(serverVersion) {
  const major = /^(\d+)/.exec(String(serverVersion))?.[1];
  if (!major || Number(major) < 18) throw new Error(`unsupported server version ${String(serverVersion)}`);
  return `/var/lib/postgresql/${major}/docker`;
}

/**
 * Shell script run as root in a one-shot postgres container (volume at /var/lib/postgresql, staging at /staging,
 * read-only): extracts the base, writes backup_label (+ tablespace_map), recovery.signal and the recovery settings.
 */
export function prepareDataDirScript({ pgdata, hasTablespaceMap }) {
  if (!/^\/var\/lib\/postgresql\/\d+\/docker$/.test(pgdata)) throw new Error('unexpected PGDATA');
  return [
    'set -eu',
    `D=${pgdata}`,
    'if [ -e "$D/PG_VERSION" ]; then echo "refusing: $D already holds a cluster" >&2; exit 3; fi',
    'mkdir -p "$D"',
    'tar -x -z -f /staging/base.tar.gz -C "$D"',
    'cp /staging/backup_label "$D/backup_label"',
    ...(hasTablespaceMap ? ['cp /staging/tablespace_map "$D/tablespace_map"'] : []),
    'mkdir -p "$D/pg_wal"',
    ': > "$D/recovery.signal"',
    'cat /staging/recovery.conf >> "$D/postgresql.auto.conf"',
    'chown -R postgres:postgres /var/lib/postgresql',
    'chmod 0700 "$D"',
  ].join('\n');
}

/** Settings the restore appended (removed again with ALTER SYSTEM RESET after promotion). */
export const RECOVERY_SETTINGS = [
  'restore_command',
  'recovery_target_timeline',
  'recovery_target_time',
  'recovery_target_action',
  'archive_mode',
];

/** Validates an ISO time for recovery_target_time; returns it normalised (UTC, `YYYY-MM-DD HH:MM:SS+00`). */
export function targetTimeSetting(iso) {
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) throw new Error(`--target-time must be an ISO date/time, got ${String(iso)}`);
  return `${new Date(t)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')}+00`;
}

// ---------------------------------------------------------------- Cloudflare DNS cutover

const CF_API = 'https://api.cloudflare.com/client/v4';

/** The record type for an address (A / AAAA); throws for anything that is not an IP address. */
export function recordTypeFor(ip) {
  const v = isIP(String(ip));
  if (v === 4) return 'A';
  if (v === 6) return 'AAAA';
  throw new Error(`not an IP address: ${String(ip)}`);
}

/** GET request that finds the console host's record (exact name, one type). */
export function cfListRequest({ zoneId, name, type }) {
  if (!/^[0-9a-f]{32}$/.test(String(zoneId))) throw new Error('zone id must be 32 hex characters');
  if (!/^[a-z0-9.-]{1,253}$/i.test(String(name))) throw new Error('invalid host name');
  const u = new URL(`${CF_API}/zones/${zoneId}/dns_records`);
  u.searchParams.set('type', type);
  u.searchParams.set('name.exact', name.toLowerCase());
  return { method: 'GET', url: u.toString() };
}

/** PATCH request that points one record at the new address (TTL / proxied unchanged). */
export function cfPatchRequest({ zoneId, recordId, ip }) {
  if (!/^[0-9a-f]{32}$/.test(String(recordId))) throw new Error('invalid record id');
  return {
    method: 'PATCH',
    url: `${CF_API}/zones/${zoneId}/dns_records/${recordId}`,
    body: { content: String(ip) },
  };
}

/**
 * Points `name` at `ip` (Cloudflare API v4: list by exact name + type, then PATCH the one record). `fetchImpl` is
 * injected (tests). With `dryRun` only the lookup runs. Returns `{ recordId, from, to, proxied, changed }`.
 */
export async function cloudflareCutover({ token, zoneId, name, ip, dryRun = false, fetchImpl = fetch }) {
  if (!token)
    throw new Error('CLOUDFLARE_API_TOKEN is not set (a token with Zone → DNS → Edit on this zone)');
  const type = recordTypeFor(ip);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const list = cfListRequest({ zoneId, name, type });
  const res = await fetchImpl(list.url, { method: 'GET', headers });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success !== true)
    throw new Error(
      `Cloudflare lookup failed: HTTP ${String(res.status)} ${JSON.stringify(body?.errors ?? []).slice(0, 300)}`,
    );
  const records = Array.isArray(body.result) ? body.result : [];
  if (records.length !== 1)
    throw new Error(
      `expected exactly one ${type} record for ${name}, found ${String(records.length)} (change it by hand)`,
    );
  const rec = records[0];
  const out = { recordId: rec.id, from: rec.content, to: ip, proxied: rec.proxied === true, changed: false };
  if (rec.content === ip || dryRun) return out;
  const patch = cfPatchRequest({ zoneId, recordId: rec.id, ip });
  const r2 = await fetchImpl(patch.url, { method: 'PATCH', headers, body: JSON.stringify(patch.body) });
  const b2 = await r2.json().catch(() => null);
  if (!r2.ok || b2?.success !== true || b2.result?.content !== ip)
    throw new Error(
      `Cloudflare update failed: HTTP ${String(r2.status)} ${JSON.stringify(b2?.errors ?? []).slice(0, 300)}`,
    );
  return { ...out, changed: true };
}

/** Name check used by `fetch` before writing anything: WAL names only. */
export const isWalName = (n) => parseWalName(n) !== null;

/** Compose project and database of the installation a stack.env belongs to (REMYRAL_PROJECT / REMYRAL_DB_NAME). */
export function installationNames(stackEnvText, env) {
  const text = String(stackEnvText ?? '');
  const get = (k) => new RegExp(`^${k}=([A-Za-z0-9_.-]{1,63})\\s*$`, 'm').exec(text)?.[1];
  const pre = preRenameNames(text, env); // p17-prerename-backups
  return {
    project: get('REMYRAL_PROJECT') ?? pre?.project ?? `remyral-${env}`, // p17-prerename-backups: drop `pre?.project ??`
    db: get('REMYRAL_DB_NAME') ?? pre?.db ?? 'remyral', // p17-prerename-backups: drop `pre?.db ??`
  };
}
