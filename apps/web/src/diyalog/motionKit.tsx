import { type CSSProperties, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../components/ui';
import { prefersReducedMotion } from './motion';

/**
 * p17-panel-motion (docs/design/p17-panel-motion.md): the small motion helpers of the Diyalog UI, next to the presence
 * primitive in motion.ts. CSS does the moving (motion.css, tokens in motion-tokens.css); these only decide WHEN
 * something may move, and measure what CSS cannot (a card's height, a row's old place):
 *
 *   useArrivals     which list items arrived after the list first showed (never the first render, never a bulk load)
 *                   and their place in the burst (the stagger index)
 *   useChangeCount  how many times a value changed since mount (0 on the first render: nothing animates then)
 *   useSmoothHeight a card's height follows its content over --dy-m-height instead of jumping (WAAPI, in view only)
 *   useFlip         rows that changed place glide from their old place (FLIP with WAAPI transforms; short lists only)
 *
 * Everything is off under `prefers-reduced-motion: reduce` and under `[data-motion='reduce']`, where the browser has no
 * `Element.animate` (jsdom) and while the page is hidden. Nothing here delays content or blocks input.
 */

/** Items that arrive together follow each other at most this many stagger steps apart. */
export const STAGGER_MAX = 5;
/** More new items than this in one render is a load (a page, a reconnect backlog), not arrivals: they stand still. */
export const BURST_MAX = 12;
/** An item counts as arrived (keeps its entrance class) for this long. */
export const ARRIVAL_MS = 1500;

/** Fallbacks of the JS-driven tokens (motion-tokens.css), used when no CSS is loaded. */
export const MOTION_FALLBACK = {
  height: 220,
  flip: 220,
  enter: 240,
  ease: 'cubic-bezier(0.23, 1, 0.32, 1)',
} as const;

/** Motion is off for this element: the system asks for less motion, or the in-app switch (`data-motion='reduce'`). */
export function motionOff(el: Element | null): boolean {
  if (prefersReducedMotion()) return true;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
  return el?.closest('[data-motion="reduce"]') != null;
}

/** The element can run a Web Animation (jsdom cannot). */
export function canAnimate(el: Element): boolean {
  return typeof (el as Partial<HTMLElement>).animate === 'function';
}

/** A duration token (`--dy-m-height: 220ms`) in ms, or the fallback when it is not set. */
export function tokenMs(el: Element, name: string, fallback: number): number {
  if (typeof window.getComputedStyle !== 'function') return fallback;
  const v = window.getComputedStyle(el).getPropertyValue(name).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : fallback;
}

/** The strong ease-out token (`--dy-m-out`), or its fallback. */
export function tokenEase(el: Element): string {
  if (typeof window.getComputedStyle !== 'function') return MOTION_FALLBACK.ease;
  const v = window.getComputedStyle(el).getPropertyValue('--dy-m-out').trim();
  return v === '' ? MOTION_FALLBACK.ease : v;
}

/** The element is (at least partly) inside the window. */
function inView(top: number, bottom: number): boolean {
  return bottom > 0 && top < window.innerHeight;
}

/* ------------------------------------------------------------------ arrivals */

interface Seen {
  readonly at: number;
  readonly i: number;
}

/**
 * Which of `keys` arrived after the list first had content, as key → stagger index (0 … STAGGER_MAX) within the
 * render they arrived in, for ARRIVAL_MS. The keys present at the first non-empty, ready render are history (stand
 * still); so are keys loaded above everything already known (an older page) and any burst of more than BURST_MAX new
 * keys at once (a backlog). Render-pure under StrictMode's double render: freshness is a time window.
 */
export function useArrivals(
  keys: readonly string[],
  ready = true,
  now: number = Date.now(),
): ReadonlyMap<string, number> {
  const seen = useRef<Map<string, Seen> | null>(null);
  if (seen.current === null && keys.length > 0 && ready)
    seen.current = new Map(keys.map((k) => [k, { at: 0, i: 0 }]));
  const map = seen.current;
  const out = new Map<string, number>();
  if (map === null) return out;
  const firstKnown = keys.findIndex((k) => map.has(k));
  const fresh = keys.filter((k, i) => !map.has(k) && !(firstKnown >= 0 && i < firstKnown));
  const burst = fresh.length > BURST_MAX;
  let n = 0;
  keys.forEach((k, i) => {
    if (map.has(k)) return;
    const history = burst || (firstKnown >= 0 && i < firstKnown);
    map.set(k, history ? { at: 0, i: 0 } : { at: now, i: Math.min(n++, STAGGER_MAX) });
  });
  for (const k of keys) {
    const s = map.get(k);
    if (s !== undefined && s.at > 0 && now - s.at < ARRIVAL_MS) out.set(k, s.i);
  }
  return out;
}

/** The inline style that carries an arrival's stagger index to the CSS (`--dy-i`). */
export function arrivalStyle(i: number | undefined): CSSProperties | undefined {
  return i === undefined || i === 0 ? undefined : ({ '--dy-i': String(i) } as CSSProperties);
}

/* ------------------------------------------------------------------ changes */

/**
 * How many times `value` changed since this component mounted: 0 on the first render, so a list that renders never
 * animates its states; a later change (Onay bekliyor → Çalışıyor) gets a new count — use it as a `key` with a class
 * whose CSS animation then runs once on the new element.
 */
export function useChangeCount(value: string | number | boolean | null): number {
  const [s, setS] = useState({ v: value, n: 0 });
  if (!Object.is(s.v, value)) {
    const next = { v: value, n: s.n + 1 };
    setS(next);
    return next.n;
  }
  return s.n;
}

/**
 * A short label whose changes cross-fade in (opacity + 2 px blur + a slight scale, --dy-m-swap): the first render stands
 * still. Ghost-free: the old label leaves at once and the blur bridges the two, so a screen reader and a test only
 * ever see one label.
 */
export function Swap(props: {
  readonly k: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): ReactNode {
  const n = useChangeCount(props.k);
  return (
    <span key={n} className={cx(n > 0 && 'dy-m-swap', props.className)} data-swap={n > 0 ? '' : undefined}>
      {props.children}
    </span>
  );
}

/* ------------------------------------------------------------------ height */

/**
 * `outer`'s height follows `inner`'s content: when the content grows or shrinks (a card resolves, a panel opens, a
 * result replaces its loading line), the outer box eases from its old height to the new one over --dy-m-height
 * (a Web Animation of `height`, the one layout property animated — there is no transform equivalent; `outer` clips
 * while it runs). The first size is only recorded. Skipped when motion is off, the box is out of view or the change is
 * under 2 px, and while a smooth-height box inside is easing (the outer one follows it frame by frame); a new change
 * mid-way retargets from the height shown.
 *
 * Changes are noticed by a MutationObserver (a microtask after the DOM change, before the frame is painted), not by a
 * ResizeObserver: starting a height animation inside a ResizeObserver callback resizes the observed ancestors in the
 * same loop ("ResizeObserver loop completed with undelivered notifications"). A ResizeObserver only keeps the
 * recorded height in step with changes that are not DOM mutations (an image loading, fonts, the window) — never
 * animating them.
 */
export function useSmoothHeight(
  outer: RefObject<HTMLElement | null>,
  inner: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (o === null || i === null || typeof MutationObserver === 'undefined') return;
    let last = o.offsetHeight;
    let anim: Animation | null = null;
    const check = (): void => {
      const shown = anim === null ? last : o.getBoundingClientRect().height;
      anim?.cancel();
      anim = null;
      const next = o.offsetHeight;
      last = next;
      if (Math.abs(next - shown) < 2 || !canAnimate(o) || motionOff(o)) return;
      // A card inside is easing its own height: this box follows it frame by frame already (no second, lagging ease).
      if (i.querySelector('[data-dy-resizing]') !== null) return;
      const r = o.getBoundingClientRect();
      if (!inView(r.top, r.top + Math.max(shown, next))) return;
      const a = o.animate([{ height: `${String(shown)}px` }, { height: `${String(next)}px` }], {
        duration: tokenMs(o, '--dy-m-height', MOTION_FALLBACK.height),
        easing: tokenEase(o),
      });
      o.dataset.dyResizing = '';
      anim = a;
      const done = (): void => {
        if (anim === a) {
          anim = null;
          delete o.dataset.dyResizing;
        }
      };
      a.addEventListener('finish', done);
      a.addEventListener('cancel', done);
    };
    const mo = new MutationObserver(check);
    mo.observe(i, { subtree: true, childList: true, characterData: true, attributes: true });
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (anim === null) last = o.offsetHeight;
          });
    ro?.observe(i);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      anim?.cancel();
    };
  }, [outer, inner]);
}

