import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requestStepUpMaxAge, requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import type { CoolifyAppService } from './coolify-apps.js';
import { OpsError } from './model.js';
import type { OpsActor } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  424: ErrorBody,
  429: ErrorBody,
  503: ErrorBody,
};
const Json = z.record(z.string(), z.unknown());
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const COOLIFY_UUID = /^[A-Za-z0-9]{6,64}$/;
const CONN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreationBody = z.object({
  id: z.string(),
  project: z.string(),
  env: z.enum(['preview', 'production']),
  connection: z.object({ id: z.string().nullable(), label: z.string().nullable() }),
  state: z.enum(['creating', 'created', 'failed']),
  appUuid: z.string().nullable(),
  name: z.string(),
  request: Json,
  result: Json.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  replayed: z.boolean(),
  deletedAt: z.string().nullable(),
});
/** p15-coolify-dedupe: 409 `coolify_app_exists` names the application(s) to fix instead of creating another one. */
const ExistingBody = z.object({
  uuid: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  fqdn: z.string().nullable(),
  repository: z.string().nullable(),
  branch: z.string().nullable(),
  linked: z.enum(['preview', 'production']).nullable(),
  match: z.array(z.enum(['repository', 'image', 'name'])),
});
const CreateConflictBody = ErrorBodySchema.extend({ existing: z.array(ExistingBody).optional() });
const LinkedBody = z.object({
  env: z.enum(['preview', 'production']),
  uuid: z.string(),
  connection: z.object({ id: z.string(), label: z.string() }),
  manageApps: z.boolean(),
  name: z.string().nullable(),
  fqdn: z.string().nullable(),
  status: z.string().nullable(),
  problem: z.string().nullable(),
});
const EnvResultBody = z.object({
  created: z.array(z.string()),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ key: z.string(), message: z.string() })),
  deployActionId: z.string().nullable(),
  deployState: z.string().nullable(),
  warnings: z.array(z.string()),
});

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpsError) throw new HttpError(err.status, err.code, err.message, err.headers);
    throw err;
  }
}

/**
 * p15-coolify-create (ADR-0057): Projeler → Deploy → "Coolify'da yeni uygulama", the variables and domains editors of
 * a linked application. Reads: `deploy.coolify.read` (project admin). Writes: `deploy.coolify.manage` (project admin),
 * CSRF and a standard step-up that the security policy waives unless the event `deploy.coolify` asks for a code.
 * Request bodies may carry variable values: they are passed to Coolify and never stored, logged or audited.
 */
