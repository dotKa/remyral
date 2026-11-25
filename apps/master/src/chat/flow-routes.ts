import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { ChatFlowService } from './flow.js';

/**
 * p17-chat-flow leftover (p18-plan-mode W4): the scheduled result cards of what a conversation created (a workflow, an
 * automation) can be turned off per conversation — "Bu sohbete sonuç gönderme" on the card. `chat.use`, the
 * conversation's owner only (another user's conversation is a 404); CSRF; audited `chat.flow.results_(un)muted`.
 *
 *  - `GET /chat/threads/:id/result-mutes` — the muted targets.
 *  - `PUT /chat/threads/:id/result-mutes {target, muted}` — `automation:<id>` / `workflow:<project>/<name>`.
 */
const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  429: ErrorBodySchema,
};

export function flowRoutes(deps: { readonly flow: () => ChatFlowService | null }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['chat'];
    const use = { config: { authz: { action: 'chat.use' as const } } };
    const userOf = (request: FastifyRequest): string => authzOf(request).subject.userId;
    const svc = (): ChatFlowService => {
      const s = deps.flow();
      if (s === null) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
      return s;
    };
    const Params = z.object({ id: z.uuid() });

    r.get(
      '/chat/threads/:id/result-mutes',
      {
        ...use,
        schema: {
          tags,
          summary:
            'W4: the automations / workflows whose scheduled result cards are turned off in this conversation (owner only)',
          security: [{ session: [] }],
          params: Params,
          response: { 200: z.object({ targets: z.array(z.string()) }), ...errors },
        },
      },
      async (request) => ({ targets: await svc().resultMutes(userOf(request), request.params.id) }),
    );

    r.put(
      '/chat/threads/:id/result-mutes',
      {
        ...use,
        schema: {
          tags,
          summary:
            'W4: turn the scheduled result cards of one automation / workflow off (or on again) in this conversation (owner only; audited)',
          security: [{ session: [], csrf: [] }],
          params: Params,
          body: z.object({ target: z.string().min(1).max(340), muted: z.boolean() }),
          response: { 200: z.object({ target: z.string(), muted: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        await svc().setResultMute(
          userOf(request),
          request.params.id,
          request.body.target,
          request.body.muted,
        );
        return { target: request.body.target, muted: request.body.muted };
      },
    );
  };
}
