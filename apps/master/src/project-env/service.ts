import { DEFAULT_CREDENTIAL_ENV, type JobSpec } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p19-project-env (docs/design/p19-project-env.md): vault credentials of kind `generic` ("Diğer") a project gives its
 * jobs as environment variables, under the credential's own `env` name.
 *
 * - The master stores ids only (`project_env_credentials`); values stay sealed on the machines.
 * - Placement: the job goes only to machines holding every bound credential at its current version.
 * - Assignment: `secretRefs[env] = secret:vault-<id>` is added to the spec sent to the worker (not stored on the job:
 *   a binding change applies to the next assignment). A ref the job already names for that variable wins.
 * - Never for an untrusted source, a pull request head, a function / integration / machine-admin job (the protocol
 *   gives those no secret references).
 */

/** At most this many credentials per project. */
export const MAX_PROJECT_ENV_CREDENTIALS = 20;

/** Variables a runtime's own credential uses: a project credential would collide with it ("injected twice"). */
export const RUNTIME_ENV: ReadonlySet<string> = new Set([
  ...Object.values(DEFAULT_CREDENTIAL_ENV).filter((v): v is string => v !== null),
  'CODEX_API_KEY',
]);

export interface ProjectEnvCredential {
  readonly credentialId: string;
  readonly name: string;
  readonly env: string;
  /** Names of the machines holding its current version (where the project's jobs can run). */
  readonly machines: readonly string[];
}

export interface ProjectEnvSetting {
  readonly project: string;
  readonly credentials: readonly ProjectEnvCredential[];
  /** Active `generic` credentials not bound yet (id, name, variable). */
  readonly available: readonly { readonly id: string; readonly name: string; readonly env: string }[];
}

export interface ProjectEnvPlacement {
  readonly credentials: readonly string[];
  readonly credentialWorkers: readonly string[];
}

/** The chosen worker does not hold a bound credential (the orchestrator tries the next candidate). */
export class ProjectEnvNotHeldError extends Error {
  constructor(readonly workerId: string) {
    super(`worker ${workerId} does not hold every project environment credential`);
    this.name = 'ProjectEnvNotHeldError';
  }
}

/** Whether a job may get project environment credentials at all. */
export function envEligible(spec: JobSpec): boolean {
  if (spec.kind === 'function' || spec.kind === 'integration' || spec.kind === 'machine-admin') return false;
  if (spec.sourceTrust === 'untrusted') return false;
  return spec.repository?.pullRequest === undefined;
}

export class ProjectEnvService {
  constructor(private readonly deps: { pool: Pool; audit: AuditRecorder; clock: () => Date }) {}

