import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { hashStream } from './s3.js';
import {
  type BlobKind,
  type BlobLocation,
  type BlobService,
  BlobUnavailableError,
  type S3Active,
  sameStore,
} from './store.js';

/**
 * p17-object-storage-rest (design note §13.3): `remyral-master blobs:migrate --to-store local|s3` moves blobs between
 * stores — the master's local blob directory and the configured bucket, either way. Per blob, copy → verify →
 * switch → delete:
 *
 *  1. stream the blob from where its row says it is into the destination under the same key;
 *  2. read the destination copy back and hash it (size + SHA-256 against the row);
 *  3. one UPDATE points the row at the new copy and records the old one in `prior_location` / `prior_store_ref` —
 *     only if the row is still where it was with the same SHA-256 (a blob changed or deleted meanwhile is skipped);
 *  4. the old copy is deleted, then `prior_*` is cleared.
 *
 * A run cut short at any step loses nothing: before 3 the row still points at the intact old copy (the next run copies
 * again, overwriting the partial one); after 3 it points at a verified copy and the next run (or the blob GC) deletes
 * the leftover old copy first. Idempotent: blobs already in the destination are not candidates.
 */

export interface MoveOptions {
  readonly to: BlobLocation;
  readonly dryRun: boolean;
  readonly kinds: readonly BlobKind[];
  readonly batch?: number;
  readonly limit?: number;
  readonly onProgress?: (line: string) => void;
  /** p17-panel-settings Part 7: stops between blobs (the panel's "İptal et"). */
  readonly signal?: AbortSignal;
  /** p17-panel-settings Part 7: blobs handled so far of a kind (the panel's progress). */
  readonly onCount?: (kind: BlobKind, processed: number, total: number) => void;
}

export interface MoveReport {
  kind: BlobKind;
  /** Blobs not in the destination store (before the run). */
  candidates: number;
  candidateBytes: number;
  moved: number;
  movedBytes: number;
  skipped: number;
  failed: number;
  /** Old copies deleted that an earlier, interrupted run left behind. */
  leftoversDeleted: number;
  /** Old copies that could not be deleted yet (retried by the next run and by the blob GC). */
  leftoversPending: number;
  failures: string[];
}

interface BlobRow {
  key: string;
  kind: BlobKind;
  location: BlobLocation;
  store_ref: string | null;
  size_bytes: string;
  sha256: string;
  prior_location: BlobLocation | null;
  prior_store_ref: string | null;
}

interface Destination {
  readonly location: BlobLocation;
  readonly s3: S3Active | null;
  readonly storeRef: string | null;
}

/** Rows whose blob may move: verified (committed bytes) and no upload grant still open on the key. */
const MOVABLE = `o.verified_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM blob_uploads u WHERE u.key = o.key AND u.state IN ('granted', 'verifying'))`;

/** SQL: the row is not in the destination store ($1 location, $2 store_ref). */
const NOT_THERE = `NOT (o.location = $1 AND ($1 = 'local' OR o.store_ref IS NOT DISTINCT FROM $2))`;

export async function destinationOf(blobs: BlobService, to: BlobLocation): Promise<Destination> {
  if (to === 'local') return { location: 'local', s3: null, storeRef: null };
  const s3 = await blobs.activeS3();
  if (s3 === null) {
    const info = await blobs.modeInfo();
    throw new BlobUnavailableError(
      '',
      'store_unavailable',
      `no usable bucket is configured (Settings → Integrations → Storage)${info.s3Error === null ? '' : `: ${info.s3Error}`}`,
    );
  }
  return { location: 's3', s3, storeRef: s3.storeRef };
}

