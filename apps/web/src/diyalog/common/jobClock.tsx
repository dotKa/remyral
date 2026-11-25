import { type ReactNode, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ChatMessage } from '../../api/chat';
import {
  changeTimeLimit,
  continueAfterTimeout,
  getTimeLimit,
  type JobClockState,
  type TimeLimitState,
} from '../../api/timeLimit';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { ReadOnlyContext } from '../chat/turnControls';
import { DyButton, Panel } from '../screens/parts';
import { toast } from '../toast/store';
import { machineName, useMachineNames } from '../../lib/machineDirectory';
import { durationText } from './timeLimit';

/**
 * p20-job-clock (docs/design/p20-job-clock.md; a job's time is set from its estimate and extended when it is running
 * out): a job's run clock as the worker reports it — run time used, the human
 * waits (answers, approvals) that did not count — the "running out of time" note's one-tap extensions, and
 * "Aynı yerden devam et" for a job that stopped on its time limit.
 */

/** Run time, waits and the warning of a job (nothing when the master has no clock for it). */
export function JobClockFacts(props: { readonly clock: JobClockState | null }): ReactNode {
  const t = useT().timeLimits;
  const format = useFormat();
  const c = props.clock;
  if (c === null) return null;
  const r = c.clock;
  const lines: ReactNode[] = [];
  if (r !== null) {
    lines.push(
      <p key="used" className="m-0 text-[0.8125rem]" data-testid="job-clock-used">
        {t.clock.used({ used: durationText(t, r.activeSec), budget: durationText(t, r.budgetSec) })}
        {r.final ? null : (
          <span className="text-dy-muted"> · {t.clock.left({ time: durationText(t, r.remainingSec) })}</span>
        )}
      </p>,
    );
    if (!r.final && r.waiting === 'question')
      lines.push(
        <p key="wq" className="m-0 text-[0.8125rem] text-dy-muted" data-testid="job-clock-waiting">
          {t.clock.waitingQuestion}
        </p>,
      );
    if (!r.final && r.waiting === 'approval')
      lines.push(
        <p key="wa" className="m-0 text-[0.8125rem] text-dy-muted" data-testid="job-clock-waiting">
          {t.clock.waitingApproval}
        </p>,
      );
    if (r.questionWaitSec >= 60)
      lines.push(
        <p key="q" className="m-0 text-[0.8125rem] text-dy-muted" data-testid="job-clock-question-wait">
          {t.clock.questionWait({ time: durationText(t, r.questionWaitSec) })}
        </p>,
      );
    if (r.approvalWaitSec >= 60)
      lines.push(
        <p key="a" className="m-0 text-[0.8125rem] text-dy-muted" data-testid="job-clock-approval-wait">
          {t.clock.approvalWait({ time: durationText(t, r.approvalWaitSec) })}
        </p>,
      );
  }
  if (c.questionsPauseClock === false)
    lines.push(
      <p key="old" className="m-0 text-[0.78125rem] text-dy-muted" data-testid="job-clock-old-machine">
        {t.clock.oldMachine}
      </p>,
    );
  if (c.warning !== null && !c.timedOut)
    lines.push(
      <p key="w" className="m-0 text-[0.78125rem] text-dy-muted" data-testid="job-clock-warned">
        {t.clock.warned({ time: format.relative(c.warning.at) })}
      </p>,
    );
  if (lines.length === 0) return null;
  return (
    <div className="grid gap-1" data-testid="job-clock">
      {lines}
    </div>
  );
}

