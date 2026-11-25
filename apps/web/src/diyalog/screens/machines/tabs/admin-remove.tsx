import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { WorkerDetail } from '../../../../api/workers';
import { cancelRemoval, getRemoval, type RemovalView, requestRemoval } from '../../../../api/workerRemoval';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import type { Tone } from '../../../tone';
import { DyApiError, DyCheck, DyNotice } from '../../forms';
import { CodeBlock } from '../../../CodeBlock';
import { DyButton, Panel, Pill } from '../../parts';
import { useGuardedValue } from './admin-guard';
import { DyConfirmDialog } from '../../../common/actions';

/**
 * p17-worker-managed Part 3 — Makine → Yönetim → Makineden kaldır: an admin removes the worker from its machine (the
 * privileged helper stops and deletes the service, triggers and program files; optionally the data with the device
 * key), after which the master revokes it. A confirm dialog and an always-fresh step-up; an offline machine gets it when
 * it connects (cancellable until then). A refusal or an older build shows the kit's uninstall command for the OS.
 */

const POLL_MS = 3_000;

const STATE_TONE: Readonly<Record<string, Tone>> = {
  requested: 'amber',
  sent: 'teal',
  done: 'green',
  refused: 'red',
  failed: 'red',
  cancelled: 'neutral',
};

export function RemovePanel(props: {
  readonly worker: WorkerDetail;
  readonly onChanged: () => void;
}): ReactNode {
  const w = props.worker;
  const t = useT().machineManaged.remove;
  const [view, setView] = useState<RemovalView | null>(null);
  const [purge, setPurge] = useState(false);
  const [armed, setArmed] = useState(false);
  const submit = useSubmit();
  const guarded = useGuardedValue();
  const { onChanged } = props;

  const load = useCallback(async () => {
    try {
      setView(await getRemoval(w.id));
    } catch {
      // the panel stays as it was (a transient error)
    }
  }, [w.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = view?.removal?.state === 'requested' || view?.removal?.state === 'sent';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [live, load]);

  if (view === null) return null;
  const r = view.removal;
  const open = r !== null && (r.state === 'requested' || r.state === 'sent');
  const showManual =
    !view.supported || r?.state === 'refused' || r?.state === 'failed' || r?.opState === 'lost';
  const start = (): void => {
    setArmed(false);
    void submit.run(async () => {
      const next = await guarded(() => requestRemoval(w.id, purge), t.why({ name: w.name }));
      if (next !== null) {
        setView(next);
        onChanged();
      }
    });
  };
  const cancel = (): void => {
    void submit.run(async () => {
      const next = await guarded(() => cancelRemoval(w.id), t.whyCancel({ name: w.name }));
      if (next !== null) setView(next);
    });
  };
  return (
    <Panel title={t.title} sub={t.sub} testId="machine-remove">
      <div className="flex flex-col gap-3">
        {r !== null && r.state !== 'cancelled' ? (
          <DyNotice
            tone={STATE_TONE[r.state] ?? 'neutral'}
            live={r.state === 'refused' || r.state === 'failed'}
            testId="removal-state"
            title={
              <span className="flex flex-wrap items-center gap-2">
                <Pill tone={STATE_TONE[r.state] ?? 'neutral'}>{t.state[r.state]}</Pill>
                {r.purge ? <span className="text-[0.8125rem] font-normal">{t.withPurge}</span> : null}
              </span>
            }
          >
            {r.reason !== null || r.detail !== null ? (
              <p className="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
                {[r.reason, r.detail].filter((x) => x !== null).join(' — ')}
              </p>
            ) : null}
            {r.state === 'requested' ? <p className="m-0 text-[0.8125rem]">{t.offline}</p> : null}
          </DyNotice>
        ) : null}
        {!view.supported ? <p className="m-0 text-[0.875rem]">{t.unsupported}</p> : null}
        {showManual ? (
          <div data-testid="removal-manual">
            {view.supported ? <p className="m-0 mb-1 text-[0.8125rem]">{t.manual}</p> : null}
            <CodeBlock code={view.manual.join('\n')} />
            <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">{t.revokeHint}</p>
          </div>
        ) : null}
        {view.supported && !open && r?.state !== 'done' && !view.revoked ? (
          <>
            <DyCheck label={t.purge} checked={purge} onChange={setPurge} hint={t.purgeHint} />
            {!view.connected ? <p className="m-0 text-[0.8125rem] text-dy-muted">{t.offline}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <DyButton
                variant="danger"
                icon="xc"
                busy={submit.busy}
                disabled={submit.blocked}
                aria-haspopup="dialog"
                onClick={() => {
                  setArmed(true);
                }}
                data-testid="remove-worker"
              >
                {t.button}
              </DyButton>
            </div>
            <DyConfirmDialog
              open={armed}
              onClose={() => {
                setArmed(false);
              }}
              title={t.why({ name: w.name })}
              description={purge ? t.purge : undefined}
              confirmLabel={t.confirm}
              cancelLabel={t.cancelConfirm}
              testId="remove-dialog"
              confirmTestId="remove-confirm"
              onConfirm={start}
            />
          </>
        ) : null}
        {r?.state === 'requested' ? (
          <div>
            <DyButton variant="ghost" busy={submit.busy} onClick={cancel} data-testid="remove-cancel">
              {t.cancel}
            </DyButton>
          </div>
        ) : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}
