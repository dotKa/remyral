import type pg from 'pg';
import { authorize, type Subject, visibleProjects } from '../authz/model.js';
import { HttpError } from '../http/errors.js';
import type { OutputFolders } from './folders.js';
import { JOB_TITLE_SQL } from '../jobs/approval-mode-sql.js';
import { titleOrDerived } from '../jobs/titles.js';
import type { OutputsService } from './service.js';

/**
 * p8-outputs-folders (docs/design/p8-outputs-folders.md §2): the automatic tree of the Outputs screen, one level per
 * request. Project → Folders / Sites / Notes / jobs with output files → the directories of each job's `out/` files
 * (the stored artifact name is the file's own path). Computed from the read model; nothing is stored.
 */

export type TreeKind = 'project' | 'personal' | 'folders' | 'sites' | 'notes' | 'job' | 'dir' | 'folder';

export interface TreeNode {
  readonly project: string | null;
  readonly path: string;
  readonly kind: TreeKind;
  readonly label: string;
  /** Items below (files of a job / directory, links of a folder, sites, notes); null when not counted. */
  readonly count: number | null;
  readonly hasChildren: boolean;
  readonly folderId?: string;
  readonly jobId?: string;
  readonly pinned?: boolean;
  readonly createdAt?: string;
}

export const TREE_PAGE = 100;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const JOB_PATH = new RegExp(`^job:(${UUID})((?:/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}){0,3})$`);
const FOLDER_PATH = new RegExp(`^folder:(${UUID})$`);

/** The parts of a tree path, or null when it is not one. */
export function parseTreePath(
  path: string,
):
  | { readonly kind: 'root' | 'personal' | 'folders' | 'sites' | 'notes' }
  | { readonly kind: 'folder'; readonly folderId: string }
  | { readonly kind: 'job'; readonly jobId: string; readonly dir: string }
  | null {
  if (path === '') return { kind: 'root' };
  if (path === 'personal' || path === 'folders' || path === 'sites' || path === 'notes')
    return { kind: path };
  const f = FOLDER_PATH.exec(path);
  if (f?.[1] !== undefined) return { kind: 'folder', folderId: f[1] };
  const j = JOB_PATH.exec(path);
  if (j?.[1] !== undefined) {
    const dir = (j[2] ?? '').slice(1);
    if (dir.split('/').some((s) => s === '..' || s.endsWith('.'))) return null;
    return { kind: 'job', jobId: j[1], dir };
  }
  return null;
}

/** p15-job-titles: the job's label is its title (stored, else derived from the prompt). */
function jobLabel(stored: string | null, prompt: string | null, id: string): string {
  if (stored === null && (prompt ?? '').trim() === '') return `Job ${id.slice(0, 8)}`;
  return titleOrDerived({ title_stored: stored, title_prompt: prompt });
}

