import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { Resource } from '../authz/model.js';
import { bodyField, param, projectQuery } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import {
  type FolderActor,
  FolderCreate,
  FolderPatch,
  LINK_KEY,
  LinkKeys,
  type OutputFolders,
} from './folders.js';
import { RATE } from './model.js';
import type { OutputTree } from './tree.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Project = z.string().regex(PROJECT);

const FolderBody = z.object({
  id: z.string(),
  scope: z.enum(['project', 'personal']),
  project: z.string().nullable(),
  parentId: z.string().nullable(),
  depth: z.number().int(),
  name: z.string(),
  note: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  itemCount: z.number().int(),
  childCount: z.number().int(),
  createdBy: z.object({ id: z.string().nullable(), username: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  writable: z.boolean(),
});
const FolderDetailBody = FolderBody.extend({
  ancestors: z.array(z.object({ id: z.string(), name: z.string() })),
});
const TreeNodeBody = z.object({
  project: z.string().nullable(),
  path: z.string(),
  kind: z.enum(['project', 'personal', 'folders', 'sites', 'notes', 'job', 'dir', 'folder']),
  label: z.string(),
  count: z.number().int().nullable(),
  hasChildren: z.boolean(),
  folderId: z.string().optional(),
  jobId: z.string().optional(),
  pinned: z.boolean().optional(),
  createdAt: z.string().optional(),
});

/**
 * p8-outputs-folders (docs/design/p8-outputs-folders.md §2–§3): own folders and the automatic tree. Route gates:
 * reads `outputs.read`, writes `outputs.folders` (viewer; the service adds `outputs.write` for project folders and
 * the owner check for personal ones). Every write is audited and rate-limited per user.
 */
export function folderRoutes(deps: {
  readonly folders: OutputFolders;
  readonly tree: OutputTree;
  readonly limiter: RateLimiter;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { folders } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['outputs'];
    const actor = (request: FastifyRequest): FolderActor => ({
      subject: authzOf(request).subject,
      ...requestMeta(request),
    });
    const limit = async (request: FastifyRequest): Promise<void> => {
      const rule = RATE.write;
      const res = await deps.limiter.hit(
        'outputs-write',
        sessionOf(request).user.id,
        rule.max,
        rule.windowMs,
      );
      if (!res.allowed) {
        throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
          'retry-after': String(Math.max(1, Math.ceil(res.retryAfterMs / 1000))),
        });
      }
    };
    /** Project folders resolve to their project; an own personal folder to `{}`; anything else null (404). */
    const folderResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      return folders.resourceOf(id, sessionOf(request).user.id);
    };
    const notFound = () => new HttpError(404, 'folder_not_found', 'Folder not found.');
    const bodyProject = (request: FastifyRequest): Resource | null | undefined => {
      const p = bodyField(request, 'project');
      if (p === undefined) return undefined;
      return PROJECT.test(p) ? { project: p } : null;
    };
    const IdParams = z.object({ id: z.string().regex(UUID) });
    const write = { action: 'outputs.folders' as const, resource: folderResource, notFound };

    r.get(
      '/outputs/folders',
      {
        config: { authz: { action: 'outputs.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Own folders: the project folders of `project` (when given) and the caller’s personal folders (flat; parents first)',
          security: session,
          querystring: z.object({ project: Project.optional() }),
          response: { 200: z.object({ items: z.array(FolderBody) }), ...errors },
        },
      },
      async (request) => ({ items: await folders.list(authzOf(request).subject, request.query.project) }),
    );

    r.get(
      '/outputs/folders/:id',
      {
        config: { authz: { action: 'outputs.read', resource: folderResource, notFound } },
        schema: {
          tags,
          summary: 'One folder with its breadcrumb (ancestors)',
          security: session,
          params: IdParams,
          response: { 200: FolderDetailBody, ...errors },
        },
      },
      async (request) => folders.get(authzOf(request).subject, request.params.id),
    );

    r.post(
      '/outputs/folders',
      {
        config: {
          authz: {
            action: 'outputs.folders',
            resource: bodyProject,
            auditDenied: { action: 'outputs.folder.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Create a folder: scope `project` (shared with the project; operator+) or `personal` (yours only); optional parent (≤ 6 levels)',
          security: csrf,
          body: FolderCreate,
          response: { 201: FolderDetailBody, ...errors },
        },
      },
      async (request, reply) => {
        await limit(request);
        return reply.code(201).send(await folders.create(actor(request), request.body));
      },
    );

    r.patch(
      '/outputs/folders/:id',
      {
        config: { authz: write },
        schema: {
          tags,
          summary:
            'Rename a folder, change its note, tags or pin, or move it (`parentId`, null = top level; same place, no cycles, ≤ 6 levels)',
          security: csrf,
          params: IdParams,
          body: FolderPatch,
          response: { 200: FolderDetailBody, ...errors },
        },
      },
      async (request) => {
        await limit(request);
        return folders.update(actor(request), request.params.id, request.body);
      },
    );

    r.delete(
      '/outputs/folders/:id',
      {
        config: { authz: write },
        schema: {
          tags,
          summary: 'Delete a folder and its sub-folders (the items themselves stay)',
          security: csrf,
          params: IdParams,
          response: { 200: z.object({ folders: z.number().int(), links: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        await limit(request);
        return folders.remove(actor(request), request.params.id);
      },
    );

    const LinkBody = z.strictObject({ project: Project, keys: LinkKeys });
    r.post(
      '/outputs/folders/:id/items',
      {
        config: { authz: write },
        schema: {
          tags,
          summary:
            'Add items (Outputs keys of one project, ≤ 100) to a folder — links, not moves; an item can be in several folders',
          security: csrf,
          params: IdParams,
          body: LinkBody,
          response: {
            200: z.object({
              added: z.number().int(),
              already: z.number().int(),
              refused: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await limit(request);
        return folders.link(actor(request), request.params.id, request.body.project, request.body.keys);
      },
    );

    r.post(
      '/outputs/folders/:id/items/remove',
      {
        config: { authz: write },
        schema: {
          tags,
          summary: 'Remove items from a folder (the items themselves stay)',
          security: csrf,
          params: IdParams,
          body: LinkBody,
          response: { 200: z.object({ removed: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        await limit(request);
        return {
          removed: await folders.unlink(
            actor(request),
            request.params.id,
            request.body.project,
            request.body.keys,
          ),
        };
      },
    );

    r.get(
      '/outputs/item-folders',
      {
        config: { authz: { action: 'outputs.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'The folders (readable by the caller) an output item is in',
          security: session,
          querystring: z.object({ project: Project, key: z.string().regex(LINK_KEY) }),
          response: { 200: z.object({ items: z.array(FolderDetailBody) }), ...errors },
        },
      },
      async (request) => ({
        items: await folders.itemFolders(authzOf(request).subject, request.query.project, request.query.key),
      }),
    );

    r.get(
      '/outputs/tree',
      {
        config: { authz: { action: 'outputs.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'One level of the automatic Outputs tree: projects and My folders; a project’s Folders, Sites, Notes and jobs with files; a job’s out/ directories; folders’ sub-folders',
          security: session,
          querystring: z.object({
            project: Project.optional(),
            path: z.string().max(400).default(''),
            offset: z.coerce.number().int().min(0).max(10_000).optional(),
          }),
          response: { 200: z.object({ nodes: z.array(TreeNodeBody), total: z.number().int() }), ...errors },
        },
      },
      async (request) =>
        deps.tree.children(
          authzOf(request).subject,
          request.query.project,
          request.query.path,
          request.query.offset ?? 0,
        ),
    );
  };
}
