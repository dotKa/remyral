import { type ReactNode, useEffect, useId, useRef } from 'react';
import { cx } from './ui';

/**
 * Modal dialog on the native `<dialog>` + showModal(): the browser traps focus, makes the page behind inert and
 * turns Escape into `cancel` (→ `onClose`). Focus returns to the element that had it when the dialog opened.
 * The title labels the dialog; `description` describes it. Content renders only while open.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts"
 *     footer={<Button onClick={() => setOpen(false)}>Done</Button>}>…</Dialog>
 */
export function Dialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons row (right-aligned on wide screens). */
  readonly footer?: ReactNode;
  /** `sm` 26 rem (confirmations), `md` 36 rem (default), `lg` 48 rem. */
  readonly size?: 'sm' | 'md' | 'lg';
  /** Show a close (×) button in the header (default true). */
  readonly closeButton?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  const { open } = props;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Return focus to the opener once closed (also when the component unmounts while open).
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    opener.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  }, [open]);

  const width =
    props.size === 'sm'
      ? 'w-[min(26rem,calc(100vw-2rem))]'
      : props.size === 'lg'
        ? 'w-[min(48rem,calc(100vw-2rem))]'
        : 'w-[min(36rem,calc(100vw-2rem))]';

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside the panel) closes it.
        if (e.target === e.currentTarget) props.onClose();
      }}
      className={cx(
        'mx-auto mt-[max(1rem,env(safe-area-inset-top))] mb-auto max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-line bg-surface p-0 text-fg shadow-xl sm:m-auto',
        width,
      )}
    >
      {open ? (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold">
                {props.title}
              </h2>
              {props.description ? (
                <p id={descId} className="mt-1 text-sm text-muted">
                  {props.description}
                </p>
              ) : null}
            </div>
            {props.closeButton !== false ? (
              <button
                type="button"
                aria-label="Close"
                onClick={props.onClose}
                className="-mt-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            ) : null}
          </div>
          {props.children}
          {props.footer ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
