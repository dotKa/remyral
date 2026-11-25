import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { JobClockService } from './job-clock.js';
import type { TimeLimitService } from './time-limit.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};

const ChangeBody = z.object({
  seq: z.number().int(),
  fromSec: z.number().int(),
  toSec: z.number().int(),
  actor: z.string().nullable(),
  delivery: z.enum(['not_running', 'sent', 'unsupported']),
  application: z.enum(['applied', 'refused']).nullable(),
  remainingSec: z.number().int().nullable(),
  // p22-timeout-continuity: 'auto' = extended by the platform at the time warning (autonomy.autoExtendTime).
  via: z.enum(['console', 'chat', 'auto']),
  createdAt: z.string(),
});

export const TimeLimitBody = z.object({
  jobId: z.string(),
  maxDurationSec: z.number().int(),
  originalSec: z.number().int(),
  maxAllowedSec: z.number().int(),
  minSec: z.number().int(),
  canChange: z.boolean(),
  reason: z.string().nullable(),
  live: z.object({ startedAt: z.string().nullable(), supportsLive: z.boolean() }).nullable(),
  changes: z.array(ChangeBody),
  /** p20-job-clock: run time, human waits apart, the time warning, "continue after a timeout". */
  clock: z
    .object({
      clock: z
        .object({
          budgetSec: z.number().int(),
          activeSec: z.number().int(),
          remainingSec: z.number().int(),
          approvalWaitSec: z.number().int(),
          questionWaitSec: z.number().int(),
          waiting: z.enum(['approval', 'question']).nullable(),
          idleSec: z.number().int().nullable(),
          at: z.string().nullable(),
          final: z.boolean(),
        })
        .nullable(),
      questionsPauseClock: z.boolean().nullable(),
      warning: z.object({ at: z.string(), limitSec: z.number().int() }).nullable(),
      thresholdSec: z.number().int(),
      timedOut: z.boolean(),
      canContinue: z.boolean(),
      continueSec: z.number().int().nullable(),
      /** p22-timeout-continuity: the unfinished work the timed-out attempt kept ("Aynı yerden devam et" starts there). */
      keptWork: z
        .object({
          branch: z.string(),
          commit: z.string(),
          files: z.number().int(),
          pushed: z.boolean(),
          ref: z.string().optional(),
          reason: z.string().optional(),
          workerId: z.string(),
        })
        .nullable(),
    })
    .nullable(),
});

/**
 * p15-autonomy (docs/design/p15-autonomy.md §10): a job's time limit. `GET` viewer+ (`jobs.read`); `POST` operator+
 * (`jobs.timelimit`, CSRF, step-up event `jobs.control`; audited). A running job's worker is told with a signed
 * SET_TIME_LIMIT and the run continues.
 */
export function timeLimitRoutes(deps: {
  readonly service: TimeLimitService;
  /** p20-job-clock: "continue after a timeout" (absent: the route answers 503). */
  readonly jobClock?: () => JobClockService | null;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const jobNotFound = () => new HttpError(404, 'job_not_found', 'Job not found.');

    r.get(
      '/jobs/:id/time-limit',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags,
          summary:
            'The job’s time limit: current and original, the security policy’s maximum, whether the caller may change it, whether a running machine takes a live change, and the change history',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: TimeLimitBody, ...errors },
        },
      },
      async (request) => deps.service.status(request.params.id, authzOf(request).subject),
    );

    r.post(
      '/jobs/:id/time-limit',
      {
        config: {
          authz: {
            action: 'jobs.timelimit',
            resource: jobResource(deps.db),
            notFound: jobNotFound,
            auditDenied: { action: 'job.time_limit.change', target: paramTarget('job') },
          },
        },
        preHandler: requireStepUp('standard', deps.clock),
        schema: {
          tags,
          summary:
            'Set (maxDurationSec) or extend (addSec) the time limit of a queued or running job without restarting it (operator+, up to the security policy maximum, audited)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          body: z
            .object({
              maxDurationSec: z
                .number()
                .int()
                .min(1)
                .max(7 * 24 * 3600)
                .optional(),
              addSec: z
                .number()
                .int()
                .min(-7 * 24 * 3600)
                .max(7 * 24 * 3600)
                .optional(),
              reason: z.string().max(1000).optional(),
            })
            .refine((b) => (b.maxDurationSec === undefined) !== (b.addSec === undefined), {
              message: 'Give maxDurationSec or addSec.',
            }),
          response: { 200: z.object({ changed: z.boolean(), timeLimit: TimeLimitBody }), ...errors },
        },
      },
      async (request) => {
        const { subject } = authzOf(request);
        return deps.service.change(
          request.params.id,
          {
            ...(request.body.maxDurationSec === undefined
              ? {}
              : { maxDurationSec: request.body.maxDurationSec }),
            ...(request.body.addSec === undefined ? {} : { addSec: request.body.addSec }),
            ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
          },
          { subject, ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
        );
      },
    );

    // p20-job-clock: "Aynı yerden devam et" for a job that stopped on its time limit.
    r.post(
      '/jobs/:id/continue-after-timeout',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: jobResource(deps.db),
            notFound: jobNotFound,
            auditDenied: { action: 'job.timeout.continue', target: paramTarget('job') },
          },
        },
        // Like POST /jobs/:id/continue (an expired approval) and starting a job: no step-up (nothing is pre-approved).
        schema: {
          tags,
          summary:
            'Continue a job that stopped on its time limit: a new job with the same settings, a longer limit (default: the old one plus half, at least 30 min, within the security policy maximum), the earlier summary in its prompt and — for a workspace job — the earlier job’s kept working directory (operator+, audited)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          body: z
            .strictObject({
              maxDurationSec: z
                .number()
                .int()
                .min(1)
                .max(7 * 24 * 3600)
                .optional(),
            })
            .optional(),
          response: {
            201: z.object({
              jobId: z.string(),
              maxDurationSec: z.number().int(),
              // p22-timeout-continuity: where the continuation starts (the kept commit, pushed or on one machine).
              from: z.enum(['pushed', 'machine', 'base']),
              workerId: z.string().nullable(),
            }),
            ...errors,
            503: ErrorBodySchema,
          },
        },
      },
      async (request, reply) => {
        const svc = deps.jobClock?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Continue is not available.',
            {},
            {},
            { reason: 'continue' },
          );
        const { subject } = authzOf(request);
        const out = await svc.continueAfterTimeout(
          request.params.id,
          request.body?.maxDurationSec === undefined ? {} : { maxDurationSec: request.body.maxDurationSec },
          { subject, ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
        );
        return reply.code(201).send(out);
      },
    );
  };
}
