import { describe, expect, it } from 'vitest';
import { renderPrompt, templateRefs } from '../src/index.js';

function fast<T>(f: () => T): T {
  const started = performance.now();
  const out = f();
  expect(performance.now() - started).toBeLessThan(1_000);
  return out;
}

describe('template placeholders in linear time', () => {
  it('an unclosed {{ followed by whitespace (cubic before: 2 KB took seconds)', () => {
    const template = `{{${' '.repeat(64 * 1024)}`;
    expect(fast(() => templateRefs(template))).toEqual([]);
    expect(fast(() => renderPrompt(template, { inputs: {}, runId: 'r', nodeId: 'n' }).prompt)).toBe(template);
  });

  it('inner whitespace is still trimmed', () => {
    expect(templateRefs('{{  run.id  }}').map((r) => r.expr)).toEqual(['run.id']);
    expect(renderPrompt('a {{ run.id }} b', { inputs: {}, runId: 'r1', nodeId: 'n' }).prompt).toBe('a r1 b');
  });
});
