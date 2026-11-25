import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { EVIDENCE_KINDS, parseRecordScope, RECORD_STATUSES, RECORD_TYPES } from '@remyral/memory';
import { RuntimeKind } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Resource } from '../authz/model.js';
import { bodyField, contextDocResource, jobResource, param, projectQuery } from '../authz/resources.js';
import { contextActorOf, contextRequestMeta, handledContext } from '../context/routes.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ConflictView, InjectedItem, MemoryRecordService, RecordEvent, RecordView } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
  findings: z.array(z.record(z.string(), z.unknown())).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Project = z.string().regex(PROJECT);
const Type = z.enum(RECORD_TYPES);
const Status = z.enum(RECORD_STATUSES);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Evidence = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  ref: z.string().min(1).max(500),
  label: z.string().max(200).optional(),
});
const split = (s: string): string[] => s.split(',').filter((x) => x !== '');
const TypeList = z.string().max(200).transform(split).pipe(z.array(Type).max(10));
const StatusList = z.string().max(200).transform(split).pipe(z.array(Status).max(10));

export const RecordBody = z.object({
  id: z.string(),
  namespace: z.string(),
  type: Type,
  scope: z.string(),
  project: z.string().nullable(),
  runtime: z.string().nullable(),
  status: Status,
  title: z.string(),
  statement: z.string(),
  rationale: z.string().nullable(),
  consequences: z.string().nullable(),
  decidedOn: z.string().nullable(),
  decidedBy: z.string().nullable(),
  content: z.string(),
  version: z.number().int(),
  evidence: z.array(Evidence),
  author: z.enum(['human', 'agent', 'runtime']),
  authorRef: z.string().nullable(),
  acceptedBy: z.string().nullable(),
  suggestionId: z.string().nullable(),
  confidence: z.number().nullable(),
  tags: z.array(z.string()),
  reviewBy: z.string().nullable(),
  reviewDue: z.boolean(),
  expiresAt: z.string().nullable(),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  statusReason: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canWrite: z.boolean(),
  /** p17-auto-learning: accepted by the auto-learning policy (null: by a person) — the "Otomatik öğrenildi" badge. */
  autoLearned: z
    .object({
      policyVersion: z.number().int(),
      reasons: z.array(z.string()),
      confidence: z.number(),
      sources: z.number().int(),
      at: z.string(),
    })
    .nullable(),
  /** p17-memory-import: the import batch the record came from ("İçe aktarıldı · Claude"); null: not imported. */
  imported: z
    .object({
      importId: z.string(),
      assistant: z.string(),
      assistantLabel: z.string().nullable(),
      at: z.string(),
    })
    .nullable(),
});
const EventBody = z.object({
  at: z.string(),
  action: z.string(),
  actorType: z.enum(['user', 'system']),
  actorId: z.string().nullable(),
  version: z.number().int().nullable(),
  relatedId: z.string().nullable(),
  note: z.string().nullable(),
});
const ConflictBody = z.object({
  id: z.string(),
  project: z.string().nullable(),
  scope: z.string(),
  record: z.object({ id: z.string(), title: z.string(), type: Type, status: Status }),
  other: z.object({ id: z.string(), title: z.string(), type: Type, status: Status }),
  score: z.number(),
  method: z.enum(['semantic', 'lexical']),
  reason: z.enum(['similar', 'negation', 'different_choice', 'different_value']),
  createdAt: z.string(),
});
const InjectedBody = z.object({
  position: z.number().int(),
  layer: z.string(),
  namespace: z.string(),
  kind: z.string(),
  docId: z.string(),
  version: z.number().int(),
  contentHash: z.string(),
  recordType: Type.nullable(),
  title: z.string().nullable(),
  scope: z.string().nullable(),
  statusNow: Status.nullable(),
});

