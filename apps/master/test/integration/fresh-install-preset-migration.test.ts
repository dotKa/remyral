import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * Migration 0221 (oss-sec3): a fresh install starts on the Dengeli security preset; the migration never changes the
 * stored policy of an installation that has users — the 0118 seed included — and a preset the owner chose stays as chosen.
 */
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const before = mkdtempSync(join(tmpdir(), 'remyral-mig-'));
for (const f of readdirSync(MIGRATIONS))
  if (f.endsWith('.sql') && f < '0221') copyFileSync(join(MIGRATIONS, f), join(before, f));

const policy = async (db: TestDatabase): Promise<{ document: unknown; version: number } | undefined> =>
  (
    await db.pool.query<{ document: unknown; version: number }>(
      'SELECT document, version FROM security_policy WHERE id = 1',
    )
  ).rows[0];
const addUser = async (db: TestDatabase): Promise<string> =>
  (
    await db.pool.query<{ id: string }>(
      `INSERT INTO users (username, role, password_hash) VALUES ('alex', 'owner', '$scrypt$test') RETURNING id::text AS id`,
    )
  ).rows[0]?.id ?? '';

describeIntegration('migration 0221 Dengeli on a fresh install', () => {
  let fresh: TestDatabase;
  let existing: TestDatabase;
  let chosen: TestDatabase;
  let savedNoUser: TestDatabase;
  let existingBefore: { document: unknown; version: number } | undefined;
  beforeAll(async () => {
    fresh = await createTestDatabase();
    existing = await createTestDatabase({ migrated: false });
    chosen = await createTestDatabase({ migrated: false });
    savedNoUser = await createTestDatabase({ migrated: false });
    for (const db of [existing, chosen, savedNoUser]) await migrate(db.pool, { dir: before });
    for (const db of [existing, chosen]) await addUser(db);
    existingBefore = await policy(existing);
    // The owner explicitly chose Serbest again in the console (a new version by a person).
    const owner = (await chosen.pool.query<{ id: string }>('SELECT id::text AS id FROM users')).rows[0]?.id;
    await chosen.pool.query(
      `UPDATE security_policy SET document = '{"preset":"serbest","stepUp":{"windowMinutes":60}}',
              version = version + 1, updated_by = $1, updated_at = now() WHERE id = 1`,
      [owner],
    );
    await chosen.pool.query(
      `INSERT INTO security_policy_versions (version, document, created_by, created_at, via)
       SELECT version, document, updated_by, now(), 'console' FROM security_policy WHERE id = 1`,
    );
    // A policy saved through the console whose user was later deleted (updated_by SET NULL): still a person's choice.
    await savedNoUser.pool.query(
      `INSERT INTO security_policy_versions (version, document, created_at, via)
       SELECT version + 1, document, now(), 'chat' FROM security_policy WHERE id = 1`,
    );
    await savedNoUser.pool.query('UPDATE security_policy SET version = version + 1 WHERE id = 1');
    for (const db of [existing, chosen, savedNoUser]) await migrate(db.pool);
  });
  afterAll(async () => {
    for (const db of [fresh, existing, chosen, savedNoUser]) await db.drop();
    rmSync(before, { recursive: true, force: true });
  });

  it('a fresh install (no user, policy never saved) gets Dengeli as a new migration version', async () => {
    expect((await policy(fresh))?.document).toEqual({ preset: 'dengeli' });
    const v = await fresh.pool.query<{ via: string; document: unknown; audited_at: Date | null }>(
      'SELECT via, document, audited_at FROM security_policy_versions ORDER BY version DESC LIMIT 1',
    );
    expect(v.rows[0]).toMatchObject({ via: 'migration', document: { preset: 'dengeli' }, audited_at: null });
  });

  it('an install with a user keeps its stored policy (the 0118 seed) exactly as it was', async () => {
    const after = await policy(existing);
    expect(after).toEqual(existingBefore);
    expect(after?.document).toMatchObject({ preset: 'serbest' });
  });

  it('a preset the owner chose stays as chosen', async () => {
    expect((await policy(chosen))?.document).toEqual({ preset: 'serbest', stepUp: { windowMinutes: 60 } });
    expect((await policy(savedNoUser))?.document).toMatchObject({ preset: 'serbest' });
  });
});
