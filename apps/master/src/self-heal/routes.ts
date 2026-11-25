import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { visibleProjects } from '../authz/model.js';
import { jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { ConflictResolveService } from './conflict-resolve.js';
import type { SelfHealService } from './service.js';

const errors = { 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema };

const Detail = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const JobAutonomyBody = z.object({
  retry: z
    .object({
      used: z.number().int(),
      max: z.number().int(),
      cause: z.string(),
      retryAt: z.string().nullable(),
      waiting: z.boolean(),
    })
    .nullable(),
  fix: z
    .object({ fixJobId: z.string().nullable(), state: z.string(), reason: z.string().nullable() })
    .nullable(),
  fixOf: z.string().nullable(),
  // p22-conflict-resolve: the conflict-resolution job of this job, and the job this one resolves.
  conflictResolve: z
    .object({
      resolveJobId: z.string().nullable(),
      state: z.enum(['created', 'skipped', 'merged', 'failed']),
      reason: z.string().nullable(),
      prClosed: z.boolean(),
    })
    .nullable(),
  conflictResolveOf: z.string().nullable(),
  conflictResolvable: z.boolean(),
  events: z.array(z.object({ id: z.string(), kind: z.string(), detail: Detail, at: z.string() })),
});

export const FailureDigestBody = z.object({
  since: z.string(),
  failed: z.number().int(),
  healed: z.number().int(),
  waiting: z.number().int(),
});

/**
 * p15-auto-mode (docs/design/p15-auto-mode.md §7): `GET /jobs/:id/autonomy` — what the platform did by itself for a
 * job (auto-approvals, automatic retries "2/3", healed base ref, rebase, auto-fix job); `GET /autonomy/digest` — the
 * 24-hour failure digest of the caller's projects. Both viewer+ (`jobs.read`), read-only.
 */
export function selfHealRoutes(deps: {
  readonly service: SelfHealService;
  readonly db: Queryable;
  readonly conflicts?: ConflictResolveService | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    r.get(
      '/jobs/:id/autonomy',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'What the platform did by itself for the job: approvals auto mode granted, automatic retries, a healed base ref, a rebase, the auto-fix job',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: JobAutonomyBody, ...errors },
        },
      },
      async (request) => {
        const v = await deps.service.jobView(request.params.id);
        return { ...v, events: v.events.map((e) => ({ ...e, detail: { ...e.detail } })) };
      },
    );
    // p22-conflict-resolve (docs/design/p22-conflict-resolve.md): "Çakışmayı çöz".
    r.post(
      '/jobs/:id/resolve-conflicts',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            auditDenied: { action: 'job.conflict_resolve', target: paramTarget('job') },
          },
        },
        schema: {
          tags,
          summary:
            'Carry a verified result that conflicts with its target onto the current target: a new job merges it into the current target, resolves the conflicts and finishes the task; when it merges, this job is superseded and its pull request closed (operator+, audited)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          response: {
            201: z.object({ jobId: z.string() }),
            ...errors,
            409: ErrorBodySchema,
            503: ErrorBodySchema,
          },
        },
      },
      async (request, reply) => {
        const svc = deps.conflicts ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Conflict resolution is not available.',
            {},
            {},
            { reason: 'conflict_resolve' },
          );
        const out = await svc.resolve(request.params.id, {
          subject: authzOf(request).subject,
          via: 'console',
        });
        return reply.code(201).send(out);
      },
    );
    r.get(
      '/autonomy/digest',
      {
        config: { authz: { action: 'jobs.read' } },
        schema: {
          tags,
          summary:
            'The last 24 hours of the caller’s projects: failed jobs, jobs the platform healed by itself, decisions waiting for a person',
          security: [{ session: [] }],
          response: { 200: FailureDigestBody, ...errors },
        },
      },
      async (request) => deps.service.digest(visibleProjects(authzOf(request).subject)),
    );
  };
}
