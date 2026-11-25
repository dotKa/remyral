// Postgres access of the backup runner (p10-backup-restore §3, §5) through psql / pg_dump — no npm driver, so the
// image needs nothing beyond the server image's own client tools. Connection settings come from the PG*
// environment (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD), never from argv.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAuditChain } from './audit-chain.mjs';
import { tail } from './proc.mjs';

/** Session settings that make `row::text` (fingerprints) and timestamps independent of server defaults. */
export const SESSION_SETTINGS = [
  "SET TimeZone = 'UTC'",
  "SET DateStyle = 'ISO, YMD'",
  "SET IntervalStyle = 'postgres'",
  'SET extra_float_digits = 1',
  "SET bytea_output = 'hex'",
  'SET statement_timeout = 0',
];

/** Known entities whose newest row (by `id`) is fingerprinted in the manifest and looked up after a restore. */
export const FINGERPRINT_TABLES = [
  'users',
  'projects',
  'workers',
  'jobs',
  'audit_events',
  'chat_threads',
  'output_items',
];

const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A long-lived `psql` process driven over stdin. Each statement is followed by an `\echo` marker, so the result
 * is everything printed before the marker. ON_ERROR_STOP makes psql exit on the first error; the pending
 * query then rejects with psql's message.
 */
export class PsqlSession {
  #proc;
  #buf = '';
  #waiters = [];
  #seq = 0;
  #closed = null;
  #stderr = '';

  static open(tools, { env = {}, args = [], uid, gid } = {}) {
    return new PsqlSession(tools, env, args, { uid, gid });
  }

  constructor(tools, env, args, user) {
    const { child, done } = tools.spawn(
      'psql',
      ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password', ...args],
      {
        stdin: 'pipe',
        env,
        ...(user.uid === undefined ? {} : { uid: user.uid, gid: user.gid }),
        allowFail: true,
        onStdout: (d) => {
          this.#buf += d.toString('utf8');
          this.#drain();
        },
      },
    );
    this.#proc = child;
    child.stderr.on('data', (d) => {
      this.#stderr = (this.#stderr + d.toString('utf8')).slice(-4000);
    });
    this.#closed = done.then(
      (r) => r,
      (e) => ({ code: 1, stderr: String(e) }),
    );
    void this.#closed.then((r) => {
      const err = new Error(`psql ended (${String(r.code)}): ${tail(this.#stderr || r.stderr || '')}`);
      for (const w of this.#waiters.splice(0)) w.reject(err);
    });
  }

  #drain() {
    for (;;) {
      const w = this.#waiters[0];
      if (!w) return;
      const idx = this.#buf.indexOf(`${w.marker}\n`);
      if (idx < 0) return;
      const out = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + w.marker.length + 1);
      this.#waiters.shift();
      w.resolve(out.replace(/\n$/, ''));
    }
  }

  /** Runs one statement; resolves its unaligned, tuples-only output (trailing newline removed). */
  query(sql) {
    this.#seq += 1;
    const marker = `__remyral_backup_${String(this.#seq)}_${String(process.pid)}__`;
    return new Promise((resolve, reject) => {
      this.#waiters.push({ marker, resolve, reject });
      this.#proc.stdin.write(`${sql};\n\\echo ${marker}\n`);
    });
  }

  /** Runs a statement that yields exactly one JSON value (or nothing → null). */
  async queryJson(sql) {
    const out = (await this.query(sql)).trim();
    return out === '' ? null : JSON.parse(out);
  }

  async close() {
    if (!this.#proc.stdin.destroyed) this.#proc.stdin.end('\\q\n');
    return this.#closed;
  }
}

