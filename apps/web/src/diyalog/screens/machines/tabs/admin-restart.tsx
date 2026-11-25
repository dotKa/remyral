import { type ReactNode, useEffect, useState } from 'react';
import { getOp, type Op, restartWorker, TERMINAL_STATES } from '../../../../api/remoteOps';
import { useOpsStatus } from '../../../../screens/fleet/remoteOps';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon, type IconName } from '../../../icons';
import { INK, type Tone } from '../../../tone';
import { DyApiError, DyCheck, DyField, DyNotice } from '../../forms';
import { DyButton, Panel, SkeletonRows } from '../../parts';
import { useGuardedValue } from './admin-guard';
import type { Messages } from '@remyral/i18n';
import { DyConfirmDialog } from '../../../common/actions';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yönetim → Makine servisini yeniden başlat (the worker service), in the Diyalog language. The classic
 * `WorkerRestart` rules: only a worker that runs under its service manager (and a build that supports it) is
 * restartable; "wait for running jobs" with a give-up time (minutes → seconds, at most 24 h) or stop them; a second
 * press confirms; the call goes through step-up; the started operation is followed until it ends.
 */

const POLL_MS = 1_200;

type OpStateKey = keyof Messages['machineAdmin']['opState'];

const OP_STATE: Readonly<Record<OpStateKey, { tone: Tone; icon: IconName }>> = {
  sent: { tone: 'teal', icon: 'send' },
  accepted: { tone: 'teal', icon: 'retry' },
  running: { tone: 'teal', icon: 'retry' },
  waiting_for_user: { tone: 'amber', icon: 'shield' },
  succeeded: { tone: 'green', icon: 'checkc' },
  failed: { tone: 'red', icon: 'xc' },
  refused: { tone: 'red', icon: 'xc' },
  lost: { tone: 'red', icon: 'xc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

const isOpStateKey = (s: string): s is OpStateKey => Object.hasOwn(OP_STATE, s);

/** Follows one operation until it reaches a terminal state. */
function useFollowedOp(workerId: string, initial: Op | null): Op | null {
  const [op, setOp] = useState<Op | null>(initial);
  useEffect(() => {
    setOp(initial);
    if (initial === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      try {
        const next = await getOp(workerId, initial.id, 0);
        if (!live) return;
        setOp(next);
        if (!TERMINAL_STATES.has(next.state)) timer = setTimeout(() => void tick(), POLL_MS);
      } catch {
        if (live) timer = setTimeout(() => void tick(), POLL_MS * 3);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [workerId, initial]);
  return op;
}

function RestartState(props: { readonly op: Op }): ReactNode {
  const { op } = props;
  const t = useT().machineAdmin;
  const s = isOpStateKey(op.state)
    ? { ...OP_STATE[op.state], text: t.opState[op.state] }
    : { tone: 'neutral' as const, icon: 'clock' as const, text: op.state };
  const p = op.progress;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.875rem]"
      data-testid="op-line"
      data-state={op.state}
    >
      <span className="font-medium">{t.restart.op}</span>
      <span className={`inline-flex items-center gap-1 font-bold ${INK[s.tone]}`}>
        <DyIcon
          name={s.icon}
          className={`size-[14px] ${TERMINAL_STATES.has(op.state) ? '' : 'dy-breathe'}`}
        />
        {s.text}
      </span>
      {p !== null && !TERMINAL_STATES.has(op.state) ? (
        <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
          {p.step}
          {p.total === undefined ? '' : ` ${String(p.done ?? 0)}/${String(p.total)}`}
        </span>
      ) : null}
      {op.reason === null && op.detail === null ? null : (
        <span className="min-w-0 basis-full text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
          {[op.reason, op.detail].filter((x) => x !== null).join(' — ')}
        </span>
      )}
    </div>
  );
}

export function RestartPanel(props: { readonly workerId: string }): ReactNode {
  const { workerId } = props;
  const all = useT().machineAdmin;
  const t = all.restart;
  const { status, error } = useOpsStatus(workerId);
  const submit = useSubmit();
  const guarded = useGuardedValue();
  const [drain, setDrain] = useState(true);
  const [timeoutMin, setTimeoutMin] = useState('30');
  const [armed, setArmed] = useState(false);
  const [started, setStarted] = useState<Op | null>(null);
  const op = useFollowedOp(workerId, started);

  let body: ReactNode;
  if (status === null) {
    body = error === null ? <SkeletonRows label={t.loading} rows={1} /> : <DyApiError error={error} />;
  } else if (!(status.supported && status.report?.service.restartable === true)) {
    body = (
      <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="restart-unavailable">
        {status.supported ? t.notManaged : t.unsupported}
      </p>
    );
  } else {
    const press = (): void => {
      setArmed(false);
      void submit.run(async () => {
        const res = await guarded(
          () =>
            restartWorker(workerId, {
              drain,
              drainTimeoutSec: Math.min(24 * 3600, Number(timeoutMin || '0') * 60),
            }),
          t.why,
        );
        if (res !== null) setStarted(res);
      });
    };
    body = (
      <div className="flex flex-col gap-3">
        <DyCheck label={t.drain} checked={drain} onChange={setDrain} />
        {drain ? (
          <DyField
            label={t.giveUp}
            inputMode="numeric"
            value={timeoutMin}
            onChange={(v) => {
              setTimeoutMin(v.replace(/\D/g, '').slice(0, 4));
            }}
            wrapClassName="max-w-[12rem]"
          />
        ) : (
          <DyNotice tone="amber">{t.stopNote}</DyNotice>
        )}
        {!status.connected ? <p className="m-0 text-[0.8125rem] text-dy-muted">{t.notConnected}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <DyButton
            variant="danger"
            icon="retry"
            busy={submit.busy}
            disabled={!status.connected || submit.blocked}
            data-testid="restart-worker"
            aria-haspopup="dialog"
            onClick={() => {
              setArmed(true);
            }}
          >
            {t.button}
          </DyButton>
        </div>
        <DyConfirmDialog
          open={armed}
          onClose={() => {
            setArmed(false);
          }}
          title={t.title}
          description={drain ? undefined : t.stopNote}
          confirmLabel={t.confirm}
          cancelLabel={all.cancel}
          variant="warn"
          testId="restart-worker-dialog"
          confirmTestId="restart-worker-confirm"
          onConfirm={press}
        />
        {op !== null ? <RestartState op={op} /> : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    );
  }
  return (
    <Panel title={t.title} sub={t.sub} testId="worker-restart">
      {body}
    </Panel>
  );
}