  async setting(project: string, db: Queryable = this.deps.pool): Promise<ProjectEnvSetting> {
    const p = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if (p.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const bound = await db.query<{ id: string; name: string; env: string; machines: string[] | null }>(
      `SELECT c.id, c.name, c.env,
              array_agg(w.display_name ORDER BY w.display_name)
                FILTER (WHERE w.id IS NOT NULL AND r.state = 'active' AND r.acked_version = r.version) AS machines
         FROM project_env_credentials b
         JOIN vault_credentials c ON c.id = b.credential_id AND c.state = 'active'
         LEFT JOIN vault_credential_workers r ON r.credential_id = c.id
         LEFT JOIN workers w ON w.id = r.worker_id AND w.archived_at IS NULL
        WHERE b.project = $1
        GROUP BY c.id, c.name, c.env ORDER BY c.env, c.id`,
      [project],
    );
    const available = await db.query<{ id: string; name: string; env: string }>(
      `SELECT c.id, c.name, c.env FROM vault_credentials c
        WHERE c.state = 'active' AND c.kind = 'generic'
          AND NOT EXISTS (SELECT 1 FROM project_env_credentials b WHERE b.project = $1 AND b.credential_id = c.id)
        ORDER BY c.env, c.id`,
      [project],
    );
    return {
      project,
      credentials: bound.rows.map((r) => ({
        credentialId: r.id,
        name: r.name,
        env: r.env,
        machines: r.machines ?? [],
      })),
      available: available.rows.filter((r) => !RUNTIME_ENV.has(r.env.toUpperCase())),
    };
  }

  /** Replaces the project's set (admin + step-up at the route); audited with the ids before / after. */
  async set(
    project: string,
    credentialIds: readonly string[],
    actor: ActorContext,
  ): Promise<ProjectEnvSetting> {
    const ids = [...new Set(credentialIds)].sort();
    if (ids.length > MAX_PROJECT_ENV_CREDENTIALS) {
      throw new HttpError(
        400,
        'too_many_env_credentials',
        `A project gives its jobs at most ${String(MAX_PROJECT_ENV_CREDENTIALS)} credentials.`,
        {},
        {},
        { max: MAX_PROJECT_ENV_CREDENTIALS },
      );
    }
    await withTransaction(this.deps.pool, async (tx) => {
      const p = await tx.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [project]);
      if (p.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
      const found = await tx.query<{ id: string; kind: string; env: string; state: string }>(
        'SELECT id, kind, env, state FROM vault_credentials WHERE id = ANY ($1::text[])',
        [ids],
      );
      const byId = new Map(found.rows.map((r) => [r.id, r]));
      const envs = new Map<string, string>();
      for (const id of ids) {
        const c = byId.get(id);
        if (c === undefined || c.state !== 'active') {
          throw new HttpError(
            404,
            'credential_not_found',
            `Credential ${id} not found or revoked.`,
            {},
            {},
            { id },
          );
        }
        if (c.kind !== 'generic') {
          throw new HttpError(
            400,
            'credential_kind_not_env',
            `Credential ${id} is not of kind "generic" (Other); only those are given to jobs as environment variables.`,
            {},
            {},
            { id },
          );
        }
        if (RUNTIME_ENV.has(c.env.toUpperCase())) {
          throw new HttpError(
            400,
            'credential_env_reserved',
            `Credential ${id} targets ${c.env}, the variable of a runtime's own credential.`,
            {},
            {},
            { id, env: c.env },
          );
        }
        const other = envs.get(c.env.toUpperCase());
        if (other !== undefined) {
          throw new HttpError(
            409,
            'credential_env_duplicate',
            `Credentials ${other} and ${id} both target ${c.env}.`,
            {},
            {},
            { env: c.env },
          );
        }
        envs.set(c.env.toUpperCase(), id);
      }
      const before = await tx.query<{ credential_id: string }>(
        'SELECT credential_id FROM project_env_credentials WHERE project = $1 ORDER BY credential_id',
        [project],
      );
      const was = before.rows.map((r) => r.credential_id);
      await tx.query(
        'DELETE FROM project_env_credentials WHERE project = $1 AND NOT (credential_id = ANY ($2::text[]))',
        [project, ids],
      );
      await tx.query(
        `INSERT INTO project_env_credentials (project, credential_id, created_by, created_at)
         SELECT $1, unnest($2::text[]), $3, $4 ON CONFLICT DO NOTHING`,
        [project, ids, actor.userId, this.deps.clock()],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.env_credentials.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { before: was, after: ids },
        },
        tx,
      );
    });
    return this.setting(project);
  }

  /** Bound active credentials (variable → id) the job does not already name itself. */
  async #bindings(project: string, spec: JobSpec): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!envEligible(spec)) return out;
    const { rows } = await this.deps.pool.query<{ id: string; env: string }>(
      `SELECT c.id, c.env FROM project_env_credentials b
         JOIN vault_credentials c ON c.id = b.credential_id AND c.state = 'active' AND c.kind = 'generic'
        WHERE b.project = $1 ORDER BY c.env, c.id`,
      [project],
    );
    const own = new Set(Object.keys(spec.secretRefs ?? {}));
    for (const r of rows) {
      if (own.has(r.env) || out.has(r.env) || RUNTIME_ENV.has(r.env.toUpperCase())) continue;
      out.set(r.env, r.id);
    }
    return out;
  }

  /** Placement facts (undefined: the job gets none). */
  async placementFor(project: string, spec: JobSpec): Promise<ProjectEnvPlacement | undefined> {
    const bound = await this.#bindings(project, spec);
    if (bound.size === 0) return undefined;
    const credentials = [...new Set(bound.values())].sort();
    return { credentials, credentialWorkers: await this.#holders(credentials) };
  }

  /**
   * The secret references to add for the chosen worker (null: none). Throws {@link ProjectEnvNotHeldError} when the
   * worker lacks one (a binding added after placement).
   */
  async assignment(project: string, spec: JobSpec, workerId: string): Promise<Record<string, string> | null> {
    const bound = await this.#bindings(project, spec);
    if (bound.size === 0) return null;
    const credentials = [...new Set(bound.values())].sort();
    if (!(await this.#holders(credentials)).includes(workerId)) throw new ProjectEnvNotHeldError(workerId);
    return Object.fromEntries([...bound].map(([env, id]) => [env, `secret:vault-${id}`]));
  }

  async #holders(credentials: readonly string[]): Promise<string[]> {
    const { rows } = await this.deps.pool.query<{ worker_id: string }>(
      `SELECT r.worker_id FROM vault_credential_workers r JOIN vault_credentials c ON c.id = r.credential_id
        WHERE r.credential_id = ANY ($1::text[]) AND r.state = 'active' AND c.state = 'active'
          AND r.acked_version = r.version
        GROUP BY r.worker_id HAVING count(DISTINCT r.credential_id) = $2 ORDER BY r.worker_id`,
      [credentials, credentials.length],
    );
    return rows.map((r) => r.worker_id);
  }
}
