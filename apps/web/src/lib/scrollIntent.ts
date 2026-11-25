/**
 * p15-chat-cards-scroll item 3 (the reader may be reading while a message streams): did the person just move this
 * scroller (wheel, touch, keys, the scrollbar)? A scroll UP right after such input means "I am reading": a live view
 * stops following its end at once — not only once the reader is far from it — and follows again when the reader is back
 * at the end. Scrolls the page makes itself (following, a list shrinking under a filter) never count as the reader's.
 */

/** A live view follows its end while the reader is at most this far from it. */
export const FOLLOW_PX = 48;
/** Input this recent makes a scroll the reader's own. */
export const INTENT_MS = 1_200;

const INPUT = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'] as const;

export interface ScrollIntent {
  /** The person touched the scroller (or the page) within {@link INTENT_MS}. */
  readonly recent: () => boolean;
  readonly dispose: () => void;
}

/**
 * Watches `target` (the window, or one scrolling element) for the person's own input. `onUp`: a wheel turned up — the
 * reader wants to go back even when nothing can scroll yet.
 */
export function watchScrollIntent(
  target: Window | HTMLElement,
  onUp?: () => void,
  now: () => number = () => Date.now(),
): ScrollIntent {
  let last = Number.NEGATIVE_INFINITY;
  const mark = (e: Event): void => {
    last = now();
    if (e.type === 'wheel' && 'deltaY' in e && typeof e.deltaY === 'number' && e.deltaY < 0) onUp?.();
  };
  for (const name of INPUT) target.addEventListener(name, mark, { capture: true, passive: true });
  return {
    recent: () => now() - last <= INTENT_MS,
    dispose: () => {
      for (const name of INPUT) target.removeEventListener(name, mark, { capture: true });
    },
  };
}

/**
 * The follow decision after a scroll of a live view: `false` when the reader just scrolled up (their own input),
 * `true` when the view is back within {@link FOLLOW_PX} of its end, else unchanged.
 */
export function followAfterScroll(opts: {
  readonly following: boolean;
  readonly top: number;
  readonly lastTop: number;
  readonly distanceToEnd: number;
  readonly userInput: boolean;
}): boolean {
  if (opts.userInput && opts.top < opts.lastTop - 1) return false;
  if (opts.distanceToEnd <= FOLLOW_PX) return true;
  return opts.following;
}
