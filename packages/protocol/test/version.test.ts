import { describe, expect, it } from 'vitest';
import { ProtocolVersion, negotiateProtocolVersion } from '../src/index.js';

describe('negotiateProtocolVersion (ADR-0011)', () => {
  it('picks the highest common version', () => {
    expect(negotiateProtocolVersion(['1.0', '1.2', '2.0'], ['1.0', '1.2', '1.10'])).toBe('1.2');
  });

  it('compares numerically, not lexically', () => {
    expect(negotiateProtocolVersion(['1.2', '1.10'], ['1.2', '1.10'])).toBe('1.10');
  });

  it('returns undefined when nothing is shared', () => {
    expect(negotiateProtocolVersion(['2.0'], ['1.0'])).toBeUndefined();
  });

  it('defaults to this build’s supported versions', () => {
    expect(negotiateProtocolVersion(['1.0'])).toBe('1.0');
  });
});

describe('ProtocolVersion', () => {
  it.each(['1.0', '0.1', '12.34'])('accepts %s', (v) => {
    expect(ProtocolVersion.safeParse(v).success).toBe(true);
  });
  it.each(['1', '1.0.0', '01.0', 'v1.0', ''])('rejects %s', (v) => {
    expect(ProtocolVersion.safeParse(v).success).toBe(false);
  });
});
