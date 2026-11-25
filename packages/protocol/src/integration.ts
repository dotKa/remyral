import { z } from 'zod';

/**
 * p11-merge-pipeline (ADR-0041, docs/design/p11-merge-pipeline.md): master-managed integration. The master merges the
 * verified branches of a coordinator's sub-jobs (or of a workflow's upstream steps) into ONE integration branch
 * `int/<root8>` — deterministically, with real git on a worker, without an agent — and opens one pull request.
 *
 * Wire (additive in 1.0, only to `integration-v1` workers):
 *  - ASSIGN_JOB `spec.kind = "integration"` with `spec.integration` ({@link IntegrationPlan}): the worker checks out
 *    `repository.baseRef` (the integration head so far, a full sha) as usual, merges the plan's branches in order
 *    (`git merge --no-ff`, hooks / attributes / filters disabled), takes a conflict-resolution job's version of exactly
 *    the conflicting files where the plan says so, and publishes the result like any attempt (`rac/<job>/<attempt>`,
 *    trailer, lease, secret scan) — the master verifies it on the remote (p4-git-flow) and moves `int/<root8>`.
 *  - The worker returns {@link IntegrationReport} as the artifact {@link INTEGRATION_REPORT_NAME} (id
 *    {@link INTEGRATION_REPORT_ARTIFACT_ID}): per step the outcome and, for a conflict, the conflicting files with
 *    bounded conflict markers and both sides' diffs. The report is a claim and untrusted text; the master checks the
 *    pushed branch itself.
 * No agent runs: the runtime of such a job is only a label (placement does not require it to be installed).
 */

export const INTEGRATION_FEATURE = 'integration-v1';
export const INTEGRATION_REPORT_ARTIFACT_ID = 'ws-integration-report';
export const INTEGRATION_REPORT_NAME = 'integration-report.json';

export const INTEGRATION_LIMITS = {
  /** Branches one integration merges (sub-jobs: ≤ 16 per family + the coordinator; workflows: ≤ 30 steps). */
  maxSteps: 32,
  /** Conflicting files reported per conflict (names); the first `maxDetailedFiles` with markers and diffs. */
  maxConflictFiles: 200,
  maxDetailedFiles: 8,
  /** Per detailed file: conflict-marker excerpt and each side's diff (UTF-8 characters). */
  maxMarkerChars: 6 * 1024,
  maxDiffChars: 6 * 1024,
  /** The whole report (bytes). */
  maxReportBytes: 512 * 1024,
  /** Files a resolution may replace. */
  maxResolutionFiles: 200,
} as const;

const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'full sha');
/** A branch name the worker may fetch / name (same shape as git flow branches; no `..`, no `@{`, no control chars). */
const BranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?![/-])(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\/$)[A-Za-z0-9._/+-]+$/, 'branch name');
/** A repository-relative path (POSIX), as git prints it. */
export const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..'), 'repository path');

export const IntegrationStep = z.object({
  /** Position in the integration (stable across rounds). */
  position: z.number().int().min(0).max(1000),
  /** Short label for commit messages (`<title> (job <id8>)`); untrusted text, clipped. */
  label: z.string().min(1).max(200),
  /** The verified branch and the sha the master verified on it (the worker merges exactly this commit). */
  branch: BranchName,
  sha: Sha,
  /**
   * A conflict-resolution job's verified result for this step: its commit (descends from the integration head) and
   * the files it resolved. The worker takes exactly these files from it when merging `sha` conflicts in them.
   */
  resolution: z
    .object({
      sha: Sha,
      branch: BranchName,
      files: z.array(RepoPath).min(1).max(INTEGRATION_LIMITS.maxResolutionFiles),
    })
    .optional(),
});
export type IntegrationStep = z.infer<typeof IntegrationStep>;

export const IntegrationPlan = z.object({
  integrationId: z.uuid(),
  round: z.number().int().min(1).max(1000),
  /** `int/<root8>` (only used in commit messages; the worker pushes its attempt branch like any job). */
  integrationBranch: BranchName,
  steps: z.array(IntegrationStep).min(1).max(INTEGRATION_LIMITS.maxSteps),
});
export type IntegrationPlan = z.infer<typeof IntegrationPlan>;

export const ConflictFileDetail = z.object({
  path: RepoPath,
  /** Excerpt of the file with git's conflict markers (bounded; `truncated` when cut). */
  markers: z.string().max(INTEGRATION_LIMITS.maxMarkerChars),
  /** `git diff <merge-base> <integration head> -- path` (what the already-integrated work changed). */
  oursDiff: z.string().max(INTEGRATION_LIMITS.maxDiffChars),
  /** `git diff <merge-base> <step sha> -- path` (what the incoming branch changed). */
  theirsDiff: z.string().max(INTEGRATION_LIMITS.maxDiffChars),
  truncated: z.boolean(),
});
export type ConflictFileDetail = z.infer<typeof ConflictFileDetail>;

export const IntegrationStepOutcome = z.enum([
  /** Merged cleanly (a merge commit). */
  'merged',
  /** Merged with the resolution job's files for the conflicting paths. */
  'resolved',
  /** Already contained in the integration head (nothing to do). */
  'already',
  /** Conflicts: the merge was aborted; the integration stops here. */
  'conflict',
  /** The commit is not on the remote (or not the verified sha). */
  'missing',
  /** Not attempted (an earlier step stopped the round). */
  'skipped',
]);
export type IntegrationStepOutcome = z.infer<typeof IntegrationStepOutcome>;

export const IntegrationReport = z.object({
  version: z.literal(1),
  integrationId: z.uuid(),
  round: z.number().int().min(1).max(1000),
  steps: z
    .array(
      z.object({
        position: z.number().int().min(0).max(1000),
        outcome: IntegrationStepOutcome,
        /** Merge commit created for this step (merged / resolved). */
        mergeSha: Sha.optional(),
        /** Conflict: every conflicting path, and the detailed ones. */
        conflictFiles: z.array(RepoPath).max(INTEGRATION_LIMITS.maxConflictFiles).optional(),
        details: z.array(ConflictFileDetail).max(INTEGRATION_LIMITS.maxDetailedFiles).optional(),
        /** Short reason (missing commit, a resolution that left markers, …). */
        detail: z.string().max(500).optional(),
      }),
    )
    .max(INTEGRATION_LIMITS.maxSteps),
});
export type IntegrationReport = z.infer<typeof IntegrationReport>;

/** `int/<first 8 hex chars of the root id>` — the one branch an integration publishes and opens a PR from. */
export function integrationBranchName(rootId: string): string {
  return `int/${rootId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}
