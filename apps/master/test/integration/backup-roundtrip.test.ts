import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  dumpWithSnapshot,
  loadMigrationFiles,
  PsqlSession,
  SESSION_SETTINGS,
  sha256File,
  verifyRestored,
  type Inspection,
} from '../../../../infra/backup/runner/lib/pg.mjs';
import { spawnTool, type ToolOptions, type Tools } from '../../../../infra/backup/runner/lib/proc.mjs';
import { AuditLog, verifyChain } from '../../src/audit/audit.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * p10-backup-restore §10: a real round trip on the dev Postgres (infra/dev) — the runner's consistent dump
 * (exported snapshot + pg_dump --snapshot, custom format, zstd) of a migrated temporary database with a real audit
 * chain, pg_restore into a second temporary database, then the drill's checks: schema/migrations, exact row counts,
 * known entities, audit chain + head. Tampering with the restored copy is detected. The Postgres client tools run
 * inside the dev Postgres container (`docker exec`), so they match the server exactly (as in the backup image).
 */
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const PG_CONTAINER = process.env.REMYRAL_DEV_PG_CONTAINER ?? 'remyral-dev-postgres-1';

/** Runs the runner's tools inside the dev Postgres container; PG* values travel as env, never argv. */
function dockerTools(): Tools {
  const wrap = (cmd: string, args: readonly string[], opts: ToolOptions = {}) => {
    const env = opts.env ?? {};
    const envFlags = Object.keys(env).flatMap((k) => ['-e', k]);
    return spawnTool('docker', ['exec', '-i', ...envFlags, PG_CONTAINER, cmd, ...args], { ...opts, env });
  };
  return {
    spawn: wrap,
    run: (cmd, args, opts) => wrap(cmd, args, opts).done,
  };
}

function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
}

