import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorBodySchema } from '../http/error-schema.js';
import type { UpdateFeedService } from './service.js';

/**
 * p16-selfhost-onboarding §4: `GET /updates/status` — the signed update feed as the owners' banner reads it
 * (`updates.read`, owners). `POST /updates/check` re-reads the sources now (same permission; bounded by the feed
 * service's own single-flight).
 */
const ErrorBody = ErrorBodySchema;
const Release = z.object({
  version: z.string(),
  publishedAt: z.string(),
  minWorkerVersion: z.string(),
  migrationsHead: z.string(),
  breaking: z.array(z.string()),
  summary: z.string(),
  notes: z.string(),
});
export const UpdateStatusBody = z.object({
  configured: z.boolean(),
  currentVersion: z.string().nullable(),
  channel: z.string().nullable(),
  latest: Release.nullable(),
  updateAvailable: z.boolean(),
  newer: z.array(Release),
  checkedAt: z.string().nullable(),
  source: z.enum(['url', 'file']).nullable(),
  error: z.string().nullable(),
  /** The host command the owner runs (the master never upgrades itself). */
  command: z.string().nullable(),
});

export function updateRoutes(deps: { readonly service: UpdateFeedService }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const body = () => {
      const s = deps.service.status();
      return {
        ...s,
        latest: s.latest === null ? null : { ...s.latest },
        newer: s.newer.map((x) => ({ ...x, breaking: [...x.breaking] })),
        command:
          s.updateAvailable && s.newer[0] ? `sudo remyral-ctl upgrade --to ${s.newer[0].version}` : null,
      };
    };
    r.get(
      '/updates/status',
      {
        config: { authz: { action: 'updates.read' } },
        schema: {
          tags: ['updates'],
          summary:
            'Installed control-plane version and newer signed releases (the "update available" banner)',
          security: [{ session: [] }],
          response: { 200: UpdateStatusBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      () => body(),
    );
    r.post(
      '/updates/check',
      {
        config: { authz: { action: 'updates.read' } },
        schema: {
          tags: ['updates'],
          summary: 'Re-read the signed update feed now (URL and the host-cached copy)',
          security: [{ session: [], csrf: [] }],
          response: { 200: UpdateStatusBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      async () => {
        await deps.service.refresh();
        return body();
      },
    );
  };
}
