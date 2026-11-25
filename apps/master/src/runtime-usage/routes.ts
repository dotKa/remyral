import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { visibleProjects } from '../authz/model.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import type { UsageRefreshService } from './refresh.js';
import type { RuntimeUsageService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
  503: ErrorBody,
};

const Level = z.enum(['ok', 'near', 'limited', 'unknown']);
const WindowBody = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string().optional(),
  usedPercent: z.number().nullable(),
  windowMinutes: z.number().optional(),
  resetsAt: z.string().optional(),
  status: z.string().optional(),
  /** p15-usage-refresh: the reset passed; the new period has not been read yet (usedPercent null). */
  restarted: z.boolean().optional(),
  level: Level,
  history: z.array(z.object({ at: z.string(), usedPercent: z.number() })).optional(),
});
const LimitBody = z.object({
  episodeId: z.string(),
  kind: z.string().nullable(),
  model: z.string().nullable(),
  resetAt: z.string().nullable(),
  resumeAt: z.string(),
});
const IdentityBody = z.object({ key: z.string(), hint: z.string().nullable() });
const MachineRef = z.object({ workerId: z.string(), workerName: z.string() });
const EntryBody = z.object({
  workerId: z.string(),
  workerName: z.string(),
  workerState: z.string(),
  runtime: z.string(),
  auth: z.enum(['subscription', 'api_key']),
  /** p13-runtime-accounts: the runtime account (`default` = the configured login / key) and its label. */
  account: z.string(),
  accountLabel: z.string().nullable(),
  store: z.string().nullable(),
  source: z.enum(['probe', 'job', 'assistant']).nullable(),
  plan: z.string().nullable(),
  available: z.boolean(),
  observedAt: z.string().nullable(),
  stale: z.boolean(),
  reports: z.boolean(),
  level: Level,
  windows: z.array(WindowBody),
  limit: LimitBody.nullable(),
  /** p15-usage-refresh: the provider account (hashed key, masked e-mail). */
  identity: IdentityBody.nullable(),
  /** p15-usage-refresh: the windows come from this other machine's newer reading of the same account. */
  readOn: MachineRef.nullable(),
  orphan: z.boolean(),
  canRefresh: z.boolean(),
});
/** p15-usage-refresh: one row per provider account (or per login of unknown identity). */
const GroupBody = z.object({
  key: z.string(),
  runtime: z.string(),
  auth: z.enum(['subscription', 'api_key']),
  identity: IdentityBody.nullable(),
  labels: z.array(z.string()),
  source: z.enum(['probe', 'job', 'assistant']).nullable(),
  plan: z.string().nullable(),
  available: z.boolean(),
  observedAt: z.string().nullable(),
  readOn: MachineRef.nullable(),
  stale: z.boolean(),
  reports: z.boolean(),
  level: Level,
  windows: z.array(WindowBody),
  limit: LimitBody.nullable(),
  orphan: z.boolean(),
  canRefresh: z.boolean(),
  machines: z.array(
    z.object({
      workerId: z.string(),
      workerName: z.string(),
      workerState: z.string(),
      account: z.string(),
      accountLabel: z.string().nullable(),
      observedAt: z.string().nullable(),
      orphan: z.boolean(),
      canRefresh: z.boolean(),
    }),
  ),
});
const OtherLimit = z.object({
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
});
const SettingsBody = z.object({
  nearThreshold: z.number().int(),
  notifyNear: z.boolean(),
  updatedAt: z.string().nullable(),
});
export const OverviewBody = z.object({
  generatedAt: z.string(),
  settings: SettingsBody,
  entries: z.array(EntryBody),
  groups: z.array(GroupBody),
  otherLimits: z.array(OtherLimit),
});

/**
 * p11-limit-visibility REST (docs/design/p11-limit-visibility.md §5). `GET /usage-limits/overview` (viewer+; machines
 * filtered by the caller's projects, no secrets); the near-limit setting: read viewer+, write admin + step-up, audited.
 */
