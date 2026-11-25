import { z } from 'zod';
import { AttemptId, Epoch, NonNegativeInt, Sha256Hex } from './common.js';
import { OUTPUT_LIMITS } from './output-limits.js';

/**
 * p17-object-storage (docs/design/p17-object-storage.md, ADR-0064): large workspace outputs go straight to the
 * master's blob store (S3-compatible object storage, or the master's local disk) instead of through the WebSocket in
 * ARTIFACT_CHUNKs. Feature `blob-upload-v1`; every message below is a control job message (seq 0, never in a durable
 * outbox), fenced by the attempt's live lease.
 *
 *   ASSIGN_JOB execution.blobUpload {thresholdBytes, maxFileBytes, maxJobBytes, maxFiles, partBytes}
 *   BLOB_UPLOAD_REQUEST  {attemptId, epoch, requestId, artifactId, name, mediaType, sizeBytes, sha256, parts?}  w → m
 *   BLOB_UPLOAD_GRANT    {attemptId, epoch, requestId, status, uploadId, target, put | parts, expiresAt}       m → w
 *   (the worker PUTs the bytes — one PUT up to `partBytes`, else one PUT per part — to presigned object-store URLs, or
 *   to the master's upload endpoint with a one-time token)
 *   BLOB_UPLOAD_COMPLETE {attemptId, epoch, requestId, uploadId, parts?: [{n, etag}]}                          w → m
 *   BLOB_UPLOAD_STATUS   {attemptId, epoch, requestId, uploadId, status: verified | failed | refused, reason}  m → w
 *   ARTIFACT_REF {…, blobUploadId}   (sequenced, as before) commits the verified upload as the job's artifact.
 *
 * The master issues a grant for exactly one key, one size and one SHA-256 (object store: the signed headers bind
 * `content-length` and `x-amz-checksum-sha256`; local disk: the endpoint counts and hashes while it writes) and
 * verifies size + SHA-256 itself before it reports `verified`. Workers never receive storage credentials. Older
 * workers (no feature) never get `execution.blobUpload` and keep the chunk path; older masters never send it, so a
 * newer worker keeps the chunk path with them.
 */

export const BLOB_UPLOAD_FEATURE = 'blob-upload-v1';

export const BLOB_LIMITS = {
  /** Highest per-file limit the owner can configure (2 GiB − 1 B: job_artifacts.size_bytes is a 32-bit integer). */
  ceilingFileBytes: 2 * 1024 * 1024 * 1024 - 1,
  /** Default per-file limit (owner-configurable, Settings → Integrations → Storage). */
  defaultFileBytes: 2 * 1024 * 1024 * 1024 - 1,
  /** Default per-job total of blob uploads. */
  defaultJobBytes: 5 * 1024 * 1024 * 1024,
  /** Highest per-job total the owner can configure. */
  ceilingJobBytes: 64 * 1024 * 1024 * 1024,
  /** Files at or above this size go to the blob store (smaller ones keep the chunk path, then land in the store). */
  defaultThresholdBytes: 4 * 1024 * 1024,
  /**
   * Part size of an upload in parts to object storage (S3: ≥ 5 MiB except the last part, ≤ 10 000 parts). A file larger
   * than the assignment's `partBytes` is always uploaded in parts; a smaller one with one PUT.
   */
  partBytes: 64 * 1024 * 1024,
  /** Part size towards the master's own endpoint (each part is one request, well inside its request timeout). */
  localPartBytes: 8 * 1024 * 1024,
  maxParts: 1000,
  /**
   * Blob uploads one attempt of a worker without `output-limits-v1` may make (p17-output-limits: newer workers get the
   * job's output file limit instead, up to {@link OUTPUT_LIMITS.ceilingMaxFiles}).
   */
  maxFiles: 20,
} as const;

/** ASSIGN_JOB `execution.blobUpload` (only to `blob-upload-v1` workers; workspace jobs). */
export const AssignedBlobUpload = z.object({
  /** Files of at least this many bytes (and every `large` type) use the blob path. */
  thresholdBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .max(BLOB_LIMITS.ceilingFileBytes),
  maxFileBytes: z.number().int().min(1).max(BLOB_LIMITS.ceilingFileBytes),
  maxJobBytes: z.number().int().min(1).max(BLOB_LIMITS.ceilingJobBytes),
  /**
   * p17-output-limits: up to the output-file ceiling — but only `output-limits-v1` workers get more than
   * {@link BLOB_LIMITS.maxFiles} (older workers' schema stops at 20).
   */
  maxFiles: z.number().int().min(1).max(OUTPUT_LIMITS.ceilingMaxFiles),
  partBytes: z
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .max(512 * 1024 * 1024),
});
export type AssignedBlobUpload = z.infer<typeof AssignedBlobUpload>;

