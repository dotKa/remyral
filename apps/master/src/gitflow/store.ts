import type { Queryable } from '../db/pool.js';
import type { PathFlag } from './flags.js';
import type { CiStatus, CommitRef, MergeMethod, ProviderKind } from './types.js';

/** Stored commit summary (display; the trailer check uses the provider's full message). */
export interface StoredCommit {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string | null;
}

export interface StoredFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly previousPath?: string;
}

export interface StoredChanges {
  readonly commits: readonly StoredCommit[];
  readonly files: readonly StoredFile[];
  readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
  readonly truncated: boolean;
}

export type MergeState = 'clean' | 'conflicts' | 'base_moved' | 'unknown';

export interface StoredMergeCheck {
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly string[];
  readonly headCommits: readonly CommitRef[];
  readonly baseCommits: readonly CommitRef[];
  readonly precision: 'exact' | 'approximate' | null;
  readonly reason: string | null;
}

export type CiStoredState = CiStatus['state'] | 'timed_out';

export interface JobGitRecord {
  readonly jobId: string;
  readonly project: string;
  readonly provider: ProviderKind;
  readonly targetBranch: string;
  readonly baseSha: string | null;
  readonly baseCapturedAt: Date | null;
  readonly attemptId: string | null;
  readonly epoch: number | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly verification: 'pending' | 'passed' | 'failed';
  readonly verificationReason: string | null;
  readonly verifiedAt: Date | null;
  readonly changes: StoredChanges | null;
  readonly flags: readonly PathFlag[];
  readonly mergeState: MergeState | null;
  readonly mergeCheck: StoredMergeCheck | null;
  readonly mergeCheckedAt: Date | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly ciState: CiStoredState | null;
  readonly ci: CiStatus | null;
  readonly ciCheckedAt: Date | null;
  readonly mergedSha: string | null;
  readonly mergedAt: Date | null;
  /** p15-auto-mode: the platform rebased the attempt onto the base at job start (diverged verification). */
  readonly autoRebase: AutoRebase | null;
  readonly updatedAt: Date;
}

/** p15-auto-mode: one platform rebase of an attempt branch (`job_git.auto_rebase`). */
export interface AutoRebase {
  readonly attemptId: string;
  readonly from: string;
  readonly to: string | null;
  readonly onto: string;
  readonly outcome: 'rebased' | 'conflicts' | 'moved' | 'unsupported';
  readonly files?: readonly string[];
  readonly at: string;
}

export type MergeRequestMode = 'merge' | 'leave_open' | 'discard';
export type MergeApprovedVia = 'human' | 'security_policy';
export type MergeRequestStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'merged'
  | 'left_open'
  | 'discarded'
  | 'refused'
  | 'denied'
  | 'expired'
  | 'cancelled';

export interface MergeRequestRecord {
  readonly id: string;
  readonly jobId: string;
  /** Null when the owner's security policy approved the merge (no approval row, p15-merge-approvals). */
  readonly approvalRequestId: string | null;
  readonly mode: MergeRequestMode;
  readonly headSha: string;
  readonly baseSha: string;
  readonly targetBranch: string;
  readonly method: MergeMethod;
  /** The person who asked; null when the master opened it at verification (p15-merge-approvals). */
  readonly requestedBy: string | null;
  readonly reason: string | null;
  readonly status: MergeRequestStatus;
  readonly approvedBy: string | null;
  /** `security_policy`: passed by the owner's security policy for an `allow-all` job (ADR-0056). */
  readonly approvedVia: MergeApprovedVia;
  readonly approvedAt: Date | null;
  readonly resultReason: string | null;
  readonly mergeSha: string | null;
  readonly executedAt: Date | null;
  readonly attempts: number;
  readonly createdAt: Date;
}

interface JobGitRow {
  job_id: string;
  project: string;
  provider: ProviderKind;
  target_branch: string;
  base_sha: string | null;
  base_captured_at: Date | null;
  attempt_id: string | null;
  epoch: number | null;
  branch: string | null;
  head_sha: string | null;
  verification: 'pending' | 'passed' | 'failed';
  verification_reason: string | null;
  verified_at: Date | null;
  changes: StoredChanges | null;
  flags: PathFlag[];
  merge_state: MergeState | null;
  merge_check: StoredMergeCheck | null;
  merge_checked_at: Date | null;
  pr_number: number | null;
  pr_url: string | null;
  ci_state: CiStoredState | null;
  ci: CiStatus | null;
  ci_checked_at: Date | null;
  merged_sha: string | null;
  merged_at: Date | null;
  auto_rebase?: AutoRebase | null;
  updated_at: Date;
}

