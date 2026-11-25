import { ASSISTANT_BUDGETS_TOOLS, ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/** p18-leftovers (worker 1.2.2): rule 55 — budgets through the chat; rule 54 — GitHub triggers in a group. */
describe('assistant budgets (p18-leftovers)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 55 names the tool, reads first and keeps loosening a budget for the user', () => {
    const r = rule(55);
    for (const name of ASSISTANT_BUDGETS_TOOLS) {
      expect(r, name).toContain(name);
      expect(ASSISTANT_TOOL_NAMES).toContain(name);
    }
    expect(r).toContain('quota_status');
    expect(r).toMatch(/LOOSEN/);
    expect(r).toMatch(/never loosen a budget on your own/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('rule 54 lets a group take a GitHub trigger (each project’s admin), webhooks stay one at a time', () => {
    expect(rule(54)).toMatch(/GitHub trigger listens to each project's own repository/);
    expect(rule(54)).toMatch(/webhook triggers one project at a time/);
  });

  it('the engines declare draft_budget_change as an acting draft', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    expect(specs.get('draft_budget_change')?.description).toContain('Acting:');
    expect(JSON.stringify(specs.get('draft_budget_change')?.inputSchema)).toContain('"onExceeded"');
  });
});
