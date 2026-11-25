import { randomUUID } from 'node:crypto';
import {
  ApprovalPolicy,
  JobSpec,
  MAX_THREAD_PROJECTS,
  normalizeJobTitle,
  PRIORITY_CLASS_VALUE,
  PriorityClass,
  RuntimeKind,
  SandboxProfile,
} from '@remyral/protocol';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { projectKind } from '../workspaces/service.js';

/**
 * p18-multi-project W5 (docs/design/p18-multi-project.md §2.4, "Built: W3 + W5"): **job fan-out batches** — "aynı işi şu
 * projelerde yap" becomes one ORDINARY job per selected project ("Her projeye ayrı iş"), grouped as a batch.
 *
 * Each job is built and submitted exactly like a single job of its project: the project's repository (or its
 * workspace), its defaults (sandbox, approval policy, limits — the composer's ProjectDefaults), its policy, egress,
 * credentials, quotas, approvals, merge pipeline and deploys. Nothing is aggregated: the submitter is authorized
 * per project (`jobs.create` = `jobs.batch`), a project is refused at submit with a reason instead of a job:
 *
 * - `not_found` (not visible) / `forbidden` (no operator role);
 * - `project_held` (the quota kill switch), `budget_exceeded` (a project / global budget at 100 %) — from the same
 *   side-effect-free admission preview the composer uses (concurrency limits only make a job wait, never refuse it);
 * - `repository_missing` (a repository project without a registered repository);
 * - `full_access_not_allowed` (allow-all / unconfined asked where the project does not allow it, ADR-0020);
 * - `invalid_job` (the job store refused the spec).
 *
 * Coordinated cross-repository changes stay out of scope (one job never touches two repositories). Audit:
 * `job.batch.submit` (batch id, projects, created / refused codes — never the prompt).
 */

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** The shared part of a batch (one prompt + the settings every job takes unless its project's defaults fill them). */
export const BatchBase = z.strictObject({
  title: z.string().min(1).max(200),
  prompt: z
    .string()
    .min(1)
    .max(32 * 1024),
  runtime: RuntimeKind,
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/)
    .optional(),
  sandboxProfile: SandboxProfile.optional(),
  approvalPolicy: ApprovalPolicy.optional(),
  maxDurationSec: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 3600)
    .optional(),
});
export type BatchBase = z.infer<typeof BatchBase>;

/** Per-project additions: extra instructions appended to the prompt, the branch to start from. */
export const BatchPerProject = z.record(
  z.string().regex(PROJECT),
  z.strictObject({
    prompt: z.string().min(1).max(4096).optional(),
    baseRef: z.string().min(1).max(255).optional(),
  }),
);
export type BatchPerProject = z.infer<typeof BatchPerProject>;

export const BatchRequest = z.strictObject({
  projects: z.array(z.string().regex(PROJECT)).min(1).max(MAX_THREAD_PROJECTS),
  spec: BatchBase,
  perProject: BatchPerProject.optional(),
  priorityClass: PriorityClass.optional(),
});
export type BatchRequest = z.infer<typeof BatchRequest>;

export type BatchRefusalCode =
  | 'not_found'
  | 'forbidden'
  | 'project_held'
  | 'budget_exceeded'
  | 'repository_missing'
  | 'full_access_not_allowed'
  | 'invalid_job';

export interface BatchRefusal {
  readonly project: string;
  readonly code: BatchRefusalCode;
  readonly message: string;
}

export interface BatchReady {
  readonly project: string;
  readonly name: string;
  readonly kind: 'repository' | 'workspace';
  readonly spec: Record<string, unknown>;
  /** Fields the project's defaults filled. */
  readonly filled: readonly string[];
  /** Admission notes that only make the job wait (a concurrency limit …). */
  readonly waits: readonly string[];
}

export interface BatchPlan {
  readonly ready: readonly BatchReady[];
  readonly refused: readonly BatchRefusal[];
}

export interface BatchMemberView {
  readonly project: string;
  readonly position: number;
  readonly jobId: string | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  /** Null when the caller cannot read the job's project (hidden). */
  readonly job: {
    readonly title: string | null;
    readonly state: string;
    readonly costUsd: number | null;
    readonly pullRequest: string | null;
    readonly link: string;
  } | null;
}

