import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { RecentTraces } from '@remyral/observability/telemetry';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { LOG_LEVEL_NUMBERS, type LogLevelName, type LogStore } from './logs.js';
import type { SystemStatusService } from './status.js';

/**
 * p16-observability (docs/design/p16-observability.md): Ayarlar → Sistem durumu. Read-only, owners and admins:
 *
 * - `GET /system/status` — the status snapshot (`system.status`)
 * - `GET /system/traces`, `GET /system/traces/:traceId` — recent slow / failed traces kept in memory (`system.status`)
 * - `GET /system/logs` — bounded search over the master's recent redacted log lines (`system.logs`)
 */

const ErrorBody = ErrorBodySchema;
const State = z.enum(['ok', 'warning', 'failing', 'unknown', 'not_configured']);
const Attrs = z.record(z.string(), z.unknown());

export const SystemStatusBody = z.object({
  checkedAt: z.string(),
  overall: z.enum(['ok', 'warning', 'failing']),
  problems: z.array(z.string()),
  components: z.array(
    z.object({
      id: z.enum(['master', 'web', 'postgres', 'redis', 'backup']),
      state: State,
      code: z.string().nullable(),
      latencyMs: z.number().nullable(),
    }),
  ),
  master: z.object({
    releaseTag: z.string().nullable(),
    startedAt: z.string(),
    uptimeSec: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    eventLoopDelayMs: z.number().nullable(),
    node: z.string(),
  }),
  workerRelease: z.array(z.object({ channel: z.string(), version: z.string(), rolloutPercent: z.number() })),
  queue: z
    .object({
      queued: z.number(),
      running: z.number(),
      oldestQueuedSec: z.number(),
      oldestQueuedJobId: z.string().nullable(),
      activeLeases: z.number(),
      approvalsPending: z.number(),
    })
    .nullable(),
  workers: z
    .object({
      online: z.number(),
      offline: z.number(),
      pending: z.number(),
      list: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          state: z.string(),
          connected: z.boolean(),
          lastSeenAt: z.string().nullable(),
          workerVersion: z.string(),
          runningJobs: z.number(),
        }),
      ),
    })
    .nullable(),
  versionFeed: z
    .object({
      enabled: z.boolean(),
      items: z.number(),
      failing: z.number(),
      lastCheckedAt: z.string().nullable(),
      errors: z.array(z.object({ item: z.string(), error: z.string() })),
    })
    .nullable(),
  integrations: z
    .object({
      coolify: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          usable: z.boolean(),
          lastTestAt: z.string().nullable(),
          lastTestOk: z.boolean().nullable(),
        }),
      ),
      cloudflare: z
        .object({
          usable: z.boolean(),
          lastTestAt: z.string().nullable(),
          lastTestOk: z.boolean().nullable(),
        })
        .nullable(),
      github: z
        .object({ connected: z.boolean(), keyUsable: z.boolean().nullable(), missingPermissions: z.number() })
        .nullable(),
    })
    .nullable(),
  errors: z
    .object({
      windowMinutes: z.number(),
      httpRequests: z.number(),
      http5xx: z.number(),
      dbErrors: z.number(),
      jobFailures: z.number(),
      leaseExpiries: z.number(),
      stepFailures: z.number(),
      workerMessageErrors: z.number(),
      chatTurns: z.number(),
      chatTurnsFailed: z.number(),
      errorLogLines: z.number().nullable(),
    })
    .nullable(),
  disk: z.array(
    z.object({
      id: z.enum(['data', 'root']),
      totalBytes: z.number(),
      freeBytes: z.number(),
      usedPercent: z.number(),
      state: State,
    }),
  ),
  database: z.object({ sizeBytes: z.number(), connections: z.number() }).nullable(),
  redis: z.object({ usedMemoryBytes: z.number(), maxMemoryBytes: z.number().nullable() }).nullable(),
  tracing: z.object({ enabled: z.boolean(), exporting: z.boolean(), slow: z.number(), errors: z.number() }),
  logs: z.object({
    enabled: z.boolean(),
    retentionDays: z.number(),
    dropped: z.number(),
    lastError: z.string().nullable(),
  }),
});

const TraceSummary = z.object({
  traceId: z.string(),
  root: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  error: z.boolean(),
  slow: z.boolean(),
  spanCount: z.number(),
  droppedSpans: z.number(),
  attributes: Attrs,
});

const TraceDetail = TraceSummary.omit({ attributes: true }).extend({
  spans: z.array(
    z.object({
      spanId: z.string(),
      parentSpanId: z.string().nullable(),
      name: z.string(),
      kind: z.number(),
      startMs: z.number(),
      durationMs: z.number(),
      error: z.boolean(),
      attributes: Attrs,
    }),
  ),
});

