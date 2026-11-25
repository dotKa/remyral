import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeKind } from '@remyral/protocol';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { authorize, type Resource } from '../authz/model.js';
import { jobResource, param, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { AutofixInput, type DeployFeedbackService } from './feedback.js';
import { OpsError } from './model.js';
import type { OpsService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  424: ErrorBody,
  429: ErrorBody,
  503: ErrorBody,
};
const Json = z.record(z.string(), z.unknown());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

const Source = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
});
const AutofixBody = z.object({
  project: z.string(),
  enabled: z.boolean(),
  maxAttempts: z.number().int(),
  runtime: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpsError) throw new HttpError(err.status, err.code, err.message, err.headers);
    throw err;
  }
}

/**
 * p12-deploy-feedback (ADR-0048): deploy logs (build / runtime / health), the failure summary and fix plan of an ops
 * action, a job's fix chain and the project's auto-fix setting.
 */
export function deployFeedbackRoutes(deps: {
  readonly db: Queryable;
  readonly ops: OpsService;
  readonly feedback: DeployFeedbackService;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { ops, feedback } = deps;
    const tags = ['deploy'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', deps.clock);
    const notFound = () => new HttpError(404, 'action_not_found', 'Ops action not found.');
    const actionResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await ops.projectOf(id);
      return project === null ? null : { project };
    };
    const IdParams = z.object({ id: z.string().regex(UUID) });

    r.get(
      '/deploy/actions/:id/logs',
      {
        config: { authz: { action: 'deploy.request', resource: actionResource, notFound } },
        schema: {
          tags,
          summary:
            'Logs of an ops action (operator+; redacted, the last 64 KB per source): kind=build (Coolify deployment logs / Cloudflare Pages stages and build log; default), runtime (Coolify application logs of the project’s own resources — lines, sinceMinutes), health (the post-deploy health check: probe, TLS, broken links, findings, screenshot). `items` keeps the p6 shape (Coolify build logs).',
          security: session,
          params: IdParams,
          querystring: z.object({
            kind: z.enum(['build', 'runtime', 'health']).optional(),
            lines: z.coerce.number().int().min(10).max(2000).optional(),
            sinceMinutes: z.coerce
              .number()
              .int()
              .min(1)
              .max(7 * 24 * 60)
              .optional(),
          }),
          response: {
            200: z.object({
              items: z.array(z.object({ deploymentUuid: z.string(), logs: z.string() })),
              kind: z.enum(['build', 'runtime', 'health']),
              provider: z.enum(['coolify', 'cloudflare']).nullable(),
              sources: z.array(Source),
              health: Json.nullable(),
              note: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(async () => {
          const q = request.query;
          const since =
            q.sinceMinutes === undefined ? null : new Date(deps.clock().getTime() - q.sinceMinutes * 60_000);
          const v = await feedback.logs(request.params.id, q.kind ?? 'build', { lines: q.lines, since });
          return {
            items: [...v.items],
            kind: v.kind,
            provider: v.provider,
            sources: [...v.sources],
            health: v.health === null ? null : { ...v.health },
            note: v.note,
          };
        }),
    );

    r.get(
      '/deploy/actions/:id/failure',
      {
        config: { authz: { action: 'deploy.read', resource: actionResource, notFound } },
        schema: {
          tags,
          summary:
            'What went wrong with an ops action: the action or the health check after it failed, the error, the health summary and one paragraph to explain it (no log text).',
          security: session,
          params: IdParams,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => wrap(async () => ({ ...(await feedback.failure(request.params.id)) })),
    );

    r.get(
      '/deploy/actions/:id/fix-plan',
      {
        config: { authz: { action: 'deploy.request', resource: actionResource, notFound } },
        schema: {
          tags,
          summary:
            'The fix job for a failed deploy / unhealthy site (composer prefill; nothing is created): continue from the source job, else a repository job on the deployed ref; the failure, log excerpt and health findings in the prompt (data); deployOnSuccess = the same target, approved like any deploy on success when the job is submitted. Needs jobs.create in the project too.',
          security: session,
          params: IdParams,
          querystring: z.object({ runtime: RuntimeKind.optional() }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(async () => {
          const project = await ops.projectOf(request.params.id);
          if (project === null || !authorize(authzOf(request).subject, 'jobs.create', { project }).allow) {
            throw new HttpError(
              403,
              'forbidden',
              'You may not create jobs in this project.',
              {},
              {},
              { reason: 'create_jobs' },
            );
          }
          const plan = await feedback.fixPlan(request.params.id, { runtime: request.query.runtime });
          return { ...plan, failure: { ...plan.failure } };
        }),
    );

    r.get(
      '/jobs/:id/deploy-fixes',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'p12-deploy-feedback: the fix chain of a job — the failed deploy it fixes (fixOf) and the fix jobs started for its deploys (auto-fix decisions, with the reason when skipped).',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ fixOf: Json.nullable(), fixes: z.array(Json) }), ...errors },
        },
      },
      async (request) => {
        const c = await feedback.chain(request.params.id);
        return { fixOf: c.fixOf === null ? null : { ...c.fixOf }, fixes: c.fixes.map((f) => ({ ...f })) };
      },
    );

    r.get(
      '/projects/:id/deploy-autofix',
      {
        config: { authz: { action: 'deploy.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'The project’s auto-fix setting (off by default): a fix job per failed deploy / publish / health check of a job’s result, bounded per chain',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: { 200: AutofixBody, ...errors },
        },
      },
      async (request) => wrap(async () => feedback.autofixSettings(request.params.id)),
    );

    r.put(
      '/projects/:id/deploy-autofix',
      {
        config: {
          authz: {
            action: 'deploy.targets.write',
            resource: projectParam(),
            auditDenied: { action: 'deploy.autofix.write', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Turn auto-fix on or off (project admin, step-up). Fix jobs run as the source job’s creator; their redeploy is never pre-approved (production waits for an approval)',
          security: csrf,
          params: z.object({ id: z.string().regex(PROJECT) }),
          body: AutofixInput,
          response: { 200: AutofixBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          feedback.putAutofix(
            { userId: sessionOf(request).user.id, ...requestMeta(request) },
            request.params.id,
            request.body,
          ),
        ),
    );
  };
}
