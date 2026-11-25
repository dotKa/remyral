import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { ADMIN_ACTION_OF } from '../../src/chat/admin-actions.js';
import { ChatDirectActions } from '../../src/chat/direct.js';
import { budgetLoosens, ChatOpsTools, type ChatOpsToolsDeps } from '../../src/chat/ops-tools.js';
import type { DraftRecord } from '../../src/chat/store.js';
import { adminOpEvent } from '../../src/security-policy/events.js';
import { effectivePolicy } from '../../src/security-policy/model.js';
import { UsageNotFoundError } from '../../src/usage/errors.js';
import { UsageStore, type BudgetRecord } from '../../src/usage/store.js';

/**
 * p18-leftovers item 3 (docs/design/p18-leftovers.md): budgets through the chat — draft_budget_change plans an
 * administration card with the console's checks (budgets.write, the store's input rules, expectedVersion, the
 * limits.budgets event); a change that loosens a budget is a card by default (only `execute: true` runs it directly);
 * confirming it writes through the usage store as the confirming user, with their step-up.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const B1 = '22222222-2222-4222-8222-222222222222';
const subject = (role: 'owner' | 'admin' | 'operator' | 'viewer'): Subject => ({
  userId: USER,
  role,
  memberships: new Map(),
});

const budget = (over: Partial<BudgetRecord> = {}): BudgetRecord => ({
  id: B1,
  name: 'Daily API spend',
  metric: 'cost_usd',
  limit: 20,
  scope: { type: 'project', value: 'acme' },
  window: 'day',
  timeZone: 'UTC',
  enabled: true,
  billing: 'all',
  thresholds: [50, 80, 100],
  onExceeded: 'pause_new',
  version: 3,
  createdBy: USER,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: USER,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  deletedAt: null,
  deletedBy: null,
  ...over,
});

/** A usage store whose input checks are the real ones and whose reads / writes are recorded. */
function fakeStore(current: BudgetRecord | null) {
  const real = new UsageStore({
    pool: {} as never,
    audit: { record: () => Promise.resolve() } as never,
    clock: () => new Date('2026-10-28T12:00:00Z'),
  });
  const writes: { op: string; user: Record<string, unknown>; args: unknown[] }[] = [];
  const store = {
    checkBudgetInput: real.checkBudgetInput.bind(real),
    getBudget: () =>
      current === null
        ? Promise.reject(new UsageNotFoundError(`budget ${B1}`))
        : Promise.resolve({ budget: current, evaluation: null }),
    createBudget: (user: Record<string, unknown>, ...args: unknown[]) => {
      writes.push({ op: 'create', user, args });
      return Promise.resolve({ budget: budget({ id: 'new', version: 1 }), evaluation: null });
    },
    updateBudget: (user: Record<string, unknown>, ...args: unknown[]) => {
      writes.push({ op: 'update', user, args });
      return Promise.resolve({ budget: budget({ version: 4, limit: 30 }), evaluation: null });
    },
    deleteBudget: (user: Record<string, unknown>, ...args: unknown[]) => {
      writes.push({ op: 'delete', user, args });
      return Promise.resolve(budget({ deletedAt: new Date() }));
    },
  };
  return { store: store as unknown as UsageStore, writes };
}

function tools(store: UsageStore | null): ChatOpsTools {
  const none = () => null;
  const deps: ChatOpsToolsDeps = {
    db: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as never,
    clock: () => new Date('2026-10-28T12:00:00Z'),
    workflows: none,
    workspaces: none,
    uptime: none,
    memoryRecords: none,
    outputs: none,
    folders: none,
    reports: none,
    health: none,
    questions: none,
    templates: none,
    backups: none,
    hostActions: none,
    updates: none,
    costBrake: none,
    usage: () => store,
  };
  return new ChatOpsTools(deps);
}

