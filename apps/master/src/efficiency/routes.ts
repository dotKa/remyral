import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { BUDGET_BILLINGS, isValidTimeZone, PERIOD_GRAINS } from '@remyral/usage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { csvLine } from '../audit/export.js';
import { visibleProjects } from '../authz/model.js';
import { HttpError } from '../http/errors.js';
import type { AuthzRule } from '../http/route-authz.js';
import { authzOf } from '../http/route-authz.js';
import { ReportSettingsInvalidError, type ReportService } from './reports.js';
import { DIMENSIONS, type DashboardQuery, EfficiencyService } from './service.js';
import { SUGGESTION_RULES } from './suggestions.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 400;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const IsoDate = z.iso.datetime({ offset: true });

const Spend = z.object({
  records: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  turns: z.number(),
  wallTimeMs: z.number(),
  costUsd: z.number(),
  costComplete: z.boolean(),
  unknownCostRecords: z.number().int(),
  subscriptionRecords: z.number().int(),
  apiEquivalentUsd: z.number(),
  apiEquivalentUnpricedRecords: z.number().int(),
  metricsIncomplete: z.boolean(),
});
const TrendPoint = Spend.extend({ key: z.string(), start: z.string(), end: z.string() });
const BreakdownRow = z.object({
  key: z.string().nullable(),
  label: z.string(),
  spend: Spend,
  jobs: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  successRate: z.number().nullable(),
  costPerSuccessUsd: z.number().nullable(),
  costPerSuccessComplete: z.boolean(),
  apiEquivalentPerSuccessUsd: z.number().nullable(),
});
const TopJob = z.object({
  jobId: z.string(),
  project: z.string(),
  runtime: z.string(),
  model: z.string().nullable(),
  kind: z.string().nullable(),
  automationId: z.string().nullable(),
  automationName: z.string().nullable(),
  workerId: z.string().nullable(),
  state: z.string(),
  finishedAt: z.string().nullable(),
  durationSec: z.number().nullable(),
  costUsd: z.number(),
  costComplete: z.boolean(),
  apiEquivalentUsd: z.number(),
  tokens: z.number(),
});
const SuccessRate = z.object({
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  attempts: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  successRate: z.number().nullable(),
  p50DurationSec: z.number().nullable(),
  p90DurationSec: z.number().nullable(),
  costPerAttemptUsd: z.number().nullable(),
});
const Savings = z.object({
  reuse: z.object({
    hits: z.number().int(),
    automationRuns: z.number().int(),
    workflowSteps: z.number().int(),
    estimatedSeconds: z.number(),
    estimatedCostUsd: z.number(),
    estimatedApiEquivalentUsd: z.number(),
  }),
  warmCaches: z.object({ runs: z.number().int() }),
  safeAutoApprove: z.object({
    approvals: z.number().int(),
    medianHumanWaitSec: z.number(),
    measured: z.boolean(),
    estimatedSecondsSaved: z.number(),
  }),
});
const Outcomes = z.object({
  finished: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  successRate: z.number().nullable(),
  costPerSuccessUsd: z.number().nullable(),
  costPerSuccessComplete: z.boolean(),
  apiEquivalentPerSuccessUsd: z.number().nullable(),
});
const DashboardBody = z.object({
  range: z.object({ from: z.string(), to: z.string(), grain: z.enum(PERIOD_GRAINS), timeZone: z.string() }),
  priceTableVersion: z.number().int(),
  totals: Spend,
  trends: z.array(TrendPoint),
  breakdown: z.object({ dimension: z.enum(DIMENSIONS), rows: z.array(BreakdownRow) }),
  outcomes: Outcomes,
  topCostly: z.array(TopJob),
  slowest: z.array(TopJob),
  successRates: z.array(SuccessRate),
  savings: Savings,
  missingPrices: z.array(z.object({ provider: z.string(), model: z.string(), records: z.number().int() })),
  truncated: z.boolean(),
});
const SuggestionAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('routing_rule'),
    role: z.string(),
    modelProfile: z.string(),
    runtimes: z.array(z.string()),
  }),
  z.object({ kind: z.literal('pause_automation'), automationId: z.string() }),
  z.object({ kind: z.literal('enable_reuse'), automationId: z.string(), hours: z.number().int() }),
  z.object({ kind: z.literal('set_parallelism'), workerId: z.string(), value: z.number().int() }),
  z.object({ kind: z.literal('open'), path: z.string() }),
]);
const SuggestionBody = z.object({
  id: z.string(),
  rule: z.enum(SUGGESTION_RULES),
  severity: z.enum(['info', 'warning']),
  title: z.string(),
  detail: z.string(),
  evidence: z.record(z.string(), z.union([z.number(), z.string()])),
  action: SuggestionAction.nullable(),
  actionRole: z.enum(['owner', 'admin', 'operator', 'viewer']).nullable(),
  actionStepUp: z.boolean(),
  project: z.string().nullable(),
});
const SettingsBody = z.object({
  timeZone: z.string(),
  weeklyEnabled: z.boolean(),
  chatThreadId: z.string().nullable(),
  isDefault: z.boolean(),
});
const ReportContent = z.record(z.string(), z.unknown());
const ReportBody = z.object({
  id: z.string(),
  kind: z.literal('weekly'),
  periodStart: z.string(),
  periodEnd: z.string(),
  timeZone: z.string(),
  generatedAt: z.string(),
  delivery: z.record(z.string(), z.unknown()),
  content: ReportContent,
});

const RangeQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  grain: z.enum(PERIOD_GRAINS).default('day'),
  timeZone: z.string().min(1).max(64).default('UTC'),
  project: z.string().regex(PROJECT).optional(),
  billing: z.enum(BUDGET_BILLINGS).optional(),
  dimension: z.enum(DIMENSIONS).default('project'),
});

function invalid(path: string, code: string): HttpError {
  return Object.assign(new HttpError(400, 'invalid_query', `Invalid ${path}.`, {}, {}, { field: path }), {
    issues: [{ path, code }],
  });
}

function rangeOf(request: FastifyRequest, q: z.infer<typeof RangeQuery>, now: Date): DashboardQuery {
  const to = q.to === undefined ? new Date(now.getTime() + 1000) : new Date(q.to);
  const from = q.from === undefined ? new Date(to.getTime() - 30 * DAY_MS) : new Date(q.from);
  if (to <= from) throw invalid('to', 'before_from');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw invalid('to', 'range_too_long');
  if (!isValidTimeZone(q.timeZone)) throw invalid('timeZone', 'invalid');
  return {
    from,
    to,
    grain: q.grain,
    timeZone: q.timeZone,
    projects: visibleProjects(authzOf(request).subject),
    project: q.project,
    billing: q.billing,
    dimension: q.dimension,
  };
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Own reports only (`reports.self`): every handler scopes by the session's user id. */
const SELF: AuthzRule = {
  action: 'reports.self',
  resource: (request) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

function userId(request: FastifyRequest): string {
  const id = request.auth?.session.user.id;
  if (!id) throw new HttpError(401, 'unauthorized', 'Authentication required.');
  return id;
}

/**
 * p8-cost-efficiency API (docs/design/p8-cost-efficiency.md §8):
 *
 * - `GET /usage/dashboard` — trends, breakdown, outcomes, top jobs, success rates, savings (usage.read, viewer+; the
 *   caller's visible projects only);
 * - `GET /usage/suggestions` — rule-based efficiency suggestions (usage.read);
 * - `GET /usage/export/breakdown.csv` (usage.read) and `GET /usage/export/jobs.csv` (usage.records, operator+);
 * - `GET|PUT /reports/settings`, `GET /reports`, `GET /reports/:id`, `GET /reports/weekly/preview` — one's own
 *   weekly reports (reports.self).
 */
export function efficiencyRoutes(
  service: EfficiencyService,
  reports: ReportService,
  clock: () => Date = () => new Date(),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['usage'];
    const session = [{ session: [] }];

    r.get(
      '/usage/dashboard',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags,
          summary:
            'Cost & efficiency dashboard: trends per day/week/month (time zone), breakdown by project / runtime / model / kind / automation / machine, outcomes and cost per successful job, top expensive and slowest jobs, success rates, savings (viewer+)',
          security: session,
          querystring: RangeQuery,
          response: { 200: DashboardBody, ...errors },
        },
      },
      async (request) =>
        (await service.dashboard(rangeOf(request, request.query, clock()))) as z.infer<typeof DashboardBody>,
    );

    r.get(
      '/usage/suggestions',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags,
          summary:
            'Efficiency suggestions from deterministic rules over the recorded statistics, each with its evidence and an optional one-click action through an existing route (never applied automatically; viewer+)',
          security: session,
          response: { 200: z.object({ items: z.array(SuggestionBody) }), ...errors },
        },
      },
      async (request) => ({
        items: (await service.suggestions(visibleProjects(authzOf(request).subject))).map((s) => ({
          ...s,
          evidence: { ...s.evidence },
          action:
            s.action === null
              ? null
              : s.action.kind === 'routing_rule'
                ? { ...s.action, runtimes: [...s.action.runtimes] }
                : { ...s.action },
        })),
      }),
    );

    r.get(
      '/usage/export/breakdown.csv',
      {
        config: { authz: { action: 'usage.read' } },
        schema: {
          tags,
          summary: 'The dashboard breakdown as CSV (viewer+; spreadsheet formulas neutralised)',
          security: session,
          querystring: RangeQuery,
        },
      },
      async (request, reply) => {
        const q = rangeOf(request, request.query, clock());
        const { header, rows } = EfficiencyService.breakdownRows(await service.dashboard(q));
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="usage-${q.dimension}-${stamp(q.from)}-${stamp(q.to)}.csv"`,
          )
          .send([header, ...rows].map(csvLine).join(''));
      },
    );

    r.get(
      '/usage/export/jobs.csv',
      {
        config: { authz: { action: 'usage.records' } },
        schema: {
          tags,
          summary: 'Usage per job in the period as CSV (operator+; spreadsheet formulas neutralised)',
          security: session,
          querystring: RangeQuery,
        },
      },
      async (request, reply) => {
        const q = rangeOf(request, request.query, clock());
        const { header, rows } = await service.jobRows(q);
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="usage-jobs-${stamp(q.from)}-${stamp(q.to)}.csv"`,
          )
          .send([header, ...rows].map(csvLine).join(''));
      },
    );

    // ----------------------------------------------------------------------------------- reports

    r.get(
      '/reports/settings',
      {
        config: { authz: SELF },
        schema: {
          tags: ['reports'],
          summary: 'Own report settings: time zone, weekly report on/off, chat thread (defaults when unset)',
          security: session,
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => reports.settings(userId(request)),
    );

    r.put(
      '/reports/settings',
      {
        config: { authz: SELF },
        schema: {
          tags: ['reports'],
          summary:
            'Change own report settings (time zone for Monday 08:00, weekly report on/off, optional own chat thread)',
          security: [{ session: [], csrf: [] }],
          body: z.strictObject({
            timeZone: z.string().min(1).max(64),
            weeklyEnabled: z.boolean(),
            chatThreadId: z.string().max(64).nullable(),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request, reply) => {
        try {
          return await reports.updateSettings(userId(request), request.body);
        } catch (err) {
          if (err instanceof ReportSettingsInvalidError) {
            return reply
              .code(400)
              .send({ error: err.code, message: err.publicMessage, issues: [...err.issues] });
          }
          throw err;
        }
      },
    );

    r.get(
      '/reports',
      {
        config: { authz: SELF },
        schema: {
          tags: ['reports'],
          summary: 'Own weekly reports, newest first',
          security: session,
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(26) }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  periodStart: z.string(),
                  periodEnd: z.string(),
                  timeZone: z.string(),
                  generatedAt: z.string(),
                  summary: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({ items: await reports.list(userId(request), request.query.limit) }),
    );

    r.get(
      '/reports/weekly/preview',
      {
        config: { authz: SELF },
        schema: {
          tags: ['reports'],
          summary: 'The weekly report for the last full week or the week so far, computed now and not stored',
          security: session,
          querystring: z.object({ week: z.enum(['last', 'current']).default('current') }),
          response: { 200: z.object({ content: ReportContent }), ...errors },
        },
      },
      async (request) => ({
        content: (await reports.preview(userId(request), request.query.week)) as unknown as Record<
          string,
          unknown
        >,
      }),
    );

    r.get(
      '/reports/:id',
      {
        config: { authz: SELF },
        schema: {
          tags: ['reports'],
          summary: 'One of the own weekly reports',
          security: session,
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: ReportBody, ...errors },
        },
      },
      async (request) => {
        const v = await reports.get(userId(request), request.params.id);
        return { ...v, content: v.content as unknown as Record<string, unknown> };
      },
    );
  };
}
