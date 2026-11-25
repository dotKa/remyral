import { normalizeJobTitle } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p11-fixes-a (docs/design/p10-verify-health.md §11): platform **report-only** jobs — a job verification's verifier,
 * the integration's verifier, a post-deploy screenshot job. Their report is a site-bundle artifact, never a commit:
 * git flow skips them (no `job_git` row → no `pushResult` → no VERIFYING / AWAITING_APPROVAL), so they end SUCCEEDED.
 * The marker is written by the master in the job's creation transaction only — never from a request body.
 *
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md): they are platform jobs, not ordinary work — a readable title
 * ("Doğrula: <checked job>"), the job they check (`checked_job_id`), a read-only repository credential, and no generic
 * "job failed" notification, auto-fix job or failure statistics ({@link PLATFORM_JOB_SQL}).
 */

/** Why a platform job only reports (`report_only_jobs.purpose`). */
export type ReportOnlyPurpose = 'verify' | 'health' | 'integration-verify';

export const REPORT_ONLY_PURPOSES: readonly ReportOnlyPurpose[] = ['verify', 'health', 'integration-verify'];

/** Marks a job as report-only (inside its creation transaction; master callers only). */
export async function markReportOnly(
  tx: Queryable,
  jobId: string,
  purpose: ReportOnlyPurpose,
  now: Date,
  checkedJobId: string | null = null,
): Promise<void> {
  await tx.query(
    `INSERT INTO report_only_jobs (job_id, purpose, created_at, checked_job_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, purpose, now, checkedJobId],
  );
}

/** Whether a job is a platform report job (it never goes through git flow). */
export async function isReportOnly(db: Queryable, jobId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM report_only_jobs WHERE job_id = $1', [jobId]);
  return (rowCount ?? 0) > 0;
}

/**
 * SQL predicate: the job `<alias>.<column>` is a platform report job, or an auto-fix job opened for one (before
 * p19-verifier-jobs auto mode could open "Fix: You are a VERIFIER…" jobs). Such jobs are not counted as failed work:
 * no "job failed" notification, no failure spike, no failure statistics, no auto-fix.
 */
export const PLATFORM_JOB_SQL = (alias: string, column = 'id'): string =>
  `(EXISTS (SELECT 1 FROM report_only_jobs ro WHERE ro.job_id = ${alias}.${column})
    OR EXISTS (SELECT 1 FROM job_auto_fixes af JOIN report_only_jobs ro ON ro.job_id = af.source_job_id
                WHERE af.fix_job_id = ${alias}.${column}))`;

/** Whether a job is a platform job in the sense of {@link PLATFORM_JOB_SQL}. */
export async function isPlatformJob(db: Queryable, jobId: string): Promise<boolean> {
  const { rows } = await db.query<{ yes: boolean }>(
    `SELECT ${PLATFORM_JOB_SQL('j')} AS yes FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
  return rows[0]?.yes === true;
}

const TITLE_PREFIX: Readonly<Record<ReportOnlyPurpose, string>> = {
  verify: 'Doğrula',
  health: 'Sağlık kontrolü',
  'integration-verify': 'Entegrasyon doğrulaması',
};

/**
 * The stored (Turkish, the console's default language) title of a platform report job: "Doğrula: <checked job's
 * title>", "Sağlık kontrolü: <address>", "Entegrasyon doğrulaması: <root job's title>" — at most 60 characters. The
 * console says it in the reader's language from the job's platform marker (purpose + checked job).
 */
export function platformJobTitle(purpose: ReportOnlyPurpose, subject: string | null): string {
  const s = normalizeJobTitle(subject);
  return (
    normalizeJobTitle(s === null ? TITLE_PREFIX[purpose] : `${TITLE_PREFIX[purpose]}: ${s}`) ??
    TITLE_PREFIX[purpose]
  );
}
