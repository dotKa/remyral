import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * Typed wrappers for the master's usage, price-table and budget routes (apps/master/src/usage/routes.ts,
 * docs/design/p6-cost.md). Provider/model/project/worker strings may come from workers: render as text.
 */

export const GROUP_BYS = ['project', 'worker', 'runtime', 'provider', 'model'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const COST_CLASSES = ['reported', 'estimated', 'unknown', 'subscription'] as const;
export type CostClass = (typeof COST_CLASSES)[number];
export type Coverage = Readonly<Record<CostClass, number>>;

export interface MissingPrice {
  readonly provider: string;
  readonly model: string;
  readonly reason: 'price_missing' | 'cache_price_missing';
  readonly records: number;
}

export interface UsageGroup {
  readonly key: string | null;
  readonly records: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly tokensUnknownRecords: number;
  readonly turns: number;
  readonly turnsUnknownRecords: number;
  readonly wallTimeMs: number;
  readonly wallTimeUnknownRecords: number;
  readonly costUsd: { readonly reported: number; readonly estimated: number; readonly total: number };
  /** p8: what subscription usage would cost on API billing — an estimate, never money spent. */
  readonly apiEquivalent: { readonly usd: number; readonly unpricedRecords: number };
  readonly coverage: Coverage;
  readonly unknownReasons: Readonly<Record<string, number>>;
  readonly missingPrices: readonly MissingPrice[];
  readonly flags: {
    readonly costComplete: boolean;
    readonly hasSubscription: boolean;
    readonly noPerRunCost: boolean;
    readonly metricsIncomplete: boolean;
  };
}

export interface UsageSummary {
  readonly groupBy: GroupBy;
  readonly from: string;
  readonly to: string;
  readonly priceTableVersion: number;
  readonly groups: readonly UsageGroup[];
  readonly totals: UsageGroup;
}

export interface PriceEntry {
  readonly provider: string;
  readonly model: string;
  readonly effectiveFrom: string;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok: number | null;
  readonly cacheWriteUsdPerMTok: number | null;
  readonly source: string;
}

export interface PriceTable {
  readonly version: number;
  readonly note: string | null;
  readonly createdAt: string | null;
  readonly entries: readonly PriceEntry[];
}

export const BUDGET_METRICS = ['tokens', 'turns', 'wall_time_ms', 'cost_usd'] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];
export const BUDGET_SCOPES = ['global', 'project', 'runtime', 'provider', 'worker'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPES)[number];
export const BUDGET_WINDOWS = ['day', 'week', 'month'] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];
export type BudgetStatus = 'under' | 'warning' | 'over' | 'unknown';
/** p8-cost-efficiency: which usage a budget counts and what happens at 100 %. */
export const BUDGET_BILLINGS = ['all', 'api', 'subscription'] as const;
export type BudgetBilling = (typeof BUDGET_BILLINGS)[number];
export const BUDGET_POLICIES = ['warn', 'pause_new', 'block_automations'] as const;
export type BudgetPolicy = (typeof BUDGET_POLICIES)[number];

export interface Budget {
  readonly id: string;
  readonly name: string;
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly scope: { readonly type: BudgetScopeType; readonly value: string | null };
  readonly window: BudgetWindow;
  readonly enabled: boolean;
  readonly version: number;
  readonly billing: BudgetBilling;
  readonly timeZone: string;
  readonly thresholds: readonly number[];
  readonly onExceeded: BudgetPolicy;
}

export interface BudgetOverride {
  readonly id: string;
  readonly jobId: string | null;
  readonly expiresAt: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
}

export interface BudgetEvaluation {
  readonly used: number;
  readonly limit: number;
  readonly ratio: number;
  readonly status: BudgetStatus;
  readonly complete: boolean;
  readonly records: number;
  readonly unknownRecords: number;
  readonly subscriptionRecords: number;
  readonly window: { readonly start: string; readonly end: string };
}

export interface BudgetView {
  readonly budget: Budget;
  readonly evaluation: BudgetEvaluation | null;
}

export interface BudgetInput {
  readonly name: string;
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly scope: { readonly type: BudgetScopeType; readonly value: string | null };
  readonly window: BudgetWindow;
  readonly enabled: boolean;
  readonly billing?: BudgetBilling;
  readonly timeZone?: string;
  readonly thresholds?: readonly number[];
  readonly onExceeded?: BudgetPolicy;
}

type Opts = Omit<RequestOptions, 'body'>;

