import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { cx } from '../components/ui';
import { useLocale, useT } from '../i18n/I18nProvider';
import { NEW_JOB_HASH } from './chat/route';
import { remainingText } from './Countdown';
import { DyIcon, type IconName } from './icons';
import { Swap } from './motionKit';
import { NEEDS_PATH, needsCardHref } from './ops/anchors';
import { type Decisions, firstDeadline, groupCounts } from './ops/decisions';
import { type DecisionRow, decisionRows } from './ops/NeedsSummary';
import { preloadDiyalogPath } from './preload';
import { INK } from './tone';

/**
 * p17-needs-page (docs/design/p17-needs-page.md): the top of the home dashboard — "Senden bekleyen" as a summary tile
 * (the full list is its own page, `/needs`) and the quick-access area (start a job, go to a screen).
 */

/** Where a decision row leads: its card on the needs page, its classic fix, or the page itself. */
function rowHref(row: DecisionRow): string {
  if (row.card !== null) return needsCardHref(row.card);
  return row.href ?? NEEDS_PATH;
}

const intent = (to: string) => {
  const go = (): void => {
    preloadDiyalogPath(to.replace(/[#?].*$/, ''));
  };
  return { onMouseEnter: go, onFocus: go, onTouchStart: go };
};

/**
 * "Senden bekleyen" in short: how many decisions wait, by kind (each kind opens its first card on the needs page), the
 * most urgent one and the first deadline; a calm green line when nothing waits. Its height is kept while the sources
 * load, so the quick access and the panels never move when the count arrives.
 */
export function NeedsTile(props: { readonly decisions: Decisions; readonly now: number }): ReactNode {
  const all = useT();
  const w = all.home.summary;
  const wd = all.home.decisions;
  const { locale } = useLocale();
  const d = props.decisions;
  const titleId = useId();
  const n = d.count;
  const state = d.loading ? 'loading' : n > 0 ? 'waiting' : 'clear';
  const cardRows = decisionRows(d.openCards, [], false, all, locale);
  const urgent = cardRows[0] ?? d.rows[0];
  // The next ones after the most urgent: the tile shows what waits instead of an empty box next to the quick access.
  const next = [...cardRows, ...d.rows].filter((r) => r !== urgent).slice(0, 3);
  const groups = groupCounts(d.openCards, d.rows);
  const firstOf = (g: string): string => {
    const card = cardRows.find((r) => r.group === g) ?? d.rows.find((r) => r.group === g);
    return card === undefined ? NEEDS_PATH : rowHref(card);
  };
  const earliest = firstDeadline(d.openCards, props.now);
  return (
    <section
      aria-labelledby={titleId}
      data-testid="dy-home-needs"
      data-state={state}
      className={cx(
        'flex min-h-[10.5rem] min-w-0 flex-col gap-3 rounded-[14px] border bg-dy-card p-4 shadow-dy',
        state === 'waiting' ? 'border-dy-amber/40' : 'border-dy-line',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'grid size-9 shrink-0 place-items-center rounded-full',
            state === 'waiting'
              ? 'bg-dy-amber-soft text-dy-amber-ink'
              : state === 'clear'
                ? 'bg-dy-green-soft text-dy-green'
                : 'dy-breathe bg-dy-sunk text-dy-muted',
          )}
          aria-hidden="true"
        >
          <DyIcon name={state === 'clear' ? 'checkc' : 'shield'} className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="m-0 text-[0.8125rem] font-bold text-dy-muted">
            {w.title}
          </h2>
          <p
            className="m-0 text-[1.1875rem] leading-snug font-extrabold tracking-[-0.01em]"
            aria-live="polite"
          >
            <Swap k={`${state}:${String(n)}`}>
              {state === 'loading' ? w.loading : n === 0 ? wd.none : wd.count({ n })}
            </Swap>
          </p>
        </div>
        <Link
          to={NEEDS_PATH}
          {...intent(NEEDS_PATH)}
          data-testid="dy-home-needs-open"
          className="dy-press inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[0.84375rem] font-bold text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
        >
          {w.openAll}
          <DyIcon name="chev" className="size-3.5 -rotate-90" />
        </Link>
      </div>
      {state === 'loading' ? (
        <div className="flex flex-wrap gap-1.5" aria-hidden="true" data-testid="dy-home-needs-pending">
          {[0, 1, 2].map((i) => (
            <span key={i} className="dy-breathe block h-[26px] w-20 rounded-full bg-dy-sunk" />
          ))}
        </div>
      ) : state === 'clear' ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{w.calm}</p>
      ) : (
        <>
          {groups.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={wd.byKind}>
              {groups.map(({ g, n: count }) => (
                <li key={g}>
                  <Link
                    to={firstOf(g)}
                    {...intent(NEEDS_PATH)}
                    className="dy-press inline-flex items-center gap-1.5 rounded-full border border-dy-line-2 bg-dy-card px-2.5 py-[3px] text-[0.8125rem] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
                  >
                    <b className="font-dy-mono font-medium">{count}</b>
                    {wd.groups[g]({ n: count })}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {urgent === undefined ? null : (
            <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem]">
              <span className="text-dy-muted">{w.urgent}</span>
              <Link
                to={rowHref(urgent)}
                {...intent(NEEDS_PATH)}
                data-testid="dy-home-needs-urgent"
                className="inline-flex min-w-0 items-center gap-1.5 text-dy-ink no-underline hover:underline"
              >
                <DyIcon name={urgent.icon} className={cx('size-4 shrink-0', INK[urgent.tone])} />
                <span className="min-w-0 truncate">{urgent.text}</span>
              </Link>
              {earliest === undefined ? null : (
                <span
                  className="text-[0.8125rem] text-dy-muted"
                  role="timer"
                  data-testid="dy-home-first-deadline"
                >
                  {wd.firstDeadlineBefore}
                  <b className="font-dy-mono font-medium text-dy-amber-ink tabular-nums">
                    {remainingText(earliest - props.now)}
                  </b>
                  {wd.firstDeadlineAfter}
                </span>
              )}
            </p>
          )}
          {next.length === 0 ? null : (
            <ul
              className="m-0 grid list-none gap-0.5 border-t border-dy-line p-0 pt-2"
              data-testid="dy-home-needs-next"
            >
              {next.map((r) => (
                <li key={rowHref(r)} className="min-w-0">
                  <Link
                    to={rowHref(r)}
                    {...intent(NEEDS_PATH)}
                    className="flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1 text-[0.875rem] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
                  >
                    <DyIcon name={r.icon} className={cx('size-4 shrink-0', INK[r.tone])} />
                    <span className="min-w-0 truncate">{r.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {d.unreadable.length > 0 ? (
        <p className="m-0 mt-auto text-[0.78125rem] text-dy-red-ink">
          {wd.unreadable({ list: d.unreadable.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}

interface QuickItem {
  readonly key: string;
  readonly to: string;
  readonly icon: IconName;
  readonly label: string;
}

/**
 * Hızlı erişim: the two ways to start a job (Sohbet, the form) as the emphasised actions — operators and up, as the
 * classic Home's `canStart` — and the rail's destinations as compact links; "Makine ekle" for owners and admins (the
 * same rule as the Makineler panel's add button).
 */
export function QuickAccess(props: { readonly role: string }): ReactNode {
  const all = useT();
  const w = all.home.quick;
  const nav = all.nav;
  const titleId = useId();
  const canStart = props.role !== 'viewer';
  const admin = props.role === 'owner' || props.role === 'admin';
  const items: readonly QuickItem[] = [
    { key: 'chat', to: '/chat', icon: 'bubble', label: nav.chat },
    { key: 'jobs', to: '/jobs', icon: 'jobs', label: nav.jobs },
    { key: 'workflows', to: '/workflows', icon: 'branch', label: nav.workflows },
    { key: 'automations', to: '/automations', icon: 'clock', label: nav.automations },
    { key: 'machines', to: '/machines', icon: 'cpu', label: nav.machines },
    { key: 'outputs', to: '/outputs', icon: 'tray', label: nav.outputs },
    { key: 'usage', to: '/usage', icon: 'gauge', label: nav.usage },
    { key: 'projects', to: '/projects', icon: 'folder', label: nav.projects },
    { key: 'settings', to: '/settings', icon: 'gear', label: nav.settings },
    ...(admin
      ? [{ key: 'add-machine', to: '/machines/add', icon: 'plus' as const, label: w.addMachine }]
      : []),
  ];
  const newJobHint = useId();
  const byFormHint = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-testid="dy-home-quick"
      className="flex min-w-0 flex-col gap-3 rounded-[14px] border border-dy-line bg-dy-card p-4 shadow-dy"
    >
      <h2 id={titleId} className="m-0 text-[0.8125rem] font-bold text-dy-muted">
        {w.title}
      </h2>
      {canStart ? (
        <div className="grid gap-2 min-[420px]:grid-cols-2">
          <Link
            to={{ pathname: '/chat', hash: `#${NEW_JOB_HASH}` }}
            {...intent('/chat')}
            data-testid="dy-new-job"
            aria-label={all.home.page.newJob}
            aria-describedby={newJobHint}
            className="dy-press flex min-h-14 items-center gap-2.5 rounded-[11px] border border-dy-ink bg-dy-ink px-3 py-2 text-dy-card no-underline"
          >
            <DyIcon name="plus" className="size-5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-[0.9375rem] leading-tight font-bold">{all.home.page.newJob}</span>
              <span id={newJobHint} className="block text-[0.75rem] leading-snug opacity-75">
                {w.newJobHint}
              </span>
            </span>
          </Link>
          <Link
            to="/jobs/new"
            {...intent('/jobs/new')}
            data-testid="dy-new-job-form"
            aria-label={all.home.page.byForm}
            aria-describedby={byFormHint}
            className="dy-press flex min-h-14 items-center gap-2.5 rounded-[11px] border border-dy-line-2 bg-dy-card px-3 py-2 text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
          >
            <DyIcon name="file" className="size-5 shrink-0 text-dy-teal-ink" />
            <span className="min-w-0">
              <span className="block text-[0.9375rem] leading-tight font-bold">{all.home.page.byForm}</span>
              <span id={byFormHint} className="block text-[0.75rem] leading-snug text-dy-muted">
                {w.byFormHint}
              </span>
            </span>
          </Link>
        </div>
      ) : null}
      <nav aria-label={w.screens}>
        <ul className="m-0 grid list-none grid-cols-2 gap-1 p-0 min-[520px]:grid-cols-3">
          {items.map((i) => (
            <li key={i.key} className="min-w-0">
              <Link
                to={i.to}
                {...intent(i.to)}
                data-quick={i.key}
                className="dy-press flex min-h-9 items-center gap-2 rounded-[9px] px-2 text-[0.84375rem] font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              >
                <DyIcon name={i.icon} className="size-4 shrink-0 text-dy-muted" />
                <span className="min-w-0 truncate">{i.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
