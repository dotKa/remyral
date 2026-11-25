import { type OriginInput, originOf } from '../console-domain/origin.js';
import { randomUUID } from 'node:crypto';
import { reviewRequestTerm } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { ApprovalService, Evaluation, GateDecisionHook } from '../approvals/service.js';
import type { ApprovalAction } from '../approvals/policy.js';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { resolveGitIdentity } from '../git-identity/store.js';
import { JobStoreError } from '../jobs/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import { loadGitConfig, type ProjectGitConfig } from './config-store.js';
import { DestructiveActionRefusedError, GitFlowError, jobNotFound } from './errors.js';
import { isReportOnly } from '../verify/report-only.js';
import { recordAutoEvent } from '../self-heal/events.js';
import { SELF_HEAL_ACTOR, type AutoRetryService } from '../self-heal/retry.js';
import { flagPaths } from './flags.js';
import { type DeliveredOutputs, deliverRepoOutputs } from './outputs-delivery.js';
import { latestRunSummary, prBody, prTitle } from './pr-text.js';
import {
  ATTEMPT_TRAILER_KEY,
  attemptBranch,
  attemptTrailerValue,
  githubRepo as githubRepoOf,
  isTargetBranch,
  MERGE_TRAILER_KEY,
  parseRepoUrl,
  SHA,
  sameRepository,
  subjectOf,
  trailerValues,
} from './refs.js';
import { gitHubEventTarget } from './github-events.js';
import {
  type JobGitRecord,
  loadJobGit,
  loadMergeRequest,
  loadMergeRequests,
  type MergeRequestMode,
  type MergeRequestRecord,
  type MergeState,
  type AutoRebase,
  type StoredChanges,
  type StoredMergeCheck,
  updateJobGit,
} from './store.js';
import {
  type CiStatus,
  type GitProvider,
  type MergeCheck,
  ProviderError,
  type PullRequestRef,
} from './types.js';

/** Builds the provider for a project configuration (production: GitHub App / plain git; tests: local). */
export type ProviderFactory = (config: ProjectGitConfig) => GitProvider;

export interface GitFlowTiming {
  /** VERIFYING gives up (fail closed) when the remote stays unreachable this long. */
  readonly verifyTimeoutMs: number;
  /** Minimum interval between remote refreshes of a job awaiting approval. */
  readonly refreshIntervalMs: number;
  /** An `executing` claim older than this is considered lost (crash) and retried idempotently. */
  readonly executeClaimMs: number;
  /** Transient provider failures before an approved merge is refused. */
  readonly maxExecuteAttempts: number;
  /** p22-output-delivery: extra test merges at verification while the provider still computes mergeability. */
  readonly mergePolls: number;
  /** p22-output-delivery: pause between those test merges. */
  readonly mergePollMs: number;
  /**
   * p22-github-webhook: on GitHub, deliveries mark what changed; a waiting result no delivery touched for this long
   * since its last check is asked about once (the fallback for a missed or broken webhook).
   */
  readonly webhookFallbackMs: number;
}

export const DEFAULT_GITFLOW_TIMING: GitFlowTiming = {
  verifyTimeoutMs: 10 * 60_000,
  refreshIntervalMs: 30_000,
  executeClaimMs: 5 * 60_000,
  maxExecuteAttempts: 5,
  mergePolls: 2,
  mergePollMs: 2_000,
  webhookFallbackMs: 2 * 3_600_000,
};

export interface GitFlowDeps {
  readonly pool: pg.Pool;
  readonly jobs: JobStore;
  readonly approvals: ApprovalService;
  readonly audit: AuditRecorder;
  readonly providers: ProviderFactory;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** The master's lease TTL: verification keeps the attempt's lease alive while it inspects the remote. */
  readonly leaseTtlMs: number;
  readonly timing?: Partial<GitFlowTiming>;
  /**
   * p11-merge-pipeline (ADR-0041): whether a verified job gets a pull request of its own. False for the members of a
   * master-managed integration (sub-jobs and their coordinator, workflow steps feeding a master integration, the
   * integration's own jobs): their changes reach the target through the ONE integration pull request. Absent = true.
   */
  readonly ownPullRequest?: () => ((job: JobRecord) => Promise<boolean>) | null;
  /** p15-auto-mode: automatic retries of transient verification failures (absent: they fail the job). */
  readonly autoRetry?: () => AutoRetryService | null;
  /** p15-job-titles: console origin for the job link in pull request bodies (absent / null: the job id only). */
  readonly consoleOrigin?: OriginInput;
}

export interface HumanRequester {
  readonly id: string;
}

const VERIFIER = { type: 'system', id: 'verifier' } as const;
const GITFLOW = { type: 'system', id: 'gitflow' } as const;
const MODE_ACTION: Readonly<Record<MergeRequestMode, ApprovalAction>> = {
  merge: 'git.merge',
  leave_open: 'git.merge',
  // Deleting the attempt branch is a destructive ref update: the force-push rule applies (default deny).
  discard: 'git.force_push',
};

type Verdict =
  | {
      readonly ok: false;
      readonly reason: string;
      /** p15-auto-mode: the head diverged from the base at job start (a platform rebase may heal it). */
      readonly diverged?: { readonly head: string; readonly branch: string; readonly base: string };
    }
  | {
      readonly ok: true;
      readonly branch: string;
      readonly head: string;
      readonly changes: StoredChanges;
      readonly noChanges: boolean;
    };

/**
 * p4-git-flow (docs/design/p4-git-flow.md): independent verification of a finished attempt on the remote,
 * conflict detection, pull requests, CI status, and protected merges / destructive actions that execute
 * only after a human approval (ApprovalService gate with the platform floor: admin + step-up).
 *
 * Nothing here trusts the worker's claims (T-WRK-2): the branch head, its `Remyral-Attempt` trailer, its
 * ancestry and the diff are read from the remote. Nothing merges or deletes without an approved request
 * bound to the exact head sha (T-INJ-2/3); a moved head refuses (sha guard).
 */
export class GitFlowService implements GateDecisionHook {
  readonly timing: GitFlowTiming;
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #providers = new Map<string, { version: number; provider: GitProvider }>();

  constructor(private readonly deps: GitFlowDeps) {
    this.timing = { ...DEFAULT_GITFLOW_TIMING, ...deps.timing };
  }

  // ------------------------------------------------------------------------------------- helpers

