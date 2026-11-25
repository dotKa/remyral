import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { HistoricalRuntimeKind, isRetiredRuntime, RuntimeKind } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { runtimeCatalog } from './runtime-catalog.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { requireStepUp } from '../auth/hooks.js';
import { actorOf } from '../workers/routes.js';
import { RUNTIME_REMOVED_MESSAGE } from '../jobs/errors.js';
import { ModelCatalogInvalidError, type ModelCatalogService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const IdParams = z.object({ id: z.string().min(1).max(64) });
const Json = z.record(z.string(), z.unknown());
const ModelBody = z
  .object({
    id: z.string(),
    displayName: z.string(),
    runtimes: z.array(z.string()),
    provider: z.string(),
    model: z.string(),
    enabled: z.boolean(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string().nullable(),
    usedBy: z.object({
      policies: z.array(
        z.object({ policy: z.string(), version: z.number().int(), runtime: z.string(), inSync: z.boolean() }),
      ),
      workers: z.array(z.string()),
    }),
  })
  .catchall(z.unknown());
const DefaultBody = z.object({
  project: z.string().nullable(),
  runtime: z.string(),
  profileId: z.string().nullable(),
  /** p15-model-picker: a model id default (catalog or custom) instead of a profile. */
  model: z.string().nullable(),
});

async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ModelCatalogInvalidError) {
      return reply.code(400).send({ error: err.code, message: err.publicMessage, issues: [...err.issues] });
    }
    throw err;
  }
}

/** Model catalog API (p5-credentials-models). Reads for every console role; writes admin + step-up + CSRF. */
export function modelRoutes(
  service: ModelCatalogService,
  clock: () => Date = () => new Date(),
  pool: Queryable = service.pool,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['models'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/models',
      {
        config: { authz: { action: 'models.read' } },
        schema: {
          tags,
          summary: 'Model catalog: profiles, where they are used, per project/runtime defaults',
          security: session,
          querystring: z.object(offsetQuery(500)),
          response: {
            200: z.object({ items: z.array(ModelBody), defaults: z.array(DefaultBody), ...pageFields }),
            ...errors,
          },
        },
      },
      async (request) => {
        const all = await service.list();
        return { ...all, ...pageArray(all.items, request.query) };
      },
    );

    // p15-model-picker: the models each runtime accepts (built-in catalog + machine lists) and the defaults in force.
    r.get(
      '/models/runtimes',
      {
        config: { authz: { action: 'models.read' } },
        schema: {
          tags,
          summary:
            'Runtime model catalog: per runtime the known models, the machines each was seen on, and the global / project / per-machine defaults',
          security: session,
          querystring: z.object({
            runtime: RuntimeKind.optional(),
            project: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
              .optional(),
          }),
          response: {
            200: z.object({
              catalogVersion: z.string(),
              runtimes: z.array(z.record(z.string(), z.unknown())),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const view = await runtimeCatalog(pool, {
          runtime: request.query.runtime,
          project: request.query.project,
        });
        return { catalogVersion: view.catalogVersion, runtimes: view.runtimes.map((r) => ({ ...r })) };
      },
    );

    r.put(
      '/models/defaults',
      {
        config: { authz: { action: 'models.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set (or clear) the default model (a profile, or a model id) of a runtime, globally or for a project (admin, step-up)',
          security: csrf,
          body: z.strictObject({
            project: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
              .nullable(),
            // ADR-0023: a removed runtime is parsed so it can be refused with its own code.
            runtime: HistoricalRuntimeKind,
            profileId: z.string().min(1).max(64).nullable(),
            /** p15-model-picker: a model id instead of a profile (profileId then null). */
            model: z.string().min(1).max(256).nullable().optional(),
          }),
          response: { 200: z.object({ defaults: z.array(DefaultBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const { runtime } = request.body;
          if (isRetiredRuntime(runtime)) {
            throw new ModelCatalogInvalidError(
              [{ path: 'runtime', code: 'runtime_removed' }],
              RUNTIME_REMOVED_MESSAGE,
            );
          }
          return { defaults: await service.setDefault({ ...request.body, runtime }, actorOf(request)) };
        }),
    );

    r.put(
      '/models/:id',
      {
        config: { authz: { action: 'models.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Create or change a model profile (optimistic on its version; admin, step-up)',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ entry: Json, expectedVersion: z.number().int().min(0) }),
          response: { 200: ModelBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.put(request.params.id, request.body, actorOf(request))),
    );

    r.delete(
      '/models/:id',
      {
        config: { authz: { action: 'models.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Delete an unused model profile (admin, step-up)',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await service.remove(request.params.id, actorOf(request));
        return reply.code(204).send(null);
      },
    );
  };
}
