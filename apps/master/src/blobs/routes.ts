import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { jobResource } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { StorageLimits } from './config.js';
import { ShareError, type ShareLinks } from './shares.js';
import { StorageSettingsError, type StorageSettings, type StorageStatus } from './settings.js';
import { type BlobService, BlobUnavailableError } from './store.js';
import { BLOB_UPLOAD_PATH, type BlobUploads } from './uploads.js';

/**
 * p17-object-storage routes:
 *   - Settings → Integrations → Storage: `GET|PUT /integrations/storage`, `POST /integrations/storage/test`
 *     (read: admin; write: owner with an always-fresh step-up; test: owner, CSRF);
 *   - downloads: `GET /jobs/:id/artifacts/:artifactId/download` (jobs.read) → 302 to a short-lived presigned GET with
 *     a forced attachment name (object storage) or the file streamed (local disk); `?open=1` ("S3'te aç") asks for the
 *     browser's own viewer for PDFs, images and videos (still on the bucket's origin, never the console's);
 *   - share links: `GET|POST /jobs/:id/artifacts/:artifactId/shares`, `DELETE …/shares/:shareId` (outputs.share,
 *     owner / admin, audited) and the public `GET /share/f/:token` (no session, rate-limited, audited);
 *   - the worker's upload endpoint in local-disk mode: `PUT /v1/worker/blobs/:id` (route auth `device`; one-time bearer
 *     token of the grant).
 */

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  410: ErrorBodySchema,
};
const Json = z.record(z.string(), z.unknown());

const ConfigBody = z.object({
  provider: z.string(),
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  pathStyle: z.boolean(),
  prefix: z.string(),
  sse: z.string(),
  kmsKeyId: z.string(),
});
const StatusBody = z.object({
  mode: z.enum(['local', 's3']),
  config: ConfigBody.nullable(),
  keyIdHint: z.string().nullable(),
  keyFingerprint: z.string().nullable(),
  usable: z.boolean(),
  problem: z.string().nullable(),
  limits: StorageLimits,
  lastTest: Json.nullable(),
  lastTestAt: z.string().nullable(),
  updatedAt: z.string(),
  usage: z.array(z.object({ location: z.enum(['local', 's3']), blobs: z.number(), bytes: z.number() })),
  legacyBytes: z.number(),
  local: z.object({ dir: z.string(), freeBytes: z.number().nullable(), totalBytes: z.number().nullable() }),
  options: z.object({
    providers: z.array(z.string()),
    defaults: z.record(z.string(), z.object({ region: z.string(), pathStyle: z.boolean() })),
    limitDefaults: StorageLimits,
  }),
  policy: Json.nullable(),
});
const SaveBody = z.strictObject({
  mode: z.enum(['local', 's3']),
  config: z
    .strictObject({
      provider: z.string().max(20),
      endpoint: z.string().max(300),
      region: z.string().max(40),
      bucket: z.string().max(80),
      pathStyle: z.boolean(),
      prefix: z.string().max(200),
      sse: z.string().max(20),
      kmsKeyId: z.string().max(2048),
    })
    .optional(),
  accessKeyId: z.string().max(200).optional(),
  secretAccessKey: z.string().max(300).optional(),
  limits: z.record(z.string(), z.number()).optional(),
});
const ShareBody = z.object({
  id: z.string(),
  jobId: z.string(),
  artifactId: z.string(),
  name: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  useCount: z.number(),
});

function statusJson(s: StorageStatus): z.infer<typeof StatusBody> {
  return {
    ...s,
    usage: [...s.usage],
    options: {
      providers: [...s.options.providers],
      defaults: { ...s.options.defaults },
      limitDefaults: s.options.limitDefaults,
    },
  };
}

