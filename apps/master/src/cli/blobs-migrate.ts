import { parseArgs } from 'node:util';
import { AuditLog } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { MIGRATE_KINDS, migrateBlobs } from '../blobs/migrate.js';
import { moveBlobs } from '../blobs/move.js';
import { setBlobService } from '../blobs/registry.js';
import { type BlobKind, BlobService } from '../blobs/store.js';
import { ConfigError, loadConfig } from '../config.js';
import { pendingMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

/**
 * `remyral-master blobs:migrate [--dry-run] [--kind <kind> …] [--batch N] [--limit N] [--to-db | --to-store local|s3]
 * [--json]` (p17-object-storage §7, p17-object-storage-rest §13): moves blobs still stored in Postgres bytea columns
 * into the blob store the master uses now (Settings → Integrations → Storage: the bucket, else the local blob
 * directory BLOB_DATA_DIR), verifying each one (row SHA-256, read-back SHA-256) before the bytea column is cleared.
 * Kinds: artifact, input, site-upload, release, kit, chat-attachment, workflow-file, automation-file, input-bundle.
 * Idempotent and resumable: run it again after an interruption. `--dry-run` only counts (rows / blobs and bytes).
 * `--to-db` moves blobs back into Postgres (rollback to an older master; rows above the old size limits stay in the
 * store). `--to-store local|s3` moves blobs BETWEEN stores (the local blob directory ↔ the configured bucket):
 * copy, read back and verify, point the row at the new copy, then delete the old one.
 *
 * Run it inside the master container (it uses the master's configuration, key file and blob volume):
 *   docker exec <master> remyral-master blobs:migrate --dry-run
 *   docker exec <master> remyral-master blobs:migrate
 *   docker exec <master> remyral-master blobs:migrate --to-store s3 --dry-run
 *   docker exec <master> remyral-master blobs:migrate --to-store s3
 * Postgres keeps the freed pages until VACUUM; `VACUUM (FULL)` of the nine tables returns them to the disk (locks).
 * `--to-store` exits 1 also when an old copy could not be deleted yet (the next run deletes it).
 * Exit: 0 done (failures listed), 1 some rows failed, 2 could not run.
 */

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      kind: { type: 'string', multiple: true },
      batch: { type: 'string' },
      limit: { type: 'string' },
      'to-db': { type: 'boolean', default: false },
      'to-store': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const kinds = (values.kind ?? [...MIGRATE_KINDS]) as BlobKind[];
  for (const k of kinds) {
    if (!MIGRATE_KINDS.includes(k))
      throw new ConfigError([`--kind ${k}: one of ${MIGRATE_KINDS.join(', ')}`]);
  }
  const toStore = values['to-store'];
  if (toStore !== undefined && toStore !== 'local' && toStore !== 's3') {
    throw new ConfigError(['--to-store: local or s3']);
  }
  if (toStore !== undefined && values['to-db'])
    throw new ConfigError(['--to-store and --to-db exclude each other']);
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ConfigError([`--${name}: a positive integer`]);
    return n;
  };
  const config = loadConfig();
  const box = await SecretBox.fromKeyFile(config.totpKeyFile);
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 4,
    applicationName: 'remyral-blobs-migrate',
  });
  try {
    if ((await pendingMigrations(pool)).length > 0) {
      throw new ConfigError(['the database has pending migrations; run `remyral-master migrate` first']);
    }
    const clock = (): Date => new Date();
    const audit = new AuditLog(pool, clock);
    const log = {
      warn: (o: Record<string, unknown>, m: string) => {
        process.stderr.write(`warning: ${m} ${JSON.stringify(o)}\n`);
      },
      error: (o: Record<string, unknown>, m: string) => {
        process.stderr.write(`error: ${m} ${JSON.stringify(o)}\n`);
      },
    };
    const blobs = new BlobService({
      pool,
      box,
      clock,
      log,
      audit,
      localDir: config.blobs.dataDir,
    });
    setBlobService(blobs);
    const mode = await blobs.modeInfo();
    if (mode.s3Error !== null)
      throw new ConfigError([`object storage is selected but not usable: ${mode.s3Error}`]);
    if (toStore !== undefined) {
      return await moveBetweenStores({ pool, blobs, audit }, toStore, values, kinds, num);
    }
    process.stderr.write(
      `target: ${values['to-db'] ? 'Postgres (rollback)' : mode.mode === 's3' ? `object storage ${mode.storeRef ?? ''}` : `local disk ${config.blobs.dataDir}`}${values['dry-run'] ? ' — DRY RUN, nothing is written' : ''}\n`,
    );
    const batch = num(values.batch, 'batch');
    const limit = num(values.limit, 'limit');
    const report = await migrateBlobs(
      { pool, blobs, audit },
      {
        dryRun: values['dry-run'],
        kinds,
        toDb: values['to-db'],
        ...(batch === undefined ? {} : { batch }),
        ...(limit === undefined ? {} : { limit }),
        onProgress: (line) => process.stderr.write(`${line}\n`),
      },
    );
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(
        ['kind', 'rows', 'bytes', 'moved', 'movedBytes', 'skipped', 'failed'].join('\t') + '\n',
      );
      for (const r of report) {
        process.stdout.write(
          [r.kind, r.candidates, r.candidateBytes, r.moved, r.movedBytes, r.skipped, r.failed]
            .map(String)
            .join('\t') + '\n',
        );
        for (const f of r.failures) process.stdout.write(`  failed: ${f}\n`);
      }
    }
    return report.some((r) => r.failed > 0) ? 1 : 0;
  } finally {
    setBlobService(null);
    await pool.end();
  }
}

