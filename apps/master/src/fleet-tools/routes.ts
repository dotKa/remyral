import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { actorOf } from '../workers/routes.js';
import { type CustomRecipeStore, RECIPE_LIMITS } from './recipes.js';
import type { VersionFeedService } from './feed.js';
import type { FleetToolsService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  skipped: z.array(z.object({ workerId: z.string(), reason: z.string().nullable() })).optional(),
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
const ActionParams = z.object({ id: z.uuid() });
const RecipeParams = z.object({ id: z.uuid() });
const WorkerId = z.string().min(1).max(64);

const ActionBody = z.strictObject({
  kind: z.enum([
    'tool.install',
    'tool.remove',
    'runtime.install',
    'tool.elevated',
    'custom.install',
    'custom.remove',
  ]),
  item: z.string().regex(/^[a-z][a-z0-9:-]{0,63}$/),
  version: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)
    .optional(),
  workers: z.union([z.literal('all'), z.array(WorkerId).min(1).max(200)]),
  rollout: z.enum(['all', 'canary-first']).optional(),
  expiresInHours: z.number().int().min(1).max(168).optional(),
  approvalPolicy: z.enum(['ask-all', 'allow-all']).optional(),
  /**
   * p16-runtime-updates: `runtime.install` of a version outside the machines' release pins (default: the newest at the
   * source), labelled unverified — only while the security policy allows it (`fleet.unverifiedRuntimeUpdates`).
   */
  unverified: z.boolean().optional(),
});
const Runtime = z.enum(['claude-code', 'codex', 'pi', 'opencode']);
const ExactVersion = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/);

/**
 * p13-fleet-tools API (docs/design/p13-fleet-tools.md, ADR-0052).
 *  - Reads (matrix, actions, recipes, settings) are fleet information: `workers.read` (viewer+).
 *  - Release-recipe installs / removes and runtime installs on many machines: `workers.ops.write` (admin) + step-up —
 *    exactly what one machine's remote operation needs; each target is a normal signed remote operation.
 *  - Elevated recipes and custom tools: `machines.admin.run` (admin) + always-fresh step-up — what one machine-admin job
 *    needs; each target is a machine-admin job or a worker-enforced custom download.
 *  - Custom recipes decide what may be downloaded onto machines: `machines.admin.run` + always-fresh step-up.
 */
