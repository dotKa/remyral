import { RuntimeCrashedError } from '@remyral/agent-adapters';
import { describe, expect, it } from 'vitest';
import { crashFailureOf, crashMessage, crashResultFailure } from '../src/jobs/crash-report.js';

describe('p22-runtime-diagnostics: the JOB_RESULT error of a runtime crash', () => {
  const now = new Date('2026-11-01T10:00:00Z');

  it('a start-up crash carries its cause, exit and stderr tail', () => {
    const err = new RuntimeCrashedError(
      'claude-code',
      { code: 137, signal: null },
      'Claude Code process exited with code 137',
      { cause: 'killed', exit: { code: 137, signal: null }, stderrTail: 'line a\nline b' },
    );
    const f = crashFailureOf(err, now);
    expect(f).toMatchObject({ code: 'runtime_crashed', params: { cause: 'killed' } });
    expect(f?.message).toContain('exit code 137');
    expect(f?.message).not.toContain('exit unknown');
    expect(f?.message).toContain('stderr (last lines):\nline a\nline b');
  });

  it('a usage limit at start-up becomes provider_usage_limit (the fallback path, not a retry)', () => {
    const err = new RuntimeCrashedError(
      'claude-code',
      { code: 1, signal: null },
      'Claude Code process exited with code 1. stderr: Claude AI usage limit reached|1793545200',
      { cause: 'usage_limit', exit: { code: 1, signal: null }, stderrTail: '' },
    );
    const f = crashFailureOf(err, now);
    expect(f?.code).toBe('provider_usage_limit');
    expect(f?.usageLimit?.resetAt?.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('other errors and undiagnosed crashes keep the old path', () => {
    expect(crashFailureOf(new Error('x'), now)).toBeNull();
    expect(crashFailureOf(new RuntimeCrashedError('claude-code', undefined, 'x'), now)).toBeNull();
  });

  it('a mid-run crash and the message bound', () => {
    const f = crashResultFailure({ cause: 'out_of_memory', stderrTail: 'heap' }, 'Claude Code ended');
    expect(f).toMatchObject({ code: 'runtime_crashed', params: { cause: 'out_of_memory' } });
    const long = crashMessage('x'.repeat(5000), { cause: 'unknown', stderrTail: '' });
    expect(long.length).toBeLessThanOrEqual(1900);
  });
});
