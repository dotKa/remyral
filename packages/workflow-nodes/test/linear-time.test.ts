import { describe, expect, it } from 'vitest';
import { configExpressions, containsExpression, hasTemplate, TemplateString } from '../src/index.js';

function fast<T>(f: () => T): T {
  const started = performance.now();
  const out = f();
  expect(performance.now() - started).toBeLessThan(1_000);
  return out;
}

describe('template detection in linear time', () => {
  const unclosed = '{{'.repeat(128 * 1024);

  it('many unclosed {{ in a config value', () => {
    expect(fast(() => containsExpression({ a: [unclosed] }))).toBe(false);
    expect(fast(() => configExpressions({ a: unclosed }))).toEqual([]);
    // zod runs the pattern even on a value over the length limit.
    expect(fast(() => TemplateString.safeParse(unclosed).success)).toBe(false);
  });

  it('same answers as `/\\{\\{[\\s\\S]*?\\}\\}/`', () => {
    const lazy = /\{\{[\s\S]*?\}\}/;
    for (const s of [
      '{{a}}',
      'x {{ y }} z',
      '{{}}',
      '{{}',
      '}}{{',
      '{{{}}}',
      'a{\n{b}}',
      '{ {a}}',
      'a{{b{{c}}',
      '',
    ]) {
      expect(hasTemplate(s)).toBe(lazy.test(s));
      expect(TemplateString.safeParse(s).success).toBe(lazy.test(s));
    }
  });
});
