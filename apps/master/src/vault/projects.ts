import type { Queryable } from '../db/pool.js';

/**
 * p22-vault-projects (docs/design/p22-vault-projects.md): a workflow HTTP / SMTP vault credential may be limited to some
 * projects (`vault_credentials.projects`). `null` = every project (every credential made before the column).
 */

/** The error code every enforcement point uses when a project references a credential it is not allowed to. */
export const CREDENTIAL_NOT_ALLOWED_FOR_PROJECT = 'credential_not_allowed_for_project';

/** Most projects one credential's allowlist may name. */
export const MAX_CREDENTIAL_PROJECTS = 200;

/** Whether a credential with allowlist `projects` may be used by `project` (null / absent: every project). */
export function credentialAllowsProject(
  projects: readonly string[] | null | undefined,
  project: string,
): boolean {
  return projects === null || projects === undefined || projects.includes(project);
}

/**
 * The allowlist of a credential as stored now (`undefined`: no such credential). Read at every use: an allowlist
 * narrowed after a workflow was saved is honoured at the next run.
 */
export async function credentialProjects(
  db: Queryable,
  credentialId: string,
): Promise<readonly string[] | null | undefined> {
  const { rows } = await db.query<{ projects: string[] | null }>(
    'SELECT projects FROM vault_credentials WHERE id = $1',
    [credentialId],
  );
  return rows[0] === undefined ? undefined : rows[0].projects;
}
