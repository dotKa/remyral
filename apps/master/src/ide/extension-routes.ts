import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { IDE_EXTENSION_LIMITS, IdeTargetPlatform } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { projectParam } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { WORKER_LIMITS } from '../http/rate-policy.js';
import type { Actor, IdeExtensions } from './extensions.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  502: ErrorBodySchema,
};
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID = z.string().min(3).max(129);
const Ids = z.array(ID).max(IDE_EXTENSION_LIMITS.allowlist);

const GlobalBody = z.object({
  registryUrl: z.string(),
  verifiedOnly: z.boolean(),
  deny: z.array(z.string()),
  updatedAt: z.string().nullable(),
});

const TargetBody = z.object({
  target: IdeTargetPlatform,
  sha256: z.string(),
  size: z.number().int(),
  keyId: z.string(),
  keyPinned: z.boolean(),
});

const AllowedBody = z.object({
  id: z.string(),
  version: z.string(),
  pinned: z.boolean(),
  displayName: z.string(),
  description: z.string(),
  publisherVerified: z.boolean(),
  license: z.string().nullable(),
  engine: z.string().nullable(),
  dependencies: z.array(z.string()),
  registryUrl: z.string(),
  targets: z.array(TargetBody),
  approvedBy: z.string().nullable(),
  approvedAt: z.string(),
});

const ProjectBody = z.object({
  required: z.array(z.string()),
  recommended: z.array(z.string()),
  deny: z.array(z.string()),
  enforcedSettings: z.record(z.string(), z.unknown()),
  updatedAt: z.string().nullable(),
});

/**
 * Enforced settings ≤ 32 KiB and lists of ids: well inside the `write` class body limit (64 KiB). A settings save from
 * the console does not exist (settings sync runs over the worker session).
 */
export const IDE_EXTENSION_POLICY_BODY_LIMIT = 48 * 1024;

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): IDE extension policy and the user's list on the console origin.
 *
 * - Ayarlar → Geliştirme ortamı (admin, `ide.extensions`; changes with the `extensions.ide` step-up event):
 *   `GET|PUT /ide/extension-policy`, `GET /ide/extensions` (the allowlist), `GET /ide/extensions/search` (Open VSX
 *   through the master), `POST /ide/extensions` (allow: download + verify + cache), `DELETE /ide/extensions/:id`.
 * - Projeler → Politika → IDE: `GET /projects/:id/ide/extension-policy` (code.read), `PUT` (ide.extensions on the
 *   project, step-up).
 * - The Tam IDE panel: `GET /projects/:id/ide/extensions` (ide.use: what the caller may pick here, their list, the
 *   project's marks, their synced settings' sizes), `PUT /me/ide/extensions`, `DELETE /me/ide/settings` (session.self).
 */
