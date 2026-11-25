import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize } from '../authz/model.js';
import type { Resource } from '../authz/model.js';
import { jobResource, param, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { IntegrationService, IntegrationView } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const View = z.object({
  id: z.string(),
  project: z.string(),
  source: z.enum(['coordinator', 'workflow']),
  rootJobId: z.string().nullable(),
  runId: z.string().nullable(),
  nodeId: z.string().nullable(),
  branch: z.string(),
  targetBranch: z.string(),
  baseSha: z.string(),
  headSha: z.string().nullable(),
  orderMode: z.enum(['dependency', 'completion']),
  state: z.enum([
    'merging',
    'resolving',
    'verifying',
    'fixing',
    'publishing',
    'ready',
    'merged',
    'needs_human',
    'failed',
    'cancelled',
  ]),
  reason: z.string().nullable(),
  resolutionRounds: z.number().int(),
  maxResolutions: z.number().int(),
  fixRounds: z.number().int(),
  maxFixes: z.number().int(),
  branches: z.array(
    z.object({
      position: z.number().int(),
      jobId: z.string(),
      title: z.string(),
      branch: z.string(),
      sha: z.string(),
      paths: z.array(z.string()),
      state: z.enum(['pending', 'merged', 'conflict', 'resolved', 'skipped']),
      mergedSha: z.string().nullable(),
      conflictFiles: z.array(z.string()),
      resolutionJobId: z.string().nullable(),
      resolutionJobState: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
  jobs: z.array(
    z.object({
      jobId: z.string(),
      kind: z.enum(['integrate', 'resolve', 'fix', 'verify']),
      round: z.number().int(),
      state: z.string(),
      createdAt: z.string(),
    }),
  ),
  warnings: z.array(
    z.object({
      kind: z.literal('path_overlap'),
      message: z.string(),
      jobIds: z.array(z.string()),
      paths: z.array(z.string()),
    }),
  ),
  verification: z
    .object({
      state: z.enum(['pending', 'running', 'passed', 'warned', 'failed', 'error', 'skipped']),
      jobId: z.string().nullable(),
      summary: z.string().nullable(),
      checks: z.array(z.object({ id: z.string(), status: z.string(), detail: z.string().nullable() })),
      findings: z.array(z.object({ severity: z.string(), kind: z.string(), message: z.string() })),
    })
    .nullable(),
  pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  mergeJobId: z.string().nullable(),
  log: z.array(z.object({ at: z.string(), message: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const Settings = z.object({
  mode: z.enum(['master', 'off']),
  order: z.enum(['dependency', 'completion']),
  maxResolutions: z.number().int().min(0).max(10),
  maxFixes: z.number().int().min(0).max(5),
});

function integrationResource(db: Queryable) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const { rows } = await db.query<{ project: string }>('SELECT project FROM integrations WHERE id = $1', [
      id,
    ]);
    const project = rows[0]?.project;
    return project === undefined ? null : { project };
  };
}

function runResource(db: Queryable) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const { rows } = await db.query<{ project: string }>('SELECT project FROM workflow_runs WHERE id = $1', [
      id,
    ]);
    const project = rows[0]?.project;
    return project === undefined ? null : { project };
  };
}

const notFound = () => new HttpError(404, 'integration_not_found', 'Integration not found.');

/**
 * p11-merge-pipeline REST (docs/design/p11-merge-pipeline.md §8): the integration of a job (coordinator, member or one
 * of the integration's own jobs) and of a workflow run (viewer+), cancel / retry (operator+, audited), and the
 * project's integration settings (read: viewer+; write: admin + step-up, audited). Merging the integration is the
 * existing protected merge of its head job (`POST /jobs/:id/merge`, admin + step-up through the approval) or the
 * provider's own PR merge — nothing here merges.
 */
export function integrationRoutes(deps: {
  readonly integration: IntegrationService;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['integration'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    // The service's view is the wire shape (readonly arrays only differ in type).
    const wire = (v: IntegrationView): z.infer<typeof View> => v as unknown as z.infer<typeof View>;
    const view = (v: IntegrationView | null) => ({ integration: v === null ? null : wire(v) });

    r.get(
      '/jobs/:id/integration',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'p11-merge-pipeline: the master-managed integration of this job — as the coordinator, as a member, or as one of the integration’s own jobs (null when none).',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ integration: View.nullable() }), ...errors },
        },
      },
      async (request) => view(await deps.integration.forJob(request.params.id)),
    );

    r.get(
      '/workflows/runs/:id/integration',
      {
        config: {
          authz: {
            action: 'workflows.read',
            resource: runResource(deps.db),
            notFound: () => new HttpError(404, 'run_not_found', 'Workflow run not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'p11-merge-pipeline: the master-managed integration of a workflow run’s integrator step (null when none).',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ integration: View.nullable() }), ...errors },
        },
      },
      async (request) => view(await deps.integration.forRun(request.params.id)),
    );

    r.post(
      '/integrations/:id/cancel',
      {
        config: {
          authz: {
            action: 'jobs.cancel',
            resource: integrationResource(deps.db),
            notFound,
            auditDenied: { action: 'integration.cancel', target: paramTarget('integration') },
          },
        },
        schema: {
          tags,
          summary:
            'Cancel an open integration (operator+): its current job is cancelled; the branch and the members stay as they are.',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.object({ reason: z.string().max(500).optional() }),
          response: { 200: z.object({ integration: View }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        return {
          integration: wire(
            await deps.integration.cancel(
              request.params.id,
              { id: user.id },
              request.body.reason ?? 'cancelled from the console',
            ),
          ),
        };
      },
    );

    r.post(
      '/integrations/:id/retry',
      {
        config: {
          authz: {
            action: 'jobs.cancel',
            resource: integrationResource(deps.db),
            notFound,
            auditDenied: { action: 'integration.retry', target: paramTarget('integration') },
          },
        },
        schema: {
          tags,
          summary:
            'Retry an integration that stopped for a person (operator+): round limits are reset and it continues from its branch.',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.object({}).optional(),
          response: { 200: z.object({ integration: View }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        return { integration: wire(await deps.integration.retry(request.params.id, { id: user.id })) };
      },
    );

    r.get(
      '/projects/:id/integration-settings',
      {
        config: { authz: { action: 'projects.git.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'p11-merge-pipeline: the project’s integration settings (mode, merge order, round limits) and whether the caller may change them.',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: z.object({ settings: Settings, canEdit: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        const subject = await loadSubject(deps.db, { id: user.id, role: user.role });
        return {
          settings: await deps.integration.settings(request.params.id),
          canEdit: authorize(subject, 'projects.git.write', { project: request.params.id }).allow,
        };
      },
    );

    r.put(
      '/projects/:id/integration-settings',
      {
        config: {
          authz: {
            action: 'projects.git.write',
            resource: projectParam(),
            auditDenied: { action: 'project.integration.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'Set the project’s integration settings (admin, step-up, audited): master-managed integration on/off, merge order, conflict-resolution and fix round limits.',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: Settings,
          response: { 200: z.object({ settings: Settings }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        return {
          settings: await deps.integration.putSettings(request.params.id, request.body, { id: user.id }),
        };
      },
    );
  };
}
