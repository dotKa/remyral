import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a parameterised query: a pool or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'remyral-master',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // An idle client erroring (e.g. Postgres restart) must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  // The same for a client that is checked out but between queries (a transaction waiting on other work, the
  // dispatcher holding its advisory-lock connection): without a listener pg emits an unhandled 'error' and the
  // master crashes on a connection loss (p4-chaos finding). The next query on it rejects; the caller's
  // error path rolls back and releases it, and the pool replaces the broken connection.
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  return pool;
}

/** Runs `fn` inside a transaction on a dedicated client; rolls back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
