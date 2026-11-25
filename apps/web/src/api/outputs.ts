import {
  API_PREFIX,
  ApiError,
  apiRequest,
  CSRF_COOKIE,
  CSRF_HEADER,
  NETWORK_ERROR_MESSAGE,
  nullableStr,
  obj,
  parseRetryAfter,
  type RequestOptions,
  ShapeError,
  str,
  strArray,
  UNEXPECTED_RESPONSE_MESSAGE,
  readCookie,
} from './client';
import { parseSiteHealth, type SiteHealthBadge } from './verify';
import { isAppPackage } from './previews';
import { filenameFrom, saveWithLink } from './download';

/**
 * p6-outputs (docs/design/p6-outputs.md): live sites, job files and notes of the visible projects. Every name, title,
 * note and URL is untrusted text: rendered as text, links only https and opened outside the console.
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

export type OutputType = 'site' | 'file' | 'note';
export type PreviewKind = 'markdown' | 'text' | 'json' | 'csv' | 'tsv' | 'image' | 'pdf' | 'diff' | 'none';
const PREVIEWS: readonly PreviewKind[] = [
  'markdown',
  'text',
  'json',
  'csv',
  'tsv',
  'image',
  'pdf',
  'diff',
  'none',
];

export interface OutputAuthor {
  readonly id: string | null;
  readonly username: string | null;
}

export interface OutputSite {
  readonly url: string | null;
  readonly env: 'preview' | 'production';
  /** p8-preview-tunnels: `tunnel` = an open preview link (Cloudflare Tunnel) of a job. */
  readonly provider: 'pages' | 'coolify' | 'tunnel';
  readonly target: string;
  readonly opsActionId: string;
  readonly opsKind: string;
  readonly deployedAt: string;
  /** p8-preview-tunnels (tunnel items): the protection and when the preview closes. */
  readonly protection: 'none' | 'access' | 'service-token' | null;
  readonly expiresAt: string | null;
}

/** Where a live site / preview lives, for people. */
export function siteProviderText(provider: OutputSite['provider']): string {
  return provider === 'pages' ? 'Cloudflare Pages' : provider === 'coolify' ? 'Coolify' : 'Preview link';
}

export interface OutputFile {
  readonly source: 'workspace' | 'run';
  readonly artifactId: string;
  readonly kind: 'output' | 'summary' | 'run';
  readonly mediaType: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly redacted: boolean;
  readonly removed: 'retention' | 'quota' | null;
  readonly expiresAt: string | null;
  readonly download: string | null;
  readonly preview: PreviewKind;
  /** p17-object-storage: where the bytes are (object storage, the master's disk, or still the database). */
  readonly location: 's3' | 'local' | 'database' | null;
}

export interface OutputNoteCard {
  readonly id: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly links: readonly string[];
  readonly author: OutputAuthor;
  readonly updatedAt: string;
}

/** p8-uptime: a monitor linked to a site item. */
export interface SiteMonitor {
  readonly id: string;
  readonly name: string;
  readonly type: 'http' | 'tcp' | 'pages' | 'coolify';
  readonly status: 'up' | 'down' | 'pending';
  readonly paused: boolean;
  readonly uptime24h: number | null;
  readonly detail: string | null;
  readonly lastCheckAt: string | null;
}

/** p8-uptime: the monitors of a site item (worst status, uptime % of the lead monitor). */
export interface SiteUptime {
  readonly status: 'up' | 'down' | 'pending' | null;
  readonly uptime24h: number | null;
  readonly monitors: readonly SiteMonitor[];
}

export interface OutputItem {
  readonly key: string;
  readonly type: OutputType;
  readonly project: string;
  readonly title: string | null;
  readonly name: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly noteCount: number;
  readonly jobId: string | null;
  readonly createdAt: string;
  readonly site: OutputSite | null;
  readonly file: OutputFile | null;
  readonly note: OutputNoteCard | null;
  /** p8-uptime: null when no monitor watches the site (and for files / notes). */
  readonly uptime: SiteUptime | null;
  /** p10-verify-health: the site's latest post-deploy health check (null: none, and for files / notes). */
  readonly health: SiteHealthBadge | null;
}

