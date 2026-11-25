import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Messages } from '@remyral/i18n';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { Markdown } from '../../screens/chat/markdown';
import { DyIcon } from '../icons';
import { runtimeCode } from '../RuntimeMark';
import { ToolRow } from '../ToolRow';
import { counts, FILTERS, type LogFilter, type LogRow, logTime, matches } from './log';
import { toolArgs, toolStatus } from './mapping';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DeliveryStatus } from './delivery';
import { followAfterScroll, watchScrollIntent } from '../../lib/scrollIntent';
import { arrivalStyle, useArrivals } from '../motionKit';

/**
 * p12-diyalog panels: "Akış günlüğü" — the job's activity log in the control panel's main column. A compact,
 * chronological list (time · icon · one line) in its own scroll box: filter chips (Hepsi / Ajan / Araçlar / Sistem /
 * Hatalar, with counts), a search field, "Canlı takip" (stick to the newest row; scrolling up turns it off) and
 * "Şimdiye atla" with the count of rows that arrived meanwhile. Long logs render the newest 400 matching rows with
 * "Daha eski satırlar". `role="log"`: new rows are announced politely.
 */

const WINDOW = 400;

const WHO_INK: Readonly<Record<string, string>> = {
  cc: 'text-dy-cc',
  cx: 'text-dy-cx',
  pi: 'text-dy-pi',
  oc: 'text-dy-oc',
};