export class OutputTree {
  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly outputs: OutputsService;
      readonly folders: OutputFolders;
    },
  ) {}

  async children(
    subject: Subject,
    project: string | undefined,
    path: string,
    offset = 0,
  ): Promise<{ nodes: TreeNode[]; total: number }> {
    const parsed = parseTreePath(path);
    if (parsed === null) throw new HttpError(400, 'invalid_path', 'Unknown tree path.');
    if (project === undefined) {
      if (parsed.kind === 'root') return this.#root(subject);
      if (parsed.kind === 'personal') return this.#folders(subject, { scope: 'personal' }, null, null);
      if (parsed.kind === 'folder') {
        return this.#folders(subject, { scope: 'personal' }, parsed.folderId, null);
      }
      throw new HttpError(
        400,
        'invalid_path',
        'This tree path needs a project.',
        {},
        {},
        { reason: 'needs_project' },
      );
    }
    if (!authorize(subject, 'outputs.read', { project }).allow) {
      throw new HttpError(404, 'project_not_found', 'Project not found.');
    }
    switch (parsed.kind) {
      case 'root':
        return this.#project(project, offset);
      case 'folders':
        return this.#folders(subject, { scope: 'project', project }, null, project);
      case 'folder':
        return this.#folders(subject, { scope: 'project', project }, parsed.folderId, project);
      case 'job':
        return this.#dirs(project, parsed.jobId, parsed.dir);
      case 'sites':
      case 'notes':
        return { nodes: [], total: 0 };
      case 'personal':
        throw new HttpError(
          400,
          'invalid_path',
          'Personal folders have no project.',
          {},
          {},
          { reason: 'personal' },
        );
    }
  }

  async #root(subject: Subject): Promise<{ nodes: TreeNode[]; total: number }> {
    const visible = visibleProjects(subject);
    const { rows } = await this.deps.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE ($1::text[] IS NULL OR id = ANY($1)) ORDER BY lower(name), id LIMIT 500`,
      [visible === null ? null : [...visible]],
    );
    const personal = await this.deps.folders.children(subject, { scope: 'personal' }, null);
    const nodes: TreeNode[] = [
      {
        project: null,
        path: 'personal',
        kind: 'personal',
        label: 'My folders',
        count: personal.length,
        hasChildren: personal.length > 0,
      },
      ...rows
        .filter((r) => authorize(subject, 'outputs.read', { project: r.id }).allow)
        .map((r): TreeNode => ({
          project: r.id,
          path: '',
          kind: 'project',
          label: r.name,
          count: null,
          hasChildren: true,
        })),
    ];
    return { nodes, total: nodes.length };
  }

  async #folders(
    subject: Subject,
    where: { scope: 'personal' } | { scope: 'project'; project: string },
    parentId: string | null,
    project: string | null,
  ): Promise<{ nodes: TreeNode[]; total: number }> {
    const list = await this.deps.folders.children(subject, where, parentId);
    const nodes = list.map((f): TreeNode => ({
      project,
      path: `folder:${f.id}`,
      kind: 'folder',
      label: f.name,
      count: f.itemCount,
      hasChildren: f.childCount > 0,
      folderId: f.id,
      pinned: f.pinned,
    }));
    return { nodes, total: nodes.length };
  }

  async #project(project: string, offset: number): Promise<{ nodes: TreeNode[]; total: number }> {
    const db = this.deps.pool;
    const head: TreeNode[] = [];
    if (offset === 0) {
      const counts = await db.query<{ folders: number; notes: number }>(
        `SELECT (SELECT count(*)::int FROM output_folders WHERE scope = 'project' AND project = $1 AND parent_id IS NULL)
                  AS folders,
                (SELECT count(*)::int FROM output_notes WHERE project = $1) AS notes`,
        [project],
      );
      const sites = await this.deps.outputs.list([project], { project, type: 'site', limit: 1 });
      const c = counts.rows[0] ?? { folders: 0, notes: 0 };
      head.push(
        {
          project,
          path: 'folders',
          kind: 'folders',
          label: 'Folders',
          count: c.folders,
          hasChildren: c.folders > 0,
        },
        { project, path: 'sites', kind: 'sites', label: 'Sites', count: sites.total, hasChildren: false },
        { project, path: 'notes', kind: 'notes', label: 'Notes', count: c.notes, hasChildren: false },
      );
    }
    // Jobs of the project with output files (workspace outputs, summaries, run artifacts), newest first.
    const { rows } = await db.query<{
      id: string;
      title_stored: string | null;
      prompt: string | null;
      created_at: Date;
      n: number;
      dirs: boolean;
      total: string;
    }>(
      `WITH f AS (
         SELECT a.job_id, count(DISTINCT a.artifact_id)::int AS n, bool_or(strpos(a.name, '/') > 0) AS dirs
           FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
          WHERE j.project = $1 AND a.kind IN ('output', 'summary')
          GROUP BY a.job_id
         UNION ALL
         SELECT e.job_id, count(DISTINCT e.payload->>'artifactId')::int AS n, false AS dirs
           FROM job_events e JOIN jobs j ON j.id = e.job_id
          WHERE j.project = $1 AND e.kind = 'artifact'
            AND coalesce(e.payload->>'artifactId', '') ~ '^[A-Za-z0-9_.:-]{1,128}$'
            AND (e.payload->>'artifactId') NOT LIKE 'ws-%'
            AND NOT EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = e.job_id
                              AND a.artifact_id = e.payload->>'artifactId')
          GROUP BY e.job_id)
       SELECT j.id::text AS id, ${JOB_TITLE_SQL('j')} AS title_stored, left(j.spec->>'prompt', 2000) AS prompt,
              j.created_at, sum(f.n)::int AS n,
              bool_or(f.dirs) AS dirs, count(*) OVER () AS total
         FROM f JOIN jobs j ON j.id = f.job_id
        GROUP BY j.id ORDER BY j.created_at DESC, j.id
        LIMIT ${String(TREE_PAGE)} OFFSET $2`,
      [project, offset],
    );
    const jobs = rows.map((r): TreeNode => ({
      project,
      path: `job:${r.id}`,
      kind: 'job',
      label: jobLabel(r.title_stored, r.prompt, r.id),
      count: r.n,
      hasChildren: r.dirs,
      jobId: r.id,
      createdAt: r.created_at.toISOString(),
    }));
    const totalJobs = Number(rows[0]?.total ?? 0);
    return { nodes: [...head, ...jobs], total: (offset === 0 ? head.length : 3) + totalJobs };
  }

  /** The directories one level below `dir` of the job's stored output files. */
  async #dirs(project: string, jobId: string, dir: string): Promise<{ nodes: TreeNode[]; total: number }> {
    const { rows } = await this.deps.pool.query<{ name: string }>(
      `SELECT DISTINCT ON (a.artifact_id) a.name
         FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
        WHERE a.job_id = $1 AND j.project = $2 AND a.kind IN ('output', 'summary')
        ORDER BY a.artifact_id, a.created_at DESC`,
      [jobId, project],
    );
    const prefix = dir === '' ? '' : `${dir}/`;
    const below = new Map<string, { files: number; deeper: boolean }>();
    for (const { name } of rows) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length).split('/');
      if (rest.length < 2) continue; // a file directly in this directory
      const seg = rest[0] ?? '';
      const cur = below.get(seg) ?? { files: 0, deeper: false };
      below.set(seg, { files: cur.files + 1, deeper: cur.deeper || rest.length > 2 });
    }
    const nodes = [...below.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([seg, v]): TreeNode => ({
        project,
        path: `job:${jobId}/${prefix}${seg}`,
        kind: 'dir',
        label: seg,
        count: v.files,
        hasChildren: v.deeper,
        jobId,
      }));
    return { nodes, total: nodes.length };
  }
}
