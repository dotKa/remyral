import { Readable } from 'node:stream';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { type Resource, visibleProjects } from '../authz/model.js';
import { bodyField, jobResource, param, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { folderZipPlan, type ZipPlan, treeZipPlan } from './folder-zip.js';
import type { OutputFolders } from './folders.js';
import { ITEM_KEY, ItemMetaUpdate, LIMITS, NoteBody, NoteCardInput, NoteCardPatch, RATE } from './model.js';
import type { OutputsActor, OutputsService } from './service.js';
import { siteBundleFile, siteBundleView } from './site-preview.js';
import { uniquePaths, zipPath, zipStream } from './zip.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { primaryOutputKey } from './primary.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  413: ErrorBody,
  429: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Project = z.string().regex(PROJECT);
const Author = z.object({ id: z.string().nullable(), username: z.string().nullable() });

const ItemBody = z.object({
  key: z.string(),
  type: z.enum(['site', 'file', 'note']),
  project: z.string(),
  title: z.string().nullable(),
  name: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  noteCount: z.number().int(),
  jobId: z.string().nullable(),
  createdAt: z.string(),
  site: z
    .object({
      url: z.string().nullable(),
      env: z.enum(['preview', 'production']),
      provider: z.enum(['pages', 'coolify', 'tunnel']),
      target: z.string(),
      opsActionId: z.string(),
      opsKind: z.string(),
      deployedAt: z.string(),
      /** p8-preview-tunnels: preview links only (provider `tunnel`). */
      protection: z.enum(['none', 'access', 'service-token']).optional(),
      stable: z.boolean().optional(),
      expiresAt: z.string().optional(),
      state: z.string().optional(),
    })
    .nullable(),
  file: z
    .object({
      source: z.enum(['workspace', 'run']),
      artifactId: z.string(),
      kind: z.enum(['output', 'summary', 'run']),
      mediaType: z.string(),
      sizeBytes: z.number().int().nullable(),
      sha256: z.string().nullable(),
      redacted: z.boolean(),
      removed: z.enum(['retention', 'quota']).nullable(),
      expiresAt: z.string().nullable(),
      download: z.string().nullable(),
      preview: z.enum(['markdown', 'text', 'json', 'csv', 'tsv', 'image', 'pdf', 'diff', 'none']),
      /** p17-object-storage: where the bytes are (null: none stored). */
      location: z.enum(['s3', 'local', 'database']).nullable(),
    })
    .nullable(),
  note: z
    .object({
      id: z.string(),
      body: z.string(),
      bodyTruncated: z.boolean(),
      links: z.array(z.string()),
      author: Author,
      updatedAt: z.string(),
    })
    .nullable(),
  // p8-uptime: the monitors linked to a site item.
  uptime: z
    .object({
      status: z.enum(['up', 'down', 'pending']).nullable(),
      uptime24h: z.number().nullable(),
      monitors: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.enum(['http', 'tcp', 'pages', 'coolify']),
          status: z.enum(['up', 'down', 'pending']),
          paused: z.boolean(),
          uptime24h: z.number().nullable(),
          detail: z.string().nullable(),
          lastCheckAt: z.string().nullable(),
        }),
      ),
    })
    .nullable()
    .optional(),
  // p10-verify-health: the latest post-deploy health check (and its screenshot) of a site item.
  health: z
    .object({
      id: z.string(),
      state: z.string(),
      checkedAt: z.string(),
      statusCode: z.number().int().nullable(),
      latencyMs: z.number().int().nullable(),
      broken: z.number().int(),
      screenshot: z.object({ jobId: z.string(), artifactId: z.string() }).nullable(),
    })
    .nullable()
    .optional(),
});
const ItemNoteBody = z.object({
  id: z.string(),
  body: z.string(),
  author: Author,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const NoteCardBody = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  links: z.array(z.string()),
  pinned: z.boolean(),
  author: Author,
  createdAt: z.string(),
  updatedAt: z.string(),
});

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

/**
 * p6-outputs (docs/design/p6-outputs.md §3): the Outputs API. Reads need `outputs.read` (viewer) in the item's
 * project, writes `outputs.write` (operator) plus — for notes — authorship or the owner/admin role; every write is
 * audited. File content keeps using the job artifact routes and their `jobs.read` rule; the site-bundle preview is
 * job-scoped too.
 */