const Id = z.string().regex(/^[A-Za-z0-9_.:@-]{1,64}$/);
const LEVELS = Object.keys(LOG_LEVEL_NUMBERS) as [LogLevelName, ...LogLevelName[]];

export const LogQuery = z.object({
  level: z.enum(LEVELS).optional(),
  component: Id.optional(),
  reqId: Id.optional(),
  jobId: Id.optional(),
  workerId: Id.optional(),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  q: z.string().min(1).max(200).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const LogLineBody = z.object({
  id: z.string(),
  at: z.string(),
  level: z.number(),
  levelName: z.string(),
  component: z.string().nullable(),
  reqId: z.string().nullable(),
  jobId: z.string().nullable(),
  workerId: z.string().nullable(),
  traceId: z.string().nullable(),
  msg: z.string(),
  fields: Attrs.nullable(),
});

const LogsBody = z.object({
  enabled: z.boolean(),
  retentionDays: z.number(),
  lines: z.array(LogLineBody),
  nextBefore: z.string().nullable(),
  since: z.string().nullable(),
  until: z.string().nullable(),
});

export interface SystemRouteDeps {
  readonly status: SystemStatusService;
  readonly traces: () => RecentTraces | null;
  readonly logs: () => LogStore | null;
}

export function systemRoutes(deps: SystemRouteDeps) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/system/status',
      {
        config: { authz: { action: 'system.status' } },
        schema: {
          tags: ['system'],
          summary:
            'System status: services, queue, workers, errors of the last hour, disk (owners and admins)',
          security: [{ session: [] }],
          response: { 200: SystemStatusBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      // The service's readonly view is the response shape.
      async () => (await deps.status.snapshot()) as unknown as z.infer<typeof SystemStatusBody>,
    );

    r.get(
      '/system/traces',
      {
        config: { authz: { action: 'system.status' } },
        schema: {
          tags: ['system'],
          summary: 'Recent slow or failed traces kept in memory (owners and admins)',
          security: [{ session: [] }],
          querystring: z.object({
            kind: z.enum(['slow', 'error', 'all']).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          }),
          response: {
            200: z.object({ enabled: z.boolean(), traces: z.array(TraceSummary) }),
            401: ErrorBody,
            403: ErrorBody,
          },
        },
      },
      (req) => {
        const t = deps.traces();
        if (t === null) return { enabled: false, traces: [] };
        return { enabled: true, traces: t.list(req.query.kind ?? 'all', req.query.limit ?? 50) };
      },
    );

    r.get(
      '/system/traces/:traceId',
      {
        config: { authz: { action: 'system.status' } },
        schema: {
          tags: ['system'],
          summary: 'One recent trace with its spans (owners and admins)',
          security: [{ session: [] }],
          params: z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) }),
          response: { 200: TraceDetail, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      (req) => {
        const t = deps.traces()?.get(req.params.traceId);
        if (t === undefined) throw new HttpError(404, 'trace_not_found', 'This trace is no longer kept.');
        return t as unknown as z.infer<typeof TraceDetail>;
      },
    );

    r.get(
      '/system/logs',
      {
        config: { authz: { action: 'system.logs' } },
        schema: {
          tags: ['system'],
          summary: "Search the master's recent redacted log lines (owners and admins)",
          security: [{ session: [] }],
          querystring: LogQuery,
          response: { 200: LogsBody, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (req) => {
        const store = deps.logs();
        if (store === null || !store.enabled)
          return { enabled: false, retentionDays: 0, lines: [], nextBefore: null, since: null, until: null };
        const q = req.query;
        const since = q.since === undefined ? undefined : new Date(q.since);
        const until = q.until === undefined ? undefined : new Date(q.until);
        if (since !== undefined && until !== undefined && since > until)
          throw new HttpError(400, 'invalid_range', 'The start of the range must not be after its end.');
        const res = await store.search({
          ...(q.level === undefined ? {} : { level: q.level }),
          ...(q.component === undefined ? {} : { component: q.component }),
          ...(q.reqId === undefined ? {} : { reqId: q.reqId }),
          ...(q.jobId === undefined ? {} : { jobId: q.jobId }),
          ...(q.workerId === undefined ? {} : { workerId: q.workerId }),
          ...(q.traceId === undefined ? {} : { traceId: q.traceId }),
          ...(q.q === undefined ? {} : { text: q.q }),
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          ...(q.before === undefined ? {} : { before: q.before }),
          ...(q.limit === undefined ? {} : { limit: q.limit }),
        });
        return {
          enabled: true,
          retentionDays: store.config.retentionDays,
          lines: [...res.lines],
          nextBefore: res.nextBefore,
          since: res.since,
          until: res.until,
        };
      },
    );
  };
}
