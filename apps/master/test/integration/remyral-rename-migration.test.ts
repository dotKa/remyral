import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * p17-remyral-rebrand: migration 0149 — the support address moves to info@remyral.com only while it is still the old
 * default, releases stored before are marked legacy-signed, Remyral kit names and reserved MCP ids.
 */
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const before = mkdtempSync(join(tmpdir(), 'remyral-mig-'));
for (const f of readdirSync(MIGRATIONS))
  if (f.endsWith('.sql') && f < '0149') copyFileSync(join(MIGRATIONS, f), join(before, f));
const through = mkdtempSync(join(tmpdir(), 'remyral-mig-'));
for (const f of readdirSync(MIGRATIONS))
  if (f.endsWith('.sql') && f < '0220') copyFileSync(join(MIGRATIONS, f), join(through, f));

describeIntegration('migration 0149 remyral rename', () => {
  let kept: TestDatabase;
  let moved: TestDatabase;
  beforeAll(async () => {
    kept = await createTestDatabase({ migrated: false });
    moved = await createTestDatabase({ migrated: false });
    for (const db of [kept, moved]) await migrate(db.pool, { dir: before });
    await kept.pool.query("UPDATE support_settings SET email = 'ops@customer.example' WHERE id = 1");
    await moved.pool.query(
      `INSERT INTO worker_releases (version, channel, manifest, signature, key_id, sha256, size_bytes, protocol_versions,
                                    min_node, artifact, built_at, uploaded_at)
       VALUES ('1.0.77', 'stable', '\\x7b7d', '{}', '0123456789abcdef', repeat('a', 64), 1, '["1.0"]', '24.11.0', '\\x00',
               now(), now())`,
    );
    // Up to 0219: 0220 clears the address on an install without users (a fresh one), which these test databases are.
    for (const db of [kept, moved]) await migrate(db.pool, { dir: through });
  });
  afterAll(async () => {
    await kept.drop();
    await moved.drop();
    rmSync(before, { recursive: true, force: true });
    rmSync(through, { recursive: true, force: true });
  });

  it('replaces the old default support address and keeps an address the owner chose', async () => {
    const email = async (db: TestDatabase) =>
      (await db.pool.query<{ email: string }>('SELECT email FROM support_settings WHERE id = 1')).rows[0]
        ?.email;
    expect(await email(moved)).toBe('info@remyral.com');
    expect(await email(kept)).toBe('ops@customer.example');
  });

  it('marks releases stored before the rename as legacy-signed; new rows default to the current domain', async () => {
    const r = await moved.pool.query<{ signing_domain: string }>(
      "SELECT signing_domain FROM worker_releases WHERE version = '1.0.77'",
    );
    expect(r.rows[0]?.signing_domain).toBe('legacy');
    const def = await moved.pool.query<{ d: string }>(
      `SELECT column_default AS d FROM information_schema.columns
        WHERE table_name = 'worker_releases' AND column_name = 'signing_domain'`,
    );
    expect(def.rows[0]?.d).toContain('current');
  });

  it('accepts remyral-worker kit names (and the stored remana-worker ones) and reserves remyral MCP ids', async () => {
    const kit = await moved.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'worker_release_installer_kits_file_name_check'`,
    );
    expect(kit.rows[0]?.def).toContain('(remyral|remana)-worker-');
    const mcp = await moved.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'mcp_servers_id_check'`,
    );
    expect(mcp.rows[0]?.def).toContain('(remyral|remana|subtask)');
  });
});
