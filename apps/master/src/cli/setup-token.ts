import { parseArgs } from 'node:util';
import { SetupError, SetupService } from '../setup/service.js';
import { AdminError } from './admin.js';
import { runAdminCli } from './run-cli.js';

/**
 * `remyral-master setup:token [--ttl-hours 24]` (p16-selfhost-onboarding §3): a one-time token for creating the first
 * owner in the browser (`/setup`). Prints ONLY the token on stdout (remyral-ctl reads it and shows it once); refuses
 * with exit 3 once any account exists. A new token withdraws an unused one.
 */
function ttlMs(): number {
  try {
    const { values } = parseArgs({
      options: { 'ttl-hours': { type: 'string', default: '24' } },
      strict: true,
      allowPositionals: false,
    });
    const h = Number(values['ttl-hours']);
    if (!Number.isInteger(h) || h < 1 || h > 168) throw new AdminError('--ttl-hours must be 1..168');
    return h * 60 * 60_000;
  } catch (err) {
    if (err instanceof AdminError) throw err;
    throw new AdminError('usage: setup:token [--ttl-hours 1..168]');
  }
}

await runAdminCli(async (deps) => {
  const ttl = ttlMs();
  try {
    const { token, expiresAt } = await new SetupService({ pool: deps.pool, audit: deps.audit }).issue({
      ttlMs: ttl,
    });
    process.stdout.write(`${token}\n`);
    process.stderr.write(`setup token valid until ${expiresAt.toISOString()} (single use)\n`);
  } catch (err) {
    if (err instanceof SetupError && err.code === 'setup_done') {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
});
