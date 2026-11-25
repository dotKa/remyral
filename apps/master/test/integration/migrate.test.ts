import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { loadMigrations, migrate, MigrationError, pendingMigrations } from '../../src/db/migrate.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

describeIntegration('migration runner (integration)', () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase({ migrated: false });
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remyral-mig-'));
    await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies files in order once and records them', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int); INSERT INTO a VALUES (1);');
    expect(await pendingMigrations(db.pool, dir)).toEqual(['0001', '0002']);
    expect(await migrate(db.pool, { dir })).toEqual({ applied: ['0001', '0002'], alreadyApplied: [] });
    expect(await migrate(db.pool, { dir })).toEqual({ applied: [], alreadyApplied: ['0001', '0002'] });
    expect(await pendingMigrations(db.pool, dir)).toEqual([]);
    const { rows } = await db.pool.query('SELECT version, name FROM schema_migrations ORDER BY version');
    expect(rows).toEqual([
      { version: '0001', name: 'a' },
      { version: '0002', name: 'b' },
    ]);
  });

  it('serialises concurrent runners with the advisory lock', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int); SELECT pg_sleep(0.2);');
    const results = await Promise.all([migrate(db.pool, { dir }), migrate(db.pool, { dir })]);
    expect(results.map((r) => r.applied.length).sort()).toEqual([0, 1]);
  });

  it('rolls back a failing migration entirely', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int); SELECT * FROM missing_table;');
    await expect(migrate(db.pool, { dir })).rejects.toBeInstanceOf(MigrationError);
    const { rows } = await db.pool.query<{ t: string | null }>("SELECT to_regclass('a')::text AS t");
    expect(rows[0]?.t).toBeNull();
    expect(await pendingMigrations(db.pool, dir)).toEqual(['0001']);
  });

  it('refuses edited migrations (forward-only)', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await migrate(db.pool, { dir });
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id bigint);');
    await expect(migrate(db.pool, { dir })).rejects.toThrow(/modified after being applied/);
  });

  it('refuses to run when the database is ahead of the build', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, '0002_b.sql'), 'SELECT 1;');
    await migrate(db.pool, { dir });
    await rm(join(dir, '0002_b.sql'));
    await expect(migrate(db.pool, { dir })).rejects.toThrow(/downgrade refused/);
  });

  it('rejects badly named files', async () => {
    await writeFile(join(dir, '1_bad.sql'), 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(/NNNN_name/);
  });

  it('applies the shipped migrations cleanly', async () => {
    const result = await migrate(db.pool);
    expect(result.alreadyApplied).toEqual([]);
    expect(await pendingMigrations(db.pool)).toEqual([]);
  });
});
