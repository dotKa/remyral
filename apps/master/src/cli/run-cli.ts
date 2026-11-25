import { AuditLog } from '../audit/audit.js';
import { ConfigError } from '../config.js';
import { pendingMigrations } from '../db/migrate.js';
import { createPool, type Pool } from '../db/pool.js';
import { AdminError, type AdminDeps } from './admin.js';
import { NotATtyError, PromptAbortedError } from './tty-prompt.js';

/** Runs an admin CLI against DATABASE_URL with uniform, secret-free error reporting. */
export async function runAdminCli(main: (deps: AdminDeps) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  let pool: Pool | undefined;
  try {
    if (!databaseUrl) throw new ConfigError(['DATABASE_URL: missing']);
    pool = createPool({ connectionString: databaseUrl, max: 2, applicationName: 'remyral-admin-cli' });
    const pending = await pendingMigrations(pool);
    if (pending.length > 0) {
      throw new AdminError(
        'database has pending migrations; run `pnpm --filter @remyral/master migrate` first',
      );
    }
    await main({ pool, audit: new AuditLog(pool) });
  } catch (err) {
    const known =
      err instanceof AdminError ||
      err instanceof ConfigError ||
      err instanceof NotATtyError ||
      err instanceof PromptAbortedError;
    process.stderr.write(`error: ${known ? err.message : 'unexpected failure'}\n`);
    if (!known && err instanceof Error) process.stderr.write(`(${err.name})\n`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