export interface ItemNote {
  readonly id: string;
  readonly body: string;
  readonly author: OutputAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteCard {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly pinned: boolean;
  readonly author: OutputAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OutputFilter {
  readonly project?: string;
  readonly type?: OutputType;
  readonly job?: string;
  readonly from?: string;
  readonly to?: string;
  readonly pinned?: boolean;
  readonly q?: string;
  readonly tag?: string;
  readonly key?: string;
  /** p8-outputs-folders: items of one own folder. */
  readonly folder?: string;
  /** p8-outputs-folders: files below one directory of a job's out/ tree (with `job`). */
  readonly path?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** The https URL itself, or null for anything else (never a javascript:/data: link). */
export function httpsUrl(u: string | null | undefined): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null;
  } catch {
    return null;
  }
}

function author(v: unknown): OutputAuthor {
  const o = obj(v);
  return { id: nullableStr(o, 'id'), username: nullableStr(o, 'username') };
}

function num(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') throw new ShapeError(k);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], k: string): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ShapeError(k);
}

function parseUptime(v: unknown): SiteUptime | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  if (!Array.isArray(o.monitors)) throw new ShapeError('monitors');
  const status = (x: unknown): 'up' | 'down' | 'pending' => oneOf(x, ['up', 'down', 'pending'], 'status');
  return {
    status: o.status === null ? null : status(o.status),
    uptime24h: num(o, 'uptime24h'),
    monitors: o.monitors.map((m) => {
      const x = obj(m);
      return {
        id: str(x, 'id'),
        name: str(x, 'name'),
        type: oneOf(x.type, ['http', 'tcp', 'pages', 'coolify'], 'type'),
        status: status(x.status),
        paused: x.paused === true,
        uptime24h: num(x, 'uptime24h'),
        detail: nullableStr(x, 'detail'),
        lastCheckAt: nullableStr(x, 'lastCheckAt'),
      };
    }),
  };
}

export function parseOutputItem(v: unknown): OutputItem {
  const o = obj(v);
  const s = o.site === null || o.site === undefined ? null : obj(o.site);
  const f = o.file === null || o.file === undefined ? null : obj(o.file);
  const n = o.note === null || o.note === undefined ? null : obj(o.note);
  return {
    key: str(o, 'key'),
    type: oneOf(o.type, ['site', 'file', 'note'], 'type'),
    project: str(o, 'project'),
    title: nullableStr(o, 'title'),
    name: str(o, 'name'),
    tags: strArray(o, 'tags'),
    pinned: o.pinned === true,
    noteCount: num(o, 'noteCount') ?? 0,
    jobId: nullableStr(o, 'jobId'),
    createdAt: str(o, 'createdAt'),
    site:
      s === null
        ? null
        : {
            url: httpsUrl(nullableStr(s, 'url')),
            env: oneOf(s.env, ['preview', 'production'], 'env'),
            provider: oneOf(s.provider, ['pages', 'coolify', 'tunnel'], 'provider'),
            target: str(s, 'target'),
            opsActionId: str(s, 'opsActionId'),
            opsKind: str(s, 'opsKind'),
            deployedAt: str(s, 'deployedAt'),
            protection:
              s.protection === 'none' || s.protection === 'access' || s.protection === 'service-token'
                ? s.protection
                : null,
            expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : null,
          },
    file:
      f === null
        ? null
        : {
            source: oneOf(f.source, ['workspace', 'run'], 'source'),
            artifactId: str(f, 'artifactId'),
            kind: oneOf(f.kind, ['output', 'summary', 'run'], 'kind'),
            mediaType: str(f, 'mediaType'),
            sizeBytes: num(f, 'sizeBytes'),
            sha256: nullableStr(f, 'sha256'),
            redacted: f.redacted === true,
            removed: f.removed === 'retention' || f.removed === 'quota' ? f.removed : null,
            expiresAt: nullableStr(f, 'expiresAt'),
            // Only master API paths; never an absolute URL.
            download: (() => {
              const d = nullableStr(f, 'download');
              return d !== null && d.startsWith('/jobs/') && !d.startsWith('//') ? d : null;
            })(),
            // p8-preview-tunnels: app packages are never previewed, whatever an answer says.
            preview: isAppPackage(str(f, 'mediaType')) ? 'none' : oneOf(f.preview, PREVIEWS, 'preview'),
            location:
              f.location === 's3' || f.location === 'local' || f.location === 'database' ? f.location : null,
          },
    note:
      n === null
        ? null
        : {
            id: str(n, 'id'),
            body: str(n, 'body'),
            bodyTruncated: n.bodyTruncated === true,
            links: strArray(n, 'links').flatMap((l) => {
              const u = httpsUrl(l);
              return u === null ? [] : [u];
            }),
            author: author(n.author),
            updatedAt: str(n, 'updatedAt'),
          },
    uptime: parseUptime(o.uptime),
    health: parseSiteHealth(o.health),
  };
}

