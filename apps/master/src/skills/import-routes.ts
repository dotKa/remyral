import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { ReleaseVersion, RuntimeKind, SkillId, SkillTrust } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import type { ContextActor } from '../context/store.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { authzOf } from '../http/route-authz.js';
import { HttpError } from '../http/errors.js';
import type { SkillCatalogService } from './catalog.js';
import { MAX_IMPORT_RAW_FILES } from './import-analysis.js';
import { MAX_IMPORT_ZIP_BYTES, type SkillImportService } from './import-service.js';
import { AssignmentSchema, VersionSchema } from './routes.js';
import type { RequestMeta, SkillService } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  413: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  502: ErrorBody,
  503: ErrorBody,
};

/**
 * `POST /skills/imports`: a zip (≤ 2 MiB) or a folder's files travel base64 in the JSON body — 3 MiB, a
 * BODY_LIMIT_EXCEPTIONS entry (src/http/rate-policy.ts).
 */
export const SKILL_IMPORT_BODY_LIMIT = 3 * 1024 * 1024;
/** `POST /skills/imports/:id/publish`: id, title, description, version, runtimes, an assignment. */
export const SKILL_IMPORT_PUBLISH_BODY_LIMIT = 4 * 1024;
export const SKILL_TRUST_BODY_LIMIT = 1024;
/** p14-skill-catalogs: `PUT /skills/catalog/sources/:id` (title, repo, ref, folder, enabled). */
export const SKILL_CATALOG_SOURCE_BODY_LIMIT = 2 * 1024;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');
const ProjectRef = z.string().regex(/^(\*|[A-Za-z0-9_.:-]{1,128})$/);

const ImportSourceBody = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('files'),
    files: z
      .array(z.strictObject({ path: z.string().min(1).max(512), data: Base64 }))
      .min(1)
      .max(MAX_IMPORT_RAW_FILES),
  }),
  z.strictObject({
    kind: z.literal('zip'),
    fileName: z.string().min(1).max(200).optional(),
    data: Base64.max(Math.ceil(MAX_IMPORT_ZIP_BYTES / 3) * 4),
  }),
  z.strictObject({
    kind: z.literal('github'),
    url: z.string().min(1).max(2048),
    ref: z.string().min(1).max(200).optional(),
  }),
  // p14-skill-catalogs: an entry of a configured catalog (pinned to the listing's commit).
  z.strictObject({
    kind: z.literal('catalog'),
    entryId: z.string().min(3).max(260),
  }),
]);

const Finding = z.object({
  kind: z.string(),
  severity: z.enum(['block', 'warn', 'info']),
  path: z.string().optional(),
  line: z.number().int().optional(),
  rule: z.string().optional(),
  to: z.string().optional(),
  hosts: z.array(z.string()).optional(),
  size: z.number().int().optional(),
  excerpt: z.string().optional(),
});

const ImportView = z.object({
  id: z.string(),
  sourceKind: z.enum(['upload', 'zip', 'github', 'catalog']),
  source: z.object({
    catalog: z.string().optional(),
    fileName: z.string().optional(),
    repo: z.string().optional(),
    path: z.string().optional(),
    ref: z.string().optional(),
    commit: z.string().optional(),
    url: z.string().optional(),
  }),
  state: z.enum(['previewed', 'published', 'discarded', 'expired']),
  blocked: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  suggested: z.object({
    skillId: z.string().nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    version: z.string(),
  }),
  latest: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number().int(),
      sha256: z.string(),
      executable: z.boolean(),
      content: z.string(),
    }),
  ),
  excluded: z.array(z.object({ path: z.string(), size: z.number().int(), reason: z.string() })),
  findings: z.array(Finding),
  license: z.object({ path: z.string().nullable(), name: z.string().nullable() }).nullable(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  diff: z.string().nullable(),
  published: z.object({ skillId: z.string(), version: z.string() }).nullable(),
  limits: z.object({
    maxFiles: z.number().int(),
    maxFileBytes: z.number().int(),
    maxTotalBytes: z.number().int(),
  }),
  /** p14-skill-catalogs: 1 = every worker, 2 = skills-layout-v2 workers only, null = over the limits. */
  layout: z.union([z.literal(1), z.literal(2)]).nullable(),
});

const CatalogSourceView = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  ref: z.string().nullable(),
  path: z.string(),
  enabled: z.boolean(),
  builtin: z.boolean(),
  commit: z.string().nullable(),
  listedAt: z.string().nullable(),
  error: z.string().nullable(),
  entryCount: z.number().int(),
  updatedAt: z.string(),
});

const CatalogEntryView = z.object({
  id: z.string(),
  sourceId: z.string(),
  repo: z.string(),
  path: z.string(),
  commit: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  fit: z.enum(['v1', 'v2', 'too_large', 'binary']),
  url: z.string(),
});

const CatalogSourceId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(40);

const TrustView = z.object({
  project: z.string(),
  trust: SkillTrust,
  updatedAt: z.string().nullable().optional(),
  /** Skills assigned to the project that only have panel-signed versions (skipped while 'offline-only'). */
  panelSignedAssignments: z.array(z.string()),
});

