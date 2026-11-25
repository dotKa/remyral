import { JOB_MESSAGE_STATUSES } from '@remyral/protocol/job-messages';
import { PriorityClass } from '@remyral/protocol';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  ChatArchiveNote,
  MAX_ASSISTANT_MESSAGE,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ZIPS,
  MAX_THREAD_PROJECTS,
} from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { realStepUpFields, requireStepUp, stepUpFields } from '../auth/hooks.js';
import { jobResource, paramTarget } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import type { ChatKnowledge, ChatKnowledgePrefs, ThreadKnowledge } from '../search/chat-knowledge.js';
import { cursorOrBadRequest, keysetQuery, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import type { JobMessageService } from '../jobs/messages.js';
import { QuestionBody } from '../questions/routes.js';
import type { QuestionService } from '../questions/service.js';
import { actorOf } from '../workers/routes.js';
import type { ChatAttachments } from './attachments.js';
import { DraftEditBody } from './draft-edit.js';
import type { DraftExecutor } from './drafts.js';
import { type ChatJobActions, MAX_JOB_ACTION_JOBS } from './job-actions.js';
import { type ChatMentions, MENTION_TYPES, MentionRefs } from './mentions.js';
import {
  type ChatOrganizer,
  OrganizeSummaryBody,
  ThreadListFilters,
  threadListFilter,
} from './organize-routes.js';
import type { ChatService } from './service.js';
import {
  ChatLimits,
  ChatSettingsInput,
  type ChatSettings,
  type ChatSettingsStore,
  type ChatWorkerEngines,
} from './settings.js';
import { type ChatStore, draftView } from './store.js';
import { AutoInput, PinInput } from './failover.js';
import type { ChatCredentials } from './credentials.js';
import type { ChatStreams } from './streams.js';
import { type ChatWatchService, WatchError } from './watches.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { readerView, type ChatShares } from './share.js';
import { chatCompleteRoutes } from './complete-routes.js';
import { ThreadPlanBody } from './plan-routes.js';
import type { ChatPlanService } from './plans.js';
import type { ThreadProjects } from './thread-projects.js';
import type { GoalGrants } from './goal-grants.js';
import type { UntrustedAllows } from './untrusted.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};

const Json = z.record(z.string(), z.unknown());
const ConfirmBody = z.object({
  approvalPolicy: z.enum(['ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all']).optional(),
  /** p9-queue-priority: the class picked on a job / workflow run card. */
  priorityClass: PriorityClass.optional(),
  /** p10-chat-job-actions: the jobs left checked on a job action card (a subset of its jobs). */
  jobIds: z.array(z.uuid()).min(1).max(50).optional(),
  /** p14-mcp-chat: an MCP install card's "turn on MCP for this project" box (unticked by default). */
  enableMcpProject: z.boolean().optional(),
  /**
   * oss-sec3: a card held because its turn read untrusted content — "remember this": the same kind of action on the same
   * target runs without asking in later such turns (only the person's own confirmation writes it; unticked by default).
   */
  remember: z.boolean().optional(),
});
const ThreadParams = z.object({ id: z.uuid() });
export const ThreadBody = z.object({
  id: z.string(),
  title: z.string(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** p9-chat-unread: a conversation list row with the caller's unread count (capped at 100). */
const ThreadListBody = ThreadBody.extend({
  unreadCount: z.number().int().min(0),
  /** p10-chat-organize: the caller's own pin, group and tags. */
  pinnedAt: z.string().nullable(),
  groupId: z.string().nullable(),
  tagIds: z.array(z.string()),
});
const ReadStateBody = z.object({
  threadId: z.string(),
  lastReadSeq: z.number().int(),
  lastReadAt: z.string(),
  unreadCount: z.number().int(),
});
export const MessageBody = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool', 'error']),
  content: z.string(),
  meta: Json.nullable(),
  turnId: z.string().nullable(),
  createdAt: z.string(),
  /** p16-chat-complete: replaced by an edit / regenerate / retry (folded by the console; never sent to a model). */
  supersededAt: z.string().optional(),
  supersededBy: z.string().optional(),
});
const DraftBody = z.object({
  id: z.string(),
  threadId: z.string(),
  kind: z.string(),
  title: z.string(),
  payload: Json,
  project: z.string().nullable(),
  state: z.string(),
  result: Json.nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  /** p16-chat-complete: a shared reader may not see this card's project ("erişimin yok"). */
  restricted: z.boolean().optional(),
  /** oss-sec3: held as a card because its turn read untrusted content; whether it may be remembered. */
  held: z.object({ reason: z.literal('untrusted_content'), rememberable: z.boolean() }).optional(),
});
/** p6-chat-notify: one of the caller's watches ("let me know when …"). */
const WatchBody = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  target: z.object({ kind: z.string(), id: z.string() }),
  label: z.string(),
  project: z.string().nullable(),
  conditions: z.array(z.string()),
  repeat: z.enum(['once', 'every']),
  language: z.enum(['tr', 'en']),
  state: z.string(),
  endReason: z.string().nullable(),
  fireCount: z.number().int(),
  lastFiredAt: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
  link: z.string(),
  /** p20-quick (additive): the originating conversation's title (the caller's list without `threadId`). */
  threadTitle: z.string().nullable().optional(),
  /** p15-watches (Takipler): the condition, last and next check of a `check` watch; null for the other kinds. */
  check: z
    .object({
      kind: z.string(),
      condition: z.record(z.string(), z.unknown()),
      summary: z.string(),
      mode: z.enum(['event', 'poll']),
      everySec: z.number().int().nullable(),
      lastCheck: z
        .object({
          at: z.string(),
          met: z.boolean(),
          summary: z.string(),
          mode: z.string(),
          value: z.unknown().optional(),
          workerId: z.string().nullable().optional(),
          error: z.string().nullable().optional(),
        })
        .nullable(),
      nextCheckAt: z.string().nullable(),
      checking: z.boolean(),
      checks: z.number().int(),
      result: z.object({ summary: z.string(), value: z.unknown(), url: z.string().nullable() }).nullable(),
      then: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
});
const StatusBody = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  worker: z.object({ id: z.string(), name: z.string(), online: z.boolean() }).nullable(),
  runtime: z.string(),
  model: z.string().nullable(),
  /** p11-usage-limit-fallback (additive): the fallback engine answers while the main engine is at its usage limit. */
  fallback: z.boolean(),
  limit: z.object({ runtime: z.string(), until: z.string(), resetAt: z.string().nullable() }).nullable(),
  /** p13-runtime-accounts (additive): the runtime account turns go to now (null = the configured one). */
  account: z.string().nullable(),
  limits: z.object({ turnsPerUserPer10Min: z.number().int(), userDailyTokens: z.number().int().nullable() }),
  input: z.object({
    images: z.enum(['supported', 'model-dependent', 'unsupported']),
    pdf: z.boolean(),
    mentions: z.boolean(),
    reason: z.string().nullable(),
  }),
  /** p15-chat-failover (additive): the configured primary and which machine of the chain answers, and why. */
  primary: z.object({ id: z.string(), name: z.string(), online: z.boolean() }).nullable(),
  routing: z
    .object({
      machine: z.enum(['primary', 'backup']).nullable(),
      reason: z
        .enum(['primary', 'pinned', 'primary_offline', 'primary_unavailable', 'primary_unstable'])
        .nullable(),
      position: z.number().int().nullable(),
      pinned: z.boolean(),
      auto: z.boolean(),
      primaryIssue: z.object({ code: z.string(), message: z.string() }).nullable(),
      returnsAt: z.string().nullable(),
      backups: z.number().int(),
      pin: z.object({ workerId: z.string(), name: z.string(), until: z.string() }).nullable(),
    })
    .nullable(),
  /** p16-chat-complete (additive): the engines the answering machine has ready (regenerate with another one). */
  engines: z.array(z.string()).optional(),
  /** p18-plan-mode (additive): the answering machine has the plan tools (plan mode can be turned on). */
  plan: z.boolean().optional(),
  /**
   * p20-quick (additive): the security policy lets the assistant act directly (`autonomy.chatDirect`): a request the
   * person writes runs at once instead of waiting as a card. Absent: unknown (the console then promises neither).
   */
  direct: z.boolean().optional(),
});
/** p15-chat-failover: `GET /chat/failover`. */
const FailoverBody = z.object({
  status: StatusBody,
  auto: z.boolean(),
  stableSeconds: z.number().int(),
  pin: z.object({ workerId: z.string(), name: z.string(), until: z.string() }).nullable(),
  active: z
    .object({ workerId: z.string(), name: z.string(), reason: z.string().nullable(), since: z.string() })
    .nullable(),
  chain: z.array(
    z.object({
      workerId: z.string(),
      name: z.string(),
      role: z.enum(['primary', 'backup']),
      position: z.number().int(),
      online: z.boolean(),
      connectedAt: z.string().nullable(),
      workerVersion: z.string().nullable(),
      eligible: z.boolean(),
      issue: z.string().nullable(),
      message: z.string().nullable(),
      runtime: z.string().nullable(),
      fallback: z.boolean(),
      account: z.string().nullable(),
      answering: z.boolean(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      from: z.object({ id: z.string(), name: z.string() }).nullable(),
      to: z.object({ id: z.string(), name: z.string() }).nullable(),
      reason: z.string().nullable(),
      actor: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
const AttachmentBody = z.object({
  id: z.string(),
  threadId: z.string(),
  messageId: z.string().nullable(),
  kind: z.enum(['image', 'pdf', 'text']),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  scrubbed: z.array(z.string()),
  createdAt: z.string(),
  url: z.string(),
});
export const DroppedBody = z.object({ type: z.string(), id: z.string(), reason: z.string() });
/** p22-chat-queue: a message written while the assistant was answering, waiting for the next turn. */
export const QueuedBody = z.object({
  id: z.string(),
  content: z.string(),
  meta: Json,
  attachments: z.number().int(),
  holdReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** p10-semantic-defaults-chat: the thread's project and whether it is shared with project knowledge. */
/** p18-multi-project W3: one working project of a conversation. */
const ThreadProjectBody = z.object({
  project: z.string(),
  name: z.string(),
  kind: z.enum(['repository', 'workspace']),
  role: z.string().nullable(),
  share: z.boolean(),
  primary: z.boolean(),
});
const KnowledgeBody = z.object({
  project: z.string().nullable(),
  share: z.boolean(),
  personalShare: z.boolean(),
  sharedWith: z.array(z.string()),
  notShared: z.array(
    z.object({
      project: z.string(),
      reason: z.enum(['thread_off', 'personal_off', 'indexing_off', 'capture_off', 'no_access']),
    }),
  ),
  suggestedProject: z.string().nullable(),
  /** p10-chat-memory-suggestions: projects where "Summarise this conversation for project memory" is offered. */
  memorySummary: z.array(z.string()),
  /** p18-multi-project W3: the working projects (primary first), each with its own sharing switch. */
  projects: z.array(ThreadProjectBody),
});
const PrefsBody = z.object({
  indexConversations: z.boolean(),
  shareProjects: z.boolean(),
  autoRelated: z.boolean(),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
});
const OwnHitBody = z.object({
  threadId: z.string(),
  threadTitle: z.string(),
  archived: z.boolean(),
  messageId: z.string(),
  seq: z.number().int(),
  author: z.enum(['user', 'assistant']),
  attachmentName: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
  at: z.string(),
  /** p18-leftovers: a plan of the conversation matched (messageId is `plan:<id>`). */
  plan: z.object({ id: z.string(), title: z.string() }).nullable().optional(),
});
const knowledgeJson = (k: ThreadKnowledge): z.infer<typeof KnowledgeBody> => ({
  ...k,
  sharedWith: [...k.sharedWith],
  notShared: k.notShared.map((n) => ({ ...n })),
  memorySummary: [...k.memorySummary],
  projects: k.projects.map((p) => ({ ...p })),
});
const prefsJson = (p: ChatKnowledgePrefs): z.infer<typeof PrefsBody> => ({
  ...p,
  updatedAt: p.updatedAt?.toISOString() ?? null,
});
/** Base64 of one attachment (≤ 3.75 MiB raw) plus the JSON around it. */
export const CHAT_ATTACHMENT_BODY_LIMIT = 6 * 1024 * 1024;

/** RFC 6266 filename: ASCII fallback plus the UTF-8 form. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._ ()+-]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
const UsageCounts = z.object({
  turns: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  unknownTurns: z.number().int(),
});
const SettingsBody = z.object({
  enabled: z.boolean(),
  workerId: z.string().nullable(),
  runtime: z.string(),
  modelProfile: z.string().nullable(),
  /** p15-model-picker (additive): the engine's model as a model id (instead of a profile). */
  model: z.string().nullable(),
  /** p11-usage-limit-fallback (additive): the engine the chat continues on while the main one is at its usage limit. */
  fallbackRuntime: z.string().nullable(),
  fallbackModelProfile: z.string().nullable(),
  fallbackModel: z.string().nullable(),
  /** p13-runtime-accounts (additive): the engine's runtime account and fallback account (null = configured / none). */
  account: z.string().nullable(),
  fallbackAccount: z.string().nullable(),
  /** p15-chat-failover (additive): the ordered backup assistant machines after the primary. */
  backupWorkerIds: z.array(z.string()),
  limits: ChatLimits,
  version: z.number().int(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
  /**
   * p5-ops-chat-next: workers that run an assistant host and the readiness of each engine they reported (Settings →
   * Chat shows it next to the runtime choice). A runtime a worker does not list needs a newer worker release.
   */
  engines: z.array(
    z.object({
      workerId: z.string(),
      workerName: z.string(),
      online: z.boolean(),
      disabled: z.boolean(),
      engines: z.array(z.object({ runtime: z.string(), ready: z.boolean(), reason: z.string().optional() })),
      reportedAt: z.string().nullable(),
      /** p15-chat-failover (additive): worker release, assistant feature, connected since (readiness per machine). */
      workerVersion: z.string().nullable(),
      assistantFeature: z.boolean(),
      connectedAt: z.string().nullable(),
    }),
  ),
});

function settingsJson(s: ChatSettings, engines: readonly ChatWorkerEngines[]): z.infer<typeof SettingsBody> {
  return {
    ...s,
    backupWorkerIds: [...s.backupWorkerIds],
    updatedAt: s.updatedAt.toISOString(),
    engines: engines.map((w) => ({
      ...w,
      engines: w.engines.map((e) => ({ ...e })),
      reportedAt: w.reportedAt === null ? null : w.reportedAt.toISOString(),
      connectedAt: w.connectedAt === null ? null : w.connectedAt.toISOString(),
    })),
  };
}

function userOf(request: FastifyRequest): string {
  return authzOf(request).subject.userId;
}

/**
 * Ops chat API (p5-ops-chat, ADR-0018). Threads are private: every thread/draft route resolves the row with
 * the caller's user id (another user's thread is a 404). `chat.use` (viewer+) for one's own conversations;
 * the assistant's tools act with the caller's own permissions. Confirming a draft needs step-up and CSRF and
 * re-checks the action the draft proposes. Settings (kill switch, worker, runtime, model, limits) are
 * `chat.admin` with step-up. `POST /jobs/:id/messages` talks to a running job's agent (`jobs.message`).
 */
export function chatRoutes(deps: {
  readonly service: ChatService;
  readonly store: ChatStore;
  readonly settings: ChatSettingsStore;
  readonly drafts: DraftExecutor;
  readonly streams: ChatStreams;
  readonly jobMessages: JobMessageService;
  readonly db: Parameters<typeof jobResource>[0];
  readonly clock?: () => Date;
  /** p6-chat-notify (absent: no watches; the thread view lists none). */
  readonly watches?: ChatWatchService;
  /** p8-chat-attachments-mentions (absent: the routes answer 404 / no items). */
  readonly attachments?: ChatAttachments;
  readonly mentions?: ChatMentions;
  /** p10-semantic-defaults-chat: chat knowledge (absent: no search, no sharing, no related knowledge). */
  readonly knowledge?: ChatKnowledge;
  /** p18-multi-project W3: the conversation's working projects (absent: the routes answer 503). */
  readonly threadProjects?: () => ThreadProjects | null;
  /** p10-chat-organize (absent: no `organize` summary / `starred` ids in the answers). */
  readonly organizer?: ChatOrganizer;
  /** p10-chat-job-actions: quick buttons on a job card draft a job action card (absent: 404). */
  readonly jobActions?: ChatJobActions;
  /** p14-ask-user: the conversation's question cards in the thread view (absent: none). */
  readonly questions?: () => QuestionService | null;
  /** p15-workflow-ai: the workflow a conversation is linked to (absent: never linked). */
  readonly workflowLink?: (
    userId: string,
    threadId: string,
  ) => Promise<{ project: string; name: string | null; definitionId: string | null } | null>;
  readonly limiter?: {
    hit(b: string, k: string, n: number, ms: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  };
  /** p15-chat-vault: credential_save cards completed by the browser (absent: 404). */
  readonly credentials?: () => ChatCredentials | null;
  /** p16-chat-complete: shared readers and handing over (absent: owner-only, no sharing routes). */
  readonly shares?: ChatShares;
  /** p18-plan-mode: plan mode and the active plan in the thread view (absent: none). */
  readonly plans?: () => ChatPlanService | null;
  /** p20-quick: whether the security policy lets the assistant act directly (absent / null: unknown). */
  readonly direct?: () => Promise<boolean | null>;
  /** p20-scope-preview: the conversation's goal-bound grants (absent: the routes answer 503). */
  readonly goalGrants?: () => GoalGrants | null;
  /** oss-sec3: remembered confirmations for cards held because a turn read untrusted content. */
  readonly untrustedAllows?: () => UntrustedAllows | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['chat'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const use = { config: { authz: { action: 'chat.use' as const } } };
    const admin = { config: { authz: { action: 'chat.admin' as const } } };
    const stepUp = requireStepUp('standard', deps.clock);
    app.addHook('onClose', () => {
      deps.streams.closeAll();
    });

    r.get(
      '/chat/status',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Whether the assistant is available (kill switch, worker online, runtime ready) and why not',
          security: session,
          response: { 200: StatusBody, ...errors },
        },
      },
      async () => {
        const status = await deps.service.status();
        // p20-quick: the composer and the empty conversation say what really happens to a request (card or not).
        const direct = await (deps.direct?.() ?? Promise.resolve(null)).catch(() => null);
        return direct === null ? status : { ...status, direct };
      },
    );

    r.get(
      '/chat/threads',
      {
        ...use,
        schema: {
          tags,
          summary: 'The caller’s conversations (newest first), with search over titles and messages',
          security: session,
          querystring: z.object({
            q: z.string().max(200).optional(),
            archived: z.enum(['true', 'false']).optional(),
            ...ThreadListFilters,
            ...keysetQuery(200),
          }),
          response: {
            200: z.object({
              items: z.array(ThreadListBody),
              ...pageFields,
              /** p10-chat-organize: the caller's groups, tags and number of pins (the list's sections). */
              organize: OrganizeSummaryBody.optional(),
              /**
               * p16-chat-complete: on the first plain page, the conversations other people shared with the caller
               * ("Paylaşılanlar", read-only).
               */
              shared: z
                .array(
                  ThreadBody.extend({
                    owner: z.object({ id: z.string(), username: z.string() }),
                    sharedAt: z.string(),
                  }),
                )
                .optional(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const userId = userOf(request);
        const query = request.query;
        const firstPlain =
          deps.shares !== undefined &&
          query.cursor === undefined &&
          query.archived !== 'true' &&
          (query.q ?? '') === '' &&
          Object.keys(threadListFilter(query)).length === 0;
        const shared = firstPlain ? await deps.shares.listShared(userId, 50) : undefined;
        const [page, organize] = await Promise.all([
          cursorOrBadRequest(() =>
            deps.store.listThreadsPage(userId, {
              ...(request.query.q === undefined ? {} : { search: request.query.q }),
              archived: request.query.archived === 'true',
              ...threadListFilter(request.query),
              ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
              ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
            }),
          ),
          deps.organizer?.summary(userId),
        ]);
        return {
          ...page,
          ...(organize === undefined ? {} : { organize }),
          ...(shared === undefined ? {} : { shared }),
        };
      },
    );

    // p9-chat-unread: the caller's read position per conversation (private threads: the owner only).
    const readLimit = async (request: FastifyRequest, bucket: string, n: number): Promise<void> => {
      if (deps.limiter === undefined) return;
      const hit = await deps.limiter.hit(bucket, userOf(request), n, 60_000);
      if (!hit.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many read updates; slow down.',
          {
            'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
          },
          {},
          { reason: 'read_updates' },
        );
      }
    };

    r.get(
      '/chat/unread',
      {
        ...use,
        schema: {
          tags,
          summary:
            'The caller’s unread totals over conversations that are not archived (nav badge, tab title): messages and conversations',
          security: session,
          response: { 200: z.object({ total: z.number().int(), threads: z.number().int() }), ...errors },
        },
      },
      async (request) => deps.store.unreadSummary(userOf(request)),
    );

    r.post(
      '/chat/threads/read-all',
      {
        ...use,
        schema: {
          tags,
          summary: 'Mark all of the caller’s conversations as read',
          security: csrf,
          body: z.object({}).strict().optional(),
          response: { 200: z.object({ updated: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        await readLimit(request, 'chat-read-all', 30);
        return { updated: await deps.store.markAllRead(userOf(request)) };
      },
    );

    r.post(
      '/chat/threads/:id/read',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Mark one of the caller’s conversations read up to a message (default: the latest); idempotent, never moves back',
          security: csrf,
          params: ThreadParams,
          body: z
            .object({ seq: z.number().int().min(0).max(2_147_483_647).optional() })
            .strict()
            .optional(),
          response: { 200: ReadStateBody, ...errors },
        },
      },
      async (request) => {
        await readLimit(request, 'chat-read', 240);
        return deps.store.markRead(userOf(request), request.params.id, request.body?.seq);
      },
    );

    r.post(
      '/chat/threads',
      {
        ...use,
        schema: {
          tags,
          summary: 'Start a conversation (empty; send a message next)',
          security: csrf,
          body: z.object({ title: z.string().min(1).max(200).optional() }),
          response: { 201: ThreadBody, ...errors },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await deps.store.createThread(userOf(request), request.body.title)),
    );

    r.get(
      '/chat/threads/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'One of the caller’s conversations: messages, draft cards and the running turn',
          security: session,
          params: ThreadParams,
          response: {
            200: z.object({
              thread: ThreadBody,
              messages: z.array(MessageBody),
              drafts: z.array(DraftBody),
              turn: z.object({ id: z.string(), state: z.string(), text: z.string() }).nullable(),
              /** p6-chat-notify: the active watches this conversation set. */
              watches: z.array(WatchBody),
              /** p10-semantic-defaults-chat: project link and knowledge sharing (null: not available). */
              knowledge: KnowledgeBody.nullable(),
              /** p10-chat-organize: ids of the caller's starred messages in this conversation. */
              starred: z.array(z.string()).optional(),
              /** p14-ask-user: the assistant's question cards of this conversation (oldest first). */
              questions: z.array(QuestionBody).optional(),
              /** p15-workflow-ai: the workflow this conversation belongs to (the editor's AI panel), else null. */
              workflow: z
                .object({
                  project: z.string(),
                  name: z.string().nullable(),
                  definitionId: z.string().nullable(),
                })
                .nullable()
                .optional(),
              /** p16-chat-complete: the caller owns it, or reads it shared (read-only), and who owns it. */
              access: z.enum(['owner', 'reader']).optional(),
              owner: z.object({ id: z.string(), username: z.string() }).nullable().optional(),
              /** p18-plan-mode: plan mode (since when, null: off) and the conversation's active plan. */
              plan: ThreadPlanBody.optional(),
              /** p22-chat-queue: the owner's messages waiting for the running turn to end (oldest first). */
              queued: z.array(QueuedBody).optional(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const userId = userOf(request);
        // p16-chat-complete: a shared reader gets the conversation read-only, filtered for their permissions.
        const access = deps.shares === undefined ? null : await deps.shares.access(userId, request.params.id);
        if (access !== null && access.role === 'reader') {
          const subject = authzOf(request).subject;
          const [messages, drafts, starred, questions, plan] = await Promise.all([
            deps.store.messages(access.thread.id),
            deps.store.drafts(access.thread.id),
            deps.organizer?.starredIds(userId, access.thread.id),
            deps.questions?.()?.forThread(access.thread.id),
            deps.plans?.()?.summary(access.thread.id),
          ]);
          const view = readerView(subject, messages, drafts.map(draftView));
          return {
            thread: access.thread,
            messages: view.messages,
            drafts: view.drafts,
            turn: deps.service.snapshot(access.thread.id).turn,
            watches: [],
            knowledge: null,
            ...(starred === undefined ? {} : { starred }),
            ...(questions === undefined ? {} : { questions }),
            workflow: null,
            access: 'reader' as const,
            owner: access.owner,
            ...(plan === undefined ? {} : { plan }),
          };
        }
        const thread = await deps.store.thread(userId, request.params.id);
        const [messages, drafts, watches, knowledge, starred, questions, workflow, plan, queued] =
          await Promise.all([
            deps.store.messages(thread.id),
            deps.store.drafts(thread.id),
            deps.watches === undefined ? [] : deps.watches.list(userId, { threadId: thread.id }),
            deps.knowledge === undefined ? null : deps.knowledge.threadKnowledge(userId, thread.id),
            deps.organizer?.starredIds(userId, thread.id),
            deps.questions?.()?.forThread(thread.id),
            deps.workflowLink?.(userId, thread.id),
            deps.plans?.()?.summary(thread.id),
            deps.service.queued(userId, thread.id),
          ]);
        return {
          thread,
          messages,
          drafts: drafts.map(draftView),
          turn: deps.service.snapshot(thread.id).turn,
          watches: watches.map((w) => ({ ...w, conditions: [...w.conditions] })),
          knowledge: knowledge === null ? null : knowledgeJson(knowledge),
          ...(starred === undefined ? {} : { starred }),
          ...(questions === undefined ? {} : { questions }),
          ...(workflow === undefined ? {} : { workflow }),
          access: 'owner' as const,
          owner: access?.owner ?? null,
          ...(plan === undefined ? {} : { plan }),
          queued,
        };
      },
    );

    // p6-chat-notify: the caller's own watches only (another user's watch is a 404).
    const watchErr = (err: unknown): never => {
      if (err instanceof WatchError) {
        throw err.code === 'not_found'
          ? new HttpError(404, 'watch_not_found', err.message)
          : new HttpError(409, 'watch_not_active', err.message);
      }
      throw err;
    };
    r.get(
      '/chat/watches',
      {
        ...use,
        schema: {
          tags,
          summary: 'The caller’s chat watches (“let me know when …”), optionally of one conversation',
          security: session,
          querystring: z.object({
            threadId: z.uuid().optional(),
            includeEnded: z.enum(['true', 'false']).optional(),
          }),
          response: { 200: z.object({ items: z.array(WatchBody) }), ...errors },
        },
      },
      async (request) => {
        const userId = userOf(request);
        if (request.query.threadId !== undefined) await deps.store.thread(userId, request.query.threadId);
        const items =
          deps.watches === undefined
            ? []
            : await deps.watches.list(userId, {
                ...(request.query.threadId === undefined
                  ? { threadTitles: true }
                  : { threadId: request.query.threadId }),
                includeEnded: request.query.includeEnded === 'true',
              });
        return { items: items.map((w) => ({ ...w, conditions: [...w.conditions] })) };
      },
    );

    r.delete(
      '/chat/watches/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Stop one of the caller’s chat watches',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: WatchBody, ...errors },
        },
      },
      async (request) => {
        if (deps.watches === undefined) throw new HttpError(404, 'watch_not_found', 'Watch not found.');
        const w = await deps.watches.cancel(userOf(request), request.params.id).catch(watchErr);
        if (w.threadId !== null) deps.streams.publish(w.threadId, 'watch', {});
        return { ...w, conditions: [...w.conditions] };
      },
    );

    r.patch(
      '/chat/threads/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Rename, archive or restore one of the caller’s conversations',
          security: csrf,
          params: ThreadParams,
          body: z
            .object({ title: z.string().min(1).max(200).optional(), archived: z.boolean().optional() })
            .refine((b) => b.title !== undefined || b.archived !== undefined, 'nothing to change'),
          response: { 200: ThreadBody, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        const thread = await deps.store.updateThread(userOf(request), request.params.id, {
          ...(b.title === undefined ? {} : { title: b.title }),
          ...(b.archived === undefined ? {} : { archived: b.archived }),
        });
        deps.streams.publish(thread.id, 'thread', thread);
        return thread;
      },
    );

    r.delete(
      '/chat/threads/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Delete one of the caller’s conversations with its messages and drafts',
          security: csrf,
          params: ThreadParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const userId = userOf(request);
        const id = request.params.id;
        if (deps.service.snapshot(id).turn !== null) {
          await deps.service.cancel(userId, id).catch(() => undefined);
        }
        await deps.store.deleteThread(userId, id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/chat/threads/:id/messages',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Send a message; the assistant answers on the thread stream (409 when chat is off or the assistant worker is unavailable)',
          security: csrf,
          params: ThreadParams,
          body: z.object({
            text: z.string().trim().max(MAX_ASSISTANT_MESSAGE),
            /** p8-chat-attachments-mentions: unsent uploads of this thread, and `@` mentions. */
            attachments: z.array(z.uuid()).max(MAX_CHAT_ATTACHMENTS).optional(),
            mentions: MentionRefs.optional(),
            /** p15-chat-zip: ready site uploads of the sender (a .zip the console unpacked and uploaded). */
            siteUploads: z.array(z.uuid()).max(MAX_CHAT_ZIPS).optional(),
            /** p15-chat-zip: .zip files the console read that are not a publishable site (a note only). */
            archives: z.array(ChatArchiveNote).max(MAX_CHAT_ZIPS).optional(),
            /** p16-zip-job-input: ready job input bundles of the sender (a .zip the console unpacked for a job). */
            inputUploads: z.array(z.uuid()).max(MAX_CHAT_ZIPS).optional(),
            /**
             * p16-workflow-quality: the sender's IANA time zone (the browser's) — the default zone of schedules the
             * assistant drafts in this turn. Unknown zones are ignored.
             */
            timeZone: z.string().min(1).max(64).optional(),
            /** p17-chat-flow: "Sohbette düzenle" — the open workflow card of this conversation the message changes. */
            editDraft: z.uuid().optional(),
            /** p18-plan-mode: `/plan …` / the Planla chip — plan mode is turned on with this message (409 on an older assistant machine). */
            mode: z.enum(['plan']).optional(),
            /**
             * p22-chat-queue: while the assistant is still answering, the message waits and is delivered with the next
             * turn (the answer then carries `queued` instead of `message` / `turnId`). Absent: 409 `turn_in_progress`.
             */
            queue: z.boolean().optional(),
          }),
          response: {
            202: z.object({
              message: MessageBody.optional(),
              turnId: z.string().optional(),
              dropped: z.array(DroppedBody),
              queued: QueuedBody.optional(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const b = request.body;
        const send =
          b.queue === true ? deps.service.post.bind(deps.service) : deps.service.send.bind(deps.service);
        return reply.code(202).send(
          await send(actorOf(request), request.params.id, b.text, {
            ...(b.attachments === undefined ? {} : { attachments: b.attachments }),
            ...(b.mentions === undefined ? {} : { mentions: b.mentions }),
            ...(b.siteUploads === undefined ? {} : { siteUploads: b.siteUploads }),
            ...(b.archives === undefined ? {} : { archives: b.archives }),
            ...(b.inputUploads === undefined ? {} : { inputUploads: b.inputUploads }),
            ...(b.timeZone === undefined ? {} : { timeZone: b.timeZone }),
            ...(b.editDraft === undefined ? {} : { editDraft: b.editDraft }),
            ...(b.mode === undefined ? {} : { mode: b.mode }),
            // p15-autonomy: the sender's step-up, for direct actions in this turn.
            stepUp: realStepUpFields(request),
            // p15-chat-execute-default: a person wrote it — its drafts run at once unless proposed.
            byUser: true,
          }),
        );
      },
    );

    // ------------------------------------------------------------- p8-chat-attachments-mentions

    const attachments = (): ChatAttachments => {
      if (deps.attachments === undefined) {
        throw new HttpError(
          404,
          'attachment_not_found',
          'Attachments are not available.',
          {},
          {},
          { reason: 'unavailable' },
        );
      }
      return deps.attachments;
    };
    const AttachmentParams = z.object({ id: z.uuid() });

    r.post(
      '/chat/threads/:id/attachments',
      {
        ...use,
        bodyLimit: CHAT_ATTACHMENT_BODY_LIMIT,
        schema: {
          tags,
          summary:
            'Upload an image (png, jpeg, webp, gif), PDF or small text file to one of the caller’s conversations; metadata (EXIF/GPS, XMP, comments) is removed and secrets are redacted or refused before it is stored',
          security: csrf,
          params: ThreadParams,
          body: z.object({
            name: z.string().min(1).max(255),
            contentBase64: z.string().min(1).max(CHAT_ATTACHMENT_BODY_LIMIT),
          }),
          response: { 201: AttachmentBody, 413: ErrorBody, 422: ErrorBody, ...errors },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await attachments().upload(userOf(request), request.params.id, request.body)),
    );

    r.get(
      '/chat/attachments/:id/content',
      {
        ...use,
        schema: {
          tags,
          summary:
            'The bytes of an attachment of one of the caller’s conversations (images inline, other files as a download)',
          security: session,
          params: AttachmentParams,
        },
      },
      async (request, reply) => {
        const f = await attachments().content(userOf(request), request.params.id);
        const inline = f.kind === 'image';
        const type = f.mediaType.startsWith('text/') ? `${f.mediaType}; charset=utf-8` : f.mediaType;
        return reply
          .header('content-type', type)
          .header('content-disposition', disposition(inline ? 'inline' : 'attachment', f.name))
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('x-content-type-options', 'nosniff')
          .header('cross-origin-resource-policy', 'same-origin')
          .header('cache-control', 'private, max-age=300')
          .send(f.content);
      },
    );

    r.delete(
      '/chat/attachments/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Remove an attachment that was not sent yet',
          security: csrf,
          params: AttachmentParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await attachments().remove(userOf(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/chat/mentions',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Search what the caller may mention with @: visible projects, own conversations, outputs, jobs, machines and own folders',
          security: session,
          querystring: z.object({
            q: z.string().max(100).optional(),
            type: z.enum(MENTION_TYPES).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  type: z.enum(MENTION_TYPES),
                  id: z.string(),
                  project: z.string().nullable(),
                  label: z.string(),
                  detail: z.string().nullable(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        if (deps.mentions === undefined) return { items: [] };
        if (deps.limiter !== undefined) {
          const hit = await deps.limiter.hit('chat-mentions', userOf(request), 240, 60_000);
          if (!hit.allowed) {
            throw new HttpError(
              429,
              'rate_limited',
              'Too many searches; slow down.',
              {
                'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
              },
              {},
              { reason: 'searches' },
            );
          }
        }
        return {
          items: await deps.mentions.search(
            authzOf(request).subject,
            request.query.q ?? '',
            request.query.type,
          ),
        };
      },
    );

    // p16-chat-complete: edit / regenerate / retry, export, sharing and handing over.
    chatCompleteRoutes({
      service: deps.service,
      store: deps.store,
      ...(deps.shares === undefined ? {} : { shares: deps.shares }),
    })(app);

    // p22-chat-queue: a waiting message is changed or removed until it is delivered (409 `message_not_queued` after that).
    const QueuedParams = z.object({ id: z.uuid(), queuedId: z.uuid() });
    r.patch(
      '/chat/threads/:id/queued/:queuedId',
      {
        ...use,
        schema: {
          tags,
          summary: 'Change the text of a message that waits for the assistant’s current answer to end',
          security: csrf,
          params: QueuedParams,
          body: z.object({ text: z.string().trim().max(MAX_ASSISTANT_MESSAGE) }),
          response: { 200: QueuedBody, ...errors },
        },
      },
      async (request) =>
        deps.service.editQueued(
          userOf(request),
          request.params.id,
          request.params.queuedId,
          request.body.text,
        ),
    );

    r.delete(
      '/chat/threads/:id/queued/:queuedId',
      {
        ...use,
        schema: {
          tags,
          summary: 'Remove a message that waits for the assistant’s current answer to end (it is never sent)',
          security: csrf,
          params: QueuedParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await deps.service.removeQueued(userOf(request), request.params.id, request.params.queuedId);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/chat/threads/:id/cancel',
      {
        ...use,
        schema: {
          tags,
          summary: 'Stop the assistant’s current answer in this conversation',
          security: csrf,
          params: ThreadParams,
          response: { 202: z.object({ ok: z.boolean() }), ...errors },
        },
      },
      async (request, reply) => {
        await deps.service.cancel(userOf(request), request.params.id);
        return reply.code(202).send({ ok: true });
      },
    );

    // oss-sec3: the caller's remembered choices for cards held because a turn read untrusted content.
    const untrustedAllowsOf = (): UntrustedAllows => {
      const svc = deps.untrustedAllows?.() ?? null;
      if (svc === null)
        throw new HttpError(
          503,
          'unavailable',
          'Remembered confirmations are not available.',
          {},
          {},
          { reason: 'untrusted_allows' },
        );
      return svc;
    };
    r.get(
      '/chat/untrusted-allows',
      {
        ...use,
        schema: {
          tags,
          summary:
            'My remembered confirmations: kinds of assistant actions on a target that run without a card even in a turn that read untrusted content (a job log, a file, a web response)',
          security: session,
          response: {
            200: z.object({
              allows: z.array(
                z.object({
                  id: z.string(),
                  action: z.string(),
                  target: z.string(),
                  label: z.string(),
                  threadId: z.string().nullable(),
                  createdAt: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const rows = await untrustedAllowsOf().list(userOf(request));
        return { allows: rows.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })) };
      },
    );
    r.delete(
      '/chat/untrusted-allows/:id',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Forget one of my remembered confirmations: that kind of action asks again in a turn that read untrusted content (audited)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ revoked: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        const revoked = await untrustedAllowsOf().revoke(
          { userId: actor.userId, ip: actor.ip, userAgent: actor.userAgent },
          request.params.id,
        );
        if (!revoked)
          throw new HttpError(
            404,
            'not_found',
            'Remembered confirmation not found.',
            {},
            {},
            { reason: 'untrusted_allow' },
          );
        return { revoked };
      },
    );

    // p20-scope-preview: the goal-bound grants of a conversation ("Hedefe bağlı yetki") — read and revoke.
    const goalGrantsOf = (): GoalGrants => {
      const svc = deps.goalGrants?.() ?? null;
      if (svc === null)
        throw new HttpError(
          503,
          'unavailable',
          'Goal-bound permissions are not available.',
          {},
          {},
          { reason: 'goal_grants' },
        );
      return svc;
    };
    r.get(
      '/chat/threads/:id/goal-grants',
      {
        ...use,
        schema: {
          tags,
          summary:
            'The live goal-bound permissions of one of my conversations: what my own messages ran directly, which its plan / watch continuations inherit until they expire',
          security: session,
          params: ThreadParams,
          response: {
            200: z.object({
              grants: z.array(
                z.object({
                  id: z.string(),
                  scope: z.string(),
                  project: z.string().nullable(),
                  workerId: z.string().nullable(),
                  machineAdmin: z.boolean(),
                  createdAt: z.string(),
                  expiresAt: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const userId = userOf(request);
        await deps.store.thread(userId, request.params.id);
        const rows = await goalGrantsOf().live(userId, request.params.id);
        return {
          grants: rows.map((g) => ({
            id: g.id,
            scope: g.cls,
            project: g.project,
            workerId: g.workerId,
            machineAdmin: g.machineAdmin,
            createdAt: g.createdAt.toISOString(),
            expiresAt: g.expiresAt.toISOString(),
          })),
        };
      },
    );
    r.delete(
      '/chat/threads/:id/goal-grants',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Revoke the goal-bound permissions of one of my conversations: its continuations no longer inherit what my messages allowed (audited)',
          security: csrf,
          params: ThreadParams,
          response: { 200: z.object({ revoked: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        await deps.store.thread(actor.userId, request.params.id);
        const revoked = await goalGrantsOf().revoke(
          { userId: actor.userId, ip: actor.ip, userAgent: actor.userAgent },
          request.params.id,
        );
        return { revoked };
      },
    );

    r.get(
      '/chat/threads/:id/stream',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Live view of a conversation (text/event-stream): ready, turn, delta, tool, draft, message, done, error',
          security: session,
          params: ThreadParams,
          response: errors,
        },
      },
      async (request, reply) => {
        const userId = userOf(request);
        // p16-chat-complete: shared readers follow the conversation live too (rows only as a signal).
        const access = deps.shares === undefined ? null : await deps.shares.access(userId, request.params.id);
        const thread = access?.thread ?? (await deps.store.thread(userId, request.params.id));
        await deps.streams.serve(reply, {
          reader: access?.role === 'reader',
          threadId: thread.id,
          userId,
          snapshot: () => deps.service.snapshot(thread.id),
        });
      },
    );

    r.post(
      '/chat/drafts/:id/confirm',
      {
        ...use,
        // p15-autonomy (ADR-0056): no route-level step-up — the card's event decides (DraftExecutor.confirm).
        schema: {
          tags,
          summary:
            'Confirm a draft card: runs the proposed job / workflow run / configuration change / approval decision / job message through the normal service path (step-up; the target action is re-checked). Optional JSON body {approvalPolicy} changes the approval mode of a job or machine-task draft (p6-approval-mode-switch).',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ draft: DraftBody, result: Json }), ...errors },
        },
      },
      async (request) => {
        const { subject, role } = authzOf(request);
        // p6-approval-mode-switch: an optional `{approvalPolicy}` body changes the mode of a job / machine-task draft
        // (no body schema: older clients send none, or `{}`).
        const parsed = ConfirmBody.safeParse(request.body ?? {});
        if (!parsed.success)
          throw new HttpError(
            400,
            'invalid_request',
            'Invalid approvalPolicy, priorityClass or jobIds.',
            {},
            {},
            { reason: 'job_actions' },
          );
        const override = parsed.data.approvalPolicy;
        const priorityClass = parsed.data.priorityClass;
        const jobIds = parsed.data.jobIds;
        const enableMcpProject = parsed.data.enableMcpProject;
        // oss-sec3: what to remember is decided from the stored card BEFORE it runs (its owner, the hold, the key).
        const remember =
          parsed.data.remember === true
            ? await deps.store.draft(subject.userId, request.params.id).catch(() => null)
            : null;
        const out = await deps.drafts.confirm(
          {
            subject,
            human: { id: subject.userId, role, ...stepUpFields(request) },
            actor: actorOf(request),
          },
          request.params.id,
          {
            ...(override === undefined ? {} : { approvalPolicy: override }),
            ...(priorityClass === undefined ? {} : { priorityClass }),
            ...(jobIds === undefined ? {} : { jobIds }),
            ...(enableMcpProject === undefined ? {} : { enableMcpProject }),
          },
        );
        deps.streams.publish(out.draft.threadId, 'draft', out.draft);
        // oss-sec3: the person ticked "remember" on a card held for untrusted content (never-remember kinds refused).
        const allows = deps.untrustedAllows?.() ?? null;
        if (remember !== null && remember.held !== undefined && allows !== null) {
          const actor = actorOf(request);
          await allows
            .remember({ userId: subject.userId, ip: actor.ip, userAgent: actor.userAgent }, remember)
            .catch(() => null);
        }
        // The thread note (seen by the assistant) carries the stored result only, never `reveal` (a secret).
        await deps.service
          .noteConfirmed(
            out.draft.threadId,
            `The user confirmed draft “${out.draft.title}”: ${JSON.stringify(out.result).slice(0, 300)}`,
          )
          .catch(() => undefined);
        return {
          draft: out.draft,
          result: out.reveal === null ? out.result : { ...out.result, ...out.reveal },
        };
      },
    );

    r.patch(
      '/chat/drafts/:id',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p12-diyalog-f3: edit an open job draft on its card (title, project, runtime, prompt, class, approval mode, sandbox, machines, deploy / verify when done, input files). The card is rebuilt by the assistant’s own draft_job checks for the caller and replaces the earlier version; nothing runs until it is confirmed (step-up there).',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: DraftEditBody,
          response: { 200: DraftBody, ...errors },
        },
      },
      async (request) => {
        const { subject } = authzOf(request);
        return deps.service.editDraft(subject, actorOf(request), request.params.id, request.body);
      },
    );

    r.post(
      '/chat/threads/:id/job-actions',
      {
        ...use,
        schema: {
          tags,
          summary:
            'p10-chat-job-actions: a quick button on a job card (Cancel, Run again) drafts a job action card in this conversation for the caller — nothing runs until it is confirmed like any card (step-up, per-job re-checks).',
          security: csrf,
          params: ThreadParams,
          body: z.strictObject({
            action: z.enum(['cancel', 'run_again']),
            jobIds: z.array(z.uuid()).min(1).max(MAX_JOB_ACTION_JOBS),
            reason: z.string().min(1).max(1000).optional(),
          }),
          response: { 200: DraftBody, ...errors },
        },
      },
      async (request) => {
        if (deps.jobActions === undefined)
          throw new HttpError(404, 'not_found', 'Not available.', {}, {}, { reason: 'unavailable' });
        const { subject } = authzOf(request);
        const thread = await deps.store.thread(subject.userId, request.params.id);
        const out = await deps.jobActions.propose(
          { userId: subject.userId, subject, threadId: thread.id, turnId: null },
          request.body,
        );
        if (!out.ok) {
          const status =
            out.code === 'not_found'
              ? 404
              : out.code === 'forbidden'
                ? 403
                : out.code === 'unavailable'
                  ? 503
                  : 409;
          throw new HttpError(status, out.code === 'invalid' ? 'not_applicable' : out.code, out.message);
        }
        if (out.draft === undefined) throw new Error('job action proposal returned no draft');
        const draft = draftView(out.draft);
        deps.streams.publish(thread.id, 'draft', draft);
        return draft;
      },
    );

    r.post(
      '/chat/drafts/:id/dismiss',
      {
        ...use,
        schema: {
          tags,
          summary: 'Dismiss a draft card (nothing runs)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: DraftBody, ...errors },
        },
      },
      async (request) => {
        const draft = await deps.drafts.dismiss(userOf(request), request.params.id);
        deps.streams.publish(draft.threadId, 'draft', draft);
        return draft;
      },
    );

    r.post(
      '/chat/drafts/:id/credential-saved',
      {
        // The vault write itself (POST /vault/credentials) is admin + always-fresh step-up; this only links the card.
        config: { authz: { action: 'vault.write' as const } },
        schema: {
          tags,
          summary:
            'p15-chat-vault: the browser sealed a pasted value and created this vault credential for an open “save to vault” card — the card is done (no value, ciphertext or token in the request)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({ credentialId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/) }),
          response: { 200: z.object({ draft: DraftBody, result: Json }), ...errors },
        },
      },
      async (request) => {
        const svc = deps.credentials?.() ?? null;
        if (svc === null) throw new HttpError(404, 'draft_not_found', 'Draft not found.');
        const actor = actorOf(request);
        const out = await svc.markSaved(actor, request.params.id, request.body.credentialId);
        const view = draftView(out.draft);
        deps.streams.publish(view.threadId, 'draft', view);
        await deps.service
          .noteConfirmed(
            view.threadId,
            `The user saved the vault credential {{credential:${out.credential.name}}} (${out.credential.kind}${
              out.credential.allowedHosts === null ? '' : `, hosts ${out.credential.allowedHosts.join(', ')}`
            }) in their browser. Refer to it as @${out.credential.name}.`,
          )
          .catch(() => undefined);
        return { draft: view, result: out.draft.result ?? {} };
      },
    );

    r.get(
      '/chat/usage',
      {
        ...use,
        schema: {
          tags,
          summary:
            'The Chat budget line: the caller’s token/cost use today and this month (admins: everyone’s)',
          security: session,
          response: {
            200: z.object({
              limits: ChatLimits,
              me: z.object({ today: UsageCounts, month: UsageCounts }),
              all: z.object({ today: UsageCounts, month: UsageCounts }).nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => deps.service.usage(authzOf(request).subject),
    );

    r.get(
      '/chat/settings',
      {
        ...admin,
        schema: {
          tags,
          summary: 'Settings → Chat: kill switch, assistant worker, runtime, model profile, limits (admin)',
          security: session,
          response: { 200: SettingsBody, ...errors },
        },
      },
      async () => settingsJson(await deps.settings.get(), await deps.settings.engines()),
    );

    r.put(
      '/chat/settings',
      {
        ...admin,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change the chat settings (admin, step-up; optimistic on the version). Turning chat off stops running answers.',
          security: csrf,
          body: ChatSettingsInput,
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const updated = await deps.settings.put(request.body, actorOf(request));
        if (!updated.enabled) await deps.service.cancelAll('chat disabled');
        return settingsJson(updated, await deps.settings.engines());
      },
    );

    // ------------------------------------------------------------------- p15-chat-failover

    r.get(
      '/chat/failover',
      {
        ...admin,
        schema: {
          tags,
          summary:
            'Chat failover state (admin): which machine answers and why, each chain machine’s verdict, pin / automatic failover, recent switches',
          security: session,
          response: { 200: FailoverBody, ...errors },
        },
      },
      async () => deps.service.failoverView(),
    );

    r.post(
      '/chat/failover/primary',
      {
        ...admin,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Force the chat back to the primary machine now (admin, step-up; clears the pin; 409 when the primary cannot answer)',
          security: csrf,
          response: { 200: FailoverBody, ...errors },
        },
      },
      async (request) => deps.service.forcePrimary(actorOf(request)),
    );

    r.put(
      '/chat/failover/pin',
      {
        ...admin,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Pin a chain machine as the chat assistant for 15 minutes … 7 days (admin, step-up, audited)',
          security: csrf,
          body: PinInput,
          response: { 200: FailoverBody, ...errors },
        },
      },
      async (request) => deps.service.pin(request.body, actorOf(request)),
    );

    r.delete(
      '/chat/failover/pin',
      {
        ...admin,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove the pin (admin, step-up, audited)',
          security: csrf,
          response: { 200: FailoverBody, ...errors },
        },
      },
      async (request) => deps.service.unpin(actorOf(request)),
    );

    r.put(
      '/chat/failover/auto',
      {
        ...admin,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Turn automatic failover to the backup machines on or off (admin, step-up, audited)',
          security: csrf,
          body: AutoInput,
          response: { 200: FailoverBody, ...errors },
        },
      },
      async (request) => deps.service.setAutoFailover(request.body.enabled, actorOf(request)),
    );

    // ------------------------------------------------------------------- p10-semantic-defaults-chat

    const knowledge = (): ChatKnowledge => {
      if (deps.knowledge === undefined) {
        throw new HttpError(404, 'not_available', 'Chat knowledge is not available on this master.');
      }
      return deps.knowledge;
    };
    const requestMeta = (request: FastifyRequest) => ({
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    r.get(
      '/chat/search',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Search my conversations by meaning (keyword fallback): the caller’s own threads only — never another user’s, whatever the role',
          security: session,
          querystring: z.object({
            q: z.string().min(1).max(500),
            limit: z.coerce.number().int().min(1).max(50).optional(),
          }),
          response: {
            200: z.object({
              mode: z.enum(['semantic', 'keyword']),
              fallbackReason: z
                .enum(['unavailable', 'opted_out', 'query_rejected', 'provider_error', 'rate_limited'])
                .nullable(),
              items: z.array(OwnHitBody),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const found = await knowledge().findOwn(userOf(request), request.query.q, {
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        return { mode: found.mode, fallbackReason: found.fallbackReason, items: [...found.items] };
      },
    );

    // p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.4): the command palette's "search with AI".
    r.get(
      '/chat/search/everywhere',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Search by meaning (keyword fallback) across what the caller may read: own conversations and the knowledge of up to 8 visible projects (documents incl. memory, job summaries, shared project chat). One query vector; the per-user search limits apply',
          security: session,
          querystring: z.object({
            q: z.string().min(1).max(500),
            limit: z.coerce.number().int().min(1).max(30).optional(),
          }),
          response: {
            200: z.object({
              mode: z.enum(['semantic', 'keyword']),
              fallbackReason: z
                .enum(['unavailable', 'opted_out', 'query_rejected', 'provider_error', 'rate_limited'])
                .nullable(),
              projects: z.number().int(),
              items: z.array(
                z.object({
                  kind: z.enum(['own_chat', 'project_chat', 'context_doc', 'job_summary']),
                  id: z.string(),
                  project: z.string().nullable(),
                  title: z.string(),
                  snippet: z.string(),
                  at: z.string().nullable(),
                  link: z.string().nullable(),
                  score: z.number(),
                  match: z.enum(['semantic', 'keyword']),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        if (deps.limiter !== undefined) {
          const hit = await deps.limiter.hit('chat-search-everywhere', userOf(request), 60, 60_000);
          if (!hit.allowed) {
            throw new HttpError(
              429,
              'rate_limited',
              'Too many searches; slow down.',
              {
                'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
              },
              {},
              { reason: 'searches' },
            );
          }
        }
        const found = await knowledge().everywhere(authzOf(request).subject, request.query.q, {
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        return {
          mode: found.mode,
          fallbackReason: found.fallbackReason,
          projects: found.projects,
          items: found.items.map((i) => ({
            kind: i.kind,
            id: i.id,
            project: i.project,
            title: i.title,
            snippet: i.snippet,
            at: i.at,
            link: i.link,
            score: i.score,
            match: i.match,
          })),
        };
      },
    );

    r.get(
      '/chat/knowledge/preferences',
      {
        ...use,
        schema: {
          tags,
          summary:
            'My chat knowledge settings: index my conversations, share project-related chat with project knowledge, related knowledge on every message',
          security: session,
          response: { 200: PrefsBody, ...errors },
        },
      },
      async (request) => prefsJson(await knowledge().prefs(userOf(request))),
    );

    r.put(
      '/chat/knowledge/preferences',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Change my chat knowledge settings (audited; turning indexing off deletes all my chat vectors, turning sharing off deletes my project-shared ones)',
          security: csrf,
          body: z.object({
            indexConversations: z.boolean(),
            shareProjects: z.boolean(),
            autoRelated: z.boolean(),
            expectedVersion: z.number().int().min(0),
          }),
          response: { 200: PrefsBody, ...errors },
        },
      },
      async (request) =>
        prefsJson(await knowledge().setPrefs(userOf(request), request.body, requestMeta(request))),
    );

    r.put(
      '/chat/threads/:id/knowledge',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Link one of my conversations to a project (one I can read) or unlink it, and switch “Share with project knowledge” for it (audited)',
          security: csrf,
          params: ThreadParams,
          body: z
            .object({
              project: z
                .string()
                .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
                .nullable()
                .optional(),
              share: z.boolean().optional(),
            })
            .refine((b) => b.project !== undefined || b.share !== undefined, 'nothing to change'),
          response: { 200: KnowledgeBody, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        const k = await knowledge().setThreadKnowledge(
          authzOf(request).subject,
          request.params.id,
          {
            ...(b.project === undefined ? {} : { project: b.project }),
            ...(b.share === undefined ? {} : { share: b.share }),
          },
          requestMeta(request),
        );
        deps.streams.publish(
          request.params.id,
          'thread',
          await deps.store.thread(userOf(request), request.params.id),
        );
        return knowledgeJson(k);
      },
    );

    // p18-multi-project W3: the conversation's working projects ("Çalışma projeleri").
    r.get(
      '/chat/threads/:id/projects',
      {
        ...use,
        schema: {
          tags,
          summary:
            "The working projects of one of my conversations (primary first; name, kind, my role, each one's sharing switch)",
          security: session,
          params: ThreadParams,
          response: { 200: z.object({ projects: z.array(ThreadProjectBody) }), ...errors },
        },
      },
      async (request) => {
        const svc = deps.threadProjects?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Working projects are not available.',
            {},
            {},
            { reason: 'thread_projects' },
          );
        const view = await svc.view(authzOf(request).subject, request.params.id);
        return { projects: view.map((v) => ({ ...v })) };
      },
    );
    r.put(
      '/chat/threads/:id/projects',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Set the working projects of one of my conversations: the whole set, the first is the primary (at most 8, projects I can read), each with “Share with project knowledge” (audited)',
          security: csrf,
          params: ThreadParams,
          body: z.object({
            projects: z
              .array(
                z.object({
                  project: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
                  share: z.boolean().optional(),
                }),
              )
              .max(MAX_THREAD_PROJECTS),
          }),
          response: { 200: z.object({ projects: z.array(ThreadProjectBody) }), ...errors },
        },
      },
      async (request) => {
        const svc = deps.threadProjects?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Working projects are not available.',
            {},
            {},
            { reason: 'thread_projects' },
          );
        const view = await svc.set(authzOf(request).subject, request.params.id, request.body.projects, {
          ...requestMeta(request),
          source: 'console',
        });
        deps.streams.publish(
          request.params.id,
          'thread',
          await deps.store.thread(userOf(request), request.params.id),
        );
        return { projects: view.map((v) => ({ ...v })) };
      },
    );

    // ------------------------------------------------------------------- talk to a running job

    const jobNotFound = () => new HttpError(404, 'job_not_found', 'Job not found.');

    r.get(
      '/jobs/:id/messages/status',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags: ['jobs'],
          summary:
            'Whether the agent of this job can take a message now (live) or once it runs (queue) (viewer+)',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              supported: z.boolean(),
              reason: z.string().nullable(),
              mode: z.enum(['live', 'queue']).nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => deps.jobMessages.status(request.params.id),
    );

    // p15-message-delivery: the job's messages with their delivery state (viewer+, like the job's events).
    r.get(
      '/jobs/:id/messages',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags: ['jobs'],
          summary: 'Messages sent to the agent of this job and how far each got (viewer+)',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              messages: z.array(
                z.object({
                  id: z.string(),
                  text: z.string(),
                  source: z.enum(['panel', 'chat']),
                  sentBy: z.string(),
                  sentByName: z.string().nullable(),
                  status: z.enum(JOB_MESSAGE_STATUSES),
                  code: z.string().nullable(),
                  detail: z.string().nullable(),
                  receipts: z.boolean(),
                  createdAt: z.string(),
                  updatedAt: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({ messages: await deps.jobMessages.list(request.params.id) }),
    );

    r.post(
      '/jobs/:id/messages',
      {
        config: {
          authz: {
            action: 'jobs.message',
            resource: jobResource(deps.db),
            notFound: jobNotFound,
            auditDenied: { action: 'job.message', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Send a message to the agent of a job: now while it runs, else held until it runs (operator+; audited)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          // p15-message-delivery: `clientId` makes a retried POST the same message (no duplicate to the agent).
          body: z.object({ text: z.string().trim().min(1).max(8192), clientId: z.uuid().optional() }),
          response: {
            202: z.object({ messageId: z.string(), status: z.enum(JOB_MESSAGE_STATUSES) }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        reply.code(202).send(
          await deps.jobMessages.send(request.params.id, request.body.text, actorOf(request), {
            source: 'panel',
            ...(request.body.clientId === undefined ? {} : { clientId: request.body.clientId }),
          }),
        ),
    );
  };
}
