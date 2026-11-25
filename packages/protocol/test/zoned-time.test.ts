import { describe, expect, it } from 'vitest';
import { isValidTimeZone, zonedMinuteOfDay, zonedParts, zonedToUtc } from '../src/index.js';

/** p6-quota-scheduling: wall-clock time in IANA zones, including daylight saving edges. */
describe('zoned time', () => {
  it('reads wall time and converts back', () => {
    const at = new Date('2026-10-16T19:30:00Z');
    expect(zonedParts(at, 'Europe/Istanbul')).toEqual({
      year: 2026,
      month: 10,
      day: 16,
      hour: 22,
      minute: 30,
    });
    expect(zonedMinuteOfDay(at, 'America/New_York')).toBe(15 * 60 + 30);
    expect(
      zonedToUtc({ year: 2026, month: 10, day: 16, hour: 22, minute: 30 }, 'Europe/Istanbul').toISOString(),
    ).toBe('2026-10-16T19:30:00.000Z');
  });

  it('a wall time skipped by spring-forward moves forward by the gap', () => {
    // Europe/Berlin 2026-03-29: 02:00 CET → 03:00 CEST.
    expect(
      zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin').toISOString(),
    ).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedParts(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin').hour).toBe(3);
  });

  it('a wall time repeated by fall-back resolves to the earlier instant', () => {
    // America/New_York 2026-11-01: 02:00 EDT → 01:00 EST; 01:30 happens twice.
    expect(
      zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York').toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rolls over out-of-range days and validates zones', () => {
    expect(zonedToUtc({ year: 2026, month: 10, day: 32, hour: 0, minute: 0 }, 'UTC').toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(isValidTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('../etc')).toBe(false);
  });
});
