import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/** p18-plan-mode (docs/design/p18-plan-mode.md §5): rule 52 — when to propose planning and how plans are executed. */
describe('assistant planning rule (p18-plan-mode)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = rules.find((l) => l.startsWith('52. ')) ?? '';

  it('names every plan tool that exists in the catalog', () => {
    for (const t of [
      'plan_propose',
      'plan_create',
      'plan_update_items',
      'plan_ask_decision',
      'plan_set_status',
      'plan_set_state',
      'plan_read',
    ]) {
      expect(rule).toContain(t);
      expect(ASSISTANT_TOOL_NAMES).toContain(t);
    }
  });

  it('says when to propose, never to enter by itself, read-only planning and one item at a time', () => {
    expect(rule).toMatch(/3 or more side-effecting actions/);
    expect(rule).toMatch(/never enter plan mode yourself/);
    expect(rule).toMatch(/you only read/);
    expect(rule).toMatch(/one assistant item at a time/);
    expect(rule).toMatch(/planItem/);
    expect(rule).toMatch(/re-plan with plan_update_items and a reason/);
  });

  it('p18-assistant-gaps: matches plan autonomy — runs directly in an autonomous plan, cards otherwise', () => {
    expect(rule).toMatch(
      /autonomous: true\) the platform runs the drafts of its continuation turns directly/,
    );
    expect(rule).toMatch(/never ask the user to confirm a card that ran/);
    expect(rule).toMatch(/A non-autonomous plan keeps cards/);
    expect(rule).toMatch(/In the user's own turns rule 2 applies/);
    expect(rule).toMatch(/job and workflow items without unmet dependsOn may run in parallel/);
    expect(rule).not.toMatch(/Approval of a plan grants nothing/);
  });
});
