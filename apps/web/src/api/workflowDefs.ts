import { type ApiIssue, apiRequest, int, obj, ShapeError, str } from './client';

/**
 * p13-workflows-ui: the workflow catalogue routes (apps/master/src/workflows/routes.ts, docs/design/p13-workflows-ui.md
 * §4) — the definitions with their run statistics, one full definition document, its versions, a new version, archive,
 * duplicate and validation without saving. Definition documents are JSON objects (the master's schema, strict); the
 * console never interprets prompts — they are text.
 */

type Opts = { readonly signal?: AbortSignal };

export interface WorkflowSummary {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly version: number;
  readonly nodes: number;
  readonly edges: number;
  readonly description: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly lastRun: { readonly id: string; readonly state: string; readonly createdAt: string } | null;
  /**
   * p18-multi-project: set on a workflow `project` attached from another project — `id` is the owner's version it
   * runs (open it with `?project=`); absent on the project's own workflows.
   */
  readonly attachment?: {
    readonly id: string;
    readonly ownerProject: string;
    readonly state: string;
    readonly follow: string;
    readonly latestVersion: number;
    readonly pendingVersion: number | null;
  };
}

const num = (o: Record<string, unknown>, k: string): number =>
  typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] : 0;
const optStr = (o: Record<string, unknown>, k: string): string | null =>
  typeof o[k] === 'string' ? o[k] : null;

function parseSummary(x: unknown): WorkflowSummary {
  const o = obj(x);
  const last = typeof o.lastRun === 'object' && o.lastRun !== null ? obj(o.lastRun) : null;
  const att = typeof o.attachment === 'object' && o.attachment !== null ? obj(o.attachment) : null;
  return {
    ...(att === null
      ? {}
      : {
          attachment: {
            id: str(att, 'id'),
            ownerProject: str(att, 'ownerProject'),
            state: str(att, 'state'),
            follow: str(att, 'follow'),
            latestVersion: num(att, 'latestVersion'),
            pendingVersion: typeof att.pendingVersion === 'number' ? att.pendingVersion : null,
          },
        }),
    id: str(o, 'id'),
    project: str(o, 'project'),
    name: str(o, 'name'),
    version: int(o, 'version'),
    nodes: num(o, 'nodes'),
    edges: num(o, 'edges'),
    description: optStr(o, 'description'),
    createdAt: str(o, 'createdAt'),
    createdBy: optStr(o, 'createdBy'),
    archived: o.archived === true,
    archivedAt: optStr(o, 'archivedAt'),
    runs: num(o, 'runs'),
    succeeded: num(o, 'succeeded'),
    failed: num(o, 'failed'),
    lastRun:
      last === null
        ? null
        : { id: str(last, 'id'), state: str(last, 'state'), createdAt: str(last, 'createdAt') },
  };
}

/** Latest version of every workflow of the visible projects (archived ones included, flagged). */
export function listWorkflows(opts: Opts = {}): Promise<WorkflowSummary[]> {
  return apiRequest(
    'GET',
    '/workflows',
    (v) => {
      const d = obj(v).definitions;
      if (!Array.isArray(d)) throw new ShapeError('expected definitions');
      return d.map(parseSummary);
    },
    opts,
  );
}

/** A workflow definition document (the master's schema; unknown here beyond the parts the editor edits). */
export type WorkflowDoc = Record<string, unknown>;

export interface WorkflowDocument {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly version: number;
  readonly latestVersion: number;
  readonly latestId: string;
  readonly archived: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  /** Viewers may not see step prompts: the master sends them empty and says so. */
  readonly promptsHidden: boolean;
  readonly definition: WorkflowDoc;
  /** p18-multi-project: read through a project that attached it (null: the owner project's view). */
  readonly attachment: {
    readonly id: string;
    readonly project: string;
    readonly state: string;
    readonly follow: string;
    readonly version: number;
    readonly pendingVersion: number | null;
  } | null;
}

export function parseDocument(v: unknown): WorkflowDocument {
  const o = obj(v);
  const version = int(o, 'version');
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    name: str(o, 'name'),
    version,
    latestVersion: typeof o.latestVersion === 'number' ? o.latestVersion : version,
    latestId: optStr(o, 'latestId') ?? str(o, 'id'),
    archived: o.archived === true,
    createdBy: optStr(o, 'createdBy'),
    createdAt: str(o, 'createdAt'),
    promptsHidden: o.promptsHidden === true,
    definition: obj(o.definition),
    attachment: (() => {
      if (typeof o.attachment !== 'object' || o.attachment === null) return null;
      const a = obj(o.attachment);
      return {
        id: str(a, 'id'),
        project: str(a, 'project'),
        state: str(a, 'state'),
        follow: str(a, 'follow'),
        version: int(a, 'version'),
        pendingVersion: typeof a.pendingVersion === 'number' ? a.pendingVersion : null,
      };
    })(),
  };
}

