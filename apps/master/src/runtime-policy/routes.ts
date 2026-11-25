import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { actorOf } from '../workers/routes.js';
import { RuntimePolicyInvalidError, type RuntimePolicyService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const Name = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
const WorkerParams = z.object({ id: z.string().min(1).max(64) });
const NameParams = z.object({ name: Name });

/** Response shapes are loose on purpose for the document (validated on write by @remyral/protocol). */
const Document = z.object({
  runtimes: z.record(z.string(), z.unknown()),
  projectProfiles: z.record(z.string(), z.unknown()),
});
const VersionBody = z.object({
  version: z.number().int(),
  documentHash: z.string(),
  document: Document,
  changeNote: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
const PolicyBody = z.object({
  name: z.string(),
  description: z.string().nullable(),
  activeVersion: z.number().int().nullable(),
  canaryVersion: z.number().int().nullable(),
  previousVersion: z.number().int().nullable(),
  active: VersionBody.nullable(),
  canary: VersionBody.nullable(),
  workers: z.number().int(),
  canaryWorkers: z.number().int(),
  updatedAt: z.string(),
});
const WorkerPolicyBody = z.object({
  workerId: z.string(),
  assignedPolicy: z.string().nullable(),
  canary: z.boolean(),
  effective: z
    .object({
      policy: z.string(),
      version: z.number().int(),
      stage: z.enum(['active', 'canary']),
      documentHash: z.string(),
      document: Document,
    })
    .nullable(),
  delivered: z.object({
    policy: z.string().nullable(),
    version: z.number().int().nullable(),
    stage: z.string().nullable(),
    hash: z.string().nullable(),
    at: z.string().nullable(),
    generation: z.number().int(),
  }),
  applied: z.object({
    policy: z.string().nullable(),
    version: z.number().int().nullable(),
    hash: z.string().nullable(),
    at: z.string().nullable(),
  }),
  inSync: z.boolean(),
  runtimes: z.array(
    z.object({
      runtime: z.string(),
      pinned: z.string(),
      pinMode: z.enum(['follow', 'hold']),
      installed: z.string().nullable(),
      status: z.enum(['match', 'mismatch', 'not-installed', 'unknown']),
      allowUnpinned: z.boolean(),
      authModes: z.array(z.string()),
      defaultProfile: z.string().nullable(),
      profiles: z.array(z.string()),
    }),
  ),
});

async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RuntimePolicyInvalidError) {
      return reply.code(400).send({ error: err.code, message: err.publicMessage, issues: [...err.issues] });
    }
    throw err;
  }
}

/**
 * Runtime policy API (docs/design/p3-runtime-policy.md). Reads: every console role (no secrets in policies);
 * writes: admin+, step-up, CSRF, audited.
 */
export function runtimePolicyRoutes(service: RuntimePolicyService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['runtime-policy'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/runtime-policies',
      {
        config: { authz: { action: 'runtimes.read' } },
        schema: {
          tags,
          summary: 'Runtime policies with their active and staged (canary) versions',
          security: session,
          response: { 200: z.object({ items: z.array(PolicyBody) }), ...errors },
        },
      },
      async () => ({ items: await service.list() }),
    );

    r.get(
      '/runtime-policies/template',
      {
        config: { authz: { action: 'runtimes.read' } },
        schema: {
          tags,
          summary:
            'A valid starter policy document from the compiled-in runtime pins (every runtime at its exact pin; nothing unverified or unpinned allowed)',
          security: session,
          response: { 200: z.object({ document: Document, documentHash: z.string() }), ...errors },
        },
      },
      async (_request, reply) => handled(reply, () => service.template()),
    );

    r.get(
      '/runtime-policies/:name',
      {
        config: { authz: { action: 'runtimes.read' } },
        schema: {
          tags,
          summary: 'One runtime policy',
          security: session,
          params: NameParams,
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request) => service.get(request.params.name),
    );

    r.get(
      '/runtime-policies/:name/versions',
      {
        config: { authz: { action: 'runtimes.read' } },
        schema: {
          tags,
          summary: 'Version history of a runtime policy (newest first)',
          security: session,
          params: NameParams,
          response: { 200: z.object({ items: z.array(VersionBody) }), ...errors },
        },
      },
      async (request) => ({ items: await service.versions(request.params.name) }),
    );

    r.put(
      '/runtime-policies/:name',
      {
        config: { authz: { action: 'runtimes.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Store a new policy version; activate it for the group or stage it for canary workers (admin, step-up)',
          security: csrf,
          params: NameParams,
          body: z.object({
            document: z.unknown(),
            stage: z.enum(['all', 'canary']),
            expectedVersion: z.number().int().min(0),
            changeNote: z.string().max(1000).optional(),
            description: z.string().max(500).optional(),
          }),
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.put(request.params.name, request.body, actorOf(request))),
    );

    r.post(
      '/runtime-policies/:name/promote',
      {
        config: { authz: { action: 'runtimes.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Promote the staged canary version to every worker of the group (admin, step-up)',
          security: csrf,
          params: NameParams,
          body: z.object({ version: z.number().int().min(1), force: z.boolean().optional() }),
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request) => service.promote(request.params.name, request.body, actorOf(request)),
    );

    r.post(
      '/runtime-policies/:name/rollback',
      {
        config: { authz: { action: 'runtimes.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Abandon a staged rollout or return to an earlier version (admin, step-up)',
          security: csrf,
          params: NameParams,
          body: z.object({
            toVersion: z.number().int().min(1).optional(),
            reason: z.string().max(1000).optional(),
          }),
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.rollback(request.params.name, request.body, actorOf(request))),
    );

    r.get(
      '/workers/:id/runtime-policy',
      {
        config: { authz: { action: 'runtimes.read' } },
        schema: {
          tags,
          summary: 'The runtime policy a worker should run, what was delivered and what it applied',
          security: session,
          params: WorkerParams,
          response: { 200: WorkerPolicyBody, ...errors },
        },
      },
      async (request) => service.forWorker(request.params.id),
    );

    r.put(
      '/workers/:id/runtime-policy',
      {
        config: { authz: { action: 'runtimes.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Assign a worker to a runtime policy (null: default) and set its canary flag (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          body: z.object({ policy: Name.nullable(), canary: z.boolean() }),
          response: { 200: WorkerPolicyBody, ...errors },
        },
      },
      async (request) => service.assign(request.params.id, request.body, actorOf(request)),
    );
  };
}
