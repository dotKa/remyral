import { API_PREFIX, apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * p15-workspace-retention (apps/master/src/workfiles/routes.ts): "Çalışma dosyaları" — the whole working directory of
 * a repository-less job, kept on its machine after the job ended for the retention period. The console lists them,
 * shows a job's file tree, previews and downloads files (streamed from the machine through the master), cleans them
 * up, pushes them to a repository and makes a site upload of them.
 */

type Opts = Omit<RequestOptions, 'body'>;

export type WorkfilesState = 'kept' | 'deleting' | 'deleted' | 'lost';
export type WorkfilePreview =
  'html' | 'image' | 'pdf' | 'markdown' | 'json' | 'csv' | 'tsv' | 'text' | 'none';

export interface WorkfilesView {
  readonly jobId: string;
  readonly attemptId: string;
  readonly project: string;
  readonly jobTitle: string | null;
  readonly jobState: string | null;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly workerConnected: boolean;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly state: WorkfilesState;
  readonly sizeBytes: number;
  readonly files: number;
  readonly dropped: number;
  readonly redacted: number;
  readonly keptAt: string;
  readonly expiresAt: string;
  readonly pinnedUntil: string | null;
  readonly pinReason: string | null;
  readonly deleteReason: string | null;
  readonly deletedAt: string | null;
}

export interface WorkfileEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'other';
  readonly size: number;
  readonly mtime: string;
  readonly preview: WorkfilePreview;
}

export interface WorkfilesPin {
  readonly kind: string;
  readonly ref: string;
}

export interface WorkfilesSettings {
  readonly retentionDays: number;
  readonly machineCapBytes: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly limits: {
    readonly retentionDaysMax: number;
    readonly machineCapBytesMin: number;
    readonly machineCapBytesMax: number;
  };
}

export interface ProjectWorkfilesPolicy {
  readonly project: string;
  readonly retentionDays: number | null;
  readonly effectiveDays: number;
  readonly globalDays: number;
}

const s = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new ShapeError(`${k} must be a string`);
  return v;
};
const ns = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ShapeError(`${k} must be a string or null`);
  return v;
};
const n = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number') throw new ShapeError(`${k} must be a number`);
  return v;
};

const STATES: ReadonlySet<string> = new Set(['kept', 'deleting', 'deleted', 'lost']);
const OUTCOMES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);
const PREVIEWS: ReadonlySet<string> = new Set([
  'html',
  'image',
  'pdf',
  'markdown',
  'json',
  'csv',
  'tsv',
  'text',
  'none',
]);

export function parseWorkfiles(raw: unknown): WorkfilesView {
  const o = obj(raw);
  const state = s(o, 'state');
  const outcome = s(o, 'outcome');
  if (!STATES.has(state)) throw new ShapeError('state');
  if (!OUTCOMES.has(outcome)) throw new ShapeError('outcome');
  return {
    jobId: s(o, 'jobId'),
    attemptId: s(o, 'attemptId'),
    project: s(o, 'project'),
    jobTitle: ns(o, 'jobTitle'),
    jobState: ns(o, 'jobState'),
    workerId: s(o, 'workerId'),
    workerName: ns(o, 'workerName'),
    workerConnected: o.workerConnected === true,
    outcome: outcome as WorkfilesView['outcome'],
    state: state as WorkfilesState,
    sizeBytes: n(o, 'sizeBytes'),
    files: n(o, 'files'),
    dropped: typeof o.dropped === 'number' ? o.dropped : 0,
    redacted: typeof o.redacted === 'number' ? o.redacted : 0,
    keptAt: s(o, 'keptAt'),
    expiresAt: s(o, 'expiresAt'),
    pinnedUntil: ns(o, 'pinnedUntil'),
    pinReason: ns(o, 'pinReason'),
    deleteReason: ns(o, 'deleteReason'),
    deletedAt: ns(o, 'deletedAt'),
  };
}

function parseEntry(raw: unknown): WorkfileEntry {
  const o = obj(raw);
  const kind = s(o, 'kind');
  const preview = s(o, 'preview');
  if (kind !== 'file' && kind !== 'dir' && kind !== 'other') throw new ShapeError('kind');
  return {
    path: s(o, 'path'),
    kind,
    size: n(o, 'size'),
    mtime: s(o, 'mtime'),
    preview: (PREVIEWS.has(preview) ? preview : 'none') as WorkfilePreview,
  };
}

