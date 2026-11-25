import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { actorOf } from '../workers/routes.js';
import { HARD_MAX } from './controller.js';
import type { CapacityService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const Params = z.object({ id: z.string().min(1).max(64) });
const Mode = z.enum(['manual', 'suggest', 'auto']);
const ReasonBody = z.object({ code: z.string(), text: z.string() });
const Action = z.enum(['raise', 'lower', 'clamp', 'hold']);

const CapacityBody = z.object({
  workerId: z.string(),
  mode: Mode,
  min: z.number().int(),
  max: z.number().int(),
  slots: z.number().int().nullable(),
  effective: z.number().int().nullable(),
  configured: z.number().int().nullable(),
  reportedMax: z.number().int().nullable(),
  hardwareCeiling: z.number().int().nullable(),
  upper: z.number().int(),
  managed: z.boolean(),
  metricsSupported: z.boolean(),
  suggestion: z.object({ value: z.number().int(), reasons: z.array(ReasonBody) }).nullable(),
  lastDecision: z
    .object({
      at: z.string(),
      action: Action,
      from: z.number().int(),
      to: z.number().int(),
      estimate: z.number().int().nullable(),
      reasons: z.array(ReasonBody),
    })
    .nullable(),
  metrics: z
    .object({
      at: z.string().nullable(),
      cpuPercent: z.number().nullable(),
      memoryAvailableBytes: z.number().nullable(),
      memoryTotalBytes: z.number().nullable(),
      swapUsedBytes: z.number().nullable(),
      swapTotalBytes: z.number().nullable(),
      swapInPerSec: z.number().nullable(),
      commitPercent: z.number().nullable(),
      memoryPressurePercent: z.number().nullable(),
      running: z.number().int(),
      waiting: z.number().int(),
      oomFailures: z.number().int(),
      timeouts: z.number().int(),
      slowdownRatio: z.number().nullable(),
    })
    .nullable(),
  events: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      kind: z.enum(['raise', 'lower', 'clamp', 'suggest', 'mode', 'bounds', 'override']),
      mode: Mode,
      from: z.number().int().nullable(),
      to: z.number().int().nullable(),
      reasons: z.array(ReasonBody),
      actor: z.object({ type: z.enum(['user', 'system']), id: z.string().nullable() }),
    }),
  ),
});

/**
 * p8-capacity-auto (docs/design/p8-capacity-auto.md §6): a machine's capacity mode, bounds, the controller's last
 * decision and the change history. Read: `workers.read` (viewer+, like the fleet overview — numbers and reason
 * sentences only). Write: `workers.config.write` (admin) + step-up + CSRF, audited.
 */
export function capacityRoutes(service: CapacityService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, clock);
    r.get(
      '/workers/:id/capacity',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags: ['workers'],
          summary:
            'A machine’s capacity mode (manual / suggest / auto), bounds, live metrics, the last decision and the history',
          security: [{ session: [] }],
          params: Params,
          response: { 200: CapacityBody, ...errors },
        },
      },
      async (request) => (await service.get(request.params.id)) as z.infer<typeof CapacityBody>,
    );
    r.put(
      '/workers/:id/capacity',
      {
        config: { authz: { action: 'workers.config.write' } },
        preHandler: stepUp,
        schema: {
          tags: ['workers'],
          summary:
            'Set a machine’s capacity mode and bounds (admin, step-up). Auto needs a panel-managed machine; a manual maxParallelJobs change later switches auto off.',
          security: [{ session: [], csrf: [] }],
          params: Params,
          body: z.strictObject({
            mode: Mode,
            min: z.number().int().min(1).max(HARD_MAX),
            max: z.number().int().min(1).max(HARD_MAX),
          }),
          response: { 200: CapacityBody, ...errors },
        },
      },
      async (request) =>
        (await service.set(request.params.id, request.body, actorOf(request))) as z.infer<
          typeof CapacityBody
        >,
    );
  };
}
