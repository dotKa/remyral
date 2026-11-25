import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import {
  type AssignedBlobUpload,
  type BlobPart,
  type BlobUploadCompletePayload,
  type BlobUploadGrantPayload,
  type BlobUploadRequestPayload,
  type BlobUploadStatusPayload,
  blobUrlAllowed,
} from '@remyral/protocol';
import { masterOrigin } from '../update/download.js';

/**
 * p17-object-storage (docs/design/p17-object-storage.md §4): the worker side of a large output's upload. The file is
 * hashed (whole + per part) in one pass, the master grants an upload for exactly that size and SHA-256, the worker
 * PUTs the bytes — streamed from disk, one request per part — to the presigned object-store URL(s) or to the master's
 * own endpoint (one-time bearer token), reports BLOB_UPLOAD_COMPLETE and waits for the master's own verification.
 * The worker never holds storage credentials; a URL outside https (or http to loopback) is refused, and a master
 * target must be a path below `/v1/worker/blobs/` of the master's own origin.
 */

export const MASTER_BLOB_PATH = '/v1/worker/blobs/';

export class BlobUploadError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BlobUploadError';
  }
}

/** One PUT of `size` bytes of `path` from `start`; resolves with the response's ETag (multipart needs it). */
export type BlobPut = (
  target: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
  kind: 'master' | 'object-store',
  file: { readonly path: string; readonly start: number; readonly size: number },
) => Promise<{ readonly etag: string | null }>;

/** Whole-file SHA-256 and the part hashes (`partBytes` each, the last one shorter) in one pass, never following links. */
export async function hashFile(
  path: string,
  size: number,
  partBytes: number,
): Promise<{ sha256: string; parts: BlobPart[] }> {
  const fh = await open(path, constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== size) throw new BlobUploadError('file_changed');
    const whole = createHash('sha256');
    const parts: BlobPart[] = [];
    let part = createHash('sha256');
    let inPart = 0;
    const buf = Buffer.alloc(1024 * 1024);
    for (let at = 0; at < size;) {
      const want = Math.min(buf.length, size - at, partBytes - inPart);
      const { bytesRead } = await fh.read(buf, 0, want, at);
      if (bytesRead === 0) throw new BlobUploadError('file_changed');
      const chunk = buf.subarray(0, bytesRead);
      whole.update(chunk);
      part.update(chunk);
      inPart += bytesRead;
      at += bytesRead;
      if (inPart === partBytes || at === size) {
        parts.push({ sizeBytes: inPart, sha256: part.digest('hex') });
        part = createHash('sha256');
        inPart = 0;
      }
    }
    return { sha256: whole.digest('hex'), parts };
  } finally {
    await fh.close();
  }
}

export interface HttpBlobPutOptions {
  readonly masterUrl: string;
  readonly workerVersion: string;
  /** Extra trusted CA (tests); production uses the default trust store. */
  readonly ca?: string | Buffer;
  /** Socket inactivity timeout per request (default 120 s). */
  readonly timeoutMs?: number;
}

/**
 * PUTs with TLS verification (never configurable), no redirects, a streamed body from disk with the exact
 * `content-length`, and the grant's headers (only `authorization` toward the master).
 */
export function httpBlobPut(opts: HttpBlobPutOptions): BlobPut {
  const origin = masterOrigin(opts.masterUrl);
  return (target, kind, file) =>
    new Promise((resolve, reject) => {
      let url: URL;
      if (kind === 'master') {
        if (!target.url.startsWith(MASTER_BLOB_PATH)) {
          reject(new BlobUploadError('bad_url'));
          return;
        }
        url = new URL(target.url, origin);
        if (url.origin !== origin.origin) {
          reject(new BlobUploadError('bad_url'));
          return;
        }
      } else {
        if (!blobUrlAllowed(target.url)) {
          reject(new BlobUploadError('bad_url'));
          return;
        }
        url = new URL(target.url);
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(target.headers)) {
        // A presigned object-store URL needs no authorization header; a stray one is never sent there.
        if (k === 'authorization' && kind !== 'master') continue;
        headers[k] = v;
      }
      headers['content-length'] = String(file.size);
      headers['user-agent'] = `remyral-worker/${opts.workerVersion}`;
      const onResponse = (res: http.IncomingMessage): void => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new BlobUploadError(`http_${String(status)}`));
          return;
        }
        const etag = res.headers.etag;
        resolve({ etag: typeof etag === 'string' ? etag : null });
      };
      const req =
        url.protocol === 'https:'
          ? https.request(
              url,
              {
                method: 'PUT',
                headers,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.2',
                ...(opts.ca === undefined ? {} : { ca: opts.ca }),
              },
              onResponse,
            )
          : http.request(url, { method: 'PUT', headers }, onResponse);
      req.setTimeout(opts.timeoutMs ?? 120_000, () => {
        req.destroy(new BlobUploadError('timeout'));
      });
      req.on('error', (err) => {
        reject(err instanceof BlobUploadError ? err : new BlobUploadError('network'));
      });
      if (file.size === 0) {
        req.end();
        return;
      }
      const body = createReadStream(file.path, { start: file.start, end: file.start + file.size - 1 });
      body.on('error', (err) => {
        req.destroy(err);
      });
      body.pipe(req);
    });
}

