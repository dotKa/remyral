import { describe, expect, it } from 'vitest';
import { CronError, minIntervalMinutes, nextRun, nextRuns, parseCron } from '../../src/schedules/cron.js';

const at = (s: string) => new Date(s);
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('5-field cron (p5-composer schedules)', () => {
  it.each([
    ['*/15 * * * *', '2026-10-13T10:07:30Z', '2026-10-13T10:15:00.000Z'],
    ['0 9 * * *', '2026-10-13T09:00:00Z', '2026-10-14T09:00:00.000Z'],
    ['0 9 * * *', '2026-10-13T08:59:59Z', '2026-10-13T09:00:00.000Z'],
    ['30 2 1 * *', '2026-10-13T00:00:00Z', '2026-11-01T02:30:00.000Z'],
    ['0 0 * * 1-5', '2026-10-16T12:00:00Z', '2026-10-19T00:00:00.000Z'], // Fri → Mon
    ['0 0 * * 7', '2026-10-13T00:00:00Z', '2026-10-18T00:00:00.000Z'], // 7 = Sunday
    ['0 12 29 2 *', '2026-03-01T00:00:00Z', '2028-02-29T12:00:00.000Z'], // leap day
    ['5,35 */6 * 1,7 *', '2026-12-31T23:59:00Z', '2027-01-01T00:05:00.000Z'],
    ['0 8-17/3 * * *', '2026-10-13T12:00:00Z', '2026-10-13T14:00:00.000Z'],
  ])('%s after %s → %s', (expr, after, expected) => {
    expect(iso(nextRun(parseCron(expr), at(after)))).toBe(expected);
  });

  it('day-of-month and day-of-week both restricted: either matches (standard cron)', () => {
    // 13th of the month OR a Friday.
    const c = parseCron('0 0 13 * 5');
    expect(iso(nextRun(c, at('2026-10-13T00:00:00Z')))).toBe('2026-10-16T00:00:00.000Z'); // Friday
    expect(iso(nextRun(c, at('2026-11-07T00:00:00Z')))).toBe('2026-11-13T00:00:00.000Z');
  });

  it('never-matching expressions return null instead of looping', () => {
    expect(nextRun(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('lists the next runs and the shortest interval', () => {
    const c = parseCron('0 */2 * * *');
    expect(nextRuns(c, at('2026-10-13T00:30:00Z'), 3).map((d) => d.toISOString())).toEqual([
      '2026-10-13T02:00:00.000Z',
      '2026-10-13T04:00:00.000Z',
      '2026-10-13T06:00:00.000Z',
    ]);
    expect(minIntervalMinutes(c, at('2026-10-13T00:00:00Z'))).toBe(120);
    expect(minIntervalMinutes(parseCron('* * * * *'), at('2026-10-13T00:00:00Z'))).toBe(1);
  });

  it.each([
    ['', 'expected 5 fields'],
    ['* * * *', 'expected 5 fields'],
    ['60 * * * *', 'outside'],
    ['* 24 * * *', 'outside'],
    ['* * 0 * *', 'outside'],
    ['* * * 13 *', 'outside'],
    ['* * * * 8', 'outside'],
    ['5-1 * * * *', 'outside'],
    ['*/0 * * * *', 'step'],
    ['MON * * * *', 'only digits'],
    ['1/2/3 * * * *', 'more than one step'],
    ['$(id) * * * *', 'only digits'],
  ])('rejects %j', (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(message);
  });
});
