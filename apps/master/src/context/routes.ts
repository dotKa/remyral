import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { CONTEXT_KINDS, type ContextVersion, ROLES } from '@remyral/memory';
import { RuntimeKind } from '@remyral/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import { projectRoleOf } from '../authz/model.js';
import {
  bodyField,
  contextDocResource,
  namespaceBody,
  paramTarget,
  projectQuery,
} from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { ContextError } from './errors.js';
import type { ContextPolicyService } from './policy.js';
import {
  type BundleView,
  type ContextActor,
  type ContextStore,
  type DocumentRecord,
  MAX_RETENTION_DAYS,
  type RequestMeta,
  type VersionMeta,
} from './store.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
  findings: z
    .array(
      z.object({ field: z.string(), line: z.number().int(), column: z.number().int(), rule: z.string() }),
    )
    .optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const Id = z.string().min(1).max(64);
const Role = z.enum(ROLES);
const Kind = z.enum(CONTEXT_KINDS);
const Projects = z.union([z.literal('*'), z.array(z.string().min(1).max(128)).max(500)]);
const Runtimes = z.array(RuntimeKind).min(1).max(5).nullable();

const Provenance = z.object({
  type: z.enum(['user', 'import', 'agent', 'platform']),
  userId: z.string().optional(),
  source: z.string().optional(),
  jobId: z.string().optional(),
  attemptId: z.string().optional(),
  workerId: z.string().nullable().optional(),
});

