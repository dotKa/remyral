import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formToInput } from '../src/screens/usage/budgets';
import { formatUsd, periodRange } from '../src/screens/usage/format';
import { rowsToEntries } from '../src/screens/usage/prices';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

const HOSTILE = '<img src=x onerror=alert(1)>';

function group(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'alpha',
    records: 4,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokensUnknownRecords: 0,
    turns: 6,
    turnsUnknownRecords: 0,
    wallTimeMs: 65_000,
    wallTimeUnknownRecords: 0,
    costUsd: { reported: 0.25, estimated: 2, total: 2.25 },
    coverage: { reported: 1, estimated: 1, unknown: 1, subscription: 1 },
    coverageShare: { reported: 0.25, estimated: 0.25, unknown: 0.25, subscription: 0.25 },
    unknownReasons: { price_missing: 1 },
    missingPrices: [{ provider: 'openai', model: 'test-model-b', reason: 'price_missing', records: 1 }],
    flags: { costComplete: false, hasSubscription: true, noPerRunCost: false, metricsIncomplete: false },
    ...over,
  };
}

const SUB_ONLY = group({
  key: 'subs',
  records: 2,
  costUsd: { reported: 0, estimated: 0, total: 0 },
  coverage: { reported: 0, estimated: 0, unknown: 0, subscription: 2 },
  missingPrices: [],
  unknownReasons: {},
  flags: { costComplete: true, hasSubscription: true, noPerRunCost: true, metricsIncomplete: false },
});

const COMPLETE = group({
  key: HOSTILE,
  records: 1,
  costUsd: { reported: 1.5, estimated: 0, total: 1.5 },
  coverage: { reported: 1, estimated: 0, unknown: 0, subscription: 0 },
  missingPrices: [],
  unknownReasons: {},
  flags: { costComplete: true, hasSubscription: false, noPerRunCost: false, metricsIncomplete: false },
});

function summaryBody(groupBy: string, groups = [group(), COMPLETE, SUB_ONLY]): unknown {
  return {
    groupBy,
    from: '2026-09-12T00:00:00.000Z',
    to: '2026-10-12T00:00:00.000Z',
    priceTableVersion: 0,
    groups,
    totals: group({ key: null, records: 7 }),
  };
}

function budgetView(over: Record<string, unknown> = {}, evaluation: Record<string, unknown> = {}): unknown {
  return {
    budget: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Beta dollars',
      metric: 'cost_usd',
      limit: 100,
      scope: { type: 'project', value: 'beta' },
      window: 'month',
      enabled: true,
      version: 1,
      createdBy: USER.id,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedBy: USER.id,
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      deletedBy: null,
      ...over,
    },
    evaluation: {
      metric: 'cost_usd',
      limit: 100,
      used: 12.5,
      ratio: 0.125,
      level: 'none',
      status: 'unknown',
      complete: false,
      records: 3,
      unknownRecords: 1,
      subscriptionRecords: 0,
      window: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
      ...evaluation,
    },
  };
}

/** Routes with a prefix match for the time-dependent summary URL. */
function routes(role: string, extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/usage/prices': () => ({
      status: 200,
      body: { version: 0, note: null, createdBy: null, createdAt: null, entries: [] },
    }),
    'GET /api/budgets': () => ({ status: 200, body: { items: [budgetView()] } }),
    ...extra,
  };
  base['GET /api/auth/session'] = () => ({
    status: 200,
    body: { ...(sessionBody() as object), user: { ...USER, role } },
  });
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === 'string' && key.startsWith('GET /api/usage/summary?') && !(key in target)) {
        const groupBy = new URLSearchParams(key.split('?')[1]).get('groupBy') ?? 'project';
        return extra['GET /api/usage/summary'] ?? (() => ({ status: 200, body: summaryBody(groupBy) }));
      }
      return target[key as string];
    },
  });
}

describe('Usage screen', () => {
  it('shows an empty state when nothing was recorded', async () => {
    renderApp({
      path: '/usage?tab=overview',
      routes: routes('viewer', {
        'GET /api/usage/summary': () => ({ status: 200, body: summaryBody('project', []) }),
      }),
    });
    expect(await screen.findByTestId('usage-empty')).toBeTruthy();
  });
});

describe('usage helpers', () => {
  it('formats dollars without hiding small amounts', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(0.00001)).toBe('<$0.0001');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('period ranges end just after now', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    expect(periodRange('month', now)).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-13T12:00:01.000Z',
    });
    expect(periodRange('24h', now).from).toBe('2026-10-12T12:00:00.000Z');
  });

  it('budget form converts hours and validates scope', () => {
    const base = {
      name: 'x',
      metric: 'turns' as const,
      limit: '10',
      scopeType: 'global' as const,
      scopeValue: '',
      window: 'day' as const,
      enabled: true,
    };
    expect(formToInput(base).input).toMatchObject({ limit: 10, scope: { type: 'global', value: null } });
    expect(formToInput({ ...base, limit: '1.5' }).errors.limit).toBe('Use a whole number.');
    expect(formToInput({ ...base, scopeType: 'project' }).errors.scopeValue).toBe('Required for this scope.');
    expect(formToInput({ ...base, metric: 'wall_time_ms', limit: '1.5' }).input?.limit).toBe(5_400_000);
  });

  it('price rows need a source and non-negative prices', () => {
    const row = {
      key: 1,
      provider: 'Acme',
      model: 'm',
      effectiveFrom: '2026-01-01',
      input: '1',
      output: '-2',
      cacheRead: '',
      cacheWrite: 'x',
      source: '',
    };
    const { errors, entries } = rowsToEntries([row]);
    expect(errors).toHaveLength(3);
    expect(entries[0]?.provider).toBe('acme');
  });
});
