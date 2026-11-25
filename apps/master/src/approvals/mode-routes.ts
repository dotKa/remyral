import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { ApprovalModeActor, ApprovalModeService } from './mode-switch.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
const Mode = z.enum(['ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all']);

const ChangeBody = z.object({
  id: z.string(),
  seq: z.number().int(),
  from: Mode,
  to: Mode,
  actor: z.object({ id: z.string(), username: z.string() }),
  jobState: z.string(),
  workerId: z.string().nullable(),
  delivery: z.enum(['not_running', 'sent']),
  application: z.enum(['live', 'gate', 'partial', 'next_turn', 'refused']).nullable(),
  detail: z.string().nullable(),
  appliedAt: z.string().nullable(),
  pendingResolved: z.number().int(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});

export const ApprovalModeBody = z.object({
  current: Mode,
  original: Mode,
  seq: z.number().int(),
  machineAdmin: z.boolean(),
  canChange: z.boolean(),
  reason: z.string().nullable(),
  options: z.array(z.object({ mode: Mode, allowed: z.boolean(), reason: z.string().nullable() })),
  live: z.object({ workerId: z.string(), supportsSwitch: z.boolean() }).nullable(),
  changes: z.array(ChangeBody),
});

function actorOf(request: FastifyRequest): ApprovalModeActor {
  const auth = request.auth;
  if (!auth) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
  return {
    subject: authzOf(request).subject,
    mfaAt: auth.session.mfaAt,
    // p15-autonomy: the session's always-fresh age already carries the security policy's cap (10 min in "Sıkı").
    alwaysFreshMaxAgeMs: auth.stepUp.alwaysFreshMaxAgeMs,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/**
 * p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md §4): read and change a job's approval mode.
 * `GET` is `jobs.read` (viewer+); `POST` is `jobs.approval.mode` (operator+, CSRF; a machine-admin job going to
 * `allow-all` also needs an always-fresh step-up, checked by the service). Denials are audited.
 */
export function approvalModeRoutes(deps: { readonly service: ApprovalModeService; readonly db: Queryable }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const jobNotFound = () => new HttpError(404, 'job_not_found', 'Job not found.');

    r.get(
      '/jobs/:id/approval-mode',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags,
          summary:
            'The job’s approval mode: current and original, whether the caller may change it, which modes are allowed and the change history (viewer+)',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: ApprovalModeBody, ...errors },
        },
      },
      async (request) => deps.service.status(request.params.id, authzOf(request).subject),
    );

    r.post(
      '/jobs/:id/approval-mode',
      {
        config: {
          authz: {
            action: 'jobs.approval.mode',
            resource: jobResource(deps.db),
            notFound: jobNotFound,
            auditDenied: { action: 'job.approval_mode.change', target: paramTarget('job') },
          },
        },
        schema: {
          tags,
          summary:
            'Change the approval mode of a queued or running job (operator+; allow-all only where a new job could use it; a running job’s worker is told with a signed message; audited)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            mode: Mode,
            expectedSeq: z.number().int().min(0),
            reason: z.string().max(1000).optional(),
          }),
          response: { 200: z.object({ changed: z.boolean(), approvalMode: ApprovalModeBody }), ...errors },
        },
      },
      async (request) =>
        deps.service.change(
          request.params.id,
          {
            mode: request.body.mode,
            expectedSeq: request.body.expectedSeq,
            ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
          },
          actorOf(request),
        ),
    );
  };
}
