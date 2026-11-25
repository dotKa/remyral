import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requestStepUpMaxAge, requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import type { CoolifyResourceService } from './coolify-resources.js';
import { OpsError } from './model.js';
import type { OpsActor } from './service.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  424: ErrorBodySchema,
  429: ErrorBodySchema,
  503: ErrorBodySchema,
};
const Json = z.record(z.string(), z.unknown());
const CONN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[A-Za-z0-9]{6,64}$/;
const Kind = z.enum(['application', 'database', 'service']);
const Bool = z.enum(['true', 'false']).optional();

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpsError) throw new HttpError(err.status, err.code, err.message, err.headers);
    throw err;
  }
}

/**
 * p17-coolify-full (docs/design/p17-coolify-full.md §6): Ayarlar → Entegrasyonlar → Coolify → Kaynaklar — the whole
 * Coolify of one connection. Reads: `coolify.read`; writes: `coolify.manage`, CSRF and a standard step-up that the
 * security policy waives unless its event asks for a code (`coolify.manage`; removing, stopping and deleting are the
 * `coolify.destructive` route overrides). Bodies may carry a database password or a file's content: passed to Coolify,
 * never stored, logged or audited.
 */
export function coolifyResourceRoutes(deps: {
  readonly service: CoolifyResourceService;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const tags = ['integrations'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', deps.clock);
    const read = { authz: { action: 'coolify.read' } } as const;
    const manage = { authz: { action: 'coolify.manage' } } as const;
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
    /** The write context of a request on connection `id`. */
    const ctx = async (request: FastifyRequest, id: string) =>
      service.ctxFor(await service.handle(id), actor(request), 'api');
    const base = '/integrations/coolify/connections/:id';
    const C = z.object({ id: z.string().regex(CONN) });
    const CR = C.extend({ kind: Kind, uuid: z.string().regex(UUID) });
    const CRS = CR.extend({ storage: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });
    const CU = C.extend({ uuid: z.string().regex(UUID) });
    const CB = CU.extend({ backup: z.string().regex(/^[A-Za-z0-9-]{6,64}$/) });
    const CE = CU.extend({ environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) });
    const res = { 200: Json, ...errors };

    // ------------------------------------------------------------------------------------------ reads
    r.get(
      `${base}/resources`,
      {
        config: read,
        schema: {
          tags,
          summary:
            'Everything on a Coolify connection: applications, databases, services, servers, projects, running deployments; the version and token abilities of the last test',
          security: session,
          params: C,
          response: res,
        },
      },
      async (request) => wrap(() => service.overview(request.params.id)),
    );
    r.get(
      `${base}/resources/:kind/:uuid`,
      {
        config: read,
        schema: {
          tags,
          summary:
            'One application, database or service: status, settings, variable keys (never values), backups (databases)',
          security: session,
          params: CR,
          response: res,
        },
      },
      async (request) =>
        wrap(() => service.details(request.params.id, request.params.kind, request.params.uuid)),
    );
    r.get(
      `${base}/resources/:kind/:uuid/storages`,
      {
        config: read,
        schema: {
          tags,
          summary:
            'Storages of an application, database or service (volumes, file / directory mounts) with data-path warnings',
          security: session,
          params: CR,
          response: res,
        },
      },
      async (request) =>
        wrap(async () => ({
          ...(await service.storages(request.params.id, request.params.kind, request.params.uuid)),
        })),
    );
    r.get(
      `${base}/resources/:kind/:uuid/logs`,
      {
        config: read,
        schema: {
          tags,
          summary:
            'Container output of an application, database or service part (redacted, tail-capped; needs read:sensitive)',
          security: session,
          params: CR,
          querystring: z.object({
            lines: z.coerce.number().int().min(10).max(2000).optional(),
            sub: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
              .optional(),
          }),
          response: res,
        },
      },
      async (request) =>
        wrap(() =>
          service.logs(request.params.id, request.params.kind, request.params.uuid, {
            ...(request.query.lines === undefined ? {} : { lines: request.query.lines }),
            ...(request.query.sub === undefined ? {} : { sub: request.query.sub }),
          }),
        ),
    );
    r.get(
      `${base}/servers/:uuid`,
      {
        config: read,
        schema: {
          tags,
          summary: 'A Coolify server with its resources and domains',
          security: session,
          params: CU,
          response: res,
        },
      },
      async (request) => wrap(() => service.server(request.params.id, request.params.uuid)),
    );
    r.get(
      `${base}/projects/:uuid/environments`,
      {
        config: read,
        schema: {
          tags,
          summary: 'Environments of a Coolify project',
          security: session,
          params: CU,
          response: res,
        },
      },
      async (request) => wrap(() => service.environments(request.params.id, request.params.uuid)),
    );
    r.get(
      `${base}/databases/:uuid/backups/:backup/executions`,
      {
        config: read,
        schema: {
          tags,
          summary: 'Runs of a database backup schedule (status, file, size, time)',
          security: session,
          params: CB,
          response: res,
        },
      },
      async (request) =>
        wrap(() => service.backupExecutions(request.params.id, request.params.uuid, request.params.backup)),
    );

    // ------------------------------------------------------------------------------- storages, lifecycle
    r.post(
      `${base}/resources/:kind/:uuid/storages`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Add a volume (name, mount path, optional host path), a file mount or a host directory; optionally redeploy',
          security: csrf,
          params: CR,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.addStorage(
            await ctx(request, request.params.id),
            request.params.kind,
            request.params.uuid,
            request.body,
          ),
        ),
    );
    r.patch(
      `${base}/resources/:kind/:uuid/storages/:storage`,
      {
        config: manage,
        preHandler: stepUp,
        schema: { tags, summary: 'Change a storage', security: csrf, params: CRS, body: Json, response: res },
      },
      async (request) =>
        wrap(async () =>
          service.updateStorage(
            await ctx(request, request.params.id),
            request.params.kind,
            request.params.uuid,
            request.params.storage,
            request.body,
          ),
        ),
    );
    r.delete(
      `${base}/resources/:kind/:uuid/storages/:storage`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Remove a storage after its volume name or mount path was typed (confirm); says what is lost',
          security: csrf,
          params: CRS,
          querystring: z.object({ confirm: z.string().min(1).max(300), deploy: Bool }),
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.removeStorage(
            await ctx(request, request.params.id),
            request.params.kind,
            request.params.uuid,
            request.params.storage,
            { confirm: request.query.confirm, deploy: request.query.deploy === 'true' },
          ),
        ),
    );
    for (const action of ['start', 'stop', 'restart'] as const) {
      r.post(
        `${base}/resources/:kind/:uuid/${action}`,
        {
          config: manage,
          preHandler: stepUp,
          schema: {
            tags,
            summary: `${action[0]?.toUpperCase() ?? ''}${action.slice(1)} an application, database or service`,
            security: csrf,
            params: CR,
            querystring: z.object({ latest: Bool }),
            response: res,
          },
        },
        async (request) =>
          wrap(async () =>
            service.lifecycle(
              await ctx(request, request.params.id),
              request.params.kind,
              request.params.uuid,
              {
                action,
                ...(request.query.latest === undefined ? {} : { latest: request.query.latest === 'true' }),
              },
            ),
          ),
      );
    }
    r.post(
      `${base}/deployments/:uuid/cancel`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Cancel a running deployment',
          security: csrf,
          params: C.extend({ uuid: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/) }),
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.cancelDeployment(await ctx(request, request.params.id), request.params.uuid),
        ),
    );

    // ------------------------------------------------------------------------------------------ databases
    r.post(
      `${base}/databases`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create a database (postgresql, mysql, mariadb, mongodb, redis, keydb, dragonfly, clickhouse); without a password Coolify generates one',
          security: csrf,
          params: C,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () => service.createDatabase(await ctx(request, request.params.id), request.body)),
    );
    r.patch(
      `${base}/databases/:uuid`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Change a database (name, image, public port, limits, health check)',
          security: csrf,
          params: CU,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.updateDatabase(await ctx(request, request.params.id), request.params.uuid, request.body),
        ),
    );
    const DeleteQuery = z.object({
      confirm: z.string().min(1).max(300),
      deleteVolumes: Bool,
      deleteConfigurations: Bool,
      dockerCleanup: Bool,
      deleteConnectedNetworks: Bool,
    });
    const deleteOpts = (q: z.infer<typeof DeleteQuery>): Record<string, unknown> => {
      const out: Record<string, unknown> = { confirm: q.confirm };
      for (const k of [
        'deleteVolumes',
        'deleteConfigurations',
        'dockerCleanup',
        'deleteConnectedNetworks',
      ] as const) {
        if (q[k] !== undefined) out[k] = q[k] === 'true';
      }
      return out;
    };
    for (const kind of ['database', 'service'] as const) {
      r.delete(
        `${base}/${kind}s/:uuid`,
        {
          config: manage,
          preHandler: stepUp,
          schema: {
            tags,
            summary: `Delete a ${kind} after its name was typed (confirm); volumes kept unless deleteVolumes=true`,
            security: csrf,
            params: CU,
            querystring: DeleteQuery,
            response: res,
          },
        },
        async (request) =>
          wrap(async () =>
            service.deleteResource(
              await ctx(request, request.params.id),
              kind,
              request.params.uuid,
              deleteOpts(request.query),
            ),
          ),
      );
    }
    r.post(
      `${base}/databases/:uuid/backups`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Schedule a backup of a database (frequency, S3, retention; backupNow)',
          security: csrf,
          params: CU,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.createBackup(await ctx(request, request.params.id), request.params.uuid, request.body),
        ),
    );
    r.patch(
      `${base}/databases/:uuid/backups/:backup`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Change a backup schedule, or run it now (backupNow)',
          security: csrf,
          params: CB,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.updateBackup(
            await ctx(request, request.params.id),
            request.params.uuid,
            request.params.backup,
            request.body,
          ),
        ),
    );
    r.delete(
      `${base}/databases/:uuid/backups/:backup`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Delete a backup schedule (backup files already made stay)',
          security: csrf,
          params: CB,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.deleteBackup(
            await ctx(request, request.params.id),
            request.params.uuid,
            request.params.backup,
          ),
        ),
    );

    // ------------------------------------------------------------------------------------------- services
    r.post(
      `${base}/services`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Create a service from a one-click template (type) or a Docker Compose file',
          security: csrf,
          params: C,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () => service.createService(await ctx(request, request.params.id), request.body)),
    );
    r.patch(
      `${base}/services/:uuid`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Change a service (name, description, URLs)',
          security: csrf,
          params: CU,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.updateService(await ctx(request, request.params.id), request.params.uuid, request.body),
        ),
    );
    r.put(
      `${base}/services/:uuid/envs`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set or remove variables of a service (values go to Coolify, never stored); optionally restart',
          security: csrf,
          params: CU,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.serviceEnvs(await ctx(request, request.params.id), request.params.uuid, request.body),
        ),
    );

    // --------------------------------------------------------------------- servers, projects, environments
    r.post(
      `${base}/servers/:uuid/validate`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Check a server (SSH, Docker) in Coolify — installs nothing',
          security: csrf,
          params: CU,
          response: res,
        },
      },
      async (request) =>
        wrap(async () => service.validateServer(await ctx(request, request.params.id), request.params.uuid)),
    );
    r.post(
      `${base}/projects`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Create a Coolify project',
          security: csrf,
          params: C,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () => service.createProject(await ctx(request, request.params.id), request.body)),
    );
    r.delete(
      `${base}/projects/:uuid`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Delete an empty Coolify project after its name was typed (confirm)',
          security: csrf,
          params: CU,
          querystring: z.object({ confirm: z.string().min(1).max(300) }),
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.deleteProject(await ctx(request, request.params.id), request.params.uuid, {
            confirm: request.query.confirm,
          }),
        ),
    );
    r.post(
      `${base}/projects/:uuid/environments`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Create an environment in a Coolify project',
          security: csrf,
          params: CU,
          body: Json,
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.createEnvironment(await ctx(request, request.params.id), request.params.uuid, request.body),
        ),
    );
    r.delete(
      `${base}/projects/:uuid/environments/:environment`,
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Delete an empty environment after its name was typed (confirm)',
          security: csrf,
          params: CE,
          querystring: z.object({ confirm: z.string().min(1).max(300) }),
          response: res,
        },
      },
      async (request) =>
        wrap(async () =>
          service.deleteEnvironment(
            await ctx(request, request.params.id),
            request.params.uuid,
            request.params.environment,
            { confirm: request.query.confirm },
          ),
        ),
    );
  };
}
