import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  AUTH_MODES,
  BUDGET_BILLINGS,
  BUDGET_METRICS,
  BUDGET_ON_EXCEEDED,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOWS,
  type BudgetEvaluation,
  COST_CLASSES,
  GROUP_BYS,
  type GroupSummary,
  type PriceEntry,
  UNKNOWN_COST_REASONS,
} from '@remyral/usage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import { type Resource, visibleProjects } from '../authz/model.js';
import { param, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { UsageError } from './errors.js';
import {
  type BudgetOverride,
  type BudgetRecord,
  type BudgetView,
  LIMITS,
  type PriceTable,
  type RecordView,
  type RequestMeta,
  type UsageActor,
  type UsageFilter,
  type UsageStore,
} from './store.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

const FilterValue = z.string().min(1).max(128);
const Filters = {
  project: FilterValue.optional(),
  worker: FilterValue.optional(),
  runtime: FilterValue.optional(),
  provider: FilterValue.optional(),
  model: FilterValue.optional(),
  authMode: z.enum(AUTH_MODES).optional(),
};
const IsoDate = z.iso.datetime({ offset: true });
/** p14-web-perf-2: up to one jobs page of ids, comma-separated (the İşler cost column of the listed jobs). */
const MAX_RECORD_JOBS = 200;
const JobIdList = z
  .string()
  .max(MAX_RECORD_JOBS * 37)
  .transform((s) => s.split(',').filter((x) => x !== ''))
  .pipe(z.array(z.uuid()).min(1).max(MAX_RECORD_JOBS));

const Counts = z.object({
  reported: z.number(),
  estimated: z.number(),
  unknown: z.number(),
  subscription: z.number(),
});

const GroupBody = z.object({
  key: z.string().nullable(),
  records: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  tokensUnknownRecords: z.number().int(),
  turns: z.number(),
  turnsUnknownRecords: z.number().int(),
  wallTimeMs: z.number(),
  wallTimeUnknownRecords: z.number().int(),
  costUsd: z.object({ reported: z.number(), estimated: z.number(), total: z.number() }),
  /** p8-cost-efficiency: what the subscription records would cost on API billing — an estimate, not money spent. */
  apiEquivalent: z.object({
    usd: z.number(),
    fromPriceTable: z.number(),
    fromRuntime: z.number(),
    unpricedRecords: z.number().int(),
  }),
  coverage: Counts,
  coverageShare: Counts,
  unknownReasons: z.partialRecord(z.enum(UNKNOWN_COST_REASONS), z.number().int()),
  missingPrices: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      reason: z.enum(['price_missing', 'cache_price_missing']),
      records: z.number().int(),
    }),
  ),
  flags: z.object({
    costComplete: z.boolean(),
    hasSubscription: z.boolean(),
    noPerRunCost: z.boolean(),
    metricsIncomplete: z.boolean(),
  }),
});

const PriceBody = z.object({
  provider: z.string(),
  model: z.string(),
  effectiveFrom: z.string(),
  inputUsdPerMTok: z.number(),
  outputUsdPerMTok: z.number(),
  cacheReadUsdPerMTok: z.number().nullable(),
  cacheWriteUsdPerMTok: z.number().nullable(),
  source: z.string(),
});

