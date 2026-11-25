import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { SERVICE_LIMITS, ServiceStartRequest } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { loadSubject } from '../authz/authorizer.js';
import type { Resource } from '../authz/model.js';
import { param, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import type { ServiceCaller, ServiceRegistry } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  504: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const WorkerRef = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const ServiceBody = z.object({
  id: z.string(),
  project: z.string(),
  workerId: z.string(),
  workerName: z.string().nullable(),
  name: z.string(),
  desired: z.enum(['running', 'stopped', 'removed']),
  state: z.string(),
  health: z.string(),
  detail: z.string().nullable(),
  url: z.string().nullable(),
  port: z.number().int().nullable(),
  command: z.string(),
  cwd: z.string().nullable(),
  tunnel: z.object({ mode: z.string(), state: z.string().nullable(), detail: z.string().nullable() }),
  sandboxProfile: z.string(),
  restartPolicy: z.string(),
  health_kind: z.string(),
  pid: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  restarts: z.number().int(),
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  sourceJobId: z.string().nullable(),
  createdBy: z.object({ type: z.string(), id: z.string(), username: z.string().nullable() }),
  createdVia: z.string(),
  expiresAt: z.string().nullable(),
  statusAt: z.string().nullable(),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  workerConnected: z.boolean(),
  network: z.enum(['project', 'model_apis_only']),
});

const CreateBody = z.strictObject({
  worker: WorkerRef.optional(),
  fromJobId: z.string().regex(UUID).optional(),
  baseRef: z.string().min(1).max(256).optional(),
  sandboxProfile: z.enum(['host-restricted', 'unconfined']).optional(),
  request: ServiceStartRequest,
});

/**
 * p15-services: Servisler REST — list (per project, per machine), start, stop, restart, extend, remove, logs. Reads need
 * `services.read` (viewer), changes `services.manage` (operator; `unconfined` an admin, checked in the service). Every
 * change is audited by the registry.
 */
export function serviceRoutes(deps: { readonly service: ServiceRegistry; readonly db: Queryable }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['services'];
    const subject = async (request: FastifyRequest) => {
      const s = sessionOf(request);
      return loadSubject(deps.db, { id: s.user.id, role: s.user.role });
    };
    const caller = async (request: FastifyRequest): Promise<ServiceCaller> => {
      const s = sessionOf(request);
      return {
        subject: await subject(request),
        actor: { type: 'user', id: s.user.id, ip: requestMeta(request).ip },
        via: 'api',
      };
    };
    const serviceResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.projectOf(id);
      return project === null ? null : { project };
    };
    const notFound = () => new HttpError(404, 'service_not_found', 'Service not found.');
    const IdParams = z.object({ id: z.string().regex(UUID) });
    const Wrapped = z.object({ service: ServiceBody });

    r.get(
      '/services',
      {
        config: { authz: { action: 'services.read' } },
        schema: {
          tags,
          summary: 'Services the caller can see (filter by project, machine id / name, state)',
          security: session,
          querystring: z.object({
            project: z.string().regex(PROJECT).optional(),
            worker: WorkerRef.optional(),
            state: z.enum(['live', 'stopped', 'failed', 'any']).optional(),
          }),
          response: {
            200: z.object({ services: z.array(ServiceBody), limits: z.object({ perProject: z.number() }) }),
            ...errors,
          },
        },
      },
      async (request) => ({
        services: await service.list(await subject(request), {
          project: request.query.project,
          worker: request.query.worker,
          state: request.query.state ?? 'any',
        }),
        limits: { perProject: SERVICE_LIMITS.perProject },
      }),
    );

    r.get(
      '/projects/:id/services',
      {
        config: { authz: { action: 'services.read', resource: projectParam() } },
        schema: {
          tags,
          summary: 'A project’s services (live ones and those stopped in the last 7 days)',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: { 200: z.object({ services: z.array(ServiceBody) }), ...errors },
        },
      },
      async (request) => ({
        services: await service.list(await subject(request), { project: request.params.id, state: 'any' }),
      }),
    );

    r.post(
      '/projects/:id/services',
      {
        config: { authz: { action: 'services.manage', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'Start a service on a machine — from a running job’s worktree (fromJobId) or a checkout of the project repository; no job slot',
          security: csrf,
          params: z.object({ id: z.string().regex(PROJECT) }),
          body: CreateBody,
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({
        service: await service.create(await caller(request), {
          project: request.params.id,
          worker: request.body.worker,
          fromJobId: request.body.fromJobId,
          baseRef: request.body.baseRef,
          sandboxProfile: request.body.sandboxProfile,
          request: request.body.request,
        }),
      }),
    );

    r.get(
      '/services/:id',
      {
        config: { authz: { action: 'services.read', resource: serviceResource, notFound } },
        schema: {
          tags,
          summary: 'One service',
          security: session,
          params: IdParams,
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({ service: await service.get(await subject(request), request.params.id) }),
    );

    r.get(
      '/services/:id/logs',
      {
        config: { authz: { action: 'services.read', resource: serviceResource, notFound } },
        schema: {
          tags,
          summary: 'The last log lines of a service (from its machine; secrets redacted there)',
          security: session,
          params: IdParams,
          querystring: z.object({
            lines: z.coerce.number().int().min(1).max(SERVICE_LIMITS.logLinesMax).optional(),
          }),
          response: {
            200: z.object({
              lines: z.array(z.object({ at: z.string(), stream: z.string(), text: z.string() })),
              truncated: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        return service.logs(await subject(request), request.params.id, request.query.lines ?? 200);
      },
    );

    r.post(
      '/services/:id/stop',
      {
        config: { authz: { action: 'services.manage', resource: serviceResource, notFound } },
        schema: {
          tags,
          summary: 'Stop a service (kept; it can be started again); its tunnel closes',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ remove: z.boolean().optional() }),
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({
        service: await service.stop(await caller(request), request.params.id, {
          remove: request.body.remove === true,
        }),
      }),
    );

    r.post(
      '/services/:id/restart',
      {
        config: { authz: { action: 'services.manage', resource: serviceResource, notFound } },
        schema: {
          tags,
          summary: 'Restart a service (also a stopped one), optionally with a new lifetime',
          security: csrf,
          params: IdParams,
          body: z.strictObject({
            extendMinutes: z.number().int().min(5).max(SERVICE_LIMITS.maxTtlMinutes).optional(),
            untilStopped: z.boolean().optional(),
          }),
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({
        service: await service.restart(await caller(request), request.params.id, request.body),
      }),
    );

    r.post(
      '/services/:id/extend',
      {
        config: { authz: { action: 'services.manage', resource: serviceResource, notFound } },
        schema: {
          tags,
          summary: 'A new lifetime from now (minutes) or until stopped; the process keeps running',
          security: csrf,
          params: IdParams,
          body: z.strictObject({
            minutes: z.number().int().min(5).max(SERVICE_LIMITS.maxTtlMinutes).optional(),
            untilStopped: z.boolean().optional(),
          }),
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({
        service: await service.extend(await caller(request), request.params.id, request.body),
      }),
    );
  };
}
