import { describe, expect, it } from 'vitest';
import { MAX_BACKFILL, ON_TIME_MS, planCatchUp, planOneShot } from '../../src/automations/catchup.js';
import { describeCron, parseCron } from '../../src/schedules/cron.js';

const hourly = parseCron('0 * * * *');
const at = (s: string) => new Date(s);

describe('cron catch-up (p6-automations §6)', () => {
  it('an on-time tick fires once under every policy and re-arms at the next occurrence', () => {
    for (const policy of ['skip', 'once', 'all'] as const) {
      const plan = planCatchUp(hourly, at('2026-10-15T10:00:00Z'), at('2026-10-15T10:00:30Z'), policy);
      expect(plan.fire.map((d) => d.toISOString())).toEqual(['2026-10-15T10:00:00.000Z']);
      expect(plan.skipped).toBeNull();
      expect(plan.folded).toBe(0);
      expect(plan.next?.toISOString()).toBe('2026-10-15T11:00:00.000Z');
    }
  });

  it('skip: occurrences missed while the master was down are recorded once and nothing runs', () => {
    const plan = planCatchUp(hourly, at('2026-10-15T10:00:00Z'), at('2026-10-15T13:20:00Z'), 'skip');
    expect(plan.fire).toEqual([]);
    expect(plan.skipped).toEqual({ at: at('2026-10-15T13:00:00Z'), count: 4 });
    expect(plan.next?.toISOString()).toBe('2026-10-15T14:00:00.000Z');
  });

  it('skip: the latest occurrence still runs when it is on time; the older ones are skipped', () => {
    const plan = planCatchUp(hourly, at('2026-10-15T10:00:00Z'), at('2026-10-15T13:02:00Z'), 'skip');
    expect(plan.fire).toEqual([at('2026-10-15T13:00:00Z')]);
    expect(plan.skipped).toEqual({ at: at('2026-10-15T12:00:00Z'), count: 3 });
  });

  it('once (default): one run for the latest occurrence, the rest folded into it', () => {
    const plan = planCatchUp(hourly, at('2026-10-15T10:00:00Z'), at('2026-10-15T13:20:00Z'), 'once');
    expect(plan.fire).toEqual([at('2026-10-15T13:00:00Z')]);
    expect(plan.folded).toBe(3);
    expect(plan.skipped).toBeNull();
  });

  it(`all: one run per missed occurrence, at most ${String(MAX_BACKFILL)}, older ones counted as skipped`, () => {
    const few = planCatchUp(hourly, at('2026-10-15T10:00:00Z'), at('2026-10-15T12:30:00Z'), 'all');
    expect(few.fire.map((d) => d.toISOString())).toEqual([
      '2026-10-15T10:00:00.000Z',
      '2026-10-15T11:00:00.000Z',
      '2026-10-15T12:00:00.000Z',
    ]);
    const many = planCatchUp(hourly, at('2026-10-14T00:00:00Z'), at('2026-10-15T00:30:00Z'), 'all');
    expect(many.fire).toHaveLength(MAX_BACKFILL);
    expect(many.fire[many.fire.length - 1]?.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(many.skipped).toEqual({ at: at('2026-10-14T14:00:00Z'), count: 25 - MAX_BACKFILL });
  });

  it('a one-time run late beyond the on-time window is skipped only under policy skip', () => {
    const due = at('2026-10-15T10:00:00Z');
    const late = new Date(due.getTime() + ON_TIME_MS + 1);
    expect(planOneShot(due, late, 'skip')).toBe('skip');
    expect(planOneShot(due, late, 'once')).toBe('fire');
    expect(planOneShot(due, new Date(due.getTime() + 1000), 'skip')).toBe('fire');
  });
});

describe('describeCron (cron builder summary)', () => {
  it.each([
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour'],
    ['30 * * * *', 'Every hour at minute 30'],
    ['0 3 * * *', 'Every day at 03:00 UTC'],
    ['30 9 * * 1-5', 'Every day at 09:30 UTC, on Monday to Friday'],
    ['0 0 1 * *', 'Every day at 00:00 UTC, on day 1 of the month'],
    ['0 8,20 * * 0,6', 'Every day at 08:00 and 20:00 UTC, on weekends'],
    ['0 */6 * * *', 'Every day at 00:00, 06:00, 12:00 and 18:00 UTC'],
    ['15 */2 * * *', 'Every 2 hours at minute 15 (UTC)'],
    ['0 12 * 1,7 *', 'Every day at 12:00 UTC, in January and July'],
  ])('%s → %s', (cron, text) => {
    expect(describeCron(parseCron(cron))).toBe(text);
  });
});
