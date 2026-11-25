import { describe, expect, it } from 'vitest';
import { stderrHint } from '../src/runtimes/claude-code/adapter.js';

describe('stderrHint (why the Claude Code CLI exited)', () => {
  it('keeps the last non-empty lines on one line', () => {
    expect(stderrHint('\nfirst\n\nerror: unknown option --foo\r\n')).toBe(
      'first | error: unknown option --foo',
    );
  });
  it('is empty without stderr and bounded for long output', () => {
    expect(stderrHint('')).toBe('');
    const long = stderrHint('x'.repeat(5000));
    expect(long.length).toBeLessThanOrEqual(601);
    expect(long.startsWith('…')).toBe(true);
  });
});