describeIntegration('backup round trip: consistent dump → restore → drill checks (integration)', () => {
  let source: TestDatabase;
  let restored: TestDatabase;
  let work: string;
  let dumpFile: string;
  let inspection: Inspection;
  const tools = dockerTools();

  beforeAll(async () => {
    source = await createTestDatabase();
    restored = await createTestDatabase({ migrated: false });
    work = mkdtempSync(join(tmpdir(), 'remyral-bk-it-'));
    dumpFile = join(work, 'db.dump');
    const audit = new AuditLog(source.pool);
    for (let i = 0; i < 40; i += 1) {
      await audit.record({
        actor: { type: 'user', id: `u${String(i % 3)}` },
        action: 'backup.test',
        target: `t-${String(i)}`,
        outcome: i % 7 === 0 ? 'failure' : 'success',
        ip: '203.0.113.9',
        userAgent: 'vitest',
        metadata: { i, nested: { z: [1, 'two', null], a: true } },
      });
    }
    await source.pool.query(
      "INSERT INTO projects (id, name, created_at) VALUES ('bk-alpha', 'Alpha', now()), ('bk-beta', 'Beta', now())",
    );
  });
  afterAll(async () => {
    await source.drop();
    await restored.drop();
    rmSync(work, { recursive: true, force: true });
  });

  it('dumps one exported snapshot and records counts, fingerprints and the audit head in it', async () => {
    const fd = openSync(dumpFile, 'w', 0o600);
    try {
      const r = await dumpWithSnapshot({ tools, env: pgEnv(source.url), outFd: fd });
      inspection = r.inspection;
      expect(r.snapshot).toMatch(/^[0-9A-F]+-[0-9A-F]+-\d+$/i);
      expect(r.pgDumpVersion).toMatch(/pg_dump \(PostgreSQL\) 18\./);
    } finally {
      closeSync(fd);
    }
    const files = loadMigrationFiles(MIGRATIONS);
    expect(inspection.schema).toEqual({ version: files.at(-1)?.version, count: files.length });
    expect(inspection.rowCounts.audit_events).toBe(40);
    expect(inspection.rowCounts.projects).toBeGreaterThanOrEqual(2);
    expect(Object.keys(inspection.rowCounts).length).toBeGreaterThan(100);
    expect(inspection.fingerprints.map((f) => f.table)).toEqual(
      expect.arrayContaining(['audit_events', 'projects']),
    );
    const chain = await verifyChain(source.pool);
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(inspection.auditHead).toEqual({ id: '40', hash: chain.headHash.toString('hex') });
    const { bytes } = await sha256File(dumpFile);
    expect(bytes).toBeGreaterThan(10_000);
  });

  async function restoredSession(): Promise<PsqlSession> {
    const s = PsqlSession.open(tools, { env: pgEnv(restored.url) });
    for (const q of SESSION_SETTINGS) await s.query(q);
    return s;
  }

  it('pg_restore into a fresh database passes every drill check', async () => {
    await spawnTool('docker', ['cp', dumpFile, `${PG_CONTAINER}:/tmp/remyral-bk-it.dump`]).done;
    try {
      await tools.run(
        'pg_restore',
        [
          '--exit-on-error',
          '--no-password',
          '--dbname',
          pgEnv(restored.url).PGDATABASE ?? '',
          '/tmp/remyral-bk-it.dump',
        ],
        {
          env: pgEnv(restored.url),
        },
      );
    } finally {
      await tools.run('rm', ['-f', '/tmp/remyral-bk-it.dump'], { allowFail: true });
    }
    const manifest = {
      schema: inspection.schema,
      tables: inspection.rowCounts,
      fingerprints: inspection.fingerprints,
      auditHead: inspection.auditHead,
    };
    const s = await restoredSession();
    try {
      const checks = await verifyRestored({
        queryJson: (sql) => s.queryJson(sql),
        manifest,
        migrations: loadMigrationFiles(MIGRATIONS),
      });
      expect(checks.map((c) => [c.name, c.ok])).toEqual([
        ['schema_version', true],
        ['migrations', true],
        ['row_counts', true],
        ['known_entities', true],
        ['audit_chain', true],
      ]);
      expect(checks.find((c) => c.name === 'audit_chain')?.detail).toBe(
        '40 events verified; head 40 = manifest',
      );
    } finally {
      await s.close();
    }
    // The master's own verifier agrees on the restored copy.
    expect((await verifyChain(restored.pool)).ok).toBe(true);
  });

  it('detects a lost row, an edited known entity and a broken audit chain', async () => {
    const admin = new pg.Client({ connectionString: restored.url });
    await admin.connect();
    try {
      const fp = inspection.fingerprints.find((f) => f.table === 'projects');
      await admin.query("DELETE FROM projects WHERE id = 'bk-alpha' AND id <> $1", [fp?.id ?? '']);
      await admin.query("UPDATE projects SET name = name || ' (edited)' WHERE id = $1", [fp?.id ?? '']);
      await admin.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await admin.query("UPDATE audit_events SET action = 'backup.tampered' WHERE id = 7");
    } finally {
      await admin.end();
    }
    const s = await restoredSession();
    try {
      const checks = await verifyRestored({
        queryJson: (sql) => s.queryJson(sql),
        manifest: {
          schema: inspection.schema,
          tables: inspection.rowCounts,
          fingerprints: inspection.fingerprints,
          auditHead: inspection.auditHead,
        },
        migrations: [],
      });
      const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
      expect(byName.row_counts?.ok).toBe(false);
      const n = inspection.rowCounts.projects ?? 0;
      expect(byName.row_counts?.detail).toContain(`projects ${String(n - 1)}≠${String(n)}`);
      expect(byName.known_entities?.ok).toBe(false);
      expect(byName.audit_chain).toMatchObject({ ok: false, detail: 'broken at 7 (hash_mismatch)' });
      // Applied migrations unknown to "this release" (an empty file list) fail the migration check.
      expect(byName.migrations?.ok).toBe(false);
    } finally {
      await s.close();
    }
  });
});
