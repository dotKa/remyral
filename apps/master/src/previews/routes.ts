import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { PREVIEW_LIMITS, PreviewName, PreviewPort, PreviewProtection } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requestStepUpMaxAge, requireStepUp } from '../auth/hooks.js';
import type { Resource } from '../authz/model.js';
import { jobResource, param, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { OpsError } from '../ops/model.js';
import { ActionBody } from '../ops/routes.js';
import type { OpsActor } from '../ops/service.js';
import type { PreviewService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
  424: ErrorBody,
  502: ErrorBody,
  503: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Key = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);

const Protection = z.enum(['none', 'access', 'service-token']);
export const TunnelBody = z.object({
  id: z.string(),
  project: z.string(),
  name: z.string(),
  hostname: z.string(),
  url: z.string(),
  protection: Protection,
  stable: z.boolean(),
  state: z.enum(['opening', 'active', 'idle', 'closing', 'closed', 'failed']),
  connector: z
    .object({
      state: z.enum(['starting', 'running', 'stopped', 'failed', 'refused', 'down']),
      detail: z.string().nullable(),
      since: z.string(),
    })
    .nullable(),
  jobId: z.string().nullable(),
  workerId: z.string().nullable(),
  port: z.number().int().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  openedBy: z.object({ type: z.enum(['user', 'system']), id: z.string(), username: z.string().nullable() }),
  openActionId: z.string().nullable(),
  serviceTokenClientId: z.string().nullable(),
});
const Outcome = z.object({ action: ActionBody, tunnel: TunnelBody.nullable() });

function toHttp(err: unknown): unknown {
  if (err instanceof OpsError) return new HttpError(err.status, err.code, err.message, err.headers);
  return err;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

/**
 * p8-preview-tunnels (ADR-0032): preview links of a project and of a job; open (job page), extend, close, and the
 * service token of a service-token preview (admin, always-fresh step-up). Settings live in the deploy targets
 * (`PUT /projects/:id/deploy-targets`, `previews` + `policy.previewTunnel / stableTunnel`).
 */
export function previewRoutes(deps: {
  readonly service: PreviewService;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service, clock } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', clock);
    const tags = ['previews'];
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
    const tunnelResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.projectOfTunnel(id);
      return project === null ? null : { project };
    };
    const notFound = () => new HttpError(404, 'preview_not_found', 'Preview not found.');
    const jobNotFound = () => new HttpError(404, 'job_not_found', 'Job not found.');
    const IdParams = z.object({ id: z.string().regex(UUID) });

    r.get(
      '/projects/:id/previews',
      {
        config: { authz: { action: 'previews.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'A project’s preview settings and its preview links (open ones and those closed in the last 7 days)',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: {
            200: z.object({
              settings: z.record(z.string(), z.unknown()).nullable(),
              tunnels: z.array(TunnelBody),
            }),
            ...errors,
          },
        },
      },
      async (request) => wrap(() => service.projectView(request.params.id)),
    );

    r.get(
      '/jobs/:id/previews',
      {
        config: { authz: { action: 'previews.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags,
          summary: 'A job’s preview links and whether a preview can be opened for it now',
          security: session,
          params: IdParams,
          response: {
            200: z.object({
              tunnels: z.array(TunnelBody),
              available: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
              settings: z
                .object({
                  protections: z.array(Protection),
                  defaultTtlMinutes: z.number().int(),
                  maxTtlMinutes: z.number().int(),
                })
                .nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => wrap(() => service.jobView(request.params.id)),
    );

    r.post(
      '/jobs/:id/previews',
      {
        config: { authz: { action: 'previews.open', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags,
          summary:
            'Open a preview link of a port the running job serves on its machine (ops action tunnel.open; the project policy decides)',
          security: csrf,
          params: IdParams,
          body: z.strictObject({
            port: PreviewPort,
            name: PreviewName.optional(),
            protect: PreviewProtection.optional(),
            ttlMinutes: z.number().int().min(5).max(PREVIEW_LIMITS.stableMaxMinutes).optional(),
            stable: z.boolean().optional(),
            idempotencyKey: Key,
          }),
          response: { 200: Outcome, ...errors },
        },
      },
      async (request) =>
        wrap(() => {
          const b = request.body;
          return service.open(actor(request), request.params.id, {
            port: b.port,
            idempotencyKey: b.idempotencyKey,
            ...(b.name === undefined ? {} : { name: b.name }),
            ...(b.protect === undefined ? {} : { protect: b.protect }),
            ...(b.ttlMinutes === undefined ? {} : { ttlMinutes: b.ttlMinutes }),
            ...(b.stable === undefined ? {} : { stable: b.stable }),
          });
        }),
    );

    r.post(
      '/previews/:id/close',
      {
        config: { authz: { action: 'previews.open', resource: tunnelResource, notFound } },
        schema: {
          tags,
          summary: 'Close a preview: the connector stops, the Access app, DNS record and tunnel are deleted',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ idempotencyKey: Key }),
          response: { 200: Outcome, ...errors },
        },
      },
      async (request) =>
        wrap(() => service.close(actor(request), request.params.id, request.body.idempotencyKey)),
    );

    r.post(
      '/previews/:id/extend',
      {
        config: { authz: { action: 'previews.open', resource: tunnelResource, notFound } },
        schema: {
          tags,
          summary: 'Extend a preview (job-bound: up to 24 h from now; stable: renew up to 30 days)',
          security: csrf,
          params: IdParams,
          body: z.strictObject({
            minutes: z.number().int().min(5).max(PREVIEW_LIMITS.stableMaxMinutes),
            idempotencyKey: Key,
          }),
          response: { 200: Outcome, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.extend(
            actor(request),
            request.params.id,
            request.body.minutes,
            request.body.idempotencyKey,
          ),
        ),
    );

    r.post(
      '/previews/:id/reveal',
      {
        config: { authz: { action: 'previews.reveal', resource: tunnelResource, notFound } },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Show the Access service token of a service-token preview (project admin, always-fresh step-up; audited)',
          security: csrf,
          params: IdParams,
          response: { 200: z.object({ clientId: z.string(), clientSecret: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const out = await wrap(() => service.reveal(actor(request), request.params.id));
        void reply.header('cache-control', 'no-store');
        return out;
      },
    );
  };
}
