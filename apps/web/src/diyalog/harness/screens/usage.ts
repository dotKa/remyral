import type { ScreenRoutes } from './types';

/**
 * p12-diyalog Faz 4 harness fixtures for Kullanım (`?path=/usage`, `/usage?tab=enforcement`, `/usage?tab=outcomes`).
 * Return undefined to fall through to the base fixtures.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;
const DAY = 24 * H;

function spend(cost: number, eq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    records: 14,
    inputTokens: Math.round(cost * 90_000 + eq * 60_000),
    outputTokens: Math.round(cost * 12_000 + eq * 9_000),
    cacheReadTokens: 0,
    turns: Math.round(cost * 6 + eq * 5),
    wallTimeMs: Math.round((cost + eq) * 0.4 * H),
    costUsd: cost,
    costComplete: true,
    unknownCostRecords: 0,
    subscriptionRecords: eq > 0 ? 6 : 0,
    apiEquivalentUsd: eq,
    apiEquivalentUnpricedRecords: 0,
    metricsIncomplete: false,
    ...over,
  };
}

// 30 days of spend: a weekday rhythm with a release spike.
const TRENDS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(NOW - (29 - i) * DAY);
  const key = d.toISOString().slice(0, 10);
  const weekday = d.getUTCDay() % 6 === 0 ? 0.35 : 1;
  const api = Math.round((3 + ((i * 7) % 5) + (i === 22 ? 9 : 0)) * weekday * 100) / 100;
  const eq = Math.round((2.5 + ((i * 3) % 4)) * weekday * 100) / 100;
  return { ...spend(api, eq), key, start: `${key}T00:00:00.000Z`, end: `${key}T23:59:59.000Z` };
});

const sum = (k: 'costUsd' | 'apiEquivalentUsd'): number =>
  Math.round(TRENDS.reduce((s, t) => s + Number((t as Record<string, unknown>)[k]), 0) * 100) / 100;

function row(label: string, cost: number, eq: number, jobs: number, ok: number): Record<string, unknown> {
  return {
    key: label,
    label,
    spend: spend(cost, eq),
    jobs,
    succeeded: ok,
    failed: jobs - ok,
    cancelled: 0,
    successRate: ok / jobs,
    costPerSuccessUsd: Math.round((cost / ok) * 100) / 100,
    costPerSuccessComplete: true,
    apiEquivalentPerSuccessUsd: Math.round((eq / ok) * 100) / 100,
  };
}

function top(id: string, project: string, runtime: string, model: string, cost: number, sec: number) {
  return {
    jobId: id,
    project,
    runtime,
    model,
    kind: 'execute',
    automationId: null,
    automationName: null,
    workerId: 'w1',
    state: 'SUCCEEDED',
    finishedAt: iso(2 * H),
    durationSec: sec,
    costUsd: cost,
    costComplete: true,
    apiEquivalentUsd: runtime === 'claude-code' ? cost * 0.8 : 0,
    tokens: Math.round(cost * 100_000),
  };
}

const DASHBOARD = {
  range: { from: iso(30 * DAY), to: iso(0), grain: 'day', timeZone: 'Europe/Istanbul' },
  priceTableVersion: 4,
  totals: spend(sum('costUsd'), sum('apiEquivalentUsd'), {
    costComplete: false,
    unknownCostRecords: 3,
    subscriptionRecords: 212,
    records: 486,
  }),
  trends: TRENDS,
  breakdown: {
    dimension: 'project',
    rows: [
      row('vitrin-web', 61.4, 38.2, 74, 66),
      row('mobil-app', 44.9, 29.75, 58, 47),
      row('odeme-api', 23.1, 12.4, 31, 29),
      row('ops-scripts', 6.35, 4.1, 19, 19),
    ],
  },
  outcomes: {
    finished: 182,
    succeeded: 161,
    failed: 17,
    cancelled: 4,
    successRate: 161 / 182,
    costPerSuccessUsd: 0.84,
    costPerSuccessComplete: false,
    apiEquivalentPerSuccessUsd: 0.52,
  },
  topCostly: [
    top('7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e', 'mobil-app', 'claude-code', 'opus', 6.42, 2840),
    top('3a8d11c2-9f1e-4b7a-8c2d-1e2f3a4b5c6d', 'vitrin-web', 'codex', 'gpt-5-codex', 4.18, 1720),
    top('9b0c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e', 'odeme-api', 'opencode', 'kimi-k2', 2.9, 1310),
  ],
  slowest: [
    top('7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e', 'mobil-app', 'claude-code', 'opus', 6.42, 2840),
    top('5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c', 'mobil-app', 'pi', 'qwen3-coder', 0.31, 2210),
  ],
  successRates: [
    {
      runtime: 'claude-code',
      model: 'opus',
      attempts: 64,
      successRate: 0.92,
      p50DurationSec: 940,
      costPerAttemptUsd: 1.12,
    },
    {
      runtime: 'codex',
      model: 'gpt-5-codex',
      attempts: 71,
      successRate: 0.87,
      p50DurationSec: 610,
      costPerAttemptUsd: 0.64,
    },
    {
      runtime: 'opencode',
      model: 'kimi-k2',
      attempts: 28,
      successRate: 0.79,
      p50DurationSec: 720,
      costPerAttemptUsd: 0.38,
    },
    {
      runtime: 'pi',
      model: '',
      attempts: 19,
      successRate: 0.74,
      p50DurationSec: 1180,
      costPerAttemptUsd: null,
    },
  ],
  savings: {
    reuse: {
      hits: 23,
      automationRuns: 18,
      workflowSteps: 5,
      estimatedSeconds: 14_400,
      estimatedCostUsd: 11.6,
      estimatedApiEquivalentUsd: 4.2,
    },
    warmCaches: { runs: 141 },
    safeAutoApprove: {
      approvals: 318,
      medianHumanWaitSec: 95,
      measured: true,
      estimatedSecondsSaved: 30_210,
    },
  },
  missingPrices: [],
  truncated: false,
};

const history = (to: number): { at: string; usedPercent: number }[] =>
  Array.from({ length: 24 }, (_, i) => ({
    at: iso((23 - i) * H),
    usedPercent: Math.max(0, Math.round(to * (0.15 + 0.85 * (i / 23)) + ((i * 13) % 7) - 3)),
  }));

function win(id: string, kind: string, used: number, resetMin: number, level = 'ok', minutes = 300) {
  return {
    id,
    kind,
    label: null,
    usedPercent: used,
    windowMinutes: minutes,
    resetsAt: new Date(NOW + resetMin * 60_000).toISOString(),
    status: null,
    level,
    history: history(used),
  };
}

function entry(runtime: string, worker: string, windows: unknown[], level = 'ok', plan = 'max') {
  return {
    workerId: `w-${worker}`,
    workerName: worker,
    workerState: 'online',
    runtime,
    auth: 'subscription',
    store: 'default',
    source: 'probe',
    plan,
    available: true,
    observedAt: iso(3 * 60_000),
    stale: false,
    reports: true,
    level,
    limit: null,
    windows,
  };
}

const OVERVIEW = {
  generatedAt: iso(0),
  settings: { nearThreshold: 80, notifyNear: true },
  entries: [
    entry('claude-code', 'kestrel-mac', [
      win('five_hour', 'session', 72, 56),
      win('seven_day', 'weekly', 41, 3 * 24 * 60, 'ok', 10080),
    ]),
    entry(
      'codex',
      'atlas-win-01',
      [win('primary', 'session', 88, 161, 'near'), win('secondary', 'weekly', 35, 4 * 24 * 60, 'ok', 10080)],
      'near',
      'pro',
    ),
  ],
  otherLimits: [
    {
      id: 'ol1',
      runtime: 'opencode',
      pauseScope: 'credential',
      workerName: null,
      credential: 'moonshot-main',
      accountId: null,
      model: 'kimi-k2',
      kind: 'rate',
      resetAt: new Date(NOW + 42 * 60_000).toISOString(),
      resumeAt: new Date(NOW + 42 * 60_000).toISOString(),
    },
  ],
};

const QUOTAS = {
  policy: { version: 7, policy: { projects: { 'mobil-app': { maxConcurrent: 3 } } } },
  projects: [
    { project: 'mobil-app', active: 2, maxConcurrent: 3, weight: 1 },
    { project: 'vitrin-web', active: 1, maxConcurrent: null, weight: 1 },
  ],
  runtimes: [{ runtime: 'codex', active: 1, maxConcurrent: 4 }],
  accounts: [],
  pauses: [
    {
      id: 'qp1',
      scope: 'worker_runtime',
      workerId: 'atlas-win-01',
      runtime: 'codex',
      accountId: null,
      workers: ['atlas-win-01'],
      pausedAt: iso(20 * 60_000),
      resumeAt: new Date(NOW + 95 * 60_000).toISOString(),
    },
  ],
  holds: [{ project: 'deneme-lab', reason: 'Döngüye giren otomasyon', heldBy: 'alex', heldAt: iso(2 * H) }],
  budgets: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'mobil-app aylık API',
      scope: { type: 'project', value: 'mobil-app' },
      metric: 'cost_usd',
      status: 'warning',
      ratio: 0.82,
      complete: true,
      enforcement: 'warning',
    },
  ],
  events: [
    {
      id: 'qe1',
      kind: 'held',
      project: 'mobil-app',
      jobId: '55555555-5555-4555-8555-555555555555',
      workerId: null,
      code: 'project_concurrency',
      message: 'mobil-app reached its concurrency limit (3); the job waits.',
      createdAt: iso(12 * 60_000),
    },
  ],
};

const JOB_STATS = [
  ['claude-code', 'claude-sonnet', 'execute', 42, 0.88, 540, 1500, 0.42],
  ['codex', 'gpt-5-codex', 'execute', 31, 0.74, 420, 1320, 0.31],
  ['codex', 'gpt-5-codex', 'review', 12, 0.92, 180, 400, 0.08],
  ['opencode', 'kimi-k2', 'execute', 9, 0.56, 610, 1900, null],
].map(([runtime, model, kind, attempts, rate, p50, p90, cost]) => ({
  runtime,
  model,
  kind,
  project: null,
  workerId: null,
  attempts,
  succeeded: Math.round(Number(attempts) * Number(rate)),
  failed: Number(attempts) - Math.round(Number(attempts) * Number(rate)),
  successRate: rate,
  p50DurationSec: p50,
  p90DurationSec: p90,
  meanDurationSec: p50,
  costUsd: cost === null ? 0 : Number(cost) * Number(attempts),
  costPerAttemptUsd: cost,
}));

const SUGGESTIONS = [
  {
    id: 'sg1',
    rule: 'failing_automation',
    severity: 'warning',
    title: '“Gece testleri” otomasyonu 5 kez üst üste başarısız oldu',
    detail:
      'Son 5 çalışmanın hepsi aynı hatayla bitti (tests_failed). Düzeltilene kadar duraklatmak harcamayı keser.',
    evidence: {},
    action: { kind: 'pause_automation', automationId: 'a-1' },
    actionRole: 'operator',
    actionStepUp: false,
    project: 'mobil-app',
  },
  {
    id: 'sg2',
    rule: 'routing',
    severity: 'info',
    title: 'İnceleme işleri daha ucuz bir profille aynı başarıyı veriyor',
    detail: 'Codex review işleri %92 başarılı; aynı başarı deneme başına $0.31 yerine $0.08.',
    evidence: {},
    action: { kind: 'routing_rule', role: 'review', modelProfile: 'codex-fast', runtimes: ['codex'] },
    actionRole: 'admin',
    actionStepUp: true,
    project: null,
  },
  {
    id: 'sg3',
    rule: 'missing_prices',
    severity: 'info',
    title: 'Bir model için fiyat eksik',
    detail: 'Bu modelin maliyeti “bilinmiyor” görünüyor. Fiyat tablosuna ekle.',
    evidence: {},
    action: { kind: 'open', path: '/usage?tab=prices' },
    actionRole: null,
    actionStepUp: false,
    project: null,
  },
];

function group(key: string | null, cost: number, unknown = 0): Record<string, unknown> {
  return {
    key,
    records: 20 + unknown,
    inputTokens: Math.round(cost * 90_000),
    outputTokens: Math.round(cost * 12_000),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokensUnknownRecords: 0,
    turns: Math.round(cost * 6),
    turnsUnknownRecords: 0,
    wallTimeMs: Math.round(cost * 0.4 * H),
    wallTimeUnknownRecords: 0,
    costUsd: { reported: cost * 0.7, estimated: cost * 0.3, total: cost },
    apiEquivalent: { usd: 0, unpricedRecords: 0 },
    coverage: { reported: 14, estimated: 6, unknown, subscription: 3 },
    unknownReasons: unknown > 0 ? { price_missing: unknown } : {},
    missingPrices:
      unknown > 0
        ? [{ provider: 'moonshot', model: 'kimi-k2', reason: 'price_missing', records: unknown }]
        : [],
    flags: {
      costComplete: unknown === 0,
      hasSubscription: true,
      noPerRunCost: false,
      metricsIncomplete: false,
    },
  };
}

function summary(groupBy: string): Record<string, unknown> {
  const keys: readonly (readonly [string, number, number])[] =
    groupBy === 'runtime'
      ? [
          ['claude-code', 31.2, 0],
          ['codex', 18.4, 0],
          ['opencode', 4.1, 3],
        ]
      : [
          ['mobil-app', 26.5, 0],
          ['vitrin-web', 14.9, 0],
          ['odeme-api', 8.2, 3],
          ['deneme-lab', 4.1, 0],
        ];
  return {
    groupBy,
    from: iso(30 * DAY),
    to: iso(0),
    priceTableVersion: 4,
    groups: keys.map(([k, c, u]) => group(k, c, u)),
    totals: group(null, 53.7, 3),
  };
}

const PRICES = {
  version: 4,
  note: 'Ekim faturasından',
  createdAt: iso(5 * DAY),
  entries: (
    [
      ['anthropic', 'claude-sonnet', 3, 15, 0.3, 3.75],
      ['anthropic', 'claude-opus', 15, 75, 1.5, 18.75],
      ['openai', 'gpt-5-codex', 1.25, 10, 0.125, null],
    ] as const
  ).map(([provider, model, i, o, cr, cw]) => ({
    provider,
    model,
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    inputUsdPerMTok: i,
    outputUsdPerMTok: o,
    cacheReadUsdPerMTok: cr,
    cacheWriteUsdPerMTok: cw,
    source: 'sağlayıcı fiyat sayfası, 2026-10-01',
  })),
};

function budget(
  id: string,
  name: string,
  metric: string,
  limit: number,
  used: number,
  status: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    budget: {
      id,
      name,
      metric,
      limit,
      scope: { type: 'project', value: 'mobil-app' },
      window: 'month',
      enabled: true,
      version: 2,
      billing: metric === 'cost_usd' ? 'api' : 'subscription',
      timeZone: 'Europe/Istanbul',
      thresholds: [50, 80, 100],
      onExceeded: 'pause_new',
      ...over,
    },
    evaluation: {
      used,
      limit,
      ratio: used / limit,
      status,
      complete: true,
      records: 40,
      unknownRecords: 0,
      subscriptionRecords: 0,
      window: { start: iso(19 * DAY), end: new Date(NOW + 12 * DAY).toISOString() },
    },
  };
}

const BUDGETS = [
  budget('44444444-4444-4444-8444-444444444444', 'mobil-app aylık API', 'cost_usd', 60, 49.2, 'warning'),
  budget('b-2', 'deneme-lab token', 'tokens', 2_000_000, 2_240_000, 'over', {
    scope: { type: 'project', value: 'deneme-lab' },
  }),
  budget('b-3', 'Claude abonelik saatleri', 'wall_time_ms', 120 * H, 41 * H, 'under', {
    scope: { type: 'runtime', value: 'claude-code' },
    onExceeded: 'warn',
  }),
];

const CHAT_USAGE = {
  limits: {
    turnsPerUserPer10Min: 20,
    userDailyTokens: 400_000,
    dailyTokens: 2_000_000,
    monthlyCostUsd: 40,
    maxToolCallsPerTurn: 8,
  },
  me: {
    today: { turns: 14, inputTokens: 61_000, outputTokens: 8_200, costUsd: 0.41, unknownTurns: 0 },
    month: { turns: 212, inputTokens: 920_000, outputTokens: 131_000, costUsd: 6.12, unknownTurns: 0 },
  },
  all: {
    today: { turns: 30, inputTokens: 140_000, outputTokens: 19_000, costUsd: 0.95, unknownTurns: 0 },
    month: { turns: 512, inputTokens: 2_100_000, outputTokens: 310_000, costUsd: 14.8, unknownTurns: 0 },
  },
};

const REPORT = {
  version: 1,
  period: { start: iso(8 * DAY), end: iso(DAY), timeZone: 'Europe/Istanbul', label: '12–18 Ekim 2026' },
  ran: {
    finished: 37,
    succeeded: 31,
    failed: 4,
    cancelled: 2,
    byProject: [
      { project: 'mobil-app', succeeded: 14, failed: 2, cancelled: 1 },
      { project: 'vitrin-web', succeeded: 11, failed: 1, cancelled: 0 },
      { project: 'odeme-api', succeeded: 6, failed: 1, cancelled: 1 },
    ],
  },
  deployed: {
    total: 2,
    succeeded: 1,
    failed: 1,
    items: [
      {
        id: 'd-1',
        project: 'vitrin-web',
        kind: 'pages.publish',
        env: 'production',
        state: 'succeeded',
        at: iso(2 * DAY),
      },
      {
        id: 'd-2',
        project: 'odeme-api',
        kind: 'coolify.deploy',
        env: 'staging',
        state: 'failed',
        at: iso(3 * DAY),
      },
    ],
  },
  failures: [
    {
      jobId: '55555555-5555-4555-8555-555555555555',
      project: 'mobil-app',
      runtime: 'codex',
      errorCode: 'tests_failed',
      at: iso(2 * DAY),
    },
  ],
  spend: { ...spend(48.2, 12.4), previousWeekCostUsd: 41.7, previousWeekApiEquivalentUsd: 10.1 },
  budgets: [
    {
      id: 'b-1',
      name: 'mobil-app aylık API',
      scope: 'project mobil-app',
      used: '$49.20',
      limit: '$60.00',
      ratio: 0.82,
      status: 'warning',
      policy: 'pause_new',
      windowEnd: '2026-10-31',
    },
  ],
  topCostly: [],
  slowest: [],
  savings: {
    reuse: {
      hits: 6,
      automationRuns: 4,
      workflowSteps: 2,
      estimatedSeconds: 3600,
      estimatedCostUsd: 3.1,
      estimatedApiEquivalentUsd: 0,
    },
    warmCaches: { runs: 18 },
    safeAutoApprove: { approvals: 44, medianHumanWaitSec: 95, measured: true, estimatedSecondsSaved: 4180 },
  },
  suggestions: [],
};

const W2_ROUTES: ScreenRoutes = {
  '/usage/suggestions': () => ({ items: SUGGESTIONS }),
  '/usage/summary': (u) => summary(u.searchParams.get('groupBy') ?? 'project'),
  '/usage/prices': (_u, method) => (method === 'GET' ? PRICES : undefined),
  '/budgets': (_u, method) => (method === 'GET' ? { items: BUDGETS } : undefined),
  '/budgets/b-2/overrides': () => ({ items: [] }),
  '/chat/usage': () => CHAT_USAGE,
  '/reports/settings': (_u, method) =>
    method === 'GET'
      ? { timeZone: 'Europe/Istanbul', weeklyEnabled: true, chatThreadId: null, isDefault: false }
      : undefined,
  '/reports': () => ({
    items: [
      {
        id: 'r-41',
        periodStart: iso(8 * DAY),
        periodEnd: iso(DAY),
        timeZone: 'Europe/Istanbul',
        generatedAt: iso(DAY),
        summary: '37 iş bitti (31 başarılı); API harcaması $48.20',
      },
    ],
  }),
  '/reports/r-41': () => ({
    id: 'r-41',
    periodStart: iso(8 * DAY),
    periodEnd: iso(DAY),
    timeZone: 'Europe/Istanbul',
    generatedAt: iso(DAY),
    content: REPORT,
  }),
  '/reports/weekly/preview': () => ({ content: REPORT }),
};

export const ROUTES: ScreenRoutes = {
  '/usage/dashboard': () => DASHBOARD,
  '/usage-limits/overview': (u) => (u.searchParams.get('history') === '1' ? OVERVIEW : undefined),
  '/quotas/status': () => QUOTAS,
  '/usage-limits/status': () => ({ limits: [] }),
  '/usage-limits/defaults': () => ({
    policy: { mode: 'auto', maxWaitHours: 6, fallbacks: [{ runtime: 'codex' }], allowPaidFallback: false },
  }),
  '/usage/job-stats': () => ({ items: JOB_STATS }),
  ...W2_ROUTES,
};