export function runtimeUsageRoutes(deps: {
  readonly service: RuntimeUsageService;
  readonly clock: () => Date;
  /** p15-usage-refresh: on-demand refresh (absent: the routes answer 503). */
  readonly refresh?: () => UsageRefreshService | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['quotas'];

    r.get(
      '/usage-limits/overview',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags,
          summary:
            'Runtime usage limits now: per machine and runtime login store the used share of each window (5-hour, weekly, per model; Codex primary / secondary), reset times, source and age, merged with known limit hits (viewer+)',
          security: [{ session: [] }],
          querystring: z.object({
            history: z.enum(['0', '1']).optional(),
            worker: z
              .string()
              .regex(/^wrk_[a-z2-7]{26}$/)
              .optional(),
            runtime: z
              .string()
              .regex(/^[a-z0-9_-]{1,32}$/)
              .optional(),
          }),
          response: { 200: OverviewBody, ...errors },
        },
      },
      async (request) =>
        deps.service.overview({
          projects: visibleProjects(authzOf(request).subject),
          history: request.query.history === '1',
          ...(request.query.worker === undefined ? {} : { workerId: request.query.worker }),
          ...(request.query.runtime === undefined ? {} : { runtime: request.query.runtime }),
        }),
    );

    r.put(
      '/usage-limits/near-settings',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: { action: 'runtime_usage.settings.update', target: () => 'runtime-usage:settings' },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'The "near the usage limit" threshold (50–99 %) and whether owners / admins get the notice (admin+, step-up, audited)',
          security: [{ session: [], csrf: [] }],
          body: z.object({ nearThreshold: z.number().int().min(50).max(99), notifyNear: z.boolean() }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const meta = requestMeta(request);
        return deps.service.saveSettings(request.body, {
          userId: sessionOf(request).user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      },
    );

    // p15-usage-refresh (docs/design/p15-usage-refresh.md §4): read the usage windows now on the right machines.
    const refreshOf = (): UsageRefreshService => {
      const svc = deps.refresh?.() ?? null;
      if (svc === null)
        throw new HttpError(
          503,
          'unavailable',
          'Limit refresh is not available.',
          {},
          {},
          { reason: 'usage_refresh' },
        );
      return svc;
    };
    const OpRef = z.object({ workerId: z.string(), workerName: z.string(), opId: z.string() });

    r.post(
      '/usage-limits/refresh',
      {
        config: { authz: { action: 'quotas.refresh' } },
        schema: {
          tags,
          summary:
            'Read the runtime usage windows now (operator+, no step-up): one signed usage.refresh remote operation per affected connected machine — all machines, one machine (optionally one runtime / account), or every machine one provider account is logged in on (identity + runtime). Read-only probes, no model request.',
          security: [{ session: [], csrf: [] }],
          body: z
            .object({
              workerId: z
                .string()
                .regex(/^wrk_[a-z2-7]{26}$/)
                .optional(),
              runtime: z.enum(['claude-code', 'codex']).optional(),
              account: z
                .string()
                .regex(/^[a-z0-9]{1,12}$/)
                .optional(),
              identity: z
                .string()
                .regex(/^[a-f0-9]{32}$/)
                .optional(),
            })
            .nullable()
            .optional(),
          response: {
            200: z.object({
              ops: z.array(OpRef),
              skipped: z.array(
                z.object({ workerId: z.string(), workerName: z.string(), reason: z.string() }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const b = request.body ?? {};
        return refreshOf().start(
          {
            ...(b.workerId === undefined ? {} : { workerId: b.workerId }),
            ...(b.runtime === undefined ? {} : { runtime: b.runtime }),
            ...(b.account === undefined ? {} : { account: b.account }),
            ...(b.identity === undefined ? {} : { identity: b.identity }),
          },
          actorOf(request),
          visibleProjects(authzOf(request).subject),
        );
      },
    );

    r.get(
      '/usage-limits/refresh-status',
      {
        config: { authz: { action: 'quotas.refresh' } },
        schema: {
          tags,
          summary: 'The state of usage.refresh operations started from Usage → Limit windows (operator+)',
          security: [{ session: [] }],
          querystring: z.object({ ops: z.string().max(64 * 37) }),
          response: {
            200: z.object({
              ops: z.array(
                z.object({
                  opId: z.string(),
                  workerId: z.string(),
                  state: z.string(),
                  done: z.boolean(),
                  reason: z.string().nullable(),
                  results: z.array(
                    z.object({ runtime: z.string(), account: z.string(), outcome: z.string() }),
                  ),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({ ops: await refreshOf().status(request.query.ops.split(',')) }),
    );

    r.post(
      '/usage-limits/cleanup',
      {
        config: {
          authz: {
            action: 'quotas.write',
            auditDenied: { action: 'runtime_usage.cleanup', target: () => 'runtime-usage:snapshots' },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'Delete the usage readings of logins that no longer exist (removed accounts, logins the machine no longer runs) (admin+, step-up, audited)',
          security: [{ session: [], csrf: [] }],
          response: { 200: z.object({ removed: z.number().int() }), ...errors },
        },
      },
      async (request) => {
        const meta = requestMeta(request);
        return deps.service.cleanup({
          userId: sessionOf(request).user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      },
    );
  };
}
