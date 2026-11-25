import { type ReactNode, useEffect, useState } from 'react';
import {
  accountUsed,
  listRuntimeAccounts,
  type RuntimeAccount,
  switchJobAccount,
} from '../../api/runtimeAccounts';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { useSubmit } from '../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { runtimeDisplayName } from '../RuntimeMark';
import { DyApiError, DyDialog, DyNotice } from '../screens/forms';
import { DyButton } from '../screens/parts';

/** p13-runtime-accounts: the runtimes whose jobs can move to another account. */
export const SWITCHABLE_RUNTIMES: ReadonlySet<string> = new Set(['claude-code', 'codex']);
/** Job states in which "Hesabı değiştir" applies (running, paused, waiting to run). */
export const SWITCHABLE_STATES: ReadonlySet<string> = new Set([
  'RUNNING',
  'STARTING',
  'PAUSED',
  'QUEUED',
  'RETRY_WAIT',
  'WAITING',
]);

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §5): "Hesabı değiştir" — move a job to another account of
 * its runtime. A queued job is pinned to it; a paused one resumes with it; a running one is stopped, kept and resumed
 * with it in the same workspace (on another machine: a new attempt there). Step-up like a resume.
 */
export function SwitchAccountDialog(props: {
  readonly jobId: string;
  readonly runtime: string;
  readonly current: { readonly workerId: string; readonly id: string } | null;
  readonly onClose: () => void;
  readonly onDone: (text: string) => void;
}): ReactNode {
  const w = useT().job.switchAccount;
  const f = useFormat();
  const [accounts, setAccounts] = useState<readonly RuntimeAccount[] | null>(null);
  const [choice, setChoice] = useState<string>('');
  const load = useSubmit();
  const save = useSubmit();
  const stepUp = useStepUp();
  const { run } = load;
  useEffect(() => {
    void run(async () => {
      const r = await listRuntimeAccounts({ runtime: props.runtime });
      setAccounts(r.accounts.filter((a) => a.runtime === props.runtime && a.supported));
    });
  }, [run, props.runtime]);
  const key = (a: Pick<RuntimeAccount, 'workerId' | 'id'>): string => `${a.workerId}/${a.id}`;
  const picked = accounts?.find((a) => key(a) === choice) ?? null;
  const submit = (): void => {
    if (picked === null) return;
    void save.run(async () => {
      try {
        const result = await stepUp.run(
          () =>
            switchJobAccount(props.jobId, {
              workerId: picked.workerId,
              runtime: props.runtime,
              account: picked.id,
            }),
          w.stepUp({ label: picked.label }),
        );
        props.onDone(w.result[result]);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };
  return (
    <DyDialog
      open
      onClose={props.onClose}
      title={w.title}
      description={w.description({ runtime: runtimeDisplayName(props.runtime) })}
      testId="switch-account-dialog"
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onClose}>
            {w.discard}
          </DyButton>
          <DyButton variant="primary" busy={save.busy} disabled={picked === null} onClick={submit}>
            {w.submit}
          </DyButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <DyNotice tone="amber">{w.notice}</DyNotice>
        {accounts === null ? (
          load.error === null ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{w.loading}</p>
          ) : null
        ) : accounts.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{w.none}</p>
        ) : (
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{w.legend}</legend>
            {accounts.map((a) => {
              const current = props.current !== null && key(a) === key(props.current);
              const used = accountUsed(a);
              return (
                <label
                  key={key(a)}
                  className="flex items-center gap-2 text-[0.875rem]"
                  data-testid={`switch-account-${a.workerId}-${a.id}`}
                >
                  <input
                    type="radio"
                    name="switch-account"
                    value={key(a)}
                    checked={choice === key(a)}
                    disabled={current}
                    onChange={() => {
                      setChoice(key(a));
                    }}
                  />
                  <span>
                    <span className="font-bold">{a.label}</span>
                    {` — ${a.workerName}, ${w.kind[a.kind]}, ${w.state[a.state]}`}
                    {used === null ? '' : `, ${w.used({ percent: f.percent(Math.round(used) / 100) })}`}
                    {current ? w.current : ''}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <DyApiError error={load.error ?? save.error} retryLeft={save.retryLeft} />
      </div>
    </DyDialog>
  );
}
