/**
 * Calendar periods in an IANA time zone (p8-cost-efficiency, docs/design/p8-cost-efficiency.md §3): budget windows
 * ("this month in Europe/Istanbul"), dashboard trend buckets and the weekly report's "Monday 08:00 local". Pure,
 * no date library: `Intl.DateTimeFormat` (full ICU in Node and every evergreen browser) supplies the zone rules, so
 * daylight-saving transitions follow the tz database. The same "compatible" resolution as
 * `@remyral/protocol` zoned-time (kept dependency-free here on purpose: this package has no runtime dependencies):
 * a wall time that occurs twice resolves to the earlier instant, one that does not exist moves forward by the gap.
 */

/** Calendar date and wall-clock time in some zone (month 1–12). */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (formatters.size > 256) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;

/** Whether `timeZone` is an IANA zone name (or `UTC`) this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!ZONE_NAME.test(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time of `instant` in `timeZone`. Throws a RangeError for an unknown zone. */
export function wallTime(instant: Date, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function offsetAt(epochMs: number, timeZone: string): number {
  const w = wallTime(new Date(epochMs), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(epochMs / 60_000) * 60_000;
}

/** The instant the wall clock in `timeZone` shows `wall` (fields roll over like `Date.UTC`). */
export function wallToInstant(wall: WallTime, timeZone: string): Date {
  const t = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  if (timeZone === 'UTC') return new Date(t);
  const c1 = t - offsetAt(t, timeZone);
  const c2 = t - offsetAt(c1, timeZone);
  const valid = [c1, c2].filter((c) => offsetAt(c, timeZone) === t - c);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(Math.max(c1, c2));
}

export const PERIOD_GRAINS = ['day', 'week', 'month'] as const;
export type PeriodGrain = (typeof PERIOD_GRAINS)[number];

export interface Period {
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/** Day of the week of a calendar date, Monday = 0 … Sunday = 6 (ISO 8601 weeks start on Monday). */
function isoWeekday(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/**
 * The calendar period of `grain` containing `at`, in `timeZone`: local midnight to local midnight (a day can be 23
 * or 25 hours long on the day the clocks change), weeks Monday–Sunday, months from the 1st.
 */
export function periodContaining(grain: PeriodGrain, at: Date, timeZone = 'UTC'): Period {
  const w = wallTime(at, timeZone);
  const midnight = (year: number, month: number, day: number): Date =>
    wallToInstant({ year, month, day, hour: 0, minute: 0 }, timeZone);
  switch (grain) {
    case 'day':
      return { start: midnight(w.year, w.month, w.day), end: midnight(w.year, w.month, w.day + 1) };
    case 'week': {
      const back = isoWeekday(w.year, w.month, w.day);
      return {
        start: midnight(w.year, w.month, w.day - back),
        end: midnight(w.year, w.month, w.day - back + 7),
      };
    }
    case 'month':
      return { start: midnight(w.year, w.month, 1), end: midnight(w.year, w.month + 1, 1) };
  }
}

/** Consecutive periods of `grain` covering [from, to) (the first and last may extend past it); at most `max`. */
export function periodsBetween(
  grain: PeriodGrain,
  from: Date,
  to: Date,
  timeZone = 'UTC',
  max = 1000,
): Period[] {
  const out: Period[] = [];
  let p = periodContaining(grain, from, timeZone);
  while (p.start.getTime() < to.getTime() && out.length < max) {
    out.push(p);
    p = periodContaining(grain, p.end, timeZone);
  }
  return out;
}

/** "2026-10-12" — the local calendar date a period starts on (its key in trend series). */
export function periodKey(start: Date, timeZone = 'UTC'): string {
  const w = wallTime(start, timeZone);
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/**
 * The latest weekly slot — Monday `hour`:00 local in `timeZone` — at or before `now`, and the full week it reports
 * on (the Monday 00:00 → Monday 00:00 local week before that slot). Used by the weekly report scheduler: a report is
 * due when no report exists for `week.start`.
 */
export function weeklySlot(
  now: Date,
  timeZone = 'UTC',
  hour = 8,
): { readonly slot: Date; readonly week: Period } {
  const thisWeek = periodContaining('week', now, timeZone);
  const w = wallTime(thisWeek.start, timeZone);
  let slot = wallToInstant({ year: w.year, month: w.month, day: w.day, hour, minute: 0 }, timeZone);
  let monday = thisWeek.start;
  if (slot.getTime() > now.getTime()) {
    // Before this Monday's slot: the latest slot was last Monday.
    monday = periodContaining('week', new Date(thisWeek.start.getTime() - 1), timeZone).start;
    const lw = wallTime(monday, timeZone);
    slot = wallToInstant({ year: lw.year, month: lw.month, day: lw.day, hour, minute: 0 }, timeZone);
  }
  const reported = periodContaining('week', new Date(monday.getTime() - 1), timeZone);
  return { slot, week: reported };
}
