import { type RefObject, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function mql(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(listener: () => void): () => void {
  const m = mql();
  if (m === null) return () => undefined;
  m.addEventListener('change', listener);
  return () => {
    m.removeEventListener('change', listener);
  };
}

/** p12-diyalog: true while the person asked the system for less motion (live; jsdom without matchMedia: false). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mql()?.matches ?? false,
    () => false,
  );
}

/** Whether the system asks for less motion right now (non-hook form). */
export function prefersReducedMotion(): boolean {
  return mql()?.matches ?? false;
}

/**
 * The longest transition / animation the element will run now, in ms (duration + delay of the longest entry). 0
 * when nothing animates: no CSS loaded (jsdom), `transition: none` (reduced motion), or a hidden element.
 */
export function motionMs(el: Element): number {
  if (typeof window.getComputedStyle !== 'function') return 0;
  const cs = window.getComputedStyle(el);
  const list = (v: string | undefined): number[] =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => (s.endsWith('ms') ? Number.parseFloat(s) : Number.parseFloat(s) * 1000))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const longest = (dur: string | undefined, delay: string | undefined): number => {
    const d = list(dur);
    const l = list(delay);
    return d.reduce((m, x, i) => Math.max(m, x + (l[i % Math.max(l.length, 1)] ?? 0)), 0);
  };
  const names = (cs.animationName || 'none').split(',').map((s) => s.trim());
  const anim = names.every((n) => n === 'none' || n === '')
    ? 0
    : longest(cs.animationDuration, cs.animationDelay);
  return Math.max(longest(cs.transitionDuration, cs.transitionDelay), anim);
}

export type PresenceState = 'open' | 'closed';

export interface Presence<T extends HTMLElement> {
  /** Render the element: open, or closed but still playing its exit. */
  readonly mounted: boolean;
  /** `data-state` for the CSS: entries animate from `@starting-style`, exits to `[data-state='closed']`. */
  readonly state: PresenceState;
  /** Attach to the animated element (its transitionend / animationend ends the exit). */
  readonly ref: RefObject<T | null>;
}

/**
 * p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.2): mount / unmount with an exit animation — the one motion
 * primitive behind the Diyalog drawers, side panels, sheets and dropdowns.
 *
 *   open → mounted at once with `data-state="open"`; the CSS enters it from `@starting-style` (no JS frame dance);
 *   close → stays mounted with `data-state="closed"` until its own transition / animation ends (or a fallback timer
 *           of that length), then unmounts. Nothing animating — reduced motion (`transition: none`), no CSS (tests),
 *           a hidden element — unmounts in the same commit, so closing is never slower than before.
 *
 * Interruptible: reopening during the exit flips the state back and the CSS transition retargets from where it is.
 * Callers mark the closing element `inert` (see {@link presenceProps}) so focus and screen readers leave at once.
 */
export function usePresence<T extends HTMLElement = HTMLElement>(
  open: boolean,
  external?: RefObject<T | null>,
): Presence<T> {
  const own = useRef<T>(null);
  const ref = external ?? own;
  const [prev, setPrev] = useState(open);
  const [exiting, setExiting] = useState(false);
  // Derived state (React's "adjust state while rendering"): a close starts an exit in the same render.
  if (prev !== open) {
    setPrev(open);
    setExiting(!open);
  }
  useLayoutEffect(() => {
    if (!exiting) return;
    const el = ref.current;
    const ms = el === null || prefersReducedMotion() ? 0 : motionMs(el);
    if (el === null || ms <= 0) {
      setExiting(false);
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      setExiting(false);
    };
    const onEnd = (e: Event): void => {
      if (e.target === el) finish();
    };
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);
    const t = window.setTimeout(finish, ms + 60);
    return () => {
      done = true;
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
      window.clearTimeout(t);
    };
  }, [exiting, ref]);
  return { mounted: open || exiting, state: open ? 'open' : 'closed', ref };
}

/** The attributes a presence element carries: its state for the CSS and `inert` while it leaves. */
export function presenceProps(p: { readonly state: PresenceState }): {
  'data-state': PresenceState;
  inert: boolean | undefined;
} {
  return { 'data-state': p.state, inert: p.state === 'closed' ? true : undefined };
}
