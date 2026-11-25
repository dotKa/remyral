import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { RuntimeKind, RuntimePathSettings, SandboxProfile } from '@remyral/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { actorOf } from '../workers/routes.js';
import { MAX_PREFERRED_WORKERS, type PreferredWorkersService } from './preferred.js';
import { WorkerConfigInvalidError, type WorkerConfigService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const WorkerParams = z.object({ id: z.string().min(1).max(64) });
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });
const WorkerId = z.string().min(1).max(64);
const ProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

/** Response shapes are loose for the documents (validated on write by @remyral/protocol). */
const Json = z.record(z.string(), z.unknown());
const VersionBody = z.object({
  generation: z.number().int(),
  documentHash: z.string(),
  spec: Json,
  document: Json,
  cause: z.string(),
  rollbackOf: z.number().int().nullable(),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
const ConfigBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  state: z.string(),
  connected: z.boolean(),
  supported: z.boolean(),
  desired: VersionBody.nullable(),
  delivered: z.object({ generation: z.number().int().nullable(), at: z.string().nullable() }),
  report: Json.nullable(),
  reportedAt: z.string().nullable(),
  status: z.enum(['unmanaged', 'unsupported', 'pending', 'applied', 'rejected']),
  drift: z.array(z.object({ path: z.string(), reason: z.string() })),
  suggested: Json,
  projectOptions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      repositoryUrl: z.string().nullable(),
      kind: z.enum(['repository', 'workspace']),
    }),
  ),
  // p5-credentials-models: vault credential metadata, catalog profiles, the worker's vault key.
  credentialOptions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      env: z.string(),
      version: z.number().int(),
      state: z.enum(['active', 'revoked']),
      sharedWithWorker: z.boolean(),
    }),
  ),
  modelOptions: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      runtimes: z.array(z.string()),
      provider: z.string(),
      model: z.string(),
      enabled: z.boolean(),
    }),
  ),
  vault: z.object({ supported: z.boolean(), keyFingerprint: z.string().nullable() }),
  // p17-worker-managed: panel-managed local settings supported (worker-managed-v1); machine admin enabled (paths).
  settings: z.object({ supported: z.boolean(), machineAdmin: z.boolean() }),
});
const ProjectWorkerBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  state: z.string(),
  connected: z.boolean(),
  managed: z.boolean(),
  supported: z.boolean(),
  assigned: z.boolean(),
  effective: z.boolean().nullable(),
  blocked: z.string().nullable(),
  generation: z.number().int().nullable(),
  appliedGeneration: z.number().int().nullable(),
});

/** p18-project-bootstrap: ≤ 16 machine ids of ≤ 64 characters (well inside the write class). */
export const PREFERRED_WORKERS_BODY_LIMIT = 4 * 1024;
const PreferredBody = z.object({
  project: z.string(),
  workerIds: z.array(z.string()),
  updatedAt: z.string().nullable(),
});

async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkerConfigInvalidError) {
      return reply.code(400).send({ error: err.code, message: err.publicMessage, issues: [...err.issues] });
    }
    throw err;
  }
}

/**
 * Panel-managed worker configuration API (ADR-0015, docs/design/p5-managed-workers.md). Reads and writes are
 * admin+ (a configuration names projects a viewer may not see); writes need step-up and CSRF, are optimistic on
 * the generation and audited. Project-side reads are project-scoped (viewer+ of the project).
 */
