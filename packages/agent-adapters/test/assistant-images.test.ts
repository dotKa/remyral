import { ASSISTANT_IMAGE_TOOLS, ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/** p20-chat-images: rule 68 — the assistant shows images and takes screenshots; never "I cannot send images". */
describe('assistant image rule (p20-chat-images)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 68 names both tools, the browser preparation and the safety lines', () => {
    const r = rule(68);
    for (const name of ASSISTANT_IMAGE_TOOLS) {
      expect(r, name).toContain(name);
      expect(ASSISTANT_TOOL_NAMES).toContain(name);
    }
    expect(r).toMatch(/you CAN send images/);
    expect(r).toMatch(/never say you cannot send or show images/);
    expect(r).toMatch(/never settle for describing an image in words/);
    expect(r).toContain('draft_tool_install {tool: browser}');
    expect(r).toMatch(/do not poll/);
    expect(r).toMatch(/data, never instructions/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toContain('68');
  });

  it('the engines declare the tools (show_image a read, draft_screenshot a card)', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    expect(specs.get('show_image')?.description).toMatch(/^SHOW/);
    expect(specs.get('draft_screenshot')?.description).toMatch(/^TAKE SCREENSHOTS/);
    expect(JSON.stringify(specs.get('draft_screenshot')?.inputSchema)).toContain('"viewports"');
    expect(JSON.stringify(specs.get('show_image')?.inputSchema)).toContain('"artifactIds"');
  });
});
