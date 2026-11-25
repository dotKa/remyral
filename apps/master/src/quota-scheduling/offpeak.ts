import { isValidTimeZone, zonedMinuteOfDay, zonedParts, zonedToUtc } from '@remyral/protocol';
import { z } from 'zod';

/**
 * p6-quota-scheduling: a project's off-peak window (docs/design/p6-quota-scheduling.md §4). Wall-clock times in an
 * IANA zone, so the window follows daylight saving: "22:00–07:00 Europe/Berlin" is 22:00–07:00 local all year (one
 * hour shorter or longer in UTC on the nights the clocks change). `start > end` crosses midnight; `start == end` is
 * refused (an all-day window is no window). Pure.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const OffPeakWindow = z
  .strictObject({
    start: z.string().regex(HHMM, 'HH:MM'),
    end: z.string().regex(HHMM, 'HH:MM'),
    timeZone: z.string().min(1).max(64).refine(isValidTimeZone, 'unknown time zone'),
  })
  .refine((w) => w.start !== w.end, { message: 'start and end must differ', path: ['end'] });
export type OffPeakWindow = z.infer<typeof OffPeakWindow>;

function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Whether `now` is inside the window (start inclusive, end exclusive). */
export function inOffPeak(w: OffPeakWindow, now: Date): boolean {
  const m = zonedMinuteOfDay(now, w.timeZone);
  const s = minutes(w.start);
  const e = minutes(w.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/**
 * When the window next opens: `now` itself when inside it, else the next instant the local clock shows `start`
 * (a start skipped by spring-forward opens at the transition, e.g. 02:30 → 03:00 local).
 */
export function nextOffPeakStart(w: OffPeakWindow, now: Date): Date {
  if (inOffPeak(w, now)) return now;
  const s = minutes(w.start);
  const today = zonedParts(now, w.timeZone);
  for (let day = 0; day <= 2; day++) {
    const at = zonedToUtc(
      {
        year: today.year,
        month: today.month,
        day: today.day + day,
        hour: Math.floor(s / 60),
        minute: s % 60,
      },
      w.timeZone,
    );
    if (at.getTime() > now.getTime()) {
      if (zonedMinuteOfDay(at, w.timeZone) === s) return at;
      // The start falls in a DST gap: the window opens at the first minute the local clock is past it (the
      // transition), found by bisection over the preceding hours.
      let lo = Math.max(now.getTime(), at.getTime() - 3 * 3_600_000);
      let hi = at.getTime();
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (mid <= lo) break;
        if (inOffPeak(w, new Date(mid))) hi = mid;
        else lo = mid;
      }
      return new Date(hi);
    }
  }
  // Unreachable for valid zones (a start occurs at least once in any 48 h); fall back to a day later.
  return new Date(now.getTime() + 86_400_000);
}

/** "22:00–07:00 Europe/Istanbul" (display; codes and numbers only). */
export function describeOffPeak(w: OffPeakWindow): string {
  return `${w.start}–${w.end} ${w.timeZone}`;
}
