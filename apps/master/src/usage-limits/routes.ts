import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { RuntimeKind, type UsageLimitPolicy } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import type { AuditRecorder } from '../audit/audit.js';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { resolveJobModel } from '../models/job-model.js';
import {
  effectivePolicy,
  loadDefaultPolicy,
  loadProjectPolicy,
  saveDefaultPolicy,
  saveProjectPolicy,
  UsageLimitPolicyError,
} from './policy.js';
import type { UsageLimitService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];

const PolicyBody = z.object({
  mode: z.enum(['auto', 'wait', 'fallback', 'fail']),
  maxWaitHours: z.number(),
  fallbacks: z.array(z.object({ runtime: z.string(), model: z.string().optional() })),
  allowPaidFallback: z.boolean(),
});

const FallbackFacts = z.object({
  runtime: z.string(),
  model: z.string().nullable(),
  profile: z.string().nullable(),
  /** `credential`: the profile brings an API key (billed per token); `machine`: depends on the machine's auth. */
  paid: z.enum(['credential', 'machine']),
  /** Left out at dispatch because it would bill per token and paid fallbacks are not allowed. */
  blocked: z.boolean(),
  estimate: z
    .object({
      avgCostUsdPerJob: z.number(),
      jobs: z.number().int(),
      basis: z.enum(['project', 'all_projects']),
    })
    .nullable(),
});

const ProjectPolicyResponse = z.object({
  project: z.string(),
  own: PolicyBody.nullable(),
  effective: PolicyBody,
  source: z.enum(['project', 'default']),
  defaults: PolicyBody,
  fallbacks: z.array(FallbackFacts),
  updatedAt: z.string().nullable(),
});

const EpisodeBody = z.object({
  id: z.string(),
  scope: z.string(),
  pauseScope: z.string(),
  workerId: z.string().nullable(),
  workerName: z.string().nullable(),
  runtime: z.string(),
  accountId: z.string().nullable(),
  runtimeAccount: z.string().nullable(),
  credential: z.string().nullable(),
  store: z.string().nullable(),
  model: z.string().nullable(),
  kind: z.string().nullable(),
  resetAt: z.string().nullable(),
  resumeAt: z.string(),
  since: z.string(),
  lastHitAt: z.string(),
  hits: z.number().int(),
  project: z.string().nullable(),
  message: z.string().nullable(),
});

function mapped<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof UsageLimitPolicyError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  });
}

function actor(request: FastifyRequest): { userId: string; ip: string | null; userAgent: string | null } {
  const meta = requestMeta(request);
  return { userId: sessionOf(request).user.id, ip: meta.ip, userAgent: meta.userAgent };
}

/**
 * Estimated cost of one job on a fallback: the average reported / estimated dollar cost per job of API-key runs of that
 * runtime (and model) over the last 30 days — of this project, else of all projects. Null when nothing was recorded.
 */
async function estimate(
  db: Queryable,
  project: string,
  runtime: string,
  model: string | null,
  now: Date,
): Promise<z.infer<typeof FallbackFacts>['estimate']> {
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  for (const basis of ['project', 'all_projects'] as const) {
    const { rows } = await db.query<{ avg: string | null; jobs: number }>(
      `SELECT avg(x.cost)::text AS avg, count(*)::int AS jobs FROM (
         SELECT job_id, sum(cost_usd) AS cost FROM usage_records
          WHERE runtime = $1 AND auth_mode = 'secret-ref' AND cost_usd IS NOT NULL AND recorded_at >= $2
            AND ($3::text IS NULL OR model = $3) AND ($4::text IS NULL OR project = $4)
          GROUP BY job_id) x`,
      [runtime, since, model, basis === 'project' ? project : null],
    );
    const r = rows[0];
    if (r !== undefined && r.jobs > 0 && r.avg !== null) {
      return { avgCostUsdPerJob: Math.round(Number(r.avg) * 10_000) / 10_000, jobs: r.jobs, basis };
    }
  }
  return null;
}

/**
 * p11-usage-limit-fallback REST (docs/design/p11-usage-limit-fallback.md §9). Workspace default: quotas.read /
 * quotas.write (admin + step-up). Project policy: policy.read / policy.write (project admin + step-up). Every write is
 * audited with before / after (denials by the authorization layer).
 */