export interface BatchView {
  readonly id: string;
  readonly title: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly source: 'console' | 'chat';
  readonly threadId: string | null;
  readonly prompt: string;
  readonly runtime: string;
  readonly members: readonly BatchMemberView[];
  readonly counts: {
    readonly total: number;
    readonly created: number;
    readonly refused: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly running: number;
  };
  readonly costUsd: number | null;
  /** done = every created job ended; failed = at least one ended without success; else running. */
  readonly state: 'running' | 'done' | 'failed' | 'refused';
}

export interface JobBatchDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  /** The job store's create (DRAFT → QUEUED in one transaction). */
  readonly createJob: (input: {
    project: string;
    spec: Record<string, unknown>;
    priority: number;
    actor: { type: 'user'; id: string };
  }) => Promise<{ id: string }>;
  /** Placement after the commit (failures only delay it). */
  readonly dispatch?: (jobId: string) => Promise<unknown>;
  /** The project's defaults like the composer (sandbox, approval policy, limits); absent: the spec as given. */
  readonly applyDefaults?: (
    project: string,
    spec: Record<string, unknown>,
  ) => Promise<{ spec: Record<string, unknown>; filled: readonly string[] }>;
  /** The composer's side-effect-free admission preview (holds); absent: nothing is held. */
  readonly holds?: (
    project: string,
    runtime: string,
  ) => Promise<readonly { readonly code: string; readonly message: string }[]>;
}

/** The repository URL of a built job spec (null: a workspace job). */
export function specRepositoryUrl(spec: Record<string, unknown>): string | null {
  const r = spec.repository;
  if (typeof r !== 'object' || r === null) return null;
  const url = (r as { url?: unknown }).url;
  return typeof url === 'string' ? url : null;
}

/** `{{project.id}}` / `{{project.name}}` in the batch prompt, and the project's extra instructions appended. */
export function projectPrompt(
  base: string,
  project: { readonly id: string; readonly name: string },
  extra: string | undefined,
): string {
  const text = base
    .replace(/\{\{\s*project\.id\s*\}\}/gu, project.id)
    .replace(/\{\{\s*project\.name\s*\}\}/gu, project.name);
  return extra === undefined ? text : `${text}\n\n${extra}`;
}

const ENDED_OK = new Set(['SUCCEEDED']);
const ENDED_BAD = new Set(['FAILED', 'CANCELLED']);

/** The batch's overall state from its members' job states (pure; the page and the plan link use it). */
export function batchState(
  members: readonly { readonly jobId: string | null; readonly state: string | null }[],
): { state: BatchView['state']; succeeded: number; failed: number; running: number } {
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let created = 0;
  for (const m of members) {
    if (m.jobId === null) continue;
    created += 1;
    if (m.state !== null && ENDED_OK.has(m.state)) succeeded += 1;
    else if (m.state !== null && ENDED_BAD.has(m.state)) failed += 1;
    else running += 1;
  }
  const state: BatchView['state'] =
    created === 0 ? 'refused' : running > 0 ? 'running' : failed > 0 ? 'failed' : 'done';
  return { state, succeeded, failed, running };
}

export class JobBatchService {
  constructor(private readonly deps: JobBatchDeps) {}

  #now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }

  /**
   * Preflight (no side effects): per project the job it would submit, or why not. The order of `projects` is kept;
   * duplicates count once.
   */
  async plan(subject: Subject, request: BatchRequest, db: Queryable = this.deps.pool): Promise<BatchPlan> {
    const projects = [...new Set(request.projects)];
    const { rows } = await db.query<{
      id: string;
      name: string;
      kind: 'repository' | 'workspace';
      host_execution: boolean;
      unconfined_execution: boolean;
      auto_approve_execution: boolean;
      repository_url: string | null;
      base_branch: string | null;
    }>(
      `SELECT p.id, p.name, p.kind, p.host_execution, p.unconfined_execution, p.auto_approve_execution,
              g.repository_url, g.base_branch
         FROM projects p LEFT JOIN project_git_configs g ON g.project = p.id
        WHERE p.id = ANY($1::text[])`,
      [projects],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ready: BatchReady[] = [];
    const refused: BatchRefusal[] = [];
    const base = request.spec;
    for (const project of projects) {
      const p = byId.get(project);
      const decision = authorize(subject, 'jobs.create', { project });
      if (p === undefined || (!decision.allow && decision.reason === 'not_visible')) {
        refused.push({ project, code: 'not_found', message: 'Project not found.' });
        continue;
      }
      if (!decision.allow) {
        refused.push({
          project,
          code: 'forbidden',
          message: 'You cannot create jobs in this project (operator role needed).',
        });
        continue;
      }
      const missing = [
        base.approvalPolicy === 'allow-all' && !p.auto_approve_execution
          ? 'auto-approve ("Never ask")'
          : null,
        base.sandboxProfile === 'unconfined' && !p.unconfined_execution ? 'the unconfined profile' : null,
      ].filter((x): x is string => x !== null);
      if (missing.length > 0) {
        refused.push({
          project,
          code: 'full_access_not_allowed',
          message: `Project ${project} does not allow ${missing.join(' or ')}.`,
        });
        continue;
      }
      const kind = (await projectKind(db, project)) ?? p.kind;
      if (kind === 'repository' && (p.repository_url === null || p.base_branch === null)) {
        refused.push({
          project,
          code: 'repository_missing',
          message: `Project ${project} has no registered repository (Projects → Git).`,
        });
        continue;
      }
      const holds = (await this.deps.holds?.(project, base.runtime)) ?? [];
      const held = holds.find((h) => h.code === 'project_hold');
      if (held !== undefined) {
        refused.push({ project, code: 'project_held', message: held.message });
        continue;
      }
      const budget = holds.find((h) => h.code === 'budget_exceeded' || h.code === 'budget_incomplete');
      if (budget !== undefined) {
        refused.push({ project, code: 'budget_exceeded', message: budget.message });
        continue;
      }
      const per = request.perProject?.[project];
      const title = normalizeJobTitle(base.title);
      const common: Record<string, unknown> = {
        projectId: project,
        runtime: base.runtime,
        ...(base.model === undefined ? {} : { model: base.model }),
        prompt: projectPrompt(base.prompt, { id: project, name: p.name }, per?.prompt),
        ...(title === null ? {} : { title }),
        ...(base.sandboxProfile === undefined ? {} : { sandboxProfile: base.sandboxProfile }),
        ...(base.approvalPolicy === undefined ? {} : { approvalPolicy: base.approvalPolicy }),
        limits: base.maxDurationSec === undefined ? {} : { maxDurationSec: base.maxDurationSec },
        // The batch's prompt comes from the authenticated submitter; the project's own repository is trusted source.
        sourceTrust: 'trusted',
      };
      let spec: Record<string, unknown> =
        kind === 'workspace'
          ? common
          : {
              ...common,
              repository: {
                url: p.repository_url,
                baseRef: per?.baseRef ?? p.base_branch,
                workBranch: `agent/batch-${randomUUID().slice(0, 8)}`,
              },
            };
      let filled: readonly string[] = [];
      if (this.deps.applyDefaults !== undefined) {
        const applied = await this.deps.applyDefaults(project, spec);
        spec = applied.spec;
        filled = applied.filled;
      }
      if (kind === 'repository') {
        const check = JobSpec.safeParse(spec);
        if (!check.success) {
          refused.push({
            project,
            code: 'invalid_job',
            message: `The job would be refused: ${check.error.issues
              .slice(0, 5)
              .map((x) => `${x.path.join('.')} ${x.code}`)
              .join('; ')}`.slice(0, 500),
          });
          continue;
        }
      }
      ready.push({
        project,
        name: p.name,
        kind,
        spec,
        filled,
        waits: holds.map((h) => h.message).slice(0, 5),
      });
    }
    return { ready, refused };
  }

  /**
   * Preflight again (for the submitting user, now) and create one job per allowed project. The batch row and its
   * members are written even when every project was refused (the page shows why). Jobs are created one by one, each in
   * its own transaction (one project's failure never undoes another's job); the refusal of a failed create is kept.
   */
  async submit(
    subject: Subject,
    request: BatchRequest,
    source: {
      readonly kind: 'console' | 'chat';
      readonly threadId?: string | null;
      readonly draftId?: string | null;
      readonly ip?: string | null;
      readonly userAgent?: string | null;
    },
  ): Promise<{ batchId: string; created: { project: string; jobId: string }[]; refused: BatchRefusal[] }> {
    const parsed = BatchRequest.safeParse(request);
    if (!parsed.success)
      throw new HttpError(400, 'bad_request', 'Invalid batch.', {}, {}, { reason: 'batch' });
    const req = parsed.data;
    const plan = await this.plan(subject, req);
    const batchId = randomUUID();
    const now = this.#now();
    const priority = PRIORITY_CLASS_VALUE[req.priorityClass ?? 'normal'];
    await this.deps.pool.query(
      `INSERT INTO job_batches (id, created_by, title, spec, source, thread_id, draft_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        batchId,
        subject.userId,
        normalizeJobTitle(req.spec.title) ?? req.spec.title.slice(0, 200),
        JSON.stringify({
          ...req.spec,
          ...(req.perProject === undefined ? {} : { perProject: req.perProject }),
        }),
        source.kind,
        source.threadId ?? null,
        source.draftId ?? null,
        now,
      ],
    );
    const created: { project: string; jobId: string }[] = [];
    const refused: BatchRefusal[] = [...plan.refused];
    const order = [...new Set(req.projects)];
    for (const r of plan.ready) {
      try {
        const job = await this.deps.createJob({
          project: r.project,
          spec: r.spec,
          priority,
          actor: { type: 'user', id: subject.userId },
        });
        created.push({ project: r.project, jobId: job.id });
      } catch (err) {
        refused.push({
          project: r.project,
          code: 'invalid_job',
          message: (err instanceof Error ? err.message : 'The job was refused.').slice(0, 500),
        });
      }
    }
    await withTransaction(this.deps.pool, async (tx) => {
      for (const c of created)
        await tx.query(
          `INSERT INTO job_batch_members (batch_id, project, position, job_id) VALUES ($1, $2, $3, $4)`,
          [batchId, c.project, order.indexOf(c.project), c.jobId],
        );
      for (const f of refused)
        await tx.query(
          `INSERT INTO job_batch_members (batch_id, project, position, refusal) VALUES ($1, $2, $3, $4)
           ON CONFLICT (batch_id, project) DO NOTHING`,
          [
            batchId,
            f.project,
            Math.max(0, order.indexOf(f.project)),
            JSON.stringify({ code: f.code, message: f.message }),
          ],
        );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: subject.userId },
          action: 'job.batch.submit',
          target: `job-batch:${batchId}`,
          outcome: created.length > 0 ? 'success' : 'denied',
          ip: source.ip ?? null,
          userAgent: source.userAgent ?? null,
          metadata: {
            source: source.kind,
            ...(source.threadId == null ? {} : { threadId: source.threadId }),
            ...(source.draftId == null ? {} : { draftId: source.draftId }),
            projects: order,
            created: created.map((c) => ({ project: c.project, jobId: c.jobId })),
            // `reason`, not `code`: the audit redactor masks a `code` key as a secret.
            refused: refused.map((f) => ({ project: f.project, reason: f.code })),
          },
        },
        tx,
      );
    });
    for (const c of created) void this.deps.dispatch?.(c.jobId).catch(() => undefined);
    return { batchId, created, refused };
  }

  /** The batch page: the submitter's own batch (owners / admins see every batch). */
  async get(subject: Subject, id: string): Promise<BatchView> {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new HttpError(404, 'batch_not_found', 'Batch not found.');
    const { rows } = await this.deps.pool.query<{
      id: string;
      title: string;
      created_by: string;
      created_at: Date;
      source: 'console' | 'chat';
      thread_id: string | null;
      spec: Record<string, unknown>;
    }>('SELECT id, title, created_by, created_at, source, thread_id, spec FROM job_batches WHERE id = $1', [
      id,
    ]);
    const b = rows[0];
    if (
      b === undefined ||
      (b.created_by !== subject.userId && subject.role !== 'owner' && subject.role !== 'admin')
    )
      throw new HttpError(404, 'batch_not_found', 'Batch not found.');
    return this.#view(subject, b);
  }

  /** The caller's recent batches (newest first). */
  async list(subject: Subject, limit = 20): Promise<BatchView[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      title: string;
      created_by: string;
      created_at: Date;
      source: 'console' | 'chat';
      thread_id: string | null;
      spec: Record<string, unknown>;
    }>(
      `SELECT id, title, created_by, created_at, source, thread_id, spec FROM job_batches
        WHERE created_by = $1 ORDER BY created_at DESC, id LIMIT $2`,
      [subject.userId, Math.min(Math.max(limit, 1), 100)],
    );
    const out: BatchView[] = [];
    for (const b of rows) out.push(await this.#view(subject, b));
    return out;
  }

  /** Member job states of a batch (the plan link's derived status; no access checks — ids only). */
  async states(id: string): Promise<{ jobId: string | null; state: string | null }[]> {
    const { rows } = await this.deps.pool.query<{ job_id: string | null; state: string | null }>(
      `SELECT m.job_id::text AS job_id, j.state FROM job_batch_members m LEFT JOIN jobs j ON j.id = m.job_id
        WHERE m.batch_id = $1`,
      [id],
    );
    return rows.map((r) => ({ jobId: r.job_id, state: r.state }));
  }

  async #view(
    subject: Subject,
    b: {
      id: string;
      title: string;
      created_by: string;
      created_at: Date;
      source: 'console' | 'chat';
      thread_id: string | null;
      spec: Record<string, unknown>;
    },
  ): Promise<BatchView> {
    const { rows } = await this.deps.pool.query<{
      project: string;
      position: number;
      job_id: string | null;
      refusal: { code?: unknown; message?: unknown } | null;
      state: string | null;
      title: string | null;
      cost: string | null;
      pr_url: string | null;
    }>(
      `SELECT m.project, m.position, m.job_id::text AS job_id, m.refusal, j.state, j.spec->>'title' AS title,
              (SELECT sum(u.cost_usd)::text FROM usage_records u WHERE u.job_id = m.job_id) AS cost,
              g.pr_url
         FROM job_batch_members m
         LEFT JOIN jobs j ON j.id = m.job_id
         LEFT JOIN job_git g ON g.job_id = m.job_id
        WHERE m.batch_id = $1
        ORDER BY m.position, m.project`,
      [b.id],
    );
    const members: BatchMemberView[] = rows.map((r) => {
      const visible = authorize(subject, 'jobs.read', { project: r.project }).allow;
      return {
        project: r.project,
        position: r.position,
        jobId: visible ? r.job_id : null,
        refusal:
          r.refusal === null
            ? null
            : {
                code: typeof r.refusal.code === 'string' ? r.refusal.code : 'refused',
                message: typeof r.refusal.message === 'string' ? r.refusal.message : '',
              },
        job:
          r.job_id === null || !visible
            ? null
            : {
                title: r.title,
                state: r.state ?? 'UNKNOWN',
                costUsd: r.cost === null ? null : Number(r.cost),
                pullRequest: r.pr_url,
                link: `/jobs/${r.job_id}`,
              },
      };
    });
    const st = batchState(rows.map((r) => ({ jobId: r.job_id, state: r.state })));
    const costs = members.flatMap((m) => (m.job?.costUsd == null ? [] : [m.job.costUsd]));
    return {
      id: b.id,
      title: b.title,
      createdBy: b.created_by,
      createdAt: b.created_at.toISOString(),
      source: b.source,
      threadId: b.thread_id,
      prompt: typeof b.spec.prompt === 'string' ? b.spec.prompt : '',
      runtime: typeof b.spec.runtime === 'string' ? b.spec.runtime : '',
      members,
      counts: {
        total: rows.length,
        created: rows.filter((r) => r.job_id !== null).length,
        refused: rows.filter((r) => r.job_id === null).length,
        succeeded: st.succeeded,
        failed: st.failed,
        running: st.running,
      },
      costUsd: costs.length === 0 ? null : Math.round(costs.reduce((a, c) => a + c, 0) * 1e6) / 1e6,
      state: st.state,
    };
  }
}