/** `--to-store local|s3`: blobs between the local directory and the bucket. */
async function moveBetweenStores(
  deps: Parameters<typeof moveBlobs>[0],
  to: 'local' | 's3',
  values: {
    readonly 'dry-run': boolean;
    readonly json: boolean;
    readonly batch?: string;
    readonly limit?: string;
  },
  kinds: BlobKind[],
  num: (v: string | undefined, name: string) => number | undefined,
): Promise<number> {
  const s3 = to === 's3' ? await deps.blobs.activeS3() : null;
  if (to === 's3' && s3 === null) {
    throw new ConfigError([
      '--to-store s3: no usable bucket is configured (Settings → Integrations → Storage)',
    ]);
  }
  const mode = await deps.blobs.modeInfo();
  process.stderr.write(
    `moving blobs to ${to === 's3' ? `the bucket ${s3?.storeRef ?? ''}` : 'the local disk'}${values['dry-run'] ? ' — DRY RUN, nothing is written' : ''}\n`,
  );
  if (mode.mode !== to) {
    process.stderr.write(
      `note: new blobs still go to ${mode.mode === 's3' ? 'the bucket' : 'the local disk'}; switch the mode in Settings → Integrations → Storage too\n`,
    );
  }
  const batch = num(values.batch, 'batch');
  const limit = num(values.limit, 'limit');
  const report = await moveBlobs(deps, {
    to,
    dryRun: values['dry-run'],
    kinds,
    ...(batch === undefined ? {} : { batch }),
    ...(limit === undefined ? {} : { limit }),
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });
  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      ['kind', 'blobs', 'bytes', 'moved', 'movedBytes', 'skipped', 'failed', 'oldCopiesLeft'].join('\t') +
        '\n',
    );
    for (const r of report) {
      process.stdout.write(
        [
          r.kind,
          r.candidates,
          r.candidateBytes,
          r.moved,
          r.movedBytes,
          r.skipped,
          r.failed,
          r.leftoversPending,
        ]
          .map(String)
          .join('\t') + '\n',
      );
      for (const f of r.failures) process.stdout.write(`  failed: ${f}\n`);
    }
  }
  return report.some((r) => r.failed > 0 || (!values['dry-run'] && r.leftoversPending > 0)) ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof ConfigError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected failure'}\n`,
    );
    process.exitCode = 2;
  },
);
