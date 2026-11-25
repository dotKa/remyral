import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { AccountPolicy } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { authorize, visibleProjects } from '../authz/model.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import { authzOf } from '../http/route-authz.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { effectivePolicy as usageLimitPolicy } from '../usage-limits/policy.js';
import type { AccountSwitchService } from './switch.js';
import {
  type AccountActor,
  RuntimeAccountError,
  type RuntimeAccountService,
  type RuntimeAccountView,
} from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * p13-runtime-accounts REST (docs/design/p13-runtime-accounts.md §6). Reading: viewers and up (labels, kinds, states,
 * usage — no secret, no identity). Changing a machine's accounts: workers.config.write (admin) with step-up (removing
 * one: always-fresh, it deletes a login). Policies: quotas.write / policy.write with step-up. Moving a job to another
 * account: jobs.resume (project operator) with step-up. Everything is audited by the service.
 */

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];

const WindowBody = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string().optional(),
  usedPercent: z.number().nullable(),
  windowMinutes: z.number().optional(),
  resetsAt: z.string().optional(),
  status: z.string().optional(),
  level: z.string(),
});

export const AccountBody = z.object({
  workerId: z.string(),
  workerName: z.string(),
  runtime: z.string(),
  id: z.string(),
  label: z.string(),
  kind: z.enum(['subscription', 'api_key']),
  credentialId: z.string().nullable(),
  store: z.string().nullable(),
  isDefault: z.boolean(),
  position: z.number().int(),
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  login: z.object({
    status: z.string().nullable(),
    reason: z.string().nullable(),
    checkedAt: z.string().nullable(),
  }),
  state: z.enum(['logged_in', 'needs_login', 'paused', 'limited', 'unknown']),
  limit: z.object({ episodeId: z.string(), resetAt: z.string().nullable(), resumeAt: z.string() }).nullable(),
  usage: z
    .object({
      level: z.string(),
      observedAt: z.string().nullable(),
      usedPercent: z.number().nullable(),
      windows: z.array(WindowBody),
    })
    .nullable(),
  running: z.number().int(),
  lendable: z.boolean(),
  supported: z.boolean(),
  reported: z.boolean(),
});

const PolicyBody = z.object({
  strategy: z.enum(['balanced', 'fill_first', 'least_used']),
  order: z.array(z.string()),
  skipPercent: z.number().int(),
});

const AccountParams = z.object({
  id: z.string().min(1).max(128),
  runtime: z.enum(['claude-code', 'codex']),
  account: z.string().regex(/^[a-z0-9]{1,12}$/),
});

function view(a: RuntimeAccountView): z.infer<typeof AccountBody> {
  return {
    ...a,
    usage:
      a.usage === null
        ? null
        : {
            level: a.usage.level,
            observedAt: a.usage.observedAt,
            usedPercent: a.usage.usedPercent,
            windows: a.usage.windows.map((w) => ({
              id: w.id,
              kind: w.kind,
              ...(w.label === undefined ? {} : { label: w.label }),
              usedPercent: w.usedPercent,
              ...(w.windowMinutes === undefined ? {} : { windowMinutes: w.windowMinutes }),
              ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
              ...(w.status === undefined ? {} : { status: w.status }),
              level: w.level,
            })),
          },
  };
}

function actor(request: FastifyRequest): AccountActor {
  const meta = requestMeta(request);
  return { userId: sessionOf(request).user.id, ip: meta.ip, userAgent: meta.userAgent };
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RuntimeAccountError) throw new HttpError(err.statusCode, err.code, err.publicMessage);
    throw err;
  }
}

