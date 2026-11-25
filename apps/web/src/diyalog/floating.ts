import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';

/**
 * p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.3): collision-aware placement for every Diyalog dropdown, menu and
 * popover — one helper, no dependency.
 *
 *   flip   below the anchor when it fits, else above when that fits, else on the roomier side with a max height
 *          (the content scrolls inside);
 *   shift  aligned to the anchor's end (or start) edge, then moved left / right to stay `margin` px inside the
 *          window (narrower than the window when it must be);
 *   live   re-placed on scroll (any scroller) and resize, one frame at a time;
 *   phones below 640 px the caller renders a bottom sheet instead (`useFloating(...).sheet`).
 *
 * The floating element is `position: fixed`; render it into the Diyalog scope root — or, inside a modal `<dialog>`, into
 * that dialog (see {@link floatingRoot}) — so no transformed / blurred / scrolling ancestor clips it or becomes its
 * containing block.
 */

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Placement {
  readonly top: number;
  readonly left: number;
  readonly maxHeight: number;
  readonly maxWidth: number;
  readonly side: 'bottom' | 'top';
}

export interface PlaceOptions {
  /** Distance to keep from the window edges (default 8). */
  readonly margin?: number;
  /** Distance between anchor and floating element (default 4). */
  readonly gap?: number;
  /** Which anchor edge the floating element lines up with (default 'end': right edges aligned). */
  readonly align?: 'start' | 'end';
}

/** {@link useFloating} options beyond the placement. */
export interface FloatingOptions extends PlaceOptions {
  /** Below 640 px report `sheet` (the caller renders a bottom sheet). Default true; false for a combobox's list,
   * which stays next to its field (the on-screen keyboard is up while it is open). */
  readonly phoneSheet?: boolean;
  /** At least as wide as the anchor (a combobox's list under its field). */
  readonly matchWidth?: boolean;
}

/** Pure placement of a `width` × `height` box next to `anchor` inside a `vw` × `vh` window. */
export function place(
  anchor: Rect,
  size: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
  opts: PlaceOptions = {},
): Placement {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 4;
  const below = Math.max(0, view.height - anchor.bottom - gap - margin);
  const above = Math.max(0, anchor.top - gap - margin);
  let side: 'bottom' | 'top';
  if (size.height <= below) side = 'bottom';
  else if (size.height <= above) side = 'top';
  else side = below >= above ? 'bottom' : 'top';
  const room = side === 'bottom' ? below : above;
  const height = Math.min(size.height, room);
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  const maxWidth = Math.max(0, view.width - 2 * margin);
  const width = Math.min(size.width, maxWidth);
  const wanted = (opts.align ?? 'end') === 'end' ? anchor.right - width : anchor.left;
  const left = Math.min(Math.max(wanted, margin), view.width - margin - width);
  return { top, left: Math.max(margin, left), maxHeight: room, maxWidth, side };
}

const PHONE = '(max-width: 639.98px)';

function phoneMql(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE)
    : null;
}

/** True below 640 px (live): menus become bottom sheets. jsdom without matchMedia: false. */
export function usePhoneSheet(): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = phoneMql();
      if (m === null) return () => undefined;
      m.addEventListener('change', l);
      return () => {
        m.removeEventListener('change', l);
      };
    },
    () => phoneMql()?.matches ?? false,
    () => false,
  );
}

/**
 * Where a floating element renders. Inside an open modal `<dialog>` (DyDialog, the step-up dialog): that dialog — it
 * sits in the browser's top layer and makes everything outside it inert, so a list portalled elsewhere would lie
 * under it and could not be clicked (p17-ui-batch); `position: fixed` lets the list leave the dialog's scrolling box
 * (a dialog at rest has no transform). Elsewhere the Diyalog scope root around `from` (keeps the tokens), else the
 * body.
 */
export function floatingRoot(from: Element | null): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const dialog = from?.closest<HTMLElement>('dialog[open]');
  if (dialog !== null && dialog !== undefined) return dialog;
  const root = from?.closest<HTMLElement>('[data-ui="diyalog"]');
  return root ?? document.body;
}

/** The visible window in layout-viewport coordinates: the on-screen keyboard (visualViewport) is not room. */
function viewSize(): { readonly width: number; readonly height: number } {
  // Optional chaining: absent in some environments (jsdom), although the DOM types say `VisualViewport | null`.
  const vv = window.visualViewport;
  const inner = window.innerHeight;
  const height = Math.min(inner, (vv?.offsetTop ?? 0) + (vv?.height ?? inner));
  return { width: window.innerWidth, height };
}

