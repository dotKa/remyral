import { API_PREFIX, apiRequest, ApiError, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * Typed wrappers for the p8-cost-efficiency routes (apps/master/src/efficiency/routes.ts): the cost & efficiency
 * dashboard, suggestions, CSV exports and one's own weekly reports. Project, model, automation and machine names
 * come from users and workers: render as text.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const DIMENSIONS = ['project', 'runtime', 'model', 'kind', 'automation', 'worker'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const GRAINS = ['day', 'week', 'month'] as const;
export type Grain = (typeof GRAINS)[number];

export interface Spend {
  readonly records: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly turns: number;
  readonly wallTimeMs: number;
  readonly costUsd: number;
  readonly costComplete: boolean;
  readonly unknownCostRecords: number;
  readonly subscriptionRecords: number;
  readonly apiEquivalentUsd: number;
  readonly apiEquivalentUnpricedRecords: number;
  readonly metricsIncomplete: boolean;
}

export interface TrendPoint extends Spend {
  readonly key: string;
  readonly start: string;
  readonly end: string;
}

export interface BreakdownRow {
  readonly key: string | null;
  readonly label: string;
  readonly spend: Spend;
  readonly jobs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly successRate: number | null;
  readonly costPerSuccessUsd: number | null;
  readonly costPerSuccessComplete: boolean;
  readonly apiEquivalentPerSuccessUsd: number | null;
}

export interface TopJob {
  readonly jobId: string;
  readonly project: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly kind: string | null;
  readonly automationName: string | null;
  readonly workerId: string | null;
  readonly state: string;
  readonly durationSec: number | null;
  readonly costUsd: number;
  readonly costComplete: boolean;
  readonly apiEquivalentUsd: number;
  readonly tokens: number;
}

export interface SuccessRate {
  readonly runtime: string | null;
  readonly model: string | null;
  readonly attempts: number;
  readonly successRate: number | null;
  readonly p50DurationSec: number | null;
  readonly costPerAttemptUsd: number | null;
}

export interface Savings {
  readonly reuse: {
    readonly hits: number;
    readonly automationRuns: number;
    readonly workflowSteps: number;
    readonly estimatedSeconds: number;
    readonly estimatedCostUsd: number;
    readonly estimatedApiEquivalentUsd: number;
  };
  readonly warmCaches: { readonly runs: number };
  readonly safeAutoApprove: {
    readonly approvals: number;
    readonly medianHumanWaitSec: number;
    readonly measured: boolean;
    readonly estimatedSecondsSaved: number;
  };
}

export interface Outcomes {
  readonly finished: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly successRate: number | null;
  readonly costPerSuccessUsd: number | null;
  readonly costPerSuccessComplete: boolean;
  readonly apiEquivalentPerSuccessUsd: number | null;
}

export interface Dashboard {
  readonly range: {
    readonly from: string;
    readonly to: string;
    readonly grain: Grain;
    readonly timeZone: string;
  };
  readonly totals: Spend;
  readonly trends: readonly TrendPoint[];
  readonly breakdown: { readonly dimension: Dimension; readonly rows: readonly BreakdownRow[] };
  readonly outcomes: Outcomes;
  readonly topCostly: readonly TopJob[];
  readonly slowest: readonly TopJob[];
  readonly successRates: readonly SuccessRate[];
  readonly savings: Savings;
  readonly missingPrices: readonly { provider: string; model: string; records: number }[];
  readonly truncated: boolean;
}

export type SuggestionAction =
  | {
      readonly kind: 'routing_rule';
      readonly role: string;
      readonly modelProfile: string;
      readonly runtimes: string[];
    }
  | { readonly kind: 'pause_automation'; readonly automationId: string }
  | { readonly kind: 'enable_reuse'; readonly automationId: string; readonly hours: number }
  | { readonly kind: 'set_parallelism'; readonly workerId: string; readonly value: number }
  | { readonly kind: 'open'; readonly path: string };

export interface Suggestion {
  readonly id: string;
  readonly rule: string;
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, number | string>>;
  readonly action: SuggestionAction | null;
  readonly actionRole: 'owner' | 'admin' | 'operator' | 'viewer' | null;
  readonly actionStepUp: boolean;
  readonly project: string | null;
}

export interface ReportSettings {
  readonly timeZone: string;
  readonly weeklyEnabled: boolean;
  readonly chatThreadId: string | null;
  readonly isDefault: boolean;
}

export interface ReportListItem {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly summary: string;
}

/** Stored report content (apps/master/src/efficiency/reports.ts WeeklyReportContent v1). */
export interface ReportContent {
  readonly version: number;
  readonly period: {
    readonly start: string;
    readonly end: string;
    readonly timeZone: string;
    readonly label: string;
  };
  readonly ran: {
    readonly finished: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly byProject: readonly { project: string; succeeded: number; failed: number; cancelled: number }[];
  };
  readonly deployed: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly items: readonly {
      id: string;
      project: string;
      kind: string;
      env: string | null;
      state: string;
      at: string;
    }[];
  };
  readonly failures: readonly {
    jobId: string;
    project: string;
    runtime: string;
    errorCode: string | null;
    at: string;
  }[];
  readonly spend: Spend & {
    readonly previousWeekCostUsd: number;
    readonly previousWeekApiEquivalentUsd: number;
  };
  readonly budgets: readonly {
    id: string;
    name: string;
    scope: string;
    used: string;
    limit: string;
    ratio: number;
    status: string;
    policy: string;
    windowEnd: string;
  }[];
  readonly topCostly: readonly TopJob[];
  readonly slowest: readonly TopJob[];
  readonly savings: Savings;
  readonly suggestions: readonly Suggestion[];
}

export interface Report {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly content: ReportContent;
}

// ------------------------------------------------------------------------------------------ parsing

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${k}`);
  return v;
}

function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${k}`);
  return v;
}

