import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * p13-runtime-accounts: migration 0096 — runtime accounts, policies, usage per account, account-scoped limit episodes,
 * the account-switch pause cause, chat account settings, the new config cause and draft kind.
 */
describeIntegration('migration 0096 runtime accounts', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrated: true });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('creates the tables and keeps the existing rows as the default account', async () => {
    const t = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('runtime_accounts', 'runtime_account_defaults')
        ORDER BY table_name`,
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(['runtime_account_defaults', 'runtime_accounts']);
    const d = await db.pool.query<{ policy: unknown }>('SELECT policy FROM runtime_account_defaults');
    expect(d.rows[0]?.policy).toEqual({ strategy: 'balanced', order: [], skipPercent: 90 });
    const pk = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'runtime_usage_snapshots_pkey'`,
    );
    expect(pk.rows[0]?.def).toBe('PRIMARY KEY (worker_id, runtime, auth, account)');
    const cause = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'worker_config_versions_cause_check'`,
    );
    expect(cause.rows[0]?.def).toContain('accounts');
    expect(cause.rows[0]?.def).toContain('capacity');
    const kinds = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chat_drafts_kind_check'`,
    );
    expect(kinds.rows[0]?.def).toContain('account_action');
    expect(kinds.rows[0]?.def).toContain('memory_change');
  });
});