const enc = encodeURIComponent;

export function listWorkfiles(
  filter: { project?: string; worker?: string; state?: 'kept' | 'all'; limit?: number } = {},
  opts: Opts = {},
): Promise<{
  items: WorkfilesView[];
  totals: { bytes: number; count: number };
  settings: { retentionDays: number; machineCapBytes: number };
}> {
  const q = new URLSearchParams();
  if (filter.project !== undefined) q.set('project', filter.project);
  if (filter.worker !== undefined) q.set('worker', filter.worker);
  if (filter.state !== undefined) q.set('state', filter.state);
  if (filter.limit !== undefined) q.set('limit', String(filter.limit));
  return apiRequest(
    'GET',
    `/workfiles${q.size === 0 ? '' : `?${q.toString()}`}`,
    (b) => {
      const o = obj(b);
      if (!Array.isArray(o.items)) throw new ShapeError('items must be an array');
      const t = obj(o.totals);
      const st = obj(o.settings);
      return {
        items: o.items.map(parseWorkfiles),
        totals: { bytes: n(t, 'bytes'), count: n(t, 'count') },
        settings: { retentionDays: n(st, 'retentionDays'), machineCapBytes: n(st, 'machineCapBytes') },
      };
    },
    opts,
  );
}

export function getJobWorkfiles(
  jobId: string,
  opts: Opts = {},
): Promise<{ workfiles: WorkfilesView | null; pins: WorkfilesPin[]; retentionDays: number }> {
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/workfiles`,
    (b) => {
      const o = obj(b);
      return {
        workfiles: o.workfiles === null || o.workfiles === undefined ? null : parseWorkfiles(o.workfiles),
        pins: Array.isArray(o.pins)
          ? o.pins.map((p) => {
              const x = obj(p);
              return { kind: s(x, 'kind'), ref: s(x, 'ref') };
            })
          : [],
        retentionDays: typeof o.retentionDays === 'number' ? o.retentionDays : 0,
      };
    },
    opts,
  );
}

export function getWorkfilesTree(
  jobId: string,
  opts: Opts = {},
): Promise<{ workfiles: WorkfilesView; entries: WorkfileEntry[]; truncated: boolean }> {
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/workfiles/tree`,
    (b) => {
      const o = obj(b);
      if (!Array.isArray(o.entries)) throw new ShapeError('entries must be an array');
      return {
        workfiles: parseWorkfiles(o.workfiles),
        entries: o.entries.map(parseEntry),
        truncated: o.truncated === true,
      };
    },
    opts,
  );
}

/** Same-origin route of one kept file (`inline` previews; downloads otherwise). */
export function workfileUrl(jobId: string, path: string, inline: boolean): string {
  return `${API_PREFIX}/jobs/${enc(jobId)}/workfiles/file?path=${enc(path)}${inline ? '&inline=1' : ''}`;
}

/** The API path of a kept file (for `useText`, which adds the prefix itself). */
export function workfilePath(jobId: string, path: string): string {
  return `/jobs/${enc(jobId)}/workfiles/file?path=${enc(path)}&inline=1`;
}

export function workfilesZipUrl(jobId: string): string {
  return `${API_PREFIX}/jobs/${enc(jobId)}/workfiles/zip`;
}

export function removeWorkfiles(jobId: string, opts: Opts = {}): Promise<WorkfilesView> {
  return apiRequest('DELETE', `/jobs/${enc(jobId)}/workfiles`, (b) => parseWorkfiles(obj(b).workfiles), opts);
}

export function cleanupWorkfiles(
  scope: { worker?: string; project?: string },
  opts: Opts = {},
): Promise<{
  removed: number;
  bytes: number;
  pending: number;
  skipped: { jobId: string; reasons: string }[];
}> {
  return apiRequest(
    'POST',
    '/workfiles/cleanup',
    (b) => {
      const o = obj(b);
      return {
        removed: n(o, 'removed'),
        bytes: n(o, 'bytes'),
        pending: n(o, 'pending'),
        skipped: Array.isArray(o.skipped)
          ? o.skipped.map((x) => {
              const y = obj(x);
              return { jobId: s(y, 'jobId'), reasons: s(y, 'reasons') };
            })
          : [],
      };
    },
    { ...opts, body: scope },
  );
}

