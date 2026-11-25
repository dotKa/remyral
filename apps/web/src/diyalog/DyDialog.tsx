import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { DyIcon } from './icons';
import { presenceProps, usePresence } from './motion';

/**
 * The one modal dialog / side sheet of the Diyalog UI (p12-diyalog-w4, made the single one by p12-diyalog-final: the
 * W2 kit, the W3 forms and the shell's dialogs all render this). Native `<dialog>` + showModal() — the browser traps
 * focus, makes the page behind inert and turns Escape into `cancel` (→ `onClose`); focus returns to the element that
 * had it when the dialog opened. Sizes `sm` 28 rem, `md` 38 rem (default), `lg` 52 rem: on phones the panel sits at
 * the top below the safe area and spans the width (the on-screen keyboard never covers a field or the buttons); wider
 * screens centre it. `sheet`: a side sheet from the right (≥ 640 px, 40 rem), full screen on phones — for drawers (an
 * output, a record). Content renders only while open.
 *
 * p12-diyalog-cmdk motion (motion.css): it rises in with a backdrop fade (a sheet slides in from the right) and leaves
 * the same way — the native dialog stays modal (inert) with the content it last showed until the exit ends, then
 * closes and focus returns. None under reduced motion: it closes in the same commit. p17-ui-batch: it rises 8 px from
 * 0.98 scale (`--dy-m-dialog`); opened again while it is still leaving, it turns back from where it is (same element,
 * still modal) and focus goes back into it.
 */
/** Focus what showModal() would: `initial`, else the `autofocus` element, else the first focusable, else the dialog. */
export function refocusDialog(d: HTMLDialogElement, initial: HTMLElement | null): void {
  if (d.contains(document.activeElement) && document.activeElement !== d) return;
  const target =
    initial ??
    d.querySelector<HTMLElement>('[autofocus]') ??
    d.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
  (target ?? d).focus();
}

export function DyDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons row (right-aligned on wide screens; stacked, primary on top, on phones). */
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg' | 'sheet' | undefined;
  /** Show the × close button (default true). */
  readonly closeButton?: boolean;
  /** A click on the backdrop closes (default true; off for a form a stray tap must not lose). */
  readonly backdropClose?: boolean;
  readonly testId?: string | undefined;
  /** The element focused on open (default: the first focusable / `autoFocus`). */
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  const closeLabel = useT().shell.close;
  const { open, initialFocus } = props;
  const presence = usePresence(open, ref);
  // While leaving, the dialog keeps the content it last showed (the caller may already have cleared its data).
  const shownRef = useRef<{
    title: ReactNode;
    description: ReactNode;
    children: ReactNode;
    footer: ReactNode;
  } | null>(null);
  if (open)
    shownRef.current = {
      title: props.title,
      description: props.description,
      children: props.children,
      footer: props.footer,
    };
  const shown = open
    ? { title: props.title, description: props.description, children: props.children, footer: props.footer }
    : (shownRef.current ?? {
        title: props.title,
        description: props.description,
        children: props.children,
        footer: props.footer,
      });

  const wasOpen = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (open && !d.open) {
      opener.current = document.activeElement;
      // Older jsdom builds have no showModal; the open attribute is the same state for tests.
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      initialFocus?.current?.focus();
    } else if (opening) {
      // Reopened while its exit was still running: the dialog never left the top layer, but it was inert, so focus
      // left it — put it back where showModal() would.
      refocusDialog(d, initialFocus?.current ?? null);
    }
  }, [open, initialFocus]);

  // Closed once the exit is over (at once without motion); then focus goes back to the opener.
  const mounted = presence.mounted;
  useEffect(() => {
    if (mounted) return;
    const d = ref.current;
    if (d?.open === true) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
    shownRef.current = null;
    const el = opener.current;
    opener.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  }, [mounted]);

  const sheet = props.size === 'sheet';
  const width =
    props.size === 'sm'
      ? 'sm:w-[min(28rem,calc(100vw-2rem))]'
      : props.size === 'lg'
        ? 'sm:w-[min(52rem,calc(100vw-2rem))]'
        : 'sm:w-[min(38rem,calc(100vw-2rem))]';

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={props.description === undefined ? undefined : descId}
      data-testid={props.testId}
      data-size={props.size ?? 'md'}
      {...presenceProps(presence)}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        if (props.backdropClose !== false && e.target === e.currentTarget) props.onClose();
      }}
      // p18-confirm-dialog: Escape belongs to the dialog (the browser turns it into `cancel`); it must not also reach
      // a page-level listener behind it (an open account menu closing under its confirm dialog).
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation();
      }}
      className={cx(
        'dy-surface dy-dialog border border-dy-line bg-dy-card p-0 text-dy-ink shadow-dy-pop backdrop:bg-dy-scrim',
        sheet
          ? 'm-0 ml-auto h-dvh max-h-dvh w-full max-w-full overflow-y-auto sm:w-[min(40rem,100vw)] sm:rounded-l-[var(--dy-r-card)]'
          : cx(
              'mx-auto mt-[max(0.75rem,env(safe-area-inset-top))] mb-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-none overflow-y-auto rounded-[var(--dy-r-card)] sm:m-auto',
              width,
            ),
      )}
    >
      {mounted ? (
        <div
          className={cx(
            'grid gap-4 p-4 sm:p-5',
            sheet &&
              'min-h-full content-start pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="m-0 text-[1.0625rem] font-extrabold tracking-[-0.01em] [overflow-wrap:anywhere]"
              >
                {shown.title}
              </h2>
              {shown.description === undefined ? null : (
                <div id={descId} className="m-0 mt-1 text-[0.875rem] text-dy-muted">
                  {shown.description}
                </div>
              )}
            </div>
            {props.closeButton === false ? null : (
              <button
                type="button"
                aria-label={closeLabel}
                onClick={props.onClose}
                className="dy-press -mt-1 -mr-1 grid size-10 shrink-0 place-items-center rounded-[9px] text-dy-muted sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
              >
                <DyIcon name="xc" className="size-4" />
              </button>
            )}
          </div>
          {shown.children}
          {shown.footer === undefined ? null : (
            // p17-ui-polish: the footer stays in view at the bottom of a tall dialog (the Toplu işlem form on a phone
            // put "Başlat" below the fold); it covers the dialog's padding so scrolled content passes under it.
            <div className="sticky bottom-0 z-[1] -mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-dy-line bg-dy-card px-4 pt-3 pb-4 sm:-mx-5 sm:-mb-5 sm:flex-row sm:justify-end sm:px-5 sm:pb-5">
              {shown.footer}
            </div>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
