import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { DiskHygieneReport } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { fleetOverview, type PolicyView, workerHistory } from './overview.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const WORKER_ID = /^wrk_[a-z2-7]{26}$/;

const Cell = z.object({
  runtime: z.string(),
  status: z.string(),
  version: z.string().nullable(),
  reason: z.string(),
  /** p14-i18n-reasons (additive): `cause` picks the console's sentence variant (REASON_CAUSES). */
  params: z.object({ cause: z.string() }).optional(),
});

const RuntimePeak = z.object({
  runtime: z.string(),
  peakBytes: z.number(),
  perJobBytes: z.number(),
  source: z.enum(['measured', 'fleet', 'default']),
  attempts: z.number().int(),
});

const Overview = z.object({
  id: z.string(),
  capacity: z.object({ running: z.number().int(), max: z.number().int().nullable() }),
  /** p9-queue-priority: per-profile slots ("3 slots (host: 1)"), running per profile, the urgent reserve. */
  queue: z.object({
    profileSlots: z.record(z.string(), z.number().int()).nullable(),
    exclusiveProfiles: z.array(z.string()),
    profileRunning: z.record(z.string(), z.number().int()),
    urgentReserve: z.number().int(),
    urgentReserveAuto: z.boolean(),
  }),
  capabilitiesAt: z.string().nullable(),
  sandboxProfiles: z.array(z.string()),
  sandboxReadiness: z.array(
    z.object({
      profile: z.string(),
      ready: z.boolean(),
      runtimes: z.array(z.string()).nullable(),
      reason: z.string().nullable(),
    }),
  ),
  tools: z.array(z.object({ name: z.string(), version: z.string() })),
  load: z
    .object({
      cpuPercent: z.number(),
      memoryFreeBytes: z.number(),
      diskFreeBytes: z.number(),
      // p15-merge-approvals item 4: free disk vs. the minimum under the workspace root (newer workers).
      workspaceDisk: z.object({ freeBytes: z.number(), minFreeBytes: z.number() }).optional(),
    })
    .nullable(),
  network: z.object({ key: z.string(), label: z.string() }),
  runtimePolicy: z.object({
    assigned: z.string().nullable(),
    effective: z.string().nullable(),
    version: z.number().int().nullable(),
    stage: z.string().nullable(),
    inSync: z.boolean(),
  }),
  release: z.object({
    channel: z.string(),
    targetVersion: z.string().nullable(),
    lastAttempt: z
      .object({
        toVersion: z.string(),
        status: z.string(),
        reason: z.string().nullable(),
        at: z.string(),
        // p17-worker-managed (additive): what the updater said, the version it started from, the diagnostics link.
        id: z.string(),
        fromVersion: z.string(),
        detail: z.string().nullable(),
        rollback: z.boolean(),
        hasDiagnostics: z.boolean(),
      })
      .nullable(),
    /** p17-worker-managed: the version before the current one (rollback target; null when not stored). */
    previousVersion: z.string().nullable(),
  }),
  compatibility: z.array(Cell),
  parallelism: z.object({
    effective: z.number().int().nullable(),
    configured: z.number().int().nullable(),
    localCeiling: z.number().int().nullable(),
    state: z.enum(['panel', 'local_ceiling', 'pending', 'local_file', 'unknown']),
  }),
  advice: z
    .object({
      recommended: z.number().int(),
      limitedBy: z.enum(['cpu', 'memory']),
      cpuCount: z.number().int(),
      memoryBytes: z.number(),
      reserveBytes: z.number(),
      perJobBytes: z.number(),
      byCpu: z.number().int(),
      byMemory: z.number().int(),
      basis: RuntimePeak,
      runtimes: z.array(RuntimePeak),
    })
    .nullable(),
  capacityMode: z
    .object({
      mode: z.enum(['manual', 'suggest', 'auto']),
      slots: z.number().int().nullable(),
      min: z.number().int(),
      max: z.number().int(),
      suggestion: z.number().int().nullable(),
    })
    .nullable(),
  /** p6-warm-caches: shared package caches as last reported (sizes and project ids only). */
  packageCaches: z
    .object({
      enabled: z.boolean(),
      disabledReason: z.enum(['local_config', 'limit_zero']).optional(),
      maxBytes: z.number(),
      usedBytes: z.number(),
      projects: z.array(
        z.object({
          projectId: z.string(),
          bytes: z.number(),
          lastUsedAt: z.string(),
          inUse: z.boolean(),
          managers: z.array(z.object({ manager: z.string(), bytes: z.number() })),
        }),
      ),
      truncated: z.boolean().optional(),
      scannedAt: z.string().nullable(),
      lastEviction: z
        .object({ at: z.string(), projects: z.number().int(), bytes: z.number() })
        .nullable()
        .optional(),
      reportedAt: z.string(),
    })
    .nullable(),
  /** p17-disk-selfclean: the worker's own disk cleanup (supported, last report). */
  diskHygiene: z.object({
    supported: z.boolean(),
    report: DiskHygieneReport.extend({ reportedAt: z.string() }).nullable(),
  }),
});

const History = z.object({
  at: z.string(),
  action: z.string(),
  outcome: z.string(),
  actor: z.object({ type: z.string(), id: z.string().nullable() }),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

/**
 * p5-fleet-ui read endpoints (docs/design/p5-fleet-ui.md §3), `workers.read` (viewer+, global like the rest
 * of the fleet API): the per-worker overview with the runtime × worker compatibility matrix, and one worker's
 * lifecycle timeline from the audit log (worker actions only, allowlisted metadata, no IPs, no user ids).
 */
export function fleetViewRoutes(deps: {
  readonly db: Queryable;
  readonly policyOf: (workerId: string) => Promise<PolicyView>;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/fleet/overview',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags: ['workers'],
          summary:
            'Fleet overview: capacity, sandbox readiness, tools, network group, policy and release state, compatibility matrix',
          security: [{ session: [] }],
          response: { 200: z.object({ workers: z.array(Overview) }), ...errors },
        },
      },
      async () => {
        const workers = await fleetOverview(deps.db, deps.policyOf);
        return { workers: workers as z.infer<typeof Overview>[] };
      },
    );

    r.get(
      '/workers/:id/history',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags: ['workers'],
          summary:
            'A worker’s lifecycle timeline (pairing, sessions, drain, rotation, policy, updates), newest first',
          security: [{ session: [] }],
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: z.object({ items: z.array(History) }), ...errors },
        },
      },
      async (request) => {
        const id = request.params.id;
        if (!WORKER_ID.test(id))
          throw new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
        const exists = await deps.db.query('SELECT 1 FROM workers WHERE id = $1', [id]);
        if ((exists.rowCount ?? 0) === 0)
          throw new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
        return { items: await workerHistory(deps.db, id) };
      },
    );
  };
}