export interface ExportRequest {
  readonly project: string;
  readonly directory?: string;
  readonly targetPath?: string;
  readonly branch?: string;
  readonly title?: string;
  readonly newRepository?: { readonly name: string; readonly owner?: string; readonly private?: boolean };
}

export interface ExportResult {
  readonly mode: 'branch_pr' | 'new_repo';
  readonly project: string;
  readonly branch: string;
  readonly commit: string;
  readonly files: number;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly repository: { readonly fullName: string; readonly htmlUrl: string } | null;
}

export function exportWorkfiles(jobId: string, body: ExportRequest, opts: Opts = {}): Promise<ExportResult> {
  return apiRequest(
    'POST',
    `/jobs/${enc(jobId)}/workfiles/export`,
    (b) => {
      const o = obj(obj(b).export);
      const mode = s(o, 'mode');
      const pr = o.pullRequest === null || o.pullRequest === undefined ? null : obj(o.pullRequest);
      const repo = o.repository === null || o.repository === undefined ? null : obj(o.repository);
      return {
        mode: mode === 'new_repo' ? 'new_repo' : 'branch_pr',
        project: s(o, 'project'),
        branch: s(o, 'branch'),
        commit: s(o, 'commit'),
        files: n(o, 'files'),
        pullRequest: pr === null ? null : { number: n(pr, 'number'), url: s(pr, 'url') },
        repository: repo === null ? null : { fullName: s(repo, 'fullName'), htmlUrl: s(repo, 'htmlUrl') },
      };
    },
    { ...opts, body },
  );
}

export function siteUploadFromWorkfiles(
  jobId: string,
  body: { project: string; directory?: string },
  opts: Opts = {},
): Promise<{ uploadId: string; project: string; files: number }> {
  return apiRequest(
    'POST',
    `/jobs/${enc(jobId)}/workfiles/site-upload`,
    (b) => {
      const o = obj(obj(b).upload);
      return { uploadId: s(o, 'uploadId'), project: s(o, 'project'), files: n(o, 'files') };
    },
    { ...opts, body },
  );
}

function parseSettings(b: unknown): WorkfilesSettings {
  const o = obj(b);
  const l = obj(o.limits);
  return {
    retentionDays: n(o, 'retentionDays'),
    machineCapBytes: n(o, 'machineCapBytes'),
    updatedAt: s(o, 'updatedAt'),
    updatedBy: ns(o, 'updatedBy'),
    limits: {
      retentionDaysMax: n(l, 'retentionDaysMax'),
      machineCapBytesMin: n(l, 'machineCapBytesMin'),
      machineCapBytesMax: n(l, 'machineCapBytesMax'),
    },
  };
}

export function getWorkfilesSettings(opts: Opts = {}): Promise<WorkfilesSettings> {
  return apiRequest('GET', '/settings/workfiles', parseSettings, opts);
}

export function putWorkfilesSettings(
  body: { retentionDays?: number; machineCapBytes?: number },
  opts: Opts = {},
): Promise<WorkfilesSettings> {
  return apiRequest('PUT', '/settings/workfiles', parseSettings, { ...opts, body });
}

function parsePolicy(b: unknown): ProjectWorkfilesPolicy {
  const o = obj(b);
  return {
    project: s(o, 'project'),
    retentionDays: typeof o.retentionDays === 'number' ? o.retentionDays : null,
    effectiveDays: n(o, 'effectiveDays'),
    globalDays: n(o, 'globalDays'),
  };
}

export function getProjectWorkfilesPolicy(project: string, opts: Opts = {}): Promise<ProjectWorkfilesPolicy> {
  return apiRequest('GET', `/projects/${enc(project)}/workfiles`, parsePolicy, opts);
}

export function putProjectWorkfilesPolicy(
  project: string,
  retentionDays: number | null,
  opts: Opts = {},
): Promise<ProjectWorkfilesPolicy> {
  return apiRequest('PUT', `/projects/${enc(project)}/workfiles`, parsePolicy, {
    ...opts,
    body: { retentionDays },
  });
}

/** Images of a listing, in tree order (the lightbox's sequence). */
export function imageEntries(entries: readonly WorkfileEntry[]): WorkfileEntry[] {
  return entries.filter((e) => e.kind === 'file' && e.preview === 'image');
}
