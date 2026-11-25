import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/** p17-ui-batch: owner rule — the assistant never writes a circumflex in Turkish (rule 48). */
describe('Turkish spelling without circumflex (p17-ui-batch)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');

  it('rule 48 forbids â / î / û and names the plain spellings; one short line', () => {
    const r48 = rules.find((l) => l.startsWith('48. ')) ?? '';
    expect(r48).toMatch(/never write a circumflex/);
    expect(r48).toContain('â');
    for (const word of ['"hala"', '"zeka"', '"haliyle"', '"kağıt"']) expect(r48).toContain(word);
    // The examples themselves carry no circumflex.
    expect(r48.slice(r48.indexOf('write "'))).not.toMatch(/[âîûÂÎÛ]/);
    expect(r48.length).toBeLessThan(200);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    // p17-chat-github: later rules (49 titles, 50 projects) follow it.
    expect(Number(numbers.at(-1))).toBeGreaterThanOrEqual(48);
  });
});
