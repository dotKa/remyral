import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p16-doctor (docs/design/p16-doctor.md §7): rule 46 sends the model to run_diagnostics before it answers "what is
 * wrong", names the machine-side `remyral-worker doctor`, drafts the support report with the user's own words, keeps job
 * prompts out unless agreed, follows the security policy and forbids claiming a send without a result.
 */
describe('diagnostics through the chat (p16-doctor)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = rules.find((l) => l.startsWith('46. ')) ?? '';

  it('rule 46 names the tools, the machine CLI, the prompts boundary and the policy', () => {
    expect(rule).toContain('run_diagnostics');
    expect(rule).toContain('draft_support_report');
    expect(rule).toContain('remyral-worker doctor');
    expect(rule).toContain('/settings/diagnostics');
    expect(rule).toMatch(/job_prompts/);
    expect(rule).toMatch(/support\.report/);
    expect(rule).toMatch(/never claim it was sent unless the result says so/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
