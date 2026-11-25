import { describe, expect, it } from 'vitest';
import { planCatchUp } from '../../src/automations/catchup.js';
import { CronError, describeCron, nextRun, nextRuns, parseCron } from '../../src/schedules/cron.js';

/**
 * p16-workflow-quality: cron read on an IANA zone's wall clock. Daylight saving (America/New_York 2026: clocks go
 * forward 8 March 02:00 → 03:00, back 1 November 02:00 → 01:00): a fixed-hour schedule runs once for a skipped or a
 * repeated wall time; an hourly (`*` hour) schedule keeps its real-time cadence.
 */

const iso = (d: Date | null) => d?.toISOString() ?? null;
const runs = (cron: string, tz: string, after: string, n: number) =>
  nextRuns(parseCron(cron, tz), new Date(after), n).map((d) => d.toISOString());

describe('cron in a time zone (p16-workflow-quality)', () => {
  it('reads the fields on the zone’s wall clock (Europe/Istanbul is UTC+3 all year)', () => {
    expect(iso(nextRun(parseCron('0 9 * * *', 'Europe/Istanbul'), new Date('2026-10-23T00:00:00Z')))).toBe(
      '2026-10-23T06:00:00.000Z',
    );
    expect(runs('0 * * * *', 'Europe/Istanbul', '2026-10-23T06:10:00Z', 2)).toEqual([
      '2026-10-23T07:00:00.000Z',
      '2026-10-23T08:00:00.000Z',
    ]);
    // Weekdays are the zone's: Monday 00:30 in Istanbul is Sunday 21:30 UTC.
    expect(iso(nextRun(parseCron('30 0 * * 1', 'Europe/Istanbul'), new Date('2026-10-23T00:00:00Z')))).toBe(
      '2026-10-25T21:30:00.000Z',
    );
  });

  it('UTC (the default) is unchanged', () => {
    const c = parseCron('0 9 * * *');
    expect(c.timeZone).toBe('UTC');
    expect(iso(nextRun(c, new Date('2026-10-23T00:00:00Z')))).toBe('2026-10-23T09:00:00.000Z');
  });

  it('spring forward: hourly stays hourly in real time; a skipped fixed time runs once after the gap', () => {
    // 00:30 EST → 01:00 EST (06:00Z), 03:00 EDT (07:00Z), 04:00 EDT (08:00Z).
    expect(runs('0 * * * *', 'America/New_York', '2026-03-08T05:30:00Z', 3)).toEqual([
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
    ]);
    // 02:30 does not exist on 8 March: it runs at 03:00 EDT (07:00Z), then 02:30 EDT the next day (06:30Z).
    expect(runs('30 2 * * *', 'America/New_York', '2026-03-08T05:00:00Z', 2)).toEqual([
      '2026-03-08T07:00:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
  });

  it('fall back: hourly runs in both 01:00 hours; a fixed time in the repeated hour runs once', () => {
    expect(runs('0 * * * *', 'America/New_York', '2026-11-01T04:30:00Z', 3)).toEqual([
      '2026-11-01T05:00:00.000Z', // 01:00 EDT
      '2026-11-01T06:00:00.000Z', // 01:00 EST (again)
      '2026-11-01T07:00:00.000Z', // 02:00 EST
    ]);
    expect(runs('30 1 * * *', 'America/New_York', '2026-11-01T04:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z', // 01:30 EDT, the first occurrence
      '2026-11-02T06:30:00.000Z', // not 06:30Z on the 1st (01:30 EST, the repeat)
    ]);
  });

  it('catch-up plans across a DST boundary use the zone', () => {
    const c = parseCron('0 * * * *', 'America/New_York');
    const plan = planCatchUp(c, new Date('2026-03-08T06:00:00Z'), new Date('2026-03-08T07:01:00Z'), 'all');
    expect(plan.fire.map((d) => d.toISOString())).toEqual([
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
    ]);
    expect(iso(plan.next)).toBe('2026-03-08T08:00:00.000Z');
  });

  it('refuses unknown zones and names the zone in the summary', () => {
    expect(() => parseCron('0 9 * * *', 'Mars/Olympus')).toThrow(CronError);
    expect(() => parseCron('0 9 * * *', 'Europe/Istanbul; DROP')).toThrow(CronError);
    expect(describeCron(parseCron('0 9 * * *', 'Europe/Istanbul'))).toBe(
      'Every day at 09:00 Europe/Istanbul',
    );
    expect(describeCron(parseCron('0 * * * *', 'Europe/Istanbul'))).toBe('Every hour');
  });
});
