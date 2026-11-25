import { type JobModelProfile, RuntimeKind, WorkerConfigDocument, WorkerConfigSpec } from '@remyral/protocol';
import type { ManagedPlacementConfig, PlacementJob } from '@remyral/scheduler';
import type { Queryable } from '../db/pool.js';
import { type CatalogEntry, loadCatalog } from '../models/service.js';

/** The protocol feature a worker needs to hold vault credentials (ADR-0016). */
const VAULT_FEATURE = 'credential-vault-v1';

type Facts = Pick<ManagedPlacementConfig, 'runtimeCredentials' | 'unavailableModelProfiles'>;

/** Why a catalog profile cannot be used for `runtime` (null: usable or not a catalog id). */
export function catalogProblem(
  catalog: ReadonlyMap<string, CatalogEntry>,
  id: string,
  runtime: string,
): string | null {
  const c = catalog.get(id);
  if (c === undefined) return null;
  if (!c.entry.enabled) return `model profile ${id} is disabled in the model catalog`;
  if (!c.entry.runtimes.includes(runtime as RuntimeKind)) {
    return `model profile ${id} is not offered for ${runtime} (catalog runtimes: ${c.entry.runtimes.join(', ')})`;
  }
  return null;
}

/**
 * p5-credentials-models placement facts for panel-managed workers: for each enabled runtime, the vault credential
 * its delivered auth uses and whether the worker holds the desired version; and runtimes whose configured
 * catalog model profile is unusable. One query per kind for all workers.
 */
export async function credentialModelFacts(
  db: Queryable,
  workers: readonly {
    readonly id: string;
    readonly spec: unknown;
    readonly document: unknown;
    readonly features: unknown;
  }[],
): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  const managed = workers.filter((w) => w.document !== null && w.document !== undefined);
  if (managed.length === 0) return out;
  const { rows } = await db.query<{
    credential_id: string;
    worker_id: string;
    version: number;
    row_state: string;
    cred_state: string;
    acked_version: number | null;
    ack_outcome: string | null;
  }>(
    `SELECT r.credential_id, r.worker_id, r.version, r.state AS row_state, c.state AS cred_state, r.acked_version,
            r.ack_outcome
       FROM vault_credential_workers r JOIN vault_credentials c ON c.id = r.credential_id
      WHERE r.worker_id = ANY($1)`,
    [managed.map((w) => w.id)],
  );
  const held = new Map(rows.map((r) => [`${r.worker_id}\n${r.credential_id}`, r]));
  const catalog = await loadCatalog(db);
  for (const w of managed) {
    const doc = WorkerConfigDocument.safeParse(w.document);
    const spec = WorkerConfigSpec.safeParse(w.spec);
    if (!doc.success) continue;
    const supported = Array.isArray(w.features) && w.features.includes(VAULT_FEATURE);
    const runtimeCredentials: Record<
      string,
      { credentialId: string; state: 'ready' | 'pending' | 'missing' }
    > = {};
    const unavailableModelProfiles: Record<string, string> = {};
    for (const runtime of RuntimeKind.options) {
      if (!doc.data.allowedRuntimes.includes(runtime)) continue;
      const auth = doc.data.runtimes[runtime]?.auth;
      if (auth?.mode === 'secret-ref' && auth.credentialRef.source === 'vault') {
        const id = auth.credentialRef.id;
        const r = held.get(`${w.id}\n${id}`);
        let state: 'ready' | 'pending' | 'missing';
        if (!supported || r === undefined || r.row_state !== 'active' || r.cred_state !== 'active')
          state = 'missing';
        else if (r.acked_version === r.version) state = 'ready';
        else state = r.ack_outcome === 'rejected' ? 'missing' : 'pending';
        runtimeCredentials[runtime] = { credentialId: id, state };
      }
      const profile = spec.success ? spec.data.runtimes[runtime]?.modelProfile : undefined;
      const problem = profile === undefined ? null : catalogProblem(catalog, profile, runtime);
      if (problem !== null)
        unavailableModelProfiles[runtime] = `${problem} (worker configuration of this worker)`;
    }
    out.set(w.id, { runtimeCredentials, unavailableModelProfiles });
  }
  return out;
}

/**
 * Placement facts of a job's catalog model profile (`JobSpec.modelProfile`): its id and,
 * for a vault credential, the workers that hold its current version (a worker-store secret cannot be checked).
 */
export async function jobModelProfileFacts(
  db: Queryable,
  profile: JobModelProfile | undefined,
): Promise<PlacementJob['modelProfile']> {
  if (profile === undefined) return undefined;
  const ref = profile.credentialRef;
  if (ref?.source !== 'vault') return { id: profile.id };
  const { rows } = await db.query<{ worker_id: string }>(
    `SELECT r.worker_id FROM vault_credential_workers r JOIN vault_credentials c ON c.id = r.credential_id
      WHERE r.credential_id = $1 AND r.state = 'active' AND c.state = 'active' AND r.acked_version = r.version`,
    [ref.id],
  );
  return { id: profile.id, credentialId: ref.id, credentialWorkers: rows.map((r) => r.worker_id) };
}
