// p12-diyalog Faz 4: Kullanım (/usage) in the Diyalog language — dashboard tiles, spend chart with its table,
// breakdown, costly jobs with "thread'de aç", limit windows (meters + 24 h sparklines), the runtime × area matrix,
// and (p12-diyalog-w2) every other tab drawn natively: suggestions, reports + /usage/reports/:id, cost breakdown,
// outcomes, prices, budgets + chat usage, enforcement (step-up writes, kill switch confirm, viewer read-only);
// flag off = classic page.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

const JOB = '55555555-5555-4555-8555-555555555555';
const HOSTILE = '<img src=x onerror=alert(1)>';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function spend(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    records: 5,
    inputTokens: 2000,
    outputTokens: 500,
    cacheReadTokens: 0,
    turns: 4,
    wallTimeMs: 7_200_000,
    costUsd: 12.5,
    costComplete: false,
    unknownCostRecords: 1,
    subscriptionRecords: 2,
    apiEquivalentUsd: 3.25,
    apiEquivalentUnpricedRecords: 0,
    metricsIncomplete: false,
    ...over,
  };
}

const point = (key: string, cost: number, eq: number): Record<string, unknown> => ({
  ...spend({ costUsd: cost, apiEquivalentUsd: eq, costComplete: true }),
  key,
  start: `${key}T00:00:00.000Z`,
  end: `${key}T23:59:59.000Z`,
});

const DASHBOARD = {
  range: { from: '2026-09-20T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z', grain: 'day', timeZone: 'UTC' },
  priceTableVersion: 1,
  totals: spend(),
  trends: [point('2026-10-17', 4, 1), point('2026-10-18', 6.5, 0), point('2026-10-19', 2, 2.25)],
  breakdown: {
    dimension: 'project',
    rows: [
      {
        key: HOSTILE,
        label: HOSTILE,
        spend: spend(),
        jobs: 3,
        succeeded: 2,
        failed: 1,
        cancelled: 0,
        successRate: 2 / 3,
        costPerSuccessUsd: 6.25,
        costPerSuccessComplete: true,
        apiEquivalentPerSuccessUsd: 1,
      },
    ],
  },
  outcomes: {
    finished: 3,
    succeeded: 2,
    failed: 1,
    cancelled: 0,
    successRate: 2 / 3,
    costPerSuccessUsd: 6.25,
    costPerSuccessComplete: true,
    apiEquivalentPerSuccessUsd: 1,
  },
  topCostly: [
    {
      jobId: JOB,
      project: 'acme',
      runtime: 'codex',
      model: 'gpt-x',
      kind: 'execute',
      automationId: null,
      automationName: null,
      workerId: 'w1',
      state: 'SUCCEEDED',
      finishedAt: null,
      durationSec: 600,
      costUsd: 9,
      costComplete: true,
      apiEquivalentUsd: 0,
      tokens: 100,
    },
  ],
  slowest: [],
  successRates: [],
  savings: {
    reuse: {
      hits: 4,
      automationRuns: 3,
      workflowSteps: 1,
      estimatedSeconds: 1200,
      estimatedCostUsd: 2,
      estimatedApiEquivalentUsd: 0,
    },
    warmCaches: { runs: 7 },
    safeAutoApprove: { approvals: 10, medianHumanWaitSec: 120, measured: false, estimatedSecondsSaved: 1200 },
  },
  missingPrices: [],
  truncated: false,
};

const OVERVIEW = {
  generatedAt: iso(0),
  settings: { nearThreshold: 80, notifyNear: true },
  entries: [
    {
      workerId: 'w1',
      workerName: 'kestrel-mac',
      workerState: 'online',
      runtime: 'claude-code',
      auth: 'subscription',
      store: 'default',
      source: 'probe',
      plan: 'max',
      available: true,
      observedAt: iso(60_000),
      stale: false,
      reports: true,
      level: 'near',
      limit: null,
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          label: null,
          usedPercent: 86,
          windowMinutes: 300,
          resetsAt: new Date(NOW + 3_600_000).toISOString(),
          status: null,
          level: 'near',
          history: [
            { at: iso(20 * 3_600_000), usedPercent: 10 },
            { at: iso(10 * 3_600_000), usedPercent: 40 },
            { at: iso(60_000), usedPercent: 86 },
          ],
        },
      ],
    },
  ],
  otherLimits: [],
};

const MATRIX = {
  project: 'acme',
  settings: {
    mode: 'advice',
    explorationPct: 10,
    minSamples: 5,
    allowedRuntimes: [],
    allowPaid: false,
    halfLifeDays: 30,
    rerunWindowDays: 3,
    areaRules: [],
  },
  runtimes: ['claude-code', 'codex'],
  areas: ['frontend', 'backend'],
  cells: [
    {
      area: 'frontend',
      runtime: 'claude-code',
      n: 12,
      rate: 0.82,
      low: 0.7,
      high: 0.9,
      rawRate: 0.83,
      medianDurationSec: 600,
      meanCostUsd: 1.5,
      recent: { n: 6, rate: 0.9 },
      previous: { n: 6, rate: 0.8 },
      models: [],
    },
    {
      area: 'frontend',
      runtime: 'codex',
      n: 8,
      rate: 0.6,
      low: 0.45,
      high: 0.75,
      rawRate: 0.62,
      medianDurationSec: 420,
      meanCostUsd: null,
      recent: { n: 4, rate: null },
      previous: { n: 4, rate: null },
      models: [],
    },
  ],
  advice: [{ area: 'frontend', recommended: 'claude-code', text: 'Claude Code does frontend best here.' }],
  jobs: 20,
};

const STEP_UP_REQUIRED = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

function quotaStatus(): unknown {
  return {
    policy: { version: 3, policy: {} },
    projects: [],
    runtimes: [],
    accounts: [],
    pauses: [],
    holds: [],
    budgets: [],
    events: [],
  };
}

