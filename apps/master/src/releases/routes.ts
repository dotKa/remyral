import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  MAX_INSTALLER_INDEX_BYTES,
  MAX_INSTALLER_KIT_BYTES,
  MAX_RELEASE_ARTIFACT_BYTES,
  ReleaseChannel,
  ReleaseSignature,
  ReleaseVersion,
  UpdateDiagnostics,
} from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { HttpError } from '../http/errors.js';
import { cursorOrBadRequest, keysetQuery } from '../http/pagination.js';
import { WORKER_LIMITS } from '../http/rate-policy.js';
import { actorOf } from '../workers/routes.js';
import type { InstallerService } from '../installers/service.js';
import type { ReleaseActor } from './actor.js';
import type { ReleaseService, ReleaseSummary } from './service.js';
import {
  RELEASE_UPLOAD_BODY_LIMIT,
  type ReleaseUploadService,
  UPLOAD_PART_MAX_BYTES,
  UPLOAD_PART_MIN_BYTES,
} from './uploads.js';
import { ErrorBodySchema } from '../http/error-schema.js';

export { RELEASE_UPLOAD_BODY_LIMIT } from './uploads.js';

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
  503: ErrorBody,
};

/** Base64 (standard alphabet) with an upper bound on the decoded size. */
const base64 = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');

/**
 * The signed `release.json` document written by `scripts/release/sign.mjs`: the body of `POST /releases`
 * and the assembled document of a chunked upload (`POST /releases/uploads/:id/complete`).
 */
export const ReleaseDocument = z.object({
  manifest: base64(8 * 1024),
  signature: ReleaseSignature,
  artifact: base64(MAX_RELEASE_ARTIFACT_BYTES),
  // p5-worker-onboarding: the signed installer kits written by `sign.mjs build|installers`.
  installers: z
    .object({
      index: base64(MAX_INSTALLER_INDEX_BYTES),
      signature: ReleaseSignature,
      kits: z
        .array(z.object({ os: z.string().max(16), content: base64(MAX_INSTALLER_KIT_BYTES) }))
        .min(1)
        .max(3),
    })
    .optional(),
});
export type ReleaseDocument = z.infer<typeof ReleaseDocument>;

/**
 * The one verification and storage path of a release document (direct or chunked upload, or the
 * host-side `release-import` CLI): release signature, artifact integrity and protocol
 * (ReleaseService.upload, audited `release.upload`), then the signed installer kits if present. The
 * routes pass the signed-in admin (`actorOf(request)`); the CLI passes the system actor `release-import`.
 */
export async function publishRelease(
  releases: ReleaseService,
  installers: InstallerService | null,
  doc: ReleaseDocument,
  actor: ReleaseActor,
): Promise<{ release: ReleaseSummary; created: boolean }> {
  const result = await releases.upload(
    {
      manifest: Buffer.from(doc.manifest, 'base64'),
      signature: doc.signature,
      artifact: Buffer.from(doc.artifact, 'base64'),
    },
    actor,
  );
  const kits = doc.installers;
  if (kits !== undefined) {
    if (installers === null)
      throw new HttpError(503, 'installers_unavailable', 'Installer kits are not enabled.');
    await installers.attach(
      result.release.version,
      {
        index: Buffer.from(kits.index, 'base64'),
        signature: kits.signature,
        kits: kits.kits.map((k) => ({ os: k.os, content: Buffer.from(k.content, 'base64') })),
      },
      actor,
    );
  }
  return result;
}

const UploadSchema = z.object({
  id: z.string(),
  totalBytes: z.number().int(),
  sha256: z.string(),
  partSize: z.number().int(),
  partCount: z.number().int(),
  received: z.array(z.number().int()),
  expiresAt: z.string(),
});
const UploadParams = z.object({ id: z.uuid() });
const PART_SHA256_HEADER = 'x-part-sha256';

