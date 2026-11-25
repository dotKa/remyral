import { parseArgs } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { SecretBox } from '../auth/secret-box.js';
import { setBlobService } from '../blobs/registry.js';
import { BlobService } from '../blobs/store.js';
import { loadConfig } from '../config.js';
import { createReleaseServices, releaseServicesConfig } from '../releases/factory.js';
import { importRelease, parseRollout, readCapped, type Rollout } from '../releases/import.js';
import { WorkerHub } from '../workers/hub.js';
import { AdminError } from './admin.js';
import { runAdminCli } from './run-cli.js';

/**
 * `node dist/cli/release-import.js [--rollout stable[:100]] < release.json` (p6-release-import)
 *
 * Publishes a signed release.json from the control-plane host — the path `scripts/release/publish.mjs`
 * drives over the deploy SSH access (`docker compose … exec -T master node dist/cli/release-import.js`).
 * Same verification as the console upload (RELEASE_PUBLIC_KEYS, artifact, protocol, installer kits),
 * audited as the system actor `release-import`. Prints one line of JSON; refusals exit 1 with a message.
 */
function args(): { rollout: Rollout | null } {
  let values: { rollout?: string | undefined };
  try {
    ({ values } = parseArgs({
      options: { rollout: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new AdminError(
      'usage: release-import [--rollout <stable|canary>[:<percent>]] < release.json (the document is read from stdin)',
    );
  }
  return { rollout: values.rollout === undefined ? null : parseRollout(values.rollout) };
}

/** Warnings and errors to stderr as one line each (no hub sessions here, so this stays quiet). */
function stderrLogger(): FastifyBaseLogger {
  const write =
    (level: string) =>
    (obj: unknown, msg?: unknown): void => {
      const text = typeof obj === 'string' ? obj : typeof msg === 'string' ? msg : '';
      process.stderr.write(`${level}: ${text}\n`);
    };
  const noop = (): void => undefined;
  const log = {
    level: 'warn',
    fatal: write('fatal'),
    error: write('error'),
    warn: write('warn'),
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: (): FastifyBaseLogger => log,
  } as unknown as FastifyBaseLogger;
  return log;
}

await runAdminCli(async (deps) => {
  const { rollout } = args();
  if (process.stdin.isTTY) throw new AdminError('pipe the signed release.json into stdin');
  const config = loadConfig(process.env);
  const log = stderrLogger();
  // p17-object-storage: the bundle and its installer kits are written to the blob store (the bucket, else the local
  // blob directory), which createMasterApp sets for the server; a CLI has to set it itself.
  setBlobService(
    new BlobService({
      pool: deps.pool,
      box: await SecretBox.fromKeyFile(config.totpKeyFile),
      clock: () => new Date(),
      log: {
        warn: (o: Record<string, unknown>, m: string) => {
          process.stderr.write(`warning: ${m} ${JSON.stringify(o)}\n`);
        },
        error: (o: Record<string, unknown>, m: string) => {
          process.stderr.write(`error: ${m} ${JSON.stringify(o)}\n`);
        },
      },
      audit: deps.audit,
      localDir: config.blobs.dataDir,
    }),
  );
  const services = createReleaseServices(
    { pool: deps.pool, audit: deps.audit, hub: new WorkerHub(log), clock: () => new Date(), log },
    releaseServicesConfig(config),
  );
  const bytes = await readCapped(process.stdin);
  const result = await importRelease(services, bytes, { rollout });
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