const DocBody = z.object({
  id: z.string(),
  namespace: z.string(),
  kind: Kind,
  readRole: Role,
  writeRole: Role,
  projectScope: z.enum(['own', 'all', 'listed']),
  projects: z.array(z.string()),
  currentVersion: z.number().int(),
  createdBy: z.object({ type: z.enum(['user', 'import', 'agent']), id: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  deleteReason: z.string().nullable(),
  purgeAfter: z.string().nullable(),
});

const VersionMetaBody = z.object({
  version: z.number().int(),
  title: z.string(),
  contentHash: z.string(),
  sortOrder: z.number().int(),
  runtimes: z.array(z.string()).nullable(),
  changeNote: z.string().nullable(),
  provenance: Provenance,
  createdAt: z.string(),
});
const VersionBody = VersionMetaBody.extend({ content: z.string() });
const DocWithVersion = z.object({ document: DocBody, version: VersionBody });

const BundleItemBody = z.object({
  position: z.number().int(),
  layer: z.enum(['platform', 'global', 'user', 'project', 'memory']),
  authority: z.enum(['platform-policy', 'human-instructions', 'memory']),
  namespace: z.string(),
  kind: z.string(),
  docId: z.string(),
  version: z.number().int(),
  title: z.string(),
  contentHash: z.string(),
  provenance: Provenance,
  /** null when the caller's role may not read this document (hash and provenance still shown). */
  content: z.string().nullable(),
  withheld: z.boolean(),
  /** p11-memory-layers: rule / fact / decision / lesson for typed memory records. */
  recordType: z.enum(['rule', 'fact', 'decision', 'lesson']).optional(),
});

const BundleBody = z.object({
  format: z.string(),
  project: z.string(),
  runtime: z.string(),
  bundleHash: z.string(),
  pinned: z.boolean(),
  items: z.array(BundleItemBody),
  omitted: z.array(z.object({ docId: z.string(), version: z.number().int(), reason: z.string() })),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function docJson(d: DocumentRecord): z.infer<typeof DocBody> {
  return {
    id: d.id,
    namespace: d.namespace,
    kind: d.kind,
    readRole: d.readRole,
    writeRole: d.writeRole,
    projectScope: d.projectScope,
    projects: [...d.grants],
    currentVersion: d.currentVersion,
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    deletedAt: iso(d.deletedAt),
    deletedBy: d.deletedBy,
    deleteReason: d.deleteReason,
    purgeAfter: iso(d.purgeAfter),
  };
}

function versionMetaJson(v: VersionMeta): z.infer<typeof VersionMetaBody> {
  return {
    version: v.version,
    title: v.title,
    contentHash: v.contentHash,
    sortOrder: v.sortOrder,
    runtimes: v.runtimes === null ? null : [...v.runtimes],
    changeNote: v.changeNote,
    provenance: { ...v.provenance },
    createdAt: v.createdAt.toISOString(),
  };
}

function versionJson(v: ContextVersion): z.infer<typeof VersionBody> {
  return { ...versionMetaJson(v), content: v.content };
}

function bundleJson(view: BundleView): z.infer<typeof BundleBody> {
  const b = view.bundle;
  return {
    format: b.format,
    project: b.project,
    runtime: b.runtime,
    bundleHash: b.bundleHash,
    pinned: view.pinned,
    items: b.items.map((i) => {
      const withheld = view.withheld.has(i.docId);
      return {
        position: i.position,
        layer: i.layer,
        authority: i.authority,
        namespace: i.namespace,
        kind: i.kind,
        docId: i.docId,
        version: i.version,
        title: i.title,
        contentHash: i.contentHash,
        provenance: { ...i.provenance },
        content: withheld ? null : i.content,
        withheld,
      };
    }),
    omitted: b.omitted.map((o) => ({ ...o })),
  };
}

/** The caller, with per-project roles from the authorization decision (p5-rbac project scoping). */
function human(request: FastifyRequest): ContextActor {
  const { subject } = authzOf(request);
  return {
    id: subject.userId,
    role: subject.role,
    ...stepUpFields(request),
    projectRole: (project) => projectRoleOf(subject, project),
  };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/** Context errors carry public details (field names, positions, rule ids — never values). */
async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContextError) {
      return reply
        .code(err.httpStatus)
        .send({ error: err.code, message: err.publicMessage, ...err.details() });
    }
    throw err;
  }
}

/** Context API (docs/design/p6-context-model.md). All routes need a full session. */
export function contextRoutes(
  store: ContextStore,
  clock: () => Date,
  db: Queryable,
  /** p6-context-policy: when given, `POST /context/purge` runs the whole retention sweep. */
  policy?: ContextPolicyService,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const doc = {
      resource: contextDocResource(db),
      notFound: () => new HttpError(404, 'context_doc_not_found', 'Context document not found.'),
    };
    // Refusals keep the audit actions the store uses for its own refusals.
    const denied = (action: string) => ({ action, target: paramTarget('context') });

    r.get(
      '/context/docs',
      {
        config: { authz: { action: 'context.read' } },
        schema: {
          tags,
          summary: 'Context documents readable by the caller (current version metadata)',
          security: session,
          querystring: z.object({
            namespace: z.string().max(200).optional(),
            kind: Kind.optional(),
            includeDeleted: z.enum(['true', 'false']).optional(),
            ...offsetQuery(500),
          }),
          response: {
            200: z.object({
              items: z.array(z.object({ document: DocBody, current: VersionMetaBody })),
              ...pageFields,
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const q = request.query;
          const items = await store.list(human(request), {
            ...(q.namespace === undefined ? {} : { namespace: q.namespace }),
            ...(q.kind === undefined ? {} : { kind: q.kind }),
            includeDeleted: q.includeDeleted === 'true',
          });
          const page = pageArray(items, q);
          return {
            items: page.items.map((i) => ({ document: docJson(i.doc), current: versionMetaJson(i.current) })),
            total: page.total,
          };
        }),
    );

    r.post(
      '/context/docs',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: namespaceBody(),
            auditDenied: {
              action: 'context.doc.create',
              target: (req) => `context:${(bodyField(req, 'namespace') ?? '').slice(0, 140)}`,
            },
          },
        },
        schema: {
          tags,
          summary: 'Create a context document (version 1); secret-looking content is rejected',
          security: csrf,
          body: z.object({
            namespace: z.string().min(1).max(200),
            kind: Kind,
            title: z.string().max(1000),
            content: z.string(),
            changeNote: z.string().max(5000).optional(),
            sortOrder: z.number().int().optional(),
            runtimes: Runtimes.optional(),
            readRole: Role.optional(),
            writeRole: Role.optional(),
            projects: Projects.optional(),
            import: z.object({ source: z.string().min(1).max(1000) }).optional(),
          }),
          response: { 201: DocWithVersion, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const b = request.body;
          const created = await store.create(
            human(request),
            {
              namespace: b.namespace,
              kind: b.kind,
              title: b.title,
              content: b.content,
              changeNote: b.changeNote,
              sortOrder: b.sortOrder,
              runtimes: b.runtimes,
              readRole: b.readRole,
              writeRole: b.writeRole,
              projects: b.projects,
              importSource: b.import?.source,
            },
            meta(request),
          );
          return reply
            .code(201)
            .send({ document: docJson(created.doc), version: versionJson(created.version) });
        }),
    );

    r.get(
      '/context/docs/:id',
      {
        config: { authz: { action: 'context.read', ...doc } },
        schema: {
          tags,
          summary: 'One context document with its current version',
          security: session,
          params: z.object({ id: Id }),
          response: { 200: DocWithVersion, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const found = await store.get(human(request), request.params.id);
          return { document: docJson(found.doc), version: versionJson(found.version) };
        }),
    );

    r.get(
      '/context/docs/:id/versions',
      {
        config: { authz: { action: 'context.read', ...doc } },
        schema: {
          tags,
          summary: 'Version history (newest first, metadata only)',
          security: session,
          params: z.object({ id: Id }),
          response: { 200: z.object({ items: z.array(VersionMetaBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const items = await store.listVersions(human(request), request.params.id);
          return { items: items.map(versionMetaJson) };
        }),
    );

    r.get(
      '/context/docs/:id/versions/:version',
      {
        config: { authz: { action: 'context.read', ...doc } },
        schema: {
          tags,
          summary: 'One immutable version with content',
          security: session,
          params: z.object({ id: Id, version: z.coerce.number().int().min(1).max(1_000_000) }),
          response: { 200: VersionBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () =>
          versionJson(await store.getVersion(human(request), request.params.id, request.params.version)),
        ),
    );

    r.post(
      '/context/docs/:id/versions',
      {
        config: { authz: { action: 'context.write', ...doc, auditDenied: denied('context.doc.version') } },
        schema: {
          tags,
          summary: 'Add a new version and make it current (optimistic: expectedVersion)',
          security: csrf,
          params: z.object({ id: Id }),
          body: z.object({
            expectedVersion: z.number().int().min(1),
            title: z.string().max(1000).optional(),
            content: z.string(),
            changeNote: z.string().max(5000).optional(),
            sortOrder: z.number().int().optional(),
            runtimes: Runtimes.optional(),
            import: z.object({ source: z.string().min(1).max(1000) }).optional(),
          }),
          response: { 200: DocWithVersion, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const b = request.body;
          const res = await store.addVersion(
            human(request),
            request.params.id,
            {
              expectedVersion: b.expectedVersion,
              title: b.title,
              content: b.content,
              changeNote: b.changeNote,
              sortOrder: b.sortOrder,
              runtimes: b.runtimes,
              importSource: b.import?.source,
            },
            meta(request),
          );
          return { document: docJson(res.doc), version: versionJson(res.version) };
        }),
    );

    r.post(
      '/context/docs/:id/rollback',
      {
        config: { authz: { action: 'context.write', ...doc, auditDenied: denied('context.doc.rollback') } },
        schema: {
          tags,
          summary: 'Point the document back at an earlier version (no content is rewritten)',
          security: csrf,
          params: z.object({ id: Id }),
          body: z.object({
            expectedVersion: z.number().int().min(1),
            toVersion: z.number().int().min(1),
            reason: z.string().max(1000).optional(),
          }),
          response: { 200: DocWithVersion, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const res = await store.rollback(human(request), request.params.id, request.body, meta(request));
          return { document: docJson(res.doc), version: versionJson(res.version) };
        }),
    );

    r.put(
      '/context/docs/:id/access',
      {
        config: { authz: { action: 'context.delete', ...doc, auditDenied: denied('context.doc.access') } },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary: 'Change read/write roles and project grants (admin+, step-up)',
          security: csrf,
          params: z.object({ id: Id }),
          body: z.object({ readRole: Role, writeRole: Role, projects: Projects.optional() }),
          response: { 200: DocWithVersion, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const res = await store.setAccess(human(request), request.params.id, request.body, meta(request));
          return { document: docJson(res.doc), version: versionJson(res.version) };
        }),
    );

    r.delete(
      '/context/docs/:id',
      {
        config: { authz: { action: 'context.delete', ...doc, auditDenied: denied('context.doc.delete') } },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary: 'Soft-delete with a retention marker (admin+, step-up); purged after retentionDays',
          security: csrf,
          params: z.object({ id: Id }),
          querystring: z.object({
            reason: z.string().max(1000).optional(),
            retentionDays: z.coerce.number().int().min(0).max(MAX_RETENTION_DAYS).optional(),
          }),
          response: { 200: z.object({ document: DocBody }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const doc = await store.softDelete(
            human(request),
            request.params.id,
            { reason: request.query.reason, retentionDays: request.query.retentionDays },
            meta(request),
          );
          return { document: docJson(doc) };
        }),
    );

    r.post(
      '/context/purge',
      {
        config: { authz: { action: 'context.purge' } },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary:
            'Run retention now: expire by max age, prune old versions, hard-purge expired soft deletes; legal holds are honoured (admin+, step-up)',
          security: csrf,
          response: {
            200: z.object({
              purged: z.array(z.string()),
              expired: z.array(z.string()).optional(),
              pruned: z
                .array(z.object({ docId: z.string(), versions: z.array(z.number().int()) }))
                .optional(),
              held: z.number().int().optional(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handled(reply, async () =>
          policy === undefined
            ? store.purgeExpired(human(request), meta(request))
            : policy.runRetention(human(request), meta(request)),
        ),
    );

    r.get(
      '/context/bundle',
      {
        config: { authz: { action: 'context.bundle', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'The exact ordered context bundle for a project/runtime, with its hash (operator+)',
          security: session,
          querystring: z.object({
            project: z.string().min(1).max(128),
            runtime: z.string().min(1).max(32),
            job: z.string().min(1).max(64).optional(),
          }),
          response: { 200: BundleBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const q = request.query;
          const view = await store.bundle(human(request), {
            project: q.project,
            runtime: q.runtime,
            ...(q.job === undefined ? {} : { jobId: q.job }),
          });
          return bundleJson(view);
        }),
    );
  };
}

export { handled as handledContext, human as contextActorOf, meta as contextRequestMeta };
