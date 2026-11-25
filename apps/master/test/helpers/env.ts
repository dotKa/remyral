import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe } from 'vitest';
import { createPool, type Pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { createRedis, type RedisClient } from '../../src/redis.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Explicit opt-out (e.g. CI runners without Docker). Never inferred from a failed connection. */
export const INTEGRATION_SKIPPED = process.env.REMYRAL_INTEGRATION === 'skip';
export const describeIntegration = INTEGRATION_SKIPPED ? describe.skip : describe;

function loadDevEnv(): void {
  const file = `${repoRoot}.env`;
  if ((!process.env.DATABASE_URL || !process.env.REDIS_URL) && existsSync(file)) process.loadEnvFile(file);
}

function requireEnv(name: 'DATABASE_URL' | 'REDIS_URL'): string {
  loadDevEnv();
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Integration tests need the local dev stack: run \`pnpm dev:keygen && pnpm dev:up\` ` +
        '(or set REMYRAL_INTEGRATION=skip to skip them explicitly).',
    );
  }
  return v;
}

export interface TestDatabase {
  readonly pool: Pool;
  readonly url: string;
  drop(): Promise<void>;
}

/** Creates a throw-away database (optionally migrated). Throws — never skips — if Postgres is unreachable. */
export async function createTestDatabase(
  opts: {
    migrated?: boolean;
    /** Another server (p4-chaos: a throw-away Postgres container). */ adminUrl?: string;
  } = {},
): Promise<TestDatabase> {
  const adminUrl = opts.adminUrl ?? requireEnv('DATABASE_URL');
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 3_000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Integration tests cannot reach Postgres (${(err as Error).message}). Start it with \`pnpm dev:up\`.`,
      { cause: err },
    );
  }
  const name = `remyral_test_${String(process.pid)}_${randomBytes(4).toString('hex')}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString(), max: 8, applicationName: 'remyral-test' });
  if (opts.migrated ?? true) await migrate(pool);
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Connected Redis client; throws if Redis is unreachable. Callers use a unique key prefix. */
export async function createTestRedis(): Promise<RedisClient> {
  const redis = createRedis(requireEnv('REDIS_URL'), 'remyral-test');
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    redis.disconnect();
    throw new Error(
      `Integration tests cannot reach Redis (${(err as Error).message}). Start it with \`pnpm dev:up\`.`,
      { cause: err },
    );
  }
  return redis;
}

export function uniquePrefix(): string {
  return `test:${randomBytes(6).toString('hex')}:`;
}

/**
 * REDIS_URL with another logical database: tests that flush Redis (FLUSHDB) use their own database so the
 * shared dev Redis (database 0: rate limits of other test runs) is never touched.
 */
export function redisUrlWithDb(db: number): string {
  const url = new URL(requireEnv('REDIS_URL'));
  url.pathname = `/${String(db)}`;
  return url.toString();
}
