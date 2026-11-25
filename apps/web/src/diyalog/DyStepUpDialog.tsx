import { type ReactNode, type SubmitEvent, useEffect, useRef, useState } from 'react';
import { CODE_PATTERN, digitsOnly, isBulkCodeEntry, useSubmit } from '../screens/useSubmit';
import type { StepUpDialogProps } from '../stepup/StepUpProvider';
import { useT } from '../i18n/I18nProvider';
import { refocusDialog } from './DyDialog';
import { DyErrorNotice } from './forms';
import { DyIcon } from './icons';
import { DyButton } from './screens/parts';
import { CodeCheck, CodeTicks, useShake } from './codeMotion';
import { presenceProps, usePresence } from './motion';

/**
 * p12-diyalog-w4: the step-up confirmation (ADR-0009 §10) in the Diyalog language, the StepUpProvider's dialog (the
 * provider's run / confirm / supersede / cancel rules are unchanged; the classic `StepUpDialog` was removed with the
 * classic console). Native modal `<dialog>`: focus trap, inert page, Escape cancels, focus
 * returns to the opener. Phones: the panel sits at the top below the safe area so the keyboard never covers the
 * field; the field is `one-time-code` + numeric and a code filled in one go (autofill, password manager, paste)
 * submits itself; one confirmation at a time (a second submit of the same code would meet a rotated session).
 * p17-panel-motion: the code's ticks fill as digits come in, a refused code shakes the field, an accepted one shows a
 * check while the dialog leaves (it stays modal with that content until its exit transition ends — `usePresence`, as
 * DyDialog; none under reduced motion).
 */
export function DyStepUpDialog(props: StepUpDialogProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const opener = useRef<Element | null>(null);
  const inFlight = useRef(false);
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [refused, setRefused] = useState(false);
  const { shake, attr: shakeAttr } = useShake();
  const presence = usePresence(props.open, ref);
  const shown = presence.mounted;
  const submit = useSubmit();
  const { clearError } = submit;
  const all = useT().auth;
  const t = all.stepUp;

  // A new confirmation starts clean — also one that opens while the previous one is still leaving (the dialog is
  // then still modal: it turns back from where its exit is instead of showing the old check / code).
  const wasOpen = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opening = props.open && !wasOpen.current;
    wasOpen.current = props.open;
    if (opening) {
      setCode('');
      setFieldError(null);
      setVerified(false);
      setRefused(false);
      clearError();
    }
    if (props.open && !d.open) {
      opener.current = document.activeElement;
      // Older jsdom builds have no showModal; the open attribute is the same state for tests.
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (opening) {
      refocusDialog(d, null);
    } else if (!shown && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
      const el = opener.current;
      opener.current = null;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    }
  }, [props.open, shown, clearError]);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!CODE_PATTERN.test(code)) {
      setFieldError(all.codeRequired);
      shake();
      return;
    }
    if (inFlight.current) return;
    setFieldError(null);
    inFlight.current = true;
    try {
      const ok = await submit.run(() => props.verify(code));
      if (ok) {
        setVerified(true);
        props.onVerified();
      } else {
        setCode('');
        setRefused(true);
        shake();
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="stepup-title"
      aria-describedby="stepup-desc"
      data-testid="dy-stepup"
      {...presenceProps(presence)}
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
      className="dy-surface dy-dialog mx-auto mt-[max(0.75rem,env(safe-area-inset-top))] mb-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[16px] border border-dy-line bg-dy-card p-0 text-dy-ink shadow-dy-pop backdrop:bg-dy-scrim sm:m-auto sm:w-[min(26rem,calc(100vw-2rem))]"
    >
      {shown ? (
        <form ref={formRef} noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-dy-amber-soft text-dy-amber-ink"
            >
              <DyIcon name="key" className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 id="stepup-title" className="m-0 text-[1.0625rem] font-extrabold tracking-[-0.01em]">
                {t.title}
              </h2>
              <p id="stepup-desc" className="m-0 mt-1 text-[0.875rem] text-dy-muted">
                {props.reason ?? t.defaultReason} {t.validFor}
              </p>
            </div>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="stepup-code" className="text-[0.875rem] font-bold">
              {t.code}
            </label>
            <span className="relative block" data-shake={shakeAttr}>
              <input
                id="stepup-code"
                name="code"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                enterKeyHint="done"
                placeholder="000000"
                spellCheck={false}
                value={code}
                aria-invalid={fieldError === null ? undefined : true}
                aria-describedby={fieldError === null ? undefined : 'stepup-code-error'}
                onChange={(e) => {
                  const next = digitsOnly(e.target.value);
                  const bulk = isBulkCodeEntry(code, next);
                  setCode(next);
                  setRefused(false);
                  // Submit after React has committed the new value (requestSubmit runs onSubmit with it).
                  if (bulk && !submit.busy && !submit.blocked) {
                    setTimeout(() => formRef.current?.requestSubmit(), 0);
                  }
                }}
                data-verified={verified ? '' : undefined}
                className={`dy-m-code min-h-12 w-full rounded-[10px] border bg-dy-card px-3 text-center font-dy-mono text-xl tracking-[0.4em] text-dy-ink outline-none placeholder:text-dy-faint focus:border-dy-teal ${
                  fieldError === null ? 'border-dy-line-2' : 'border-dy-red'
                }`}
              />
              <CodeTicks n={code.length} state={verified ? 'ok' : refused ? 'error' : 'idle'} />
              {verified ? <CodeCheck /> : null}
            </span>
            {fieldError === null ? null : (
              <p id="stepup-code-error" className="m-0 text-[0.8125rem] font-medium text-dy-red-ink">
                {fieldError}
              </p>
            )}
          </div>
          <DyErrorNotice error={submit.error} retryLeft={submit.retryLeft} />
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <DyButton onClick={props.onCancel} className="min-h-11 sm:min-h-9">
              {t.cancel}
            </DyButton>
            <DyButton
              type="submit"
              variant="primary"
              busy={submit.busy}
              disabled={submit.blocked}
              className="min-h-11 sm:min-h-9"
            >
              {t.confirm}
            </DyButton>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
