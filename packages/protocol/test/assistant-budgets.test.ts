import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_BUDGETS_FEATURE,
  ASSISTANT_BUDGETS_TOOLS,
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_TOOLS,
  assistantToolDescription,
  assistantToolInput,
  WorkerFeature,
} from '../src/index.js';

/** p18-leftovers (docs/design/p18-leftovers.md): draft_budget_change of worker 1.2.2 and its feature. */
describe('assistant budgets (p18-leftovers)', () => {
  const U = '7d0e2f1a-3b4c-4d5e-8f60-718293a4b5c6';
  const ok = (v: unknown) => assistantToolInput('draft_budget_change').safeParse(v).success;

  it('is an acting draft tool of a worker feature (the master decides card vs. direct per change)', () => {
    expect(WorkerFeature.options).toContain(ASSISTANT_BUDGETS_FEATURE);
    for (const t of ASSISTANT_BUDGETS_TOOLS) {
      expect(ASSISTANT_TOOLS[t].kind, t).toBe('draft');
      expect(assistantToolDescription(t)).toContain('Acting:');
    }
    expect(ASSISTANT_CARD_DEFAULT_TOOLS.has('draft_budget_change')).toBe(false);
  });

  it('validates its input strictly', () => {
    expect(
      ok({
        action: 'create',
        name: 'Daily cap',
        metric: 'cost_usd',
        limit: 25,
        window: 'day',
        scope: { type: 'project', value: 'acme' },
        thresholds: [50, 80, 100],
        onExceeded: 'pause_new',
      }),
    ).toBe(true);
    expect(ok({ action: 'update', budgetId: U, limit: 40 })).toBe(true);
    expect(ok({ action: 'delete', budgetId: U })).toBe(true);
    expect(ok({ action: 'raise', budgetId: U })).toBe(false);
    expect(ok({ action: 'update', budgetId: U, limit: -1 })).toBe(false);
    expect(ok({ action: 'update', budgetId: U, thresholds: [0] })).toBe(false);
    expect(ok({ action: 'update', budgetId: U, onExceeded: 'ignore' })).toBe(false);
    expect(ok({ action: 'update', budgetId: 'not-a-uuid' })).toBe(false);
    expect(ok({ action: 'create', scope: { type: 'team' } })).toBe(false);
  });
});