function parseItemNote(v: unknown): ItemNote {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    body: str(o, 'body'),
    author: author(o.author),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

function parseNoteCard(v: unknown): NoteCard {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    title: str(o, 'title'),
    body: str(o, 'body'),
    tags: strArray(o, 'tags'),
    links: strArray(o, 'links').flatMap((l) => {
      const u = httpsUrl(l);
      return u === null ? [] : [u];
    }),
    pinned: o.pinned === true,
    author: author(o.author),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

export function outputQuery(f: OutputFilter): string {
  const q = new URLSearchParams();
  if (f.project) q.set('project', f.project);
  if (f.type) q.set('type', f.type);
  if (f.job) q.set('job', f.job);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.pinned !== undefined) q.set('pinned', String(f.pinned));
  if (f.q) q.set('q', f.q);
  if (f.tag) q.set('tag', f.tag);
  if (f.key) q.set('key', f.key);
  if (f.folder) q.set('folder', f.folder);
  if (f.path) q.set('path', f.path);
  if (f.limit !== undefined) q.set('limit', String(f.limit));
  if (f.offset !== undefined && f.offset > 0) q.set('offset', String(f.offset));
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

export function listOutputs(
  f: OutputFilter,
  opts: Opts = {},
): Promise<{
  items: OutputItem[];
  total: number;
  /** p15-chat-cards-scroll: with `job`, the key of the job's primary output (its report); null: none / older master. */
  primaryOutputId: string | null;
}> {
  return apiRequest(
    'GET',
    `/outputs${outputQuery(f)}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('items');
      return {
        items: o.items.map(parseOutputItem),
        total: num(o, 'total') ?? 0,
        primaryOutputId: typeof o.primaryOutputId === 'string' ? o.primaryOutputId : null,
      };
    },
    opts,
  );
}

export function updateOutputItem(
  body: {
    readonly project: string;
    readonly key: string;
    readonly title?: string | null;
    readonly tags?: readonly string[];
    readonly pinned?: boolean;
  },
  opts: Opts = {},
): Promise<OutputItem> {
  return apiRequest('PUT', '/outputs/items', parseOutputItem, { ...opts, body });
}

export function listItemNotes(project: string, key: string, opts: Opts = {}): Promise<ItemNote[]> {
  return apiRequest(
    'GET',
    `/outputs/thread?project=${enc(project)}&key=${enc(key)}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('items');
      return o.items.map(parseItemNote);
    },
    opts,
  );
}

export function addItemNote(project: string, key: string, body: string, opts: Opts = {}): Promise<ItemNote> {
  return apiRequest('POST', '/outputs/item-notes', parseItemNote, { ...opts, body: { project, key, body } });
}

export function editItemNote(id: string, body: string, opts: Opts = {}): Promise<ItemNote> {
  return apiRequest('PATCH', `/outputs/item-notes/${enc(id)}`, parseItemNote, { ...opts, body: { body } });
}

export function deleteItemNote(id: string, opts: Opts = {}): Promise<null> {
  return apiRequest('DELETE', `/outputs/item-notes/${enc(id)}`, () => null, opts);
}

export interface NoteCardInput {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly pinned: boolean;
}

export function getNoteCard(id: string, opts: Opts = {}): Promise<NoteCard> {
  return apiRequest('GET', `/outputs/notes/${enc(id)}`, parseNoteCard, opts);
}

export function createNoteCard(project: string, input: NoteCardInput, opts: Opts = {}): Promise<NoteCard> {
  return apiRequest('POST', '/outputs/notes', parseNoteCard, { ...opts, body: { project, ...input } });
}

export function updateNoteCard(
  id: string,
  patch: Partial<NoteCardInput>,
  opts: Opts = {},
): Promise<NoteCard> {
  return apiRequest('PATCH', `/outputs/notes/${enc(id)}`, parseNoteCard, { ...opts, body: patch });
}

export function deleteNoteCard(id: string, opts: Opts = {}): Promise<null> {
  return apiRequest('DELETE', `/outputs/notes/${enc(id)}`, () => null, opts);
}

// ------------------------------------------------------------------------------- site bundle preview

export interface SiteBundleFile {
  readonly path: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly view: 'html' | 'image' | 'source' | 'none';
}

export interface SiteBundle {
  readonly createdAt: string;
  readonly directory: string;
  readonly flagged: boolean;
  readonly removed: 'retention' | 'quota' | null;
  readonly files: readonly SiteBundleFile[];
}

export function getSiteBundle(jobId: string, opts: Opts = {}): Promise<SiteBundle> {
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/site-bundle`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.files)) throw new ShapeError('files');
      return {
        createdAt: str(o, 'createdAt'),
        directory: str(o, 'directory'),
        flagged: o.flagged === true,
        removed: o.removed === 'retention' || o.removed === 'quota' ? o.removed : null,
        files: o.files.map((x) => {
          const f = obj(x);
          return {
            path: str(f, 'path'),
            contentType: str(f, 'contentType'),
            sizeBytes: num(f, 'sizeBytes') ?? 0,
            view: oneOf(f.view, ['html', 'image', 'source', 'none'], 'view'),
          };
        }),
      };
    },
    opts,
  );
}

/** Same-origin URL of a site-bundle file for a sandboxed frame / image / source fetch. */
export function siteFileUrl(jobId: string, path: string): string {
  return `${API_PREFIX}/jobs/${enc(jobId)}/site-bundle/file?path=${enc(path)}`;
}

/** Same-origin URL of a file's content (`inline` for the preview of allowlisted types). */
export function fileUrl(download: string, inline: boolean): string {
  return `${API_PREFIX}${download}${inline ? '?inline=1' : ''}`;
}

// ------------------------------------------------------------------------------- multi-select download

/** Downloads the selected stored files of one project as a ZIP (POST, CSRF; the browser saves the blob). */
export function downloadZip(project: string, keys: readonly string[], opts: ZipOpts = {}): Promise<string> {
  return downloadZipOf({ project, keys }, `outputs-${project}.zip`, opts);
}

export interface ZipOpts {
  readonly fetchImpl?: typeof fetch;
  readonly save?: (blob: Blob, name: string) => void;
}

/**
 * p8-outputs-folders: `POST /outputs/zip` with any of its bodies — selected keys, a node of the automatic tree
 * (`{project, tree}`) or an own folder (`{folder}`). Returns the saved file name.
 */
export async function downloadZipOf(
  body:
    | { readonly project: string; readonly keys: readonly string[] }
    | { readonly project: string; readonly tree: string }
    | { readonly folder: string },
  fallbackName: string,
  opts: ZipOpts = {},
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/zip' };
  const token = readCookie(CSRF_COOKIE);
  if (token) headers[CSRF_HEADER] = token;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${API_PREFIX}/outputs/zip`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await res.text()) as unknown;
    } catch {
      parsed = undefined;
    }
    const retry = parseRetryAfter(res.headers.get('retry-after'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { error, message } = parsed as { error?: unknown; message?: unknown };
      if (typeof error === 'string' && typeof message === 'string') {
        throw new ApiError(res.status, error, message, retry);
      }
    }
    throw new ApiError(res.status, 'unexpected_response', UNEXPECTED_RESPONSE_MESSAGE, retry);
  }
  const name = filenameFrom(res.headers.get('content-disposition'), fallbackName);
  (opts.save ?? saveWithLink)(new Blob([await res.arrayBuffer()], { type: 'application/zip' }), name);
  return name;
}
