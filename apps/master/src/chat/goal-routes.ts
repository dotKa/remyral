import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { GOAL_STATES, type GoalLedger } from './goals.js';

/**
 * p20-outcome (docs/design/p20-outcome-contract.md, "The intervention card"): the caller's own goals — `chat.use`, only
 * their own rows. Writes are CSRF-protected and audited (`chat.goal.resume`, `chat.goal.cancel`).
 *
 *  - `GET /chat/goals[?state=open|intervention|done|cancelled|live&threadId=]` — newest change first (default: live).
 *  - `GET /chat/goals/:gid`
 *  - `POST /chat/goals/:gid/resume` — "Devam ettir" (a plan goal: the plan's own resume; else one continuation turn).
 *  - `POST /chat/goals/:gid/cancel` — "Vazgeç" (a plan goal cancels its plan; else its active watches stop).
 */

export const GoalBody = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  origin: z.object({ kind: z.enum(['plan', 'job', 'workflow_run', 'watch']), id: z.string() }),
  title: z.string(),
  outcomeCondition: z.string(),
  nextAction: z.string().nullable(),
  nextNote: z.string().nullable(),
  owner: z.enum(['assistant', 'user', 'job', 'workflow', 'system']),
  blockedReason: z.string().nullable(),
  reevaluateAt: z.string().nullable(),
  state: z.enum(GOAL_STATES),
  detail: z.string().nullable(),
  userAction: z.string().nullable(),
  interventions: z.number().int(),
  links: z.array(z.object({ kind: z.string(), id: z.string() })),
  openedAt: z.string(),
  updatedAt: z.string(),
  interventionAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  429: ErrorBodySchema,
};

export function goalRoutes(deps: { readonly goals: () => GoalLedger | null }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['chat'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const use = { config: { authz: { action: 'chat.use' as const } } };
    const userOf = (request: FastifyRequest): string => authzOf(request).subject.userId;
    const svc = (): GoalLedger => {
      const s = deps.goals();
      if (s === null) throw new HttpError(404, 'goal_not_found', 'Goal not found.');
      return s;
    };
    const Params = z.object({ gid: z.uuid() });

    r.get(
      '/chat/goals',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p20-outcome: the caller’s goals (one per open request of a conversation), newest change first — default the live ones (open and intervention); state=intervention feeds the intervention cards of “Senden bekleyen”',
          security: session,
          querystring: z.object({
            state: z.enum([...GOAL_STATES, 'live']).optional(),
            threadId: z.uuid().optional(),
          }),
          response: { 200: z.object({ items: z.array(GoalBody) }), ...errors },
        },
      },
      async (request) => {
        const s = deps.goals();
        if (s === null) return { items: [] };
        return {
          items: await s.list(userOf(request), {
            ...(request.query.state === undefined ? {} : { state: request.query.state }),
            ...(request.query.threadId === undefined ? {} : { threadId: request.query.threadId }),
          }),
        };
      },
    );

    r.get(
      '/chat/goals/:gid',
      {
        ...use,
        schema: {
          tags,
          summary: 'p20-outcome: one of the caller’s goals',
          security: session,
          params: Params,
          response: { 200: GoalBody, ...errors },
        },
      },
      async (request) => svc().get(userOf(request), request.params.gid),
    );

    for (const action of ['resume', 'cancel'] as const) {
      r.post(
        `/chat/goals/:gid/${action}`,
        {
          ...use,
          schema: {
            tags,
            summary:
              action === 'resume'
                ? 'p20-outcome: “Devam ettir” — the goal is open again and the assistant owns it (a plan goal resumes its plan; any other gets one continuation turn)'
                : 'p20-outcome: “Vazgeç” — the goal is given up (a plan goal cancels its plan; any other stops its active watches)',
            security: csrf,
            params: Params,
            response: { 200: GoalBody, ...errors },
          },
        },
        async (request) => {
          const actor = actorOf(request);
          return action === 'resume'
            ? svc().resume(actor, request.params.gid)
            : svc().cancel(actor, request.params.gid);
        },
      );
    }
  };
}
