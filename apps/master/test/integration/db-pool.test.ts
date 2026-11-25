import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, type Pool } from '../../src/db/pool.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * p4-chaos finding: a checked-out client whose backend dies between queries (Postgres restart, failover,
 * pg_terminate_backend) emitted an unhandled 'error' event — an uncaught exception that would crash the
 * master. Vitest reports such an exception as a failed run, so this test fails without the fix.
 */
describeIntegration('db pool: connection loss of a checked-out client (integration)', () => {
  let db: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase({ migrated: false });
    pool = createPool({ connectionString: db.url, max: 2, applicationName: 'remyral-pool-test' });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('a terminated backend of a held client neither crashes the process nor poisons the pool', async () => {
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]?.pid;
    // Held between queries (like the dispatcher's advisory-lock connection) while the backend is killed.
    await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await expect
      .poll(async () =>
        client.query('SELECT 1').then(
          () => 'alive',
          () => 'dead',
        ),
      )
      .toBe('dead');
    client.release(new Error('connection lost'));
    // The pool serves fresh connections.
    expect((await pool.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);
  });
});
