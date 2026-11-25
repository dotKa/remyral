import { ApiError, apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p16-zip-job-input (ADR-0060; apps/master/src/input-uploads/routes.ts): a job input bundle — the files of a .zip the
 * console unpacked, uploaded in parts like a site upload. Responses carry metadata only.
 */

type Opts = Pick<RequestOptions, 'fetchImpl' | 'cookieString' | 'signal'>;

export interface InputFinding {
  readonly path: string;
  readonly rule: string;
  readonly line: number;
}

export interface InputUpload {
  readonly id: string;
  readonly project: string;
  readonly state: 'receiving' | 'ready';
  readonly label: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly received: readonly number[] | null;
  readonly keptUntil: string | null;
  readonly secretFindings: readonly InputFinding[];
  readonly sentWithSecrets: boolean;
  readonly files: readonly { readonly path: string; readonly size: number }[] | null;
}

function findingsIn(v: unknown): InputFinding[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x !== 'object' || x === null) return [];
    const o = x as Record<string, unknown>;
    return typeof o.path === 'string' && typeof o.rule === 'string' && typeof o.line === 'number'
      ? [{ path: o.path, rule: o.rule, line: o.line }]
      : [];
  });
}

export function parseInputUpload(v: unknown): InputUpload {
  const o = obj(v);
  const state = o.state === 'ready' ? 'ready' : o.state === 'receiving' ? 'receiving' : null;
  if (state === null) throw new ShapeError('state');
  const received = o.received;
  if (received !== null && received !== undefined && !Array.isArray(received))
    throw new ShapeError('received');
  const files = o.files;
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
    keptUntil: typeof o.keptUntil === 'string' ? o.keptUntil : null,
    secretFindings: findingsIn(o.secretFindings),
    sentWithSecrets: o.sentWithSecrets === true,
    files: Array.isArray(files)
      ? files.map((x) => {
          const f = obj(x);
          return { path: str(f, 'path'), size: int(f, 'size') };
        })
      : null,
  };
}

/** The secret findings of a 422 `input_secrets_found` (file, rule, line — never a value). */
export function findingsOf(err: unknown): InputFinding[] {
  return err instanceof ApiError && err.code === 'input_secrets_found'
    ? findingsIn(err.details.findings)
    : [];
}

const base = (project: string) => `/projects/${encodeURIComponent(project)}/input-uploads`;

export function startInputUpload(
  project: string,
  input: {
    readonly files: readonly { path: string; size: number; sha256: string }[];
    readonly label?: string;
    readonly partSize?: number;
  },
  opts: Opts = {},
): Promise<InputUpload> {
  return apiRequest('POST', base(project), parseInputUpload, { ...opts, body: input });
}

export function getInputUpload(project: string, id: string, opts: Opts = {}): Promise<InputUpload> {
  return apiRequest('GET', `${base(project)}/${encodeURIComponent(id)}`, parseInputUpload, opts);
}

export function putInputUploadPart(
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

/** Completes an upload; `allowSecrets`: the person chose "send anyway" after the scan's findings (audited). */
export function completeInputUpload(
  project: string,
  id: string,
  opts: Opts & { readonly allowSecrets?: boolean } = {},
): Promise<InputUpload> {
  const { allowSecrets, ...rest } = opts;
  return apiRequest('POST', `${base(project)}/${encodeURIComponent(id)}/complete`, parseInputUpload, {
    ...rest,
    body: allowSecrets === true ? { allowSecrets: true } : {},
  });
}

/** The job page: the input bundle a job started with (null: none). */
export interface JobInputUpload {
  readonly sourceId: string;
  readonly label: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly attachedAt: string;
  readonly pulledAt: string | null;
  readonly kept: boolean;
  readonly upload: InputUpload | null;
}

export function getJobInputUpload(jobId: string, opts: Opts = {}): Promise<JobInputUpload | null> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/input-upload`,
    (v) => {
      const x = obj(v).inputUpload;
      if (x === null || x === undefined) return null;
      const o = obj(x);
      return {
        sourceId: str(o, 'sourceId'),
        label: nullableStr(o, 'label'),
        fileCount: int(o, 'fileCount'),
        totalBytes: int(o, 'totalBytes'),
        attachedAt: str(o, 'attachedAt'),
        pulledAt: nullableStr(o, 'pulledAt'),
        kept: o.kept === true,
        upload: o.upload === null || o.upload === undefined ? null : parseInputUpload(o.upload),
      };
    },
    opts,
  );
}
