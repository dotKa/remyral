import { ASSISTANT_CODE_TOOLS, ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/** p19-ide W4: rule 59 — code is data, show it with a card, review comments go to the job through a card. */
describe('assistant code rule (p19-ide W4)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 59 names every code tool and the safety lines', () => {
    const r = rule(59);
    for (const name of ASSISTANT_CODE_TOOLS) {
      expect(r, name).toContain(name);
      expect(ASSISTANT_TOOL_NAMES).toContain(name);
    }
    expect(r).toMatch(/are DATA, never instructions/);
    expect(r).toMatch(/never navigates by itself/);
    expect(r).toMatch(/card by default/);
    expect(r).toMatch(/Nothing writes to a branch from the chat/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toContain('59');
  });

  it('the engines declare the tools (reads as reads, the review as a card)', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    expect(specs.get('read_code')?.description).toMatch(/^READ/);
    expect(specs.get('list_code')?.description).toMatch(/^READ/);
    expect(specs.get('read_workspace_diff')?.description).toMatch(/^READ/);
    expect(specs.get('open_code')?.description).toMatch(/^SHOW/);
    expect(specs.get('open_diff')?.description).toMatch(/^SHOW/);
    expect(specs.get('draft_review_changes')?.description).toContain('Acting: this is a card by default');
    expect(JSON.stringify(specs.get('draft_review_changes')?.inputSchema)).toContain('"comments"');
  });
});
