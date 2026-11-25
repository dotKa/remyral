import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import type { Resource } from '../authz/model.js';
import { bodyField, param, projectQuery } from '../authz/resources.js';
import { contextActorOf, contextRequestMeta, handledContext } from '../context/routes.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { RecordBody, recordJson } from '../memory-records/routes.js';
import type { AutoLearnRunStats } from './autolearn-service.js';
import {
  MAX_BACKFILL_DAYS,
  MAX_BULK,
  type MemorySuggestionService,
  type SuggestionSettings,
  type SuggestionView,
} from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
  findings: z.array(z.record(z.string(), z.unknown())).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Project = z.string().regex(PROJECT);
const Mode = z.enum(['off', 'rules', 'assisted']);
const State = z.enum(['pending', 'accepted', 'dismissed', 'merged']);
const AutoLearn = z.enum(['off', 'safe', 'all']);
const Counts = z.object({
  merged: z.number().int(),
  known: z.number().int(),
  accepted: z.number().int(),
  expiring: z.number().int(),
  human: z.number().int(),
});
const AutoLearnRunBody = z.object({
  dryRun: z.boolean(),
  policyVersion: z.number().int(),
  totals: Counts,
  projects: z.array(
    z.object({
      project: z.string(),
      mode: AutoLearn,
      semantic: z.boolean(),
      pending: z.number().int(),
      byType: z.object({ rule: Counts, fact: Counts, decision: Counts, lesson: Counts }),
      totals: Counts,
      humanReasons: z.record(z.string(), z.number().int()),
    }),
  ),
});

const SettingsBody = z.object({
  project: z.string(),
  mode: Mode,
  version: z.number().int(),
  enabledAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  /** p10-semantic-defaults-chat: where the mode came from (null: never set). */
  origin: z.enum(['explicit', 'create', 'platform_default']).nullable(),
  semanticDedupe: z.boolean(),
  pending: z.number().int(),
  /** p17-auto-learning: "Otomatik öğrenme" — off / safe / all. */
  autoLearn: AutoLearn,
  /** False: MEMORY_AUTO_LEARN=off on this master (the setting is kept but nothing is accepted automatically). */
  autoLearnAvailable: z.boolean(),
  autoLearnUpdatedAt: z.string().nullable(),
  /** Accepted by the system and not undone. */
  autoLearned: z.number().int(),
  /** Pending suggestions the policy left for a person. */
  needsHuman: z.number().int(),
});
const SuggestionBody = z.object({
  id: z.string(),
  project: z.string(),
  state: State,
  source: z.enum(['job', 'agent_summary', 'chat', 'agent']),
  jobId: z.string().nullable(),
  threadId: z.string().nullable(),
  rule: z.string(),
  title: z.string(),
  content: z.string(),
  /**
   * p10-chat-memory-suggestions: where a chat-origin suggestion came from ("from a conversation of <ownerName>, <at>")
   * and a short redacted snippet of the message while it is still shared; null for job suggestions.
   */
  chat: z
    .object({
      origin: z.enum(['pass', 'assistant']),
      ownerName: z.string().nullable(),
      author: z.enum(['user', 'assistant']).nullable(),
      seq: z.number().int().nullable(),
      at: z.string(),
      snippet: z.string().nullable(),
    })
    .nullable(),
  similar: z
    .object({
      documentId: z.string(),
      title: z.string().nullable(),
      score: z.number(),
      method: z.enum(['semantic', 'lexical']),
    })
    .nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  acceptedDocumentId: z.string().nullable(),
  /** p11-memory-layers: rule / fact / decision / lesson (null: fact). */
  recordType: z.enum(['rule', 'fact', 'decision', 'lesson']).nullable(),
  runtime: z.string().nullable(),
  /** p11-memory-layers: "this may replace X". */
  replaces: z
    .object({
      documentId: z.string(),
      title: z.string().nullable(),
      reason: z.enum(['similar', 'negation', 'different_choice', 'different_value']),
    })
    .nullable(),
  /** p17-auto-learning: the policy's verdict (null: never evaluated). */
  auto: z
    .object({
      outcome: z.enum(['accepted', 'expiring', 'human', 'merged']),
      reasons: z.array(z.string()),
      policyVersion: z.number().int(),
      at: z.string(),
    })
    .nullable(),
  autoAccepted: z.boolean(),
  undoneAt: z.string().nullable(),
  recordStatus: z.string().nullable(),
  recordExpiresAt: z.string().nullable(),
  mergedInto: z.string().nullable(),
  mergedIntoDocument: z.string().nullable(),
  mergedSources: z.array(
    z.object({
      suggestionId: z.string(),
      jobId: z.string().nullable(),
      threadId: z.string().nullable(),
      chatMessageId: z.string().nullable(),
      title: z.string(),
    }),
  ),
});
const PassBody = z.object({
  jobs: z.number().int(),
  /** p10-chat-memory-suggestions: shared chat messages read. */
  chatMessages: z.number().int(),
  proposed: z.number().int(),
  duplicates: z.number().int(),
  skippedSecrets: z.number().int(),
  /** Chat candidates over the per-thread daily cap. */
  rateLimited: z.number().int(),
});

