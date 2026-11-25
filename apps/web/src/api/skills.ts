import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/** Typed wrappers for the skills routes (apps/master/src/skills/routes.ts, p6-skills). */

export interface SkillVersion {
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly runtimes: readonly string[];
  readonly manifestSha256: string;
  readonly keyId: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly uploadedAt: string;
  /** p5-machine-admin (ADR-0021): which key signed it — the owner's offline key or the panel skills key. */
  readonly signer: 'offline' | 'panel' | 'unknown';
  /** p14-skill-import: where a panel-signed version came from (null: the offline upload path). */
  readonly provenance: SkillProvenance | null;
  /** p14-skill-catalogs: 2 = only machines with the wider skill layout (skills-layout-v2) take this version. */
  readonly layout: SkillLayout;
}

/** p14-skill-catalogs: 1 = today's layout (every machine), 2 = the wider layout (skills-layout-v2 machines). */
export type SkillLayout = 1 | 2;

export interface LayoutLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxJobBytes: number;
}

export interface SkillProvenance {
  readonly kind: 'upload' | 'zip' | 'github' | 'catalog' | 'chat';
  readonly repo?: string;
  readonly path?: string;
  readonly commit?: string;
  readonly fileName?: string;
  readonly catalog?: string;
}

/** The panel-held skills key (chat-authored skills are signed with it on confirm). */
export interface PanelKey {
  readonly configured: boolean;
  readonly keyId: string | null;
}

/** Assignment project meaning "every project". */
export const ALL_PROJECTS = '*';

export interface SkillAssignment {
  readonly id: string;
  readonly skillId: string;
  readonly project: string;
  readonly runtimes: readonly string[] | null;
  readonly version: string | null;
  readonly updatedAt: string;
}

export interface Skill {
  readonly id: string;
  readonly deleted: boolean;
  readonly latest: string | null;
  readonly versions: readonly SkillVersion[];
  readonly assignments: readonly SkillAssignment[];
}

export interface SkillFile {
  readonly path: string;
  readonly sha256: string;
  readonly executable: boolean;
  readonly content: string;
}

type Opts = Omit<RequestOptions, 'body'>;

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError(`expected ${what}[]`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function version(v: unknown): SkillVersion {
  const o = obj(v);
  return {
    version: str(o, 'version'),
    title: str(o, 'title'),
    description: str(o, 'description'),
    runtimes: strArray(o, 'runtimes'),
    manifestSha256: str(o, 'manifestSha256'),
    keyId: str(o, 'keyId'),
    fileCount: int(o, 'fileCount'),
    totalBytes: int(o, 'totalBytes'),
    uploadedAt: str(o, 'uploadedAt'),
    signer: o.signer === 'offline' || o.signer === 'panel' ? o.signer : 'unknown',
    provenance: provenance(o.provenance),
    layout: o.layout === 2 ? 2 : 1,
  };
}

const PROVENANCE_KINDS = ['upload', 'zip', 'github', 'catalog', 'chat'] as const;

function optStr(o: Record<string, unknown>, key: string): { [k: string]: string } {
  const v = o[key];
  return typeof v === 'string' ? { [key]: v } : {};
}

function provenance(v: unknown): SkillProvenance | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const kind = PROVENANCE_KINDS.find((k) => k === o.kind);
  if (kind === undefined) return null;
  return {
    kind,
    ...optStr(o, 'repo'),
    ...optStr(o, 'path'),
    ...optStr(o, 'commit'),
    ...optStr(o, 'fileName'),
    ...optStr(o, 'catalog'),
  };
}

function assignment(v: unknown): SkillAssignment {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    skillId: str(o, 'skillId'),
    project: str(o, 'project'),
    runtimes: o.runtimes === null ? null : strArray(o, 'runtimes'),
    version: nullableStr(o, 'version'),
    updatedAt: str(o, 'updatedAt'),
  };
}

function panelKey(v: unknown): PanelKey {
  if (typeof v !== 'object' || v === null) return { configured: false, keyId: null };
  const o = v as Record<string, unknown>;
  return { configured: o.configured === true, keyId: typeof o.keyId === 'string' ? o.keyId : null };
}

