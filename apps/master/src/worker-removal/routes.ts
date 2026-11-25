import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { OpBody } from '../remote-ops/routes.js';
import { actorOf } from '../workers/routes.js';
import type { WorkerRemovalService } from './service.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  429: ErrorBodySchema,
  503: ErrorBodySchema,
};
const WorkerParams = z.object({ id: z.string().min(1).max(64) });

const RemovalBody = z.object({
  workerId: z.string(),
  os: z.string().nullable(),
  supported: z.boolean(),
  connected: z.boolean(),
  revoked: z.boolean(),
  removal: z
    .object({
      id: z.string(),
      purge: z.boolean(),
      state: z.string(),
      opId: z.string().nullable(),
      opState: z.string().nullable(),
      reason: z.string().nullable(),
      detail: z.string().nullable(),
      requestedBy: z.string().nullable(),
      requestedAt: z.string(),
      updatedAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .nullable(),
  manual: z.array(z.string()),
});

/**
 * p17-worker-managed Parts 3 and 4: remove a worker from its machine (signed `worker.uninstall` through the privileged
 * helper, then revoke) and install / remove the machine-admin helper. Privileged work on a machine: always-fresh
 * step-up, audited; installing the elevated helper is owner-only like enabling machine administration.
 */
export function workerRemovalRoutes(service: WorkerRemovalService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['workers'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const fresh = requireStepUp('always-fresh', clock);

    r.get(
      '/workers/:id/remove',
      {
        config: { authz: { action: 'machines.admin.read' } },
        schema: {
          tags,
          summary:
            'The removal of a worker from its machine: state, outcome and the manual uninstall for its OS (admin)',
          security: session,
          params: WorkerParams,
          response: { 200: RemovalBody, ...errors },
        },
      },
      async (request) => service.view(request.params.id),
    );

    r.post(
      '/workers/:id/remove',
      {
        config: {
          authz: {
            action: 'machines.admin.run',
            auditDenied: { action: 'worker.remove.request', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Remove the worker from its machine: drain it, send the signed uninstall (now, or when it connects) to its privileged helper (service, triggers, program files; `purge`: also config, data dir with the device key and the service user), then revoke it (admin, always-fresh step-up, audited)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({ purge: z.boolean().default(false) }),
          response: { 200: RemovalBody, ...errors },
        },
      },
      async (request) => service.request(request.params.id, request.body, actorOf(request)),
    );

    r.delete(
      '/workers/:id/remove',
      {
        config: { authz: { action: 'machines.admin.run' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Cancel a removal that has not reached the machine yet (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          response: { 200: RemovalBody, ...errors },
        },
      },
      async (request) => service.cancel(request.params.id, actorOf(request)),
    );

    r.post(
      '/workers/:id/machine-admin/helper',
      {
        config: {
          authz: {
            action: 'machines.admin.enable',
            auditDenied: { action: 'worker.ops.helper.manage', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Install or remove the machine-admin helper’s trigger (the elevated broker) on the worker’s machine through its privileged helper, with the units of its release (OWNER, always-fresh step-up, audited)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({ action: z.enum(['install', 'remove']) }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.manageHelper(
          request.params.id,
          request.body.action === 'install' ? 'admin_helper.install' : 'admin_helper.remove',
          actorOf(request),
        ),
    );
  };
}
