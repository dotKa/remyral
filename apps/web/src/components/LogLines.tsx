import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment } from '../lib/ansi';
import { cx } from './ui';
import { type ScrollIntent, watchScrollIntent } from '../lib/scrollIntent';

/**
 * p6-logs-ui (docs/design/p6-logs-ui.md): the shared, virtualized log line list of the job Logs tab and the
 * worker-log viewer (Operations → Activity). Each row has a gutter (line number, timestamp, stream / level
 * badge) and the line's text segments. Text is only ever rendered as React text nodes — segments come from
 * the strict SGR-only ANSI parser (job logs) or are plain text (worker logs); the classes on segments are the
 * parser's own fixed class list, never taken from the output (T-INJ-4).
 *
 * Only the rows in the viewport (plus overscan) are in the DOM. Without wrapping every row is exactly
 * {@link ROW_HEIGHT} px (separators {@link SEPARATOR_HEIGHT}); with wrapping, heights are estimated from the
 * monospace character width and the rows are laid out in flow between two spacers, so a wrong estimate only
 * shifts the scroll position slightly — it never overlaps rows. The scroll area keeps the default
 * `overscroll-behavior`, so a wheel at its top/bottom edge continues to scroll the page.
 */

/** Fixed row height (px) without wrapping; matches the `h-5` row class. */
export const ROW_HEIGHT = 20;
/** Attempt separator height (px); matches `h-7`. */
export const SEPARATOR_HEIGHT = 28;
const OVERSCAN = 30;
const FALLBACK_VIEWPORT = 480;
const FALLBACK_CHAR_PX = 7.5;

export type BadgeTone = 'default' | 'danger' | 'warn' | 'accent' | 'muted';

export interface LogRow {
  readonly kind: 'line';
  readonly key: number | string;
  /** 1-based line number in this view. */
  readonly no: number;
  /** Epoch ms of the line (null: unknown). */
  readonly tsMs: number | null;
  /** Epoch ms the elapsed time is counted from (start of the attempt / of the log). */
  readonly startMs: number | null;
  readonly badge: { readonly label: string; readonly tone: BadgeTone; readonly title: string } | null;
  /** `danger`: tinted row (stderr, error level); `warn`: warning level. */
  readonly tone: 'default' | 'danger' | 'warn';
  readonly segments: readonly Segment[];
  /** Exposed as `data-stream` (job logs) for tests and styling. */
  readonly stream?: string;
}

export interface SeparatorRow {
  readonly kind: 'separator';
  readonly key: number | string;
  readonly label: string;
  readonly tsMs: number | null;
}

export type DisplayRow = LogRow | SeparatorRow;

// ------------------------------------------------------------------------------------- timestamps

export type TimestampMode = 'clock' | 'elapsed';
export interface TimestampPref {
  readonly show: boolean;
  readonly mode: TimestampMode;
}

export const TIMESTAMP_PREF_KEY = 'remyral.logs.timestamps';
const DEFAULT_PREF: TimestampPref = { show: true, mode: 'clock' };

/** The viewer's remembered timestamp setting; storage can be missing or throw (private mode): defaults. */
export function readTimestampPref(): TimestampPref {
  try {
    const raw = window.localStorage.getItem(TIMESTAMP_PREF_KEY);
    if (raw === null) return DEFAULT_PREF;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return DEFAULT_PREF;
    const o = v as Record<string, unknown>;
    return {
      show: typeof o.show === 'boolean' ? o.show : DEFAULT_PREF.show,
      mode: o.mode === 'elapsed' ? 'elapsed' : 'clock',
    };
  } catch {
    return DEFAULT_PREF;
  }
}

function writeTimestampPref(p: TimestampPref): void {
  try {
    window.localStorage.setItem(TIMESTAMP_PREF_KEY, JSON.stringify(p));
  } catch {
    // Not remembered (storage blocked); the setting still applies to this page.
  }
}