interface MergeRequestRow {
  id: string;
  job_id: string;
  approval_request_id: string | null;
  mode: MergeRequestMode;
  head_sha: string;
  base_sha: string;
  target_branch: string;
  method: MergeMethod;
  requested_by: string | null;
  reason: string | null;
  status: MergeRequestStatus;
  approved_by: string | null;
  approved_via: MergeApprovedVia;
  approved_at: Date | null;
  result_reason: string | null;
  merge_sha: string | null;
  executed_at: Date | null;
  attempts: number;
  created_at: Date;
}

export function toJobGit(r: JobGitRow): JobGitRecord {
  return {
    jobId: r.job_id,
    project: r.project,
    provider: r.provider,
    targetBranch: r.target_branch,
    baseSha: r.base_sha,
    baseCapturedAt: r.base_captured_at,
    attemptId: r.attempt_id,
    epoch: r.epoch,
    branch: r.branch,
    headSha: r.head_sha,
    verification: r.verification,
    verificationReason: r.verification_reason,
    verifiedAt: r.verified_at,
    changes: r.changes,
    flags: r.flags,
    mergeState: r.merge_state,
    mergeCheck: r.merge_check,
    mergeCheckedAt: r.merge_checked_at,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    ciState: r.ci_state,
    ci: r.ci,
    ciCheckedAt: r.ci_checked_at,
    mergedSha: r.merged_sha,
    mergedAt: r.merged_at,
    autoRebase: r.auto_rebase ?? null,
    updatedAt: r.updated_at,
  };
}

export function toMergeRequest(r: MergeRequestRow): MergeRequestRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    approvalRequestId: r.approval_request_id,
    mode: r.mode,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    targetBranch: r.target_branch,
    method: r.method,
    requestedBy: r.requested_by,
    reason: r.reason,
    status: r.status,
    approvedBy: r.approved_by,
    approvedVia: r.approved_via,
    approvedAt: r.approved_at,
    resultReason: r.result_reason,
    mergeSha: r.merge_sha,
    executedAt: r.executed_at,
    attempts: r.attempts,
    createdAt: r.created_at,
  };
}

export async function loadJobGit(db: Queryable, jobId: string, lock = false): Promise<JobGitRecord | null> {
  const { rows } = await db.query<JobGitRow>(
    `SELECT * FROM job_git WHERE job_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [jobId],
  );
  const r = rows[0];
  return r === undefined ? null : toJobGit(r);
}

export async function loadMergeRequests(db: Queryable, jobId: string): Promise<MergeRequestRecord[]> {
  const { rows } = await db.query<MergeRequestRow>(
    'SELECT * FROM git_merge_requests WHERE job_id = $1 ORDER BY created_at, id',
    [jobId],
  );
  return rows.map(toMergeRequest);
}

export async function loadMergeRequest(
  db: Queryable,
  where: { id: string } | { approvalRequestId: string },
  lock = false,
): Promise<MergeRequestRecord | null> {
  const [col, val] = 'id' in where ? ['id', where.id] : ['approval_request_id', where.approvalRequestId];
  const { rows } = await db.query<MergeRequestRow>(
    `SELECT * FROM git_merge_requests WHERE ${col} = $1${lock ? ' FOR UPDATE' : ''}`,
    [val],
  );
  const r = rows[0];
  return r === undefined ? null : toMergeRequest(r);
}

const UPDATABLE: ReadonlySet<string> = new Set([
  'base_sha',
  'base_captured_at',
  'attempt_id',
  'epoch',
  'branch',
  'head_sha',
  'verification',
  'verification_reason',
  'verified_at',
  'changes',
  'flags',
  'merge_state',
  'merge_check',
  'merge_checked_at',
  'pr_number',
  'pr_url',
  'ci_state',
  'ci',
  'ci_checked_at',
  'merged_sha',
  'merged_at',
  'decision_closed_seen',
  'auto_rebase',
  'target_branch',
]);

/** Partial update of a job_git row (column → value; jsonb values are serialised). */
export async function updateJobGit(
  db: Queryable,
  jobId: string,
  fields: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<void> {
  const cols = Object.keys(fields);
  for (const c of cols) if (!UPDATABLE.has(c)) throw new Error(`job_git column not updatable: ${c}`);
  const JSONB = new Set(['changes', 'flags', 'merge_check', 'ci', 'auto_rebase']);
  const sets = cols.map((c, i) => `${c} = $${String(i + 3)}`);
  const values = cols.map((c) => {
    const v = fields[c];
    return JSONB.has(c) && v !== null ? JSON.stringify(v) : v;
  });
  await db.query(`UPDATE job_git SET ${[...sets, 'updated_at = $2'].join(', ')} WHERE job_id = $1`, [
    jobId,
    now,
    ...values,
  ]);
}
