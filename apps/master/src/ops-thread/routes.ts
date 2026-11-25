import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthzRule } from '../http/route-authz.js';
import { authzOf } from '../http/route-authz.js';
import { CursorParam, cursorOrBadRequest } from '../http/pagination.js';
import type { OpsThreadService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody };

const Event = z.object({
  notificationId: z.string(),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
});

const Item = z.object({
  id: z.string(),
  type: z.string(),
  at: z.string(),
  subject: z.string().nullable(),
  unread: z.boolean(),
  event: Event.nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
});

const Counts = z.object({
  approvals: z.number().int(),
  deploys: z.number().int(),
  merges: z.number().int(),
  failures: z.number().int(),
  limits: z.number().int(),
});

/**
 * The caller's own thread (`notifications.self`, owner = caller): every signed-in role may read it; each item is
 * then filtered by the action its own endpoint requires (service.ts).
 */
const SELF: AuthzRule = {
  action: 'notifications.self',
  resource: (request) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

export function opsThreadRoutes(service: OpsThreadService) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/ops-thread',
      {
        config: { authz: SELF },
        schema: {
          tags: ['ops-thread'],
          summary:
            'p12-diyalog: one page of the caller’s operations thread — own notifications (keyset by time, newest first) merged with the open cards the caller can see (pending approvals, ops actions waiting, integrations needing a person, failures of the last 24 h, usage-limit pauses); stable ids, one item per card',
          security: [{ session: [] }],
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional(),
            before: CursorParam.optional(),
          }),
          response: {
            200: z.object({
              items: z.array(Item),
              nextCursor: z.string().nullable(),
              open: Counts.nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        cursorOrBadRequest(() =>
          service.page(authzOf(request).subject, {
            cursor: request.query.before,
            limit: request.query.limit,
          }),
        ),
    );
  };
}