const PriceTableBody = z.object({
  version: z.number().int(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string().nullable(),
  entries: z.array(PriceBody),
});

const RecordBody = z.object({
  id: z.string(),
  jobId: z.string(),
  attemptId: z.string(),
  workerId: z.string(),
  project: z.string(),
  runtime: z.string(),
  runtimeVersion: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  authMode: z.enum(AUTH_MODES).nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  turns: z.number().nullable(),
  wallTimeMs: z.number().nullable(),
  reported: z.object({
    costUsd: z.number().nullable(),
    provenance: z.enum(['reported-by-runtime', 'estimated-from-tokens', 'unknown']),
  }),
  cost: z.object({
    costClass: z.enum(COST_CLASSES),
    costUsd: z.number().nullable(),
    provenance: z.enum(['reported-by-runtime', 'estimated-from-tokens', 'unknown']).nullable(),
    unknownReason: z.enum(UNKNOWN_COST_REASONS).nullable(),
    priceEffectiveFrom: z.string().nullable(),
  }),
  sourceEventId: z.string(),
  recordedAt: z.string(),
});

const EvaluationBody = z.object({
  metric: z.enum(BUDGET_METRICS),
  limit: z.number(),
  used: z.number(),
  ratio: z.number(),
  level: z.enum(['none', 'warning', 'exceeded']),
  status: z.enum(['under', 'warning', 'over', 'unknown']),
  complete: z.boolean(),
  records: z.number().int(),
  unknownRecords: z.number().int(),
  subscriptionRecords: z.number().int(),
  window: z.object({ start: z.string(), end: z.string() }),
});

const BudgetBody = z.object({
  id: z.string(),
  name: z.string(),
  metric: z.enum(BUDGET_METRICS),
  limit: z.number(),
  scope: z.object({ type: z.enum(BUDGET_SCOPE_TYPES), value: z.string().nullable() }),
  window: z.enum(BUDGET_WINDOWS),
  enabled: z.boolean(),
  version: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  billing: z.enum(BUDGET_BILLINGS),
  timeZone: z.string(),
  thresholds: z.array(z.number().int()),
  onExceeded: z.enum(BUDGET_ON_EXCEEDED),
});
const BudgetViewBody = z.object({ budget: BudgetBody, evaluation: EvaluationBody.nullable() });

const BudgetInputBody = z.object({
  name: z.string().max(1000),
  metric: z.enum(BUDGET_METRICS),
  limit: z.number(),
  scope: z.object({ type: z.enum(BUDGET_SCOPE_TYPES), value: z.string().max(200).nullable().optional() }),
  window: z.enum(BUDGET_WINDOWS),
  enabled: z.boolean().optional(),
  // p8-cost-efficiency (omitted on create: all / UTC / 50-80-100 / pause_new; on update: unchanged).
  billing: z.enum(BUDGET_BILLINGS).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  thresholds: z.array(z.number()).max(10).optional(),
  onExceeded: z.enum(BUDGET_ON_EXCEEDED).optional(),
});

const OverrideBody = z.object({
  id: z.string(),
  budgetId: z.string(),
  budgetVersion: z.number().int(),
  windowStart: z.string(),
  jobId: z.string().nullable(),
  expiresAt: z.string(),
  reason: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  active: z.boolean(),
});

// ------------------------------------------------------------------------------------------ mapping

function groupJson(g: GroupSummary): z.infer<typeof GroupBody> {
  return {
    ...g,
    costUsd: { ...g.costUsd },
    apiEquivalent: { ...g.apiEquivalent },
    coverage: { ...g.coverage },
    coverageShare: { ...g.coverageShare },
    unknownReasons: { ...g.unknownReasons },
    missingPrices: g.missingPrices.map((m) => ({ ...m })),
    flags: { ...g.flags },
  };
}

function priceJson(p: PriceEntry): z.infer<typeof PriceBody> {
  return { ...p, effectiveFrom: p.effectiveFrom.toISOString() };
}

function priceTableJson(t: PriceTable): z.infer<typeof PriceTableBody> {
  return {
    version: t.version,
    note: t.note,
    createdBy: t.createdBy,
    createdAt: t.createdAt?.toISOString() ?? null,
    entries: t.entries.map(priceJson),
  };
}

function recordJson(r: RecordView): z.infer<typeof RecordBody> {
  return {
    id: r.id,
    jobId: r.jobId,
    attemptId: r.attemptId,
    workerId: r.workerId,
    project: r.project,
    runtime: r.runtime,
    runtimeVersion: r.runtimeVersion,
    provider: r.provider,
    model: r.model,
    authMode: r.authMode,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    turns: r.turns,
    wallTimeMs: r.wallTimeMs,
    reported: { costUsd: r.reportedCostUsd, provenance: r.reportedProvenance },
    cost: {
      costClass: r.cost.costClass,
      costUsd: r.cost.costUsd,
      provenance: r.cost.provenance,
      unknownReason: r.cost.unknownReason,
      priceEffectiveFrom: r.cost.price?.effectiveFrom.toISOString() ?? null,
    },
    sourceEventId: r.sourceEventId,
    recordedAt: r.recordedAt.toISOString(),
  };
}

function evaluationJson(e: BudgetEvaluation): z.infer<typeof EvaluationBody> {
  return {
    metric: e.metric,
    limit: e.limit,
    used: e.used,
    ratio: e.ratio,
    level: e.level,
    status: e.status,
    complete: e.complete,
    records: e.records,
    unknownRecords: e.unknownRecords,
    subscriptionRecords: e.subscriptionRecords,
    window: { start: e.window.start.toISOString(), end: e.window.end.toISOString() },
  };
}

function budgetJson(b: BudgetRecord): z.infer<typeof BudgetBody> {
  return {
    id: b.id,
    name: b.name,
    metric: b.metric,
    limit: b.limit,
    scope: { type: b.scope.type, value: b.scope.value },
    window: b.window,
    enabled: b.enabled,
    version: b.version,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
    updatedBy: b.updatedBy,
    updatedAt: b.updatedAt.toISOString(),
    deletedAt: b.deletedAt?.toISOString() ?? null,
    deletedBy: b.deletedBy,
    billing: b.billing,
    timeZone: b.timeZone,
    thresholds: [...b.thresholds],
    onExceeded: b.onExceeded,
  };
}

function overrideJson(o: BudgetOverride, now: Date): z.infer<typeof OverrideBody> {
  return {
    id: o.id,
    budgetId: o.budgetId,
    budgetVersion: o.budgetVersion,
    windowStart: o.windowStart.toISOString(),
    jobId: o.jobId,
    expiresAt: o.expiresAt.toISOString(),
    reason: o.reason,
    createdBy: o.createdBy,
    createdAt: o.createdAt.toISOString(),
    revokedAt: o.revokedAt?.toISOString() ?? null,
    revokedBy: o.revokedBy,
    active: o.revokedAt === null && o.expiresAt > now,
  };
}

function budgetViewJson(v: BudgetView): z.infer<typeof BudgetViewBody> {
  return { budget: budgetJson(v.budget), evaluation: v.evaluation ? evaluationJson(v.evaluation) : null };
}

function human(request: FastifyRequest): UsageActor {
  const { subject } = authzOf(request);
  return { id: subject.userId, role: subject.role, ...stepUpFields(request) };
}

/** p5-rbac: projects whose usage the caller may see (null = every project). */
function scope(request: FastifyRequest): readonly string[] | null {
  return visibleProjects(authzOf(request).subject);
}

/** A budget is project-bound when its scope is a project; other scopes are global resources. */
function budgetResource(db: Queryable) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await db.query<{ scope_type: string; scope_value: string | null }>(
      'SELECT scope_type, scope_value FROM usage_budgets WHERE id = $1',
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return { project: r.scope_type === 'project' ? r.scope_value : null };
  };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function filterOf(q: { [K in keyof typeof Filters]?: string | undefined }): UsageFilter {
  const out: Record<string, string> = {};
  for (const k of Object.keys(Filters) as (keyof typeof Filters)[]) {
    const v = q[k];
    if (v !== undefined) out[k] = k === 'provider' ? v.toLowerCase() : v;
  }
  return out;
}

async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UsageError) {
      return reply
        .code(err.httpStatus)
        .send({ error: err.code, message: err.publicMessage, ...err.details() });
    }
    throw err;
  }
}

