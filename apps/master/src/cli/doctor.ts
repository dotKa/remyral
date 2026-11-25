import { parseArgs } from 'node:util';
import { DEFAULT_RULES, Redactor, redactDeep } from '@remyral/observability';
import { type DoctorFinding, sortFindings, summarizeFindings } from '@remyral/protocol';
import { ConfigError } from '../config.js';
import { createPool } from '../db/pool.js';
import { runChecks } from '../doctor/checks.js';
import { createRedis } from '../redis.js';

/**
 * `remyral-master doctor [--light] [--json]` (p16-selfhost-onboarding §6, on top of p16-doctor): the master's doctor
 * checks from a shell on the host — `remyral-ctl doctor` runs it with `docker compose exec -T master`. Same checks and
 * redaction as Ayarlar → Tanılama, with what a shell has: the database, Redis and the master's environment. The
 * console-only sources (the cached status page, key expiry, cost brake, chat, backups, log store) are absent here, so
 * those checks say "unknown"; the full run with machine doctors stays in the console. Nothing is stored or sent.
 * Exit: 0 without errors, 1 with at least one error finding, 2 when the checks could not run.
 */
const SIGN: Readonly<Record<DoctorFinding['severity'], string>> = {
  ok: 'ok  ',
  info: 'info',
  warning: 'WARN',
  error: 'FAIL',
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { light: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new ConfigError(['DATABASE_URL / REDIS_URL: missing']);
  const pool = createPool({ connectionString: databaseUrl, max: 4, applicationName: 'remyral-doctor-cli' });
  const redis = createRedis(redisUrl, 'remyral-doctor-cli');
  try {
    const raw = await runChecks(
      {
        pool,
        redis,
        clock: () => new Date(),
        status: () => Promise.resolve(null),
        expiry: () => Promise.resolve(null),
        costBrake: () => Promise.resolve(null),
        chat: () => Promise.resolve(null),
        backups: () => Promise.resolve(null),
        logs: () => null,
      },
      values.light ? 'light' : 'full',
    );
    const findings = sortFindings(
      redactDeep(raw, new Redactor({ rules: DEFAULT_RULES }), { maxEntries: 400 }) as DoctorFinding[],
    );
    const summary = summarizeFindings(findings);
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
    } else {
      for (const f of findings) {
        process.stdout.write(`${SIGN[f.severity]} ${f.check}: ${f.message}\n`);
        if (f.fix !== undefined && f.severity !== 'ok') process.stdout.write(`     → ${f.fix}\n`);
      }
      process.stdout.write(
        `\n${String(summary.error)} error(s), ${String(summary.warning)} warning(s), ${String(summary.ok)} ok — the full run with machine doctors: Ayarlar → Tanılama\n`,
      );
    }
    return summary.error > 0 ? 1 : 0;
  } finally {
    redis.disconnect();
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof ConfigError ? err.message : err instanceof Error ? err.name : 'unexpected failure'}\n`,
    );
    process.exitCode = 2;
  },
);
