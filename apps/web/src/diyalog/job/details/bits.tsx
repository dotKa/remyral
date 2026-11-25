import { type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { DyNotice } from '../../common/notices';
import type { Tone } from '../../tone';
import { useFormat } from '../../../i18n/I18nProvider';
import { TR_FORMAT } from '../../common/time';
import type { Formatter } from '@remyral/i18n';

/**
 * p12-diyalog-w1: small shared pieces of the job's "Ayrıntılar" tabs (docs/design/p12-diyalog.md §14) — a section
 * heading, a notice line, a toggle chip (`aria-pressed`), a copy button that builds its text only on click, a
 * monospace block and a Turkish date-time. Everything shown is rendered as React text.
 */

export function SectionHead(props: {
  readonly children: ReactNode;
  readonly count?: string | undefined;
  readonly aside?: ReactNode;
  readonly id?: string | undefined;
}): ReactNode {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3
        id={props.id}
        className="m-0 flex items-baseline gap-2 text-[0.9375rem] font-bold tracking-[-0.01em]"
      >
        {props.children}
        {props.count === undefined ? null : (
          <span className="font-dy-mono text-[0.78125rem] font-medium text-dy-muted tabular-nums">
            {props.count}
          </span>
        )}
      </h3>
      {props.aside === undefined ? null : (
        <div className="ml-auto flex items-center gap-2">{props.aside}</div>
      )}
    </div>
  );
}

// p12-diyalog-final: the notice, the toolbar toggle / segmented choice and the copy button live once in
// `diyalog/common/*`; the job's Ayrıntılar tabs keep importing them from here.
export { DyCopyButton as CopyButton } from '../../common/actions';
export { Segmented, Toggle } from '../../common/controls';

/** A one-line notice in a meaning colour (always with an icon and words); a red one is an alert. */
export function Notice(props: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly live?: boolean | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <DyNotice tone={props.tone} live={props.tone === 'red' || props.live === true} testId={props.testId}>
      {props.children}
    </DyNotice>
  );
}

/** A monospace block (JSON, raw reasons): wraps, scrolls past `max`, never interprets its text. */
export function MonoBlock(props: {
  readonly children: string;
  readonly label: string;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <pre
      aria-label={props.label}
      tabIndex={0}
      data-testid={props.testId}
      className={cx(
        'm-0 max-h-[60vh] overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-3 font-dy-mono text-[0.78125rem] leading-[1.55] break-words whitespace-pre-wrap text-dy-ink',
        props.className,
      )}
    >
      {props.children}
    </pre>
  );
}

/** "19 Eki 2026 14:02" with the ISO value for machines and the tooltip. */
export function When(props: { readonly iso: string | null }): ReactNode {
  const fmt = useFormat();
  if (props.iso === null) return <span className="text-dy-faint">—</span>;
  const t = Date.parse(props.iso);
  if (Number.isNaN(t)) return <span>{props.iso}</span>;
  return (
    <time dateTime={props.iso} title={new Date(t).toISOString()} className="tabular-nums">
      {fmt.dateTime(t)}
    </time>
  );
}

export function dateTimeText(iso: string, f: Formatter = TR_FORMAT): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : f.dateTime(t);
}