describe('which budget changes loosen it', () => {
  const prev = budget();
  const as = (over: Record<string, unknown>) => ({
    name: prev.name,
    metric: prev.metric,
    limit: prev.limit,
    scopeType: prev.scope.type,
    scopeValue: prev.scope.value,
    window: prev.window,
    enabled: prev.enabled,
    billing: prev.billing,
    onExceeded: prev.onExceeded,
    ...over,
  });
  it('a higher limit, off, a weaker rule, a longer window, another scope / metric and deleting loosen it', () => {
    expect(budgetLoosens(prev, as({ limit: 25 }) as never)).toBe(true);
    expect(budgetLoosens(prev, as({ enabled: false }) as never)).toBe(true);
    expect(budgetLoosens(prev, as({ onExceeded: 'warn' }) as never)).toBe(true);
    expect(budgetLoosens(prev, as({ window: 'week' }) as never)).toBe(true);
    expect(budgetLoosens(prev, as({ scopeValue: 'beta' }) as never)).toBe(true);
    expect(budgetLoosens(prev, as({ metric: 'tokens', limit: 5 }) as never)).toBe(true);
    expect(budgetLoosens(prev, null)).toBe(true);
  });
  it('a lower limit, a stricter rule, a renamed budget and a new one do not', () => {
    expect(budgetLoosens(prev, as({ limit: 10 }) as never)).toBe(false);
    expect(budgetLoosens(budget({ onExceeded: 'warn' }), as({ onExceeded: 'pause_new' }) as never)).toBe(
      false,
    );
    expect(budgetLoosens(prev, as({ name: 'Renamed' }) as never)).toBe(false);
    expect(budgetLoosens(null, as({}) as never)).toBe(false);
    expect(budgetLoosens(budget({ enabled: false }), null)).toBe(false);
  });
});

