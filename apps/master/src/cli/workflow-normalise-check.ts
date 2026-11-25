import { createPool } from '../db/pool.js';
import { ConfigError, loadConfig } from '../config.js';
import { checkStoredDefinitions, reportLines } from '../workflows/v2/normalise-check.js';

/**
 * `pnpm --filter @remyral/master workflow:normalise-check` (p14-workflow-engine §5.7): read-only dry run — every stored
 * workflow definition normalises to a valid v2 document and converts back unchanged, plus what switching
 * WORKFLOW_ENGINE_V2_FOR_V1 on changes (version-1 workflows whose new runs move to engine 2, open runs per engine —
 * open engine-1 runs finish on engine 1). Exit 1 on any failure.
 */
async function run(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 1,
    applicationName: 'remyral-wf-normalise',
  });
  try {
    const r = await checkStoredDefinitions(pool);
    for (const line of reportLines(r)) process.stdout.write(`${line}\n`);
    if (r.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run().catch((err: unknown) => {
  if (err instanceof ConfigError) process.stderr.write(`${err.message}\n`);
  else
    process.stderr.write(`normalise check failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
