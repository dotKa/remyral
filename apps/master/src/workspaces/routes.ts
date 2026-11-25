import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  INLINE_MEDIA_TYPES,
  MAX_ALLOW_HOSTS,
  OUTPUT_LIMITS,
  OutputSkipCode,
  WorkspaceEgress,
} from '@remyral/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { Readable } from 'node:stream';
import { blobs } from '../blobs/registry.js';
import { BlobUnavailableError } from '../blobs/store.js';
import {
  ARCHIVE_MAX_ENTRIES,
  ARTIFACT_PAGE,
  type StoredFile,
  type WorkspaceService,
  type WorkspaceSettings,
} from './service.js';
import { ARCHIVE_MAX_BYTES, streamArchive } from './archive.js';
import { PROJECT_JOB_BYTES } from './output-limits.js';
import { QUOTA_BYTES, RETENTION_DAYS } from './storage.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const UsageBody = z.object({
  bytes: z.number().int(),
  files: z.number().int(),
  artifactBytes: z.number().int(),
  artifactFiles: z.number().int(),
  inputBytes: z.number().int(),
  inputFiles: z.number().int(),
  prunedFiles: z.number().int(),
  oldestAt: z.string().nullable(),
});

const SettingsBody = z.object({
  project: z.string(),
  kind: z.literal('workspace'),
  egress: WorkspaceEgress,
  allowHosts: z.array(z.string()),
  /** p5-research-workspace-next: storage policy (null: none) and current usage. */
  artifactRetentionDays: z.number().int().nullable(),
  storageQuotaBytes: z.number().int().nullable(),
  /** p17-output-limits: the project's lower output limits (null: the server's) and what applies. */
  outputMaxFiles: z.number().int().nullable(),
  outputMaxJobBytes: z.number().int().nullable(),
  outputLimits: z
    .object({
      server: z.object({
        maxFiles: z.number().int(),
        maxJobBytes: z.number().int(),
        maxFileBytes: z.number().int(),
        thresholdBytes: z.number().int(),
        storage: z.enum(['local', 's3', 'unavailable']),
      }),
      effectiveMaxFiles: z.number().int(),
      effectiveMaxJobBytes: z.number().int(),
      ceilingMaxFiles: z.number().int(),
      ceilingJobBytes: z.number().int(),
      inlineFileBytes: z.number().int(),
      inlineTotalBytes: z.number().int(),
    })
    .nullable(),
  usage: UsageBody,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const ArtifactBody = z.object({
  id: z.string(),
  attemptId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  kind: z.enum(['output', 'summary']),
  redacted: z.boolean(),
  createdAt: z.string(),
  prunedAt: z.string().nullable(),
  prunedReason: z.enum(['retention', 'quota']).nullable(),
});
const InputBody = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  source: z.enum(['upload', 'artifact', 'upstream', 'subtask']),
  sourceJobId: z.string().nullable(),
  prunedAt: z.string().nullable(),
  prunedReason: z.enum(['retention', 'quota']).nullable(),
});

/** p18-outputs-delivery: what GET /jobs/:id/artifacts/all.zip holds. */
const ArchiveInfoBody = z.object({
  files: z.number().int(),
  bytes: z.number().int(),
  unpacked: z.object({ name: z.string(), files: z.number().int() }).nullable(),
  removed: z.number().int(),
});

/** p17-output-limits: GET /jobs/:id/output-report. */
const ReportBody = z.object({
  attemptId: z.string(),
  maxFiles: z.number().int().nullable(),
  returned: z.number().int().nullable(),
  storage: z.boolean().nullable(),
  zip: z.object({ name: z.string(), files: z.number().int(), bytes: z.number().int() }).nullable(),
  skipped: z.array(
    z.object({
      name: z.string(),
      code: z.union([OutputSkipCode, z.literal('quota')]),
      reason: z.string(),
    }),
  ),
  skippedCount: z.number().int(),
});

function settingsJson(s: WorkspaceSettings): z.infer<typeof SettingsBody> {
  return {
    project: s.project,
    kind: s.kind,
    egress: s.egress,
    allowHosts: [...s.allowHosts],
    artifactRetentionDays: s.artifactRetentionDays,
    storageQuotaBytes: s.storageQuotaBytes,
    outputMaxFiles: s.outputMaxFiles,
    outputMaxJobBytes: s.outputMaxJobBytes,
    outputLimits:
      s.outputLimits === null
        ? null
        : {
            server: { ...s.outputLimits.server },
            effectiveMaxFiles: s.outputLimits.effectiveMaxFiles,
            effectiveMaxJobBytes: s.outputLimits.effectiveMaxJobBytes,
            ceilingMaxFiles: OUTPUT_LIMITS.ceilingMaxFiles,
            ceilingJobBytes: PROJECT_JOB_BYTES.max,
            inlineFileBytes: OUTPUT_LIMITS.inlineFileBytes,
            inlineTotalBytes: OUTPUT_LIMITS.inlineTotalBytes,
          },
    usage: { ...s.usage, oldestAt: s.usage.oldestAt?.toISOString() ?? null },
    updatedAt: s.updatedAt?.toISOString() ?? null,
    updatedBy: s.updatedBy,
  };
}

