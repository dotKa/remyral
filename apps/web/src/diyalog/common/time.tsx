import { createFormatter, type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { useNow } from '../../lib/now';

/**
 * p14-i18n-shell (i18n Phase 2): the options `Date#toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` use
 * when called without options — so a call site moved to `useFormat().dateWith(v, …)` prints exactly what it printed
 * before for Turkish ("20.10.2026 14:03:05"), and the English form ("20/10/2026, 14:03:05") for English.
 */
export const DATE_TIME_NUMERIC: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};
export const DATE_NUMERIC: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
export const TIME_NUMERIC: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};
/** "14:05". */
export const HH_MM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/**
 * Turkish formatters for pure helpers whose sentence is still Turkish copy (moved to the catalog in Phase 5); a
 * component passes `useFormat()` instead.
 */
export const TR_FORMAT: Formatter = createFormatter('tr');

/**
 * p12-diyalog-final: relative time in Turkish, once for the Diyalog UI. The words ("az önce", "3 dk önce",
 * "2 sa sonra", "4 gün önce") and `DyTime`, which ticks on the shared clock of `lib/now.ts` (one 30 s interval for every
 * subscriber, an immediate tick when the tab becomes visible again) — the classic relative-time ticker, so a page left
 * open never shows a frozen "az önce". The absolute local time is the tooltip (and `dateTime` for assistive tech).
 */

/** The relative-time words of one language (`useT().screenKit.time`); Turkish for pure helpers without a provider. */
export type TimeWords = Messages['screenKit']['time'];
const TR_TIME: TimeWords = messagesFor('tr').screenKit.time;

/** "az önce" / "3 dk önce" / "2 sa önce" / "4 gün önce" (a time ahead counts as now). "—" for none. */
export function agoText(
  iso: string | null | undefined,
  now: number = Date.now(),
  w: TimeWords = TR_TIME,
): string {
  if (iso === null || iso === undefined) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return w.justNow;
  const m = Math.round(s / 60);
  if (m < 60) return w.minutesAgo({ n: m });
  const h = Math.round(m / 60);
  if (h < 48) return w.hoursAgo({ n: h });
  return w.daysAgo({ n: Math.round(h / 24) });
}

/** Like `agoText`, but a time ahead reads "46 dk sonra" / "2 sa sonra" (schedules, expiries). */
export function whenText(
  iso: string | null | undefined,
  now: number = Date.now(),
  w: TimeWords = TR_TIME,
): string {
  if (iso === null || iso === undefined) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  if (t <= now) return agoText(iso, now, w);
  const m = Math.max(1, Math.round((t - now) / 60_000));
  if (m < 60) return w.minutesAhead({ n: m });
  const h = Math.round(m / 60);
  if (h < 48) return w.hoursAhead({ n: h });
  return w.daysAhead({ n: Math.round(h / 24) });
}

/** "20.10.2026 14:05:09" — the absolute local time in the UI language ("—" for an unreadable value). */
export function absoluteText(iso: string, f: Formatter = TR_FORMAT): string {
  return f.dateWith(iso, DATE_TIME_NUMERIC);
}

/**
 * The relative time that keeps moving (shared 30 s clock + visibility); the absolute local time as its tooltip.
 * `future`: a time ahead reads "… sonra" (otherwise it counts as now).
 */
export function DyTime(props: {
  readonly iso: string;
  readonly className?: string | undefined;
  readonly future?: boolean | undefined;
}): ReactNode {
  const now = useNow();
  const f = useFormat();
  const w = useT().screenKit.time;
  return (
    <time dateTime={props.iso} title={absoluteText(props.iso, f)} className={props.className}>
      {props.future === true ? whenText(props.iso, now, w) : agoText(props.iso, now, w)}
    </time>
  );
}

/** The absolute local time, the (moving) relative one in the tooltip. */
export function DyAbsoluteTime(props: {
  readonly iso: string;
  readonly className?: string | undefined;
}): ReactNode {
  const now = useNow();
  const f = useFormat();
  const w = useT().screenKit.time;
  return (
    <time dateTime={props.iso} title={agoText(props.iso, now, w)} className={props.className}>
      {absoluteText(props.iso, f)}
    </time>
  );
}