export function workerConfigRoutes(
  service: WorkerConfigService,
  clock: () => Date = () => new Date(),
  /** p18-project-bootstrap: a project's preferred machines (absent: the routes are not registered). */
  preferred?: PreferredWorkersService,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['worker-config'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const fresh = requireStepUp('always-fresh', clock);

    r.get(
      '/workers/:id/config',
      {
        config: { authz: { action: 'workers.config.read' } },
        schema: {
          tags,
          summary: 'A worker’s panel configuration: desired generation, delivery, the worker’s report, drift',
          security: session,
          params: WorkerParams,
          response: { 200: ConfigBody, ...errors },
        },
      },
      async (request) => service.get(request.params.id),
    );

    r.get(
      '/workers/:id/config/history',
      {
        config: { authz: { action: 'workers.config.read' } },
        schema: {
          tags,
          summary: 'Configuration generations of a worker (newest first)',
          security: session,
          params: WorkerParams,
          response: { 200: z.object({ items: z.array(VersionBody) }), ...errors },
        },
      },
      async (request) => ({ items: await service.history(request.params.id) }),
    );

    r.put(
      '/workers/:id/config',
      {
        config: { authz: { action: 'workers.config.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Store a new configuration generation for a worker and deliver it (admin, step-up; optimistic on the generation)',
          security: csrf,
          params: WorkerParams,
          body: z.object({
            spec: z.unknown(),
            expectedGeneration: z.number().int().min(0),
            changeNote: z.string().max(1000).optional(),
            /** First generation taken over from the worker's local file (audited as `adopt`). */
            adopt: z.boolean().optional(),
          }),
          response: { 200: ConfigBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.put(request.params.id, request.body, actorOf(request))),
    );

    r.put(
      '/workers/:id/config/runtime-paths',
      {
        config: {
          authz: {
            action: 'machines.admin.enable',
            auditDenied: { action: 'worker.runtime_paths', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Which executable each runtime runs on a worker, and Pi extension files (OWNER, always-fresh step-up; only with machine administration enabled; the worker re-validates every path; audited)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            runtimePaths: z.partialRecord(RuntimeKind, RuntimePathSettings),
            expectedGeneration: z.number().int().min(0),
            reason: z.string().max(500).optional(),
          }),
          response: { 200: ConfigBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.setRuntimePaths(request.params.id, request.body, actorOf(request))),
    );

    r.post(
      '/workers/:id/config/rollback',
      {
        config: { authz: { action: 'workers.config.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Make an earlier configuration generation the desired one again, as a new generation (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          body: z.object({
            toGeneration: z.number().int().min(1),
            expectedGeneration: z.number().int().min(0),
            reason: z.string().max(1000).optional(),
          }),
          response: { 200: ConfigBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.rollback(request.params.id, request.body, actorOf(request))),
    );

    r.post(
      '/workers/config/bulk',
      {
        config: { authz: { action: 'workers.config.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Apply one change to several workers, all or nothing (admin, step-up)',
          security: csrf,
          body: z.object({
            workerIds: z.array(WorkerId).min(1).max(100),
            patch: z.strictObject({
              addProjects: z.array(ProjectId).max(256).optional(),
              removeProjects: z.array(ProjectId).max(256).optional(),
              allowedRuntimes: z.array(RuntimeKind).max(8).optional(),
              maxParallelJobs: z.number().int().min(0).max(64).optional(),
              sandboxProfiles: z.array(SandboxProfile).max(8).optional(),
              setLabels: z.record(z.string(), z.string()).optional(),
              removeLabels: z.array(z.string().max(63)).max(32).optional(),
            }),
            changeNote: z.string().max(1000).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({ workerId: z.string(), generation: z.number().int(), changed: z.boolean() }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({ items: await service.bulk(request.body, actorOf(request)) })),
    );

    r.get(
      '/projects/:id/workers',
      {
        config: { authz: { action: 'projects.workers.read', resource: projectParam() } },
        schema: {
          tags,
          summary: 'Workers and whether this project is assigned to / in effect on each',
          security: session,
          params: ProjectParams,
          response: { 200: z.object({ items: z.array(ProjectWorkerBody) }), ...errors },
        },
      },
      async (request) => ({ items: await service.projectWorkers(request.params.id) }),
    );

    r.put(
      '/projects/:id/workers',
      {
        config: { authz: { action: 'projects.workers.write', resource: projectParam() } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set the workers that run this project (complete set); each changed worker gets a new configuration generation (admin, step-up)',
          security: csrf,
          params: ProjectParams,
          body: z.object({ workerIds: z.array(WorkerId).max(1000) }),
          response: { 200: z.object({ items: z.array(ProjectWorkerBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({
          items: await service.setProjectWorkers(request.params.id, request.body, actorOf(request)),
        })),
    );

    if (preferred === undefined) return;
    // p18-project-bootstrap: the project's preferred machines (a soft placement preference of all its jobs).
    r.get(
      '/projects/:id/preferred-workers',
      {
        config: { authz: { action: 'projects.workers.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            "The project's preferred machines: every job of the project prefers them (a soft preference — another eligible machine runs the job when they cannot)",
          security: session,
          params: ProjectParams,
          response: { 200: PreferredBody, ...errors },
        },
      },
      async (request) => preferred.get(request.params.id),
    );

    r.put(
      '/projects/:id/preferred-workers',
      {
        config: {
          authz: {
            action: 'projects.workers.write',
            resource: projectParam(),
            auditDenied: { action: 'project.preferred_workers.update', target: paramTarget('project') },
          },
        },
        bodyLimit: PREFERRED_WORKERS_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            "Set the project's preferred machines (complete set, at most 16 enrolled machines; an empty list removes the preference). Admin, step-up, audited.",
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({ workerIds: z.array(WorkerId).max(MAX_PREFERRED_WORKERS) }),
          response: { 200: PreferredBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => preferred.set(request.params.id, request.body, actorOf(request))),
    );
  };
}
