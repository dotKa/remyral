import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import { WorkerConfigInvalidError } from './service.js';

/**
 * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §5): a project's PREFERRED machines — the minimal
 * project-level placement default. The platform had project ↔ machine ASSIGNMENT (which machines may run a project's
 * jobs: the worker configurations, `PUT /projects/:id/workers`) and per-job pins (`requirements.workers`), but no
 * default "run this project's jobs on that machine". Here: up to 16 machines whose score every job of the project raises
 * (the scheduler's soft preference, `PREFERRED_WORKER_BONUS`) — never a requirement: when the preferred machines are
 * offline, busy or cannot run the job another eligible machine runs it. Per-kind placement ("design work on the Windows
 * machine") stays a per-job pin (`draft_job` workers / os).
 *
 * Reads: `projects.workers.read` (viewer+). Writes: `projects.workers.write` (admin) + step-up, like the assignment;
 * only enrolled, non-archived machines; audited `project.preferred_workers.update` (before / after).
 */

export const MAX_PREFERRED_WORKERS = 16;

export interface PreferredWorkersView {
  readonly project: string;
  readonly workerIds: string[];
  readonly updatedAt: string | null;
}

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

export class PreferredWorkersService {
  constructor(
    private readonly deps: {
      readonly pool: Parameters<typeof withTransaction>[0] & Queryable;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  /** The preferred machines of `project` (the orchestrator's placement fact; [] when none). */
  async forProject(project: string, db: Queryable = this.deps.pool): Promise<readonly string[]> {
    const { rows } = await db.query<{ worker_ids: string[] }>(
      'SELECT worker_ids FROM project_preferred_workers WHERE project = $1',
      [project],
    );
    return rows[0]?.worker_ids ?? [];
  }

  async get(project: string, db: Queryable = this.deps.pool): Promise<PreferredWorkersView> {
    await this.#project(db, project);
    const { rows } = await db.query<{ worker_ids: string[]; updated_at: Date }>(
      'SELECT worker_ids, updated_at FROM project_preferred_workers WHERE project = $1',
      [project],
    );
    const r = rows[0];
    return {
      project,
      workerIds: [...(r?.worker_ids ?? [])],
      updatedAt: r === undefined ? null : r.updated_at.toISOString(),
    };
  }

  /** Replaces the whole set (an empty list removes the preference). */
  async set(
    project: string,
    input: { readonly workerIds: readonly string[] },
    actor: ActorContext,
  ): Promise<PreferredWorkersView> {
    const wanted = [...new Set(input.workerIds)].sort();
    if (wanted.length > MAX_PREFERRED_WORKERS)
      throw new WorkerConfigInvalidError([{ path: 'workerIds', code: 'too_many' }]);
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#project(tx, project);
      if (wanted.length > 0) {
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM workers
            WHERE id = ANY($1::text[]) AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
          [wanted],
        );
        const known = new Set(rows.map((r) => r.id));
        const unknown = wanted.filter((id) => !known.has(id));
        if (unknown.length > 0)
          throw new WorkerConfigInvalidError(
            unknown.map((id) => ({ path: `workerIds.${id}`, code: 'unknown_worker' })),
          );
      }
      const before = await this.forProject(project, tx);
      const now = this.deps.clock();
      if (wanted.length === 0)
        await tx.query('DELETE FROM project_preferred_workers WHERE project = $1', [project]);
      else
        await tx.query(
          `INSERT INTO project_preferred_workers (project, worker_ids, updated_by, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project) DO UPDATE SET worker_ids = EXCLUDED.worker_ids, updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at`,
          [project, wanted, actor.userId === '' ? null : actor.userId, now],
        );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.preferred_workers.update',
          target: `project:${project}`,
          outcome: 'success',
          metadata: { project, before: [...before], after: wanted },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      return { project, workerIds: wanted, updatedAt: now.toISOString() };
    });
  }

  async #project(db: Queryable, project: string): Promise<void> {
    if (!PROJECT.test(project))
      throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
    const { rowCount } = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((rowCount ?? 0) === 0)
      throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
  }
}