function busyQuota(): unknown {
  return {
    policy: { version: 3, policy: { maxConcurrentPerProject: 4 } },
    projects: [{ project: 'acme', active: 2, maxConcurrent: 4, weight: 1 }],
    runtimes: [{ runtime: 'codex', active: 1, maxConcurrent: null }],
    accounts: [],
    pauses: [
      {
        id: 'p1',
        scope: 'worker_runtime',
        workerId: 'w1',
        runtime: 'codex',
        accountId: null,
        workers: ['w1'],
        pausedAt: iso(600_000),
        resumeAt: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    holds: [{ project: 'acme', reason: 'runaway costs', heldBy: 'alex', heldAt: iso(60_000) }],
    budgets: [
      {
        id: 'b1',
        name: 'Aylık API',
        scope: { type: 'project', value: 'acme' },
        metric: 'cost_usd',
        status: 'over',
        ratio: 1.2,
        complete: true,
        enforcement: 'pause_new',
      },
    ],
    events: [
      {
        id: 'e1',
        kind: 'held',
        project: 'acme',
        jobId: JOB,
        workerId: null,
        code: 'budget_exhausted',
        message: 'Budget held a job',
        createdAt: iso(30_000),
      },
    ],
  };
}

const SUGGESTIONS = [
  {
    id: 's1',
    rule: 'failing_automation',
    severity: 'warning',
    title: 'Nightly keeps failing',
    detail: '5 failures in a row.',
    evidence: {},
    action: { kind: 'pause_automation', automationId: 'a1' },
    actionRole: 'operator',
    actionStepUp: false,
    project: 'acme',
  },
  {
    id: 's2',
    rule: 'idle_slots',
    severity: 'info',
    title: 'kestrel-mac idles',
    detail: 'Run more at once.',
    evidence: {},
    action: { kind: 'set_parallelism', workerId: 'w1', value: 3 },
    actionRole: 'admin',
    actionStepUp: true,
    project: null,
  },
];

function group(key: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    records: 4,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokensUnknownRecords: 0,
    turns: 6,
    turnsUnknownRecords: 0,
    wallTimeMs: 600_000,
    wallTimeUnknownRecords: 0,
    costUsd: { reported: 2, estimated: 1, total: 3 },
    apiEquivalent: { usd: 0, unpricedRecords: 0 },
    coverage: { reported: 2, estimated: 1, unknown: 1, subscription: 0 },
    unknownReasons: { price_missing: 1 },
    missingPrices: [{ provider: 'openai', model: 'gpt-x', reason: 'price_missing', records: 1 }],
    flags: { costComplete: false, hasSubscription: false, noPerRunCost: false, metricsIncomplete: false },
    ...over,
  };
}

const SUMMARY = {
  groupBy: 'project',
  from: iso(30 * 86_400_000),
  to: iso(0),
  priceTableVersion: 2,
  groups: [group('acme')],
  totals: group(null),
};

const PRICES = {
  version: 2,
  note: 'from the invoice',
  createdAt: iso(86_400_000),
  entries: [
    {
      provider: 'anthropic',
      model: 'claude-x',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadUsdPerMTok: null,
      cacheWriteUsdPerMTok: null,
      source: 'price page',
    },
  ],
};

function budgetView(over: Record<string, unknown>): unknown {
  return {
    budget: {
      id: 'b1',
      name: 'Aylık API',
      metric: 'cost_usd',
      limit: 100,
      scope: { type: 'project', value: 'acme' },
      window: 'month',
      enabled: true,
      version: 4,
      billing: 'api',
      timeZone: 'UTC',
      thresholds: [50, 80, 100],
      onExceeded: 'pause_new',
      ...over,
    },
    evaluation: {
      used: 120,
      limit: 100,
      ratio: 1.2,
      status: 'over',
      complete: true,
      records: 10,
      unknownRecords: 0,
      subscriptionRecords: 0,
      window: { start: iso(10 * 86_400_000), end: new Date(NOW + 5 * 86_400_000).toISOString() },
    },
  };
}

const REPORT_CONTENT = {
  version: 1,
  period: { start: iso(7 * 86_400_000), end: iso(0), timeZone: 'Europe/Istanbul', label: '12–18 Ekim' },
  ran: {
    finished: 10,
    succeeded: 8,
    failed: 1,
    cancelled: 1,
    byProject: [{ project: 'acme', succeeded: 8, failed: 1, cancelled: 1 }],
  },
  deployed: { total: 0, succeeded: 0, failed: 0, items: [] },
  failures: [
    { jobId: JOB, project: 'acme', runtime: 'codex', errorCode: 'tests_failed', at: iso(86_400_000) },
  ],
  spend: { ...spend(), previousWeekCostUsd: 9, previousWeekApiEquivalentUsd: 0 },
  budgets: [],
  topCostly: [],
  slowest: [],
  savings: DASHBOARD.savings,
  suggestions: [],
};

const CHAT_USAGE = {
  limits: {
    turnsPerUserPer10Min: 20,
    userDailyTokens: 100_000,
    dailyTokens: null,
    monthlyCostUsd: 50,
    maxToolCallsPerTurn: 8,
  },
  me: {
    today: { turns: 3, inputTokens: 100, outputTokens: 50, costUsd: 0.1, unknownTurns: 0 },
    month: { turns: 30, inputTokens: 1000, outputTokens: 500, costUsd: 1, unknownTurns: 0 },
  },
  all: null,
};

const JOB_STATS = [
  {
    runtime: 'codex',
    model: 'gpt-x',
    kind: 'execute',
    project: null,
    workerId: null,
    attempts: 8,
    succeeded: 6,
    failed: 2,
    successRate: 0.75,
    p50DurationSec: 300,
    p90DurationSec: 900,
    meanDurationSec: 400,
    costUsd: 4,
    costPerAttemptUsd: 0.5,
  },
];

function routes(role: string, extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), user: { ...USER, role } },
    }),
    'GET /api/usage-limits/overview?history=1': () => ({ status: 200, body: OVERVIEW }),
    'GET /api/usage-limits/overview': () => ({ status: 200, body: OVERVIEW }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'Acme',
            kind: 'repository',
            createdAt: '2026-01-01T00:00:00.000Z',
            createdBy: null,
            members: 1,
            myRole: 'owner',
          },
        ],
      },
    }),
    'GET /api/usage/runtime-outcomes?project=acme': () => ({ status: 200, body: MATRIX }),
    'GET /api/quotas/status': () => ({ status: 200, body: quotaStatus() }),
    'GET /api/usage-limits/status': () => ({ status: 200, body: { limits: [] } }),
    'GET /api/usage-limits/defaults': () => ({
      status: 200,
      body: { policy: { mode: 'auto', maxWaitHours: 6, fallbacks: [], allowPaidFallback: false } },
    }),
    'GET /api/usage/suggestions': () => ({ status: 200, body: { items: [] } }),
    'GET /api/usage/prices': () => ({ status: 200, body: PRICES }),
    'GET /api/budgets': () => ({ status: 200, body: { items: [budgetView({})] } }),
    'GET /api/budgets/b1/overrides': () => ({ status: 200, body: { items: [] } }),
    'GET /api/chat/usage': () => ({ status: 200, body: CHAT_USAGE }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [] } }),
    'GET /api/reports/settings': () => ({
      status: 200,
      body: { timeZone: 'Europe/Istanbul', weeklyEnabled: false, chatThreadId: null, isDefault: true },
    }),
    'GET /api/reports': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'r1',
            periodStart: iso(7 * 86_400_000),
            periodEnd: iso(0),
            timeZone: 'Europe/Istanbul',
            generatedAt: iso(0),
            summary: '10 jobs, $12.50',
          },
        ],
      },
    }),
    'GET /api/reports/r1': () => ({
      status: 200,
      body: {
        id: 'r1',
        periodStart: iso(7 * 86_400_000),
        periodEnd: iso(0),
        timeZone: 'Europe/Istanbul',
        generatedAt: iso(0),
        content: REPORT_CONTENT,
      },
    }),
    ...extra,
  };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key.startsWith('GET /api/usage/dashboard?')) return () => ({ status: 200, body: DASHBOARD });
      if (key.startsWith('GET /api/usage/job-stats?'))
        return () => ({ status: 200, body: { items: JOB_STATS } });
      if (key.startsWith('GET /api/usage/summary?')) return () => ({ status: 200, body: SUMMARY });
      return undefined;
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
});

