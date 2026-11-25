import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import {
  BLOB_MODES,
  MAINTENANCE_KINDS,
  type MaintenanceJobView,
  type MaintenanceService,
} from './service.js';

/**
 * p17-panel-settings Part 7 (docs/design/p17-panel-settings.md §9): maintenance jobs from Ayarlar → Sunucu ayarları →
 * Bakım. `GET /maintenance/jobs[/:id]` (`maintenance.read`, admin+), `POST /maintenance/jobs` (`maintenance.run`,
 * owners, step-up event `maintenance.run`; a real run needs a recent dry run), `POST /maintenance/jobs/:id/cancel`.
 */
const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};
const tags = ['maintenance'];

const Params = z.strictObject({
  mode: z.enum(BLOB_MODES).optional(),
  kinds: z.array(z.string().max(40)).max(20).optional(),
  projects: z.array(z.string().max(128)).max(200).optional(),
});

export const JobBody = z.object({
  id: z.string(),
  kind: z.enum(MAINTENANCE_KINDS),
  params: z.object({
    mode: z.string().optional(),
    kinds: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
  }),
  dryRun: z.boolean(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  progress: z.object({
    done: z.number(),
    total: z.number().nullable(),
    step: z.string(),
    lines: z.array(z.string()),
  }),
  report: z.unknown(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  startedBy: z.string().nullable(),
});

function copy(j: MaintenanceJobView): z.infer<typeof JobBody> {
  return {
    ...j,
    params: {
      ...(j.params.mode === undefined ? {} : { mode: j.params.mode }),
      ...(j.params.kinds === undefined ? {} : { kinds: [...j.params.kinds] }),
      ...(j.params.projects === undefined ? {} : { projects: [...j.params.projects] }),
    },
    progress: { ...j.progress, lines: [...j.progress.lines] },
  };
}

export function maintenanceRoutes(deps: {
  readonly service: MaintenanceService;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, deps.clock);
    r.get(
      '/maintenance/jobs',
      {
        config: { authz: { action: 'maintenance.read' as const } },
        schema: {
          tags,
          summary: 'The maintenance jobs (newest first): kind, parameters, dry run, progress, report',
          security: [{ session: [] }],
          response: { 200: z.object({ items: z.array(JobBody) }), ...errors },
        },
      },
      async () => ({ items: (await deps.service.list()).map(copy) }),
    );
    r.get(
      '/maintenance/jobs/:id',
      {
        config: { authz: { action: 'maintenance.read' as const } },
        schema: {
          tags,
          summary: 'One maintenance job with its progress (the panel polls it)',
          security: [{ session: [] }],
          params: z.object({ id: z.string().max(64) }),
          response: { 200: JobBody, ...errors },
        },
      },
      async (request) => copy(await deps.service.get(request.params.id)),
    );
    r.post(
      '/maintenance/jobs',
      {
        config: { authz: { action: 'maintenance.run' as const } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Start a maintenance job in the background (blobs:migrate, search:backfill, memory:autolearn); a real run needs a recent dry run',
          security: [{ session: [], csrf: [] }],
          body: z.strictObject({
            kind: z.enum(MAINTENANCE_KINDS),
            params: Params.default({}),
            dryRun: z.boolean(),
          }),
          response: { 200: JobBody, ...errors },
        },
      },
      async (request) =>
        copy(
          await deps.service.start(
            actorOf(request),
            request.body.kind,
            {
              ...(request.body.params.mode === undefined ? {} : { mode: request.body.params.mode }),
              ...(request.body.params.kinds === undefined ? {} : { kinds: request.body.params.kinds }),
              ...(request.body.params.projects === undefined
                ? {}
                : { projects: request.body.params.projects }),
            },
            request.body.dryRun,
          ),
        ),
    );
    r.post(
      '/maintenance/jobs/:id/cancel',
      {
        config: { authz: { action: 'maintenance.run' as const } },
        schema: {
          tags,
          summary: 'Cancel a running maintenance job (it stops at its next step)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.string().max(64) }),
          response: { 200: JobBody, ...errors },
        },
      },
      async (request) => copy(await deps.service.cancel(actorOf(request), request.params.id)),
    );
  };
}
