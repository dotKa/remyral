import { MAX_ASSISTANT_MESSAGE } from '@remyral/protocol';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Resource } from '../authz/model.js';
import { bodyField } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { MAX_SELECTED, WORKFLOW_AI_MODES, type WorkflowAiService } from './ai.js';
import { WORKFLOW_DEFINITION_BODY_LIMIT } from './routes.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const NODE_ID = /^[a-z][a-z0-9_-]{0,47}$/;

const ThreadBody = z.object({
  id: z.string(),
  title: z.string(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const LinkBody = z.object({
  project: z.string(),
  name: z.string().nullable(),
  definitionId: z.string().nullable(),
});
const MessageBody = z.object({
  id: z.string(),
  seq: z.number(),
  role: z.string(),
  content: z.string(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  turnId: z.string().nullable(),
  createdAt: z.string(),
});

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

/**
 * p15-workflow-ai (docs/design/p15-workflow-ai.md): the workflow editor's AI panel. Threads are the caller's own chat
 * threads linked to a workflow; messages are chat turns with the editor's context. `workflows.read` in the body's
 * project for every route (design / edit messages also need `workflows.define`, checked by the service).
 */
export function workflowAiRoutes(deps: { readonly service: WorkflowAiService }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['workflows'];
    const csrf = [{ session: [], csrf: [] }];
    const read = {
      authz: {
        action: 'workflows.read' as const,
        resource: bodyProject,
        notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
      },
    };

    r.post(
      '/workflows/ai/threads',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Open the caller’s AI conversation of a workflow in the editor: the latest linked one of a saved workflow (unless fresh), else a new thread linked to the project (viewer+)',
          security: csrf,
          body: z.object({
            project: z.string().regex(PROJECT),
            workflowId: z.uuid().optional(),
            fresh: z.boolean().optional(),
            /** Continue this conversation (the caller's own, linked to the same workflow). */
            threadId: z.uuid().optional(),
          }),
          response: {
            200: z.object({ thread: ThreadBody, workflow: LinkBody, created: z.boolean() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const b = request.body;
        return deps.service.openThread(authzOf(request).subject, {
          project: b.project,
          ...(b.workflowId === undefined ? {} : { workflowId: b.workflowId }),
          ...(b.fresh === undefined ? {} : { fresh: b.fresh }),
          ...(b.threadId === undefined ? {} : { threadId: b.threadId }),
        });
      },
    );

    r.put(
      '/workflows/ai/threads/:id/link',
      {
        config: read,
        schema: {
          tags,
          summary: 'Link the caller’s AI conversation to the workflow the editor just saved (viewer+)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.object({ project: z.string().regex(PROJECT), workflowId: z.uuid() }),
          response: { 200: LinkBody, ...errors },
        },
      },
      async (request) =>
        deps.service.linkThread(authzOf(request).subject, request.params.id, request.body.workflowId),
    );

    r.post(
      '/workflows/ai/threads/:id/messages',
      {
        bodyLimit: WORKFLOW_DEFINITION_BODY_LIMIT + 64 * 1024,
        config: read,
        schema: {
          tags,
          summary:
            'Ask the assistant in the workflow editor: design (operator+), edit the current document (operator+), explain, or debug a failed run (viewer+). The answer arrives on the chat thread stream; drafts are validated like POST /workflows/validate',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.object({
            mode: z.enum(WORKFLOW_AI_MODES),
            text: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE),
            project: z.string().regex(PROJECT),
            workflowId: z.uuid().optional(),
            document: z.record(z.string(), z.unknown()).optional(),
            selected: z.array(z.string().regex(NODE_ID)).max(MAX_SELECTED).optional(),
            runId: z.uuid().optional(),
          }),
          response: { 202: z.object({ message: MessageBody, turnId: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        if (b.document !== undefined && JSON.stringify(b.document).length > WORKFLOW_DEFINITION_BODY_LIMIT) {
          throw new HttpError(
            400,
            'invalid_request',
            'The workflow document is too large (at most 512 KiB).',
            {},
            {},
            { reason: 'workflow_document' },
          );
        }
        const sent = await deps.service.send(actorOf(request), authzOf(request).subject, request.params.id, {
          mode: b.mode,
          text: b.text,
          project: b.project,
          ...(b.workflowId === undefined ? {} : { workflowId: b.workflowId }),
          ...(b.document === undefined ? {} : { document: b.document }),
          ...(b.selected === undefined ? {} : { selected: b.selected }),
          ...(b.runId === undefined ? {} : { runId: b.runId }),
        });
        return reply.code(202).send(sent);
      },
    );
  };
}
