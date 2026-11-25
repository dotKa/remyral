import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  ArtifactName,
  type AssignedBlobUpload,
  BLOB_LIMITS,
  type BlobRefusal,
  type BlobUploadCompletePayload,
  type BlobUploadGrantPayload,
  type BlobUploadRequestPayload,
  type BlobUploadStatusPayload,
  contentMatchesType,
  FUNCTION_RESULT_ARTIFACT_ID,
  INTEGRATION_REPORT_ARTIFACT_ID,
  SITE_BUNDLE_ARTIFACT_ID,
  workspaceFileType,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { reserveStorage, StorageQuotaError } from '../workspaces/storage.js';
import { hashStream, S3Error, sha256HexToBase64 } from './s3.js';
import { type BlobLocation, type BlobLog, type BlobService, BlobUnavailableError } from './store.js';

/**
 * p17-object-storage: upload grants for large workspace outputs of `blob-upload-v1` workers (docs/design/
 * p17-object-storage.md §4). A grant is for one key (`artifacts/<job>/<attempt>/<artifact>`), one size and one
 * SHA-256, for the attempt holding the job's live lease:
 *
 *  - object storage: a presigned PUT (≤ 100 MiB; `content-length` bound, plus `x-amz-checksum-sha256` on providers
 *    that check it) or presigned UploadPart URLs of a multipart upload (each part's `content-length` bound);
 *  - local disk: the master's endpoint `PUT /v1/worker/blobs/:id` with a one-time bearer token (only its SHA-256 is
 *    stored), which counts and hashes while it writes and accepts only the declared size + SHA-256.
 *
 * BLOB_UPLOAD_COMPLETE makes the master verify the stored object itself (it streams the object and hashes it: size,
 * SHA-256, the type's magic bytes) before it answers `verified`; only a verified upload can be committed by
 * ARTIFACT_REF `blobUploadId`. Workers never get storage credentials; every grant is short-lived and audited.
 */

const SPECIAL_IDS = new Set([
  'ws-summary',
  SITE_BUNDLE_ARTIFACT_ID,
  INTEGRATION_REPORT_ARTIFACT_ID,
  FUNCTION_RESULT_ARTIFACT_ID,
]);

/** The master's upload endpoint (local-disk mode). */
export const BLOB_UPLOAD_PATH = '/v1/worker/blobs/';

/** Grant lifetime: 15 min plus 1 s per MiB (a slow uplink), at most 12 h. */
export function grantTtlSeconds(sizeBytes: number): number {
  return Math.min(12 * 3600, 900 + Math.ceil(sizeBytes / (1024 * 1024)));
}

/** Providers that verify `x-amz-checksum-sha256` on PutObject (others: the master's own read-back only). */
const CHECKSUM_PROVIDERS = new Set(['aws', 'minio']);

export function artifactKey(jobId: string, attemptId: string, artifactId: string): string {
  return `artifacts/${jobId}/${attemptId}/${artifactId}`;
}

interface UploadRow {
  id: string;
  job_id: string;
  attempt_id: string;
  epoch: number;
  worker_id: string;
  artifact_id: string;
  name: string;
  media_type: string;
  size_bytes: string;
  sha256: string;
  key: string;
  location: BlobLocation;
  multipart_id: string | null;
  parts: { sizeBytes: number; sha256: string }[] | null;
  state: 'granted' | 'verifying' | 'verified' | 'committed' | 'failed' | 'expired';
  expires_at: Date;
}

export interface BlobUploadDeps {
  readonly pool: Pool;
  readonly blobs: BlobService;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: BlobLog;
}

type GrantReply = Omit<BlobUploadGrantPayload, 'attemptId' | 'epoch' | 'requestId'>;

export class BlobUploads {
  readonly #verifying = new Set<string>();

  constructor(private readonly deps: BlobUploadDeps) {}

