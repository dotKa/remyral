import {
  API_PREFIX,
  apiRequest,
  int,
  nullableStr,
  obj,
  type RequestOptions,
  ShapeError,
  str,
  strArray,
} from './client';

/**
 * p17-object-storage (apps/master/src/blobs/routes.ts): Settings → Integrations → Storage, downloads of outputs (a
 * presigned link for object storage, the file for local disk) and share links. The access keys are write-only: no
 * response carries one; the browser only sends keys the owner types.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;

export type StorageMode = 'local' | 's3';
export type StorageProvider = 'aws' | 'r2' | 'minio' | 'other';
export type StorageSse = 'none' | 'AES256' | 'aws:kms';

export interface StorageConfig {
  readonly provider: StorageProvider;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly pathStyle: boolean;
  readonly prefix: string;
  readonly sse: StorageSse;
  readonly kmsKeyId: string;
}

export interface StorageLimits {
  readonly maxFileBytes: number;
  readonly maxJobBytes: number;
  readonly thresholdBytes: number;
  readonly downloadTtlSeconds: number;
  readonly shareMaxDays: number;
}

export interface StorageStatus {
  readonly mode: StorageMode;
  readonly config: StorageConfig | null;
  readonly keyIdHint: string | null;
  readonly keyFingerprint: string | null;
  readonly usable: boolean;
  readonly problem: string | null;
  readonly limits: StorageLimits;
  readonly lastTest: Json | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string;
  readonly usage: readonly {
    readonly location: StorageMode;
    readonly blobs: number;
    readonly bytes: number;
  }[];
  readonly legacyBytes: number;
  readonly local: {
    readonly dir: string;
    readonly freeBytes: number | null;
    readonly totalBytes: number | null;
  };
  readonly options: {
    readonly providers: readonly StorageProvider[];
    readonly defaults: Readonly<Record<string, { readonly region: string; readonly pathStyle: boolean }>>;
    readonly limitDefaults: StorageLimits;
  };
  readonly policy: Json | null;
}

const PROVIDERS: readonly StorageProvider[] = ['aws', 'r2', 'minio', 'other'];
const SSES: readonly StorageSse[] = ['none', 'AES256', 'aws:kms'];

function json(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

function nullableNum(o: Json, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') throw new ShapeError(key);
  return v;
}

function parseLimits(v: unknown): StorageLimits {
  const o = obj(v);
  return {
    maxFileBytes: int(o, 'maxFileBytes'),
    maxJobBytes: int(o, 'maxJobBytes'),
    thresholdBytes: int(o, 'thresholdBytes'),
    downloadTtlSeconds: int(o, 'downloadTtlSeconds'),
    shareMaxDays: int(o, 'shareMaxDays'),
  };
}

function parseConfig(v: unknown): StorageConfig | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const provider = str(o, 'provider');
  const sse = str(o, 'sse');
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new ShapeError('provider');
  if (!(SSES as readonly string[]).includes(sse)) throw new ShapeError('sse');
  if (typeof o.pathStyle !== 'boolean') throw new ShapeError('pathStyle');
  return {
    provider: provider as StorageProvider,
    endpoint: str(o, 'endpoint'),
    region: str(o, 'region'),
    bucket: str(o, 'bucket'),
    pathStyle: o.pathStyle,
    prefix: str(o, 'prefix'),
    sse: sse as StorageSse,
    kmsKeyId: str(o, 'kmsKeyId'),
  };
}

export function parseStorageStatus(v: unknown): StorageStatus {
  const o = obj(v);
  const mode = str(o, 'mode');
  if (mode !== 'local' && mode !== 's3') throw new ShapeError('mode');
  if (typeof o.usable !== 'boolean') throw new ShapeError('usable');
  const local = obj(o.local);
  const options = obj(o.options);
  const defaults: Record<string, { region: string; pathStyle: boolean }> = {};
  for (const [k, d] of Object.entries(json(options.defaults))) {
    const x = obj(d);
    defaults[k] = { region: str(x, 'region'), pathStyle: x.pathStyle === true };
  }
  return {
    mode,
    config: parseConfig(o.config),
    keyIdHint: nullableStr(o, 'keyIdHint'),
    keyFingerprint: nullableStr(o, 'keyFingerprint'),
    usable: o.usable,
    problem: nullableStr(o, 'problem'),
    limits: parseLimits(o.limits),
    lastTest: o.lastTest === null || o.lastTest === undefined ? null : json(o.lastTest),
    lastTestAt: nullableStr(o, 'lastTestAt'),
    updatedAt: str(o, 'updatedAt'),
    usage: (Array.isArray(o.usage) ? o.usage : []).map((u) => {
      const x = obj(u);
      const location = str(x, 'location');
      return {
        location: location === 's3' ? 's3' : 'local',
        blobs: int(x, 'blobs'),
        bytes: int(x, 'bytes'),
      } as const;
    }),
    legacyBytes: int(o, 'legacyBytes'),
    local: {
      dir: str(local, 'dir'),
      freeBytes: nullableNum(local, 'freeBytes'),
      totalBytes: nullableNum(local, 'totalBytes'),
    },
    options: {
      providers: strArray(options, 'providers').filter((p): p is StorageProvider =>
        (PROVIDERS as readonly string[]).includes(p),
      ),
      defaults,
      limitDefaults: parseLimits(options.limitDefaults),
    },
    policy: o.policy === null || o.policy === undefined ? null : json(o.policy),
  };
}

export function getStorage(opts: Opts = {}): Promise<StorageStatus> {
  return apiRequest('GET', '/integrations/storage', parseStorageStatus, opts);
}

export function saveStorage(
  body: {
    readonly mode: StorageMode;
    readonly config?: StorageConfig;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
    readonly limits?: StorageLimits;
  },
  opts: Opts = {},
): Promise<StorageStatus> {
  return apiRequest('PUT', '/integrations/storage', parseStorageStatus, { ...opts, body });
}

export function testStorage(opts: Opts = {}): Promise<Json> {
  return apiRequest('POST', '/integrations/storage/test', json, opts);
}

// ------------------------------------------------------------------------------------------ downloads, shares

/**
 * The download address of an output (`download` is the API path of the file, e.g. `/jobs/<id>/artifacts/<aid>`): a
 * plain navigation, so a large file never passes through the page's memory and an object-storage link (302) needs no
 * CORS on the bucket. `open`: the browser's own viewer for PDFs, images and videos (on the bucket's origin).
 */
