import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p8-outputs-folders (docs/design/p8-outputs-folders.md): own folders (project folders shared with the project,
 * personal folders of their creator) and the automatic Outputs tree. Folder names, notes and tags are untrusted text.
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

export const FOLDER_DEPTH_MAX = 6;

export interface OutputFolder {
  readonly id: string;
  readonly scope: 'project' | 'personal';
  readonly project: string | null;
  readonly parentId: string | null;
  readonly depth: number;
  readonly name: string;
  readonly note: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly itemCount: number;
  readonly childCount: number;
  readonly createdBy: { readonly id: string | null; readonly username: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly writable: boolean;
  /** Breadcrumb (top first); only on single-folder answers. */
  readonly ancestors: readonly { readonly id: string; readonly name: string }[];
}

export type TreeKind = 'project' | 'personal' | 'folders' | 'sites' | 'notes' | 'job' | 'dir' | 'folder';
const KINDS: readonly TreeKind[] = [
  'project',
  'personal',
  'folders',
  'sites',
  'notes',
  'job',
  'dir',
  'folder',
];

export interface TreeNode {
  readonly project: string | null;
  readonly path: string;
  readonly kind: TreeKind;
  readonly label: string;
  readonly count: number | null;
  readonly hasChildren: boolean;
  readonly folderId: string | null;
  readonly jobId: string | null;
  readonly pinned: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function int(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(k);
  return v;
}

export function parseFolder(v: unknown): OutputFolder {
  const o = obj(v);
  const by = obj(o.createdBy ?? {});
  const scope = o.scope === 'personal' ? 'personal' : o.scope === 'project' ? 'project' : null;
  if (scope === null) throw new ShapeError('scope');
  const id = str(o, 'id');
  if (!UUID.test(id)) throw new ShapeError('id');
  return {
    id,
    scope,
    project: nullableStr(o, 'project'),
    parentId: nullableStr(o, 'parentId'),
    depth: int(o, 'depth'),
    name: str(o, 'name'),
    note: typeof o.note === 'string' ? o.note : '',
    tags: strArray(o, 'tags'),
    pinned: o.pinned === true,
    itemCount: int(o, 'itemCount'),
    childCount: int(o, 'childCount'),
    createdBy: { id: nullableStr(by, 'id'), username: nullableStr(by, 'username') },
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
    writable: o.writable === true,
    ancestors: Array.isArray(o.ancestors)
      ? o.ancestors.map((a) => {
          const x = obj(a);
          return { id: str(x, 'id'), name: str(x, 'name') };
        })
      : [],
  };
}

export function parseTreeNode(v: unknown): TreeNode {
  const o = obj(v);
  const kind = KINDS.find((k) => k === o.kind);
  if (kind === undefined) throw new ShapeError('kind');
  return {
    project: nullableStr(o, 'project'),
    path: str(o, 'path'),
    kind,
    label: str(o, 'label'),
    count: typeof o.count === 'number' ? o.count : null,
    hasChildren: o.hasChildren === true,
    folderId: typeof o.folderId === 'string' && UUID.test(o.folderId) ? o.folderId : null,
    jobId: typeof o.jobId === 'string' && UUID.test(o.jobId) ? o.jobId : null,
    pinned: o.pinned === true,
  };
}

function items<T>(parse: (v: unknown) => T): (v: unknown) => T[] {
  return (v) => {
    const o = obj(v);
    if (!Array.isArray(o.items)) throw new ShapeError('items');
    return o.items.map(parse);
  };
}

/** Project folders of `project` (when given) plus the caller's personal folders, flat (parents first). */
export function listFolders(project?: string, opts: Opts = {}): Promise<OutputFolder[]> {
  return apiRequest(
    'GET',
    `/outputs/folders${project === undefined || project === '' ? '' : `?project=${enc(project)}`}`,
    items(parseFolder),
    opts,
  );
}

export function getFolder(id: string, opts: Opts = {}): Promise<OutputFolder> {
  return apiRequest('GET', `/outputs/folders/${enc(id)}`, parseFolder, opts);
}

export interface FolderInput {
  readonly scope: 'project' | 'personal';
  readonly project?: string;
  readonly parentId?: string | null;
  readonly name: string;
  readonly note?: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
}

export function createFolder(input: FolderInput, opts: Opts = {}): Promise<OutputFolder> {
  return apiRequest('POST', '/outputs/folders', parseFolder, { ...opts, body: input });
}

export function updateFolder(
  id: string,
  patch: {
    readonly name?: string;
    readonly note?: string;
    readonly tags?: readonly string[];
    readonly pinned?: boolean;
    readonly parentId?: string | null;
  },
  opts: Opts = {},
): Promise<OutputFolder> {
  return apiRequest('PATCH', `/outputs/folders/${enc(id)}`, parseFolder, { ...opts, body: patch });
}

export function deleteFolder(id: string, opts: Opts = {}): Promise<{ folders: number; links: number }> {
  return apiRequest(
    'DELETE',
    `/outputs/folders/${enc(id)}`,
    (v) => {
      const o = obj(v);
      return { folders: int(o, 'folders'), links: int(o, 'links') };
    },
    opts,
  );
}

export function linkItems(
  id: string,
  project: string,
  keys: readonly string[],
  opts: Opts = {},
): Promise<{ added: number; already: number; refused: readonly string[] }> {
  return apiRequest(
    'POST',
    `/outputs/folders/${enc(id)}/items`,
    (v) => {
      const o = obj(v);
      return { added: int(o, 'added'), already: int(o, 'already'), refused: strArray(o, 'refused') };
    },
    { ...opts, body: { project, keys } },
  );
}

export function unlinkItems(
  id: string,
  project: string,
  keys: readonly string[],
  opts: Opts = {},
): Promise<number> {
  return apiRequest('POST', `/outputs/folders/${enc(id)}/items/remove`, (v) => int(obj(v), 'removed'), {
    ...opts,
    body: { project, keys },
  });
}

export function itemFolders(project: string, key: string, opts: Opts = {}): Promise<OutputFolder[]> {
  return apiRequest(
    'GET',
    `/outputs/item-folders?project=${enc(project)}&key=${enc(key)}`,
    items(parseFolder),
    opts,
  );
}

/** One level of the automatic tree. */
export function getTree(
  project: string | null,
  path: string,
  offset = 0,
  opts: Opts = {},
): Promise<{ nodes: TreeNode[]; total: number }> {
  const q = new URLSearchParams();
  if (project !== null) q.set('project', project);
  if (path !== '') q.set('path', path);
  if (offset > 0) q.set('offset', String(offset));
  const s = q.toString();
  return apiRequest(
    'GET',
    `/outputs/tree${s === '' ? '' : `?${s}`}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.nodes)) throw new ShapeError('nodes');
      return { nodes: o.nodes.map(parseTreeNode), total: typeof o.total === 'number' ? o.total : 0 };
    },
    opts,
  );
}

/** The path of a folder in a flat list ("Reports / Weekly"), bounded by the depth limit. */
export function folderPath(folder: OutputFolder, all: readonly OutputFolder[]): string {
  const byId = new Map(all.map((f) => [f.id, f]));
  const names = [folder.name];
  let cur = folder.parentId === null ? undefined : byId.get(folder.parentId);
  for (let i = 0; cur !== undefined && i < FOLDER_DEPTH_MAX; i += 1) {
    names.unshift(cur.name);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return names.join(' / ');
}

/** Drag-and-drop payload type of an Outputs card. */
export const DRAG_TYPE = 'application/x-remyral-output';

export function dragPayload(project: string, key: string): string {
  return JSON.stringify({ project, key });
}

/** The dropped item, or null for anything that is not an Outputs card. */
export function parseDragPayload(raw: string): { project: string; key: string } | null {
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== 'object' || o === null) return null;
    const { project, key } = o as { project?: unknown; key?: unknown };
    if (typeof project !== 'string' || typeof key !== 'string') return null;
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(project) ||
      !/^(site|file|run|note):[A-Za-z0-9_.:+-]{1,300}$/.test(key)
    ) {
      return null;
    }
    return { project, key };
  } catch {
    return null;
  }
}
