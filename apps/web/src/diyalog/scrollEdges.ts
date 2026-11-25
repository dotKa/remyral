import { type RefObject, useLayoutEffect } from 'react';

/** Which sides of a sideways-scrolling row hide more content: `start`, `end`, `start end`, or null (all in view). */
export function scrollEdges(el: {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}): string | null {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 1) return null;
  const left = Math.abs(el.scrollLeft); // RTL scrolls negative
  const sides = [left > 1 ? 'start' : null, left < max - 1 ? 'end' : null].filter((s) => s !== null);
  return sides.length === 0 ? null : sides.join(' ');
}

/**
 * p22-classic-removal (docs/design/p22-classic-removal.md §4): a row that scrolls sideways says so — `data-more`
 * names the side(s) with hidden content and the CSS fades that edge (`.dy-edge-fade`, chat.css). Re-checked on
 * scroll, on a resize of the row and when its content changes. Not motion: it is on under reduced motion too.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = (): void => {
      const more = scrollEdges(el);
      if (more === null) delete el.dataset.more;
      else el.dataset.more = more;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref]);
}
