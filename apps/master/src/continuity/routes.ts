import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobResource } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { SessionContinuityService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * p11-session-continuity REST (docs/design/p11-session-continuity.md §6): the job page's checkpoints and resume history
 * after worker restarts. Read only (any role that may read the job). Resume now / Restart from scratch / Cancel of a
 * paused job are the existing `POST /jobs/:id/resume` and `POST /jobs/:id/cancel`.
 */

const ErrorBody = ErrorBodySchema;
const ToolNote = z.object({
  callId: z.string().optional(),
  toolName: z.string(),
  class: z.enum(['idempotent', 'workspace_write', 'external', 'unknown']),
  state: z.enum(['running', 'done', 'failed']),
});

const ContinuityBody = z.object({
  checkpoints: z.array(
    z.object({
      n: z.number().int(),
      epoch: z.number().int(),
      takenAt: z.string(),
      kind: z.enum(['git', 'snapshot']),
      ref: z.string().nullable(),
      commit: z.string().nullable(),
      files: z.number().int(),
      bytes: z.number(),
      lastTool: ToolNote.nullable(),
      inFlight: z.number().int(),
    }),
  ),
  restarts: z.array(
    z.object({
      pauseId: z.string(),
      status: z.string(),
      detectedAt: z.string(),
      pausedEpoch: z.number().int(),
      resumedEpoch: z.number().int().nullable(),
      checkpoint: z.number().int(),
      checkpointAt: z.string().nullable(),
      restarts: z.number().int(),
      resume: z.enum(['session', 'continuation']),
      unknownOutcome: z.array(ToolNote),
      blockedReason: z.string().nullable(),
      endedAt: z.string().nullable(),
      endReason: z.string().nullable(),
      summary: z.string(),
    }),
  ),
});

export function continuityRoutes(deps: {
  readonly service: SessionContinuityService;
  readonly db: Queryable;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const job = {
      resource: jobResource(deps.db),
      notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
    };
    r.get(
      '/jobs/:id/continuity',
      {
        config: { authz: { action: 'jobs.read', ...job } },
        schema: {
          tags: ['jobs'],
          summary:
            'Session continuity of a job (p11-session-continuity): the current attempt’s checkpoints and the resumes after worker restarts (any role that can read the job)',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: ContinuityBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const v = await deps.service.view(request.params.id);
        return {
          checkpoints: v.checkpoints.map((c) => ({ ...c })),
          restarts: v.restarts.map((x) => ({ ...x, unknownOutcome: [...x.unknownOutcome] })),
        };
      },
    );
  };
}
