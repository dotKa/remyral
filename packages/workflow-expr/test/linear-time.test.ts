import { describe, expect, it } from 'vitest';
import { isTemplate, templateParts } from '../src/index.js';

function fast<T>(f: () => T): T {
  const started = performance.now();
  const out = f();
  expect(performance.now() - started).toBeLessThan(1_000);
  return out;
}

describe('template scanning in linear time', () => {
  it('many unclosed {{ (each rescanned the rest of the text before)', () => {
    const text = '{{'.repeat(256 * 1024);
    expect(fast(() => isTemplate(text))).toBe(false);
    expect(fast(() => templateParts(text))).toEqual([{ literal: text, expr: null }]);
  });

  it('splits like the lazy `{{ … }}` regex', () => {
    expect(templateParts('a {{ x }} b {{{y}}} c {{ z')).toEqual([
      { literal: 'a ', expr: 'x' },
      { literal: ' b ', expr: '{y' },
      { literal: '} c {{ z', expr: null },
    ]);
    expect(isTemplate('}} {{')).toBe(false);
    expect(isTemplate('{{}}')).toBe(true);
  });
});
