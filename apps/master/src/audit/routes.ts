import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { AccessGate, requestMeta } from './access.js';
import { type AuditRecorder, verifyChainRange } from './audit.js';
import { createExportStream, type ExportFormat, type ExportRecord, redactRecord } from './export.js';
import {
  ACTOR_TYPES,
  type AuditEventView,
  type AuditFilter,
  AuditQuery,
  decodeAuditCursor,
  encodeAuditCursor,
  MAX_PAGE,
  OUTCOMES,
} from './query.js';
import { BIGINT_ID, InvalidCursorError } from './sql.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 429: ErrorBody };

const Iso = z.iso.datetime({ offset: true });
const Cursor = z.string().min(1).max(512);
const BigintId = z.string().regex(BIGINT_ID);

/** Filter parameters shared by list and export. Lengths mirror the column constraints of audit_events. */
export const AuditFilterQuery = z.object({
  from: Iso.optional(),
  to: Iso.optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  actorId: z.string().min(1).max(200).optional(),
  action: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_.-]+$/)
    .optional(),
  target: z.string().min(1).max(500).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  q: z.string().max(400).optional(),
});
type AuditFilterQuery = z.infer<typeof AuditFilterQuery>;

const AuditEventBody = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actor: z.object({ type: z.enum(ACTOR_TYPES), id: z.string().nullable() }),
  action: z.string(),
  target: z.string().nullable(),
  outcome: z.enum(OUTCOMES),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});
type AuditEventBody = z.infer<typeof AuditEventBody>;

function toFilter(q: AuditFilterQuery): AuditFilter {
  return {
    from: q.from === undefined ? undefined : new Date(q.from),
    to: q.to === undefined ? undefined : new Date(q.to),
    actorType: q.actorType,
    actorId: q.actorId,
    action: q.action,
    target: q.target,
    outcome: q.outcome,
    q: q.q,
  };
}

/** Normalised filter echo for manifests and audit metadata (only the fields that were set). */
export function filterEcho(q: AuditFilterQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

/** API view of an event, passed through export-time redaction as defence in depth. */
function eventJson(e: AuditEventView): AuditEventBody {
  const { value } = redactRecord({
    actor: e.actor,
    action: e.action,
    target: e.target,
    ip: e.ip,
    userAgent: e.userAgent,
    metadata: e.metadata,
  });
  return {
    id: e.id,
    occurredAt: e.occurredAt.toISOString(),
    actor: e.actor,
    action: e.action,
    target: value.target as string | null,
    outcome: e.outcome,
    ip: e.ip,
    userAgent: value.userAgent as string | null,
    metadata: value.metadata as Record<string, unknown>,
    prevHash: e.prevHash,
    hash: e.hash,
  };
}

export function auditExportRow(e: AuditEventView): Record<string, unknown> {
  return {
    type: 'audit_event',
    id: e.id,
    occurred_at: e.occurredAt.toISOString(),
    actor_type: e.actor.type,
    actor_id: e.actor.id,
    action: e.action,
    target: e.target,
    outcome: e.outcome,
    ip: e.ip,
    user_agent: e.userAgent,
    metadata: e.metadata,
    prev_hash: e.prevHash,
    hash: e.hash,
  };
}

export const AUDIT_CSV_COLUMNS = [
  'id',
  'occurred_at',
  'actor_type',
  'actor_id',
  'action',
  'target',
  'outcome',
  'ip',
  'user_agent',
  'metadata',
  'prev_hash',
  'hash',
] as const;

export async function cursorOrBadRequest<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      throw new HttpError(
        400,
        'invalid_cursor',
        'The page cursor is invalid. Start again from the first page.',
      );
    }
    throw err;
  }
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function sendExport(
  reply: FastifyReply,
  format: ExportFormat,
  filename: string,
  stream: NodeJS.ReadableStream,
): FastifyReply {
  void reply
    .header(
      'content-type',
      format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/csv; charset=utf-8',
    )
    .header('content-disposition', `attachment; filename="${filename}"`);
  return reply.send(stream);
}

