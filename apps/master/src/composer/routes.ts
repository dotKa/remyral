import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { JobRole, JobSpec, ROLE_HINT_CHARS, RuntimeKind, SandboxProfile } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Resource } from '../authz/model.js';
import { bodyField } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { aiProjection, type StoredDefinition } from '@remyral/workflow-nodes';
import { workflowTargetResource } from '../workflows/routes.js';
import { type PreviewDeps, previewPlacement } from './preview.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { inputFilesAvailability } from '../jobs/repo-inputs.js';
import { projectKind } from '../workspaces/service.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Authorization resource: the project named in the (unvalidated) body; absent → collection rule. */
function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

const Reason = z.object({ code: z.string(), permanent: z.boolean(), message: z.string() });
const Summary = Reason.extend({ workers: z.array(z.string()) });
const Limits = z.object({
  maxCostUsd: z.number().optional(),
  maxTokens: z.number().optional(),
  maxTurns: z.number().optional(),
  maxWallTimeSec: z.number().optional(),
});

/**
 * p19-repo-inputs-composer-workflows: may the composer offer input files (job) / run files (workflow run) for the
 * project now — false with `inputs_worker_update` for a repository project while no machine has `repo-inputs-v1`.
 */
const InputFiles = z.object({
  available: z.boolean(),
  reason: z.enum(['inputs_worker_update', 'inputs_project']).nullable(),
});

const PreviewBody = z.object({
  project: z.string().regex(PROJECT),
  runtime: RuntimeKind.optional(),
  runtimeVersion: JobSpec.shape.runtimeVersion,
  model: JobSpec.shape.model,
  sandboxProfile: SandboxProfile.optional(),
  sourceTrust: JobSpec.shape.sourceTrust,
  approvalPolicy: JobSpec.shape.approvalPolicy.optional(),
  requirements: JobSpec.shape.requirements,
  secretRefs: JobSpec.shape.secretRefs,
  // p6-smart-routing: the draft's kind, or the start of its prompt for the kind heuristic.
  role: JobRole.optional(),
  promptHead: z.string().max(ROLE_HINT_CHARS).optional(),
});

const PreviewResponse = z.object({
  project: z.string(),
  hostExecution: z.boolean(),
  unconfinedExecution: z.boolean(),
  autoApproveExecution: z.boolean(),
  defaultApprovalPolicy: z.enum(['allow-all', 'ask-sensitive']),
  fullAccess: z.object({
    available: z.boolean(),
    reasons: z.array(z.object({ code: z.string(), message: z.string() })),
    workers: z.array(z.string()),
  }),
  sandboxProfile: z.string(),
  issues: z.array(z.object({ code: z.string(), message: z.string() })),
  placement: z
    .object({
      runtime: z.string(),
      verdict: z.enum(['placed', 'waiting', 'infeasible', 'held']),
      holds: z.array(Summary),
      candidates: z.array(
        z.object({ workerId: z.string(), score: z.number(), breakdown: z.record(z.string(), z.number()) }),
      ),
      rejected: z.array(z.object({ workerId: z.string(), reasons: z.array(Reason) })),
      summary: z.array(Summary),
      explanation: z.string().nullable(),
    })
    .nullable(),
  routing: z.object({
    role: z.string().nullable(),
    roleSource: z.enum(['explicit', 'inferred']).nullable(),
    rule: z
      .object({
        role: z.string(),
        modelProfile: z.string().nullable(),
        runtimes: z.array(z.string()),
        scope: z.enum(['project', 'global']),
      })
      .nullable(),
    runtime: z.string().nullable(),
  }),
  runtimes: z.array(
    z.object({
      runtime: z.string(),
      verdict: z.enum(['placed', 'waiting', 'infeasible']),
      eligible: z.array(z.string()),
      feasible: z.array(z.string()),
      summary: z.array(Summary),
    }),
  ),
  modelProfiles: z.array(
    z.object({
      name: z.string(),
      provider: z.string(),
      model: z.string(),
      isDefault: z.boolean(),
      workers: z.array(z.string()),
      source: z.enum(['policy', 'catalog']),
      value: z.string(),
      displayName: z.string().optional(),
      pricing: z.record(z.string(), z.number()).optional(),
      limits: z.record(z.string(), z.number()).optional(),
      projectDefault: z.boolean(),
    }),
  ),
  model: z
    .object({
      runtime: z.string(),
      defaultProfile: z.string().nullable(),
      defaultScope: z.enum(['project', 'global']).nullable(),
      defaultSource: z.enum(['routing', 'default']).nullable(),
      defaultModel: z.boolean(),
    })
    .nullable(),
  sandbox: z.array(z.object({ profile: z.string(), workers: z.array(z.string()) })),
  limits: Limits,
  workers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      state: z.string(),
      connected: z.boolean(),
      os: z.string().nullable(),
      arch: z.string().nullable(),
      tools: z.array(z.string()),
    }),
  ),
  inputFiles: InputFiles,
});

