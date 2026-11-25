import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import {
  cancelHostAction,
  getHostAction,
  type HostAction,
  type HostActionState,
  OPEN_STATES,
} from '../../../api/hostActions';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyApiError } from '../../common/notices';
import { DyIcon, type IconName } from '../../icons';
import { KeyValue } from '../../KeyValue';
import type { Tone } from '../../tone';
import { DyButton, Panel, Pill } from '../parts';

/**
 * p17-host-actions: the progress of one request the remyral-ctl host applier runs (update, rollback, backups). Polls
 * `GET /host-actions/requests/:id` while it is open. During an update the master is stopped and the proxy answers 502
 * (or nothing): the panel says "the server is restarting" and keeps polling until the master answers again, then
 * shows the final result (and, after an update, offers to reload the console).
 */

/** Poll period; tests make it short. */
export const HOST_POLL = { ms: 3000 };

export const STATE_LOOK: Readonly<Record<HostActionState, { tone: Tone; icon: IconName }>> = {
  pending: { tone: 'neutral', icon: 'clock' },
  applying: { tone: 'teal', icon: 'retry' },
  applied: { tone: 'green', icon: 'checkc' },
  scheduled: { tone: 'amber', icon: 'clock' },
  rolled_back: { tone: 'amber', icon: 'retry' },
  held: { tone: 'red', icon: 'shield' },
  failed: { tone: 'red', icon: 'xc' },
  refused: { tone: 'red', icon: 'xc' },
  expired: { tone: 'neutral', icon: 'clock' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

/** The master is away (stopped for the update, the proxy answers 502 / 503 / 504, or no answer at all). */
export function masterAway(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504)
  );
}

export function HostRequestProgress(props: {
  readonly action: HostAction;
  /** Called once when the request reaches a final state (the screen re-reads its data). */
  readonly onFinished?: ((a: HostAction) => void) | undefined;
}): ReactNode {
  const t = useT().hostActions.progress;
  const [action, setAction] = useState(props.action);
  const [away, setAway] = useState(false);
  const cancel = useSubmit();
  const stepUp = useStepUp();
  const finished = useRef(false);
  const { onFinished } = props;
  const open = OPEN_STATES.includes(action.state);

  useEffect(() => {
    setAction(props.action);
  }, [props.action]);

  useEffect(() => {
    if (!open) {
      if (!finished.current) {
        finished.current = true;
        onFinished?.(action);
      }
      return;
    }
    finished.current = false;
    let alive = true;
    const timer = setInterval(() => {
      getHostAction(action.id, { noSessionRetry: true }).then(
        (a) => {
          if (!alive) return;
          setAway(false);
          setAction(a);
        },
        (err: unknown) => {
          if (alive && masterAway(err)) setAway(true);
        },
      );
    }, HOST_POLL.ms);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [action, open, onFinished]);

  const look = STATE_LOOK[action.state];
  const upgraded = action.kind === 'upgrade' && action.state === 'applied';
  return (
    <Panel
      title={`${t.title}: ${t.kinds[action.kind] ?? action.kind}`}
      testId="dy-host-request"
      aside={
        <Pill tone={look.tone} icon={look.icon}>
          {t.states[action.state] ?? action.state}
        </Pill>
      }
    >
      {away && open ? (
        <p
          role="status"
          data-testid="dy-host-reconnecting"
          className="m-0 mb-3 flex items-center gap-1.5 text-[0.875rem] font-bold text-dy-amber-ink"
        >
          <DyIcon name="retry" className="dy-breathe size-4" />
          {t.reconnecting}
        </p>
      ) : null}
      <KeyValue
        rows={[
          ...(action.step ? [{ k: t.step, v: action.step }] : []),
          ...(action.detail ? [{ k: t.detail, v: action.detail }] : []),
        ]}
      />
      {action.state === 'held' ? <p className="m-0 mt-2 text-[0.875rem] text-dy-red-ink">{t.held}</p> : null}
      {action.log.length > 0 ? (
        <details className="mt-3" open={open}>
          <summary className="cursor-pointer text-[0.8125rem] font-bold">{t.log}</summary>
          <pre
            data-testid="dy-host-log"
            className="m-0 mt-2 max-h-64 overflow-auto rounded-[10px] bg-dy-sunk p-3 text-[0.75rem] whitespace-pre-wrap"
          >
            {action.log.join('\n')}
          </pre>
        </details>
      ) : null}
      {upgraded ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="dy-host-reload">
          <span className="text-[0.875rem]">{t.reloadHint}</span>
          <DyButton
            variant="primary"
            icon="retry"
            onClick={() => {
              window.location.reload();
            }}
          >
            {t.reload}
          </DyButton>
        </div>
      ) : null}
      {action.state === 'pending' ? (
        <div className="mt-3">
          <DyButton
            variant="ghost"
            icon="xc"
            busy={cancel.busy}
            onClick={() => {
              void cancel.run(async () => {
                try {
                  setAction(await stepUp.run(() => cancelHostAction(action.id), t.cancel));
                } catch (err) {
                  if (err instanceof StepUpCancelledError) return;
                  throw err;
                }
              });
            }}
          >
            {t.cancel}
          </DyButton>
          <DyApiError error={cancel.error} />
        </div>
      ) : null}
    </Panel>
  );
}
