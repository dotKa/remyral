import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * Migration 0220: a fresh install has no support address (the vendor address seeded by 0147 / 0149 is cleared); an
 * installation with users keeps its stored address (the migration never changes it).
 */
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const before = mkdtempSync(join(tmpdir(), 'remyral-mig-'));
for (const f of readdirSync(MIGRATIONS))
  if (f.endsWith('.sql') && f < '0220') copyFileSync(join(MIGRATIONS, f), join(before, f));

const email = async (db: TestDatabase): Promise<string | null | undefined> =>
  (await db.pool.query<{ email: string | null }>('SELECT email FROM support_settings WHERE id = 1')).rows[0]
    ?.email;
const addUser = (db: TestDatabase): Promise<unknown> =>
  db.pool.query(`INSERT INTO users (username, role, password_hash) VALUES ('alex', 'owner', '$scrypt$test')`);

describeIntegration('migration 0220 support address unset on a fresh install', () => {
  let fresh: TestDatabase;
  let existing: TestDatabase;
  let chosen: TestDatabase;
  beforeAll(async () => {
    fresh = await createTestDatabase();
    existing = await createTestDatabase({ migrated: false });
    chosen = await createTestDatabase({ migrated: false });
    for (const db of [existing, chosen]) {
      await migrate(db.pool, { dir: before });
      await addUser(db);
    }
    await chosen.pool.query("UPDATE support_settings SET email = 'ops@customer.example', updated_at = now()");
    for (const db of [existing, chosen]) await migrate(db.pool);
  });
  afterAll(async () => {
    for (const db of [fresh, existing, chosen]) await db.drop();
    rmSync(before, { recursive: true, force: true });
  });

  it('a fresh install has no support address; NULL is allowed, a malformed address is not', async () => {
    expect(await email(fresh)).toBeNull();
    await expect(fresh.pool.query("UPDATE support_settings SET email = 'not-an-address'")).rejects.toThrow();
    await fresh.pool.query("UPDATE support_settings SET email = 'help@example.com'");
    expect(await email(fresh)).toBe('help@example.com');
  });

  it('an installation with users keeps its stored address, whatever it is', async () => {
    expect(await email(existing)).toBe('info@remyral.com');
    expect(await email(chosen)).toBe('ops@customer.example');
  });
});
