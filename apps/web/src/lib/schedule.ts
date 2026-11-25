import { fill, type Messages } from '@remyral/i18n';

/**
 * p16-workflow-quality: schedules said in the reader's language with their zone — "her saat başı · Europe/Istanbul",
 * "every day at 09:00 · Europe/Istanbul". The common cron shapes get words; anything else shows the expression itself.
 * Pure: tested without rendering.
 */

/** The browser's IANA zone, or null when unknown / UTC (then the master's default applies). */
export function browserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz !== '' && tz !== 'UTC' && tz !== 'Etc/UTC' ? tz : null;
  } catch {
    return null;
  }
}

/** Whether this runtime knows `tz` as an IANA zone (or UTC). */
export function isTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zone names for a picker (the runtime's list, else a short fallback). */
export function timeZoneNames(): readonly string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    );
    if (all !== undefined && all.length > 0) return ['UTC', ...all.filter((z) => z !== 'UTC')];
  } catch {
    // older runtimes
  }
  return ['UTC', 'Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo'];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const NUM = /^\d{1,2}$/;

/** Words for the common 5-field shapes, or null (the caller shows the expression). */
export function cronWords(cron: string, t: Messages['workflowQuality']['schedule']): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m = '', h = '', dom = '', mon = '', dow = ''] = f;
  if (dom !== '*' || mon !== '*') return null;
  const step = /^\*\/(\d{1,2})$/.exec(m);
  if (step?.[1] !== undefined && h === '*' && dow === '*')
    return fill(t.everyMinutes, { n: Number(step[1]) });
  if (!NUM.test(m)) return null;
  if (h === '*' && dow === '*') return Number(m) === 0 ? t.hourly : fill(t.hourlyAt, { m: Number(m) });
  if (!NUM.test(h)) return null;
  const time = `${pad(Number(h))}:${pad(Number(m))}`;
  if (dow === '*') return fill(t.daily, { time });
  if (dow === '1-5') return fill(t.weekdays, { time });
  if (/^[0-7]$/.test(dow)) {
    const days = t.days as Readonly<Record<string, string>>;
    return fill(t.weekly, { day: days[`d${String(Number(dow) % 7)}`] ?? dow, time });
  }
  return null;
}

/** A cron schedule with its zone: words when known, else the expression; " · <zone>" always. */
export function cronLine(cron: string, timeZone: string, t: Messages['workflowQuality']['schedule']): string {
  return fill(t.withZone, { text: cronWords(cron, t) ?? cron, zone: timeZone });
}

/** An automation's schedule line: cron in words with its zone; other triggers keep the master's summary. */
export function scheduleSummary(
  a: {
    readonly trigger: { readonly kind: string; readonly cron?: string };
    readonly triggerSummary: string;
    readonly timeZone: string;
  },
  t: Messages['workflowQuality']['schedule'],
): string {
  return a.trigger.kind === 'cron' && typeof a.trigger.cron === 'string'
    ? cronLine(a.trigger.cron, a.timeZone, t)
    : a.triggerSummary;
}
