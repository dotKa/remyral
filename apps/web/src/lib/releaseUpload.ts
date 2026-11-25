import { ApiError } from '../api/client';
import {
  completeReleaseUpload,
  getReleaseUpload,
  putReleaseUploadPart,
  type ReleaseInfo,
  type ReleaseUploadInfo,
  startReleaseUpload,
} from '../api/releases';

/**
 * Chunked, resumable upload of a signed `release.json` (p6-release-upload; master routes
 * `/releases/uploads/*`). The file is hashed, started, sent in parts with their SHA-256 (each part retried
 * on transient failures), then completed — the master checks the whole-document hash and verifies the
 * release exactly like a direct upload. Pure logic with injectable I/O, so the component stays thin.
 */

/** 2 MiB parts: smooth progress and well inside the master's per-request time limit on slow links. */
export const RELEASE_PART_SIZE = 2 * 1024 * 1024;
/** The master's cap for one release document (RELEASE_UPLOAD_BODY_LIMIT). */
export const RELEASE_MAX_BYTES = 48 * 1024 * 1024;
/** Attempts per part (first try + retries). */
export const PART_ATTEMPTS = 4;

export class UploadCancelledError extends Error {
  override readonly name = 'UploadCancelledError';
  constructor() {
    super('The upload was cancelled.');
  }
}

export interface UploadProgress {
  readonly phase: 'hashing' | 'uploading' | 'verifying';
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly partsDone: number;
  readonly partCount: number;
  /** Set while a part is being retried after a transient failure. */
  readonly retry: { part: number; attempt: number } | null;
}

export interface UploadApi {
  start: typeof startReleaseUpload;
  status: typeof getReleaseUpload;
  putPart: typeof putReleaseUploadPart;
  complete: typeof completeReleaseUpload;
}

export interface UploadOptions {
  readonly partSize?: number;
  readonly onProgress?: (p: UploadProgress) => void;
  /** Called with the upload id as soon as it exists (to resume or cancel it later). */
  readonly onStarted?: (id: string) => void;
  readonly signal?: AbortSignal;
  /** Resume this upload instead of starting a new one (sends only the parts the master lacks). */
  readonly resumeId?: string | null;
  /** Wraps the step-up guarded calls (start, complete): StepUpProvider.run. */
  readonly guard?: <T>(action: () => Promise<T>) => Promise<T>;
  readonly api?: UploadApi;
  readonly digest?: (data: ArrayBuffer) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_API: UploadApi = {
  start: startReleaseUpload,
  status: getReleaseUpload,
  putPart: putReleaseUploadPart,
  complete: completeReleaseUpload,
};

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read a Blob into memory (Blob.arrayBuffer where available, FileReader otherwise). */
export function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      resolve(r.result as ArrayBuffer);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('read failed'));
    };
    r.readAsArrayBuffer(blob);
  });
}

/** The byte ranges of the parts: every part is `partSize` bytes except a shorter last one. */
export function partRanges(totalBytes: number, partSize: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < totalBytes; start += partSize) {
    out.push({ start, end: Math.min(start + partSize, totalBytes) });
  }
  return out;
}

/** Network errors, 408/429/5xx and a part that arrived corrupted are worth another try. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500) return true;
  return err.code === 'part_checksum_mismatch';
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function uploadReleaseInParts(file: Blob, opts: UploadOptions = {}): Promise<ReleaseInfo> {
  const api = opts.api ?? DEFAULT_API;
  const digest = opts.digest ?? sha256Hex;
  const sleep = opts.sleep ?? defaultSleep;
  const guard = opts.guard ?? (<T>(a: () => Promise<T>) => a());
  const signal = opts.signal;
  const partSize = opts.partSize ?? RELEASE_PART_SIZE;
  const checkCancelled = () => {
    if (signal?.aborted === true) throw new UploadCancelledError();
  };
  const report = (p: Omit<UploadProgress, 'totalBytes'>) => {
    opts.onProgress?.({ ...p, totalBytes: file.size });
  };
  const net = signal === undefined ? {} : { signal };

  report({ phase: 'hashing', sentBytes: 0, partsDone: 0, partCount: 0, retry: null });
  let upload: ReleaseUploadInfo | null = null;
  if (opts.resumeId) {
    try {
      upload = await api.status(opts.resumeId, net);
    } catch (err) {
      // Expired or already consumed on the master: start over with the same file.
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 410))) throw err;
    }
  }
  if (upload === null) {
    const sha256 = await digest(await readBlob(file));
    checkCancelled();
    upload = await guard(() => api.start({ totalBytes: file.size, sha256, partSize }, net));
  }
  const id = upload.id;
  opts.onStarted?.(upload.id);
  const ranges = partRanges(file.size, upload.partSize);
  const have = new Set(upload.received);
  let sent = ranges.filter((_, n) => have.has(n)).reduce((a, r) => a + (r.end - r.start), 0);
  let done = have.size;
  report({ phase: 'uploading', sentBytes: sent, partsDone: done, partCount: ranges.length, retry: null });

  for (const [n, r] of ranges.entries()) {
    if (have.has(n)) continue;
    checkCancelled();
    const bytes = await readBlob(file.slice(r.start, r.end));
    const hash = await digest(bytes);
    for (let attempt = 1; ; attempt++) {
      checkCancelled();
      try {
        await api.putPart(id, n, bytes, hash, net);
        break;
      } catch (err) {
        if (signal?.aborted === true) throw new UploadCancelledError();
        if (!isTransient(err) || attempt >= PART_ATTEMPTS) throw err;
        report({
          phase: 'uploading',
          sentBytes: sent,
          partsDone: done,
          partCount: ranges.length,
          retry: { part: n, attempt: attempt + 1 },
        });
        await sleep(500 * 3 ** (attempt - 1));
      }
    }
    sent += r.end - r.start;
    done += 1;
    report({ phase: 'uploading', sentBytes: sent, partsDone: done, partCount: ranges.length, retry: null });
  }
  checkCancelled();
  report({ phase: 'verifying', sentBytes: sent, partsDone: done, partCount: ranges.length, retry: null });
  return guard(() => api.complete(id, net));
}
