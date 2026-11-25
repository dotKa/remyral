import {
  ASSISTANT_TOOLS,
  assistantToolDescription,
  assistantToolInput,
  assistantToolJsonSchema,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs, isAssistantToolName } from '../src/assistant-kit.js';

/**
 * p8-templates: the engines register list_templates and draft_from_template like every platform tool; the inputs
 * carry no policy field (a parameter can never set the sandbox, approval policy, model or limits), and the system
 * prompt tells the model to use a matching template and say which one.
 */
describe('assistant template tools (p8-templates)', () => {
  it('registers the tools with strict schemas and no policy fields', () => {
    const specs = assistantToolSpecs();
    for (const name of ['list_templates', 'draft_from_template'] as const) {
      expect(isAssistantToolName(name)).toBe(true);
      expect(specs.find((s) => s.name === name)?.description).toBe(assistantToolDescription(name));
    }
    expect(ASSISTANT_TOOLS.draft_from_template.kind).toBe('draft');
    expect(ASSISTANT_TOOLS.list_templates.kind).toBe('read');
    const schema = JSON.stringify(assistantToolJsonSchema('draft_from_template'));
    for (const field of ['sandboxProfile', 'approvalPolicy', 'modelProfile', 'runtime', 'maxDurationSec']) {
      expect(schema).not.toContain(`"${field}"`);
    }
    const input = assistantToolInput('draft_from_template');
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      input.safeParse({ templateId: id, params: { url: 'https://a.example', count: 3, on: true } }).success,
    ).toBe(true);
    expect(input.safeParse({ templateId: id, approvalPolicy: 'allow-all' }).success).toBe(false);
    expect(input.safeParse({ templateId: id, params: { 'Bad Name': 'x' } }).success).toBe(false);
    expect(input.safeParse({ templateId: id, params: { nested: { a: 1 } } }).success).toBe(false);
    const auto = assistantToolInput('draft_automation');
    expect(
      auto.safeParse({
        project: 'acme',
        name: 'n',
        trigger: { kind: 'cron', cron: '0 3 * * *' },
        template: { templateId: id },
      }).success,
    ).toBe(true);
  });

  it('the system prompt says to use a matching template, name it, and keep settings out of parameters', () => {
    const p = ASSISTANT_SYSTEM_PROMPT;
    expect(p).toContain('18. Saved job templates');
    expect(p).toContain('şablonu çalıştır');
    expect(p).toMatch(/use draft_from_template/);
    expect(p).toMatch(/say which template \(title and version\)/);
    expect(p).toMatch(/do not try to change them through parameters/);
  });
});