/** RFC 6266 filename: ASCII fallback plus the UTF-8 form. */
export function disposition(kind: 'inline' | 'attachment', name: string): string {
  const base = name.split('/').at(-1) ?? 'file';
  const ascii = base.replace(/[^A-Za-z0-9._ ()+-]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/** Types the browser may show in its own viewer on the bucket's origin ("S3'te aç"); everything else downloads. */
const OPEN_INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/;

function wrapStorage(err: unknown): never {
  if (err instanceof StorageSettingsError) {
    throw new HttpError(
      err.status,
      err.code,
      err.message,
      {},
      err.result === undefined ? {} : { result: err.result },
    );
  }
  if (err instanceof ShareError) throw new HttpError(err.status, err.code, err.message);
  if (err instanceof BlobUnavailableError) {
    throw new HttpError(
      err.reason === 'not_found' ? 410 : 503,
      err.reason === 'not_found' ? 'file_missing' : 'storage_unavailable',
      err.message,
    );
  }
  throw err;
}

/**
 * Sends one stored file as an attachment: a 302 to a presigned GET (object storage), the local file streamed, or the
 * legacy bytea. Untrusted bytes: nosniff, a sandbox CSP, CORP same-origin.
 */
export async function sendDownload(
  reply: FastifyReply,
  blobsSvc: BlobService,
  file: { name: string; mediaType: string; content: Buffer | null; blobKey: string | null },
  opts: { readonly open?: boolean } = {},
): Promise<FastifyReply> {
  const open = opts.open === true && OPEN_INLINE.test(file.mediaType);
  const disp = disposition(open ? 'inline' : 'attachment', file.name);
  const secure = (r: FastifyReply): FastifyReply =>
    r
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'same-origin');
  if (file.content !== null) {
    return secure(reply)
      .header('content-type', file.mediaType)
      .header('content-disposition', disposition('attachment', file.name))
      .send(file.content);
  }
  if (file.blobKey === null) {
    throw new HttpError(410, 'file_removed', 'This file was removed by the workspace retention policy.');
  }
  try {
    const d = await blobsSvc.download(file.blobKey, {
      disposition: disp,
      mediaType: open ? file.mediaType : 'application/octet-stream',
    });
    if (d.kind === 'redirect') {
      return await reply.header('referrer-policy', 'no-referrer').redirect(d.url, 302);
    }
    return await secure(reply)
      .header('content-type', file.mediaType)
      .header('content-length', String(d.size))
      .header('content-disposition', disposition('attachment', file.name))
      .send(d.stream);
  } catch (err) {
    wrapStorage(err);
  }
}

export function storageRoutes(deps: { readonly settings: StorageSettings; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['integrations'];
    const user = (request: FastifyRequest) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });
    r.get(
      '/integrations/storage',
      {
        config: { authz: { action: 'integrations.storage.read' } },
        schema: {
          tags,
          summary:
            'Object storage: where blobs go (local disk or an S3-compatible bucket; no keys), limits, usage per location',
          security: [{ session: [] }],
          response: { 200: StatusBody, ...errors },
        },
      },
      async () => statusJson(await deps.settings.status()),
    );
    r.put(
      '/integrations/storage',
      {
        config: { authz: { action: 'integrations.storage.write' } },
        preHandler: requireStepUp('always-fresh', deps.clock),
        schema: {
          tags,
          summary:
            'Choose local disk or an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO), enter its keys (stored encrypted) and the limits; a bucket must pass a put/head/get/delete round trip (owner, always-fresh step-up)',
          security: [{ session: [], csrf: [] }],
          body: SaveBody,
          // A failed round trip answers 400 `storage_test_failed` with the test result (no secrets).
          response: { 200: StatusBody, ...errors, 400: ErrorBodySchema.extend({ result: Json.optional() }) },
        },
      },
      async (request) => {
        try {
          return statusJson(await deps.settings.save(user(request), request.body));
        } catch (err) {
          wrapStorage(err);
        }
      },
    );
    r.post(
      '/integrations/storage/test',
      {
        config: { authz: { action: 'integrations.storage.write' } },
        schema: {
          tags,
          summary:
            'Test the stored storage settings: a put / head / get / delete round trip of a small object (latency, or the error code and a hint)',
          security: [{ session: [], csrf: [] }],
          response: { 200: Json, ...errors },
        },
      },
      async (request) => deps.settings.test(user(request)),
    );
  };
}

