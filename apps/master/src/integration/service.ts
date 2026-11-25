import { randomUUID } from 'node:crypto';
import {
  type ConflictFileDetail,
  integrationBranchName,
  IntegrationReport,
  type IntegrationPlan,
  type JobSpec,
  jobTitleOf,
  pullRequestTitle,
  RuntimeKind,
} from '@remyral/protocol';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { jobTitle } from '../jobs/titles.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { GitFlowService } from '../gitflow/service.js';
import { loadJobGit } from '../gitflow/store.js';
import type { GitProvider } from '../gitflow/types.js';
import { HttpError } from '../http/errors.js';
import { rowContent } from '../blobs/registry.js';
import { JobStoreError } from '../jobs/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import { combine, stateOf } from '../verify/model.js';
import { readVerifierFiles } from '../verify/report.js';
import type { VerifySettingsStore } from '../verify/settings.js';
import { markReportOnly } from '../verify/report-only.js';
import { closeReportJobGate, mayCreateJobs, verifierSpec } from '../verify/verifier-job.js';
import {
  type BranchState,
  clip,
  DEFAULT_SETTINGS,
  fixPrompt,
  INTEGRATION_TIMING,
  type IntegrationJobKind,
  type IntegrationSettings,
  type IntegrationState,
  type MemberInput,
  OPEN_STATES,
  oneLine,
  orderMembers,
  type OverlapWarning,
  prBody,
  prTitle,
  resolutionPrompt,
  siblingOverlaps,
} from './model.js';

/**
 * p11-merge-pipeline (ADR-0041, docs/design/p11-merge-pipeline.md): the master-managed integration.
 *
 * By design, combining the code of several agents ends in ONE pull request, built by the master — not
 * one PR per sub-job, and not an agent that merges branches by itself. For a coordinator job whose sub-jobs changed the
 * repository (or a workflow run with an integrator step) the master:
 *  1. creates `int/<root8>` from the target's current head and merges the members' verified branches in a defined order
 *     with a deterministic integration job on a worker (real git, no agent; `kind: "integration"`);
 *  2. on a conflict opens a conflict-resolution job (an agent, the coordinator's policy) given both sides' diffs, the
 *     conflict markers and both task descriptions as fenced data, and applies its result for exactly the conflicting
 *     files in the next round — at most `maxResolutions` rounds, then a human;
 *  3. runs the project's verification (the p10-verify-health repository checklist) on the result; a failure opens a
 *     bounded fix job, else a human;
 *  4. opens ONE pull request (GitHub) with a generated description, or offers the existing protected merge (plain git).
 *     Merging stays a human approval (the head job's `git.merge`, admin + step-up) or GitHub's own protected merge.
 * Every job result is verified by git flow on the remote (T-WRK-2) before the master moves `int/<root8>`, and the branch
 * only ever fast-forwards. Nothing here trusts agent or worker text: reports and summaries are data.
 */

export interface IntegrationServiceDeps {
  readonly pool: Pool;
  readonly jobs: JobStore;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly gitflow: () => GitFlowService | null;
  readonly dispatch: (jobId: string) => Promise<unknown>;
  readonly cancel: () => { sendCancel(job: { readonly id: string }, reason: string): Promise<boolean> };
  readonly verifySettings: VerifySettingsStore;
  readonly timing?: Partial<typeof INTEGRATION_TIMING>;
}

