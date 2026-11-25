import type pg from 'pg';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, type Role, type Subject, visibleProjects } from '../authz/model.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { ITEM_KEY, NoteBody, parseItemKey, Tags } from './model.js';
import { likePattern, type OutputItem, type OutputsService } from './service.js';

/**
 * p8-outputs-folders (docs/design/p8-outputs-folders.md §3): own folders on the Outputs screen.
 *
 * Two scopes: **project** folders are shared with the project's members (read `outputs.read`, write `outputs.write`),
 * **personal** folders belong to their creator only — anyone else (admins included) gets the same 404 as for a missing
 * folder. A folder holds links to output items, never the items: an item can be in several folders and deleting a
 * folder leaves it alone. Items of a personal folder are filtered by the reader's access every time they are read.
 */

export const FOLDER_LIMITS = {
  depthMax: 6,
  nameMax: 120,
  perProject: 500,
  perUser: 500,
  linksPerFolder: 1_000,
  keysPerRequest: 100,
  /** Folders listed in one response (picker, tree level). */
  listMax: 1_000,
} as const;

/** An item key a folder may link: the read model's keys plus note cards. */
export const LINK_KEY = new RegExp(
  `${ITEM_KEY.source}|^note:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A folder name: trimmed, 1–120 characters, no control characters, no slashes (paths and breadcrumbs). */
export const FolderName = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(FOLDER_LIMITS.nameMax)
      // eslint-disable-next-line no-control-regex -- refusing control characters is the point
      .refine((s) => !/[\u0000-\u001f\u007f/\\]/.test(s), 'no control characters or slashes'),
  );

export const FolderCreate = z.strictObject({
  scope: z.enum(['project', 'personal']),
  project: z.string().regex(PROJECT).optional(),
  parentId: z.uuid().nullable().optional(),
  name: FolderName,
  note: NoteBody.default(''),
  tags: Tags.default([]),
  pinned: z.boolean().default(false),
});
export type FolderCreate = z.infer<typeof FolderCreate>;

export const FolderPatch = z.strictObject({
  name: FolderName.optional(),
  note: NoteBody.optional(),
  tags: Tags.optional(),
  pinned: z.boolean().optional(),
  /** Move: the new parent (null = top level of the same scope). */
  parentId: z.uuid().nullable().optional(),
});
export type FolderPatch = z.infer<typeof FolderPatch>;

export const LinkKeys = z.array(z.string().regex(LINK_KEY)).min(1).max(FOLDER_LIMITS.keysPerRequest);

export interface FolderActor {
  readonly subject: Subject;
  readonly ip?: string;
  readonly userAgent?: string | null;
}

export interface Folder {
  readonly id: string;
  readonly scope: 'project' | 'personal';
  readonly project: string | null;
  readonly parentId: string | null;
  readonly depth: number;
  readonly name: string;
  readonly note: string;
  readonly tags: string[];
  readonly pinned: boolean;
  /** Links in this folder (not counting sub-folders). */
  readonly itemCount: number;
  readonly childCount: number;
  readonly createdBy: { readonly id: string | null; readonly username: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Whether the caller may change it (owner of a personal folder; operator+ of a project folder's project). */
  readonly writable: boolean;
}

export interface FolderDetail extends Folder {
  /** Ancestors, top first (the breadcrumb). */
  readonly ancestors: { readonly id: string; readonly name: string }[];
}

export interface FolderRow {
  id: string;
  scope: 'project' | 'personal';
  project: string | null;
  owner_id: string | null;
  parent_id: string | null;
  depth: number;
  name: string;
  note: string;
  tags: string[];
  pinned: boolean;
  item_count: number;
  child_count: number;
  created_by: string | null;
  username: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `
  SELECT f.id::text AS id, f.scope, f.project, f.owner_id::text AS owner_id, f.parent_id::text AS parent_id, f.depth,
         f.name, f.note, f.tags, f.pinned,
         (SELECT count(*)::int FROM output_folder_links l WHERE l.folder_id = f.id) AS item_count,
         (SELECT count(*)::int FROM output_folders c WHERE c.parent_id = f.id) AS child_count,
         f.created_by::text AS created_by, u.username, f.created_at, f.updated_at
    FROM output_folders f LEFT JOIN users u ON u.id = f.created_by`;
const ORDER = 'ORDER BY f.pinned DESC, lower(f.name), f.id';

const notFound = (): HttpError => new HttpError(404, 'folder_not_found', 'Folder not found.');
const FINISHED = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
/** How long a succeeded job's pending deploy-on-success may hold its folder link open. */
const DEPLOY_WAIT_MS = 2 * 60 * 60 * 1000;

export class OutputFolders {
  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly outputs: OutputsService;
    },
  ) {}

  // ------------------------------------------------------------------------------------------- access

  #canRead(subject: Subject, r: Pick<FolderRow, 'scope' | 'project' | 'owner_id'>): boolean {
    if (r.scope === 'personal') return r.owner_id === subject.userId;
    return r.project !== null && authorize(subject, 'outputs.read', { project: r.project }).allow;
  }

  #canWrite(subject: Subject, r: Pick<FolderRow, 'scope' | 'project' | 'owner_id'>): boolean {
    if (r.scope === 'personal') return r.owner_id === subject.userId;
    return r.project !== null && authorize(subject, 'outputs.write', { project: r.project }).allow;
  }

  async #row(db: Queryable, id: string, lock = false): Promise<FolderRow | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<FolderRow>(
      lock
        ? `${SELECT} WHERE f.id = (SELECT id FROM output_folders WHERE id = $1 FOR UPDATE)`
        : `${SELECT} WHERE f.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** The route authorization's view of a folder: its project, `{}` for an own personal folder, else null (404). */
  async resourceOf(id: string, userId: string): Promise<{ project?: string } | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<{
      scope: string;
      project: string | null;
      owner_id: string | null;
    }>('SELECT scope, project, owner_id::text AS owner_id FROM output_folders WHERE id = $1', [id]);
    const r = rows[0];
    if (r === undefined) return null;
    if (r.scope === 'project' && r.project !== null) return { project: r.project };
    return r.owner_id === userId ? {} : null;
  }

  /** The folder if the subject may read it, else a 404 (missing and forbidden look the same). */
  async readable(subject: Subject, id: string): Promise<FolderRow> {
    const r = await this.#row(this.deps.pool, id);
    if (r === null || !this.#canRead(subject, r)) throw notFound();
    return r;
  }

  /** Write access inside a transaction (row locked): 404 when not readable, 403 (audited) when read-only. */
  async #writable(tx: Queryable, actor: FolderActor, id: string, action: string): Promise<FolderRow> {
    const r = await this.#row(tx, id, true);
    if (r === null || !this.#canRead(actor.subject, r)) throw notFound();
    if (!this.#canWrite(actor.subject, r)) {
      await this.#auditDenied(actor, action, id, r.project);
      throw new HttpError(
        403,
        'forbidden',
        'You can only view the folders of this project.',
        {},
        {},
        { reason: 'folders_view' },
      );
    }
    return r;
  }

  async #auditDenied(actor: FolderActor, action: string, id: string | null, project: string | null) {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.subject.userId },
      action,
      target: id === null ? null : `output-folder:${id}`,
      outcome: 'denied',
      ...this.#meta(actor),
      metadata: { ...(project === null ? {} : { project }), reason: 'role' },
    });
  }

  #view(subject: Subject, r: FolderRow): Folder {
    return {
      id: r.id,
      scope: r.scope,
      project: r.project,
      parentId: r.parent_id,
      depth: r.depth,
      name: r.name,
      note: r.note,
      tags: r.tags,
      pinned: r.pinned,
      itemCount: r.item_count,
      childCount: r.child_count,
      createdBy: { id: r.created_by, username: r.username },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      writable: this.#canWrite(subject, r),
    };
  }

  async #ancestors(db: Queryable, id: string): Promise<{ id: string; name: string }[]> {
    const { rows } = await db.query<{ id: string; name: string }>(
      `WITH RECURSIVE up AS (
         SELECT p.id, p.name, p.parent_id, 1 AS n FROM output_folders f JOIN output_folders p ON p.id = f.parent_id
          WHERE f.id = $1
         UNION ALL
         SELECT p.id, p.name, p.parent_id, up.n + 1 FROM up JOIN output_folders p ON p.id = up.parent_id
          WHERE up.n < ${String(FOLDER_LIMITS.depthMax)})
       SELECT id::text AS id, name FROM up ORDER BY n DESC`,
      [id],
    );
    return rows;
  }

  // ------------------------------------------------------------------------------------------- reads

  /** Project folders of `project` (when given and readable) and the subject's own personal folders. */
  async list(subject: Subject, project?: string): Promise<Folder[]> {
    const readable =
      project !== undefined && authorize(subject, 'outputs.read', { project }).allow ? project : null;
    const { rows } = await this.deps.pool.query<FolderRow>(
      `${SELECT}
        WHERE (f.scope = 'personal' AND f.owner_id = $1::uuid)
           OR ($2::text IS NOT NULL AND f.scope = 'project' AND f.project = $2)
        ORDER BY f.scope DESC, f.depth, f.pinned DESC, lower(f.name), f.id
        LIMIT ${String(FOLDER_LIMITS.listMax * 2)}`,
      [subject.userId, readable],
    );
    return rows.map((r) => this.#view(subject, r));
  }

  async get(subject: Subject, id: string): Promise<FolderDetail> {
    const r = await this.readable(subject, id);
    return { ...this.#view(subject, r), ancestors: await this.#ancestors(this.deps.pool, id) };
  }

  /** Children of a parent (null: the top level) in one scope — the tree's folder levels. */
  async children(
    subject: Subject,
    where: { scope: 'personal' } | { scope: 'project'; project: string },
    parentId: string | null,
  ): Promise<Folder[]> {
    if (parentId !== null) {
      const parent = await this.readable(subject, parentId);
      const same =
        where.scope === 'personal'
          ? parent.scope === 'personal'
          : parent.scope === 'project' && parent.project === where.project;
      if (!same) throw notFound();
    } else if (where.scope === 'project' && !authorize(subject, 'outputs.read', where).allow) {
      throw notFound();
    }
    const { rows } = await this.deps.pool.query<FolderRow>(
      `${SELECT}
        WHERE ${where.scope === 'personal' ? "f.scope = 'personal' AND f.owner_id = $1::uuid" : "f.scope = 'project' AND f.project = $1"}
          AND ${parentId === null ? 'f.parent_id IS NULL' : 'f.parent_id = $2::uuid'}
        ${ORDER} LIMIT ${String(FOLDER_LIMITS.listMax)}`,
      parentId === null
        ? [where.scope === 'personal' ? subject.userId : where.project]
        : [where.scope === 'personal' ? subject.userId : where.project, parentId],
    );
    return rows.map((r) => this.#view(subject, r));
  }

  /** The folders an item is in that the subject can read. */
  async itemFolders(subject: Subject, project: string, key: string): Promise<FolderDetail[]> {
    const { rows } = await this.deps.pool.query<FolderRow>(
      `${SELECT}
        WHERE f.id IN (SELECT folder_id FROM output_folder_links WHERE project = $1 AND item_key = $2)
        ${ORDER} LIMIT 200`,
      [project, key],
    );
    const out: FolderDetail[] = [];
    for (const r of rows.filter((x) => this.#canRead(subject, x))) {
      out.push({ ...this.#view(subject, r), ancestors: await this.#ancestors(this.deps.pool, r.id) });
    }
    return out;
  }

  /**
   * The folder and its sub-folders (readable by the subject), each with its path relative to the folder — for the
   * folder ZIP. Bounded by the depth limit.
   */
  async subtree(subject: Subject, id: string): Promise<{ id: string; path: string[] }[]> {
    const root = await this.readable(subject, id);
    const { rows } = await this.deps.pool.query<{ id: string; path: string[] }>(
      `WITH RECURSIVE down AS (
         SELECT id, ARRAY[]::text[] AS path, 0 AS n FROM output_folders WHERE id = $1
         UNION ALL
         SELECT c.id, down.path || c.name, down.n + 1 FROM down JOIN output_folders c ON c.parent_id = down.id
          WHERE down.n < ${String(FOLDER_LIMITS.depthMax)})
       SELECT id::text AS id, path FROM down ORDER BY array_length(path, 1) NULLS FIRST, path LIMIT 2000`,
      [root.id],
    );
    return rows;
  }

  // ------------------------------------------------------------------------------------------- writes

  async create(actor: FolderActor, input: FolderCreate): Promise<FolderDetail> {
    const { subject } = actor;
    const now = this.deps.clock();
    if (input.scope === 'project') {
      const project = input.project;
      if (project === undefined)
        throw new HttpError(400, 'invalid_folder', 'A project folder needs a project.');
      if (!authorize(subject, 'outputs.read', { project }).allow) {
        throw new HttpError(404, 'project_not_found', 'Project not found.');
      }
      if (!authorize(subject, 'outputs.write', { project }).allow) {
        await this.#auditDenied(actor, 'outputs.folder.create', null, project);
        throw new HttpError(
          403,
          'forbidden',
          'Only operators can add folders to this project.',
          {},
          {},
          { reason: 'folders_add' },
        );
      }
    } else if (input.project !== undefined) {
      throw new HttpError(
        400,
        'invalid_folder',
        'A personal folder has no project.',
        {},
        {},
        { reason: 'personal' },
      );
    }
    const id = await withTransaction(this.deps.pool, async (tx) => {
      const scopeKey =
        input.scope === 'project' ? `project:${input.project ?? ''}` : `user:${subject.userId}`;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`output-folders:${scopeKey}`]);
      if (input.scope === 'project') {
        const exists = await tx.query('SELECT 1 FROM projects WHERE id = $1', [input.project]);
        if (exists.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
      }
      let depth = 1;
      if (input.parentId != null) {
        const parent = await this.#writable(tx, actor, input.parentId, 'outputs.folder.create');
        if (parent.scope !== input.scope || (input.scope === 'project' && parent.project !== input.project)) {
          throw new HttpError(400, 'invalid_parent', 'The parent folder is in another place.');
        }
        depth = parent.depth + 1;
        if (depth > FOLDER_LIMITS.depthMax) {
          throw new HttpError(
            409,
            'folder_too_deep',
            `Folders nest at most ${String(FOLDER_LIMITS.depthMax)} levels deep.`,
            {},
            {},
            { max: FOLDER_LIMITS.depthMax },
          );
        }
      }
      const count = await tx.query<{ n: number }>(
        input.scope === 'project'
          ? "SELECT count(*)::int AS n FROM output_folders WHERE scope = 'project' AND project = $1"
          : "SELECT count(*)::int AS n FROM output_folders WHERE scope = 'personal' AND owner_id = $1::uuid",
        [input.scope === 'project' ? input.project : subject.userId],
      );
      const max = input.scope === 'project' ? FOLDER_LIMITS.perProject : FOLDER_LIMITS.perUser;
      if ((count.rows[0]?.n ?? 0) >= max) {
        throw new HttpError(
          409,
          'too_many_folders',
          `${input.scope === 'project' ? 'A project' : 'You'} can keep at most ${String(max)} folders; delete some first.`,
          {},
          {},
          { reason: input.scope === 'project' ? 'project' : 'personal', max },
        );
      }
      const { rows } = await tx
        .query<{ id: string }>(
          `INSERT INTO output_folders (scope, project, owner_id, parent_id, depth, name, note, tags, pinned, created_by,
                                       created_at, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11) RETURNING id::text AS id`,
          [
            input.scope,
            input.scope === 'project' ? input.project : null,
            input.scope === 'personal' ? subject.userId : null,
            input.parentId ?? null,
            depth,
            input.name,
            input.note,
            input.tags,
            input.pinned,
            subject.userId,
            now,
          ],
        )
        .catch(nameTaken);
      const folderId = rows[0]?.id ?? '';
      await this.#audit(tx, actor, 'outputs.folder.create', folderId, {
        scope: input.scope,
        ...(input.project === undefined ? {} : { project: input.project }),
        depth,
      });
      return folderId;
    });
    return this.get(subject, id);
  }

  async update(actor: FolderActor, id: string, patch: FolderPatch): Promise<FolderDetail> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const first = await this.#row(tx, id);
      if (first === null || !this.#canRead(actor.subject, first)) throw notFound();
      // Moves serialise per scope (cycle and depth checks see a stable tree).
      if (patch.parentId !== undefined) {
        const scopeKey =
          first.scope === 'project' ? `project:${first.project ?? ''}` : `user:${first.owner_id ?? ''}`;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `output-folders:${scopeKey}`,
        ]);
      }
      const r = await this.#writable(tx, actor, id, 'outputs.folder.update');
      let moved = false;
      if (patch.parentId !== undefined && patch.parentId !== r.parent_id) {
        await this.#move(tx, actor, r, patch.parentId);
        moved = true;
      }
      await tx
        .query(
          `UPDATE output_folders SET name = coalesce($2, name), note = coalesce($3, note),
                  tags = coalesce($4::text[], tags), pinned = coalesce($5::boolean, pinned),
                  updated_by = $6, updated_at = $7
            WHERE id = $1`,
          [
            id,
            patch.name ?? null,
            patch.note ?? null,
            patch.tags ?? null,
            patch.pinned ?? null,
            actor.subject.userId,
            now,
          ],
        )
        .catch(nameTaken);
      await this.#audit(tx, actor, moved ? 'outputs.folder.move' : 'outputs.folder.update', id, {
        scope: r.scope,
        ...(r.project === null ? {} : { project: r.project }),
        fields: Object.keys(patch).sort(),
        ...(moved ? { from: r.parent_id, to: patch.parentId ?? null } : {}),
      });
    });
    return this.get(actor.subject, id);
  }

  async #move(tx: Queryable, actor: FolderActor, r: FolderRow, parentId: string | null): Promise<void> {
    let base = 0;
    if (parentId !== null) {
      if (parentId === r.id) throw new HttpError(409, 'folder_cycle', 'A folder cannot go into itself.');
      const parent = await this.#writable(tx, actor, parentId, 'outputs.folder.move');
      if (
        parent.scope !== r.scope ||
        parent.project !== r.project ||
        (r.scope === 'personal' && parent.owner_id !== r.owner_id)
      ) {
        throw new HttpError(
          400,
          'invalid_parent',
          'Folders move only within the same place.',
          {},
          {},
          { reason: 'move' },
        );
      }
      const below = await tx.query<{ hit: boolean }>(
        `WITH RECURSIVE down AS (
           SELECT id, 0 AS n FROM output_folders WHERE parent_id = $1
           UNION ALL
           SELECT c.id, down.n + 1 FROM down JOIN output_folders c ON c.parent_id = down.id
            WHERE down.n < ${String(FOLDER_LIMITS.depthMax)})
         SELECT EXISTS (SELECT 1 FROM down WHERE id = $2) AS hit`,
        [r.id, parentId],
      );
      if (below.rows[0]?.hit === true) {
        throw new HttpError(
          409,
          'folder_cycle',
          'A folder cannot go into one of its own sub-folders.',
          {},
          {},
          { reason: 'descendant' },
        );
      }
      base = parent.depth;
    }
    const height = await tx.query<{ h: number }>(
      `WITH RECURSIVE down AS (
         SELECT id, 0 AS n FROM output_folders WHERE id = $1
         UNION ALL
         SELECT c.id, down.n + 1 FROM down JOIN output_folders c ON c.parent_id = down.id
          WHERE down.n < ${String(FOLDER_LIMITS.depthMax)})
       SELECT max(n)::int AS h FROM down`,
      [r.id],
    );
    const newDepth = base + 1;
    if (newDepth + (height.rows[0]?.h ?? 0) > FOLDER_LIMITS.depthMax) {
      throw new HttpError(
        409,
        'folder_too_deep',
        `Folders nest at most ${String(FOLDER_LIMITS.depthMax)} levels deep; this move would go deeper.`,
        {},
        {},
        { reason: 'move', max: FOLDER_LIMITS.depthMax },
      );
    }
    const delta = newDepth - r.depth;
    // Parent and depth change together so the (parent IS NULL) = (depth = 1) check holds row by row.
    await tx
      .query(
        `WITH RECURSIVE down AS (
           SELECT id FROM output_folders WHERE parent_id = $1
           UNION ALL
           SELECT c.id FROM down JOIN output_folders c ON c.parent_id = down.id)
         UPDATE output_folders SET depth = depth + $2 WHERE id IN (SELECT id FROM down)`,
        [r.id, delta],
      )
      .then(() =>
        tx.query('UPDATE output_folders SET parent_id = $2, depth = $3 WHERE id = $1', [
          r.id,
          parentId,
          newDepth,
        ]),
      )
      .catch(nameTaken);
  }

  /** Deletes the folder and its sub-folders with their links; the items stay. */
  async remove(actor: FolderActor, id: string): Promise<{ folders: number; links: number }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#writable(tx, actor, id, 'outputs.folder.delete');
      const { rows } = await tx.query<{ folders: number; links: number }>(
        `WITH RECURSIVE down AS (
           SELECT id, 0 AS n FROM output_folders WHERE id = $1
           UNION ALL
           SELECT c.id, down.n + 1 FROM down JOIN output_folders c ON c.parent_id = down.id
            WHERE down.n < ${String(FOLDER_LIMITS.depthMax)})
         SELECT (SELECT count(*)::int FROM down) AS folders,
                (SELECT count(*)::int FROM output_folder_links WHERE folder_id IN (SELECT id FROM down)) AS links`,
        [id],
      );
      const counts = rows[0] ?? { folders: 1, links: 0 };
      await tx.query('DELETE FROM output_folders WHERE id = $1', [id]);
      await this.#audit(tx, actor, 'outputs.folder.delete', id, {
        scope: r.scope,
        ...(r.project === null ? {} : { project: r.project }),
        ...counts,
      });
      return counts;
    });
  }

  /**
   * Links items (keys of `project`) into a folder. Each key must name an item of the read model there; a project
   * folder takes only its own project's items, a personal folder anything its owner can read.
   */
  async link(
    actor: FolderActor,
    id: string,
    project: string,
    keys: readonly string[],
    source: 'user' | 'job' = 'user',
  ): Promise<{ added: number; already: number; refused: string[] }> {
    const unique = [...new Set(keys)];
    const r = await this.#row(this.deps.pool, id);
    if (r === null || !this.#canRead(actor.subject, r)) throw notFound();
    if (!this.#canWrite(actor.subject, r)) {
      await this.#auditDenied(actor, 'outputs.folder.link', id, r.project);
      throw new HttpError(
        403,
        'forbidden',
        'You can only view the folders of this project.',
        {},
        {},
        { reason: 'folders_view' },
      );
    }
    if (r.scope === 'project' && r.project !== project) {
      throw new HttpError(
        409,
        'folder_project_mismatch',
        'A project folder holds only its own project’s items.',
      );
    }
    if (!authorize(actor.subject, 'outputs.read', { project }).allow) {
      throw new HttpError(404, 'output_not_found', 'Output not found.');
    }
    const found: { key: string; jobId: string | null }[] = [];
    const refused: string[] = [];
    for (const key of unique) {
      const item = await this.#resolve(project, key);
      const parsed = parseItemKey(key);
      if (item === null) refused.push(key);
      else found.push({ key, jobId: parsed !== null && parsed.kind !== 'site' ? parsed.jobId : null });
    }
    const now = this.deps.clock();
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const locked = await this.#writable(tx, actor, id, 'outputs.folder.link');
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM output_folder_links WHERE folder_id = $1',
        [locked.id],
      );
      const existing = await tx.query<{ item_key: string }>(
        'SELECT item_key FROM output_folder_links WHERE folder_id = $1 AND project = $2 AND item_key = ANY($3)',
        [locked.id, project, found.map((f) => f.key)],
      );
      const have = new Set(existing.rows.map((e) => e.item_key));
      const fresh = found.filter((f) => !have.has(f.key));
      if ((count.rows[0]?.n ?? 0) + fresh.length > FOLDER_LIMITS.linksPerFolder) {
        throw new HttpError(
          409,
          'too_many_links',
          `A folder holds at most ${String(FOLDER_LIMITS.linksPerFolder)} items.`,
          {},
          {},
          { max: FOLDER_LIMITS.linksPerFolder },
        );
      }
      if (fresh.length > 0) {
        await tx.query(
          `INSERT INTO output_folder_links (folder_id, project, item_key, job_id, source, added_by, added_at)
           SELECT $1, $2, k, j, $5, $6, $7 FROM unnest($3::text[], $4::uuid[]) AS x(k, j)
           ON CONFLICT DO NOTHING`,
          [
            locked.id,
            project,
            fresh.map((f) => f.key),
            fresh.map((f) => f.jobId),
            source,
            actor.subject.userId,
            now,
          ],
        );
      }
      await this.#audit(tx, actor, source === 'job' ? 'outputs.folder.autolink' : 'outputs.folder.link', id, {
        scope: locked.scope,
        project,
        added: fresh.length,
        already: found.length - fresh.length,
        refused: refused.length,
      });
      return { added: fresh.length, already: found.length - fresh.length };
    });
    return { ...out, refused };
  }

  async unlink(actor: FolderActor, id: string, project: string, keys: readonly string[]): Promise<number> {
    return withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#writable(tx, actor, id, 'outputs.folder.unlink');
      const res = await tx.query(
        'DELETE FROM output_folder_links WHERE folder_id = $1 AND project = $2 AND item_key = ANY($3)',
        [id, project, [...new Set(keys)]],
      );
      const removed = res.rowCount ?? 0;
      await this.#audit(tx, actor, 'outputs.folder.unlink', id, { scope: r.scope, project, removed });
      return removed;
    });
  }

  /** The read-model item a key names in `project` (note cards included), or null. */
  async #resolve(project: string, key: string): Promise<OutputItem | null> {
    if (!LINK_KEY.test(key)) return null;
    if (!key.startsWith('note:') && parseItemKey(key) === null) return null;
    const { items } = await this.deps.outputs.list([project], { project, key, limit: 1 });
    return items[0] ?? null;
  }

  // -------------------------------------------------------------------------------- job output target

  /**
   * Checks that `subject` may file a job's outputs of `project` into the folder (at job / automation creation).
   * Throws 404 (not readable), 403 (read-only) or 409 (a project folder of another project).
   */
  async checkJobTarget(actor: FolderActor, project: string, folderId: string): Promise<void> {
    const r = await this.#row(this.deps.pool, folderId);
    if (r === null || !this.#canRead(actor.subject, r)) throw notFound();
    if (!this.#canWrite(actor.subject, r)) {
      await this.#auditDenied(actor, 'outputs.folder.target', folderId, r.project);
      throw new HttpError(
        403,
        'forbidden',
        'You cannot add items to this folder.',
        {},
        {},
        { reason: 'folder_items' },
      );
    }
    if (r.scope === 'project' && r.project !== project) {
      throw new HttpError(
        409,
        'folder_project_mismatch',
        'A project folder takes only the outputs of jobs in that project.',
        {},
        {},
        { reason: 'job_outputs' },
      );
    }
  }

  /** Records the job's folder in the job's create transaction (linked when the job ends). */
  async recordJobTarget(
    tx: Queryable,
    jobId: string,
    folderId: string,
    requestedBy: string,
    via: 'api' | 'automation',
  ): Promise<void> {
    await tx.query(
      `INSERT INTO job_output_folders (job_id, folder_id, requested_by, via, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING`,
      [jobId, folderId, requestedBy, via, this.deps.clock()],
    );
  }

  /**
   * Tick step: links the outputs of ended jobs into their folders, re-checking the requester now. Idempotent (links
   * are upserts); a job with an open deploy-on-success stays pending until the site is live (at most 2 h).
   */
  async linkTick(limit = 20): Promise<number> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      job_id: string;
      folder_id: string | null;
      requested_by: string | null;
      project: string;
      state: string;
      ended: Date;
      deploy_open: boolean;
    }>(
      `SELECT o.job_id::text AS job_id, o.folder_id::text AS folder_id, o.requested_by::text AS requested_by,
              j.project, j.state::text AS state, j.state_changed_at AS ended,
              EXISTS (SELECT 1 FROM job_deploy_on_success d WHERE d.job_id = o.job_id
                        AND d.state IN ('pending', 'running', 'requested')) AS deploy_open
         FROM job_output_folders o JOIN jobs j ON j.id = o.job_id
        WHERE o.done_at IS NULL AND j.state::text = ANY($1)
        ORDER BY o.created_at LIMIT $2`,
      [FINISHED, limit],
    );
    let done = 0;
    for (const r of rows) {
      const finish = async (outcome: 'linked' | 'refused', reason: string | null, linked = 0) => {
        await this.deps.pool.query(
          `UPDATE job_output_folders SET done_at = $2, outcome = $3, reason = $4, linked = linked + $5
            WHERE job_id = $1 AND done_at IS NULL`,
          [r.job_id, now, outcome, reason, linked],
        );
        done += 1;
      };
      const subject = r.requested_by === null ? null : await this.#activeSubject(r.requested_by);
      if (r.folder_id === null || subject === null) {
        await finish('refused', r.folder_id === null ? 'folder deleted' : 'requester no longer active');
        await this.deps.audit.record({
          actor: { type: 'system', id: 'output-folders' },
          action: 'outputs.folder.autolink',
          target: `job:${r.job_id}`,
          outcome: 'denied',
          metadata: { reason: r.folder_id === null ? 'folder_deleted' : 'requester_inactive' },
        });
        continue;
      }
      const actor: FolderActor = { subject };
      const folder = await this.#row(this.deps.pool, r.folder_id);
      const allowed =
        folder !== null &&
        this.#canWrite(subject, folder) &&
        (folder.scope === 'personal' || folder.project === r.project) &&
        authorize(subject, 'outputs.read', { project: r.project }).allow;
      if (!allowed) {
        await finish('refused', 'the requester may no longer add items to this folder');
        await this.deps.audit.record({
          actor: { type: 'user', id: subject.userId },
          action: 'outputs.folder.autolink',
          target: `output-folder:${r.folder_id}`,
          outcome: 'denied',
          metadata: { jobId: r.job_id, project: r.project, reason: 'not_writable' },
        });
        continue;
      }
      const { items } = await this.deps.outputs.list([r.project], {
        project: r.project,
        jobId: r.job_id,
        limit: 100,
      });
      let added = 0;
      if (items.length > 0) {
        try {
          added = (
            await this.link(
              actor,
              r.folder_id,
              r.project,
              items.map((i) => i.key),
              'job',
            )
          ).added;
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          await finish('refused', err.message.slice(0, 300));
          continue;
        }
      }
      const waitDeploy =
        r.state === 'SUCCEEDED' && r.deploy_open && now.getTime() - r.ended.getTime() < DEPLOY_WAIT_MS;
      if (waitDeploy) {
        if (added > 0) {
          await this.deps.pool.query('UPDATE job_output_folders SET linked = linked + $2 WHERE job_id = $1', [
            r.job_id,
            added,
          ]);
        }
        continue;
      }
      await finish('linked', null, added);
    }
    return done;
  }

  async #activeSubject(userId: string): Promise<Subject | null> {
    const { rows } = await this.deps.pool.query<{ id: string; role: Role; disabled_at: Date | null }>(
      'SELECT id::text AS id, role, disabled_at FROM users WHERE id::text = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled_at !== null) return null;
    return loadSubject(this.deps.pool, { id: u.id, role: u.role });
  }

  // ------------------------------------------------------------------------------------------ mentions

  /** Folders whose name matches, readable by the subject (picker). */
  async search(
    subject: Subject,
    q: string,
    limit: number,
  ): Promise<{ id: string; project: string | null; name: string; scope: string }[]> {
    const visible = visibleProjects(subject);
    const { rows } = await this.deps.pool.query<FolderRow>(
      `${SELECT}
        WHERE f.name ILIKE $1
          AND ((f.scope = 'personal' AND f.owner_id = $2::uuid)
               OR (f.scope = 'project' AND ($3::text[] IS NULL OR f.project = ANY($3))))
        ORDER BY f.pinned DESC, lower(f.name), f.id LIMIT $4`,
      [likePattern(q), subject.userId, visible === null ? null : [...visible], limit * 2],
    );
    return rows
      .filter((r) => this.#canRead(subject, r))
      .slice(0, limit)
      .map((r) => ({ id: r.id, project: r.project, name: r.name, scope: r.scope }));
  }

  /** The bounded context of a mentioned folder, resolved as `subject` now (null: not readable). */
  async mention(
    subject: Subject,
    id: string,
  ): Promise<{ label: string; project: string | null; data: Record<string, unknown> } | null> {
    const r = await this.#row(this.deps.pool, id);
    if (r === null || !this.#canRead(subject, r)) return null;
    const ancestors = await this.#ancestors(this.deps.pool, id);
    const kids = await this.deps.pool.query<{ name: string }>(
      'SELECT name FROM output_folders WHERE parent_id = $1 ORDER BY pinned DESC, lower(name) LIMIT 20',
      [id],
    );
    const visible = visibleProjects(subject);
    const { items, total } = await this.deps.outputs.list(visible, { folder: id, limit: 30 });
    const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
    return {
      label: r.name,
      project: r.project,
      data: {
        type: 'folder',
        id: r.id,
        name: r.name,
        scope: r.scope,
        project: r.project,
        path: [...ancestors.map((a) => a.name), r.name].join(' / '),
        note: r.note === '' ? null : clip(r.note, 2_000),
        tags: r.tags,
        subFolders: kids.rows.map((k) => k.name),
        itemCount: total,
        items: items.map((i) => ({
          key: i.key,
          type: i.type,
          project: i.project,
          name: i.title ?? i.name,
          ...(i.site?.url == null ? {} : { url: i.site.url }),
          ...(i.file !== null && i.jobId !== null && i.file.source === 'workspace' && i.file.removed === null
            ? { inputArtifact: { jobId: i.jobId, artifactId: i.file.artifactId } }
            : {}),
        })),
        ...(total > items.length ? { more: total - items.length } : {}),
        hint: 'Items are Outputs keys; files with inputArtifact can be given to a workspace job via draft_job.inputArtifacts.',
      },
    };
  }

  // ------------------------------------------------------------------------------------------- helpers

  async #audit(
    tx: Queryable,
    actor: FolderActor,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.subject.userId },
        action,
        target: `output-folder:${id}`,
        outcome: 'success',
        ...this.#meta(actor),
        metadata,
      },
      tx,
    );
  }

  #meta(actor: FolderActor): { ip?: string; userAgent?: string | null } {
    return {
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
      ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
    };
  }
}

/** A unique-name violation → 409 with a plain message; anything else rethrown. */
function nameTaken(err: unknown): never {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505') {
    throw new HttpError(409, 'folder_name_taken', 'A folder with this name is already here.');
  }
  throw err;
}
