import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * Largest `release.json` the master accepts, whether in one `POST /releases` body or assembled from
 * parts: base64 of the artifact (≤ 32 MiB) plus the installer kits → about 43 MiB of JSON.
 */
export const RELEASE_UPLOAD_BODY_LIMIT = 48 * 1024 * 1024;
/** Upper bound of one part (`PUT /releases/uploads/:id/parts/:n`); every part but the last is exactly `partSize`. */
export const UPLOAD_PART_MAX_BYTES = 4 * 1024 * 1024;
export const UPLOAD_PART_MIN_BYTES = 64 * 1024;
/** An upload without activity for this long is expired (sliding: every accepted part extends it). */
export const UPLOAD_TTL_MS = 60 * 60_000;
/** Open (unexpired) uploads per user. */
export const UPLOADS_PER_USER = 2;

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface UploadStart {
  readonly totalBytes: number;
  readonly sha256: string;
  readonly partSize: number;
}

export interface UploadStatus {
  readonly id: string;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly partSize: number;
  readonly partCount: number;
  /** Indexes (0-based) of the parts the master holds, ascending. */
  readonly received: number[];
  readonly expiresAt: string;
}

export interface ReleaseUploadServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}

interface UploadRow {
  id: string;
  user_id: string;
  total_bytes: number;
  sha256: string;
  part_size: number;
  part_count: number;
  expires_at: Date;
}

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Not found.');
}

/** Expected length of part `n` of an upload. */
export function partLength(totalBytes: number, partSize: number, n: number): number {
  const count = Math.ceil(totalBytes / partSize);
  return n < count - 1 ? partSize : totalBytes - partSize * (count - 1);
}

/**
 * Resumable chunked upload of a signed `release.json` (p6-release-upload). Holds the bytes temporarily in
 * Postgres (where releases live, migration 0041) until `assemble()` hands the verified whole document to
 * the same verification and storage path as `POST /releases` (routes.ts `publishRelease`); the caller
 * then discards the upload. Uploads belong to the user who started them (others get 404), expire after
 * {@link UPLOAD_TTL_MS} without a part and are swept lazily on every start and by {@link sweep}.
 */
export class ReleaseUploadService {
  constructor(private readonly deps: ReleaseUploadServiceDeps) {}

