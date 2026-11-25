import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { PLAN_LIMITS, PLAN_STATES } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { realStepUpFields } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { QuestionBody } from '../questions/routes.js';
import { type ChatPlanService, PLAN_LIST_FILTERS, PLAN_LIST_LIMIT, PLAN_LIST_SCOPES } from './plans.js';
import type { ChatShares } from './share.js';
import type { ChatStore } from './store.js';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §5): the plan API of the Sohbet conversations. Everything is `chat.use`
 * and the conversation's owner; reads also for its shared readers (read-only). Writes are CSRF-protected and audited
 * (`chat.plan.*`); the plan's own revision (`rev`) / version guards concurrent changes (409 with the current plan).
 *
 *  - `GET /chat/threads/:id/plans` — the active plan and the history (summaries) of a conversation.
 *  - `GET /chat/plans/:pid[?version=n]` · `GET /chat/plans/:pid/versions` · `GET /chat/plans/:pid/diff?from=&to=`
 *  - `PUT /chat/threads/:id/plan-mode {on}` — plan mode on / off (409 `plan_mode_unavailable` on an older machine).
 *  - `POST /chat/plans/:pid/approve {version, autonomous?}` · `/request-changes {version, note}` · `/pause` · `/resume` ·
 *    `/cancel` · `/autonomy {autonomous}` (p18-plan-autonomy)
 *  - `PATCH /chat/plans/:pid/items {baseRev, ops}` — the person's edits (409 `plan_rev_conflict`).
 *  - Decisions are answered through the question answer route (`POST /chat/threads/:id/questions/:qid/answer`).
 *  - `GET /chat/plans/waiting` (W4) — the caller's own plans that wait for them ("Senden bekleyen").
 *  - `GET /chat/plans[?filter=&scope=&project=&q=&limit=&offset=]` (p18-plans-ui) — the caller's plans across their
 *    conversations (and, with `scope`, the ones shared with them), with the overview counts ("Planlar").
 */

