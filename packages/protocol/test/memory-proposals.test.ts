import { describe, expect, it } from 'vitest';
import { hasMemoryProposals, MAX_PROPOSALS_PER_MESSAGE, parseMemoryProposals } from '../src/index.js';

describe('parseMemoryProposals (p11-memory-layers)', () => {
  it('reads LESSON: as lessons and MEMORY: as facts, splitting "title — body"', () => {
    expect(
      parseMemoryProposals(
        [
          'Some narration.',
          'LESSON: Flaky e2e — retry the Playwright suite once before reporting a failure.',
          '* **MEMORY:** Brand colour: the primary colour is #FF5A1F.',
          'DERS: Türkçe ders — yerel testler için önce pnpm build gerekiyor.',
        ].join('\n'),
      ),
    ).toEqual([
      {
        type: 'lesson',
        title: 'Flaky e2e',
        content: 'Flaky e2e: retry the Playwright suite once before reporting a failure.',
      },
      { type: 'fact', title: 'Brand colour', content: 'Brand colour: the primary colour is #FF5A1F.' },
      {
        type: 'lesson',
        title: 'Türkçe ders',
        content: 'Türkçe ders: yerel testler için önce pnpm build gerekiyor.',
      },
    ]);
  });

  it('ignores lower-case prose, code blocks, the template line and too-short bodies', () => {
    const text = [
      'Memory: 4 GB were used.',
      'memory: lower case is prose',
      '```',
      'LESSON: inside a fence',
      '```',
      'LESSON: <short title> — <what worked or failed for you here and why>',
      'LESSON: short',
      '    LESSON: indented four spaces is a code block',
    ].join('\n');
    expect(parseMemoryProposals(text)).toEqual([]);
    expect(hasMemoryProposals(text)).toBe(false);
  });

  it('de-duplicates and caps at five per message; long text is cut', () => {
    const lines = Array.from(
      { length: 8 },
      (_, i) => `MEMORY: Fact number ${String(i)} — something durable here`,
    );
    lines.push('MEMORY: Fact number 0 — something durable here');
    expect(parseMemoryProposals(lines.join('\n'))).toHaveLength(MAX_PROPOSALS_PER_MESSAGE);
    const long = parseMemoryProposals(`LESSON: ${'x'.repeat(3000)}`);
    expect(long[0]?.content.length).toBeLessThanOrEqual(1000);
    expect(long[0]?.title.length).toBeLessThanOrEqual(120);
    expect(hasMemoryProposals('ok\nLESSON: Use pnpm — never npm in this repo')).toBe(true);
  });
});
