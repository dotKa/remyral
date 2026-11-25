import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { actorOf } from '../workers/routes.js';
import type { OffPeakView, QuotaSchedulingService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });

const Window = z.object({ start: z.string(), end: z.string(), timeZone: z.string() });
const OffPeakBody = z.object({
  project: z.string(),
  window: Window.nullable(),
  open: z.boolean(),
  nextStart: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const json = (v: OffPeakView): z.infer<typeof OffPeakBody> => ({
  project: v.project,
  window: v.window === null ? null : { ...v.window },
  open: v.open,
  nextStart: v.nextStart?.toISOString() ?? null,
  updatedBy: v.updatedBy,
  updatedAt: v.updatedAt?.toISOString() ?? null,
});

/**
 * p6-quota-scheduling API (docs/design/p6-quota-scheduling.md §6). The off-peak window is part of a project's
 * execution policy (`projects.execution.*`: viewers read, admins change with step-up); "Run now" is a job action
 * of the job's operators (`jobs.create`), like submitting it was. Writes audited; denials audited by the
 * authorization layer.
 */
export function quotaSchedulingRoutes(deps: {
  readonly service: QuotaSchedulingService;
  readonly db: Queryable;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, deps.clock);

    r.get(
      '/projects/:id/off-peak',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'A project’s off-peak window for deferrable jobs (wall-clock start/end in an IANA time zone), whether it is open and when it next opens',
          security: session,
          params: ProjectParams,
          response: { 200: OffPeakBody, ...errors },
        },
      },
      async (request) => json(await deps.service.window(request.params.id)),
    );

    r.put(
      '/projects/:id/off-peak',
      {
        config: {
          authz: {
            action: 'projects.execution.write',
            resource: projectParam(),
            auditDenied: { action: 'project.off_peak.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            'Set or clear a project’s off-peak window (admin, step-up, audited). `start`/`end` "HH:MM" (different; start after end crosses midnight), `timeZone` an IANA zone. null: deferrable jobs run at once.',
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({
            window: z
              .strictObject({
                start: z.string().max(5),
                end: z.string().max(5),
                timeZone: z.string().max(64),
              })
              .nullable(),
          }),
          response: { 200: OffPeakBody, ...errors },
        },
      },
      async (request) =>
        json(await deps.service.setWindow(request.params.id, request.body.window, actorOf(request))),
    );

    r.post(
      '/jobs/:id/run-now',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            auditDenied: { action: 'job.run_now', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Start a deferred job now instead of waiting for its project’s off-peak window (operator+, audited). 409 when the job is not deferrable or no longer queued.',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ jobId: z.string(), state: z.string() }), ...errors },
        },
      },
      async (request) => deps.service.runNow(request.params.id, actorOf(request)),
    );
  };
}