describe('draft_budget_change plans', () => {
  it('needs budgets.write (administrators) and the store', async () => {
    const { store } = fakeStore(budget());
    expect(
      await tools(store).plan(subject('operator'), 'draft_budget_change', { action: 'delete', budgetId: B1 }),
    ).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      await tools(null).plan(subject('admin'), 'draft_budget_change', { action: 'delete', budgetId: B1 }),
    ).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
  });

  it('create: the store’s checks before a card; a new budget is not a loosening (no card-only mark)', async () => {
    const { store } = fakeStore(null);
    const t = tools(store);
    const bad = await t.plan(subject('admin'), 'draft_budget_change', {
      action: 'create',
      name: 'Subs',
      metric: 'cost_usd',
      limit: 10,
      window: 'day',
      billing: 'subscription',
    });
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
    expect(bad.ok ? '' : bad.message).toContain('subscription_has_no_dollars');
    const ok = await t.plan(subject('admin'), 'draft_budget_change', {
      action: 'create',
      name: 'Acme daily',
      metric: 'cost_usd',
      limit: 10,
      window: 'day',
      scope: { type: 'project', value: 'acme' },
    });
    expect(ok.ok && ok.payload).toMatchObject({
      target: 'admin',
      op: 'budget.create',
      event: 'limits.budgets',
      budget: { name: 'Acme daily', limit: 10, scopeType: 'project', scopeValue: 'acme' },
    });
    expect(ok.ok && ok.payload.cardOnly).toBeUndefined();
    // Never a project field (the card would be authorized in that project instead of globally, like the route).
    expect(ok.ok && ok.payload.project).toBeUndefined();
  });

  it('update: only the named fields change; raising the limit is a card by default, lowering is not', async () => {
    const { store } = fakeStore(budget());
    const t = tools(store);
    const raise = await t.plan(subject('admin'), 'draft_budget_change', {
      action: 'update',
      budgetId: B1,
      limit: 50,
    });
    expect(raise.ok && raise.payload).toMatchObject({
      op: 'budget.update',
      budgetId: B1,
      expectedVersion: 3,
      cardOnly: 'default',
      budget: { limit: 50, window: 'day', scopeValue: 'acme', onExceeded: 'pause_new' },
      previous: { limit: 20 },
    });
    expect(raise.ok && raise.describe.loosens).toBeDefined();
    const lower = await t.plan(subject('admin'), 'draft_budget_change', {
      action: 'update',
      budgetId: B1,
      limit: 5,
    });
    expect(lower.ok && lower.payload.cardOnly).toBeUndefined();
    expect(
      await t.plan(subject('admin'), 'draft_budget_change', { action: 'update', budgetId: B1 }),
    ).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('delete: an enabled budget is a card by default; an unknown one is not found', async () => {
    const { store } = fakeStore(budget());
    const del = await tools(store).plan(subject('admin'), 'draft_budget_change', {
      action: 'delete',
      budgetId: B1,
    });
    expect(del.ok && del.payload).toMatchObject({
      op: 'budget.delete',
      expectedVersion: 3,
      cardOnly: 'default',
    });
    const missing = fakeStore(null);
    expect(
      await tools(missing.store).plan(subject('admin'), 'draft_budget_change', {
        action: 'delete',
        budgetId: B1,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('confirming writes through the store as the confirming user with their step-up and the shown version', async () => {
    const { store, writes } = fakeStore(budget());
    const t = tools(store);
    const plan = await t.plan(subject('admin'), 'draft_budget_change', {
      action: 'update',
      budgetId: B1,
      limit: 5,
    });
    if (!plan.ok) throw new Error('plan');
    const mfaAt = new Date('2026-10-28T11:59:00Z');
    const out = await t.apply('budget.update', plan.payload, {
      subject: subject('admin'),
      actor: { userId: USER, ip: '10.0.0.1', userAgent: 'ua' },
      meta: { ip: '10.0.0.1', userAgent: 'ua' },
      human: { mfaAt, stepUpMaxAgeMs: 600_000 },
    });
    expect(out).toMatchObject({ budgetId: B1, version: 4 });
    expect(writes[0]).toMatchObject({
      op: 'update',
      user: { id: USER, role: 'admin', mfaAt, stepUpMaxAgeMs: 600_000 },
    });
    expect(writes[0]?.args[0]).toBe(B1);
    expect(writes[0]?.args[1]).toMatchObject({ limit: 5, expectedVersion: 3 });
  });

  it('the operations keep the console route’s action and event', () => {
    for (const op of ['budget.create', 'budget.update', 'budget.delete'] as const) {
      expect(ADMIN_ACTION_OF[op]).toBe('budgets.write');
      expect(adminOpEvent(op)).toBe('limits.budgets');
    }
  });
});

describe('a card by default on the direct path', () => {
  function direct() {
    let confirmed = 0;
    const audits: Record<string, unknown>[] = [];
    const d = new ChatDirectActions({
      drafts: () =>
        ({
          confirm: () => {
            confirmed++;
            return Promise.resolve({ draft: {}, result: {} });
          },
        }) as never,
      securityPolicy: {
        current: () =>
          Promise.resolve(effectivePolicy({ preset: 'serbest', autonomy: { chatDirect: true } })),
      },
      audit: { record: (e: Record<string, unknown>) => (audits.push(e), Promise.resolve()) } as never,
    });
    return { d, audits, confirmed: () => confirmed };
  }
  const draft = {
    id: 'd1',
    kind: 'settings_change',
    threadId: 't1',
    project: null,
    payload: { target: 'admin', op: 'budget.update', cardOnly: 'default', budgetId: B1 },
  } as unknown as DraftRecord;

  it('the platform’s default, a watch and a plan keep it a card', async () => {
    for (const trigger of ['default', 'watch', 'plan'] as const) {
      const x = direct();
      expect(await x.d.execute(subject('admin'), 'admin', undefined, draft, trigger)).toMatchObject({
        executed: false,
        reason: 'card_only',
      });
      expect(x.confirmed()).toBe(0);
      expect(x.audits[0]).toMatchObject({ outcome: 'denied' });
    }
  });

  it('the user’s explicit request (execute) runs it', async () => {
    const x = direct();
    expect(await x.d.execute(subject('admin'), 'admin', undefined, draft, 'execute')).toMatchObject({
      executed: true,
    });
    expect(x.confirmed()).toBe(1);
  });
});