export async function moveBlobs(
  deps: { readonly pool: Pool; readonly blobs: BlobService; readonly audit: AuditRecorder },
  opts: MoveOptions,
): Promise<MoveReport[]> {
  const say = opts.onProgress ?? (() => undefined);
  const batch = Math.max(1, Math.min(opts.batch ?? 20, 500));
  const dst = await destinationOf(deps.blobs, opts.to);
  const out: MoveReport[] = [];
  for (const kind of opts.kinds) {
    const report: MoveReport = {
      kind,
      candidates: 0,
      candidateBytes: 0,
      moved: 0,
      movedBytes: 0,
      skipped: 0,
      failed: 0,
      leftoversDeleted: 0,
      leftoversPending: 0,
      failures: [],
    };
    const fail = (key: string, err: unknown): void => {
      report.failed++;
      if (report.failures.length < 50) {
        report.failures.push(`${key}: ${err instanceof Error ? err.message : 'failed'}`.slice(0, 300));
      }
    };
    const count = await deps.pool.query<{ n: number; bytes: string; leftovers: number }>(
      `SELECT count(*) FILTER (WHERE ${NOT_THERE} AND ${MOVABLE})::int AS n,
              coalesce(sum(size_bytes) FILTER (WHERE ${NOT_THERE} AND ${MOVABLE}), 0)::text AS bytes,
              count(*) FILTER (WHERE prior_location IS NOT NULL)::int AS leftovers
         FROM blob_objects o WHERE o.kind = $3`,
      [dst.location, dst.storeRef, kind],
    );
    report.candidates = count.rows[0]?.n ?? 0;
    report.candidateBytes = Number(count.rows[0]?.bytes ?? 0);
    const leftovers = count.rows[0]?.leftovers ?? 0;
    say(
      `${kind}: ${String(report.candidates)} blobs, ${String(report.candidateBytes)} bytes to move to ${dst.location === 'local' ? 'the local disk' : `the bucket ${dst.storeRef ?? ''}`}` +
        (leftovers > 0 ? `; ${String(leftovers)} old copies still to delete` : ''),
    );
    if (opts.dryRun || stopped(opts.signal)) {
      report.leftoversPending = leftovers;
      out.push(report);
      continue;
    }
    // 1. Old copies an interrupted run left behind (the row already points at the verified new copy).
    if (leftovers > 0) {
      const pending = await deps.pool.query<BlobRow>(
        `SELECT key, kind, location, store_ref, size_bytes::text AS size_bytes, sha256, prior_location, prior_store_ref
           FROM blob_objects WHERE kind = $1 AND prior_location IS NOT NULL ORDER BY key`,
        [kind],
      );
      for (const r of pending.rows) {
        if ((await dropPrior(deps, r)) === 'deleted') report.leftoversDeleted++;
        else report.leftoversPending++;
      }
    }
    // 2. The move itself, keyset over the key so a failing blob is passed over (and reported), never retried in a loop.
    let after = '';
    let done = 0;
    while (opts.limit === undefined || done < opts.limit) {
      const res = await deps.pool.query<BlobRow>(
        `SELECT key, kind, location, store_ref, size_bytes::text AS size_bytes, sha256, prior_location, prior_store_ref
           FROM blob_objects o
          WHERE o.kind = $3 AND o.key > $4 AND o.prior_location IS NULL AND ${NOT_THERE} AND ${MOVABLE}
          ORDER BY o.key LIMIT ${String(batch)}`,
        [dst.location, dst.storeRef, kind, after],
      );
      if (res.rows.length === 0 || stopped(opts.signal)) break;
      for (const r of res.rows) {
        if (opts.limit !== undefined && done >= opts.limit) break;
        if (stopped(opts.signal)) break;
        done++;
        try {
          const step = await moveOne(deps, r, dst);
          if (step === 'skipped') report.skipped++;
          else {
            report.moved++;
            report.movedBytes += Number(r.size_bytes);
            if (step === 'moved-leftover') report.leftoversPending++;
          }
        } catch (err) {
          fail(r.key, err);
        }
      }
      after = res.rows.at(-1)?.key ?? after;
      opts.onCount?.(kind, report.moved + report.skipped + report.failed, report.candidates);
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
        direction: `to-store:${dst.location}`,
        moved: report.moved,
        bytes: report.movedBytes,
        skipped: report.skipped,
        failed: report.failed,
        leftoversDeleted: report.leftoversDeleted,
        leftoversPending: report.leftoversPending,
      },
    });
    out.push(report);
  }
  return out;
}

/** Copies one blob into `dst`, verifies the copy, switches the row, then deletes the old copy. */
async function moveOne(
  deps: { readonly pool: Pool; readonly blobs: BlobService },
  r: BlobRow,
  dst: Destination,
): Promise<'moved' | 'moved-leftover' | 'skipped'> {
  const size = Number(r.size_bytes);
  const src = await deps.blobs.streamFrom(r.key, r.location, r.store_ref);
  if (src.size !== size) {
    src.stream.destroy();
    throw new Error(`the stored blob has ${String(src.size)} bytes, the row ${String(size)}`);
  }
  // Copy (streamed: blobs reach 2 GiB).
  if (dst.s3 !== null) {
    await dst.s3.client.putStream(r.key, src.stream, size);
  } else {
    const put = await deps.blobs.local.putStream(
      r.key,
      src.stream,
      size,
      (n, sha) => n === size && sha === r.sha256,
    );
    if (!put.accepted) throw new Error('the copy does not match the row SHA-256 / size');
  }
  // Verify: read the destination copy back.
  const back = dst.s3 !== null ? await dst.s3.client.stream(r.key) : await deps.blobs.local.stream(r.key);
  const got = await hashStream(back.stream, size + 1);
  if (got.size !== size || got.sha256 !== r.sha256) {
    throw new Error('the copy read back does not match the row SHA-256 / size');
  }
  // Switch: only if the row is still where (and what) it was.
  const upd = await deps.pool.query(
    `UPDATE blob_objects SET location = $2, store_ref = $3, prior_location = location, prior_store_ref = store_ref,
            verified_at = now()
      WHERE key = $1 AND location = $4 AND store_ref IS NOT DISTINCT FROM $5 AND sha256 = $6
        AND prior_location IS NULL`,
    [r.key, dst.location, dst.storeRef, r.location, r.store_ref, r.sha256],
  );
  if ((upd.rowCount ?? 0) === 0) return 'skipped';
  // Delete the old copy now that the row points at the verified new one.
  const dropped = await dropPrior(deps, {
    ...r,
    location: dst.location,
    store_ref: dst.storeRef,
    prior_location: r.location,
    prior_store_ref: r.store_ref,
  });
  return dropped === 'deleted' ? 'moved' : 'moved-leftover';
}

/** Deletes the old copy named by `prior_*` (never the live one), then clears `prior_*`. */
async function dropPrior(
  deps: { readonly pool: Pool; readonly blobs: BlobService },
  r: BlobRow,
): Promise<'deleted' | 'pending'> {
  if (r.prior_location === null) return 'deleted';
  if (!sameStore(r.prior_location, r.prior_store_ref, r.location, r.store_ref)) {
    try {
      await deps.blobs.deleteObject(r.key, r.prior_location, r.prior_store_ref);
    } catch {
      return 'pending';
    }
  }
  await deps.pool.query(
    `UPDATE blob_objects SET prior_location = NULL, prior_store_ref = NULL
      WHERE key = $1 AND prior_location = $2 AND prior_store_ref IS NOT DISTINCT FROM $3`,
    [r.key, r.prior_location, r.prior_store_ref],
  );
  return 'deleted';
}

/** p17-panel-settings Part 7: the run was cancelled (a function: the flag changes while the loop runs). */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
