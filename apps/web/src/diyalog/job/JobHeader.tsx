import { type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { JobDetail } from '../../api/jobs';
import { PRIORITY_CLASS_LABEL, priorityClassOf } from '../../api/queue';
import { cx } from '../../components/ui';
import { machineHref } from '../../lib/reasons';
import { formatSpan, jobDurationMs } from '../../screens/job/format';
import { agoText } from '../common/time';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyIcon, type IconName } from '../icons';
import { useChangeCount } from '../motionKit';
import { RuntimeMark } from '../RuntimeMark';
import { SOFT, type Tone } from '../tone';
import { PlatformBadge, platformPill } from './platform';

/**
 * p12-diyalog Faz 2 (control panel since the 2026-10-19 direction change): the job's header (mockup `#job` `.pin`) — the title (p15-job-titles: the job's own short title, editable), the
 * state as a pill (icon + word + tone, never colour alone), then the facts: id, project and class, runtime and model,
 * machine, checkpoint, memory, duration, cost. Right: "Ayrıntılar" (the classic Files / Logs / Details panels) and a
 * menu with the job's other actions (approval mode, template, export, cancel).
 */

export interface JobStatePill {
  readonly tone: Tone;
  readonly icon: IconName;
  readonly label: string;
}

const TR = messagesFor('tr');

/**
 * The job state in the thread's words. `waiting`: an approval of the running agent is pending (the job runs but waits
 * for a person); `stale`: that approval has waited long (still pending, not paused). `m`: the UI language's catalog
 * (Turkish by default).
 */
export function jobStatePill(state: string, stale = false, waiting = false, m: Messages = TR): JobStatePill {
  const w = m.job.header.state;
  if (waiting && (state === 'RUNNING' || state === 'AWAITING_APPROVAL'))
    return { tone: 'amber', icon: 'shield', label: stale ? w.waitingStale : w.waiting };
  switch (state) {
    case 'RUNNING':
    case 'STARTING':
    case 'RESERVED':
      return { tone: 'teal', icon: 'retry', label: state === 'RUNNING' ? w.running : w.starting };
    case 'VERIFYING':
      return { tone: 'teal', icon: 'checkc', label: w.verifying };
    case 'AWAITING_APPROVAL':
      return { tone: 'amber', icon: 'shield', label: stale ? w.waitingStale : w.waiting };
    case 'PAUSED':
      return { tone: 'violet', icon: 'pause', label: w.paused };
    case 'QUEUED':
    case 'DRAFT':
      return { tone: 'neutral', icon: 'clock', label: w.queued };
    case 'RETRY_WAIT':
      return { tone: 'neutral', icon: 'clock', label: w.retryWait };
    case 'SUCCEEDED':
      return { tone: 'green', icon: 'checkc', label: w.succeeded };
    case 'FAILED':
      return { tone: 'red', icon: 'xc', label: w.failed };
    case 'LOST':
      return { tone: 'red', icon: 'cpu', label: w.lost };
    case 'BLOCKED':
      return { tone: 'amber', icon: 'pause', label: w.blocked };
    case 'CANCELLING':
      return { tone: 'neutral', icon: 'xc', label: w.cancelling };
    case 'CANCELLED':
      return { tone: 'neutral', icon: 'xc', label: w.cancelled };
    default:
      return { tone: 'neutral', icon: 'clock', label: state };
  }
}

/**
 * A relative time in the UI language: the Diyalog Turkish words ("3 dk önce", unchanged) or the locale's
 * `Intl.RelativeTimeFormat` sentence ("3 minutes ago").
 */
export function relativeText(iso: string, now: number, f: Formatter): string {
  return f.locale === 'tr' ? agoText(iso, now) : f.relative(iso, now);
}

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly to?: string | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly danger?: boolean | undefined;
}

