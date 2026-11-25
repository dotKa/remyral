import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';
import { cursorOrBadRequest } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { ASSET_KINDS, type ChatAssets } from './assets.js';
import {
  type ChatOrganizer,
  MAX_GROUP_NAME,
  MAX_TAG_NAME,
  MAX_TAGS_PER_THREAD,
  TAG_COLORS,
} from './organize.js';
import type { ChatStore } from './store.js';
import { ErrorBodySchema } from '../http/error-schema.js';

export type { ChatOrganizer } from './organize.js';

/**
 * p10-chat-organize routes (docs/design/p10-chat-organize.md §2): the caller's pins, groups, tags and stars, and the
 * chat sidebar's read model. `chat.use`; everything is the caller's own (another user's thread, message, group or tag
 * is a 404). Writes need CSRF and are rate limited per user (bucket `chat-organize`); they are personal organisation and
 * not audited (like the read position of p9-chat-unread).
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

export const GroupBody = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  collapsed: z.boolean(),
  threadCount: z.number().int(),
});
export const TagBody = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(TAG_COLORS),
  threadCount: z.number().int(),
});
export const OrganizeSummaryBody = z.object({
  groups: z.array(GroupBody),
  tags: z.array(TagBody),
  pinned: z.number().int(),
});

/** Query filters of `GET /chat/threads` (p10-chat-organize). */
export const ThreadListFilters = {
  pinned: z.enum(['true', 'false']).optional(),
  group: z.union([z.uuid(), z.literal('none')]).optional(),
  tag: z.uuid().optional(),
};

export function threadListFilter(q: {
  pinned?: 'true' | 'false' | undefined;
  group?: string | undefined;
  tag?: string | undefined;
}): { pinned?: boolean; group?: string; tag?: string } {
  return {
    ...(q.pinned === undefined ? {} : { pinned: q.pinned === 'true' }),
    ...(q.group === undefined ? {} : { group: q.group }),
    ...(q.tag === undefined ? {} : { tag: q.tag }),
  };
}

const AssetBody = z.object({
  kind: z.enum(ASSET_KINDS),
  key: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  messageId: z.string().nullable(),
  seq: z.number().int().nullable(),
  createdAt: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  url: z.string().nullable(),
  href: z.string().nullable(),
  domain: z.string().nullable(),
  mediaType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  role: z.enum(['user', 'assistant']).nullable(),
  source: z.enum(['attachment', 'artifact']).nullable(),
  draftKind: z.string().nullable(),
  draftState: z.string().nullable(),
  state: z.string().nullable(),
});
const AssetQuery = z.object({
  kind: z.enum(ASSET_KINDS),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(4096).optional(),
});
const AssetPageBody = z.object({ items: z.array(AssetBody), nextCursor: z.string().nullable() });

const ThreadParams = z.object({ id: z.uuid() });
const IdParams = z.object({ id: z.uuid() });

/** Writes per user and minute (pins, groups, tags, stars together). */
export const ORGANIZE_WRITES_PER_MIN = 120;