export function listSkills(opts: Opts = {}): Promise<{
  configured: boolean;
  panelKey: PanelKey;
  skills: Skill[];
  /** p14-skill-import: projects that accept only offline-signed skills. */
  offlineOnlyProjects: string[];
  /** p14-skill-import: GitHub imports are enabled on the master. */
  githubImport: boolean;
  /** p14-skill-catalogs: limits of layout 1 and 2 (null from an older master). */
  layouts: { v1: LayoutLimits; v2: LayoutLimits } | null;
  /** p14-skill-catalogs: approved machines, and how many take layout-2 skills (null from an older master). */
  layoutV2Workers: { supported: number; total: number } | null;
}> {
  return apiRequest(
    'GET',
    '/skills',
    (v) => {
      const o = obj(v);
      return {
        configured: bool(o, 'configured'),
        panelKey: panelKey(o.panelKey),
        offlineOnlyProjects: Array.isArray(o.offlineOnlyProjects)
          ? o.offlineOnlyProjects.filter((p): p is string => typeof p === 'string')
          : [],
        githubImport:
          typeof o.imports === 'object' &&
          o.imports !== null &&
          (o.imports as { github?: unknown }).github === true,
        layouts: layoutsOf(o.layouts),
        layoutV2Workers:
          typeof o.layoutV2Workers === 'object' && o.layoutV2Workers !== null
            ? {
                supported: int(o.layoutV2Workers as Record<string, unknown>, 'supported'),
                total: int(o.layoutV2Workers as Record<string, unknown>, 'total'),
              }
            : null,
        skills: arr(o.skills, 'skills').map((s) => {
          const x = obj(s);
          return {
            id: str(x, 'id'),
            deleted: bool(x, 'deleted'),
            latest: nullableStr(x, 'latest'),
            versions: arr(x.versions, 'versions').map(version),
            assignments: arr(x.assignments, 'assignments').map(assignment),
          };
        }),
      };
    },
    opts,
  );
}

function limitsOf(v: unknown): LayoutLimits {
  const o = obj(v);
  return {
    maxFiles: int(o, 'maxFiles'),
    maxFileBytes: int(o, 'maxFileBytes'),
    maxTotalBytes: int(o, 'maxTotalBytes'),
    maxJobBytes: int(o, 'maxJobBytes'),
  };
}

function layoutsOf(v: unknown): { v1: LayoutLimits; v2: LayoutLimits } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return { v1: limitsOf(o.v1), v2: limitsOf(o.v2) };
}

export function skillFiles(id: string, ver: string, opts: Opts = {}): Promise<SkillFile[]> {
  return apiRequest(
    'GET',
    `/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(ver)}`,
    (v) =>
      arr(obj(v).files, 'files').map((f) => {
        const o = obj(f);
        return {
          path: str(o, 'path'),
          sha256: str(o, 'sha256'),
          executable: bool(o, 'executable'),
          content: str(o, 'content'),
        };
      }),
    opts,
  );
}

/** Uploads a bundle written by `scripts/skills/sign.mjs pack` (the master verifies the signature). */
export function uploadSkill(bundle: unknown, opts: Opts = {}): Promise<SkillVersion> {
  return apiRequest('POST', '/skills', version, { ...opts, body: bundle });
}

export function assignSkill(
  input: { skillId: string; project: string; runtimes: readonly string[] | null; version: string | null },
  opts: Opts = {},
): Promise<SkillAssignment> {
  return apiRequest('PUT', '/skills/assignments', assignment, { ...opts, body: input });
}

