import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { ConfigError, loadConfig } from '../config.js';

/** `pnpm --filter @remyral/master migrate` — applies pending forward-only migrations. */
async function run(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 1,
    applicationName: 'remyral-migrate',
  });
  try {
    const result = await migrate(pool, { log: (m) => void process.stdout.write(`${m}\n`) });
    process.stdout.write(
      `migrations: ${String(result.applied.length)} applied, ${String(result.alreadyApplied.length)} already applied\n`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((err: unknown) => {
  if (err instanceof ConfigError) process.stderr.write(`${err.message}\n`);
  else process.stderr.write(`migrate failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