describe('Kullanım in the Diyalog shell (p12-diyalog Faz 4)', () => {
  it('dashboard: tiles, spend chart with summary and table, breakdown as text, costly job opens its thread', async () => {
    const { container } = renderApp({ path: '/usage', routes: routes('owner') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Kullanım' })).toBeTruthy();
    expect(screen.getByTestId('dy-usage').closest('[data-ui="diyalog"]')).toBeTruthy();
    expect((await screen.findByTestId('dash-spend')).textContent).toBe('≥ $12,50');
    expect(screen.getByTestId('dash-subscription').textContent).toBe('2 kayıt');

    const chart = screen.getByTestId('dy-spend-chart');
    expect(within(chart).getByText(/3 dönem: API harcaması toplam \$12,50/)).toBeTruthy();
    expect(within(chart).getByText('Abonelik, API karşılığı (tahmin)')).toBeTruthy();
    expect(chart.querySelectorAll('li[title]')).toHaveLength(3);
    expect(chart.querySelector('li[title^="2026-10-18"]')?.getAttribute('title')).toBe(
      '2026-10-18: API $6,50',
    );
    const table = within(chart).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);

    const breakdown = screen.getByTestId('dash-breakdown');
    expect(breakdown.textContent).toContain(HOSTILE);
    expect(container.querySelector('img:not([data-brand])')).toBeNull();
    expect(within(breakdown).getByText('%67')).toBeTruthy();

    const costly = screen.getByTestId('dash-top-costly');
    const link = within(costly).getByRole('link', { name: "İş 55555555: thread'de aç" });
    expect(link.getAttribute('href')).toBe(`/jobs/${JOB}`);
  });

  it('limit windows: a meter per window with the near mark and a 24 h sparkline in words', async () => {
    renderApp({ path: '/usage', routes: routes('owner') });
    const panel = await screen.findByTestId('dy-limit-windows');
    const meter = await within(panel).findByRole('meter', { name: 'Claude Code 5 saatlik' });
    expect(meter.getAttribute('aria-valuenow')).toBe('86');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^%86 sınıra yakın, .+ sıfırlanır$/);
    expect(within(panel).getByTestId('dy-limit-window').getAttribute('data-level')).toBe('near');
    expect(
      within(panel).getByRole('img', { name: '5 saatlik, son 24 saat: %10 ile %86 arası' }),
    ).toBeTruthy();
    expect(within(panel).getByText(/eşiği \(%80\)/)).toBeTruthy();
  });

  it('outcomes tab: the runtime × area matrix with the recommended runtime named', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/usage', routes: routes('owner') });
    await user.click(await screen.findByRole('tab', { name: 'Sonuçlar' }));
    const matrix = await screen.findByTestId('runtime-area-matrix');
    const cell = within(matrix).getByTestId('matrix-cell-frontend-claude-code');
    expect(cell.textContent).toContain('82%');
    expect(cell.textContent).toContain('önerilen');
    expect(cell.textContent).toContain('▲ 10 puan');
    expect(within(matrix).getByTestId('matrix-cell-frontend-codex').textContent).not.toContain('önerilen');
    expect(screen.getByTestId('runtime-area-advice').textContent).toContain(
      'Claude Code does frontend best here.',
    );
  });

  // p15-classic-removal: the classic runtime-limits.test "admins change the near-limit notice with a step-up".
  it('enforcement tab: an admin changes the near-limit notice through step-up (PUT /usage-limits/near-settings)', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let stepped = false;
    const { requests } = renderApp({
      path: '/usage?tab=enforcement',
      routes: routes('owner', {
        'PUT /api/usage-limits/near-settings': (r) =>
          stepped ? { status: 200, body: r.body } : STEP_UP_REQUIRED,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const form = await screen.findByRole('form', { name: 'Sınıra yakın bildirimi' });
    const threshold = within(form).getByLabelText('Yakın sayılan (%)');
    await user.clear(threshold);
    await user.type(threshold, '90');
    await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT' && r.url === '/api/usage-limits/near-settings');
      expect(puts).toHaveLength(2);
      expect(puts.at(-1)?.body).toMatchObject({ nearThreshold: 90 });
    });
    // p17-toasts-rest: the save result is a toast, not a line in the form.
    expect(await findToast('Kaydedildi.')).toBeTruthy();
    expect(within(form).queryByText('Kaydedildi.')).toBeNull();
  });

  it('enforcement tab (deep link): the usage-limit default is a Diyalog form saved through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let stepped = false;
    const { requests } = renderApp({
      path: '/usage?tab=enforcement',
      routes: routes('owner', {
        'PUT /api/usage-limits/defaults': (r) =>
          stepped ? { status: 200, body: { policy: r.body as object } } : STEP_UP_REQUIRED,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    expect(
      (await screen.findByRole('tab', { name: 'Limitler ve kotalar' })).getAttribute('aria-selected'),
    ).toBe('true');
    const form = await screen.findByTestId('usage-limit-default-form');
    expect(await screen.findByTestId('near-settings')).toBeTruthy();
    expect(screen.getByTestId('usage-limit-default').textContent).toContain('Çalışma alanı varsayılanı');
    // A bad wait is caught before any request, in Turkish.
    const wait = within(form).getByLabelText('Bu kadar saat içinde sıfırlanıyorsa bekle');
    await user.clear(wait);
    await user.type(wait, '500');
    await user.click(within(form).getByRole('button', { name: 'Varsayılanı kaydet' }));
    expect(await within(form).findByText('Bekleme 0,25 ile 168 saat arasında olmalı.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await user.clear(wait);
    await user.type(wait, '6');
    await user.selectOptions(within(form).getByLabelText('Bir iş kullanım limitine takılınca'), 'wait');
    await user.click(within(form).getByRole('button', { name: 'Varsayılanı kaydet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(await findToast('Çalışma alanı varsayılanı kaydedildi.')).toBeTruthy();
    const puts = requests.filter((r) => r.method === 'PUT' && r.url === '/api/usage-limits/defaults');
    expect(puts.at(-1)?.body).toMatchObject({ policy: { mode: 'wait' } });
    expect(puts.at(-1)?.headers['x-csrf-token']).toBe('csrf-token-1');
    // No classic panel is rendered.
    expect(screen.queryByText('Default when a job hits a usage limit')).toBeNull();
  });

  it('p19-limit-clear: an admin clears a limit the provider reset early; viewers see no button', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    const episode = {
      id: '11111111-1111-4111-8111-111111111111',
      scope: 'subscription',
      pauseScope: 'worker_runtime',
      workerId: 'w1',
      workerName: 'windows-worker-1',
      runtime: 'codex',
      accountId: null,
      runtimeAccount: null,
      credential: null,
      store: 'codex',
      model: null,
      kind: 'session',
      resetAt: '2030-01-01T06:20:00.000Z',
      resumeAt: '2030-01-01T06:20:00.000Z',
      since: '2030-01-01T01:20:00.000Z',
      lastHitAt: '2030-01-01T01:20:00.000Z',
      hits: 1,
      project: 'acme',
      message: null,
    };
    let open = true;
    const { requests } = renderApp({
      path: '/usage?tab=enforcement',
      routes: routes('owner', {
        'GET /api/usage-limits/status': () => ({ status: 200, body: { limits: open ? [episode] : [] } }),
        [`POST /api/usage-limits/${episode.id}/clear`]: () => {
          open = false;
          return { status: 200, body: { cleared: true } };
        },
      }),
    });
    const row = await screen.findByTestId('usage-limit-row');
    await user.click(within(row).getByRole('button', { name: 'Limiti kaldır' }));
    expect(await findToast('Limit kaldırıldı; bekleyen işler devam ediyor.')).toBeTruthy();
    expect(await screen.findByTestId('usage-limits-none')).toBeTruthy();
    const post = requests.find(
      (r) => r.method === 'POST' && r.url === `/api/usage-limits/${episode.id}/clear`,
    );
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-1');
  });

  it('p19-limit-clear: a viewer sees the limit without the clear button', async () => {
    renderApp({
      path: '/usage?tab=enforcement',
      routes: routes('viewer', {
        'GET /api/usage-limits/status': () => ({
          status: 200,
          body: {
            limits: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                scope: 'subscription',
                pauseScope: 'worker_runtime',
                workerId: 'w1',
                workerName: 'mac-1',
                runtime: 'codex',
                accountId: null,
                credential: null,
                store: 'codex',
                model: null,
                kind: 'session',
                resetAt: null,
                resumeAt: '2030-01-01T06:20:00.000Z',
                since: '2030-01-01T01:20:00.000Z',
                hits: 1,
              },
            ],
          },
        }),
      }),
    });
    expect(await screen.findByTestId('usage-limit-row')).toBeTruthy();
    expect(screen.queryByTestId('usage-limit-clear')).toBeNull();
  });

  it('enforcement: resume a pause, release a hold, kill switch with a second confirmation and step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let stepped = false;
    const guard =
      (ok: () => { status: number; body?: unknown }): Handler =>
      () =>
        stepped ? ok() : STEP_UP_REQUIRED;
    const { requests } = renderApp({
      path: '/usage?tab=enforcement&section=holds',
      routes: routes('admin', {
        'GET /api/quotas/status': () => ({ status: 200, body: busyQuota() }),
        'POST /api/quotas/pauses/p1/resume': guard(() => ({ status: 200, body: {} })),
        'DELETE /api/projects/acme/kill': guard(() => ({ status: 200, body: {} })),
        'POST /api/projects/acme/kill': guard(() => ({
          status: 200,
          body: { cancelled: 2, cancelling: 1, skipped: 0, hold: true },
        })),
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const pauses = await screen.findByTestId('quota-pauses');
    expect(pauses.textContent).toContain('Codex');
    expect(screen.getByTestId('quota-holds').textContent).toContain('runaway costs');
    // p17-settings-tabs: the count on Duraklatma ve durdurma is what is held now (pauses + holds).
    expect(screen.getByRole('tab', { name: /Duraklatma ve durdurma/ }).textContent).toMatch(/\d$/);
    await user.click(screen.getByRole('tab', { name: 'Son kararlar' }));
    expect((await screen.findByTestId('quota-events')).textContent).toContain('held a job');
    await user.click(screen.getByRole('tab', { name: 'Eşzamanlılık ve bütçe' }));
    expect(
      (await screen.findByRole('meter', { name: 'proje acme eşzamanlılık' })).getAttribute('aria-valuetext'),
    ).toBe('2 / 4');
    await user.click(screen.getByRole('tab', { name: /Duraklatma ve durdurma/ }));
    await screen.findByTestId('quota-pauses');
    await user.click(
      within(screen.getByTestId('quota-pauses')).getByRole('button', { name: 'Şimdi sürdür' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(await screen.findByText('Codex yeniden başladı.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/quotas/pauses/p1/resume')).toBe(true);

    await user.click(
      within(screen.getByTestId('quota-holds')).getByRole('button', { name: 'Serbest bırak' }),
    );
    expect(await screen.findByText('acme için tutma kaldırıldı.')).toBeTruthy();

    const kill = screen.getByTestId('dy-kill-switch');
    const stop = within(kill).getByRole('button', { name: 'Tüm işleri durdur' });
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(kill).getByLabelText('Proje'), 'acme');
    await user.type(within(kill).getByLabelText('Neden'), 'loop');
    await user.click(within(kill).getByRole('button', { name: 'Tüm işleri durdur' }));
    // Nothing is sent before the second confirmation.
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/projects/acme/kill')).toBe(false);
    await user.click(within(kill).getByRole('button', { name: 'Evet, hepsini durdur' }));
    expect(await screen.findByText('acme için acil durdurma kullanıldı.')).toBeTruthy();
    const post = requests.find((r) => r.method === 'POST' && r.url === '/api/projects/acme/kill');
    expect(post?.body).toMatchObject({ reason: 'loop', hold: true });
  });

  it('p17-settings-tabs: enforcement in five sections; the first is the clean URL, an old anchor opens its section', async () => {
    renderApp({
      path: '/usage?tab=enforcement#kill-switch',
      routes: routes('admin', { 'GET /api/quotas/status': () => ({ status: 200, body: busyQuota() }) }),
    });
    expect(await screen.findByTestId('dy-kill-switch')).toBeTruthy();
    expect(screen.getByTestId('quota-pauses')).toBeTruthy();
    expect(
      within(screen.getByTestId('enforcement-tabs'))
        .getAllByRole('tab')
        .map((t) => t.textContent.replace(/\d+$/, '')),
    ).toEqual([
      'Kullanım sınırları',
      'Duraklatma ve durdurma',
      'Eşzamanlılık ve bütçe',
      'Son kararlar',
      'Kota politikası',
    ]);
    // Only the open section renders.
    expect(screen.queryByTestId('dy-usage-limits')).toBeNull();
    expect(screen.queryByTestId('quota-events')).toBeNull();
  });

  it('p17-settings-tabs: /usage?tab=enforcement (the composer’s "Limit ayrıntıları") opens Kullanım sınırları', async () => {
    renderApp({
      path: '/usage?tab=enforcement',
      routes: routes('admin', { 'GET /api/quotas/status': () => ({ status: 200, body: busyQuota() }) }),
    });
    expect(await screen.findByTestId('dy-usage-limits')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Kullanım sınırları' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.queryByTestId('quota-pauses')).toBeNull();
  });

  it('enforcement as a viewer: read only — no resume, release, policy save or kill switch', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/usage?tab=enforcement&section=holds',
      routes: routes('viewer', { 'GET /api/quotas/status': () => ({ status: 200, body: busyQuota() }) }),
      initialState: {
        kind: 'signedIn',
        user: { ...USER, role: 'viewer' },
        session: null,
        remainingRecoveryCodes: null,
      },
    });
    await screen.findByTestId('quota-pauses');
    expect(screen.queryByRole('button', { name: 'Şimdi sürdür' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Serbest bırak' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Politikayı kaydet' })).toBeNull();
    expect(screen.queryByTestId('dy-kill-switch')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Kota politikası' }));
    expect((await screen.findByLabelText<HTMLTextAreaElement>('Kota politikası (JSON)')).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Politikayı kaydet' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Kullanım sınırları' }));
    await screen.findByTestId('dy-usage-limits');
    expect(screen.queryByTestId('usage-limit-default-form')).toBeNull();
  });

  it('suggestions: confirm-then-apply, role gating and a remembered dismiss', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/usage?tab=suggestions',
      routes: routes('operator', {
        'GET /api/usage/suggestions': () => ({ status: 200, body: { items: SUGGESTIONS } }),
        'POST /api/automations/a1/pause': () => ({ status: 500, body: { error: 'x', message: 'nope' } }),
      }),
      initialState: {
        kind: 'signedIn',
        user: { ...USER, role: 'operator' },
        session: null,
        remainingRecoveryCodes: null,
      },
    });
    const rows = await screen.findAllByTestId('suggestion');
    expect(rows).toHaveLength(2);
    const [pause, admin] = rows as [HTMLElement, HTMLElement];
    expect(within(pause).getByText('Uyarı')).toBeTruthy();
    // Admin-only action: an operator sees who can apply it, no button.
    expect(within(admin).queryByRole('button', { name: /Paralel/ })).toBeNull();
    expect(within(admin).getByText(/admin rolü uygulayabilir/)).toBeTruthy();
    await user.click(within(pause).getByRole('button', { name: 'Otomasyonu duraklat…' }));
    expect(requests.some((r) => r.url === '/api/automations/a1/pause')).toBe(false);
    await user.click(within(pause).getByRole('button', { name: 'Onayla: Otomasyonu duraklat' }));
    expect(await within(pause).findByTestId('api-error')).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/automations/a1/pause')).toBe(true);
    await user.click(within(admin).getByRole('button', { name: 'Gizle' }));
    expect(screen.getAllByTestId('suggestion')).toHaveLength(1);
    expect(window.localStorage.getItem('remyral.suggestions.dismissed')).toContain('s2');
  });

  it('reports: settings save, the list links to /usage/reports/:id which renders the report natively', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/usage?tab=reports',
      routes: routes('owner', {
        'PUT /api/reports/settings': (r) => ({
          status: 200,
          body: { ...(r.body as object), isDefault: false },
        }),
      }),
    });
    const settings = await screen.findByTestId('dy-report-settings');
    await user.click(await within(settings).findByLabelText('Haftalık raporu her pazartesi 08:00’de gönder'));
    await user.click(within(settings).getByRole('button', { name: 'Kaydet' }));
    expect(await findToast('Rapor ayarları kaydedildi.')).toBeTruthy();
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({
      weeklyEnabled: true,
      timeZone: 'Europe/Istanbul',
    });
    const link = within(await screen.findByTestId('report-list')).getByRole('link');
    expect(link.getAttribute('href')).toBe('/usage/reports/r1');
    await user.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Haftalık rapor: 12–18 Ekim' })).toBeTruthy();
    const content = await screen.findByTestId('report-content');
    expect(content.textContent).toContain('Biten iş');
    expect(
      within(content).getByRole('link', { name: "İş 55555555: thread'de aç" }).getAttribute('href'),
    ).toBe(`/jobs/${JOB}`);
  });

  it('cost breakdown: provenance chips, lower bound, missing prices lead admins to the price tab', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/usage?tab=overview', routes: routes('owner') });
    expect((await screen.findByTestId('overview-cost')).textContent).toBe('≥ $3,00');
    expect(screen.getAllByTestId('badge-unknown').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('missing-prices')).getByText('openai / gpt-x')).toBeTruthy();
    expect(screen.getAllByTestId('usage-row')).toHaveLength(1);
    expect(screen.getByTestId('usage-chart').querySelector('li[title="acme: ≥ $3,00"]')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fiyat ekle' }));
    expect((await screen.findByRole('tab', { name: 'Fiyatlar' })).getAttribute('aria-selected')).toBe('true');
  });

  it('prices: admins edit with Turkish validation and step-up; viewers only read', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let stepped = false;
    const { requests } = renderApp({
      path: '/usage?tab=prices',
      routes: routes('admin', {
        'PUT /api/usage/prices': (r) =>
          stepped
            ? {
                status: 200,
                body: {
                  version: 3,
                  note: null,
                  createdAt: null,
                  entries: (r.body as { entries: unknown[] }).entries,
                },
              }
            : STEP_UP_REQUIRED,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    expect(await screen.findByTestId('price-table')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fiyatları düzenle' }));
    await user.click(screen.getByRole('button', { name: 'Satır ekle' }));
    await user.click(screen.getByRole('button', { name: 'Yeni sürüm olarak kaydet' }));
    expect(await screen.findByText('Satır 2: sağlayıcı ve model gerekli.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Satır 2’i kaldır' }));
    await user.click(screen.getByRole('button', { name: 'Yeni sürüm olarak kaydet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(await screen.findByText('Sürüm 3 olarak kaydedildi.')).toBeTruthy();
    expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toMatchObject({ expectedVersion: 2 });
  });

  it('prices as a viewer: the table without edit controls', async () => {
    renderApp({
      path: '/usage?tab=prices',
      routes: routes('viewer'),
      initialState: {
        kind: 'signedIn',
        user: { ...USER, role: 'viewer' },
        session: null,
        remainingRecoveryCodes: null,
      },
    });
    expect(await screen.findByTestId('price-table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fiyatları düzenle' })).toBeNull();
  });

  it('budgets: status with a meter, create through the form with step-up, edit keeps the version; chat usage', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let stepped = false;
    const { requests } = renderApp({
      path: '/usage?tab=budgets',
      routes: routes('owner', {
        'POST /api/budgets': (r) =>
          stepped ? { status: 201, body: budgetView({ ...(r.body as object), id: 'b2' }) } : STEP_UP_REQUIRED,
        'PUT /api/budgets/b1': () => ({ status: 200, body: budgetView({}) }),
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const row = await screen.findByTestId('budget-row');
    expect(within(row).getByTestId('budget-status').textContent).toContain('Aşıldı');
    expect(within(row).getByTestId('budget-exhausted').textContent).toContain('yeni işler bekletiliyor');
    expect(within(row).getByRole('meter', { name: 'Aylık API kullanımı' })).toBeTruthy();
    expect(within(row).getByTestId('budget-overrides')).toBeTruthy();
    expect((await screen.findByTestId('dy-chat-usage')).textContent).toContain('Sen, bugün');

    await user.click(screen.getByRole('button', { name: 'Yeni bütçe' }));
    const form = screen.getByTestId('budget-form');
    await user.click(within(form).getByRole('button', { name: 'Bütçe oluştur' }));
    expect(within(form).getByText('Bütçeye bir ad ver.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/budgets')).toBe(false);
    await user.type(within(form).getByLabelText('Ad'), 'Acme tokens');
    await user.type(within(form).getByLabelText('Sınır (token)'), '1000');
    await user.type(within(form).getByLabelText('Proje'), 'acme');
    await user.click(within(form).getByRole('button', { name: 'Bütçe oluştur' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(await screen.findByText('Bütçe oluşturuldu.')).toBeTruthy();
    expect(requests.find((r) => r.method === 'POST' && r.url === '/api/budgets')?.body).toMatchObject({
      name: 'Acme tokens',
      limit: 1000,
      scope: { type: 'project', value: 'acme' },
    });

    await user.click(
      within(screen.getAllByTestId('budget-row')[0] as HTMLElement).getByRole('button', { name: 'Düzenle' }),
    );
    await user.click(
      within(screen.getByTestId('budget-form')).getByRole('button', { name: 'Bütçeyi kaydet' }),
    );
    expect(await screen.findByText('Bütçe güncellendi.')).toBeTruthy();
    expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/budgets/b1')?.body).toMatchObject({
      expectedVersion: 4,
    });
  });

  it('budgets as a viewer: no create, edit, delete or override', async () => {
    renderApp({
      path: '/usage?tab=budgets',
      routes: routes('viewer'),
      initialState: {
        kind: 'signedIn',
        user: { ...USER, role: 'viewer' },
        session: null,
        remainingRecoveryCodes: null,
      },
    });
    await screen.findByTestId('budget-row');
    expect(screen.queryByRole('button', { name: 'Yeni bütçe' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Düzenle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sil' })).toBeNull();
    expect(screen.queryByTestId('budget-overrides')).toBeNull();
  });

  it('outcomes: the job-stats table in the Diyalog language with grouping', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/usage?tab=outcomes', routes: routes('owner') });
    const table = await screen.findByTestId('outcomes-table');
    expect(within(table).getAllByTestId('outcome-row')).toHaveLength(1);
    expect(table.textContent).toContain('%75');
    await user.click(within(screen.getByTestId('dy-outcomes')).getByLabelText('Proje'));
    expect(await screen.findByRole('columnheader', { name: 'Proje' })).toBeTruthy();
  });
});

// p15-usage-refresh (docs/design/p15-usage-refresh.md): one row per provider account with the machines it is used
// on, "Tümünü yenile" / "Şimdi kontrol et" with progress, honest values (%0 vs —, reset passed, stale), and the
// cleanup of logins that no longer exist (admins, step-up).
describe('Limit pencereleri: accounts, refresh and cleanup (p15-usage-refresh)', () => {
  const KA = { key: 'a'.repeat(32), hint: 'a…@example.com' };
  const OP1 = '11111111-1111-4111-8111-111111111111';
  const OP2 = '22222222-2222-4222-8222-222222222222';
  const win = (id: string, kind: string, used: number | null, level: string, over: object = {}) => ({
    id,
    kind,
    label: null,
    usedPercent: used,
    windowMinutes: kind === 'session' ? 300 : 10080,
    resetsAt: new Date(NOW + 3_600_000).toISOString(),
    status: null,
    level,
    history: [],
    ...over,
  });
  const machine = (workerId: string, workerName: string, over: object = {}) => ({
    workerId,
    workerName,
    workerState: 'online',
    account: 'default',
    accountLabel: 'example-org',
    observedAt: iso(60_000),
    orphan: false,
    canRefresh: true,
    ...over,
  });
  const group = (over: object) => ({
    key: 'g',
    runtime: 'claude-code',
    auth: 'subscription',
    identity: null,
    labels: [],
    source: 'probe',
    plan: 'max',
    available: true,
    observedAt: iso(60_000),
    readOn: null,
    stale: false,
    reports: true,
    level: 'ok',
    windows: [],
    limit: null,
    orphan: false,
    canRefresh: true,
    machines: [],
    ...over,
  });
  const GROUPS = {
    ...OVERVIEW,
    groups: [
      group({
        key: `id:claude-code:${KA.key}`,
        identity: KA,
        labels: ['example-org'],
        readOn: { workerId: 'w2', workerName: 'linux-worker-1' },
        windows: [
          win('five_hour', 'session', 72, 'ok'),
          win('seven_day', 'weekly', 29, 'ok', { status: 'warning' }),
        ],
        machines: [machine('w1', 'windows-worker-1'), machine('w2', 'linux-worker-1')],
      }),
      group({
        key: 'login:w1|codex|subscription|default',
        runtime: 'codex',
        stale: true,
        observedAt: iso(40 * 60_000),
        windows: [
          win('primary', 'session', 0, 'ok'),
          win('secondary', 'weekly', null, 'unknown', { restarted: true, resetsAt: null }),
        ],
        machines: [machine('w1', 'windows-worker-1', { accountLabel: null })],
      }),
      group({
        key: 'login:w1|claude-code|subscription|ae6rh2mm',
        orphan: true,
        canRefresh: false,
        observedAt: iso(2 * 86_400_000),
        machines: [
          machine('w1', 'windows-worker-1', { account: 'ae6rh2mm', accountLabel: null, orphan: true }),
        ],
      }),
    ],
  };
  const refreshPosts = <R extends { method: string; url: string }>(requests: R[]): R[] =>
    requests.filter((r) => r.method === 'POST' && r.url === '/api/usage-limits/refresh');

  it('one row per account with its machines; %0, unknown, reset passed and stale are told apart', async () => {
    renderApp({
      path: '/usage',
      routes: routes('owner', {
        'GET /api/usage-limits/overview?history=1': () => ({ status: 200, body: GROUPS }),
      }),
    });
    const panel = await screen.findByTestId('dy-limit-windows');
    const rows = await within(panel).findAllByTestId('dy-limit-entry');
    expect(rows).toHaveLength(3);
    const [ka, codex, gone] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(ka).getByTestId('dy-limit-account').textContent).toBe('example-org');
    expect(within(ka).getByTestId('dy-limit-identity').textContent).toBe('a…@example.com');
    expect(within(ka).getByTestId('dy-limit-machines').textContent).toBe(
      'Kullanıldığı makineler: windows-worker-1, linux-worker-1',
    );
    expect(within(ka).getByTestId('dy-limit-source').textContent).toContain('linux-worker-1 üzerinde okundu');
    // 29 % weekly with a runtime warning is not "near" (the master's level is shown as is).
    const weekly = within(ka).getByRole('meter', { name: 'Claude Code haftalık' });
    expect(weekly.getAttribute('aria-valuetext')).toMatch(/^%29, .+ sıfırlanır$/);
    expect(within(ka).queryByText(/sınıra yakın/)).toBeNull();
    // The reset time carries the viewer's time zone.
    const titled = within(ka).getAllByTitle(/^Sıfırlanma: /);
    expect(titled.length).toBe(2);
    expect(titled.every((el) => /\(.+\)$/.test(el.getAttribute('title') ?? ''))).toBe(true);

    expect(
      within(codex).getByRole('meter', { name: 'Codex 5 saatlik' }).getAttribute('aria-valuetext'),
    ).toMatch(/^%0, /);
    expect(within(codex).getByText('sıfırlandı — yeni okuma bekleniyor')).toBeTruthy();
    expect(within(codex).getByTestId('dy-limit-stale').getAttribute('title')).toBe(
      'Son okuma 30 dakikadan eski',
    );
    expect(within(gone).getByText('Bu giriş artık yok')).toBeTruthy();
    expect(within(gone).queryByTestId('dy-limit-refresh')).toBeNull();
  });

  it('"Tümünü yenile" and "Şimdi kontrol et" run the remote reads, show progress and reload the rows', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let reads = 0;
    const done = (opId: string) => ({
      opId,
      workerId: 'w',
      state: 'succeeded',
      done: true,
      reason: null,
      results: [{ runtime: 'claude-code', account: 'default', outcome: 'read' }],
    });
    const { requests } = renderApp({
      path: '/usage',
      routes: routes('operator', {
        'GET /api/usage-limits/overview?history=1': () => {
          reads += 1;
          return { status: 200, body: GROUPS };
        },
        'POST /api/usage-limits/refresh': () => ({
          status: 200,
          body: {
            ops: [
              { workerId: 'w1', workerName: 'windows-worker-1', opId: OP1 },
              { workerId: 'w2', workerName: 'linux-worker-1', opId: OP2 },
            ],
            skipped: [{ workerId: 'w3', workerName: 'old-worker', reason: 'worker_update_required' }],
          },
        }),
        [`GET /api/usage-limits/refresh-status?ops=${OP1}%2C${OP2}`]: () => ({
          status: 200,
          body: { ops: [done(OP1), done(OP2)] },
        }),
      }),
    });
    const panel = await screen.findByTestId('dy-limit-windows');
    await within(panel).findAllByTestId('dy-limit-entry');
    const before = reads;
    await user.click(within(panel).getByTestId('dy-limit-refresh-all'));
    // p17-toasts-shortcuts: the outcome is a toast (a warning: one machine was skipped), not a line in the panel.
    const refreshed = await screen.findByTestId('dy-limit-refresh-note');
    expect(refreshed.querySelector('[data-toast-title]')?.textContent).toBe(
      'Kontrol bitti: 2 giriş okundu. old-worker: makinenin güncellenmesi gerekiyor',
    );
    expect(refreshed.getAttribute('data-tone')).toBe('warning');
    await expect.poll(() => reads).toBeGreaterThan(before);
    expect(refreshPosts(requests).at(-1)?.body).toEqual({});
    expect(refreshPosts(requests).at(-1)?.headers['x-csrf-token']).toBe('csrf-token-1');

    const [ka] = within(panel).getAllByTestId('dy-limit-entry') as [HTMLElement];
    await user.click(within(ka).getByRole('button', { name: 'Şimdi kontrol et' }));
    await expect.poll(() => refreshPosts(requests).length).toBe(2);
    expect(refreshPosts(requests).at(-1)?.body).toEqual({ runtime: 'claude-code', identity: 'a'.repeat(32) });
    // Operators cannot clean up (admins only).
    expect(within(panel).queryByTestId('dy-limit-cleanup')).toBeNull();
  });

  it('viewers see the rows without refresh buttons', async () => {
    renderApp({
      path: '/usage',
      routes: routes('viewer', {
        'GET /api/usage-limits/overview?history=1': () => ({ status: 200, body: GROUPS }),
      }),
    });
    const panel = await screen.findByTestId('dy-limit-windows');
    await within(panel).findAllByTestId('dy-limit-entry');
    expect(within(panel).queryByTestId('dy-limit-refresh-all')).toBeNull();
    expect(within(panel).queryByTestId('dy-limit-refresh')).toBeNull();
    expect(within(panel).queryByTestId('dy-limit-cleanup')).toBeNull();
  });

  it('admins clean up old logins through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-token-1');
    const user = userEvent.setup();
    let stepped = false;
    let cleaned = false;
    renderApp({
      path: '/usage',
      routes: routes('owner', {
        'GET /api/usage-limits/overview?history=1': () => ({
          status: 200,
          body: cleaned ? { ...GROUPS, groups: GROUPS.groups.slice(0, 2) } : GROUPS,
        }),
        'POST /api/usage-limits/cleanup': () => {
          if (!stepped) return STEP_UP_REQUIRED;
          cleaned = true;
          return { status: 200, body: { removed: 1 } };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const panel = await screen.findByTestId('dy-limit-windows');
    await user.click(await within(panel).findByTestId('dy-limit-cleanup'));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(await findToast('1 eski giriş temizlendi.')).toBeTruthy();
    await expect.poll(() => within(panel).queryAllByTestId('dy-limit-entry').length).toBe(2);
  });
});
