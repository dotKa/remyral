import { AssistantRuntime, MAX_ASSISTANT_MESSAGE } from '@remyral/protocol';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { realStepUpFields } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { exportFileName, exportMarkdown } from './export.js';
import type { ChatService } from './service.js';
import type { ChatShares } from './share.js';
import type { ChatStore } from './store.js';
import { DroppedBody, MessageBody, ThreadBody } from './routes.js';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md): edit / regenerate / retry, export, sharing and handing over.
 * Every write is the conversation owner's (a reader's attempt is 404 like any foreign thread) and carries CSRF.
 */

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
/** 409 `turn_acted` names what the replaced answer did (the console shows it and asks). */
const ActedBody = ErrorBodySchema.extend({
  effects: z
    .object({
      actions: z.number().int(),
      tools: z.array(z.object({ name: z.string(), summary: z.string() })),
      cards: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), state: z.string() })),
    })
    .optional(),
});
const actedErrors = { ...errors, 409: ActedBody };
const ThreadParams = z.object({ id: z.uuid() });
const ShareBody = z.object({ userId: z.string(), username: z.string(), grantedAt: z.string() });
const Owner = z.object({ id: z.string(), username: z.string() });

export function chatCompleteRoutes(deps: {
  readonly service: ChatService;
  readonly store: ChatStore;
  readonly shares?: ChatShares;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['chat'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const use = { config: { authz: { action: 'chat.use' as const } } };
    const userOf = (request: Parameters<typeof authzOf>[0]): string => authzOf(request).subject.userId;
    const shares = (): ChatShares => {
      if (deps.shares === undefined) throw new HttpError(404, 'not_found', 'Not found.');
      return deps.shares;
    };

    r.post(
      '/chat/threads/:id/messages/:messageId/edit',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Edit one of your messages: the conversation forks there (later rows are superseded) and the edited text is answered (409 turn_acted when a replaced answer acted)',
          security: csrf,
          params: z.object({ id: z.uuid(), messageId: z.uuid() }),
          body: z.object({
            text: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE),
            acknowledgeActions: z.boolean().optional(),
          }),
          response: {
            202: z.object({ message: MessageBody, turnId: z.string(), dropped: z.array(DroppedBody) }),
            ...actedErrors,
          },
        },
      },
      async (request, reply) =>
        reply.code(202).send(
          await deps.service.edit(
            actorOf(request),
            request.params.id,
            request.params.messageId,
            request.body.text,
            {
              ...(request.body.acknowledgeActions === undefined
                ? {}
                : { acknowledgeActions: request.body.acknowledgeActions }),
              stepUp: realStepUpFields(request),
            },
          ),
        ),
    );

    r.post(
      '/chat/threads/:id/regenerate',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Answer the last message again (regenerate, optionally with another ready engine / model) or retry a failed / lost turn (409 turn_acted when the replaced answer acted)',
          security: csrf,
          params: ThreadParams,
          body: z.object({
            messageId: z.uuid().optional(),
            runtime: AssistantRuntime.optional(),
            model: z.string().min(1).max(128).optional(),
            mode: z.enum(['regenerate', 'retry']).optional(),
            acknowledgeActions: z.boolean().optional(),
          }),
          response: { 202: z.object({ turnId: z.string() }), ...actedErrors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        return reply.code(202).send(
          await deps.service.regenerate(actorOf(request), request.params.id, {
            messageId: b.messageId,
            runtime: b.runtime,
            model: b.model,
            mode: b.mode,
            acknowledgeActions: b.acknowledgeActions,
            stepUp: realStepUpFields(request),
          }),
        );
      },
    );

    r.get(
      '/chat/threads/:id/export',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Export a conversation you own or read (Markdown download, or the JSON document the console prints as PDF); redacted, cards with their final state, only links you can open',
          security: session,
          params: ThreadParams,
          querystring: z.object({
            format: z.enum(['markdown', 'json']).optional(),
            lang: z.enum(['tr', 'en']).optional(),
          }),
          response: { 200: z.unknown(), ...errors },
        },
      },
      async (request, reply) => {
        const format = request.query.format ?? 'markdown';
        const doc = await shares().export(
          authzOf(request).subject,
          actorOf(request),
          request.params.id,
          format,
        );
        if (format === 'json') return doc;
        return reply
          .header('content-type', 'text/markdown; charset=utf-8')
          .header('content-disposition', `attachment; filename="${exportFileName(doc.thread.title, 'md')}"`)
          .header('x-content-type-options', 'nosniff')
          .send(exportMarkdown(doc, request.query.lang ?? 'en'));
      },
    );

    r.get(
      '/chat/shared',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Conversations other people shared with the caller (read-only), most recently active first',
          security: session,
          response: {
            200: z.object({
              items: z.array(ThreadBody.extend({ owner: Owner, sharedAt: z.string() })),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({ items: await shares().listShared(userOf(request)) }),
    );

    r.get(
      '/chat/share/users',
      {
        ...use,
        schema: {
          tags,
          summary: 'Active users the caller can share a conversation with (by name; never the caller)',
          security: session,
          querystring: z.object({ q: z.string().max(100).optional() }),
          response: {
            200: z.object({ items: z.array(z.object({ id: z.string(), username: z.string() })) }),
            ...errors,
          },
        },
      },
      async (request) => ({ items: await shares().candidates(userOf(request), request.query.q ?? '') }),
    );

    r.get(
      '/chat/threads/:id/shares',
      {
        ...use,
        schema: {
          tags,
          summary: 'The readers of one of the caller’s conversations',
          security: session,
          params: ThreadParams,
          response: { 200: z.object({ items: z.array(ShareBody) }), ...errors },
        },
      },
      async (request) => ({ items: await shares().shares(userOf(request), request.params.id) }),
    );

    r.put(
      '/chat/threads/:id/shares/:userId',
      {
        ...use,
        schema: {
          tags,
          summary: 'Give a user read-only access to one of the caller’s conversations (audited)',
          security: csrf,
          params: z.object({ id: z.uuid(), userId: z.uuid() }),
          response: { 200: z.object({ items: z.array(ShareBody) }), ...errors },
        },
      },
      async (request) => ({
        items: await shares().add(actorOf(request), request.params.id, request.params.userId),
      }),
    );

    r.delete(
      '/chat/threads/:id/shares/:userId',
      {
        ...use,
        schema: {
          tags,
          summary: 'Remove a reader (the owner), or leave a conversation shared with you (audited)',
          security: csrf,
          params: z.object({ id: z.uuid(), userId: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await shares().remove(actorOf(request), request.params.id, request.params.userId);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/chat/threads/:id/transfer',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Hand one of the caller’s conversations over to another user (open cards are dismissed, watches end; optionally keep read access; audited)',
          security: csrf,
          params: ThreadParams,
          body: z.object({ userId: z.uuid(), keepAccess: z.boolean().optional() }),
          response: { 200: ThreadBody, ...errors },
        },
      },
      async (request) =>
        shares().transfer(
          actorOf(request),
          request.params.id,
          request.body.userId,
          request.body.keepAccess === true,
        ),
    );
  };
}