export function downloadUrl(download: string, open = false): string {
  return `${API_PREFIX}${download}/download${open ? '?open=1' : ''}`;
}

/** Starts a download by navigation (a temporary link; nothing is read into memory). */
export function startDownload(href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  a.setAttribute('download', '');
  document.body.append(a);
  a.click();
  a.remove();
}

export interface ShareLink {
  readonly id: string;
  readonly jobId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
}

export function parseShareLink(v: unknown): ShareLink {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    jobId: str(o, 'jobId'),
    artifactId: str(o, 'artifactId'),
    name: str(o, 'name'),
    createdBy: nullableStr(o, 'createdBy'),
    createdAt: str(o, 'createdAt'),
    expiresAt: str(o, 'expiresAt'),
    revokedAt: nullableStr(o, 'revokedAt'),
    lastUsedAt: nullableStr(o, 'lastUsedAt'),
    useCount: int(o, 'useCount'),
  };
}

const sharePath = (jobId: string, artifactId: string): string =>
  `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}/shares`;

export function listShares(jobId: string, artifactId: string, opts: Opts = {}): Promise<ShareLink[]> {
  return apiRequest(
    'GET',
    sharePath(jobId, artifactId),
    (v) => {
      const o = obj(v);
      return (Array.isArray(o.links) ? o.links : []).map(parseShareLink);
    },
    opts,
  );
}

/** Creates a link; the returned `url` (absolute, this console's origin) is shown once and never again. */
export function createShare(
  jobId: string,
  artifactId: string,
  days: number,
  opts: Opts = {},
): Promise<{ link: ShareLink; url: string }> {
  return apiRequest(
    'POST',
    sharePath(jobId, artifactId),
    (v) => {
      const o = obj(v);
      const path = str(o, 'path');
      if (!/^\/share\/f\/[A-Za-z0-9_-]{43}$/.test(path)) throw new ShapeError('path');
      return { link: parseShareLink(o.link), url: `${window.location.origin}${API_PREFIX}${path}` };
    },
    { ...opts, body: { days } },
  );
}

export function revokeShare(
  jobId: string,
  artifactId: string,
  shareId: string,
  opts: Opts = {},
): Promise<ShareLink> {
  return apiRequest(
    'DELETE',
    `${sharePath(jobId, artifactId)}/${encodeURIComponent(shareId)}`,
    (v) => parseShareLink(obj(v).link),
    opts,
  );
}

/** The least-privilege bucket policy (the same text as the master and docs/guide/tr/depolama.md). */
export function storagePolicy(bucket: string, prefix: string): string {
  const p = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'RemyralBlobObjects',
          Effect: 'Allow',
          Action: [
            's3:PutObject',
            's3:GetObject',
            's3:DeleteObject',
            's3:AbortMultipartUpload',
            's3:ListMultipartUploadParts',
          ],
          Resource: `arn:aws:s3:::${bucket}/${p === '' ? '' : `${p}/`}*`,
        },
      ],
    },
    null,
    2,
  );
}