export function unassignSkill(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/skills/assignments/${encodeURIComponent(id)}`, () => undefined, opts);
}

// ------------------------------------------------------------------ p14-skill-import (ADR-0054)

export type ImportSource =
  | { readonly kind: 'files'; readonly files: readonly { readonly path: string; readonly data: string }[] }
  | { readonly kind: 'zip'; readonly fileName?: string; readonly data: string }
  | { readonly kind: 'github'; readonly url: string; readonly ref?: string }
  /** p14-skill-catalogs: an entry of a configured catalog (pinned to the listing's commit). */
  | { readonly kind: 'catalog'; readonly entryId: string };

export interface ImportFinding {
  readonly kind: string;
  readonly severity: 'block' | 'warn' | 'info';
  readonly path?: string;
  readonly line?: number;
  readonly rule?: string;
  readonly to?: string;
  readonly hosts?: readonly string[];
  readonly size?: number;
  readonly excerpt?: string;
}

export interface SkillImport {
  readonly id: string;
  readonly sourceKind: 'upload' | 'zip' | 'github' | 'catalog';
  readonly source: {
    readonly catalog?: string;
    readonly fileName?: string;
    readonly repo?: string;
    readonly path?: string;
    readonly ref?: string;
    readonly commit?: string;
    readonly url?: string;
  };
  readonly state: 'previewed' | 'published' | 'discarded' | 'expired';
  readonly blocked: boolean;
  readonly expiresAt: string;
  readonly suggested: {
    readonly skillId: string | null;
    readonly title: string | null;
    readonly description: string | null;
    readonly version: string;
  };
  readonly latest: string | null;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly executable: boolean;
    readonly content: string;
  }[];
  readonly excluded: readonly { readonly path: string; readonly size: number; readonly reason: string }[];
  readonly findings: readonly ImportFinding[];
  readonly totalBytes: number;
  readonly diff: string | null;
  readonly limits: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  };
  /** p14-skill-catalogs: 1 = every machine, 2 = skills-layout-v2 machines only, null = over the limits. */
  readonly layout: SkillLayout | null;
}

const SEVERITIES = ['block', 'warn', 'info'] as const;
const IMPORT_STATES = ['previewed', 'published', 'discarded', 'expired'] as const;
const SOURCE_KINDS = ['upload', 'zip', 'github', 'catalog'] as const;

function finding(v: unknown): ImportFinding {
  const o = obj(v);
  const severity = SEVERITIES.find((s) => s === o.severity) ?? 'info';
  return {
    kind: str(o, 'kind'),
    severity,
    ...optStr(o, 'path'),
    ...optStr(o, 'rule'),
    ...optStr(o, 'to'),
    ...optStr(o, 'excerpt'),
    ...(typeof o.line === 'number' ? { line: o.line } : {}),
    ...(typeof o.size === 'number' ? { size: o.size } : {}),
    ...(Array.isArray(o.hosts) ? { hosts: o.hosts.filter((h): h is string => typeof h === 'string') } : {}),
  };
}

function skillImport(v: unknown): SkillImport {
  const o = obj(v);
  const s = obj(o.suggested);
  const src = typeof o.source === 'object' && o.source !== null ? (o.source as Record<string, unknown>) : {};
  const limits = obj(o.limits);
  return {
    id: str(o, 'id'),
    sourceKind: SOURCE_KINDS.find((k) => k === o.sourceKind) ?? 'upload',
    source: {
      ...optStr(src, 'catalog'),
      ...optStr(src, 'fileName'),
      ...optStr(src, 'repo'),
      ...optStr(src, 'path'),
      ...optStr(src, 'ref'),
      ...optStr(src, 'commit'),
      ...optStr(src, 'url'),
    },
    state: IMPORT_STATES.find((k) => k === o.state) ?? 'expired',
    blocked: bool(o, 'blocked'),
    expiresAt: str(o, 'expiresAt'),
    suggested: {
      skillId: nullableStr(s, 'skillId'),
      title: nullableStr(s, 'title'),
      description: nullableStr(s, 'description'),
      version: str(s, 'version'),
    },
    latest: nullableStr(o, 'latest'),
    files: arr(o.files, 'files').map((f) => {
      const x = obj(f);
      return {
        path: str(x, 'path'),
        size: int(x, 'size'),
        executable: bool(x, 'executable'),
        content: str(x, 'content'),
      };
    }),
    excluded: arr(o.excluded, 'excluded').map((e) => {
      const x = obj(e);
      return { path: str(x, 'path'), size: int(x, 'size'), reason: str(x, 'reason') };
    }),
    findings: arr(o.findings, 'findings').map(finding),
    totalBytes: int(o, 'totalBytes'),
    diff: nullableStr(o, 'diff'),
    limits: {
      maxFiles: int(limits, 'maxFiles'),
      maxFileBytes: int(limits, 'maxFileBytes'),
      maxTotalBytes: int(limits, 'maxTotalBytes'),
    },
    layout: o.layout === 1 || o.layout === 2 ? o.layout : null,
  };
}

/** Reads a folder / zip / GitHub link into a preview (admin, step-up). Nothing is signed yet. */
export function previewSkillImport(source: ImportSource, opts: Opts = {}): Promise<SkillImport> {
  return apiRequest('POST', '/skills/imports', skillImport, { ...opts, body: source });
}

export function getSkillImport(id: string, opts: Opts = {}): Promise<SkillImport> {
  return apiRequest('GET', `/skills/imports/${encodeURIComponent(id)}`, skillImport, opts);
}

/** Signs the preview with the panel key and publishes it (admin, always-fresh step-up). */
export function publishSkillImport(
  id: string,
  input: {
    skillId: string;
    title: string;
    description: string;
    version: string;
    runtimes: readonly string[];
    assign: { project: string } | null;
  },
  opts: Opts = {},
): Promise<{ version: SkillVersion; assignment: SkillAssignment | null }> {
  return apiRequest(
    'POST',
    `/skills/imports/${encodeURIComponent(id)}/publish`,
    (v) => {
      const o = obj(v);
      return {
        version: version(o.version),
        assignment: o.assignment === null ? null : assignment(o.assignment),
      };
    },
    { ...opts, body: input },
  );
}

export function discardSkillImport(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/skills/imports/${encodeURIComponent(id)}`, () => undefined, opts);
}