function settingsJson(s: SuggestionSettings): z.infer<typeof SettingsBody> {
  return {
    ...s,
    enabledAt: s.enabledAt?.toISOString() ?? null,
    updatedAt: s.updatedAt?.toISOString() ?? null,
    autoLearnUpdatedAt: s.autoLearnUpdatedAt?.toISOString() ?? null,
  };
}

function runJson(r: AutoLearnRunStats): z.infer<typeof AutoLearnRunBody> {
  return { ...r, projects: r.projects.map((p) => ({ ...p })) };
}

function suggestionJson(s: SuggestionView): z.infer<typeof SuggestionBody> {
  return {
    ...s,
    chat: s.chat === null ? null : { ...s.chat, at: s.chat.at.toISOString() },
    createdAt: s.createdAt.toISOString(),
    decidedAt: s.decidedAt?.toISOString() ?? null,
    auto: s.auto === null ? null : { ...s.auto, reasons: [...s.auto.reasons], at: s.auto.at.toISOString() },
    undoneAt: s.undoneAt?.toISOString() ?? null,
    recordExpiresAt: s.recordExpiresAt?.toISOString() ?? null,
    mergedSources: [...s.mergedSources],
  };
}

/** The project named in the JSON body (`project`). */
function projectBody() {
  return (request: FastifyRequest): Resource | null | undefined => {
    const p = bodyField(request, 'project');
    if (p === undefined) return undefined;
    return PROJECT.test(p) ? { project: p } : null;
  };
}

/**
 * Memory suggestions API (docs/design/p10-semantic-memory.md §6). Reading the inbox is viewer+ in the project
 * (suggestions come from job summaries, which viewers read); deciding is operator+ (it writes context); the opt-in
 * and backfill are admin+ (the opt-in with a fresh step-up).
 */
