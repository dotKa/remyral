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
import { type EgressMode, EGRESS_MODES, type ProjectKind } from './directory';
import { fetchBlob, type FetchedBlob } from './download';

/**
 * p5-research-workspace (docs/design/p5-research-workspace.md §2 API): a workspace project's network
 * settings, a job's artifacts and inputs. Names and contents come from agents, uploads and the web:
 * untrusted, rendered as text only (never HTML).
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

// ------------------------------------------------------------------------------- limits (shared with master)

/** Input limits of `POST /v1/jobs` (protocol `workspace.ts`). */
export const MAX_INPUT_FILES = 10;
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_ALLOW_HOSTS = 64;

/** Allowed file extensions (inputs and artifacts) → media type. */
export const ALLOWED_TYPES: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED_TYPES);

/** The master's input name rule. */
export const INPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}$/;

/** Media types the master serves with `?inline=1`. */
export const INLINE_TEXT_TYPES = new Set([
  'text/markdown',
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'text/yaml',
]);
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** `host` or `host:port` (DNS name, no scheme, no path). */
const HOST =
  /^(?=.{1,253}(?::\d{1,5})?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*(?::\d{1,5})?$/;

/** Splits "one host per line" text; returns the hosts and the first problem, if any. */
export function parseAllowHosts(text: string): { hosts: string[]; error: string | null } {
  const hosts = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ''),
    ),
  ];
  if (hosts.length > MAX_ALLOW_HOSTS) return { hosts, error: `At most ${String(MAX_ALLOW_HOSTS)} hosts.` };
  const bad = hosts.find((h) => {
    if (!HOST.test(h)) return true;
    const port = h.includes(':') ? Number(h.slice(h.indexOf(':') + 1)) : 443;
    return port < 1 || port > 65535;
  });
  if (bad !== undefined)
    return { hosts, error: `“${bad}” is not a host name (host or host:port, no https://).` };
  return { hosts, error: null };
}

// ------------------------------------------------------------------------------- workspace settings

/** p5-research-workspace-next: stored bytes of the project's job files (artifacts + inputs). */
export interface StorageUsage {
  readonly bytes: number;
  readonly files: number;
  readonly artifactBytes: number;
  readonly artifactFiles: number;
  readonly inputBytes: number;
  readonly inputFiles: number;
  readonly prunedFiles: number;
  readonly oldestAt: string | null;
}

/** Bounds of the storage policy (master `workspaces/storage.ts`). */
export const RETENTION_DAYS = { min: 1, max: 3650 } as const;
export const QUOTA_BYTES = { min: 10 * 1024 * 1024, max: 1024 * 1024 * 1024 * 1024 } as const;

export interface WorkspaceSettings {
  readonly project: string;
  readonly kind: ProjectKind;
  readonly egress: EgressMode;
  readonly allowHosts: readonly string[];
  /** Files of finished jobs older than this are removed (null: kept as long as the job). */
  readonly artifactRetentionDays: number | null;
  /** Cap on the stored bytes of the project's job files (null: none). */
  readonly storageQuotaBytes: number | null;
  /** p17-output-limits: the project's lower output file limit (null: the server's). */
  readonly outputMaxFiles: number | null;
  /** p17-output-limits: the project's lower per-job bytes in the storage (null: the server's). */
  readonly outputMaxJobBytes: number | null;
  /** p17-output-limits: the server's limits and what applies to this project (null: an older master). */
  readonly outputLimits: ProjectOutputLimits | null;
  readonly usage: StorageUsage;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** p17-output-limits: where outputs go and the limits that decide it (server, project, effective). */
export interface ProjectOutputLimits {
  readonly server: OutputServerLimits;
  readonly effectiveMaxFiles: number;
  readonly effectiveMaxJobBytes: number;
  readonly ceilingMaxFiles: number;
  readonly ceilingJobBytes: number;
  readonly inlineFileBytes: number;
  readonly inlineTotalBytes: number;
}

/** p17-output-limits: the server's output limits and the storage's state (Sunucu ayarları → İşler, project view). */
export interface OutputServerLimits {
  readonly maxFiles: number;
  readonly maxJobBytes: number;
  readonly maxFileBytes: number;
  readonly thresholdBytes: number;
  /** `unavailable`: object storage selected but not usable — inline only. */
  readonly storage: 'local' | 's3' | 'unavailable';
}

/** Bounds of a project's output overrides (protocol `output-limits.ts`, master `PROJECT_JOB_BYTES`). */
export const OUTPUT_FILES = { min: 1, max: 2000 } as const;
export const OUTPUT_JOB_BYTES = { min: 1024 * 1024, max: 64 * 1024 * 1024 * 1024 } as const;

function storageOf(v: unknown): OutputServerLimits['storage'] {
  return v === 's3' || v === 'unavailable' ? v : 'local';
}

export function parseOutputServerLimits(v: unknown): OutputServerLimits | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (k: string): number | null => (typeof o[k] === 'number' ? o[k] : null);
  const maxFiles = n('maxFiles');
  const maxJobBytes = n('maxJobBytes');
  const maxFileBytes = n('maxFileBytes');
  const thresholdBytes = n('thresholdBytes');
  if (maxFiles === null || maxJobBytes === null || maxFileBytes === null || thresholdBytes === null)
    return null;
  return { maxFiles, maxJobBytes, maxFileBytes, thresholdBytes, storage: storageOf(o.storage) };
}

