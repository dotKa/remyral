import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, verifyChain } from '../../src/audit/audit.js';
import { withTransaction } from '../../src/db/pool.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

describeIntegration('audit_events (integration)', () => {
  let db: TestDatabase;
  let audit: AuditLog;

  beforeAll(async () => {
    db = await createTestDatabase();
    audit = new AuditLog(db.pool);
  });
  afterAll(async () => {
    await db.drop();
  });

  // The table is append-only, so each test starts from a freshly migrated schema.
  beforeEach(async () => {
    await db.pool.query('DROP TABLE audit_events CASCADE; DROP FUNCTION audit_events_reject_change();');
    await db.pool.query("DELETE FROM schema_migrations WHERE version = '0001'");
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(db.pool);
  });

  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await audit.record({
        actor: { type: 'user', id: `u${String(i)}` },
        action: 'test.event',
        target: `t${String(i)}`,
        outcome: i % 2 ? 'failure' : 'success',
        ip: '203.0.113.7',
        userAgent: 'vitest',
        metadata: { i, nested: { ok: true, list: [1, 'two', null] }, unicode: 'çğış ✓' },
      });
    }
  }

  it('builds a verifiable hash chain', async () => {
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true, checked: 0 });
    await seed(5);
    const result = await verifyChain(db.pool, 2); // small batches exercise pagination
    expect(result).toMatchObject({ ok: true, checked: 5 });
    const { rows } = await db.pool.query<{ prev_hash: Buffer; hash: Buffer }>(
      'SELECT prev_hash, hash FROM audit_events ORDER BY id',
    );
    expect(rows[0]?.prev_hash.equals(Buffer.alloc(32))).toBe(true);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]?.prev_hash.equals(rows[i - 1]?.hash ?? Buffer.alloc(0))).toBe(true);
  });

  it('keeps the chain linear under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        audit.record({
          actor: { type: 'system' },
          action: 'test.concurrent',
          outcome: 'success',
          metadata: { i },
        }),
      ),
    );
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true, checked: 40 });
  });

  it('rejects UPDATE, DELETE and TRUNCATE at the database level', async () => {
    await seed(2);
    await expect(db.pool.query("UPDATE audit_events SET outcome = 'success'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await expect(db.pool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true, checked: 2 });
  });

  it('detects an edited row', async () => {
    await seed(4);
    await db.pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
    await db.pool.query(
      `UPDATE audit_events SET metadata = '{"i":99}' WHERE id = (SELECT min(id) + 1 FROM audit_events)`,
    );
    const r = await verifyChain(db.pool);
    expect(r).toMatchObject({ ok: false, checked: 1, reason: 'hash_mismatch' });
  });

  it('detects a deleted row', async () => {
    await seed(4);
    await db.pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
    await db.pool.query('DELETE FROM audit_events WHERE id = (SELECT min(id) + 1 FROM audit_events)');
    expect(await verifyChain(db.pool)).toMatchObject({ ok: false, checked: 1, reason: 'prev_hash_mismatch' });
  });

  it('joins the caller transaction (rolled back together)', async () => {
    await seed(1);
    await expect(
      withTransaction(db.pool, async (tx) => {
        await audit.record({ actor: { type: 'system' }, action: 'test.rollback', outcome: 'success' }, tx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const { rows } = await db.pool.query("SELECT 1 FROM audit_events WHERE action = 'test.rollback'");
    expect(rows).toHaveLength(0);
    await seed(1);
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true, checked: 2 });
  });

  it('stores redacted metadata only', async () => {
    await audit.record({
      actor: { type: 'anonymous' },
      action: 'auth.login.password',
      outcome: 'failure',
      metadata: { username: 'alex', password: 'CANARY-pw-123', reason: 'bad_credentials' },
    });
    const { rows } = await db.pool.query<{ metadata: unknown }>('SELECT metadata FROM audit_events');
    expect(rows[0]?.metadata).toEqual({
      username: 'alex',
      password: '[REDACTED]',
      reason: 'bad_credentials',
    });
  });

  it('rejects malformed actions', async () => {
    await expect(
      audit.record({ actor: { type: 'system' }, action: 'Bad Action', outcome: 'success' }),
    ).rejects.toThrow(/invalid audit action/);
  });
});
