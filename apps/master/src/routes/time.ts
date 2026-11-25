import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthzRule } from '../http/route-authz.js';

/** Any signed-in role: the caller's own session is the resource (p5-rbac `session.self`). */
const SELF: AuthzRule = {
  action: 'session.self',
  resource: (request) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

/**
 * `GET /time` (p6-logs-ui, docs/design/p6-logs-ui.md §3): the master's current time, for the console
 * header clock. The browser measures its offset to it once and then ticks locally, re-measuring every few
 * minutes. Full session required (it is not a public probe); answers nothing but the time, `no-store`.
 */
export function timeRoutes(clock: () => Date) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/time',
      {
        config: { authz: SELF },
        schema: {
          tags: ['health'],
          summary: 'Current server time',
          security: [{ session: [] }],
          response: {
            200: z.object({ now: z.string().describe('ISO 8601, UTC, millisecond precision') }),
          },
        },
      },
      (_request, reply) => {
        void reply.header('cache-control', 'no-store');
        return { now: clock().toISOString() };
      },
    );
  };
}