// ------------------------------------------------------------------------------------------ parsing

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${key}`);
  return v;
}

function nullableNum(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : num(o, key);
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function oneOf<const A extends readonly string[]>(
  o: Record<string, unknown>,
  key: string,
  allowed: A,
): A[number] {
  const v = str(o, key);
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new ShapeError(`unexpected ${key}`);
  return found;
}

function array<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(item);
}

function coverage(v: unknown): Coverage {
  const o = obj(v);
  return {
    reported: num(o, 'reported'),
    estimated: num(o, 'estimated'),
    unknown: num(o, 'unknown'),
    subscription: num(o, 'subscription'),
  };
}

function parseGroup(v: unknown): UsageGroup {
  const o = obj(v);
  const cost = obj(o.costUsd);
  const flags = obj(o.flags);
  const reasons = obj(o.unknownReasons);
  return {
    key: nullableStr(o, 'key'),
    records: int(o, 'records'),
    inputTokens: num(o, 'inputTokens'),
    outputTokens: num(o, 'outputTokens'),
    cacheReadTokens: num(o, 'cacheReadTokens'),
    cacheWriteTokens: num(o, 'cacheWriteTokens'),
    tokensUnknownRecords: int(o, 'tokensUnknownRecords'),
    turns: num(o, 'turns'),
    turnsUnknownRecords: int(o, 'turnsUnknownRecords'),
    wallTimeMs: num(o, 'wallTimeMs'),
    wallTimeUnknownRecords: int(o, 'wallTimeUnknownRecords'),
    costUsd: {
      reported: num(cost, 'reported'),
      estimated: num(cost, 'estimated'),
      total: num(cost, 'total'),
    },
    apiEquivalent: (() => {
      // Older masters (before p8) do not send it.
      if (o.apiEquivalent === undefined) return { usd: 0, unpricedRecords: 0 };
      const e = obj(o.apiEquivalent);
      return { usd: num(e, 'usd'), unpricedRecords: int(e, 'unpricedRecords') };
    })(),
    coverage: coverage(o.coverage),
    unknownReasons: Object.fromEntries(Object.keys(reasons).map((k) => [k, int(reasons, k)])),
    missingPrices: array(o.missingPrices, (m) => {
      const x = obj(m);
      return {
        provider: str(x, 'provider'),
        model: str(x, 'model'),
        reason: oneOf(x, 'reason', ['price_missing', 'cache_price_missing']),
        records: int(x, 'records'),
      };
    }),
    flags: {
      costComplete: bool(flags, 'costComplete'),
      hasSubscription: bool(flags, 'hasSubscription'),
      noPerRunCost: bool(flags, 'noPerRunCost'),
      metricsIncomplete: bool(flags, 'metricsIncomplete'),
    },
  };
}

function parseSummary(v: unknown): UsageSummary {
  const o = obj(v);
  return {
    groupBy: oneOf(o, 'groupBy', GROUP_BYS),
    from: str(o, 'from'),
    to: str(o, 'to'),
    priceTableVersion: int(o, 'priceTableVersion'),
    groups: array(o.groups, parseGroup),
    totals: parseGroup(o.totals),
  };
}

function parsePrice(v: unknown): PriceEntry {
  const o = obj(v);
  return {
    provider: str(o, 'provider'),
    model: str(o, 'model'),
    effectiveFrom: str(o, 'effectiveFrom'),
    inputUsdPerMTok: num(o, 'inputUsdPerMTok'),
    outputUsdPerMTok: num(o, 'outputUsdPerMTok'),
    cacheReadUsdPerMTok: nullableNum(o, 'cacheReadUsdPerMTok'),
    cacheWriteUsdPerMTok: nullableNum(o, 'cacheWriteUsdPerMTok'),
    source: str(o, 'source'),
  };
}

function parsePriceTable(v: unknown): PriceTable {
  const o = obj(v);
  return {
    version: int(o, 'version'),
    note: nullableStr(o, 'note'),
    createdAt: nullableStr(o, 'createdAt'),
    entries: array(o.entries, parsePrice),
  };
}

function parseBudget(v: unknown): Budget {
  const o = obj(v);
  const scope = obj(o.scope);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    metric: oneOf(o, 'metric', BUDGET_METRICS),
    limit: num(o, 'limit'),
    scope: { type: oneOf(scope, 'type', BUDGET_SCOPES), value: nullableStr(scope, 'value') },
    window: oneOf(o, 'window', BUDGET_WINDOWS),
    enabled: bool(o, 'enabled'),
    version: int(o, 'version'),
    billing: o.billing === undefined ? 'all' : oneOf(o, 'billing', BUDGET_BILLINGS),
    timeZone: o.timeZone === undefined ? 'UTC' : str(o, 'timeZone'),
    thresholds:
      o.thresholds === undefined
        ? [80, 100]
        : array(o.thresholds, (x) => {
            if (typeof x !== 'number') throw new ShapeError('expected number');
            return x;
          }),
    onExceeded: o.onExceeded === undefined ? 'pause_new' : oneOf(o, 'onExceeded', BUDGET_POLICIES),
  };
}

function parseOverride(v: unknown): BudgetOverride {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    jobId: nullableStr(o, 'jobId'),
    expiresAt: str(o, 'expiresAt'),
    reason: str(o, 'reason'),
    createdBy: str(o, 'createdBy'),
    createdAt: str(o, 'createdAt'),
    revokedAt: nullableStr(o, 'revokedAt'),
    active: bool(o, 'active'),
  };
}

function parseEvaluation(v: unknown): BudgetEvaluation {
  const o = obj(v);
  const w = obj(o.window);
  return {
    used: num(o, 'used'),
    limit: num(o, 'limit'),
    ratio: num(o, 'ratio'),
    status: oneOf(o, 'status', ['under', 'warning', 'over', 'unknown']),
    complete: bool(o, 'complete'),
    records: int(o, 'records'),
    unknownRecords: int(o, 'unknownRecords'),
    subscriptionRecords: int(o, 'subscriptionRecords'),
    window: { start: str(w, 'start'), end: str(w, 'end') },
  };
}

function parseBudgetView(v: unknown): BudgetView {
  const o = obj(v);
  return {
    budget: parseBudget(o.budget),
    evaluation: o.evaluation === null ? null : parseEvaluation(o.evaluation),
  };
}

// ------------------------------------------------------------------------------------------ calls

export function getUsageSummary(
  q: { groupBy: GroupBy; from: string; to: string },
  opts: Opts = {},
): Promise<UsageSummary> {
  const params = new URLSearchParams({ groupBy: q.groupBy, from: q.from, to: q.to });
  return apiRequest('GET', `/usage/summary?${params.toString()}`, parseSummary, opts);
}

export function getPriceTable(opts: Opts = {}): Promise<PriceTable> {
  return apiRequest('GET', '/usage/prices', parsePriceTable, opts);
}

export function putPriceTable(
  body: { expectedVersion: number; note: string; entries: readonly PriceEntry[] },
  opts: Opts = {},
): Promise<PriceTable> {
  const note = body.note.trim();
  return apiRequest('PUT', '/usage/prices', parsePriceTable, {
    ...opts,
    body: { expectedVersion: body.expectedVersion, entries: body.entries, ...(note === '' ? {} : { note }) },
  });
}

export function listBudgets(opts: Opts = {}): Promise<BudgetView[]> {
  return apiRequest('GET', '/budgets', (v) => array(obj(v).items, parseBudgetView), opts);
}

export function createBudget(input: BudgetInput, opts: Opts = {}): Promise<BudgetView> {
  return apiRequest('POST', '/budgets', parseBudgetView, { ...opts, body: input });
}

export function updateBudget(
  id: string,
  input: BudgetInput & { expectedVersion: number },
  opts: Opts = {},
): Promise<BudgetView> {
  return apiRequest('PUT', `/budgets/${encodeURIComponent(id)}`, parseBudgetView, { ...opts, body: input });
}

export function listBudgetOverrides(id: string, opts: Opts = {}): Promise<BudgetOverride[]> {
  return apiRequest(
    'GET',
    `/budgets/${encodeURIComponent(id)}/overrides`,
    (v) => array(obj(v).items, parseOverride),
    opts,
  );
}

export function createBudgetOverride(
  id: string,
  input: { reason: string; jobId?: string | null; until?: string },
  opts: Opts = {},
): Promise<BudgetOverride> {
  return apiRequest('POST', `/budgets/${encodeURIComponent(id)}/overrides`, parseOverride, {
    ...opts,
    body: input,
  });
}

export function revokeBudgetOverride(
  id: string,
  overrideId: string,
  opts: Opts = {},
): Promise<BudgetOverride> {
  return apiRequest(
    'DELETE',
    `/budgets/${encodeURIComponent(id)}/overrides/${encodeURIComponent(overrideId)}`,
    parseOverride,
    opts,
  );
}

export function deleteBudget(id: string, expectedVersion: number, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'DELETE',
    `/budgets/${encodeURIComponent(id)}?expectedVersion=${String(expectedVersion)}`,
    () => undefined,
    opts,
  );
}

/** p6-ui-jobs: the cost side of one usage record (GET /usage/records, operator+). */
export interface UsageCostRecord {
  readonly jobId: string;
  readonly costClass: CostClass;
  readonly costUsd: number | null;
}

/** Usage records (newest first, one page), reduced to what the Jobs screens show: cost per job. */
export function listUsageCosts(
  q: {
    readonly job?: string;
    /** p14-web-perf-2: only these jobs' records (≤ 200 ids; the listed page of İşler). */
    readonly jobs?: readonly string[];
    readonly from?: string;
    readonly limit?: number;
  },
  opts: Opts = {},
): Promise<UsageCostRecord[]> {
  const params = new URLSearchParams();
  if (q.from !== undefined) params.set('from', q.from);
  if (q.job !== undefined) params.set('job', q.job);
  if (q.jobs !== undefined && q.jobs.length > 0) params.set('jobs', q.jobs.join(','));
  params.set('limit', String(q.limit ?? 500));
  return apiRequest(
    'GET',
    `/usage/records?${params.toString()}`,
    (v) =>
      array(obj(v).items, (x) => {
        const o = obj(x);
        const c = obj(o.cost);
        return {
          jobId: str(o, 'jobId'),
          costClass: oneOf(c, 'costClass', COST_CLASSES),
          costUsd: nullableNum(c, 'costUsd'),
        };
      }),
    opts,
  );
}
