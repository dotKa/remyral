import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { altAria, altLabel, isAltCombo } from '../../shell/keys';
import { TOAST_FOCUS_LETTER } from '../../shell/shortcuts';
import { DyIcon, type IconName } from '../icons';
import { presenceProps, usePresence } from '../motion';
import {
  dismissToast,
  getToasts,
  MAX_VISIBLE,
  pauseToasts,
  removeToast,
  resumeToasts,
  subscribeToasts,
  type Toast,
  type ToastTone,
} from './store';

/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §2): the toasts of the Diyalog shell, mounted once.
 *
 *   - bottom right on desktop, full width at the bottom on phones — above the tab bar, the Sohbet composer and the
 *     on-screen keyboard (chat.css `.dy-toaster`);
 *   - newest on top; at most MAX_VISIBLE shown, older ones collapse into a "+N" stack that expands on click;
 *   - timers pause while the pointer or the keyboard is in the toaster and while the tab is hidden;
 *   - never takes focus: Option / Alt + T moves the keyboard to the newest toast, Esc dismisses the focused one
 *     (the keyboard goes to the next toast, or back where it was); a horizontal swipe dismisses on touch;
 *   - announced through two live regions that exist from the start (polite; assertive for errors) — a region added
 *     together with its text is not read reliably;
 *   - motion: motion.css `.dy-m-toast` (the dialog's rise, `--dy-m-toast`), none under reduced motion.
 */

const TONE_ICON: Readonly<Record<ToastTone, IconName>> = {
  success: 'checkc',
  info: 'info',
  warning: 'warn',
  error: 'xc',
};

const TONE_MARK: Readonly<Record<ToastTone, string>> = {
  success: 'text-dy-green',
  info: 'text-dy-teal-ink',
  warning: 'text-dy-amber-ink',
  error: 'text-dy-red-ink',
};

const TONE_EDGE: Readonly<Record<ToastTone, string>> = {
  success: 'before:bg-dy-green',
  info: 'before:bg-dy-teal',
  warning: 'before:bg-dy-amber',
  error: 'before:bg-dy-red',
};

/** A swipe this far (px) — or a quick flick — dismisses. */
export const SWIPE_DISMISS_PX = 64;
const FLICK_PX_PER_MS = 0.5;

function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}

/** "Tamam: Başlık. Açıklama" — what a screen reader hears for a toast (the tone word first). */
function spoken(t: Toast, tone: Readonly<Record<ToastTone, string>>): string {
  if (t.description === undefined || t.description === '') return `${tone[t.tone]}: ${t.title}`;
  // A title that ends a sentence is followed by a space, any other by ". ".
  const sep = /[.!?…:]$/.test(t.title) ? ' ' : '. ';
  return `${tone[t.tone]}: ${t.title}${sep}${t.description}`;
}

