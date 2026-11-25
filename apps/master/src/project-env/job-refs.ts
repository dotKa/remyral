import {
  FORBIDDEN_CREDENTIAL_ENV,
  type JobSpec,
  VaultCredentialId,
  vaultIdOfSecretRef,
} from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import type { InvalidJobIssue } from '../jobs/errors.js';
import { credentialAllowsProject } from '../vault/projects.js';
import { envEligible, RUNTIME_ENV } from './service.js';

/**
 * Job-level vault references (docs/design/p19-project-env.md "Job-level references"): the one rule every job
 * creation path (JobStore.create), every assignment (Orchestrator → signed `lease.vaultScope`) and every service start
 * applies to a `secret:vault-<id>` reference a job or service names itself.
 *
 * A vault credential reaches an environment only when
 * 1. the project gives it to its jobs: bound in `project_env_credentials` (Projeler → Politika → Ortam değişkenleri;
 *    admin, step-up, audited) and allowed by the credential's project allowlist (p22 `vault_credentials.projects`);
 * 2. its kind is `generic` — runtime keys go through runtime auth, git keys only to the worker's git, http-auth / smtp
 *    only to function jobs, MCP secrets only to their slots;
 * 3. it is active, and the variable is neither a code-loading / subscription variable nor a runtime key's own;
 * 4. the job may get environment credentials at all (`envEligible`: no untrusted source, pull request head, function,
 *    integration or machine-admin job).
 *
 * The submitter's own permission is the project's `jobs.create` (checked by every route): the admin's binding is the
 * grant for every job of the project, so there is no per-user "use credential" permission to add.
 *
 * Combination with the project's bindings: the worker gets the project's bound credentials under their own variables,
 * plus the job's references; for the same variable the job's reference wins. Because a job's vault reference must name
 * a credential bound to the same project, a job can only re-map or re-use what the project already gives its jobs — it
 * can never add a credential the project does not give. Non-vault references (a worker's own `secret:<name>`) are not
 * affected.
 *
 * Every refusal has one code ({@link VAULT_REF_NOT_AVAILABLE}) whatever the reason, so the answer does not tell whether
 * a credential id exists elsewhere.
 */
export const VAULT_REF_NOT_AVAILABLE = 'vault_credential_not_available';

interface VaultEntry {
  readonly env: string;
  readonly id: string;
  /** The reference is in the canonical form (`…secret:vault-<valid lower-case id>`). */
  readonly canonical: boolean;
}

function vaultEntries(refs: Readonly<Record<string, string>> | undefined): VaultEntry[] {
  const out: VaultEntry[] = [];
  for (const [env, ref] of Object.entries(refs ?? {})) {
    const id = vaultIdOfSecretRef(ref);
    if (id === null) continue;
    const canonical = VaultCredentialId.safeParse(id).success && ref.endsWith(`secret:vault-${id}`);
    out.push({ env, id, canonical });
  }
  return out;
}

/**
 * The variables of `refs` whose vault reference is not allowed for `project` (non-vault references are never listed),
 * and the allowed credential ids.
 */
export async function checkVaultRefs(
  db: Queryable,
  project: string,
  refs: Readonly<Record<string, string>> | undefined,
  opts: { readonly eligible: boolean },
): Promise<{ readonly refused: readonly string[]; readonly allowed: readonly string[] }> {
  const entries = vaultEntries(refs);
  if (entries.length === 0) return { refused: [], allowed: [] };
  const ids = [...new Set(entries.filter((e) => e.canonical).map((e) => e.id))];
  const rows = new Map<string, readonly string[] | null>();
  if (opts.eligible && ids.length > 0) {
    const found = await db.query<{ id: string; projects: string[] | null }>(
      `SELECT c.id, c.projects FROM vault_credentials c
         JOIN project_env_credentials b ON b.credential_id = c.id AND b.project = $1
        WHERE c.id = ANY ($2::text[]) AND c.state = 'active' AND c.kind = 'generic'`,
      [project, ids],
    );
    for (const r of found.rows) rows.set(r.id, r.projects);
  }
  const refused: string[] = [];
  const allowed = new Set<string>();
  for (const e of entries) {
    const upper = e.env.toUpperCase();
    const ok =
      opts.eligible &&
      e.canonical &&
      rows.has(e.id) &&
      credentialAllowsProject(rows.get(e.id), project) &&
      !FORBIDDEN_CREDENTIAL_ENV.has(upper) &&
      !RUNTIME_ENV.has(upper);
    if (ok) allowed.add(e.id);
    else refused.push(e.env);
  }
  return { refused: refused.sort(), allowed: [...allowed].sort() };
}

/** Submission: the issues of a job's own vault references (empty: allowed). Paths name the variable, never the value. */
export async function jobVaultRefIssues(
  db: Queryable,
  project: string,
  spec: JobSpec,
): Promise<InvalidJobIssue[]> {
  const { refused } = await checkVaultRefs(db, project, spec.secretRefs, { eligible: envEligible(spec) });
  return refused.map((env) => ({ path: `spec.secretRefs.${env}`, code: VAULT_REF_NOT_AVAILABLE }));
}

/**
 * Assignment: the spec sent to the worker without the vault references that are not allowed now (a binding removed or
 * a credential revoked after submission; the project's own bound references pass the same rule) and the allowed
 * credential ids — the signed `lease.vaultScope`.
 */
export async function scopeVaultRefs(
  db: Queryable,
  project: string,
  spec: JobSpec,
): Promise<{
  readonly spec: JobSpec;
  readonly vaultScope: readonly string[];
  readonly dropped: readonly string[];
}> {
  const { refused, allowed } = await checkVaultRefs(db, project, spec.secretRefs, {
    eligible: envEligible(spec),
  });
  if (refused.length === 0) return { spec, vaultScope: allowed, dropped: [] };
  const drop = new Set(refused);
  const kept = Object.fromEntries(Object.entries(spec.secretRefs ?? {}).filter(([env]) => !drop.has(env)));
  const { secretRefs: _all, ...rest } = spec;
  return {
    spec: Object.keys(kept).length === 0 ? rest : { ...rest, secretRefs: kept },
    vaultScope: allowed,
    dropped: refused,
  };
}
