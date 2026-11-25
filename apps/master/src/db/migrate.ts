import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Forward-only SQL migration runner (see docs/design/p1-master-auth.md "Migrations").
 *
 * - Migrations are plain `NNNN_name.sql` files in apps/master/migrations, applied in numeric order.
 * - A session-level Postgres advisory lock serialises concurrent runners (two master replicas starting).
 * - Each file runs in its own transaction together with its row in `schema_migrations`.
 * - Already-applied files are checksummed; an edited file aborts the run (forward-only: write a new file).
 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Arbitrary constant: `remyral` in ASCII, used as the advisory-lock key for migrations. */
export const MIGRATION_LOCK_KEY = 0x72656d616e61n;

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const file of files) {
    const m = FILE_PATTERN.exec(file);
    if (!m?.[1] || !m[2]) throw new MigrationError(`migration file name not NNNN_name.sql: ${file}`);
    const version = m[1];
    if (seen.has(version)) throw new MigrationError(`duplicate migration version ${version}`);
    seen.add(version);
    const sql = await readFile(`${dir.replace(/\/?$/, '/')}${file}`, 'utf8');
    migrations.push({ version, name: m[2], sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return migrations;
}

export async function migrate(
  pool: pg.Pool,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const log = opts.log ?? (() => undefined);
  const migrations = await loadMigrations(opts.dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    text PRIMARY KEY,
          name       text NOT NULL,
          checksum   text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      );
      const applied = new Map(rows.map((r) => [r.version, r]));
      const known = new Set(migrations.map((m) => m.version));
      for (const row of rows) {
        if (!known.has(row.version)) {
          throw new MigrationError(
            `database has migration ${row.version}_${row.name} that is not in this build (downgrade refused)`,
          );
        }
      }
      const done: string[] = [];
      const already: string[] = [];
      for (const m of migrations) {
        const prior = applied.get(m.version);
        if (prior) {
          if (prior.checksum !== m.checksum) {
            throw new MigrationError(
              `migration ${m.version}_${m.name} was modified after being applied (forward-only: add a new file)`,
            );
          }
          already.push(m.version);
          continue;
        }
        log(`applying migration ${m.version}_${m.name}`);
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
            m.version,
            m.name,
            m.checksum,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new MigrationError(`migration ${m.version}_${m.name} failed: ${(err as Error).message}`, {
            cause: err,
          });
        }
        done.push(m.version);
      }
      return { applied: done, alreadyApplied: already };
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** Returns versions present in the build but not yet applied (used by /readyz-style checks and tests). */
export async function pendingMigrations(pool: pg.Pool, dir?: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t");
  if (!exists.rows[0]?.t) return migrations.map((m) => m.version);
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  return migrations.filter((m) => !applied.has(m.version)).map((m) => m.version);
}
