import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { namespaceBody, namespaceResource, projectQuery } from '../authz/resources.js';
import { contextActorOf, contextRequestMeta, handledContext } from '../context/routes.js';
import type { SearchHit, SearchService, SearchSettings, SyncStats } from './service.js';
import { MAX_QUERY_CHARS } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
});
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
  502: ErrorBody,
};

const SettingsBody = z.object({
  namespace: z.string(),
  available: z.boolean(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  dims: z.number().int().nullable(),
  /** p10-bedrock-integration-panel: `panel` / `environment` / `instance role` (null: no provider). */
  source: z.enum(['panel', 'environment', 'instance role']).nullable(),
  region: z.string().nullable(),
  enabled: z.boolean(),
  version: z.number().int(),
  indexed: z.number().int(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  /** p10-semantic-defaults-chat: where the setting came from (null: never set). */
  origin: z.enum(['explicit', 'create', 'platform_default']).nullable(),
});
const HitBody = z.object({
  type: z.enum(['context_doc', 'job_summary', 'chat_message']),
  id: z.string(),
  namespace: z.string(),
  title: z.string(),
  snippet: z.string(),
  version: z.string(),
  score: z.number(),
  /** p10-semantic-defaults-chat: a project-linked chat message — whose conversation, which message, when. */
  chat: z
    .object({
      author: z.enum(['user', 'assistant']),
      ownerName: z.string(),
      seq: z.number().int(),
      at: z.string(),
      /** The thread, only for its owner (others cannot open it). */
      threadId: z.string().nullable(),
    })
    .optional(),
});
const SyncBody = z.object({
  receipts: z.number().int(),
  removed: z.number().int(),
  indexedDocs: z.number().int(),
  indexedJobs: z.number().int(),
  skippedSecrets: z.number().int(),
});

const Namespace = z.string().min(1).max(200);

function settingsJson(s: SearchSettings): z.infer<typeof SettingsBody> {
  return {
    namespace: s.namespace,
    available: s.available,
    model: s.model,
    provider: s.provider,
    dims: s.dims,
    source: s.source,
    region: s.region,
    enabled: s.enabled,
    version: s.version,
    indexed: s.indexed,
    updatedAt: s.updatedAt?.toISOString() ?? null,
    updatedBy: s.updatedBy,
    origin: s.origin,
  };
}

const hitJson = (h: SearchHit): z.infer<typeof HitBody> => ({ ...h });
const syncJson = (s: SyncStats): z.infer<typeof SyncBody> => ({ ...s });

function namespaceQuery() {
  return (request: FastifyRequest) => {
    const q = request.query as Record<string, unknown> | null;
    const ns =
      q !== null && typeof q === 'object' && typeof q.namespace === 'string' ? q.namespace : undefined;
    return namespaceResource(ns);
  };
}

/** Optional semantic search API (docs/design/p6-vector.md §6). Registered always; 409 when unconfigured. */
export function searchRoutes(search: SearchService, clock: () => Date) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];

    r.get(
      '/context/search',
      {
        config: { authz: { action: 'context.search', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            "Semantic search over a project's context documents (and granted global ones) and job summaries (viewer+, opt-in per project)",
          security: session,
          querystring: z.object({
            project: z.string().min(1).max(128),
            q: z.string().min(1).max(MAX_QUERY_CHARS),
            limit: z.coerce.number().int().min(1).max(50).optional(),
            // p10-semantic-memory: only one source type; keyword fallback instead of 409/400/429/502.
            type: z.enum(['context_doc', 'job_summary', 'chat_message']).optional(),
            fallback: z.enum(['keyword']).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(HitBody),
              mode: z.enum(['semantic', 'keyword']),
              fallbackReason: z
                .enum(['unavailable', 'not_enabled', 'query_rejected', 'provider_error', 'rate_limited'])
                .nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const found = await search.find(contextActorOf(request), request.query.project, request.query.q, {
            limit: request.query.limit,
            types: request.query.type === undefined ? undefined : [request.query.type],
            fallback: request.query.fallback === 'keyword',
          });
          return { items: found.items.map(hitJson), mode: found.mode, fallbackReason: found.fallbackReason };
        }),
    );

    r.get(
      '/context/search/settings',
      {
        config: { authz: { action: 'context.read', resource: namespaceQuery() } },
        schema: {
          tags,
          summary: 'Semantic-search capture setting of a namespace and whether a provider is configured',
          security: session,
          querystring: z.object({ namespace: Namespace }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          settingsJson(await search.settings(contextActorOf(request), request.query.namespace)),
        ),
    );

    r.put(
      '/context/search/settings',
      {
        config: {
          authz: {
            action: 'context.search.admin',
            resource: namespaceBody(),
            auditDenied: { action: 'context.search.consent' },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary:
            "Consent: allow or stop sending a namespace's documents (and job summaries) to the embedding provider (admin+, step-up, audited; off deletes its vectors)",
          security: csrf,
          body: z.object({
            namespace: Namespace,
            enabled: z.boolean(),
            expectedVersion: z.number().int().min(0),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          settingsJson(
            await search.setConsent(contextActorOf(request), request.body, contextRequestMeta(request)),
          ),
        ),
    );

    r.post(
      '/context/search/reindex',
      {
        config: {
          authz: {
            action: 'context.search.admin',
            resource: namespaceBody(),
            auditDenied: { action: 'context.search.reindex' },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary: "Rebuild a namespace's search vectors from the live sources (admin+, step-up, audited)",
          security: csrf,
          body: z.object({ namespace: Namespace }),
          response: { 200: SyncBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          syncJson(
            await search.reindex(
              contextActorOf(request),
              request.body.namespace,
              contextRequestMeta(request),
            ),
          ),
        ),
    );
  };
}
