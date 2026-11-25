import type { Formatter } from '@remyral/i18n';

/** Chat time helpers (p5-chat-ux): thread-list groups and message timestamps, in the viewer's local time. */

export type ThreadGroup = 'Today' | 'Yesterday' | 'Last 7 days' | 'Older';

const GROUP_ORDER: readonly ThreadGroup[] = ['Today', 'Yesterday', 'Last 7 days', 'Older'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function threadGroup(iso: string, now: Date = new Date()): ThreadGroup {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Older';
  const today = startOfDay(now);
  const day = 24 * 3600 * 1000;
  // Local midnights; DST days are 23/25 h, so compare with the previous midnight computed from the calendar.
  const yesterday = startOfDay(new Date(today - day / 2));
  const weekAgo = startOfDay(new Date(today - 6 * day + day / 2));
  if (t >= today) return 'Today';
  if (t >= yesterday) return 'Yesterday';
  if (t >= weekAgo) return 'Last 7 days';
  return 'Older';
}

/** Items grouped by `updatedAt` (order inside a group kept; empty groups left out). */
export function groupThreads<T extends { readonly updatedAt: string }>(
  items: readonly T[],
  now: Date = new Date(),
): { readonly label: ThreadGroup; readonly items: T[] }[] {
  const by = new Map<ThreadGroup, T[]>();
  for (const it of items) {
    const g = threadGroup(it.updatedAt, now);
    by.set(g, [...(by.get(g) ?? []), it]);
  }
  return GROUP_ORDER.flatMap((label) => {
    const list = by.get(label);
    return list === undefined ? [] : [{ label, items: list }];
  });
}

/**
 * "14:05" today, "Mon 14:05" this week, "12 Oct 14:05" otherwise. Browser locale by default (the classic console);
 * p14-i18n-shell: Diyalog passes its `useFormat()` formatter, so the words follow the user's language.
 */
export function shortTime(iso: string, now: Date = new Date(), format?: Formatter): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = (o: Intl.DateTimeFormatOptions, date: boolean): string =>
    format !== undefined
      ? format.dateWith(d, o)
      : date
        ? d.toLocaleDateString(undefined, o)
        : d.toLocaleTimeString(undefined, o);
  const time = fmt({ hour: '2-digit', minute: '2-digit' }, false);
  const g = threadGroup(iso, now);
  if (g === 'Today') return time;
  if (g === 'Yesterday' || g === 'Last 7 days') return `${fmt({ weekday: 'short' }, true)} ${time}`;
  return `${fmt({ day: 'numeric', month: 'short' }, true)} ${time}`;
}
