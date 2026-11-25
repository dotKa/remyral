import { describe, expect, it } from 'vitest';
import { resetBucket } from '../../src/runtime-usage/notify.js';

// The same weekly window must not be announced again on every read just because the reset time jitters.
describe('usage-limit notice dedupe: reset time bucket', () => {
  it('jittered reset times of one window give one key', () => {
    const keys = ['2026-10-28T14:00:00.317Z', '2026-10-28T14:00:00.064Z', '2026-10-28T13:59:59.554Z'].map(
      resetBucket,
    );
    expect(new Set(keys)).toEqual(new Set(['2026-10-28T14:00:00Z']));
  });
  it('a different period stays a different key; unknown stays null', () => {
    expect(resetBucket('2026-11-04T14:00:00.100Z')).toBe('2026-11-04T14:00:00Z');
    expect(resetBucket(null)).toBeNull();
    expect(resetBucket('not a date')).toBe('not a date');
  });
});
