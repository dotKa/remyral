/**
 * p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md §2.1): SQL for a job's effective approval mode.
 * The spec is immutable after submission; changes live in `job_approval_mode_changes`, the latest `seq` wins.
 *
 * `alias` is the `jobs` table name or alias in the surrounding query (a trusted constant, never user input).
 */
const ALIAS = /^[a-z_][a-z0-9_]{0,30}$/;

function checked(alias: string): string {
  if (!ALIAS.test(alias)) throw new TypeError(`invalid SQL alias ${alias}`);
  return alias;
}

/** The latest changed mode of the job, or NULL when it was never changed. */
export function CHANGED_APPROVAL_MODE_SQL(alias: string): string {
  const a = checked(alias);
  return `(SELECT c.to_mode FROM job_approval_mode_changes c WHERE c.job_id = ${a}.id ORDER BY c.seq DESC LIMIT 1)`;
}

/** The job's effective mode: the latest change, else `spec.approvalPolicy`. */
export function EFFECTIVE_APPROVAL_POLICY_SQL(alias: string): string {
  const a = checked(alias);
  return `COALESCE(${CHANGED_APPROVAL_MODE_SQL(a)}, ${a}.spec->>'approvalPolicy')`;
}

/** p15-autonomy: the latest changed time limit of the job (seconds), or NULL when it was never changed. */
export function CHANGED_TIME_LIMIT_SQL(alias: string): string {
  const a = checked(alias);
  return `(SELECT c.to_sec FROM job_time_limit_changes c WHERE c.job_id = ${a}.id ORDER BY c.seq DESC LIMIT 1)`;
}

/** p15-auto-mode: the latest healed base ref of the job (`job_base_ref_changes`), or NULL when it was never healed. */
export function CHANGED_BASE_REF_SQL(alias: string): string {
  const a = checked(alias);
  return `(SELECT c.base_ref FROM job_base_ref_changes c WHERE c.job_id = ${a}.id ORDER BY c.seq DESC LIMIT 1)`;
}

/** p15-job-titles: the job's current title (`job_titles`), or NULL before the back-fill reached it. */
export function JOB_TITLE_SQL(alias: string): string {
  const a = checked(alias);
  return `(SELECT t.title FROM job_titles t WHERE t.job_id = ${a}.id)`;
}
