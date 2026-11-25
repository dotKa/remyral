import { PRIORITY_CLASS_VALUE, PriorityClass } from '@remyral/protocol';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../audit/access.js';
import { requestStepUpFresh, requireStepUp } from '../auth/hooks.js';
import { type Resource, type Subject, visibleProjects } from '../authz/model.js';
import type { WorkflowApprovalView } from '../chat/flow.js';
import { bodyField, param, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { Repository } from './definition.js';
import { type ExprSample, WorkflowError, type WorkflowService } from './engine.js';
import { JOB_CREATE_BODY_LIMIT } from '../orchestration/routes.js';
import { type PreparedInput, projectKind, type WorkspaceService } from '../workspaces/service.js';
import { prepareSubmissionInputs } from '../workspaces/submission.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { MemoryRateLimiter, type RateLimiter } from '../auth/rate-limit.js';
import type { ActivationActor, SaveTriggers, WorkflowTriggerService } from './triggers.js';
import { attachmentOf } from './sharing.js';
import { authorize } from '../authz/model.js';
import { assertRepoInputsReady } from '../jobs/repo-inputs.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
/** p13-workflows-ui: a validation issue (path and code only, never prompt text). */
const Issue = z.object({ path: z.string(), code: z.string() });
/** An `invalid_workflow` 400 carries the issues (the editor marks them on steps and edges). */
const defineErrors = { ...errors, 400: ErrorBody.extend({ issues: z.array(Issue).optional() }) };
/**
 * p16-workflow-quality: what the saved version's trigger nodes do now (`WorkflowTriggerService.afterSave`): re-synced
 * when the workflow's triggers follow the latest version, otherwise a warning that they do not start runs yet.
 */
const SavedTriggers = z.object({
  state: z.enum(['none', 'active', 'inactive', 'not_synced', 'pinned']),
  triggers: z.array(z.object({ nodeId: z.string(), type: z.string() })),
  warning: z.string().nullable(),
  webhookSecrets: z.array(z.object({ nodeId: z.string(), secret: z.string(), url: z.string() })),
});
const Created = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
  triggers: SavedTriggers.optional(),
  /** p18-multi-project: projects that attached the workflow — moved to this version, waiting for their admin, pinned. */
  attachments: z
    .object({ advanced: z.array(z.string()), pending: z.array(z.string()), pinned: z.array(z.string()) })
    .optional(),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * p14-workflow-engine 14.1: a v2 definition (≤ 200 nodes with configs) may be up to 512 KiB of JSON
 * (`V2_LIMITS.maxDefinitionBytes`); the request adds the envelope (`project`, `baseVersion`). Validation refuses a
 * larger document with `too_large` before anything else. Registered in `BODY_LIMIT_EXCEPTIONS`.
 */
export const WORKFLOW_DEFINITION_BODY_LIMIT = 512 * 1024 + 8 * 1024;

/** Per-user budgets of the sandbox routes (§10.3), on top of the write class. */
export const SANDBOX_RATE = {
  evaluate: { max: 60, windowMs: 60_000 },
  test: { max: 20, windowMs: 60_000 },
} as const;

/** Sample data of a preview / test (`$input`, `$node.<id>.<port>`, `$inputs`, `$trigger`, `$item` …). */
const Sample = z
  .object({
    input: z.unknown().optional(),
    node: z.record(z.string().max(48), z.unknown()).optional(),
    inputs: z.record(z.string().max(64), z.unknown()).optional(),
    trigger: z.unknown().optional(),
    item: z.unknown().optional(),
    index: z.number().int().min(0).max(100_000).optional(),
    items: z.unknown().optional(),
    loop: z.unknown().optional(),
    run: z.record(z.string().max(64), z.unknown()).optional(),
  })
  .strict();

function toHttp(err: unknown): unknown {
  if (err instanceof WorkflowError) {
    return new HttpError(
      err.status,
      err.code,
      err.message,
      {},
      err.issues.length > 0 ? { issues: err.issues.map((i) => ({ path: i.path, code: i.code })) } : {},
    );
  }
  return err;
}

/**
 * p14-workflow-engine 14.4: the run-operation refusals (pause / resume / re-run / start) as catalogued HTTP errors
 * (`@remyral/i18n` errors — the console says them in the user's language); anything else as `toHttp`.
 */
function opsHttp(err: unknown): unknown {
  if (!(err instanceof WorkflowError)) return toHttp(err);
  const m = err.message;
  switch (err.code) {
    case 'run_not_active':
      return new HttpError(409, 'run_not_active', m);
    case 'run_not_paused':
      return new HttpError(409, 'run_not_paused', m);
    case 'run_not_finished':
      return new HttpError(409, 'run_not_finished', m);
    case 'rerun_not_supported':
      return new HttpError(409, 'rerun_not_supported', m);
    case 'rerun_node_unknown':
      return new HttpError(400, 'rerun_node_unknown', m);
    case 'rerun_node_in_group':
      return new HttpError(400, 'rerun_node_in_group', m);
    case 'rerun_upstream_incomplete':
      return new HttpError(409, 'rerun_upstream_incomplete', m);
    case 'rerun_data_pruned':
      return new HttpError(409, 'rerun_data_pruned', m);
    case 'rerun_version_mismatch':
      return new HttpError(409, 'rerun_version_mismatch', m);
    case 'concurrency_key_invalid':
      return new HttpError(400, 'concurrency_key_invalid', m);
    default:
      return toHttp(err);
  }
}

async function projectOf(db: Queryable, sql: string, id: string | undefined): Promise<Resource | null> {
  if (id === undefined || !UUID.test(id)) return null;
  const { rows } = await db.query<{ project: string }>(sql, [id]);
  const project = rows[0]?.project;
  return project === undefined ? null : { project };
}

/** Authorization resources (they run before validation: untrusted input, parameterised SQL only). */
export function workflowResource(db: Queryable) {
  return (request: FastifyRequest): Promise<Resource | null> =>
    projectOf(db, 'SELECT project FROM workflow_definitions WHERE id = $1', param(request, 'id'));
}
export function workflowRunResource(db: Queryable) {
  return (request: FastifyRequest): Promise<Resource | null> =>
    projectOf(db, 'SELECT project FROM workflow_runs WHERE id = $1', param(request, 'id'));
}
function queryField(request: FastifyRequest, key: string): string | undefined {
  const q = request.query;
  if (typeof q !== 'object' || q === null) return undefined;
  const v = (q as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * p18-multi-project: the project a request about a workflow acts in — the `project` (query or body; `targetProject`
 * for a copy) when that project attached the workflow, else the owner project. A project that did not attach it (and,
 * with `offered`, was not offered it) gets a 404: the owner's workflow is not visible there.
 */
export function workflowTargetResource(
  db: Queryable,
  opts: { readonly key?: 'project' | 'targetProject'; readonly offered?: boolean } = {},
) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const { rows } = await db.query<{ project: string; name: string }>(
      'SELECT project, name FROM workflow_definitions WHERE id = $1',
      [id],
    );
    const d = rows[0];
    if (d === undefined) return null;
    const key = opts.key ?? 'project';
    const target = queryField(request, key) ?? bodyField(request, key);
    if (target === undefined || target === d.project) return { project: d.project };
    if (!PROJECT.test(target)) return null;
    if ((await attachmentOf(db, target, d.project, d.name)) !== null) return { project: target };
    if (opts.offered === true) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM workflow_shares WHERE owner_project = $1 AND name = $2 AND (project = $3 OR project = '*')`,
        [d.project, d.name, target],
      );
      if ((rowCount ?? 0) > 0) return { project: target };
    }
    return null;
  };
}

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * p4-dag REST (docs/design/p4-dag.md §8). Reads viewer+ (project-scoped), define/start/cancel operator+,
 * gate decisions operator+ with the gate's own approver role and a fresh step-up. All writes audited.
 */
export function workflowRoutes(deps: {
  readonly workflows: WorkflowService;
  readonly db: Queryable;
  readonly clock: () => Date;
  /** p5-research-workspace-next: run files of workspace runs (absent: refused). */
  readonly workspaces?: WorkspaceService;
  /** p14-workflow-engine: per-user budgets of the sandbox routes (default: per-process windows). */
  readonly limiter?: RateLimiter;
  /** p14-workflow-engine 14.2: trigger activation (absent: the activation routes answer 409). */
  readonly triggers?: WorkflowTriggerService;
  /** p17-chat-flow: one approval step as the chat card and "Senden bekleyen" show it (absent: 404). */
  readonly approvals?: () => {
    approvalView(subject: Subject, runId: string, nodeRunId: string): Promise<WorkflowApprovalView | null>;
    /** p17-chat-flow leftover (W4): tell the conversations showing the step's card at once (their stream). */
    approvalDecided?(nodeRunId: string): Promise<number>;
    /** p18-last-gaps: the same for an engine-1 gate (run + node). */
    gateDecided?(runId: string, nodeId: string): Promise<number>;
  } | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['workflows'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'workflow_not_found', 'Workflow not found.');
    const runNotFound = () => new HttpError(404, 'run_not_found', 'Workflow run not found.');
    const limiter = deps.limiter ?? new MemoryRateLimiter();
    /** p14 14.2: who saves (privileged node deltas need `workflows.define.*` and a fresh step-up, §8.5). */
    const access = (request: FastifyRequest) => ({
      subject: authzOf(request).subject,
      stepUpFresh: requestStepUpFresh(request, deps.clock()),
    });
    /** The user acting on a workflow's triggers (activation, re-sync on save, pause on archive). */
    const activationActor = (request: FastifyRequest): ActivationActor => ({
      id: sessionOf(request).user.id,
      subject: authzOf(request).subject,
      stepUpFresh: requestStepUpFresh(request, deps.clock()),
      mfaAt: sessionOf(request).mfaAt,
      ip: request.ip,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
    /** p16-workflow-quality: the trigger outcome of a saved version (absent: no trigger service). */
    const savedTriggers = async (request: FastifyRequest, id: string): Promise<SaveTriggers | undefined> =>
      deps.triggers === undefined ? undefined : deps.triggers.afterSave(activationActor(request), id);
    const limit = async (request: FastifyRequest, bucket: keyof typeof SANDBOX_RATE): Promise<void> => {
      const rule = SANDBOX_RATE[bucket];
      const res = await limiter.hit(
        `workflow-${bucket}`,
        sessionOf(request).user.id,
        rule.max,
        rule.windowMs,
      );
      if (!res.allowed) {
        throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
          'retry-after': String(Math.max(1, Math.ceil(res.retryAfterMs / 1000))),
        });
      }
    };

    r.post(
      '/workflows',
      {
        bodyLimit: WORKFLOW_DEFINITION_BODY_LIMIT,
        config: {
          authz: {
            action: 'workflows.define',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'workflow.define', target: () => null },
          },
        },
        schema: {
          tags,
          summary: 'Define a workflow (new version of project + name) (operator+)',
          security: csrf,
          body: z.object({
            project: z.string().regex(PROJECT),
            definition: z.record(z.string(), z.unknown()),
          }),
          response: { 201: Created, ...defineErrors },
        },
      },
      async (request, reply) => {
        const user = sessionOf(request).user;
        try {
          const d = await deps.workflows.define(
            { type: 'user', id: user.id },
            request.body.project,
            request.body.definition,
            { access: access(request) },
          );
          const triggers = await savedTriggers(request, d.id);
          if (triggers !== undefined) void reply.header('cache-control', 'no-store');
          return await reply.code(201).send({ ...d, ...(triggers === undefined ? {} : { triggers }) });
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/workflows',
      {
        config: { authz: { action: 'workflows.read' } },
        schema: {
          tags,
          summary: 'Workflow definitions (latest versions) and recent runs of visible projects (viewer+)',
          security: session,
          response: { 200: z.record(z.string(), z.unknown()), ...errors },
        },
      },
      async (request) => {
        const l = await deps.workflows.list(visibleProjects(authzOf(request).subject));
        return {
          definitions: l.definitions.map((d) => ({
            ...d,
            createdAt: iso(d.createdAt),
            archivedAt: iso(d.archivedAt),
            lastRun: d.lastRun === null ? null : { ...d.lastRun, createdAt: iso(d.lastRun.createdAt) },
          })),
          runs: l.runs.map((x) => ({ ...x, createdAt: iso(x.createdAt), endedAt: iso(x.endedAt) })),
        };
      },
    );

    // ------------------------------------------------------------------ p13-workflows-ui: catalog and editor

    r.post(
      '/workflows/validate',
      {
        bodyLimit: WORKFLOW_DEFINITION_BODY_LIMIT,
        config: {
          authz: {
            action: 'workflows.define',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'Validate a workflow document for a project without saving it: every issue as a path and a code (operator+)',
          security: csrf,
          body: z.object({
            project: z.string().regex(PROJECT),
            definition: z.record(z.string(), z.unknown()),
          }),
          response: { 200: z.object({ ok: z.boolean(), issues: z.array(Issue) }), ...errors },
        },
      },
      async (request) => {
        try {
          const v = await deps.workflows.validate(request.body.project, request.body.definition);
          return { ok: v.ok, issues: v.issues.map((i) => ({ path: i.path, code: i.code })) };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/workflows/:id/definition',
      {
        config: {
          authz: {
            action: 'workflows.read',
            resource: workflowTargetResource(deps.db, { offered: true }),
            notFound,
          },
        },
        schema: {
          tags,
          summary:
            "The full document of one workflow version (prompts included, as job prompts are), its latest version and archive state (viewer+). p18-multi-project: `project` = a project that attached it (read-only there; an offered, not yet attached workflow only for that project's admins)",
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          querystring: z.object({ project: z.string().regex(PROJECT).optional() }),
          response: {
            200: z.object({
              id: z.string(),
              project: z.string(),
              name: z.string(),
              version: z.number().int(),
              latestVersion: z.number().int(),
              latestId: z.string(),
              archived: z.boolean(),
              createdBy: z.string(),
              createdAt: z.string(),
              hash: z.string(),
              promptsHidden: z.boolean(),
              definition: z.record(z.string(), z.unknown()),
              /** p18-multi-project: read through a project that attached it (null: the owner project's view). */
              attachment: z
                .object({
                  id: z.string(),
                  project: z.string(),
                  state: z.string(),
                  follow: z.string(),
                  version: z.number().int(),
                  pendingVersion: z.number().int().nullable(),
                })
                .nullable()
                .optional(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const d = await deps.workflows.document(request.params.id);
        if (d === null) throw notFound();
        const target = request.query.project;
        let attachment: {
          id: string;
          project: string;
          state: string;
          follow: string;
          version: number;
          pendingVersion: number | null;
        } | null = null;
        if (target !== undefined && target !== d.project) {
          const a = await attachmentOf(deps.db, target, d.project, d.name);
          if (a === null) {
            // Offered, not attached: the target's admins may look before they attach.
            if (!authorize(authzOf(request).subject, 'workflows.attach', { project: target }).allow)
              throw notFound();
          } else {
            // A target reads the versions it runs (and the one waiting for its admin).
            if (d.version > Math.max(a.version, a.pending_version ?? 0)) throw notFound();
            attachment = {
              id: a.id,
              project: a.project,
              state: a.state,
              follow: a.follow,
              version: a.version,
              pendingVersion: a.pending_version,
            };
          }
        }
        // Viewers read job specs with their prompts (GET /jobs/:id), so the document is the same for every role.
        return {
          ...d,
          createdAt: d.createdAt.toISOString(),
          promptsHidden: false,
          definition: d.definition as unknown as Record<string, unknown>,
          attachment,
        };
      },
    );

    r.put(
      '/workflows/:id',
      {
        bodyLimit: WORKFLOW_DEFINITION_BODY_LIMIT,
        config: {
          authz: {
            action: 'workflows.define',
            resource: workflowResource(deps.db),
            notFound,
            auditDenied: { action: 'workflow.define', target: paramTarget('workflow') },
          },
        },
        schema: {
          tags,
          summary:
            'Save a new version of a workflow (same project and name; `baseVersion` = the version edited, 409 when another was saved meanwhile) (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({
            definition: z.record(z.string(), z.unknown()),
            baseVersion: z.number().int().min(1).optional(),
          }),
          response: { 200: Created, ...defineErrors },
        },
      },
      async (request, reply) => {
        const user = sessionOf(request).user;
        try {
          const d = await deps.workflows.update(
            { type: 'user', id: user.id },
            request.params.id,
            request.body.definition,
            request.body.baseVersion,
            access(request),
          );
          const triggers = await savedTriggers(request, d.id);
          if (triggers !== undefined) void reply.header('cache-control', 'no-store');
          return { ...d, ...(triggers === undefined ? {} : { triggers }) };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/workflows/:id/versions',
      {
        config: { authz: { action: 'workflows.read', resource: workflowTargetResource(deps.db), notFound } },
        schema: {
          tags,
          summary:
            'Every version of the workflow (project + name) of this definition, newest first (viewer+); `project` = a project that attached it (the versions up to the one it runs or has pending)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          querystring: z.object({ project: z.string().regex(PROJECT).optional() }),
          response: {
            200: z.object({
              versions: z.array(
                z.object({
                  id: z.string(),
                  version: z.number().int(),
                  createdBy: z.string(),
                  createdAt: z.string(),
                  hash: z.string(),
                  nodes: z.number().int(),
                  edges: z.number().int(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const v = await deps.workflows.versions(request.params.id);
        if (v === null) throw notFound();
        let upTo = Number.MAX_SAFE_INTEGER;
        const target = request.query.project;
        const d = target === undefined ? null : await deps.workflows.definition(request.params.id);
        if (d !== null && target !== undefined && target !== d.project) {
          const a = await attachmentOf(deps.db, target, d.project, d.name);
          if (a === null) throw notFound();
          upTo = Math.max(a.version, a.pending_version ?? 0);
        }
        return {
          versions: v
            .filter((x) => x.version <= upTo)
            .map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
        };
      },
    );

    for (const archived of [true, false]) {
      const verb = archived ? 'archive' : 'unarchive';
      r.post(
        `/workflows/:id/${verb}`,
        {
          config: {
            authz: {
              action: 'workflows.define',
              resource: workflowResource(deps.db),
              notFound,
              auditDenied: { action: `workflow.${verb}`, target: paramTarget('workflow') },
            },
          },
          schema: {
            tags,
            summary: archived
              ? 'Archive a workflow (every version): new runs and versions are refused, pickers hide it (operator+)'
              : 'Restore an archived workflow (operator+)',
            security: csrf,
            params: z.object({ id: z.string().regex(UUID) }),
            body: z.object({ reason: z.string().max(500).optional() }),
            response: { 200: z.object({ archived: z.boolean() }), ...errors },
          },
        },
        async (request) => {
          const user = sessionOf(request).user;
          try {
            const done = await deps.workflows.setArchived(
              { type: 'user', id: user.id },
              request.params.id,
              archived,
              request.body.reason,
            );
            // p16-workflow-quality: an archived workflow's schedules / webhooks are paused (they could only fail).
            if (archived && done) await deps.triggers?.onArchive(activationActor(request), request.params.id);
            return { archived: done };
          } catch (err) {
            throw toHttp(err);
          }
        },
      );
    }

    r.post(
      '/workflows/:id/duplicate',
      {
        config: {
          authz: {
            action: 'workflows.define',
            resource: workflowTargetResource(deps.db, { key: 'targetProject' }),
            notFound,
            auditDenied: { action: 'workflow.duplicate', target: paramTarget('workflow') },
          },
        },
        schema: {
          tags,
          summary:
            'Copy a workflow version as version 1 of a new name in the same project (operator+); p18-multi-project "Projeye kopyala": `targetProject` = a project that attached it (the copy becomes its own workflow there)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({
            name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            targetProject: z.string().regex(PROJECT).optional(),
          }),
          response: { 201: Created, ...defineErrors },
        },
      },
      async (request, reply) => {
        const user = sessionOf(request).user;
        try {
          const d = await deps.workflows.duplicate(
            { type: 'user', id: user.id },
            request.params.id,
            request.body.name,
            access(request),
            request.body.targetProject,
          );
          return await reply.code(201).send(d);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/workflows/:id/runs',
      {
        bodyLimit: JOB_CREATE_BODY_LIMIT,
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowTargetResource(deps.db),
            notFound,
            auditDenied: { action: 'workflow.run.start', target: paramTarget('workflow') },
          },
        },
        schema: {
          tags,
          summary:
            "Start a run of a workflow version with inputs (operator+). `files` (base64) and `continueFrom` (a job whose artifacts become run files) are handed to every step: workspace projects (each step also gets its upstream steps' files) and repository projects (each AI step's attempt reads them from a read-only scratch in/ next to its checkout, never committed; needs a machine with repo-inputs-v1, else 400 reason inputs_worker_update). p18-multi-project: `project` = a project that attached it (the run belongs there and runs the attachment's version).",
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({
            project: z.string().regex(PROJECT).optional(),
            inputs: z.record(z.string(), z.string()).default({}),
            repository: Repository.optional(),
            files: z
              .array(
                z.object({
                  name: z.string().min(1).max(100),
                  contentBase64: z.string().max(8 * 1024 * 1024),
                }),
              )
              .max(10)
              .optional(),
            continueFrom: z.uuid().optional(),
            /** p9-queue-priority: the run's class (every step job); `priority` (advanced) wins when both are given. */
            priorityClass: PriorityClass.optional(),
            priority: z.number().int().min(-100).max(100).optional(),
          }),
          response: { 201: z.object({ runId: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const user = sessionOf(request).user;
        let files: PreparedInput[] = [];
        if ((request.body.files ?? []).length > 0 || request.body.continueFrom !== undefined) {
          const def = await deps.workflows.definition(request.params.id);
          const kind = def === null ? null : await projectKind(deps.db, request.body.project ?? def.project);
          // p19-repo-inputs-composer-workflows: a repository project's run takes them too (each AI step's attempt
          // reads them from a scratch in/ next to its checkout) once a machine advertises repo-inputs-v1.
          if (kind === 'repository' && deps.workspaces !== undefined) await assertRepoInputsReady(deps.db);
          else if (kind !== 'workspace' || deps.workspaces === undefined) {
            throw new HttpError(
              400,
              'invalid_run',
              'Invalid run: files:not_allowed (not a workspace project)',
            );
          }
          files = await prepareSubmissionInputs({
            workspaces: deps.workspaces,
            db: deps.db,
            subject: authzOf(request).subject,
            uploads: request.body.files ?? [],
            continueFrom: request.body.continueFrom,
          });
        }
        try {
          const runId = await deps.workflows.startRun({ type: 'user', id: user.id }, request.params.id, {
            ...(request.body.project === undefined ? {} : { project: request.body.project }),
            inputs: request.body.inputs,
            repository: request.body.repository,
            ...(files.length > 0 ? { files } : {}),
            ...runPriority(request.body),
          });
          return await reply.code(201).send({ runId });
        } catch (err) {
          throw opsHttp(err);
        }
      },
    );

    r.get(
      '/workflows/runs/:id',
      {
        config: {
          authz: { action: 'workflows.read', resource: workflowRunResource(deps.db), notFound: runNotFound },
        },
        schema: {
          tags,
          summary:
            'A workflow run: graph (nodes, edges) with node states, jobs, outputs and merge requests (viewer+)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          response: { 200: z.record(z.string(), z.unknown()), ...errors },
        },
      },
      async (request) => {
        const v = await deps.workflows.runView(request.params.id);
        if (v === null) throw runNotFound();
        // p18-multi-project: a run of a project that attached the workflow names the owner project and attachment.
        const attachmentId = (v.run as { attachment_id?: string | null }).attachment_id ?? null;
        const ownerProject =
          attachmentId === null
            ? v.run.project
            : ((await deps.workflows.definition(v.run.definition_id))?.project ?? v.run.project);
        return {
          run: {
            id: v.run.id,
            definitionId: v.run.definition_id,
            project: v.run.project,
            attachmentId,
            ownerProject,
            name: v.run.name,
            version: v.run.version,
            state: v.run.state,
            // p14-workflow-engine: which engine runs it (1: classic, 2: node runs; same view either way).
            engine: v.run.engine ?? 1,
            inputs: v.run.inputs,
            repository: v.run.repository,
            // p5-research-workspace-next: the run's files (workspace runs; metadata only).
            files: deps.workspaces === undefined ? [] : await deps.workspaces.runFiles(v.run.id),
            createdBy: v.run.created_by,
            createdAt: iso(v.run.created_at),
            endedAt: iso(v.run.ended_at),
            reason: v.run.reason,
            // p14-workflow-engine 14.1: the run's outputs (engine 2; a stored value, maybe a payload reference).
            ...(v.run.engine === 2 ? { outputs: v.outputs ?? null } : {}),
            // p14-workflow-engine 14.2: what started the run (engine 2).
            ...(v.run.engine === 2
              ? {
                  triggerKind: v.run.trigger_kind ?? null,
                  sourceTrust: v.run.source_trust ?? null,
                  triggerNode: v.run.trigger_node ?? null,
                  // p14-workflow-engine 14.4: raw state, queue, pause, lineage and retention.
                  engineState: v.run.engine_state ?? null,
                  queuePosition: v.run.queue_position ?? null,
                  concurrencyKey: v.run.concurrency_key ?? null,
                  activatedAt: iso(v.run.activated_at ?? null),
                  pausedAt: iso(v.run.paused_at ?? null),
                  pausedBy: v.run.paused_by ?? null,
                  rerunOf: v.run.rerun_of ?? null,
                  rerunFromNode: v.run.rerun_from_node ?? null,
                  errorOf: v.run.error_of ?? null,
                  dataPrunedAt: iso(v.run.data_pruned_at ?? null),
                }
              : {}),
          },
          // p14-workflow-engine 14.2: the side effects of integration nodes (non-secret detail only).
          sideEffects: (v.sideEffects ?? []).map((e) => ({
            nodeId: e.node_id,
            scope: e.scope,
            nodeRunId: e.node_run_id,
            kind: e.kind,
            state: e.state,
            externalRef: e.external_ref,
            detail: e.detail,
            createdAt: iso(e.created_at),
            updatedAt: iso(e.updated_at),
          })),
          nodes: v.nodes.map((n) => ({
            id: n.node_id,
            // p14-workflow-engine: the node type (engine 1: every node is an AI step).
            type: n.node_type ?? 'ai.step',
            role: n.role,
            state: n.state,
            parent: n.parent_node,
            jobId: n.job_id,
            jobState: n.job_state,
            workerId: n.worker_id,
            attempts: n.attempts,
            reason: n.reason,
            // p6-result-reuse: the step reused this identical earlier job (its own job was cancelled unrun).
            reusedJobId: n.reused_job_id,
            // p8-orchestration: the step's runtime and why it runs there (planner hint, routing rule, default …).
            runtime: n.job_spec?.runtime ?? null,
            placement: n.placement,
            workerName: n.worker_name,
            outputs: n.outputs === null ? null : { summary: n.outputs.summary, branch: n.outputs.branch },
            ...(n.node_run_id === undefined
              ? {}
              : {
                  nodeRunId: n.node_run_id,
                  nodeRunState: n.node_run_state,
                  scope: n.scope ?? '',
                  waitKind: n.wait_kind ?? null,
                  dueAt: n.due_at === undefined ? null : iso(n.due_at),
                  outputPort: n.output_port ?? null,
                  error: n.error ?? null,
                  iterations: n.iterations ?? 0,
                  copiedFrom: n.copied_from ?? null,
                }),
            gate:
              n.gate_role === null
                ? null
                : {
                    approverRole: n.gate_role,
                    decision: n.gate_decision,
                    decidedBy: n.gate_decided_by,
                    decidedAt: iso(n.gate_decided_at),
                  },
          })),
          edges: v.edges,
          mergeRequests: v.mergeRequests.map((m) => ({
            id: m.id,
            node: m.node_id,
            status: m.status,
            branches: m.branches,
            externalRef: m.external_ref,
            createdAt: iso(m.created_at),
          })),
        };
      },
    );

    r.post(
      '/workflows/runs/:id/cancel',
      {
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowRunResource(deps.db),
            notFound: runNotFound,
            auditDenied: { action: 'workflow.run.cancel', target: paramTarget('workflow-run') },
          },
        },
        schema: {
          tags,
          summary: 'Cancel a workflow run: every open node job is cancelled (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({ reason: z.string().min(1).max(500) }),
          response: { 200: z.object({ state: z.string() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          return {
            state: await deps.workflows.cancelRun(
              request.params.id,
              { type: 'user', id: user.id },
              request.body.reason,
            ),
          };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    // ------------------------------------------------------------------ p14-workflow-engine 14.4 (§20)

    r.post(
      '/workflows/runs/:id/pause',
      {
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowRunResource(deps.db),
            notFound: runNotFound,
            auditDenied: { action: 'workflow.run.pause', target: paramTarget('workflow-run') },
          },
        },
        schema: {
          tags,
          summary:
            'Pause a running workflow run: nothing new starts, work in flight finishes, timers keep their time (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({ reason: z.string().max(500).default('') }).default({ reason: '' }),
          response: { 200: z.object({ state: z.string() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          return {
            state: await deps.workflows.pauseRun(
              request.params.id,
              { type: 'user', id: user.id },
              request.body.reason,
            ),
          };
        } catch (err) {
          throw opsHttp(err);
        }
      },
    );

    r.post(
      '/workflows/runs/:id/resume',
      {
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowRunResource(deps.db),
            notFound: runNotFound,
            auditDenied: { action: 'workflow.run.resume', target: paramTarget('workflow-run') },
          },
        },
        schema: {
          tags,
          summary: 'Resume a paused workflow run; timeouts move by the paused time (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({}).strict().default({}),
          response: { 200: z.object({ state: z.string() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          return { state: await deps.workflows.resumeRun(request.params.id, { type: 'user', id: user.id }) };
        } catch (err) {
          throw opsHttp(err);
        }
      },
    );

    const RerunPlanBody = z.object({
      fromNode: z.string().nullable(),
      version: z.number().int(),
      copied: z.array(z.string()),
      fresh: z.array(z.string()),
      sideEffects: z.array(z.string()),
      aiSteps: z.array(z.string()),
    });
    r.post(
      '/workflows/runs/:id/rerun',
      {
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowRunResource(deps.db),
            notFound: runNotFound,
            auditDenied: { action: 'workflow.run.rerun', target: paramTarget('workflow-run') },
          },
        },
        schema: {
          tags,
          summary:
            'Re-run a finished workflow run, from a node (upstream results are taken over, never repeated) or entirely; dryRun returns the plan (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z
            .object({
              fromNode: z
                .string()
                .regex(/^[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$/)
                .optional(),
              latestVersion: z.boolean().optional(),
              dryRun: z.boolean().optional(),
            })
            .strict(),
          response: {
            200: z.object({ plan: RerunPlanBody }),
            201: z.object({ runId: z.string(), plan: RerunPlanBody }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const user = sessionOf(request).user;
        try {
          const out = await deps.workflows.rerun({ type: 'user', id: user.id }, request.params.id, {
            fromNode: request.body.fromNode,
            ...(request.body.latestVersion === undefined
              ? {}
              : { latestVersion: request.body.latestVersion }),
            ...(request.body.dryRun === undefined ? {} : { dryRun: request.body.dryRun }),
          });
          const plan = { ...out.plan, copied: [...out.plan.copied], fresh: [...out.plan.fresh] };
          const body = {
            fromNode: plan.fromNode,
            version: plan.version,
            copied: plan.copied,
            fresh: plan.fresh,
            sideEffects: [...out.plan.sideEffects],
            aiSteps: [...out.plan.aiSteps],
          };
          if (out.runId === null) return await reply.code(200).send({ plan: body });
          return await reply.code(201).send({ runId: out.runId, plan: body });
        } catch (err) {
          throw opsHttp(err);
        }
      },
    );

    r.get(
      '/workflows/:id/metrics',
      {
        config: {
          authz: { action: 'workflows.read', resource: workflowTargetResource(deps.db), notFound },
        },
        schema: {
          tags,
          summary:
            'Run and node metrics of a workflow (every version): runs by state, failure streak, node durations and failures (viewer+); `project` = the runs of a project that attached it',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          querystring: z.object({
            days: z.coerce.number().int().min(1).max(90).default(30),
            project: z.string().regex(PROJECT).optional(),
          }),
          response: { 200: z.record(z.string(), z.unknown()), ...errors },
        },
      },
      async (request) => {
        const m = await deps.workflows.metrics(request.params.id, request.query.days, request.query.project);
        if (m === null) throw notFound();
        return m as unknown as Record<string, unknown>;
      },
    );

    for (const decision of ['approve', 'deny'] as const) {
      r.post(
        `/workflows/runs/:id/nodes/:node/${decision}`,
        {
          config: {
            authz: {
              action: 'workflows.approve',
              resource: workflowRunResource(deps.db),
              notFound: runNotFound,
              auditDenied: { action: `workflow.gate.${decision}`, target: paramTarget('workflow-run') },
            },
          },
          preHandler: requireStepUp(undefined, deps.clock),
          schema: {
            tags,
            summary: `${decision === 'approve' ? 'Approve' : 'Deny'} a node's approval gate (gate role, step-up)`,
            security: csrf,
            params: z.object({ id: z.string().regex(UUID), node: z.string().min(1).max(81) }),
            body: z.object({ reason: z.string().max(500).default('') }),
            response: { 200: z.object({ state: z.string() }), ...errors },
          },
        },
        async (request) => {
          const user = sessionOf(request).user;
          try {
            const state = await deps.workflows.decideGate(
              request.params.id,
              request.params.node,
              { id: user.id, role: authzOf(request).role },
              decision,
              request.body.reason,
            );
            // p18-last-gaps: the chat cards of an engine-1 gate update through their stream (the tick repeats it).
            void deps
              .approvals?.()
              ?.gateDecided?.(request.params.id, request.params.node)
              .catch(() => undefined);
            return { state };
          } catch (err) {
            throw toHttp(err);
          }
        },
      );
    }

    // ------------------------------------------------------------------ p14-workflow-engine 14.1

    r.get(
      '/workflows/catalog',
      {
        config: { authz: { action: 'workflows.read' } },
        schema: {
          tags,
          summary:
            'The workflow node catalog: types, config schemas, field modes, ports, expression functions, limits, and whether the new engine is on (viewer+)',
          security: session,
          response: { 200: z.record(z.string(), z.unknown()), ...errors },
        },
      },
      async () => (await deps.workflows.catalogView()) as unknown as Record<string, unknown>,
    );

    r.post(
      '/workflows/expressions/evaluate',
      {
        config: {
          authz: {
            action: 'workflows.test',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'workflow.test', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Evaluate one workflow expression (JSONata) or template against sample data in the master sandbox: value or error code + position (operator+, 60 per minute)',
          security: csrf,
          body: z.object({
            project: z.string().regex(PROJECT),
            expression: z
              .string()
              .min(1)
              .max(16 * 1024),
            mode: z.enum(['expr', 'template']).default('expr'),
            sample: Sample.optional(),
          }),
          response: { 200: z.record(z.string(), z.unknown()), ...errors, 429: ErrorBody },
        },
      },
      async (request) => {
        await limit(request, 'evaluate');
        try {
          return await deps.workflows.evaluateExpression(
            request.body.expression,
            request.body.mode,
            stripUndefined(request.body.sample ?? {}),
          );
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/workflows/:id/nodes/:node/test',
      {
        config: {
          authz: {
            action: 'workflows.test',
            resource: workflowResource(deps.db),
            notFound,
            auditDenied: { action: 'workflow.test', target: paramTarget('workflow') },
          },
        },
        schema: {
          tags,
          summary:
            "Test one master-pure node (stored, or the editor's unsaved copy) on sample input in the sandbox; nothing is stored but an audit line (operator+, 20 per minute)",
          security: csrf,
          params: z.object({ id: z.string().regex(UUID), node: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/) }),
          body: z.object({
            node: z.record(z.string(), z.unknown()).optional(),
            input: z.unknown().optional(),
            sample: Sample.omit({ input: true }).optional(),
            confirm: z.boolean().optional(),
          }),
          response: { 200: z.record(z.string(), z.unknown()), ...defineErrors, 429: ErrorBody },
        },
      },
      async (request) => {
        await limit(request, 'test');
        const user = sessionOf(request).user;
        try {
          return await deps.workflows.testNode(
            { type: 'user', id: user.id },
            request.params.id,
            request.params.node,
            {
              ...(request.body.node === undefined ? {} : { node: request.body.node }),
              ...(request.body.input === undefined ? {} : { input: request.body.input }),
              ...(request.body.sample === undefined ? {} : { sample: stripUndefined(request.body.sample) }),
            },
          );
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/workflows/runs/:id/node-runs',
      {
        config: {
          authz: { action: 'workflows.read', resource: workflowRunResource(deps.db), notFound: runNotFound },
        },
        schema: {
          tags,
          summary:
            'Node runs of an engine-2 run (every attempt and iteration): state, wait, input and output values (redacted; large ones by payload reference), error (viewer+)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          querystring: z.object({
            node: z
              .string()
              .regex(/^[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$/)
              .optional(),
            scope: z.string().max(200).optional(),
            cursor: z
              .string()
              .regex(/^\d{1,7}$/)
              .optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: {
            200: z.object({
              nodeRuns: z.array(z.record(z.string(), z.unknown())),
              nextCursor: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const r2 = await deps.workflows.nodeRuns(request.params.id, {
          node: request.query.node,
          scope: request.query.scope,
          ...(request.query.cursor === undefined ? {} : { after: Number(request.query.cursor) }),
          limit: request.query.limit,
        });
        if (r2 === null) throw runNotFound();
        return { nodeRuns: r2.nodeRuns, nextCursor: r2.next === null ? null : String(r2.next) };
      },
    );

    r.get(
      '/workflows/runs/:id/payloads/:sha',
      {
        config: {
          authz: { action: 'workflows.read', resource: workflowRunResource(deps.db), notFound: runNotFound },
        },
        schema: {
          tags,
          summary: 'One stored value of an engine-2 run (≤ 4 MiB, redacted) by its SHA-256 (viewer+)',
          security: session,
          params: z.object({ id: z.string().regex(UUID), sha: z.string().regex(/^[a-f0-9]{64}$/) }),
          response: {
            200: z.object({ sha: z.string(), size: z.number().int(), value: z.unknown() }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const p = await deps.workflows.payload(request.params.id, request.params.sha);
        if (p === null) throw new HttpError(404, 'payload_not_found', 'Payload not found.');
        void reply.header('cache-control', 'no-store');
        return { sha: request.params.sha, size: p.size, value: p.value };
      },
    );

    // p17-chat-flow: the approval step's live state for the chat card and "Senden bekleyen" (the decision is the route
    // below — the same authorization, step-up and audit wherever the person decides).
    r.get(
      '/workflows/runs/:id/node-runs/:nodeRunId/approval',
      {
        config: {
          authz: { action: 'workflows.read', resource: workflowRunResource(deps.db), notFound: runNotFound },
        },
        schema: {
          tags,
          summary:
            'An approval step of a run as the chat card shows it: title, details, approver role, state and whether the caller may decide it (viewer+). nodeRunId is an engine-2 node run, or the stable id of an engine-1 gate (engine: 1; decided through /nodes/:node/approve|deny)',
          security: session,
          params: z.object({ id: z.string().regex(UUID), nodeRunId: z.string().regex(UUID) }),
          response: { 200: z.record(z.string(), z.unknown()), ...errors },
        },
      },
      async (request, reply) => {
        const svc = deps.approvals?.() ?? null;
        const v =
          svc === null
            ? null
            : await svc.approvalView(authzOf(request).subject, request.params.id, request.params.nodeRunId);
        if (v === null) throw new HttpError(404, 'node_not_found', 'Node not found.');
        void reply.header('cache-control', 'no-store');
        return v as unknown as Record<string, unknown>;
      },
    );

    for (const decision of ['approve', 'deny'] as const) {
      r.post(
        `/workflows/runs/:id/node-runs/:nodeRunId/${decision}`,
        {
          config: {
            authz: {
              action: 'workflows.approve',
              resource: workflowRunResource(deps.db),
              notFound: runNotFound,
              auditDenied: { action: `workflow.gate.${decision}`, target: paramTarget('workflow-run') },
            },
          },
          preHandler: requireStepUp(undefined, deps.clock),
          schema: {
            tags,
            summary: `${decision === 'approve' ? 'Approve' : 'Deny'} a waiting approval of an engine-2 node run — an AI step's gate or an approval node, in any iteration (gate role, step-up)`,
            security: csrf,
            params: z.object({ id: z.string().regex(UUID), nodeRunId: z.string().regex(UUID) }),
            body: z.object({ reason: z.string().max(500).default('') }),
            response: { 200: z.object({ state: z.string() }), ...errors },
          },
        },
        async (request) => {
          const user = sessionOf(request).user;
          try {
            const state = await deps.workflows.decideNodeRun(
              request.params.id,
              request.params.nodeRunId,
              { id: user.id, role: authzOf(request).role },
              decision,
              request.body.reason,
            );
            // The chat cards of this step update through their stream (the tick repeats it for other paths).
            void deps
              .approvals?.()
              ?.approvalDecided?.(request.params.nodeRunId)
              .catch(() => undefined);
            return { state };
          } catch (err) {
            throw toHttp(err);
          }
        },
      );
    }

    // ------------------------------------------------------------------ p14-workflow-engine 14.2

    r.post(
      '/workflows/runs/:id/node-runs/:nodeRunId/resume',
      {
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowRunResource(deps.db),
            notFound: runNotFound,
            auditDenied: { action: 'workflow.node.resume', target: paramTarget('workflow-run') },
          },
        },
        schema: {
          tags,
          summary:
            'Resume an engine-2 node run that waits for a webhook by hand (testing / fallback); the data is stored as untrusted data (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID), nodeRunId: z.string().regex(UUID) }),
          body: z.object({ data: z.unknown().optional() }),
          response: { 200: z.object({ state: z.string() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          return {
            state: await deps.workflows.resumeNodeRun(
              request.params.id,
              request.params.nodeRunId,
              { type: 'user', id: user.id },
              request.body.data,
            ),
          };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    const Activation = z.record(z.string(), z.unknown());
    const noTriggers = () =>
      new HttpError(409, 'automations_unavailable', 'Automations are not available on this master.');

    r.get(
      '/workflows/:id/activation',
      {
        config: { authz: { action: 'workflows.read', resource: workflowTargetResource(deps.db), notFound } },
        schema: {
          tags,
          summary:
            "A workflow's trigger nodes and their bound automations: status, webhook address, last run, out-of-date nodes (viewer+); `project` = a project that attached it (its own automations and webhook addresses)",
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          querystring: z.object({ project: z.string().regex(PROJECT).optional() }),
          response: { 200: Activation, ...errors },
        },
      },
      async (request) => {
        if (deps.triggers === undefined) throw noTriggers();
        try {
          return (await deps.triggers.status(request.params.id, request.query.project)) as unknown as Record<
            string,
            unknown
          >;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.put(
      '/workflows/:id/activation',
      {
        config: {
          authz: {
            action: 'workflows.activate',
            resource: workflowTargetResource(deps.db),
            notFound,
            auditDenied: { action: 'workflow.activate', target: paramTarget('workflow') },
          },
        },
        schema: {
          tags,
          summary:
            '"Etkinleştir": reconcile the trigger nodes into bound automations (enabled) or pause them; webhook / GitHub triggers need automations.external and a fresh step-up (operator+). p18-multi-project: `project` = a project that attached it (its own automations, webhook address and secret, schedule / GitHub overrides; run-as = the activating user of that project)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({
            enabled: z.boolean(),
            pinnedVersion: z.number().int().min(1).nullable().optional(),
            project: z.string().regex(PROJECT).optional(),
          }),
          response: { 200: Activation, ...errors },
        },
      },
      async (request, reply) => {
        if (deps.triggers === undefined) throw noTriggers();
        // A newly created webhook trigger's secret is in the answer (shown once).
        void reply.header('cache-control', 'no-store');
        try {
          return (await deps.triggers.activate(
            activationActor(request),
            request.params.id,
            request.body,
          )) as unknown as Record<string, unknown>;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/workflows/runs/:id/node-runs/:nodeRunId/cancel',
      {
        config: {
          authz: {
            action: 'workflows.run',
            resource: workflowRunResource(deps.db),
            notFound: runNotFound,
            auditDenied: { action: 'workflow.node.cancel', target: paramTarget('workflow-run') },
          },
        },
        schema: {
          tags,
          summary:
            'Cancel one open node run of an engine-2 run: it fails `cancelled` and its error port / policy applies (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID), nodeRunId: z.string().regex(UUID) }),
          body: z.object({ reason: z.string().min(1).max(500) }),
          response: { 200: z.object({ state: z.string() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          return {
            state: await deps.workflows.cancelNodeRun(
              request.params.id,
              request.params.nodeRunId,
              { type: 'user', id: user.id },
              request.body.reason,
            ),
          };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );
  };
}

/** Drops `undefined` members (exact optional property types of the sample). */
function stripUndefined(o: Record<string, unknown>): ExprSample {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** p9-queue-priority: a run's queue priority from the advanced number or the class (absent: normal). */
export function runPriority(b: {
  readonly priority?: number | undefined;
  readonly priorityClass?: PriorityClass | undefined;
}): { priority?: number } {
  if (b.priority !== undefined) return { priority: b.priority };
  return b.priorityClass === undefined ? {} : { priority: PRIORITY_CLASS_VALUE[b.priorityClass] };
}
