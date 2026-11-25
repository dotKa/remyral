import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { cx, toApiError } from '../../components/ui';
import { CODE_PATTERN, digitsOnly, isBulkCodeEntry } from '../../screens/useSubmit';
import { isStepUpRequired } from '../../stepup/StepUpProvider';
import { DyIcon } from '../icons';
import { CardButton } from '../LiveCard';
import { CodeCheck, CodeTicks, useShake } from '../codeMotion';

/**
 * p12-diyalog Faz 1: the decision row inside a live card — the authenticator code field (and a reason when one is
 * needed) right where the decision is made, instead of a modal. Same rules as the classic step-up dialog
 * (ADR-0009 §10): the code goes to `POST /auth/step-up` through the AuthProvider (rate limits, session rotation,
 * double-submit handling unchanged) and the decision request follows; the master still decides whether a fresh
 * step-up is required (`403 step_up_required` re-opens the field). Nothing here can skip a check the master makes.
 *
 * `needsCode`: ask for the code up front (the action is known to require it and the session has no fresh step-up).
 * Without it the decision is sent at once and the field only appears when the master asks for it.
 */

/** True while the session still holds a step-up that the master accepts (a margin for clock drift and latency). */
/**
 * Whether the session can act without a code now. p15-autonomy: `event` (the security policy's step-up event of the
 * action) — when the policy does not protect it, no code is needed whatever the session's step-up.
 */
export function useFreshStepUp(event?: string): boolean {
  const { state } = useAuth();
  if (state.kind !== 'signedIn' || state.session === null) return false;
  if (event !== undefined && state.session.stepUpWaived?.includes(event) === true) return true;
  const until = state.session.stepUpValidUntil;
  return until !== null && Date.parse(until) - Date.now() > 20_000;
}

export function DecisionPanel(props: {
  /** "approve": primary submit; "deny": danger submit with a required reason. */
  readonly intent: 'approve' | 'deny';
  readonly needsCode: boolean;
  /** Label of the submit button ("Kodu gönder ve onayla", "Yayınla", "Reddet"). */
  readonly submitLabel: string;
  /** A reason field: required for deny, optional note for approve when given. */
  readonly reason?: { readonly required: boolean; readonly placeholder: string } | undefined;
  readonly onSubmit: (reason: string) => Promise<void>;
  readonly onCancel: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const w = useT().home.decisionPanel;
  const { actions } = useAuth();
  const codeId = useId();
  const reasonId = useId();
  const errId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const [needsCode, setNeedsCode] = useState(props.needsCode);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // p17-panel-motion: a refused code shakes the field and turns its ticks red; an accepted one shows a check while the
  // decision itself is sent.
  const [verified, setVerified] = useState(false);
  const [refused, setRefused] = useState(false);
  const { shake, attr: shakeAttr } = useShake();

  // Focus the first thing to fill in when the panel opens (keyboard `a` / `d` lands here).
  useEffect(() => {
    if (props.reason?.required === true) reasonRef.current?.focus();
    else if (needsCode) codeRef.current?.focus();
    else formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  }, [needsCode, props.reason?.required]);

  async function submit(): Promise<void> {
    if (inFlight.current) return; // an autofill submit followed by Enter: one confirmation only
    if (props.reason?.required === true && reason.trim() === '') {
      setError(w.reasonRequired);
      reasonRef.current?.focus();
      return;
    }
    if (needsCode && !CODE_PATTERN.test(code)) {
      setError(w.codeInvalid);
      shake();
      codeRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let accepted = false;
    try {
      if (needsCode) {
        await actions.stepUp(code);
        accepted = true;
        setVerified(true);
      }
      await props.onSubmit(reason);
    } catch (err) {
      setCode('');
      setVerified(false);
      if (needsCode && !accepted) {
        setRefused(true);
        shake();
      }
      if (isStepUpRequired(err)) {
        setNeedsCode(true);
        setError(w.stepUpHint);
      } else {
        const e = err instanceof ApiError ? err : toApiError(err);
        setError(sayError(e));
      }
      codeRef.current?.focus();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const deny = props.intent === 'deny';
  return (
    <form
      ref={formRef}
      noValidate
      aria-label={deny ? w.deny : w.approve}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onCancel();
        }
      }}
      className="dy-reveal grid w-full gap-2.5 border-t border-dashed border-dy-line-2 pt-2.5"
    >
      {props.reason === undefined ? null : (
        <div className="grid gap-1">
          <label htmlFor={reasonId} className="text-[0.8125rem] font-medium text-dy-muted">
            {props.reason.required ? w.reason : w.note}
          </label>
          <textarea
            ref={reasonRef}
            id={reasonId}
            rows={2}
            maxLength={1000}
            value={reason}
            placeholder={props.reason.placeholder}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            className="min-h-[60px] w-full resize-y rounded-[10px] border border-dy-line-2 bg-dy-card px-3 py-2 text-[0.9375rem] text-dy-ink placeholder:text-dy-faint focus:border-dy-teal focus:outline-none"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        {needsCode ? (
          <>
            <label htmlFor={codeId} className="flex items-center gap-1.5 text-[0.8125rem] font-medium">
              <DyIcon name="key" className="size-3.5" />
              {w.code}
            </label>
            <span className="relative inline-block" data-shake={shakeAttr}>
              <input
                ref={codeRef}
                id={codeId}
                name="code"
                inputMode="numeric"
                spellCheck={false}
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                enterKeyHint="done"
                placeholder="000000"
                value={code}
                aria-invalid={error !== null ? true : undefined}
                aria-describedby={error !== null ? errId : undefined}
                onChange={(e) => {
                  const next = digitsOnly(e.target.value);
                  const bulk = isBulkCodeEntry(code, next);
                  setCode(next);
                  setError(null);
                  setRefused(false);
                  // One-time-code autofill / paste submits itself (as the classic step-up dialog does).
                  if (bulk && props.reason?.required !== true)
                    setTimeout(() => formRef.current?.requestSubmit(), 0);
                }}
                data-verified={verified ? '' : undefined}
                className="dy-m-code w-[8.5rem] rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 py-[7px] text-center font-dy-mono text-base tracking-[0.3em] text-dy-ink placeholder:text-dy-faint focus:border-dy-teal focus:outline-none"
              />
              <CodeTicks n={code.length} state={verified ? 'ok' : refused ? 'error' : 'idle'} />
              {verified ? <CodeCheck /> : null}
            </span>
          </>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy || undefined}
          className={cx(
            'dy-press inline-flex items-center gap-[7px] rounded-[9px] border px-[13px] py-[7px] text-sm font-bold whitespace-nowrap disabled:opacity-60',
            deny ? 'border-dy-red bg-dy-red text-dy-on-fill' : 'border-dy-ink bg-dy-ink text-dy-card',
          )}
        >
          {busy ? <span className="dy-breathe size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
          {props.submitLabel}
        </button>
        <CardButton variant="ghost" onClick={props.onCancel} disabled={busy}>
          {w.cancel}
        </CardButton>
      </div>
      <p
        id={errId}
        role={error === null ? undefined : 'alert'}
        className={cx('m-0 text-[0.8125rem]', error === null ? 'sr-only' : 'text-dy-red-ink')}
      >
        {error ?? ''}
      </p>
    </form>
  );
}