/** Previews are read whole from the blob store up to this size (larger files are streamed as attachments). */
const INLINE_READ_MAX = 32 * 1024 * 1024;

/** RFC 6266 filename: ASCII fallback plus the UTF-8 form. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const base = name.split('/').at(-1) ?? 'file';
  const ascii = base.replace(/[^A-Za-z0-9._ ()+-]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/**
 * Untrusted bytes produced by an agent or uploaded by a user: never rendered by the browser as a document of
 * the console's origin. `inline` only for allowlisted text and raster image types, always with a sandbox CSP
 * and nosniff (docs/design/p5-research-workspace.md §5).
 */
async function sendFile(reply: FastifyReply, file: StoredFile, inline: boolean): Promise<FastifyReply> {
  if (file.content === null && file.blobKey === null) {
    // p5-research-workspace-next: pruned by the workspace's retention or storage quota; the metadata stays.
    throw new HttpError(
      410,
      'file_removed',
      file.prunedReason === 'quota'
        ? 'This file was removed to keep the workspace within its storage quota.'
        : 'This file was removed by the workspace retention policy.',
      {},
      {},
      { reason: file.prunedReason === 'quota' ? 'quota' : 'retention' },
    );
  }
  // p6-outputs: a PDF (magic bytes checked when it was stored) may be shown inline by the browser's own PDF viewer
  // in a same-origin frame of the console. Browsers refuse to run their PDF viewer in a sandboxed document, so the
  // PDF gets no `sandbox` directive, only `default-src 'none'` (docs/design/p6-outputs.md §5).
  const pdf = inline && file.mediaType === 'application/pdf';
  const canInline = pdf || (inline && INLINE_MEDIA_TYPES.has(file.mediaType));
  const type = file.mediaType.startsWith('text/') ? `${file.mediaType}; charset=utf-8` : file.mediaType;
  // p17-object-storage: the bytes come from the blob store — read whole for a preview (bounded), streamed otherwise.
  let body: Buffer | Readable;
  try {
    if (file.content !== null) body = file.content;
    else if (canInline && file.sizeBytes <= INLINE_READ_MAX)
      body = await blobs().read(file.blobKey ?? '', INLINE_READ_MAX);
    else {
      const s = await blobs().stream(file.blobKey ?? '');
      body = s.stream;
      void reply.header('content-length', String(s.size));
    }
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      throw new HttpError(
        err.reason === 'not_found' ? 410 : 503,
        err.reason === 'not_found' ? 'file_missing' : 'storage_unavailable',
        err.message,
      );
    }
    throw err;
  }
  return reply
    .header('content-type', type)
    .header('content-disposition', disposition(canInline ? 'inline' : 'attachment', file.name))
    .header(
      'content-security-policy',
      pdf
        ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'"
        : "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    )
    .header('x-content-type-options', 'nosniff')
    .header('cross-origin-resource-policy', 'same-origin')
    .send(body);
}

/**
 * Workspace settings and job artifacts (docs/design/p5-research-workspace.md §2). Settings: read by project
 * viewers, changed by admins with step-up (audited). Artifacts and inputs: `jobs.read` on the job's project.
 */
