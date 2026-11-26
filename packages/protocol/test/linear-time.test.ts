import { describe, expect, it } from 'vitest';
import { approvalHints } from '../src/approval-details.js';
import { classifyToolCall } from '../src/continuity.js';
import { clipTitle } from '../src/job-title.js';
import { parseStepOutcome } from '../src/step-outcome.js';

/**
 * Untrusted agent / user text that used to hit polynomial regex backtracking (each case took several seconds before):
 * every call must now finish quickly.
 */
const N = 64 * 1024;

function fast<T>(f: () => T): T {
  const started = performance.now();
  const out = f();
  expect(performance.now() - started).toBeLessThan(1_000);
  return out;
}

describe('linear time on pathological input', () => {
  it('clipTitle: a long run of separators that is not at the end', () => {
    expect(fast(() => clipTitle(`${'\t'.repeat(N)}a`))).toHaveLength(1);
    expect(clipTitle('Fix the login form -- ,')).toBe('Fix the login form');
  });

  it('classifyToolCall: whitespace around a shell separator', () => {
    expect(fast(() => classifyToolCall('bash', `ls${' '.repeat(N)}x`))).toBeTypeOf('string');
    expect(classifyToolCall('bash', 'ls   &&   pwd')).toBe(classifyToolCall('bash', 'ls&&pwd'));
  });

  it('parseStepOutcome: whitespace after OUTCOME: and before an unmatched line separator', () => {
    expect(fast(() => parseStepOutcome(`OUTCOME:${' '.repeat(60_000)}`))).toBeNull();
    expect(fast(() => parseStepOutcome(`OUTCOME: ok${' '.repeat(60_000)}x\u2028y`))).toBeNull();
    expect(parseStepOutcome('**OUTCOME:** partial — tests left')).toMatchObject({
      kind: 'partial',
      note: 'tests left',
    });
  });

  it('approvalHints: trailing punctuation of a URL and trailing slashes of a path', () => {
    const h = fast(() =>
      approvalHints({
        tool: 'bash',
        command: `curl https://example.com/a${'!'.repeat(N)}b`,
        shell: 'posix',
        paths: [`/tmp${'/'.repeat(N)}x`],
        workspaceRoot: '/work',
      }),
    );
    expect(h.reaches[0]?.startsWith('https://example.com/a!')).toBe(true);
    expect(h.outside).toHaveLength(1);
    expect(
      approvalHints({ tool: 'bash', command: 'curl https://example.com/a.', shell: 'posix' }).reaches,
    ).toEqual(['https://example.com/a']);
  });
});