  #provider(config: ProjectGitConfig): GitProvider {
    const cached = this.#providers.get(config.project);
    if (cached !== undefined && cached.version === config.version) return cached.provider;
    const provider = this.deps.providers(config);
    this.#providers.set(config.project, { version: config.version, provider });
    return provider;
  }

  /** Does this job go through git flow? (decided once, when its job_git row was created at dispatch). */
  async usesGitFlow(db: Queryable, jobId: string): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM job_git WHERE job_id = $1', [jobId]);
    return (rowCount ?? 0) > 0;
  }

  /** The branch an attempt's changes are merged into: the job's base branch, else the project default. */
  static targetBranch(job: Pick<JobRecord, 'spec'>, config: ProjectGitConfig): string {
    // p18-leftovers: an explicit target (a follow-up that starts at a commit keeps its original job's target).
    const explicit = job.spec.repository?.targetBranch;
    if (explicit !== undefined && !SHA.test(explicit) && isTargetBranch(explicit)) return explicit;
    const ref = job.spec.repository?.baseRef ?? config.baseBranch;
    return !SHA.test(ref) && isTargetBranch(ref) ? ref : config.baseBranch;
  }

  /**
   * Runs `fn` unless the same key is already running in this process; then returns null (the caller reads
   * the stored state). `wait`: wait for the running one to finish first and run again (forced refresh).
   */
  async #once<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { readonly wait?: boolean } = {},
  ): Promise<T | null> {
    let running = this.#inflight.get(key);
    if (running !== undefined && opts.wait !== true) return null;
    while (running !== undefined) {
      await running.catch(() => undefined);
      running = this.#inflight.get(key);
    }
    const p = fn();
    this.#inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.#inflight.delete(key);
    }
  }

  // ------------------------------------------------------------------------------------- dispatch

  /**
   * Before a job is dispatched (orchestrator, outside the dispatch lock): when the project has a git
   * provider, record the job's git context and capture the target's head as "base at job start". Best
   * effort: a failed capture is retried by the loop; verification fails closed without it.
   */
  async prepareDispatch(job: JobRecord): Promise<void> {
    // p5-research-workspace: workspace jobs have no repository and never go through git flow.
    if (job.spec.repository === undefined) return;
    // p11-fixes-a: platform report jobs (verifiers, screenshot jobs) return their report as an artifact — never a
    // commit that waits for a merge approval.
    if (await isReportOnly(this.deps.pool, job.id)) return;
    const existing = await loadJobGit(this.deps.pool, job.id);
    if (existing?.baseSha != null) return;
    const config =
      existing === null ? await loadGitConfig(this.deps.pool, job.project) : await this.#configOf(job);
    if (config === null) return;
    const now = this.deps.clock();
    const target = GitFlowService.targetBranch(job, config);
    if (existing === null) {
      await this.deps.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (job_id) DO NOTHING`,
        [job.id, job.project, config.provider, target, now],
      );
    }
    await this.#captureBase(job, config, target);
  }

  /**
   * p6-result-reuse: the commit a new job of `project` on `repository` would start from — what `#captureBase`
   * records as "base at job start" — or null when it cannot be known now: no git provider for the project, another
   * repository than the project's, a base that is not a target branch (capture would record the default branch's
   * head instead), or a provider error. A 40/64-hex base is its own commit.
   */
  async resolveBaseCommit(
    project: string,
    repository: { readonly url: string; readonly baseRef: string },
  ): Promise<string | null> {
    if (SHA.test(repository.baseRef)) return repository.baseRef;
    if (!isTargetBranch(repository.baseRef)) return null;
    const config = await loadGitConfig(this.deps.pool, project);
    if (config === null || !sameRepository(config.repositoryUrl, repository.url)) return null;
    try {
      return await this.#provider(config).branchHead(repository.baseRef);
    } catch (err) {
      this.deps.log.warn({ project, err: errText(err) }, 'git flow: base lookup for result reuse failed');
      return null;
    }
  }

  /** p11-merge-pipeline: false for members of a master-managed integration (one PR for all of them). */
  /** p15-job-titles: the pull request body — description (prompt), the agent's summary, the job link. */
  async #prBody(job: JobRecord, changes: StoredChanges): Promise<string> {
    const summary = await latestRunSummary(this.deps.pool, job.id).catch(() => null);
    return prBody(job, { totals: changes.totals, summary, consoleOrigin: originOf(this.deps.consoleOrigin) });
  }

  async #ownPullRequest(job: JobRecord): Promise<boolean> {
    const decide = this.deps.ownPullRequest?.() ?? null;
    if (decide === null) return true;
    try {
      return await decide(job);
    } catch (err) {
      this.deps.log.warn({ jobId: job.id, err: errText(err) }, 'git flow: PR policy unavailable; no own PR');
      return false;
    }
  }

  /**
   * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §3): the registered repository's state as the provider
   * sees it now — `empty` (no branch at all: the first job creates the base branch's first commit), `ready` (the base
   * branch exists), `base_missing` (a non-empty repository without the base branch: an error a person fixes) or
   * `unknown` (the provider could not be asked; `detail` says why). Null: the project has no git configuration.
   */
  async repositoryState(project: string): Promise<RepositoryState | null> {
    const config = await loadGitConfig(this.deps.pool, project);
    if (config === null) return null;
    const base = {
      provider: config.provider,
      repositoryUrl: config.repositoryUrl,
      baseBranch: config.baseBranch,
    };
    try {
      const provider = this.#provider(config);
      if (provider.isEmpty !== undefined && (await provider.isEmpty())) return { ...base, state: 'empty' };
      const head = await provider.branchHead(config.baseBranch);
      return { ...base, state: head === null ? 'base_missing' : 'ready' };
    } catch (err) {
      return { ...base, state: 'unknown', detail: errText(err).slice(0, 300) };
    }
  }

  /**
   * p22-github-webhook (docs/design/p22-github-webhook.md): a verified GitHub App delivery for repository `repo`
   * (`owner/name`, lower case). The results waiting for approval it concerns — their attempt branch or target branch
   * moved, their pull request changed, their head's CI changed — are marked for a re-check now (`merge_checked_at`
   * cleared: the loop takes them first, within the API budget). Returns how many were marked. Nothing is read from
   * GitHub here and nothing in the payload is trusted beyond comparing it with stored values.
   */
  async onGitHubEvent(repo: string, event: string, payload: unknown): Promise<number> {
    const target = gitHubEventTarget(event, payload);
    if (target === null) return 0;
    const { rows: configs } = await this.deps.pool.query<{ project: string; repository_url: string }>(
      `SELECT project, repository_url FROM project_git_configs WHERE provider = 'github'`,
    );
    const projects = configs
      .filter((c) => {
        const r = githubRepoOf(c.repository_url);
        return r !== null && `${r.owner}/${r.repo}`.toLowerCase() === repo;
      })
      .map((c) => c.project);
    if (projects.length === 0) return 0;
    const { rowCount } = await this.deps.pool.query(
      `UPDATE job_git g SET merge_checked_at = NULL, updated_at = $1
         FROM jobs j
        WHERE j.id = g.job_id AND j.state = 'AWAITING_APPROVAL' AND g.verification = 'passed'
          AND g.merged_sha IS NULL AND g.merge_checked_at IS NOT NULL AND g.project = ANY($2::text[])
          AND (g.branch = ANY($3::text[]) OR g.target_branch = ANY($3::text[])
               OR g.pr_number = ANY($4::int[]) OR g.head_sha = ANY($5::text[]))`,
      [this.deps.clock(), projects, target.branches, target.pullRequests, target.shas],
    );
    return rowCount ?? 0;
  }

  /** p11-merge-pipeline: the provider of a project's git configuration (integration branch / PR operations). */
  async providerFor(project: string): Promise<{ provider: GitProvider; config: ProjectGitConfig } | null> {
    const config = await loadGitConfig(this.deps.pool, project);
    return config === null ? null : { provider: this.#provider(config), config };
  }

  async #configOf(job: Pick<JobRecord, 'project'>): Promise<ProjectGitConfig | null> {
    return loadGitConfig(this.deps.pool, job.project);
  }

  async #captureBase(job: JobRecord, config: ProjectGitConfig, target: string): Promise<void> {
    const ref = job.spec.repository?.baseRef ?? target;
    let sha: string | null;
    try {
      sha = SHA.test(ref) ? ref : await this.#provider(config).branchHead(isTargetBranch(ref) ? ref : target);
    } catch (err) {
      this.deps.log.warn(
        { jobId: job.id, err: errText(err) },
        'git flow: base capture failed; retried later',
      );
      return;
    }
    if (sha === null) {
      this.deps.log.warn({ jobId: job.id }, 'git flow: base branch not found on the remote');
      return;
    }
    await this.deps.pool.query(
      `UPDATE job_git SET base_sha = $2, base_captured_at = $3, updated_at = $3
        WHERE job_id = $1 AND base_sha IS NULL`,
      [job.id, sha, this.deps.clock()],
    );
  }

  /**
   * p18-project-bootstrap: the base of a job whose capture never saw the target branch (an empty repository at
   * dispatch) — the target's head now, recorded as the base at job start, but only when it is a root commit (no parent:
   * the empty first commit the job's worker created). Null otherwise (verification then fails closed as before).
   */
  async #lateRootBase(jobId: string, provider: GitProvider, target: string): Promise<string | null> {
    const head = await provider.branchHead(target);
    if (head === null) return null;
    const commit = await provider.commit(head);
    if (commit.parents.length !== 0) return null;
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE job_git SET base_sha = $2, base_captured_at = $3, updated_at = $3
        WHERE job_id = $1 AND base_sha IS NULL`,
      [jobId, head, now],
    );
    this.deps.log.info(
      { jobId, base: head },
      'git flow: base captured late (first commit of an empty repository)',
    );
    return head;
  }

  // ------------------------------------------------------------------------------------- verification

  /** Post-commit kick from the inbox (JOB_RESULT succeeded → VERIFYING). */
  kickVerification(jobId: string): void {
    void this.verify(jobId).catch((err: unknown) => {
      this.deps.log.error({ jobId, err: errText(err) }, 'git flow verification failed unexpectedly');
    });
  }

  /**
   * Verifies the current attempt of a VERIFYING job on the remote and moves the job on:
   * `verification_passed` (→ AWAITING_APPROVAL: a human decides merge / leave open / reject),
   * `verification_passed_no_approval` when there is nothing to merge, or `verification_failed`.
   * Transient remote errors are retried until `verifyTimeoutMs`, then the job fails (closed).
   */
  async verify(jobId: string): Promise<'passed' | 'failed' | 'pending' | 'skipped'> {
    const r = await this.#once(`verify:${jobId}`, () => this.#verify(jobId));
    return r ?? 'skipped';
  }

  async #verify(jobId: string): Promise<'passed' | 'failed' | 'pending' | 'skipped'> {
    const job = await this.deps.jobs.get(jobId);
    if (job?.state !== 'VERIFYING' || job.currentAttemptId === null) return 'skipped';
    const jg = await loadJobGit(this.deps.pool, jobId);
    if (jg === null) return 'skipped';
    const now = this.deps.clock();
    // The attempt stays leased while the master inspects the remote (the worker already let go).
    await this.deps.pool.query(
      `UPDATE leases SET expires_at = GREATEST(expires_at, $2)
        WHERE job_id = $1 AND released_at IS NULL AND expires_at > $3`,
      [jobId, new Date(now.getTime() + this.deps.leaseTtlMs), now],
    );
    const config = await this.#configOf(job);
    const attemptId = job.currentAttemptId;
    const epoch = job.leaseEpoch;
    let verdict: Verdict;
    try {
      verdict =
        config === null
          ? { ok: false, reason: 'the project has no git configuration any more' }
          : await this.#inspect(job, jg, config, attemptId, epoch);
    } catch (err) {
      if (err instanceof ProviderError && err.transient) {
        if (now.getTime() - job.stateChangedAt.getTime() < this.timing.verifyTimeoutMs) {
          await updateJobGit(
            this.deps.pool,
            jobId,
            { verification_reason: `retrying: ${errText(err)}` },
            now,
          );
          return 'pending';
        }
        verdict = {
          ok: false,
          reason: `the remote could not be inspected (${errText(err)}); failing closed`,
        };
      } else {
        verdict = { ok: false, reason: `verification error: ${errText(err)}` };
      }
    }
    // p15-auto-mode: an attempt that diverged from the base at job start is rebased onto it by the platform and
    // verified again; only a conflicting rebase stays a failure (with the conflicting files for a person / auto-fix).
    if (!verdict.ok && verdict.diverged !== undefined && config !== null) {
      const rebaseFailure: { error: string | null } = { error: null };
      const healed = await this.#autoRebase(job, jg, config, attemptId, verdict.diverged).catch(
        (err: unknown) => {
          this.deps.log.warn({ jobId, err: errText(err) }, 'git flow: automatic rebase failed');
          rebaseFailure.error = errText(err).slice(0, 200);
          return null;
        },
      );
      // p22-git-preflight: a diverged attempt the platform could not rebase says why and what to do.
      const failedVerdict = verdict;
      const unhealed = (why: string): Verdict => ({
        ok: false,
        reason: `${failedVerdict.reason}; ${why} — run the job again on the current base`,
      });
      if (healed === null) {
        if (rebaseFailure.error !== null)
          verdict = unhealed(`the automatic rebase failed (${rebaseFailure.error})`);
      } else if (healed.outcome === 'unsupported') {
        verdict = unhealed(`this git provider (${config.provider}) cannot rebase it automatically`);
      } else if (healed.outcome === 'moved') {
        verdict = unhealed('the attempt branch moved during the automatic rebase');
      }
      if (healed !== null) {
        if (healed.outcome === 'rebased') {
          const again = await loadJobGit(this.deps.pool, jobId);
          verdict =
            again === null
              ? verdict
              : await this.#inspect(job, again, config, attemptId, epoch).catch((err: unknown) => ({
                  ok: false as const,
                  reason: `verification error after the automatic rebase: ${errText(err)}`,
                }));
        } else if (healed.outcome === 'conflicts') {
          verdict = {
            ok: false,
            reason: `${failedVerdict.reason}; rebasing it onto the base at job start conflicts in ${String(
              healed.files?.length ?? 0,
            )} file(s)${(healed.files ?? []).length === 0 ? '' : `: ${(healed.files ?? []).slice(0, 10).join(', ')}`} — a person (or the auto-fix job) resolves them`,
          };
        }
      }
    }
    if (!verdict.ok) {
      await this.#finishVerification(job, attemptId, epoch, verdict.reason, null);
      return 'failed';
    }
    // p22-output-delivery: a job that delivers its files as outputs gets no pull request, merge check or decision —
    // the verified files are copied into the job's outputs and the job succeeds (nothing is merged).
    if (job.spec.delivery === 'outputs' && !verdict.noChanges && config !== null) {
      let delivered: DeliveredOutputs;
      try {
        delivered = await deliverRepoOutputs(
          { pool: this.deps.pool, audit: this.deps.audit, clock: this.deps.clock },
          {
            jobId,
            attemptId,
            project: job.project,
            head: verdict.head,
            files: verdict.changes.files,
            truncated: verdict.changes.truncated,
            provider: this.#provider(config),
          },
        );
      } catch (err) {
        if (
          err instanceof ProviderError &&
          err.transient &&
          now.getTime() - job.stateChangedAt.getTime() < this.timing.verifyTimeoutMs
        ) {
          await updateJobGit(
            this.deps.pool,
            jobId,
            { verification_reason: `retrying the output delivery: ${errText(err)}` },
            now,
          );
          return 'pending';
        }
        await this.#finishVerification(
          job,
          attemptId,
          epoch,
          `the files could not be delivered as outputs (${errText(err)}); they stay on ${verdict.branch}`,
          null,
        );
        return 'failed';
      }
      await this.#finishVerification(job, attemptId, epoch, null, {
        ...verdict,
        pr: null,
        check: null,
        ci: null,
        own: false,
        delivered,
      });
      return 'passed';
    }
    // Pull request, merge check and CI are information for the human; failures here do not fail the job.
    // p22-output-delivery §1: each is asked on its own — a pull request that cannot be opened (permissions) or a CI
    // read that fails no longer drops the merge check, which then answers from history (`mergeabilityFromHistory`).
    let pr: PullRequestRef | null =
      jg.prNumber === null ? null : { number: jg.prNumber, url: jg.prUrl ?? '' };
    let check: MergeCheck | null = null;
    let ci: CiStatus | null = null;
    // p11-merge-pipeline: members of a master-managed integration get neither a PR nor a decision of their own.
    const own = !verdict.noChanges && config !== null && (await this.#ownPullRequest(job));
    if (!verdict.noChanges && config !== null) {
      const provider = this.#provider(config);
      const warn = (what: string) => (err: unknown) => {
        this.deps.log.warn({ jobId, err: errText(err) }, `git flow: ${what} incomplete; refreshed later`);
        return null;
      };
      if (own) {
        pr ??= await provider
          .ensurePullRequest({
            headBranch: verdict.branch,
            targetBranch: jg.targetBranch,
            title: prTitle(job),
            body: await this.#prBody(job, verdict.changes),
          })
          .catch(warn('pull request'));
      }
      check = await this.#testMergeSettled(provider, {
        targetBranch: jg.targetBranch,
        headSha: verdict.head,
        headBranch: verdict.branch,
        baseAtStart: jg.baseSha ?? verdict.head,
        pullRequest: pr,
      }).catch(warn('merge check'));
      ci = await provider.checks(verdict.head).catch(warn('CI status'));
    }
    await this.#finishVerification(job, attemptId, epoch, null, { ...verdict, pr, check, ci, own });
    return 'passed';
  }

  /**
   * p22-output-delivery §1: the provider's test merge, asked again a few times (`mergePollMs` apart) while it answers
   * `unknown` because it is still computing (GitHub computes `mergeable` in the background right after a pull request
   * was opened or its base moved). Still `unknown` afterwards: the refresh loop keeps asking every refresh interval.
   */
  async #testMergeSettled(
    provider: GitProvider,
    input: Parameters<GitProvider['testMerge']>[0],
  ): Promise<MergeCheck> {
    let check = await provider.testMerge(input);
    for (
      let i = 0;
      i < this.timing.mergePolls && check.state === 'unknown' && input.pullRequest !== null;
      i++
    ) {
      await new Promise((r) => setTimeout(r, this.timing.mergePollMs));
      check = await provider.testMerge(input);
    }
    return check;
  }

  /** The checks that decide verification (T-WRK-2). Returns a refusal reason or the verified facts. */
  async #inspect(
    job: JobRecord,
    jg: JobGitRecord,
    config: ProjectGitConfig,
    attemptId: string,
    epoch: number,
  ): Promise<Verdict> {
    if (job.spec.repository === undefined || !sameRepository(job.spec.repository.url, config.repositoryUrl)) {
      return { ok: false, reason: 'the job repository does not match the project git configuration' };
    }
    const provider = this.#provider(config);
    // p18-project-bootstrap: the job of an empty repository created its base branch's first commit itself (worker
    // `workspace-empty-repo-v1`) after dispatch, so the capture loop may not have seen the branch yet. Captured late only
    // when the target's head is a parentless commit (that first commit) — any other late base stays refused.
    const baseSha = jg.baseSha ?? (await this.#lateRootBase(job.id, provider, jg.targetBranch));
    if (baseSha === null) {
      return { ok: false, reason: 'the base at job start was never captured; refusing to verify ancestry' };
    }
    const branch = attemptBranch(job.id, attemptId);
    const head = await provider.branchHead(branch);
    if (head === null) return { ok: false, reason: `attempt branch ${branch} is absent on the remote` };

    const commit = await provider.commit(head);
    const expected = attemptTrailerValue(attemptId, epoch);
    const trailers = trailerValues(commit.message, ATTEMPT_TRAILER_KEY);
    if (trailers.length !== 1 || trailers[0] !== expected) {
      return {
        ok: false,
        reason:
          `head ${head.slice(0, 12)} carries ${ATTEMPT_TRAILER_KEY} ${trailers.length === 0 ? '(none)' : trailers.join(', ')}` +
          ` but the current lease is ${expected} (stale epoch or foreign commit)`,
      };
    }
    // The worker's claim is compared, never trusted.
    const claimed = await this.#claimedHead(attemptId, branch);
    // p15-auto-mode: the platform's own rebase moved the branch from the claimed head to `to`.
    const rebased =
      jg.autoRebase?.attemptId === attemptId &&
      jg.autoRebase.outcome === 'rebased' &&
      jg.autoRebase.from === claimed &&
      jg.autoRebase.to === head;
    if (claimed !== null && claimed !== head && !rebased) {
      return {
        ok: false,
        reason: `the worker reported ${claimed.slice(0, 12)} but ${branch} is at ${head.slice(0, 12)} on the remote`,
      };
    }
    const cmp = await provider.compare(baseSha, head);
    if (cmp.status !== 'ahead') {
      // p22-git-preflight: `behind` / `identical` — the attempt adds nothing on top of the base at job start (the base
      // already contains its head); a rebase would produce no change, so it is not attempted — the message says so.
      const nothingNew =
        cmp.status === 'diverged'
          ? ''
          : ' — the base already contains this attempt’s head, so there is nothing new to merge; run the job again on the current base';
      return {
        ok: false,
        reason: `head ${head.slice(0, 12)} is not a descendant of the base at job start ${baseSha.slice(0, 12)} (${cmp.status})${nothingNew}`,
        ...(cmp.status === 'diverged' ? { diverged: { head, branch, base: baseSha } } : {}),
      };
    }
    const files = cmp.files.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.previousPath === undefined ? {} : { previousPath: f.previousPath }),
    }));
    const changes: StoredChanges = {
      commits: cmp.commits.map((c) => ({
        sha: c.sha,
        subject: subjectOf(c.message),
        author: c.author.name,
        date: c.author.date,
      })),
      files,
      totals: {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      },
      truncated: cmp.truncated,
    };
    return { ok: true, branch, head, changes, noChanges: files.length === 0 };
  }

  /**
   * p15-auto-mode: rebases a diverged attempt branch onto the base at job start (once per attempt, the provider's
   * `rebaseOnto`: one commit with the attempt's message and trailer, the attempt branch moved while still at the
   * verified head). Recorded in `job_git.auto_rebase`, the job timeline and the audit log (`git.auto_rebase`).
   * Null: no provider support or already tried for this attempt.
   */
  async #autoRebase(
    job: JobRecord,
    jg: JobGitRecord,
    config: ProjectGitConfig,
    attemptId: string,
    d: { readonly head: string; readonly branch: string; readonly base: string },
  ): Promise<AutoRebase | null> {
    if (jg.autoRebase?.attemptId === attemptId) return null;
    const provider = this.#provider(config);
    const now = this.deps.clock();
    let rebase: AutoRebase;
    if (provider.rebaseOnto === undefined) {
      rebase = {
        attemptId,
        from: d.head,
        to: null,
        onto: d.base,
        outcome: 'unsupported',
        at: now.toISOString(),
      };
    } else {
      const out = await provider.rebaseOnto({ branch: d.branch, headSha: d.head, onto: d.base });
      rebase =
        out.state === 'rebased'
          ? { attemptId, from: d.head, to: out.sha, onto: d.base, outcome: 'rebased', at: now.toISOString() }
          : out.state === 'conflicts'
            ? {
                attemptId,
                from: d.head,
                to: null,
                onto: d.base,
                outcome: 'conflicts',
                files: out.files.slice(0, 50),
                at: now.toISOString(),
              }
            : { attemptId, from: d.head, to: null, onto: d.base, outcome: 'moved', at: now.toISOString() };
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await updateJobGit(tx, job.id, { auto_rebase: rebase }, now);
      await recordAutoEvent(tx, {
        jobId: job.id,
        kind: 'auto_rebase',
        detail: {
          outcome: rebase.outcome,
          from: rebase.from,
          to: rebase.to,
          onto: rebase.onto,
          files: rebase.files?.length ?? 0,
        },
        at: now,
      });
      await this.deps.audit.record(
        {
          actor: SELF_HEAL_ACTOR,
          action: 'git.auto_rebase',
          target: `job:${job.id}`,
          outcome: rebase.outcome === 'rebased' ? 'success' : 'failure',
          metadata: {
            attemptId,
            branch: d.branch,
            from: rebase.from,
            to: rebase.to,
            onto: rebase.onto,
            outcome: rebase.outcome,
            ...(rebase.files === undefined ? {} : { files: rebase.files.length }),
          },
        },
        tx,
      );
    });
    return rebase;
  }

  async #claimedHead(attemptId: string, branch: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{
      result: { commits?: { sha?: unknown; branch?: unknown }[] } | null;
    }>('SELECT result FROM job_runs WHERE attempt_id = $1', [attemptId]);
    const commits = rows[0]?.result?.commits ?? [];
    const mine = commits.filter((c) => c.branch === branch && typeof c.sha === 'string');
    const last = mine.at(-1)?.sha;
    return typeof last === 'string' ? last : null;
  }

  async #finishVerification(
    job: JobRecord,
    attemptId: string,
    epoch: number,
    failure: string | null,
    ok:
      | (Extract<Verdict, { ok: true }> & {
          pr: PullRequestRef | null;
          check: MergeCheck | null;
          ci: CiStatus | null;
          /** p15-merge-approvals: open the merge decision with the transition (false: integration member). */
          own: boolean;
          /** p22-output-delivery: the files were delivered as outputs — the job succeeds, nothing to merge. */
          delivered?: DeliveredOutputs;
        })
      | null,
  ): Promise<void> {
    const now = this.deps.clock();
    let decision: DecisionOutcome | null = null;
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        if (failure !== null || ok === null) {
          // p15-auto-mode: a transient verification failure (the attempt branch never reached the remote, the remote
          // could not be inspected) runs the job again instead of failing it.
          const retry = this.deps.autoRetry?.() ?? null;
          const decision =
            retry === null
              ? null
              : await retry.decideWithin(tx, {
                  jobId: job.id,
                  attemptId,
                  workerId: null,
                  phase: 'verify',
                  code: null,
                  message: failure ?? 'verification failed',
                });
          if (decision !== null) {
            await updateJobGit(
              tx,
              job.id,
              {
                attempt_id: attemptId,
                epoch,
                branch: attemptBranch(job.id, attemptId),
                verification: 'failed',
                verification_reason: `${decision.reason}: ${failure ?? 'verification failed'}`.slice(0, 1000),
                verified_at: now,
              },
              now,
            );
            await this.deps.jobs.transitionWithin(tx, job.id, 'attempt_retry', {
              actor: SELF_HEAL_ACTOR,
              retrySafe: true,
              reason: `${decision.reason}: git flow: ${failure ?? 'verification failed'}`.slice(0, 1000),
              expectedVersion: job.version,
            });
            return;
          }
          await updateJobGit(
            tx,
            job.id,
            {
              attempt_id: attemptId,
              epoch,
              branch: attemptBranch(job.id, attemptId),
              verification: 'failed',
              verification_reason: (failure ?? 'verification failed').slice(0, 1000),
              verified_at: now,
            },
            now,
          );
          await this.deps.jobs.transitionWithin(tx, job.id, 'verification_failed', {
            actor: VERIFIER,
            reason: `git flow: ${failure ?? 'verification failed'}`.slice(0, 1000),
            expectedVersion: job.version,
          });
          await this.deps.audit.record(
            {
              actor: VERIFIER,
              action: 'git.verify',
              target: `job:${job.id}`,
              outcome: 'denied',
              metadata: { attemptId, epoch, reason: failure },
            },
            tx,
          );
          return;
        }
        const merge = ok.check === null ? null : mergeFields(ok.check);
        await updateJobGit(
          tx,
          job.id,
          {
            attempt_id: attemptId,
            epoch,
            branch: ok.branch,
            head_sha: ok.head,
            verification: 'passed',
            verification_reason: null,
            verified_at: now,
            changes: ok.changes,
            flags: flagPaths(ok.changes.files),
            ...(merge === null ? {} : { ...merge, merge_checked_at: now }),
            pr_number: ok.pr?.number ?? null,
            pr_url: ok.pr?.url ?? null,
            ...(ok.ci === null ? {} : { ci_state: ok.ci.state, ci: ok.ci, ci_checked_at: now }),
          },
          now,
        );
        const t = ok.changes.totals;
        const summary = `verified ${ok.branch}@${ok.head.slice(0, 12)} (${String(t.files)} files, +${String(t.additions)} -${String(t.deletions)})`;
        if (ok.noChanges) {
          await this.deps.jobs.transitionWithin(tx, job.id, 'verification_passed_no_approval', {
            actor: VERIFIER,
            reason: `git flow: ${summary}; no file changes, nothing to merge`,
            expectedVersion: job.version,
          });
        } else if (ok.delivered !== undefined) {
          // p22-output-delivery: the job's files are its outputs; nothing is merged, so nothing needs an approval.
          await this.deps.jobs.transitionWithin(tx, job.id, 'verification_passed_no_approval', {
            actor: VERIFIER,
            reason: `git flow: ${summary}; ${deliveryNote(ok.delivered, ok.branch)}`.slice(0, 1000),
            expectedVersion: job.version,
          });
          await this.deps.audit.record(
            {
              actor: VERIFIER,
              action: 'job.outputs.deliver',
              target: `job:${job.id}`,
              outcome: 'success',
              metadata: {
                attemptId,
                branch: ok.branch,
                head: ok.head,
                stored: ok.delivered.stored,
                bytes: ok.delivered.bytes,
                redacted: ok.delivered.redacted,
                skipped: ok.delivered.skipped.length,
                skippedFiles: ok.delivered.skipped.slice(0, 50),
              },
            },
            tx,
          );
        } else {
          const state = merge?.merge_state ?? 'unknown';
          const note =
            state === 'conflicts'
              ? `needs_rebase: conflicts in ${String(merge?.merge_check.files.length ?? 0)} file(s)`
              : state === 'base_moved'
                ? 'needs_rebase: the target branch was rewritten'
                : state === 'unknown'
                  ? `merge check: unknown for now (re-checked every ${String(Math.round(this.timing.refreshIntervalMs / 1000))} s)`
                  : `merge check: ${state}`;
          await this.deps.jobs.transitionWithin(tx, job.id, 'verification_passed', {
            actor: VERIFIER,
            reason: `git flow: ${summary}; ${note}`.slice(0, 1000),
            expectedVersion: job.version,
          });
          // p15-merge-approvals: the decision opens with the transition (it used to wait for the job page). A
          // failure here never blocks the verified result: it is rolled back alone and the loop opens it later.
          if (ok.own) decision = await this.#openDecisionGuarded(tx, job.id);
          else await updateJobGit(tx, job.id, { decision_closed_seen: 0 }, now);
        }
        await this.deps.audit.record(
          {
            actor: VERIFIER,
            action: 'git.verify',
            target: `job:${job.id}`,
            outcome: 'success',
            metadata: {
              attemptId,
              epoch,
              branch: ok.branch,
              head: ok.head,
              files: t.files,
              mergeState: merge?.merge_state ?? null,
              pullRequest: ok.pr?.number ?? null,
              ...(ok.delivered === undefined ? {} : { delivery: 'outputs' }),
            },
          },
          tx,
        );
      });
    } catch (err) {
      // Another actor moved the job (cancel, lease expiry): nothing to do; the loop re-reads state.
      if (err instanceof JobStoreError) {
        this.deps.log.info({ jobId: job.id, code: err.code }, 'git flow: job moved during verification');
        return;
      }
      throw err;
    }
    this.#afterDecision(decision);
  }

  // ------------------------------------------------------------------------------------- decisions

  /**
   * p15-merge-approvals (docs/design/p15-merge-approvals.md): opens the merge decision of a verified job in
   * AWAITING_APPROVAL inside `tx` — a `git.merge` gate approval bound to the verified head, evaluated by the approval
   * policy (platform floor → project rules → job mode → the owner's security policy):
   * - `require_approval` → a pending request (Senden bekleyenler, notification, decidable from the job page, the
   *   needs-you card and chat), recorded as a merge request opened by the master (`requested_by` NULL);
   * - `allow` (security-policy autonomy for an `allow-all` job) → a merge request approved by the policy, executed
   *   after commit with the usual sha guard, merge check and CI rules;
   * - `deny` → nothing opens (the job waits for a person to cancel or the policy to change).
   * Mode: `merge` unless the result cannot merge as is (conflicts, target rewritten) or a merge of this head was
   * already refused — then `leave_open` (accept and keep the pull request open; a denial rejects the result), which
   * always asks a person. Idempotent: nothing opens while a merge request or a gate approval of the job is open.
   */
  async #openDecisionIn(tx: pg.PoolClient, jobId: string): Promise<DecisionOutcome> {
    const { rows } = await tx.query<{ state: string; project: string; spec: JobRecord['spec'] }>(
      'SELECT state, project, spec FROM jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    const job = rows[0];
    if (job?.state !== 'AWAITING_APPROVAL') return { kind: 'skipped' };
    const jg = await loadJobGit(tx, jobId, true);
    const config = await loadGitConfig(tx, job.project);
    const requests = await loadMergeRequests(tx, jobId);
    const closed = requests.filter((r) => !OPEN_STATUSES.has(r.status)).length;
    const now = this.deps.clock();
    const seen = async () => updateJobGit(tx, jobId, { decision_closed_seen: closed }, now);
    if (
      config === null ||
      jg?.verification !== 'passed' ||
      jg.headSha === null ||
      jg.branch === null ||
      jg.mergedSha !== null ||
      (jg.changes?.totals.files ?? 0) === 0
    ) {
      await seen();
      return { kind: 'skipped' };
    }
    if (requests.some((r) => OPEN_STATUSES.has(r.status))) return { kind: 'exists' };
    const gate = await tx.query(
      `SELECT 1 FROM approval_requests WHERE job_id = $1 AND status = 'pending' AND kind = 'gate' LIMIT 1`,
      [jobId],
    );
    if ((gate.rowCount ?? 0) > 0) return { kind: 'exists' };

    const refusedBefore = requests.some(
      (r) => r.mode === 'merge' && r.status === 'refused' && r.headSha === jg.headSha,
    );
    const unmergeable = jg.mergeState === 'conflicts' || jg.mergeState === 'base_moved';
    const mode: MergeRequestMode = unmergeable || refusedBefore ? 'leave_open' : 'merge';
    // Only a plain repository job merges by policy: never a result that already failed to merge, nor a workflow step
    // or a sub-job whose run decides when its results reach the target.
    const autoEligible = mode === 'merge' && !(await partOfRun(tx, jobId));
    const id = randomUUID();
    const headSha = jg.headSha;
    const baseSha = jg.mergeCheck?.baseSha ?? jg.baseSha ?? headSha;
    const insert = async (
      db: Queryable,
      approvalRequestId: string | null,
      status: 'pending' | 'approved',
    ): Promise<void> => {
      await db.query(
        `INSERT INTO git_merge_requests (id, job_id, approval_request_id, mode, head_sha, base_sha, target_branch,
           method, requested_by, reason, status, approved_via, approved_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, $13, $13)`,
        [
          id,
          jobId,
          approvalRequestId,
          mode,
          headSha,
          baseSha,
          jg.targetBranch,
          config.mergeMethod,
          'opened by the platform when the result was verified',
          status,
          approvalRequestId === null ? 'security_policy' : 'human',
          status === 'approved' ? now : null,
          now,
        ],
      );
      await this.deps.audit.record(
        {
          actor: GITFLOW,
          action: 'git.merge.request',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: {
            mergeRequestId: id,
            approvalRequestId,
            mode,
            head: headSha,
            openedBy: 'gitflow',
            ...(approvalRequestId === null ? { approvedVia: 'security_policy' } : {}),
          },
        },
        db,
      );
    };
    const evaluation = await this.deps.approvals.evaluateWithin(
      tx,
      {
        action: 'git.merge',
        jobId,
        approvalKey: `${mode.replace('_', '-')}.${String(requests.length + 1)}`,
        summary: decisionSummary(mode, jg, config, refusedBefore),
        requestedBy: GITFLOW,
      },
      {
        ...(autoEligible ? {} : { ignoreAutonomy: true }),
        onCreated: (t, approvalRequestId) => insert(t, approvalRequestId, 'pending'),
      },
    );
    await seen();
    if (evaluation.outcome === 'pending') return { kind: 'opened', approvalRequestId: evaluation.requestId };
    if (evaluation.outcome === 'deny') {
      this.deps.log.warn(
        { jobId, mode, reason: evaluation.reason },
        'git flow: the approval policy denies the merge decision; the job waits for a person',
      );
      return { kind: 'denied' };
    }
    // `allow`: only the security-policy autonomy layer resolves git.merge to allow (the platform floor never does).
    if (!autoEligible || !evaluation.rule.sources.includes('security_policy')) {
      throw new DestructiveActionRefusedError(
        `git.merge resolved to allow without the security policy; refusing.`,
      );
    }
    await insert(tx, null, 'approved');
    return { kind: 'auto', mergeRequestId: id };
  }

  /** {@link #openDecisionIn} under a savepoint: a failure rolls back only the decision (the loop retries it). */
  async #openDecisionGuarded(tx: pg.PoolClient, jobId: string): Promise<DecisionOutcome | null> {
    await tx.query('SAVEPOINT gitflow_decision');
    try {
      const out = await this.#openDecisionIn(tx, jobId);
      await tx.query('RELEASE SAVEPOINT gitflow_decision');
      return out;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT gitflow_decision');
      this.deps.log.error(
        { jobId, err: errText(err) },
        'git flow: the merge decision could not be opened with the transition; the loop retries',
      );
      return null;
    }
  }

  /** After commit: a merge the security policy approved runs at once (the loop picks it up otherwise). */
  #afterDecision(decision: DecisionOutcome | null): void {
    if (decision?.kind !== 'auto') return;
    const id = decision.mergeRequestId;
    setImmediate(() => {
      void this.execute(id).catch((err: unknown) => {
        this.deps.log.error({ mergeRequestId: id, err: errText(err) }, 'git flow: execution failed');
      });
    });
  }

  /**
   * Loop step (also the backfill of jobs that entered AWAITING_APPROVAL before p15-merge-approvals): opens the
   * decision of every verified job awaiting one with no open merge request, once per closed request (a refused merge
   * becomes a "leave open" decision, a withdrawn request is replaced) — never twice for the same state.
   */
  async openDecisions(): Promise<number> {
    const { rows } = await this.deps.pool.query<{ job_id: string }>(
      `SELECT g.job_id FROM job_git g JOIN jobs j ON j.id = g.job_id
        WHERE j.state = 'AWAITING_APPROVAL' AND g.verification = 'passed' AND g.merged_sha IS NULL
          AND NOT EXISTS (SELECT 1 FROM git_merge_requests m
                           WHERE m.job_id = g.job_id AND m.status IN ('pending', 'approved', 'executing'))
          AND (g.decision_closed_seen IS NULL OR g.decision_closed_seen <
               (SELECT count(*) FROM git_merge_requests m
                 WHERE m.job_id = g.job_id AND m.status NOT IN ('pending', 'approved', 'executing')))
        ORDER BY g.verified_at NULLS FIRST LIMIT 20`,
    );
    let opened = 0;
    for (const { job_id: jobId } of rows) {
      const job = await this.deps.jobs.get(jobId);
      if (job === null) continue;
      const own = await this.#ownPullRequest(job);
      const decision = await withTransaction(this.deps.pool, async (tx) => {
        if (own) return this.#openDecisionIn(tx, jobId);
        // An integration member: the integration's merge decides it. Remember that it was looked at.
        await tx.query(
          `UPDATE job_git SET decision_closed_seen = (SELECT count(*) FROM git_merge_requests m
              WHERE m.job_id = $1 AND m.status NOT IN ('pending', 'approved', 'executing')), updated_at = $2
            WHERE job_id = $1`,
          [jobId, this.deps.clock()],
        );
        return { kind: 'skipped' } as const;
      });
      if (decision.kind === 'opened' || decision.kind === 'auto') opened += 1;
      this.#afterDecision(decision);
    }
    return opened;
  }

  /**
   * p22-conflict-resolve (docs/design/p22-conflict-resolve.md): job `jobId`'s conflicting result was carried onto the
   * target by `byJobId`, which merged. Its open merge decision is withdrawn, a job still AWAITING_APPROVAL is cancelled
   * (`cancel_requested`, system, the reason names the resolving job) and its pull request is closed with a comment
   * pointing at the resolving job. `busy`: a merge of it is approved or executing (looked at again later). The pull
   * request close is best effort (logged): the job state is the record.
   */
  async supersede(
    jobId: string,
    byJobId: string,
  ): Promise<{ readonly outcome: 'superseded' | 'busy' | 'gone'; readonly prClosed: boolean }> {
    const reason = `superseded: conflict-resolution job ${byJobId} carried this result onto the target and merged`;
    const res = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1 FOR UPDATE', [
        jobId,
      ]);
      const state = rows[0]?.state;
      if (state === undefined) return 'gone' as const;
      const requests = await loadMergeRequests(tx, jobId);
      if (requests.some((r) => r.status === 'approved' || r.status === 'executing')) return 'busy' as const;
      for (const mr of requests.filter((r) => r.status === 'pending')) await this.#withdraw(tx, mr, reason);
      if (state === 'AWAITING_APPROVAL') {
        await this.deps.jobs.transitionWithin(tx, jobId, 'cancel_requested', {
          actor: SELF_HEAL_ACTOR,
          reason,
        });
      }
      await this.deps.audit.record(
        {
          actor: SELF_HEAL_ACTOR,
          action: 'git.superseded',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: { byJobId, state },
        },
        tx,
      );
      return 'superseded' as const;
    });
    if (res !== 'superseded') return { outcome: res, prClosed: false };
    const jg = await loadJobGit(this.deps.pool, jobId);
    if (jg?.prNumber == null || jg.prUrl === null || jg.mergedSha !== null) {
      return { outcome: res, prClosed: false };
    }
    const job = await this.deps.jobs.get(jobId);
    const config = job === null ? null : await this.#configOf(job);
    const provider = config === null ? null : this.#provider(config);
    if (provider?.closePullRequest === undefined) return { outcome: res, prClosed: false };
    const link = originOf(this.deps.consoleOrigin);
    const comment =
      `Remyral: this result conflicted with ${jg.targetBranch}. Conflict-resolution job ${byJobId} carried it onto ` +
      `the current ${jg.targetBranch} and was merged, so this pull request is closed without merging.` +
      (link === null ? '' : `\n\n${link}/jobs/${byJobId}`);
    try {
      await provider.closePullRequest({ number: jg.prNumber, url: jg.prUrl }, comment);
      return { outcome: res, prClosed: true };
    } catch (err) {
      this.deps.log.warn(
        { jobId, byJobId, err: errText(err) },
        'git flow: the superseded pull request was not closed',
      );
      return { outcome: res, prClosed: false };
    }
  }

  /** Withdraws the master's own pending request (approval cancelled, merge request cancelled) inside `tx`. */
  async #withdraw(tx: pg.PoolClient, mr: MergeRequestRecord, why: string): Promise<void> {
    if (mr.approvalRequestId !== null) await this.deps.approvals.withdrawGate(tx, mr.approvalRequestId, why);
    await tx.query(
      `UPDATE git_merge_requests SET status = 'cancelled', result_reason = $2, updated_at = $3
        WHERE id = $1 AND status = 'pending'`,
      [mr.id, why.slice(0, 1000), this.deps.clock()],
    );
  }

  // ------------------------------------------------------------------------------------- refresh

  /**
   * Re-reads the remote for a verified job awaiting a decision: attempt head (moved?), test merge against
   * the current target, pull request and CI checks. `force` ignores the refresh interval.
   */
  async refresh(jobId: string, opts: { readonly force?: boolean } = {}): Promise<JobGitRecord | null> {
    const force = opts.force === true;
    const r = await this.#once(`refresh:${jobId}`, () => this.#refresh(jobId, force), { wait: force });
    return r ?? (await loadJobGit(this.deps.pool, jobId));
  }

  async #refresh(jobId: string, force: boolean): Promise<JobGitRecord | null> {
    const jg = await loadJobGit(this.deps.pool, jobId);
    if (jg?.verification !== 'passed' || jg.headSha === null || jg.branch === null || jg.mergedSha !== null) {
      return jg;
    }
    const now = this.deps.clock();
    if (
      !force &&
      jg.mergeCheckedAt !== null &&
      now.getTime() - jg.mergeCheckedAt.getTime() < this.timing.refreshIntervalMs
    ) {
      return jg;
    }
    const job = await this.deps.jobs.get(jobId);
    const config = job === null ? null : await this.#configOf(job);
    if (job === null || config === null) return jg;
    const provider = this.#provider(config);
    // p22-github-rate: a background re-check waits while the API budget is exhausted or below its reserve (base
    // captures, verifications and merges spend that reserve); a forced refresh (a person, a merge) still goes.
    if (!force && provider.backgroundBudgetLow?.() === true) return jg;
    const fields: Record<string, unknown> = { merge_checked_at: now };
    try {
      const head = await provider.branchHead(jg.branch);
      if (head !== jg.headSha) {
        fields.merge_state = 'unknown';
        fields.merge_check = {
          baseSha: jg.mergeCheck?.baseSha ?? jg.baseSha ?? jg.headSha,
          headSha: jg.headSha,
          files: [],
          headCommits: [],
          baseCommits: [],
          precision: null,
          reason: `${jg.branch} moved after verification (now ${head ?? 'deleted'}); it cannot be merged`,
        } satisfies StoredMergeCheck;
      } else {
        let pr: PullRequestRef | null =
          jg.prNumber === null ? null : { number: jg.prNumber, url: jg.prUrl ?? '' };
        // p22-output-delivery §1: a pull request that still cannot be opened (permissions, a provider error) does not
        // keep the merge check unknown: the test merge answers from history without one.
        if (pr === null && jg.changes !== null && (await this.#ownPullRequest(job))) {
          try {
            pr = await provider.ensurePullRequest({
              headBranch: jg.branch,
              targetBranch: jg.targetBranch,
              title: prTitle(job),
              body: await this.#prBody(job, jg.changes),
            });
            fields.pr_number = pr?.number ?? null;
            fields.pr_url = pr?.url ?? null;
          } catch (err) {
            this.deps.log.warn({ jobId, err: errText(err) }, 'git flow: pull request still not opened');
          }
        }
        Object.assign(
          fields,
          mergeFields(
            await provider.testMerge({
              targetBranch: jg.targetBranch,
              headSha: jg.headSha,
              headBranch: jg.branch,
              baseAtStart: jg.baseSha ?? jg.headSha,
              pullRequest: pr,
            }),
          ),
        );
        if (jg.ciState !== 'success' && jg.ciState !== 'failure' && jg.ciState !== 'timed_out') {
          // A CI read that fails keeps the merge check above (it used to discard the whole refresh).
          const ci = await provider.checks(jg.headSha).catch((err: unknown) => {
            this.deps.log.warn({ jobId, err: errText(err) }, 'git flow: CI status not read; retried later');
            return null;
          });
          if (ci !== null) {
            const deadline = (jg.verifiedAt ?? now).getTime() + config.ciTimeoutSec * 1000;
            const timedOut =
              (ci.state === 'pending' || (ci.state === 'none' && config.requireCi)) &&
              now.getTime() > deadline;
            Object.assign(fields, { ci_state: timedOut ? 'timed_out' : ci.state, ci, ci_checked_at: now });
          }
        }
      }
    } catch (err) {
      this.deps.log.warn({ jobId, err: errText(err) }, 'git flow: refresh failed; retried later');
      await updateJobGit(this.deps.pool, jobId, { merge_checked_at: now }, now);
      return loadJobGit(this.deps.pool, jobId);
    }
    await updateJobGit(this.deps.pool, jobId, fields, now);
    // p15-merge-approvals: the master's own pending merge request no longer fits a result that cannot merge as is;
    // it is withdrawn and the loop opens the "accept without merging" decision instead.
    if (fields.merge_state === 'conflicts' || fields.merge_state === 'base_moved') {
      const mine = (await loadMergeRequests(this.deps.pool, jobId)).find(
        (r) => r.status === 'pending' && r.mode === 'merge' && r.requestedBy === null,
      );
      if (mine !== undefined) {
        await withTransaction(this.deps.pool, (tx) =>
          this.#withdraw(
            tx,
            mine,
            fields.merge_state === 'conflicts'
              ? `withdrawn: the changes now conflict with ${jg.targetBranch}`
              : `withdrawn: ${jg.targetBranch} was rewritten`,
          ),
        );
      }
    }
    return loadJobGit(this.deps.pool, jobId);
  }

  // ------------------------------------------------------------------------------------- requests

  /**
   * A human asks to merge (or to accept and leave the PR open, or to discard the branch). Creates the gate
   * approval (`git.merge`; discard: `git.force_push`) bound to the current head sha. Nothing is merged or
   * deleted here: execution happens after the approval closes as approved (admin + step-up by the
   * platform floor). Refused when the result cannot be merged as is (conflicts, base rewritten, head moved,
   * CI required but not green).
   */
  async request(
    jobId: string,
    mode: MergeRequestMode,
    user: HumanRequester,
    opts: { readonly reason?: string; readonly ip?: string | null; readonly userAgent?: string | null } = {},
  ): Promise<{ request: MergeRequestRecord; created: boolean }> {
    const job = await this.deps.jobs.get(jobId);
    if (job === null) throw jobNotFound();
    if (job.state !== 'AWAITING_APPROVAL') {
      throw new GitFlowError(
        409,
        'not_awaiting_approval',
        `The job is ${job.state}, not awaiting a decision.`,
      );
    }
    const config = await this.#configOf(job);
    let jg = await loadJobGit(this.deps.pool, jobId);
    if (config === null || jg?.verification !== 'passed' || jg.headSha === null || jg.branch === null) {
      throw new GitFlowError(409, 'not_verified', 'The job has no verified changes to integrate.');
    }
    const open = (await loadMergeRequests(this.deps.pool, jobId)).find((r) => OPEN_STATUSES.has(r.status));
    // p15-merge-approvals: the decision the master opened at verification may be replaced by a person's own choice
    // ("accept without merging" instead of the merge, or the destructive discard).
    let supersede: MergeRequestRecord | null = null;
    if (open !== undefined) {
      if (open.mode === mode) return { request: open, created: false };
      if (open.status !== 'pending' || open.requestedBy !== null) {
        throw new GitFlowError(409, 'request_open', `A ${open.mode} request is already open for this job.`);
      }
      supersede = open;
    }
    if (mode === 'merge') {
      jg = (await this.refresh(jobId, { force: true })) ?? jg;
      refuseUnmergeable(jg, config.requireCi);
    }
    const verified = jg;
    const headSha = jg.headSha ?? '';
    const n = (await loadMergeRequests(this.deps.pool, jobId)).length + 1;
    const id = randomUUID();
    const action = MODE_ACTION[mode];
    const summary = requestSummary(mode, jg, config);
    const input = {
      action,
      jobId,
      approvalKey: `${mode.replace('_', '-')}.${String(n)}`,
      summary,
      requestedBy: GITFLOW,
      ...(mode === 'discard' ? { risk: 'critical' as const } : {}),
    };
    const evalOpts = {
      // A person asked: a person decides (the security policy's autonomy is for the master's own decisions).
      ignoreAutonomy: true,
      onCreated: async (tx: pg.PoolClient, approvalRequestId: string) => {
        const now = this.deps.clock();
        await tx.query(
          `INSERT INTO git_merge_requests (id, job_id, approval_request_id, mode, head_sha, base_sha, target_branch,
             method, requested_by, reason, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $11)`,
          [
            id,
            jobId,
            approvalRequestId,
            mode,
            headSha,
            verified.mergeCheck?.baseSha ?? verified.baseSha ?? headSha,
            verified.targetBranch,
            config.mergeMethod,
            user.id,
            opts.reason?.slice(0, 1000) ?? null,
            now,
          ],
        );
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'git.merge.request',
            target: `job:${jobId}`,
            outcome: 'success',
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            metadata: {
              mergeRequestId: id,
              approvalRequestId,
              mode,
              action,
              head: headSha,
              ...(supersede === null ? {} : { supersedes: supersede.id }),
            },
          },
          tx,
        );
      },
    };
    let evaluation: Evaluation;
    if (supersede === null) {
      evaluation = await this.deps.approvals.evaluate(input, evalOpts);
    } else {
      // Withdraw and replace atomically: when the new request is refused, the master's request stays open.
      const old = supersede;
      try {
        evaluation = await withTransaction(this.deps.pool, async (tx) => {
          await this.#withdraw(tx, old, `superseded: a ${mode.replace('_', ' ')} request was made instead`);
          const ev = await this.deps.approvals.evaluateWithin(tx, input, evalOpts);
          if (ev.outcome !== 'pending') throw new SupersedeRefused(ev);
          return ev;
        });
      } catch (err) {
        if (!(err instanceof SupersedeRefused)) throw err;
        evaluation = err.evaluation;
        await this.deps.audit.record({
          actor: { type: 'user', id: user.id },
          action: 'git.merge.request',
          target: `job:${jobId}`,
          outcome: 'denied',
          ip: opts.ip ?? null,
          userAgent: opts.userAgent ?? null,
          metadata: { mode, action, outcome: evaluation.outcome, kept: old.id },
        });
      }
    }
    if (evaluation.outcome === 'deny') {
      throw new DestructiveActionRefusedError(
        `The project policy does not allow ${action} for this job (${evaluation.reason}).`,
      );
    }
    if (evaluation.outcome === 'allow') {
      // Unreachable: a person's request skips the autonomy layer and the platform floor of git.merge /
      // git.force_push never resolves to allow. Fail closed.
      throw new DestructiveActionRefusedError(`${action} resolved to allow without approval; refusing.`);
    }
    const created = await loadMergeRequest(this.deps.pool, { approvalRequestId: evaluation.requestId });
    if (created === null)
      throw new GitFlowError(409, 'request_conflict', 'The request could not be recorded.');
    return { request: created, created: evaluation.created };
  }

  /**
   * Gate decision hook (inside the decide transaction). Merge and discard approvals are deferred: the
   * effect runs after commit and the job transition follows the effect. `leave_open` approvals and every
   * denial use the default transition (SUCCEEDED / FAILED).
   */
  async onGateClosed(
    tx: pg.PoolClient,
    input: {
      readonly requestId: string;
      readonly jobId: string;
      readonly action: ApprovalAction;
      readonly status: 'approved' | 'denied';
      readonly userId: string;
      readonly reason: string | null;
    },
  ): Promise<'default' | 'deferred'> {
    const mr = await loadMergeRequest(tx, { approvalRequestId: input.requestId }, true);
    if (mr === null) return 'default';
    const now = this.deps.clock();
    if (input.status === 'denied') {
      await tx.query(
        `UPDATE git_merge_requests SET status = 'denied', result_reason = $2, updated_at = $3 WHERE id = $1`,
        [mr.id, input.reason ?? 'denied', now],
      );
      // Denying a discard keeps the result; denying a merge / leave-open rejects it (default: FAILED).
      return mr.mode === 'discard' ? 'deferred' : 'default';
    }
    if (mr.mode === 'leave_open') {
      await tx.query(
        `UPDATE git_merge_requests SET status = 'left_open', approved_by = $2, approved_at = $3, executed_at = $3,
                updated_at = $3, result_reason = 'accepted; pull request left open' WHERE id = $1`,
        [mr.id, input.userId, now],
      );
      return 'default';
    }
    await tx.query(
      `UPDATE git_merge_requests SET status = 'approved', approved_by = $2, approved_at = $3, updated_at = $3
        WHERE id = $1`,
      [mr.id, input.userId, now],
    );
    setImmediate(() => {
      void this.execute(mr.id).catch((err: unknown) => {
        this.deps.log.error({ mergeRequestId: mr.id, err: errText(err) }, 'git flow: execution failed');
      });
    });
    return 'deferred';
  }

  // ------------------------------------------------------------------------------------- execution

  /** Runs every approved request (loop), plus claims that a crash left behind. */
  async executeApproved(): Promise<void> {
    const now = this.deps.clock().getTime();
    const stale = new Date(now - this.timing.executeClaimMs);
    // A released request (merge check / CI still running) waits one refresh interval before the next try.
    const backoff = new Date(now - this.timing.refreshIntervalMs);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM git_merge_requests
        WHERE (status = 'approved' AND (claimed_at IS NULL OR claimed_at <= $2))
           OR (status = 'executing' AND claimed_at < $1)
        ORDER BY approved_at LIMIT 20`,
      [stale, backoff],
    );
    for (const r of rows) await this.execute(r.id);
  }

  /** Executes one approved merge/discard request (idempotent; sha-guarded). */
  async execute(mergeRequestId: string): Promise<MergeRequestRecord | null> {
    const r = await this.#once(`execute:${mergeRequestId}`, async () => {
      // p22-output-delivery §2: merges into the same target branch of a project run one after another (several
      // approved at once — the bulk approval — must not race on the target); each one re-runs its own test merge
      // against the target the previous one produced, so a later one that now conflicts is refused with the
      // conflicting files and its "accept without merging" decision opens (p15-merge-approvals §1.3).
      const head = await loadMergeRequest(this.deps.pool, { id: mergeRequestId });
      const project = head === null ? null : (await loadJobGit(this.deps.pool, head.jobId))?.project;
      const key = head === null || project == null ? mergeRequestId : `${project}|${head.targetBranch}`;
      return this.#serially(key, () => this.#execute(mergeRequestId));
    });
    return r ?? (await loadMergeRequest(this.deps.pool, { id: mergeRequestId }));
  }

  readonly #chains = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier call with the same key (in this process) has settled. */
  async #serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#chains.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#chains.get(key) === tail) this.#chains.delete(key);
    }
  }

  async #execute(id: string): Promise<MergeRequestRecord | null> {
    const now = this.deps.clock();
    const claimed = await this.deps.pool.query<{ id: string }>(
      `UPDATE git_merge_requests SET status = 'executing', claimed_at = $2, attempts = attempts + 1, updated_at = $2
        WHERE id = $1 AND (status = 'approved' OR (status = 'executing' AND claimed_at < $3)) RETURNING id`,
      [id, now, new Date(now.getTime() - this.timing.executeClaimMs)],
    );
    if (claimed.rowCount !== 1) return loadMergeRequest(this.deps.pool, { id });
    const mr = await loadMergeRequest(this.deps.pool, { id });
    if (mr === null) return null;
    const job = await this.deps.jobs.get(mr.jobId);
    const jg = await loadJobGit(this.deps.pool, mr.jobId);
    const config = job === null ? null : await this.#configOf(job);
    if (job === null || jg?.branch == null || config === null) {
      return this.#refuse(mr, 'cancelled', 'job or git configuration no longer exists');
    }
    if (job.state !== 'AWAITING_APPROVAL') {
      return this.#refuse(mr, 'cancelled', `the job is ${job.state}`);
    }
    const provider = this.#provider(config);
    try {
      if (mr.mode === 'discard') {
        // Destructive: only reachable through an approved `git.force_push` gate request (step-up).
        const res = await provider.deleteBranch(jg.branch, mr.headSha);
        if (res === 'moved')
          return await this.#refuse(mr, 'refused', `${jg.branch} moved; not deleted (sha guard)`);
        return await this.#complete(
          mr,
          job,
          null,
          `attempt branch ${jg.branch} ${res === 'deleted' ? 'deleted' : 'already absent'}`,
        );
      }
      const done = await provider.findMerge(mr.targetBranch, mr.id);
      if (done !== null) return await this.#complete(mr, job, done, 'merge found on the target (retry)');
      const head = await provider.branchHead(jg.branch);
      if (head !== mr.headSha) {
        return await this.#refuse(
          mr,
          'refused',
          `head_moved: ${jg.branch} is at ${head ?? '(deleted)'}, approval was for ${mr.headSha}`,
        );
      }
      const pr = jg.prNumber === null ? null : { number: jg.prNumber, url: jg.prUrl ?? '' };
      const check = await provider.testMerge({
        targetBranch: mr.targetBranch,
        headSha: mr.headSha,
        headBranch: jg.branch,
        baseAtStart: jg.baseSha ?? mr.baseSha,
        pullRequest: pr,
      });
      await updateJobGit(this.deps.pool, mr.jobId, { ...mergeFields(check), merge_checked_at: now }, now);
      if (check.state === 'conflicts') {
        return await this.#refuse(mr, 'refused', `conflicts: ${check.files.slice(0, 20).join(', ')}`);
      }
      if (check.state === 'base_moved')
        return await this.#refuse(mr, 'refused', `needs_rebase: ${check.reason}`);
      if (check.state === 'unknown') return await this.#release(mr, 'mergeability not computed yet');
      if (config.requireCi) {
        const ci = await provider.checks(mr.headSha);
        await updateJobGit(this.deps.pool, mr.jobId, { ci_state: ci.state, ci, ci_checked_at: now }, now);
        if (ci.state !== 'success') {
          // p15-merge-approvals: a merge the security policy approved at verification waits for running checks
          // (within the project's CI timeout) instead of failing on them; a person's approval saw them green.
          const waiting = ci.state === 'pending' || ci.state === 'none';
          const deadline = (jg.verifiedAt ?? now).getTime() + config.ciTimeoutSec * 1000;
          if (mr.approvedVia === 'security_policy' && waiting && now.getTime() <= deadline)
            return await this.#release(mr, `waiting for CI: checks are ${ci.state}`);
          return await this.#refuse(mr, 'refused', `ci_not_passed: checks are ${ci.state}`);
        }
      }
      // p5-git-identity: a configured project / workspace identity also signs the master's own merge commits.
      const identity = await resolveGitIdentity(this.deps.pool, job.project);
      const outcome = await provider.merge({
        ...(identity.source === 'default' ? {} : { committer: identity.identity }),
        targetBranch: mr.targetBranch,
        headSha: mr.headSha,
        headBranch: jg.branch,
        method: mr.method,
        pullRequest: pr,
        title: prTitle(job),
        message: `Remyral job ${job.id} attempt ${jg.attemptId ?? '?'} (${approvalRef(mr)}).\n\n${MERGE_TRAILER_KEY}: ${mr.id}\n`,
      });
      if (!outcome.merged) return await this.#refuse(mr, 'refused', `${outcome.reason}: ${outcome.detail}`);
      return await this.#complete(mr, job, outcome.sha, `merged into ${mr.targetBranch}`);
    } catch (err) {
      if (err instanceof ProviderError && err.transient && mr.attempts < this.timing.maxExecuteAttempts) {
        return this.#release(mr, `retrying: ${errText(err)}`);
      }
      return this.#refuse(mr, 'refused', `provider error: ${errText(err)}`);
    }
  }

  /** Transient condition: back to `approved` for the next loop pass. */
  async #release(mr: MergeRequestRecord, reason: string): Promise<MergeRequestRecord | null> {
    await this.deps.pool.query(
      `UPDATE git_merge_requests SET status = 'approved', claimed_at = $3, result_reason = $2, updated_at = $3
        WHERE id = $1 AND status = 'executing'`,
      [mr.id, reason.slice(0, 1000), this.deps.clock()],
    );
    return loadMergeRequest(this.deps.pool, { id: mr.id });
  }

  async #refuse(
    mr: MergeRequestRecord,
    status: 'refused' | 'cancelled',
    reason: string,
  ): Promise<MergeRequestRecord | null> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE git_merge_requests SET status = $2, result_reason = $3, executed_at = $4, updated_at = $4
          WHERE id = $1 AND status = 'executing'`,
        [mr.id, status, reason.slice(0, 1000), now],
      );
      await this.deps.audit.record(
        {
          actor: GITFLOW,
          action: mr.mode === 'discard' ? 'git.branch.delete' : 'git.merge',
          target: `job:${mr.jobId}`,
          outcome: 'denied',
          metadata: {
            mergeRequestId: mr.id,
            approvalRequestId: mr.approvalRequestId,
            head: mr.headSha,
            status,
            reason: reason.slice(0, 500),
          },
        },
        tx,
      );
    });
    this.deps.log.warn(
      { jobId: mr.jobId, mergeRequestId: mr.id, reason },
      'git flow: approved request refused',
    );
    return loadMergeRequest(this.deps.pool, { id: mr.id });
  }

  /** Effect done: record it and move the job, as the approving human (the approval authorised it). */
  async #complete(
    mr: MergeRequestRecord,
    job: JobRecord,
    mergeSha: string | null,
    note: string,
  ): Promise<MergeRequestRecord | null> {
    const now = this.deps.clock();
    const approver = mr.approvedBy ?? '';
    // p15-merge-approvals: a merge the owner's security policy approved moves the job as the master (ADR-0056).
    const byPolicy = mr.approvedVia === 'security_policy';
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE git_merge_requests SET status = $2, merge_sha = $3, result_reason = $4, executed_at = $5, updated_at = $5
          WHERE id = $1`,
        [mr.id, mr.mode === 'discard' ? 'discarded' : 'merged', mergeSha, note, now],
      );
      if (mergeSha !== null) await updateJobGit(tx, mr.jobId, { merged_sha: mergeSha, merged_at: now }, now);
      await this.deps.audit.record(
        {
          actor: GITFLOW,
          action: mr.mode === 'discard' ? 'git.branch.delete' : 'git.merge',
          target: `job:${mr.jobId}`,
          outcome: 'success',
          metadata: {
            mergeRequestId: mr.id,
            approvalRequestId: mr.approvalRequestId,
            ...(byPolicy ? { approvedVia: 'security_policy' } : { approvedBy: approver }),
            head: mr.headSha,
            target: mr.targetBranch,
            method: mr.method,
            ...(mergeSha === null ? {} : { mergeSha }),
          },
        },
        tx,
      );
      try {
        await tx.query('SAVEPOINT gitflow_transition');
        await this.deps.jobs.transitionWithin(
          tx,
          mr.jobId,
          mr.mode === 'discard' ? 'approval_denied' : byPolicy ? 'approval_auto_granted' : 'approval_granted',
          {
            actor: byPolicy ? GITFLOW : { type: 'user', id: approver },
            reason:
              mr.mode === 'discard'
                ? `result discarded by ${approvalRef(mr)}: ${note}`
                : `${note} as ${(mergeSha ?? '').slice(0, 12)} (${approvalRef(mr)})`,
            expectedVersion: job.version,
          },
        );
        await tx.query('RELEASE SAVEPOINT gitflow_transition');
      } catch (err) {
        // The effect happened; if the job moved meanwhile (cancelled), the record above still says so.
        await tx.query('ROLLBACK TO SAVEPOINT gitflow_transition');
        if (!(err instanceof JobStoreError)) throw err;
        this.deps.log.error(
          { jobId: mr.jobId, code: err.code },
          'git flow: job moved while the merge executed',
        );
      }
    });
    return loadMergeRequest(this.deps.pool, { id: mr.id });
  }

  /** Mirrors approvals that expired or were cancelled (stale) without a human decision. */
  async syncClosedRequests(): Promise<void> {
    await this.deps.pool.query(
      `UPDATE git_merge_requests m SET status = a.status, result_reason = a.decision_reason, updated_at = $1
         FROM approval_requests a
        WHERE a.id = m.approval_request_id AND m.status = 'pending' AND a.status IN ('expired', 'cancelled')`,
      [this.deps.clock()],
    );
  }

  // ------------------------------------------------------------------------------------- loop

  /** One pass (orchestrator tick): verify, capture missing bases, refresh, execute, sync. */
  async tick(): Promise<void> {
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        this.deps.log.error({ step: name, err: errText(err) }, 'git flow step failed');
      }
    };
    await step('verify', async () => {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT j.id FROM jobs j JOIN job_git g ON g.job_id = j.id WHERE j.state = 'VERIFYING' LIMIT 50`,
      );
      for (const r of rows) await this.verify(r.id);
    });
    await step('capture', async () => {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT j.id FROM jobs j JOIN job_git g ON g.job_id = j.id
          WHERE g.base_sha IS NULL AND j.state IN ('QUEUED', 'RESERVED', 'STARTING', 'RUNNING') LIMIT 20`,
      );
      for (const r of rows) {
        const job = await this.deps.jobs.get(r.id);
        if (job !== null) await this.prepareDispatch(job);
      }
    });
    await step('sync', () => this.syncClosedRequests());
    await step('execute', () => this.executeApproved());
    await step('refresh', async () => {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT j.id FROM jobs j JOIN job_git g ON g.job_id = j.id
          WHERE j.state = 'AWAITING_APPROVAL' AND g.verification = 'passed' AND g.merged_sha IS NULL
            AND (g.merge_checked_at IS NULL OR g.merge_checked_at < $1::timestamptz - CASE
              WHEN g.provider = 'github' THEN make_interval(secs => $3::float8)
              ELSE make_interval(secs => $2::float8 *
                CASE WHEN g.verified_at IS NULL OR g.verified_at > $1::timestamptz - interval '10 minutes' THEN 1
                     WHEN g.verified_at > $1::timestamptz - interval '1 hour' THEN 4
                     WHEN g.verified_at > $1::timestamptz - interval '1 day' THEN 20
                     ELSE 60 END) END)
          ORDER BY g.merge_checked_at NULLS FIRST LIMIT 20`,
        // p22-github-rate: a result waiting for approval is re-checked every interval for its first 10 minutes, then
        // 4x, 20x and 60x less often (30 s → 2 min → 10 min → 30 min); a merge or merge approval forces a fresh check.
        // p22-github-webhook: a result with no webhook delivery for 2 hours is polled once, so a lost delivery never
        // leaves it stale. On GitHub the App's deliveries mark what changed (merge_checked_at cleared, taken first);
        // without one for `webhookFallbackMs` (2 h) since the last check, the result is asked about once — at any age.
        [this.deps.clock(), this.timing.refreshIntervalMs / 1000, this.timing.webhookFallbackMs / 1000],
      );
      for (const r of rows) await this.refresh(r.id);
    });
    // p15-merge-approvals: open missing merge decisions (also the backfill of jobs stuck before the fix).
    await step('decide', () => this.openDecisions());
  }

  // ------------------------------------------------------------------------------------- read

  /**
   * p5-live: the verified attempt diff (`base...head` on the remote) as text, or null when the job has no
   * verified record or the provider cannot produce patches. Untrusted text: callers redact it and render
   * it as text only.
   */
  async patch(
    jobId: string,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean; baseSha: string; headSha: string } | null> {
    const record = await loadJobGit(this.deps.pool, jobId);
    if (record === null || record.verification !== 'passed') return null;
    const { baseSha, headSha } = record;
    if (baseSha === null || headSha === null) return null;
    const config = await loadGitConfig(this.deps.pool, record.project);
    if (config === null) return null;
    const provider = this.#provider(config);
    if (provider.patch === undefined) return null;
    const p = await provider.patch(baseSha, headSha, maxBytes);
    return { ...p, baseSha, headSha };
  }

  async changes(jobId: string): Promise<{
    record: JobGitRecord | null;
    requests: MergeRequestRecord[];
    config: ProjectGitConfig | null;
  }> {
    const record = await loadJobGit(this.deps.pool, jobId);
    if (record === null) return { record: null, requests: [], config: null };
    return {
      record,
      requests: await loadMergeRequests(this.deps.pool, jobId),
      config: await loadGitConfig(this.deps.pool, record.project),
    };
  }
}

// ------------------------------------------------------------------------------------- pure helpers

/** Rolls back a supersede whose replacement request was not opened (deny / allow). */
class SupersedeRefused extends Error {
  constructor(readonly evaluation: Evaluation) {
    super('supersede refused');
  }
}

/** p15-merge-approvals: what opening a merge decision did. */
type DecisionOutcome =
  | { readonly kind: 'opened'; readonly approvalRequestId: string }
  | { readonly kind: 'auto'; readonly mergeRequestId: string }
  | { readonly kind: 'exists' | 'skipped' | 'denied' };

const OPEN_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'executing']);

/** A workflow step or a coordinator's sub-job / coordinator: its run decides when results reach the target. */
export async function partOfRun(db: Queryable, jobId: string): Promise<boolean> {
  const { rows } = await db.query<{ member: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM job_subtasks s WHERE s.child_job_id = $1 OR s.parent_job_id = $1)
          OR EXISTS (SELECT 1 FROM workflow_nodes w WHERE w.job_id = $1)
          OR EXISTS (SELECT 1 FROM workflow_node_run_jobs l WHERE l.job_id = $1)) AS member`,
    [jobId],
  );
  return rows[0]?.member === true;
}