function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v;
}

function spend(v: unknown): Spend {
  const o = obj(v);
  return {
    records: num(o, 'records'),
    inputTokens: num(o, 'inputTokens'),
    outputTokens: num(o, 'outputTokens'),
    cacheReadTokens: num(o, 'cacheReadTokens'),
    turns: num(o, 'turns'),
    wallTimeMs: num(o, 'wallTimeMs'),
    costUsd: num(o, 'costUsd'),
    costComplete: bool(o, 'costComplete'),
    unknownCostRecords: num(o, 'unknownCostRecords'),
    subscriptionRecords: num(o, 'subscriptionRecords'),
    apiEquivalentUsd: num(o, 'apiEquivalentUsd'),
    apiEquivalentUnpricedRecords: num(o, 'apiEquivalentUnpricedRecords'),
    metricsIncomplete: bool(o, 'metricsIncomplete'),
  };
}

/** Checks the fields the console renders; the rest of the documented shape is trusted from the master's schema. */
export function parseDashboard(v: unknown): Dashboard {
  const o = obj(v);
  const breakdown = obj(o.breakdown);
  return {
    ...(o as unknown as Dashboard),
    totals: spend(o.totals),
    trends: arr(o.trends).map((t) => ({
      ...spend(t),
      key: str(obj(t), 'key'),
      start: str(obj(t), 'start'),
      end: str(obj(t), 'end'),
    })),
    breakdown: {
      dimension: str(breakdown, 'dimension') as Dimension,
      rows: arr(breakdown.rows).map((r) => {
        const x = obj(r);
        return { ...(x as unknown as BreakdownRow), label: str(x, 'label'), spend: spend(x.spend) };
      }),
    },
    topCostly: arr(o.topCostly) as TopJob[],
    slowest: arr(o.slowest) as TopJob[],
    successRates: arr(o.successRates) as SuccessRate[],
    missingPrices: arr(o.missingPrices) as Dashboard['missingPrices'],
    truncated: bool(o, 'truncated'),
  };
}

const ACTION_KINDS = new Set(['routing_rule', 'pause_automation', 'enable_reuse', 'set_parallelism', 'open']);

function parseSuggestion(v: unknown): Suggestion {
  const o = obj(v);
  const action = o.action === null ? null : obj(o.action);
  if (action !== null && !ACTION_KINDS.has(str(action, 'kind'))) throw new ShapeError('unknown action');
  return {
    id: str(o, 'id'),
    rule: str(o, 'rule'),
    severity: str(o, 'severity') === 'warning' ? 'warning' : 'info',
    title: str(o, 'title'),
    detail: str(o, 'detail'),
    evidence: obj(o.evidence) as Record<string, number | string>,
    action: action as SuggestionAction | null,
    actionRole: (o.actionRole ?? null) as Suggestion['actionRole'],
    actionStepUp: bool(o, 'actionStepUp'),
    project: o.project === null ? null : str(o, 'project'),
  };
}

