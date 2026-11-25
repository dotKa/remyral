import { describe, expect, it } from 'vitest';
import { canonicalJson, eventHash, GENESIS_HASH, type HashedFields } from '../../src/audit/hash.js';
import { REDACTED, redactMetadata } from '../../src/audit/redact.js';

describe('redactMetadata', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redactMetadata({
      username: 'alex',
      password: 'hunter2',
      nested: { totpSecret: 'JBSWY3DP', apiKey: 'k', sessionId: 's', reason: 'bad_password', code: '123456' },
      list: [{ recoveryCode: 'abcd-efgh' }, 'plain'],
      authorization: 'Bearer x',
      csrfToken: 't',
    });
    expect(out).toEqual({
      username: 'alex',
      password: REDACTED,
      nested: {
        totpSecret: REDACTED,
        apiKey: REDACTED,
        sessionId: REDACTED,
        reason: 'bad_password',
        code: REDACTED,
      },
      list: [{ recoveryCode: REDACTED }, 'plain'],
      authorization: REDACTED,
      csrfToken: REDACTED,
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|JBSWY3DP|123456|abcd-efgh|Bearer/);
  });

  it('produces bounded, JSON-safe output', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 10; i++) {
      const next: Record<string, unknown> = {};
      cur.k = next;
      cur = next;
    }
    const out = redactMetadata({
      deep,
      long: 'x'.repeat(5000),
      nul: 'a\u0000b',
      big: 10n,
      when: new Date(0),
      nan: Number.NaN,
      fn: () => 1,
      arr: Array.from({ length: 100 }, (_, i) => i),
    });
    expect(JSON.stringify(out)).toContain('[TRUNCATED]');
    expect((out.long as string).length).toBeLessThanOrEqual(1001);
    expect(out.nul).toBe('ab');
    expect(out.big).toBe('10');
    expect(out.when).toBe('1970-01-01T00:00:00.000Z');
    expect(out.nan).toBeNull();
    expect('fn' in out).toBe(false);
    expect((out.arr as unknown[]).length).toBe(50);
  });
});

describe('canonicalJson / eventHash', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  const base: HashedFields = {
    id: '1',
    occurredAt: new Date('2026-10-12T00:00:00.000Z'),
    actorType: 'system',
    actorId: null,
    action: 'test.event',
    target: null,
    outcome: 'success',
    ip: null,
    userAgent: null,
    metadata: { a: 1, b: 'x' },
    prevHash: GENESIS_HASH,
  };

  it('is deterministic and independent of metadata key order', () => {
    expect(eventHash(base).equals(eventHash({ ...base, metadata: { b: 'x', a: 1 } }))).toBe(true);
    expect(eventHash(base)).toHaveLength(32);
  });

  it('changes when any field changes', () => {
    const h = eventHash(base);
    const variants: Partial<HashedFields>[] = [
      { id: '2' },
      { occurredAt: new Date('2026-10-12T00:00:00.001Z') },
      { actorType: 'user' },
      { actorId: 'u' },
      { action: 'test.other' },
      { target: 't' },
      { outcome: 'failure' },
      { ip: '127.0.0.1' },
      { userAgent: 'ua' },
      { metadata: { a: 2, b: 'x' } },
      { prevHash: Buffer.alloc(32, 1) },
    ];
    for (const v of variants) expect(eventHash({ ...base, ...v }).equals(h)).toBe(false);
  });
});