const DefinitionResponse = z.object({
  id: z.string(),
  project: z.string(),
  name: z.string(),
  version: z.number().int(),
  description: z.string().nullable(),
  inputs: z.array(z.object({ name: z.string(), required: z.boolean(), description: z.string().nullable() })),
  nodes: z.array(
    z.object({
      id: z.string(),
      role: z.string(),
      runtime: z.string(),
      gate: z.boolean(),
      dynamic: z.boolean(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  defaults: z.object({
    runtime: z.string(),
    sandboxProfile: z.string(),
    approvalPolicy: z.string(),
    limits: Limits.extend({ maxDurationSec: z.number() }).partial(),
    repository: z.object({ url: z.string(), baseRef: z.string() }).nullable(),
  }),
  /** p19-repo-inputs-composer-workflows: run files (files / continueFrom) for a run in the run project. */
  runFiles: InputFiles,
});

/**
 * p5-composer read endpoints (docs/design/p5-composer.md §3):
 *
 * - `POST /jobs/placement-preview` — "where would this run?" for a job being composed: `jobs.create` on the
 *   body's project (operator+ member, owner/admin), **no side effects** (POST only because the draft is a
 *   structured body; CSRF still applies). Answers with candidates, per-worker reasons, per-runtime
 *   availability, model profiles, sandbox readiness and the run-limit defaults.
 * - `GET /workflows/:id` — one workflow definition version without node prompts (graph, inputs, defaults)
 *   for the composer's workflow mode: `workflows.read` on the definition's project (viewer+).
 */
export function composerRoutes(deps: {
  readonly db: Queryable;
  readonly preview: () => PreviewDeps;
  readonly definition: (id: string) => Promise<{
    id: string;
    project: string;
    name: string;
    version: number;
    definition: StoredDefinition;
  } | null>;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.post(
      '/jobs/placement-preview',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Where would this job run? Candidates and reasons for a draft (operator+, no side effects; nothing is created)',
          security: [{ session: [], csrf: [] }],
          body: PreviewBody,
          response: { 200: PreviewResponse, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        const exists = await deps.db.query('SELECT 1 FROM projects WHERE id = $1', [b.project]);
        if ((exists.rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
        const preview = await previewPlacement(deps.preview(), {
          project: b.project,
          runtime: b.runtime,
          runtimeVersion: b.runtimeVersion,
          model: b.model,
          sandboxProfile: b.sandboxProfile,
          sourceTrust: b.sourceTrust,
          approvalPolicy: b.approvalPolicy,
          requirements: b.requirements,
          secretRefs: b.secretRefs,
          role: b.role,
          promptHead: b.promptHead,
        });
        // p19-repo-inputs-composer-workflows: the job composer's file field (workspace, or repository with a
        // repo-inputs-v1 machine).
        const inputFiles = await inputFilesAvailability(deps.db, await projectKind(deps.db, b.project));
        // Readonly view → the response schema's (structurally identical) mutable type.
        return { ...preview, inputFiles } as z.infer<typeof PreviewResponse>;
      },
    );

    r.get(
      '/workflows/:id',
      {
        config: {
          authz: {
            action: 'workflows.read',
            // p18-multi-project: `?project=` reads it through a project that attached it.
            resource: workflowTargetResource(deps.db),
            notFound: () => new HttpError(404, 'workflow_not_found', 'Workflow not found.'),
          },
        },
        schema: {
          tags: ['workflows'],
          summary:
            'One workflow definition version: graph, inputs and defaults, without node prompts (viewer+); `project` = a project that attached it (its runs never use the owner repository)',
          security: [{ session: [] }],
          params: z.object({ id: z.string().regex(UUID) }),
          querystring: z.object({
            project: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
              .optional(),
          }),
          response: { 200: DefinitionResponse, ...errors },
        },
      },
      async (request) => {
        const d = await deps.definition(request.params.id);
        if (d === null) throw new HttpError(404, 'workflow_not_found', 'Workflow not found.');
        // p14-workflow-engine: the AI steps of a v2 document (14.0 runs nothing else).
        const def = aiProjection(d.definition);
        // p18-multi-project: in a project that attached it, runs take that project's repository.
        const attached = request.query.project !== undefined && request.query.project !== d.project;
        return {
          id: d.id,
          project: d.project,
          name: d.name,
          version: d.version,
          description: def.description ?? null,
          inputs: Object.entries(def.inputs).map(([name, spec]) => ({
            name,
            required: spec.required,
            description: spec.description ?? null,
          })),
          nodes: def.nodes.map((n) => ({
            id: n.id,
            role: n.role,
            runtime: n.runtime ?? def.defaults.runtime,
            gate: n.approval !== undefined,
            dynamic: n.dynamic !== undefined,
          })),
          edges: def.edges,
          defaults: {
            runtime: def.defaults.runtime,
            sandboxProfile: def.defaults.sandboxProfile,
            approvalPolicy: def.defaults.approvalPolicy,
            limits: def.defaults.limits,
            repository: attached ? null : (def.defaults.repository ?? null),
          },
          // p19-repo-inputs-composer-workflows: run files in the run's project (the attaching one, else the owner).
          runFiles: await inputFilesAvailability(
            deps.db,
            await projectKind(deps.db, attached ? (request.query.project ?? d.project) : d.project),
          ),
        };
      },
    );
  };
}
