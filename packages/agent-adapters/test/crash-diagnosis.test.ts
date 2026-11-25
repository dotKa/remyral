import { describe, expect, it } from 'vitest';
import {
  boundedStderrTail,
  crashDiagnosis,
  describeExit,
  diagnoseCrash,
  exitFromError,
  isTransientCrash,
  RuntimeCrashedError,
} from '../src/index.js';

describe('p22-runtime-diagnostics: exitFromError', () => {
  it('reads the SDK message and its tags', () => {
    expect(exitFromError(new Error('Claude Code process exited with code 137. stderr: x'))).toEqual({
      code: 137,
      signal: null,
    });
    expect(exitFromError(new Error('Claude Code process terminated by signal SIGTERM'))).toEqual({
      code: null,
      signal: 'SIGTERM',
    });
    expect(exitFromError(Object.assign(new Error('boom'), { exitCode: 3 }))).toEqual({
      code: 3,
      signal: null,
    });
    expect(exitFromError(Object.assign(new Error('boom'), { signal: 'not a signal' }))).toBeUndefined();
    expect(exitFromError(new Error('something else'))).toBeUndefined();
  });
});

describe('p22-runtime-diagnostics: diagnoseCrash', () => {
  const none = { code: null, signal: null };
  it('login and usage limits win over the exit', () => {
    expect(
      diagnoseCrash({ exit: { code: 1, signal: null }, text: 'Invalid API key · Please run /login' }),
    ).toBe('login');
    expect(diagnoseCrash({ exit: none, text: 'Claude AI usage limit reached|1767225600' })).toBe(
      'usage_limit',
    );
  });
  it('memory, provider, network, signals', () => {
    expect(
      diagnoseCrash({
        exit: { code: 134, signal: null },
        text: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      }),
    ).toBe('out_of_memory');
    expect(diagnoseCrash({ exit: { code: -1073741801, signal: null }, text: '' })).toBe('out_of_memory');
    expect(diagnoseCrash({ exit: { code: 1, signal: null }, text: 'API Error: 529 overloaded_error' })).toBe(
      'provider_overloaded',
    );
    expect(
      diagnoseCrash({ exit: { code: 1, signal: null }, text: 'getaddrinfo ENOTFOUND api.anthropic.com' }),
    ).toBe('network');
    expect(diagnoseCrash({ exit: { code: null, signal: 'SIGKILL' }, text: '' })).toBe('killed');
    expect(diagnoseCrash({ exit: { code: 137, signal: null }, text: '' })).toBe('killed');
    expect(diagnoseCrash({ exit: { code: 1, signal: null }, text: 'error: unknown option --foo' })).toBe(
      'unknown',
    );
    expect(diagnoseCrash({ exit: undefined, text: '' })).toBe('unknown');
  });
  it('transient causes are the ones the automatic retry takes', () => {
    expect(isTransientCrash('killed')).toBe(true);
    expect(isTransientCrash('network')).toBe(true);
    expect(isTransientCrash('login')).toBe(false);
    expect(isTransientCrash('usage_limit')).toBe(false);
  });
});

describe('p22-runtime-diagnostics: the stderr tail is bounded', () => {
  it('keeps the newest lines within the limits', () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join('\n');
    const tail = boundedStderrTail(many);
    expect(tail.split('\n')).toHaveLength(20);
    expect(tail.endsWith('line 99')).toBe(true);
    const long = boundedStderrTail('y'.repeat(10_000));
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(boundedStderrTail(undefined)).toBe('');
  });
  it('a diagnosis carries the exit and the tail', () => {
    const d = crashDiagnosis({ code: 1, signal: null }, 'a\n\nb\n', 'Claude Code process exited with code 1');
    expect(d).toEqual({ cause: 'unknown', exit: { code: 1, signal: null }, stderrTail: 'a\nb' });
  });
});

describe('p22-runtime-diagnostics: describeExit', () => {
  it('names code, signal, NTSTATUS in hex and unknown', () => {
    expect(describeExit({ code: 2, signal: null })).toBe('exit code 2');
    expect(describeExit({ code: null, signal: 'SIGKILL' })).toBe('signal SIGKILL');
    expect(describeExit({ code: 3221225477, signal: null })).toBe('exit code 0xC0000005');
    expect(describeExit({ code: null, signal: null })).toBe('exit unknown');
    expect(describeExit(undefined)).toBe('exit unknown');
  });
  it('RuntimeCrashedError keeps the diagnosis', () => {
    const e = new RuntimeCrashedError('claude-code', { code: 1, signal: null }, 'x', {
      cause: 'network',
      stderrTail: '',
    });
    expect(e.diagnosis?.cause).toBe('network');
    expect(e.message).toBe('claude-code: runtime crashed (exit code 1): x');
  });
});