function human(request: FastifyRequest): ContextActor {
  const { subject } = authzOf(request);
  return { id: subject.userId, role: subject.role, ...stepUpFields(request) };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/**
 * p14-skill-import (ADR-0054): skill import previews and their publication with the panel key, and the per-project
 * skill trust level. Previews are `skills.publish` + step-up (they may fetch from GitHub); publishing is
 * `skills.publish` with an **always-fresh** step-up (ALWAYS_FRESH_ROUTES) — it signs with the panel key.
 */
export function skillImportRoutes(
  imports: SkillImportService,
  skills: SkillService,
  clock: () => Date = () => new Date(),
  catalog: SkillCatalogService | null = null,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['skills'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const freshStepUp = requireStepUp('always-fresh', clock);

    r.post(
      '/skills/imports',
      {
        config: { authz: { action: 'skills.publish' } },
        bodyLimit: SKILL_IMPORT_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Import a skill from a folder, a zip or a GitHub link (pinned to a commit) into a preview: files, findings, suggested id and version; nothing is signed yet (step-up)',
          security: csrf,
          body: ImportSourceBody,
          response: { 201: ImportView, ...errors },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await imports.preview(human(request), request.body, meta(request))),
    );

    r.get(
      '/skills/imports/:id',
      {
        config: { authz: { action: 'skills.publish' } },
        schema: {
          tags,
          summary: 'One skill import preview with its files and findings',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: ImportView, ...errors },
        },
      },
      async (request) => imports.get(human(request), request.params.id),
    );

    r.post(
      '/skills/imports/:id/publish',
      {
        config: { authz: { action: 'skills.publish' } },
        bodyLimit: SKILL_IMPORT_PUBLISH_BODY_LIMIT,
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            'Publish an import preview: signed with the panel skills key, provenance recorded, owners notified, optionally assigned (always-fresh step-up)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({
            skillId: SkillId,
            title: z.string().trim().min(1).max(120),
            description: z.string().trim().min(1).max(1024),
            version: ReleaseVersion,
            runtimes: z.array(RuntimeKind).min(1).max(4),
            assign: z
              .strictObject({
                project: ProjectRef,
                runtimes: z.array(RuntimeKind).min(1).max(4).nullable().optional(),
              })
              .nullable()
              .optional(),
          }),
          response: {
            201: z.object({ version: VersionSchema, assignment: AssignmentSchema.nullable() }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(await imports.publish(human(request), request.params.id, request.body, meta(request))),
    );

    r.delete(
      '/skills/imports/:id',
      {
        config: { authz: { action: 'skills.publish' } },
        schema: {
          tags,
          summary: 'Discard a skill import preview',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await imports.discard(human(request), request.params.id, meta(request));
        return reply.code(204).send(null);
      },
    );

    // ------------------------------------------------------------------ p14-skill-catalogs: catalogs

    const catalogOrFail = (): SkillCatalogService => {
      if (catalog === null) {
        throw new HttpError(
          503,
          'github_import_disabled',
          'Importing from GitHub is not enabled on this master.',
        );
      }
      return catalog;
    };

    r.get(
      '/skills/catalog',
      {
        config: { authz: { action: 'skills.read' } },
        schema: {
          tags,
          summary:
            'Search the configured skill catalogs (GitHub repositories read through api.github.com, pinned to a commit, cached 6 h). Entries are untrusted third-party text.',
          security: session,
          querystring: z.object({
            q: z.string().max(200).optional(),
            source: CatalogSourceId.optional(),
          }),
          response: {
            200: z.object({
              enabled: z.boolean(),
              sources: z.array(CatalogSourceView),
              entries: z.array(CatalogEntryView),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        if (catalog === null) return { enabled: false, sources: [], entries: [] };
        const out = await catalog.search({ q: request.query.q, source: request.query.source });
        return { enabled: catalog.enabled, ...out };
      },
    );

    r.post(
      '/skills/catalog/sources/:id/refresh',
      {
        config: { authz: { action: 'skills.publish' } },
        schema: {
          tags,
          summary: 'Read a catalog source again now (admins; rate-limited per user)',
          security: csrf,
          params: z.object({ id: CatalogSourceId }),
          response: { 200: CatalogSourceView, ...errors },
        },
      },
      async (request) => catalogOrFail().refreshNow(human(request), request.params.id, meta(request)),
    );

    r.put(
      '/skills/catalog/sources/:id',
      {
        config: { authz: { action: 'skills.publish' } },
        bodyLimit: SKILL_CATALOG_SOURCE_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Add or change a skill catalog source: a GitHub repository, an optional branch or tag, an optional folder (step-up, audited)',
          security: csrf,
          params: z.object({ id: CatalogSourceId }),
          body: z.strictObject({
            title: z.string().trim().min(1).max(80),
            repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
            ref: z.string().max(200).nullable().optional(),
            path: z.string().max(200).optional(),
            enabled: z.boolean().optional(),
          }),
          response: { 200: CatalogSourceView, ...errors },
        },
      },
      async (request) =>
        catalogOrFail().upsertSource(human(request), request.params.id, request.body, meta(request)),
    );

    r.delete(
      '/skills/catalog/sources/:id',
      {
        config: { authz: { action: 'skills.publish' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Remove a skill catalog source (step-up, audited; the built-in one can only be switched off)',
          security: csrf,
          params: z.object({ id: CatalogSourceId }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await catalogOrFail().deleteSource(human(request), request.params.id, meta(request));
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/projects/:id/skill-trust',
      {
        config: { authz: { action: 'skills.read' } },
        schema: {
          tags,
          summary: 'Which skill signatures a project accepts (any trusted key, or the offline key only)',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: TrustView, ...errors },
        },
      },
      async (request) => skills.trust(request.params.id),
    );

    r.put(
      '/projects/:id/skill-trust',
      {
        config: { authz: { action: 'skills.assign' } },
        bodyLimit: SKILL_TRUST_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set a project to accept only offline-signed skills (panel-imported and chat-written versions are then never delivered to its jobs), or any trusted key (step-up)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.strictObject({ trust: SkillTrust }),
          response: { 200: TrustView, ...errors },
        },
      },
      async (request) =>
        skills.setTrust(human(request), request.params.id, request.body.trust, meta(request)),
    );
  };
}
