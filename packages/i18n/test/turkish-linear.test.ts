import { describe, expect, it } from 'vitest';
import { withSuffix } from '../src/index.js';

describe('withSuffix in linear time', () => {
  it('long digit and punctuation runs that are not at the end', () => {
    for (const word of [`${'0'.repeat(64 * 1024)}a`, `a${'!'.repeat(64 * 1024)}b`]) {
      const started = performance.now();
      withSuffix(word, 'locative');
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it('reads the tail as before', () => {
    expect(withSuffix('mac-1', 'locative')).toBe('mac-1’de');
    expect(withSuffix('sunucu-3!', 'locative')).toBe('sunucu-3!’te');
    expect(withSuffix('Ankara.', 'ablative')).toBe('Ankara.’dan');
  });
});
