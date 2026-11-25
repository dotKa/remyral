import type { AppNotification } from '../api/notifications';

/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §2.5): every page of notifications this tab reads (the
 * bell's 30 s poll, the sound leader's checks, the toast preview's own check) is shared here, so the new-notification
 * preview sees what the bell sees without a poll of its own while a bell is on screen. In-page only.
 */
const EVENT = 'remyral:notification-page';
/** Asks the bell on screen to open its list ("Bildirimleri göster" on a grouped preview). */
export const OPEN_BELL_EVENT = 'remyral:open-bell';

let lastAt = Number.NEGATIVE_INFINITY;

export function publishNotificationPage(items: readonly AppNotification[], at: number = Date.now()): void {
  lastAt = at;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<readonly AppNotification[]>(EVENT, { detail: items }));
}

export function onNotificationPage(fn: (items: readonly AppNotification[]) => void): () => void {
  const listener = (e: Event): void => {
    const d = (e as CustomEvent<unknown>).detail;
    if (Array.isArray(d)) fn(d as readonly AppNotification[]);
  };
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener(EVENT, listener);
  };
}

/** When the last page was shared (ms epoch; -Infinity before the first). */
export function lastNotificationPageAt(): number {
  return lastAt;
}

export function openBell(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_BELL_EVENT));
}

/** Test seam. */
export function resetNotificationFeed(): void {
  lastAt = Number.NEGATIVE_INFINITY;
}