/** Usage, price table and budget API (docs/design/p6-cost.md §6). All routes need a full session. */
export function usageRoutes(
  store: UsageStore,
  clock: () => Date,
  db: Queryable,
  /** p8-cost-efficiency: after an override was granted (the orchestrator re-checks held jobs). */
  onOverride?: () => void,
) {
  const budgetHidden = (): HttpError => new HttpError(404, 'not_found', 'Not found.');
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];

    r.get(
      '/usage/summary',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags: ['usage'],
          summary: 'Usage per group with dollars, provenance coverage and gap flags (viewer+)',
          security: session,
          querystring: z.object({
            groupBy: z.enum(GROUP_BYS).default('project'),
            from: IsoDate.optional(),
            to: IsoDate.optional(),
            ...Filters,
          }),
          response: {
            200: z.object({
              groupBy: z.enum(GROUP_BYS),
              from: z.string(),
              to: z.string(),
              priceTableVersion: z.number().int(),
              groups: z.array(GroupBody),
              totals: GroupBody,
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const q = request.query;
          // Default: the last 30 days up to and including now (`to` is exclusive).
          const to = q.to === undefined ? new Date(clock().getTime() + 1) : new Date(q.to);
          const from =
            q.from === undefined ? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS) : new Date(q.from);
          const s = await store.summary(human(request), {
            groupBy: q.groupBy,
            from,
            to,
            ...filterOf(q),
            projects: scope(request),
          });
          return {
            groupBy: q.groupBy,
            from: from.toISOString(),
            to: to.toISOString(),
            priceTableVersion: s.priceTableVersion,
            groups: s.groups.map(groupJson),
            totals: groupJson(s.totals),
          };
        }),
    );

    r.get(
      '/usage/records',
      {
        config: { authz: { action: 'usage.records' } },
        schema: {
          tags: ['usage'],
          summary: 'Usage records, newest first, keyset pagination (operator+)',
          security: session,
          querystring: z.object({
            from: IsoDate.optional(),
            to: IsoDate.optional(),
            job: z.uuid().optional(),
            jobs: JobIdList.optional(),
            limit: z.coerce.number().int().min(1).max(LIMITS.maxRecordsPage).default(100),
            cursor: z.string().max(200).optional(),
            ...Filters,
          }),
          response: {
            200: z.object({
              items: z.array(RecordBody),
              nextCursor: z.string().nullable(),
              priceTableVersion: z.number().int(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const q = request.query;
          const page = await store.records(human(request), {
            ...filterOf(q),
            projects: scope(request),
            ...(q.from === undefined ? {} : { from: new Date(q.from) }),
            ...(q.to === undefined ? {} : { to: new Date(q.to) }),
            ...(q.job === undefined ? {} : { jobId: q.job }),
            ...(q.jobs === undefined ? {} : { jobIds: q.jobs }),
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            limit: q.limit,
          });
          return {
            items: page.items.map(recordJson),
            nextCursor: page.nextCursor,
            priceTableVersion: page.priceTableVersion,
          };
        }),
    );

    r.get(
      '/usage/prices',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags: ['usage'],
          summary: 'The price table used for estimated costs (current or a given version; viewer+)',
          security: session,
          querystring: z.object({ version: z.coerce.number().int().min(0).max(1_000_000).optional() }),
          response: { 200: PriceTableBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () =>
          priceTableJson(await store.priceTable(human(request), request.query.version)),
        ),
    );

    r.get(
      '/usage/prices/versions',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags: ['usage'],
          summary: 'Price table version history (viewer+)',
          security: session,
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  version: z.number().int(),
                  note: z.string().nullable(),
                  entryCount: z.number().int(),
                  createdBy: z.string(),
                  createdAt: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({
          items: (await store.priceTableVersions(human(request))).map((v) => ({
            ...v,
            createdAt: v.createdAt.toISOString(),
          })),
        })),
    );

    r.put(
      '/usage/prices',
      {
        config: {
          authz: {
            action: 'prices.write',
            auditDenied: { action: 'usage.prices.update', target: () => 'usage:prices' },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags: ['usage'],
          summary: 'Replace the price table with a new version (admin+, step-up, expectedVersion)',
          security: csrf,
          body: z.object({
            expectedVersion: z.number().int().min(0),
            note: z.string().max(5000).optional(),
            entries: z
              .array(
                z.object({
                  provider: z.string().min(1).max(200),
                  model: z.string().min(1).max(200),
                  effectiveFrom: IsoDate,
                  inputUsdPerMTok: z.number(),
                  outputUsdPerMTok: z.number(),
                  cacheReadUsdPerMTok: z.number().nullable().optional(),
                  cacheWriteUsdPerMTok: z.number().nullable().optional(),
                  source: z.string().max(2000),
                }),
              )
              .max(LIMITS.maxPriceEntries),
          }),
          response: { 200: PriceTableBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const b = request.body;
          const t = await store.replacePriceTable(
            human(request),
            {
              expectedVersion: b.expectedVersion,
              note: b.note,
              entries: b.entries.map((e) => ({ ...e, effectiveFrom: new Date(e.effectiveFrom) })),
            },
            meta(request),
          );
          return priceTableJson(t);
        }),
    );

    r.get(
      '/budgets',
      {
        config: { authz: { action: 'budgets.read' } },
        schema: {
          tags: ['budgets'],
          summary: 'Budgets with their current-window evaluation (viewer+)',
          security: session,
          querystring: z.object({ includeDeleted: z.enum(['true', 'false']).optional() }),
          response: { 200: z.object({ items: z.array(BudgetViewBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({
          items: (
            await store.listBudgets(human(request), {
              projects: scope(request),
              includeDeleted: request.query.includeDeleted === 'true',
            })
          ).map(budgetViewJson),
        })),
    );

    r.get(
      '/budgets/:id',
      {
        config: { authz: { action: 'budgets.read', resource: budgetResource(db), notFound: budgetHidden } },
        schema: {
          tags: ['budgets'],
          summary: 'One budget with its current-window evaluation (viewer+)',
          security: session,
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: BudgetViewBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () =>
          budgetViewJson(await store.getBudget(human(request), request.params.id, scope(request))),
        ),
    );

    r.post(
      '/budgets',
      {
        config: {
          authz: {
            action: 'budgets.write',
            auditDenied: { action: 'usage.budget.create', target: () => 'usage:budgets' },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags: ['budgets'],
          summary: 'Define a budget (admin+, step-up). Enforcement is p4-quotas.',
          security: csrf,
          body: BudgetInputBody,
          response: { 201: BudgetViewBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const b = request.body;
          const v = await store.createBudget(
            human(request),
            {
              name: b.name,
              metric: b.metric,
              limit: b.limit,
              scopeType: b.scope.type,
              scopeValue: b.scope.value,
              window: b.window,
              enabled: b.enabled,
              billing: b.billing,
              timeZone: b.timeZone,
              thresholds: b.thresholds,
              onExceeded: b.onExceeded,
            },
            meta(request),
          );
          return reply.code(201).send(budgetViewJson(v));
        }),
    );

    r.put(
      '/budgets/:id',
      {
        config: {
          authz: {
            action: 'budgets.write',
            auditDenied: { action: 'usage.budget.update', target: paramTarget('budget') },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags: ['budgets'],
          summary: 'Change a budget (admin+, step-up, expectedVersion)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64) }),
          body: BudgetInputBody.extend({ expectedVersion: z.number().int().min(1) }),
          response: { 200: BudgetViewBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const b = request.body;
          const v = await store.updateBudget(
            human(request),
            request.params.id,
            {
              name: b.name,
              metric: b.metric,
              limit: b.limit,
              scopeType: b.scope.type,
              scopeValue: b.scope.value,
              window: b.window,
              enabled: b.enabled,
              billing: b.billing,
              timeZone: b.timeZone,
              thresholds: b.thresholds,
              onExceeded: b.onExceeded,
              expectedVersion: b.expectedVersion,
            },
            meta(request),
          );
          return budgetViewJson(v);
        }),
    );

    r.delete(
      '/budgets/:id',
      {
        config: {
          authz: {
            action: 'budgets.write',
            auditDenied: { action: 'usage.budget.delete', target: paramTarget('budget') },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags: ['budgets'],
          summary: 'Delete a budget (soft; admin+, step-up, expectedVersion)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64) }),
          querystring: z.object({ expectedVersion: z.coerce.number().int().min(1) }),
          response: { 200: z.object({ budget: BudgetBody }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({
          budget: budgetJson(
            await store.deleteBudget(
              human(request),
              request.params.id,
              request.query.expectedVersion,
              meta(request),
            ),
          ),
        })),
    );

    // p8-cost-efficiency: overrides of an exhausted budget (owner/admin, step-up, audited).
    r.get(
      '/budgets/:id/overrides',
      {
        config: { authz: { action: 'budgets.read', resource: budgetResource(db), notFound: budgetHidden } },
        schema: {
          tags: ['budgets'],
          summary: 'Overrides of a budget, newest first (viewer+)',
          security: session,
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: z.object({ items: z.array(OverrideBody) }), ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => ({
          items: (await store.listOverrides(human(request), request.params.id, scope(request))).map((o) =>
            overrideJson(o, clock()),
          ),
        })),
    );

    r.post(
      '/budgets/:id/overrides',
      {
        config: {
          authz: {
            action: 'budgets.override',
            resource: budgetResource(db),
            notFound: budgetHidden,
            auditDenied: { action: 'usage.budget.override', target: paramTarget('budget') },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags: ['budgets'],
          summary:
            'Let work through an exhausted budget until `until` (default and maximum: the end of the current window) — every held job, or one job (owner/admin, step-up)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64) }),
          body: z.strictObject({
            reason: z.string().max(2000),
            jobId: z.string().max(64).nullable().optional(),
            until: IsoDate.optional(),
          }),
          response: { 201: OverrideBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () => {
          const b = request.body;
          const o = await store.createOverride(
            human(request),
            request.params.id,
            {
              reason: b.reason,
              jobId: b.jobId ?? null,
              ...(b.until === undefined ? {} : { until: new Date(b.until) }),
            },
            meta(request),
          );
          onOverride?.();
          return reply.code(201).send(overrideJson(o, clock()));
        }),
    );

    r.delete(
      '/budgets/:id/overrides/:overrideId',
      {
        config: {
          authz: {
            action: 'budgets.override',
            resource: budgetResource(db),
            notFound: budgetHidden,
            auditDenied: { action: 'usage.budget.override.revoke', target: paramTarget('budget') },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags: ['budgets'],
          summary: 'End a budget override early (owner/admin, step-up)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64), overrideId: z.string().min(1).max(64) }),
          response: { 200: OverrideBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, async () =>
          overrideJson(
            await store.revokeOverride(
              human(request),
              request.params.id,
              request.params.overrideId,
              meta(request),
            ),
            clock(),
          ),
        ),
    );
  };
}