/** The approver's summary of a decision the master opened (untrusted parts are file paths and the PR URL). */
function decisionSummary(
  mode: MergeRequestMode,
  jg: JobGitRecord,
  config: ProjectGitConfig,
  refusedBefore: boolean,
): string {
  const why =
    mode === 'merge'
      ? jg.mergeState === 'clean'
        ? ''
        : ' The merge check is still running; the merge waits for it after approval.'
      : refusedBefore
        ? ' An earlier merge of this result was refused; approve to accept it without merging, deny to reject it.'
        : ` It cannot merge as is (${jg.mergeState === 'conflicts' ? 'conflicts' : 'the target was rewritten'}); approve to accept it without merging, deny to reject it.`;
  return `${requestSummary(mode, jg, config)}${why}`;
}

/** How a merge request was authorised, for commit messages and transition reasons. */
function approvalRef(mr: Pick<MergeRequestRecord, 'approvalRequestId'>): string {
  return mr.approvalRequestId === null
    ? 'approved by the security policy'
    : `approval ${mr.approvalRequestId}`;
}

/** p18-project-bootstrap: {@link GitFlowService.repositoryState}. */
export interface RepositoryState {
  readonly provider: string;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly state: 'empty' | 'ready' | 'base_missing' | 'unknown';
  readonly detail?: string;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** p22-output-delivery: the transition note of a job whose files were delivered as outputs. */
export function deliveryNote(d: DeliveredOutputs, branch: string): string {
  const skipped =
    d.skipped.length === 0
      ? ''
      : ` (${String(d.skipped.length)} not copied: ${d.skipped
          .slice(0, 5)
          .map((s) => `${s.path} [${s.code}]`)
          .join(', ')}${d.skipped.length > 5 ? ', …' : ''})`;
  const capped = d.listTruncated
    ? ' (the provider capped the list of changed files; the rest stays on the branch)'
    : '';
  return `delivered as outputs: ${String(d.stored)} file(s) in Outputs${skipped}${capped}; nothing merged, ${branch} keeps the files`;
}

function mergeFields(check: MergeCheck): { merge_state: MergeState; merge_check: StoredMergeCheck } {
  return {
    merge_state: check.state,
    merge_check: {
      baseSha: check.baseSha,
      headSha: check.headSha,
      files: check.state === 'conflicts' ? check.files : [],
      headCommits: check.state === 'conflicts' ? check.headCommits : [],
      baseCommits: check.state === 'conflicts' ? check.baseCommits : [],
      precision: check.state === 'conflicts' ? check.precision : null,
      reason: check.state === 'base_moved' ? check.reason : null,
    },
  };
}

/** Throws the reason a verified result cannot be merged as is (409s the console shows verbatim). */
function refuseUnmergeable(jg: JobGitRecord, requireCi: boolean): void {
  const files = jg.mergeCheck?.files ?? [];
  switch (jg.mergeState) {
    case 'conflicts':
      throw new GitFlowError(
        409,
        'merge_conflicts',
        `The changes conflict with ${jg.targetBranch} in ${String(files.length)} file(s): ${files.slice(0, 10).join(', ')}. ` +
          'Resolve by hand (rebase the work) or leave the pull request open.',
      );
    case 'base_moved':
      throw new GitFlowError(
        409,
        'needs_rebase',
        `Needs rebase: ${jg.mergeCheck?.reason ?? 'the target moved'}.`,
      );
    case 'clean':
      break;
    default:
      throw new GitFlowError(
        409,
        'merge_check_pending',
        jg.mergeCheck?.reason ?? 'Mergeability is not known yet. Try again shortly.',
      );
  }
  if (requireCi && jg.ciState !== 'success') {
    throw new GitFlowError(
      409,
      'ci_not_passed',
      `The project requires green CI; checks are ${jg.ciState ?? 'unknown'}.`,
    );
  }
}

function requestSummary(mode: MergeRequestMode, jg: JobGitRecord, config: ProjectGitConfig): string {
  const t = jg.changes?.totals;
  const what = `${jg.branch ?? '?'}@${(jg.headSha ?? '').slice(0, 12)}`;
  const stats =
    t === undefined ? '' : ` ${String(t.files)} files, +${String(t.additions)} -${String(t.deletions)}.`;
  const flags =
    jg.flags.length === 0
      ? ''
      : ` Review flags: ${jg.flags
          .map((f) => `${f.kind} ${f.path}`)
          .slice(0, 10)
          .join('; ')}.`;
  // p16-git-providers: GitLab calls it a merge request (MR !<n>).
  const term = reviewRequestTerm(config.provider);
  const pr =
    jg.prNumber === null
      ? ''
      : ` ${term.short} ${term.numberPrefix}${String(jg.prNumber)} ${jg.prUrl ?? ''}.`;
  const repo = parseRepoUrl(config.repositoryUrl)?.key ?? config.repositoryUrl;
  switch (mode) {
    case 'merge':
      return `Merge ${what} into ${jg.targetBranch} of ${repo} (${config.mergeMethod === 'squash' ? 'squash' : 'merge commit'}).${stats} Checks: ${jg.ciState ?? 'unknown'}.${pr}${flags}`;
    case 'leave_open':
      return `Accept the result of ${what} without merging; the ${term.long} stays open for manual review.${stats}${pr}${flags}`;
    case 'discard':
      return `DESTRUCTIVE: delete the attempt branch ${what} on ${repo} and reject the result.${stats}${pr}`;
  }
}