export type SkillTrust = 'any' | 'offline-only';

export interface ProjectSkillTrust {
  readonly trust: SkillTrust;
  readonly panelSignedAssignments: readonly string[];
}

function trustView(v: unknown): ProjectSkillTrust {
  const o = obj(v);
  return {
    trust: o.trust === 'offline-only' ? 'offline-only' : 'any',
    panelSignedAssignments: strArray(o, 'panelSignedAssignments'),
  };
}

export function getSkillTrust(project: string, opts: Opts = {}): Promise<ProjectSkillTrust> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/skill-trust`, trustView, opts);
}

export function setSkillTrust(
  project: string,
  trust: SkillTrust,
  opts: Opts = {},
): Promise<ProjectSkillTrust> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/skill-trust`, trustView, {
    ...opts,
    body: { trust },
  });
}

// ------------------------------------------------------------------ p14-skill-catalogs (ADR-0054)

export type CatalogFit = 'v1' | 'v2' | 'too_large' | 'binary';

export interface CatalogSource {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly ref: string | null;
  readonly path: string;
  readonly enabled: boolean;
  readonly builtin: boolean;
  readonly commit: string | null;
  readonly listedAt: string | null;
  readonly error: string | null;
  readonly entryCount: number;
}

/** One skill folder of a catalog. Name and description are untrusted third-party text. */
export interface CatalogEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly repo: string;
  readonly path: string;
  readonly commit: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly fit: CatalogFit;
  readonly url: string;
}

const FITS = ['v1', 'v2', 'too_large', 'binary'] as const;

function catalogSource(v: unknown): CatalogSource {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    title: str(o, 'title'),
    repo: str(o, 'repo'),
    ref: nullableStr(o, 'ref'),
    path: str(o, 'path'),
    enabled: bool(o, 'enabled'),
    builtin: bool(o, 'builtin'),
    commit: nullableStr(o, 'commit'),
    listedAt: nullableStr(o, 'listedAt'),
    error: nullableStr(o, 'error'),
    entryCount: int(o, 'entryCount'),
  };
}

function catalogEntry(v: unknown): CatalogEntry {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    sourceId: str(o, 'sourceId'),
    repo: str(o, 'repo'),
    path: str(o, 'path'),
    commit: str(o, 'commit'),
    name: nullableStr(o, 'name'),
    description: nullableStr(o, 'description'),
    fileCount: int(o, 'fileCount'),
    totalBytes: int(o, 'totalBytes'),
    fit: FITS.find((f) => f === o.fit) ?? 'too_large',
    url: str(o, 'url'),
  };
}

/** Searches the configured skill catalogs (cached on the master, pinned to a commit). */
export function searchSkillCatalog(
  query: { q?: string; source?: string } = {},
  opts: Opts = {},
): Promise<{ enabled: boolean; sources: CatalogSource[]; entries: CatalogEntry[] }> {
  const params = new URLSearchParams();
  if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim());
  if (query.source !== undefined && query.source !== '') params.set('source', query.source);
  const qs = params.toString();
  return apiRequest(
    'GET',
    `/skills/catalog${qs === '' ? '' : `?${qs}`}`,
    (v) => {
      const o = obj(v);
      return {
        enabled: o.enabled === true,
        sources: arr(o.sources, 'sources').map(catalogSource),
        entries: arr(o.entries, 'entries').map(catalogEntry),
      };
    },
    opts,
  );
}

/** Reads a catalog source again now (admin). */
export function refreshCatalogSource(id: string, opts: Opts = {}): Promise<CatalogSource> {
  return apiRequest('POST', `/skills/catalog/sources/${encodeURIComponent(id)}/refresh`, catalogSource, opts);
}

/** Adds or changes a catalog source (admin, step-up). */
export function saveCatalogSource(
  id: string,
  input: { title: string; repo: string; ref: string | null; path: string; enabled: boolean },
  opts: Opts = {},
): Promise<CatalogSource> {
  return apiRequest('PUT', `/skills/catalog/sources/${encodeURIComponent(id)}`, catalogSource, {
    ...opts,
    body: input,
  });
}

/** Removes a catalog source (admin, step-up; the built-in one can only be switched off). */
export function deleteCatalogSource(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/skills/catalog/sources/${encodeURIComponent(id)}`, () => undefined, opts);
}