/** A block whose height eases to its content's (useSmoothHeight). */
export function SmoothHeight(props: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): ReactNode {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useSmoothHeight(outer, inner);
  return (
    <div ref={outer} className={cx('dy-m-height', props.className)}>
      <div ref={inner} className="flow-root">
        {props.children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ FLIP */

/** Lists longer than this never FLIP (the measuring would cost more than the motion gives). */
export const FLIP_MAX = 150;

interface Place {
  readonly x: number;
  readonly y: number;
}

/** Layout position of `el` inside `container` (transform-free: offsets, not client rects). */
function placeOf(el: HTMLElement, container: HTMLElement): Place | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement = el;
  while (node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent: Element | null = node.offsetParent;
    if (!(parent instanceof HTMLElement)) return null;
    // An offset parent outside the container: subtract the container's own offset from the same parent.
    if (!container.contains(parent) && parent !== container) {
      return { x: x - container.offsetLeft, y: y - container.offsetTop };
    }
    node = parent;
  }
  return { x, y };
}

/** The rows' places and their order (the signature a FLIP compares), or null for a list too long to FLIP. */
function measure(container: HTMLElement): Snapshot | null {
  const els = container.querySelectorAll<HTMLElement>('[data-flip-key]');
  if (els.length > FLIP_MAX) return null;
  const places = new Map<string, Place>();
  const keys: string[] = [];
  for (const el of els) {
    const k = el.dataset.flipKey ?? '';
    keys.push(k);
    const p = placeOf(el, container);
    if (p !== null) places.set(k, p);
  }
  return { sig: keys.join('|'), places, width: container.offsetWidth };
}

interface Snapshot {
  readonly sig: string;
  readonly places: ReadonlyMap<string, Place>;
  readonly width: number;
}

/**
 * FLIP for a short list: the elements under `container` marked `data-flip-key` (a stable id) that are still there after
 * the list changed — reordered, a row inserted or removed above them — glide from their old place to the new one (a
 * transform Web Animation over --dy-m-flip, ease-out: the data already changed, the row catches up). New rows keep
 * their own entrance (CSS), removed rows leave at once. Places are re-measured after every commit of the owner and
 * every resize of the container, so only a change of the rows' order / set moves anything; a width change (window
 * resize, a panel opening) never animates. Off for more than FLIP_MAX rows. `container` should be positioned
 * (`relative`): places are layout offsets inside it (transform-free, scroll-free).
 */
export function useFlip(container: RefObject<HTMLElement | null>): void {
  const last = useRef<Snapshot | null>(null);

  useLayoutEffect(() => {
    const c = container.current;
    if (c === null) return;
    // Motion off: nothing to measure for (the next commit with motion on only records the places).
    if (motionOff(c)) {
      last.current = null;
      return;
    }
    const now = measure(c);
    const before = last.current;
    last.current = now;
    if (now === null || before === null || before.sig === now.sig || before.width !== now.width) return;
    const duration = tokenMs(c, '--dy-m-flip', MOTION_FALLBACK.flip);
    const easing = tokenEase(c);
    for (const el of c.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const k = el.dataset.flipKey ?? '';
      const from = before.places.get(k);
      const to = now.places.get(k);
      if (from === undefined || to === undefined || !canAnimate(el)) continue;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const r = el.getBoundingClientRect();
      if (!inView(r.top, r.bottom) && !inView(r.top + dy, r.bottom + dy)) continue;
      const start = `translate(${String(dx)}px,${String(dy)}px)`; // i18n-ignore: CSS transform value
      el.animate([{ transform: start }, { transform: 'none' }], { duration, easing });
    }
  });

  // A resize (content above grew, the window changed) re-measures without animating.
  useLayoutEffect(() => {
    const c = container.current;
    if (c === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (last.current !== null) last.current = measure(c);
    });
    ro.observe(c);
    return () => {
      ro.disconnect();
    };
  }, [container]);
}
