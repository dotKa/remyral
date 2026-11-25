/**
 * p6-quota-scheduling: wall-clock time in an IANA time zone, without a date library. Used by the master's off-peak
 * windows (project setting) and by the runtime adapters to read provider reset times such as "resets 3pm
 * (Europe/Istanbul)". Pure; `Intl.DateTimeFormat` (full ICU in Node ≥ 13) supplies the zone rules, so daylight
 * saving transitions follow the tz database.
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
      second: '2-digit',
    });
    if (formatters.size > 256) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `timeZone` is an IANA zone name (or `UTC`) this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time of `instant` in `timeZone` (seconds dropped). Throws for an unknown zone. */
export function zonedParts(instant: Date, timeZone: string): WallTime {
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

/** Offset of `timeZone` at `epochMs` (local − UTC) in ms, at minute precision. */
function offsetAt(epochMs: number, timeZone: string): number {
  const w = zonedParts(new Date(epochMs), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(epochMs / 60_000) * 60_000;
}

/**
 * The instant at which the wall clock in `timeZone` shows `wall`. Daylight saving edges follow the usual
 * "compatible" rule: a wall time that occurs twice (clocks go back) resolves to the earlier instant; a wall time
 * that does not exist (clocks go forward) is moved forward by the gap (02:30 → 03:30). Fields out of range
 * roll over like `Date.UTC` (day 32 → next month).
 */
export function zonedToUtc(wall: WallTime, timeZone: string): Date {
  const t = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const o1 = offsetAt(t, timeZone);
  const c1 = t - o1;
  const o2 = offsetAt(c1, timeZone);
  const c2 = t - o2;
  const valid = [c1, c2].filter((c) => offsetAt(c, timeZone) === t - c);
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Gap: no instant shows this wall time; the earlier offset applied to it lands after the gap.
  return new Date(Math.max(c1, c2));
}

/** Minutes since local midnight of `instant` in `timeZone`. */
export function zonedMinuteOfDay(instant: Date, timeZone: string): number {
  const w = zonedParts(instant, timeZone);
  return w.hour * 60 + w.minute;
}
