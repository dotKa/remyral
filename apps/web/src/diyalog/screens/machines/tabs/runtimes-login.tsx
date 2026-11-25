import { type ReactNode, useState } from 'react';
import {
  cancelOp,
  type LoginRuntime,
  type Op,
  RUNTIME_NAME,
  safeLoginUrl,
  sendLoginCode,
  TERMINAL_STATES,
} from '../../../../api/remoteOps';
import { useOp } from '../../../../screens/fleet/remoteOps';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { DyApiError, DyCopyButton, DyDialog, DyField, DyNotice } from '../../forms';
import { DyButton } from '../../parts';
import { useGuardedOp } from './runtimes-ops';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — the runtime's subscription login on a machine, in the Diyalog language (the classic
 * `LoginDialog` of `screens/fleet/RemoteOpsPanel.tsx`): the runtime's own login runs on the worker; the panel only
 * shows its sign-in link (https and the provider's host only — `safeLoginUrl`), the device code, and relays a code
 * the sign-in page shows back to it (step-up). Cancel goes through step-up too. The credential never leaves the
 * machine.
 */
export function LoginDialog(props: {
  readonly workerId: string;
  readonly runtime: LoginRuntime;
  readonly op: Op;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().machineRuntimes.login;
  const { op } = useOp(props.workerId, props.op);
  const [code, setCode] = useState('');
  const submit = useSubmit();
  const guarded = useGuardedOp();
  const current = op ?? props.op;
  const finished = TERMINAL_STATES.has(current.state);
  const url = safeLoginUrl(current.login?.url ?? null);
  const userCode = current.login?.userCode ?? null;
  // An open login of the other runtime may be the one resumed (startLogin on `login_in_progress`).
  const shown = current.login?.runtime;
  const name = RUNTIME_NAME[shown === 'claude-code' || shown === 'codex' ? shown : props.runtime];
  return (
    <DyDialog
      open
      onClose={props.onClose}
      testId="login-dialog"
      title={t.title({ runtime: name })}
      description={t.description}
      footer={
        <>
          {!finished ? (
            <DyButton
              busy={submit.busy}
              onClick={() => {
                void submit.run(async () => {
                  await guarded(() => cancelOp(props.workerId, current.id), t.cancel);
                });
              }}
            >
              {t.cancel}
            </DyButton>
          ) : null}
          <DyButton variant={finished ? 'primary' : 'ghost'} onClick={props.onClose}>
            {t.close}
          </DyButton>
        </>
      }
    >
      {!finished && url === null ? (
        <p className="m-0 flex items-center gap-2 text-[0.875rem]" data-testid="login-waiting">
          <DyIcon name="retry" className="dy-breathe size-4 text-dy-teal-ink" />
          {t.waiting}
        </p>
      ) : null}
      {url !== null && !finished ? (
        <div className="flex flex-col items-start gap-2" data-testid="login-url">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className="text-[0.9375rem] font-bold break-all text-dy-teal-ink underline"
          >
            {t.openPage({ host: new URL(url).hostname })}
          </a>
          <DyCopyButton text={url} label={t.copyLink} />
        </div>
      ) : null}
      {userCode !== null && !finished ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-[0.875rem]">{t.enterCode}</p>
          <p
            className="m-0 font-dy-mono text-[1.75rem] font-bold tracking-[0.2em]"
            data-testid="login-user-code"
          >
            {userCode}
          </p>
        </div>
      ) : null}
      {current.login?.expectsCode === true && url !== null && !finished ? (
        current.login.codeSent ? (
          <p className="m-0 flex items-center gap-2 text-[0.875rem]" data-testid="login-verifying">
            <DyIcon name="retry" className="dy-breathe size-4 text-dy-teal-ink" />
            {t.verifying}
          </p>
        ) : (
          <form
            className="flex flex-col items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = code.trim();
              if (value === '') return;
              void submit.run(async () => {
                const ok = await guarded(
                  () => sendLoginCode(props.workerId, current.id, value),
                  t.whySendCode,
                );
                if (ok !== null) setCode('');
              });
            }}
          >
            <DyField
              label={t.codeLabel}
              name="login-code"
              autoComplete="off"
              spellCheck={false}
              mono
              value={code}
              onChange={setCode}
              wrapClassName="w-full"
              hint={t.codeHint}
            />
            <DyButton type="submit" variant="primary" busy={submit.busy} disabled={code.trim() === ''}>
              {t.sendCode}
            </DyButton>
          </form>
        )
      ) : null}
      {finished ? (
        current.state === 'succeeded' ? (
          <DyNotice tone="green" live>
            <span data-testid="login-done">{t.done}</span>
          </DyNotice>
        ) : (
          <DyNotice tone="red" live>
            <span data-testid="login-failed">
              {t.failed({ state: current.state.replaceAll('_', ' ') })}
              {current.reason === null ? '' : ` (${current.reason})`}
              {current.detail === null ? '' : ` — ${current.detail}`}
            </span>
          </DyNotice>
        )
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </DyDialog>
  );
}