function ToastView(props: {
  readonly toast: Toast;
  readonly onEscape: (id: string, el: HTMLElement) => void;
}): ReactNode {
  const { toast: t } = props;
  const w = useT().shell.toast;
  const presence = usePresence<HTMLLIElement>(t.open);
  const { mounted, ref } = presence;
  useEffect(() => {
    if (!mounted) removeToast(t.id);
  }, [mounted, t.id]);
  // Swipe (touch / pen): the toast follows the finger sideways; far or fast enough, it goes.
  const swipe = useRef<{ x0: number; t0: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);
  const [swiping, setSwiping] = useState(false);
  if (!mounted) return null;
  const onPointerDown = (e: ReactPointerEvent<HTMLLIElement>): void => {
    if (e.pointerType === 'mouse' || !t.open) return;
    if (e.target instanceof Element && e.target.closest('a,button') !== null) return;
    swipe.current = { x0: e.clientX, t0: e.timeStamp, id: e.pointerId };
    setSwiping(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom / an ended pointer: the move events still arrive while over the toast
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLLIElement>): void => {
    const s = swipe.current;
    if (s === null || s.id !== e.pointerId) return;
    setDx(e.clientX - s.x0);
  };
  const endSwipe = (e: ReactPointerEvent<HTMLLIElement>): void => {
    const s = swipe.current;
    if (s === null || s.id !== e.pointerId) return;
    swipe.current = null;
    setSwiping(false);
    const moved = e.clientX - s.x0;
    const speed = Math.abs(moved) / Math.max(1, e.timeStamp - s.t0);
    if (Math.abs(moved) >= SWIPE_DISMISS_PX || (Math.abs(moved) > 16 && speed >= FLICK_PX_PER_MS)) {
      setDx(moved);
      dismissToast(t.id);
    } else setDx(0);
  };
  const style = {
    '--dy-toast-x': `${String(Math.round(dx))}px`,
    '--dy-toast-out': dx < 0 ? '-24px' : '24px',
    opacity: swiping ? Math.max(0.35, 1 - Math.abs(dx) / 240) : undefined,
  } as CSSProperties;
  return (
    <li
      ref={ref}
      {...presenceProps(presence)}
      tabIndex={-1}
      data-toast={t.id}
      data-tone={t.tone}
      data-testid={t.testId ?? 'dy-toast'}
      data-swiping={swiping ? '' : undefined}
      aria-label={spoken(t, w.tone)}
      style={style}
      onKeyDown={(e: ReactKeyboardEvent<HTMLLIElement>) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        props.onEscape(t.id, e.currentTarget);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
      className={cx(
        'dy-m-toast dy-surface pointer-events-auto relative flex touch-pan-y items-start gap-3 overflow-hidden rounded-[var(--dy-r-card)] border border-dy-line bg-dy-card py-3 pr-2 pl-4 text-dy-ink shadow-dy-pop outline-none select-none',
        'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        'focus-visible:ring-2 focus-visible:ring-dy-teal',
        TONE_EDGE[t.tone],
      )}
    >
      <span className={cx('mt-0.5 shrink-0', TONE_MARK[t.tone])}>
        <DyIcon name={t.icon ?? TONE_ICON[t.tone]} className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className="m-0 text-[0.875rem] leading-snug font-bold [overflow-wrap:anywhere]"
          data-toast-title=""
        >
          {t.title}
        </p>
        {t.description === undefined || t.description === '' ? null : (
          <p className="m-0 line-clamp-3 text-[0.8125rem] leading-snug text-dy-muted [overflow-wrap:anywhere]">
            {t.description}
          </p>
        )}
        {t.actions.length > 0 || t.link !== undefined ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {t.actions.map((a, i) =>
              a.to !== undefined ? (
                <Link
                  key={a.label}
                  to={a.to}
                  data-testid={a.testId}
                  onClick={() => {
                    a.onClick?.();
                    if (a.keepOpen !== true) dismissToast(t.id);
                  }}
                  className={cx(
                    'dy-press inline-flex min-h-9 items-center rounded-[9px] px-3 text-[0.8125rem] font-bold no-underline',
                    i === 0
                      ? 'bg-dy-ink text-dy-card'
                      : 'border border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                  )}
                >
                  {a.label}
                </Link>
              ) : (
                <button
                  key={a.label}
                  type="button"
                  data-testid={a.testId}
                  onClick={() => {
                    a.onClick?.();
                    if (a.keepOpen !== true) dismissToast(t.id);
                  }}
                  className={cx(
                    'dy-press inline-flex min-h-9 items-center rounded-[9px] px-3 text-[0.8125rem] font-bold',
                    i === 0
                      ? 'bg-dy-ink text-dy-card'
                      : 'border border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                  )}
                >
                  {a.label}
                </button>
              ),
            )}
            {t.link === undefined ? null : (
              <Link
                to={t.link.to}
                onClick={() => {
                  dismissToast(t.id);
                }}
                className="text-[0.8125rem] font-bold text-dy-teal-ink"
              >
                {t.link.label}
              </Link>
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={w.dismissAria({ title: t.title })}
        title={w.dismiss}
        data-testid="dy-toast-dismiss"
        onClick={() => {
          dismissToast(t.id);
        }}
        className="dy-press grid size-9 shrink-0 place-items-center rounded-[9px] text-dy-faint [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
      >
        <DyIcon name="xc" className="size-[18px]" />
      </button>
    </li>
  );
}

/** The live regions' text: the newest version of a toast is announced once. */
function useAnnouncements(
  toasts: readonly Toast[],
  tone: Readonly<Record<ToastTone, string>>,
): { readonly polite: string; readonly assertive: string } {
  const said = useRef(new Map<string, number>());
  const [text, setText] = useState({ polite: '', assertive: '' });
  useEffect(() => {
    const fresh = toasts.filter((t) => t.open && said.current.get(t.id) !== t.version);
    for (const t of toasts) said.current.set(t.id, t.version);
    for (const id of [...said.current.keys()]) if (!toasts.some((t) => t.id === id)) said.current.delete(id);
    if (fresh.length === 0) return;
    const errors = fresh.filter((t) => t.tone === 'error').map((t) => spoken(t, tone));
    const rest = fresh.filter((t) => t.tone !== 'error').map((t) => spoken(t, tone));
    setText((prev) => ({
      polite: rest.length === 0 ? prev.polite : rest.join(' '),
      assertive: errors.length === 0 ? prev.assertive : errors.join(' '),
    }));
  }, [toasts, tone]);
  return text;
}

export function DyToaster(): ReactNode {
  const toasts = useToasts();
  const w = useT().shell.toast;
  const [expanded, setExpanded] = useState(false);
  const region = useRef<HTMLElement>(null);
  /** Where the keyboard was before it entered the toaster (Esc on the last toast returns it there). */
  const cameFrom = useRef<HTMLElement | null>(null);
  const announce = useAnnouncements(toasts, w.tone);

  const openCount = toasts.filter((t) => t.open).length;
  const hidden = Math.max(0, openCount - MAX_VISIBLE);
  // Nothing left to expand: the compact stack again.
  const isExpanded = expanded && openCount > MAX_VISIBLE;
  // Shown: the newest MAX_VISIBLE open toasts, plus closed ones that were on screen (playing their exit).
  const wasShown = useRef(new Set<string>());
  const shown: Toast[] = [];
  let openShown = 0;
  for (const t of toasts) {
    if (isExpanded) shown.push(t);
    else if (t.open && openShown < MAX_VISIBLE) {
      shown.push(t);
      openShown++;
    } else if (!t.open && wasShown.current.has(t.id)) shown.push(t);
  }
  useEffect(() => {
    wasShown.current = new Set(shown.map((t) => t.id));
    // A collapsed toast that expired was never on screen: it goes without an exit.
    for (const t of toasts) if (!t.open && !wasShown.current.has(t.id)) removeToast(t.id);
  });

  // A hidden tab: the timers wait (a toast nobody could read does not expire).
  useEffect(() => {
    const sync = (): void => {
      if (document.visibilityState === 'hidden') pauseToasts('hidden');
      else resumeToasts('hidden');
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      resumeToasts('hidden');
    };
  }, []);

  // Option / Alt + T: the keyboard goes to the newest toast (never automatically).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isAltCombo(e, TOAST_FOCUS_LETTER)) return;
      const first = region.current?.querySelector<HTMLElement>('li[data-toast][data-state="open"]');
      if (first === null || first === undefined) return;
      e.preventDefault();
      if (!(region.current?.contains(document.activeElement) ?? false))
        cameFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      first.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const onEscape = (id: string, el: HTMLElement): void => {
    const items = [
      ...(region.current?.querySelectorAll<HTMLElement>('li[data-toast][data-state="open"]') ?? []),
    ];
    const at = items.indexOf(el);
    const next = items[at + 1] ?? items[at - 1];
    dismissToast(id);
    if (next !== undefined) next.focus();
    else {
      const back = cameFrom.current;
      cameFrom.current = null;
      resumeToasts('focus');
      if (back !== null && back.isConnected) back.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  const onFocus = (e: FocusEvent<HTMLElement>): void => {
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !(region.current?.contains(from) ?? false)) cameFrom.current = from;
    pauseToasts('focus');
  };
  const onBlur = (e: FocusEvent<HTMLElement>): void => {
    const to = e.relatedTarget;
    if (to instanceof Node && (region.current?.contains(to) ?? false)) return;
    resumeToasts('focus');
  };

  const keys = altLabel(TOAST_FOCUS_LETTER);
  return (
    <section
      ref={region}
      aria-label={w.region({ keys })}
      aria-keyshortcuts={altAria(TOAST_FOCUS_LETTER)}
      data-testid="dy-toaster"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') pauseToasts('hover');
      }}
      onPointerLeave={() => {
        resumeToasts('hover');
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      className="dy-toaster pointer-events-none fixed z-[60] flex flex-col items-stretch gap-2"
    >
      {/* No empty list in the page when nothing is shown (a list landmark for screen readers only with toasts). */}
      {shown.length === 0 ? null : (
        <ol
          className={cx(
            'm-0 flex list-none flex-col gap-2 p-0',
            isExpanded && 'pointer-events-auto max-h-[min(70vh,36rem)] overflow-y-auto overscroll-contain',
          )}
        >
          {shown.map((t) => (
            <ToastView key={t.id} toast={t} onEscape={onEscape} />
          ))}
        </ol>
      )}
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={isExpanded}
          data-testid="dy-toast-more"
          onClick={() => {
            setExpanded((x) => !x);
          }}
          className={cx(
            'dy-press pointer-events-auto relative mx-auto inline-flex min-h-9 items-center rounded-full border border-dy-line bg-dy-card px-3.5 text-[0.78125rem] font-bold text-dy-muted shadow-dy',
            // The collapsed stack: a card edge behind the pill.
            !isExpanded &&
              'before:absolute before:inset-x-3 before:-top-1.5 before:-z-10 before:h-3 before:rounded-t-[10px] before:border before:border-dy-line before:bg-dy-card before:content-[""]',
          )}
        >
          {isExpanded ? w.less : w.more({ n: hidden })}
        </button>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="dy-toast-polite">
        {announce.polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true" data-testid="dy-toast-assertive">
        {announce.assertive}
      </div>
    </section>
  );
}