export function workspaceRoutes(deps: {
  readonly service: WorkspaceService;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = (): HttpError => new HttpError(404, 'not_found', 'Not found.');

    r.get(
      '/projects/:id/workspace',
      {
        config: { authz: { action: 'projects.workspace.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'Workspace settings of a workspace project: egress policy, file retention, storage quota and current usage',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => settingsJson(await deps.service.get(request.params.id)),
    );

    r.put(
      '/projects/:id/workspace',
      {
        config: {
          authz: {
            action: 'projects.workspace.write',
            resource: projectParam(),
            auditDenied: { action: 'project.workspace.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags: ['projects'],
          summary:
            "Change a workspace's settings (admin, step-up): egress none (model APIs only), allowlist (+ allowHosts) or web (+ any public HTTPS host); artifactRetentionDays and storageQuotaBytes (null: none; omitted: unchanged); outputMaxFiles / outputMaxJobBytes lower the server's output limits for this project (null: the server's; never above it)",
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.object({
            egress: WorkspaceEgress,
            allowHosts: z.array(z.string().max(260)).max(MAX_ALLOW_HOSTS).optional(),
            artifactRetentionDays: z
              .number()
              .int()
              .min(RETENTION_DAYS.min)
              .max(RETENTION_DAYS.max)
              .nullable()
              .optional(),
            storageQuotaBytes: z
              .number()
              .int()
              .min(QUOTA_BYTES.min)
              .max(QUOTA_BYTES.max)
              .nullable()
              .optional(),
            outputMaxFiles: z.number().int().min(1).max(OUTPUT_LIMITS.ceilingMaxFiles).nullable().optional(),
            outputMaxJobBytes: z
              .number()
              .int()
              .min(PROJECT_JOB_BYTES.min)
              .max(PROJECT_JOB_BYTES.max)
              .nullable()
              .optional(),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const saved = await deps.service.put(
          request.params.id,
          request.body,
          { id: sessionOf(request).user.id },
          requestMeta(request),
        );
        return settingsJson(saved);
      },
    );

    r.get(
      '/jobs/:id/artifacts',
      {
        config: {
          authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Artifacts and input files of a (workspace) job — metadata only; artifacts paged (`limit` ≤ 1000, `offset`; newest attempt first) with their `total`, filtered by a file-name substring `q`; `archive`: what "all.zip" holds (files, bytes, the overflow zip unpacked)',
          security: session,
          params: z.object({ id: z.uuid() }),
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(ARTIFACT_PAGE.max).optional(),
            offset: z.coerce.number().int().min(0).max(100_000).optional(),
            q: z.string().max(200).optional(),
          }),
          response: {
            200: z.object({
              artifacts: z.array(ArtifactBody),
              inputs: z.array(InputBody),
              total: z.number().int(),
              archive: ArchiveInfoBody.nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const [list, archive] = await Promise.all([
          deps.service.listArtifacts(request.params.id, {
            ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
            ...(request.query.offset === undefined ? {} : { offset: request.query.offset }),
            ...(request.query.q === undefined ? {} : { q: request.query.q }),
          }),
          deps.service.archiveInfo(request.params.id),
        ]);
        return {
          total: list.total,
          archive:
            archive === null
              ? null
              : { ...archive, unpacked: archive.unpacked === null ? null : { ...archive.unpacked } },
          artifacts: list.artifacts.map((a) => ({
            ...a,
            createdAt: a.createdAt.toISOString(),
            prunedAt: a.prunedAt?.toISOString() ?? null,
          })),
          inputs: list.inputs.map((i) => ({ ...i, prunedAt: i.prunedAt?.toISOString() ?? null })),
        };
      },
    );

    r.get(
      '/jobs/:id/output-report',
      {
        config: {
          authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['jobs'],
          summary:
            "What became of a workspace job's out/ (latest attempt): files returned, the overflow zip, files not returned with a reason code (the worker's and the master's refusals)",
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ report: ReportBody.nullable() }), ...errors },
        },
      },
      async (request) => {
        const report = await deps.service.outputReport(request.params.id);
        return {
          report:
            report === null
              ? null
              : {
                  ...report,
                  zip: report.zip === null ? null : { ...report.zip },
                  skipped: [...report.skipped],
                },
        };
      },
    );

    r.get(
      '/jobs/:id/artifacts/all.zip',
      {
        config: {
          authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['jobs'],
          summary:
            "All files of the job's latest attempt as one zip, streamed from the store (attachment): the files stored one by one, the overflow zip's files unpacked at their paths, the summary as _summary.md, removed files named in _removed-files.txt",
          security: session,
          params: z.object({ id: z.uuid() }),
        },
      },
      async (request, reply) => {
        const plan = await deps.service.fullArchive(request.params.id, blobs(), (err) => {
          request.log.warn({ err, jobId: request.params.id }, 'overflow zip not unpacked; included as it is');
        });
        if (plan === null) throw notFound();
        if (plan.sources.length > ARCHIVE_MAX_ENTRIES || plan.archiveBytes > ARCHIVE_MAX_BYTES) {
          throw new HttpError(
            413,
            'archive_too_large',
            'These files are too many or too large for one zip; download them one by one.',
            {},
            {},
            { files: plan.sources.length, bytes: plan.archiveBytes },
          );
        }
        const body = streamArchive(plan.sources, deps.clock(), plan.close);
        body.on('error', (err) => {
          request.log.warn({ err, jobId: request.params.id }, 'archive stream ended early');
        });
        return reply
          .header('content-type', 'application/zip')
          .header(
            'content-disposition',
            disposition('attachment', `job-${request.params.id.slice(0, 8)}.zip`),
          )
          .header('x-content-type-options', 'nosniff')
          .header('cross-origin-resource-policy', 'same-origin')
          .header('cache-control', 'no-store')
          .send(body);
      },
    );

    r.get(
      '/jobs/:id/artifacts/:artifactId',
      {
        config: {
          authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Content of an artifact (attachment; `inline=1` only for text and raster images, with a sandbox CSP, and PDF for the browser viewer)',
          security: session,
          params: z.object({ id: z.uuid(), artifactId: z.string().regex(/^ws-[a-z0-9-]{1,100}$/) }),
          querystring: z.object({ inline: z.enum(['0', '1']).optional() }),
        },
      },
      async (request, reply) => {
        const file = await deps.service.artifactContent(request.params.id, request.params.artifactId);
        if (file === null) throw notFound();
        return sendFile(reply, file, request.query.inline === '1');
      },
    );

    r.get(
      '/jobs/:id/inputs/:inputId',
      {
        config: {
          authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['jobs'],
          summary: 'Content of an input file of a workspace job (attachment)',
          security: session,
          params: z.object({ id: z.uuid(), inputId: z.string().regex(/^in-[a-z0-9]{1,32}$/) }),
        },
      },
      async (request, reply) => {
        const file = await deps.service.inputContent(request.params.id, request.params.inputId);
        if (file === null) throw notFound();
        return sendFile(reply, file, false);
      },
    );
  };
}