export const BlobPart = z.object({
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024 * 1024),
  sha256: Sha256Hex,
});
export type BlobPart = z.infer<typeof BlobPart>;

/** worker → master `BLOB_UPLOAD_REQUEST`. `parts`: the part sizes + hashes when the file is uploaded in parts. */
export const BlobUploadRequestPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  artifactId: z.string().regex(/^ws-[a-z0-9-]{1,100}$/),
  name: z.string().min(1).max(255),
  mediaType: z.string().regex(/^[a-z]+\/[A-Za-z0-9.+-]+$/),
  sizeBytes: z.number().int().min(0).max(BLOB_LIMITS.ceilingFileBytes),
  sha256: Sha256Hex,
  parts: z.array(BlobPart).min(1).max(BLOB_LIMITS.maxParts).optional(),
});
export type BlobUploadRequestPayload = z.infer<typeof BlobUploadRequestPayload>;

/** Header names a grant may tell the worker to send (lower-case). */
export const BlobHeaderName = z.string().regex(/^(authorization|content-type|x-amz-[a-z0-9-]{1,60})$/);
const Headers = z.record(BlobHeaderName, z.string().max(2048));

export const BlobPutTarget = z.object({
  /** object-store: an absolute https URL (http only to loopback); master: a path below `/v1/worker/blobs/`. */
  url: z.string().min(1).max(8192),
  headers: Headers,
});
export type BlobPutTarget = z.infer<typeof BlobPutTarget>;

export const BlobRefusal = z.enum([
  'too_large',
  'job_limit',
  'quota',
  'type_not_allowed',
  'not_configured',
  'unavailable',
  'stale',
  'invalid',
]);
export type BlobRefusal = z.infer<typeof BlobRefusal>;

/** master → worker `BLOB_UPLOAD_GRANT` (the answer to one BLOB_UPLOAD_REQUEST). */
export const BlobUploadGrantPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  status: z.enum(['ok', 'refused']),
  reason: BlobRefusal.optional(),
  uploadId: z.uuid().optional(),
  target: z.enum(['object-store', 'master']).optional(),
  /** A single PUT of the whole file. */
  put: BlobPutTarget.optional(),
  /** Multipart: one PUT per part (n from 1), in the order of the request's `parts`. */
  parts: z
    .array(BlobPutTarget.extend({ n: z.number().int().min(1).max(BLOB_LIMITS.maxParts) }))
    .max(BLOB_LIMITS.maxParts)
    .optional(),
  expiresAt: z.iso.datetime({ precision: 3 }).optional(),
});
export type BlobUploadGrantPayload = z.infer<typeof BlobUploadGrantPayload>;

/** worker → master `BLOB_UPLOAD_COMPLETE` (after the PUTs; multipart: the ETag of every part). */
export const BlobUploadCompletePayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  uploadId: z.uuid(),
  parts: z
    .array(
      z.object({
        n: z.number().int().min(1).max(BLOB_LIMITS.maxParts),
        etag: z.string().min(1).max(200),
      }),
    )
    .max(BLOB_LIMITS.maxParts)
    .optional(),
});
export type BlobUploadCompletePayload = z.infer<typeof BlobUploadCompletePayload>;

/** master → worker `BLOB_UPLOAD_STATUS`: the master checked size + SHA-256 (`verified`) or not. */
export const BlobUploadStatusPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  uploadId: z.uuid(),
  status: z.enum(['verified', 'failed', 'refused']),
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  /** Bytes the master found (on `failed`). */
  sizeBytes: NonNegativeInt.optional(),
});
export type BlobUploadStatusPayload = z.infer<typeof BlobUploadStatusPayload>;

/** Number of parts for a file of `size` bytes uploaded in `partBytes` parts (0 for an empty file). */
export function blobPartCount(size: number, partBytes: number): number {
  return Math.ceil(size / partBytes);
}

/** True when a grant URL may be used by the worker: https, or http to a loopback host (tests, local MinIO). */
export function blobUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}
