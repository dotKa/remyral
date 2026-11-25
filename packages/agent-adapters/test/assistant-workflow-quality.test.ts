import { assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/**
 * p16-workflow-quality: rule 38 (one valid workflow draft, validate first, defaults left out, IANA zones, triggers
 * active only after the card, AI steps without a repository), the validate_workflow / workflow_guide read tools and
 * the zone of drafted schedules.
 */
describe('workflow drafting rules and tools (p16-workflow-quality)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 38: validate first, one valid card, defaults and zones, active triggers, no repository needed', () => {
    const r = rule(38);
    for (const s of [
      'validate_workflow',
      'workflow_guide',
      'draft_workflow',
      'never shown as a card',
      'timezone',
    ])
      expect(r).toContain(s);
    expect(r).toMatch(/Leave defaults out/);
    expect(r).toMatch(/only while the workflow is active/);
    expect(r).toMatch(/trigger\.manual/);
    expect(r).toMatch(/never replace an AI step with a fixed list/);
    expect(r).toMatch(/needsRepository/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(Math.max(...numbers.map(Number))).toBeGreaterThanOrEqual(38);
    // Rule 11 no longer pins cron to UTC.
    expect(rule(11)).toContain('timeZone');
    expect(rule(11)).not.toContain('cron in UTC');
  });

  it('validate_workflow and workflow_guide are reads (no acting suffix); draft_workflow says one valid draft', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    for (const name of ['validate_workflow', 'workflow_guide'] as const) {
      const s = specs.get(name);
      expect(s, name).toBeDefined();
      expect(s?.description).not.toContain('Acting:');
    }
    expect(JSON.stringify(specs.get('validate_workflow')?.inputSchema)).toContain('"definition"');
    expect(JSON.stringify(specs.get('workflow_guide')?.inputSchema)).toContain('"topic"');
    const draft = specs.get('draft_workflow');
    expect(draft?.description).toContain('ONE VALID DRAFT');
    expect(draft?.description).toContain('Leave "defaults" out');
    expect(draft?.description).toContain('ACTIVE');
    const schema = JSON.stringify(draft?.inputSchema);
    expect(schema).toContain('"activate"');
    expect(schema).toContain('"dryRun"');
    expect(specs.get('workflow_node_catalog')?.description).toContain('startsRuns');
  });

  it('a workflow without defaults and schedules with an IANA zone pass the input schemas', () => {
    expect(
      assistantToolInput('draft_workflow').safeParse({
        project: 'p',
        definition: {
          schemaVersion: 2,
          name: 'hourly',
          nodes: [
            { id: 's', type: 'trigger.schedule', config: { cron: '0 * * * *', timezone: 'Europe/Istanbul' } },
          ],
          edges: [],
        },
        activate: true,
      }).success,
    ).toBe(true);
    const auto = assistantToolInput('draft_automation');
    expect(
      auto.safeParse({
        project: 'p',
        name: 'hourly',
        trigger: { kind: 'cron', cron: '0 * * * *', timeZone: 'Europe/Istanbul' },
        workflowId: '7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b',
      }).success,
    ).toBe(true);
    expect(
      auto.safeParse({
        project: 'p',
        name: 'once',
        trigger: { kind: 'at', at: '2026-10-24T09:00:00', timeZone: 'Europe/Istanbul' },
        workflowId: '7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b',
      }).success,
    ).toBe(true);
    expect(assistantToolInput('workflow_guide').safeParse({ topic: 'triggers' }).success).toBe(true);
    expect(assistantToolInput('workflow_guide').safeParse({ topic: 'nope' }).success).toBe(false);
  });
});
