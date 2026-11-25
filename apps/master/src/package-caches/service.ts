import { PackageCacheReport } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p6-warm-caches (docs/design/p6-warm-caches.md, ADR-0029): the project setting that allows the machines' shared
 * package caches for a project's jobs (`projects.package_caches`, default on), and the machines' reports.
 *
 * The master only says whether the project allows them (ASSIGN_JOB `execution.packageCaches`); the worker decides
 * the rest itself (trusted source, host profile, local switch, size limit).
 */

export interface PackageCacheSetting {
  readonly project: string;
  readonly enabled: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
}

export class PackageCacheService {
  constructor(private readonly deps: { pool: Pool; audit: AuditRecorder; clock: () => Date }) {}

  async setting(project: string): Promise<PackageCacheSetting> {
    const { rows } = await this.deps.pool.query<{
      package_caches: boolean;
      package_caches_updated_by: string | null;
      package_caches_updated_at: Date | null;
    }>(
      'SELECT package_caches, package_caches_updated_by, package_caches_updated_at FROM projects WHERE id = $1',
      [project],
    );
    const row = rows[0];
    if (row === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return {
      project,
      enabled: row.package_caches,
      updatedBy: row.package_caches_updated_by,
      updatedAt: row.package_caches_updated_at,
    };
  }

  /** Admin + step-up (route); audited `project.package_caches.update` with before/after. */
  async set(project: string, enabled: boolean, actor: ActorContext): Promise<PackageCacheSetting> {
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await tx.query<{ package_caches: boolean }>(
        'SELECT package_caches FROM projects WHERE id = $1 FOR UPDATE',
        [project],
      );
      const was = before.rows[0];
      if (was === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
      await tx.query(
        `UPDATE projects SET package_caches = $2, package_caches_updated_by = $3, package_caches_updated_at = $4
          WHERE id = $1`,
        [project, enabled, actor.userId, this.deps.clock()],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.package_caches.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { before: was.package_caches, after: enabled },
        },
        tx,
      );
    });
    return this.setting(project);
  }
}

/** The stored CAPABILITIES.packageCaches of a worker, re-validated (a malformed report counts as none). */
export function storedCacheReport(raw: unknown): PackageCacheReport | null {
  if (raw === null || raw === undefined) return null;
  const parsed = PackageCacheReport.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
