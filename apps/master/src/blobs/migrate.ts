import { createHash } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { type BlobKind, blobKeys, type BlobService, sha256Hex } from './store.js';

/**
 * p17-object-storage §8: `remyral-master blobs:migrate` — moves blobs still held in Postgres bytea columns into the
 * blob store (the configured bucket, else the local blob directory). Per row: read the bytes, check them against the
 * row's recorded SHA-256 (size for kits / releases too), write the blob, read it back and hash it, then in one
 * statement set `blob_key` and NULL the bytea column — only if the row still holds those bytes. Idempotent and
 * resumable (it only ever picks rows whose bytea column is still set; a run cut short leaves at most unreferenced
 * blobs, which the blob GC removes). `--to-db` is the rollback path: blobs back into the bytea columns (only where
 * the old constraints allow it), for running an older master.
 */

export const MIGRATE_KINDS: readonly BlobKind[] = [
  'artifact',
  'input',
  'site-upload',
  'release',
  'kit',
  // p17-object-storage-rest (design note §13).
  'chat-attachment',
  'workflow-file',
  'automation-file',
  'input-bundle',
  // p19-ide W3: never in Postgres (nothing to migrate), but movable between stores like every blob.
  'ide-extension',
];

export interface MigrateOptions {
  readonly dryRun: boolean;
  readonly kinds: readonly BlobKind[];
  /** Rows read per query (one row's bytes in memory at a time). */
  readonly batch?: number;
  /** Stop after this many rows per kind (tests, careful first runs). */
  readonly limit?: number;
  readonly toDb?: boolean;
  readonly onProgress?: (line: string) => void;
  /** p17-panel-settings Part 7: stops between rows (the panel's "İptal et"). */
  readonly signal?: AbortSignal;
  /** p17-panel-settings Part 7: rows handled so far of a kind (the panel's progress). */
  readonly onCount?: (kind: BlobKind, processed: number, total: number) => void;
}

export interface KindReport {
  kind: BlobKind;
  candidates: number;
  candidateBytes: number;
  moved: number;
  movedBytes: number;
  skipped: number;
  failed: number;
  failures: string[];
}

interface Table {
  readonly table: string;
  readonly column: string;
  /** Key columns (in order) and how to build the blob key from them. */
  readonly keys: readonly string[];
  readonly select: string;
  readonly keyOf: (r: Record<string, string>) => string;
  readonly sha: (r: Record<string, string>) => string | null;
  /** Largest size the old bytea constraint allows (for `--to-db`), or null for no limit. */
  readonly backMax: number | null;
}