  /**
   * ASSIGN_JOB `execution.blobUpload`: the owner's limits and the part size of the current store (8 MiB parts towards
   * the master's own endpoint, 64 MiB towards a bucket). Null when object storage is selected but unusable (the job
   * then keeps the chunk path and its limits).
   */
  async assignment(): Promise<AssignedBlobUpload | null> {
    const info = await this.deps.blobs.modeInfo();
    if (info.mode === 's3' && info.s3Error !== null) return null;
    const limits = await this.deps.blobs.limits();
    return {
      thresholdBytes: limits.thresholdBytes,
      maxFileBytes: limits.maxFileBytes,
      maxJobBytes: limits.maxJobBytes,
      maxFiles: BLOB_LIMITS.maxFiles,
      partBytes: info.mode === 's3' ? BLOB_LIMITS.partBytes : BLOB_LIMITS.localPartBytes,
    };
  }

  /**
   * Issues (or re-issues) a grant for one large output of the attempt. The caller checked the live lease. Refusals
   * carry a reason the worker writes into the summary ("not returned: …").
   */
  async grant(workerId: string, jobId: string, p: BlobUploadRequestPayload): Promise<GrantReply> {
    const refuse = async (reason: BlobRefusal, detail?: Record<string, unknown>): Promise<GrantReply> => {
      await this.deps.audit.record({
        actor: { type: 'worker', id: workerId },
        action: 'blob.upload.grant',
        target: `job:${jobId}`,
        outcome: 'denied',
        metadata: { artifactId: p.artifactId, sizeBytes: p.sizeBytes, reason, ...detail },
      });
      return { status: 'refused', reason };
    };
    const type = workspaceFileType(p.name);
    if (
      SPECIAL_IDS.has(p.artifactId) ||
      !ArtifactName.safeParse(p.name).success ||
      type === null ||
      type.mediaType !== p.mediaType
    ) {
      return refuse('type_not_allowed');
    }
    const limits = await this.deps.blobs.limits();
    if (p.sizeBytes > limits.maxFileBytes) return refuse('too_large', { maxFileBytes: limits.maxFileBytes });
    // An upload in parts when the worker split the file (larger than its assignment's part size).
    const multipart = (p.parts?.length ?? 0) > 1;
    let target: Awaited<ReturnType<BlobService['target']>>;
    try {
      target = await this.deps.blobs.target();
    } catch (err) {
      if (err instanceof BlobUnavailableError) return refuse('unavailable');
      throw err;
    }
    if (multipart) {
      const parts = p.parts ?? [];
      const ok =
        parts.reduce((n, x) => n + x.sizeBytes, 0) === p.sizeBytes &&
        parts.every((x, i) => i === parts.length - 1 || x.sizeBytes === parts[0]?.sizeBytes) &&
        (parts[0]?.sizeBytes ?? 0) >= 5 * 1024 * 1024;
      if (!ok) return refuse('invalid', { why: 'parts' });
    }
    const key = artifactKey(jobId, p.attemptId, p.artifactId);
    const now = this.deps.clock();
    const ttl = grantTtlSeconds(p.sizeBytes);
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    // Budgets of the job (per attempt count; per job bytes across attempts) and the project quota.
    // p17-output-limits: the attempt's recorded limits (project override, output-limits-v1 file limit) apply on top of
    // the store's; with a recorded file limit the count covers every output of the attempt (inline ones too).
    const budget = await this.deps.pool.query<{
      project: string;
      bytes: string;
      files: number;
      inline: number;
      max_files: number | null;
      max_job_bytes: string | null;
    }>(
      `SELECT j.project,
              coalesce((SELECT sum(size_bytes) FROM blob_uploads u WHERE u.job_id = j.id
                          AND u.state IN ('granted', 'verifying', 'verified', 'committed')
                          AND NOT (u.attempt_id = $2 AND u.artifact_id = $3)), 0)::text AS bytes,
              (SELECT count(*)::int FROM blob_uploads u WHERE u.attempt_id = $2
                 AND u.state IN ('granted', 'verifying', 'verified', 'committed') AND u.artifact_id <> $3) AS files,
              (SELECT count(*)::int FROM job_artifacts a WHERE a.attempt_id = $2 AND a.kind = 'output'
                 AND NOT EXISTS (SELECT 1 FROM blob_uploads u WHERE u.attempt_id = a.attempt_id
                                   AND u.artifact_id = a.artifact_id)) AS inline,
              x.output_max_files AS max_files, x.output_max_job_bytes::text AS max_job_bytes
         FROM jobs j LEFT JOIN job_attempts x ON x.id = $2 AND x.job_id = j.id WHERE j.id = $1`,
      [jobId, p.attemptId, p.artifactId],
    );
    const b = budget.rows[0];
    if (b === undefined) return refuse('stale');
    const maxJobBytes =
      b.max_job_bytes === null ? limits.maxJobBytes : Math.min(limits.maxJobBytes, Number(b.max_job_bytes));
    if (Number(b.bytes) + p.sizeBytes > maxJobBytes) {
      return refuse('job_limit', { maxJobBytes });
    }
    if (b.max_files === null ? b.files >= BLOB_LIMITS.maxFiles : b.files + b.inline >= b.max_files) {
      return refuse('job_limit', { maxFiles: b.max_files ?? BLOB_LIMITS.maxFiles });
    }
    const existing = await this.deps.pool.query<UploadRow>(
      'SELECT * FROM blob_uploads WHERE attempt_id = $1 AND artifact_id = $2',
      [p.attemptId, p.artifactId],
    );
    const prev = existing.rows[0];
    if (prev !== undefined && prev.job_id !== jobId) return refuse('invalid', { why: 'attempt' });
    if (
      prev !== undefined &&
      (prev.state === 'verified' || prev.state === 'committed') &&
      Number(prev.size_bytes) === p.sizeBytes &&
      prev.sha256 === p.sha256
    ) {
      // Already there (a retry after a crash): nothing to PUT; COMPLETE answers `verified`.
      return { status: 'ok', uploadId: prev.id, target: prev.location === 's3' ? 'object-store' : 'master' };
    }
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        await reserveStorage(tx, b.project, p.sizeBytes, now, this.deps.audit);
      });
    } catch (err) {
      if (err instanceof StorageQuotaError) return refuse('quota', { quotaBytes: err.quotaBytes });
      throw err;
    }
    if (prev !== undefined && prev.multipart_id !== null && prev.location === 's3') {
      const s3 = await this.deps.blobs.activeS3();
      await s3?.client.abortMultipart(prev.key, prev.multipart_id).catch(() => undefined);
    }
    await this.deps.blobs.register('artifact', key, p.sizeBytes, p.sha256, target);
    const id = prev !== undefined && prev.state !== 'committed' ? prev.id : randomUUID();
    let multipartId: string | null = null;
    let token: string | null = null;
    let reply: GrantReply;
    try {
      if (target.s3 !== null) {
        const s3 = target.s3;
        if (multipart) {
          multipartId = await s3.client.createMultipart(key, p.mediaType);
          const parts = p.parts ?? [];
          reply = {
            status: 'ok',
            uploadId: id,
            target: 'object-store',
            parts: parts.map((part, i) => ({
              n: i + 1,
              ...s3.client.presignPart(key, multipartId ?? '', i + 1, part.sizeBytes, ttl),
            })),
            expiresAt: expiresAt.toISOString(),
          };
        } else {
          reply = {
            status: 'ok',
            uploadId: id,
            target: 'object-store',
            put: s3.client.presignPut(key, {
              sizeBytes: p.sizeBytes,
              contentType: p.mediaType,
              ...(CHECKSUM_PROVIDERS.has(s3.config.provider)
                ? { checksumSha256: sha256HexToBase64(p.sha256) }
                : {}),
              expiresSeconds: ttl,
            }),
            expiresAt: expiresAt.toISOString(),
          };
        }
      } else {
        token = randomBytes(32).toString('base64url');
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' };
        await this.deps.blobs.local.dropParts(id);
        reply = multipart
          ? {
              status: 'ok',
              uploadId: id,
              target: 'master',
              parts: (p.parts ?? []).map((_part, i) => ({
                n: i + 1,
                url: `${BLOB_UPLOAD_PATH}${id}/${String(i + 1)}`,
                headers,
              })),
              expiresAt: expiresAt.toISOString(),
            }
          : {
              status: 'ok',
              uploadId: id,
              target: 'master',
              put: { url: `${BLOB_UPLOAD_PATH}${id}`, headers },
              expiresAt: expiresAt.toISOString(),
            };
      }
    } catch (err) {
      if (err instanceof S3Error) {
        this.deps.log.warn(
          { err, jobId, artifactId: p.artifactId },
          'blob upload grant: object storage error',
        );
        return refuse('unavailable', { error: err.code });
      }
      throw err;
    }
    await this.deps.pool.query(
      `INSERT INTO blob_uploads (id, job_id, attempt_id, epoch, worker_id, artifact_id, name, media_type, size_bytes,
                                 sha256, key, location, multipart_id, parts, token_hash, state, reason, created_at,
                                 expires_at, verified_at, committed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'granted', NULL, $16, $17, NULL, NULL)
       ON CONFLICT (attempt_id, artifact_id) DO UPDATE SET id = EXCLUDED.id, epoch = EXCLUDED.epoch,
         worker_id = EXCLUDED.worker_id, name = EXCLUDED.name, media_type = EXCLUDED.media_type,
         size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, key = EXCLUDED.key,
         location = EXCLUDED.location, multipart_id = EXCLUDED.multipart_id, parts = EXCLUDED.parts,
         token_hash = EXCLUDED.token_hash, state = 'granted', reason = NULL, created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at, verified_at = NULL, committed_at = NULL`,
      [
        id,
        jobId,
        p.attemptId,
        p.epoch,
        workerId,
        p.artifactId,
        p.name,
        p.mediaType,
        p.sizeBytes,
        p.sha256,
        key,
        target.location,
        multipartId,
        p.parts === undefined ? null : JSON.stringify(p.parts),
        token === null ? null : createHash('sha256').update(token).digest(),
        now,
        expiresAt,
      ],
    );
    await this.deps.audit.record({
      actor: { type: 'worker', id: workerId },
      action: 'blob.upload.grant',
      target: `job:${jobId}`,
      outcome: 'success',
      metadata: {
        uploadId: id,
        artifactId: p.artifactId,
        sizeBytes: p.sizeBytes,
        location: target.location,
        multipart: multipartId !== null,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return reply;
  }

  /**
   * BLOB_UPLOAD_COMPLETE: completes a multipart upload and starts the verification; `onDone` gets the status (it may
   * take a while for big objects, so the session handler does not wait for it).
   */
  async complete(
    workerId: string,
    jobId: string,
    p: BlobUploadCompletePayload,
  ): Promise<Omit<BlobUploadStatusPayload, 'attemptId' | 'epoch' | 'requestId'>> {
    const { rows } = await this.deps.pool.query<UploadRow>(
      'SELECT * FROM blob_uploads WHERE id = $1 AND job_id = $2 AND attempt_id = $3',
      [p.uploadId, jobId, p.attemptId],
    );
    const u = rows[0];
    const out = (status: 'verified' | 'failed' | 'refused', reason?: string, sizeBytes?: number) => ({
      uploadId: p.uploadId,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
    if (u === undefined) return out('refused', 'unknown_upload');
    if (u.state === 'verified' || u.state === 'committed') return out('verified');
    if (u.state === 'failed' || u.state === 'expired') return out('failed', u.state);
    if (this.#verifying.has(u.id)) return out('failed', 'verification_running');
    this.#verifying.add(u.id);
    try {
      await this.deps.pool.query(`UPDATE blob_uploads SET state = 'verifying' WHERE id = $1`, [u.id]);
      if (u.location === 'local') {
        const count = (u.parts ?? []).length;
        if (count <= 1) {
          // A single PUT is verified by the endpoint while it writes; still `granted` here means it never arrived.
          await this.deps.pool.query(`UPDATE blob_uploads SET state = 'granted' WHERE id = $1`, [u.id]);
          return out('failed', 'not_received');
        }
        const present = await this.deps.blobs.local.partsPresent(u.id, count);
        if (present.length !== count) {
          await this.deps.pool.query(`UPDATE blob_uploads SET state = 'granted' WHERE id = $1`, [u.id]);
          return out('failed', 'parts_missing');
        }
        const r = await this.deps.blobs.local.assemble(
          u.key,
          u.id,
          count,
          { size: Number(u.size_bytes), sha256: u.sha256 },
          (head) => magicOk(head, u.media_type, Number(u.size_bytes)),
        );
        if (!r.accepted) {
          return await this.#fail(
            workerId,
            u,
            r.size !== Number(u.size_bytes)
              ? 'size_mismatch'
              : r.sha256 !== u.sha256
                ? 'sha256_mismatch'
                : 'content_type',
            r.size,
          );
        }
        return await this.#settle(
          workerId,
          u,
          { sha256: r.sha256, size: r.size, head: Buffer.alloc(0) },
          true,
        );
      }
      const s3 = await this.deps.blobs.activeS3();
      if (s3 === null) return await this.#fail(workerId, u, 'store_unavailable');
      if (u.multipart_id !== null) {
        const expected = (u.parts ?? []).length;
        const parts = p.parts ?? [];
        if (parts.length !== expected || parts.some((x, i) => x.n !== i + 1)) {
          return await this.#fail(workerId, u, 'parts_mismatch');
        }
        try {
          await s3.client.completeMultipart(u.key, u.multipart_id, parts);
        } catch (err) {
          this.deps.log.warn({ err, uploadId: u.id }, 'blob upload: completing the multipart upload failed');
          return await this.#fail(workerId, u, 'complete_failed');
        }
      }
      // Read back and hash what is stored (works on every provider; in-region / R2 reads cost no egress).
      let got: { sha256: string; size: number; head: Buffer };
      try {
        const obj = await s3.client.stream(u.key);
        got = await hashStream(obj.stream, Number(u.size_bytes));
      } catch (err) {
        if (err instanceof S3Error && err.code === 'TooLarge')
          return await this.#fail(workerId, u, 'size_mismatch');
        if (err instanceof S3Error && err.status === 404)
          return await this.#fail(workerId, u, 'not_received');
        throw err;
      }
      return await this.#settle(workerId, u, got);
    } finally {
      this.#verifying.delete(u.id);
    }
  }

  async #settle(
    workerId: string,
    u: UploadRow,
    got: { sha256: string; size: number; head: Buffer },
    magicChecked = false,
  ): Promise<Omit<BlobUploadStatusPayload, 'attemptId' | 'epoch' | 'requestId'>> {
    if (got.size !== Number(u.size_bytes)) return this.#fail(workerId, u, 'size_mismatch', got.size);
    if (got.sha256 !== u.sha256) return this.#fail(workerId, u, 'sha256_mismatch', got.size);
    if (!magicChecked && !magicOk(got.head, u.media_type, got.size)) {
      return this.#fail(workerId, u, 'content_type', got.size);
    }
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE blob_uploads SET state = 'verified', verified_at = $2, token_hash = NULL WHERE id = $1`,
      [u.id, now],
    );
    await this.deps.pool.query('UPDATE blob_objects SET verified_at = $2 WHERE key = $1', [u.key, now]);
    await this.deps.audit.record({
      actor: { type: 'worker', id: workerId },
      action: 'blob.upload.verify',
      target: `job:${u.job_id}`,
      outcome: 'success',
      metadata: { uploadId: u.id, artifactId: u.artifact_id, sizeBytes: got.size, location: u.location },
    });
    return { uploadId: u.id, status: 'verified' };
  }

  async #fail(
    workerId: string,
    u: UploadRow,
    reason: string,
    sizeBytes?: number,
  ): Promise<Omit<BlobUploadStatusPayload, 'attemptId' | 'epoch' | 'requestId'>> {
    await this.deps.pool.query(`UPDATE blob_uploads SET state = 'failed', reason = $2 WHERE id = $1`, [
      u.id,
      reason,
    ]);
    await this.deps.audit.record({
      actor: { type: 'worker', id: workerId },
      action: 'blob.upload.verify',
      target: `job:${u.job_id}`,
      outcome: 'failure',
      metadata: { uploadId: u.id, artifactId: u.artifact_id, reason, sizeBytes: sizeBytes ?? null },
    });
    return { uploadId: u.id, status: 'failed', reason, ...(sizeBytes === undefined ? {} : { sizeBytes }) };
  }

  /**
   * The local-disk endpoint: `PUT /v1/worker/blobs/:id` (the whole file) or `PUT /v1/worker/blobs/:id/:n` (part n of
   * an upload in parts) with the grant's one-time bearer token. Streams to a temporary file, counting and hashing;
   * keeps it only for the declared size + SHA-256 (and, for a whole file, the magic bytes). Each part is one request,
   * so a large upload never runs into the master's (or the proxy's) request timeout.
   */
  async receive(
    id: string,
    token: string,
    body: Readable,
    contentLength: number | null,
    part?: number,
  ): Promise<{ status: 204 | 400 | 401 | 409 | 413; reason?: string }> {
    const now = this.deps.clock();
    const hash = createHash('sha256').update(token).digest();
    const { rows } = await this.deps.pool.query<UploadRow>(
      `SELECT * FROM blob_uploads WHERE id = $1 AND token_hash = $2 AND location = 'local'`,
      [id, hash],
    );
    const u = rows[0];
    if (u === undefined || u.expires_at.getTime() < now.getTime()) return { status: 401, reason: 'token' };
    if (u.state !== 'granted') return { status: 409, reason: u.state };
    const parts = u.parts ?? [];
    if (part !== undefined || parts.length > 1) {
      const spec = part === undefined ? undefined : parts[part - 1];
      if (spec === undefined) return { status: 400, reason: 'part' };
      if (contentLength !== null && contentLength !== spec.sizeBytes)
        return { status: 400, reason: 'content_length' };
      const r = await this.deps.blobs.local.putPart(u.id, part ?? 0, body, spec.sizeBytes, spec.sha256);
      return r.accepted
        ? { status: 204 }
        : { status: r.size > spec.sizeBytes ? 413 : 400, reason: 'part_mismatch' };
    }
    const size = Number(u.size_bytes);
    if (contentLength !== null && contentLength !== size) return { status: 400, reason: 'content_length' };
    const r = await this.deps.blobs.local.putStream(u.key, body, size, (gotSize, sha, head) => {
      return gotSize === size && sha === u.sha256 && magicOk(head, u.media_type, gotSize);
    });
    if (!r.accepted) {
      const reason = r.size !== size ? 'size_mismatch' : 'sha256_mismatch';
      // A short body (interrupted transfer) may be retried with the same grant; a wrong or long one fails it.
      if (r.size >= size) await this.#fail(u.worker_id, u, reason, r.size);
      return { status: r.size > size ? 413 : 400, reason };
    }
    await this.#settle(u.worker_id, u, { sha256: r.sha256, size: r.size, head: r.head });
    return { status: 204 };
  }

  /**
   * ARTIFACT_REF `blobUploadId` (inside the inbox transaction): the verified upload of this attempt + artifact with
   * the claimed name, type, size and SHA-256 becomes the job's artifact (`blob_key`). Idempotent.
   */
  async commit(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      blobUploadId: string;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'quota'> {
    const done = await tx.query('SELECT 1 FROM job_artifacts WHERE attempt_id = $1 AND artifact_id = $2', [
      p.attemptId,
      p.artifactId,
    ]);
    if ((done.rowCount ?? 0) > 0) return 'ok';
    const { rows } = await tx.query<UploadRow>(
      `SELECT * FROM blob_uploads WHERE id = $1 AND job_id = $2 AND attempt_id = $3 AND artifact_id = $4 FOR UPDATE`,
      [p.blobUploadId, jobId, p.attemptId, p.artifactId],
    );
    const u = rows[0];
    if (u === undefined) return 'invalid';
    if (
      u.name !== p.name ||
      u.media_type !== p.mediaType ||
      Number(u.size_bytes) !== p.sizeBytes ||
      u.sha256 !== p.sha256
    ) {
      return 'invalid';
    }
    if (u.state !== 'verified' && u.state !== 'committed')
      return u.state === 'failed' || u.state === 'expired' ? 'invalid' : 'incomplete';
    const owner = await tx.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [jobId]);
    try {
      await reserveStorage(tx, owner.rows[0]?.project ?? '', p.sizeBytes, now, this.deps.audit);
    } catch (err) {
      if (err instanceof StorageQuotaError) return 'quota';
      throw err;
    }
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, NULL, $8, $9)
       ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [p.attemptId, jobId, p.artifactId, p.name, p.mediaType, p.sizeBytes, p.sha256, u.key, now],
    );
    await tx.query(`UPDATE blob_uploads SET state = 'committed', committed_at = $2 WHERE id = $1`, [
      u.id,
      now,
    ]);
    return 'ok';
  }
}

/** Magic bytes of binary types (the first 64 bytes); text types are not checked here (the worker scanned them). */
export function magicOk(head: Buffer, mediaType: string, size: number): boolean {
  if (size === 0) return true;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return true;
  return contentMatchesType(head, mediaType);
}
