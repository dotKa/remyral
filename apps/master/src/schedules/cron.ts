import { isValidTimeZone, type WallTime, zonedParts, zonedToUtc } from '@remyral/protocol';

/**
 * Minimal 5-field cron (docs/design/p5-composer.md §4): `minute hour day-of-month month day-of-week`.
 * Each field: `*`, `n`, `a-b`, `*\/s`, `a-b/s`, and comma lists of those. Day of week 0–7 (0 and 7 = Sunday).
 * Standard semantics: when both day-of-month and day-of-week are restricted, a day matches either.
 * No names, no seconds, no `L`/`W`/`#` — deliberately small and fully tested.
 *
 * p16-workflow-quality: an expression is read on the wall clock of an IANA time zone (default UTC). Daylight saving
 * follows the tz database (`Intl`) with the usual cron rules: a schedule with a fixed hour runs once for a wall time
 * that is skipped (spring forward: at the first minute after the gap) and once for a wall time that repeats (fall
 * back: the first occurrence); a schedule whose hour field is `*` keeps its real-time cadence (every hour stays every
 * hour, through both changes).
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface Cron {
  readonly source: string;
  /** IANA zone whose wall clock the fields are read on (`UTC` by default). */
  readonly timeZone: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

function int(text: string, field: string): number {
  if (!/^\d{1,2}$/.test(text)) throw new CronError(`${field}: "${text}" is not a number`);
  return Number(text);
}