export function usageLimitRoutes(deps: {
  readonly service: UsageLimitService;
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['quotas'];

    r.get(
      '/usage-limits/defaults',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags,
          summary:
            'Workspace default usage-limit policy: wait / fall back / fail when a runtime hits its usage limit (viewer+)',
          security: session,
          response: { 200: z.object({ policy: PolicyBody, updatedAt: z.string().nullable() }), ...errors },
        },
      },
      async () => {
        const d = await loadDefaultPolicy(deps.pool);
        return { policy: d.policy, updatedAt: d.updatedAt?.toISOString() ?? null };
      },
    );

    r.put(
      '/usage-limits/defaults',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: { action: 'usage_limit.defaults.update', target: () => 'usage-limit:defaults' },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary: 'Replace the workspace default usage-limit policy (admin+, step-up, audited)',
          security: csrf,
          body: z.object({ policy: z.record(z.string(), z.unknown()) }),
          response: { 200: z.object({ policy: PolicyBody }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => ({
          policy: await saveDefaultPolicy(
            deps.pool,
            deps.audit,
            request.body.policy,
            actor(request),
            deps.clock(),
          ),
        })),
    );

    r.get(
      '/projects/:id/usage-limit-policy',
      {
        config: { authz: { action: 'policy.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'A project’s usage-limit policy (own or inherited), its fallbacks with paid / estimated cost per job (owner/admin)',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: ProjectPolicyResponse, ...errors },
        },
      },
      async (request) => projectView(deps, request.params.id),
    );

    r.put(
      '/projects/:id/usage-limit-policy',
      {
        config: {
          authz: {
            action: 'policy.write',
            resource: projectParam(),
            auditDenied: { action: 'project.usage_limit.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'Set or clear (null = inherit the workspace default) a project’s usage-limit policy (owner/admin, step-up, audited)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.object({ policy: z.record(z.string(), z.unknown()).nullable() }),
          response: { 200: ProjectPolicyResponse, ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          await saveProjectPolicy(
            deps.pool,
            deps.audit,
            request.params.id,
            request.body.policy,
            actor(request),
            deps.clock(),
          );
          return projectView(deps, request.params.id);
        }),
    );

    r.get(
      '/usage-limits/status',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags,
          summary:
            'Usage limits known now: per machine login store, provider account or API credential (one model or all), with reset times (viewer+)',
          security: session,
          response: { 200: z.object({ limits: z.array(EpisodeBody) }), ...errors },
        },
      },
      async () => ({ limits: await deps.service.status() }),
    );

    // p19-limit-clear: a limit that is already gone (the provider reset it early, the plan was raised) is cleared by
    // hand; a job that hits it again opens a new one, so no step-up.
    r.post(
      '/usage-limits/:id/clear',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: { action: 'usage_limit.cleared', target: paramTarget('usage-limit') },
          },
        },
        schema: {
          tags,
          summary:
            'End a usage limit before its reset time: waiting jobs continue now (admin+, audited; a new hit opens it again)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ cleared: z.literal(true) }), ...errors },
        },
      },
      async (request) => {
        if (!(await deps.service.clear(request.params.id, actor(request))))
          throw new HttpError(404, 'not_found', 'Not found.');
        return { cleared: true as const };
      },
    );
  };
}

async function projectView(
  deps: { readonly pool: Pool; readonly clock: () => Date },
  project: string,
): Promise<z.infer<typeof ProjectPolicyResponse>> {
  const own = await loadProjectPolicy(deps.pool, project);
  if (own === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
  const eff = await effectivePolicy(deps.pool, project);
  const defaults = (await loadDefaultPolicy(deps.pool)).policy;
  const now = deps.clock();
  const fallbacks: z.infer<typeof FallbackFacts>[] = [];
  for (const f of eff.policy.fallbacks) {
    const runtime = RuntimeKind.safeParse(f.runtime);
    if (!runtime.success) continue;
    const resolved = await resolveJobModel(deps.pool, project, runtime.data, f.model, null).catch(() => null);
    const credential = resolved?.modelProfile?.credentialRef !== undefined;
    const model = resolved?.modelProfile?.model ?? resolved?.model ?? null;
    fallbacks.push({
      runtime: f.runtime,
      model,
      profile: resolved?.modelProfile?.id ?? null,
      paid: credential ? 'credential' : 'machine',
      blocked: credential && !eff.policy.allowPaidFallback,
      estimate: await estimate(deps.pool, project, f.runtime, model, now),
    });
  }
  const body = (p: UsageLimitPolicy): z.infer<typeof PolicyBody> => ({
    mode: p.mode,
    maxWaitHours: p.maxWaitHours,
    fallbacks: p.fallbacks.map((f) => ({
      runtime: f.runtime,
      ...(f.model === undefined ? {} : { model: f.model }),
    })),
    allowPaidFallback: p.allowPaidFallback,
  });
  return {
    project,
    own: own.policy === null ? null : body(own.policy),
    effective: body(eff.policy),
    source: eff.source,
    defaults: body(defaults),
    fallbacks,
    updatedAt: own.updatedAt?.toISOString() ?? null,
  };
}
