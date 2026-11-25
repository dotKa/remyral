import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  type ApprovalMode,
  type ApprovalModeChange,
  type ApprovalModeState,
  getApprovalMode,
  setApprovalMode,
} from '../../api/approvalMode';
import { cx, toApiError } from '../../components/ui';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyIcon } from '../icons';
import { DyButton, Panel } from '../screens/parts';
import { dateTimeText, Notice } from './details/bits';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { type Messages, messagesFor } from '@remyral/i18n';

/**
 * p12-diyalog-w1: the job's approval mode as a side panel of the control panel (docs/design/p12-diyalog.md §14),
 * natively in the Diyalog language — it replaced the classic `ApprovalModeControl` in a dialog. Same reads and rules:
 * `GET /jobs/:id/approval-mode` (current, original, who may change it and why not, the allowed options with their
 * reasons, the live machine, the change history), `POST` with `expectedSeq` (a 409 re-reads), step-up when the master
 * asks (a machine-administration job going to "Hiç sorma"), a look again every 2 s while the machine has not
 * confirmed a sent change. One read feeds both this panel and the activity log's mode lines.
 */

const TR = messagesFor('tr');

type ModeWords = Messages['job']['approvalMode']['modes'][keyof Messages['job']['approvalMode']['modes']];

const MODE_KEY: Readonly<Record<string, keyof Messages['job']['approvalMode']['modes']>> = {
  'ask-sensitive': 'askSensitive',
  'ask-all': 'askAll',
  'deny-sensitive': 'denySensitive',
  'allow-all': 'allowAll',
};

function modeWords(mode: string, m: Messages): ModeWords | null {
  const k = MODE_KEY[mode];
  return k === undefined ? null : m.job.approvalMode.modes[k];
}

/** An approval mode's name ("Hassas adımlarda sor"); an unknown mode as it is. */
export function modeLabel(mode: string, m: Messages = TR): string {
  return modeWords(mode, m)?.label ?? mode;
}

/** How a change took effect, in words (the classic `applicationText`, in the UI language). */
export function applicationText(
  c: Pick<ApprovalModeChange, 'delivery' | 'application'>,
  m: Messages = TR,
): string {
  const w = m.job.approvalMode.application;
  if (c.delivery === 'not_running') return w.notRunning;
  switch (c.application) {
    case null:
      return w.waiting;
    case 'live':
      return w.live;
    case 'gate':
      return w.gate;
    case 'partial':
      return w.partial;
    case 'next_turn':
      return w.nextTurn;
    case 'refused':
      return w.refused;
  }
}

export interface ApprovalModeResource {
  readonly data: ApprovalModeState | null;
  readonly reload: () => void;
  readonly set: (d: ApprovalModeState) => void;
}

/** One read of the job's approval mode, re-read on a state change and every 2 s while a sent change is unconfirmed. */
export function useApprovalModeState(jobId: string, state: string): ApprovalModeResource {
  const [data, setData] = useState<ApprovalModeState | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    getApprovalMode(jobId, { signal: ctl.signal }).then(
      (d) => {
        if (!ctl.signal.aborted) setData(d);
      },
      // An older master (no route) or a transient failure: the panel stays hidden until it can load.
      () => undefined,
    );
    return () => {
      ctl.abort();
    };
  }, [jobId, state, tick]);
  const last = data?.changes.at(-1);
  const waiting = last !== undefined && last.delivery === 'sent' && last.application === null;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(reload, 2_000);
    return () => {
      clearTimeout(t);
    };
  }, [waiting, reload, data]);
  return { data, reload, set: setData };
}

function changeTone(c: ApprovalModeChange): 'red' | 'amber' | 'teal' {
  return c.application === 'refused'
    ? 'red'
    : c.application === 'partial' || c.application === 'next_turn'
      ? 'amber'
      : 'teal';
}

export function lastChangeText(c: ApprovalModeChange, m: Messages = TR): string {
  return [
    applicationText(c, m),
    c.detail !== null && c.application !== 'live' ? c.detail : '',
    c.pendingResolved > 0 ? m.job.approvalMode.resolved({ n: c.pendingResolved }) : '',
  ]
    .filter((s) => s !== '')
    .join(' ');
}

