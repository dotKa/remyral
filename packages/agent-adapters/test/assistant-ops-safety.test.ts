import { ASSISTANT_TOOLS, assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p16-ops-safety (docs/design/p16-ops-safety.md §6): rule 41 sends the model to ops_safety_status for expiry, the
 * rollout breaker and the cost brake, and forbids claiming rotations, resuming a held rollout or lifting the brake;
 * the read tool's input is strict; change_settings carries the new policy sections.
 */
describe('operations safety through the chat (p16-ops-safety)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 41 names the tool, the runbooks, the held rollout and the brake', () => {
    const r = rule(41);
    expect(r).toContain('ops_safety_status');
    expect(r).toMatch(/never claim a rotation happened/);
    expect(r).toMatch(/never try to raise its percentage/);
    expect(r).toMatch(/an urgent job still runs/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('ops_safety_status is a read with a strict part; change_settings takes the new sections', () => {
    expect(ASSISTANT_TOOLS.ops_safety_status.kind).toBe('read');
    const input = assistantToolInput('ops_safety_status');
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ part: 'rollout' }).success).toBe(true);
    expect(input.safeParse({ part: 'secrets' }).success).toBe(false);
    const change = assistantToolInput('change_settings');
    expect(
      change.safeParse({
        target: 'security_policy',
        securityPolicy: { costBrake: { mode: 'block', dailyUsd: 25 }, rollout: { failurePercent: 40 } },
      }).success,
    ).toBe(true);
    expect(
      change.safeParse({ target: 'security_policy', securityPolicy: { costBrake: { mode: 'stop' } } })
        .success,
    ).toBe(false);
  });
});
