import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import type { Messages } from '@remyral/i18n';
import { extendApproval, type ApprovalRequest } from '../../api/approvals';
import { changeTimeLimit, getTimeLimit, type TimeLimitState } from '../../api/timeLimit';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DY_INPUT } from '../forms';
import { DyButton } from '../screens/parts';
import { toast } from '../toast/store';
import { JobClockFacts } from './jobClock';

/**
 * p15-autonomy (docs/design/p15-autonomy.md §10; the time limit is editable from the job's cards):
 * the time limit of a job edited from its cards — quick extensions (+30 min, +1 h, +4 h) and an exact value, applied
 * live by the master and the machine (no restart) — and the "expires if nobody decides" deadline of an approval card.
 * The master enforces the bounds (the security policy's maximum) and asks for a code only when the policy says so.
 */

type T = Messages['timeLimits'];

/** "45 dk", "2 saat", "1 sa 30 dk", "3 gün". */
export function durationText(t: T, sec: number): string {
  const min = Math.round(sec / 60);
  if (min < 60) return t.minutes({ n: min });
  if (min % 1440 === 0) return t.days({ n: min / 1440 });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? t.hours({ n: h }) : t.hoursMinutes({ h, m });
}

const QUICK_SEC: readonly number[] = [30 * 60, 3600, 4 * 3600];

