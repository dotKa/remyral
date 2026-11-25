import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requestStepUpMaxAge, requireStepUp } from '../auth/hooks.js';
import type { Resource } from '../authz/model.js';
import { jobResource, param, paramTarget, projectParam, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { DeployHealthService } from './health.js';
import { VerifySettingsInput } from './model.js';
import type { VerificationService } from './service.js';
import type { VerifySettingsStore } from './settings.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md §7): verification of a job (read: `jobs.read`; override of a
 * held gate: `deploy.approve` + always-fresh step-up checked by the service; p19-verifier-jobs retry of a verification
 * that could not run: `jobs.create`), the project's settings (read:
 * `deploy.read`; write: `deploy.targets.write` + step-up) and the post-deploy health checks (read: `deploy.read`;
 * recheck: `deploy.request`). Invisible projects answer 404.
 */

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const IdParams = z.object({ id: z.string().regex(UUID) });
const Json = z.record(z.string(), z.unknown());

const SettingsBody = z.object({
  project: z.string(),
  verifyDefault: z.enum(['off', 'report', 'gate']),
  verifyRuntime: z.string().nullable(),
  testCommand: z.string().nullable(),
  healthAfterDeploy: z.boolean(),
  healthScreenshots: z.boolean(),
  healthKeyword: z.string().nullable(),
  autoRollback: z.boolean(),
  autoRollbackProduction: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

async function projectOfRow(db: Queryable, sql: string, id: string | undefined): Promise<Resource | null> {
  if (id === undefined || !UUID.test(id)) return null;
  const { rows } = await db.query<{ project: string }>(sql, [id]);
  const project = rows[0]?.project;
  return project === undefined ? null : { project };
}

export function verifyRoutes(deps: {
  readonly db: Queryable;
  readonly verification: VerificationService;
  readonly health: DeployHealthService;
  readonly settings: VerifySettingsStore;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', deps.clock);
    const actionResource = (request: FastifyRequest): Promise<Resource | null> =>
      projectOfRow(deps.db, 'SELECT project FROM ops_actions WHERE id = $1', param(request, 'id'));
    const healthResource = (request: FastifyRequest): Promise<Resource | null> =>
      projectOfRow(deps.db, 'SELECT project FROM deploy_health_checks WHERE id = $1', param(request, 'id'));

    r.get(
      '/jobs/:id/verification',
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
            'p10-verify-health: the job’s automatic verification — mode (report / gate), state, output type, the verifier job, checks, findings, screenshots (job files) and whether it holds a deploy. null when the job has none.',
          security: session,
          params: IdParams,
          response: { 200: z.object({ verification: Json.nullable() }), ...errors },
        },
      },
      async (request) => {
        const v = await deps.verification.forJob(request.params.id);
        return { verification: v === null ? null : { ...v } };
      },
    );

    r.post(
      '/jobs/:id/verification/override',
      {
        config: {
          authz: {
            action: 'deploy.approve',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            auditDenied: { action: 'verify.gate.override', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'p10-verify-health (ADR-0035): deploy anyway — release a deploy on success held by a failed / unfinished gate verification (project admin, always-fresh step-up, audited).',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ reason: z.string().max(500).default('') }),
          response: { 200: z.object({ verification: Json }), ...errors },
        },
      },
      async (request) => {
        const s = sessionOf(request);
        const maxAge = requestStepUpMaxAge(request, 'always-fresh');
        const v = await deps.verification.override(
          {
            userId: s.user.id,
            mfaAt: s.mfaAt,
            ...(maxAge === undefined ? {} : { stepUpMaxAgeMs: maxAge }),
            ...requestMeta(request),
          },
          request.params.id,
          request.body.reason,
        );
        return { verification: { ...v } };
      },
    );

    r.post(
      '/jobs/:id/verification/retry',
      {
        bodyLimit: 1024,
        config: {
          authz: {
            action: 'jobs.create',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            auditDenied: { action: 'verify.retry', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'p19-verifier-jobs: start a verification that could not run (state error — the verifier failed on infrastructure, git or its runtime) again; the next tick creates a new verifier job (jobs.create in the job’s project, audited verify.retry). 409 for any other state or a job that did not succeed.',
          security: csrf,
          params: IdParams,
          body: z.strictObject({}).optional(),
          response: { 200: z.object({ verification: Json }), ...errors },
        },
      },
      async (request) => {
        const v = await deps.verification.retry(
          { userId: sessionOf(request).user.id, ...requestMeta(request) },
          request.params.id,
        );
        return { verification: { ...v } };
      },
    );

    r.get(
      '/projects/:id/verify-settings',
      {
        config: { authz: { action: 'deploy.read', resource: projectParam() } },
        schema: {
          tags: ['deploy'],
          summary:
            'p10-verify-health: the project’s verification default (off / report / gate), verifier runtime, test command and post-deploy health settings (screenshots, keyword, auto-rollback).',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => ({ ...(await deps.settings.get(request.params.id)) }),
    );

    r.put(
      '/projects/:id/verify-settings',
      {
        config: {
          authz: {
            action: 'deploy.targets.write',
            resource: projectParam(),
            auditDenied: { action: 'verify.settings.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['deploy'],
          summary:
            'p10-verify-health: change the project’s verification and post-deploy health settings (project admin, step-up, audited).',
          security: csrf,
          params: z.object({ id: z.string().regex(PROJECT) }),
          body: VerifySettingsInput,
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const s = sessionOf(request);
        const out = await deps.settings.put(request.params.id, request.body, {
          userId: s.user.id,
          ...requestMeta(request),
        });
        return { ...out };
      },
    );

    r.get(
      '/deploy-health',
      {
        config: { authz: { action: 'deploy.read', resource: projectQuery() } },
        schema: {
          tags: ['deploy'],
          summary:
            'p10-verify-health: post-deploy health checks of a project (newest first), optionally of the given ops actions / preview links.',
          security: session,
          querystring: z.object({
            project: z.string().regex(PROJECT),
            actions: z
              .string()
              .max(37 * 100)
              .optional(),
            previews: z
              .string()
              .max(37 * 100)
              .optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          }),
          response: { 200: z.object({ items: z.array(Json) }), ...errors },
        },
      },
      async (request) => {
        const ids = (v: string | undefined): string[] | undefined =>
          v === undefined
            ? undefined
            : v
                .split(',')
                .map((s) => s.trim())
                .filter((s) => UUID.test(s))
                .slice(0, 100);
        const actions = ids(request.query.actions);
        const previews = ids(request.query.previews);
        const items = await deps.health.list(request.query.project, {
          ...(actions === undefined ? {} : { actions }),
          ...(previews === undefined ? {} : { previews }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        return { items: items.map((i) => ({ ...i })) };
      },
    );

    r.get(
      '/deploy/actions/:id/health',
      {
        config: {
          authz: {
            action: 'deploy.read',
            resource: actionResource,
            notFound: () => new HttpError(404, 'action_not_found', 'Ops action not found.'),
          },
        },
        schema: {
          tags: ['deploy'],
          summary:
            'p10-verify-health: the health check after this deploy / rollback (probe, crawl, screenshots, rollback); null when there is none.',
          security: session,
          params: IdParams,
          response: { 200: z.object({ health: Json.nullable() }), ...errors },
        },
      },
      async (request) => {
        const h = await deps.health.forAction(request.params.id);
        return { health: h === null ? null : { ...h } };
      },
    );

    r.post(
      '/deploy-health/:id/recheck',
      {
        config: {
          authz: {
            action: 'deploy.request',
            resource: healthResource,
            notFound: () => new HttpError(404, 'health_not_found', 'Health check not found.'),
            auditDenied: { action: 'deploy.health.recheck', target: paramTarget('health') },
          },
        },
        schema: {
          tags: ['deploy'],
          summary: 'p10-verify-health: run the health check again (operator; at most every 30 s per check).',
          security: csrf,
          params: IdParams,
          response: { 200: z.object({ health: Json }), ...errors },
        },
      },
      async (request) => {
        const h = await deps.health.recheck(
          { userId: sessionOf(request).user.id, ...requestMeta(request) },
          request.params.id,
        );
        return { health: { ...h } };
      },
    );
  };
}
