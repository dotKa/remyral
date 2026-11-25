import { describe, expect, it } from 'vitest';
import { Redactor, SecretSet, StreamRedactor } from '../src/index.js';
import { CANARY, CANARY_LINES, body } from './canaries.js';

function runStream(red: Redactor, chunks: readonly string[], maxHold?: number): string {
  const s = new StreamRedactor(red, maxHold === undefined ? {} : { maxHold });
  let out = '';
  for (const c of chunks) out += s.push(c);
  return out + s.end();
}

function splitAt(text: string, cuts: readonly number[]): string[] {
  const out: string[] = [];
  let prev = 0;
  for (const c of [...cuts].sort((a, b) => a - b)) {
    out.push(text.slice(prev, c));
    prev = c;
  }
  out.push(text.slice(prev));
  return out;
}

/** Tiny deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % n;
  };
}

describe('StreamRedactor', () => {
  const secrets = new SecretSet();
  const exact = `db-${body(30, 99)}`;
  secrets.add(exact, 'DB_PASSWORD');
  const red = new Redactor({ secrets });

  const canaries = [exact, ...Object.values(CANARY)];
  const doc = [`db ${exact}`, ...CANARY_LINES].map((l, i) => `line ${String(i)} ${l} end\n`).join('');

  it('matches non-streaming redaction when fed in one chunk', () => {
    expect(runStream(red, [doc])).toBe(red.redact(doc));
  });

  it('redacts a secret split at every possible boundary (two chunks)', () => {
    const text = `prefix ${exact} suffix`;
    const start = text.indexOf(exact);
    for (let cut = start; cut <= start + exact.length; cut++) {
      const out = runStream(red, splitAt(text, [cut]));
      expect(out, `cut at ${String(cut)}`).toBe('prefix [REDACTED:DB_PASSWORD] suffix');
    }
  });

  it('redacts pattern tokens split character by character', () => {
    for (const canary of [CANARY.anthropic, CANARY.ghp, CANARY.jwt, CANARY.awsKeyId, CANARY.pem]) {
      const text = `before ${canary} after`;
      const out = runStream(
        red,
        Array.from({ length: text.length }, (_, i) => text.charAt(i)),
      );
      expect(out).not.toContain(canary);
      expect(out.startsWith('before [REDACTED:')).toBe(true);
      expect(out.endsWith(' after')).toBe(true);
    }
  });

  it('property: random chunkings never leak any canary and equal the one-shot result', () => {
    const next = rng(42);
    const expected = red.redact(doc);
    for (let round = 0; round < 200; round++) {
      const cuts = Array.from({ length: 1 + next(40) }, () => next(doc.length));
      const out = runStream(red, splitAt(doc, cuts));
      for (const c of canaries) expect(out).not.toContain(c);
      expect(out).toBe(expected);
    }
  });

  it('emits data before the end of the stream once it is past the lookbehind', () => {
    const s = new StreamRedactor(red);
    const filler = 'x'.repeat(red.lookbehind() * 2);
    const out = s.push(filler);
    expect(out.length).toBe(filler.length - red.lookbehind());
    expect(s.pendingLength).toBe(red.lookbehind());
    expect(out + s.end()).toBe(filler);
  });

  it('force-closes an over-long open secret and swallows its continuation', () => {
    // A PEM block whose END arrives after maxHold: everything in between is swallowed.
    const maxHold = red.lookbehind() + 100;
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const keyBody = body(maxHold * 3, 7);
    const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const chunks = [`a ${begin}\n`, ...splitAt(keyBody, [100, 900, 1500, 2500]), `\n${end} tail`];
    const out = runStream(red, chunks, maxHold);
    expect(out).toBe('a [REDACTED:pem-private-key] tail');
  });

  it('force-closes an over-long token and swallows the rest of it', () => {
    const maxHold = red.lookbehind() + 10;
    const token = `ghp_${body(maxHold * 2, 3, 'abcdefghij0123456789')}`;
    const out = runStream(red, [`x ${token.slice(0, maxHold)}`, token.slice(maxHold), ' y'], maxHold);
    expect(out).toBe('x [REDACTED:github-token] y');
  });

  it('a truncated stream ending inside a PEM block still redacts', () => {
    const out = runStream(red, ['ok ', CANARY.pem.slice(0, 50)]);
    expect(out).toBe('ok [REDACTED:pem-private-key]');
  });

  it('rejects use after end and a maxHold smaller than the lookbehind', () => {
    const s = new StreamRedactor(red);
    s.end();
    expect(() => s.push('x')).toThrow();
    expect(() => new StreamRedactor(red, { maxHold: 10 })).toThrow(RangeError);
  });
});