/** A job's time limit with quick extensions; renders nothing for finished jobs or callers who cannot change it. */
export function JobTimeLimit(props: { readonly jobId: string; readonly state: string }): ReactNode {
  const t = useT().timeLimits;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const inputId = useId();
  const [data, setData] = useState<TimeLimitState | null>(null);
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { jobId, state } = props;

  const load = useCallback(() => {
    getTimeLimit(jobId).then(setData, () => undefined);
  }, [jobId]);
  useEffect(() => {
    load();
  }, [load, state]);
  const last = data?.changes.at(-1) ?? null;
  const waiting = last?.delivery === 'sent' && last.application === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(load, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [waiting, load, data]);
  if (data === null) return null;
  // p20-job-clock: run time used and the human waits that did not count (also for callers who cannot change it).
  const facts = <JobClockFacts clock={data.clock} />;
  if (!data.canChange) return data.clock?.clock == null ? null : facts;

  async function apply(change: { maxDurationSec: number } | { addSec: number }): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await stepUp.run(() => changeTimeLimit(jobId, change));
      setData(next);
      setMinutes('');
      const time = durationText(t, next.maxDurationSec);
      // p17-toasts-shortcuts: the result is a toast; a refusal / failure stays next to the controls.
      toast.success(next.live === null ? t.appliedLater({ time }) : t.applied({ time }), {
        id: `time-limit-${jobId}`,
        testId: 'time-limit-note',
      });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(t.failed({ reason: sayError(err) }));
    } finally {
      setBusy(false);
    }
  }

  const current = data.maxDurationSec;
  const custom = Number(minutes);
  const customOk =
    minutes !== '' &&
    Number.isInteger(custom) &&
    custom * 60 >= data.minSec &&
    custom * 60 <= data.maxAllowedSec;
  return (
    <div className="grid gap-2" data-testid="job-time-limit">
      {facts}
      <p className="m-0 text-[0.875rem]">
        <span className="font-bold">{t.current({ time: durationText(t, current) })}</span>
        {data.originalSec === current ? null : (
          <span className="text-dy-muted"> · {t.original({ time: durationText(t, data.originalSec) })}</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {QUICK_SEC.filter((s) => current + s <= data.maxAllowedSec).map((s) => (
          <DyButton
            key={s}
            busy={busy}
            data-testid={`time-limit-add-${String(s)}`}
            onClick={() => void apply({ addSec: s })}
          >
            {t.add({ time: durationText(t, s) })}
          </DyButton>
        ))}
        <label htmlFor={inputId} className="sr-only">
          {t.custom}
        </label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={Math.ceil(data.minSec / 60)}
          max={Math.floor(data.maxAllowedSec / 60)}
          placeholder={t.custom}
          value={minutes}
          onChange={(e) => {
            setMinutes(e.target.value);
          }}
          className={`${DY_INPUT} w-28`}
          data-testid="time-limit-minutes"
        />
        <DyButton
          busy={busy}
          disabled={!customOk}
          data-testid="time-limit-apply"
          onClick={() => void apply({ maxDurationSec: custom * 60 })}
        >
          {t.apply}
        </DyButton>
      </div>
      <p className="m-0 text-[0.78125rem] text-dy-muted">
        {t.max({ time: durationText(t, data.maxAllowedSec) })}
        {data.live !== null && !data.live.supportsLive ? ` ${t.liveUnsupported}` : ''}
      </p>
      {waiting ? <p className="m-0 text-[0.8125rem] text-dy-muted">{t.waiting}</p> : null}
      {last?.application === 'refused' ? (
        <p className="m-0 text-[0.8125rem] text-dy-red-ink">{t.refused}</p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/** The time limit field of a job draft card (minutes; saved through the card's edit path). */
export function DraftTimeLimitField(props: {
  readonly sec: number | null;
  readonly disabled?: boolean | undefined;
  readonly onSave: (sec: number) => Promise<boolean>;
}): ReactNode {
  const t = useT().timeLimits;
  const id = useId();
  const [value, setValue] = useState(props.sec === null ? '' : String(Math.round(props.sec / 60)));
  useEffect(() => {
    setValue(props.sec === null ? '' : String(Math.round(props.sec / 60)));
  }, [props.sec]);
  const n = Number(value);
  const changed = value !== '' && Number.isInteger(n) && n >= 1 && n * 60 !== props.sec;
  return (
    <div className="grid gap-1" data-testid="draft-time-limit">
      <label htmlFor={id} className="text-[0.8125rem] font-bold">
        {t.draftLabel}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={7 * 24 * 60}
          value={value}
          disabled={props.disabled === true}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onBlur={() => {
            if (changed) void props.onSave(n * 60);
          }}
          className={`${DY_INPUT} w-28`}
          data-testid="draft-time-limit-input"
        />
        {props.sec === null ? null : (
          <span className="text-[0.8125rem] text-dy-muted">{durationText(t, props.sec)}</span>
        )}
      </div>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.draftHint}</p>
    </div>
  );
}

const APPROVAL_QUICK_SEC: readonly number[] = [3600, 24 * 3600];

/** "Karar gelmezse süresi dolar": the deadline of a pending approval with +1 h / +1 day. */
export function ApprovalDeadline(props: {
  readonly request: ApprovalRequest;
  readonly onChanged: (r: ApprovalRequest) => void;
}): ReactNode {
  const t = useT().timeLimits;
  const format = useFormat();
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = props.request;
  if (r.status !== 'pending') return null;
  async function extend(sec: number): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await stepUp.run(() => extendApproval(r.id, sec));
      // p17-toasts-shortcuts: the new deadline is a toast (the card shows it too); a failure stays here.
      toast.success(t.approval.extended({ time: format.dateTime(next.expiresAt) }), {
        id: `approval-extended-${r.id}`,
        testId: 'approval-extended',
      });
      props.onChanged(next);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(t.approval.failed({ reason: sayError(err) }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="approval-deadline">
      <span className="text-[0.8125rem] text-dy-muted">
        {t.approval.deadline({ time: format.relative(r.expiresAt) })}
      </span>
      {APPROVAL_QUICK_SEC.map((s) => (
        <DyButton
          key={s}
          busy={busy}
          aria-label={`${t.approval.extend}: ${t.add({ time: durationText(t, s) })}`}
          data-testid={`approval-extend-${String(s)}`}
          onClick={() => void extend(s)}
        >
          {t.add({ time: durationText(t, s) })}
        </DyButton>
      ))}
      {error === null ? null : (
        <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
          {error}
        </span>
      )}
    </div>
  );
}
