import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { requireStepUp } from '../auth/hooks.js';
import { unauthorized } from '../http/route-auth.js';
import type { ActorContext, FleetService } from './fleet.js';
import type { RotationService } from './rotation.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const Iso = z.string().nullable();
export const WorkerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** p15-chat-cards-scroll (additive): the name a person gave the machine; null = `name` is its hostname. */
  label: z.string().nullable(),
  state: z.string(),
  quarantineReason: z.string().nullable(),
  connected: z.boolean(),
  fingerprint: z.string().nullable(),
  os: z.string().nullable(),
  arch: z.string().nullable(),
  osVersion: z.string().nullable(),
  hostname: z.string().nullable(),
  workerVersion: z.string(),
  protocolVersion: z.string().nullable(),
  runningJobs: z.number().int(),
  lastSeenAt: Iso,
  createdAt: z.string(),
  approvedAt: Iso,
  pairingExpiresAt: Iso,
  pairingExpired: z.boolean(),
  drainRequestedAt: Iso,
  revokedAt: Iso,
  archivedAt: Iso,
});

const Capability = z.object({ status: z.string(), note: z.string().optional() });
export const WorkerDetailSchema = WorkerSummarySchema.extend({
  credentials: z.array(
    z.object({
      fingerprint: z.string(),
      status: z.string(),
      createdAt: z.string(),
      activatedAt: Iso,
      retiredAt: Iso,
    }),
  ),
  runtimes: z.array(
    z.object({
      runtime: z.string(),
      version: z.string(),
      os: z.string(),
      arch: z.string(),
      installed: z.boolean(),
      authenticated: z.string(),
      pinnedVersion: z.string().nullable(),
      pinStatus: z.string(),
      present: z.boolean(),
      capabilities: z.record(z.string(), Capability),
      lastReportedAt: z.string(),
    }),
  ),
  load: z
    .object({
      cpuPercent: z.number(),
      memoryFreeBytes: z.number(),
      diskFreeBytes: z.number(),
      // p15-merge-approvals item 4: free disk vs. the minimum under the workspace root (newer workers).
      workspaceDisk: z.object({ freeBytes: z.number(), minFreeBytes: z.number() }).optional(),
    })
    .nullable(),
  sandboxProfiles: z.array(z.string()),
  tools: z.array(z.object({ name: z.string(), version: z.string() })),
  maxParallelJobs: z.number().int().nullable(),
  capabilitiesAt: Iso,
  drainReason: z.string().nullable(),
  /** p17-chat-reconnect (additive): the latest connection drops as the worker reported them, newest first. */
  disconnects: z.array(
    z.object({
      at: z.string(),
      receivedAt: z.string(),
      cause: z.string(),
      code: z.number().int().optional(),
      detail: z.string().optional(),
      connectedMs: z.number().int().optional(),
      pongWaitMs: z.number().int().optional(),
      loopDelayMaxMs: z.number().int().optional(),
    }),
  ),
});

const Params = z.object({ id: z.string().min(1).max(64) });

export function actorOf(request: FastifyRequest): ActorContext {
  const session = request.auth?.session;
  if (!session) throw unauthorized(); // unreachable: the auth hook ran before the handler
  return { userId: session.user.id, ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/** Fleet REST API (p2-pairing). Full session everywhere; state changes also need step-up (ADR-0009 §10). */
export function fleetRoutes(
  fleet: FleetService,
  rotation: RotationService,
  clock: () => Date = () => new Date(),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['workers'];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/workers',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags,
          summary:
            'List workers with their state (pending enrollments first); archived workers only with ?archived=1',
          querystring: z.object({ archived: z.enum(['0', '1']).optional(), ...offsetQuery(500) }),
          response: {
            200: z.object({ workers: z.array(WorkerSummarySchema), total: pageFields.total }),
            ...errors,
          },
        },
      },
      async (request) => {
        const page = pageArray(await fleet.list({ archived: request.query.archived === '1' }), request.query);
        return { workers: page.items, total: page.total };
      },
    );

    r.get(
      '/workers/:id',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags,
          summary: 'One worker with credentials and reported runtimes',
          params: Params,
          response: { 200: WorkerDetailSchema, ...errors },
        },
      },
      async (request) => fleet.get(request.params.id),
    );

    r.post(
      '/workers/:id/approve',
      {
        config: { authz: { action: 'workers.approve' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Approve a pending enrollment; the pairing code shown on the worker must be entered (step-up)',
          security: csrf,
          params: Params,
          body: z.object({ pairingCode: z.string().min(1).max(32) }),
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) => fleet.approve(request.params.id, request.body.pairingCode, actorOf(request)),
    );

    r.post(
      '/workers/:id/deny',
      {
        config: { authz: { action: 'workers.approve' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Deny a pending enrollment; the device key is never accepted again (step-up)',
          security: csrf,
          params: Params,
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) => fleet.deny(request.params.id, actorOf(request)),
    );

    r.put(
      '/workers/:id/name',
      {
        config: { authz: { action: 'workers.rename' } },
        schema: {
          tags,
          summary:
            'Give a machine a display name (1–60 characters, unique among listed machines) or clear it with null / "" (the hostname again); audited',
          security: csrf,
          params: Params,
          body: z.object({ name: z.string().max(200).nullable() }),
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) => fleet.rename(request.params.id, request.body.name, actorOf(request)),
    );

    r.post(
      '/workers/:id/drain',
      {
        config: { authz: { action: 'workers.drain' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Drain a worker: finish running jobs, accept no new ones (step-up)',
          security: csrf,
          params: Params,
          body: z.object({ reason: z.string().min(1).max(500).optional() }).optional(),
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) =>
        fleet.drain(
          request.params.id,
          request.body?.reason ?? 'drain requested by an administrator',
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/revoke',
      {
        config: { authz: { action: 'workers.revoke' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Revoke a worker: credentials revoked, socket closed at once, future connects refused (step-up)',
          security: csrf,
          params: Params,
          body: z.object({ reason: z.string().min(1).max(500).optional() }).optional(),
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) =>
        fleet.revoke(
          request.params.id,
          request.body?.reason ?? 'revoked by an administrator',
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/archive',
      {
        config: { authz: { action: 'workers.archive' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Remove a denied/revoked, disconnected worker from the fleet list (kept with its audit trail; step-up)',
          security: csrf,
          params: Params,
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) => fleet.archive(request.params.id, actorOf(request)),
    );

    r.post(
      '/workers/:id/unarchive',
      {
        config: { authz: { action: 'workers.archive' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Put an archived worker back on the fleet list (step-up)',
          security: csrf,
          params: Params,
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) => fleet.unarchive(request.params.id, actorOf(request)),
    );

    r.post(
      '/workers/:id/rotate',
      {
        config: { authz: { action: 'workers.rotate' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Ask an online worker to rotate its device key (ADR-0005 §5; step-up)',
          security: csrf,
          params: Params,
          response: {
            202: z.object({ status: z.literal('requested'), requiresApproval: z.boolean() }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        await rotation.request(request.params.id, actorOf(request));
        return reply
          .code(202)
          .send({ status: 'requested' as const, requiresApproval: rotation.requiresApproval });
      },
    );

    r.post(
      '/workers/:id/approve-rotation',
      {
        config: { authz: { action: 'workers.rotate' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Activate a rotated key that waits for approval (step-up)',
          security: csrf,
          params: Params,
          response: { 200: WorkerSummarySchema, ...errors },
        },
      },
      async (request) => {
        await rotation.approve(request.params.id, actorOf(request));
        return fleet.get(request.params.id);
      },
    );
  };
}
