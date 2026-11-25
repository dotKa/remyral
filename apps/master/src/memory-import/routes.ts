import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RateLimiter } from '../auth/rate-limit.js';
import { authzOf } from '../http/route-authz.js';
import { contextActorOf, contextRequestMeta, handledContext } from '../context/routes.js';
import { HttpError } from '../http/errors.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { ITEM_KINDS, MAX_IMPORT_BYTES, MAX_IMPORT_ITEMS, MAX_ITEM_CHARS } from './parse.js';
import {
  IMPORT_ASSISTANTS,
  ImportNotFoundError,
  ImportScopeError,
  ImportTooLargeError,
  ImportUndoneError,
  type ImportView,
  type MemoryImportService,
  type PreviewItem,
} from './service.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
  findings: z.array(z.record(z.string(), z.unknown())).optional(),
});
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** JSON escaping of 256 KB of text stays well under this (newlines and quotes double at most). */
export const MEMORY_IMPORT_BODY_LIMIT = 1024 * 1024;

/** Per user: previews and imports are cheap for a person, expensive in bulk (parsing, provider calls, writes). */
export const MEMORY_IMPORT_LIMITS = {
  preview: { max: 30, windowMs: 60 * 60_000 },
  apply: { max: 10, windowMs: 60 * 60_000 },
  undo: { max: 30, windowMs: 60 * 60_000 },
} as const;

const Kind = z.enum(ITEM_KINDS);
const RecordTypeOfImport = z.enum(['rule', 'fact', 'lesson']);
const Match = z
  .object({
    id: z.string(),
    title: z.string(),
    scope: z.string(),
    score: z.number(),
    method: z.enum(['semantic', 'lexical']),
  })
  .nullable();
const PreviewItemBody = z.object({
  index: z.number().int(),
  kind: Kind,
  guessed: z.boolean(),
  scopeHint: z.enum(['personal', 'team']).nullable(),
  text: z.string(),
  evidence: z.string().nullable(),
  date: z.string().nullable(),
  line: z.number().int(),
  proposedScope: z.string(),
  proposedType: z.enum(['rule', 'fact', 'decision', 'lesson']),
  flags: z.array(z.string()),
  include: z.boolean(),
  blocked: z.boolean(),
  duplicateOf: Match,
  similarTo: Match,
  contradicts: Match,
  mergeInto: z.number().int().nullable(),
  mergedFrom: z.array(z.number().int()),
});
const ImportBody = z.object({
  id: z.string(),
  assistant: z.enum(IMPORT_ASSISTANTS),
  assistantLabel: z.string().nullable(),
  source: z.string(),
  promptVersion: z.number().int().nullable(),
  format: z.string(),
  itemsTotal: z.number().int(),
  itemsImported: z.number().int(),
  itemsFailed: z.number().int(),
  flaggedImported: z.number().int(),
  scopes: z.array(z.string()),
  semantic: z.boolean(),
  createdAt: z.string(),
  undoneAt: z.string().nullable(),
  activeRecords: z.number().int(),
});

const importJson = (v: ImportView): z.infer<typeof ImportBody> => ({
  ...v,
  scopes: [...v.scopes],
  createdAt: v.createdAt.toISOString(),
  undoneAt: v.undoneAt === null ? null : v.undoneAt.toISOString(),
});
const itemJson = (i: PreviewItem): z.infer<typeof PreviewItemBody> => ({
  ...i,
  flags: [...i.flags],
  mergedFrom: [...i.mergedFrom],
});

/** The import's own refusals as HTTP errors (the console says them in the person's language). */
async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  return handledContext(reply, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ImportNotFoundError)
        throw new HttpError(404, 'memory_import_not_found', 'Memory import not found.');
      if (err instanceof ImportUndoneError)
        throw new HttpError(409, 'memory_import_already_undone', 'This import was already undone.');
      if (err instanceof ImportTooLargeError)
        throw new HttpError(
          400,
          'memory_import_too_large',
          'The text is too large to import (at most 256 KB).',
        );
      if (err instanceof ImportScopeError)
        throw new HttpError(
          403,
          'memory_import_scope_forbidden',
          'You may not write records in one of the chosen scopes (a project needs operator or more, global needs an admin).',
        );
      throw err;
    }
  });
}

/**
 * Memory import API (docs/design/p17-memory-import.md §7). Every signed-in person imports into their own personal
 * rules (`memory.personal`, like `/memory-records/personal`); project and global scopes are checked per item by the
 * service with the permission of writing such a record by hand (project operator+ / admin). Rate-limited per user.
 */
