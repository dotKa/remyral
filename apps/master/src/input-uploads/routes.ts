import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { INPUT_BUNDLE_LIMITS } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { authorize } from '../authz/model.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { InputUploadActor, InputUploadService } from './service.js';

/**
 * p16-zip-job-input (ADR-0060): job input bundles — a .zip unpacked in the browser, uploaded in parts (each request
 * ≤ 4 MiB, like site uploads: inside the master's 30 s request limit on a slow uplink), checked by the master and used
 * by jobs of the same project (`POST /jobs inputUpload`, `draft_job inputUpload`). Uploading needs `jobs.create` on the
 * project, reading `jobs.read`. Responses carry metadata only — the bytes reach only the worker of a job that names
 * the bundle (lease-checked relay).
 */

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PART_SHA256_HEADER = 'x-part-sha256';
const ErrorBody = ErrorBodySchema;
const Finding = z.object({ path: z.string(), rule: z.string(), line: z.number().int() });
const RefusedBody = ErrorBody.extend({
  refused: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
  findings: z.array(Finding).optional(),
  total: z.number().int().optional(),
});
const errors = {
  400: RefusedBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  410: ErrorBody,
  413: ErrorBody,
  415: ErrorBody,
  422: RefusedBody,
  429: ErrorBody,
};

