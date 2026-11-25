import { INTL_TAG, type Locale } from './locale.js';

/**
 * Locale-bound display formatting (ADR-0053 §4): the one place that calls `Intl.DateTimeFormat`,
 * `Intl.NumberFormat`, `Intl.RelativeTimeFormat` and `Intl.ListFormat` for user-visible text. Formatters are
 * cached per (locale, options, time zone). `tr` → tr-TR, `en` → en-GB (24 h, day-month order).
 *
 * Phase 0 provides the API; call sites move here screen by screen (plan §4.6).
 */

export type DateInput = Date | string | number;

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const made = make();
  cache.set(key, made);
  return made;
}

function toDate(v: DateInput): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Shown for a missing or unparsable value. */
export const NO_VALUE = '—';

export interface FormatOptions {
  /** IANA time zone for dates (default: the runtime's zone — the browser's, or the master's TZ). */
  readonly timeZone?: string | undefined;
}

function dtf(locale: Locale, opts: Intl.DateTimeFormatOptions, timeZone: string | undefined) {
  const o: Intl.DateTimeFormatOptions = timeZone === undefined ? opts : { ...opts, timeZone };
  return cached(`dt|${locale}|${JSON.stringify(o)}`, () => new Intl.DateTimeFormat(INTL_TAG[locale], o));
}

function nf(locale: Locale, opts: Intl.NumberFormatOptions) {
  return cached(`nf|${locale}|${JSON.stringify(opts)}`, () => new Intl.NumberFormat(INTL_TAG[locale], opts));
}

export function formatDateTime(locale: Locale, v: DateInput, o: FormatOptions = {}): string {
  const d = toDate(v);
  return d === null
    ? NO_VALUE
    : dtf(locale, { dateStyle: 'medium', timeStyle: 'short' }, o.timeZone).format(d);
}

export function formatDate(locale: Locale, v: DateInput, o: FormatOptions = {}): string {
  const d = toDate(v);
  return d === null ? NO_VALUE : dtf(locale, { dateStyle: 'medium' }, o.timeZone).format(d);
}

export function formatTime(locale: Locale, v: DateInput, o: FormatOptions = {}): string {
  const d = toDate(v);
  return d === null ? NO_VALUE : dtf(locale, { timeStyle: 'short' }, o.timeZone).format(d);
}

/**
 * p14-i18n-shell: a date/time with explicit `Intl.DateTimeFormat` options (weekday, month name, seconds, …) — for
 * call sites whose shape the fixed styles above do not cover. Same cache and time-zone handling.
 */
export function formatDateTimeWith(
  locale: Locale,
  v: DateInput,
  opts: Intl.DateTimeFormatOptions,
  o: FormatOptions = {},
): string {
  const d = toDate(v);
  return d === null ? NO_VALUE : dtf(locale, opts, o.timeZone ?? opts.timeZone).format(d);
}

/** p14-i18n-shell: `Intl.RelativeTimeFormat` for a value already in `unit` ("3 dakika önce", "in 2 hours"). */
export function formatRelativeUnit(
  locale: Locale,
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  numeric: 'auto' | 'always' = 'auto',
): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  const rtf = cached(
    `rtu|${locale}|${numeric}`,
    () => new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric, style: 'long' }),
  );
  return rtf.format(value, unit);
}

const RELATIVE_STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/** "3 dakika önce" / "3 minutes ago", "yarın" / "tomorrow"; the largest unit that fits. */
export function formatRelative(locale: Locale, v: DateInput, now: DateInput = Date.now()): string {
  const d = toDate(v);
  const n = toDate(now);
  if (d === null || n === null) return NO_VALUE;
  const rtf = cached(
    `rt|${locale}`,
    () => new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: 'auto', style: 'long' }),
  );
  let amount = (d.getTime() - n.getTime()) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(amount) < size) return rtf.format(Math.round(amount), unit);
    amount /= size;
  }
  return rtf.format(Math.round(amount), 'year');
}

export function formatNumber(locale: Locale, n: number, opts: Intl.NumberFormatOptions = {}): string {
  return Number.isFinite(n) ? nf(locale, opts).format(n) : NO_VALUE;
}

