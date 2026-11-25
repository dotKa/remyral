// E2E only: prepares a throw-away database + Redis logical DB and then starts the real master (dist build).
//
// Inputs (set by playwright.config.ts, never printed):
//   DATABASE_URL         the e2e database (dropped and recreated here, e.g. .../remyral_e2e_web)
//   E2E_ADMIN_DB_URL     maintenance connection used for DROP/CREATE DATABASE (the `postgres` database)
//   REDIS_URL            a dedicated Redis logical DB (flushed here so rate-limit counters start at zero)
// The master then runs unmodified: `apps/master/dist/main.js` with this process's environment.
import { fileURLToPath } from 'node:url';

const masterDist = new URL('../../master/dist/', import.meta.url);
const { createPool } = await import(new URL('db/pool.js', masterDist).href);
const { migrate } = await import(new URL('db/migrate.js', masterDist).href);
const { createRedis } = await import(new URL('redis.js', masterDist).href);

const dbUrl = new URL(process.env.DATABASE_URL ?? '');
const dbName = dbUrl.pathname.slice(1);
if (!/^remyral_e2e_[a-z0-9_]+$/.test(dbName)) {
  throw new Error('refusing to recreate a database whose name does not start with remyral_e2e_');
}

const admin = createPool({ connectionString: process.env.E2E_ADMIN_DB_URL, max: 1 });
try {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
} finally {
  await admin.end();
}

const pool = createPool({ connectionString: dbUrl.toString(), max: 2 });
try {
  await migrate(pool);
} finally {
  await pool.end();
}

const redisUrl = new URL(process.env.REDIS_URL ?? '');
if (redisUrl.pathname === '' || redisUrl.pathname === '/' || redisUrl.pathname === '/0') {
  throw new Error('refusing to flush Redis DB 0; use a dedicated logical DB for e2e');
}
const redis = createRedis(redisUrl.toString(), 'remyral-e2e-prepare');
await redis.connect();
await redis.flushdb();
redis.disconnect();

process.stdout.write(
  `e2e master: database ${dbName} migrated, starting ${fileURLToPath(masterDist)}main.js\n`,
);
await import(new URL('main.js', masterDist).href);