function parseProjectOutputLimits(v: unknown): ProjectOutputLimits | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const server = parseOutputServerLimits(o.server);
  if (server === null) return null;
  return {
    server,
    effectiveMaxFiles: int(o, 'effectiveMaxFiles'),
    effectiveMaxJobBytes: int(o, 'effectiveMaxJobBytes'),
    ceilingMaxFiles: int(o, 'ceilingMaxFiles'),
    ceilingJobBytes: int(o, 'ceilingJobBytes'),
    inlineFileBytes: int(o, 'inlineFileBytes'),
    inlineTotalBytes: int(o, 'inlineTotalBytes'),
  };
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(`expected integer at ${key}`);
  return v;
}

const EMPTY_USAGE: StorageUsage = {
  bytes: 0,
  files: 0,
  artifactBytes: 0,
  artifactFiles: 0,
  inputBytes: 0,
  inputFiles: 0,
  prunedFiles: 0,
  oldestAt: null,
};

function parseUsage(v: unknown): StorageUsage {
  if (v === undefined || v === null) return EMPTY_USAGE;
  const u = obj(v);
  return {
    bytes: int(u, 'bytes'),
    files: int(u, 'files'),
    artifactBytes: int(u, 'artifactBytes'),
    artifactFiles: int(u, 'artifactFiles'),
    inputBytes: int(u, 'inputBytes'),
    inputFiles: int(u, 'inputFiles'),
    prunedFiles: int(u, 'prunedFiles'),
    oldestAt: nullableStr(u, 'oldestAt'),
  };
}

function egressOf(o: Record<string, unknown>): EgressMode {
  const v = str(o, 'egress');
  const found = EGRESS_MODES.find((m) => m === v);
  if (found === undefined) throw new ShapeError('unexpected egress');
  return found;
}

export function parseWorkspaceSettings(v: unknown): WorkspaceSettings {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    kind: o.kind === 'repository' ? 'repository' : 'workspace',
    egress: egressOf(o),
    allowHosts: strArray(o, 'allowHosts'),
    artifactRetentionDays: nullableInt(o, 'artifactRetentionDays'),
    storageQuotaBytes: nullableInt(o, 'storageQuotaBytes'),
    outputMaxFiles: nullableInt(o, 'outputMaxFiles'),
    outputMaxJobBytes: nullableInt(o, 'outputMaxJobBytes'),
    outputLimits: parseProjectOutputLimits(o.outputLimits),
    usage: parseUsage(o.usage),
    updatedAt: nullableStr(o, 'updatedAt'),
    updatedBy: nullableStr(o, 'updatedBy'),
  };
}

export function getWorkspaceSettings(project: string, opts: Opts = {}): Promise<WorkspaceSettings> {
  return apiRequest('GET', `/projects/${enc(project)}/workspace`, parseWorkspaceSettings, opts);
}

export function putWorkspaceSettings(
  project: string,
  body: {
    egress: EgressMode;
    allowHosts: readonly string[];
    /** Omitted: unchanged; null: none. */
    artifactRetentionDays?: number | null;
    storageQuotaBytes?: number | null;
    /** p17-output-limits: omitted: unchanged; null: the server's. */
    outputMaxFiles?: number | null;
    outputMaxJobBytes?: number | null;
  },
  opts: Opts = {},
): Promise<WorkspaceSettings> {
  return apiRequest('PUT', `/projects/${enc(project)}/workspace`, parseWorkspaceSettings, { ...opts, body });
}

// ------------------------------------------------------------------------------- artifacts and inputs

export interface JobArtifact {
  readonly id: string;
  readonly attemptId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: 'output' | 'summary';
  readonly redacted: boolean;
  readonly createdAt: string;
  /** p5-research-workspace-next: removed by the retention or the storage quota (null: stored). */
  readonly prunedReason: PrunedReason | null;
}

export type PrunedReason = 'retention' | 'quota';

function prunedReasonOf(o: Record<string, unknown>): PrunedReason | null {
  return o.prunedReason === 'retention' || o.prunedReason === 'quota' ? o.prunedReason : null;
}