export function outputRoutes(deps: {
  readonly service: OutputsService;
  readonly db: Queryable;
  readonly limiter: RateLimiter;
  /** p8-outputs-folders: `?folder=` filter and folder / tree ZIPs (absent: refused). */
  readonly folders?: OutputFolders;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['outputs'];
    const actor = (request: FastifyRequest): OutputsActor => ({
      id: sessionOf(request).user.id,
      role: authzOf(request).role,
      ...requestMeta(request),
    });
    const limit = async (request: FastifyRequest, bucket: keyof typeof RATE): Promise<void> => {
      const rule = RATE[bucket];
      const res = await deps.limiter.hit(
        `outputs-${bucket}`,
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
    const resourceOf =
      (lookup: (id: string) => Promise<string | null>) =>
      async (request: FastifyRequest): Promise<Resource | null> => {
        const id = param(request, 'id');
        if (id === undefined || !UUID.test(id)) return null;
        const project = await lookup(id);
        return project === null ? null : { project };
      };
    const noteNotFound = () => new HttpError(404, 'note_not_found', 'Note not found.');
    const itemNoteResource = resourceOf((id) => service.itemNoteProject(id));
    const noteResource = resourceOf((id) => service.noteProject(id));
    const IdParams = z.object({ id: z.string().regex(UUID) });

    r.get(
      '/outputs',
      {
        config: { authz: { action: 'outputs.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Outputs of visible projects: live sites (latest successful deploy per project, target and environment), job output files and run artifacts, note cards — pinned first, newest first',
          security: session,
          querystring: z.object({
            project: Project.optional(),
            type: z.enum(['site', 'file', 'note']).optional(),
            job: z.string().regex(UUID).optional(),
            from: z.iso.datetime({ offset: true }).optional(),
            to: z.iso.datetime({ offset: true }).optional(),
            pinned: z.enum(['true', 'false']).optional(),
            q: z.string().max(LIMITS.queryMax).optional(),
            tag: z.string().max(LIMITS.tagMax).optional(),
            key: z.string().max(320).optional(),
            // p8-outputs-folders: items of one own folder; files below one directory of a job's out/ tree.
            folder: z.string().regex(UUID).optional(),
            path: z
              .string()
              .max(300)
              .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}){0,2}$/)
              .optional(),
            limit: z.coerce.number().int().min(1).max(LIMITS.pageMax).optional(),
            offset: z.coerce.number().int().min(0).max(LIMITS.offsetMax).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(ItemBody),
              total: z.number().int(),
              /**
               * p15-chat-cards-scroll (additive, with `job` only): the key of the job's primary output among the listed
               * items — a report-like Markdown file, else the newest document; null: none.
               */
              primaryOutputId: z.string().nullable().optional(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const q = request.query;
        if (q.folder !== undefined) {
          // A folder the caller cannot read is a 404 (same as a missing one).
          if (deps.folders === undefined) throw new HttpError(404, 'folder_not_found', 'Folder not found.');
          await deps.folders.readable(authzOf(request).subject, q.folder);
        }
        const listed = await service.list(visibleProjects(authzOf(request).subject), {
          folder: q.folder,
          path: q.path,
          project: q.project,
          type: q.type,
          jobId: q.job,
          from: q.from === undefined ? undefined : new Date(q.from),
          to: q.to === undefined ? undefined : new Date(q.to),
          pinned: q.pinned === undefined ? undefined : q.pinned === 'true',
          q: q.q,
          tag: q.tag,
          key: q.key,
          limit: q.limit,
          offset: q.offset,
        });
        return q.job === undefined ? listed : { ...listed, primaryOutputId: primaryOutputKey(listed.items) };
      },
    );

    r.put(
      '/outputs/items',
      {
        config: {
          authz: {
            action: 'outputs.write',
            resource: bodyProject,
            auditDenied: { action: 'outputs.item.update', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Title, tag or pin an output item (omitted fields unchanged); pinned files are kept by the retention',
          security: csrf,
          body: ItemMetaUpdate,
          response: { 200: ItemBody, ...errors },
        },
      },
      async (request) => {
        await limit(request, 'write');
        return service.updateItem(actor(request), request.body);
      },
    );

    r.get(
      '/outputs/thread',
      {
        config: { authz: { action: 'outputs.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'The notes thread of an output item (oldest first)',
          security: session,
          querystring: z.object({ project: Project, key: z.string().regex(ITEM_KEY) }),
          response: { 200: z.object({ items: z.array(ItemNoteBody) }), ...errors },
        },
      },
      async (request) => ({ items: await service.itemNotes(request.query.project, request.query.key) }),
    );

    r.post(
      '/outputs/item-notes',
      {
        config: {
          authz: {
            action: 'outputs.write',
            resource: bodyProject,
            auditDenied: { action: 'outputs.item_note.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary: 'Add a note (markdown text, ≤ 20 000 characters) to an output item',
          security: csrf,
          body: z.strictObject({ project: Project, key: z.string().regex(ITEM_KEY), body: NoteBody }),
          response: { 201: ItemNoteBody, ...errors },
        },
      },
      async (request, reply) => {
        await limit(request, 'write');
        const b = request.body;
        return reply.code(201).send(await service.addItemNote(actor(request), b.project, b.key, b.body));
      },
    );

    r.patch(
      '/outputs/item-notes/:id',
      {
        config: { authz: { action: 'outputs.write', resource: itemNoteResource, notFound: noteNotFound } },
        schema: {
          tags,
          summary: 'Edit a note of an output item (its author, or an owner/admin)',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ body: NoteBody }),
          response: { 200: ItemNoteBody, ...errors },
        },
      },
      async (request) => {
        await limit(request, 'write');
        return service.updateItemNote(actor(request), request.params.id, request.body.body);
      },
    );

    r.delete(
      '/outputs/item-notes/:id',
      {
        config: { authz: { action: 'outputs.write', resource: itemNoteResource, notFound: noteNotFound } },
        schema: {
          tags,
          summary: 'Delete a note of an output item (its author, or an owner/admin)',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await limit(request, 'write');
        await service.deleteItemNote(actor(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/outputs/notes',
      {
        config: {
          authz: {
            action: 'outputs.write',
            resource: bodyProject,
            auditDenied: { action: 'outputs.note.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Create a note card in a project (title, markdown body, tags, https links, pin) — not a context document',
          security: csrf,
          body: NoteCardInput,
          response: { 201: NoteCardBody, ...errors },
        },
      },
      async (request, reply) => {
        await limit(request, 'write');
        return reply.code(201).send(await service.createNote(actor(request), request.body));
      },
    );

    r.get(
      '/outputs/notes/:id',
      {
        config: { authz: { action: 'outputs.read', resource: noteResource, notFound: noteNotFound } },
        schema: {
          tags,
          summary: 'One note card with its full body',
          security: session,
          params: IdParams,
          response: { 200: NoteCardBody, ...errors },
        },
      },
      async (request) => service.note(request.params.id),
    );

    r.patch(
      '/outputs/notes/:id',
      {
        config: { authz: { action: 'outputs.write', resource: noteResource, notFound: noteNotFound } },
        schema: {
          tags,
          summary: 'Change a note card (its author, or an owner/admin)',
          security: csrf,
          params: IdParams,
          body: NoteCardPatch,
          response: { 200: NoteCardBody, ...errors },
        },
      },
      async (request) => {
        await limit(request, 'write');
        return service.updateNote(actor(request), request.params.id, request.body);
      },
    );

    r.delete(
      '/outputs/notes/:id',
      {
        config: { authz: { action: 'outputs.write', resource: noteResource, notFound: noteNotFound } },
        schema: {
          tags,
          summary: 'Delete a note card (its author, or an owner/admin)',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await limit(request, 'write');
        await service.deleteNote(actor(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/outputs/zip',
      {
        config: {
          authz: {
            action: 'outputs.read',
            resource: bodyProject,
            auditDenied: { action: 'outputs.zip', target: () => null },
          },
        },
        bodyLimit: 32 * 1024,
        schema: {
          tags,
          summary: `Download stored files as one ZIP (≤ ${String(LIMITS.zipFilesMax)} files, ≤ ${String(LIMITS.zipBytesMax / (1024 * 1024))} MiB; streamed; includes MANIFEST.txt): selected keys of one project, a node of the automatic tree ({project, tree}) or an own folder with its sub-folders ({folder})`,
          security: csrf,
          body: z.union([
            z.strictObject({
              project: Project,
              keys: z.array(z.string().regex(ITEM_KEY)).min(1).max(LIMITS.zipFilesMax),
            }),
            z.strictObject({ project: Project, tree: z.string().max(400) }),
            z.strictObject({ folder: z.string().regex(UUID) }),
          ]),
        },
      },
      async (request, reply) => {
        await limit(request, 'zip');
        const body = request.body;
        const subject = authzOf(request).subject;
        let plan: ZipPlan;
        let heading: string;
        let auditProject: string | null;
        if ('keys' in body) {
          const p = await service.zipPlan(body.project, body.keys);
          const paths = uniquePaths(p.files.map((f) => zipPath(f.jobId.slice(0, 8), f.name)));
          plan = {
            files: p.files.map((f, i) => ({ ...f, path: paths[i] ?? `file-${String(i)}` })),
            skipped: p.skipped,
            label: body.project,
          };
          heading = `Remyral outputs of project ${body.project}`;
          auditProject = body.project;
        } else {
          if (deps.folders === undefined) throw new HttpError(404, 'folder_not_found', 'Folder not found.');
          if ('tree' in body) {
            plan = await treeZipPlan(deps.db, deps.folders, subject, body.project, body.tree);
            heading = `Remyral outputs of project ${body.project}${body.tree === '' ? '' : ` — ${body.tree}`}`;
            auditProject = body.project;
          } else {
            plan = await folderZipPlan(deps.db, deps.folders, subject, body.folder);
            heading = `Remyral outputs — folder ${plan.label}`;
            auditProject = null;
          }
        }
        const now = new Date();
        const manifest = [
          heading,
          '',
          ...plan.files.map(
            (f) => `${f.path}\tjob ${f.jobId}\t${String(f.sizeBytes)} bytes\tsha256 ${f.sha256}`,
          ),
          ...(plan.skipped.length === 0 ? [] : ['', 'Not included (not a stored file):', ...plan.skipped]),
          '',
        ].join('\n');
        async function* entries() {
          for (const f of plan.files) {
            const data = await service.fileContent(f.jobId, f.artifactId);
            if (data === null) continue; // pruned since the plan; listed in the manifest anyway
            yield { name: f.path, data, modified: f.createdAt };
          }
          yield { name: 'MANIFEST.txt', data: Buffer.from(manifest, 'utf8'), modified: now };
        }
        await service.auditZip(
          actor(request),
          auditProject,
          plan.files.length,
          plan.files.reduce((n, f) => n + f.sizeBytes, 0),
          'keys' in body
            ? undefined
            : 'tree' in body
              ? { tree: body.tree.slice(0, 200) }
              : { folder: body.folder },
        );
        const name = `outputs-${plan.label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-${now.toISOString().slice(0, 10)}.zip`;
        return reply
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${name}"`)
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(Readable.from(zipStream(entries())));
      },
    );

    // ------------------------------------------------------------------------------ site bundle preview
    const jobRule = {
      action: 'jobs.read' as const,
      resource: jobResource(deps.db),
      notFound: () => new HttpError(404, 'not_found', 'Not found.'),
    };
    r.get(
      '/jobs/:id/site-bundle',
      {
        config: { authz: jobRule },
        schema: {
          tags: ['jobs'],
          summary: 'Files of the job’s site bundle (the source of a deployed site) — metadata only',
          security: session,
          params: IdParams,
          response: {
            200: z.object({
              createdAt: z.string(),
              directory: z.string(),
              flagged: z.boolean(),
              removed: z.enum(['retention', 'quota']).nullable(),
              files: z.array(
                z.object({
                  path: z.string(),
                  contentType: z.string(),
                  sizeBytes: z.number().int(),
                  view: z.enum(['html', 'image', 'source', 'none']),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => siteBundleView(deps.db, request.params.id),
    );
    r.get(
      '/jobs/:id/site-bundle/file',
      {
        config: { authz: jobRule },
        schema: {
          tags: ['jobs'],
          summary:
            "One file of the job’s site bundle for preview: HTML only for a sandboxed frame (CSP sandbox, default-src 'none'), raster images, everything else as text/plain",
          security: session,
          params: IdParams,
          querystring: z.object({ path: z.string().min(1).max(300) }),
        },
      },
      async (request, reply) => {
        const f = await siteBundleFile(deps.db, request.params.id, request.query.path);
        const base = request.query.path.split('/').at(-1) ?? 'file';
        const ascii = base.replace(/[^A-Za-z0-9._ ()+-]/g, '_');
        return reply
          .header('content-type', f.contentType)
          .header('content-disposition', `inline; filename="${ascii}"`)
          .header('content-security-policy', f.csp)
          .header('x-content-type-options', 'nosniff')
          .header('cross-origin-resource-policy', 'same-origin')
          .header('referrer-policy', 'no-referrer')
          .send(f.data);
      },
    );
  };
}
