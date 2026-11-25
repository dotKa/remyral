import type { Queryable } from '../db/pool.js';
import { type Subject, visibleProjects } from '../authz/model.js';
import { HttpError } from '../http/errors.js';
import type { OutputFolders } from './folders.js';
import { LIMITS } from './model.js';
import { parseTreePath } from './tree.js';
import { uniquePaths, zipPath } from './zip.js';

/**
 * p8-outputs-folders (docs/design/p8-outputs-folders.md §4): what a folder-level ZIP holds — a node of the automatic
 * tree (project, job, directory) or an own folder with its sub-folders. Same bounds as the p6 multi-select ZIP
 * (≤ 100 files, ≤ 50 MiB, checked before the first byte); archive paths keep the folder structure and are sanitised.
 */

export interface PlannedFile {
  readonly jobId: string;
  readonly artifactId: string;
  /** Path inside the archive (sanitised, unique). */
  readonly path: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly sha256: string;
}

export interface ZipPlan {
  readonly files: PlannedFile[];
  readonly skipped: string[];
  /** For the archive name and the manifest heading. */
  readonly label: string;
}

interface FileRow {
  job_id: string;
  artifact_id: string;
  name: string;
  size_bytes: number;
  created_at: Date;
  sha256: string;
  stored: boolean;
}

/** Applies the p6 bounds and makes the paths unique. */
export function boundedPlan(
  candidates: { row: FileRow; path: string }[],
  skipped: string[],
  label: string,
): ZipPlan {
  for (const c of candidates) if (!c.row.stored) skipped.push(`file:${c.row.job_id}:${c.row.artifact_id}`);
  const stored = candidates.filter((c) => c.row.stored);
  if (stored.length === 0) throw new HttpError(409, 'zip_empty', 'There is no stored file here to download.');
  if (stored.length > LIMITS.zipFilesMax) {
    throw new HttpError(
      413,
      'zip_too_many',
      `This folder holds ${String(stored.length)} files; a ZIP takes at most ${String(LIMITS.zipFilesMax)}. Open a smaller folder.`,
      {},
      {},
      { count: stored.length, max: LIMITS.zipFilesMax },
    );
  }
  const total = stored.reduce((n, c) => n + c.row.size_bytes, 0);
  if (total > LIMITS.zipBytesMax) {
    throw new HttpError(
      413,
      'zip_too_large',
      `The files add up to more than ${String(LIMITS.zipBytesMax / (1024 * 1024))} MiB; open a smaller folder.`,
      {},
      {},
      { maxMib: LIMITS.zipBytesMax / (1024 * 1024) },
    );
  }
  const paths = uniquePaths(stored.map((c) => c.path));
  return {
    files: stored.map((c, i) => ({
      jobId: c.row.job_id,
      artifactId: c.row.artifact_id,
      path: paths[i] ?? `file-${String(i)}`,
      sizeBytes: c.row.size_bytes,
      createdAt: c.row.created_at,
      sha256: c.row.sha256,
    })),
    skipped,
    label,
  };
}

