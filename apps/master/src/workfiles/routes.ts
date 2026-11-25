import { Readable } from 'node:stream';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { isWorkfilePath, WORKFILES_LIMITS } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { jobResource, projectParam, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { zipStream } from '../outputs/zip.js';
import type { WorkfilesExport } from './export.js';
import { disposition, previewOf, servedAs } from './files.js';
import type { WorkfilesActor, WorkfilesService, WorkfilesView } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  410: ErrorBody,
  413: ErrorBody,
  422: ErrorBody,
  502: ErrorBody,
  503: ErrorBody,
  504: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

export const WorkfilesBody = z.object({
  jobId: z.string(),
  attemptId: z.string(),
  project: z.string(),
  jobTitle: z.string().nullable(),
  jobState: z.string().nullable(),
  workerId: z.string(),
  workerName: z.string().nullable(),
  workerConnected: z.boolean(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  state: z.enum(['kept', 'deleting', 'deleted', 'lost']),
  sizeBytes: z.number(),
  files: z.number().int(),
  dropped: z.number().int(),
  redacted: z.number().int(),
  keptAt: z.string(),
  expiresAt: z.string(),
  pinnedUntil: z.string().nullable(),
  pinReason: z.string().nullable(),
  deleteReason: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const Entry = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir', 'other']),
  size: z.number(),
  mtime: z.string(),
  preview: z.enum(['html', 'image', 'pdf', 'markdown', 'json', 'csv', 'tsv', 'text', 'none']),
});

const SettingsBody = z.object({
  retentionDays: z.number().int(),
  machineCapBytes: z.number(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  limits: z.object({
    retentionDaysMax: z.number().int(),
    machineCapBytesMin: z.number(),
    machineCapBytesMax: z.number(),
  }),
});

const ExportBody = z.strictObject({
  project: z.string().regex(PROJECT),
  directory: z.string().max(512).optional(),
  targetPath: z.string().max(512).optional(),
  branch: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  newRepository: z
    .strictObject({
      name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
      owner: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
        .optional(),
      private: z.boolean().optional(),
    })
    .optional(),
});

const limits = {
  retentionDaysMax: WORKFILES_LIMITS.retentionDaysMax,
  machineCapBytesMin: WORKFILES_LIMITS.machineCapBytesMin,
  machineCapBytesMax: WORKFILES_LIMITS.machineCapBytesMax,
};

/**
 * p15-workspace-retention: "Çalışma dosyaları" REST — the kept working directories of workspace jobs (list per project
 * / machine, one job's record, its file tree, a file (preview or download), a zip of all), clean-up (one job, a machine
 * or a project), "Repoya aktar" and a site upload from them, and the retention settings. Reads need `workfiles.read`
 * on the job's project (viewer), changes `workfiles.manage` (operator), the settings `workfiles.settings` (admin).
 * Bytes stream from the machine through the master; nothing is stored on the master.
 */
export function workfilesRoutes(deps: {
  readonly service: WorkfilesService;
  readonly exporter: WorkfilesExport;
  readonly db: Queryable;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['workfiles'];
    const actor = (request: FastifyRequest): WorkfilesActor => {
      const s = sessionOf(request);
      const meta = requestMeta(request);
      return { subject: authzOf(request).subject, userId: s.user.id, ip: meta.ip, userAgent: meta.userAgent };
    };
    const JobParams = z.object({ id: z.string().regex(UUID) });
    const notFound = () => new HttpError(404, 'job_not_found', 'Job not found.');
    const jobRead = { action: 'workfiles.read' as const, resource: jobResource(deps.db), notFound };
    const jobManage = { action: 'workfiles.manage' as const, resource: jobResource(deps.db), notFound };
    const view = (v: WorkfilesView): z.infer<typeof WorkfilesBody> => ({ ...v });

    r.get(
      '/workfiles',
      {
        config: { authz: { action: 'workfiles.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'Kept working directories of workspace jobs the caller can see (per project / machine)',
          security: session,
          querystring: z.object({
            project: z.string().regex(PROJECT).optional(),
            worker: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
              .optional(),
            state: z.enum(['kept', 'all']).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(WorkfilesBody),
              totals: z.object({ bytes: z.number(), count: z.number().int() }),
              settings: z.object({ retentionDays: z.number().int(), machineCapBytes: z.number() }),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await service.list(authzOf(request).subject, request.query);
        const s = await service.settings();
        return {
          items: out.items.map(view),
          totals: out.totals,
          settings: { retentionDays: s.retentionDays, machineCapBytes: s.machineCapBytes },
        };
      },
    );

    r.get(
      '/jobs/:id/workfiles',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary: 'The kept working directory of a job (newest attempt) and what still needs it',
          security: session,
          params: JobParams,
          response: {
            200: z.object({
              workfiles: WorkfilesBody.nullable(),
              pins: z.array(z.object({ kind: z.string(), ref: z.string() })),
              retentionDays: z.number().int(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const subject = authzOf(request).subject;
        const project = await service.projectOfJob(request.params.id);
        const retentionDays = project === null ? 0 : await service.retentionFor(project);
        try {
          const v = await service.forJob(subject, request.params.id);
          const pins = v.state === 'kept' ? await service.pins(v.jobId, v.attemptId) : [];
          return { workfiles: view(v), pins: pins.map((p) => ({ ...p })), retentionDays };
        } catch (err) {
          if (err instanceof HttpError && err.code === 'workfiles_not_found') {
            return { workfiles: null, pins: [], retentionDays };
          }
          throw err;
        }
      },
    );

    r.get(
      '/jobs/:id/workfiles/tree',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary: 'The file tree of a job’s kept working directory (read from its machine)',
          security: session,
          params: JobParams,
          response: {
            200: z.object({ workfiles: WorkfilesBody, entries: z.array(Entry), truncated: z.boolean() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const t = await service.tree(authzOf(request).subject, request.params.id);
        return {
          workfiles: view(t.workfiles),
          entries: t.entries.map((e) => ({
            ...e,
            preview: e.kind === 'file' ? previewOf(e.path) : ('none' as const),
          })),
          truncated: t.truncated,
        };
      },
    );

    r.get(
      '/jobs/:id/workfiles/file',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            'One kept file, streamed from its machine (attachment; `inline=1` only for text as text/plain, raster images and PDFs by their magic bytes, HTML for a sandboxed frame)',
          security: session,
          params: JobParams,
          querystring: z.object({
            path: z.string().min(1).max(WORKFILES_LIMITS.pathMax),
            inline: z.enum(['0', '1']).optional(),
          }),
        },
      },
      async (request, reply) => {
        const path = request.query.path;
        if (!isWorkfilePath(path)) throw new HttpError(404, 'file_not_found', 'File not found.');
        const f = await service.open(authzOf(request).subject, request.params.id, path);
        const as = servedAs(path, f.first);
        const inline = request.query.inline === '1' && as.inline;
        const body = Readable.from(
          (async function* () {
            yield f.first;
            yield* f.rest();
          })(),
        );
        return reply
          .header(
            'content-type',
            inline
              ? as.contentType
              : as.contentType.startsWith('text/html')
                ? 'application/octet-stream'
                : as.contentType,
          )
          .header('content-length', String(f.size))
          .header('content-disposition', disposition(inline ? 'inline' : 'attachment', path))
          .header('content-security-policy', as.csp)
          .header('x-content-type-options', 'nosniff')
          .header('cross-origin-resource-policy', 'same-origin')
          .header('referrer-policy', 'no-referrer')
          .header('cache-control', 'private, no-store')
          .send(body);
      },
    );

    r.get(
      '/jobs/:id/workfiles/zip',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary: 'All kept files of a job as one zip, streamed from its machine (bounded)',
          security: session,
          params: JobParams,
        },
      },
      async (request, reply) => {
        const z0 = await service.zipEntries(authzOf(request).subject, request.params.id);
        const name = `job-${request.params.id.slice(0, 8)}-files.zip`;
        return reply
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${name}"`)
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('cache-control', 'private, no-store')
          .send(Readable.from(zipStream(z0.entries)));
      },
    );

    r.delete(
      '/jobs/:id/workfiles',
      {
        config: { authz: jobManage },
        schema: {
          tags,
          summary:
            '"Temizle": remove a job’s kept working directory from its machine (refused while something needs it)',
          security: csrf,
          params: JobParams,
          response: { 200: z.object({ workfiles: WorkfilesBody }), ...errors },
        },
      },
      async (request) => ({ workfiles: view(await service.remove(actor(request), request.params.id)) }),
    );

    r.post(
      '/workfiles/cleanup',
      {
        config: {
          authz: {
            action: 'workfiles.manage',
            resource: (request: FastifyRequest) => {
              const p = (request.body as { project?: unknown } | undefined)?.project;
              return typeof p === 'string' ? (PROJECT.test(p) ? { project: p } : null) : undefined;
            },
          },
        },
        schema: {
          tags,
          summary:
            'Bulk clean-up of kept working directories of a machine or a project (pinned ones are skipped)',
          security: csrf,
          body: z
            .strictObject({
              worker: z
                .string()
                .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
                .optional(),
              project: z.string().regex(PROJECT).optional(),
            })
            .refine((b) => b.worker !== undefined || b.project !== undefined, 'worker or project'),
          response: {
            200: z.object({
              removed: z.number().int(),
              bytes: z.number(),
              pending: z.number().int(),
              skipped: z.array(z.object({ jobId: z.string(), reasons: z.string() })),
            }),
            ...errors,
          },
        },
      },
      async (request) => service.cleanup(actor(request), request.body),
    );

    r.post(
      '/jobs/:id/workfiles/export',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            '"Repoya aktar": push the kept files to a project’s repository as a new branch + pull request, or open a new private repository for them',
          security: csrf,
          params: JobParams,
          body: ExportBody,
          response: {
            200: z.object({
              export: z.object({
                id: z.string(),
                mode: z.enum(['branch_pr', 'new_repo']),
                project: z.string(),
                branch: z.string(),
                commit: z.string(),
                files: z.number().int(),
                bytes: z.number(),
                skipped: z.number().int(),
                pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
                repository: z.object({ fullName: z.string(), htmlUrl: z.string() }).nullable(),
              }),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({
        export: await deps.exporter.toRepository(actor(request), request.params.id, request.body, 'api'),
      }),
    );

    r.post(
      '/jobs/:id/workfiles/site-upload',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            'Deploy retry without regenerating: the kept files below a directory as a ready site upload',
          security: csrf,
          params: JobParams,
          body: z.strictObject({
            project: z.string().regex(PROJECT),
            directory: z.string().max(512).optional(),
            label: z.string().max(200).optional(),
          }),
          response: {
            200: z.object({
              upload: z.object({
                id: z.string(),
                uploadId: z.string(),
                project: z.string(),
                files: z.number().int(),
                bytes: z.number(),
                skipped: z.number().int(),
              }),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({
        upload: await deps.exporter.toSiteUpload(actor(request), request.params.id, request.body),
      }),
    );

    const ProjectPolicy = z.object({
      project: z.string(),
      retentionDays: z.number().int().nullable(),
      effectiveDays: z.number().int(),
      globalDays: z.number().int(),
    });

    r.get(
      '/projects/:id/workfiles',
      {
        config: { authz: { action: 'workfiles.read', resource: projectParam() } },
        schema: {
          tags,
          summary: 'A workspace project’s own retention of kept working directories (null: the global one)',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: { 200: ProjectPolicy, ...errors },
        },
      },
      async (request) => service.projectPolicy(request.params.id),
    );

    r.put(
      '/projects/:id/workfiles',
      {
        config: { authz: { action: 'projects.workspace.write', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'Set a workspace project’s own retention (days, 0 = delete at the end; null = the global one; audited)',
          security: csrf,
          params: z.object({ id: z.string().regex(PROJECT) }),
          body: z.strictObject({
            retentionDays: z.number().int().min(0).max(WORKFILES_LIMITS.retentionDaysMax).nullable(),
          }),
          response: { 200: ProjectPolicy, ...errors },
        },
      },
      async (request) =>
        service.setProjectRetention(actor(request), request.params.id, request.body.retentionDays),
    );

    r.get(
      '/settings/workfiles',
      {
        config: { authz: { action: 'workfiles.read' } },
        schema: {
          tags,
          summary: 'How long kept working directories stay and the per-machine cap',
          security: session,
          response: { 200: SettingsBody, ...errors },
        },
      },
      async () => ({ ...(await service.settings()), limits }),
    );

    r.put(
      '/settings/workfiles',
      {
        config: { authz: { action: 'workfiles.settings' } },
        schema: {
          tags,
          summary:
            'Change the retention (days; 0 = delete at the end) and the per-machine cap (admin, audited)',
          security: csrf,
          body: z.strictObject({
            retentionDays: z.number().int().min(0).max(WORKFILES_LIMITS.retentionDaysMax).optional(),
            machineCapBytes: z
              .number()
              .int()
              .min(WORKFILES_LIMITS.machineCapBytesMin)
              .max(WORKFILES_LIMITS.machineCapBytesMax)
              .optional(),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => ({ ...(await service.updateSettings(actor(request), request.body)), limits }),
    );
  };
}
