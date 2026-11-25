import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseThresholds } from '../src/screens/usage/budgets';
import { safePath } from '../src/screens/usage/suggestions';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

/** p8-cost-efficiency console: dashboard, suggestions (confirm + existing routes), budgets p8 fields, reports. */
const HOSTILE = '<img src=x onerror=alert(1)>';
const BUDGET = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
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

const DASHBOARD = {
  range: { from: '2026-09-20T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z', grain: 'day', timeZone: 'UTC' },
  priceTableVersion: 1,
  totals: spend(),
  trends: [
    { ...spend(), key: '2026-10-19', start: '2026-10-19T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
  ],
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

const SUGGESTIONS = [
  {
    id: 'cheaper_model:codex:summarise:mini',
    rule: 'cheaper_model',
    severity: 'info',
    title: `summarise jobs could use a cheaper model ${HOSTILE}`,
    detail: 'detail',
    evidence: { attempts: 20 },
    action: { kind: 'routing_rule', role: 'summarise', modelProfile: 'mini', runtimes: ['codex'] },
    actionRole: 'admin',
    actionStepUp: true,
    project: null,
  },
  {
    id: 'failing_automation:a1',
    rule: 'failing_automation',
    severity: 'warning',
    title: 'Automation "nightly" fails 50 % of its runs',
    detail: 'd',
    evidence: {},
    action: { kind: 'pause_automation', automationId: 'a1' },
    actionRole: 'operator',
    actionStepUp: false,
    project: 'acme',
  },
];

function budgetView(): unknown {
  return {
    budget: {
      id: BUDGET,
      name: 'acme monthly API',
      metric: 'cost_usd',
      limit: 10,
      scope: { type: 'project', value: 'acme' },
      window: 'month',
      enabled: true,
      version: 1,
      createdBy: USER.id,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedBy: USER.id,
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      deletedBy: null,
      billing: 'api',
      timeZone: 'Europe/Istanbul',
      thresholds: [50, 80, 100],
      onExceeded: 'pause_new',
    },
    evaluation: {
      metric: 'cost_usd',
      limit: 10,
      used: 11,
      ratio: 1.1,
      level: 'exceeded',
      status: 'over',
      complete: true,
      records: 3,
      unknownRecords: 0,
      subscriptionRecords: 0,
      window: { start: '2026-09-30T21:00:00.000Z', end: '2026-10-31T21:00:00.000Z' },
    },
  };
}

/** Exact routes plus prefix matches for URLs with time-dependent query strings. */
function routes(role: string, extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), user: { ...USER, role } },
    }),
    'GET /api/usage/suggestions': () => ({ status: 200, body: { items: SUGGESTIONS } }),
    'GET /api/budgets': () => ({ status: 200, body: { items: [budgetView()] } }),
    [`GET /api/budgets/${BUDGET}/overrides`]: () => ({ status: 200, body: { items: [] } }),
    'GET /api/reports/settings': () => ({
      status: 200,
      body: { timeZone: 'UTC', weeklyEnabled: true, chatThreadId: null, isDefault: true },
    }),
    'GET /api/reports': () => ({ status: 200, body: { items: [] } }),
    'GET /api/chat/threads': () => ({
      status: 200,
      body: {
        items: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            title: 'Reports',
            archived: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    }),
    ...extra,
  };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key.startsWith('GET /api/usage/dashboard?')) return () => ({ status: 200, body: DASHBOARD });
      if (key.startsWith('GET /api/usage/summary?')) {
        return () => ({
          status: 200,
          body: {
            groupBy: 'project',
            from: '2026-09-20T00:00:00.000Z',
            to: '2026-10-20T00:00:00.000Z',
            priceTableVersion: 0,
            groups: [],
            totals: {
              key: null,
              records: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              tokensUnknownRecords: 0,
              turns: 0,
              turnsUnknownRecords: 0,
              wallTimeMs: 0,
              wallTimeUnknownRecords: 0,
              costUsd: { reported: 0, estimated: 0, total: 0 },
              coverage: { reported: 0, estimated: 0, unknown: 0, subscription: 0 },
              coverageShare: { reported: 0, estimated: 0, unknown: 0, subscription: 0 },
              unknownReasons: {},
              missingPrices: [],
              flags: {
                costComplete: true,
                hasSubscription: false,
                noPerRunCost: false,
                metricsIncomplete: false,
              },
            },
          },
        });
      }
      return undefined;
    },
  });
}

describe('Efficiency suggestions', () => {
  it('viewers see suggestions without action buttons; paths stay console-relative', async () => {
    renderApp({ path: '/usage?tab=suggestions', routes: routes('viewer') });
    expect(await screen.findAllByTestId('suggestion')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Route summarise/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause the automation/ })).toBeNull();
    expect(safePath('/usage?tab=prices')).toBe('/usage?tab=prices');
    expect(safePath('//evil.example')).toBeNull();
    expect(safePath('https://evil.example')).toBeNull();
  });
});

describe('Budgets p8 fields and overrides', () => {
  it('parses thresholds', () => {
    expect(parseThresholds('100, 50 80')).toEqual([50, 80, 100]);
    expect(parseThresholds('0, 50')).toBeNull();
    expect(parseThresholds('')).toBeNull();
  });
});