export function memorySuggestionRoutes(service: MemorySuggestionService, db: Queryable, clock: () => Date) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'memory_suggestion_not_found', 'Memory suggestion not found.');
    const suggestionResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.projectOf(id);
      return project === null ? null : { project };
    };
    const jobQueryResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const q = request.query as Record<string, unknown> | null;
      const id = q !== null && typeof q === 'object' && typeof q.job === 'string' ? q.job : undefined;
      if (id === undefined || !UUID.test(id)) return null;
      const { rows } = await db.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [id]);
      const project = rows[0]?.project;
      return project === undefined ? null : { project };
    };
    const IdParams = z.object({ id: z.string().regex(UUID) });

    r.get(
      '/memory-suggestions',
      {
        config: { authz: { action: 'memory.suggestions.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: "A project's memory suggestions inbox (pending by default; viewer+)",
          security: session,
          querystring: z.object({
            project: Project,
            state: State.optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            offset: z.coerce.number().int().min(0).max(10_000).optional(),
            /** p17-auto-learning: `true` only what the system accepted, `false` only what people decided. */
            auto: z.enum(['true', 'false']).optional(),
          }),
          response: { 200: z.object({ items: z.array(SuggestionBody), total: z.number().int() }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const q = request.query;
          const out = await service.list(contextActorOf(request), q.project, {
            ...(q.state === undefined ? {} : { state: q.state }),
            ...(q.limit === undefined ? {} : { limit: q.limit }),
            ...(q.offset === undefined ? {} : { offset: q.offset }),
            ...(q.auto === undefined ? {} : { auto: q.auto === 'true' }),
          });
          return { items: out.items.map(suggestionJson), total: out.total };
        }),
    );

    r.get(
      '/memory-suggestions/settings',
      {
        config: { authz: { action: 'memory.suggestions.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Whether memory suggestions are on for a project (off / rules / assisted) and the pending count',
          security: session,
          querystring: z.object({ project: Project }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          settingsJson(await service.settings(contextActorOf(request), request.query.project)),
        ),
    );

    r.put(
      '/memory-suggestions/settings',
      {
        config: {
          authz: {
            action: 'memory.suggestions.admin',
            resource: projectBody(),
            auditDenied: { action: 'memory.suggestions.settings' },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary:
            'Opt a project in or out of memory suggestions (admin+, step-up, audited): rules = deterministic pass over finished jobs; assisted = rules + "Summarise with an agent"',
          security: csrf,
          body: z.object({ project: Project, mode: Mode, expectedVersion: z.number().int().min(0) }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          settingsJson(
            await service.setMode(contextActorOf(request), request.body, contextRequestMeta(request)),
          ),
        ),
    );

    r.put(
      '/memory-suggestions/auto-learn',
      {
        config: {
          authz: {
            action: 'memory.suggestions.admin',
            resource: projectBody(),
            auditDenied: { action: 'memory.suggestions.auto_learn' },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary:
            'p17-auto-learning: the project\'s "Otomatik öğrenme" — off / safe (facts and lessons that pass every check) / all (also those resembling a record); rules, decisions and anything that may replace a record always stay with a person (admin+, step-up, audited)',
          security: csrf,
          body: z.object({
            project: Project,
            autoLearn: AutoLearn,
            expectedVersion: z.number().int().min(0),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          settingsJson(
            await service.setAutoLearn(contextActorOf(request), request.body, contextRequestMeta(request)),
          ),
        ),
    );

    r.post(
      '/memory-suggestions/auto-learn/run',
      {
        config: {
          authz: {
            action: 'memory.suggestions.admin',
            resource: projectBody(),
            auditDenied: { action: 'memory.suggestions.autolearn_backfill' },
          },
        },
        schema: {
          tags,
          summary:
            "p17-auto-learning: run the policy over the project's pending suggestions — merge twins, accept what is safe, leave the rest for a person. `dryRun` only counts (admin+; the real run needs a fresh step-up; audited)",
          security: csrf,
          body: z.object({ project: Project, dryRun: z.boolean() }),
          response: { 200: AutoLearnRunBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          runJson(
            await service.autoLearnRun(
              contextActorOf(request),
              request.body.project,
              request.body.dryRun,
              contextRequestMeta(request),
            ),
          ),
        ),
    );

    r.post(
      '/memory-suggestions/:id/undo',
      {
        config: {
          authz: {
            action: 'memory.suggestions.decide',
            resource: suggestionResource,
            notFound,
            auditDenied: { action: 'memory.suggestion.undo' },
          },
        },
        schema: {
          tags,
          summary:
            'p17-auto-learning "Geri al": reject what the system learned by itself (the record becomes rejected, its history stays; operator+, audited)',
          security: csrf,
          params: IdParams,
          response: { 200: z.object({ suggestion: SuggestionBody }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          suggestion: suggestionJson(
            await service.undo(contextActorOf(request), request.params.id, contextRequestMeta(request)),
          ),
        })),
    );

    r.post(
      '/memory-suggestions/bulk',
      {
        config: {
          authz: {
            action: 'memory.suggestions.decide',
            resource: projectBody(),
            auditDenied: { action: 'memory.suggestion.bulk' },
          },
        },
        schema: {
          tags,
          summary: `p17-auto-learning bulk review: accept, decline or merge up to ${String(MAX_BULK)} suggestions of a project (merge keeps \`keep\`; operator+, each item audited)`,
          security: csrf,
          body: z.object({
            project: Project,
            ids: z.array(z.string().regex(UUID)).min(1).max(MAX_BULK),
            action: z.enum(['accept', 'dismiss', 'merge']),
            keep: z.string().regex(UUID).optional(),
          }),
          response: {
            200: z.object({
              done: z.array(z.string()),
              failed: z.array(z.object({ id: z.string(), code: z.string() })),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          service.bulk(contextActorOf(request), request.body, contextRequestMeta(request)),
        ),
    );

    r.post(
      '/memory-suggestions/:id/accept',
      {
        config: {
          authz: {
            action: 'memory.suggestions.decide',
            resource: suggestionResource,
            notFound,
            auditDenied: { action: 'memory.suggestion.accept' },
          },
        },
        schema: {
          tags,
          summary:
            "Accept a suggestion (optionally edited): it becomes a memory document in the project's context with provenance (operator+, audited)",
          security: csrf,
          params: IdParams,
          body: z
            .object({
              title: z.string().min(1).max(160).optional(),
              content: z.string().min(1).max(1000).optional(),
              // p11-memory-layers: the typed record it becomes.
              type: z.enum(['rule', 'fact', 'decision', 'lesson']).optional(),
              scope: z.enum(['project', 'project+runtime']).optional(),
              reviewBy: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .nullable()
                .optional(),
              supersedes: z.string().regex(UUID).nullable().optional(),
            })
            .optional(),
          response: {
            200: z.object({
              suggestion: SuggestionBody,
              documentId: z.string(),
              record: RecordBody.nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const out = await service.accept(
            contextActorOf(request),
            request.params.id,
            request.body ?? {},
            contextRequestMeta(request),
          );
          return {
            suggestion: suggestionJson(out.suggestion),
            documentId: out.documentId,
            record: out.record === null ? null : recordJson(out.record),
          };
        }),
    );

    r.post(
      '/memory-suggestions/:id/dismiss',
      {
        config: {
          authz: {
            action: 'memory.suggestions.decide',
            resource: suggestionResource,
            notFound,
            auditDenied: { action: 'memory.suggestion.dismiss' },
          },
        },
        schema: {
          tags,
          summary: 'Dismiss a suggestion (it is never proposed again; operator+, audited)',
          security: csrf,
          params: IdParams,
          response: { 200: z.object({ suggestion: SuggestionBody }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          suggestion: suggestionJson(
            await service.dismiss(contextActorOf(request), request.params.id, contextRequestMeta(request)),
          ),
        })),
    );

    r.post(
      '/memory-suggestions/backfill',
      {
        config: {
          authz: {
            action: 'memory.suggestions.admin',
            resource: projectBody(),
            auditDenied: { action: 'memory.suggestions.backfill' },
          },
        },
        schema: {
          tags,
          summary: `Read the project's successful jobs and shared project-linked chat of the last N days (≤ ${String(MAX_BACKFILL_DAYS)}) that were never read (admin+, audited)`,
          security: csrf,
          body: z.object({ project: Project, days: z.number().int().min(1).max(MAX_BACKFILL_DAYS) }),
          response: { 200: PassBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          service.backfill(
            contextActorOf(request),
            request.body.project,
            request.body.days,
            contextRequestMeta(request),
          ),
        ),
    );

    r.get(
      '/memory-suggestions/agent-prompt',
      {
        config: {
          authz: {
            action: 'memory.suggestions.decide',
            resource: jobQueryResource,
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'Assisted mode: the prompt of an ordinary job that summarises a finished job into MEMORY: lines (opened in the job composer; operator+)',
          security: session,
          querystring: z.object({ job: z.string().regex(UUID) }),
          response: { 200: z.object({ project: z.string(), prompt: z.string() }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => service.agentPrompt(contextActorOf(request), request.query.job)),
    );

    r.get(
      '/memory-suggestions/chat-prompt',
      {
        config: { authz: { action: 'memory.suggestions.decide', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Assisted mode: the prompt of an ordinary job that summarises one of my conversations (its messages shared with the project) into MEMORY: lines — opened in the job composer, submitted by me (conversation owner, operator+)',
          security: session,
          querystring: z.object({ project: Project, thread: z.string().regex(UUID) }),
          response: {
            200: z.object({ project: z.string(), prompt: z.string(), messages: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          service.chatPrompt(contextActorOf(request), {
            project: request.query.project,
            threadId: request.query.thread,
          }),
        ),
    );
  };
}
