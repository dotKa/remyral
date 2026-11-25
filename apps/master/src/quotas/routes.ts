import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { visibleProjects } from '../authz/model.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { QuotaService } from './service.js';
import { QuotaError, type QuotaStore } from './store.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toHttp(err: unknown): unknown {
  if (err instanceof QuotaError) return new HttpError(err.status, err.code, err.message);
  return err;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * p4-quotas REST (docs/design/p4-quotas.md §8). Reads: viewer+ (project rows filtered by visibility).
 * Writes: admin+ with a fresh step-up and CSRF; every write audited (success in the store/service, denials
 * by the authorization layer).
 */
export function quotaRoutes(deps: {
  readonly service: QuotaService;
  readonly store: QuotaStore;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['quotas'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];

    r.get(
      '/quotas/status',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags,
          summary:
            'Quota enforcement status: policy, concurrency in use, provider pauses, holds, budgets, recent decisions (viewer+)',
          security: session,
          response: { 200: z.record(z.string(), z.unknown()), ...errors },
        },
      },
      async (request) => {
        const projects = visibleProjects(authzOf(request).subject);
        const s = await deps.service.status(projects);
        return {
          policy: { ...s.policy, createdAt: iso(s.policy.createdAt) },
          projects: s.projects,
          runtimes: s.runtimes,
          accounts: s.accounts,
          pauses: s.pauses.map((p) => ({ ...p, pausedAt: iso(p.pausedAt), resumeAt: iso(p.resumeAt) })),
          holds: s.holds.map((h) => ({ ...h, heldAt: iso(h.heldAt) })),
          budgets: s.budgets,
          events: s.events.map((e) => ({ ...e, createdAt: iso(e.createdAt) })),
        };
      },
    );

    r.put(
      '/quotas/policy',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: { action: 'quota.policy.update', target: () => 'quota:policy' },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary: 'Replace the quota policy (admin+, step-up, expectedVersion)',
          security: csrf,
          body: z.object({
            expectedVersion: z.number().int().min(0),
            note: z.string().max(500).optional(),
            policy: z.record(z.string(), z.unknown()),
          }),
          response: { 200: z.object({ version: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          const v = await deps.store.replacePolicy(
            { type: 'user', id: user.id },
            {
              expectedVersion: request.body.expectedVersion,
              policy: request.body.policy,
              ...(request.body.note === undefined ? {} : { note: request.body.note }),
            },
          );
          return { version: v.version };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/quotas/pauses/:id/resume',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: { action: 'quota.provider.resume', target: paramTarget('quota-pause') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary: 'Resume a provider pause before its reset time (admin+, step-up)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          response: { 200: z.object({ id: z.string(), resumedAt: z.string() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          const p = await deps.store.resumePause(request.params.id, { type: 'user', id: user.id });
          return { id: p.id, resumedAt: (p.resumedAt ?? deps.clock()).toISOString() };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/projects/:id/kill',
      {
        config: {
          authz: {
            action: 'projects.kill',
            resource: projectParam(),
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'project.kill', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'Kill switch: stop every running job of the project and cancel its queued jobs; optionally hold dispatch (admin+, step-up)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.object({ reason: z.string().min(1).max(500), hold: z.boolean().default(true) }),
          response: {
            200: z.object({
              cancelled: z.number().int(),
              cancelling: z.number().int(),
              skipped: z.number().int(),
              hold: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        try {
          const res = await deps.service.killProject(
            request.params.id,
            { type: 'user', id: user.id },
            { reason: request.body.reason, hold: request.body.hold },
          );
          request.log.warn(
            { project: request.params.id, ...res, ...requestMeta(request) },
            'project kill switch',
          );
          return res;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.delete(
      '/projects/:id/kill',
      {
        config: {
          authz: {
            action: 'projects.kill',
            resource: projectParam(),
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'project.kill.release', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary: 'Release the kill-switch dispatch hold of a project (admin+, step-up)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: z.object({ released: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        const user = sessionOf(request).user;
        const released = await deps.store.releaseHold(request.params.id, { type: 'user', id: user.id });
        if (!released) throw new HttpError(404, 'hold_not_found', 'The project has no dispatch hold.');
        return { released };
      },
    );
  };
}
