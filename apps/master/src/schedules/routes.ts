import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { type Resource, visibleProjects } from '../authz/model.js';
import { bodyField, param, paramTarget, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { ScheduleError, ScheduleInput, type ScheduleService } from './service.js';
import { JOB_CREATE_BODY_LIMIT } from '../orchestration/routes.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ScheduleBody = z.object({
  id: z.string(),
  project: z.string(),
  name: z.string(),
  target: z.object({
    kind: z.enum(['job', 'workflow']),
    runtime: z.string().nullable(),
    workflowId: z.string().nullable(),
  }),
  when: z.union([
    z.object({ kind: z.literal('at'), at: z.string() }),
    z.object({ kind: z.literal('cron'), cron: z.string() }),
  ]),
  state: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastJobId: z.string().nullable(),
  lastRunId: z.string().nullable(),
  lastError: z.string().nullable(),
  runCount: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
  automationId: z.string(),
});

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

function scheduleResource(db: Queryable) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const { rows } = await db.query<{ project: string }>(
      "SELECT project FROM automations WHERE id = $1 AND trigger_kind IN ('cron', 'at')",
      [id],
    );
    const project = rows[0]?.project;
    return project === undefined ? null : { project };
  };
}

function toHttp(err: unknown): unknown {
  return err instanceof ScheduleError ? new HttpError(err.status, err.code, err.message) : err;
}

/**
 * Schedules REST (docs/design/p5-composer.md §4) — since p6-automations an alias over `cron` / `at` automations
 * (audited as `automation.*`). Reads `schedules.read` (viewer+, project-scoped; lists are
 * filtered to visible projects); create `schedules.write` (operator+ in the project) **with step-up**; cancel
 * `schedules.write`.
 */
export function scheduleRoutes(deps: {
  readonly schedules: ScheduleService;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['schedules'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'schedule_not_found', 'Schedule not found.');

    r.get(
      '/schedules',
      {
        config: { authz: { action: 'schedules.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'Schedules of visible projects (viewer+), active first',
          security: session,
          querystring: z.object({ project: z.string().regex(PROJECT).optional(), ...offsetQuery(500) }),
          response: { 200: z.object({ items: z.array(ScheduleBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        pageArray(
          await deps.schedules.list(visibleProjects(authzOf(request).subject), request.query.project),
          request.query,
        ),
    );

    r.get(
      '/schedules/cron-preview',
      {
        config: { authz: { action: 'schedules.read' } },
        schema: {
          tags,
          summary: 'Validate a cron expression (UTC) and list its next run times (viewer+)',
          security: session,
          querystring: z.object({ cron: z.string().min(1).max(120) }),
          response: { 200: z.object({ cron: z.string(), nextRuns: z.array(z.string()) }), ...errors },
        },
      },
      async (request) => {
        await Promise.resolve();
        try {
          return {
            cron: request.query.cron,
            nextRuns: deps.schedules.preview(request.query.cron).map((d) => d.toISOString()),
          };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/schedules',
      {
        // p5-research-workspace-next: input files of a workspace job travel base64 in the body.
        bodyLimit: JOB_CREATE_BODY_LIMIT,
        config: {
          authz: {
            action: 'schedules.write',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'schedule.create', target: () => null },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'Schedule a job or a workflow run: once at a time, or on a cron (UTC) (operator+, step-up)',
          security: csrf,
          body: ScheduleInput,
          response: { 201: ScheduleBody, ...errors },
        },
      },
      async (request, reply) => {
        const user = sessionOf(request).user;
        try {
          const s = await deps.schedules.create({ id: user.id, ...requestMeta(request) }, request.body);
          return await reply.code(201).send(s);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.delete(
      '/schedules/:id',
      {
        config: {
          authz: {
            action: 'schedules.write',
            resource: scheduleResource(deps.db),
            notFound,
            auditDenied: { action: 'schedule.cancel', target: paramTarget('schedule') },
          },
        },
        schema: {
          tags,
          summary: 'Cancel a schedule (operator+); jobs it already created are not affected',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          response: { 200: ScheduleBody, ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          return await deps.schedules.cancel({ id: user.id, ...requestMeta(request) }, request.params.id);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );
  };
}
