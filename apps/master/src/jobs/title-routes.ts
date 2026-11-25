import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { JobTitles } from './titles.js';

const errors = { 400: ErrorBodySchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 404: ErrorBodySchema };

export const JobTitleBody = z.object({
  jobId: z.string(),
  title: z.string(),
  source: z.enum(['given', 'derived', 'edited']),
  updatedAt: z.string().nullable(),
});

/**
 * p15-job-titles (docs/design/p15-job-titles.md §4): a job's short title. `GET` viewer+ (`jobs.read`); `PUT`
 * whoever may start jobs in the job's project (`jobs.create`, CSRF; audited `job.title.update`). Any state: the title
 * is not part of the immutable spec.
 */
export function jobTitleRoutes(deps: { readonly titles: JobTitles; readonly db: Queryable }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const jobNotFound = () => new HttpError(404, 'job_not_found', 'Job not found.');

    r.get(
      '/jobs/:id/title',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: jobNotFound } },
        schema: {
          tags,
          summary: 'The job’s short title and where it came from (given, derived from the prompt, edited)',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: JobTitleBody, ...errors },
        },
      },
      async (request) => {
        const v = await deps.titles.get(request.params.id);
        if (v === null) throw jobNotFound();
        return v;
      },
    );

    r.put(
      '/jobs/:id/title',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: jobResource(deps.db),
            notFound: jobNotFound,
            auditDenied: { action: 'job.title.update', target: paramTarget('job') },
          },
        },
        schema: {
          tags,
          summary:
            'Rename a job: one line, at most 60 characters (whoever may start jobs in its project; audited)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          body: z.object({ title: z.string().max(400) }),
          response: { 200: JobTitleBody, ...errors },
        },
      },
      async (request) => {
        const { subject } = authzOf(request);
        return deps.titles.set(request.params.id, request.body.title, {
          userId: subject.userId,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      },
    );
  };
}