export function blobDownloadRoutes(deps: {
  readonly blobs: BlobService;
  readonly shares: ShareLinks;
  readonly db: Queryable;
  readonly limiter: RateLimiter;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const notFound = (): HttpError => new HttpError(404, 'not_found', 'Not found.');
    const Params = z.object({ id: z.uuid(), artifactId: z.string().regex(/^ws-[a-z0-9-]{1,100}$/) });
    const user = (request: FastifyRequest) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });
    const artifact = async (jobId: string, artifactId: string) => {
      const { rows } = await deps.db.query<{
        name: string;
        media_type: string;
        content: Buffer | null;
        blob_key: string | null;
      }>(
        `SELECT name, media_type, content, blob_key FROM job_artifacts
          WHERE job_id = $1 AND artifact_id = $2 AND kind IN ('output', 'summary')
          ORDER BY created_at DESC LIMIT 1`,
        [jobId, artifactId],
      );
      return rows[0] ?? null;
    };

    r.get(
      '/jobs/:id/artifacts/:artifactId/download',
      {
        config: {
          authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Download an output: a short-lived presigned link (object storage) or the file (local disk); `open=1` lets the browser show PDFs, images and videos itself',
          security: [{ session: [] }],
          params: Params,
          querystring: z.object({ open: z.enum(['0', '1']).optional() }),
        },
      },
      async (request, reply) => {
        const f = await artifact(request.params.id, request.params.artifactId);
        if (f === null) throw notFound();
        return sendDownload(
          reply,
          deps.blobs,
          { name: f.name, mediaType: f.media_type, content: f.content, blobKey: f.blob_key },
          { open: request.query.open === '1' },
        );
      },
    );

    r.get(
      '/jobs/:id/artifacts/:artifactId/shares',
      {
        config: {
          authz: { action: 'outputs.share', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['outputs'],
          summary:
            'Share links of an output (owner / admin): validity, uses, revoked or not — never the token',
          security: [{ session: [] }],
          params: Params,
          response: { 200: z.object({ links: z.array(ShareBody) }), ...errors },
        },
      },
      async (request) => ({ links: await deps.shares.list(request.params.id, request.params.artifactId) }),
    );
    r.post(
      '/jobs/:id/artifacts/:artifactId/shares',
      {
        config: {
          authz: { action: 'outputs.share', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['outputs'],
          summary:
            'Create a time-limited share link of an output (owner / admin, audited); the link is shown once',
          security: [{ session: [], csrf: [] }],
          params: Params,
          body: z.strictObject({ days: z.number().int().min(1).max(30) }),
          response: { 200: z.object({ link: ShareBody, path: z.string() }), ...errors },
        },
      },
      async (request) => {
        try {
          const out = await deps.shares.create(
            user(request),
            request.params.id,
            request.params.artifactId,
            request.body.days,
          );
          return { link: out.link, path: out.path };
        } catch (err) {
          wrapStorage(err);
        }
      },
    );
    r.delete(
      '/jobs/:id/artifacts/:artifactId/shares/:shareId',
      {
        config: {
          authz: { action: 'outputs.share', resource: jobResource(deps.db), notFound: () => notFound() },
        },
        schema: {
          tags: ['outputs'],
          summary: 'Revoke a share link (owner / admin, audited)',
          security: [{ session: [], csrf: [] }],
          params: Params.extend({ shareId: z.uuid() }),
          response: { 200: z.object({ link: ShareBody }), ...errors },
        },
      },
      async (request) => {
        try {
          return { link: await deps.shares.revoke(user(request), request.params.id, request.params.shareId) };
        } catch (err) {
          wrapStorage(err);
        }
      },
    );

    app.get(
      '/share/f/:token',
      { config: { auth: 'public' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        const { token } = z.object({ token: z.string().max(64) }).parse(request.params);
        const hit = await deps.limiter.hit('blob-share-open', request.ip, 60, 60_000);
        if (!hit.allowed) {
          throw new HttpError(
            429,
            'rate_limited',
            'Too many requests.',
            { 'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)) },
            {},
            { reason: 'downloads' },
          );
        }
        try {
          const f = await deps.shares.open(token, {
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
          if (f === null) throw new HttpError(404, 'not_found', 'Not found.');
          return await sendDownload(reply, deps.blobs, {
            name: f.name,
            mediaType: f.mediaType,
            content: f.content,
            blobKey: f.blobKey,
          });
        } catch (err) {
          wrapStorage(err);
        }
      },
    );
  };
}

export function blobUploadRoutes(deps: { readonly uploads: BlobUploads; readonly limiter: RateLimiter }) {
  return (app: FastifyInstance): void => {
    void app.register((scope, _opts, done) => {
      // The body is streamed to the blob directory, never buffered (route body limit does not apply).
      scope.addContentTypeParser('application/octet-stream', (_req, payload, next) => {
        next(null, payload);
      });
      const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
        const unauthorized = (): HttpError =>
          new HttpError(
            401,
            'unauthorized',
            'A valid upload token is required.',
            { 'www-authenticate': 'Bearer' },
            {},
            { reason: 'upload_token' },
          );
        const hit = await deps.limiter.hit('worker-blob-upload', request.ip, 600, 60_000);
        if (!hit.allowed)
          throw new HttpError(429, 'rate_limited', 'Too many requests.', {}, {}, { reason: 'uploads' });
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
        if (token === undefined) throw unauthorized();
        const params = z
          .object({ id: z.uuid(), n: z.coerce.number().int().min(1).max(1000).optional() })
          .safeParse(request.params);
        if (!params.success) throw unauthorized();
        const { id, n } = params.data;
        const len = request.headers['content-length'];
        const body = request.body as NodeJS.ReadableStream | undefined;
        if (body === undefined || typeof (body as { pipe?: unknown }).pipe !== 'function') {
          throw new HttpError(400, 'invalid_body', 'Send the file as application/octet-stream.');
        }
        const res = await deps.uploads.receive(
          id,
          token,
          body as unknown as Readable,
          len === undefined ? null : Number(len),
          n,
        );
        if (res.status === 204) return reply.code(204).send();
        throw new HttpError(
          res.status,
          res.status === 401 ? 'unauthorized' : 'upload_refused',
          `Upload refused (${res.reason ?? 'refused'}).`,
        );
      };
      const route = { config: { auth: 'device' as const }, schema: { hide: true } };
      scope.put(`${BLOB_UPLOAD_PATH}:id`, route, handler);
      scope.put(`${BLOB_UPLOAD_PATH}:id/:n`, route, handler);
      done();
    });
  };
}