export interface AuditRoutesDeps {
  readonly db: Queryable;
  readonly audit: AuditRecorder;
  readonly gate: AccessGate;
  readonly clock: () => Date;
  /** Export limits (tests lower them). */
  readonly exportLimits?: { readonly maxRecords?: number; readonly maxBytes?: number };
  readonly exportBatchSize?: number;
}

const AUDIT_READ_DENIED = { action: 'audit.read', target: () => 'audit_events' };

/** Audit explorer API (docs/design/p5-search-audit.md). Owner/admin only (central `audit.*` rules). */
export function auditRoutes(deps: AuditRoutesDeps) {
  const query = new AuditQuery(deps.db);
  const batchSize = deps.exportBatchSize ?? 500;

  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['audit'];
    const security = [{ session: [] }];

    r.get(
      '/audit',
      {
        config: { authz: { action: 'audit.read', auditDenied: AUDIT_READ_DENIED } },
        schema: {
          tags,
          summary: 'Search the audit log (owner/admin; newest first, keyset-paginated)',
          security,
          querystring: AuditFilterQuery.extend({
            limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
            cursor: Cursor.optional(),
          }),
          response: {
            200: z.object({ items: z.array(AuditEventBody), nextCursor: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const { limit, cursor, ...filter } = request.query;
        const page = await cursorOrBadRequest(() =>
          query.list(toFilter(filter), { ...(limit ? { limit } : {}), cursor: cursor ?? null }),
        );
        return { items: page.items.map(eventJson), nextCursor: page.nextCursor };
      },
    );

    r.get(
      '/audit/events/:id',
      {
        config: { authz: { action: 'audit.read', auditDenied: AUDIT_READ_DENIED } },
        schema: {
          tags,
          summary: 'One audit event (owner/admin)',
          security,
          params: z.object({ id: BigintId }),
          response: { 200: AuditEventBody, ...errors },
        },
      },
      async (request) => {
        const e = await query.get(request.params.id);
        if (!e) throw new HttpError(404, 'audit_event_not_found', 'Audit event not found.');
        return eventJson(e);
      },
    );

    r.get(
      '/audit/verify',
      {
        config: {
          authz: {
            action: 'audit.verify',
            auditDenied: { action: 'audit.verify', target: () => 'audit_events' },
          },
        },
        schema: {
          tags,
          summary:
            'Verify the hash chain over an id or time range; reports the first broken link (owner/admin)',
          security,
          querystring: z.object({
            fromId: BigintId.optional(),
            toId: BigintId.optional(),
            from: Iso.optional(),
            to: Iso.optional(),
          }),
          response: {
            200: z.object({
              ok: z.boolean(),
              checked: z.number().int(),
              fromId: z.string().nullable(),
              toId: z.string().nullable(),
              lastCheckedId: z.string().nullable(),
              headHash: z.string().nullable(),
              brokenAtId: z.string().nullable(),
              reason: z.enum(['prev_hash_mismatch', 'hash_mismatch']).nullable(),
              anchored: z.enum(['genesis', 'predecessor']),
              verifiedAt: z.string(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const session = await deps.gate.check(request, {
          rateLimit: { bucket: 'verify' },
          deniedAction: 'audit.verify',
          target: 'audit_events',
        });
        const q = request.query;
        let fromId = q.fromId ?? null;
        let toId = q.toId ?? null;
        let empty = false;
        if (q.from !== undefined || q.to !== undefined) {
          const range = await query.idRange(
            q.from === undefined ? undefined : new Date(q.from),
            q.to === undefined ? undefined : new Date(q.to),
          );
          if (range.fromId === null) empty = true;
          if (fromId === null || (range.fromId !== null && BigInt(range.fromId) > BigInt(fromId))) {
            fromId = range.fromId;
          }
          if (toId === null || (range.toId !== null && BigInt(range.toId) < BigInt(toId))) toId = range.toId;
        }
        const result = empty
          ? ({ ok: true, checked: 0, headHash: null, lastCheckedId: null } as const)
          : await verifyChainRange(deps.db, { fromId, toId });
        const out = {
          ok: result.ok,
          checked: result.checked,
          fromId,
          toId,
          lastCheckedId: result.ok ? (result.lastCheckedId ?? null) : null,
          headHash: result.ok ? (result.headHash?.toString('hex') ?? null) : null,
          brokenAtId: result.ok ? null : result.brokenAtId,
          reason: result.ok ? null : result.reason,
          anchored: fromId === null || fromId === '1' ? ('genesis' as const) : ('predecessor' as const),
          verifiedAt: deps.clock().toISOString(),
        };
        await deps.audit.record({
          actor: { type: 'user', id: session.user.id },
          action: 'audit.verify',
          target: 'audit_events',
          outcome: out.ok ? 'success' : 'failure',
          ...requestMeta(request),
          metadata: {
            fromId,
            toId,
            checked: out.checked,
            brokenAtId: out.brokenAtId,
            reason: out.reason,
          },
        });
        return out;
      },
    );

    r.get(
      '/audit/export',
      {
        config: {
          authz: {
            action: 'audit.export',
            auditDenied: { action: 'audit.export', target: () => 'audit_events' },
          },
        },
        schema: {
          tags,
          summary:
            'Export audit events as JSON Lines or CSV with a trailing manifest (owner/admin, step-up, rate-limited, audited)',
          security,
          querystring: AuditFilterQuery.extend({
            format: z.enum(['jsonl', 'csv']).default('jsonl'),
            cursor: Cursor.optional(),
          }),
          response: errors,
        },
      },
      async (request, reply) => {
        const session = await deps.gate.check(request, {
          stepUp: true,
          rateLimit: { bucket: 'export' },
          deniedAction: 'audit.export',
          target: 'audit_events',
        });
        const { format, cursor, ...filterQuery } = request.query;
        const afterId =
          cursor === undefined ? '0' : await cursorOrBadRequest(() => decodeAuditCursor(cursor));
        const filter = toFilter(filterQuery);
        const head = await query.head();
        const uptoId = head?.id ?? '0';
        const now = deps.clock();
        const filters = { ...filterEcho(filterQuery), after_id: afterId, upto_id: uptoId };
        const actor = { type: 'user' as const, id: session.user.id };
        const meta = requestMeta(request);

        // Fail closed: if the export cannot be audited, nothing is exported.
        await deps.audit.record({
          actor,
          action: 'audit.export.started',
          target: 'audit_events',
          outcome: 'success',
          ...meta,
          metadata: { format, filters },
        });

        async function* source(): AsyncGenerator<ExportRecord> {
          let after = afterId;
          for (;;) {
            const batch = await query.exportBatch(filter, { afterId: after, uptoId, limit: batchSize });
            for (const e of batch) yield { record: auditExportRow(e), cursor: encodeAuditCursor(e.id) };
            const last = batch.at(-1);
            if (batch.length < batchSize || !last) return;
            after = last.id;
          }
        }

        const stream = createExportStream(source(), {
          kind: 'audit',
          format,
          generatedAt: now,
          generatedBy: session.user.id,
          filters,
          ...(format === 'csv' ? { csvColumns: AUDIT_CSV_COLUMNS } : {}),
          ...(deps.exportLimits?.maxRecords === undefined
            ? {}
            : { maxRecords: deps.exportLimits.maxRecords }),
          ...(deps.exportLimits?.maxBytes === undefined ? {} : { maxBytes: deps.exportLimits.maxBytes }),
          extra: { chain_head: head },
          onComplete: async (m) => {
            await deps.audit.record({
              actor,
              action: 'audit.export.completed',
              target: 'audit_events',
              outcome: 'success',
              ...meta,
              metadata: {
                format,
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
              action: 'audit.export.failed',
              target: 'audit_events',
              outcome: 'error',
              ...meta,
              metadata: { format, reason: f.reason, recordCount: f.recordCount },
            });
          },
        });
        return sendExport(reply, format, `audit-export-${stamp(now)}.${format}`, stream);
      },
    );
  };
}