/** 12 300 → "12,3 B" / "12.3K". */
export function formatCompact(locale: Locale, n: number): string {
  return formatNumber(locale, n, { notation: 'compact', maximumFractionDigits: 1 });
}

/** 0.42 → "%42" / "42%". */
export function formatPercent(locale: Locale, ratio: number): string {
  return formatNumber(locale, ratio, { style: 'percent', maximumFractionDigits: 0 });
}

/** US dollars (provider prices are in USD); sub-dollar amounts keep 4 decimals. */
export function formatUsd(locale: Locale, n: number): string {
  if (!Number.isFinite(n)) return NO_VALUE;
  const small = n !== 0 && Math.abs(n) < 1;
  return formatNumber(locale, n, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  });
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1024-based sizes with the locale's decimal separator: "1,5 MB" / "1.5 MB". */
export function formatBytes(locale: Locale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NO_VALUE;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${formatNumber(locale, v, { maximumFractionDigits: digits })} ${BYTE_UNITS[i] ?? 'B'}`;
}

const DURATION_UNITS: Readonly<Record<Locale, { d: string; h: string; m: string; s: string }>> = {
  tr: { d: 'g', h: 'sa', m: 'dk', s: 'sn' },
  en: { d: 'd', h: 'h', m: 'min', s: 's' },
};

/** Milliseconds as the two largest units: "45 sn", "3 dk 05 sn", "2 sa 10 dk" / "45 s", "3 min 05 s". */
export function formatDuration(locale: Locale, ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NO_VALUE;
  const u = DURATION_UNITS[locale];
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)} ${u.s}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)} ${u.m} ${String(s % 60).padStart(2, '0')} ${u.s}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)} ${u.h} ${String(m % 60).padStart(2, '0')} ${u.m}`;
  return `${String(Math.floor(h / 24))} ${u.d} ${String(h % 24)} ${u.h}`;
}

/** ["a", "b", "c"] → "a, b ve c" / "a, b and c". */
export function formatList(
  locale: Locale,
  items: readonly string[],
  type: 'conjunction' | 'disjunction' = 'conjunction',
): string {
  const lf = cached(`lf|${locale}|${type}`, () => new Intl.ListFormat(INTL_TAG[locale], { type }));
  return lf.format(items);
}

/** Every formatter bound to one locale (and optionally one time zone). */
export interface Formatter {
  readonly locale: Locale;
  dateTime(v: DateInput): string;
  date(v: DateInput): string;
  time(v: DateInput): string;
  relative(v: DateInput, now?: DateInput): string;
  /** A date/time with explicit Intl options (p14-i18n-shell). */
  dateWith(v: DateInput, opts: Intl.DateTimeFormatOptions): string;
  /** A relative time for a value already in `unit` (p14-i18n-shell). */
  relativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit, numeric?: 'auto' | 'always'): string;
  number(n: number, opts?: Intl.NumberFormatOptions): string;
  compact(n: number): string;
  percent(ratio: number): string;
  usd(n: number): string;
  bytes(n: number): string;
  duration(ms: number): string;
  list(items: readonly string[], type?: 'conjunction' | 'disjunction'): string;
}

export function createFormatter(locale: Locale, o: FormatOptions = {}): Formatter {
  return {
    locale,
    dateTime: (v) => formatDateTime(locale, v, o),
    date: (v) => formatDate(locale, v, o),
    time: (v) => formatTime(locale, v, o),
    relative: (v, now) => formatRelative(locale, v, now),
    dateWith: (v, opts) => formatDateTimeWith(locale, v, opts, o),
    relativeUnit: (value, unit, numeric) => formatRelativeUnit(locale, value, unit, numeric),
    number: (n, opts) => formatNumber(locale, n, opts),
    compact: (n) => formatCompact(locale, n),
    percent: (r) => formatPercent(locale, r),
    usd: (n) => formatUsd(locale, n),
    bytes: (n) => formatBytes(locale, n),
    duration: (ms) => formatDuration(locale, ms),
    list: (items, type) => formatList(locale, items, type),
  };
}
