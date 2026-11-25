import type { Queryable } from '../db/pool.js';
import type { ReportOnlyPurpose } from './report-only.js';

/**
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md §4): the job-read marker of a platform report job — what the
 * console needs to show it as a platform job ("Doğrulama" badge, the checked job, the outcome) instead of an ordinary
 * failed job. Read from `report_only_jobs` (master-written only) and the verification / health records.
 *
 * `outcome` is the CHECKED job's verification as this verifier left it:
 *   verified      the verification passed / passed with warnings (Doğrulandı)
 *   issues        the verification found problems (Doğrulama sorun buldu)
 *   unverifiable  the verifier could not run — infrastructure, git, runtime (Doğrulanamadı)
 *   running       still being checked
 *   null          nothing to say beyond the job's own state (e.g. an integration verifier that succeeded)
 */

export type PlatformOutcome = 'verified' | 'issues' | 'unverifiable' | 'running';

export interface PlatformMarker {
  readonly purpose: ReportOnlyPurpose;
  readonly checkedJobId: string | null;
  /** The checked job's current title (the console says "Verify: <title>" in the reader's language). */
  readonly checkedTitle: string | null;
  readonly outcome: PlatformOutcome | null;
  /** Why it could not run (`unverifiable` of a job verification; `UNVERIFIABLE_CAUSES`), else null. */
  readonly errorCause: string | null;
}

/** SQL select expression (alias of `jobs`): the raw marker as json, NULL for an ordinary job. */
export const PLATFORM_MARKER_SQL = (j = 'j'): string =>
  `(SELECT json_build_object(
      'purpose', ro.purpose,
      'checkedJobId', ro.checked_job_id::text,
      'checkedTitle', (SELECT ct.title FROM job_titles ct WHERE ct.job_id = ro.checked_job_id),
      'verification', (SELECT v.state FROM job_verifications v WHERE v.verifier_job_id = ro.job_id LIMIT 1),
      'errorCause', (SELECT v.error_cause FROM job_verifications v WHERE v.verifier_job_id = ro.job_id LIMIT 1),
      'health', (SELECT h.state FROM deploy_health_checks h WHERE h.browser_job_id = ro.job_id LIMIT 1))
     FROM report_only_jobs ro WHERE ro.job_id = ${j}.id)`;

const PURPOSES = new Set<string>(['verify', 'health', 'integration-verify']);
const ACTIVE_JOB = new Set([
  'DRAFT',
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'RETRY_WAIT',
  'PAUSED',
]);

function recordOutcome(state: unknown): PlatformOutcome | null | undefined {
  switch (state) {
    case 'passed':
    case 'warned':
      return 'verified';
    case 'failed':
      return 'issues';
    case 'error':
      return 'unverifiable';
    case 'waiting':
    case 'pending':
    case 'checking':
    case 'verifying':
    case 'browser':
      return 'running';
    case 'skipped':
      return null;
    default:
      return undefined;
  }
}

/** The marker from {@link PLATFORM_MARKER_SQL}'s value and the report job's own state (pure). */
export function platformMarker(raw: unknown, jobState: string): PlatformMarker | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.purpose !== 'string' || !PURPOSES.has(o.purpose)) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  // The checked job's record wins; without one (an integration verifier, a retried verification) the report job's
  // own end: failed / cancelled / lost = it could not run.
  let outcome = recordOutcome(o.verification);
  if (outcome === undefined) outcome = recordOutcome(o.health);
  if (outcome === undefined) {
    outcome =
      jobState === 'FAILED' || jobState === 'CANCELLED' || jobState === 'LOST'
        ? 'unverifiable'
        : ACTIVE_JOB.has(jobState)
          ? 'running'
          : null;
  }
  return {
    purpose: o.purpose as ReportOnlyPurpose,
    checkedJobId: str(o.checkedJobId),
    checkedTitle: str(o.checkedTitle),
    outcome,
    errorCause: outcome === 'unverifiable' ? str(o.errorCause) : null,
  };
}

/** The marker of one job (null: an ordinary job). */
export async function loadPlatformMarker(db: Queryable, jobId: string): Promise<PlatformMarker | null> {
  const { rows } = await db.query<{ state: string; platform: unknown }>(
    `SELECT j.state::text AS state, ${PLATFORM_MARKER_SQL('j')} AS platform FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
  const r = rows[0];
  return r === undefined ? null : platformMarker(r.platform, r.state);
}

/**
 * p19-verifier-jobs: plan items follow the job a verifier checks. `rows` were read for the followed ids (a verifier's
 * checked job instead of the verifier); each linked id gets its followed job's row under its own id (pure).
 */
export function followCheckedJobs<T extends { readonly id: string }>(
  linked: readonly string[],
  follow: ReadonlyMap<string, string>,
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return linked.flatMap((id) => {
    const r = byId.get(follow.get(id) ?? id);
    return r === undefined ? [] : [{ ...r, id }];
  });
}