const Text = z.string();
const LinkBody = z.object({ kind: z.string(), id: z.string(), label: z.string().optional() });
export const PlanItemBody = z.object({
  key: z.string(),
  phase: z.number().int(),
  phaseTitle: z.string(),
  position: z.number().int(),
  title: Text,
  activeTitle: Text.nullable(),
  detail: Text.nullable(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked', 'skipped']),
  owner: z.enum(['assistant', 'user', 'job', 'workflow']),
  project: z.string().nullable(),
  dependsOn: z.array(z.string()).readonly(),
  estimate: z.union([z.string(), z.number()]).nullable(),
  links: z.array(LinkBody).readonly(),
  note: Text.nullable(),
  statusBy: z.enum(['assistant', 'user', 'derived']),
  decisionOpen: z.boolean(),
  awaitsUser: z.boolean(),
  failures: z.number().int(),
});
const DecisionBody = z.object({
  id: z.string(),
  itemKey: z.string().nullable(),
  prompt: Text,
  kind: z.enum(['single', 'multi', 'text']),
  options: z.array(z.object({ label: Text, description: Text.optional() })).readonly(),
  recommended: Text.nullable(),
  rationale: Text.nullable(),
  state: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  answers: z
    .array(
      z.object({
        id: z.string(),
        choices: z.array(z.string()).readonly().optional(),
        other: z.string().optional(),
        text: z.string().optional(),
      }),
    )
    .readonly()
    .nullable(),
  answer: Text.nullable(),
  createdAt: z.string(),
});
export const PlanBody = z.object({
  id: z.string(),
  threadId: z.string(),
  title: Text,
  goal: Text,
  assumptions: z.array(Text).readonly(),
  risks: z.array(Text).readonly(),
  state: z.enum(PLAN_STATES),
  version: z.number().int(),
  rev: z.number().int(),
  approvedVersion: z.number().int().nullable(),
  autonomous: z.boolean(),
  stalled: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  phases: z.array(z.object({ index: z.number().int(), title: Text })).readonly(),
  items: z.array(PlanItemBody).readonly(),
  decisions: z.array(DecisionBody).readonly(),
  progress: z.object({
    done: z.number().int(),
    total: z.number().int(),
    skipped: z.number().int(),
    remainingMinutes: z.number().int().nullable(),
  }),
  lastChange: z
    .object({
      version: z.number().int(),
      author: z.enum(['assistant', 'user']),
      reason: Text.nullable(),
      added: z.number().int(),
      removed: z.number().int(),
      changed: z.number().int(),
      moved: z.number().int(),
    })
    .nullable(),
});
/** p18-plan-mode W4: one plan that waits for the caller ("Senden bekleyen"). */
const PlanNeedBody = z.object({
  planId: z.string(),
  threadId: z.string(),
  threadTitle: Text,
  title: Text,
  state: z.enum(PLAN_STATES),
  rev: z.number().int(),
  stalled: z.string().nullable(),
  questions: z.array(QuestionBody).readonly(),
  waiting: z
    .array(
      z.object({
        key: z.string(),
        title: Text,
        why: z.enum(['card', 'blocked', 'mine']),
        note: Text.nullable(),
      }),
    )
    .readonly(),
  updatedAt: z.string(),
});

/** p18-plans-ui: one row of the plans list. */
const PlanListItemBody = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: Text,
  archived: z.boolean(),
  role: z.enum(['owner', 'reader']),
  title: Text,
  state: z.enum(PLAN_STATES),
  autonomous: z.boolean(),
  stalled: z.string().nullable(),
  version: z.number().int(),
  progress: z.object({
    done: z.number().int(),
    total: z.number().int(),
    skipped: z.number().int(),
    remainingMinutes: z.number().int().nullable(),
  }),
  openDecisions: z.number().int(),
  waiting: z.number().int(),
  needsYou: z.boolean(),
  projects: z.array(z.string()).readonly(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
const PlanListCountsBody = z.object({
  total: z.number().int(),
  active: z.number().int(),
  executing: z.number().int(),
  review: z.number().int(),
  paused: z.number().int(),
  done: z.number().int(),
  cancelled: z.number().int(),
  needsYou: z.number().int(),
});

/** The thread view's plan part: plan mode (since, null: off) and the active plan. */
export const ThreadPlanBody = z.object({ mode: z.string().nullable(), active: PlanBody.nullable() });

const SummaryBody = z.object({
  id: z.string(),
  title: Text,
  state: z.enum(PLAN_STATES),
  version: z.number().int(),
  done: z.number().int(),
  total: z.number().int(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
const VersionMetaBody = z.object({
  version: z.number().int(),
  author: z.enum(['assistant', 'user']),
  reason: Text.nullable(),
  createdAt: z.string(),
});
const VersionBody = VersionMetaBody.extend({
  items: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
  changed: z.number().int(),
  moved: z.number().int(),
});
const ShapeBody = z.object({
  key: z.string(),
  phase: z.number().int(),
  phaseTitle: Text,
  position: z.number().int(),
  title: Text,
  activeTitle: Text.nullable(),
  detail: Text.nullable(),
  owner: z.enum(['assistant', 'user', 'job', 'workflow']),
  project: z.string().nullable(),
  dependsOn: z.array(z.string()).readonly(),
  estimate: z.union([z.string(), z.number()]).nullable(),
});
const DiffBody = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.object({ key: z.string(), fields: z.array(z.string()) })),
  moved: z.array(z.string()),
  goalChanged: z.boolean(),
  titleChanged: z.boolean(),
  // p18-plan-mode W3: the diff view of the console.
  from: VersionMetaBody,
  to: VersionMetaBody,
  items: z
    .array(
      z.object({
        key: z.string(),
        change: z.enum(['added', 'removed', 'changed', 'moved']),
        fields: z.array(z.string()).readonly(),
        moved: z.boolean(),
        before: ShapeBody.nullable(),
        after: ShapeBody.nullable(),
      }),
    )
    .readonly(),
  decisions: z
    .array(
      z.object({
        id: z.string(),
        itemKey: z.string().nullable(),
        prompt: Text,
        change: z.enum(['asked', 'answered']),
        answer: Text.nullable(),
      }),
    )
    .readonly(),
});

/** 409 answers carry the current plan (the console shows "Plan güncellendi — farkları gör"). */
const ConflictBody = ErrorBodySchema.extend({ plan: PlanBody.nullable().optional() });
const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ConflictBody,
  429: ErrorBodySchema,
};

export function planRoutes(deps: {
  readonly plans: () => ChatPlanService | null;
  readonly store: ChatStore;
  readonly shares?: ChatShares;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['chat'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const use = { config: { authz: { action: 'chat.use' as const } } };
    const userOf = (request: FastifyRequest): string => authzOf(request).subject.userId;
    const svc = (): ChatPlanService => {
      const s = deps.plans();
      if (s === null) throw new HttpError(404, 'plan_not_found', 'Plan not found.');
      return s;
    };
    /** The owner, or (`read`) a shared reader, of the conversation. */
    const canSee = async (userId: string, threadId: string, read: boolean): Promise<void> => {
      if (read && deps.shares !== undefined) {
        await deps.shares.access(userId, threadId);
        return;
      }
      await deps.store.thread(userId, threadId);
    };
    const ofPlan = async (request: FastifyRequest, planId: string, read: boolean): Promise<void> => {
      const threadId = await svc().threadOf(planId);
      await canSee(userOf(request), threadId, read).catch(() => {
        throw new HttpError(404, 'plan_not_found', 'Plan not found.');
      });
    };
    const ThreadParams = z.object({ id: z.uuid() });
    const PlanParams = z.object({ pid: z.uuid() });

    r.get(
      '/chat/threads/:id/plans',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: the conversation’s active plan and its earlier plans (owner and shared readers)',
          security: session,
          params: ThreadParams,
          response: {
            200: z.object({
              active: PlanBody.nullable(),
              history: z.array(SummaryBody),
              mode: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await canSee(userOf(request), request.params.id, true);
        const s = svc();
        const [{ active, history }, mode] = await Promise.all([
          s.ofThread(request.params.id),
          s.mode(request.params.id),
        ]);
        return { active, history, mode };
      },
    );

    r.get(
      '/chat/plans/waiting',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode W4: the caller’s own plans that wait for them — approval, open decisions, a stall, a card to confirm, a blocked item, their own ready item (Senden bekleyen)',
          security: session,
          response: { 200: z.object({ items: z.array(PlanNeedBody) }), ...errors },
        },
      },
      async (request) => {
        const s = deps.plans();
        return { items: s === null ? [] : await s.waiting(userOf(request)) };
      },
    );

    r.get(
      '/chat/plans',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plans-ui: the caller’s plans across their conversations, newest change first (scope shared / all: also the conversations shared with them, read only) — filter (active, executing, review, paused, done, cancelled), project, title search, offset paging; with the overview counts of the scope',
          security: session,
          querystring: z.object({
            filter: z.enum(PLAN_LIST_FILTERS).optional(),
            scope: z.enum(PLAN_LIST_SCOPES).optional(),
            project: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/u)
              .optional(),
            q: z.string().max(120).optional(),
            limit: z.coerce.number().int().min(1).max(PLAN_LIST_LIMIT.max).optional(),
            offset: z.coerce.number().int().min(0).max(10_000).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(PlanListItemBody),
              next: z.number().int().nullable(),
              counts: PlanListCountsBody,
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const s = deps.plans();
        if (s === null)
          return {
            items: [],
            next: null,
            counts: {
              total: 0,
              active: 0,
              executing: 0,
              review: 0,
              paused: 0,
              done: 0,
              cancelled: 0,
              needsYou: 0,
            },
          };
        const page = await s.list(userOf(request), request.query);
        return { ...page, items: page.items.map((i) => ({ ...i, projects: [...i.projects] })) };
      },
    );

    r.get(
      '/chat/plans/:pid',
      {
        ...use,
        schema: {
          tags,
          summary: 'p18-plan-mode: one plan (a kept version with ?version=n, read-only)',
          security: session,
          params: PlanParams,
          querystring: z.object({ version: z.coerce.number().int().min(1).optional() }),
          response: { 200: PlanBody, ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, true);
        return svc().get(request.params.pid, request.query.version);
      },
    );

    r.get(
      '/chat/plans/:pid/versions',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: the kept versions of a plan, newest first (author, reason, when, counts against the version before)',
          security: session,
          params: PlanParams,
          response: { 200: z.object({ versions: z.array(VersionBody) }), ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, true);
        return { versions: await svc().versions(request.params.pid) };
      },
    );

    r.get(
      '/chat/plans/:pid/diff',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: what changed between two kept versions (added / removed / changed / moved per item, both sides of each item, decisions asked / answered between them)',
          security: session,
          params: PlanParams,
          querystring: z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }),
          response: { 200: DiffBody, ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, true);
        const d = await svc().diff(request.params.pid, request.query.from, request.query.to);
        return {
          ...d,
          added: [...d.added],
          removed: [...d.removed],
          moved: [...d.moved],
          changed: d.changed.map((c) => ({ key: c.key, fields: [...c.fields] })),
        };
      },
    );

    r.put(
      '/chat/threads/:id/plan-mode',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: turn plan mode on or off for the conversation (the assistant only reads and plans; 409 plan_mode_unavailable while the assistant machine lacks the plan tools)',
          security: csrf,
          params: ThreadParams,
          body: z.object({ on: z.boolean() }),
          response: { 200: z.object({ mode: z.string().nullable() }), ...errors },
        },
      },
      async (request) => ({
        mode: await svc().setMode(userOf(request), request.params.id, request.body.on),
      }),
    );

    r.post(
      '/chat/plans/:pid/approve',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: approve the plan at this version — leaves plan mode and starts execution; `autonomous` (default true, p18-plan-autonomy) lets the continuation turns run the plan’s drafts at once (what the security policy keeps on a card still waits); 409 plan_decisions_open / plan_version_conflict',
          security: csrf,
          params: PlanParams,
          body: z.object({ version: z.number().int().min(1), autonomous: z.boolean().optional() }),
          response: { 200: PlanBody, ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, false);
        return svc().approve(
          actorOf(request),
          request.params.pid,
          request.body.version,
          request.body.autonomous ?? true,
        );
      },
    );

    r.post(
      '/chat/plans/:pid/autonomy',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-autonomy: turn autonomous execution of the plan off (its drafts wait as cards) or on (continuation drafts run at once); owner only, audited chat.plan.autonomy; 409 plan_state_conflict for a closed plan',
          security: csrf,
          params: PlanParams,
          body: z.object({ autonomous: z.boolean() }),
          response: { 200: PlanBody, ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, false);
        return svc().setAutonomy(actorOf(request), request.params.pid, request.body.autonomous);
      },
    );

    r.post(
      '/chat/plans/:pid/request-changes',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: ask the assistant to revise the plan — the note is sent as the owner’s message in plan mode (409 turn_in_progress while it answers)',
          security: csrf,
          params: PlanParams,
          body: z.object({
            version: z.number().int().min(1),
            note: z.string().trim().min(1).max(PLAN_LIMITS.changeNote),
          }),
          response: { 200: z.object({ turnId: z.string() }), ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, false);
        return svc().requestChanges(
          actorOf(request),
          request.params.pid,
          request.body.version,
          request.body.note,
          realStepUpFields(request),
        );
      },
    );

    for (const action of ['pause', 'resume', 'cancel'] as const) {
      r.post(
        `/chat/plans/:pid/${action}`,
        {
          ...use,
          schema: {
            tags,
            summary:
              action === 'pause'
                ? 'p18-plan-mode: pause an executing plan (no continuation turns)'
                : action === 'resume'
                  ? 'p18-plan-mode: resume a paused or waiting plan (“Plana devam edeyim mi?”)'
                  : 'p18-plan-mode: cancel the plan (its open decisions close)',
            security: csrf,
            params: PlanParams,
            response: { 200: PlanBody, ...errors },
          },
        },
        async (request) => {
          await ofPlan(request, request.params.pid, false);
          const s = svc();
          const actor = actorOf(request);
          return action === 'pause'
            ? s.pause(actor, request.params.pid)
            : action === 'resume'
              ? s.resume(actor, request.params.pid)
              : s.cancel(actor, request.params.pid);
        },
      );
    }

    r.patch(
      '/chat/plans/:pid/items',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p18-plan-mode: the owner’s edits of the plan’s items (add, rename, detail, move, remove, restore, skip, unskip, assign_me, done_mine, set_owner, set_project, set_estimate) at the revision they saw — structural edits make a user version (no re-approval); 409 plan_rev_conflict with the current plan',
          security: csrf,
          params: PlanParams,
          body: z.object({
            baseRev: z.number().int().min(0),
            ops: z.array(z.unknown()).min(1).max(PLAN_LIMITS.userOps),
          }),
          response: { 200: PlanBody, ...errors },
        },
      },
      async (request) => {
        await ofPlan(request, request.params.pid, false);
        return svc().edit(actorOf(request), request.params.pid, request.body);
      },
    );
  };
}
