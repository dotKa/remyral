import { type ReactNode, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { cx } from '../components/ui';
import type { Messages } from '@remyral/i18n';
import { useT } from '../i18n/I18nProvider';
import { DyIcon, type IconName } from './icons';
import { useSmoothHeight } from './motionKit';
import { SOFT, type Tone } from './tone';

/**
 * p12-diyalog: the shell every live card in a thread shares — an approval, a deploy, a merge, a failure, a limit
 * pause, a draft. Header: kind pill (icon + word, tone) · state · meta · a right-aligned fact (position, timer).
 * Body: title + content. Actions row on a sunk band. When the decision is made the card is `resolved`: it
 * collapses to the header and a one-line outcome, and can be opened again — the thread keeps the history without
 * the weight. Later phases plug card kinds in through the event → card registry (docs/design/p12-diyalog.md §5).
 * p17-panel-motion: the card's height follows its content (a decision row opening, the card resolving, its details
 * folding) over --dy-m-height instead of jumping (`useSmoothHeight`; none under reduced motion).
 */
export interface CardKind {
  readonly label: string;
  /** p18-plan-mode W4: the word in the reader's language (registry kinds); `label` is the fallback. */
  readonly labelOf?: ((m: Messages) => string) | undefined;
  readonly icon: IconName;
  readonly tone: Tone;
}

export function LiveCard(props: {
  readonly kind: CardKind;
  readonly title: ReactNode;
  /** Optional link target of the title (the full page). */
  readonly children?: ReactNode | undefined;
  /** A StateBadge (or any short state text). */
  readonly state?: ReactNode | undefined;
  /** Muted header text ("Bayat, 18 dk bekliyor", project). */
  readonly meta?: ReactNode | undefined;
  /** Right side of the header in mono ("1 / 5", a timer). */
  readonly aside?: ReactNode | undefined;
  /** One line under the title (project · runtime · machine). */
  readonly sub?: ReactNode | undefined;
  readonly actions?: ReactNode | undefined;
  /** Muted note at the end of the actions row ("Onay kod ister"). */
  readonly hint?: ReactNode | undefined;
  /** Set once the card is decided: the outcome line shown while collapsed. */
  readonly resolved?: ReactNode | undefined;
  /**
   * p12-diyalog-w4: what stays visible under the outcome line of a decided card (per-job results, a one-time secret
   * to copy, quick follow-up buttons) — the rest of the body still folds behind "Ayrıntılar".
   */
  readonly after?: ReactNode | undefined;
  /** Anchor id. */
  readonly id?: string | undefined;
  /**
   * p12-diyalog Faz 1: the thread item id (`approval:<id>`): makes the card a keyboard stop (`j` / `k`, focusable
   * with tabindex -1) and the target of `a` / `d` and the jump links.
   */
  readonly cardKey?: string | undefined;
  /** Not seen yet (an unread notification): a teal mark next to the kind and "yeni" for screen readers. */
  readonly unread?: boolean | undefined;
  /** Sunk band below the actions (the decision panel with the code field). */
  readonly panel?: ReactNode | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const all = useT();
  const t = all.shared;
  const titleId = useId();
  const bodyId = useId();
  const isResolved = props.resolved !== undefined && props.resolved !== null;
  const [open, setOpen] = useState(false);
  const expanded = !isResolved || open;
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useSmoothHeight(outer, inner);
  return (
    <article
      ref={outer}
      id={props.id}
      aria-labelledby={titleId}
      data-resolved={isResolved ? '' : undefined}
      data-card={props.cardKey}
      data-unread={props.unread === true ? '' : undefined}
      tabIndex={props.cardKey === undefined ? undefined : -1}
      className={cx(
        'min-w-0 overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy target:outline-2 target:outline-offset-[3px] target:outline-dy-teal',
        props.className,
      )}
    >
      <div ref={inner} className="flow-root">
        <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2.5 text-[0.8125rem] sm:px-3.5">
          {props.unread === true ? (
            <span className="-mr-1 size-2 shrink-0 rounded-full bg-dy-teal" data-testid="dy-unread">
              <span className="sr-only">{t.card.fresh}</span>
            </span>
          ) : null}
          <span
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-[7px] font-bold',
              SOFT[props.kind.tone],
            )}
          >
            <DyIcon name={props.kind.icon} className="size-3.5 shrink-0" />
            {props.kind.labelOf?.(all) ?? props.kind.label}
          </span>
          {props.state}
          {props.meta === undefined ? null : <span className="text-dy-muted">{props.meta}</span>}
          {props.aside === undefined ? null : (
            <span className="ml-auto font-dy-mono text-[0.78125rem] whitespace-nowrap text-dy-muted">
              {props.aside}
            </span>
          )}
        </header>
        <div className="px-3 pt-0.5 pb-3 sm:px-4 sm:pb-3.5">
          <h3
            id={titleId}
            className="m-0 text-[1.0625rem] leading-[1.3] font-bold tracking-[-0.01em] text-balance"
          >
            {props.title}
          </h3>
          {props.sub === undefined ? null : (
            <div className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[0.84375rem] text-dy-muted">
              {props.sub}
            </div>
          )}
          {isResolved ? (
            <div className="dy-settle mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.875rem]">
              <span className="min-w-0 flex-1">{props.resolved}</span>
              {props.children === undefined ? null : (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => {
                    setOpen((o) => !o);
                  }}
                  className="dy-press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.8125rem] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
                >
                  {open ? t.card.hide : t.card.details}
                  <DyIcon
                    name="chev"
                    className={cx('size-3.5 transition-transform duration-150 ease-dy', open && 'rotate-180')}
                  />
                </button>
              )}
            </div>
          ) : null}
          {isResolved && props.after !== undefined && props.after !== null ? (
            <div className="mt-3 grid gap-3">{props.after}</div>
          ) : null}
          {props.children === undefined ? null : (
            <div id={bodyId} hidden={!expanded} className="mt-3">
              {props.children}
            </div>
          )}
        </div>
        {props.actions === undefined || isResolved ? null : (
          <div className="flex flex-wrap items-center gap-2 border-t border-dy-line bg-dy-sunk px-3 py-2.5 sm:px-4 sm:py-3">
            {props.actions}
            {props.hint === undefined ? null : (
              <span className="w-full text-[0.78125rem] text-dy-muted sm:ml-auto sm:w-auto">
                {props.hint}
              </span>
            )}
            {props.panel === undefined || props.panel === null ? null : props.panel}
          </div>
        )}
      </div>
    </article>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'warn' | 'danger' | 'ghost';

function buttonClass(v: ButtonVariant): string {
  return cx(
    'dy-press inline-flex items-center gap-[7px] rounded-[9px] border px-[13px] py-[7px] text-sm whitespace-nowrap no-underline disabled:opacity-50',
    v === 'primary' && 'border-dy-ink bg-dy-ink font-bold text-dy-card',
    v === 'warn' && 'border-dy-amber bg-dy-amber font-bold text-dy-on-fill',
    v === 'secondary' &&
      'border-dy-line-2 bg-dy-card font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink',
    v === 'danger' && 'border-dy-line-2 bg-dy-card font-medium text-dy-red-ink',
    v === 'ghost' &&
      'border-transparent bg-transparent font-medium text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
  );
}

/** p12-diyalog: a card action (primary = ink, warn = amber, danger = red text, ghost). */
export function CardButton(props: {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly icon?: IconName | undefined;
  /** Opens a panel (the code field): its open state. */
  readonly expanded?: boolean | undefined;
  readonly busy?: boolean | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled === true || props.busy === true}
      aria-expanded={props.expanded}
      aria-busy={props.busy === true ? true : undefined}
      className={buttonClass(props.variant ?? 'secondary')}
    >
      {props.icon === undefined ? null : <DyIcon name={props.icon} />}
      {props.children}
    </button>
  );
}

/** p12-diyalog: a card action that opens a page (the classic screen while a card kind is not yet in-thread). */
export function CardLink(props: {
  readonly children: ReactNode;
  readonly to: string;
  readonly variant?: ButtonVariant | undefined;
  readonly icon?: IconName | undefined;
  /** Router state for the target page (p12-diyalog Faz 3: the composer prefill). */
  readonly state?: unknown;
}): ReactNode {
  return (
    <Link to={props.to} state={props.state} className={buttonClass(props.variant ?? 'secondary')}>
      {props.icon === undefined ? null : <DyIcon name={props.icon} />}
      {props.children}
    </Link>
  );
}
