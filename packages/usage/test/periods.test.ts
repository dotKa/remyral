import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS_PCT,
  isValidTimeZone,
  levelOfThreshold,
  normalizeThresholds,
  periodContaining,
  periodKey,
  periodsBetween,
  thresholdsReached,
  wallToInstant,
  weeklySlot,
  windowBounds,
} from '../src/index.js';

const iso = (d: Date): string => d.toISOString();

describe('periods in a time zone (p8-cost-efficiency)', () => {
  it('validates zone names without throwing', () => {
    expect(isValidTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('../etc/passwd')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('a month in Europe/Istanbul (UTC+3, no DST) starts at 21:00 UTC the day before', () => {
    const p = periodContaining('month', new Date('2026-10-31T22:30:00Z'), 'Europe/Istanbul');
    // 22:30 UTC on Oct 31 is already 01:30 on Nov 1 in Istanbul.
    expect(iso(p.start)).toBe('2026-10-31T21:00:00.000Z');
    expect(iso(p.end)).toBe('2026-11-30T21:00:00.000Z');
  });

  it('UTC windows match the p6 behaviour exactly', () => {
    const at = new Date('2026-10-14T12:00:00Z');
    expect(windowBounds('week', at)).toEqual(periodContaining('week', at, 'UTC'));
    expect(iso(windowBounds('week', at).start)).toBe('2026-10-12T00:00:00.000Z');
    expect(iso(windowBounds('day', at, 'UTC').end)).toBe('2026-10-15T00:00:00.000Z');
  });

  it('a day across the autumn DST change in Europe/Berlin is 25 hours long', () => {
    const p = periodContaining('day', new Date('2026-10-25T12:00:00Z'), 'Europe/Berlin');
    expect(iso(p.start)).toBe('2026-10-24T22:00:00.000Z'); // 00:00 CEST
    expect(iso(p.end)).toBe('2026-10-25T23:00:00.000Z'); // 00:00 CET
    expect(p.end.getTime() - p.start.getTime()).toBe(25 * 3_600_000);
  });

  it('a spring day in America/New_York is 23 hours long; weeks start on Monday local', () => {
    const d = periodContaining('day', new Date('2026-03-08T15:00:00Z'), 'America/New_York');
    expect(d.end.getTime() - d.start.getTime()).toBe(23 * 3_600_000);
    const w = periodContaining('week', new Date('2026-03-08T15:00:00Z'), 'America/New_York');
    expect(iso(w.start)).toBe('2026-03-02T05:00:00.000Z'); // Monday 00:00 EST
    expect(iso(w.end)).toBe('2026-03-09T04:00:00.000Z'); // next Monday 00:00 EDT
  });

  it('a wall time in the spring-forward gap moves forward', () => {
    const t = wallToInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin');
    expect(iso(t)).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
  });

  it('periodsBetween covers the range with consecutive local periods and labels them', () => {
    const ps = periodsBetween(
      'day',
      new Date('2026-10-24T00:00:00Z'),
      new Date('2026-10-27T00:00:00Z'),
      'Europe/Berlin',
    );
    expect(ps.map((p) => periodKey(p.start, 'Europe/Berlin'))).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    for (let i = 1; i < ps.length; i++) expect(ps[i]?.start).toEqual(ps[i - 1]?.end);
    expect(periodsBetween('month', new Date('2026-01-01Z'), new Date('2027-01-01Z'), 'UTC', 5)).toHaveLength(
      5,
    );
  });

  it('weekly slot: Monday 08:00 local; before it the previous Monday; the reported week ends at the slot Monday', () => {
    // Monday 2026-10-19 07:59 Istanbul = 04:59 UTC: the latest slot is Monday 2026-10-12 08:00.
    const before = weeklySlot(new Date('2026-10-19T04:59:00Z'), 'Europe/Istanbul');
    expect(iso(before.slot)).toBe('2026-10-12T05:00:00.000Z');
    expect(iso(before.week.start)).toBe('2026-10-04T21:00:00.000Z');
    expect(iso(before.week.end)).toBe('2026-10-11T21:00:00.000Z');
    const after = weeklySlot(new Date('2026-10-19T05:00:00Z'), 'Europe/Istanbul');
    expect(iso(after.slot)).toBe('2026-10-19T05:00:00.000Z');
    expect(iso(after.week.start)).toBe('2026-10-11T21:00:00.000Z');
    expect(iso(after.week.end)).toBe('2026-10-18T21:00:00.000Z');
    // Mid-week: still the Monday slot of this week.
    expect(iso(weeklySlot(new Date('2026-10-22T12:00:00Z'), 'UTC').slot)).toBe('2026-10-19T08:00:00.000Z');
  });
});

describe('budget thresholds (p8-cost-efficiency)', () => {
  it('normalises thresholds: integers 1–100, unique, ascending, at most five', () => {
    expect(normalizeThresholds([100, 50, 80, 50])).toEqual([50, 80, 100]);
    expect(normalizeThresholds([])).toBeNull();
    expect(normalizeThresholds([0])).toBeNull();
    expect(normalizeThresholds([101])).toBeNull();
    expect(normalizeThresholds([50.5])).toBeNull();
    expect(normalizeThresholds([10, 20, 30, 40, 50, 60])).toBeNull();
    expect(DEFAULT_THRESHOLDS_PCT).toEqual([50, 80, 100]);
  });

  it('reports every threshold the known consumption reached (inclusive)', () => {
    expect(thresholdsReached([50, 80, 100], 49.99, 100)).toEqual([]);
    expect(thresholdsReached([50, 80, 100], 50, 100)).toEqual([50]);
    expect(thresholdsReached([50, 80, 100], 80, 100)).toEqual([50, 80]);
    expect(thresholdsReached([50, 80, 100], 250, 100)).toEqual([50, 80, 100]);
    expect(thresholdsReached([50], 10, 0)).toEqual([]);
  });

  it('maps thresholds to the p6 level names', () => {
    expect(levelOfThreshold(50)).toBe('notice');
    expect(levelOfThreshold(80)).toBe('warning');
    expect(levelOfThreshold(90)).toBe('warning');
    expect(levelOfThreshold(100)).toBe('exceeded');
  });
});