export function runtimeAccountRoutes(deps: {
  readonly service: RuntimeAccountService;
  readonly switcher: AccountSwitchService;
  readonly pool: Pool;
  readonly clock: () => Date;
}) {
  /** Machines whose accounts the caller may see: those that take one of their projects (owner / admin: all). */
  const visibleWorkers = async (request: FastifyRequest): Promise<readonly string[] | null> => {
    const projects = visibleProjects(authzOf(request).subject);
    if (projects === null) return null;
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM workers WHERE archived_at IS NULL
          AND (local_projects IS NULL OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(local_projects) p WHERE p = ANY($1::text[])))`,
      [[...projects]],
    );
    return rows.map((r) => r.id);
  };
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['runtime-accounts'];
    const stepUp = requireStepUp('standard', deps.clock);
    const fresh = requireStepUp('always-fresh', deps.clock);

    r.get(
      '/runtime-accounts',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags,
          summary:
            'The Claude Code / Codex accounts of the machines: label, kind, state, usage windows, limits, running jobs — no secret, no identity (viewer+)',
          security: session,
          querystring: z.object({
            worker: z.string().min(1).max(128).optional(),
            runtime: z.enum(['claude-code', 'codex']).optional(),
          }),
          response: {
            200: z.object({
              accounts: z.array(AccountBody),
              workers: z.array(z.object({ id: z.string(), name: z.string(), supported: z.boolean() })),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const visible = await visibleWorkers(request);
        const want = request.query.worker === undefined ? null : [request.query.worker];
        const ids =
          visible === null ? want : want === null ? visible : want.filter((w) => visible.includes(w));
        const list = await deps.service.list({
          ...(ids === null ? {} : { workerIds: ids }),
          ...(request.query.runtime === undefined ? {} : { runtime: request.query.runtime }),
        });
        // The vault credential id of an API-key account is only for those who manage accounts (it is a handle a job
        // could otherwise name); the label and kind stay visible.
        const seeIds = authorize(authzOf(request).subject, 'workers.config.write').allow;
        return {
          accounts: list.accounts.map(view).map((a) => (seeIds ? a : { ...a, credentialId: null })),
          workers: list.workers,
        };
      },
    );

    r.post(
      '/workers/:id/runtime-accounts',
      {
        config: {
          authz: {
            action: 'workers.config.write',
            auditDenied: { action: 'runtime_account.create', target: paramTarget('worker') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Add an account to a machine runtime: a subscription (then log it in) or an API key from the vault (admin, step-up, audited)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z
            .object({
              runtime: z.enum(['claude-code', 'codex']),
              label: z.string().max(200),
              kind: z.enum(['subscription', 'api_key']),
              credentialId: z.string().max(64).nullable().optional(),
            })
            .strict(),
          response: { 201: z.object({ account: AccountBody }), ...errors },
        },
      },
      async (request, reply) =>
        mapped(async () => {
          const a = await deps.service.create(request.params.id, request.body, actor(request));
          void reply.code(201);
          return { account: view(a) };
        }),
    );

    r.patch(
      '/workers/:id/runtime-accounts/:runtime/:account',
      {
        config: {
          authz: {
            action: 'workers.config.write',
            auditDenied: { action: 'runtime_account.update', target: paramTarget('worker') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Rename, pause / resume, make default or reorder a machine account (admin, step-up, audited)',
          security: csrf,
          params: AccountParams,
          body: z
            .object({
              label: z.string().max(200).optional(),
              paused: z.boolean().optional(),
              pausedReason: z.string().max(400).nullable().optional(),
              isDefault: z.literal(true).optional(),
              position: z.number().int().optional(),
            })
            .strict(),
          response: { 200: z.object({ account: AccountBody }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => ({
          account: view(
            await deps.service.update(
              request.params.id,
              request.params.runtime,
              request.params.account,
              request.body,
              actor(request),
            ),
          ),
        })),
    );

    r.delete(
      '/workers/:id/runtime-accounts/:runtime/:account',
      {
        config: {
          authz: {
            action: 'workers.config.write',
            auditDenied: { action: 'runtime_account.remove', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Remove an added account: the machine logs it out and deletes its login folder (admin, always-fresh step-up, audited)',
          security: csrf,
          params: AccountParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) =>
        mapped(async () => {
          await deps.service.remove(
            request.params.id,
            request.params.runtime,
            request.params.account,
            actor(request),
          );
          return reply.code(204).send(null);
        }),
    );

    r.get(
      '/runtime-accounts/policy',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags,
          summary: 'Workspace default account selection: strategy, order, skip threshold (viewer+)',
          security: session,
          response: { 200: z.object({ policy: PolicyBody, updatedAt: z.string().nullable() }), ...errors },
        },
      },
      async () => {
        const d = await deps.service.defaults();
        return { policy: d.policy, updatedAt: d.updatedAt?.toISOString() ?? null };
      },
    );

    r.put(
      '/runtime-accounts/policy',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: {
              action: 'runtime_account.policy.update',
              target: () => 'runtime-accounts:defaults',
            },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Replace the workspace default account selection (admin, step-up, audited)',
          security: csrf,
          body: z.object({ policy: z.record(z.string(), z.unknown()) }),
          response: { 200: z.object({ policy: PolicyBody }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => ({
          policy: await deps.service.saveDefaults(request.body.policy, actor(request)),
        })),
    );

    const ProjectPolicyResponse = z.object({
      project: z.string(),
      own: PolicyBody.nullable(),
      effective: PolicyBody,
      source: z.enum(['project', 'default']),
      defaults: PolicyBody,
      /** The project's paid switch (usage-limit policy `allowPaidFallback`), authoritative for API-key accounts. */
      allowPaid: z.boolean(),
      accounts: z.array(
        z.object({
          ref: z.string(),
          workerId: z.string(),
          workerName: z.string(),
          runtime: z.string(),
          id: z.string(),
          label: z.string(),
          kind: z.enum(['subscription', 'api_key']),
        }),
      ),
      updatedAt: z.string().nullable(),
    });
    const projectView = async (project: string): Promise<z.infer<typeof ProjectPolicyResponse>> => {
      const own = await deps.service.projectPolicy(project);
      if (own === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
      const eff = await deps.service.effectivePolicy(project);
      const defaults = (await deps.service.defaults()).policy;
      const paid = (await usageLimitPolicy(deps.pool, project)).policy.allowPaidFallback;
      const { rows } = await deps.pool.query<{ worker_id: string }>(
        `SELECT DISTINCT a.worker_id FROM (
           SELECT worker_id FROM worker_configs c JOIN worker_config_versions v USING (worker_id)
            WHERE v.generation = c.generation AND v.spec->'projects' ? $1
           UNION SELECT id AS worker_id FROM workers
            WHERE archived_at IS NULL AND (local_projects IS NULL OR local_projects ? $1)) a`,
        [project],
      );
      const { accounts } = await deps.service.list({ workerIds: rows.map((x) => x.worker_id) });
      const body = (p: AccountPolicy): z.infer<typeof PolicyBody> => ({
        strategy: p.strategy,
        order: [...p.order],
        skipPercent: p.skipPercent,
      });
      return {
        project,
        own: own.policy === null ? null : body(own.policy),
        effective: body(eff.policy),
        source: eff.source,
        defaults: body(defaults),
        allowPaid: paid,
        accounts: accounts.map((a) => ({
          ref: `${a.workerId}/${a.runtime}/${a.id}`,
          workerId: a.workerId,
          workerName: a.workerName,
          runtime: a.runtime,
          id: a.id,
          label: a.label,
          kind: a.kind,
        })),
        updatedAt: own.updatedAt?.toISOString() ?? null,
      };
    };

    r.get(
      '/projects/:id/account-policy',
      {
        config: { authz: { action: 'policy.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'A project’s account selection (own or inherited), the paid switch and the accounts it can use',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: ProjectPolicyResponse, ...errors },
        },
      },
      async (request) => projectView(request.params.id),
    );

    r.put(
      '/projects/:id/account-policy',
      {
        config: {
          authz: {
            action: 'policy.write',
            resource: projectParam(),
            auditDenied: { action: 'project.account_policy.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set or clear (null = inherit) a project’s account selection (owner/admin, step-up, audited)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.object({ policy: z.record(z.string(), z.unknown()).nullable() }),
          response: { 200: ProjectPolicyResponse, ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          await deps.service.saveProjectPolicy(request.params.id, request.body.policy, actor(request));
          return projectView(request.params.id);
        }),
    );

    r.post(
      '/jobs/:id/switch-account',
      {
        config: {
          authz: {
            action: 'jobs.resume',
            resource: jobResource(deps.pool),
            auditDenied: { action: 'job.account.switch', target: paramTarget('job') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Move a job to another runtime account: a waiting job is pinned to it, a running one is paused and resumed with it (operator, step-up, audited)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z
            .object({
              workerId: z.string().min(1).max(128),
              runtime: z.enum(['claude-code', 'codex']).optional(),
              account: z.string().regex(/^[a-z0-9]{1,12}$/),
            })
            .strict(),
          response: {
            200: z.object({ result: z.enum(['pinned', 'resuming', 'pausing', 'restarting']) }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => ({
          result: await deps.switcher.switchAccount(request.params.id, request.body, actor(request)),
        })),
    );
  };
}