/** p19-ide W3: `ide-extension` blobs never lived in Postgres (written to the store from the start). */
const TABLES: Readonly<Record<Exclude<BlobKind, 'ide-extension'>, Table>> = {
  artifact: {
    table: 'job_artifacts',
    column: 'content',
    keys: ['attempt_id', 'artifact_id'],
    select: `attempt_id::text AS attempt_id, artifact_id, job_id::text AS job_id, sha256, size_bytes::text AS size_bytes,
             media_type`,
    keyOf: (r) => `artifacts/${r.job_id ?? ''}/${r.attempt_id ?? ''}/${r.artifact_id ?? ''}`,
    sha: (r) => r.sha256 ?? null,
    backMax: 83_886_080,
  },
  input: {
    table: 'job_inputs',
    column: 'content',
    keys: ['job_id', 'input_id'],
    select: `job_id::text AS job_id, input_id, sha256, size_bytes::text AS size_bytes, media_type`,
    keyOf: (r) => `inputs/${r.job_id ?? ''}/${r.input_id ?? ''}`,
    sha: (r) => r.sha256 ?? null,
    backMax: 5_242_880,
  },
  'site-upload': {
    table: 'site_upload_files',
    column: 'content',
    keys: ['upload_id', 'idx'],
    select: `upload_id::text AS upload_id, idx::text AS idx, sha256, size_bytes::text AS size_bytes,
             content_type AS media_type`,
    keyOf: (r) => `site-uploads/${r.upload_id ?? ''}/${r.idx ?? ''}`,
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
  release: {
    table: 'worker_releases',
    column: 'artifact',
    keys: ['version'],
    select: `version, sha256, size_bytes::text AS size_bytes, 'application/octet-stream' AS media_type`,
    keyOf: (r) => `releases/${r.version ?? ''}/bundle-migrated`,
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
  kit: {
    table: 'worker_release_installer_kits',
    column: 'content',
    keys: ['version', 'os'],
    select: `version, os, sha256, size_bytes::text AS size_bytes, 'application/octet-stream' AS media_type`,
    keyOf: (r) => `kits/${r.version ?? ''}/${r.os ?? ''}-migrated`,
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
  // p17-object-storage-rest: the same keys the writers use (design note §13.1). The old size bounds still hold on the
  // bytea columns, so --to-db has no extra limit.
  'chat-attachment': {
    table: 'chat_attachments',
    column: 'content',
    keys: ['id'],
    select: `id::text AS id, thread_id::text AS thread_id, sha256, size_bytes::text AS size_bytes, media_type`,
    keyOf: (r) => blobKeys.chatAttachment(r.thread_id ?? '', r.id ?? ''),
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
  'workflow-file': {
    table: 'workflow_run_files',
    column: 'content',
    keys: ['run_id', 'input_id'],
    select: `run_id::text AS run_id, input_id, sha256, size_bytes::text AS size_bytes, media_type`,
    keyOf: (r) => blobKeys.workflowFile(r.run_id ?? '', r.input_id ?? ''),
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
  'automation-file': {
    table: 'automation_files',
    column: 'content',
    keys: ['automation_id', 'input_id'],
    select: `automation_id::text AS automation_id, input_id, sha256, size_bytes::text AS size_bytes, media_type`,
    keyOf: (r) => blobKeys.automationFile(r.automation_id ?? '', r.input_id ?? ''),
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
  'input-bundle': {
    table: 'input_upload_files',
    column: 'content',
    keys: ['upload_id', 'idx'],
    select: `upload_id::text AS upload_id, idx::text AS idx, sha256, size_bytes::text AS size_bytes,
             'application/octet-stream' AS media_type`,
    keyOf: (r) => blobKeys.inputBundle(r.upload_id ?? '', Number(r.idx ?? 0)),
    sha: (r) => r.sha256 ?? null,
    backMax: null,
  },
};

function whereKeys(t: Table, offset = 0): string {
  return t.keys.map((k, i) => `${k}::text = $${String(i + 1 + offset)}`).join(' AND ');
}

export async function migrateBlobs(
  deps: { readonly pool: Pool; readonly blobs: BlobService; readonly audit: AuditRecorder },
  opts: MigrateOptions,
): Promise<KindReport[]> {
  const out: KindReport[] = [];
  const say = opts.onProgress ?? (() => undefined);
  const batch = Math.max(1, Math.min(opts.batch ?? 20, 500));
  for (const kind of opts.kinds) {
    const report: KindReport = {
      kind,
      candidates: 0,
      candidateBytes: 0,
      moved: 0,
      movedBytes: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };
    if (kind === 'ide-extension') {
      out.push(report);
      continue;
    }
    const t = TABLES[kind];
    const count = await deps.pool.query<{ n: number; bytes: string }>(
      opts.toDb === true
        ? `SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::text AS bytes FROM ${t.table}
            WHERE blob_key IS NOT NULL`
        : `SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::text AS bytes FROM ${t.table}
            WHERE ${t.column} IS NOT NULL`,
    );
    report.candidates = count.rows[0]?.n ?? 0;
    report.candidateBytes = Number(count.rows[0]?.bytes ?? 0);
    say(
      `${kind}: ${String(report.candidates)} rows, ${String(report.candidateBytes)} bytes ${opts.toDb === true ? 'in the blob store' : 'in Postgres'}`,
    );
    if (opts.dryRun || report.candidates === 0 || stopped(opts.signal)) {
      out.push(report);
      continue;
    }
    // Keyset over the primary key, so a row that fails is passed over (and reported), never retried in a loop.
    let after: string[] | null = null;
    let done = 0;
    const order = t.keys.map((k) => `${k}::text`).join(', ');
    while (opts.limit === undefined || done < opts.limit) {
      const params: unknown[] = after === null ? [] : [...after];
      const cursor: string =
        after === null ? '' : `AND (${order}) > (${t.keys.map((_k, i) => `$${String(i + 1)}`).join(', ')})`;
      const res: { rows: Record<string, string>[] } = await deps.pool.query<Record<string, string>>(
        `SELECT ${t.select} FROM ${t.table}
          WHERE ${opts.toDb === true ? 'blob_key IS NOT NULL' : `${t.column} IS NOT NULL`} ${cursor}
          ORDER BY ${order} LIMIT ${String(batch)}`,
        params,
      );
      const rows = res.rows;
      if (rows.length === 0) break;
      if (stopped(opts.signal)) break;
      for (const r of rows) {
        if (opts.limit !== undefined && done >= opts.limit) break;
        if (stopped(opts.signal)) break;
        done++;
        const ids = t.keys.map((k) => r[k] ?? '');
        const label = `${kind} ${ids.join('/')}`;
        try {
          const moved =
            opts.toDb === true ? await backToDb(deps, t, ids, r) : await toStore(deps, kind, t, ids, r);
          if (moved === 'skipped') report.skipped++;
          else {
            report.moved++;
            report.movedBytes += Number(r.size_bytes ?? 0);
          }
        } catch (err) {
          report.failed++;
          if (report.failures.length < 50) {
            report.failures.push(`${label}: ${err instanceof Error ? err.message : 'failed'}`.slice(0, 300));
          }
        }
      }
      opts.onCount?.(kind, report.moved + report.skipped + report.failed, report.candidates);
      const last: Record<string, string> | undefined = rows.at(-1);
      after = t.keys.map((k): string => last?.[k] ?? '');
      say(
        `${kind}: ${String(report.moved)} moved, ${String(report.skipped)} skipped, ${String(report.failed)} failed`,
      );
    }
    await deps.audit.record({
      actor: { type: 'system', id: 'cli:blobs-migrate' },
      action: 'blobs.migrate',
      target: `blobs:${kind}`,
      outcome: report.failed > 0 ? 'failure' : 'success',
      metadata: {
        direction: opts.toDb === true ? 'to-db' : 'to-store',
        moved: report.moved,
        bytes: report.movedBytes,
        skipped: report.skipped,
        failed: report.failed,
      },
    });
    out.push(report);
  }
  return out;
}

async function toStore(
  deps: { readonly pool: Pool; readonly blobs: BlobService },
  kind: BlobKind,
  t: Table,
  ids: readonly string[],
  r: Record<string, string>,
): Promise<'moved' | 'skipped'> {
  const got = await deps.pool.query<{ c: Buffer | null }>(
    `SELECT ${t.column} AS c FROM ${t.table} WHERE ${whereKeys(t)}`,
    [...ids],
  );
  const bytes = got.rows[0]?.c ?? null;
  if (bytes === null) return 'skipped';
  const sha = sha256Hex(bytes);
  const expected = t.sha(r);
  if (expected !== null && sha !== expected) throw new Error('the stored bytes do not match the row SHA-256');
  if (Number(r.size_bytes) !== bytes.length) throw new Error('the stored bytes do not match the row size');
  const key = t.keyOf(r);
  await deps.blobs.write(kind, key, bytes, r.media_type ?? 'application/octet-stream');
  // Read back from the store and hash again before the bytea is dropped.
  const back = await deps.blobs.read(key, bytes.length + 1);
  if (createHash('sha256').update(back).digest('hex') !== sha) throw new Error('read-back mismatch');
  const upd = await deps.pool.query(
    `UPDATE ${t.table} SET blob_key = $${String(t.keys.length + 1)}, ${t.column} = NULL
      WHERE ${whereKeys(t)} AND ${t.column} IS NOT NULL AND sha256 = $${String(t.keys.length + 2)}`,
    [...ids, key, sha],
  );
  // The row changed meanwhile (pruned / replaced): the written blob is unreferenced and the GC removes it.
  return (upd.rowCount ?? 0) > 0 ? 'moved' : 'skipped';
}

async function backToDb(
  deps: { readonly pool: Pool; readonly blobs: BlobService },
  t: Table,
  ids: readonly string[],
  r: Record<string, string>,
): Promise<'moved' | 'skipped'> {
  const size = Number(r.size_bytes);
  if (t.backMax !== null && size > t.backMax) return 'skipped';
  const got = await deps.pool.query<{ k: string | null }>(
    `SELECT blob_key AS k FROM ${t.table} WHERE ${whereKeys(t)}`,
    [...ids],
  );
  const key = got.rows[0]?.k ?? null;
  if (key === null) return 'skipped';
  const bytes = await deps.blobs.read(key, size + 1);
  const expected = t.sha(r);
  if (expected !== null && sha256Hex(bytes) !== expected)
    throw new Error('the blob does not match the row SHA-256');
  const upd = await deps.pool.query(
    `UPDATE ${t.table} SET ${t.column} = $${String(t.keys.length + 1)}, blob_key = NULL
      WHERE ${whereKeys(t)} AND blob_key = $${String(t.keys.length + 2)}`,
    [...ids, bytes, key],
  );
  return (upd.rowCount ?? 0) > 0 ? 'moved' : 'skipped';
}

/** p17-panel-settings Part 7: the run was cancelled (a function: the flag changes while the loop runs). */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
