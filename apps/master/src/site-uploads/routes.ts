import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { SITE_UPLOAD_LIMITS } from '@remyral/protocol/site-files';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { authorize } from '../authz/model.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { SiteUploadActor, SiteUploadService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * p10-site-upload (ADR-0037): Project → Deploy → "Upload a site". Chunked and resumable like the release upload
 * (each request ≤ 4 MiB: well inside the master's 30 s request time limit, Traefik's and Cloudflare's 100 MB proxy
 * limit even on a slow residential uplink). Every route is project-scoped; uploading needs `deploy.request` (the
 * right to request a Pages deploy in that project), reading `deploy.read`. Responses carry metadata only — the
 * uploaded bytes are never served back by the console.
 */

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const PART_SHA256_HEADER = 'x-part-sha256';
const ErrorBody = ErrorBodySchema;
const RefusedBody = ErrorBody.extend({
  refused: z
    .array(
      z.object({
        path: z.string(),
        reason: z.string(),
        rule: z.string().optional(),
        line: z.number().int().optional(),
      }),
    )
    .optional(),
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

const FileView = z.object({
  path: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  contentType: z.string(),
});
const UploadView = z.object({
  id: z.string(),
  project: z.string(),
  state: z.enum(['receiving', 'ready']),
  label: z.string().nullable(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  partSize: z.number().int(),
  partCount: z.number().int(),
  received: z.array(z.number().int()).nullable(),
  siteSha256: z.string(),
  uploadedBy: z.object({ id: z.string(), username: z.string().nullable() }),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastDeployedAt: z.string().nullable(),
  lastActionId: z.string().nullable(),
  files: z.array(FileView).nullable(),
});

const ProjectParams = z.object({ id: z.string().regex(PROJECT) });
const UploadParams = z.object({ id: z.string().regex(PROJECT), uploadId: z.uuid() });

export function siteUploadRoutes(deps: { readonly service: SiteUploadService }) {
  return (app: FastifyInstance): void => {
    // Own encapsulated scope: the raw-bytes parser exists only for these routes (the rest of the API stays JSON).
    void app.register((scope, _opts, done) => {
      const r = scope.withTypeProvider<ZodTypeProvider>();
      const { service } = deps;
      const tags = ['deploy'];
      const session = [{ session: [] }];
      const csrf = [{ session: [], csrf: [] }];
      const actor = (request: FastifyRequest): SiteUploadActor => ({
        userId: sessionOf(request).user.id,
        ...requestMeta(request),
      });
      const request = {
        action: 'deploy.request' as const,
        resource: projectParam(),
        notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
      };

      scope.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: SITE_UPLOAD_LIMITS.partBytes },
        (_req, body, done) => {
          done(null, body);
        },
      );

      r.post(
        '/projects/:id/site-uploads',
        {
          config: {
            authz: {
              ...request,
              auditDenied: { action: 'site.upload.start', target: paramTarget('project') },
            },
          },
          // 500 entries of path (≤ 300) + size + hash.
          bodyLimit: 256 * 1024,
          schema: {
            tags,
            summary:
              'Start uploading a static site for a Pages deploy: the file list (relative path, size, SHA-256) is checked before any byte is sent (site types incl. mp4/webm, ≤ 500 files, ≤ 25 MiB each, ≤ 50 MiB total, index.html at the root)',
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
                .max(2000),
              label: z.string().max(200).nullable().optional(),
              partSize: z.number().int().optional(),
            }),
            response: { 201: UploadView, ...errors },
          },
        },
        async (req, reply) => {
          const out = await service.start(actor(req), req.params.id, req.body);
          return reply.code(201).send(out);
        },
      );

      r.get(
        '/projects/:id/site-uploads',
        {
          config: { authz: { action: 'deploy.read', resource: projectParam() } },
          schema: {
            tags,
            summary:
              'Uploaded sites of a project that are ready to deploy (metadata only; never the content)',
            security: session,
            params: ProjectParams,
            response: { 200: z.object({ items: z.array(UploadView) }), ...errors },
          },
        },
        async (req) => ({ items: await service.list(req.params.id) }),
      );

      r.get(
        '/projects/:id/site-uploads/:uploadId',
        {
          config: { authz: { action: 'deploy.read', resource: projectParam() } },
          schema: {
            tags,
            summary:
              'One uploaded site: file list (path, size, SHA-256, type), state and the parts received (to resume)',
            security: session,
            params: UploadParams,
            response: { 200: UploadView, ...errors },
          },
        },
        async (req) => service.get(req.params.id, req.params.uploadId),
      );

      r.put(
        '/projects/:id/site-uploads/:uploadId/parts/:n',
        {
          config: { authz: request },
          bodyLimit: SITE_UPLOAD_LIMITS.partBytes,
          schema: {
            tags,
            summary:
              'Store part n (0-based) of a site upload of the caller: application/octet-stream body (≤ 4 MiB), X-Part-SHA256 header; a retry overwrites',
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
        '/projects/:id/site-uploads/:uploadId/complete',
        {
          config: {
            authz: {
              ...request,
              auditDenied: { action: 'site.upload.complete', target: paramTarget('site-upload', 'uploadId') },
            },
          },
          schema: {
            tags,
            summary:
              'Finish a site upload: assemble the parts, check every file (SHA-256, magic bytes, secret scan); refused files are named with the reason (rule + line for a secret)',
            security: csrf,
            params: UploadParams,
            response: { 200: UploadView, ...errors },
          },
        },
        async (req) => service.complete(actor(req), req.params.id, req.params.uploadId),
      );

      r.delete(
        '/projects/:id/site-uploads/:uploadId',
        {
          config: { authz: request },
          schema: {
            tags,
            summary: 'Delete an uploaded site (its uploader, or a project admin)',
            security: csrf,
            params: UploadParams,
            response: { 204: z.null(), ...errors },
          },
        },
        async (req, reply) => {
          const admin = authorize(authzOf(req).subject, 'deploy.approve', { project: req.params.id }).allow;
          await service.remove(actor(req), req.params.id, req.params.uploadId, admin);
          return reply.code(204).send(null);
        },
      );
      done();
    });
  };
}