/** A small disclosure menu (native `<details>`: keyboard and screen readers for free). Escape and outside click close it. */
export function HeaderMenu(props: { readonly items: readonly MenuItem[] }): ReactNode {
  const menuLabel = useT().job.header.menu;
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent): void => {
      const d = ref.current;
      if (d?.open !== true) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        d.open = false;
        d.querySelector('summary')?.focus();
        return;
      }
      if (e.target instanceof Node && !d.contains(e.target)) d.open = false;
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  if (props.items.length === 0) return null;
  const done = (): void => {
    if (ref.current !== null) ref.current.open = false;
  };
  const item =
    'flex min-h-11 w-full items-center gap-2.5 rounded-[9px] px-3 text-left text-sm whitespace-nowrap no-underline sm:min-h-10 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk focus-visible:bg-dy-sunk';
  return (
    <details ref={ref} className="relative" data-testid="dy-job-menu">
      <summary
        aria-label={menuLabel}
        className="dy-press grid size-9 cursor-pointer list-none place-items-center rounded-[9px] border border-dy-line-2 bg-dy-card text-dy-muted [&::-webkit-details-marker]:hidden [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
      >
        <DyIcon name="more" className="size-[18px]" />
      </summary>
      <div className="absolute right-0 z-20 mt-1.5 flex min-w-60 flex-col rounded-[12px] border border-dy-line bg-dy-card p-1 shadow-dy-pop">
        {props.items.map((it) =>
          it.to !== undefined ? (
            <Link key={it.key} to={it.to} onClick={done} className={cx(item, 'text-dy-ink')}>
              <DyIcon name={it.icon} className="size-4 text-dy-muted" />
              {it.label}
            </Link>
          ) : (
            <button
              key={it.key}
              type="button"
              onClick={() => {
                done();
                it.onSelect?.();
              }}
              className={cx(item, it.danger === true ? 'text-dy-red-ink' : 'text-dy-ink')}
            >
              <DyIcon
                name={it.icon}
                className={cx('size-4', it.danger === true ? 'text-dy-red-ink' : 'text-dy-muted')}
              />
              {it.label}
            </button>
          ),
        )}
      </div>
    </details>
  );
}

/**
 * p15-job-titles: the job's title as the page heading, with "Başlığı düzenle" (pencil) for people who may start jobs in
 * the project: an inline one-line field (≤ 60 characters), Enter saves, Escape cancels.
 */
export function JobTitleHeading(props: {
  readonly title: string;
  readonly onRename?: ((title: string) => Promise<void>) | undefined;
}): ReactNode {
  const w = useT().job.header.title;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setValue(props.title);
  }, [props.title, editing]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const length = Array.from(trimmed).length;
  const invalid = trimmed === '' ? w.empty : length > 60 ? w.tooLong({ n: length }) : null;
  const save = (): void => {
    if (props.onRename === undefined || invalid !== null || busy) return;
    if (trimmed === props.title) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    props
      .onRename(trimmed)
      .then(() => {
        setEditing(false);
      })
      .catch((err: unknown) => {
        setError(w.failed({ error: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const heading =
    'm-0 min-w-0 text-[1.125rem] leading-[1.25] font-extrabold tracking-[-0.015em] text-balance [overflow-wrap:anywhere] sm:text-[1.375rem]';
  if (!editing) {
    return (
      <div className="flex min-w-0 flex-[1_1_100%] items-start gap-1.5 sm:flex-[1_1_300px]">
        <h1 className={heading} data-testid="dy-job-title">
          {props.title}
        </h1>
        {props.onRename === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
            }}
            aria-label={w.edit}
            title={w.edit}
            data-testid="dy-job-title-edit"
            className="dy-press mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
          >
            <DyIcon name="pen" className="size-4" />
          </button>
        )}
      </div>
    );
  }
  const hintId = 'dy-job-title-hint';
  return (
    <form
      className="grid min-w-0 flex-[1_1_100%] gap-1 sm:flex-[1_1_300px]"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      data-testid="dy-job-title-form"
    >
      <label htmlFor="dy-job-title-input" className="sr-only">
        {w.label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <input
          id="dy-job-title-input"
          ref={input}
          value={value}
          maxLength={120}
          disabled={busy}
          aria-invalid={invalid !== null ? true : undefined}
          aria-describedby={hintId}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
              setError(null);
            }
          }}
          className="h-10 min-w-0 flex-[1_1_220px] rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[1rem] font-bold text-dy-ink outline-none focus-visible:border-dy-ink"
        />
        <button
          type="submit"
          disabled={busy || invalid !== null}
          className="dy-press inline-flex h-10 items-center rounded-[9px] border border-dy-ink bg-dy-ink px-3 text-sm font-medium text-dy-card disabled:opacity-50"
        >
          {busy ? w.saving : w.save}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className="dy-press inline-flex h-10 items-center rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-sm font-medium text-dy-ink"
        >
          {w.cancel}
        </button>
      </div>
      <p
        id={hintId}
        className={cx(
          'm-0 text-[0.8125rem]',
          invalid !== null || error !== null ? 'text-dy-red-ink' : 'text-dy-muted',
        )}
        role={error !== null ? 'alert' : undefined}
      >
        {error ?? invalid ?? w.hint}
      </p>
    </form>
  );
}

