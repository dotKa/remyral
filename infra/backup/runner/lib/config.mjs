// Runner configuration from the environment (p10-backup-restore §2). Everything has a default matching the
// compose service; paths are inside the container.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecipients } from './age.mjs';
import { assertEnv } from './naming.mjs';
import { parseRetention } from './retention.mjs';
import { parseEnvFile, parseOffsiteConfig } from './s3.mjs';
import { parseSchedule } from './schedule.mjs';

/** `on`/`true` → true, empty/`off`/`false` → false; anything else is a configuration error. */
export function parseOnOff(value, name) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (v === '' || v === 'off' || v === 'false') return false;
  if (v === 'on' || v === 'true') return true;
  throw new Error(`${name} must be on or off`);
}

/** Days a deleted blob stays in the backup mirror (default 35, 1…3650). */
export function parseKeepDays(value) {
  if (value === undefined || String(value).trim() === '') return 35;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650)
    throw new Error('BACKUP_BLOB_KEEP_DELETED_DAYS must be 1…3650');
  return n;
}

export function loadConfig(env = process.env) {
  const root = env.BACKUP_ROOT || '/backups';
  const source = env.BACKUP_SOURCE_DIR || '/source';
  const configDir = env.BACKUP_CONFIG_DIR || join(source, 'backup-config');
  const uid = Number(env.BACKUP_DRILL_UID || 70);
  const gid = Number(env.BACKUP_DRILL_GID || 70);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
    throw new Error('BACKUP_DRILL_UID/GID must be positive integers');
  }
  return {
    env: assertEnv(env.BACKUP_ENV || env.REMYRAL_ENV || 'prod'),
    root,
    statusDir: join(root, 'status'),
    source,
    /** Entries of `source` that go into the encrypted secrets archive (missing ones are skipped and reported). */
    secretEntries: ['stack.env', 'secrets', 'backup-config'],
    configDir,
    migrationsDir: env.BACKUP_MIGRATIONS_DIR || '/opt/remyral-backup/migrations',
    drillUser: { uid, gid },
    schedule: parseSchedule(env),
    retention: parseRetention(env),
    /**
     * p11-master-resilience: continuous WAL archiving (`PG_WAL_ARCHIVE=on` in stack.env → BACKUP_WAL_ARCHIVE). Postgres
     * writes segments into `walArchiveDir`; the daemon ships them and takes a daily physical base backup of
     * `pgdataDir` (the pgdata volume, mounted read-only).
     */
    walArchive: { enabled: parseOnOff(env.BACKUP_WAL_ARCHIVE, 'BACKUP_WAL_ARCHIVE') },
    walArchiveDir: env.BACKUP_WAL_ARCHIVE_DIR || '/wal-archive',
    pgdataDir: env.BACKUP_PGDATA_DIR || '/pgdata/18/docker',
    walShipIntervalMs: 30_000,
    /**
     * p17-object-storage: the master's local blob directory (the blobdata volume, mounted read-only). Mirrored into the
     * backup encrypted (and off-site); a blob the master deleted stays this many days (older dumps may name it).
     */
    blobDir: env.BACKUP_BLOB_DIR || '/blobs',
    blobKeepDeletedDays: parseKeepDays(env.BACKUP_BLOB_KEEP_DELETED_DAYS),
    pgEnv: {
      PGHOST: env.PGHOST || 'remyral-pg',
      PGPORT: env.PGPORT || '5432',
      PGUSER: env.PGUSER || 'remyral_backup',
      PGDATABASE: env.PGDATABASE || 'remyral',
      PGPASSWORD: env.PGPASSWORD || '',
      PGAPPNAME: 'remyral-backup',
      PGCONNECT_TIMEOUT: '10',
    },
  };
}

/** The owner's public keys, or `{ error }` when the file is missing or unusable. */
export function loadRecipients(cfg) {
  const file = join(cfg.configDir, 'recipients.txt');
  if (!existsSync(file)) return { recipients: [], error: `no ${file} (the owner's age public keys)` };
  try {
    return { recipients: parseRecipients(readFileSync(file, 'utf8')), error: null };
  } catch (err) {
    return { recipients: [], error: err instanceof Error ? err.message : String(err), fatal: true };
  }
}

/** Off-site target, null when `offsite.env` does not exist, or `{ error }` when it is invalid. */
export function loadOffsite(cfg) {
  const file = join(cfg.configDir, 'offsite.env');
  if (!existsSync(file)) return null;
  try {
    return parseOffsiteConfig(parseEnvFile(readFileSync(file, 'utf8')));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
