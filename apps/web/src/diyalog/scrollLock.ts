import { useEffect } from 'react';

/**
 * p22-classic-removal §7 (on phones the page shifted while the plan was open): while an overlay that
 * covers part of the page is open (the plan's phone sheet, its 40–64 rem drawer), the page behind it must not scroll.
 * A swipe on the dimmed thread above the sheet used to scroll the window — the reader's place in the conversation was
 * gone when the sheet closed. `<html data-scroll-lock>` (chat.css) sets `overflow: hidden` and stops scroll chaining;
 * the scroll position is kept. Counted, so two overlays (sheet + a dialog in it) release only when both are gone.
 */
export const SCROLL_LOCK_ATTR = 'data-scroll-lock';

let holders = 0;

/** Takes one hold on the page scroll; the returned function releases it (once). */
export function lockPageScroll(): () => void {
  const root = document.documentElement;
  holders += 1;
  root.setAttribute(SCROLL_LOCK_ATTR, '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) root.removeAttribute(SCROLL_LOCK_ATTR);
  };
}

/** Holds the page scroll while `active` (released on change and on unmount). */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    return lockPageScroll();
  }, [active]);
}