export function memoryImportRoutes(service: MemoryImportService, limiter?: RateLimiter) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const limit = async (
      request: FastifyRequest,
      bucket: keyof typeof MEMORY_IMPORT_LIMITS,
    ): Promise<void> => {
      if (limiter === undefined) return;
      const rule = MEMORY_IMPORT_LIMITS[bucket];
      const hit = await limiter.hit(
        `memory-import-${bucket}`,
        authzOf(request).subject.userId,
        rule.max,
        rule.windowMs,
      );
      if (!hit.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many memory imports; try again later.',
          { 'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)) },
          {},
          { reason: 'memory_imports' },
        );
      }
    };

    r.get(
      '/memory-imports/options',
      {
        config: { authz: { action: 'memory.personal' } },
        schema: {
          tags,
          summary:
            'Limits and choices of the memory import (prompt version, size caps, meaning-based comparison)',
          security: session,
          response: {
            200: z.object({
              promptVersion: z.number().int(),
              maxBytes: z.number().int(),
              maxItems: z.number().int(),
              maxItemChars: z.number().int(),
              semanticAvailable: z.boolean(),
              canGlobal: z.boolean(),
              personalScope: z.string(),
            }),
            ...errors,
          },
        },
      },
      (request) => service.options(contextActorOf(request)),
    );

    r.get(
      '/memory-imports',
      {
        config: { authz: { action: 'memory.personal' } },
        schema: {
          tags,
          summary: 'Your memory imports, newest first (with what an undo would reject)',
          security: session,
          response: { 200: z.object({ items: z.array(ImportBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({
          items: (await service.list(contextActorOf(request))).map(importJson),
        })),
    );

    r.post(
      '/memory-imports/preview',
      {
        bodyLimit: MEMORY_IMPORT_BODY_LIMIT,
        config: { authz: { action: 'memory.personal' } },
        schema: {
          tags,
          summary:
            "Parse an assistant's answer into candidate records (checks, duplicates, proposed type and scope); stores nothing",
          security: csrf,
          body: z.object({
            // Characters bound the JSON; the service checks the UTF-8 byte size (MAX_IMPORT_BYTES).
            text: z.string().min(1).max(MAX_IMPORT_BYTES),
            project: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
              .nullable()
              .optional(),
            semantic: z.boolean().optional(),
          }),
          response: {
            200: z.object({
              format: z.enum(['jsonl', 'json', 'markdown', 'text']),
              sha256: z.string(),
              bytes: z.number().int(),
              items: z.array(PreviewItemBody),
              issues: z.array(
                z.object({
                  line: z.number().int(),
                  code: z.enum(['invalid_json', 'missing_text', 'unknown_type', 'not_an_object']),
                }),
              ),
              truncated: z.boolean(),
              semantic: z.boolean(),
              semanticFailed: z.boolean(),
              language: z.enum(['tr', 'en']),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        await limit(request, 'preview');
        return handled(reply, async () => {
          const out = await service.preview(contextActorOf(request), request.body);
          return { ...out, items: out.items.map(itemJson), issues: [...out.issues] };
        });
      },
    );

    r.post(
      '/memory-imports',
      {
        bodyLimit: MEMORY_IMPORT_BODY_LIMIT,
        config: { authz: { action: 'memory.personal', auditDenied: { action: 'memory.import' } } },
        schema: {
          tags,
          summary:
            'Import the reviewed items as memory records (personal by default; project / global with the same permission as writing them by hand). Audited memory.import',
          security: csrf,
          body: z.object({
            assistant: z.enum(IMPORT_ASSISTANTS),
            assistantLabel: z.string().max(40).nullable().optional(),
            promptVersion: z.number().int().min(1).max(1000).nullable().optional(),
            format: z.enum(['jsonl', 'json', 'markdown', 'text', 'edited']),
            sha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable()
              .optional(),
            bytes: z.number().int().min(0).max(MAX_IMPORT_BYTES).nullable().optional(),
            semantic: z.boolean().optional(),
            items: z
              .array(
                z.object({
                  kind: Kind,
                  text: z.string().min(1).max(MAX_ITEM_CHARS),
                  type: RecordTypeOfImport,
                  scope: z.string().min(6).max(200),
                  evidence: z.string().max(300).nullable().optional(),
                  date: z.string().max(10).nullable().optional(),
                }),
              )
              .min(1)
              .max(MAX_IMPORT_ITEMS),
          }),
          response: {
            200: z.object({
              import: ImportBody,
              results: z.array(
                z.object({
                  index: z.number().int(),
                  ok: z.boolean(),
                  recordId: z.string().nullable(),
                  code: z.string().nullable(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        await limit(request, 'apply');
        return handled(reply, async () => {
          const out = await service.apply(contextActorOf(request), request.body, contextRequestMeta(request));
          return { import: importJson(out.import), results: out.results };
        });
      },
    );

    r.post(
      '/memory-imports/:id/undo',
      {
        config: { authz: { action: 'memory.personal', auditDenied: { action: 'memory.import.undo' } } },
        schema: {
          tags,
          summary:
            'Undo one of your imports: its still-active records become rejected (history kept). Once. Audited memory.import.undo',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          response: {
            200: z.object({ import: ImportBody, rejected: z.number().int(), failed: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        await limit(request, 'undo');
        return handled(reply, async () => {
          const out = await service.undo(
            contextActorOf(request),
            request.params.id,
            contextRequestMeta(request),
          );
          return { import: importJson(out.import), rejected: out.rejected, failed: out.failed };
        });
      },
    );
  };
}