export interface BlobUploadPort {
  request(
    p: Omit<BlobUploadRequestPayload, 'attemptId' | 'epoch' | 'requestId'>,
  ): Promise<BlobUploadGrantPayload | null>;
  complete(
    p: Omit<BlobUploadCompletePayload, 'attemptId' | 'epoch' | 'requestId'>,
  ): Promise<BlobUploadStatusPayload | null>;
  put: BlobPut;
}

/** PUT with up to `tries` attempts on transport errors and 5xx answers (a 4xx is final). */
async function putWithRetry(
  put: BlobPut,
  target: { url: string; headers: Record<string, string> },
  kind: 'master' | 'object-store',
  file: { path: string; start: number; size: number },
  tries = 3,
): Promise<{ etag: string | null }> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await put(target, kind, file);
    } catch (err) {
      last = err;
      const reason = err instanceof BlobUploadError ? err.reason : 'network';
      if (/^http_4\d\d$/.test(reason) || reason === 'bad_url') break;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last instanceof BlobUploadError ? last : new BlobUploadError('network');
}

/**
 * Uploads one large output: hash, grant, PUT(s), COMPLETE, the master's verification. Returns the upload id for the
 * ARTIFACT_REF, or throws BlobUploadError with the reason (written into the summary as "not returned").
 */
export async function uploadBigFile(
  port: BlobUploadPort,
  file: {
    readonly artifactId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly path: string;
    readonly size: number;
  },
  blob: AssignedBlobUpload,
): Promise<{ uploadId: string; sha256: string }> {
  const hashed = await hashFile(file.path, file.size, blob.partBytes);
  const grant = await port.request({
    artifactId: file.artifactId,
    name: file.name,
    mediaType: file.mediaType,
    sizeBytes: file.size,
    sha256: hashed.sha256,
    ...(hashed.parts.length > 1 ? { parts: hashed.parts } : {}),
  });
  if (grant === null) throw new BlobUploadError('no_answer');
  if (grant.status !== 'ok' || grant.uploadId === undefined || grant.target === undefined) {
    throw new BlobUploadError(`refused_${grant.reason ?? 'unknown'}`);
  }
  const kind = grant.target;
  const etags: { n: number; etag: string }[] = [];
  if (grant.parts !== undefined && grant.parts.length > 0) {
    if (grant.parts.length !== hashed.parts.length) throw new BlobUploadError('grant_parts_mismatch');
    let start = 0;
    for (const [i, part] of hashed.parts.entries()) {
      const t = grant.parts[i];
      if (t?.n !== i + 1) throw new BlobUploadError('grant_parts_mismatch');
      const r = await putWithRetry(port.put, { url: t.url, headers: { ...t.headers } }, kind, {
        path: file.path,
        start,
        size: part.sizeBytes,
      });
      etags.push({ n: i + 1, etag: r.etag ?? '' });
      start += part.sizeBytes;
    }
  } else if (grant.put !== undefined) {
    await putWithRetry(port.put, { url: grant.put.url, headers: { ...grant.put.headers } }, kind, {
      path: file.path,
      start: 0,
      size: file.size,
    });
  }
  // (No put and no parts: the master already holds this exact file — a retry after a crash.)
  const objectStoreParts = kind === 'object-store' && etags.length > 0;
  if (objectStoreParts && etags.some((e) => e.etag === '')) throw new BlobUploadError('no_etag');
  const status = await port.complete({
    uploadId: grant.uploadId,
    ...(objectStoreParts ? { parts: etags } : {}),
  });
  if (status === null) throw new BlobUploadError('verification_timeout');
  if (status.status !== 'verified')
    throw new BlobUploadError(`not_verified_${status.reason ?? status.status}`);
  return { uploadId: grant.uploadId, sha256: hashed.sha256 };
}