/** "Aynı yerden devam et": starts the continuation job; `onStarted` (default: a link to it under the button). */
export function ContinueAfterTimeoutButton(props: {
  readonly jobId: string;
  /** The limit the continuation gets (s; null: the master's default). */
  readonly continueSec: number | null;
  readonly onStarted?: (jobId: string) => void;
}): ReactNode {
  const t = useT().timeLimits;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  if (started !== null && props.onStarted === undefined)
    return (
      <p className="m-0 text-[0.8125rem]" role="status" data-testid="job-continued">
        {t.clock.continued({ id: started.slice(0, 8) })} ·{' '}
        <Link to={`/jobs/${started}`} className="font-bold text-dy-ink underline">
          {t.clock.openContinued}
        </Link>
      </p>
    );
  async function go(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const out = await stepUp.run(() => continueAfterTimeout(props.jobId));
      toast.success(t.clock.continued({ id: out.jobId.slice(0, 8) }), {
        id: `job-continued-${props.jobId}`,
        testId: 'job-continued-toast',
      });
      setStarted(out.jobId);
      props.onStarted?.(out.jobId);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(t.clock.continueFailed({ reason: sayError(err) }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="grid gap-1 justify-items-start">
      <DyButton
        variant="primary"
        icon="retry"
        busy={busy}
        data-testid="job-continue-after-timeout"
        onClick={() => void go()}
      >
        {props.continueSec === null
          ? t.clock.continue
          : t.clock.continueWith({ time: durationText(t, props.continueSec) })}
      </DyButton>
      {error === null ? null : (
        <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * A finished job's clock: what it used, the waits that did not count and — when it stopped on its time limit —
 * "Aynı yerden devam et". Renders nothing for a finished job without a clock report that did not time out.
 */
export function JobClockEndPanel(props: {
  readonly jobId: string;
  readonly state: string;
  readonly onContinued?: (jobId: string) => void;
}): ReactNode {
  const tl = useT().timeLimits;
  const names = useMachineNames();
  const [data, setData] = useState<TimeLimitState | null>(null);
  const { jobId, state } = props;
  useEffect(() => {
    getTimeLimit(jobId).then(setData, () => undefined);
  }, [jobId, state]);
  const c = data?.clock ?? null;
  if (c === null || (!c.timedOut && c.clock === null)) return null;
  return (
    <Panel title={tl.title} testId="dy-job-clock-end">
      <div className="grid gap-2 px-4 pb-4">
        {c.timedOut ? (
          <p className="m-0 text-[0.875rem] font-bold" data-testid="job-timed-out">
            {tl.clock.expired} · {tl.clock.timedOut}
          </p>
        ) : null}
        {/* p22-timeout-continuity: what the machine kept of the work, and where. */}
        {c.timedOut && c.keptWork !== null ? (
          <p className="m-0 text-[0.8125rem] [overflow-wrap:anywhere]" data-testid="job-kept-work">
            {c.keptWork.pushed
              ? tl.clock.keptPushed({ files: c.keptWork.files, branch: c.keptWork.branch })
              : tl.clock.keptLocal({
                  files: c.keptWork.files,
                  machine: machineName(names, c.keptWork.workerId),
                })}
          </p>
        ) : null}
        <JobClockFacts clock={c} />
        {c.timedOut && c.canContinue ? (
          <ContinueAfterTimeoutButton
            jobId={jobId}
            continueSec={c.continueSec}
            {...(props.onContinued === undefined ? {} : { onStarted: props.onContinued })}
          />
        ) : null}
      </div>
    </Panel>
  );
}

/** The facts of a `job-time-warning` chat note (`meta.jobTimeWarning`), or null for other messages. */
export function timeWarningOf(
  m: ChatMessage,
): { readonly jobId: string; readonly limitSec: number; readonly maxAllowedSec: number } | null {
  const meta = m.meta;
  if (meta?.notice !== 'job-time-warning' || typeof meta.jobId !== 'string') return null;
  const w = meta.jobTimeWarning;
  if (typeof w !== 'object' || w === null) return null;
  const { limitSec, maxAllowedSec } = w as { limitSec?: unknown; maxAllowedSec?: unknown };
  if (typeof limitSec !== 'number' || typeof maxAllowedSec !== 'number') return null;
  return { jobId: meta.jobId, limitSec, maxAllowedSec };
}

const WARNING_QUICK_SEC: readonly number[] = [30 * 60, 3600];

/** "+30 dk" / "+1 saat" under a time warning note (one tap; the master checks the bounds and the role again). */
export function TimeWarningActions(props: { readonly m: ChatMessage }): ReactNode {
  const t = useT().timeLimits;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const readOnly = useContext(ReadOnlyContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const w = timeWarningOf(props.m);
  if (w === null || readOnly) return null;
  const current = limit ?? w.limitSec;
  const quick = WARNING_QUICK_SEC.filter((s) => current + s <= w.maxAllowedSec);
  async function extend(addSec: number): Promise<void> {
    if (w === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await stepUp.run(() => changeTimeLimit(w.jobId, { addSec }));
      setLimit(next.maxDurationSec);
      toast.success(t.applied({ time: durationText(t, next.maxDurationSec) }), {
        id: `time-limit-${w.jobId}`,
        testId: 'time-limit-note',
      });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(t.failed({ reason: sayError(err) }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-2" data-testid="job-time-warning-actions">
      {quick.map((s) => (
        <DyButton
          key={s}
          busy={busy}
          aria-label={`${t.clock.extend}: ${t.add({ time: durationText(t, s) })}`}
          data-testid={`time-warning-add-${String(s)}`}
          onClick={() => void extend(s)}
        >
          {t.add({ time: durationText(t, s) })}
        </DyButton>
      ))}
      {limit === null ? null : (
        <span className="text-[0.8125rem] text-dy-muted" role="status">
          {t.current({ time: durationText(t, limit) })}
        </span>
      )}
      <Link to={`/jobs/${w.jobId}`} className="text-[0.8125rem] font-bold text-dy-ink underline">
        {t.clock.openJob}
      </Link>
      {error === null ? null : (
        <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
          {error}
        </span>
      )}
    </span>
  );
}
