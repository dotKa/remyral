import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import type { AccessGate } from '../audit/access.js';
import { requestMeta } from '../audit/access.js';
import type { AuditRecorder } from '../audit/audit.js';
import { createExportStream } from '../audit/export.js';
import { sendExport } from '../audit/routes.js';
import { namespaceBody, namespaceResource, projectQuery } from '../authz/resources.js';
import type { ContextPolicyService, DeletionReceipt, NamespacePolicyRecord } from './policy.js';
import { contextActorOf, contextRequestMeta, handledContext } from './routes.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const Memory = z.object({
  enabled: z.boolean(),
  maxBytes: z.number().int(),
  maxPerJob: z.number().int(),
  maxPerHour: z.number().int(),
});
const PolicyBody = z.object({
  namespace: z.string(),
  explicit: z.boolean(),
  version: z.number().int(),
  maxAgeDays: z.number().int().nullable(),
  maxVersions: z.number().int().nullable(),
  legalHold: z.boolean(),
  deleteRetentionDays: z.number().int(),
  memory: Memory,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
const ReceiptBody = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.enum(['delete', 'expire', 'prune', 'purge']),
  docId: z.string(),
  namespace: z.string(),
  kind: z.string(),
  versions: z.array(z.number().int()),
  contentHashes: z.array(z.string()),
  actor: z.object({ type: z.string(), id: z.string().nullable() }),
  reason: z.string().nullable(),
  purgeAfter: z.string().nullable(),
});

function policyJson(p: NamespacePolicyRecord): z.infer<typeof PolicyBody> {
  return {
    namespace: p.namespace,
    explicit: p.explicit,
    version: p.version,
    maxAgeDays: p.maxAgeDays,
    maxVersions: p.maxVersions,
    legalHold: p.legalHold,
    deleteRetentionDays: p.deleteRetentionDays,
    memory: { ...p.memory },
    updatedAt: p.updatedAt?.toISOString() ?? null,
    updatedBy: p.updatedBy,
  };
}

function receiptJson(r: DeletionReceipt): z.infer<typeof ReceiptBody> {
  return {
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    action: r.action,
    docId: r.docId,
    namespace: r.namespace,
    kind: r.kind,
    versions: [...r.versions],
    contentHashes: [...r.contentHashes],
    actor: { ...r.actor },
    reason: r.reason,
    purgeAfter: r.purgeAfter?.toISOString() ?? null,
  };
}

/** `?namespace=` names the resource: `project:<id>` is project-bound, `global` is global. */
function namespaceQuery() {
  return (request: FastifyRequest) => {
    const q = request.query as Record<string, unknown> | null;
    const ns =
      q !== null && typeof q === 'object' && typeof q.namespace === 'string' ? q.namespace : undefined;
    return namespaceResource(ns);
  };
}

const Namespace = z.string().min(1).max(200);

export interface ContextPolicyRoutesDeps {
  readonly policy: ContextPolicyService;
  readonly gate: AccessGate;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly exportLimits?: { readonly maxRecords?: number; readonly maxBytes?: number };
}

