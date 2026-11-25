import {
  type AssignedRepoEgress,
  effectiveRepoEgress,
  MAX_REPO_EGRESS_HOSTS,
  REPO_EGRESS_FEATURE,
  type RepoEgressMode,
  RepoEgressPreset,
  repoEgressHosts,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { egressEntryProblem, normaliseEgressEntry } from '../workflows/egress.js';

/**
 * p14-repo-egress (docs/design/p14-repo-egress.md): Projects → Policy → Network access of a **repository** project.
 * `none` (default, the behaviour before this setting: model APIs only) · `allowlist` (presets + custom hosts) · `web`
 * (any public host on 443). The security floor is the worker's egress proxy (LAN / private / loopback / link-local /
 * CGNAT / metadata always refused); here only public DNS names are accepted (same check as the workflow allowlist).
 *
 * Changing it needs `projects.egress.write` (project admin) and an always-fresh step-up; every change is audited
 * (`project.repo_egress.update`, before / after). The policy in force is read again at every assignment (a change
 * applies to queued jobs and to the next attempt of a running one).
 */

export interface RepoEgressView {
  readonly project: string;
  /** `workspace` projects have their own egress setting (Workspace tab); this one does not apply to them. */
  readonly kind: 'repository' | 'workspace';
  readonly mode: RepoEgressMode;
  readonly presets: RepoEgressPreset[];
  readonly hosts: string[];
  /** What a job of this project may reach on top of the model APIs (presets expanded; empty for none / web). */
  readonly effective: AssignedRepoEgress;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** Active machines whose worker does not apply this setting yet (they keep model APIs only). */
  readonly unsupportedWorkers: { readonly id: string; readonly name: string }[];
}

interface Row {
  mode: RepoEgressMode;
  presets: string[];
  hosts: string[];
  updated_at: Date;
  username: string | null;
}

const PRESET_ORDER = RepoEgressPreset.options;

function presetsOf(raw: readonly string[]): RepoEgressPreset[] {
  return PRESET_ORDER.filter((p) => raw.includes(p));
}

async function readRow(db: Queryable, project: string): Promise<Row | null> {
  const { rows } = await db.query<Row>(
    `SELECT e.mode, e.presets, e.hosts, e.updated_at, u.username
       FROM project_repo_egress e LEFT JOIN users u ON u.id = e.updated_by WHERE e.project = $1`,
    [project],
  );
  return rows[0] ?? null;
}

/** The policy a repository job of `project` carries (ASSIGN_JOB `execution.repoEgress`); default `none`. */
export async function loadRepoEgress(db: Queryable, project: string): Promise<AssignedRepoEgress> {
  const r = await readRow(db, project);
  if (r === null) return { mode: 'none', hosts: [] };
  return effectiveRepoEgress(r.mode, presetsOf(r.presets), r.hosts);
}

/**
 * p22-worker-limits: the network policy of everything the worker runs for a project outside a job — services and IDE
 * servers. A repository project: its Projects → Policy → Network access ({@link loadRepoEgress}). A workspace project:
 * its Workspace tab's egress setting (the same three modes; `allowHosts` are the hosts), exactly what its jobs get.
 * No settings row → `none` (model APIs only).
 */
export async function loadProjectEgress(db: Queryable, project: string): Promise<AssignedRepoEgress> {
  const { rows } = await db.query<{
    kind: string;
    egress: RepoEgressMode | null;
    allow_hosts: string[] | null;
  }>(
    `SELECT p.kind, w.egress, w.allow_hosts FROM projects p
       LEFT JOIN project_workspaces w ON w.project = p.id WHERE p.id = $1`,
    [project],
  );
  const r = rows[0];
  if (r?.kind !== 'workspace') return loadRepoEgress(db, project);
  if (r.egress === null) return { mode: 'none', hosts: [] };
  return effectiveRepoEgress(r.egress, [], r.allow_hosts ?? []);
}

export class RepoEgressService {
  constructor(
    private readonly deps: {
      readonly pool: Parameters<typeof withTransaction>[0];
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      /**
       * p21-service-egress: called after a committed change (the services of the project are sent the new policy).
       * Errors are logged by the caller's wiring, never fail the change.
       */
      readonly onChanged?: (project: string) => Promise<void>;
    },
  ) {}

  async get(project: string, db: Queryable = this.deps.pool): Promise<RepoEgressView> {
    const kind = await this.#kind(db, project);
    const r = await readRow(db, project);
    const mode = r?.mode ?? 'none';
    const presets = presetsOf(r?.presets ?? []);
    const hosts = [...(r?.hosts ?? [])];
    const { rows: workers } = await db.query<{ id: string; name: string | null }>(
      `SELECT id, display_name AS name FROM workers
        WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL AND NOT (features ? $1)
        ORDER BY display_name, id LIMIT 50`,
      [REPO_EGRESS_FEATURE],
    );
    return {
      project,
      kind,
      mode,
      presets,
      hosts,
      effective: effectiveRepoEgress(mode, presets, hosts),
      updatedAt: r === null ? null : r.updated_at.toISOString(),
      updatedBy: r === null ? null : r.username,
      unsupportedWorkers: workers.map((w) => ({ id: w.id, name: w.name ?? w.id })),
    };
  }

  async set(
    actor: { readonly userId: string },
    project: string,
    input: {
      readonly mode: RepoEgressMode;
      readonly presets: readonly RepoEgressPreset[];
      readonly hosts: readonly string[];
    },
  ): Promise<RepoEgressView> {
    const hosts = [...new Set(input.hosts.map(normaliseEgressEntry))].sort();
    if (hosts.length > MAX_REPO_EGRESS_HOSTS)
      throw new HttpError(
        422,
        'invalid_egress',
        `At most ${String(MAX_REPO_EGRESS_HOSTS)} hosts.`,
        {},
        {},
        { reason: 'too_many', max: MAX_REPO_EGRESS_HOSTS },
      );
    for (const h of hosts) {
      const problem = egressEntryProblem(h);
      if (problem !== null)
        throw new HttpError(
          422,
          'invalid_egress',
          `${h}: not a public host name (${problem}); LAN, private, loopback and metadata addresses are never allowed.`,
          {},
          { detail: h },
          { entry: h, problem },
        );
    }
    const presets = presetsOf(input.presets);
    const now = this.deps.clock();
    const view = await withTransaction(this.deps.pool, async (tx) => {
      const kind = await this.#kind(tx, project);
      if (kind !== 'repository')
        throw new HttpError(
          409,
          'repo_egress_not_repository',
          'This is a workspace project: its network access is set on its Workspace tab.',
        );
      const before = await readRow(tx, project);
      await tx.query(
        `INSERT INTO project_repo_egress (project, mode, presets, hosts, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project) DO UPDATE SET mode = EXCLUDED.mode, presets = EXCLUDED.presets, hosts = EXCLUDED.hosts,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [project, input.mode, presets, hosts, actor.userId, now],
      );
      const after = effectiveRepoEgress(input.mode, presets, hosts);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.repo_egress.update',
          target: `project:${project}`,
          outcome: 'success',
          metadata: {
            project,
            before:
              before === null
                ? { mode: 'none', presets: [], hosts: [] }
                : { mode: before.mode, presets: presetsOf(before.presets), hosts: [...before.hosts] },
            after: { mode: input.mode, presets, hosts },
            // What jobs can reach now (presets expanded), so the audit entry alone answers the question.
            effective: { mode: after.mode, hostCount: repoEgressHosts(presets, hosts).length },
          },
        },
        tx,
      );
      return this.get(project, tx);
    });
    await this.deps.onChanged?.(project).catch(() => undefined);
    return view;
  }

  async #kind(db: Queryable, project: string): Promise<'repository' | 'workspace'> {
    const { rows } = await db.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [project]);
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return r.kind === 'workspace' ? 'workspace' : 'repository';
  }
}
