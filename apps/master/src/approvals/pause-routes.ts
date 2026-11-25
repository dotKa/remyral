import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { APPROVAL_PAUSE_DEFAULTS, APPROVAL_PAUSE_LIMITS } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import type { AuditRecorder } from '../audit/audit.js';
import { requireStepUp } from '../auth/hooks.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { IllegalTransitionError, InvalidJobError, JobStoreError } from '../jobs/errors.js';
import { type ApprovalPauseService, type JobPauseView, PauseError } from './pause.js';
import {
  type ApprovalPauseSettings,
  ApprovalPauseSettingsError,
  loadPauseSettings,
  savePauseSettings,
} from './pause-settings.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * p10-approval-pause REST (docs/design/p10-approval-pause.md §5): resume now / restart from scratch of a paused job,
 * "Continue" of a job whose approval expired, and the project's long-wait timing (Project → Policy). Cancelling a
 * paused job is the normal `POST /jobs/:id/cancel`.
 */

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const PauseBody = z.object({
  id: z.string(),
  status: z.enum(['pausing', 'paused', 'resuming', 'resumed', 'restarted', 'cancelled', 'expired']),
  requestId: z.string(),
  action: z.string(),
  summary: z.string(),
  workerId: z.string(),
  workerName: z.string().nullable(),
  requestedAt: z.string(),
  pausedAt: z.string().nullable(),
  retainUntil: z.string(),
  resumeMode: z.enum(['session', 'continuation']).nullable(),
  activeMs: z.number().int(),
  decision: z.enum(['approve', 'deny']).nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  resumeRequestedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
});

const SettingsBody = z.object({
  project: z.string(),
  staleAfterSec: z.number().int(),
  pauseAfterSec: z.number().int(),
  retentionSec: z.number().int(),
  defaults: z.object({
    staleAfterSec: z.number().int(),
    pauseAfterSec: z.number().int(),
    retentionSec: z.number().int(),
  }),
  limits: z.object({
    minStaleAfterSec: z.number().int(),
    maxStaleAfterSec: z.number().int(),
    minPauseAfterSec: z.number().int(),
    maxPauseAfterSec: z.number().int(),
    minRetentionSec: z.number().int(),
    maxRetentionSec: z.number().int(),
  }),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function pauseJson(p: JobPauseView): z.infer<typeof PauseBody> {
  return {
    ...p,
    requestedAt: p.requestedAt.toISOString(),
    pausedAt: iso(p.pausedAt),
    retainUntil: p.retainUntil.toISOString(),
    resumeRequestedAt: iso(p.resumeRequestedAt),
    endedAt: iso(p.endedAt),
  };
}

function settingsJson(project: string, s: ApprovalPauseSettings): z.infer<typeof SettingsBody> {
  return {
    project,
    ...s,
    defaults: { ...APPROVAL_PAUSE_DEFAULTS },
    limits: { ...APPROVAL_PAUSE_LIMITS },
  };
}

function toHttp(err: unknown): unknown {
  if (err instanceof PauseError || err instanceof ApprovalPauseSettingsError) {
    return new HttpError(err.status, err.code, err.message);
  }
  if (err instanceof InvalidJobError) {
    return new HttpError(
      400,
      'invalid_job',
      `The job cannot be continued: ${err.issues.map((i) => `${i.path || '(root)'}:${i.code}`).join(', ')}`.slice(
        0,
        1000,
      ),
      {},
      {},
      {
        reason: 'continue',
        issues: err.issues
          .map((i) => `${i.path || '(root)'}:${i.code}`)
          .join(', ')
          .slice(0, 300),
      },
    );
  }
  if (err instanceof IllegalTransitionError) {
    return new HttpError(
      409,
      'illegal_transition',
      `The job cannot do this in state ${err.from}.`,
      {},
      {},
      { state: err.from },
    );
  }
  if (err instanceof JobStoreError) {
    return new HttpError(409, 'conflict', 'The job changed concurrently. Reload and try again.');
  }
  return err;
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

function actor(request: FastifyRequest): { id: string; ip: string | null; userAgent: string | null } {
  const meta = requestMeta(request);
  return { id: sessionOf(request).user.id, ip: meta.ip, userAgent: meta.userAgent ?? null };
}

export function approvalPauseRoutes(deps: {
  readonly service: ApprovalPauseService;
  readonly pool: Pool;
  readonly db: Queryable;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const csrf = [{ session: [], csrf: [] }];
    const session = [{ session: [] }];
    const job = {
      resource: jobResource(deps.db),
      notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
    };

    r.post(
      '/jobs/:id/resume',
      {
        config: {
          authz: {
            action: 'jobs.resume',
            ...job,
            auditDenied: { action: 'job.pause.resume', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'A job paused for an approval: `resume` — resume it now on its machine (after the approval was decided; 409 decision_required otherwise) — or `restart` — restart it from scratch as a new attempt (operator+, audited).',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({
            mode: z.enum(['resume', 'restart']),
            reason: z.string().max(500).optional(),
          }),
          response: {
            200: z.object({
              job: z.object({ id: z.string(), state: z.string() }),
              pause: PauseBody.nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => {
          const out = await deps.service.requestResume(
            request.params.id,
            request.body.mode,
            actor(request),
            request.body.reason,
          );
          return {
            job: { id: request.params.id, state: out.state },
            pause: out.pause === null ? null : pauseJson(out.pause),
          };
        }),
    );

    r.post(
      '/jobs/:id/continue',
      {
        config: {
          authz: {
            action: 'jobs.create',
            ...job,
            auditDenied: { action: 'job.pause.continue', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Continue a failed or cancelled job whose approval expired: a new job with the same settings and a continuation prompt (the earlier result summary and what expired). Nothing is pre-approved (operator+).',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({}).optional(),
          response: { 201: z.object({ jobId: z.string() }), ...errors },
        },
      },
      async (request, reply) =>
        mapped(async () => {
          const out = await deps.service.continueAfterExpiry(request.params.id, actor(request));
          return reply.code(201).send(out);
        }),
    );

    r.get(
      '/projects/:id/approval-pause',
      {
        config: { authz: { action: 'policy.read', resource: projectParam() } },
        schema: {
          tags: ['approvals'],
          summary:
            'Long approval waits of a project: stale after, pause after and how long a paused job waits (owner/admin)',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const exists = await deps.db.query('SELECT 1 FROM projects WHERE id = $1', [request.params.id]);
        if ((exists.rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
        return settingsJson(request.params.id, await loadPauseSettings(deps.db, request.params.id));
      },
    );

    r.put(
      '/projects/:id/approval-pause',
      {
        config: {
          authz: {
            action: 'policy.write',
            resource: projectParam(),
            auditDenied: { action: 'project.approval_pause.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags: ['approvals'],
          summary:
            'Change the project’s long approval waits (owner/admin, step-up, audited). staleAfterSec < pauseAfterSec; retention 1 h – 7 d.',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.object({
            staleAfterSec: z.number().int(),
            pauseAfterSec: z.number().int(),
            retentionSec: z.number().int(),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const a = actor(request);
          const saved = await savePauseSettings(deps.pool, deps.audit, request.params.id, request.body, {
            userId: a.id,
            ip: a.ip,
            userAgent: a.userAgent,
          });
          return settingsJson(request.params.id, saved);
        }),
    );
  };
}
