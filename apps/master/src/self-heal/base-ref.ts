import type { ReasonSummary } from '@remyral/scheduler';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { ProjectGitConfig } from '../gitflow/config-store.js';
import { isAttemptBranch, isTargetBranch, sameRepository, SHA } from '../gitflow/refs.js';
import type { GitProvider } from '../gitflow/types.js';
import type { JobRecord } from '../jobs/store.js';
import { recordAutoEvent } from './events.js';
import type { RemoteProbe } from './remote-probe.js';
import { SELF_HEAL_ACTOR } from './retry.js';

/**
 * p15-auto-mode (docs/design/p15-auto-mode.md §5): a queued job whose base ref does not exist on the remote is healed
 * before it is dispatched (prod 2026-10-22: 9 × BaseRefNotFoundError).
 *
 * 1. The base ref names another job's work branch (`spec.repository.workBranch`, e.g. `agent/chat-…`, which is never
 *    pushed — the platform publishes attempt branches `rac/<job>/<attempt>`) or one of its attempt branches:
 *    - the job's result was merged → its target branch;
 *    - its verified head exists → that commit (the follow-up builds on the result);
 *    - the job is still running / verifying / waiting → this job waits for it (`dependency_pending`);
 *    - it ended without a published result → the project's base branch, with a note.
 * 2. The project's base branch (e.g. `main`) does not exist → the repository's default branch (the provider's `HEAD`),
 *    recorded on the project (`project_git_configs.base_branch`, audited `project.git.base_branch_healed`).
 * 3. Any other missing branch → the project's base branch (or the default branch when that is missing too).
 *
 * A heal is a row of `job_base_ref_changes` (the spec stays immutable; every reader sees the latest one), a job timeline
 * event and an audit entry `job.base_ref.heal`. Nothing happens for SHAs, jobs without a repository, projects without a
 * git configuration or another repository than the project's.
 */

export interface BaseRefHealerDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  /** The project's git provider and configuration (gitflow), null when the project has none. */
  readonly providerFor: (
    project: string,
  ) => Promise<{ readonly provider: GitProvider; readonly config: ProjectGitConfig } | null>;
  /** p22-git-preflight: the anonymous view of repositories without a git configuration (absent: not healed). */
  readonly probe?: RemoteProbe;
}

export type HealReason = 'previous_job_head' | 'previous_job_target' | 'project_base' | 'repository_default';

export type HealOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'healed'; readonly from: string; readonly to: string; readonly reason: HealReason }
  | { readonly kind: 'wait'; readonly forJob: string; readonly reasons: readonly ReasonSummary[] }
  | { readonly kind: 'unresolved'; readonly why: string };

const ACTIVE = new Set([
  'DRAFT',
  'QUEUED',
  'BLOCKED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'RETRY_WAIT',
  'LOST',
  'PAUSED',
  'CANCELLING',
]);

export class BaseRefHealer {
  readonly #clock: () => Date;

  constructor(private readonly deps: BaseRefHealerDeps) {
    this.#clock = deps.clock ?? (() => new Date());
  }

