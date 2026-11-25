import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyDialog } from '../DyDialog';
import type { IconName } from '../icons';
import { DyButton, type DyVariant } from '../screens/parts';
import { insideModal, toast } from '../toast/store';

/**
 * p12-diyalog-final: the two action conventions of the Diyalog UI, once (the W2 kit's `DyConfirm`, the W3
 * `ConfirmButton` and the copy buttons of W2 / W3 / W4 render these):
 *
 *   - DyConfirm      every destructive action takes two steps — p18-confirm-dialog: the first press opens a small
 *                    confirm dialog (`DyConfirmDialog`: the question as its title, an optional consequence line,
 *                    Vazgeç + the confirm button). No confirmation is ever rendered inline next to the trigger.
 *                    Vazgeç, Escape or a backdrop click cancel; focus returns to the trigger.
 *   - DyCopyButton   copies text (async Clipboard API; `text` may be a function for long logs) and announces the
 *                    result; a failure says to select the text by hand.
 */

/**
 * p18-confirm-dialog: the one "are you sure?" dialog (a `DyDialog size="sm"`). Initial focus: Vazgeç for a `danger`
 * confirmation (Enter must not destroy by accident), the confirm button otherwise. The confirm button carries
 * `confirmTestId`; `onConfirm` runs once and the caller closes it (`onClose`), or keeps it open while `busy`.
 */
export function DyConfirmDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Extra content (a typed-name field, a choice, an error) between the title and the buttons. */
  readonly children?: ReactNode;
  /** Focus the first field of `children` on open (a typed-name confirmation) instead of a button. */
  readonly focusField?: boolean | undefined;
  readonly confirmLabel: string;
  readonly cancelLabel?: string | undefined;
  readonly variant?: DyVariant | undefined;
  readonly busy?: boolean | undefined;
  /** The confirm button is disabled (e.g. until a typed name matches). */
  readonly confirmDisabled?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly confirmTestId?: string | undefined;
  readonly cancelTestId?: string | undefined;
}): ReactNode {
  const t = useT().shared;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const variant = props.variant === 'warn' || props.variant === 'primary' ? props.variant : 'danger';
  const initialFocus = variant === 'danger' ? cancelRef : confirmRef;
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={props.title ?? t.confirm.question}
      description={props.description}
      size="sm"
      testId={props.testId}
      initialFocus={props.focusField === true ? undefined : initialFocus}
      footer={
        <>
          <DyButton ref={cancelRef} variant="ghost" data-testid={props.cancelTestId} onClick={props.onClose}>
            {props.cancelLabel ?? t.confirm.back}
          </DyButton>
          <DyButton
            ref={confirmRef}
            variant={variant}
            busy={props.busy}
            disabled={props.confirmDisabled}
            data-testid={props.confirmTestId}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </DyButton>
        </>
      }
    >
      {props.children}
    </DyDialog>
  );
}

export function DyConfirm(props: {
  readonly label: string;
  readonly confirmLabel?: string | undefined;
  /** The dialog's title (default "Emin misin?"). */
  readonly question?: ReactNode;
  /** p18-confirm-dialog: an optional consequence line under the question. */
  readonly description?: ReactNode;
  readonly onConfirm: () => void;
  readonly icon?: IconName | undefined;
  readonly variant?: DyVariant | undefined;
  readonly busy?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
  /** Accessible name of the first button when the label alone is ambiguous in a list ("Kaldır: mac-1"). */
  readonly ariaLabel?: string | undefined;
}): ReactNode {
  const [asking, setAsking] = useState(false);
  const close = (): void => {
    setAsking(false);
  };
  return (
    <>
      <DyButton
        variant={props.variant ?? 'danger'}
        icon={props.icon}
        busy={props.busy}
        disabled={props.disabled}
        data-testid={props.testId}
        aria-label={props.ariaLabel}
        aria-haspopup="dialog"
        className={props.className}
        onClick={() => {
          setAsking(true);
        }}
      >
        {props.label}
      </DyButton>
      <DyConfirmDialog
        open={asking}
        onClose={close}
        title={props.question}
        description={props.description}
        confirmLabel={props.confirmLabel ?? props.label}
        variant={props.variant === 'warn' ? 'warn' : 'danger'}
        testId={props.testId === undefined ? undefined : `${props.testId}-dialog`}
        confirmTestId={props.testId === undefined ? undefined : `${props.testId}-confirm`}
        onConfirm={() => {
          setAsking(false);
          props.onConfirm();
        }}
      />
    </>
  );
}

/**
 * Copies `text`; the icon turns into a tick. p17-toasts-shortcuts: the result ("Kopyalandı." / why not) is a toast,
 * no longer a line next to the button.
 */
export function DyCopyButton(props: {
  readonly text: string | (() => string);
  readonly label?: string | undefined;
  /** Accessible name when the visible label alone is ambiguous ("Kurulum komutunu kopyala"). */
  readonly about?: string | undefined;
  /** Same as `about` (the W4 name). */
  readonly ariaLabel?: string | undefined;
  readonly variant?: DyVariant | undefined;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const t = useT().shared.copy;
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // In a modal the result stays next to the button (the toaster is under the modal); elsewhere it is a toast.
  const [inline, setInline] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => {
      setState('idle');
    }, 2500);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  return (
    <span ref={wrap} className={cx('inline-flex items-center gap-2', props.className)}>
      <DyButton
        variant={props.variant ?? 'secondary'}
        icon={state === 'copied' ? 'check' : 'copy'}
        aria-label={props.about ?? props.ariaLabel}
        data-testid={props.testId}
        onClick={() => {
          const text = typeof props.text === 'function' ? props.text() : props.text;
          const modal = insideModal(wrap.current);
          setInline(modal);
          navigator.clipboard.writeText(text).then(
            () => {
              setState('copied');
              if (!modal) toast.success(t.copied, { id: 'copied', testId: 'dy-copied' });
            },
            () => {
              setState('failed');
              if (!modal) toast.error(t.failed, { id: 'copied', testId: 'dy-copy-failed' });
            },
          );
        }}
      >
        {props.label ?? t.label}
      </DyButton>
      <span role="status" className="text-[0.78125rem] text-dy-muted">
        {!inline ? '' : state === 'copied' ? t.copied : state === 'failed' ? t.failed : ''}
      </span>
    </span>
  );
}