function parseField(text: string, f: (typeof FIELDS)[number]): { values: Set<number>; star: boolean } {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(',')) {
    const [range = '', stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`${f.name}: "${part}" has more than one step`);
    const step = stepText === undefined ? 1 : int(stepText, f.name);
    if (step < 1) throw new CronError(`${f.name}: step must be at least 1`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      hi = f.max;
      if (stepText === undefined) star = true;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      lo = int(a, f.name);
      hi = int(b, f.name);
    } else {
      lo = int(range, f.name);
      hi = stepText === undefined ? lo : f.max;
    }
    if (lo < f.min || hi > f.max || lo > hi) {
      throw new CronError(`${f.name}: "${part}" is outside ${String(f.min)}-${String(f.max)}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

export function parseCron(source: string, timeZone = 'UTC'): Cron {
  if (!isValidTimeZone(timeZone)) throw new CronError(`unknown time zone "${timeZone.slice(0, 64)}"`);
  const text = source.trim();
  if (text.length === 0 || text.length > 120) throw new CronError('expected 5 fields');
  if (!/^[0-9*,/\- ]+$/.test(text)) throw new CronError('only digits, "*", ",", "-", "/" and spaces');
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new CronError(`expected 5 fields, got ${String(parts.length)}`);
  const [m, h, dom, mon, dow] = parts.map((p, i) => {
    const f = FIELDS[i];
    if (f === undefined) throw new CronError('expected 5 fields');
    return parseField(p, f);
  });
  if (!m || !h || !dom || !mon || !dow) throw new CronError('expected 5 fields');
  const weekdays = new Set([...dow.values].map((d) => (d === 7 ? 0 : d)));
  return {
    source: parts.join(' '),
    timeZone,
    minutes: m.values,
    hours: h.values,
    days: dom.values,
    months: mon.values,
    weekdays,
    daysRestricted: !dom.star,
    weekdaysRestricted: !dow.star,
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.days.has(d.getUTCDate());
  const dow = c.weekdays.has(d.getUTCDay());
  if (c.daysRestricted && c.weekdaysRestricted) return dom || dow;
  if (c.daysRestricted) return dom;
  if (c.weekdaysRestricted) return dow;
  return true;
}

/** The first time strictly after `after` (minute precision) the expression matches; null if none within 5 years. */
export function nextRun(c: Cron, after: Date): Date | null {
  return c.timeZone === 'UTC' ? nextRunUtc(c, after) : nextRunZoned(c, after);
}

function nextRunUtc(c: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(t.getTime());
  }
  return null;
}

const MINUTE_MS = 60_000;

function wallMatchesDay(c: Cron, w: WallTime): boolean {
  const dom = c.days.has(w.day);
  const dow = c.weekdays.has(new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay());
  if (c.daysRestricted && c.weekdaysRestricted) return dom || dow;
  if (c.daysRestricted) return dom;
  if (c.weekdaysRestricted) return dow;
  return true;
}

function wallMatches(c: Cron, w: WallTime): boolean {
  return c.months.has(w.month) && wallMatchesDay(c, w) && c.hours.has(w.hour) && c.minutes.has(w.minute);
}

const wallMs = (w: WallTime): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);

function wallOf(ms: number): WallTime {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/**
 * Spring forward: whether the wall clock jumped over a matching time right before instant `t` (the minute before it
 * shows a wall time more than one minute earlier). Bounded: a gap is at most a day long.
 */
function skippedMatch(c: Cron, t: number, w: WallTime): boolean {
  const before = wallMs(zonedParts(new Date(t - MINUTE_MS), c.timeZone)) + MINUTE_MS;
  const now = wallMs(w);
  if (now <= before) return false;
  for (let x = before, n = 0; x < now && n < 1440; x += MINUTE_MS, n++) {
    if (wallMatches(c, wallOf(x))) return true;
  }
  return false;
}

/** {@link nextRun} on the wall clock of `c.timeZone` (daylight saving rules: see the module comment). */
function nextRunZoned(c: Cron, after: Date): Date | null {
  const tz = c.timeZone;
  const fixedHours = c.hours.size < 24;
  const minutes = [...c.minutes].sort((a, b) => a - b);
  let t = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  // A wall-clock target as an instant, always moving forward.
  const jump = (w: WallTime): number => Math.max(t + MINUTE_MS, zonedToUtc(w, tz).getTime());
  while (t <= limit) {
    const w = zonedParts(new Date(t), tz);
    if (!c.months.has(w.month)) {
      t = jump({ year: w.year, month: w.month + 1, day: 1, hour: 0, minute: 0 });
      continue;
    }
    if (!wallMatchesDay(c, w)) {
      t = jump({ ...w, day: w.day + 1, hour: 0, minute: 0 });
      continue;
    }
    if (!c.hours.has(w.hour) || !c.minutes.has(w.minute)) {
      if (fixedHours && skippedMatch(c, t, w)) return new Date(t);
      if (!c.hours.has(w.hour)) {
        t = jump({ ...w, hour: w.hour + 1, minute: 0 });
        continue;
      }
      // Minutes advance in real time, so a repeated hour (fall back) is walked through, not jumped over.
      const next = minutes.find((m) => m > w.minute);
      const step = next === undefined ? 60 - w.minute + (minutes[0] ?? 0) : next - w.minute;
      t += step * MINUTE_MS;
      continue;
    }
    // Fall back: the second occurrence of a repeated wall time does not run a fixed-hour schedule again.
    if (fixedHours && zonedToUtc(w, tz).getTime() < t) {
      t += MINUTE_MS;
      continue;
    }
    return new Date(t);
  }
  return null;
}

/** The next `count` run times after `after`. */
export function nextRuns(c: Cron, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let from = after;
  for (let i = 0; i < count; i++) {
    const n = nextRun(c, from);
    if (n === null) break;
    out.push(n);
    from = n;
  }
  return out;
}

/** Smallest gap between consecutive runs over the next `sample` runs (minutes); guards against every-minute floods. */
export function minIntervalMinutes(c: Cron, after: Date, sample = 50): number | null {
  const runs = nextRuns(c, after, sample);
  let min: number | null = null;
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1];
    const b = runs[i];
    if (a === undefined || b === undefined) continue;
    const gap = (b.getTime() - a.getTime()) / 60_000;
    min = min === null ? gap : Math.min(min, gap);
  }
  return min;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad2 = (n: number): string => String(n).padStart(2, '0');
const sortedValues = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);

/** `[0, 15, 30, 45]` over 0..max → 15 (an even step from 0 that wraps evenly); null otherwise. */
function evenStep(values: number[], max: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = (values[1] ?? 0) - values[0];
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) - (values[i - 1] ?? 0) !== step) return null;
  }
  return (values[values.length - 1] ?? 0) + step > max ? step : null;
}

function wordList(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/**
 * A human summary of a parsed expression (p6-automations cron builder), e.g. "Every day at 03:00 UTC",
 * "Every 15 minutes", "At 09:30 UTC, on Monday to Friday", "Every day at 00:00 UTC, on day 1 of the month". Times
 * name the expression's zone ("Every day at 09:00 Europe/Istanbul"); interval schedules are zone-free.
 */
export function describeCron(c: Cron): string {
  const minutes = sortedValues(c.minutes);
  const hours = sortedValues(c.hours);
  const allHours = hours.length === 24;
  let time: string;
  const minuteStep = evenStep(minutes, 59);
  if (allHours && minuteStep !== null) {
    time = minuteStep === 1 ? 'Every minute' : `Every ${String(minuteStep)} minutes`;
  } else if (allHours && minutes.length === 1) {
    time = minutes[0] === 0 ? 'Every hour' : `Every hour at minute ${String(minutes[0])}`;
  } else if (allHours) {
    time = `Every hour at minutes ${minutes.join(', ')}`;
  } else if (hours.length * minutes.length <= 6) {
    const times = hours.flatMap((h) => minutes.map((m) => `${pad2(h)}:${pad2(m)}`));
    time = `At ${wordList(times)} ${c.timeZone}`;
  } else {
    const hourStep = evenStep(hours, 23);
    const at = minutes.length === 1 ? `at minute ${String(minutes[0])}` : `at minutes ${minutes.join(', ')}`;
    time =
      hourStep !== null
        ? `Every ${String(hourStep)} hours ${at} (${c.timeZone})`
        : `At ${at.slice(3)} past hours ${hours.join(', ')} (${c.timeZone})`;
  }
  const parts: string[] = [];
  const weekdays = sortedValues(c.weekdays);
  const dayWords =
    weekdays.join(',') === '1,2,3,4,5'
      ? 'Monday to Friday'
      : weekdays.join(',') === '0,6'
        ? 'weekends'
        : wordList(weekdays.map((d) => DAY_NAMES[d] ?? String(d)));
  const days = wordList(sortedValues(c.days).map(String));
  if (c.daysRestricted && c.weekdaysRestricted) parts.push(`on day ${days} of the month or on ${dayWords}`);
  else if (c.daysRestricted) parts.push(`on day ${days} of the month`);
  else if (c.weekdaysRestricted) parts.push(`on ${dayWords}`);
  if (c.months.size < 12) {
    parts.push(`in ${wordList(sortedValues(c.months).map((m) => MONTH_NAMES[m - 1] ?? String(m)))}`);
  }
  const lead = time.startsWith('At ') ? `Every day at ${time.slice(3)}` : time;
  return parts.length === 0 ? lead : `${lead}, ${parts.join(', ')}`;
}