/** The stored files of a tree node of `project` (`` · `job:<id>` · `job:<id>/<dir>`). */
export async function treeZipPlan(
  pool: Queryable,
  folders: OutputFolders,
  subject: Subject,
  project: string,
  path: string,
): Promise<ZipPlan> {
  const parsed = parseTreePath(path);
  if (parsed === null) throw new HttpError(400, 'invalid_path', 'Unknown tree path.');
  if (parsed.kind === 'folder') {
    const f = await folders.readable(subject, parsed.folderId);
    if (f.scope !== 'project' || f.project !== project) {
      throw new HttpError(404, 'folder_not_found', 'Folder not found.');
    }
    return folderZipPlan(pool, folders, subject, parsed.folderId);
  }
  if (parsed.kind !== 'root' && parsed.kind !== 'job') {
    throw new HttpError(
      409,
      'zip_empty',
      'Sites, notes and folder lists hold no stored files to download.',
      {},
      {},
      { reason: 'kinds' },
    );
  }
  const jobId = parsed.kind === 'job' ? parsed.jobId : null;
  const dir = parsed.kind === 'job' ? parsed.dir : '';
  const { rows } = await pool.query<FileRow>(
    `SELECT DISTINCT ON (a.job_id, a.artifact_id) a.job_id::text AS job_id, a.artifact_id, a.name, a.size_bytes,
            a.created_at, a.sha256, a.pruned_at IS NULL AS stored
       FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
      WHERE j.project = $1 AND a.kind IN ('output', 'summary') AND ($2::uuid IS NULL OR a.job_id = $2)
      ORDER BY a.job_id, a.artifact_id, a.created_at DESC
      LIMIT 5000`,
    [project, jobId],
  );
  const prefix = dir === '' ? '' : `${dir}/`;
  const candidates = rows
    .filter((r) => r.name.startsWith(prefix))
    .map((r) => ({
      row: r,
      path: jobId === null ? zipPath(r.job_id.slice(0, 8), r.name) : zipPath('', r.name.slice(prefix.length)),
    }));
  const label = jobId === null ? project : `${project}-${jobId.slice(0, 8)}${dir === '' ? '' : `-${dir}`}`;
  return boundedPlan(candidates, [], label);
}

/** The stored files linked into an own folder and its sub-folders (items the subject can read now). */
export async function folderZipPlan(
  pool: Queryable,
  folders: OutputFolders,
  subject: Subject,
  folderId: string,
): Promise<ZipPlan> {
  const tree = await folders.subtree(subject, folderId);
  const root = await folders.readable(subject, folderId);
  const where = new Map(tree.map((t) => [t.id, t.path]));
  const visible = visibleProjects(subject);
  const { rows: links } = await pool.query<{ folder_id: string; project: string; item_key: string }>(
    `SELECT folder_id::text AS folder_id, project, item_key FROM output_folder_links
      WHERE folder_id = ANY($1::uuid[]) AND ($2::text[] IS NULL OR project = ANY($2))
      ORDER BY added_at LIMIT 5000`,
    [[...where.keys()], visible === null ? null : [...visible]],
  );
  const skipped: string[] = [];
  const wanted: { folderId: string; project: string; jobId: string; artifactId: string }[] = [];
  for (const l of links) {
    const m = /^file:([0-9a-f-]{36}):(ws-[a-z0-9-]{1,100})$/.exec(l.item_key);
    if (m?.[1] === undefined || m[2] === undefined) skipped.push(l.item_key);
    else wanted.push({ folderId: l.folder_id, project: l.project, jobId: m[1], artifactId: m[2] });
  }
  const { rows } = await pool.query<FileRow & { project: string }>(
    `SELECT DISTINCT ON (a.job_id, a.artifact_id) a.job_id::text AS job_id, a.artifact_id, a.name, a.size_bytes,
            a.created_at, a.sha256, a.pruned_at IS NULL AS stored, j.project
       FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
       JOIN unnest($1::uuid[], $2::text[]) AS x(job_id, artifact_id)
         ON x.job_id = a.job_id AND x.artifact_id = a.artifact_id
      WHERE a.kind IN ('output', 'summary')
      ORDER BY a.job_id, a.artifact_id, a.created_at DESC`,
    [wanted.map((w) => w.jobId), wanted.map((w) => w.artifactId)],
  );
  const byKey = new Map(rows.map((r) => [`${r.job_id}:${r.artifact_id}`, r]));
  const candidates: { row: FileRow; path: string }[] = [];
  for (const w of wanted) {
    const r = byKey.get(`${w.jobId}:${w.artifactId}`);
    // The link's project must be the job's project (no cross-project planting through a stale link).
    if (r === undefined || r.project !== w.project) {
      skipped.push(`file:${w.jobId}:${w.artifactId}`);
      continue;
    }
    candidates.push({ row: r, path: zipPath((where.get(w.folderId) ?? []).join('/'), r.name) });
  }
  return boundedPlan(candidates, skipped, root.name);
}
