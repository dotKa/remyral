import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../components/ui';
import { DyIcon, type IconName } from './icons';

/**
 * p12-diyalog: a small pill — a link (`to`), a button (`onClick`) or a static label. `hot` marks the one thing that
 * needs attention (amber). `value` is the number part, set in mono.
 */
export function Chip(props: {
  readonly children: ReactNode;
  readonly icon?: IconName | undefined;
  readonly value?: string | undefined;
  readonly hot?: boolean | undefined;
  readonly to?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  /** Full accessible name when the visible text is terse ("5 karar" → "5 karar senden bekliyor"). */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const cls = cx(
    'dy-press inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.8125rem] whitespace-nowrap no-underline',
    props.hot
      ? 'border-transparent bg-dy-amber-soft font-bold text-dy-amber-ink'
      : 'border-dy-line bg-dy-card text-dy-ink',
    (props.to !== undefined || props.onClick !== undefined) &&
      '[@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2',
    props.className,
  );
  const body = (
    <>
      {props.icon === undefined ? null : <DyIcon name={props.icon} className="size-3.5 shrink-0" />}
      {props.value === undefined ? null : (
        <b className="font-dy-mono font-medium tabular-nums">{props.value}</b>
      )}
      {props.children}
    </>
  );
  if (props.to !== undefined)
    return (
      <Link to={props.to} className={cls} aria-label={props.label}>
        {body}
      </Link>
    );
  if (props.onClick !== undefined)
    return (
      <button type="button" onClick={props.onClick} className={cls} aria-label={props.label}>
        {body}
      </button>
    );
  return (
    <span className={cls} aria-label={props.label}>
      {body}
    </span>
  );
}
