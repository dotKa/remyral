import { describe, expect, it } from 'vitest';
import { DeferredOwnedProcess, InvalidSpawnContextError, SecretValue } from '../../src/index.js';
import { ApprovalBroker } from '../../src/runtimes/session-kit/approval-broker.js';
import { assertSecretEnvForAuthMode } from '../../src/runtimes/session-kit/auth.js';
import { boundedText, summarize } from '../../src/runtimes/session-kit/text.js';

describe('ApprovalBroker (fail-closed approvals)', () => {
  it('only an explicit human approve approves', async () => {
    const b = new ApprovalBroker(1_000);
    const p = b.wait('a1');
    expect(b.decide({ approvalId: 'a1', decision: 'approve', decidedBy: 'alice', reason: 'ok' })).toBe(true);
    expect(await p).toEqual({ decision: 'approve', cause: 'human', decidedBy: 'alice', reason: 'ok' });
    expect(b.decide({ approvalId: 'a1', decision: 'approve', decidedBy: 'alice' })).toBe(false);
  });

  it('times out to deny', async () => {
    const b = new ApprovalBroker(20);
    expect(await b.wait('a2')).toEqual({ decision: 'deny', cause: 'timeout' });
    expect(b.size).toBe(0);
  });

  it('abort and denyAll deny; duplicate ids are refused', async () => {
    const b = new ApprovalBroker(1_000);
    const ac = new AbortController();
    const p1 = b.wait('a3', ac.signal);
    await expect(b.wait('a3')).rejects.toThrow(/already pending/);
    ac.abort();
    expect(await p1).toEqual({ decision: 'deny', cause: 'aborted' });
    const p2 = b.wait('a4');
    b.denyAll('session-ended');
    expect(await p2).toEqual({ decision: 'deny', cause: 'session-ended' });
  });
});

describe('auth env policy (ADR-0014)', () => {
  const policy = { forbidden: ['CLAUDE_CODE_OAUTH_TOKEN'], providerCredentials: ['ANTHROPIC_API_KEY'] };
  it('refuses forbidden names in every mode and provider keys in local-login', () => {
    const tok = { CLAUDE_CODE_OAUTH_TOKEN: new SecretValue('t') };
    const key = { ANTHROPIC_API_KEY: new SecretValue('k') };
    expect(() => {
      assertSecretEnvForAuthMode('claude-code', 'secret-ref', tok, policy);
    }).toThrow(InvalidSpawnContextError);
    expect(() => {
      assertSecretEnvForAuthMode('claude-code', 'local-login', key, policy);
    }).toThrow(InvalidSpawnContextError);
    expect(() => {
      assertSecretEnvForAuthMode('claude-code', 'secret-ref', key, policy);
    }).not.toThrow();
  });
});

describe('text helpers', () => {
  it('redacts and bounds', () => {
    const s = { K: new SecretValue('abc123secret') };
    expect(boundedText('x abc123secret y', s)).toBe('x [REDACTED] y');
    expect(boundedText('a'.repeat(50), {}, 10)).toHaveLength(10);
    expect(summarize({ a: '1\n2' }, {})).toBe('{"a":"1\\n2"}');
  });
});

describe('DeferredOwnedProcess', () => {
  it('a failed start surfaces as error + exit, never hangs the SDK', async () => {
    const proc = new DeferredOwnedProcess(() => Promise.reject(new Error('confiner refused')), 100);
    const errors: Error[] = [];
    proc.on('error', (e) => errors.push(e));
    const exit = new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => {
        resolve(code);
      });
    });
    expect(await exit).toBe(1);
    expect(errors.map((e) => e.message)).toEqual(['confiner refused']);
    expect(proc.exitCode).toBe(1);
    expect(proc.kill('SIGTERM')).toBe(false);
  });
});
