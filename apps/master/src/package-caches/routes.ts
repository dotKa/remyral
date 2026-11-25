import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { actorOf } from '../workers/routes.js';
import type { PackageCacheService, PackageCacheSetting } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });
const SettingBody = z.object({
  project: z.string(),
  enabled: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const json = (v: PackageCacheSetting): z.infer<typeof SettingBody> => ({
  project: v.project,
  enabled: v.enabled,
  updatedBy: v.updatedBy,
  updatedAt: v.updatedAt?.toISOString() ?? null,
});

/**
 * p6-warm-caches API (docs/design/p6-warm-caches.md §6). Part of a project's execution policy
 * (`projects.execution.*`): viewers read, admins change with step-up; audited.
 */
export function packageCacheRoutes(deps: {
  readonly service: PackageCacheService;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, deps.clock);

    r.get(
      '/projects/:id/package-caches',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'Whether trusted host-profile jobs of this project share the machines’ package caches (npm, pnpm, Yarn, pip, uv, Cargo, Go); default on',
          security: [{ session: [] }],
          params: ProjectParams,
          response: { 200: SettingBody, ...errors },
        },
      },
      async (request) => json(await deps.service.setting(request.params.id)),
    );

    r.put(
      '/projects/:id/package-caches',
      {
        config: {
          authz: {
            action: 'projects.execution.write',
            resource: projectParam(),
            auditDenied: { action: 'project.package_caches.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            'Allow or forbid shared package caches for this project’s jobs (admin, step-up, audited). Untrusted sources and container jobs never get one.',
          security: [{ session: [], csrf: [] }],
          params: ProjectParams,
          body: z.strictObject({ enabled: z.boolean() }),
          response: { 200: SettingBody, ...errors },
        },
      },
      async (request) =>
        json(await deps.service.set(request.params.id, request.body.enabled, actorOf(request))),
    );
  };
}