export interface JobInput {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /**
   * `upstream`: an upstream workflow step's file (p5-research-workspace-next); `subtask`: a file a sub-job delivered
   * back to this job (p8-orchestration).
   */
  readonly source: 'upload' | 'artifact' | 'upstream' | 'subtask';
  readonly sourceJobId: string | null;
  readonly prunedReason: PrunedReason | null;
}

export interface JobArtifacts {
  readonly artifacts: readonly JobArtifact[];
  readonly inputs: readonly JobInput[];
  /** p17-output-limits: all artifacts of the job (the list is paged; older masters: the list's length). */
  readonly total: number;
  /** p18-outputs-delivery: what "Tüm dosyaları indir (zip)" holds (null: no files, or an older master). */
  readonly archive: ArchiveInfo | null;
}

/** p18-outputs-delivery: the whole archive's files (stored + the overflow zip's, unpacked) and bytes. */
export interface ArchiveInfo {
  readonly files: number;
  readonly bytes: number;
  readonly unpacked: { readonly name: string; readonly files: number } | null;
  readonly removed: number;
}

/** p17-output-limits: one page of the artifact list. */
export const ARTIFACT_PAGE_SIZE = 500;
/** p18-outputs-delivery: the Dosyalar tab's page sizes (the first is the default). */
export const FILE_PAGE_SIZES = [50, 100, 250] as const;

function archiveOf(o: Record<string, unknown>): ArchiveInfo | null {
  const v = o.archive;
  if (v === null || v === undefined || typeof v !== 'object') return null;
  const a = obj(v);
  const u = a.unpacked === null || a.unpacked === undefined ? null : obj(a.unpacked);
  return {
    files: int(a, 'files'),
    bytes: int(a, 'bytes'),
    unpacked: u === null ? null : { name: str(u, 'name'), files: int(u, 'files') },
    removed: typeof a.removed === 'number' ? a.removed : 0,
  };
}