function TextRow(props: {
  readonly row: LogRow & { kind: 'text' };
  readonly runtime: string | null;
  readonly onResend?: ((text: string) => void) | undefined;
}): ReactNode {
  const { row } = props;
  const w = useT().job.log;
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const code = row.who === 'agent' ? runtimeCode(props.runtime ?? '') : null;
  const iconInk = row.error
    ? 'text-dy-red-ink'
    : row.who === 'agent'
      ? code === null
        ? 'text-dy-teal-ink'
        : WHO_INK[code]
      : row.who === 'me'
        ? 'text-dy-ink'
        : 'text-dy-muted';
  return (
    <>
      <DyIcon name={row.icon} className={cx('mt-[3px] size-4 shrink-0', iconInk)} />
      <div className="min-w-0">
        <p
          className={cx(
            'm-0 [overflow-wrap:anywhere]',
            row.error ? 'text-dy-red-ink' : row.who === 'system' ? 'text-dy-muted' : 'text-dy-ink',
            row.pending === true && 'opacity-70',
          )}
          data-testid={row.who === 'agent' ? 'dy-agent-text' : undefined}
        >
          {row.text}
          {row.delivery !== undefined ? (
            <DeliveryStatus d={row.delivery} onResend={props.onResend} />
          ) : row.pending === true ? (
            <span className="ml-1.5 text-[0.75rem] text-dy-muted">{w.pendingSent}</span>
          ) : null}
          {row.body === null ? null : (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => {
                setOpen((v) => !v);
              }}
              className="dy-press ml-1.5 inline-flex items-center gap-0.5 rounded px-1 text-[0.78125rem] font-medium text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
            >
              {open ? w.less : w.more}
              <DyIcon
                name="chev"
                className={cx('size-3 transition-transform duration-150 ease-dy', open && 'rotate-180')}
              />
            </button>
          )}
        </p>
        {row.body === null ? null : (
          <div
            id={bodyId}
            hidden={!open}
            className="mt-1.5 mb-1 rounded-[10px] bg-dy-sunk px-3 py-2 text-[0.875rem] [overflow-wrap:anywhere]"
          >
            {open ? (
              row.markdown ? (
                <Markdown text={row.body} />
              ) : (
                <pre className="m-0 font-dy-mono text-[0.78125rem] leading-[1.55] whitespace-pre-wrap">
                  {row.body}
                </pre>
              )
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

/** p14-ask-user: the inline "Cevap yaz" under the agent's last line when it ended its turn with a question. */
export interface InlineReply {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly onReply: () => void;
}

/** The key of the last agent text row when it reads as a question (a '?' in its last 200 characters). */
export function lastQuestionKey(rows: readonly LogRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r === undefined || r.kind !== 'text') continue;
    if (r.who === 'me') return null;
    if (r.who !== 'agent') continue;
    const text = (r.body ?? r.text).trimEnd();
    return text.slice(-200).includes('?') ? r.key : null;
  }
  return null;
}

function Row(props: {
  readonly row: LogRow;
  readonly runtime: string | null;
  readonly logsHref: string;
  readonly onApproval: (requestId: string) => void;
  readonly reply?: InlineReply | null | undefined;
  /** p15-message-delivery: "Tekrar yaz" on a message that did not reach the agent. */
  readonly onResend?: ((text: string) => void) | undefined;
  /** p17-panel-motion: the row arrived while the log was open — its place in the burst (stagger), else undefined. */
  readonly arrived?: number | undefined;
}): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.job.log;
  const { row } = props;
  let body: ReactNode;
  if (row.kind === 'tool') {
    const st = toolStatus(row.call, t);
    body = (
      <div className="col-span-2 -mx-2.5 -my-1 min-w-0">
        <ToolRow
          op={row.call.name}
          args={toolArgs(row.call.input)}
          status={st.text}
          tone={st.tone}
          input={row.call.input}
          output={row.call.result?.output}
          logsHref={props.logsHref}
        />
      </div>
    );
  } else if (row.kind === 'approval') {
    const pending = row.status === 'pending' || row.status === null;
    body = (
      <>
        <DyIcon
          name="shield"
          className={cx(
            'mt-[3px] size-4 shrink-0',
            pending ? 'text-dy-amber-ink' : row.error ? 'text-dy-red-ink' : 'text-dy-muted',
          )}
        />
        <p className="m-0 min-w-0 text-dy-muted [overflow-wrap:anywhere]">
          {row.text}
          {row.status === null ? null : (
            <span
              className={cx(
                'ml-1.5 font-medium',
                pending ? 'text-dy-amber-ink' : row.error ? 'text-dy-red-ink' : 'text-dy-ink',
              )}
            >
              {pending ? w.waiting : (approvalStatus(row.status, w) ?? row.status)}
            </span>
          )}
          {pending && row.requestId !== null ? (
            <button
              type="button"
              onClick={() => {
                props.onApproval(row.requestId ?? '');
              }}
              className="dy-press ml-1.5 rounded px-1 text-[0.78125rem] font-medium text-dy-amber-ink underline-offset-2 hover:underline"
            >
              {w.goDecision}
            </button>
          ) : null}
        </p>
      </>
    );
  } else
    body = (
      <>
        <TextRow row={row} runtime={props.runtime} onResend={props.onResend} />
        {props.reply?.key === row.key ? (
          <div className="col-start-3 mt-1 flex flex-wrap items-center gap-2" data-testid="inline-reply">
            <button
              type="button"
              onClick={props.reply.onReply}
              className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] border border-dy-teal px-3 text-[0.8125rem] font-bold text-dy-teal-ink sm:min-h-8"
            >
              <DyIcon name="send" className="size-3.5" />
              {props.reply.label}
            </button>
            <span className="text-[0.75rem] text-dy-muted">{props.reply.hint}</span>
          </div>
        ) : null}
      </>
    );
  return (
    <li
      data-key={row.key}
      data-group={row.group}
      data-error={row.error ? '' : undefined}
      data-arrived={props.arrived === undefined ? undefined : ''}
      style={arrivalStyle(props.arrived)}
      className={cx(
        'grid grid-cols-[4.25rem_1rem_minmax(0,1fr)] items-start gap-x-2.5 px-3 py-[5px] text-[0.875rem] leading-[1.5] sm:px-4 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60',
        props.arrived !== undefined && 'dy-m-line',
      )}
    >
      <time dateTime={row.at} className="pt-px font-dy-mono text-[0.75rem] text-dy-faint tabular-nums">
        {logTime(row.at, fmt)}
      </time>
      {body}
    </li>
  );
}

function approvalStatus(status: string, w: Messages['job']['log']): string | null {
  return Object.hasOwn(w.approvalStatus, status)
    ? w.approvalStatus[status as keyof Messages['job']['log']['approvalStatus']]
    : null;
}

export function ActivityLog(props: {
  readonly rows: readonly LogRow[];
  readonly runtime: string | null;
  /** What happens right now ("Claude Code çalışıyor"), or null. */
  readonly now: string | null;
  /** Older events were not loaded into the stream (the full log is in Ayrıntılar › Loglar). */
  readonly partial: boolean;
  readonly logsHref: string;
  readonly onApproval: (requestId: string) => void;
  /** Live stream problem line. */
  readonly warning?: ReactNode;
  /** Under the log: the composer / the job's actions. */
  readonly footer?: ReactNode;
  /** p14-ask-user: "Cevap yaz" under the agent's trailing question (null: none). */
  readonly reply?: InlineReply | null | undefined;
  /** p15-message-delivery: "Tekrar yaz" on a message that did not reach the agent. */
  readonly onResend?: ((text: string) => void) | undefined;
}): ReactNode {
  const { rows } = props;
  const w = useT().job.log;
  const [filter, setFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [limit, setLimit] = useState(WINDOW);
  const [fresh, setFresh] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const known = useRef<number | null>(null);
  const headingId = useId();

  const n = useMemo(() => counts(rows), [rows]);
  // p17-panel-motion: lines that arrive while the log is open slide in (keys of every row, so a filter or a search never
  // counts as an arrival; the history present at first, a backlog burst and older pages stand still).
  const keys = useMemo(() => rows.map((r) => r.key), [rows]);
  const arrivals = useArrivals(keys);
  const shown = useMemo(() => rows.filter((r) => matches(r, filter, query)), [rows, filter, query]);
  const hidden = Math.max(0, shown.length - limit);
  const visible = hidden === 0 ? shown : shown.slice(hidden);

  const toEnd = useCallback(() => {
    const el = boxRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, []);

  // Follow: keep the newest row in view; otherwise count what arrived.
  useLayoutEffect(() => {
    const before = known.current;
    known.current = rows.length;
    if (follow) {
      toEnd();
      return;
    }
    if (before !== null && rows.length > before) setFresh((f) => f + rows.length - before);
  }, [rows.length, follow, toEnd]);
  useLayoutEffect(() => {
    if (follow) toEnd();
  }, [filter, query, follow, toEnd]);

  // p15-chat-cards-scroll item 3: the reader scrolling up (their own wheel / touch / keys / scrollbar) stops following at
  // once, even a few pixels from the end; scrolling back to the end follows again (and clears "n yeni").
  useEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    let raf = 0;
    let lastTop = el.scrollTop;
    const intent = watchScrollIntent(el, () => {
      setFollow(false);
    });
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = el.scrollTop;
        const prev = lastTop;
        lastTop = top;
        const at = { top, lastTop: prev, distanceToEnd: el.scrollHeight - top - el.clientHeight };
        const userInput = intent.recent();
        if (followAfterScroll({ following: false, ...at, userInput })) setFresh(0);
        setFollow((f) => followAfterScroll({ following: f, ...at, userInput }));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      intent.dispose();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  const jump = (): void => {
    setFresh(0);
    setFollow(true);
    toEnd();
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="dy-job-log"
      className="flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy"
    >
      <div className="grid gap-2.5 border-b border-dy-line px-3 pt-3 pb-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2
            id={headingId}
            className="m-0 flex items-baseline gap-2 text-[1rem] font-bold tracking-[-0.01em]"
          >
            {w.title}
            <span className="font-dy-mono text-[0.78125rem] font-medium text-dy-muted tabular-nums">
              {shown.length === rows.length
                ? String(rows.length)
                : `${String(shown.length)}/${String(rows.length)}`}
            </span>
          </h2>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => {
                if (follow) setFollow(false);
                else jump();
              }}
              data-testid="dy-log-follow"
              className={cx(
                'dy-press inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[0.8125rem] font-medium',
                follow
                  ? 'border-dy-teal bg-dy-teal-soft text-dy-teal-ink'
                  : 'border-dy-line-2 bg-dy-card text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
              )}
            >
              <span
                aria-hidden="true"
                className={cx('size-1.5 rounded-full', follow ? 'dy-breathe bg-dy-teal' : 'bg-dy-line-2')}
              />
              {w.follow}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={w.filterGroup}
            className="dy-noscrollbar dy-scroll-fade flex max-w-full gap-1 overflow-x-auto"
          >
            {FILTERS.map((id) => {
              const on = filter === id;
              const count = n[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setFilter(id);
                    setLimit(WINDOW);
                  }}
                  className={cx(
                    'dy-press inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[0.8125rem] whitespace-nowrap',
                    on
                      ? 'border-dy-ink bg-dy-ink font-bold text-dy-card'
                      : 'border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink',
                  )}
                >
                  {w.filters[id]}
                  <span
                    className={cx(
                      'font-dy-mono text-[0.75rem] tabular-nums',
                      on
                        ? 'text-dy-card/75'
                        : id === 'errors' && count > 0
                          ? 'text-dy-red-ink'
                          : 'text-dy-muted',
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <label className="relative ml-auto min-w-0 flex-[1_1_180px] sm:max-w-[260px]">
            <span className="sr-only">{w.search}</span>
            <DyIcon
              name="search"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-dy-faint"
            />
            <input
              type="search"
              value={query}
              maxLength={128}
              placeholder={w.search}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(WINDOW);
              }}
              className="min-h-9 w-full rounded-[9px] border border-dy-line-2 bg-dy-card pr-2.5 pl-8 text-[0.9375rem] text-dy-ink placeholder:text-dy-faint sm:min-h-8 sm:text-[0.84375rem]"
            />
          </label>
        </div>
      </div>
      {props.warning ?? null}
      <div
        ref={boxRef}
        className="relative max-h-[62dvh] min-h-[220px] overflow-y-auto overscroll-contain py-1.5 lg:max-h-[calc(100dvh-17rem)] lg:min-h-[420px]"
        data-testid="dy-log-box"
      >
        {props.partial ? (
          <p className="m-0 px-4 py-1 text-[0.8125rem] text-dy-muted">
            <Link to={props.logsHref} className="text-inherit underline underline-offset-2">
              {w.partial}
            </Link>
          </p>
        ) : null}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => {
              setLimit((l) => l + WINDOW);
            }}
            className="dy-press mx-4 my-1 text-[0.8125rem] font-medium text-dy-teal-ink underline-offset-2 hover:underline"
          >
            {w.older({ n: hidden })}
          </button>
        ) : null}
        <ol
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={w.title}
          className="m-0 list-none p-0"
        >
          {visible.map((r) => (
            <Row
              key={r.key}
              row={r}
              runtime={props.runtime}
              logsHref={props.logsHref}
              onApproval={props.onApproval}
              reply={props.reply}
              onResend={props.onResend}
              arrived={arrivals.get(r.key)}
            />
          ))}
        </ol>
        {visible.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-[0.875rem] text-dy-muted">
            {rows.length === 0 ? w.empty : w.noMatch}
          </p>
        ) : null}
        {props.now === null ? null : (
          <p
            role="status"
            data-testid="dy-job-now"
            className="m-0 flex items-center gap-2.5 px-3 pt-1.5 pb-1 text-[0.84375rem] text-dy-muted sm:px-4"
          >
            <span className="inline-flex w-[4.25rem] gap-1" aria-hidden="true">
              <i className="dy-breathe size-1.5 rounded-full bg-dy-teal" />
              <i className="dy-breathe size-1.5 rounded-full bg-dy-teal [animation-delay:150ms]" />
              <i className="dy-breathe size-1.5 rounded-full bg-dy-teal [animation-delay:300ms]" />
            </span>
            {props.now}
          </p>
        )}
        {follow ? null : (
          <div className="pointer-events-none sticky bottom-2 flex justify-center">
            <button
              type="button"
              onClick={jump}
              data-testid="dy-now-pill"
              className="dy-pill dy-press pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-dy-ink px-3.5 py-1.5 text-[0.8125rem] font-bold text-dy-card shadow-dy-pop"
            >
              <DyIcon name="chev" className="size-3.5" />
              {fresh > 0 ? w.jumpNew({ n: fresh }) : w.jump}
            </button>
          </div>
        )}
      </div>
      {props.footer === undefined ? null : (
        <div className="border-t border-dy-line bg-dy-sunk px-3 py-3 sm:px-4">{props.footer}</div>
      )}
    </section>
  );
}