const FileView = z.object({ path: z.string(), size: z.number().int(), sha256: z.string() });
export const InputUploadBody = z.object({
  id: z.string(),
  project: z.string(),
  state: z.enum(['receiving', 'ready']),
  label: z.string().nullable(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  partSize: z.number().int(),
  partCount: z.number().int(),
  received: z.array(z.number().int()).nullable(),
  bundleSha256: z.string(),
  uploadedBy: z.object({ id: z.string(), username: z.string().nullable() }),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  keptUntil: z.string().nullable(),
  secretFindings: z.array(Finding),
  sentWithSecrets: z.boolean(),
  files: z.array(FileView).nullable(),
});

const ProjectParams = z.object({ id: z.string().regex(PROJECT) });
const UploadParams = z.object({ id: z.string().regex(PROJECT), uploadId: z.uuid() });

export function inputUploadRoutes(deps: { readonly service: InputUploadService; readonly db: Queryable }) {
  return (app: FastifyInstance): void => {
    // Own encapsulated scope: the raw-bytes parser exists only for these routes.
    void app.register((scope, _opts, done) => {
      const r = scope.withTypeProvider<ZodTypeProvider>();
      const { service } = deps;
      const tags = ['jobs'];
      const session = [{ session: [] }];
      const csrf = [{ session: [], csrf: [] }];
      const actor = (request: FastifyRequest): InputUploadActor => ({
        userId: sessionOf(request).user.id,
        ...requestMeta(request),
      });
      const create = {
        action: 'jobs.create' as const,
        resource: projectParam(),
        notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
      };

      scope.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: INPUT_BUNDLE_LIMITS.partBytes },
        (_req, body, done) => {
          done(null, body);
        },
      );

      r.post(
        '/projects/:id/input-uploads',
        {
          config: {
            authz: {
              ...create,
              auditDenied: { action: 'input.upload.start', target: paramTarget('project') },
            },
          },
          // 2000 entries of path (≤ 300) + size + hash.
          bodyLimit: 1024 * 1024,
          schema: {
            tags,
            summary:
              'Start uploading a job input bundle (a .zip unpacked in the browser): the file list (relative path, size, SHA-256) is checked before any byte is sent (≤ 2000 files, ≤ 25 MiB each, ≤ 100 MiB total, safe paths, no native executables unless the security policy allows them)',
            security: csrf,
            params: ProjectParams,
            body: z.strictObject({
              files: z
                .array(
                  z.strictObject({
                    path: z.string().max(400),
                    size: z.number().int().min(0),
                    sha256: z.string().max(64),
                  }),
                )
                .min(1)
                .max(INPUT_BUNDLE_LIMITS.maxFiles),
              label: z.string().max(200).nullable().optional(),
              partSize: z.number().int().optional(),
            }),
            response: { 201: InputUploadBody, ...errors },
          },
        },
        async (req, reply) => reply.code(201).send(await service.start(actor(req), req.params.id, req.body)),
      );

      r.get(
        '/projects/:id/input-uploads',
        {
          config: { authz: { action: 'jobs.read', resource: projectParam() } },
          schema: {
            tags,
            summary: 'Job input bundles of a project that jobs can use (metadata only; never the content)',
            security: session,
            params: ProjectParams,
            response: { 200: z.object({ items: z.array(InputUploadBody) }), ...errors },
          },
        },
        async (req) => ({ items: await service.list(req.params.id) }),
      );

      r.get(
        '/projects/:id/input-uploads/:uploadId',
        {
          config: { authz: { action: 'jobs.read', resource: projectParam() } },
          schema: {
            tags,
            summary:
              'One job input bundle: file list (path, size, SHA-256), state, secret findings sent anyway, the parts received (to resume)',
            security: session,
            params: UploadParams,
            response: { 200: InputUploadBody, ...errors },
          },
        },
        async (req) => service.get(req.params.id, req.params.uploadId),
      );

      r.put(
        '/projects/:id/input-uploads/:uploadId/parts/:n',
        {
          config: { authz: create },
          bodyLimit: INPUT_BUNDLE_LIMITS.partBytes,
          schema: {
            tags,
            summary:
              'Store part n (0-based) of a job input bundle upload of the caller: application/octet-stream body (≤ 4 MiB), X-Part-SHA256 header; a retry overwrites',
            security: csrf,
            params: UploadParams.extend({ n: z.coerce.number().int().min(0).max(10_000) }),
            response: {
              200: z.object({
                n: z.number().int(),
                received: z.number().int(),
                partCount: z.number().int(),
                expiresAt: z.string(),
              }),
              ...errors,
            },
          },
        },
        async (req) => {
          const body: unknown = req.body;
          if (!Buffer.isBuffer(body)) {
            throw new HttpError(
              400,
              'invalid_request',
              'The part must be sent as application/octet-stream.',
              {},
              {},
              { reason: 'octet_stream' },
            );
          }
          const h = req.headers[PART_SHA256_HEADER];
          const sha = (Array.isArray(h) ? h[0] : h)?.toLowerCase() ?? '';
          return service.putPart(actor(req), req.params.id, req.params.uploadId, req.params.n, body, sha);
        },
      );

      r.post(
        '/projects/:id/input-uploads/:uploadId/complete',
        {
          config: {
            authz: {
              ...create,
              auditDenied: {
                action: 'input.upload.complete',
                target: paramTarget('input-upload', 'uploadId'),
              },
            },
          },
          schema: {
            tags,
            summary:
              'Finish a job input bundle upload: check every file (SHA-256, executables, secret scan of text files). Secret findings answer 422 input_secrets_found (file, rule, line; the parts are kept) unless allowSecrets: true ("send anyway", audited)',
            security: csrf,
            params: UploadParams,
            body: z.strictObject({ allowSecrets: z.boolean().optional() }).optional(),
            response: { 200: InputUploadBody, ...errors },
          },
        },
        async (req) =>
          service.complete(actor(req), req.params.id, req.params.uploadId, {
            allowSecrets: req.body?.allowSecrets === true,
          }),
      );

      r.delete(
        '/projects/:id/input-uploads/:uploadId',
        {
          config: { authz: create },
          schema: {
            tags,
            summary: 'Delete a job input bundle (its uploader, or a project admin); jobs keep their facts',
            security: csrf,
            params: UploadParams,
            response: { 204: z.null(), ...errors },
          },
        },
        async (req, reply) => {
          // A project admin (the role 'policy.read' needs) may delete anyone's bundle.
          const admin = authorize(authzOf(req).subject, 'policy.read', { project: req.params.id }).allow;
          await service.remove(actor(req), req.params.id, req.params.uploadId, admin);
          return reply.code(204).send(null);
        },
      );

      r.get(
        '/jobs/:id/input-upload',
        {
          config: {
            authz: {
              action: 'jobs.read',
              resource: jobResource(deps.db),
              notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            },
          },
          schema: {
            tags,
            summary:
              'The input bundle a job started with: its facts (kept after the bundle was pruned), whether it is still kept (a follow-up may reuse it) and its files',
            security: session,
            params: z.object({ id: z.string().regex(UUID) }),
            response: {
              200: z.object({
                inputUpload: z
                  .object({
                    sourceId: z.string(),
                    label: z.string().nullable(),
                    fileCount: z.number().int(),
                    totalBytes: z.number().int(),
                    attachedAt: z.string(),
                    pulledAt: z.string().nullable(),
                    kept: z.boolean(),
                    upload: InputUploadBody.nullable(),
                  })
                  .nullable(),
              }),
              ...errors,
            },
          },
        },
        async (req) => ({ inputUpload: await service.forJob(req.params.id) }),
      );
      done();
    });
  };
}
