import { SITE_UPLOAD_LIMITS, siteFileType, sitePathProblem } from '@remyral/protocol/site-files';
import {
  completeSiteUpload,
  getSiteUpload,
  putSiteUploadPart,
  type SiteUpload,
  startSiteUpload,
} from '../api/siteUploads';
import {
  isTransient,
  PART_ATTEMPTS,
  partRanges,
  readBlob,
  sha256Hex,
  UploadCancelledError,
} from './releaseUpload';

/**
 * p10-site-upload: everything "Upload a site" does before and while sending — pure logic with injectable I/O.
 *
 *  1. collect the picked files (a folder via `webkitdirectory`, or the entries of a .zip read in the browser);
 *  2. drop the one top folder every file shares (the picked folder / the folder inside the zip), skip OS litter
 *     (`.DS_Store`, `Thumbs.db`, `__MACOSX/`), and apply the master's rules (the same `@remyral/protocol/site-files`
 *     code): refused files are listed with the reason before anything is sent;
 *  3. hash each file (SHA-256), start the upload with the file list, send the concatenated bytes in parts of
 *     ≤ 4 MiB (each with its SHA-256, retried on transient failures; a resumed upload sends only missing parts),
 *     complete — the master then checks every file again (hash, magic bytes, secret scan).
 */

export interface SiteFile {
  readonly path: string;
  readonly size: number;
  readonly blob: Blob;
}

export interface SitePlan {
  readonly files: readonly SiteFile[];
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  /** OS litter that is left out silently (shown as a count). */
  readonly skipped: number;
  readonly totalBytes: number;
  /** The shared top folder that was removed, if any. */
  readonly strippedRoot: string | null;
  /** Problems with the site as a whole (no index.html, too many files, too large). */
  readonly problems: readonly string[];
}

const LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Builds the upload plan from picked files (`path` relative, `/`-separated). A single top folder shared by every
 * file is removed so that `index.html` lands at the site root.
 */
