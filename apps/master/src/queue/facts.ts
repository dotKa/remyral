import { LocalLoginSlots, PROFILE_SLOTS_FEATURE, SandboxProfile } from '@remyral/protocol';
import { type PlacementWorker, runsWithExclusiveLogin } from '@remyral/scheduler';
import type { Queryable } from '../db/pool.js';

/**
 * p9-queue-priority: placement facts the master derives for the queue (docs/design/p9-queue-priority.md §2, §4).
 */

/**
 * Per-profile slot facts of a worker. The reported concurrency is used only from a worker that advertises
 * `profile-slots-v1` (and is re-validated: unknown profiles, out-of-range values are dropped); the active counts are
 * always the master's own lease count.
 */
export function profileFacts(
  features: unknown,
  rawConcurrency: unknown,
  rawExclusive: unknown,
  active: Record<string, number> | null,
): Pick<PlacementWorker, 'profileConcurrency' | 'exclusiveProfiles' | 'profileActive'> {
  const out: {
    profileConcurrency?: Partial<Record<string, number>>;
    exclusiveProfiles?: string[];
    profileActive?: Partial<Record<string, number>>;
  } = {};
  if (active !== null && typeof active === 'object') out.profileActive = active;
  if (!Array.isArray(features) || !features.includes(PROFILE_SLOTS_FEATURE)) return out;
  if (typeof rawConcurrency === 'object' && rawConcurrency !== null) {
    const pc: Partial<Record<string, number>> = {};
    for (const [k, v] of Object.entries(rawConcurrency as Record<string, unknown>)) {
      if (
        SandboxProfile.safeParse(k).success &&
        Number.isInteger(v) &&
        (v as number) >= 0 &&
        (v as number) <= 64
      ) {
        pc[k] = v as number;
      }
    }
    out.profileConcurrency = pc;
  }
  if (Array.isArray(rawExclusive)) {
    out.exclusiveProfiles = rawExclusive.filter(
      (p): p is string => typeof p === 'string' && SandboxProfile.safeParse(p).success,
    );
  }
  return out;
}

/**
 * p9-subjob-local-login-deadlock: the root job of `jobId`'s sub-job tree (`jobId` itself for a root job).
 * p11-fixes-a: an integration / conflict-resolution / fix / verify job of a coordinator's integration belongs to the
 * coordinator's family too (the coordinator may still hold a slot while its integration runs).
 */
export async function jobFamily(db: Queryable, jobId: string): Promise<string> {
  const { rows } = await db.query<{ root: string | null }>(
    `SELECT COALESCE(
       (SELECT root_job_id::text FROM job_subtasks WHERE child_job_id = $1),
       (SELECT i.root_job_id::text FROM integration_jobs ij JOIN integrations i ON i.id = ij.integration_id
         WHERE ij.job_id = $1)) AS root`,
    [jobId],
  );
  return rows[0]?.root ?? jobId;
}

/** The job's queue priority: a queue-screen override (reorder, run now) or its stored priority. */
export async function effectiveQueuePriority(
  db: Queryable,
  job: { readonly id: string; readonly priority: number },
): Promise<number> {
  const { rows } = await db.query<{ priority: number }>(
    'SELECT priority FROM job_queue_priority WHERE job_id = $1',
    [job.id],
  );
  return rows[0]?.priority ?? job.priority;
}

/**
 * p9-queue-local-login-accounting (A): SQL condition for a lease that holds a slot on its worker — unreleased, and not
 * the not-yet-answered re-ask (RESERVED) of a job that this worker declined as busy before. Such a re-ask is usually
 * declined again within a second; counting it made the jobs behind it read "2/3 slots in use" while one job ran, and
 * made a decline recorded meanwhile look as if a slot freed up when the re-ask was declined (an immediate re-ask
 * loop). If the re-ask is accepted the job leaves RESERVED and counts again; the worker's own capacity check covers
 * the short window (a transient decline). `l` / `j`: aliases of `leases` / `jobs`.
 */
export function slotLease(l: string, j: string): string {
  // p14-workflow-engine 14.3: a function job (kind "function") holds no AI slot — counted apart (function slots).
  return `${l}.released_at IS NULL AND COALESCE(${j}.spec->>'kind', '') <> 'function' AND NOT (${j}.state = 'RESERVED' AND EXISTS (
    SELECT 1 FROM job_declines sd WHERE sd.job_id = ${l}.job_id AND sd.worker_id = ${l}.worker_id
       AND sd.kind = 'transient'))`;
}

/**
 * One slot-holding lease of a worker as placement needs it (SQL `json_build_object` of {@link SLOT_LEASE_JSON}):
 * its profile, the runtime it runs (a fallback runtime when chosen) and whether that runtime option brings its own
 * credential (model profile `credentialRef`).
 */
