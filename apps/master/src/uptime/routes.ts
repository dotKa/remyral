import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { type Resource, visibleProjects } from '../authz/model.js';
import { bodyField, param, projectQuery } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { cursorOrBadRequest, keysetQuery, offsetQuery, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { LIMITS, MonitorInput, MonitorPatch, OutputKey, RATE } from './model.js';
import type { UptimeActor, UptimeService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Project = z.string().regex(PROJECT);
const IdParams = z.object({ id: z.string().regex(UUID) });
const Status = z.enum(['pending', 'up', 'down']);
const Type = z.enum(['http', 'tcp', 'pages', 'coolify']);

export const MonitorBody = z.object({
  id: z.string(),
  project: z.string(),
  name: z.string(),
  type: Type,
  config: z.record(z.string(), z.unknown()),
  outputKey: z.string().nullable(),
  coolifyConnection: z.string().nullable(),
  intervalSec: z.number().int(),
  timeoutMs: z.number().int(),
  retries: z.number().int(),
  paused: z.boolean(),
  status: Status,
  flapping: z.boolean(),
  consecutiveFailures: z.number().int(),
  statusChangedAt: z.string().nullable(),
  lastCheck: z
    .object({
      at: z.string(),
      ok: z.boolean().nullable(),
      latencyMs: z.number().int().nullable(),
      statusCode: z.number().int().nullable(),
      error: z.string().nullable(),
      detail: z.string().nullable(),
    })
    .nullable(),
  tls: z.object({ expiresAt: z.string(), daysLeft: z.number().int(), warning: z.boolean() }).nullable(),
  uptime: z.object({ h24: z.number().nullable(), d7: z.number().nullable(), d30: z.number().nullable() }),
  latencyAvg24h: z.number().int().nullable(),
  sparkline: z.array(z.number().int().nullable()),
  openIncident: z.object({ id: z.string(), startedAt: z.string(), cause: z.string() }).nullable(),
  nextCheckAt: z.string(),
  createdBy: z.object({ type: z.enum(['user', 'system']), id: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const IncidentBody = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  cause: z.string(),
  detail: z.string().nullable(),
  suppressed: z.boolean(),
});
const CheckBody = z.object({
  id: z.string(),
  at: z.string(),
  ok: z.boolean().nullable(),
  latencyMs: z.number().int().nullable(),
  statusCode: z.number().int().nullable(),
  error: z.string().nullable(),
  detail: z.string().nullable(),
});
const PointBody = z.object({
  t: z.string(),
  uptime: z.number().nullable(),
  latencyAvg: z.number().int().nullable(),
  latencyMax: z.number().int().nullable(),
  checks: z.number().int(),
});
const SettingsBody = z.object({
  project: z.string(),
  autoMonitor: z.boolean(),
  updatedAt: z.string().nullable(),
});

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

/**
 * p8-uptime (docs/design/p8-uptime.md §7): the Uptime API. Reads need `uptime.read` (viewer) in the monitor's project,
 * monitor writes `uptime.write` (operator) + CSRF, the project's auto-monitor setting `uptime.settings` (admin). Every
 * write is audited and rate-limited per user on top of the central classes.
 */
export function uptimeRoutes(deps: { readonly service: UptimeService; readonly limiter: RateLimiter }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['uptime'];
    const actor = (request: FastifyRequest): UptimeActor => ({
      type: 'user',
      id: sessionOf(request).user.id,
      ...requestMeta(request),
    });
    const limit = async (request: FastifyRequest, bucket: keyof typeof RATE): Promise<void> => {
      const rule = RATE[bucket];
      const res = await deps.limiter.hit(
        `uptime-${bucket}`,
        sessionOf(request).user.id,
        rule.max,
        rule.windowMs,
      );
      if (!res.allowed) {
        throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
          'retry-after': String(Math.max(1, Math.ceil(res.retryAfterMs / 1000))),
        });
      }
    };
    const monitorResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.projectOf(id);
      return project === null ? null : { project };
    };
    const notFound = () => new HttpError(404, 'monitor_not_found', 'Monitor not found.');

    r.get(
      '/uptime/monitors',
      {
        config: { authz: { action: 'uptime.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Monitors of visible projects with status, uptime % (24 h / 7 d / 30 d), 24 h latency sparkline and the open incident (down first)',
          security: session,
          querystring: z.object({
            project: Project.optional(),
            status: z.enum(['pending', 'up', 'down', 'paused']).optional(),
            q: z.string().max(200).optional(),
            outputKey: OutputKey.optional(),
            ...offsetQuery(LIMITS.listMax),
          }),
          response: { 200: z.object({ items: z.array(MonitorBody), ...pageFields }), ...errors },
        },
      },
      async (request) => service.listPage(visibleProjects(authzOf(request).subject), request.query),
    );

    r.post(
      '/uptime/monitors',
      {
        config: {
          authz: {
            action: 'uptime.write',
            resource: bodyProject,
            auditDenied: { action: 'uptime.monitor.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Create a monitor: http(s) (GET/HEAD, status range, keyword, max latency, redirects, TLS warning), tcp, Cloudflare Pages deployment or Coolify application status',
          security: csrf,
          body: MonitorInput,
          response: { 201: MonitorBody, ...errors },
        },
      },
      async (request, reply) => {
        await limit(request, 'write');
        return reply.code(201).send(await service.create(actor(request), request.body));
      },
    );

    r.post(
      '/uptime/monitors/from-output',
      {
        config: {
          authz: {
            action: 'uptime.write',
            resource: bodyProject,
            auditDenied: { action: 'uptime.monitor.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            '“Monitor this” for an Outputs site: an http monitor for its live URL plus the provider status (Pages project / Coolify apps); existing ones are kept',
          security: csrf,
          body: z.strictObject({ project: Project, key: OutputKey }),
          response: {
            200: z.object({ created: z.array(MonitorBody), existing: z.array(MonitorBody) }),
            ...errors,
          },
        },
      },
      async (request) => {
        await limit(request, 'write');
        return await service.createFromOutput(actor(request), request.body.project, request.body.key);
      },
    );

    r.get(
      '/uptime/monitors/:id',
      {
        config: { authz: { action: 'uptime.read', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary: 'One monitor with its status, last check, TLS certificate, uptime and the open incident',
          security: session,
          params: IdParams,
          response: { 200: MonitorBody, ...errors },
        },
      },
      async (request) => (await service.get(request.params.id)) as z.infer<typeof MonitorBody>,
    );

    r.patch(
      '/uptime/monitors/:id',
      {
        config: { authz: { action: 'uptime.write', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary:
            'Edit a monitor (name, settings of its type, schedule, link to an Outputs site) or pause / resume it; new settings start a new status',
          security: csrf,
          params: IdParams,
          body: MonitorPatch,
          response: { 200: MonitorBody, ...errors },
        },
      },
      async (request) => {
        await limit(request, 'write');
        return await service.update(actor(request), request.params.id, request.body);
      },
    );

    r.delete(
      '/uptime/monitors/:id',
      {
        config: { authz: { action: 'uptime.write', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary: 'Delete a monitor with its checks and incidents',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await limit(request, 'write');
        await service.remove(actor(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/uptime/monitors/:id/check',
      {
        config: { authz: { action: 'uptime.write', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary:
            'Check now (at most once every 10 s per monitor); the result is recorded like a scheduled check',
          security: csrf,
          params: IdParams,
          response: { 200: MonitorBody, ...errors },
        },
      },
      async (request) => {
        await limit(request, 'checkNow');
        return await service.checkNow(actor(request), request.params.id);
      },
    );

    r.get(
      '/uptime/monitors/:id/series',
      {
        config: { authz: { action: 'uptime.read', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary: 'Latency and uptime chart: 24 h in 5-minute buckets, 7 d hourly, 30 d per 6 h, 90 d daily',
          security: session,
          params: IdParams,
          querystring: z.object({ range: z.enum(['24h', '7d', '30d', '90d']).default('24h') }),
          response: { 200: z.object({ range: z.string(), points: z.array(PointBody) }), ...errors },
        },
      },
      async (request) => ({
        range: request.query.range,
        points: await service.series(request.params.id, request.query.range),
      }),
    );

    r.get(
      '/uptime/monitors/:id/incidents',
      {
        config: { authz: { action: 'uptime.read', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary: 'Incidents of a monitor (down → up with duration and cause), newest first',
          security: session,
          params: IdParams,
          querystring: z.object(keysetQuery(LIMITS.incidentsPageMax)),
          response: { 200: z.object({ items: z.array(IncidentBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        cursorOrBadRequest(() =>
          service.incidentsPage(request.params.id, {
            limit: request.query.limit,
            cursor: request.query.cursor,
          }),
        ),
    );

    r.get(
      '/uptime/monitors/:id/checks',
      {
        config: { authz: { action: 'uptime.read', resource: monitorResource, notFound } },
        schema: {
          tags,
          summary: 'Recent checks of a monitor (kept 30 days), newest first',
          security: session,
          params: IdParams,
          querystring: z.object(keysetQuery(LIMITS.checksPageMax)),
          response: { 200: z.object({ items: z.array(CheckBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        cursorOrBadRequest(() =>
          service.checksPage(request.params.id, { limit: request.query.limit, cursor: request.query.cursor }),
        ),
    );

    r.get(
      '/uptime/settings',
      {
        config: { authz: { action: 'uptime.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'A project’s uptime settings (auto-monitor deployed sites)',
          security: session,
          querystring: z.object({ project: Project }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => service.settings(request.query.project),
    );

    r.put(
      '/uptime/settings',
      {
        config: {
          authz: {
            action: 'uptime.settings',
            resource: bodyProject,
            auditDenied: { action: 'uptime.settings.update', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Switch “auto-monitor deployed sites” for a project (project admin): every site deployed afterwards gets its monitors',
          security: csrf,
          body: z.strictObject({ project: Project, autoMonitor: z.boolean() }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        await limit(request, 'write');
        return service.setSettings(actor(request), request.body.project, request.body.autoMonitor);
      },
    );
  };
}