const Fields = {
  title: z.string().min(1).max(200).optional(),
  statement: z.string().min(1).max(2000),
  rationale: z.string().max(2000).nullable().optional(),
  consequences: z.string().max(2000).nullable().optional(),
  decidedOn: DateOnly.nullable().optional(),
  decidedBy: z.string().max(120).nullable().optional(),
  evidence: z.array(Evidence).max(20).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  reviewBy: DateOnly.nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
};
const CreateBody = z.object({
  scope: z.string().min(6).max(200),
  type: Type,
  ...Fields,
  supersedes: z.string().regex(UUID).nullable().optional(),
});
const EditBody = z.object({
  expectedVersion: z.number().int().min(1),
  ...Fields,
  statement: Fields.statement.optional(),
  changeNote: z.string().max(1000).optional(),
});
const StatusBody = z.object({
  status: z.enum(['expired', 'rejected', 'active']),
  reason: z.string().max(500).optional(),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function recordJson(r: RecordView): z.infer<typeof RecordBody> {
  return {
    ...r,
    evidence: r.evidence.map((e) => ({
      kind: e.kind,
      ref: e.ref,
      ...(e.label === undefined ? {} : { label: e.label }),
    })),
    tags: [...r.tags],
    autoLearned: r.autoLearned === null ? null : { ...r.autoLearned, reasons: [...r.autoLearned.reasons] },
    imported: r.imported === null ? null : { ...r.imported, at: r.imported.at.toISOString() },
    expiresAt: iso(r.expiresAt),
    statusChangedAt: iso(r.statusChangedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
const eventJson = (e: RecordEvent): z.infer<typeof EventBody> => ({ ...e, at: e.at.toISOString() });
const conflictJson = (c: ConflictView): z.infer<typeof ConflictBody> => ({
  ...c,
  createdAt: c.createdAt.toISOString(),
});
const injectedJson = (i: InjectedItem): z.infer<typeof InjectedBody> => ({ ...i });

/** `project:<id>[+runtime:…]` scope in the body → that project; any other scope: no single project. */
function scopeBody() {
  return (request: FastifyRequest): Resource | null | undefined => {
    const s = bodyField(request, 'scope');
    if (s === undefined) return undefined;
    const scope = parseRecordScope(s);
    if (scope === null) return null;
    return scope.type === 'project' ? { project: scope.project } : undefined;
  };
}

/**
 * Memory records API (docs/design/p11-memory-layers.md §7). Reads: `context.read` (viewer+ in the project; global and
 * personal records filtered by the service). Writes: `context.write` (operator+ in the project; the document write
 * role still applies — global records need an admin). Personal rules (`/memory-records/personal`): any signed-in user,
 * for their own rules only (`memory.personal`). Every write is audited (`memory.record.*` and `context.doc.*`).
 */
export function memoryRecordRoutes(service: MemoryRecordService, db: Queryable) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'memory_record_not_found', 'Memory record not found.');
    const recordResource =
      (key = 'id') =>
      async (request: FastifyRequest): Promise<Resource | null> => {
        const id = param(request, key);
        if (id === undefined || !UUID.test(id)) return null;
        const project = await service.projectOf(id);
        return project === undefined ? null : { project };
      };
    const conflictResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.conflictProject(id);
      return project === undefined ? null : { project };
    };
    const IdParams = z.object({ id: z.string().regex(UUID) });
    const one = { 200: RecordBody, ...errors };

    r.get(
      '/memory-records',
      {
        config: { authz: { action: 'context.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Typed memory records (rules, facts, decisions, lessons) of a project, the global scope or your own',
          security: session,
          querystring: z.object({
            scope: z.enum(['project', 'global', 'mine']).default('project'),
            project: Project.optional(),
            type: TypeList.optional(),
            status: StatusList.optional(),
            runtime: RuntimeKind.optional(),
            tag: z.string().min(1).max(40).optional(),
            q: z.string().max(200).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
          }),
          response: { 200: z.object({ items: z.array(RecordBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const q = request.query;
          const items = await service.list(contextActorOf(request), {
            scope: q.scope,
            project: q.project,
            types: q.type,
            statuses: q.status,
            runtime: q.runtime,
            tag: q.tag,
            q: q.q,
            limit: q.limit,
          });
          return { items: items.map(recordJson) };
        }),
    );

    r.get(
      '/memory-records/decisions',
      {
        config: { authz: { action: 'context.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: "A project's decision history (every status, newest decision first)",
          security: session,
          querystring: z.object({ project: Project }),
          response: { 200: z.object({ items: z.array(RecordBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          items: (await service.decisions(contextActorOf(request), request.query.project)).map(recordJson),
        })),
    );

    r.get(
      '/memory-records/conflicts',
      {
        config: { authz: { action: 'context.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'Pending "this may replace" pairs of a project (or of the global scope without `project`)',
          security: session,
          querystring: z.object({ project: Project.optional() }),
          response: { 200: z.object({ items: z.array(ConflictBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          items: (await service.conflicts(contextActorOf(request), request.query.project ?? null)).map(
            conflictJson,
          ),
        })),
    );

    r.post(
      '/memory-records/conflicts/:id/resolve',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: conflictResource,
            notFound: () => new HttpError(404, 'memory_conflict_not_found', 'Possible conflict not found.'),
            auditDenied: { action: 'memory.record.conflict' },
          },
        },
        schema: {
          tags,
          summary: 'Decide a possible conflict: supersede (the newer record replaces the older) or keep both',
          security: csrf,
          params: IdParams,
          body: z.object({ decision: z.enum(['supersede', 'keep']) }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          await service.resolveConflict(
            contextActorOf(request),
            request.params.id,
            request.body.decision,
            contextRequestMeta(request),
          );
          return reply.code(204).send(null);
        }),
    );

    r.get(
      '/memory-records/review-due',
      {
        config: { authz: { action: 'context.read' } },
        schema: {
          tags,
          summary: 'Active records whose review-by date has come and that you may update (Home "Needs you")',
          security: session,
          response: { 200: z.object({ items: z.array(RecordBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          items: (await service.reviewDue(contextActorOf(request))).map(recordJson),
        })),
    );

    r.get(
      '/memory-records/untyped',
      {
        config: { authz: { action: 'context.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'Untyped memory / instruction documents of a project (they can be given a type)',
          security: session,
          querystring: z.object({ project: Project }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  kind: z.string(),
                  title: z.string(),
                  namespace: z.string(),
                  updatedAt: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          items: (await service.untyped(contextActorOf(request), request.query.project)).map((d) => ({
            ...d,
            updatedAt: d.updatedAt.toISOString(),
          })),
        })),
    );

    r.post(
      '/memory-records/type/:docId',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: contextDocResource(db, 'docId'),
            notFound,
            auditDenied: { action: 'memory.record.type' },
          },
        },
        schema: {
          tags,
          summary: 'Give an existing (untyped) memory / instruction document a record type, keeping its text',
          security: csrf,
          params: z.object({ docId: z.string().regex(UUID) }),
          body: z.object({ type: Type, reviewBy: DateOnly.nullable().optional(), tags: Fields.tags }),
          response: one,
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          recordJson(
            await service.typeDocument(
              contextActorOf(request),
              request.params.docId,
              {
                type: request.body.type,
                reviewBy: request.body.reviewBy ?? null,
                ...(request.body.tags === undefined ? {} : { tags: request.body.tags }),
              },
              contextRequestMeta(request),
            ),
          ),
        ),
    );

    r.get(
      '/memory-records/jobs/:jobId',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(db, 'jobId') } },
        schema: {
          tags,
          summary:
            'Exactly which context items a job received: its pinned bundle (doc, version, type as pinned) and each record’s status now',
          security: session,
          params: z.object({ jobId: z.string().regex(UUID) }),
          response: {
            200: z.object({
              pinned: z.boolean(),
              bundleHash: z.string().nullable(),
              items: z.array(InjectedBody),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const out = await service.injected(contextActorOf(request), request.params.jobId);
          return { ...out, items: out.items.map(injectedJson) };
        }),
    );

    // ---------------------------------------------------------------------------------- personal rules

    r.get(
      '/memory-records/personal',
      {
        config: { authz: { action: 'memory.personal' } },
        schema: {
          tags,
          summary: 'Your personal rules (they apply to the jobs and chats you create)',
          security: session,
          response: { 200: z.object({ items: z.array(RecordBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          items: (await service.list(contextActorOf(request), { scope: 'mine', limit: 500 })).map(recordJson),
        })),
    );

    r.post(
      '/memory-records/personal',
      {
        config: { authz: { action: 'memory.personal', auditDenied: { action: 'memory.record.create' } } },
        schema: {
          tags,
          summary: 'Add a personal rule (applies to the jobs and chats you create)',
          security: csrf,
          body: z.object({
            title: Fields.title,
            statement: Fields.statement,
            rationale: Fields.rationale,
            tags: Fields.tags,
            reviewBy: Fields.reviewBy,
            expiresAt: Fields.expiresAt,
            supersedes: z.string().regex(UUID).nullable().optional(),
          }),
          response: { 200: z.object({ record: RecordBody, conflicts: z.array(ConflictBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const user = contextActorOf(request);
          const out = await service.create(
            user,
            { ...request.body, scope: `user:${user.id.toLowerCase()}`, type: 'rule' },
            contextRequestMeta(request),
          );
          return { record: recordJson(out.record), conflicts: out.conflicts.map(conflictJson) };
        }),
    );

    r.put(
      '/memory-records/personal/:id',
      {
        config: { authz: { action: 'memory.personal', auditDenied: { action: 'memory.record.edit' } } },
        schema: {
          tags,
          summary: 'Edit one of your personal rules (a new version)',
          security: csrf,
          params: IdParams,
          body: EditBody,
          response: one,
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          recordJson(
            await service.edit(
              contextActorOf(request),
              request.params.id,
              request.body,
              contextRequestMeta(request),
            ),
          ),
        ),
    );

    r.post(
      '/memory-records/personal/:id/status',
      {
        config: { authz: { action: 'memory.personal', auditDenied: { action: 'memory.record.status' } } },
        schema: {
          tags,
          summary: 'Retire (expire) or reactivate one of your personal rules',
          security: csrf,
          params: IdParams,
          body: StatusBody,
          response: one,
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          recordJson(
            await service.setStatus(
              contextActorOf(request),
              request.params.id,
              request.body,
              contextRequestMeta(request),
            ),
          ),
        ),
    );

    // ------------------------------------------------------------------------------------ one record

    r.post(
      '/memory-records',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: scopeBody(),
            auditDenied: { action: 'memory.record.create' },
          },
        },
        schema: {
          tags,
          summary:
            'Create a typed record (operator+ in the project; global / runtime scopes need an admin); optionally superseding an active one',
          security: csrf,
          body: CreateBody,
          response: { 200: z.object({ record: RecordBody, conflicts: z.array(ConflictBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const out = await service.create(
            contextActorOf(request),
            request.body,
            contextRequestMeta(request),
          );
          return { record: recordJson(out.record), conflicts: out.conflicts.map(conflictJson) };
        }),
    );

    r.get(
      '/memory-records/:id',
      {
        config: { authz: { action: 'context.read', resource: recordResource(), notFound } },
        schema: {
          tags,
          summary: 'One record with its lifecycle history and its supersession chain',
          security: session,
          params: IdParams,
          response: {
            200: z.object({ record: RecordBody, events: z.array(EventBody), related: z.array(RecordBody) }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const out = await service.get(contextActorOf(request), request.params.id);
          return {
            record: recordJson(out.record),
            events: out.events.map(eventJson),
            related: out.related.map(recordJson),
          };
        }),
    );

    r.put(
      '/memory-records/:id',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: recordResource(),
            notFound,
            auditDenied: { action: 'memory.record.edit' },
          },
        },
        schema: {
          tags,
          summary:
            'Edit a record (text changes write a new immutable version; metadata in the same transaction)',
          security: csrf,
          params: IdParams,
          body: EditBody,
          response: one,
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          recordJson(
            await service.edit(
              contextActorOf(request),
              request.params.id,
              request.body,
              contextRequestMeta(request),
            ),
          ),
        ),
    );

    r.post(
      '/memory-records/:id/status',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: recordResource(),
            notFound,
            auditDenied: { action: 'memory.record.status' },
          },
        },
        schema: {
          tags,
          summary:
            'Expire or reject a record (never injected again), or reactivate an expired / rejected one',
          security: csrf,
          params: IdParams,
          body: StatusBody,
          response: one,
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          recordJson(
            await service.setStatus(
              contextActorOf(request),
              request.params.id,
              request.body,
              contextRequestMeta(request),
            ),
          ),
        ),
    );

    r.post(
      '/memory-records/:id/supersede',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: recordResource(),
            notFound,
            auditDenied: { action: 'memory.record.supersede' },
          },
        },
        schema: {
          tags,
          summary: 'Mark this record superseded by another active record (same project / scope family)',
          security: csrf,
          params: IdParams,
          body: z.object({ by: z.string().regex(UUID), reason: z.string().max(500).optional() }),
          response: { 200: z.object({ old: RecordBody, replacement: RecordBody }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const out = await service.supersede(
            contextActorOf(request),
            request.params.id,
            request.body.by,
            request.body.reason,
            contextRequestMeta(request),
          );
          return { old: recordJson(out.old), replacement: recordJson(out.replacement) };
        }),
    );

    r.post(
      '/memory-records/:id/reviewed',
      {
        config: {
          authz: {
            action: 'context.write',
            resource: recordResource(),
            notFound,
            auditDenied: { action: 'memory.record.review' },
          },
        },
        schema: {
          tags,
          summary: 'Mark a record reviewed (still valid); optionally set the next review date',
          security: csrf,
          params: IdParams,
          body: z.object({ reviewBy: DateOnly.nullable() }),
          response: one,
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          recordJson(
            await service.reviewed(
              contextActorOf(request),
              request.params.id,
              request.body,
              contextRequestMeta(request),
            ),
          ),
        ),
    );
  };
}