export function useTimestampPref(): [TimestampPref, (p: TimestampPref) => void] {
  const [pref, setPref] = useState<TimestampPref>(readTimestampPref);
  const update = useCallback((p: TimestampPref) => {
    setPref(p);
    writeTimestampPref(p);
  }, []);
  return [pref, update];
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Local wall-clock time `HH:MM:SS.mmm`. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Elapsed time `+12.3s`, `+4m05s`, `+1h02m` (negative values, e.g. clock skew between chunks, clamp to 0). */
export function formatElapsed(deltaMs: number): string {
  const ms = Math.max(0, deltaMs);
  if (ms < 60_000) return `+${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `+${String(Math.floor(s / 60))}m${pad(s % 60)}s`;
  return `+${String(Math.floor(s / 3600))}h${pad(Math.floor(s / 60) % 60)}m`;
}

/** Full local date-time and UTC, for a timestamp's tooltip. */
export function timestampTitle(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })} · ${d.toISOString()}`;
}

export function parseTs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ------------------------------------------------------------------------------------- rows

const BADGE: Readonly<Record<BadgeTone, string>> = {
  default: 'text-muted',
  muted: 'text-muted opacity-70',
  danger: 'bg-danger-soft text-danger',
  warn: 'bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent',
};

interface Gutter {
  readonly numbers: boolean;
  readonly digits: number;
  readonly ts: TimestampPref | null;
  readonly badge: boolean;
}

/** Width of the gutter in `ch` (keep in step with the classes below). */
function gutterCh(g: Gutter): number {
  let ch = 0;
  if (g.numbers) ch += g.digits + 1;
  if (g.ts?.show === true) ch += (g.ts.mode === 'clock' ? 12 : 7) + 1;
  if (g.badge) ch += 4;
  return ch === 0 ? 0 : ch + 2;
}

function textLength(segments: readonly Segment[]): number {
  let n = 0;
  for (const s of segments) n += s.text.length + (s.text.includes('\t') ? s.text.split('\t').length * 7 : 0);
  return n;
}

function LineRow(props: {
  readonly row: LogRow;
  readonly gutter: Gutter | null;
  readonly wrap: boolean;
  readonly terminal: boolean;
}): ReactNode {
  const { row: r, gutter: g, wrap, terminal } = props;
  const ts = g?.ts?.show === true ? g.ts : null;
  return (
    <div
      className={cx(
        'flex',
        wrap ? 'min-h-5' : 'h-5',
        !terminal && r.tone === 'danger' && 'bg-danger-soft/70',
        !terminal && r.tone === 'warn' && 'bg-warn-soft/70',
      )}
      data-testid="log-line"
      data-stream={r.stream}
    >
      {g !== null ? (
        <span
          className={cx(
            'sticky left-0 flex shrink-0 items-start gap-[1ch] border-r pr-[1ch] pl-[1ch] tabular-nums select-none',
            terminal ? 'border-white/10 bg-[#0b0e14] text-[#8b95a3]' : 'border-line bg-surface-2 text-muted',
          )}
        >
          {g.numbers ? (
            <span
              data-testid="log-no"
              className="text-right opacity-70"
              style={{ width: `${String(g.digits)}ch` }}
            >
              {r.no}
            </span>
          ) : null}
          {ts !== null ? (
            r.tsMs === null ? (
              <span data-testid="log-ts" style={{ width: ts.mode === 'clock' ? '12ch' : '7ch' }} />
            ) : (
              <time
                data-testid="log-ts"
                dateTime={new Date(r.tsMs).toISOString()}
                title={timestampTitle(r.tsMs)}
                className="text-right"
                style={{ width: ts.mode === 'clock' ? '12ch' : '7ch' }}
              >
                {ts.mode === 'clock' ? formatClock(r.tsMs) : formatElapsed(r.tsMs - (r.startMs ?? r.tsMs))}
              </time>
            )
          ) : null}
          {g.badge ? (
            r.badge === null ? (
              <span className="w-[3ch]" />
            ) : (
              <span
                data-testid="log-stream"
                title={r.badge.title}
                className={cx(
                  'my-0.5 w-[3ch] rounded-sm text-center text-[10px] leading-4 font-semibold',
                  BADGE[r.badge.tone],
                )}
              >
                {r.badge.label}
              </span>
            )
          ) : null}
        </span>
      ) : null}
      <span
        data-testid="log-text"
        className={cx(
          'pr-3 pl-[1ch]',
          wrap ? 'min-w-0 flex-1 break-all whitespace-pre-wrap' : 'whitespace-pre',
        )}
      >
        {r.segments.map((s, i) =>
          s.cls === '' ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

function Separator(props: { readonly row: SeparatorRow; readonly terminal: boolean }): ReactNode {
  const r = props.row;
  return (
    <div role="separator" data-testid="log-attempt" className="flex h-7 items-center" aria-label={r.label}>
      <span
        className={cx(
          'sticky left-0 inline-flex items-center gap-2 px-[1ch] text-[11px] font-semibold tracking-wide uppercase',
          props.terminal ? 'bg-[#0b0e14] text-[#8b95a3]' : 'bg-surface-2 text-muted',
        )}
      >
        {r.label}
        {r.tsMs !== null ? (
          <time
            dateTime={new Date(r.tsMs).toISOString()}
            title={timestampTitle(r.tsMs)}
            className="font-normal tracking-normal normal-case"
          >
            {formatClock(r.tsMs)}
          </time>
        ) : null}
      </span>
      <span className={cx('h-px min-w-8 flex-1', props.terminal ? 'bg-white/15' : 'bg-line-strong')} />
    </div>
  );
}

/** Index of the last offset ≤ y (offsets ascending, offsets[0] = 0). */
function indexAt(offsets: readonly number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function VirtualLines(props: {
  readonly rows: readonly DisplayRow[];
  readonly follow: boolean;
  readonly onFollowChange: (follow: boolean) => void;
  readonly label: string;
  readonly wrap: boolean;
  /** Line numbers, timestamps and badges; null: none (terminal view). */
  readonly gutter: {
    readonly numbers: boolean;
    readonly ts: TimestampPref | null;
    readonly badge: boolean;
  } | null;
  readonly terminal?: boolean;
  /** Height classes of the scroll area. */
  readonly className?: string;
  readonly testId?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ h: FALLBACK_VIEWPORT, w: 0, ch: FALLBACK_CHAR_PX });
  const { rows, follow, wrap } = props;
  const terminal = props.terminal === true;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      const chPx = (probe.current?.getBoundingClientRect().width ?? 0) / 10;
      setSize({
        h: el.clientHeight > 0 ? el.clientHeight : FALLBACK_VIEWPORT,
        w: el.clientWidth,
        ch: chPx > 0 ? chPx : FALLBACK_CHAR_PX,
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const lineCount = useMemo(() => rows.reduce((n, r) => (r.kind === 'line' ? n + 1 : n), 0), [rows]);
  const gutter: Gutter | null =
    props.gutter === null ? null : { ...props.gutter, digits: Math.max(2, String(lineCount).length) };
  const gutterWidth = gutter === null ? 0 : gutterCh(gutter);

  // Prefix offsets (px) of every row; exact without wrapping, estimated with it.
  const offsets = useMemo(() => {
    const cols = Math.max(20, Math.floor((size.w > 0 ? size.w : 800) / size.ch) - gutterWidth - 4);
    const out = new Array<number>(rows.length + 1);
    out[0] = 0;
    let y = 0;
    rows.forEach((r, i) => {
      if (r.kind === 'separator') y += SEPARATOR_HEIGHT;
      else y += wrap ? Math.max(1, Math.ceil(textLength(r.segments) / cols)) * ROW_HEIGHT : ROW_HEIGHT;
      out[i + 1] = y;
    });
    return out;
  }, [rows, wrap, size.w, size.ch, gutterWidth]);
  const total = offsets[rows.length] ?? 0;

  useEffect(() => {
    const el = ref.current;
    if (!follow || el === null) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [follow, rows, wrap]);

  // p15-chat-cards-scroll item 3: the reader's own upward scroll (or a wheel turned up) stops following at once, even
  // inside the last two rows; back at the end it follows again.
  const followRef = useRef(follow);
  followRef.current = follow;
  const onFollowRef = useRef(props.onFollowChange);
  onFollowRef.current = props.onFollowChange;
  const intent = useRef<ScrollIntent | null>(null);
  const lastTop = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const i = watchScrollIntent(el, () => {
      if (followRef.current) onFollowRef.current(false);
    });
    intent.current = i;
    return () => {
      i.dispose();
      intent.current = null;
    };
  }, []);

  const start = Math.max(0, indexAt(offsets, scrollTop) - OVERSCAN);
  const end = Math.min(rows.length, indexAt(offsets, scrollTop + size.h) + 1 + OVERSCAN);
  const visible = rows.slice(start, end);

  return (
    <div
      ref={ref}
      role="log"
      aria-label={props.label}
      aria-live="off"
      tabIndex={0}
      className={cx(
        'relative overflow-auto font-mono text-xs leading-5 sm:text-[12.5px]',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        terminal ? 'live-term' : 'bg-surface-2 text-fg',
        props.className ?? 'h-[60vh] max-h-[640px] min-h-64',
      )}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        const prev = lastTop.current;
        lastTop.current = el.scrollTop;
        const readerUp = intent.current?.recent() === true && el.scrollTop < prev - 1;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 2;
        if (follow && (!atBottom || readerUp)) props.onFollowChange(false);
        else if (!follow && atBottom && !readerUp && el.scrollTop > 0) props.onFollowChange(true);
      }}
      data-testid={props.testId ?? 'log-viewport'}
    >
      <span ref={probe} aria-hidden="true" className="invisible absolute top-0 left-0 whitespace-pre">
        0000000000
      </span>
      <div
        className={wrap ? 'min-w-full' : 'w-max min-w-full'}
        style={{ paddingTop: offsets[start] ?? 0, paddingBottom: total - (offsets[end] ?? total) }}
      >
        {visible.map((r) =>
          r.kind === 'separator' ? (
            <Separator key={r.key} row={r} terminal={terminal} />
          ) : (
            <LineRow key={r.key} row={r} gutter={gutter} wrap={wrap} terminal={terminal} />
          ),
        )}
      </div>
    </div>
  );
}
