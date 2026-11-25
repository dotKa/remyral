import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta } from '../audit/access.js';
import { redactRecord } from '../audit/export.js';
import type { Resource } from '../authz/model.js';
import { bodyField, jobResource, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { workflowRunResource } from '../workflows/routes.js';
import { RelatedSettingsConflictError, type RelatedWorkService } from './service.js';

/**
 * p17-embeddings (docs/design/p17-embeddings.md §6): the related-work API. Every route is scoped to one project the
 * caller may read (the job's, the workflow run's, or the one named in the request) and every answer only names items of
 * that same project — nothing of another project is ever scored, let alone returned. "Unavailable" (no provider, capture
 * off, a secret-looking text, the per-person limit) is an empty answer with a reason, never an error.
 */

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const Project = z.string().regex(PROJECT);
const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};
const Unavailable = z
  .enum(['off', 'no_provider', 'not_consented', 'secret', 'rate_limited', 'error'])
  .nullable();
const Rule = z.enum(['strong', 'lexical', 'identifiers', 'lineage', 'code', 'none']);

const SimilarJobBody = z.object({
  jobId: z.string(),
  title: z.string(),
  state: z.string(),
  finishedAt: z.string(),
  summary: z.string().nullable(),
  score: z.number(),
  rule: Rule,
});

const ResolvedFailureBody = z.object({
  failed: z.object({
    kind: z.enum(['job', 'workflow_run']),
    id: z.string(),
    title: z.string(),
    code: z.string().nullable(),
    at: z.string(),
  }),
  resolution: z.object({
    how: z.enum(['retry', 'auto_fix', 'automation', 'rerun']),
    kind: z.enum(['job', 'workflow_run']),
    id: z.string(),
    title: z.string(),
    summary: z.string().nullable(),
    at: z.string(),
  }),
  score: z.number(),
  rule: Rule,
});

const DuplicateBody = z.object({
  kind: z.enum(['job', 'automation']),
  id: z.string(),
  title: z.string(),
  state: z.string(),
  createdAt: z.string(),
  score: z.number(),
});

const SettingsBody = z.object({
  project: z.string(),
  contextEnabled: z.boolean(),
  version: z.number().int(),
  platform: z.object({ enabled: z.boolean(), context: z.boolean() }),
});

const CheckBody = z.strictObject({
  project: Project,
  /** The title / name and prompt / description of what is about to be created. */
  text: z.string().max(8000),
  /** The record being edited (left out of the answer). */
  excludeId: z.uuid().nullable().optional(),
});

/** Every answer passes the observability redactor (patterns + sensitive keys), like the job detail. */
function redacted<T>(value: T): T {
  return redactRecord({ value }).value.value as T;
}

function projectBody(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

export function relatedRoutes(deps: { readonly db: Queryable; readonly related: () => RelatedWorkService }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['related'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const hiddenJob = (): HttpError => new HttpError(404, 'job_not_found', 'Job not found.');
    const hiddenRun = (): HttpError => new HttpError(404, 'workflow_not_found', 'Workflow not found.');

    r.get(
      '/jobs/:id/related',
      {
        config: { authz: { action: 'jobs.read', resource: jobResource(deps.db), notFound: hiddenJob } },
        schema: {
          tags,
          summary:
            'p17-embeddings: similar finished jobs of the same project, what the agent was given, and (failed jobs) earlier similar failures that were solved',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              similar: z.array(SimilarJobBody),
              givenToAgent: z.array(z.string()).nullable(),
              failures: z.array(ResolvedFailureBody),
              unavailable: Unavailable,
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const svc = deps.related();
        const id = request.params.id;
        const { rows } = await deps.db.query<{ state: string }>(
          'SELECT state::text AS state FROM jobs WHERE id = $1',
          [id],
        );
        const state = rows[0]?.state;
        if (state === undefined) throw hiddenJob();
        const similar = await svc.similarJobs(id);
        const failures =
          state === 'FAILED'
            ? await svc.resolvedFailures({ kind: 'job', id })
            : { items: [], unavailable: null };
        return redacted({
          similar: similar.items,
          givenToAgent: await svc.givenToAgent(id),
          failures: failures.items,
          unavailable: similar.unavailable ?? failures.unavailable,
        });
      },
    );

    r.get(
      '/workflows/runs/:id/related',
      {
        config: {
          authz: { action: 'workflows.read', resource: workflowRunResource(deps.db), notFound: hiddenRun },
        },
        schema: {
          tags,
          summary:
            'p17-embeddings: earlier failures of the same project that look like this failed workflow run and were solved',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({ failures: z.array(ResolvedFailureBody), unavailable: Unavailable }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await deps.related().resolvedFailures({ kind: 'workflow_run', id: request.params.id });
        return redacted({ failures: out.items, unavailable: out.unavailable });
      },
    );

    for (const kind of ['job', 'automation'] as const) {
      r.post(
        kind === 'job' ? '/related/check/jobs' : '/related/check/automations',
        {
          config: {
            authz: { action: kind === 'job' ? 'jobs.read' : 'automations.read', resource: projectBody },
          },
          schema: {
            tags,
            summary:
              kind === 'job'
                ? 'p17-embeddings: open or recent jobs of the project that look like the job about to be created (a warning; never blocks)'
                : 'p17-embeddings: automations of the project that look like the one about to be created (a warning; never blocks)',
            security: csrf,
            body: CheckBody,
            response: {
              200: z.object({ items: z.array(DuplicateBody), unavailable: Unavailable }),
              ...errors,
            },
          },
        },
        async (request) => {
          const b = request.body;
          const out = await deps.related().checkDuplicate({
            userId: authzOf(request).subject.userId,
            kind,
            project: b.project,
            text: b.text,
            excludeId: b.excludeId ?? null,
          });
          return redacted({ items: out.items, unavailable: out.unavailable });
        },
      );
    }

    r.get(
      '/related/settings',
      {
        config: { authz: { action: 'jobs.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'p17-embeddings: whether jobs of the project get similar past jobs in their context (and the platform switches)',
          security: session,
          querystring: z.object({ project: Project }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => deps.related().settings(request.query.project),
    );

    r.put(
      '/related/settings',
      {
        config: {
          authz: {
            action: 'memory.suggestions.admin',
            resource: projectBody,
            auditDenied: { action: 'related.settings' },
          },
        },
        schema: {
          tags,
          summary:
            'p17-embeddings: turn similar past jobs in job contexts on or off for a project (project admin, audited)',
          security: csrf,
          body: z.strictObject({
            project: Project,
            contextEnabled: z.boolean(),
            expectedVersion: z.number().int().min(0),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        try {
          return await deps
            .related()
            .setSettings(
              { userId: authzOf(request).subject.userId, ...requestMeta(request) },
              b.project,
              b.contextEnabled,
              b.expectedVersion,
            );
        } catch (err) {
          if (err instanceof RelatedSettingsConflictError) {
            throw new HttpError(
              409,
              'related_settings_conflict',
              'The setting was changed by someone else; reload and try again.',
            );
          }
          throw err;
        }
      },
    );
  };
}
