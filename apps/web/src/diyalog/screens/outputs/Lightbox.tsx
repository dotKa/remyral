import { type ReactNode, type TouchEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DyIcon } from '../../icons';
import { presenceProps, usePresence, useReducedMotion } from '../../motion';

/**
 * p15-workspace-retention §8 (screenshots looked squashed): images of job outputs never lose
 * their aspect ratio — every preview is `object-contain` inside a bounded box (never stretched by a flex parent); a
 * hover shows a zoom affordance; a click opens this lightbox: the image at full size (fit to the viewport), ←/→ and
 * Esc on the keyboard, a swipe on phones, a download link and next / previous across the job's images. The images are
 * the same-origin download routes (CSP + nosniff, decoded only as images).
 *
 * p17-chat-drawer (docs/design/p17-chat-drawer.md §2): the one lightbox of the panel — the chat's details drawer
 * (Görseller) and a message's image attachments open it too. Added: size and an optional meta line under the name;
 * "Sohbette göster"; Home / End; `wrap={false}` (the ends disable ←/→ instead of wrapping); a focus trap, focus back on
 * the thumbnail of the image last shown; neighbours prefetched; a placeholder of the known size while the image loads
 * (no jump); open / close and the image switch through the motion system (presence + `dy-m-lb*` in motion.css; reduced
 * motion: nothing moves).
 */

export interface LightboxImage {
  readonly src: string;
  readonly name: string;
  /** Download URL (null: no download). */
  readonly download: string | null;
  /** Size in bytes, shown under the name (absent / null: not shown). */
  readonly sizeBytes?: number | null | undefined;
  /** Intrinsic size when known: the loading placeholder takes its aspect ratio (no jump when the image arrives). */
  readonly width?: number | null | undefined;
  readonly height?: number | null | undefined;
  /** More words for the line under the name (the conversation, the time). */
  readonly meta?: string | null | undefined;
  /** "Sohbette göster": the lightbox closes and the image's message is shown (absent: no button). */
  readonly onShowInChat?: (() => void) | null | undefined;
}

const SWIPE_PX = 48;

/**
 * p15-model-picker (lightbox fix): where the lightbox is portalled. Opened inside a modal `<dialog>`
 * (the Outputs drawer, the job result card drawer) it must render INSIDE that dialog: a modal dialog sits in the
 * browser's top layer and makes everything outside it inert, so a portal into `document.body` lay under the drawer
 * whatever its z-index. Elsewhere it renders into the Diyalog scope root (`[data-ui="diyalog"]`): the `--dy-*` tokens
 * (the dark backdrop, the control colours) exist only inside that subtree. `document.body` only as a last resort.
 */
export function lightboxHost(from: Element | null): HTMLElement {
  const dialog = from?.closest<HTMLElement>('dialog[open]');
  if (dialog !== null && dialog !== undefined) return dialog;
  return from?.closest<HTMLElement>('[data-ui="diyalog"]') ?? document.body;
}

/** The next index for a step (±1) or a jump (first / last); null when there is nowhere to go. Pure. */
export function lightboxStep(
  at: number,
  n: number,
  move: 1 | -1 | 'first' | 'last',
  wrap: boolean,
): number | null {
  if (n < 2) return null;
  let next: number;
  if (move === 'first') next = 0;
  else if (move === 'last') next = n - 1;
  else if (wrap) next = (at + move + n) % n;
  else next = at + move;
  if (next < 0 || next >= n || next === at) return null;
  return next;
}