export function fleetToolsRoutes(
  service: FleetToolsService,
  recipes: CustomRecipeStore,
  feed: VersionFeedService,
  clock: () => Date = () => new Date(),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['fleet'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', clock);
    const fresh = requireStepUp('always-fresh', clock);
    const read = { config: { authz: { action: 'workers.read' as const } } };
    const opsWrite = { config: { authz: { action: 'workers.ops.write' as const } } };
    const adminRun = { config: { authz: { action: 'machines.admin.run' as const } } };

    r.get(
      '/fleet/tools',
      {
        ...read,
        schema: {
          tags,
          summary:
            'Tool and runtime versions across the fleet: per machine what jobs use, the pin, the latest version at the official source, a status and the action that applies',
          security: session,
          querystring: z.object({ worker: WorkerId.optional() }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) => (await service.view(request.query.worker)) as unknown as Record<string, unknown>,
    );

    r.post(
      '/fleet/tools/feed/refresh',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Read the latest versions from the official sources now (npm, GitHub releases, NuGet, Node.js)',
          security: csrf,
          body: z.strictObject({}).optional(),
          response: { 200: Json, ...errors },
        },
      },
      async () => {
        await feed.refresh();
        return (await service.view()) as unknown as Record<string, unknown>;
      },
    );

    r.get(
      '/fleet/tools/actions',
      {
        ...read,
        schema: {
          tags,
          summary: 'Recent bulk tool / runtime actions with per-machine progress',
          security: session,
          response: { 200: z.object({ actions: z.array(Json) }), ...errors },
        },
      },
      async () => ({ actions: (await service.list()) as unknown as Record<string, unknown>[] }),
    );

    r.get(
      '/fleet/tools/actions/:id',
      {
        ...read,
        schema: {
          tags,
          summary: 'One bulk action with per-machine progress',
          security: session,
          params: ActionParams,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => (await service.get(request.params.id)) as unknown as Record<string, unknown>,
    );

    r.post(
      '/fleet/tools/actions',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            "Install / update / remove a release-recipe tool or install a runtime version on many machines — a pinned one, or with `unverified: true` a newer one outside the release pins (security policy fleet.unverifiedRuntimeUpdates; labelled unverified; 409 nothing_to_do lists every machine's skip reason) (remote operations; offline machines get it when they reconnect, until it expires) (admin, step-up)",
          security: csrf,
          body: ActionBody,
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            (await service.create(request.body, false, actorOf(request))) as unknown as Record<
              string,
              unknown
            >,
          ),
    );

    r.post(
      '/fleet/tools/runtime-candidates/verify',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Verify a runtime version newer than the release pin now on a canary machine: install into a scratch dir and run the automatable checks (integrity, version, help / loopback auth, adapter probe; a model prompt and the contract suite are not automated) (admin, step-up)',
          security: csrf,
          body: z.strictObject({ runtime: Runtime, version: ExactVersion.optional() }),
          response: { 202: Json, ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(202)
          .send(
            (await service.verifyRuntimeNow(
              request.body.runtime,
              request.body.version,
              actorOf(request),
            )) as unknown as Record<string, unknown>,
          ),
    );

    r.get(
      '/fleet/tools/runtime-candidates/:runtime/:version/lock',
      {
        ...read,
        schema: {
          tags,
          summary:
            'The npm lockfile (package-lock.json v3) of a resolved runtime release outside the pins — the input of scripts/release/promote-runtime-pin.mjs',
          security: session,
          params: z.object({ runtime: Runtime, version: ExactVersion }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) => service.runtimeLock(request.params.runtime, request.params.version),
    );

    r.post(
      '/fleet/tools/admin-actions',
      {
        ...adminRun,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Machine administration on many machines: a distribution-package recipe or a custom tool (machine-admin jobs / worker-checked custom downloads; machine administration must be enabled per machine) (admin, always-fresh step-up)',
          security: csrf,
          body: ActionBody,
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            (await service.create(request.body, true, actorOf(request))) as unknown as Record<
              string,
              unknown
            >,
          ),
    );

    r.post(
      '/fleet/tools/actions/:id/continue',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Canary-first rollout: the canary machines succeeded — roll out to the rest (admin, step-up)',
          security: csrf,
          params: ActionParams,
          body: z.strictObject({}).optional(),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await service.continue(request.params.id, actorOf(request))) as unknown as Record<string, unknown>,
    );

    r.post(
      '/fleet/tools/actions/:id/retry',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Retry the failed / expired machines of a bulk action (admin, step-up)',
          security: csrf,
          params: ActionParams,
          body: z.strictObject({ workers: z.array(WorkerId).min(1).max(200).optional() }).optional(),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await service.retry(
          request.params.id,
          request.body?.workers,
          actorOf(request),
        )) as unknown as Record<string, unknown>,
    );

    r.post(
      '/fleet/tools/actions/:id/cancel',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Cancel what has not been sent yet (operations already running finish on their machine) (admin, step-up)',
          security: csrf,
          params: ActionParams,
          body: z.strictObject({}).optional(),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await service.cancel(request.params.id, actorOf(request))) as unknown as Record<string, unknown>,
    );

    r.get(
      '/fleet/tools/recipes',
      {
        ...read,
        schema: {
          tags,
          summary: 'Custom tool recipes and the hosts a custom download may come from',
          security: session,
          response: {
            200: z.object({
              recipes: z.array(Json),
              limits: z.object({ hosts: z.array(z.string()), reservedNames: z.array(z.string()) }),
            }),
            ...errors,
          },
        },
      },
      async () => ({
        recipes: (await recipes.list()) as unknown as Record<string, unknown>[],
        limits: { hosts: [...RECIPE_LIMITS.hosts], reservedNames: [...RECIPE_LIMITS.reservedNames] },
      }),
    );

    r.post(
      '/fleet/tools/recipes',
      {
        ...adminRun,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Create a custom tool recipe (download from an allowlisted https host with SHA-256 and size, or a package-manager package) (admin, always-fresh step-up)',
          security: csrf,
          body: z.strictObject({ recipe: Json }),
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            (await recipes.create(request.body.recipe, actorOf(request))) as unknown as Record<
              string,
              unknown
            >,
          ),
    );

    r.put(
      '/fleet/tools/recipes/:id',
      {
        ...adminRun,
        preHandler: fresh,
        schema: {
          tags,
          summary: 'Replace a custom tool recipe (same name) (admin, always-fresh step-up)',
          security: csrf,
          params: RecipeParams,
          body: z.strictObject({ recipe: Json }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await recipes.update(request.params.id, request.body.recipe, actorOf(request))) as unknown as Record<
          string,
          unknown
        >,
    );

    r.delete(
      '/fleet/tools/recipes/:id',
      {
        ...adminRun,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Remove a custom tool recipe (installs on machines stay until removed there) (admin, always-fresh step-up)',
          security: csrf,
          params: RecipeParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await recipes.archive(request.params.id, actorOf(request));
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/fleet/tools/settings',
      {
        ...read,
        schema: {
          tags,
          summary: 'Fleet tool settings (weekly update digest)',
          security: session,
          response: {
            200: z.object({ digestEnabled: z.boolean(), lastDigestAt: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async () => service.settings(),
    );

    r.put(
      '/fleet/tools/settings',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Switch the weekly tool update digest on or off (admin, step-up)',
          security: csrf,
          body: z.strictObject({ digestEnabled: z.boolean() }),
          response: {
            200: z.object({ digestEnabled: z.boolean(), lastDigestAt: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async (request) => service.setSettings(request.body.digestEnabled, actorOf(request)),
    );
  };
}