export function planSite(input: readonly { path: string; blob: Blob }[]): SitePlan {
  let skipped = 0;
  const kept = input.filter((f) => {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1);
    if (LITTER.has(base) || f.path.startsWith('__MACOSX/')) {
      skipped += 1;
      return false;
    }
    return true;
  });
  let strippedRoot: string | null = null;
  const firsts = new Set(kept.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '')));
  const only = firsts.size === 1 ? [...firsts][0] : undefined;
  if (only !== undefined && only !== '' && kept.length > 0) strippedRoot = only;
  const files: SiteFile[] = [];
  const refused: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const f of kept) {
    const path = strippedRoot === null ? f.path : f.path.slice(strippedRoot.length + 1);
    const problem = sitePathProblem(path);
    if (problem !== null) refused.push({ path, reason: problem });
    else if (f.blob.size > SITE_UPLOAD_LIMITS.maxFileBytes)
      refused.push({
        path,
        reason: `larger than ${String(SITE_UPLOAD_LIMITS.maxFileBytes / 1024 / 1024)} MiB`,
      });
    else if (seen.has(path)) refused.push({ path, reason: 'listed twice' });
    else {
      seen.add(path);
      files.push({ path, size: f.blob.size, blob: f.blob });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const problems: string[] = [];
  if (files.length === 0) problems.push('No site files were found.');
  else if (!seen.has('index.html')) problems.push('The site has no index.html at its root.');
  if (files.length > SITE_UPLOAD_LIMITS.maxFiles) {
    problems.push(`More than ${String(SITE_UPLOAD_LIMITS.maxFiles)} files (${String(files.length)}).`);
  }
  if (totalBytes > SITE_UPLOAD_LIMITS.maxTotalBytes) {
    problems.push(`The site is larger than ${String(SITE_UPLOAD_LIMITS.maxTotalBytes / 1024 / 1024)} MiB.`);
  }
  return { files, refused, skipped, totalBytes, strippedRoot, problems };
}

/** The files of a folder picked with `webkitdirectory` (their `webkitRelativePath` includes the folder name). */
export function folderInput(list: FileList | readonly File[]): { path: string; blob: Blob }[] {
  return Array.from(list).map((f) => ({
    path: (f.webkitRelativePath || f.name).replace(/^\/+/, ''),
    blob: f,
  }));
}

/** Whether a file is a site file type (for the list's type column). */
export function typeOf(path: string): string {
  return siteFileType(path) ?? '—';
}

export interface SiteUploadProgress {
  readonly phase: 'hashing' | 'uploading' | 'checking';
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly retry: { part: number; attempt: number } | null;
}

export interface SiteUploadApi {
  start: typeof startSiteUpload;
  status: typeof getSiteUpload;
  putPart: typeof putSiteUploadPart;
  complete: typeof completeSiteUpload;
}

const DEFAULT_API: SiteUploadApi = {
  start: startSiteUpload,
  status: getSiteUpload,
  putPart: putSiteUploadPart,
  complete: completeSiteUpload,
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** What a chunked upload's API answers (site uploads, p16-zip-job-input input bundles). */
export interface ChunkedUpload {
  readonly id: string;
  readonly partSize: number;
  readonly received: readonly number[] | null;
}

/** The four calls of a chunked upload (start with the file list, status to resume, parts, complete). */
export interface ChunkedUploadApi<U extends ChunkedUpload> {
  start(
    project: string,
    input: { files: { path: string; size: number; sha256: string }[]; label?: string; partSize?: number },
    opts: { signal?: AbortSignal },
  ): Promise<U>;
  status(project: string, id: string, opts: { signal?: AbortSignal }): Promise<U>;
  putPart(
    project: string,
    id: string,
    n: number,
    bytes: ArrayBuffer,
    sha256: string,
    opts: { signal?: AbortSignal },
  ): Promise<unknown>;
  complete(project: string, id: string, opts: { signal?: AbortSignal }): Promise<U>;
}

export interface ChunkedUploadOptions {
  readonly label?: string;
  readonly partSize?: number;
  readonly onProgress?: (p: SiteUploadProgress) => void;
  readonly onStarted?: (id: string) => void;
  readonly resumeId?: string | null;
  readonly signal?: AbortSignal;
  readonly digest?: (data: ArrayBuffer) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function uploadSite(
  project: string,
  files: readonly SiteFile[],
  opts: ChunkedUploadOptions & { readonly api?: SiteUploadApi } = {},
): Promise<SiteUpload> {
  return uploadChunked(project, files, opts.api ?? DEFAULT_API, opts);
}

/**
 * Hashes the files, starts the upload (or resumes `resumeId`), sends the concatenated bytes in parts (each with its
 * SHA-256, retried on transient failures; parts the master holds are skipped) and completes it.
 */
export async function uploadChunked<U extends ChunkedUpload>(
  project: string,
  files: readonly SiteFile[],
  api: ChunkedUploadApi<U>,
  opts: ChunkedUploadOptions = {},
): Promise<U> {
  const digest = opts.digest ?? sha256Hex;
  const sleep = opts.sleep ?? defaultSleep;
  const signal = opts.signal;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const check = () => {
    if (signal?.aborted === true) throw new UploadCancelledError();
  };
  const report = (p: Omit<SiteUploadProgress, 'totalBytes'>) => opts.onProgress?.({ ...p, totalBytes });
  const call = signal === undefined ? {} : { signal };

  let upload: U;
  let have = new Set<number>();
  if (opts.resumeId !== undefined && opts.resumeId !== null) {
    upload = await api.status(project, opts.resumeId, call);
    have = new Set(upload.received ?? []);
  } else {
    const hashed: { path: string; size: number; sha256: string }[] = [];
    let done = 0;
    for (const f of files) {
      check();
      report({ phase: 'hashing', sentBytes: done, retry: null });
      hashed.push({ path: f.path, size: f.size, sha256: await digest(await readBlob(f.blob)) });
      done += f.size;
    }
    check();
    upload = await api.start(
      project,
      {
        files: hashed,
        ...(opts.label === undefined ? {} : { label: opts.label }),
        ...(opts.partSize === undefined ? {} : { partSize: opts.partSize }),
      },
      call,
    );
  }
  opts.onStarted?.(upload.id);
  // The concatenation of the files in list order, sliced lazily (the browser reads from disk per part).
  const all = new Blob(files.map((f) => f.blob));
  const ranges = partRanges(totalBytes, upload.partSize);
  let sent = ranges.filter((_, n) => have.has(n)).reduce((s, r) => s + (r.end - r.start), 0);
  for (const [n, r] of ranges.entries()) {
    if (have.has(n)) continue;
    check();
    report({ phase: 'uploading', sentBytes: sent, retry: null });
    const bytes = await readBlob(all.slice(r.start, r.end));
    const hash = await digest(bytes);
    for (let attempt = 1; ; attempt++) {
      check();
      try {
        await api.putPart(project, upload.id, n, bytes, hash, call);
        break;
      } catch (err) {
        if (!isTransient(err) || attempt >= PART_ATTEMPTS) throw err;
        report({ phase: 'uploading', sentBytes: sent, retry: { part: n, attempt: attempt + 1 } });
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
    sent += r.end - r.start;
  }
  check();
  report({ phase: 'checking', sentBytes: totalBytes, retry: null });
  return api.complete(project, upload.id, call);
}