/** The CSS max height of `el` in px (a `max-h-80` class), Infinity when none. */
function cssMaxHeight(el: HTMLElement): number {
  if (typeof window.getComputedStyle !== 'function') return Number.POSITIVE_INFINITY;
  const v = Number.parseFloat(window.getComputedStyle(el).maxHeight);
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY;
}

export interface Floating {
  /** Phones: render as a bottom sheet (no position style). */
  readonly sheet: boolean;
  /** `position: fixed` + top / left / max sizes (hidden until measured). */
  readonly style: CSSProperties;
  readonly side: 'bottom' | 'top' | null;
  /** Re-measure now (after the content changed size). */
  readonly update: () => void;
}

/**
 * Places `floating` next to `anchor` while `open` (see {@link place}); re-places on scroll / resize. On phones it
 * only reports `sheet` (the caller styles the bottom sheet).
 */
export function useFloating(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  opts: FloatingOptions = {},
): Floating {
  const phone = usePhoneSheet();
  const sheet = phone && opts.phoneSheet !== false;
  const [p, setP] = useState<(Placement & { readonly width: number | null; readonly cap: number }) | null>(
    null,
  );
  const { margin, gap, align, matchWidth } = opts;
  const update = useCallback(() => {
    const a = anchor.current;
    const f = floating.current;
    if (a === null || f === null) return;
    const r = a.getBoundingClientRect();
    const width = matchWidth === true ? Math.round(r.right - r.left) : null;
    // Natural size: measured without the max height a previous placement gave it (a CSS max height still caps it).
    const prevMax = f.style.maxHeight;
    const prevMin = f.style.minWidth;
    f.style.maxHeight = '';
    if (width !== null) f.style.minWidth = `${String(width)}px`;
    const cap = cssMaxHeight(f);
    const size = {
      width: Math.max(f.offsetWidth, width ?? 0),
      height: Math.min(f.scrollHeight || f.offsetHeight, cap),
    };
    f.style.maxHeight = prevMax;
    f.style.minWidth = prevMin;
    const placed = place(r, size, viewSize(), {
      ...(margin === undefined ? {} : { margin }),
      ...(gap === undefined ? {} : { gap }),
      ...(align === undefined ? {} : { align }),
    });
    setP({ ...placed, width, cap });
  }, [anchor, floating, margin, gap, align, matchWidth]);
  useLayoutEffect(() => {
    if (!open || sheet) {
      setP(null);
      return;
    }
    update();
    let frame = 0;
    const later = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    window.visualViewport?.addEventListener('resize', later);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      window.visualViewport?.removeEventListener('resize', later);
    };
  }, [open, sheet, update]);
  const style: CSSProperties =
    sheet || !open
      ? {}
      : p === null
        ? { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
        : {
            position: 'fixed',
            top: p.top,
            left: p.left,
            // The room on its side, never more than its own CSS cap (a `max-h-80` list stays that short).
            maxHeight: Math.min(p.maxHeight, p.cap),
            maxWidth: p.maxWidth,
            ...(p.width === null ? {} : { minWidth: Math.min(p.width, p.maxWidth) }),
            transformOrigin: `${p.side === 'bottom' ? 'top' : 'bottom'} ${(align ?? 'end') === 'end' ? 'right' : 'left'}`,
          };
  return { sheet, style, side: p?.side ?? null, update };
}

/**
 * The room above `anchor` inside the visible viewport (on-screen keyboard included), minus `margin` + `gap` — the max
 * height of a picker that opens upward from a composer (mention / command lists). Live on scroll / resize; null
 * while closed or unmeasured.
 */
export function useRoomAbove(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  opts: { readonly margin?: number; readonly gap?: number } = {},
): number | null {
  const [room, setRoom] = useState<number | null>(null);
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 8;
  useLayoutEffect(() => {
    if (!open) {
      setRoom(null);
      return;
    }
    const measure = (): void => {
      const a = anchor.current;
      if (a === null) return;
      const top = window.visualViewport?.offsetTop ?? 0;
      setRoom(Math.max(96, Math.floor(a.getBoundingClientRect().top - top - margin - gap)));
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [open, anchor, margin, gap]);
  return room;
}

/** Bottom sheet classes for a menu / dropdown on phones (above the safe area, scrolls inside). */
export const SHEET_CLASSES =
  'fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-50 max-h-[min(70dvh,32rem)] overflow-y-auto overscroll-contain rounded-[16px]';
