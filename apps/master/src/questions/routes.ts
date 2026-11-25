import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { realStepUpFields } from '../auth/hooks.js';
import { jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import type { ActorContext } from '../workers/fleet.js';
import type { QuestionService, QuestionView } from './service.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  429: ErrorBodySchema,
};

const Option = z.object({ label: z.string(), description: z.string().optional() });
export const QuestionBody = z.object({
  id: z.string(),
  source: z.enum(['job', 'assistant']),
  jobId: z.string().nullable(),
  threadId: z.string().nullable(),
  project: z.string().nullable(),
  title: z.string().nullable(),
  questions: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      kind: z.enum(['single', 'multi', 'text']),
      options: z.array(Option).optional(),
      allowOther: z.boolean().optional(),
      default: z.union([z.string(), z.array(z.string())]).optional(),
      placeholder: z.string().optional(),
      /** p18-plan-mode: the recommended option and why (plan decisions). */
      recommended: z.string().optional(),
      rationale: z.string().optional(),
    }),
  ),
  state: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  createdAt: z.string(),
  deadlineAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  /** p20-decisions: what the conversation settled when a plan decision was closed in the chat. */
  closeNote: z.string().optional(),
  answers: z
    .array(
      z.object({
        id: z.string(),
        choices: z.array(z.string()).optional(),
        other: z.string().optional(),
        text: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .nullable(),
  answeredBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  answeredAt: z.string().nullable(),
  /** p18-plan-mode: a plan decision (its plan and item; answered without starting a turn). */
  planId: z.string().nullable().optional(),
  planItemKey: z.string().nullable().optional(),
});

/** Answers as sent by the console; the service validates them against the stored questions. */
const AnswerBody = z.object({ answers: z.array(z.unknown()).min(1).max(4) });

const PendingBody = z.object({
  id: z.string(),
  source: z.enum(['job', 'assistant']),
  jobId: z.string().nullable(),
  jobTitle: z.string().nullable(),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  project: z.string().nullable(),
  title: z.string().nullable(),
  prompt: z.string(),
  count: z.number().int(),
  createdAt: z.string(),
  deadlineAt: z.string().nullable(),
  /** p18-plan-mode W4: a plan decision — its plan and item ("Senden bekleyen" groups it under the plan). */
  plan: z
    .object({
      id: z.string(),
      title: z.string(),
      itemKey: z.string().nullable(),
      itemTitle: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

/** What answering an assistant question needs from the chat (ChatService.answerQuestion). */
export interface ChatQuestionAnswerer {
  answerQuestion(
    actor: ActorContext,
    threadId: string,
    questionId: string,
    answers: unknown,
    /** p15-autonomy: the sender's step-up, for direct actions of the next turn. */
    stepUp?: { mfaAt: Date | null; stepUpMaxAgeMs?: number; alwaysFreshMaxAgeMs?: number },
  ): Promise<{ question: QuestionView; turnId: string | null }>;
}

/**
 * p14-ask-user (docs/design/p14-ask-user.md): the question cards' API.
 *
 *  - `GET /jobs/:id/questions` (`jobs.read`): the job's question sets, newest first.
 *  - `POST /jobs/:id/questions/:qid/answer` (`jobs.message` — exactly who may message the job; CSRF; audited): the
 *    answer goes back to the agent's blocked tool call.
 *  - `GET /questions/pending`: open sets the caller may answer ("Senden bekleyenler" and its count).
 *  - `POST /chat/threads/:id/questions/:qid/answer` (`chat.use`, the conversation's owner only; CSRF; audited): answers
 *    the assistant's question card and starts the next turn with the structured answer.
 */
export function questionRoutes(deps: {
  readonly questions: QuestionService;
  readonly db: Queryable;
  readonly chat: () => ChatQuestionAnswerer | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const jobNotFound = () => new HttpError(404, 'job_not_found', 'Job not found.');

    r.get(
      '/jobs/:id/questions',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags: ['jobs'],
          summary: 'p14-ask-user: the question sets the job’s agent asked (newest first), with their answers',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ questions: z.array(QuestionBody) }), ...errors },
        },
      },
      async (request) => ({ questions: await deps.questions.forJob(request.params.id) }),
    );

    r.post(
      '/jobs/:id/questions/:qid/answer',
      {
        config: {
          authz: {
            action: 'jobs.message',
            resource: jobResource(deps.db),
            notFound: jobNotFound,
            auditDenied: { action: 'job.question.answer', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'p14-ask-user: answer a question of the job’s agent (operator+, as messaging the job; the same answer twice is idempotent, a different one 409; audited)',
          security: csrf,
          params: z.object({ id: z.uuid(), qid: z.uuid() }),
          body: AnswerBody,
          response: { 200: z.object({ question: QuestionBody }), ...errors },
        },
      },
      async (request) => ({
        question: await deps.questions.answerJob(
          actorOf(request),
          request.params.id,
          request.params.qid,
          request.body.answers,
        ),
      }),
    );

    r.get(
      '/questions/pending',
      {
        config: { authz: { action: 'jobs.read' } },
        schema: {
          tags: ['jobs'],
          summary:
            'p14-ask-user: open questions the caller may answer — job questions in projects where they may message jobs, and their own conversations’ question cards',
          security: session,
          response: { 200: z.object({ items: z.array(PendingBody), total: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        const items = await deps.questions.pending(authzOf(request).subject);
        return { items, total: items.length };
      },
    );

    r.post(
      '/chat/threads/:id/questions/:qid/answer',
      {
        config: { authz: { action: 'chat.use' } },
        schema: {
          tags: ['chat'],
          summary:
            'p14-ask-user: answer the assistant’s question card (own conversations only); the answer starts the next turn (409 turn_in_progress while the asking turn still runs)',
          security: csrf,
          params: z.object({ id: z.uuid(), qid: z.uuid() }),
          body: AnswerBody,
          response: {
            200: z.object({ question: QuestionBody, turnId: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const chat = deps.chat();
        if (chat === null) throw new HttpError(409, 'chat_disabled', 'Chat is turned off.');
        return chat.answerQuestion(
          actorOf(request),
          request.params.id,
          request.params.qid,
          request.body.answers,
          realStepUpFields(request),
        );
      },
    );
  };
}
