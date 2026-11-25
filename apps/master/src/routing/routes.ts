import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { HistoricalRuntimeKind, isRetiredRuntime, JobRole, RuntimeKind } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { visibleProjects } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { RUNTIME_REMOVED_MESSAGE } from '../jobs/errors.js';
import { actorOf } from '../workers/routes.js';
import { RoutingRuleInvalidError, type RoutingService } from './rules.js';
import { listJobStats, STATS_GROUPS } from './stats.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

const RuleBody = z.object({
  project: z.string().nullable(),
  role: z.string(),
  modelProfile: z.string().nullable(),
  runtimes: z.array(z.string()),
});

const StatsBody = z.object({
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  kind: z.string().nullable(),
  project: z.string().nullable(),
  workerId: z.string().nullable(),
  attempts: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  successRate: z.number().nullable(),
  p50DurationSec: z.number().nullable(),
  p90DurationSec: z.number().nullable(),
  meanDurationSec: z.number().nullable(),
  costUsd: z.number(),
  costPerAttemptUsd: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  lastAt: z.string(),
});

/**
 * p6-smart-routing API (docs/design/p6-smart-routing.md §5):
 *
 * - `GET /routing/rules[?project=]` — global rules and the project's overrides (models.read, viewer+);
 * - `PUT /routing/rules` — set or clear one kind's rule, globally (`project: null`) or for a project (models.write:
 *   admin, step-up, CSRF), like the model defaults;
 * - `GET /usage/job-stats` — the outcome rollup grouped by runtime / model / kind / project / worker (usage.read;
 *   only the caller's visible projects).
 */
export function routingRoutes(service: RoutingService, db: Queryable, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/routing/rules',
      {
        config: { authz: { action: 'models.read' } },
        schema: {
          tags: ['models'],
          summary:
            'Routing rules: job kind → model profile and runtime order, global and per project (viewer+)',
          security: [{ session: [] }],
          querystring: z.object({ project: z.string().regex(PROJECT).optional() }),
          response: { 200: z.object({ rules: z.array(RuleBody) }), ...errors },
        },
      },
      async (request) => ({ rules: await service.list(request.query.project) }),
    );

    r.put(
      '/routing/rules',
      {
        config: { authz: { action: 'models.write' } },
        preHandler: stepUp,
        schema: {
          tags: ['models'],
          summary:
            'Set (or clear, with no model profile and no runtimes) the routing rule of a job kind, globally or for a project (admin, step-up)',
          security: [{ session: [], csrf: [] }],
          body: z.strictObject({
            project: z.string().regex(PROJECT).nullable(),
            role: JobRole,
            modelProfile: z
              .string()
              .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
              .nullable(),
            // ADR-0023: a removed runtime is parsed so it can be refused with its own code.
            runtimes: z.array(HistoricalRuntimeKind).max(RuntimeKind.options.length),
          }),
          response: { 200: z.object({ rules: z.array(RuleBody) }), ...errors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        try {
          if (b.runtimes.some((x) => isRetiredRuntime(x))) {
            throw new RoutingRuleInvalidError(
              [{ path: 'runtimes', code: 'runtime_removed' }],
              RUNTIME_REMOVED_MESSAGE,
            );
          }
          const runtimes = b.runtimes.filter((x): x is RuntimeKind => RuntimeKind.safeParse(x).success);
          return { rules: await service.set({ ...b, runtimes }, actorOf(request)) };
        } catch (err) {
          if (err instanceof RoutingRuleInvalidError) {
            return reply
              .code(400)
              .send({ error: err.code, message: err.publicMessage, issues: [...err.issues] });
          }
          throw err;
        }
      },
    );

    r.get(
      '/usage/job-stats',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags: ['usage'],
          summary:
            'Job outcome statistics (success rate, p50/p90 duration, cost) per runtime × model × kind × project × machine (viewer+)',
          security: [{ session: [] }],
          querystring: z.object({
            groupBy: z
              .string()
              .default('runtime,model,kind')
              .transform((v) => v.split(',').filter((x) => x !== ''))
              .pipe(z.array(z.enum(STATS_GROUPS)).max(STATS_GROUPS.length)),
            project: z.string().regex(PROJECT).optional(),
            runtime: z.string().max(32).optional(),
            kind: z.union([JobRole, z.literal('unclassified')]).optional(),
            workerId: z.string().regex(PROJECT).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
          response: { 200: z.object({ items: z.array(StatsBody) }), ...errors },
        },
      },
      async (request) => {
        const q = request.query;
        const projects = visibleProjects(authzOf(request).subject);
        if (q.project !== undefined && projects !== null && !projects.includes(q.project)) {
          throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
        }
        const items = await listJobStats(db, {
          projects,
          project: q.project,
          runtime: q.runtime,
          kind: q.kind === 'unclassified' ? '' : q.kind,
          workerId: q.workerId,
          groupBy: q.groupBy,
          limit: q.limit,
        });
        return { items };
      },
    );
  };
}
