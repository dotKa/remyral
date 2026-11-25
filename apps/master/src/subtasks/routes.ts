import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobResource } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { SubtaskService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;

/**
 * p8-orchestration (ADR-0031): a job's place in its sub-job family, for the job page tree. Read rights on the job's
 * project (`jobs.read`); a sub-job is always in its parent's project. Cancelling a sub-job is the ordinary
 * `POST /jobs/:id/cancel` on the child (its own sub-jobs follow by the cascade).
 */
export function subtaskRoutes(deps: { readonly subtasks: SubtaskService; readonly db: Queryable }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/jobs/:id/subtasks',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'p8-orchestration: the job’s parent (when it is a sub-job requested by another job’s agent) and the sub-jobs its own agent requested — state, runtime, machine, how the runtime was chosen, files delivered.',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              parent: z
                .object({ jobId: z.string(), title: z.string(), state: z.string(), depth: z.number().int() })
                .nullable(),
              children: z.array(
                z.object({
                  jobId: z.string(),
                  title: z.string(),
                  state: z.string(),
                  runtime: z.string(),
                  worker: z.string().nullable(),
                  depth: z.number().int(),
                  wait: z.boolean(),
                  placement: z.record(z.string(), z.unknown()),
                  deliveredFiles: z.number().int(),
                  createdAt: z.string(),
                }),
              ),
            }),
            401: ErrorBody,
            403: ErrorBody,
            404: ErrorBody,
          },
        },
      },
      async (request) => {
        const v = await deps.subtasks.view(request.params.id);
        return {
          parent: v.parent,
          children: v.children.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
        };
      },
    );
  };
}
