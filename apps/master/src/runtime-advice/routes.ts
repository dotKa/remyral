import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { visibleProjects } from '../authz/model.js';
import { bodyField, jobResource, paramTarget, projectParam } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { RuntimeAdviceService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Signal = z.object({ source: z.string(), area: z.string(), weight: z.number(), detail: z.string() });
const Classification = z.object({
  kind: z.string().nullable(),
  kindSource: z.string().nullable(),
  area: z.string().nullable(),
  areaSource: z.string().nullable(),
  scores: z.record(z.string(), z.number()),
  signals: z.array(Signal),
});
const Advice = z.object({
  recommended: z.string().nullable(),
  confidence: z.enum(['strong', 'weak', 'insufficient']),
  scope: z.string(),
  text: z.string(),
  options: z.array(
    z.object({
      runtime: z.string(),
      n: z.number().int(),
      rate: z.number(),
      low: z.number(),
      high: z.number(),
      rawRate: z.number().nullable(),
      medianDurationSec: z.number().nullable(),
      meanCostUsd: z.number().nullable(),
      counted: z.boolean(),
    }),
  ),
});
const Trend = z.object({ n: z.number().int(), rate: z.number().nullable() });
const Settings = z.object({
  mode: z.string(),
  explorationPct: z.number(),
  minSamples: z.number(),
  allowedRuntimes: z.array(z.string()),
  allowPaid: z.boolean(),
  halfLifeDays: z.number(),
  rerunWindowDays: z.number(),
  areaRules: z.array(z.object({ area: z.string(), globs: z.array(z.string()) })),
});

function actor(request: FastifyRequest): { userId: string; ip: string | null; userAgent: string | null } {
  const meta = requestMeta(request);
  return { userId: sessionOf(request).user.id, ip: meta.ip, userAgent: meta.userAgent };
}

function bodyProject(request: FastifyRequest) {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

/**
 * p11-runtime-advice REST (docs/design/p11-runtime-advice.md §7):
 *
 * - `POST /routing/advice` — advice for a draft (jobs.create on the project, like the placement preview; no side
 *   effects);
 * - `GET /usage/runtime-outcomes?project=` — the runtime × area matrix (usage.read; visible projects only);
 * - `GET|PUT /projects/:id/runtime-advice` — the project's settings (policy.read / policy.write + step-up, audited);
 * - `PUT /jobs/:id/rating` — 👍 / 👎 on a finished job (jobs.merge: operator+, the acceptance judgement; audited);
 * - `GET /jobs/:id/runtime-outcome` — classification, auto decision, rating, outcome judgement (jobs.read).
 */
export function runtimeAdviceRoutes(deps: {
  readonly service: RuntimeAdviceService;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];

    r.post(
      '/routing/advice',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Runtime advice for a job being composed: its classification (kind, area, signals) and the runtime with the best good-outcome record for this project area (operator+, no side effects)',
          security: csrf,
          body: z.strictObject({
            project: z.string().regex(PROJECT),
            prompt: z.string().max(4000).optional(),
            role: z.string().max(32).optional(),
            area: z.string().max(32).optional(),
            paths: z.array(z.string().max(300)).max(32).optional(),
            templateName: z.string().max(200).optional(),
          }),
          response: {
            200: z.object({ mode: z.string(), classification: Classification, advice: Advice.nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const b = request.body;
        const view = await deps.service.advise(b.project, b);
        return view as never;
      },
    );

    r.get(
      '/usage/runtime-outcomes',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags: ['usage'],
          summary:
            'Good-outcome rate per runtime × work area of one project, smoothed towards the fleet, with intervals, trend and models (viewer+)',
          security: session,
          querystring: z.object({ project: z.string().regex(PROJECT) }),
          response: {
            200: z.object({
              project: z.string(),
              settings: Settings,
              runtimes: z.array(z.string()),
              areas: z.array(z.string().nullable()),
              jobs: z.number().int(),
              cells: z.array(
                z.object({
                  area: z.string().nullable(),
                  runtime: z.string(),
                  n: z.number().int(),
                  rate: z.number(),
                  low: z.number(),
                  high: z.number(),
                  rawRate: z.number().nullable(),
                  medianDurationSec: z.number().nullable(),
                  meanCostUsd: z.number().nullable(),
                  recent: Trend,
                  previous: Trend,
                  models: z.array(
                    z.object({ model: z.string(), n: z.number().int(), good: z.number().int() }),
                  ),
                }),
              ),
              advice: z.array(
                z.object({
                  area: z.string().nullable(),
                  recommended: z.string().nullable(),
                  text: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const projects = visibleProjects(authzOf(request).subject);
        const p = request.query.project;
        if (projects !== null && !projects.includes(p))
          throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
        return (await deps.service.matrix(p)) as never;
      },
    );

    r.get(
      '/projects/:id/runtime-advice',
      {
        config: { authz: { action: 'policy.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'A project’s runtime-advice settings: advice / auto mode, exploration, minimum samples, path rules (owner/admin)',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: { 200: z.object({ settings: Settings }), ...errors },
        },
      },
      async (request) => ({ settings: await deps.service.settings(request.params.id) }),
    );

    r.put(
      '/projects/:id/runtime-advice',
      {
        config: {
          authz: {
            action: 'policy.write',
            resource: projectParam(),
            auditDenied: { action: 'project.runtime_advice.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags: ['projects'],
          summary: 'Change a project’s runtime-advice settings (owner/admin, step-up, audited)',
          security: csrf,
          params: z.object({ id: z.string().regex(PROJECT) }),
          body: z.object({ settings: z.record(z.string(), z.unknown()) }),
          response: { 200: z.object({ settings: Settings }), ...errors },
        },
      },
      async (request) => ({
        settings: await deps.service.saveSettings(request.params.id, request.body.settings, actor(request)),
      }),
    );

    r.put(
      '/jobs/:id/rating',
      {
        config: {
          authz: {
            action: 'jobs.merge',
            resource: jobResource(deps.service.pool),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            auditDenied: { action: 'job.rating.set', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Rate a finished job 👍 (1) / 👎 (-1), or clear the rating (null); feeds runtime advice (operator+)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.strictObject({ rating: z.union([z.literal(1), z.literal(-1), z.null()]) }),
          response: { 200: z.object({ rating: z.number().nullable() }), ...errors },
        },
      },
      async (request) => {
        await deps.service.rate(request.params.id, request.body.rating, actor(request));
        return { rating: request.body.rating };
      },
    );

    r.get(
      '/jobs/:id/runtime-outcome',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(deps.service.pool),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'How the job was classified (kind, area, signals), why auto mode chose its runtime, its rating and outcome judgement (viewer+)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          response: {
            200: z.object({
              classification: z
                .object({
                  kind: z.string().nullable(),
                  kindSource: z.string().nullable(),
                  area: z.string().nullable(),
                  areaSource: z.string().nullable(),
                  signals: z.array(Signal),
                  stage: z.string(),
                })
                .nullable(),
              decision: z
                .object({
                  runtime: z.string(),
                  how: z.string(),
                  reasons: z.array(z.string()),
                  considered: z.array(
                    z.object({
                      runtime: z.string(),
                      n: z.number(),
                      rate: z.number().nullable(),
                      excluded: z.string().nullable(),
                    }),
                  ),
                  decidedAt: z.string(),
                })
                .nullable(),
              rating: z.object({ value: z.number(), at: z.string() }).nullable(),
              outcome: z
                .object({
                  good: z.boolean(),
                  reasons: z.array(z.string()),
                  runtime: z.string(),
                  model: z.string(),
                })
                .nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => (await deps.service.jobView(request.params.id)) as never,
    );
  };
}