export function chatOrganizeRoutes(deps: {
  readonly organizer: ChatOrganizer;
  readonly assets: ChatAssets;
  readonly store: ChatStore;
  readonly limiter?: {
    hit(b: string, k: string, n: number, ms: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  };
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['chat'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const use = { config: { authz: { action: 'chat.use' as const } } };
    const userOf = (request: FastifyRequest): string => authzOf(request).subject.userId;
    const limit = async (request: FastifyRequest): Promise<string> => {
      const userId = userOf(request);
      if (deps.limiter !== undefined) {
        const hit = await deps.limiter.hit('chat-organize', userId, ORGANIZE_WRITES_PER_MIN, 60_000);
        if (!hit.allowed) {
          throw new HttpError(
            429,
            'rate_limited',
            'Too many changes; slow down.',
            {
              'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
            },
            {},
            { reason: 'changes' },
          );
        }
      }
      return userId;
    };

    r.get(
      '/chat/organize',
      {
        ...use,
        schema: {
          tags,
          summary: 'The caller’s conversation groups and tags (with counts) and the number of pins',
          security: session,
          response: { 200: OrganizeSummaryBody, ...errors },
        },
      },
      async (request) => deps.organizer.summary(userOf(request)),
    );

    r.put(
      '/chat/threads/:id/pin',
      {
        ...use,
        schema: {
          tags,
          summary: 'Pin or unpin one of the caller’s conversations (at most 20 pins)',
          security: csrf,
          params: ThreadParams,
          body: z.strictObject({ pinned: z.boolean() }),
          response: { 200: z.object({ threadId: z.string(), pinnedAt: z.string().nullable() }), ...errors },
        },
      },
      async (request) => {
        const userId = await limit(request);
        const out = await deps.organizer.setPinned(userId, request.params.id, request.body.pinned);
        return { threadId: request.params.id, ...out };
      },
    );

    r.put(
      '/chat/threads/:id/group',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Move one of the caller’s conversations into one of their groups, or out of any group (null)',
          security: csrf,
          params: ThreadParams,
          body: z.strictObject({ groupId: z.uuid().nullable() }),
          response: { 200: z.object({ threadId: z.string(), groupId: z.string().nullable() }), ...errors },
        },
      },
      async (request) => {
        const userId = await limit(request);
        const out = await deps.organizer.setGroup(userId, request.params.id, request.body.groupId);
        return { threadId: request.params.id, ...out };
      },
    );

    r.put(
      '/chat/threads/:id/tags',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Replace the tags of one of the caller’s conversations (the caller’s own tags, at most 10)',
          security: csrf,
          params: ThreadParams,
          body: z.strictObject({ tagIds: z.array(z.uuid()).max(MAX_TAGS_PER_THREAD) }),
          response: { 200: z.object({ threadId: z.string(), tagIds: z.array(z.string()) }), ...errors },
        },
      },
      async (request) => {
        const userId = await limit(request);
        const out = await deps.organizer.setTags(userId, request.params.id, request.body.tagIds);
        return { threadId: request.params.id, ...out };
      },
    );

    r.post(
      '/chat/groups',
      {
        ...use,
        schema: {
          tags,
          summary: 'Create a conversation group (names are unique per user, case-insensitive; at most 50)',
          security: csrf,
          body: z.strictObject({
            name: z
              .string()
              .min(1)
              .max(MAX_GROUP_NAME * 2),
          }),
          response: { 201: GroupBody, ...errors },
        },
      },
      async (request, reply) => {
        const userId = await limit(request);
        return reply.code(201).send(await deps.organizer.createGroup(userId, request.body.name));
      },
    );

    r.patch(
      '/chat/groups/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Rename, collapse / expand or reorder one of the caller’s groups',
          security: csrf,
          params: IdParams,
          body: z
            .strictObject({
              name: z
                .string()
                .min(1)
                .max(MAX_GROUP_NAME * 2)
                .optional(),
              collapsed: z.boolean().optional(),
              position: z.number().int().min(0).max(100_000).optional(),
            })
            .refine((b) => Object.keys(b).length > 0, 'nothing to change'),
          response: { 200: GroupBody, ...errors },
        },
      },
      async (request) => {
        const userId = await limit(request);
        const b = request.body;
        return deps.organizer.updateGroup(userId, request.params.id, {
          ...(b.name === undefined ? {} : { name: b.name }),
          ...(b.collapsed === undefined ? {} : { collapsed: b.collapsed }),
          ...(b.position === undefined ? {} : { position: b.position }),
        });
      },
    );

    r.delete(
      '/chat/groups/:id',
      {
        ...use,
        schema: {
          tags,
          summary:
            'Delete one of the caller’s groups (its conversations become ungrouped; nothing else is deleted)',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const userId = await limit(request);
        await deps.organizer.deleteGroup(userId, request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/chat/tags',
      {
        ...use,
        schema: {
          tags,
          summary: 'Create a conversation tag with a colour from the palette (unique per user; at most 100)',
          security: csrf,
          body: z.strictObject({
            name: z
              .string()
              .min(1)
              .max(MAX_TAG_NAME * 2),
            color: z.enum(TAG_COLORS),
          }),
          response: { 201: TagBody, ...errors },
        },
      },
      async (request, reply) => {
        const userId = await limit(request);
        return reply
          .code(201)
          .send(await deps.organizer.createTag(userId, request.body.name, request.body.color));
      },
    );

    r.patch(
      '/chat/tags/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Rename or recolour one of the caller’s tags',
          security: csrf,
          params: IdParams,
          body: z
            .strictObject({
              name: z
                .string()
                .min(1)
                .max(MAX_TAG_NAME * 2)
                .optional(),
              color: z.enum(TAG_COLORS).optional(),
            })
            .refine((b) => b.name !== undefined || b.color !== undefined, 'nothing to change'),
          response: { 200: TagBody, ...errors },
        },
      },
      async (request) => {
        const userId = await limit(request);
        const b = request.body;
        return deps.organizer.updateTag(userId, request.params.id, {
          ...(b.name === undefined ? {} : { name: b.name }),
          ...(b.color === undefined ? {} : { color: b.color }),
        });
      },
    );

    r.delete(
      '/chat/tags/:id',
      {
        ...use,
        schema: {
          tags,
          summary: 'Delete one of the caller’s tags (removed from every conversation)',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const userId = await limit(request);
        await deps.organizer.deleteTag(userId, request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.put(
      '/chat/messages/:id/star',
      {
        ...use,
        schema: {
          tags,
          summary: 'Star or unstar a message (yours or the assistant’s) in one of the caller’s conversations',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ starred: z.boolean() }),
          response: {
            200: z.object({
              messageId: z.string(),
              threadId: z.string(),
              starred: z.boolean(),
              starredAt: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const userId = await limit(request);
        return deps.organizer.setStar(userId, request.params.id, request.body.starred);
      },
    );

    r.get(
      '/chat/threads/:id/assets',
      {
        ...use,
        schema: {
          tags,
          summary:
            'The chat sidebar of one of the caller’s conversations: starred messages, media, links, files or the work it created (newest first, paged)',
          security: session,
          params: ThreadParams,
          querystring: AssetQuery,
          response: { 200: AssetPageBody, ...errors },
        },
      },
      async (request) => {
        const { subject } = authzOf(request);
        await deps.store.thread(subject.userId, request.params.id);
        const q = request.query;
        return cursorOrBadRequest(() =>
          deps.assets.list(subject, q.kind, {
            threadId: request.params.id,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            ...(q.limit === undefined ? {} : { limit: q.limit }),
          }),
        );
      },
    );

    r.get(
      '/chat/assets',
      {
        ...use,
        schema: {
          tags,
          summary:
            'The chat sidebar over all the caller’s conversations: starred messages, media, links, files or the work they created',
          security: session,
          querystring: AssetQuery,
          response: { 200: AssetPageBody, ...errors },
        },
      },
      async (request) => {
        const { subject } = authzOf(request);
        const q = request.query;
        return cursorOrBadRequest(() =>
          deps.assets.list(subject, q.kind, {
            threadId: null,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            ...(q.limit === undefined ? {} : { limit: q.limit }),
          }),
        );
      },
    );
  };
}
