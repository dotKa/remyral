import { describe, expect, it } from 'vitest';
import { MIN_SAMPLES, suggest, type SuggestionInputs } from '../../src/efficiency/suggestions.js';

const NOW = new Date('2026-10-20T12:00:00Z');

function inputs(over: Partial<SuggestionInputs> = {}): SuggestionInputs {
  return {
    now: NOW,
    stats: [],
    profiles: [],
    routing: new Map(),
    automations: [],
    workers: [],
    budgets: [],
    missingPrices: [],
    ...over,
  };
}

const stat = (model: string, attempts: number, succeeded: number, costPerAttempt: number) => ({
  runtime: 'claude-code',
  model,
  kind: 'summarise',
  attempts,
  succeeded,
  costUsd: costPerAttempt * attempts,
  costAttempts: attempts,
});

describe('efficiency suggestions (p8-cost-efficiency, deterministic rules)', () => {
  it('cheaper model: proposes the routing rule only with enough samples, a real saving and similar success', () => {
    const s = suggest(
      inputs({
        stats: [stat('big', 40, 36, 0.5), stat('small', 20, 18, 0.1)],
        profiles: [{ id: 'small-profile', model: 'small', runtimes: ['claude-code'] }],
        routing: new Map([['summarise', { modelProfile: null, runtimes: ['claude-code', 'codex'] }]]),
      }),
    );
    const c = s.find((x) => x.rule === 'cheaper_model');
    expect(c?.action).toEqual({
      kind: 'routing_rule',
      role: 'summarise',
      modelProfile: 'small-profile',
      runtimes: ['claude-code', 'codex'],
    });
    expect(c?.actionStepUp).toBe(true);
    expect(c?.actionRole).toBe('admin');

    // Worse success rate, too few samples, or no real saving → nothing.
    expect(
      suggest(inputs({ stats: [stat('big', 40, 36, 0.5), stat('small', 20, 10, 0.1)] })).some(
        (x) => x.rule === 'cheaper_model',
      ),
    ).toBe(false);
    expect(
      suggest(inputs({ stats: [stat('big', 40, 36, 0.5), stat('small', MIN_SAMPLES - 1, 9, 0.1)] })).some(
        (x) => x.rule === 'cheaper_model',
      ),
    ).toBe(false);
    expect(
      suggest(inputs({ stats: [stat('big', 40, 36, 0.5), stat('small', 20, 18, 0.45)] })).some(
        (x) => x.rule === 'cheaper_model',
      ),
    ).toBe(false);
    // No catalog profile for the model: only a link to the model settings, no write.
    expect(
      suggest(inputs({ stats: [stat('big', 40, 36, 0.5), stat('small', 20, 18, 0.1)] })).find(
        (x) => x.rule === 'cheaper_model',
      )?.action,
    ).toEqual({ kind: 'open', path: '/settings/models' });
  });

  it('failing automation (≥ 40 % of ≥ 5 runs) and enable result reuse for repeated identical scheduled work', () => {
    const s = suggest(
      inputs({
        automations: [
          {
            id: 'a1',
            name: 'nightly',
            project: 'acme',
            targetKind: 'job',
            triggerKind: 'cron',
            reuseWithinHours: null,
            runs: 10,
            failed: 4,
            identicalSuccessRuns: 3,
          },
          {
            id: 'a2',
            name: 'fine',
            project: 'acme',
            targetKind: 'job',
            triggerKind: 'github',
            reuseWithinHours: null,
            runs: 10,
            failed: 3,
            identicalSuccessRuns: 5,
          },
        ],
      }),
    );
    expect(s.filter((x) => x.rule === 'failing_automation').map((x) => x.id)).toEqual([
      'failing_automation:a1',
    ]);
    expect(s.find((x) => x.rule === 'failing_automation')?.title).toContain('40 %');
    // GitHub-triggered runs carry event data: never suggested for reuse.
    expect(s.filter((x) => x.rule === 'enable_reuse').map((x) => x.action)).toEqual([
      { kind: 'enable_reuse', automationId: 'a1', hours: 24 },
    ]);
  });

  it('lower parallelism only above the recommendation and never for auto machines; budget pace; order is stable', () => {
    const s = suggest(
      inputs({
        workers: [
          { id: 'w1', name: 'win', effective: 6, recommended: 3, mode: 'manual' },
          { id: 'w2', name: 'mac', effective: 6, recommended: 3, mode: 'auto' },
          { id: 'w3', name: 'pi', effective: 2, recommended: 3, mode: null },
        ],
        budgets: [
          {
            id: 'b1',
            name: 'monthly',
            metric: 'cost_usd',
            limit: 100,
            used: 80,
            status: 'warning',
            complete: true,
            windowStart: new Date('2026-10-01T00:00:00Z'),
            windowEnd: new Date('2026-11-01T00:00:00Z'),
          },
        ],
        missingPrices: [{ provider: 'openai', model: 'gpt-x', records: 4 }],
      }),
    );
    expect(s.filter((x) => x.rule === 'lower_parallelism').map((x) => x.action)).toEqual([
      { kind: 'set_parallelism', workerId: 'w1', value: 3 },
    ]);
    expect(s.find((x) => x.rule === 'budget_pace')?.title).toMatch(/on pace for \d+ %/);
    expect(s.at(-1)?.rule).toBe('missing_price');
    // Deterministic: same input, same output.
    expect(JSON.stringify(s)).toBe(
      JSON.stringify(
        suggest(
          inputs({
            workers: [
              { id: 'w1', name: 'win', effective: 6, recommended: 3, mode: 'manual' },
              { id: 'w2', name: 'mac', effective: 6, recommended: 3, mode: 'auto' },
              { id: 'w3', name: 'pi', effective: 2, recommended: 3, mode: null },
            ],
            budgets: [
              {
                id: 'b1',
                name: 'monthly',
                metric: 'cost_usd',
                limit: 100,
                used: 80,
                status: 'warning',
                complete: true,
                windowStart: new Date('2026-10-01T00:00:00Z'),
                windowEnd: new Date('2026-11-01T00:00:00Z'),
              },
            ],
            missingPrices: [{ provider: 'openai', model: 'gpt-x', records: 4 }],
          }),
        ),
      ),
    );
  });
});
