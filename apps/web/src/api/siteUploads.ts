import { ApiError, apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p10-site-upload (ADR-0037; apps/master/src/site-uploads/routes.ts): a ready-made static site uploaded through
 * Project → Deploy, chunked like the release upload. Responses carry metadata only — the master never serves the
 * site's bytes back to the console.
 */

type Opts = Pick<RequestOptions, 'fetchImpl' | 'cookieString' | 'signal'>;

export interface SiteUploadFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface SiteUpload {
  readonly id: string;
  readonly project: string;
  readonly state: 'receiving' | 'ready';
  readonly label: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly received: readonly number[] | null;
  readonly uploadedBy: { readonly id: string; readonly username: string | null };
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly lastDeployedAt: string | null;
  readonly lastActionId: string | null;
  readonly files: readonly SiteUploadFile[] | null;
}

/** A file the master refused (start or complete): path, reason, and for a secret the rule and line. */
export interface SiteRefusal {
  readonly path: string;
  readonly reason: string;
  readonly rule?: string;
  readonly line?: number;
}

export function parseSiteUpload(v: unknown): SiteUpload {
  const o = obj(v);
  const by = obj(o.uploadedBy);
  const state = o.state === 'ready' ? 'ready' : o.state === 'receiving' ? 'receiving' : null;
  if (state === null) throw new ShapeError('state');
  const received = o.received;
  if (received !== null && received !== undefined && !Array.isArray(received))
    throw new ShapeError('received');
  const files = o.files;
  if (files !== null && files !== undefined && !Array.isArray(files)) throw new ShapeError('files');
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    state,
    label: nullableStr(o, 'label'),
    fileCount: int(o, 'fileCount'),
    totalBytes: int(o, 'totalBytes'),
    partSize: int(o, 'partSize'),
    partCount: int(o, 'partCount'),
    received: Array.isArray(received) ? received.filter((n): n is number => typeof n === 'number') : null,
    uploadedBy: { id: str(by, 'id'), username: nullableStr(by, 'username') },
    createdAt: str(o, 'createdAt'),
    completedAt: nullableStr(o, 'completedAt'),
    lastDeployedAt: nullableStr(o, 'lastDeployedAt'),
    lastActionId: nullableStr(o, 'lastActionId'),
    files: Array.isArray(files)
      ? files.map((x) => {
          const f = obj(x);
          return {
            path: str(f, 'path'),
            size: int(f, 'size'),
            sha256: str(f, 'sha256'),
            contentType: str(f, 'contentType'),
          };
        })
      : null,
  };
}

/** The refused files an error from the master names (`details.refused`), if any. */
export function refusalsOf(err: unknown): SiteRefusal[] {
  if (!(err instanceof ApiError)) return [];
  const r = err.details.refused;
  if (!Array.isArray(r)) return [];
  return r.flatMap((x) => {
    if (typeof x !== 'object' || x === null) return [];
    const o = x as Record<string, unknown>;
    if (typeof o.path !== 'string' || typeof o.reason !== 'string') return [];
    return [
      {
        path: o.path,
        reason: o.reason,
        ...(typeof o.rule === 'string' ? { rule: o.rule } : {}),
        ...(typeof o.line === 'number' ? { line: o.line } : {}),
      },
    ];
  });
}

const base = (project: string) => `/projects/${encodeURIComponent(project)}/site-uploads`;

export function startSiteUpload(
  project: string,
  input: {
    readonly files: readonly { path: string; size: number; sha256: string }[];
    readonly label?: string;
    readonly partSize?: number;
  },
  opts: Opts = {},
): Promise<SiteUpload> {
  return apiRequest('POST', base(project), parseSiteUpload, { ...opts, body: input });
}

export function getSiteUpload(project: string, id: string, opts: Opts = {}): Promise<SiteUpload> {
  return apiRequest('GET', `${base(project)}/${encodeURIComponent(id)}`, parseSiteUpload, opts);
}

export function listSiteUploads(project: string, opts: Opts = {}): Promise<SiteUpload[]> {
  return apiRequest(
    'GET',
    base(project),
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('items');
      return items.map(parseSiteUpload);
    },
    opts,
  );
}

export function putSiteUploadPart(
  project: string,
  id: string,
  n: number,
  bytes: Blob | ArrayBuffer,
  sha256: string,
  opts: Opts = {},
): Promise<{ n: number; received: number }> {
  return apiRequest(
    'PUT',
    `${base(project)}/${encodeURIComponent(id)}/parts/${String(n)}`,
    (v) => {
      const o = obj(v);
      return { n: int(o, 'n'), received: int(o, 'received') };
    },
    {
      ...opts,
      rawBody: bytes,
      contentType: 'application/octet-stream',
      headers: { 'X-Part-SHA256': sha256 },
    },
  );
}

export function completeSiteUpload(project: string, id: string, opts: Opts = {}): Promise<SiteUpload> {
  return apiRequest('POST', `${base(project)}/${encodeURIComponent(id)}/complete`, parseSiteUpload, {
    ...opts,
    body: {},
  });
}

export function deleteSiteUpload(project: string, id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `${base(project)}/${encodeURIComponent(id)}`, () => undefined, opts);
}