/** Reads what a manifest records about a database (call inside the snapshot transaction for a backup). */
export async function inspectDatabase(queryJson) {
  const serverVersion = await queryJson("SELECT to_json(current_setting('server_version'))");
  const hasMigrations = await queryJson(
    "SELECT to_json(to_regclass('public.schema_migrations') IS NOT NULL)",
  );
  const schema = hasMigrations
    ? await queryJson(
        "SELECT json_build_object('version', coalesce(max(version), ''), 'count', count(*)) FROM schema_migrations",
      )
    : { version: '', count: 0 };
  const tables = (
    await queryJson(
      "SELECT coalesce(json_agg(tablename::text ORDER BY tablename), '[]'::json) FROM pg_tables WHERE schemaname = 'public'",
    )
  ).filter((t) => TABLE_RE.test(t));
  const counts =
    tables.length === 0
      ? {}
      : await queryJson(
          `SELECT json_object_agg(t, n ORDER BY t) FROM (${tables
            .map((t) => `SELECT '${t}'::text AS t, count(*)::bigint AS n FROM public."${t}"`)
            .join(' UNION ALL ')}) s`,
        );
  const rowCounts = {};
  for (const t of tables) rowCounts[t] = Number(counts[t]);
  const withId = new Set(
    (await queryJson(
      `SELECT coalesce(json_agg(table_name::text), '[]'::json) FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'id'
          AND table_name IN (${FINGERPRINT_TABLES.map((t) => `'${t}'`).join(', ')})`,
    )) ?? [],
  );
  const fingerprints = [];
  for (const t of FINGERPRINT_TABLES) {
    if (!withId.has(t)) continue;
    const fp = await queryJson(
      `SELECT json_build_object('table', '${t}', 'id', x.id::text,
              'sha256', encode(sha256(convert_to(x::text, 'UTF8')), 'hex'))
         FROM public."${t}" x ORDER BY x.id DESC LIMIT 1`,
    );
    if (fp) fingerprints.push(fp);
  }
  const auditHead = tables.includes('audit_events')
    ? await queryJson(
        "SELECT json_build_object('id', id::text, 'hash', encode(hash, 'hex')) FROM audit_events ORDER BY id DESC LIMIT 1",
      )
    : null;
  return { serverVersion, schema, rowCounts, fingerprints, auditHead };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (d) => {
        hash.update(d);
        bytes += d.length;
      })
      .on('error', reject)
      .on('end', resolve);
  });
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Consistent dump: one REPEATABLE READ READ ONLY transaction exports its snapshot, the manifest data is read in it,
 * and `pg_dump --snapshot` dumps exactly that snapshot into `outFd` (custom format, zstd).
 */
export async function dumpWithSnapshot({ tools, env, outFd }) {
  const session = PsqlSession.open(tools, { env });
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const s of SESSION_SETTINGS) await session.query(s);
    const snapshot = (await session.query('SELECT pg_export_snapshot()')).trim();
    if (!/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i.test(snapshot)) throw new Error('could not export a snapshot');
    const inspection = await inspectDatabase((sql) => session.queryJson(sql));
    const version = (await tools.run('pg_dump', ['--version'], { env })).stdout.trim();
    await tools.run(
      'pg_dump',
      [
        '--format=custom',
        '--compress=zstd',
        `--snapshot=${snapshot}`,
        '--no-password',
        '--quote-all-identifiers',
      ],
      { env, stdout: outFd },
    );
    await session.query('COMMIT');
    return { snapshot, inspection, pgDumpVersion: version };
  } finally {
    await session.close();
  }
}

