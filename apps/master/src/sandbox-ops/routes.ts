import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { RuntimeKind } from '@remyral/protocol';
import { SAFE_COMMANDS_MODES } from '@remyral/protocol/safe-commands';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { actorOf } from '../workers/routes.js';
import type { SandboxOpsService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
const Json = z.record(z.string(), z.unknown());
const WorkerParams = z.object({ id: z.string().min(1).max(64) });
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });

const SandboxBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  state: z.string(),
  connected: z.boolean(),
  supported: z.boolean(),
  status: Json.nullable(),
  statusAt: z.string().nullable(),
  readyProfiles: z.array(z.string()),
  unconfined: z.object({
    allowed: z.boolean(),
    generation: z.number().int(),
    // p19-unconfined-parallel: the response schema strips undeclared fields — declare them.
    parallel: z.boolean(),
    parallelSupported: z.boolean(),
  }),
  localLogin: z.boolean(),
  lastPrepare: Json.nullable(),
});
const ExecutionBody = z.object({
  project: z.string(),
  hostExecution: z.boolean(),
  unconfined: z.boolean(),
  allowAutoApprove: z.boolean(),
  safeCommands: z.enum(SAFE_COMMANDS_MODES),
  subtasks: z.boolean(),
  delegationRuntimes: z.array(z.string()),
});

/**
 * p5-sandbox-ops API (ADR-0019). Reading the Sandbox card is fleet information (viewer+). Preparing the sandbox,
 * switching `unconfined` on a worker and changing a project's execution policy are admin actions in the
 * always-fresh step-up class (they decide what agent code may do on a machine), CSRF-protected and audited.
 * `GET /v1/worker/lease-keys` publishes the master's lease-signing *public* keys for the privileged prepare
 * helper (it verifies the signed command with them; nothing secret).
 */
export function sandboxOpsRoutes(service: SandboxOpsService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', clock);

    r.get(
      '/workers/:id/sandbox',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags: ['fleet'],
          summary:
            'Sandbox card: per-profile readiness with codes and fixes, host checks, unconfined switch, last Prepare',
          security: session,
          params: WorkerParams,
          response: { 200: SandboxBody, ...errors },
        },
      },
      async (request) => {
        const v = await service.worker(request.params.id);
        return {
          ...v,
          status: v.status as unknown as Record<string, unknown> | null,
          readyProfiles: [...v.readyProfiles],
          lastPrepare: v.lastPrepare as unknown as Record<string, unknown> | null,
        };
      },
    );

    r.post(
      '/workers/:id/sandbox/prepare',
      {
        config: {
          authz: {
            action: 'workers.ops.write',
            auditDenied: { action: 'worker.ops.sandbox.prepare', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags: ['fleet'],
          summary:
            "Prepare every sandbox profile this machine can support; `privileged` also runs the root/SYSTEM helper's fixed allowlist (admin, always-fresh step-up)",
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({ privileged: z.boolean().default(true) }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await service.prepare(
          request.params.id,
          request.body.privileged,
          actorOf(request),
        )) as unknown as Record<string, unknown>,
    );

    r.put(
      '/workers/:id/sandbox/unconfined',
      {
        config: {
          authz: {
            action: 'workers.config.write',
            auditDenied: { action: 'worker.sandbox.unconfined', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags: ['fleet'],
          summary:
            'Allow or forbid the unconfined profile on a worker (no filesystem / egress confinement; admin, always-fresh step-up, audited, owner notified); `parallel` lets attempts without sandbox run in parallel there (p19-unconfined-parallel)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            allow: z.boolean(),
            parallel: z.boolean().optional(),
            expectedGeneration: z.number().int().min(0),
            reason: z.string().max(500).optional(),
          }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await service.setUnconfined(request.params.id, request.body, actorOf(request))) as unknown as Record<
          string,
          unknown
        >,
    );

    r.get(
      '/projects/:id/execution',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'A project’s execution policy: host-native profiles, the unconfined profile, auto-approve (approval policy allow-all) and the safe-command mode',
          security: session,
          params: ProjectParams,
          response: { 200: ExecutionBody, ...errors },
        },
      },
      async (request) => service.projectExecution(request.params.id),
    );

    r.put(
      '/projects/:id/execution',
      {
        config: {
          authz: {
            action: 'projects.execution.write',
            resource: projectParam(),
            auditDenied: { action: 'project.execution.update', target: paramTarget('project') },
          },
        },
        preHandler: fresh,
        schema: {
          tags: ['projects'],
          summary:
            'Change a project’s execution policy (host-native profiles, unconfined, auto-approve, sub-jobs and delegation runtimes) (admin, always-fresh step-up, audited, owners/admins notified). An absent allowAutoApprove, safeCommands, subtasks or delegationRuntimes keeps its current value.',
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({
            hostExecution: z.boolean(),
            unconfined: z.boolean(),
            allowAutoApprove: z.boolean().optional(),
            safeCommands: z.enum(SAFE_COMMANDS_MODES).optional(),
            /** p8-orchestration (ADR-0031): agents may request sub-jobs; runtimes agent-chosen work may use. */
            subtasks: z.boolean().optional(),
            delegationRuntimes: z.array(RuntimeKind).max(4).optional(),
          }),
          response: { 200: ExecutionBody, ...errors },
        },
      },
      async (request) => service.setProjectExecution(request.params.id, request.body, actorOf(request)),
    );

    app.get(
      '/v1/worker/lease-keys',
      { config: { auth: 'public' }, schema: { hide: true }, exposeHeadRoute: false },
      async (_request, reply) =>
        reply
          .header('cache-control', 'no-store')
          .header('content-type', 'application/json')
          .send(service.leaseKeys()),
    );
  };
}