export const ReleaseSchema = z.object({
  version: z.string(),
  channel: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  keyId: z.string(),
  protocolVersions: z.array(z.string()),
  minNode: z.string(),
  builtAt: z.string(),
  uploadedAt: z.string(),
});
export const ChannelSchema = z.object({
  channel: z.string(),
  version: z.string(),
  rolloutPercent: z.number().int(),
  updatedAt: z.string(),
});
export const AttemptSchema = z.object({
  id: z.string(),
  workerId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  source: z.string(),
  rollback: z.boolean(),
  force: z.boolean(),
  status: z.string(),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  /** p6-worker-boot-diagnostics: boot verdict of the attached evidence (null: none). */
  verdict: z.string().nullable(),
  hasDiagnostics: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});

/**
 * Release registry and update intent (p2-signed-updates). Full session everywhere; every change also needs
 * step-up (ADR-0009 §10) and is audited. Publishing and targeting are admin actions (`releases.publish`,
 * `workers.update`); reading is `releases.read`.
 */
export function releaseRoutes(
  releases: ReleaseService,
  clock: () => Date = () => new Date(),
  installers: InstallerService | null = null,
  uploads: ReleaseUploadService | null = null,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['releases'];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/releases',
      {
        config: { authz: { action: 'releases.read' } },
        schema: {
          tags,
          summary: 'Worker releases, channels (version + rollout %) and recent update attempts',
          querystring: z.object({
            workerId: z.string().min(1).max(64).optional(),
            /** p9-pagination: page size and cursor of the attempt history (default 100, newest first). */
            ...keysetQuery(200),
          }),
          response: {
            200: z.object({
              releases: z.array(ReleaseSchema),
              channels: z.array(ChannelSchema),
              attempts: z.array(AttemptSchema),
              attemptsNextCursor: z.string().nullable().optional(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        cursorOrBadRequest(() =>
          releases.list(request.query.workerId, { limit: request.query.limit, cursor: request.query.cursor }),
        ),
    );

    r.get(
      '/releases/attempts/:id/diagnostics',
      {
        // Log lines (redacted on the worker and again here): the same audience as remote `logs.tail` results.
        config: { authz: { action: 'workers.ops.read' } },
        schema: {
          tags,
          summary:
            'Why an update attempt failed: boot-log verdict and records, service output, updater log, restart errors (admin)',
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              attemptId: z.string(),
              workerId: z.string(),
              toVersion: z.string(),
              diagnostics: UpdateDiagnostics.nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const found = await releases.attemptDiagnostics(request.params.id);
        if (found === null)
          throw new HttpError(
            404,
            'not_found',
            'No such update attempt.',
            {},
            {},
            { reason: 'update_attempt' },
          );
        return found;
      },
    );

    r.post(
      '/releases',
      {
        config: { authz: { action: 'releases.publish' } },
        bodyLimit: RELEASE_UPLOAD_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Upload a release signed offline with the release key; refused unless the signature verifies against RELEASE_PUBLIC_KEYS (step-up)',
          security: csrf,
          body: ReleaseDocument,
          response: { 200: ReleaseSchema, 201: ReleaseSchema, ...errors },
        },
      },
      async (request, reply) => {
        const { release, created } = await publishRelease(
          releases,
          installers,
          request.body,
          actorOf(request),
        );
        return reply.code(created ? 201 : 200).send(release);
      },
    );

    if (uploads !== null) registerUploadRoutes(app, releases, installers, uploads, stepUp, csrf);

    r.put(
      '/releases/channels/:channel',
      {
        config: { authz: { action: 'releases.publish' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Point a channel at a release with a rollout percentage (promote / roll out; step-up)',
          security: csrf,
          params: z.object({ channel: ReleaseChannel }),
          body: z.object({
            version: ReleaseVersion,
            rolloutPercent: z.number().int().min(0).max(100).default(100),
          }),
          response: { 200: ChannelSchema, ...errors },
        },
      },
      async (request) =>
        releases.promote(
          request.params.channel,
          request.body.version,
          request.body.rolloutPercent,
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/update',
      {
        config: { authz: { action: 'workers.update' } },
        preHandler: stepUp,
        schema: {
          tags: ['workers'],
          summary:
            'Set a worker’s update channel and/or explicit target version (pin; rollback: true for a lower version; force: do not wait for jobs) (step-up)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64) }),
          body: z
            .object({
              version: ReleaseVersion.optional(),
              channel: ReleaseChannel.optional(),
              rollback: z.boolean().optional(),
              force: z.boolean().optional(),
            })
            .refine(
              (b) => b.version !== undefined || b.channel !== undefined,
              'version or channel is required',
            ),
          response: {
            202: z.object({
              workerId: z.string(),
              channel: z.string(),
              targetVersion: z.string().nullable(),
              rollback: z.boolean(),
              force: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const result = await releases.target(request.params.id, request.body, actorOf(request));
        return reply.code(202).send(result);
      },
    );
  };
}

/**
 * p6-release-upload: resumable chunked upload of the same `release.json` (docs/ops/worker-updates.md §2).
 * start (step-up) → PUT each part (raw bytes ≤ 4 MiB + its SHA-256) → complete (step-up): the assembled
 * document is checked against the SHA-256 declared at start and then goes through {@link publishRelease},
 * exactly like `POST /releases`. Every route needs `releases.publish`, a full session and CSRF; parts,
 * status and abort skip the step-up (they only touch the caller's own pending bytes; publishing happens
 * at complete), so a slow upload does not re-prompt for every part.
 */
function registerUploadRoutes(
  app: FastifyInstance,
  releases: ReleaseService,
  installers: InstallerService | null,
  uploads: ReleaseUploadService,
  stepUp: ReturnType<typeof requireStepUp>,
  csrf: { session: never[]; csrf: never[] }[],
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['releases'];
  // Parts travel as raw bytes, in this encapsulated scope only (the rest of the API stays JSON-only).
  r.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLOAD_PART_MAX_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  r.post(
    '/releases/uploads',
    {
      config: { authz: { action: 'releases.publish' } },
      preHandler: stepUp,
      schema: {
        tags,
        summary:
          'Start a chunked upload of a signed release.json (total size + SHA-256 of the whole document; step-up)',
        security: csrf,
        body: z.object({
          totalBytes: z.number().int().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex SHA-256'),
          partSize: z
            .number()
            .int()
            .min(UPLOAD_PART_MIN_BYTES)
            .max(UPLOAD_PART_MAX_BYTES)
            .default(UPLOAD_PART_MAX_BYTES),
        }),
        response: { 201: UploadSchema, ...errors },
      },
    },
    async (request, reply) => {
      const started = await uploads.start(actorOf(request), request.body);
      return reply.code(201).send(started);
    },
  );

  r.get(
    '/releases/uploads/:id',
    {
      config: { authz: { action: 'releases.publish' } },
      schema: {
        tags,
        summary: 'A chunked release upload of the caller: which parts the master holds (to resume)',
        params: UploadParams,
        response: { 200: UploadSchema, ...errors },
      },
    },
    async (request) => uploads.status(actorOf(request), request.params.id),
  );

  r.put(
    '/releases/uploads/:id/parts/:n',
    {
      config: { authz: { action: 'releases.publish' } },
      bodyLimit: UPLOAD_PART_MAX_BYTES,
      schema: {
        tags,
        summary:
          'Store part n (0-based) of a chunked release upload: application/octet-stream body, X-Part-SHA256 header (hex); a retry overwrites',
        security: csrf,
        params: z.object({ id: z.uuid(), n: z.coerce.number().int().min(0).max(10_000) }),
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
    async (request) => {
      const body: unknown = request.body;
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
      const h = request.headers[PART_SHA256_HEADER];
      const sha = (Array.isArray(h) ? h[0] : h)?.toLowerCase() ?? '';
      return uploads.putPart(actorOf(request), request.params.id, request.params.n, body, sha);
    },
  );

  r.post(
    '/releases/uploads/:id/complete',
    {
      config: { authz: { action: 'releases.publish' } },
      preHandler: stepUp,
      schema: {
        tags,
        summary:
          'Assemble a chunked release upload, verify its SHA-256, then verify and store it exactly like POST /releases (step-up)',
        security: csrf,
        params: UploadParams,
        response: { 200: ReleaseSchema, 201: ReleaseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const bytes = await uploads.assemble(actor, id);
      // From here on the upload is consumed, whatever the outcome (accepted or refused).
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString('utf8'));
        } catch {
          parsed = undefined;
        }
        const doc = ReleaseDocument.safeParse(parsed);
        if (!doc.success) {
          await uploads.refused(actor, 'document_invalid', id);
          throw new HttpError(
            422,
            'document_invalid',
            'The uploaded file is not a signed release.json document.',
          );
        }
        const { release, created } = await publishRelease(releases, installers, doc.data, actor);
        return await reply.code(created ? 201 : 200).send(release);
      } finally {
        await uploads.discard(id);
      }
    },
  );

  r.delete(
    '/releases/uploads/:id',
    {
      config: { authz: { action: 'releases.publish' } },
      schema: {
        tags,
        summary: 'Cancel a chunked release upload of the caller and drop its parts',
        security: csrf,
        params: UploadParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await uploads.abort(actorOf(request), request.params.id);
      return reply.code(204).send(null);
    },
  );
}

export interface DownloadRateLimit {
  readonly perIp: number;
  readonly windowMs: number;
  /** Downloads per worker in the same window (default WORKER_LIMITS.downloadPerWorker). */
  readonly perWorker?: number;
}

/**
 * `GET /v1/worker/releases/:version/{manifest,artifact}` — the worker's download endpoint
 * (route auth level `device`: no human session). Authenticated by the bearer download token that the
 * master sent over the worker's authenticated WebSocket in UPDATE_AVAILABLE: bound to one worker, one
 * release and an open attempt, valid for 15 minutes, stored only as a hash. Integrity never depends on
 * this channel (the worker verifies the release signature with its pinned key).
 */
export function releaseDownloadRoutes(
  releases: ReleaseService,
  limiter: RateLimiter,
  limit: DownloadRateLimit = {
    perIp: WORKER_LIMITS.downloadPerIp.max,
    windowMs: WORKER_LIMITS.downloadPerIp.windowMs,
  },
) {
  const perWorker = limit.perWorker ?? WORKER_LIMITS.downloadPerWorker.max;
  return (app: FastifyInstance): void => {
    const authorize = async (
      ip: string,
      header: string | undefined,
      version: string,
    ): Promise<{ workerId: string; attemptId: string }> => {
      const r = await limiter.hit('worker-release-download', ip, limit.perIp, limit.windowMs);
      if (!r.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many download requests.',
          {
            'retry-after': String(Math.ceil(r.retryAfterMs / 1000)),
          },
          {},
          { reason: 'downloads' },
        );
      }
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '')?.[1];
      const grant = token === undefined ? null : await releases.authorizeDownload(token, version);
      if (grant === null) {
        throw new HttpError(
          401,
          'unauthorized',
          'A valid release download token is required.',
          {
            'www-authenticate': 'Bearer',
          },
          {},
          { reason: 'release_token' },
        );
      }
      // p7-rate-limit: per worker too (many workers may share one IP; one worker may not hog the master).
      const w = await limiter.hit(
        'worker-release-download-worker',
        grant.workerId,
        perWorker,
        limit.windowMs,
      );
      if (!w.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many download requests.',
          {
            'retry-after': String(Math.ceil(w.retryAfterMs / 1000)),
          },
          {},
          { reason: 'downloads' },
        );
      }
      return grant;
    };
    const Params = z.object({ version: z.string().max(64) });

    app.get(
      '/v1/worker/releases/:version/manifest',
      { config: { auth: 'device' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        const { version } = Params.parse(request.params);
        const grant = await authorize(request.ip, request.headers.authorization, version);
        const doc = await releases.manifestDocument(version);
        if (doc === null) throw new HttpError(404, 'not_found', 'Not found.');
        request.log.info(
          { workerId: grant.workerId, attemptId: grant.attemptId, version },
          'release manifest served',
        );
        return reply.header('content-type', 'application/json').send(doc);
      },
    );

    app.get(
      '/v1/worker/releases/:version/artifact',
      { config: { auth: 'device' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        const { version } = Params.parse(request.params);
        const grant = await authorize(request.ip, request.headers.authorization, version);
        const artifact = await releases.artifact(version);
        if (artifact === null) throw new HttpError(404, 'not_found', 'Not found.');
        request.log.info(
          { workerId: grant.workerId, attemptId: grant.attemptId, version },
          'release artifact served',
        );
        return reply.header('content-type', 'application/octet-stream').send(artifact);
      },
    );
  };
}