export function ApprovalModePanel(props: {
  readonly jobId: string;
  readonly mode: ApprovalModeResource;
  /** The job can still change mode (not finished, not cancelling, not a retired runtime). */
  readonly changeable: boolean;
  readonly onChanged: () => void;
  /** Set by the header menu ("Onay modunu değiştir"): open the change control and move focus to it. */
  readonly openRequested?: boolean | undefined;
  readonly onOpenHandled?: (() => void) | undefined;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const w = t.job.approvalMode;
  const { data } = props.mode;
  const stepUp = useStepUp();
  const selectId = useId();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<ApprovalMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusNext, setFocusNext] = useState(false);

  const { openRequested, onOpenHandled } = props;
  const loaded = data !== null;
  useEffect(() => {
    if (openRequested !== true || !loaded) return;
    setEditing(true);
    setFocusNext(true);
    onOpenHandled?.();
  }, [openRequested, onOpenHandled, loaded]);
  useEffect(() => {
    if (!focusNext) return;
    setFocusNext(false);
    const root = rootRef.current;
    if (root !== null && typeof root.scrollIntoView === 'function') root.scrollIntoView({ block: 'nearest' });
    (selectRef.current ?? rootRef.current)?.focus();
  }, [focusNext, editing, data]);

  if (data === null) return null;
  const canChange = data.canChange && props.changeable;
  const selected = choice ?? data.current;
  const option = data.options.find((o) => o.mode === selected);
  const last = data.changes.at(-1) ?? null;
  const dirty = choice !== null && choice !== data.current;

  const apply = async (): Promise<void> => {
    if (choice === null || choice === data.current) return;
    setBusy(true);
    setError(null);
    try {
      const r = await stepUp.run(
        () => setApprovalMode(props.jobId, { mode: choice, expectedSeq: data.seq }),
        w.stepUp,
      );
      props.mode.set(r.approvalMode);
      setChoice(null);
      setEditing(false);
      props.onChanged();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(sayError(err));
      if (toApiError(err).status === 409) props.mode.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none" data-testid="dy-approval-mode">
      <Panel
        title={w.title}
        sub={
          data.current !== data.original ? (
            <span data-testid="dy-approval-mode-original">
              {w.startedWith({ mode: modeLabel(data.original, t) })}
            </span>
          ) : undefined
        }
        aside={
          canChange && !editing ? (
            <DyButton
              variant="ghost"
              icon="pen"
              onClick={() => {
                setEditing(true);
                setFocusNext(true);
              }}
            >
              {w.change}
            </DyButton>
          ) : undefined
        }
      >
        <div className="grid gap-2.5 text-[0.875rem]">
          {editing && canChange ? (
            <div className="grid gap-2">
              <label htmlFor={selectId} className="text-[0.8125rem] font-bold">
                {w.newMode}
              </label>
              <select
                id={selectId}
                ref={selectRef}
                value={selected}
                disabled={busy}
                data-testid="dy-approval-mode-select"
                onChange={(e) => {
                  setChoice(e.target.value as ApprovalMode);
                  setError(null);
                }}
                className="min-h-10 w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] text-dy-ink sm:min-h-9 sm:text-[0.875rem]"
              >
                {data.options.map((o) => (
                  <option key={o.mode} value={o.mode} disabled={!o.allowed && o.mode !== data.current}>
                    {`${modeLabel(o.mode, t)}${!o.allowed && o.mode !== data.current ? w.notAllowed : ''}`}
                  </option>
                ))}
              </select>
              {option === undefined ? null : (
                <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="dy-approval-mode-effect">
                  {modeWords(option.mode, t)?.text}
                  {option.reason === null ? null : (
                    <span className="mt-0.5 block text-dy-amber-ink">{option.reason}</span>
                  )}
                  {data.live !== null && option.allowed && dirty ? w.liveEffect : ''}
                </p>
              )}
              <span className="flex flex-wrap gap-2">
                <DyButton
                  variant="primary"
                  busy={busy}
                  disabled={!dirty || option?.allowed === false}
                  onClick={() => void apply()}
                >
                  {data.live === null ? w.change : w.changeNow}
                </DyButton>
                <DyButton
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setChoice(null);
                    setError(null);
                  }}
                >
                  {w.discard}
                </DyButton>
              </span>
            </div>
          ) : (
            <p className="m-0 flex items-center gap-2">
              <DyIcon name="shield" className="size-4 text-dy-muted" />
              <b className="font-bold" data-testid="dy-approval-mode-current">
                {modeLabel(data.current, t)}
              </b>
            </p>
          )}
          {!data.canChange && data.reason !== null ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="dy-approval-mode-reason">
              {data.reason}
            </p>
          ) : null}
          {last === null ? null : (
            <Notice tone={changeTone(last)} live>
              <span
                data-testid="dy-approval-mode-applied"
                data-application={last.application ?? last.delivery}
              >
                {lastChangeText(last, t)}
              </span>
            </Notice>
          )}
          {error === null ? null : <Notice tone="red">{w.failed({ error })}</Notice>}
          {data.changes.length === 0 ? null : (
            <div>
              <button
                type="button"
                aria-expanded={historyOpen}
                onClick={() => {
                  setHistoryOpen((v) => !v);
                }}
                className="dy-press inline-flex items-center gap-1 text-[0.8125rem] font-medium text-dy-teal-ink"
              >
                <DyIcon
                  name="chev"
                  className={cx('size-3.5 transition-transform', historyOpen && 'rotate-180')}
                />
                {w.history({ n: data.changes.length })}
              </button>
              {historyOpen ? <ModeHistory changes={data.changes} /> : null}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** The change history ("Hassas adımlarda sor → Her adımda sor · alex · 19 Eki 14:02 · Runtime canlı uyguladı"). */
export function ModeHistory(props: { readonly changes: readonly ApprovalModeChange[] }): ReactNode {
  const fmt = useFormat();
  const t = useT();
  return (
    <ol
      className="m-0 mt-2 grid list-none gap-2 p-0"
      aria-label={t.job.approvalMode.historyLabel}
      data-testid="dy-approval-mode-history"
    >
      {props.changes.map((c) => (
        <li key={c.id} className="border-l-2 border-dy-line-2 pl-2.5 text-[0.84375rem]">
          <b className="font-bold">{`${modeLabel(c.from, t)} → ${modeLabel(c.to, t)}`}</b>
          <span className="block text-[0.8125rem] text-dy-muted">
            {`${c.actor.username} · ${dateTimeText(c.createdAt, fmt)} · ${applicationText(c, t)}`}
          </span>
          {c.reason === null ? null : (
            <span className="block text-[0.8125rem] text-dy-muted">{`“${c.reason}”`}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
