import { type ReactNode, useState } from 'react';
import {
  type DisplayRow,
  type TimestampPref,
  useTimestampPref,
  VirtualLines,
} from '../../components/LogLines';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyCopyButton } from './actions';
import { Segmented, Toggle } from './controls';

/**
 * p12-diyalog-final: the log viewer of the Diyalog UI — one native wrapper around the shared virtualized line engine
 * (`VirtualLines`: only the rows in view are in the DOM, follow-to-bottom, measured wrapping), used by the job's
 * Loglar tab and the machine's worker log. The engine draws the rows; this wrapper gives it the Diyalog tokens
 * (`.dy-log`, diyalog.css) and the Diyalog toolbar: follow, wrap, time on / off with wall-clock ("Saat") or elapsed
 * ("Geçen") — remembered in this browser (`remyral.logs.timestamps`, shared with the classic viewer) — copy (text built
 * on click) and the line count. Text is rendered as text (the engine's strict SGR-only ANSI parser).
 */

/** The engine in the Diyalog tokens (line-number gutter, timestamps, stream badges; terminal colours kept). */
export function DyLogViewport(props: {
  readonly rows: readonly DisplayRow[];
  readonly follow: boolean;
  readonly onFollowChange: (follow: boolean) => void;
  readonly label: string;
  readonly wrap: boolean;
  readonly gutter: {
    readonly numbers: boolean;
    readonly ts: TimestampPref | null;
    readonly badge: boolean;
  } | null;
  readonly terminal?: boolean | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div className="dy-log">
      <VirtualLines
        rows={props.rows}
        follow={props.follow}
        onFollowChange={props.onFollowChange}
        label={props.label}
        wrap={props.wrap}
        gutter={props.gutter}
        {...(props.terminal === true ? { terminal: true } : {})}
        className={props.className ?? 'h-[60vh] max-h-[640px] min-h-64'}
        {...(props.testId === undefined ? {} : { testId: props.testId })}
      />
    </div>
  );
}

/** Follow, wrap, time (+ wall / elapsed), copy and the count — the toolbar row of every Diyalog log. */
export function DyLogTools(props: {
  readonly follow: boolean;
  readonly onFollow: (follow: boolean) => void;
  readonly wrap: boolean;
  readonly onWrap: (wrap: boolean) => void;
  /** null: no time controls (the terminal view). */
  readonly ts: TimestampPref | null;
  readonly onTs?: ((p: TimestampPref) => void) | undefined;
  readonly copyText: () => string;
  readonly copyLabel?: string | undefined;
  readonly count: ReactNode;
  readonly countTestId?: string | undefined;
  readonly followLabel?: string | undefined;
}): ReactNode {
  const { ts, onTs } = props;
  const t = useT().shared;
  const l = t.logs;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Toggle
        label={props.followLabel ?? l.follow}
        pressed={props.follow}
        onChange={props.onFollow}
        title={l.followTitle}
      />
      <Toggle label={l.wrap} pressed={props.wrap} onChange={props.onWrap} title={l.wrapTitle} />
      {ts === null || onTs === undefined ? null : (
        <>
          <Toggle
            label={l.time}
            pressed={ts.show}
            onChange={(show) => {
              onTs({ ...ts, show });
            }}
            title={l.timeTitle}
          />
          {ts.show ? (
            <Segmented
              label={l.timeFormat}
              value={ts.mode}
              onChange={(mode) => {
                onTs({ ...ts, mode });
              }}
              options={[
                ['clock', l.clock, l.clockTitle],
                ['elapsed', l.elapsed, l.elapsedTitle],
              ]}
            />
          ) : null}
        </>
      )}
      <DyCopyButton text={props.copyText} label={props.copyLabel ?? t.copy.label} variant="secondary" />
      <span
        className="ml-auto font-dy-mono text-[0.75rem] text-dy-muted tabular-nums"
        data-testid={props.countTestId}
      >
        {props.count}
      </span>
    </div>
  );
}

/**
 * A complete log card: an optional header (search, view switch), the toolbar and the lines (or the empty text). It
 * keeps follow / wrap itself; the time preference is the remembered one.
 */
export function DyLogView(props: {
  readonly label: string;
  readonly rows: readonly DisplayRow[];
  /** Plain text for "Kopyala" (built on click). */
  readonly copyText: () => string;
  readonly count: ReactNode;
  readonly empty: ReactNode;
  readonly header?: ReactNode;
  readonly badge?: boolean | undefined;
  readonly initialWrap?: boolean | undefined;
  readonly className?: string | undefined;
  readonly viewportClassName?: string | undefined;
  readonly testId?: string | undefined;
  readonly viewportTestId?: string | undefined;
}): ReactNode {
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(props.initialWrap ?? false);
  const [ts, setTs] = useTimestampPref();
  return (
    <section
      aria-label={props.label}
      data-testid={props.testId}
      className={cx(
        'min-w-0 overflow-hidden rounded-[14px] border border-dy-line bg-dy-card',
        props.className,
      )}
    >
      <div className="grid gap-2 border-b border-dy-line px-3 py-2.5 sm:px-4">
        {props.header}
        <DyLogTools
          follow={follow}
          onFollow={setFollow}
          wrap={wrap}
          onWrap={setWrap}
          ts={ts}
          onTs={setTs}
          copyText={props.copyText}
          count={props.count}
        />
      </div>
      {props.rows.length === 0 ? (
        <p className="m-0 px-4 py-6 text-[0.875rem] text-dy-muted">{props.empty}</p>
      ) : (
        <DyLogViewport
          rows={props.rows}
          follow={follow}
          onFollowChange={setFollow}
          wrap={wrap}
          gutter={{ numbers: true, ts, badge: props.badge === true }}
          label={props.label}
          className={props.viewportClassName}
          testId={props.viewportTestId}
        />
      )}
    </section>
  );
}
