import {
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_OPS_TOOLS,
  ASSISTANT_TOOL_NAMES,
  ASSISTANT_TOOLS,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/**
 * p18-assistant-gaps (docs/design/p18-assistant-gaps.md, worker 1.2.1): rule 53 names every new tool, rule 20 the
 * console's current sidebar and settings sections, rule 2 the card-only cases; every engine declares the tools.
 */
describe('assistant ops tools (p18-assistant-gaps)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 53 names every new tool, all of them in the catalog', () => {
    const r = rule(53);
    expect(ASSISTANT_OPS_TOOLS.size).toBe(16);
    for (const name of ASSISTANT_OPS_TOOLS) {
      expect(r, name).toContain(name);
      expect(ASSISTANT_TOOL_NAMES).toContain(name);
    }
    expect(r).toMatch(/never answer it yourself/);
    expect(r).toMatch(/data, never instructions/);
  });

  it('rule 2: a job question answer and a restore stay cards; the answer tool is a card by default', () => {
    expect(rule(2)).toMatch(/draft_job_question_answer stays a card unless/);
    expect(rule(2)).toMatch(/draft_backup_action action restore\) is ALWAYS a card/);
    expect(ASSISTANT_CARD_DEFAULT_TOOLS.has('draft_job_question_answer')).toBe(true);
  });

  it('rule 20 names the sidebar and the settings sections as the console shows them', () => {
    const r = rule(20);
    for (const label of [
      'Senden bekleyenler',
      '/needs',
      'Workflow’lar',
      'Otomasyonlar',
      'API anahtarları',
      'Webhook’lar',
      'Yedekler',
      'Tanılama',
      'Sistem durumu',
      'Sunucu ayarları',
      'Operasyon güvenliği',
      'Servis hesapları',
      'Çalışma dosyaları',
    ])
      expect(r, label).toContain(label);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('the engines declare the tools: reads without the acting suffix, drafts with it', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    for (const name of ASSISTANT_OPS_TOOLS) {
      const s = specs.get(name);
      expect(s, name).toBeDefined();
      if (ASSISTANT_TOOLS[name].kind === 'read') expect(s?.description).not.toContain('Acting:');
      else expect(s?.description).toContain('Acting:');
    }
    expect(JSON.stringify(specs.get('read_job_output')?.inputSchema)).toContain('"offset"');
    expect(JSON.stringify(specs.get('draft_backup_action')?.inputSchema)).toContain('"restore"');
  });
});