/** Context policy API (docs/design/p6-context-policy.md). */
export function contextPolicyRoutes(deps: ContextPolicyRoutesDeps) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];

    r.get(
      '/context/policies',
      {
        config: { authz: { action: 'context.read', resource: namespaceQuery() } },
        schema: {
          tags,
          summary: 'Retention, legal hold and memory-write policy of a namespace (or every explicit one)',
          security: session,
          querystring: z.object({ namespace: Namespace.optional() }),
          response: { 200: z.object({ items: z.array(PolicyBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => ({
          items: (await deps.policy.list(contextActorOf(request), request.query.namespace)).map(policyJson),
        })),
    );

    r.put(
      '/context/policies',
      {
        config: {
          authz: {
            action: 'context.retention',
            resource: namespaceBody(),
            auditDenied: { action: 'context.policy.update' },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary: 'Replace a namespace policy: retention, legal hold, memory writes (admin+, step-up)',
          security: csrf,
          body: z.object({
            namespace: Namespace,
            expectedVersion: z.number().int().min(0),
            maxAgeDays: z.number().int().nullable(),
            maxVersions: z.number().int().nullable(),
            legalHold: z.boolean(),
            deleteRetentionDays: z.number().int(),
            memory: Memory,
          }),
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () =>
          policyJson(
            await deps.policy.put(contextActorOf(request), request.body, contextRequestMeta(request)),
          ),
        ),
    );

    r.get(
      '/context/deletion-receipts',
      {
        config: { authz: { action: 'context.receipts', resource: namespaceQuery() } },
        schema: {
          tags,
          summary:
            'Deletion receipts of a namespace: what was deleted when and by whom, never content (admin+)',
          security: session,
          querystring: z.object({
            namespace: Namespace,
            limit: z.coerce.number().int().min(1).max(500).optional(),
            before: z
              .string()
              .regex(/^\d{1,18}$/)
              .optional(),
          }),
          response: { 200: z.object({ items: z.array(ReceiptBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handledContext(reply, async () => {
          const q = request.query;
          const items = await deps.policy.receipts(contextActorOf(request), q.namespace, {
            ...(q.limit === undefined ? {} : { limit: q.limit }),
            ...(q.before === undefined ? {} : { before: q.before }),
          });
          return { items: items.map(receiptJson) };
        }),
    );

    r.get(
      '/context/export',
      {
        config: {
          authz: {
            action: 'context.export',
            resource: projectQuery(),
            auditDenied: { action: 'context.export' },
          },
        },
        schema: {
          tags,
          summary:
            "Export a project's context as JSON Lines with a trailing manifest (sha256) (operator+, step-up, audited)",
          security: session,
          querystring: z.object({ project: z.string().min(1).max(128) }),
          response: errors,
        },
      },
      async (request, reply) => {
        const project = request.query.project;
        const target = `context-export:${project}`;
        const session = await deps.gate.check(request, {
          stepUp: true,
          rateLimit: { bucket: 'export' },
          deniedAction: 'context.export',
          target,
        });
        const out = await handledContext(reply, () =>
          deps.policy.exportRecords(contextActorOf(request), project),
        );
        if (!('records' in out)) return out;
        const now = deps.clock();
        const actor = { type: 'user' as const, id: session.user.id };
        const meta = requestMeta(request);
        await deps.audit.record({
          actor,
          action: 'context.export.started',
          target,
          outcome: 'success',
          ...meta,
          metadata: { format: 'jsonl', project, documents: out.documents, withheld: out.withheld },
        });
        const stream = createExportStream(out.records, {
          kind: 'context',
          format: 'jsonl',
          generatedAt: now,
          generatedBy: session.user.id,
          filters: { project },
          ...(deps.exportLimits?.maxRecords === undefined
            ? {}
            : { maxRecords: deps.exportLimits.maxRecords }),
          ...(deps.exportLimits?.maxBytes === undefined ? {} : { maxBytes: deps.exportLimits.maxBytes }),
          extra: { project, documents: out.documents, withheld_documents: out.withheld },
          onComplete: async (m) => {
            await deps.audit.record({
              actor,
              action: 'context.export.completed',
              target,
              outcome: 'success',
              ...meta,
              metadata: {
                format: 'jsonl',
                project,
                recordCount: m.record_count,
                bodyBytes: m.body_bytes,
                sha256: m.sha256,
                truncated: m.truncated,
                redactedRecords: m.redacted_records,
              },
            });
          },
          onFailure: async (f) => {
            await deps.audit.record({
              actor,
              action: 'context.export.failed',
              target,
              outcome: 'error',
              ...meta,
              metadata: { format: 'jsonl', reason: f.reason, recordCount: f.recordCount },
            });
          },
        });
        const stamp = now
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}/, '');
        return sendExport(reply, 'jsonl', `context-${project.slice(0, 40)}-${stamp}.jsonl`, stream);
      },
    );
  };
}