function list(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

export function parseJobArtifacts(v: unknown): JobArtifacts {
  const o = obj(v);
  return {
    artifacts: list(o, 'artifacts').map((x) => {
      const a = obj(x);
      return {
        id: str(a, 'id'),
        attemptId: str(a, 'attemptId'),
        name: str(a, 'name'),
        mediaType: str(a, 'mediaType'),
        sizeBytes: int(a, 'sizeBytes'),
        sha256: str(a, 'sha256'),
        kind: a.kind === 'summary' ? 'summary' : 'output',
        redacted: a.redacted === true,
        createdAt: str(a, 'createdAt'),
        prunedReason: prunedReasonOf(a),
      };
    }),
    total: typeof o.total === 'number' ? o.total : list(o, 'artifacts').length,
    archive: archiveOf(o),
    inputs: list(o, 'inputs').map((x) => {
      const i = obj(x);
      return {
        id: str(i, 'id'),
        name: str(i, 'name'),
        mediaType: str(i, 'mediaType'),
        sizeBytes: int(i, 'sizeBytes'),
        sha256: str(i, 'sha256'),
        source:
          i.source === 'artifact' || i.source === 'upstream' || i.source === 'subtask' ? i.source : 'upload',
        sourceJobId: nullableStr(i, 'sourceJobId'),
        prunedReason: prunedReasonOf(i),
      };
    }),
  };
}

export function listJobArtifacts(
  jobId: string,
  opts: Opts & { readonly offset?: number; readonly limit?: number; readonly q?: string } = {},
): Promise<JobArtifacts> {
  const { offset, limit, q: filter, ...rest } = opts;
  const q = new URLSearchParams();
  if (limit !== undefined) q.set('limit', String(limit));
  if (offset !== undefined && offset > 0) q.set('offset', String(offset));
  // p18-outputs-delivery: a file-name filter, applied by the master (the total counts the matches).
  if (filter !== undefined && filter.trim() !== '') q.set('q', filter.trim());
  const qs = q.toString();
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/artifacts${qs === '' ? '' : `?${qs}`}`,
    parseJobArtifacts,
    rest,
  );
}

/** p17-output-limits: the API path of "Hepsini indir (zip)" (download by navigation, streamed by the master). */
export function artifactsZipPath(jobId: string): string {
  return `/jobs/${enc(jobId)}/artifacts/all.zip`;
}

// ------------------------------------------------------------------------------- output report (p17-output-limits)

/** Why a file of `out/` was not returned (protocol OutputSkipCode, plus the master's `quota`). */
export type OutputSkipCode =
  | 'type'
  | 'too_large'
  | 'count'
  | 'inline_budget'
  | 'job_bytes'
  | 'secret'
  | 'content'
  | 'symlink'
  | 'not_regular'
  | 'nested'
  | 'unreadable'
  | 'upload'
  | 'zip_full'
  | 'not_listed'
  | 'quota'
  | 'other';

const SKIP_CODES: ReadonlySet<string> = new Set<OutputSkipCode>([
  'type',
  'too_large',
  'count',
  'inline_budget',
  'job_bytes',
  'secret',
  'content',
  'symlink',
  'not_regular',
  'nested',
  'unreadable',
  'upload',
  'zip_full',
  'not_listed',
  'quota',
  'other',
]);

export interface OutputReport {
  readonly maxFiles: number | null;
  readonly returned: number | null;
  readonly storage: boolean | null;
  readonly zip: { readonly name: string; readonly files: number; readonly bytes: number } | null;
  readonly skipped: readonly {
    readonly name: string;
    readonly code: OutputSkipCode;
    readonly reason: string;
  }[];
  readonly skippedCount: number;
}

export function parseOutputReport(v: unknown): OutputReport | null {
  const o = obj(v);
  if (o.report === null || o.report === undefined) return null;
  const r = obj(o.report);
  const z = r.zip === null || r.zip === undefined ? null : obj(r.zip);
  return {
    maxFiles: nullableInt(r, 'maxFiles'),
    returned: nullableInt(r, 'returned'),
    storage: typeof r.storage === 'boolean' ? r.storage : null,
    zip: z === null ? null : { name: str(z, 'name'), files: int(z, 'files'), bytes: int(z, 'bytes') },
    skipped: list(r, 'skipped').map((x) => {
      const s = obj(x);
      const code = str(s, 'code');
      return {
        name: str(s, 'name'),
        code: SKIP_CODES.has(code) ? (code as OutputSkipCode) : 'other',
        reason: str(s, 'reason'),
      };
    }),
    skippedCount: int(r, 'skippedCount'),
  };
}

/** What became of the job's `out/` (null: nothing to say — no report, nothing refused). */
export function getOutputReport(jobId: string, opts: Opts = {}): Promise<OutputReport | null> {
  return apiRequest('GET', `/jobs/${enc(jobId)}/output-report`, parseOutputReport, opts);
}

/**
 * p18-outputs-delivery: the zipped-delivery facts ("600 dosya üretildi: 499’u tek tek, 101’i out-rest.zip içinde (iş
 * başına 500 dosya sınırı)") — null when no overflow zip was made. `returned` counts the zip as one file.
 */
export function deliveredOf(r: OutputReport | null): {
  readonly total: number;
  readonly single: number;
  readonly zipped: number;
  readonly name: string;
  readonly max: number;
} | null {
  if (r?.zip == null || r.returned === null) return null;
  const single = Math.max(0, r.returned - 1);
  return {
    total: single + r.zip.files,
    single,
    zipped: r.zip.files,
    name: r.zip.name,
    max: r.maxFiles ?? r.returned,
  };
}

/** Skipped files grouped by reason code (count, first names), most frequent first. */
export function skippedByCode(
  r: OutputReport,
): { readonly code: OutputSkipCode; readonly count: number; readonly names: readonly string[] }[] {
  const by = new Map<OutputSkipCode, string[]>();
  for (const s of r.skipped) by.set(s.code, [...(by.get(s.code) ?? []), s.name]);
  return [...by.entries()]
    .map(([code, names]) => ({ code, count: names.length, names }))
    .sort((a, b) => b.count - a.count);
}

/** An artifact's bytes; `inline` asks for the preview disposition (allowed types only). */
export function fetchArtifact(
  jobId: string,
  artifactId: string,
  inline: boolean,
  opts: { readonly fetchImpl?: typeof fetch } = {},
): Promise<FetchedBlob> {
  return fetchBlob(`/jobs/${enc(jobId)}/artifacts/${enc(artifactId)}${inline ? '?inline=1' : ''}`, opts);
}

/**
 * Same-origin URL of an artifact's inline preview, for an `<img src>` (p9-files-image-preview). The console's CSP
 * allows `img-src 'self' data:` only, so a `blob:` object URL would render as a broken image; the master serves
 * allowlisted raster types inline with their own media type, nosniff and CORP same-origin, and the session cookie
 * authorises the request like any other GET.
 */
export function artifactInlineUrl(jobId: string, artifactId: string): string {
  return `${API_PREFIX}/jobs/${enc(jobId)}/artifacts/${enc(artifactId)}?inline=1`;
}

export function fetchInput(
  jobId: string,
  inputId: string,
  opts: { readonly fetchImpl?: typeof fetch } = {},
): Promise<FetchedBlob> {
  return fetchBlob(`/jobs/${enc(jobId)}/inputs/${enc(inputId)}`, opts);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** Why a file is gone, for people. */
export function prunedText(reason: PrunedReason): string {
  return reason === 'quota'
    ? 'Removed to keep the workspace within its storage quota'
    : 'Removed by the workspace retention policy';
}

/** A file to upload with a submission (base64 content). */
export interface UploadFile {
  readonly name: string;
  readonly contentBase64: string;
}