  /** Checks (and heals) the base ref of a queued job. Provider errors propagate (the caller dispatches anyway). */
  async heal(job: JobRecord): Promise<HealOutcome> {
    const repo = job.spec.repository;
    if (repo === undefined || repo.pullRequest !== undefined) return { kind: 'ok' };
    const ref = repo.baseRef;
    if (SHA.test(ref)) return { kind: 'ok' };
    const git = await this.deps.providerFor(job.project);
    if (git === null || !sameRepository(git.config.repositoryUrl, repo.url))
      return this.#healAnonymous(job, ref);
    const { provider, config } = git;
    if (isTargetBranch(ref) || isAttemptBranch(ref)) {
      // p18-project-bootstrap: GitHub answers 409 for a branch of an empty repository — that is "missing", not an error.
      const head = await provider.branchHead(ref).catch(async (err: unknown) => {
        if (await isEmpty(provider)) return null;
        throw err;
      });
      if (head !== null) return { kind: 'ok' };
    }

    // 1. another job's work branch / attempt branch
    const prev = await this.#previousJob(job, ref);
    if (prev !== null) {
      if (prev.merged_sha !== null && isTargetBranch(prev.target_branch ?? '')) {
        return this.#apply(job, ref, prev.target_branch ?? config.baseBranch, 'previous_job_target', prev.id);
      }
      if (prev.head_sha !== null && SHA.test(prev.head_sha)) {
        return this.#apply(job, ref, prev.head_sha, 'previous_job_head', prev.id);
      }
      if (ACTIVE.has(prev.state) || prev.state === 'AWAITING_APPROVAL') {
        return {
          kind: 'wait',
          forJob: prev.id,
          reasons: [
            {
              code: 'dependency_pending',
              permanent: false,
              message: `waits for job ${prev.id.slice(0, 8)} to publish its result (the base ${ref} is its work branch)`,
              workers: [],
            },
          ],
        };
      }
    }

    // p18-project-bootstrap: an EMPTY repository has no branch to heal to — the job's worker creates the base branch's
    // first commit (`workspace-empty-repo-v1`). A job on another branch than the project's base starts from the base
    // branch, so that first commit lands where the pull requests go.
    if (await isEmpty(provider)) {
      return ref === config.baseBranch
        ? { kind: 'ok' }
        : this.#apply(job, ref, config.baseBranch, 'project_base', prev?.id ?? null);
    }

    // 2. / 3. the project's base branch, else the repository's default branch
    const base = config.baseBranch;
    if (ref !== base && (await provider.branchHead(base)) !== null) {
      return this.#apply(job, ref, base, 'project_base', prev?.id ?? null);
    }
    const fallback = provider.defaultBranch === undefined ? null : await provider.defaultBranch();
    if (fallback === null || fallback === ref) return { kind: 'unresolved', why: 'no default branch' };
    if ((await provider.branchHead(fallback)) === null)
      return { kind: 'unresolved', why: 'default branch missing' };
    const missingBase = (await provider.branchHead(base)) === null;
    return this.#apply(
      job,
      ref,
      fallback,
      'repository_default',
      prev?.id ?? null,
      missingBase ? config : null,
    );
  }

  /**
   * p22-git-preflight §2: a repository the project has no git configuration for (chat jobs on another repository, a
   * project without a connection) — what an anonymous reader sees (RemoteProbe, cached): the ref exists → nothing to
   * do; another job's work branch → as above; an empty repository → the worker bootstraps it (p18-project-bootstrap);
   * otherwise the repository's default branch (its `HEAD`). Unreadable / unknown → nothing (dispatch as before).
   */
  async #healAnonymous(job: JobRecord, ref: string): Promise<HealOutcome> {
    const url = job.spec.repository?.url;
    if (this.deps.probe === undefined || url === undefined) return { kind: 'ok' };
    const seen = await this.deps.probe.probe(url);
    if (seen.kind !== 'readable') return { kind: 'ok' };
    if (seen.heads.has(ref) || seen.tags.has(ref)) return { kind: 'ok' };
    const prev = await this.#previousJob(job, ref);
    if (prev !== null) {
      if (
        prev.merged_sha !== null &&
        isTargetBranch(prev.target_branch ?? '') &&
        prev.target_branch !== null
      ) {
        if (seen.heads.has(prev.target_branch))
          return this.#apply(job, ref, prev.target_branch, 'previous_job_target', prev.id);
      }
      if (prev.head_sha !== null && SHA.test(prev.head_sha)) {
        return this.#apply(job, ref, prev.head_sha, 'previous_job_head', prev.id);
      }
      if (ACTIVE.has(prev.state) || prev.state === 'AWAITING_APPROVAL') {
        return {
          kind: 'wait',
          forJob: prev.id,
          reasons: [
            {
              code: 'dependency_pending',
              permanent: false,
              message: `waits for job ${prev.id.slice(0, 8)} to publish its result (the base ${ref} is its work branch)`,
              workers: [],
            },
          ],
        };
      }
    }
    if (seen.empty) return { kind: 'ok' };
    const fallback = seen.defaultBranch;
    if (fallback === null || fallback === ref || !seen.heads.has(fallback))
      return { kind: 'unresolved', why: 'no default branch' };
    return this.#apply(job, ref, fallback, 'repository_default', prev?.id ?? null);
  }

  async #previousJob(
    job: JobRecord,
    ref: string,
  ): Promise<{
    id: string;
    state: string;
    head_sha: string | null;
    merged_sha: string | null;
    target_branch: string | null;
  } | null> {
    const attempt = isAttemptBranch(ref) ? ref.split('/')[1] : null;
    const { rows } = await this.deps.pool.query<{
      id: string;
      state: string;
      head_sha: string | null;
      merged_sha: string | null;
      target_branch: string | null;
    }>(
      `SELECT j.id, j.state, g.head_sha, g.merged_sha, g.target_branch
         FROM jobs j LEFT JOIN job_git g ON g.job_id = j.id
        WHERE j.project = $1 AND j.id <> $2
          AND (j.spec->'repository'->>'workBranch' = $3 OR j.id::text = $4)
        ORDER BY j.created_at DESC LIMIT 1`,
      [job.project, job.id, ref, attempt ?? ''],
    );
    return rows[0] ?? null;
  }

  async #apply(
    job: JobRecord,
    from: string,
    to: string,
    reason: HealReason,
    previousJob: string | null,
    projectConfig: ProjectGitConfig | null = null,
  ): Promise<HealOutcome> {
    const now = this.#clock();
    await withTransaction(this.deps.pool, async (tx) => {
      // Only while the job still waits to be dispatched (a concurrent dispatch already took the old ref).
      const { rows } = await tx.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1 FOR UPDATE', [
        job.id,
      ]);
      if (rows[0]?.state !== 'QUEUED') return;
      await tx.query(
        `INSERT INTO job_base_ref_changes (job_id, seq, base_ref, previous, reason, created_at)
         VALUES ($1, COALESCE((SELECT max(seq) FROM job_base_ref_changes WHERE job_id = $1), 0) + 1, $2, $3, $4, $5)`,
        [job.id, to, from.slice(0, 255), reason, now],
      );
      // The merge target follows the healed base (a SHA base merges into the project's base branch).
      const target = isTargetBranch(to) ? to : null;
      await tx.query(
        `UPDATE job_git SET target_branch = COALESCE($2, (SELECT base_branch FROM project_git_configs
                                                          WHERE project = job_git.project)),
                updated_at = $3
          WHERE job_id = $1 AND base_sha IS NULL`,
        [job.id, target, now],
      );
      if (projectConfig !== null && reason === 'repository_default') {
        await recordProjectBase(tx, this.deps.audit, projectConfig, to, now);
      }
      await recordAutoEvent(tx, {
        jobId: job.id,
        kind: 'base_ref',
        detail: { from: from.slice(0, 255), to, reason, previousJob },
        at: now,
      });
      await this.deps.audit.record(
        {
          actor: SELF_HEAL_ACTOR,
          action: 'job.base_ref.heal',
          target: `job:${job.id}`,
          outcome: 'success',
          metadata: { from: from.slice(0, 255), to, reason, previousJob },
        },
        tx,
      );
    });
    return { kind: 'healed', from, to, reason };
  }
}

/** The project's base branch did not exist: the repository's default branch is recorded on the project. */
async function recordProjectBase(
  tx: Queryable,
  audit: AuditRecorder,
  config: ProjectGitConfig,
  branch: string,
  now: Date,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE project_git_configs SET base_branch = $2, version = version + 1, updated_at = $3
      WHERE project = $1 AND base_branch = $4`,
    [config.project, branch, now, config.baseBranch],
  );
  if ((rowCount ?? 0) === 0) return;
  await audit.record(
    {
      actor: SELF_HEAL_ACTOR,
      action: 'project.git.base_branch_healed',
      target: `project:${config.project}`,
      outcome: 'success',
      metadata: { from: config.baseBranch, to: branch, why: 'the base branch does not exist on the remote' },
    },
    tx,
  );
}

/** p18-project-bootstrap: the provider says the repository has no branch at all (unknown / error: false). */
async function isEmpty(provider: GitProvider): Promise<boolean> {
  if (provider.isEmpty === undefined) return false;
  return provider.isEmpty().catch(() => false);
}
