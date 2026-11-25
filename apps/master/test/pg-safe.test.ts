import { describe, expect, it } from 'vitest';
import { pgSafe } from '../src/workers/pg-safe.js';

describe('pgSafe (worker values Postgres can store)', () => {
  it('replaces NUL bytes and lone surrogates at any depth, keys included', () => {
    const out = pgSafe({
      type: 'LOG_CHUNK',
      payload: { text: 'a\u0000b', lines: ['ok', 'x\uD800y'], ['k\u0000']: 1, n: 3, flag: true, nil: null },
    });
    expect(out.payload.text).toBe('a�b');
    expect(out.payload.lines).toEqual(['ok', 'x�y']);
    expect(out.payload).toHaveProperty(['k�'], 1);
    expect(out.payload).not.toHaveProperty(['k\u0000']);
    expect(out.payload.n).toBe(3);
    expect(out.payload.flag).toBe(true);
    expect(out.payload.nil).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/\\u0000|\\ud800/i);
  });

  it('returns the same object when nothing needs fixing', () => {
    const msg = { payload: { text: 'Türkçe ✓ 😀', list: [1, 'a'] } };
    expect(pgSafe(msg)).toBe(msg);
  });

  it('does not mutate the original', () => {
    const msg = { payload: { text: 'a\u0000' } };
    pgSafe(msg);
    expect(msg.payload.text).toBe('a\u0000');
  });
});