export function ideExtensionRoutes(deps: {
  readonly extensions: IdeExtensions;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const ext = deps.extensions;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['ide'];
    const stepUp = requireStepUp(undefined, deps.clock);
    const actor = (request: FastifyRequest): Actor => {
      const s = sessionOf(request);
      return { type: 'user', id: s.user.id, ip: requestMeta(request).ip };
    };
    const admin = { action: 'ide.extensions' } as const;
    const self = {
      action: 'session.self',
      resource: (rq: FastifyRequest) => ({ ownerId: rq.auth?.session.user.id ?? null }),
    } as const;
    const ProjectParams = z.object({ id: z.string().regex(PROJECT) });

    r.get(
      '/ide/extension-policy',
      {
        config: { authz: admin },
        schema: {
          tags,
          summary: 'The global IDE extension policy: registry, verified publishers only, deny list',
          security: session,
          response: { 200: GlobalBody, ...errors },
        },
      },
      async () => ext.globalPolicy(),
    );

    r.put(
      '/ide/extension-policy',
      {
        config: { authz: admin },
        preHandler: stepUp,
        bodyLimit: IDE_EXTENSION_POLICY_BODY_LIMIT,
        schema: {
          tags,
          summary:
            'Change the global IDE extension policy (an Open VSX-compatible https registry, verified publishers only, deny list; step-up: extensions.ide)',
          security: csrf,
          body: z.strictObject({
            registryUrl: z.string().max(300).nullable(),
            verifiedOnly: z.boolean(),
            deny: Ids,
          }),
          response: { 200: GlobalBody, ...errors },
        },
      },
      async (request) => ext.setGlobalPolicy(actor(request), request.body),
    );

    r.get(
      '/ide/extensions',
      {
        config: { authz: admin },
        schema: {
          tags,
          summary: 'The IDE extension allowlist with the cached, verified builds',
          security: session,
          response: { 200: z.object({ extensions: z.array(AllowedBody) }), ...errors },
        },
      },
      async () => ({ extensions: await ext.list() }),
    );

    r.get(
      '/ide/extensions/search',
      {
        config: { authz: admin },
        schema: {
          tags,
          summary:
            'Search the extension registry (Open VSX) through the master; marks what is allowed / denied',
          security: session,
          querystring: z.object({ q: z.string().min(1).max(100) }),
          response: {
            200: z.object({
              results: z.array(
                z.object({
                  id: z.string(),
                  version: z.string(),
                  displayName: z.string(),
                  description: z.string(),
                  verified: z.boolean(),
                  deprecated: z.boolean(),
                  downloadCount: z.number(),
                  allowedVersion: z.string().nullable(),
                  denied: z.boolean(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({ results: await ext.search(request.query.q) }),
    );

    r.post(
      '/ide/extensions',
      {
        config: { authz: admin },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Allow an extension (a version, or the latest now): the master downloads it from the registry, verifies size, SHA-256 and the registry signature, and caches it (step-up: extensions.ide)',
          security: csrf,
          body: z.strictObject({ id: ID, version: z.string().min(1).max(64).optional() }),
          response: { 201: z.object({ extension: AllowedBody }), ...errors },
        },
      },
      async (request, reply) => {
        const extension = await ext.allow(actor(request), request.body);
        return reply.code(201).send({ extension });
      },
    );

    r.delete(
      '/ide/extensions/:extensionId',
      {
        config: { authz: admin },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Remove an extension from the allowlist (workspaces drop it at their next start; the cached builds are removed)',
          security: csrf,
          params: z.object({ extensionId: ID }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await ext.remove(actor(request), request.params.extensionId);
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/projects/:id/ide/extension-policy',
      {
        config: { authz: { action: 'code.read', resource: projectParam() } },
        schema: {
          tags,
          summary: 'The project’s IDE extension lists (required, recommended, deny) and enforced settings',
          security: session,
          params: ProjectParams,
          response: { 200: ProjectBody, ...errors },
        },
      },
      async (request) => ext.projectPolicy(request.params.id),
    );

    r.put(
      '/projects/:id/ide/extension-policy',
      {
        config: { authz: { action: 'ide.extensions', resource: projectParam() } },
        preHandler: stepUp,
        bodyLimit: IDE_EXTENSION_POLICY_BODY_LIMIT,
        schema: {
          tags,
          summary:
            'Change the project’s IDE extension lists and enforced settings (ids from the allowlist; step-up: extensions.ide)',
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({
            required: z.array(ID).max(100),
            recommended: z.array(ID).max(100),
            deny: Ids,
            enforcedSettings: z.record(z.string().max(200), z.unknown()),
          }),
          response: { 200: ProjectBody, ...errors },
        },
      },
      async (request) => ext.setProjectPolicy(actor(request), request.params.id, request.body),
    );

    r.get(
      '/projects/:id/ide/extensions',
      {
        config: { authz: { action: 'ide.use', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'Extensions the caller may use in the project’s Tam IDE (allowed, not denied), the project’s required / recommended ones, the caller’s list and synced settings sizes',
          security: session,
          params: ProjectParams,
          response: {
            200: z.object({
              available: z.array(AllowedBody.extend({ required: z.boolean(), recommended: z.boolean() })),
              mine: z.array(z.string()),
              required: z.array(z.string()),
              recommended: z.array(z.string()),
              blocked: z.array(z.object({ id: z.string(), reason: z.string() })),
              settings: z.object({
                settingsBytes: z.number().int().nullable(),
                keybindingsBytes: z.number().int().nullable(),
                updatedAt: z.string().nullable(),
              }),
            }),
            ...errors,
          },
        },
      },
      async (request) => ext.userView(sessionOf(request).user.id, request.params.id),
    );

    r.put(
      '/me/ide/extensions',
      {
        config: { authz: self },
        schema: {
          tags,
          summary:
            'Set the caller’s own IDE extension list (only allowed extensions; installed at each workspace start where the project does not deny them)',
          security: csrf,
          body: z.strictObject({ extensions: z.array(ID).max(IDE_EXTENSION_LIMITS.perUser) }),
          response: { 200: z.object({ extensions: z.array(z.string()) }), ...errors },
        },
      },
      async (request) => ({
        extensions: await ext.setUserExtensions(actor(request), request.body.extensions),
      }),
    );

    r.delete(
      '/me/ide/settings',
      {
        config: { authz: self },
        schema: {
          tags,
          summary:
            'Forget the caller’s synced IDE settings and keybindings (the next start begins with defaults)',
          security: csrf,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await ext.resetSettings(actor(request));
        return reply.code(204).send(null);
      },
    );
  };
}

/**
 * `GET /v1/worker/ide/extensions/:sha256` and `GET /v1/worker/ide/settings/:workspaceId` — the worker's downloads for
 * one IDE start (route auth level `device`: no human session). Authenticated by the start's bearer download token
 * (sent in the signed IDE_START over the worker's authenticated WebSocket; 30 minutes; only that start's blobs and the
 * workspace owner's settings; kept only as a hash in the master's memory). Integrity never depends on this channel:
 * the worker checks every VSIX against the SHA-256 in the signed profile.
 */
export function ideWorkerDownloadRoutes(deps: {
  readonly extensions: IdeExtensions;
  readonly limiter: RateLimiter;
}) {
  return (app: FastifyInstance): void => {
    const limit = async (ip: string): Promise<void> => {
      const r = await deps.limiter.hit(
        'worker-ide-download',
        ip,
        WORKER_LIMITS.downloadPerIp.max * 20,
        WORKER_LIMITS.downloadPerIp.windowMs,
      );
      if (!r.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many download requests.',
          { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) },
          {},
          { reason: 'downloads' },
        );
      }
    };
    const unauthorized = (): HttpError =>
      new HttpError(
        401,
        'unauthorized',
        'A valid IDE download token is required.',
        { 'www-authenticate': 'Bearer' },
        {},
        {
          reason: 'ide_token',
        },
      );

    app.get(
      '/v1/worker/ide/extensions/:sha256',
      { config: { auth: 'device' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        await limit(request.ip);
        const sha = (request.params as { sha256?: string }).sha256 ?? '';
        const res = await deps.extensions.download(request.headers.authorization, sha);
        if (res.status === 'unauthorized') throw unauthorized();
        if (res.status === 'not_found') throw new HttpError(404, 'not_found', 'Not found.');
        request.log.info({ workerId: res.workerId, sha256: sha }, 'IDE extension served');
        return reply
          .header('content-type', 'application/octet-stream')
          .header('content-length', String(res.size))
          .send(res.stream);
      },
    );

    app.get(
      '/v1/worker/ide/settings/:workspaceId',
      { config: { auth: 'device' }, schema: { hide: true }, exposeHeadRoute: false },
      async (request, reply) => {
        await limit(request.ip);
        const id = (request.params as { workspaceId?: string }).workspaceId ?? '';
        const res = await deps.extensions.downloadSettings(request.headers.authorization, id);
        if (res === null) throw unauthorized();
        return reply.header('content-type', 'application/json').header('cache-control', 'no-store').send(res);
      },
    );
  };
}
