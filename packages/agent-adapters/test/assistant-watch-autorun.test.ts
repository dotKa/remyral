import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/**
 * p15-watch-autorun: a watch's follow-up step runs by itself when the user asked for it (rule 35), and the assistant
 * finds workflows by name instead of asking for a UUID (rule 36, list_workflows / describe_workflow).
 */
describe('watch follow-up steps and workflow lookup (p15-watch-autorun)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 35: mode auto on the user’s request, ask only when they want to confirm; report then.onMet exactly', () => {
    const r = rule(35);
    expect(r).toContain('create_watch');
    expect(r).toContain('mode "auto"');
    expect(r).toContain('mode "ask"');
    expect(r).toContain('then.onMet');
    expect(r).toMatch(/Never claim that the watch can only prepare a card/);
    expect(r).toMatch(/approval steps still ask/);
  });

  it('rule 36: list_workflows / describe_workflow — never ask for a workflow id', () => {
    const r = rule(36);
    expect(r).toContain('list_workflows');
    expect(r).toContain('describe_workflow');
    expect(r).toMatch(/never ask the user for a workflow id or UUID/);
    expect(r).toMatch(/never say you have no tool for it/);
    // The last rules, numbers unique.
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(Math.max(...numbers.map(Number))).toBeGreaterThanOrEqual(36);
  });

  it('the engines declare both read tools without the acting suffix', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    for (const name of ['list_workflows', 'describe_workflow'] as const) {
      const s = specs.get(name);
      expect(s, name).toBeDefined();
      expect(s?.description).not.toContain('Acting:');
    }
    expect(JSON.stringify(specs.get('list_workflows')?.inputSchema)).toContain('"query"');
    expect(JSON.stringify(specs.get('create_watch')?.inputSchema)).toContain('"mode"');
  });
});