/** `[{ version, name, checksum }]` of a release's migration files (same checksum as apps/master/src/db/migrate.ts). */
export function loadMigrationFiles(dir) {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f);
    if (!m) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    out.push({ version: m[1], name: m[2], checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/** Applied migrations vs the release's files: unknown or edited ones fail; not-yet-applied ones are reported. */
export function compareMigrations(applied, files) {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const unknown = [];
  const mismatched = [];
  for (const a of applied) {
    const f = byVersion.get(a.version);
    if (!f) unknown.push(a.version);
    else if (f.checksum !== a.checksum) mismatched.push(a.version);
  }
  const appliedSet = new Set(applied.map((a) => a.version));
  const pending = files.filter((f) => !appliedSet.has(f.version)).map((f) => f.version);
  return { ok: unknown.length === 0 && mismatched.length === 0, unknown, mismatched, pending };
}

const list = (xs, max = 8) =>
  xs.length > max ? `${xs.slice(0, max).join(', ')}, … (+${String(xs.length - max)})` : xs.join(', ');

/**
 * Drill checks on a restored database against its manifest. `migrations`: the release's files (or null to skip).
 * The caller's session must have applied SESSION_SETTINGS (fingerprints depend on them). Returns
 * `[{ name, ok, detail }]`.
 */
export async function verifyRestored({ queryJson, manifest, migrations }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: String(detail).slice(0, 500) });
  const now = await inspectDatabase(queryJson);

  add(
    'schema_version',
    now.schema.version === manifest.schema.version && now.schema.count === manifest.schema.count,
    `restored ${now.schema.version || '∅'} (${String(now.schema.count)} applied), manifest ${manifest.schema.version || '∅'} (${String(manifest.schema.count)})`,
  );

  if (migrations) {
    const applied =
      (await queryJson(
        "SELECT coalesce(json_agg(json_build_object('version', version, 'checksum', checksum) ORDER BY version), '[]'::json) FROM schema_migrations",
      )) ?? [];
    const cmp = compareMigrations(applied, migrations);
    add(
      'migrations',
      cmp.ok,
      cmp.ok
        ? `${String(applied.length)} applied migrations match this release${cmp.pending.length ? `; pending: ${list(cmp.pending)}` : '; none pending'}`
        : `unknown: ${list(cmp.unknown) || '-'}; edited: ${list(cmp.mismatched) || '-'}`,
    );
  }

  const expected = manifest.tables;
  const missing = Object.keys(expected).filter((t) => !(t in now.rowCounts));
  const extra = Object.keys(now.rowCounts).filter((t) => !(t in expected));
  const differ = Object.keys(expected).filter((t) => t in now.rowCounts && now.rowCounts[t] !== expected[t]);
  const totalRows = Object.values(now.rowCounts).reduce((a, b) => a + b, 0);
  add(
    'row_counts',
    missing.length === 0 && extra.length === 0 && differ.length === 0,
    missing.length + extra.length + differ.length === 0
      ? `${String(Object.keys(expected).length)} tables, ${String(totalRows)} rows match`
      : `missing: ${list(missing) || '-'}; extra: ${list(extra) || '-'}; differ: ${list(differ.map((t) => `${t} ${String(now.rowCounts[t])}≠${String(expected[t])}`)) || '-'}`,
  );

  const fpWant = new Map(manifest.fingerprints.map((f) => [f.table, f]));
  const fpBad = [];
  for (const [table, want] of fpWant) {
    const got = now.fingerprints.find((f) => f.table === table);
    if (!got || got.id !== want.id || got.sha256 !== want.sha256) fpBad.push(table);
  }
  add(
    'known_entities',
    fpBad.length === 0,
    fpBad.length === 0
      ? `${String(fpWant.size)} entities identical (${[...fpWant.keys()].join(', ')})`
      : `differ: ${fpBad.join(', ')}`,
  );

  if (manifest.auditHead || now.rowCounts.audit_events !== undefined) {
    const chain = await verifyAuditChain(queryJson);
    const headOk =
      manifest.auditHead === null
        ? chain.ok && chain.checked === 0
        : chain.ok && chain.headId === manifest.auditHead.id && chain.headHash === manifest.auditHead.hash;
    add(
      'audit_chain',
      chain.ok && headOk,
      chain.ok
        ? `${String(chain.checked)} events verified; head ${chain.headId ?? '∅'}${headOk ? ' = manifest' : ` ≠ manifest ${manifest.auditHead?.id ?? '∅'}`}`
        : `broken at ${chain.brokenAtId} (${chain.reason})`,
    );
  }
  return checks;
}

export const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