/** `?project=` (p18-multi-project) of a request read through a project that attached the workflow. */
const viaProject = (project: string | undefined): string =>
  project === undefined || project === '' ? '' : `?project=${encodeURIComponent(project)}`;

export function getWorkflowDocument(
  id: string,
  opts: Opts & { readonly project?: string } = {},
): Promise<WorkflowDocument> {
  const { project, ...rest } = opts;
  return apiRequest(
    'GET',
    `/workflows/${encodeURIComponent(id)}/definition${viaProject(project)}`,
    parseDocument,
    rest,
  );
}

export interface SavedWorkflow {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  /** p18-multi-project: projects that attached it — moved to this version, waiting for their admin, pinned. */
  readonly attachments?: {
    readonly advanced: readonly string[];
    readonly pending: readonly string[];
    readonly pinned: readonly string[];
  };
}

const parseSaved = (v: unknown): SavedWorkflow => {
  const o = obj(v);
  const a = typeof o.attachments === 'object' && o.attachments !== null ? obj(o.attachments) : null;
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y) => typeof y === 'string') : []);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    version: int(o, 'version'),
    ...(a === null
      ? {}
      : { attachments: { advanced: list(a.advanced), pending: list(a.pending), pinned: list(a.pinned) } }),
  };
};

/** A new workflow (version 1 of project + name; an existing name gets its next version). */
export function createWorkflow(project: string, definition: WorkflowDoc): Promise<SavedWorkflow> {
  return apiRequest('POST', '/workflows', parseSaved, { body: { project, definition } });
}

/** A new version of the workflow `id` belongs to (409 version_conflict when someone saved in between). */
export function saveWorkflowVersion(
  id: string,
  definition: WorkflowDoc,
  baseVersion: number,
): Promise<SavedWorkflow> {
  return apiRequest('PUT', `/workflows/${encodeURIComponent(id)}`, parseSaved, {
    body: { definition, baseVersion },
  });
}

export interface WorkflowVersion {
  readonly id: string;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly hash: string;
  readonly nodes: number;
  readonly edges: number;
}

export function listWorkflowVersions(
  id: string,
  opts: Opts & { readonly project?: string } = {},
): Promise<WorkflowVersion[]> {
  const { project, ...rest } = opts;
  return apiRequest(
    'GET',
    `/workflows/${encodeURIComponent(id)}/versions${viaProject(project)}`,
    (v) => {
      const d = obj(v).versions;
      if (!Array.isArray(d)) throw new ShapeError('expected versions');
      return d.map((x) => {
        const o = obj(x);
        return {
          id: str(o, 'id'),
          version: int(o, 'version'),
          createdBy: optStr(o, 'createdBy'),
          createdAt: str(o, 'createdAt'),
          hash: optStr(o, 'hash') ?? '',
          nodes: num(o, 'nodes'),
          edges: num(o, 'edges'),
        };
      });
    },
    rest,
  );
}

export function archiveWorkflow(id: string, archived: boolean, reason = ''): Promise<boolean> {
  return apiRequest(
    'POST',
    `/workflows/${encodeURIComponent(id)}/${archived ? 'archive' : 'unarchive'}`,
    (v) => obj(v).archived === true,
    { body: archived ? (reason === '' ? {} : { reason }) : {} },
  );
}

/** Kopyala; p18-multi-project "Projeye kopyala": `targetProject` = a project that attached it (its own copy there). */
export function duplicateWorkflow(id: string, name: string, targetProject?: string): Promise<SavedWorkflow> {
  return apiRequest('POST', `/workflows/${encodeURIComponent(id)}/duplicate`, parseSaved, {
    body: { name, ...(targetProject === undefined ? {} : { targetProject }) },
  });
}

export interface Validation {
  readonly ok: boolean;
  readonly issues: readonly ApiIssue[];
}

/** The master's own validation (schema, graph, every step as a job) without saving. */
export function validateWorkflow(project: string, definition: WorkflowDoc): Promise<Validation> {
  return apiRequest(
    'POST',
    '/workflows/validate',
    (v) => {
      const o = obj(v);
      const raw = Array.isArray(o.issues) ? o.issues : [];
      const issues = raw.flatMap((i) => {
        if (typeof i !== 'object' || i === null) return [];
        const r = i as Record<string, unknown>;
        return typeof r.path === 'string' && typeof r.code === 'string'
          ? [{ path: r.path, code: r.code }]
          : [];
      });
      return { ok: o.ok === true && issues.length === 0, issues };
    },
    { body: { project, definition } },
  );
}