export function JobHeader(props: {
  readonly detail: JobDetail;
  readonly state: string;
  readonly title: string;
  /** p15-job-titles: renames the job (absent: the viewer may not). */
  readonly onRename?: ((title: string) => Promise<void>) | undefined;
  readonly stale: boolean;
  /** An approval of this job is pending. */
  readonly waiting: boolean;
  readonly names: ReadonlyMap<string, string>;
  readonly now: number;
  readonly cost: string | null;
  readonly checkpoint: { readonly n: number; readonly at: string } | null;
  readonly memoryItems: number | null;
  /** "Ayrıntılar" is open (the classic panels replace the thread). */
  readonly detailsOpen: boolean;
  readonly onDetails: () => void;
  readonly menu: readonly MenuItem[];
  /** p12-diyalog panels: the one action that fits the state (classic header primary), left of "Ayrıntılar". */
  readonly primary?: ReactNode;
  /** p12-diyalog panels: the step progress bar, under the facts. */
  readonly steps?: ReactNode;
}): ReactNode {
  const { detail: d, state } = props;
  const j = d.job;
  const t = useT();
  const f = useFormat();
  const w = t.job.header;
  // p19-verifier-jobs: a platform verifier shows the checked job's verification outcome, not its own FAILED.
  const pill = platformPill(j.platform, t) ?? jobStatePill(state, props.stale, props.waiting, t);
  const runtime = typeof j.spec.runtime === 'string' ? j.spec.runtime : null;
  const model =
    d.scheduling?.runtimeChoice?.model ?? (typeof j.spec.model === 'string' ? j.spec.model : null);
  const workerId = d.attempts.at(-1)?.workerId ?? null;
  const cls = typeof j.priority === 'number' ? PRIORITY_CLASS_LABEL[priorityClassOf(j.priority)] : null;
  const ago = (iso: string): string => relativeText(iso, props.now, f);
  const stateChanges = useChangeCount(pill.label);
  return (
    <div className="border-b border-dy-line bg-dy-bg px-3 py-3 sm:px-6 sm:py-4" data-testid="dy-job-header">
      <div className="mx-auto grid w-full max-w-[1440px] gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <JobTitleHeading title={props.title} onRename={props.onRename} />
          {/* p17-panel-motion: a state change (Kuyrukta → Çalışıyor → Bitti) cross-fades the chip in. */}
          <span
            key={stateChanges}
            data-testid="dy-job-state"
            data-state={state}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-[7px] text-[0.8125rem] font-bold whitespace-nowrap',
              SOFT[pill.tone],
              stateChanges > 0 && 'dy-m-swap',
            )}
          >
            <DyIcon name={pill.icon} className={cx('size-3.5', pill.tone === 'teal' && 'dy-breathe')} />
            {pill.label}
          </span>
          {j.platform === null || j.platform === undefined ? null : (
            <PlatformBadge platform={j.platform} showChecked />
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5 max-sm:ml-0">
            {props.primary ?? null}
            <button
              type="button"
              aria-pressed={props.detailsOpen}
              onClick={props.onDetails}
              className={cx(
                'dy-press inline-flex h-9 items-center gap-1.5 rounded-[9px] border px-3 text-sm font-medium whitespace-nowrap',
                props.detailsOpen
                  ? 'border-dy-ink bg-dy-ink text-dy-card'
                  : 'border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink',
              )}
            >
              <DyIcon name={props.detailsOpen ? 'grid' : 'file'} />
              {props.detailsOpen ? w.backToPanel : w.details}
            </button>
            <HeaderMenu items={props.menu} />
          </span>
        </div>
        {/* p12-diyalog-default (visual tour): from 640 to 1023 px the facts wrap to a second line once the checkpoint
            and memory reads land; the two lines are reserved so the steps and the panel below do not jump. */}
        <div
          className="dy-noscrollbar dy-scroll-fade -mx-3 flex items-center gap-x-4 gap-y-1.5 overflow-x-auto px-3 text-[0.8125rem] whitespace-nowrap text-dy-muted sm:mx-0 sm:flex-wrap sm:content-start sm:overflow-visible sm:px-0 sm:whitespace-normal sm:max-lg:min-h-[2.875rem]"
          data-testid="dy-job-facts"
        >
          <span className="font-dy-mono" translate="no" title={j.id}>{`J-${j.id.slice(0, 8)}`}</span>
          <span>
            {j.project}
            {j.projectKind === 'workspace' ? w.workspace : ''}
            {cls === null ? '' : `, ${cls}`}
          </span>
          {runtime === null ? null : (
            <span className="inline-flex items-center">
              <RuntimeMark runtime={runtime} />
              {model === null ? null : <span className="whitespace-pre">{`, ${model}`}</span>}
            </span>
          )}
          {d.runtimeAccount === undefined || d.runtimeAccount === null ? null : (
            <span className="inline-flex items-center gap-1.5" data-testid="dy-job-account">
              <DyIcon name="key" className="size-3.5" />
              {w.account({ label: d.runtimeAccount.label })}
            </span>
          )}
          {d.accountPin === undefined || d.accountPin === null ? null : (
            <span className="inline-flex items-center gap-1.5" data-testid="dy-job-account-pin">
              {w.accountPin({ label: d.accountPin.label })}
            </span>
          )}
          {workerId === null ? null : (
            <Link
              to={machineHref(workerId)}
              className="inline-flex items-center gap-1.5 text-inherit no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              <DyIcon name="cpu" className="size-3.5" />
              <span className="font-dy-mono" translate="no">
                {props.names.get(workerId) ?? workerId}
              </span>
            </Link>
          )}
          {props.checkpoint === null ? null : (
            <span className="inline-flex items-center gap-1.5">
              <DyIcon name="flag" className="size-3.5" />
              {w.checkpoint({ n: props.checkpoint.n, ago: ago(props.checkpoint.at) })}
            </span>
          )}
          {props.memoryItems === null || props.memoryItems === 0 ? null : (
            <span className="inline-flex items-center gap-1.5">
              <DyIcon name="brain" className="size-3.5" />
              {w.memory({ n: props.memoryItems })}
            </span>
          )}
          <span className="tabular-nums">{formatSpan(jobDurationMs({ ...j, state }, props.now))}</span>
          {d.pausedMs > 0 ? (
            <span className="tabular-nums">{w.paused({ span: formatSpan(d.pausedMs) })}</span>
          ) : null}
          {props.cost === null ? null : <span className="tabular-nums">{props.cost}</span>}
        </div>
        {props.steps === undefined ? null : <div className="mt-2.5">{props.steps}</div>}
      </div>
    </div>
  );
}
