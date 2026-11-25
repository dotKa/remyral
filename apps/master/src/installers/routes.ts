import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RateLimiter } from '../auth/rate-limit.js';
import { HttpError } from '../http/errors.js';
import { actorOf } from '../workers/routes.js';
import type { InstallerService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 503: ErrorBody };

const Commands = z
  .object({ bootstrapUrl: z.string(), bootstrapSha256: z.string(), download: z.string(), run: z.string() })
  .nullable();
const Kit = z.object({
  os: z.string(),
  file: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  commands: Commands,
  kitUrl: z.string().nullable(),
});
export const InstallerOverviewSchema = z.object({
  publicOrigin: z.string().nullable(),
  masterUrl: z.string().nullable(),
  publicDownloads: z.boolean(),
  current: z
    .object({
      version: z.string(),
      channel: z.string(),
      stable: z.boolean(),
      keyId: z.string(),
      nodeVersion: z.string(),
      uploadedAt: z.string(),
      kits: z.array(Kit),
    })
    .nullable(),
  withoutKits: z.array(z.string()),
});

const Version = z
  .string()
  .max(64)
  .regex(/^[0-9A-Za-z.-]+$/);
const Os = z.enum(['linux', 'macos', 'windows']);

/**
 * Fleet → "Add machine" (p5-worker-onboarding). Full session, admin (`installers.read`): the current
 * release's kits, the one-line install commands and the signed-in bundle download (audited).
 */
export function installerRoutes(installers: InstallerService) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['installers'];

    r.get(
      '/installers',
      {
        config: { authz: { action: 'installers.read' } },
        schema: {
          tags,
          summary: 'Installer kits of the current worker release and the install commands for Add machine',
          response: { 200: InstallerOverviewSchema, ...errors },
        },
      },
      async () => installers.overview(),
    );

    r.get(
      '/installers/:version/:os/kit',
      {
        config: { authz: { action: 'installers.read' } },
        schema: {
          tags,
          summary: 'Download an installer kit (zip / tar.gz) of a release; audited',
          params: z.object({ version: Version, os: Os }),
        },
      },
      async (request, reply) => {
        const kit = await installers.kit(request.params.version, request.params.os);
        if (kit === null)
          throw new HttpError(
            404,
            'not_found',
            'No installer kit for this release and OS.',
            {},
            {},
            { reason: 'installer_kit' },
          );
        await installers.auditDownload(
          actorOf(request),
          request.params.version,
          request.params.os,
          kit.sha256,
        );
        return reply
          .header('content-type', kit.file.endsWith('.zip') ? 'application/zip' : 'application/gzip')
          .header('content-disposition', `attachment; filename="${kit.file}"`)
          .header('x-content-sha256', kit.sha256)
          .header('cache-control', 'no-store')
          .send(kit.content);
      },
    );
  };
}

export interface InstallerDownloadLimit {
  readonly perIp: number;
  readonly windowMs: number;
}

/**
 * Anonymous installer downloads (route auth level `public`, INSTALLER_PUBLIC_DOWNLOADS): a machine being
 * installed has no credential yet. Served: the bootstrap script (no secret; pins the kit's SHA-256 from
 * the signed index), the kit itself and the signed index for offline verification. Only kits bound to the
 * release's current manifest; immutable per release. Rate-limited per IP; every response is logged.
 */
export function installerDownloadRoutes(
  installers: InstallerService,
  limiter: RateLimiter,
  limit: InstallerDownloadLimit = { perIp: 30, windowMs: 10 * 60_000 },
) {
  return (app: FastifyInstance): void => {
    const gate = async (ip: string): Promise<void> => {
      if (!installers.publicDownloads) throw new HttpError(404, 'not_found', 'Not found.');
      const r = await limiter.hit('installer-download', ip, limit.perIp, limit.windowMs);
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
    };
    const notFound = () => new HttpError(404, 'not_found', 'Not found.');

    app.get(
      '/v1/worker/install/:version/:os/:file',
      { config: { auth: 'public' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        await gate(request.ip);
        const p = z.object({ version: Version, os: Os, file: z.string().max(80) }).safeParse(request.params);
        if (!p.success) throw notFound();
        const { version, os, file } = p.data;
        if (file === 'bootstrap.sh' || file === 'bootstrap.ps1') {
          const script = await installers.bootstrap(version, os, file);
          if (script === null) throw notFound();
          request.log.info({ version, os, file }, 'installer bootstrap served');
          return reply
            .header('content-type', 'text/plain; charset=utf-8')
            .header('cache-control', 'no-store')
            .header('x-content-type-options', 'nosniff')
            .send(script);
        }
        const kit = await installers.kit(version, os);
        if (kit === null || kit.file !== file) throw notFound();
        request.log.info({ version, os, sha256: kit.sha256 }, 'installer kit served');
        return reply
          .header('content-type', file.endsWith('.zip') ? 'application/zip' : 'application/gzip')
          .header('content-disposition', `attachment; filename="${kit.file}"`)
          .header('cache-control', 'no-store')
          .send(kit.content);
      },
    );

    app.get(
      '/v1/worker/install/:version/:file',
      { config: { auth: 'public' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        await gate(request.ip);
        const p = z
          .object({ version: Version, file: z.enum(['index.json', 'index.sig.json']) })
          .safeParse(request.params);
        if (!p.success) throw notFound();
        const doc = await installers.indexDocument(p.data.version);
        if (doc === null) throw notFound();
        const body = p.data.file === 'index.json' ? doc.index : `${JSON.stringify(doc.signature)}\n`;
        return reply
          .header('content-type', 'application/json')
          .header('cache-control', 'no-store')
          .send(body);
      },
    );
  };
}