export interface SlotLeaseRow {
  readonly profile: string;
  readonly runtime: string;
  readonly ownCredential: boolean;
  /** p13-runtime-accounts: the runtime account the lease runs with (`default` when none was chosen). */
  readonly account?: string;
  /** p9-subjob-local-login-deadlock: the lease's job and its family (root job of its sub-job tree). */
  readonly jobId?: string;
  readonly family?: string;
}

/**
 * p9-subjob-local-login-deadlock: SQL for a job's family — the root job of its agent-requested sub-job tree
 * (`job_subtasks.root_job_id`), its own id for a root job. `j`: alias of `jobs`.
 */
export function familySql(j: string): string {
  return `COALESCE((SELECT fs.root_job_id::text FROM job_subtasks fs WHERE fs.child_job_id = ${j}.id),
    (SELECT fi.root_job_id::text FROM integration_jobs fij JOIN integrations fi ON fi.id = fij.integration_id
      WHERE fij.job_id = ${j}.id), ${j}.id::text)`;
}

/** SQL for one {@link SlotLeaseRow}; needs `l` (leases), `j` (jobs) and `r` (job_runs, LEFT JOIN on attempt_id). */
export const SLOT_LEASE_JSON = `json_build_object(
  'jobId', j.id::text,
  'family', ${familySql('j')},
  'profile', COALESCE(j.spec->>'sandboxProfile', 'container'),
  'runtime', COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime'),
  'account', COALESCE(r.runtime_choice->>'account', 'default'),
  'ownCredential', CASE WHEN r.runtime_choice ? 'ownCredential' THEN (r.runtime_choice->>'ownCredential')::boolean
    WHEN r.runtime_choice->>'origin' = 'policy' THEN false
    WHEN COALESCE((r.runtime_choice->>'index')::int, 0) > 0
    THEN (j.spec->'fallbacks'->((r.runtime_choice->>'index')::int - 1)->'modelProfile'->'credentialRef') IS NOT NULL
    ELSE (j.spec->'modelProfile'->'credentialRef') IS NOT NULL END)`;

/**
 * CAPABILITIES.localLogin as stored, used only from a worker that advertises `profile-slots-v1`. `stores`
 * (p9-subjob-local-login-deadlock) switches placement to the per-store, per-family rule.
 */
export function localLoginFacts(features: unknown, raw: unknown): PlacementWorker['localLogin'] {
  if (!Array.isArray(features) || !features.includes(PROFILE_SLOTS_FEATURE)) return undefined;
  const parsed = LocalLoginSlots.safeParse(raw);
  if (!parsed.success || parsed.data.runtimes.length === 0 || parsed.data.exclusiveProfiles.length === 0) {
    return undefined;
  }
  return parsed.data;
}

/**
 * p15-merge-approvals item 4: the worker's last HEARTBEAT `load.workspaceDisk` (free disk under the workspace root vs.
 * its `workspace.minFreeBytes`) as placement facts; `{}` when not reported (older workers) or malformed.
 */
export function diskFacts(load: unknown): Pick<PlacementWorker, 'disk'> {
  if (typeof load !== 'object' || load === null) return {};
  const d = (load as { workspaceDisk?: unknown }).workspaceDisk;
  if (typeof d !== 'object' || d === null) return {};
  const { freeBytes, minFreeBytes } = d as { freeBytes?: unknown; minFreeBytes?: unknown };
  if (typeof freeBytes !== 'number' || typeof minFreeBytes !== 'number') return {};
  if (!Number.isFinite(freeBytes) || !Number.isFinite(minFreeBytes) || freeBytes < 0 || minFreeBytes < 0)
    return {};
  return { disk: { freeBytes, minFreeBytes } };
}

/** Slot counts of a worker from its slot-holding leases: total, per profile, and subscription-login ones. */
export function slotCounts(
  leases: readonly SlotLeaseRow[],
  localLogin: PlacementWorker['localLogin'],
): Pick<PlacementWorker, 'activeLeases' | 'profileActive' | 'localLoginActive' | 'slotLeases'> {
  const profileActive: Partial<Record<string, number>> = {};
  let localLoginActive = 0;
  for (const l of leases) {
    profileActive[l.profile] = (profileActive[l.profile] ?? 0) + 1;
    if (
      runsWithExclusiveLogin(
        { runtime: l.runtime, sandboxProfile: l.profile, ownCredential: l.ownCredential },
        { localLogin },
      )
    ) {
      localLoginActive++;
    }
  }
  return { activeLeases: leases.length, profileActive, localLoginActive, slotLeases: leases };
}