export interface IntegrationView {
  readonly id: string;
  readonly project: string;
  readonly source: 'coordinator' | 'workflow';
  readonly rootJobId: string | null;
  readonly runId: string | null;
  readonly nodeId: string | null;
  readonly branch: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  readonly headSha: string | null;
  readonly orderMode: 'dependency' | 'completion';
  readonly state: IntegrationState;
  readonly reason: string | null;
  readonly resolutionRounds: number;
  readonly maxResolutions: number;
  readonly fixRounds: number;
  readonly maxFixes: number;
  readonly branches: readonly {
    readonly position: number;
    readonly jobId: string;
    readonly title: string;
    readonly branch: string;
    readonly sha: string;
    readonly paths: readonly string[];
    readonly state: BranchState;
    readonly mergedSha: string | null;
    readonly conflictFiles: readonly string[];
    readonly resolutionJobId: string | null;
    readonly resolutionJobState: string | null;
    readonly detail: string | null;
  }[];
  readonly jobs: readonly {
    readonly jobId: string;
    readonly kind: IntegrationJobKind;
    readonly round: number;
    readonly state: string;
    readonly createdAt: string;
  }[];
  readonly warnings: readonly OverlapWarning[];
  readonly verification: VerificationResult | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly mergeJobId: string | null;
  readonly log: readonly { readonly at: string; readonly message: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VerificationResult {
  readonly state: 'pending' | 'running' | 'passed' | 'warned' | 'failed' | 'error' | 'skipped';
  readonly jobId: string | null;
  readonly summary: string | null;
  readonly checks: readonly {
    readonly id: string;
    readonly status: string;
    readonly detail: string | null;
  }[];
  readonly findings: readonly {
    readonly severity: string;
    readonly kind: string;
    readonly message: string;
  }[];
}

interface IntRow {
  id: string;
  project: string;
  source: 'coordinator' | 'workflow';
  root_job_id: string | null;
  run_id: string | null;
  node_id: string | null;
  branch: string;
  target_branch: string;
  repository_url: string;
  base_sha: string;
  head_sha: string | null;
  head_job_id: string | null;
  order_mode: 'dependency' | 'completion';
  state: IntegrationState;
  reason: string | null;
  round: number;
  resolution_rounds: number;
  max_resolutions: number;
  fix_rounds: number;
  max_fixes: number;
  current_job_id: string | null;
  verification: VerificationResult | null;
  pr_number: number | null;
  pr_url: string | null;
  warnings: OverlapWarning[];
  log: { at: string; message: string }[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface BranchRow {
  position: number;
  job_id: string;
  title: string;
  branch: string;
  sha: string;
  paths: string[];
  state: BranchState;
  merged_sha: string | null;
  conflict_files: string[];
  conflict: { details?: ConflictFileDetail[] } | null;
  resolution_job_id: string | null;
  resolution: { sha: string; branch: string; files: string[]; jobId: string } | null;
  detail: string | null;
}

const COLS = `id::text AS id, project, source, root_job_id::text AS root_job_id, run_id::text AS run_id, node_id, branch,
  target_branch, repository_url, base_sha, head_sha, head_job_id::text AS head_job_id, order_mode, state, reason, round,
  resolution_rounds, max_resolutions, fix_rounds, max_fixes, current_job_id::text AS current_job_id, verification,
  pr_number, pr_url, warnings, log, created_by::text AS created_by, created_at, updated_at`;

const ACTOR = { type: 'system', id: 'integration' } as const;
const TERMINAL_JOB = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const redactor = new Redactor({ rules: DEFAULT_RULES });

/** A stop that needs a human (the integration keeps its branch; a person resolves it and may retry). */
class NeedsHuman extends Error {}

type Finished =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'ok';
      readonly job: JobRecord;
      readonly head: string;
      readonly branch: string;
      /** The job's verified result changed files (else git flow finished it without an approval). */
      readonly changed: boolean;
    };

export class IntegrationService {
  readonly #timing: typeof INTEGRATION_TIMING;
  readonly #running = new Set<Promise<void>>();
  readonly #lastPoll = new Map<string, number>();

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.#timing = { ...INTEGRATION_TIMING, ...deps.timing };
  }

  // ------------------------------------------------------------------------------------------- settings

  async settings(project: string, db: Queryable = this.deps.pool): Promise<IntegrationSettings> {
    const { rows } = await db.query<{
      integration_mode: 'master' | 'off';
      integration_order: 'dependency' | 'completion';
      integration_max_resolutions: number;
      integration_max_fixes: number;
    }>(
      `SELECT integration_mode, integration_order, integration_max_resolutions, integration_max_fixes
         FROM projects WHERE id = $1`,
      [project],
    );
    const r = rows[0];
    if (r === undefined) return DEFAULT_SETTINGS;
    return {
      mode: r.integration_mode,
      order: r.integration_order,
      maxResolutions: r.integration_max_resolutions,
      maxFixes: r.integration_max_fixes,
    };
  }

  async putSettings(
    project: string,
    input: IntegrationSettings,
    actor: { readonly id: string },
  ): Promise<IntegrationSettings> {
    const before = await this.settings(project);
    const res = await this.deps.pool.query(
      `UPDATE projects SET integration_mode = $2, integration_order = $3, integration_max_resolutions = $4,
              integration_max_fixes = $5 WHERE id = $1`,
      [project, input.mode, input.order, input.maxResolutions, input.maxFixes],
    );
    if (res.rowCount !== 1) throw new HttpError(404, 'project_not_found', 'Project not found.');
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.id },
      action: 'project.integration.update',
      target: `project:${project}`,
      outcome: 'success',
      metadata: { before, after: input },
    });
    return input;
  }

  // ------------------------------------------------------------------------------------------- PR policy

  /**
   * git flow hook: false when the verified job's changes reach the target through a master-managed integration (one PR
   * for all of them) — a sub-job or a coordinator with sub-jobs, a workflow step of a run with an integrator, or a job
   * the integration created itself — in a project whose integration mode is `master`.
   *
   * A sub-job tree only counts while it can still be integrated: an integration of its root exists (any state but
   * cancelled), or the root is not failed / cancelled and still has a sub-job that is not. Otherwise (e.g. a
   * coordinator whose only sub-job was cancelled, a sub-job whose coordinator failed) #discover never
   * starts an integration, so the job gets its own pull request instead of waiting for a merge decision forever.
   */
  async ownPullRequest(job: JobRecord): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ member: boolean }>(
      `WITH tree AS (
         SELECT COALESCE((SELECT s.root_job_id FROM job_subtasks s WHERE s.child_job_id = $1 LIMIT 1), $1::uuid) AS root
       )
       SELECT (
          EXISTS (SELECT 1 FROM integration_jobs WHERE job_id = $1)
          OR (p.integration_mode = 'master' AND (
                (EXISTS (SELECT 1 FROM job_subtasks s WHERE s.child_job_id = $1 OR s.parent_job_id = $1)
                 AND (
                   EXISTS (SELECT 1 FROM integrations i, tree t WHERE i.root_job_id = t.root AND i.state <> 'cancelled')
                   OR (
                     EXISTS (SELECT 1 FROM jobs r, tree t WHERE r.id = t.root AND r.state NOT IN ('FAILED', 'CANCELLED'))
                     AND EXISTS (SELECT 1 FROM job_subtasks s JOIN jobs c ON c.id = s.child_job_id, tree t
                                  WHERE s.root_job_id = t.root AND c.state NOT IN ('FAILED', 'CANCELLED'))
                   )
                 ))
                OR EXISTS (SELECT 1 FROM workflow_nodes w JOIN workflow_nodes i ON i.run_id = w.run_id
                            WHERE w.job_id = $1 AND i.role = 'integrator')
                OR EXISTS (SELECT 1 FROM workflow_node_run_jobs l JOIN workflow_node_runs w ON w.id = l.node_run_id
                             JOIN workflow_node_runs i ON i.run_id = w.run_id
                            WHERE l.job_id = $1 AND i.input->>'role' = 'integrator'))))
         AS member
         FROM projects p WHERE p.id = $2`,
      [job.id, job.project],
    );
    return rows[0]?.member !== true;
  }

  // ------------------------------------------------------------------------------------------- tick

  step(): { name: string; run: () => Promise<number> } {
    return { name: 'integration', run: () => this.tick() };
  }

  /** Waits for the work started by earlier ticks (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  async tick(): Promise<number> {
    let n = 0;
    try {
      n += await this.#discover();
    } catch (err) {
      this.deps.log.error({ err }, 'integration discovery failed');
    }
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `UPDATE integrations SET claimed_at = $1
        WHERE id IN (SELECT id FROM integrations
                      WHERE state = ANY($2::text[]) AND (claimed_at IS NULL OR claimed_at < $3)
                      ORDER BY updated_at LIMIT 10 FOR UPDATE SKIP LOCKED)
       RETURNING id::text AS id`,
      [now, OPEN_STATES, new Date(now.getTime() - this.#timing.claimTimeoutMs)],
    );
    for (const r of rows) {
      this.#spawn(async () => {
        try {
          await this.#advance(r.id);
        } finally {
          await this.deps.pool.query('UPDATE integrations SET claimed_at = NULL WHERE id = $1', [r.id]);
        }
      });
      n++;
    }
    return n;
  }

  #spawn(fn: () => Promise<void>): void {
    const p = fn()
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'integration step failed unexpectedly');
      })
      .finally(() => this.#running.delete(p));
    this.#running.add(p);
  }

  // ------------------------------------------------------------------------------------------- discovery

  /** Coordinators whose repository sub-jobs are all settled and at least one of them has verified changes. */
  async #discover(): Promise<number> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id::text AS id FROM jobs j JOIN projects p ON p.id = j.project
        WHERE p.integration_mode = 'master'
          AND j.state IN ('AWAITING_APPROVAL', 'SUCCEEDED')
          AND j.state_changed_at > $1
          AND j.spec ? 'repository'
          AND EXISTS (SELECT 1 FROM project_git_configs g WHERE g.project = j.project)
          AND NOT EXISTS (SELECT 1 FROM job_subtasks s WHERE s.child_job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM integrations i WHERE i.root_job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM integration_jobs ij WHERE ij.job_id = j.id)
          AND EXISTS (SELECT 1 FROM job_subtasks s JOIN jobs c ON c.id = s.child_job_id
                        JOIN job_git cg ON cg.job_id = c.id
                       WHERE s.root_job_id = j.id AND c.state = 'AWAITING_APPROVAL' AND cg.verification = 'passed')
          AND NOT EXISTS (SELECT 1 FROM job_subtasks s JOIN jobs c ON c.id = s.child_job_id
                           WHERE s.root_job_id = j.id
                             AND c.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL'))
        ORDER BY j.state_changed_at LIMIT 5`,
      [new Date(now.getTime() - this.#timing.discoverWindowMs)],
    );
    let n = 0;
    for (const r of rows) {
      try {
        if (await this.#startCoordinator(r.id)) n++;
      } catch (err) {
        this.deps.log.warn(
          { err, jobId: r.id },
          'integration could not be started; retried on the next tick',
        );
      }
    }
    return n;
  }

  async #startCoordinator(rootId: string): Promise<boolean> {
    const root = await this.deps.jobs.get(rootId);
    if (root?.spec.repository === undefined) return false;
    if (root.createdBy.type !== 'user' || root.createdBy.id === null) {
      this.deps.log.info(
        { jobId: rootId },
        'integration skipped: the coordinator was not started by a person',
      );
      return false;
    }
    const members = await this.deps.pool.query<{
      job_id: string;
      parent_job_id: string;
      title: string;
      paths: string[];
      created_at: Date;
      state_changed_at: Date;
      branch: string;
      head_sha: string;
    }>(
      `SELECT s.child_job_id::text AS job_id, s.parent_job_id::text AS parent_job_id, s.title, s.paths, s.created_at,
              c.state_changed_at, g.branch, g.head_sha
         FROM job_subtasks s JOIN jobs c ON c.id = s.child_job_id JOIN job_git g ON g.job_id = c.id
        WHERE s.root_job_id = $1 AND c.state = 'AWAITING_APPROVAL' AND g.verification = 'passed'
          AND g.branch IS NOT NULL AND g.head_sha IS NOT NULL AND g.merged_sha IS NULL`,
      [rootId],
    );
    const inputs: MemberInput[] = members.rows.map((m) => ({
      jobId: m.job_id,
      title: m.title,
      branch: m.branch,
      sha: m.head_sha,
      paths: m.paths,
      // A sub-job's own sub-jobs land before it (it waited for them).
      after: members.rows.filter((c) => c.parent_job_id === m.job_id).map((c) => c.job_id),
      parent: m.parent_job_id,
      createdAt: m.created_at,
      completedAt: m.state_changed_at,
    }));
    const rootGit = await loadJobGit(this.deps.pool, rootId);
    if (
      root.state === 'AWAITING_APPROVAL' &&
      rootGit?.verification === 'passed' &&
      rootGit.branch !== null &&
      rootGit.headSha !== null &&
      rootGit.mergedSha === null
    ) {
      // The coordinator's own changes land last: it waited for its sub-jobs.
      inputs.push({
        jobId: rootId,
        title: jobTitleOf(root.spec).title,
        branch: rootGit.branch,
        sha: rootGit.headSha,
        paths: [],
        after: inputs.map((m) => m.jobId),
        parent: null,
        createdAt: root.createdAt,
        completedAt: root.stateChangedAt,
      });
    }
    if (inputs.length === 0) return false;
    return (
      (await this.#create({
        project: root.project,
        source: 'coordinator',
        rootJobId: rootId,
        runId: null,
        nodeId: null,
        createdBy: root.createdBy.id,
        branchName: integrationBranchName(rootId),
        repositoryUrl: root.spec.repository.url,
        targetFrom: root,
        members: inputs,
      })) !== null
    );
  }

  /**
   * p11-merge-pipeline: a workflow run's integrator step, integrated by the master instead of an agent. Returns the
   * integration id, or null when the project does not use master-managed integration (the engine then runs the
   * integrator step as before).
   */
  async startWorkflow(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly project: string;
    readonly repository: { readonly url: string; readonly baseRef: string };
    readonly createdBy: string;
    readonly members: readonly {
      readonly nodeId: string;
      readonly jobId: string;
      readonly title: string;
      readonly after: readonly string[];
    }[];
  }): Promise<{ readonly id: string } | { readonly refused: string } | null> {
    const settings = await this.settings(input.project);
    const flow = this.deps.gitflow();
    if (settings.mode !== 'master' || flow === null) return null;
    // The integration acts for the person who started the run; a run without one keeps the integrator step as before.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.createdBy)) {
      this.deps.log.info(
        { runId: input.runId },
        'master integration skipped: the run was not started by a person',
      );
      return null;
    }
    if ((await flow.providerFor(input.project)) === null) return null;
    const existing = await this.deps.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM integrations WHERE run_id = $1 AND node_id = $2',
      [input.runId, input.nodeId],
    );
    if (existing.rows[0] !== undefined) return { id: existing.rows[0].id };
    const ids = new Map(input.members.map((m) => [m.nodeId, m.jobId]));
    const members: MemberInput[] = [];
    for (const m of input.members) {
      const job = await this.deps.jobs.get(m.jobId);
      const jg = await loadJobGit(this.deps.pool, m.jobId);
      if (
        job?.state !== 'AWAITING_APPROVAL' ||
        jg?.verification !== 'passed' ||
        jg.branch === null ||
        jg.headSha === null ||
        jg.mergedSha !== null
      ) {
        continue;
      }
      members.push({
        jobId: m.jobId,
        title: m.title,
        branch: jg.branch,
        sha: jg.headSha,
        paths: [],
        after: m.after.flatMap((n) => {
          const id = ids.get(n);
          return id === undefined ? [] : [id];
        }),
        parent: input.runId,
        createdAt: job.createdAt,
        completedAt: job.stateChangedAt,
      });
    }
    if (members.length === 0) return { refused: 'no upstream step has verified changes to integrate' };
    const id = await this.#create({
      project: input.project,
      source: 'workflow',
      rootJobId: null,
      runId: input.runId,
      nodeId: input.nodeId,
      createdBy: input.createdBy,
      branchName: integrationBranchName(input.runId),
      repositoryUrl: input.repository.url,
      targetFrom: null,
      targetRef: input.repository.baseRef,
      members,
    });
    return id === null ? { refused: 'the integration could not be started (see the master log)' } : { id };
  }

  /** The engine's merge status for a workflow integration. */
  async workflowStatus(id: string): Promise<'pending' | 'merged' | 'refused'> {
    const i = await this.#row(id);
    if (i === null) return 'refused';
    if (i.state === 'merged') return 'merged';
    if (i.state === 'failed' || i.state === 'cancelled' || i.state === 'needs_human') return 'refused';
    return 'pending';
  }

  async #create(c: {
    readonly project: string;
    readonly source: 'coordinator' | 'workflow';
    readonly rootJobId: string | null;
    readonly runId: string | null;
    readonly nodeId: string | null;
    readonly createdBy: string;
    readonly branchName: string;
    readonly repositoryUrl: string;
    readonly targetFrom: JobRecord | null;
    readonly targetRef?: string;
    readonly members: readonly MemberInput[];
  }): Promise<string | null> {
    const flow = this.deps.gitflow();
    const pc = flow === null ? null : await flow.providerFor(c.project);
    if (pc === null) return null;
    const settings = await this.settings(c.project);
    const target =
      c.targetFrom !== null
        ? GitFlowService.targetBranch(c.targetFrom, pc.config)
        : c.targetRef !== undefined && !/^[0-9a-f]{40}$/.test(c.targetRef)
          ? c.targetRef
          : pc.config.baseBranch;
    const base = await pc.provider.branchHead(target);
    if (base === null) {
      this.deps.log.warn({ project: c.project, target }, 'integration: the target branch does not exist');
      return null;
    }
    const ordered = orderMembers(c.members, settings.order);
    const warnings = siblingOverlaps(c.members);
    const id = randomUUID();
    const now = this.deps.clock();
    const log = [
      {
        at: now.toISOString(),
        message: `Integration of ${String(ordered.length)} branch(es) into ${c.branchName} from ${target} @ ${base.slice(0, 12)} (${settings.order} order).`,
      },
      ...warnings.map((w) => ({ at: now.toISOString(), message: `Warning: ${w.message}` })),
    ];
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO integrations (id, project, source, root_job_id, run_id, node_id, branch, target_branch,
                                   repository_url, base_sha, order_mode, state, max_resolutions, max_fixes, warnings,
                                   log, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'merging', $12, $13, $14, $15, $16, $17, $17)`,
        [
          id,
          c.project,
          c.source,
          c.rootJobId,
          c.runId,
          c.nodeId,
          c.branchName,
          target,
          c.repositoryUrl,
          base,
          settings.order,
          settings.maxResolutions,
          settings.maxFixes,
          JSON.stringify(warnings),
          JSON.stringify(log),
          c.createdBy,
          now,
        ],
      );
      for (const [position, m] of ordered.entries()) {
        await tx.query(
          `INSERT INTO integration_branches (integration_id, position, job_id, title, branch, sha, paths, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [id, position, m.jobId, clip(oneLine(m.title), 200) || 'task', m.branch, m.sha, [...m.paths]],
        );
      }
    });
    await this.deps.audit.record({
      actor: ACTOR,
      action: 'integration.start',
      target: c.rootJobId === null ? `workflow-run:${c.runId ?? ''}` : `job:${c.rootJobId}`,
      outcome: 'success',
      metadata: {
        integrationId: id,
        project: c.project,
        branch: c.branchName,
        target,
        base,
        members: ordered.map((m) => m.jobId),
        order: settings.order,
        warnings: warnings.length,
      },
    });
    const row = await this.#row(id);
    if (row !== null) await this.#guard(row, () => this.#startRound(row));
    return id;
  }

  // ------------------------------------------------------------------------------------------- state machine

  async #row(id: string, db: Queryable = this.deps.pool): Promise<IntRow | null> {
    const { rows } = await db.query<IntRow>(`SELECT ${COLS} FROM integrations WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async #branches(id: string): Promise<BranchRow[]> {
    const { rows } = await this.deps.pool.query<BranchRow>(
      `SELECT position, job_id::text AS job_id, title, branch, sha, paths, state, merged_sha, conflict_files, conflict,
              resolution_job_id::text AS resolution_job_id, resolution, detail
         FROM integration_branches WHERE integration_id = $1 ORDER BY position`,
      [id],
    );
    return rows;
  }

  async #set(id: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, n) => `${k} = $${String(n + 2)}`);
    await this.deps.pool.query(
      `UPDATE integrations SET ${[...sets, `updated_at = $${String(keys.length + 2)}`].join(', ')} WHERE id = $1`,
      [
        id,
        ...keys.map((k) => {
          const v = fields[k];
          return typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v;
        }),
        this.deps.clock(),
      ],
    );
  }

  async #note(id: string, message: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE integrations
          SET log = (CASE WHEN jsonb_array_length(log) >= 200 THEN log - 0 ELSE log END)
                    || jsonb_build_array(jsonb_build_object('at', $2::text, 'message', $3::text)),
              updated_at = $4
        WHERE id = $1`,
      [id, this.deps.clock().toISOString(), clip(message, 1000), this.deps.clock()],
    );
  }

  async #stop(
    i: IntRow,
    state: 'needs_human' | 'failed' | 'merged' | 'cancelled',
    reason: string,
  ): Promise<void> {
    await this.#set(i.id, { state, reason: clip(reason, 1000), current_job_id: null });
    await this.#note(i.id, state === 'merged' ? reason : `${humanState(state)}: ${reason}`);
    await this.deps.audit.record({
      actor: ACTOR,
      action: 'integration.finish',
      target: `integration:${i.id}`,
      outcome: state === 'merged' ? 'success' : 'failure',
      metadata: { project: i.project, state, reason: clip(reason, 300) },
    });
  }

  /** Runs a step; a NeedsHuman stop or an unexpected error moves the integration to `needs_human`. */
  async #guard(i: IntRow, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof NeedsHuman) {
        await this.#stop(i, 'needs_human', err.message);
        return;
      }
      this.deps.log.error({ err, integrationId: i.id }, 'integration step failed');
      const transient = (err as { transient?: unknown }).transient === true;
      if (transient) return; // provider unreachable: retried on the next tick
      await this.#stop(i, 'needs_human', `internal error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async #advance(id: string): Promise<void> {
    const i = await this.#row(id);
    if (i === null || !OPEN_STATES.includes(i.state)) return;
    await this.#guard(i, async () => {
      switch (i.state) {
        case 'merging':
          return this.#onMerging(i);
        case 'resolving':
          return this.#onResolving(i);
        case 'verifying':
          return this.#onVerifying(i);
        case 'fixing':
          return this.#onFixing(i);
        case 'publishing':
          return this.#publish(i);
        case 'ready':
          return this.#onReady(i);
        default:
          return undefined;
      }
    });
  }

  /** Starts the next integration round over the branches that still need merging, or moves on to verification. */
  async #startRound(i: IntRow): Promise<void> {
    const branches = await this.#branches(i.id);
    const pending = branches.filter(
      (b) => b.state === 'pending' || (b.state === 'conflict' && b.resolution !== null),
    );
    if (pending.length === 0) {
      await this.#startVerification(i);
      return;
    }
    const round = i.round + 1;
    const plan: IntegrationPlan = {
      integrationId: i.id,
      round,
      integrationBranch: i.branch,
      steps: pending.map((b) => ({
        position: b.position,
        label: `${clip(oneLine(b.title), 150)} (job ${b.job_id.slice(0, 8)})`,
        branch: b.branch,
        sha: b.sha,
        ...(b.state === 'conflict' && b.resolution !== null
          ? { resolution: { sha: b.resolution.sha, branch: b.resolution.branch, files: b.resolution.files } }
          : {}),
      })),
    };
    const policy = await this.#policySpec(i);
    const spec: Record<string, unknown> = {
      kind: 'integration',
      integration: plan,
      runtime: policy.runtime,
      prompt:
        `Platform integration step (no agent): merge ${String(plan.steps.length)} verified branch(es) into ` +
        `${i.branch} (integration ${i.id}, round ${String(round)}).`,
      repository: {
        url: i.repository_url,
        baseRef: i.head_sha ?? i.base_sha,
        workBranch: `${i.branch}/r${String(round)}`,
      },
      sandboxProfile: policy.sandboxProfile,
      approvalPolicy: policy.approvalPolicy,
      ...(policy.sourceTrust === undefined ? {} : { sourceTrust: policy.sourceTrust }),
      limits: { maxDurationSec: this.#timing.integrateMaxDurationSec },
      role: 'chore',
    };
    const jobId = await this.#createJob(i, 'integrate', round, spec, null);
    await this.#set(i.id, { state: 'merging', round, current_job_id: jobId, reason: null });
    await this.#note(
      i.id,
      `Round ${String(round)}: integration step ${jobId.slice(0, 8)} merges ${plan.steps
        .map((s) => String(s.position + 1))
        .join(
          ', ',
        )}${plan.steps.some((s) => s.resolution !== undefined) ? ' (with a conflict resolution)' : ''}.`,
    );
  }

  async #onMerging(i: IntRow): Promise<void> {
    if (i.current_job_id === null) return this.#startRound(i);
    const f = await this.#finished(i.current_job_id);
    if (f.kind === 'pending') return;
    if (f.kind === 'failed') throw new NeedsHuman(`the integration step failed (${f.reason})`);
    const report = await this.#report(f.job);
    if (report === null) throw new NeedsHuman('the integration step returned no valid report');
    if (report.integrationId !== i.id)
      throw new NeedsHuman('the integration report belongs to another integration');
    const flow = this.deps.gitflow();
    const pc = flow === null ? null : await flow.providerFor(i.project);
    if (pc === null) throw new NeedsHuman('the project has no git configuration any more');
    const branches = await this.#branches(i.id);
    // T-WRK-2: the worker's claims are checked on the remote — the result descends from the integration head and
    // contains every commit it says it merged.
    const from = i.head_sha ?? i.base_sha;
    if (!(await descends(pc.provider, from, f.head))) {
      throw new NeedsHuman(
        `the integration step's result ${f.head.slice(0, 12)} does not build on ${from.slice(0, 12)}`,
      );
    }
    let conflict: { position: number; files: string[]; details: ConflictFileDetail[] } | null = null;
    for (const s of report.steps) {
      const b = branches.find((x) => x.position === s.position);
      if (b === undefined) continue;
      if (s.outcome === 'merged' || s.outcome === 'resolved' || s.outcome === 'already') {
        if (!(await descends(pc.provider, b.sha, f.head))) {
          throw new NeedsHuman(
            `the integration step claims ${b.branch} merged, but ${b.sha.slice(0, 12)} is not in its result`,
          );
        }
        await this.deps.pool.query(
          `UPDATE integration_branches SET state = $3, merged_sha = $4, detail = $5
            WHERE integration_id = $1 AND position = $2`,
          [
            i.id,
            b.position,
            s.outcome === 'resolved' ? 'resolved' : 'merged',
            s.mergeSha ?? null,
            s.outcome === 'already' ? 'already contained in the integration branch' : null,
          ],
        );
        await this.#note(
          i.id,
          `${String(b.position + 1)}. ${clip(oneLine(b.title), 80)}: ${
            s.outcome === 'resolved'
              ? 'merged with the conflict resolution'
              : s.outcome === 'already'
                ? 'already contained'
                : 'merged cleanly'
          }.`,
        );
      } else if (s.outcome === 'conflict') {
        const files = s.conflictFiles ?? [];
        conflict = { position: s.position, files, details: s.details ?? [] };
        await this.deps.pool.query(
          `UPDATE integration_branches SET state = 'conflict', conflict_files = $3, conflict = $4, resolution = NULL,
                  resolution_job_id = NULL, detail = $5
            WHERE integration_id = $1 AND position = $2`,
          [i.id, b.position, files, JSON.stringify({ details: s.details ?? [] }), s.detail ?? null],
        );
        await this.#note(
          i.id,
          `${String(b.position + 1)}. ${clip(oneLine(b.title), 80)}: conflict in ${files.slice(0, 5).join(', ') || 'the merge'}${files.length > 5 ? ' …' : ''}${s.detail === undefined ? '' : ` (${s.detail})`}.`,
        );
      } else if (s.outcome === 'missing') {
        throw new NeedsHuman(`${b.branch}: ${s.detail ?? 'the commit is not on the remote'}`);
      }
    }
    // The verified result becomes the integration branch (fast-forward only) when it changed anything.
    if (f.changed) await this.#moveBranch(i, pc.provider, f.head, f.job.id);
    const fresh = await this.#row(i.id);
    if (fresh === null) return;
    if (conflict !== null) {
      if (conflict.files.length === 0) throw new NeedsHuman('the merge could not be started (see the log)');
      return this.#startResolution(fresh, conflict.position);
    }
    if (fresh.head_sha === null) {
      // Everything was already in the target: nothing to integrate.
      await this.#stop(
        fresh,
        'merged',
        `Everything was already contained in ${i.target_branch}; nothing to integrate.`,
      );
      await this.#settled(fresh);
      return;
    }
    return this.#startRound(fresh);
  }

  async #moveBranch(i: IntRow, provider: GitProvider, sha: string, jobId: string): Promise<void> {
    if (provider.updateBranch === undefined) {
      throw new NeedsHuman('the git provider cannot update branches (update the master)');
    }
    const outcome = await provider.updateBranch(i.branch, sha, i.head_sha);
    if (outcome === 'moved') {
      throw new NeedsHuman(`${i.branch} was changed outside the platform; it was not overwritten`);
    }
    if (outcome === 'not_fast_forward') {
      throw new NeedsHuman(`${i.branch} could not be fast-forwarded to ${sha.slice(0, 12)}`);
    }
    await this.#set(i.id, { head_sha: sha, head_job_id: jobId });
    await this.#note(
      i.id,
      `${i.branch} → ${sha.slice(0, 12)} (verified result of job ${jobId.slice(0, 8)}).`,
    );
    await this.deps.audit.record({
      actor: ACTOR,
      action: 'integration.branch.update',
      target: `integration:${i.id}`,
      outcome: 'success',
      metadata: { project: i.project, branch: i.branch, from: i.head_sha, to: sha, jobId },
    });
  }

  async #startResolution(i: IntRow, position: number): Promise<void> {
    if (i.resolution_rounds >= i.max_resolutions) {
      throw new NeedsHuman(
        `a merge conflict remains after ${String(i.resolution_rounds)} resolution round(s) (limit ${String(i.max_resolutions)}); resolve it on ${i.branch} by hand`,
      );
    }
    const branches = await this.#branches(i.id);
    const b = branches.find((x) => x.position === position);
    if (b === undefined) throw new NeedsHuman('the conflicting branch is unknown');
    const incoming = await this.deps.jobs.get(b.job_id);
    const round = i.resolution_rounds + 1;
    const prompt = resolutionPrompt({
      integrationId: i.id,
      branch: i.branch,
      targetBranch: i.target_branch,
      incoming: { title: b.title, jobId: b.job_id, branch: b.branch, prompt: incoming?.spec.prompt ?? '' },
      integrated: branches
        .filter((x) => x.state === 'merged' || x.state === 'resolved')
        .map((x) => ({ title: x.title, jobId: x.job_id })),
      files: b.conflict_files,
      details: b.conflict?.details ?? [],
      round,
    });
    const spec = await this.#agentSpec(i, prompt, `${i.branch}/resolve-${String(position)}-${String(round)}`);
    const jobId = await this.#createJob(i, 'resolve', round, spec, position);
    await this.deps.pool.query(
      'UPDATE integration_branches SET resolution_job_id = $3 WHERE integration_id = $1 AND position = $2',
      [i.id, position, jobId],
    );
    await this.#set(i.id, { state: 'resolving', resolution_rounds: round, current_job_id: jobId });
    await this.#note(
      i.id,
      `Conflict resolution ${String(round)}/${String(i.max_resolutions)}: job ${jobId.slice(0, 8)} resolves ${String(b.conflict_files.length)} file(s) of "${clip(oneLine(b.title), 60)}".`,
    );
  }

  async #onResolving(i: IntRow): Promise<void> {
    if (i.current_job_id === null) throw new NeedsHuman('the resolution job is unknown');
    const f = await this.#finished(i.current_job_id);
    if (f.kind === 'pending') return;
    const branches = await this.#branches(i.id);
    const b = branches.find((x) => x.resolution_job_id === i.current_job_id);
    if (b === undefined) throw new NeedsHuman('the conflicting branch of the resolution is unknown');
    const retry = async (why: string): Promise<void> => {
      await this.#note(i.id, `The conflict resolution did not work: ${why}.`);
      const fresh = await this.#row(i.id);
      if (fresh !== null) await this.#startResolution(fresh, b.position);
    };
    if (f.kind === 'failed') return retry(`job ${i.current_job_id.slice(0, 8)} ${f.reason}`);
    if (!f.changed) return retry('it changed nothing');
    const pc = await this.#provider(i);
    const from = i.head_sha ?? i.base_sha;
    const cmp = await pc.compare(from, f.head);
    if (cmp.status !== 'ahead') return retry(`its result does not build on ${from.slice(0, 12)}`);
    const changed = new Set(
      cmp.files.flatMap((x) => [x.path, ...(x.previousPath === undefined ? [] : [x.previousPath])]),
    );
    const untouched = b.conflict_files.filter((x) => !changed.has(x));
    if (untouched.length > 0) return retry(`it did not change ${untouched.slice(0, 5).join(', ')}`);
    const extra = [...changed].filter((x) => !b.conflict_files.includes(x));
    if (extra.length > 0) {
      await this.#note(
        i.id,
        `The resolution also changed ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}; only the conflicting files are taken.`,
      );
    }
    await this.deps.pool.query(
      `UPDATE integration_branches SET resolution = $3 WHERE integration_id = $1 AND position = $2`,
      [
        i.id,
        b.position,
        JSON.stringify({ sha: f.head, branch: f.branch, files: b.conflict_files, jobId: f.job.id }),
      ],
    );
    await this.#note(i.id, `Resolution of job ${f.job.id.slice(0, 8)} verified at ${f.head.slice(0, 12)}.`);
    const fresh = await this.#row(i.id);
    if (fresh !== null) await this.#startRound({ ...fresh, current_job_id: null });
  }

  async #startVerification(i: IntRow): Promise<void> {
    const fresh = (await this.#row(i.id)) ?? i;
    if (fresh.head_sha === null || fresh.head_job_id === null) throw new NeedsHuman('nothing was integrated');
    const settings = await this.deps.verifySettings.get(i.project);
    const policy = await this.#policySpec(i);
    const runtime = RuntimeKind.safeParse(settings.verifyRuntime ?? policy.runtime);
    if (!runtime.success) throw new NeedsHuman('no runtime is available for the verification');
    const n = (await this.#jobCount(i.id, 'verify')) + 1;
    const spec = verifierSpec({
      // p19-verifier-jobs: "Entegrasyon doğrulaması: <the root job's title>".
      purpose: 'integration-verify',
      subject:
        i.root_job_id === null ? null : await jobTitle(this.deps.pool, i.root_job_id).catch(() => null),
      project: i.project,
      creator: i.created_by,
      parentSpec: { ...policy, repository: { url: i.repository_url } },
      runtime: runtime.data,
      priority: 0,
      checklist: {
        type: 'repo',
        jobId: fresh.head_job_id,
        projectKind: 'repository',
        testCommand: settings.testCommand,
        browser: false,
      },
      checkoutRef: fresh.head_sha,
      workBranch: `verify/${i.branch}/${String(n)}`,
    });
    const jobId = await this.#createJob(fresh, 'verify', n, spec, null);
    const verification: VerificationResult = {
      state: 'running',
      jobId,
      summary: null,
      checks: [],
      findings: [],
    };
    await this.#set(i.id, { state: 'verifying', current_job_id: jobId, verification });
    await this.#note(
      i.id,
      `Verification ${String(n)}: job ${jobId.slice(0, 8)} builds and tests ${fresh.head_sha.slice(0, 12)}.`,
    );
  }

  async #onVerifying(i: IntRow): Promise<void> {
    if (i.current_job_id === null) return this.#startVerification(i);
    const job = await this.deps.jobs.get(i.current_job_id);
    if (job === null) throw new NeedsHuman('the verifier job no longer exists');
    if (!TERMINAL_JOB.has(job.state) && job.state !== 'AWAITING_APPROVAL') return;
    let result: VerificationResult;
    if (job.state === 'FAILED' || job.state === 'CANCELLED') {
      result = {
        state: 'error',
        jobId: job.id,
        summary: `The verifier job ended ${job.state.toLowerCase()}.`,
        checks: [],
        findings: [],
      };
    } else {
      // p11-fixes-a: a verifier created before report-only jobs went through git flow; its gate is pointless.
      if (job.state === 'AWAITING_APPROVAL') {
        await closeReportJobGate(
          this.deps.jobs,
          job.id,
          `Integration verifier: its report was collected; ${i.branch} is merged through the integration.`,
        );
      }
      const files = await readVerifierFiles(this.deps.pool, job.id);
      if (files.report === null) {
        result = {
          state: 'error',
          jobId: job.id,
          summary: files.problem ?? 'No valid report.',
          checks: [],
          findings: [],
        };
      } else {
        const r = files.report;
        result = {
          state: stateOf(combine(r.checks, r.findings, r.status)),
          jobId: job.id,
          summary: r.summary,
          checks: r.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
          findings: r.findings.map((x) => ({ severity: x.severity, kind: x.kind, message: x.message })),
        };
      }
    }
    await this.#set(i.id, { verification: result, current_job_id: null });
    await this.#note(
      i.id,
      `Verification ${result.state}${result.summary === null ? '' : `: ${clip(oneLine(result.summary), 200)}`}.`,
    );
    if (result.state === 'failed') {
      if (i.fix_rounds >= i.max_fixes) {
        throw new NeedsHuman(
          `the verification failed${i.fix_rounds > 0 ? ` after ${String(i.fix_rounds)} fix round(s)` : ''} (limit ${String(i.max_fixes)}); fix ${i.branch} by hand`,
        );
      }
      return this.#startFix({ ...i, verification: result });
    }
    // passed / warned — and `error` (the checks could not run): the PR says so; merging stays a human decision.
    await this.#set(i.id, { state: 'publishing' });
    const fresh = await this.#row(i.id);
    if (fresh !== null) await this.#publish(fresh);
  }

  async #startFix(i: IntRow): Promise<void> {
    const v = i.verification;
    const settings = await this.deps.verifySettings.get(i.project);
    const branches = await this.#branches(i.id);
    const round = i.fix_rounds + 1;
    const prompt = fixPrompt({
      integrationId: i.id,
      branch: i.branch,
      targetBranch: i.target_branch,
      tasks: branches.map((b) => ({ title: b.title, jobId: b.job_id })),
      summary: v?.summary ?? null,
      checks: v?.checks ?? [],
      findings: v?.findings ?? [],
      testCommand: settings.testCommand,
      round,
    });
    const spec = await this.#agentSpec(i, prompt, `${i.branch}/fix-${String(round)}`);
    const jobId = await this.#createJob(i, 'fix', round, spec, null);
    await this.#set(i.id, { state: 'fixing', fix_rounds: round, current_job_id: jobId });
    await this.#note(
      i.id,
      `Fix ${String(round)}/${String(i.max_fixes)}: job ${jobId.slice(0, 8)} works on the failed checks.`,
    );
  }

  async #onFixing(i: IntRow): Promise<void> {
    if (i.current_job_id === null) throw new NeedsHuman('the fix job is unknown');
    const f = await this.#finished(i.current_job_id);
    if (f.kind === 'pending') return;
    const again = async (why: string): Promise<void> => {
      if (i.fix_rounds >= i.max_fixes)
        throw new NeedsHuman(`the fix did not work (${why}); fix ${i.branch} by hand`);
      await this.#note(i.id, `The fix did not work: ${why}.`);
      await this.#startFix(i);
    };
    if (f.kind === 'failed') return again(`job ${i.current_job_id.slice(0, 8)} ${f.reason}`);
    if (!f.changed) return again('it changed nothing');
    const pc = await this.#provider(i);
    const from = i.head_sha ?? i.base_sha;
    if (!(await descends(pc, from, f.head)))
      return again(`its result does not build on ${from.slice(0, 12)}`);
    await this.#moveBranch(i, pc, f.head, f.job.id);
    const fresh = await this.#row(i.id);
    if (fresh !== null) await this.#startVerification({ ...fresh, current_job_id: null });
  }

  /** One pull request (GitHub) or the protected merge of the head job (plain git) — then `ready`. */
  async #publish(i: IntRow): Promise<void> {
    if (i.head_sha === null || i.head_job_id === null) throw new NeedsHuman('nothing to publish');
    const pc = await this.#provider(i);
    const body = await this.#prBody(i);
    // p15-job-titles: a coordinator's integration PR is named by the coordinator job's title.
    const rootTitle =
      i.source === 'coordinator' && i.root_job_id !== null
        ? await jobTitle(this.deps.pool, i.root_job_id)
        : null;
    const title =
      rootTitle === null
        ? prTitle({ branches: await this.#branches(i.id), targetBranch: i.target_branch })
        : pullRequestTitle(rootTitle);
    let pr: { number: number; url: string } | null =
      i.pr_number === null ? null : { number: i.pr_number, url: i.pr_url ?? '' };
    if (pr === null) {
      pr = await pc.ensurePullRequest({ headBranch: i.branch, targetBranch: i.target_branch, title, body });
    } else if (pc.updatePullRequest !== undefined) {
      await pc.updatePullRequest(pr, { title, body });
    }
    // The head job's protected merge merges the integration: its PR is the integration's PR, and its merge checks
    // compare against the integration's base on the target (the job itself started at an integration head that the
    // target never contained).
    await this.deps.pool.query(
      `UPDATE job_git SET pr_number = COALESCE($2, pr_number), pr_url = COALESCE($3, pr_url), base_sha = $4,
              target_branch = $5, merge_checked_at = NULL, updated_at = $6
        WHERE job_id = $1`,
      [i.head_job_id, pr?.number ?? null, pr?.url ?? null, i.base_sha, i.target_branch, this.deps.clock()],
    );
    await this.deps.gitflow()?.refresh(i.head_job_id, { force: true });
    await this.#set(i.id, {
      state: 'ready',
      pr_number: pr?.number ?? null,
      pr_url: pr?.url ?? null,
      current_job_id: null,
      reason: null,
    });
    await this.#note(
      i.id,
      pr === null
        ? `Ready: merge ${i.branch} with the protected merge of job ${i.head_job_id.slice(0, 8)} (Changes panel).`
        : `Ready: pull request #${String(pr.number)} (${i.branch} → ${i.target_branch}).`,
    );
    await this.deps.audit.record({
      actor: ACTOR,
      action: 'integration.publish',
      target: `integration:${i.id}`,
      outcome: 'success',
      metadata: {
        project: i.project,
        branch: i.branch,
        head: i.head_sha,
        pr: pr?.number ?? null,
        mergeJobId: i.head_job_id,
      },
    });
  }

  /** `ready`: did the integration land (protected merge of the head job, or the PR merged on the provider)? */
  async #onReady(i: IntRow): Promise<void> {
    const now = this.deps.clock().getTime();
    const last = this.#lastPoll.get(i.id) ?? 0;
    const jg = i.head_job_id === null ? null : await loadJobGit(this.deps.pool, i.head_job_id);
    let mergedSha = jg?.mergedSha ?? null;
    if (mergedSha === null) {
      if (now - last < this.#timing.readyPollMs) return;
      this.#lastPoll.set(i.id, now);
      if (i.head_sha === null) return;
      const pc = await this.#provider(i);
      const target = await pc.branchHead(i.target_branch);
      if (target !== null && (target === i.head_sha || (await descends(pc, i.head_sha, target))))
        mergedSha = target;
      else {
        const at = await pc.branchHead(i.branch);
        if (at !== i.head_sha) {
          throw new NeedsHuman(`${i.branch} was changed outside the platform (now ${at ?? 'deleted'})`);
        }
        return;
      }
    }
    this.#lastPoll.delete(i.id);
    await this.#stop(i, 'merged', `Merged into ${i.target_branch} at ${mergedSha.slice(0, 12)}.`);
    await this.deps.pool.query('UPDATE integrations SET merged_at = $2 WHERE id = $1', [
      i.id,
      this.deps.clock(),
    ]);
    await this.#settled({ ...i, state: 'merged' }, mergedSha);
  }

  /**
   * After the merge: the members' and the integration's own jobs that still wait for a decision are approved by the
   * person who approved the integration's merge (their changes are in), and their git records name the merge.
   * Without a known approver (merged on the provider directly) they are left for a person.
   */
  async #settled(i: IntRow, mergedSha?: string): Promise<void> {
    const approver =
      i.head_job_id === null
        ? null
        : ((
            await this.deps.pool.query<{ approved_by: string | null }>(
              `SELECT approved_by::text AS approved_by FROM git_merge_requests
                WHERE job_id = $1 AND status = 'merged' ORDER BY executed_at DESC NULLS LAST LIMIT 1`,
              [i.head_job_id],
            )
          ).rows[0]?.approved_by ?? null);
    const { rows } = await this.deps.pool.query<{ job_id: string }>(
      `SELECT job_id::text AS job_id FROM integration_branches WHERE integration_id = $1
       UNION SELECT job_id::text FROM integration_jobs WHERE integration_id = $1 AND kind <> 'verify'`,
      [i.id],
    );
    for (const r of rows) {
      if (r.job_id === i.head_job_id) continue;
      if (mergedSha !== undefined) {
        await this.deps.pool.query(
          `UPDATE job_git SET merged_sha = COALESCE(merged_sha, $2), merged_at = COALESCE(merged_at, $3), updated_at = $3
            WHERE job_id = $1`,
          [r.job_id, mergedSha, this.deps.clock()],
        );
      }
      if (approver === null) continue;
      await this.#transition(
        r.job_id,
        'approval_granted',
        { type: 'user', id: approver },
        `integrated through ${i.branch} (integration ${i.id}), merged by the approved integration merge`,
      );
    }
  }

  // ------------------------------------------------------------------------------------------- jobs

  /** The coordinator's (or the integrator step's) stored spec: the policy every job of the integration inherits. */
  async #policySpec(i: IntRow): Promise<JobSpec> {
    if (i.root_job_id !== null) {
      const root = await this.deps.jobs.get(i.root_job_id);
      if (root === null) throw new NeedsHuman('the coordinator job no longer exists');
      return root.spec;
    }
    const { rows } = await this.deps.pool.query<{ job_spec: JobSpec }>(
      // p14-workflow-engine: an engine-2 step keeps its spec on its node run.
      `SELECT job_spec FROM workflow_nodes WHERE run_id = $1 AND node_id = $2
       UNION ALL
       (SELECT input->'spec' FROM workflow_node_runs WHERE run_id = $1 AND node_id = $2 AND scope = ''
         ORDER BY attempt DESC LIMIT 1)`,
      [i.run_id, i.node_id],
    );
    const spec = rows[0]?.job_spec;
    if (spec === undefined) throw new NeedsHuman('the workflow step no longer exists');
    return spec;
  }

  /** A resolution / fix job: the coordinator's runtime, model, sandbox, approval policy and trust; no secrets. */
  async #agentSpec(i: IntRow, prompt: string, workBranch: string): Promise<Record<string, unknown>> {
    const p = await this.#policySpec(i);
    const l = p.limits;
    return {
      runtime: p.runtime,
      ...(p.model === undefined ? {} : { model: p.model }),
      prompt,
      repository: { url: i.repository_url, baseRef: i.head_sha ?? i.base_sha, workBranch },
      sandboxProfile: p.sandboxProfile,
      approvalPolicy: p.approvalPolicy,
      ...(p.sourceTrust === undefined ? {} : { sourceTrust: p.sourceTrust }),
      limits: {
        maxDurationSec: Math.max(60, Math.min(l.maxDurationSec, this.#timing.agentMaxDurationSec)),
        ...(l.maxTokens === undefined ? {} : { maxTokens: l.maxTokens }),
        ...(l.maxTurns === undefined ? {} : { maxTurns: l.maxTurns }),
        ...(l.maxCostUsd === undefined ? {} : { maxCostUsd: l.maxCostUsd }),
      },
      ...(p.requirements?.tools === undefined ? {} : { requirements: { tools: p.requirements.tools } }),
      role: 'execute',
    };
  }

  /**
   * Creates a job of the integration as the person it acts for (re-authorised now), records it and its git target
   * (the integration's target branch — the job checks out a sha) in the creation transaction, and dispatches it.
   */
  async #createJob(
    i: IntRow,
    kind: IntegrationJobKind,
    round: number,
    spec: Record<string, unknown>,
    position: number | null,
  ): Promise<string> {
    if (!(await mayCreateJobs(this.deps.pool, i.created_by, i.project))) {
      throw new NeedsHuman('the person the integration acts for may no longer create jobs in this project');
    }
    const flow = this.deps.gitflow();
    const pc = flow === null ? null : await flow.providerFor(i.project);
    if (pc === null) throw new NeedsHuman('the project has no git configuration any more');
    const priority = await this.#priority(i);
    try {
      const { job } = await this.deps.jobs.create({
        project: i.project,
        spec,
        priority,
        actor: { type: 'user', id: i.created_by },
        submit: true,
        ...(kind === 'integrate' ? { integration: true } : {}),
        withinCreate: async (tx, jobId) => {
          await tx.query(
            `INSERT INTO integration_jobs (job_id, integration_id, kind, round, branch_position, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [jobId, i.id, kind, round, position, this.deps.clock()],
          );
          // p11-fixes-a: the verifier only reports (a site-bundle artifact) — no git flow, no commit, no approval.
          if (kind === 'verify') {
            await markReportOnly(tx, jobId, 'integration-verify', this.deps.clock(), i.root_job_id);
            return;
          }
          await tx.query(
            `INSERT INTO job_git (job_id, project, provider, target_branch, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT (job_id) DO UPDATE SET target_branch = EXCLUDED.target_branch`,
            [jobId, i.project, pc.config.provider, i.target_branch, this.deps.clock()],
          );
        },
      });
      void this.deps.dispatch(job.id).catch(() => undefined);
      await this.deps.audit.record({
        actor: ACTOR,
        action: 'integration.job.create',
        target: `integration:${i.id}`,
        outcome: 'success',
        metadata: { project: i.project, jobId: job.id, kind, round, createdFor: i.created_by },
      });
      return job.id;
    } catch (err) {
      if (err instanceof JobStoreError) {
        throw new NeedsHuman(`the ${kind} job could not be created (${err.message})`);
      }
      throw err;
    }
  }

  async #priority(i: IntRow): Promise<number> {
    if (i.root_job_id === null) return 0;
    const { rows } = await this.deps.pool.query<{ priority: number }>(
      'SELECT priority FROM jobs WHERE id = $1',
      [i.root_job_id],
    );
    return rows[0]?.priority ?? 0;
  }

  async #jobCount(id: string, kind: IntegrationJobKind): Promise<number> {
    const { rows } = await this.deps.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM integration_jobs WHERE integration_id = $1 AND kind = $2',
      [id, kind],
    );
    return rows[0]?.n ?? 0;
  }

  /** A job of the integration that git flow verified (head on the remote, trailer, ancestry) — or why not. */
  async #finished(jobId: string): Promise<Finished> {
    const job = await this.deps.jobs.get(jobId);
    if (job === null) return { kind: 'failed', reason: 'no longer exists' };
    if (job.state === 'FAILED' || job.state === 'CANCELLED') {
      return { kind: 'failed', reason: job.state === 'FAILED' ? 'failed' : 'was cancelled' };
    }
    if (job.state !== 'AWAITING_APPROVAL' && job.state !== 'SUCCEEDED') return { kind: 'pending' };
    const jg = await loadJobGit(this.deps.pool, jobId);
    if (jg?.verification !== 'passed' || jg.headSha === null || jg.branch === null) {
      return { kind: 'failed', reason: 'finished without a verified result' };
    }
    return {
      kind: 'ok',
      job,
      head: jg.headSha,
      branch: jg.branch,
      changed: job.state === 'AWAITING_APPROVAL',
    };
  }

  async #report(job: JobRecord): Promise<IntegrationReport | null> {
    const { rows } = await this.deps.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      `SELECT content, blob_key FROM job_artifacts WHERE job_id = $1 AND kind = 'integration'
          AND ($2::uuid IS NULL OR attempt_id = $2::uuid) ORDER BY created_at DESC LIMIT 1`,
      [job.id, job.currentAttemptId],
    );
    // p17-object-storage: the report's bytes may be in the blob store.
    const c = rows[0] === undefined ? null : await rowContent(rows[0], 16 * 1024 * 1024);
    if (c === null) return null;
    try {
      const parsed = IntegrationReport.safeParse(JSON.parse(c.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async #provider(i: IntRow): Promise<GitProvider> {
    const flow = this.deps.gitflow();
    const pc = flow === null ? null : await flow.providerFor(i.project);
    if (pc === null) throw new NeedsHuman('the project has no git configuration any more');
    return pc.provider;
  }

  async #transition(
    jobId: string,
    trigger: 'cancel_requested' | 'approval_granted',
    actor: { type: 'user' | 'system'; id: string },
    reason: string,
  ): Promise<void> {
    for (let n = 0; n < 3; n++) {
      try {
        const job = await this.deps.jobs.get(jobId);
        if (job === null || TERMINAL_JOB.has(job.state) || job.state === 'CANCELLING') return;
        if (trigger === 'approval_granted' && job.state !== 'AWAITING_APPROVAL') return;
        const { job: next } = await this.deps.jobs.transition(jobId, trigger, {
          actor,
          reason: clip(reason, 1000),
        });
        if (next.state === 'CANCELLING') await this.deps.cancel().sendCancel(next, reason);
        return;
      } catch (err) {
        if (err instanceof JobStoreError) continue;
        throw err;
      }
    }
  }

  async #prBody(i: IntRow): Promise<string> {
    const branches = await this.#branches(i.id);
    const facts = await this.deps.pool.query<{ id: string; runtime: string | null; machine: string | null }>(
      `SELECT j.id::text AS id, j.spec->>'runtime' AS runtime,
              (SELECT COALESCE(w.display_name, w.id) FROM job_runs r JOIN workers w ON w.id = r.worker_id
                WHERE r.attempt_id = j.current_attempt_id) AS machine
         FROM jobs j WHERE j.id = ANY($1::uuid[])`,
      [branches.map((b) => b.job_id)],
    );
    const by = new Map(facts.rows.map((r) => [r.id, r]));
    const fresh = (await this.#row(i.id)) ?? i;
    return redactor.redact(
      prBody({
        integrationId: i.id,
        source: i.source,
        rootJobId: i.root_job_id,
        runId: i.run_id,
        branch: i.branch,
        targetBranch: i.target_branch,
        branches: branches.map((b) => ({
          position: b.position,
          title: b.title,
          jobId: b.job_id,
          runtime: by.get(b.job_id)?.runtime ?? null,
          machine: by.get(b.job_id)?.machine ?? null,
          branch: b.branch,
          state: b.state,
          conflictFiles: b.conflict_files,
          resolutionJobId: b.resolution === null ? null : b.resolution.jobId,
        })),
        log: fresh.log,
        verification:
          fresh.verification === null
            ? null
            : {
                state: fresh.verification.state,
                summary: fresh.verification.summary,
                checks: fresh.verification.checks,
                jobId: fresh.verification.jobId,
              },
        resolutionRounds: fresh.resolution_rounds,
        fixRounds: fresh.fix_rounds,
      }),
    );
  }

  // ------------------------------------------------------------------------------------------- human actions

  async cancel(id: string, actor: { readonly id: string }, reason: string): Promise<IntegrationView> {
    const i = await this.#row(id);
    if (i === null) throw new HttpError(404, 'integration_not_found', 'Integration not found.');
    if (!OPEN_STATES.includes(i.state) && i.state !== 'needs_human') {
      throw new HttpError(409, 'not_open', 'The integration has already ended.');
    }
    await this.#set(id, {
      state: 'cancelled',
      reason: clip(`cancelled: ${reason}`, 1000),
      current_job_id: null,
    });
    await this.#note(id, `Cancelled by a person: ${clip(oneLine(reason), 300)}.`);
    if (i.current_job_id !== null) {
      await this.#transition(
        i.current_job_id,
        'cancel_requested',
        { type: 'user', id: actor.id },
        'integration cancelled',
      );
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.id },
      action: 'integration.cancel',
      target: `integration:${id}`,
      outcome: 'success',
      metadata: { project: i.project, reason: clip(reason, 300), state: i.state },
    });
    return (await this.view(id)) as IntegrationView;
  }

  async retry(id: string, actor: { readonly id: string }): Promise<IntegrationView> {
    const i = await this.#row(id);
    if (i === null) throw new HttpError(404, 'integration_not_found', 'Integration not found.');
    if (i.state !== 'needs_human') {
      throw new HttpError(
        409,
        'not_retryable',
        'Only an integration that stopped for a person can be retried.',
      );
    }
    if (i.head_sha !== null) {
      const at = await (await this.#provider(i)).branchHead(i.branch);
      if (at !== i.head_sha) {
        throw new HttpError(
          409,
          'not_retryable',
          `${i.branch} is at ${at ?? '(deleted)'}, not where the integration left it; start a new integration instead.`,
          {},
          {},
          { reason: 'moved', branch: i.branch, at: at ?? '(deleted)' },
        );
      }
    }
    await this.#set(id, {
      state: 'merging',
      reason: null,
      resolution_rounds: 0,
      fix_rounds: 0,
      current_job_id: null,
    });
    await this.#note(id, 'Retried by a person (round limits reset).');
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.id },
      action: 'integration.retry',
      target: `integration:${id}`,
      outcome: 'success',
      metadata: { project: i.project },
    });
    const fresh = await this.#row(id);
    if (fresh !== null) {
      await this.#guard(fresh, async () => {
        const branches = await this.#branches(id);
        const conflicted = branches.find((b) => b.state === 'conflict' && b.resolution === null);
        if (conflicted !== undefined) await this.#startResolution(fresh, conflicted.position);
        else await this.#startRound(fresh);
      });
    }
    return (await this.view(id)) as IntegrationView;
  }

  // ------------------------------------------------------------------------------------------- views

  async forJob(jobId: string): Promise<IntegrationView | null> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM integrations WHERE root_job_id = $1
       UNION SELECT integration_id::text FROM integration_branches WHERE job_id = $1
       UNION SELECT integration_id::text FROM integration_jobs WHERE job_id = $1
       LIMIT 1`,
      [jobId],
    );
    return rows[0] === undefined ? null : this.view(rows[0].id);
  }

  async forRun(runId: string): Promise<IntegrationView | null> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM integrations WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1',
      [runId],
    );
    return rows[0] === undefined ? null : this.view(rows[0].id);
  }

  /** The project of an integration (route authorisation). */
  async projectOf(id: string): Promise<string | null> {
    const i = await this.#row(id);
    return i?.project ?? null;
  }

  async view(id: string): Promise<IntegrationView | null> {
    const i = await this.#row(id);
    if (i === null) return null;
    const branches = await this.#branches(id);
    const jobs = await this.deps.pool.query<{
      job_id: string;
      kind: IntegrationJobKind;
      round: number;
      state: string;
      created_at: Date;
    }>(
      `SELECT ij.job_id::text AS job_id, ij.kind, ij.round, j.state::text AS state, ij.created_at
         FROM integration_jobs ij JOIN jobs j ON j.id = ij.job_id WHERE ij.integration_id = $1 ORDER BY ij.seq`,
      [id],
    );
    const states = new Map(jobs.rows.map((r) => [r.job_id, r.state]));
    return {
      id: i.id,
      project: i.project,
      source: i.source,
      rootJobId: i.root_job_id,
      runId: i.run_id,
      nodeId: i.node_id,
      branch: i.branch,
      targetBranch: i.target_branch,
      baseSha: i.base_sha,
      headSha: i.head_sha,
      orderMode: i.order_mode,
      state: i.state,
      reason: i.reason,
      resolutionRounds: i.resolution_rounds,
      maxResolutions: i.max_resolutions,
      fixRounds: i.fix_rounds,
      maxFixes: i.max_fixes,
      branches: branches.map((b) => ({
        position: b.position,
        jobId: b.job_id,
        title: b.title,
        branch: b.branch,
        sha: b.sha,
        paths: b.paths,
        state: b.state,
        mergedSha: b.merged_sha,
        conflictFiles: b.conflict_files,
        resolutionJobId: b.resolution_job_id,
        resolutionJobState: b.resolution_job_id === null ? null : (states.get(b.resolution_job_id) ?? null),
        detail: b.detail,
      })),
      jobs: jobs.rows.map((r) => ({
        jobId: r.job_id,
        kind: r.kind,
        round: r.round,
        state: r.state,
        createdAt: r.created_at.toISOString(),
      })),
      warnings: i.warnings,
      verification: i.verification,
      pullRequest: i.pr_number === null ? null : { number: i.pr_number, url: i.pr_url ?? '' },
      mergeJobId: i.state === 'ready' ? i.head_job_id : null,
      log: i.log,
      createdAt: i.created_at.toISOString(),
      updatedAt: i.updated_at.toISOString(),
    };
  }
}

/** `ancestor` is contained in `head` (identical or `head` descends from it). */
async function descends(provider: GitProvider, ancestor: string, head: string): Promise<boolean> {
  if (ancestor === head) return true;
  const c = await provider.compare(ancestor, head);
  return c.status === 'ahead' || c.status === 'identical';
}

function humanState(s: IntegrationState): string {
  return s === 'needs_human'
    ? 'Needs a human'
    : s === 'failed'
      ? 'Failed'
      : s === 'cancelled'
        ? 'Cancelled'
        : s;
}