export function coolifyAppRoutes(deps: { readonly service: CoolifyAppService; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const tags = ['deploy'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', deps.clock);
    const actor = (request: FastifyRequest): OpsActor => {
      const s = sessionOf(request);
      const maxAge = requestStepUpMaxAge(request, 'always-fresh');
      return {
        type: 'user',
        id: s.user.id,
        mfaAt: s.mfaAt,
        ...(maxAge === undefined ? {} : { stepUpMaxAgeMs: maxAge }),
        ...requestMeta(request),
      };
    };
    const Params = z.object({ id: z.string().regex(PROJECT) });
    const AppParams = z.object({ id: z.string().regex(PROJECT), uuid: z.string().regex(COOLIFY_UUID) });
    const read = { action: 'deploy.coolify.read', resource: projectParam() } as const;
    const manage = (audit: string) =>
      ({
        action: 'deploy.coolify.manage',
        resource: projectParam(),
        auditDenied: { action: audit, target: paramTarget('project') },
      }) as const;

    r.get(
      '/projects/:id/coolify/options',
      {
        config: { authz: read },
        schema: {
          tags,
          summary:
            'What a new Coolify application can use on a connection: servers, projects (+ environments, destinations of the chosen ones), GitHub App sources, deploy keys (no key material), the project repository and targets',
          security: session,
          params: Params,
          querystring: z.object({
            connection: z.string().regex(CONN).optional(),
            env: z.enum(['preview', 'production']).optional(),
            coolifyProject: z.string().regex(COOLIFY_UUID).optional(),
            server: z.string().regex(COOLIFY_UUID).optional(),
          }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.options(request.params.id, {
            connection: request.query.connection ?? null,
            env: request.query.env ?? null,
            coolifyProject: request.query.coolifyProject ?? null,
            server: request.query.server ?? null,
          }),
        ),
    );
    r.get(
      '/projects/:id/coolify/suggestion',
      {
        config: { authz: read },
        schema: {
          tags,
          summary:
            'Build pack, port and directories suggested from the repository root (Dockerfile, compose file, package.json, index.html); defaults when it cannot be read',
          security: session,
          params: Params,
          querystring: z.object({
            branch: z
              .string()
              .regex(/^[A-Za-z0-9._/-]{1,200}$/)
              .optional(),
          }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(async () => ({
          ...(await service.suggestion(request.params.id, request.query.branch ?? null)),
        })),
    );
    r.get(
      '/projects/:id/coolify/apps',
      {
        config: { authz: read },
        schema: {
          tags,
          summary: 'The Coolify applications linked to the project’s deploy targets and recent creations',
          security: session,
          params: Params,
          response: {
            200: z.object({ items: z.array(LinkedBody), creations: z.array(CreationBody) }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(async () => ({
          items: await service.linked(request.params.id),
          creations: await service.creations(request.params.id),
        })),
    );
    r.post(
      '/projects/:id/coolify/apps',
      {
        config: { authz: manage('ops.coolify.app.create') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create a Coolify application for the project (repository + branch, Dockerfile or image; build pack, ports, domains, health check, variables), link it to the deploy target and optionally request its first deploy; idempotent per key. Refused (409 coolify_app_exists, with the existing applications) when the Coolify environment already has an application for the same repository + branch or with the same name, unless allowDuplicate',
          security: csrf,
          params: Params,
          body: Json,
          response: { 200: CreationBody, 201: CreationBody, ...errors, 409: CreateConflictBody },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          const out = await service.create(actor(request), request.params.id, request.body, 'api');
          return reply.code(out.replayed ? 200 : 201).send(out);
        }),
    );
    r.get(
      '/projects/:id/coolify/apps/:uuid',
      {
        config: { authz: read },
        schema: {
          tags,
          summary:
            'A linked application: domains, build settings and its variables (keys and flags, never values)',
          security: session,
          params: AppParams,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => wrap(() => service.app(request.params.id, request.params.uuid)),
    );
    r.put(
      '/projects/:id/coolify/apps/:uuid/envs',
      {
        config: { authz: manage('ops.coolify.app.envs') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set or remove environment variables of a linked application (values go to Coolify and are never stored); optionally redeploy',
          security: csrf,
          params: AppParams,
          body: Json,
          response: { 200: EnvResultBody, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.setEnvs(actor(request), request.params.id, request.params.uuid, request.body, 'api'),
        ),
    );
    r.put(
      '/projects/:id/coolify/apps/:uuid/domains',
      {
        config: { authz: manage('ops.coolify.app.domains') },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Replace the domains of a linked application; optionally redeploy',
          security: csrf,
          params: AppParams,
          body: Json,
          response: {
            200: z.object({
              domains: z.array(z.string()),
              previous: z.array(z.string()),
              deployActionId: z.string().nullable(),
              deployState: z.string().nullable(),
              warnings: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(() =>
          service.setDomains(actor(request), request.params.id, request.params.uuid, request.body, 'api'),
        ),
    );
    // p15-coolify-dedupe: settings, logs and deletion of the project's applications.
    r.patch(
      '/projects/:id/coolify/apps/:uuid',
      {
        config: { authz: manage('ops.coolify.app.update') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change the build and run settings of a linked application (build pack, base directory, Dockerfile location, ports, install / build / start command, branch, health check); optionally redeploy it',
          security: csrf,
          params: AppParams,
          body: Json,
          response: {
            200: z.object({
              appUuid: z.string(),
              changed: z.array(z.string()),
              deployActionId: z.string().nullable(),
              deployState: z.string().nullable(),
              warnings: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(() =>
          service.update(actor(request), request.params.id, request.params.uuid, request.body, 'api'),
        ),
    );
    r.get(
      '/projects/:id/coolify/apps/:uuid/logs',
      {
        config: { authz: read },
        schema: {
          tags,
          summary:
            'The deployment (build) log of the application’s last deployment and its container output — redacted and capped; for an application linked to the project or created by it',
          security: session,
          params: AppParams,
          querystring: z.object({
            kind: z.enum(['deployment', 'runtime', 'both']).optional(),
            lines: z.coerce.number().int().min(10).max(2000).optional(),
          }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(async () => ({
          ...(await service.logs(request.params.id, request.params.uuid, {
            ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
            ...(request.query.lines === undefined ? {} : { lines: request.query.lines }),
          })),
        })),
    );
    r.delete(
      '/projects/:id/coolify/apps/:uuid',
      {
        config: { authz: manage('ops.coolify.app.delete') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Delete an application of the project in Coolify (linked or created by it; never the control plane or another project’s target): its creation is marked deleted and the deploy targets stop listing it. Volumes are kept unless deleteVolumes=true',
          security: csrf,
          params: AppParams,
          querystring: z.object({
            deleteVolumes: z.enum(['true', 'false']).optional(),
            deleteConfigurations: z.enum(['true', 'false']).optional(),
            dockerCleanup: z.enum(['true', 'false']).optional(),
            deleteConnectedNetworks: z.enum(['true', 'false']).optional(),
            /** p17-coolify-full: the application's name as typed (must match when given). */
            confirm: z.string().min(1).max(300).optional(),
          }),
          response: {
            200: z.object({
              appUuid: z.string(),
              name: z.string(),
              unlinked: z.array(z.enum(['preview', 'production'])),
              creations: z.number().int(),
              options: z.object({
                deleteVolumes: z.boolean(),
                deleteConfigurations: z.boolean(),
                dockerCleanup: z.boolean(),
                deleteConnectedNetworks: z.boolean(),
              }),
              lost: z.array(z.string()),
              warnings: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(() => {
          const q = request.query;
          const flag = (v: 'true' | 'false' | undefined) => (v === undefined ? {} : v === 'true');
          const opts: Record<string, boolean> = {};
          for (const k of [
            'deleteVolumes',
            'deleteConfigurations',
            'dockerCleanup',
            'deleteConnectedNetworks',
          ] as const) {
            const v = flag(q[k]);
            if (typeof v === 'boolean') opts[k] = v;
          }
          const withConfirm: Record<string, unknown> =
            q.confirm === undefined ? opts : { ...opts, confirm: q.confirm };
          return service.delete(actor(request), request.params.id, request.params.uuid, withConfirm, 'api');
        }),
    );

    // p17-coolify-full: storages (volumes, file / directory mounts) and start / stop / restart of a project application.
    const StorageParams = AppParams.extend({ storage: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });
    r.get(
      '/projects/:id/coolify/apps/:uuid/storages',
      {
        config: { authz: read },
        schema: {
          tags,
          summary:
            'The storages of an application of the project — volumes, file and directory mounts (file contents never) — with warnings for data paths that have no storage; on a Coolify without the storage API, the manual step',
          security: session,
          params: AppParams,
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(async () => ({ ...(await service.storages(request.params.id, request.params.uuid)) })),
    );
    r.post(
      '/projects/:id/coolify/apps/:uuid/storages',
      {
        config: { authz: manage('ops.coolify.storage.add') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Add a volume (name, mount path, optional host path), a file mount or a host directory to an application of the project; optionally redeploy it (the storage takes effect then and starts empty)',
          security: csrf,
          params: AppParams,
          body: Json,
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.addStorage(actor(request), request.params.id, request.params.uuid, request.body, 'api'),
        ),
    );
    r.patch(
      '/projects/:id/coolify/apps/:uuid/storages/:storage',
      {
        config: { authz: manage('ops.coolify.storage.update') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change a storage of an application of the project (name, mount path, host path, file content)',
          security: csrf,
          params: StorageParams,
          body: Json,
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.updateStorage(
            actor(request),
            request.params.id,
            request.params.uuid,
            request.params.storage,
            request.body,
            'api',
          ),
        ),
    );
    r.delete(
      '/projects/:id/coolify/apps/:uuid/storages/:storage',
      {
        config: { authz: manage('ops.coolify.storage.remove') },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Remove a storage of an application of the project after its volume name or mount path was typed (confirm); says what is lost',
          security: csrf,
          params: StorageParams,
          querystring: z.object({
            confirm: z.string().min(1).max(300),
            deploy: z.enum(['true', 'false']).optional(),
          }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.removeStorage(
            actor(request),
            request.params.id,
            request.params.uuid,
            request.params.storage,
            { confirm: request.query.confirm, deploy: request.query.deploy === 'true' },
            'api',
          ),
        ),
    );
    for (const action of ['start', 'stop', 'restart'] as const) {
      r.post(
        `/projects/:id/coolify/apps/:uuid/${action}`,
        {
          config: { authz: manage(`ops.coolify.lifecycle.${action}`) },
          preHandler: stepUp,
          schema: {
            tags,
            summary: `${action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Restart'} an application of the project in Coolify (the token's deploy permission)`,
            security: csrf,
            params: AppParams,
            response: { 200: Json, ...errors },
          },
        },
        async (request) =>
          wrap(() =>
            service.lifecycle(actor(request), request.params.id, request.params.uuid, { action }, 'api'),
          ),
      );
    }
  };
}