/** The swipe a touch made: 1 (left → next), -1 (right → previous) or null (too short, or mostly vertical). Pure. */
export function swipeDirection(dx: number, dy: number): 1 | -1 | null {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return null;
  return dx < 0 ? 1 : -1;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Dir = 'next' | 'prev' | null;

interface Shown {
  readonly open: boolean;
  /** The image shown (kept after a close so the exit plays with its content). */
  readonly at: number | null;
  /** How the current image came in (for the switch motion); null on open and under reduced motion. */
  readonly dir: Dir;
}

export function DyLightbox(props: {
  readonly images: readonly LightboxImage[];
  readonly index: number | null;
  readonly onIndex: (i: number) => void;
  readonly onClose: () => void;
  /** ←/→ past the last / first image wrap around (default true); false disables the buttons at the ends. */
  readonly wrap?: boolean | undefined;
  /** Where focus goes back when the lightbox closes: the thumbnail of the image last shown (default: the opener). */
  readonly returnFocus?: ((i: number) => HTMLElement | null) | undefined;
}): ReactNode {
  const t = useT().workfiles.lightbox;
  const f = useFormat();
  const reduce = useReducedMotion();
  const { images, index, onIndex, onClose } = props;
  const wrap = props.wrap ?? true;
  const n = images.length;
  const open = index !== null && images[index] !== undefined;
  // Adjust-state-while-rendering: the image shown, how it came in, and the last one (for the exit).
  const [shown, setShown] = useState<Shown>({ open, at: open ? index : null, dir: null });
  if (shown.open !== open || (open && shown.at !== index)) {
    const from = open && shown.open && !reduce ? shown.at : null;
    setShown({
      open,
      at: open ? index : shown.at,
      dir: from === null || index === null ? null : index > from ? 'next' : 'prev',
    });
  }
  const presence = usePresence<HTMLDivElement>(open);
  const at = open ? index : shown.at;
  const img = at === null ? undefined : images[at];
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  // An invisible marker where the lightbox sits in the tree: its nearest open dialog / theme root is the portal host.
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [loaded, setLoaded] = useState<{ readonly src: string; readonly ok: boolean } | null>(null);
  useLayoutEffect(() => {
    setHost(presence.mounted ? lightboxHost(anchor.current) : null);
  }, [presence.mounted]);

  const go = (move: 1 | -1 | 'first' | 'last'): void => {
    if (index === null) return;
    const next = lightboxStep(index, n, move, wrap);
    if (next !== null) onIndex(next);
  };
  // The latest handlers for the document listener (registered once per opening).
  const latest = useRef({ go, onClose, at, returnFocus: props.returnFocus });
  useLayoutEffect(() => {
    latest.current = { go, onClose, at, returnFocus: props.returnFocus };
  });

  const live = open && host !== null;
  useEffect(() => {
    if (!live) return;
    opener.current = document.activeElement;
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent): void => {
      const l = latest.current;
      const move =
        e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowLeft'
            ? -1
            : e.key === 'Home'
              ? 'first'
              : e.key === 'End'
                ? 'last'
                : null;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        l.onClose();
      } else if (move !== null) {
        e.preventDefault();
        e.stopPropagation();
        l.go(move);
      } else if (e.key === 'Tab') {
        // Focus stays inside the lightbox (it is modal): Tab past the last control comes back to the first.
        const box = closeRef.current?.closest<HTMLElement>('[data-testid="lightbox"]');
        if (box === null || box === undefined) return;
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = items[0];
        const last = items[items.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        if (!box.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Capture: an enclosing dialog (the outputs drawer) or panel (the details drawer) must not see the same key.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      const l = latest.current;
      const back = l.at === null ? null : (l.returnFocus?.(l.at) ?? null);
      const target = back ?? opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [live]);

  // A nav button that just got disabled (the first / last image) hands focus to its partner instead of losing it.
  useEffect(() => {
    if (!live) return;
    const active = document.activeElement;
    if (active === prevRef.current && prevRef.current?.disabled === true) nextRef.current?.focus();
    else if (active === nextRef.current && nextRef.current?.disabled === true) prevRef.current?.focus();
    else if (active === document.body || active === null) closeRef.current?.focus();
  }, [live, index]);

  const marker = <span ref={anchor} hidden data-testid="lightbox-anchor" />;
  if (!presence.mounted || img === undefined || at === null || host === null) return marker;
  const onTouchStart = (e: TouchEvent): void => {
    const p = e.touches[0];
    touch.current = p === undefined ? null : { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e: TouchEvent): void => {
    const start = touch.current;
    const p = e.changedTouches[0];
    touch.current = null;
    if (start === null || p === undefined) return;
    const d = swipeDirection(p.clientX - start.x, p.clientY - start.y);
    if (d !== null) go(d);
  };
  const state = loaded?.src === img.src ? (loaded.ok ? 'ready' : 'failed') : 'loading';
  const ratio =
    typeof img.width === 'number' && typeof img.height === 'number' && img.width > 0 && img.height > 0
      ? { w: img.width, h: img.height }
      : null;
  const canPrev = lightboxStep(at, n, -1, wrap) !== null;
  const canNext = lightboxStep(at, n, 1, wrap) !== null;
  const neighbours = [at - 1, at + 1]
    .map((i) => images[wrap ? (i + n) % n : i])
    .filter((x): x is LightboxImage => x !== undefined && x.src !== img.src);
  const sub = [
    img.sizeBytes === null || img.sizeBytes === undefined ? null : f.bytes(img.sizeBytes),
    img.meta ?? null,
  ].filter((s): s is string => s !== null && s !== '');
  const showInChat = img.onShowInChat ?? null;
  const ctl =
    'dy-press grid size-11 shrink-0 place-items-center rounded-full bg-dy-lightbox-ctl text-white outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-35';
  const box = createPortal(
    <div
      ref={presence.ref}
      {...presenceProps({ state: presence.state })}
      role="dialog"
      aria-modal="true"
      aria-label={t.label({ name: img.name })}
      data-testid="lightbox"
      className="dy-m-lightbox fixed inset-0 z-[1000] flex flex-col bg-dy-lightbox pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[0.875rem] font-bold" data-testid="lightbox-name" title={img.name}>
            {img.name}
          </p>
          {sub.length > 0 ? (
            <p
              className="m-0 truncate text-[0.75rem] text-white/70 tabular-nums"
              data-testid="lightbox-meta"
              title={sub.join(' · ')}
            >
              {sub.join(' · ')}
            </p>
          ) : null}
        </div>
        {n > 1 ? (
          <span
            className="shrink-0 rounded-full bg-dy-lightbox-ctl px-2.5 py-1 text-[0.8125rem] tabular-nums"
            data-testid="lightbox-position"
            aria-live="polite"
          >
            {t.position({ at: at + 1, n })}
          </span>
        ) : null}
        {showInChat === null ? null : (
          <button
            type="button"
            className={cx(ctl, 'sm:w-auto sm:gap-1.5 sm:rounded-full sm:px-3.5')}
            onClick={() => {
              onClose();
              showInChat();
            }}
            aria-label={t.showInChat}
            title={t.showInChat}
            data-testid="lightbox-show-in-chat"
          >
            <DyIcon name="msg" className="size-5" />
            <span className="hidden text-[0.8125rem] font-bold sm:inline">{t.showInChat}</span>
          </button>
        )}
        {img.download === null ? null : (
          <a
            href={img.download}
            download={img.name}
            className={cx(ctl, 'no-underline')}
            aria-label={t.download}
            title={t.download}
          >
            <DyIcon name="tray" className="size-5" />
          </a>
        )}
        <button
          ref={closeRef}
          type="button"
          className={ctl}
          onClick={onClose}
          aria-label={t.close}
          title={t.close}
        >
          <DyIcon name="xc" className="size-5" />
        </button>
      </div>
      <div
        className="dy-m-lb-stage relative flex min-h-0 flex-1 items-center justify-center px-2 pb-3 sm:px-16"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {state === 'ready' ? null : (
          <div
            aria-hidden={state === 'loading' ? 'true' : undefined}
            data-testid="lightbox-placeholder"
            data-state={state}
            className="pointer-events-none absolute inset-0 grid place-items-center px-2 pb-3 sm:px-16"
          >
            {state === 'failed' ? (
              <p role="alert" className="m-0 rounded-[12px] bg-dy-lightbox-ctl px-4 py-3 text-[0.8125rem]">
                {t.failed}
              </p>
            ) : ratio === null ? (
              <span className="dy-breathe block size-40 rounded-[12px] bg-dy-lightbox-ctl" />
            ) : (
              // The known size as a replaced box: it scales into the stage exactly like the image will (no jump).
              <svg
                viewBox={`0 0 ${String(ratio.w)} ${String(ratio.h)}`}
                width={ratio.w}
                height={ratio.h}
                className="dy-breathe block h-auto max-h-full w-auto max-w-full rounded-[12px] bg-dy-lightbox-ctl"
                data-testid="lightbox-placeholder-box"
              />
            )}
          </div>
        )}
        <img
          key={img.src}
          src={img.src}
          alt={img.name}
          width={img.width ?? undefined}
          height={img.height ?? undefined}
          decoding="async"
          onLoad={() => {
            setLoaded({ src: img.src, ok: true });
          }}
          onError={() => {
            setLoaded({ src: img.src, ok: false });
          }}
          className={cx(
            'dy-m-lb-img block h-auto max-h-full w-auto max-w-full object-contain select-none',
            state === 'loading' && 'opacity-0',
            state === 'failed' && 'hidden',
          )}
          draggable={false}
          data-dir={state === 'ready' ? (shown.dir ?? undefined) : undefined}
          data-testid="lightbox-image"
        />
        {neighbours.map((x) => (
          // Prefetch: the previous / next image is already in the cache when ←/→ shows it (hidden, never painted).
          <img key={`pre:${x.src}`} src={x.src} alt="" hidden data-testid="lightbox-prefetch" />
        ))}
        {n > 1 ? (
          <>
            <button
              ref={prevRef}
              type="button"
              className={cx(ctl, 'absolute top-1/2 left-2 -translate-y-1/2')}
              disabled={!canPrev}
              onClick={() => {
                go(-1);
              }}
              aria-label={t.prev}
              title={t.prev}
              data-testid="lightbox-prev"
            >
              <DyIcon name="chev" className="size-5 rotate-90" />
            </button>
            <button
              ref={nextRef}
              type="button"
              className={cx(ctl, 'absolute top-1/2 right-2 -translate-y-1/2')}
              disabled={!canNext}
              onClick={() => {
                go(1);
              }}
              aria-label={t.next}
              title={t.next}
              data-testid="lightbox-next"
            >
              <DyIcon name="chev" className="size-5 -rotate-90" />
            </button>
          </>
        ) : null}
      </div>
    </div>,
    host,
  );
  return (
    <>
      {marker}
      {box}
    </>
  );
}

/**
 * An image preview that keeps its aspect ratio (object-contain in a bounded box), shows a zoom affordance on hover and
 * opens the lightbox on a click / Enter. Loaded lazily (a thumbnail below the fold costs nothing until scrolled to).
 */
export function DyZoomImage(props: {
  readonly src: string;
  readonly name: string;
  readonly onOpen: () => void;
  readonly size?: 'full' | 'thumb';
  readonly testId?: string;
  /** The button (the lightbox gives focus back to it). */
  readonly buttonRef?: ((el: HTMLButtonElement | null) => void) | undefined;
}): ReactNode {
  const t = useT().workfiles.lightbox;
  const [failed, setFailed] = useState(false);
  const thumb = props.size === 'thumb';
  return (
    <button
      ref={props.buttonRef}
      type="button"
      onClick={props.onOpen}
      aria-label={t.open({ name: props.name })}
      title={thumb ? props.name : t.zoom}
      data-testid={props.testId ?? 'zoom-image'}
      className={cx(
        'group relative grid place-items-center self-start overflow-hidden rounded-[10px] border border-dy-line bg-dy-sunk p-0 outline-none focus-visible:ring-2 focus-visible:ring-dy-teal',
        thumb ? 'aspect-square w-full' : 'max-w-full',
        failed && 'hidden',
      )}
    >
      <img
        src={props.src}
        alt={props.name}
        loading="lazy"
        decoding="async"
        onError={() => {
          setFailed(true);
        }}
        className={cx(
          'block object-contain',
          thumb ? 'h-full w-full' : 'h-auto max-h-[60vh] w-auto max-w-full',
        )}
        data-testid="image-preview"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-1.5 bottom-1.5 grid size-8 place-items-center rounded-full bg-dy-lightbox-ctl text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
      >
        <DyIcon name="search" className="size-4" />
      </span>
    </button>
  );
}

/** Several images as a grid of square thumbnails (aspect kept inside each), each opening the lightbox. */
export function DyImageGrid(props: {
  readonly images: readonly LightboxImage[];
  readonly onOpen: (i: number) => void;
  /** Columns: the default (3, 4 from sm) or a fixed 3 for narrow columns (the details drawer). */
  readonly cols?: 'auto' | 3 | undefined;
  readonly label?: string | undefined;
  /** Thumbnail buttons by index (for the lightbox's focus return). */
  readonly buttonRef?: ((i: number, el: HTMLButtonElement | null) => void) | undefined;
}): ReactNode {
  const t = useT().workfiles.lightbox;
  return (
    <ul
      aria-label={props.label ?? t.thumbs}
      className={cx(
        'm-0 grid list-none gap-2 p-0',
        props.cols === 3 ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-4',
      )}
      data-testid="image-grid"
    >
      {props.images.map((img, i) => (
        <li key={img.src} className="min-w-0">
          <DyZoomImage
            src={img.src}
            name={img.name}
            size="thumb"
            testId="image-thumb"
            buttonRef={
              props.buttonRef === undefined
                ? undefined
                : (el) => {
                    props.buttonRef?.(i, el);
                  }
            }
            onOpen={() => {
              props.onOpen(i);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