function parseSettings(v: unknown): ReportSettings {
  const o = obj(v);
  return {
    timeZone: str(o, 'timeZone'),
    weeklyEnabled: bool(o, 'weeklyEnabled'),
    chatThreadId: o.chatThreadId === null ? null : str(o, 'chatThreadId'),
    isDefault: bool(o, 'isDefault'),
  };
}

function parseContent(v: unknown): ReportContent {
  const o = obj(v);
  obj(o.period);
  obj(o.ran);
  spend(o.spend);
  return o as unknown as ReportContent;
}

// ------------------------------------------------------------------------------------------ calls

export interface DashboardQuery {
  readonly from: string;
  readonly to: string;
  readonly grain: Grain;
  readonly timeZone: string;
  readonly dimension: Dimension;
  readonly billing?: 'all' | 'api' | 'subscription';
  readonly project?: string;
}

export function dashboardParams(q: DashboardQuery): string {
  const p = new URLSearchParams({
    from: q.from,
    to: q.to,
    grain: q.grain,
    timeZone: q.timeZone,
    dimension: q.dimension,
  });
  if (q.billing !== undefined && q.billing !== 'all') p.set('billing', q.billing);
  if (q.project !== undefined && q.project !== '') p.set('project', q.project);
  return p.toString();
}

export function getDashboard(q: DashboardQuery, opts: Opts = {}): Promise<Dashboard> {
  return apiRequest('GET', `/usage/dashboard?${dashboardParams(q)}`, parseDashboard, opts);
}

export function getSuggestions(opts: Opts = {}): Promise<Suggestion[]> {
  return apiRequest('GET', '/usage/suggestions', (v) => arr(obj(v).items).map(parseSuggestion), opts);
}

/** Downloads a CSV export through fetch (so errors surface instead of a broken file). */
export async function downloadCsv(
  kind: 'breakdown' | 'jobs',
  q: DashboardQuery,
  save: (blob: Blob, filename: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${API_PREFIX}/usage/export/${kind}.csv?${dashboardParams(q)}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let code = 'http_error';
    let message = 'The export failed.';
    try {
      const b = obj(await res.json());
      code = str(b, 'error');
      message = str(b, 'message');
    } catch {
      // keep the generic message
    }
    throw new ApiError(res.status, code, message);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="([A-Za-z0-9._-]{1,120})"/.exec(disposition)?.[1] ?? `usage-${kind}.csv`;
  save(await res.blob(), name);
}

export function getReportSettings(opts: Opts = {}): Promise<ReportSettings> {
  return apiRequest('GET', '/reports/settings', parseSettings, opts);
}

export function putReportSettings(
  body: { timeZone: string; weeklyEnabled: boolean; chatThreadId: string | null },
  opts: Opts = {},
): Promise<ReportSettings> {
  return apiRequest('PUT', '/reports/settings', parseSettings, { ...opts, body });
}

export function listReports(opts: Opts = {}): Promise<ReportListItem[]> {
  return apiRequest(
    'GET',
    '/reports',
    (v) =>
      arr(obj(v).items).map((i) => {
        const x = obj(i);
        return {
          id: str(x, 'id'),
          periodStart: str(x, 'periodStart'),
          periodEnd: str(x, 'periodEnd'),
          timeZone: str(x, 'timeZone'),
          generatedAt: str(x, 'generatedAt'),
          summary: str(x, 'summary'),
        };
      }),
    opts,
  );
}

export function getReport(id: string, opts: Opts = {}): Promise<Report> {
  return apiRequest(
    'GET',
    `/reports/${encodeURIComponent(id)}`,
    (v) => {
      const o = obj(v);
      return {
        id: str(o, 'id'),
        periodStart: str(o, 'periodStart'),
        periodEnd: str(o, 'periodEnd'),
        timeZone: str(o, 'timeZone'),
        generatedAt: str(o, 'generatedAt'),
        content: parseContent(o.content),
      };
    },
    opts,
  );
}

export function previewReport(week: 'last' | 'current', opts: Opts = {}): Promise<ReportContent> {
  return apiRequest('GET', `/reports/weekly/preview?week=${week}`, (v) => parseContent(obj(v).content), opts);
}
