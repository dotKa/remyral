import { AuditLog } from '../audit/audit.js';
import { ConfigError, loadConfig } from '../config.js';
import { pendingMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { keyFileSpecs, publicOriginOf } from '../ops-safety/config.js';
import { ExpiryService } from '../ops-safety/expiry.js';
import { readServedCertificate } from '../ops-safety/tls.js';

/**
 * `remyral-master secrets:rotated <item> [--at <ISO date>] [--note <text>]` (p16-ops-safety §1): records on the host
 * that an item of Ayarlar → Operasyon güvenliği → Anahtarlar ve süreler was rotated after its runbook (e.g. after
 * replacing `lease-signing.pem`, or creating a new backup age identity). `remyral-master secrets:rotated --list` prints
 * the items with their state. Dates only — the command never reads a key. Audited as `secret.rotation.recorded`
 * (actor system:cli).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function run(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 1,
    applicationName: 'remyral-secrets-cli',
  });
  try {
    if ((await pendingMigrations(pool)).length > 0) {
      throw new Error('database has pending migrations; run `remyral-master migrate` first');
    }
    const expiry = new ExpiryService({
      pool,
      audit: new AuditLog(pool),
      clock: () => new Date(),
      notifications: () => null,
      publicOrigin: publicOriginOf(config),
      readCertificate: (origin) => readServedCertificate(origin),
      cloudflareVerify: () => Promise.resolve(null),
      keyFiles: keyFileSpecs(config),
    });
    if (process.argv.includes('--list')) {
      const { items } = await expiry.list();
      for (const i of items) {
        const due = i.dueAt === null ? '-' : `${i.dueAt.slice(0, 10)} (${String(i.daysLeft)} d)`;
        process.stdout.write(
          `${i.id.padEnd(36)} ${i.state.padEnd(8)} ${due}${i.stampable ? '' : '  (not stampable)'}\n`,
        );
      }
      return;
    }
    const item = process.argv[2];
    if (item === undefined || item.startsWith('--')) {
      throw new Error(
        'usage: remyral-master secrets:rotated <item> [--at <ISO date>] [--note <text>] | --list',
      );
    }
    const at = arg('--at');
    const note = arg('--note');
    const out = await expiry.recordRotation({ userId: null, source: 'cli' }, item, {
      ...(at === undefined ? {} : { rotatedAt: new Date(at) }),
      ...(note === undefined ? {} : { note }),
    });
    process.stdout.write(`recorded: ${out.item} rotated at ${out.rotatedAt}\n`);
  } finally {
    await pool.end();
  }
}

run().catch((err: unknown) => {
  if (err instanceof ConfigError) process.stderr.write(`${err.message}\n`);
  else if (err instanceof HttpError) process.stderr.write(`error: ${err.message}\n`);
  else process.stderr.write(`error: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