  async start(actor: ActorContext, input: UploadStart): Promise<UploadStatus> {
    if (!SHA256_HEX.test(input.sha256)) {
      throw new HttpError(
        400,
        'invalid_request',
        'sha256 must be 64 lowercase hex characters.',
        {},
        {},
        { reason: 'sha256' },
      );
    }
    if (input.totalBytes < 1 || input.totalBytes > RELEASE_UPLOAD_BODY_LIMIT) {
      throw new HttpError(
        413,
        'upload_too_large',
        `A release document may be at most ${String(RELEASE_UPLOAD_BODY_LIMIT)} bytes.`,
        {},
        {},
        { max: RELEASE_UPLOAD_BODY_LIMIT },
      );
    }
    if (input.partSize < UPLOAD_PART_MIN_BYTES || input.partSize > UPLOAD_PART_MAX_BYTES) {
      throw new HttpError(
        400,
        'invalid_request',
        `partSize must be between ${String(UPLOAD_PART_MIN_BYTES)} and ${String(UPLOAD_PART_MAX_BYTES)} bytes.`,
        {},
        {},
        { reason: 'part_size', min: UPLOAD_PART_MIN_BYTES, max: UPLOAD_PART_MAX_BYTES },
      );
    }
    await this.sweep();
    const now = this.deps.clock();
    const id = randomUUID();
    const partCount = Math.ceil(input.totalBytes / input.partSize);
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
    await withTransaction(this.deps.pool, async (tx) => {
      // Serialise this user's starts so two concurrent requests cannot both pass the cap.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('release-upload:' || $1, 0))`, [
        actor.userId,
      ]);
      const open = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM worker_release_uploads WHERE user_id = $1 AND expires_at > $2',
        [actor.userId, now],
      );
      if ((open.rows[0]?.n ?? 0) >= UPLOADS_PER_USER) {
        throw new HttpError(
          409,
          'too_many_uploads',
          `You already have ${String(UPLOADS_PER_USER)} release uploads in progress. Finish or cancel one first.`,
          {},
          {},
          { max: UPLOADS_PER_USER },
        );
      }
      await tx.query(
        `INSERT INTO worker_release_uploads (id, user_id, total_bytes, sha256, part_size, part_count,
                                             created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, actor.userId, input.totalBytes, input.sha256, input.partSize, partCount, now, expiresAt],
      );
    });
    return {
      id,
      totalBytes: input.totalBytes,
      sha256: input.sha256,
      partSize: input.partSize,
      partCount,
      received: [],
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The caller's own, unexpired upload; 404 otherwise (an expired one is deleted: 410). */
  async #own(actor: ActorContext, id: string): Promise<UploadRow> {
    const { rows } = await this.deps.pool.query<UploadRow>(
      `SELECT id, user_id, total_bytes, sha256, part_size, part_count, expires_at
         FROM worker_release_uploads WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row?.user_id !== actor.userId) throw notFound();
    if (row.expires_at.getTime() <= this.deps.clock().getTime()) {
      await this.discard(id);
      throw new HttpError(410, 'upload_expired', 'This upload expired. Start the upload again.');
    }
    return row;
  }

  async status(actor: ActorContext, id: string): Promise<UploadStatus> {
    const row = await this.#own(actor, id);
    const { rows } = await this.deps.pool.query<{ n: number }>(
      'SELECT n FROM worker_release_upload_parts WHERE upload_id = $1 ORDER BY n',
      [id],
    );
    return {
      id: row.id,
      totalBytes: row.total_bytes,
      sha256: row.sha256,
      partSize: row.part_size,
      partCount: row.part_count,
      received: rows.map((r) => r.n),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** Stores part `n` (idempotent: a retry overwrites it) after checking its length and SHA-256. */
  async putPart(
    actor: ActorContext,
    id: string,
    n: number,
    bytes: Buffer,
    sha256: string,
  ): Promise<{ n: number; received: number; partCount: number; expiresAt: string }> {
    const row = await this.#own(actor, id);
    if (!Number.isInteger(n) || n < 0 || n >= row.part_count) {
      throw new HttpError(
        400,
        'part_out_of_range',
        `Part ${String(n)} does not exist; this upload has parts 0–${String(row.part_count - 1)}.`,
        {},
        {},
        { part: n, last: row.part_count - 1 },
      );
    }
    const expected = partLength(row.total_bytes, row.part_size, n);
    if (bytes.byteLength !== expected) {
      throw new HttpError(
        400,
        'part_size_mismatch',
        `Part ${String(n)} must be ${String(expected)} bytes, got ${String(bytes.byteLength)}.`,
        {},
        {},
        { part: n, expected, got: bytes.byteLength },
      );
    }
    if (!SHA256_HEX.test(sha256) || sha256Hex(bytes) !== sha256) {
      throw new HttpError(
        422,
        'part_checksum_mismatch',
        `Part ${String(n)} does not match its SHA-256; send it again.`,
        {},
        {},
        { part: n },
      );
    }
    const expiresAt = new Date(this.deps.clock().getTime() + UPLOAD_TTL_MS);
    const received = await withTransaction(this.deps.pool, async (tx) => {
      // Lock the upload row: a concurrent complete/abort/sweep either ran before (404) or waits for us.
      const live = await tx.query('SELECT 1 FROM worker_release_uploads WHERE id = $1 FOR UPDATE', [id]);
      if (live.rowCount === 0) throw notFound();
      await tx.query(
        `INSERT INTO worker_release_upload_parts (upload_id, n, sha256, bytes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (upload_id, n) DO UPDATE SET sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes`,
        [id, n, sha256, bytes],
      );
      await tx.query('UPDATE worker_release_uploads SET expires_at = $2 WHERE id = $1', [id, expiresAt]);
      const c = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM worker_release_upload_parts WHERE upload_id = $1',
        [id],
      );
      return c.rows[0]?.n ?? 0;
    });
    return { n, received, partCount: row.part_count, expiresAt: expiresAt.toISOString() };
  }

  /**
   * The whole document, once every part is present and the concatenation matches the SHA-256 declared at
   * start. Missing parts: 409 and the upload stays (send them, then complete again). Whole-document
   * mismatch: the upload is discarded, audited as a refused `release.upload` and 422.
   */
  async assemble(actor: ActorContext, id: string): Promise<Buffer> {
    const row = await this.#own(actor, id);
    const { rows } = await this.deps.pool.query<{ n: number; bytes: Buffer }>(
      'SELECT n, bytes FROM worker_release_upload_parts WHERE upload_id = $1 ORDER BY n',
      [id],
    );
    const have = new Set(rows.map((r) => r.n));
    const missing: number[] = [];
    for (let i = 0; i < row.part_count; i++) if (!have.has(i)) missing.push(i);
    if (missing.length > 0) {
      throw new HttpError(
        409,
        'upload_incomplete',
        `Parts ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''} have not been received.`,
        {},
        {},
        { parts: `${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}` },
      );
    }
    const doc = Buffer.concat(rows.map((r) => r.bytes));
    if (doc.byteLength !== row.total_bytes || sha256Hex(doc) !== row.sha256) {
      await this.discard(id);
      await this.refused(actor, 'checksum_mismatch', id);
      throw new HttpError(
        422,
        'checksum_mismatch',
        'The assembled document does not match the SHA-256 declared at start. Start the upload again.',
      );
    }
    return doc;
  }

  /** Records a refused upload that never reached release verification (same audit action as today). */
  async refused(actor: ActorContext, reason: string, uploadId: string): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'release.upload',
      outcome: 'denied',
      target: null,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { reason, uploadId },
    });
  }

  async abort(actor: ActorContext, id: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ user_id: string }>(
      'SELECT user_id FROM worker_release_uploads WHERE id = $1',
      [id],
    );
    if (rows[0]?.user_id !== actor.userId) throw notFound();
    await this.discard(id);
  }

  async discard(id: string): Promise<void> {
    await this.deps.pool.query('DELETE FROM worker_release_uploads WHERE id = $1', [id]);
  }

  /** Deletes expired uploads (and their parts); returns how many. */
  async sweep(): Promise<number> {
    const r = await this.deps.pool.query('DELETE FROM worker_release_uploads WHERE expires_at <= $1', [
      this.deps.clock(),
    ]);
    return r.rowCount ?? 0;
  }
}
