import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { Locale, Messages } from '@remyral/i18n';
import { useT } from '../../i18n/I18nProvider';
import type { OpsItem } from '../../api/opsThread';
import type { PendingQuestion } from '../../api/questionsPending';
import { cx } from '../../components/ui';
import { describeReason, machineHref } from '../../lib/reasons';
import type { NeedsYouItem } from '../../screens/home/needsYou';
import { remainingText } from '../Countdown';
import { DyIcon, type IconName } from '../icons';
import { RailSection } from '../Rail';
import { runtimeDisplayName } from '../RuntimeMark';
import { cardFor } from '../registry';
import { INK, type Tone } from '../tone';
import { focusCard } from './keys';
import { NEEDS_ANCHOR } from './anchors';

/**
 * p12-diyalog Faz 1: "Benden ne bekleniyor" — pinned at the top of the thread (counts by kind, each a jump to its
 * first card) and listed in the context rail (one row per decision, its timer, a jump into the card). One source for
 * both: the open cards of the thread plus the needs-you items that have no card (a machine waiting to pair, a
 * blocked job, an automation, a memory review, a machine problem) — those link to their classic screen.
 */
export { NEEDS_ANCHOR };

export interface DecisionRow {
  readonly key: string;
  /** Card id in the thread (jump target), or null for a classic link. */
  readonly card: string | null;
  readonly href: string | null;
  readonly group: Group;
  readonly icon: IconName;
  readonly tone: Tone;
  readonly text: string;
  /** Right column: a deadline (mono timer) or an age. */
  readonly until: string | null;
  readonly since: string | null;
  /** p18-plan-mode W4: a plan decision's plan ("Senden bekleyen" shows it in the plan's group). */
  readonly planId?: string | undefined;
}

type Group = 'approval' | 'deploy' | 'merge' | 'failure' | 'limit' | 'plan' | 'other';

function cardRow(item: OpsItem, t: Messages): DecisionRow | null {
  const base = { key: item.id, card: item.id, href: null };
  switch (item.type) {
    case 'approval:request':
      return {
        ...base,
        group: 'approval',
        icon: 'shield',
        tone: item.approval.risk === 'critical' ? 'red' : 'amber',
        text: item.approval.headline.text,
        until: item.approval.expiresAt,
        since: null,
      };
    case 'deploy:action':
      return {
        ...base,
        group: 'deploy',
        icon: 'rocket',
        tone: item.deploy.env === 'production' ? 'red' : 'amber',
        text: `${item.deploy.project} ${item.deploy.env ?? ''}`.trim(),
        until: item.deploy.expiresAt,
        since: item.deploy.createdAt,
      };
    case 'merge:integration':
      return {
        ...base,
        group: 'merge',
        icon: 'merge',
        tone: 'teal',
        text:
          item.merge.pullRequest === null
            ? item.merge.branch
            : t.home.needs.mergePr({ n: item.merge.pullRequest.number }),
        until: null,
        since: item.merge.updatedAt,
      };
    case 'job:failed':
      return {
        ...base,
        group: 'failure',
        icon: 'xc',
        tone: 'red',
        text: item.job.title === '' ? t.home.untitledJob : item.job.title,
        until: null,
        since: item.job.stateChangedAt,
      };
    case 'workflow:approval':
      return {
        ...base,
        group: 'approval',
        icon: 'shield',
        tone: 'amber',
        text: item.approval.title ?? `${item.approval.workflow} · ${item.approval.node}`,
        until: item.approval.dueAt,
        since: item.approval.createdAt,
      };
    case 'limit:paused':
      return {
        ...base,
        group: 'limit',
        icon: 'pause',
        tone: 'violet',
        text: t.home.needs.limitOf({ runtime: runtimeDisplayName(item.limit.runtime) }),
        until: item.limit.resumeAt,
        since: null,
      };
    default:
      return null;
  }
}

/** p14-ask-user: "… işinin ajanı bir soru soruyor." in the user's language. */
function questionSentence(q: PendingQuestion, t: Messages): string {
  const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const w = t.questions.needs;
  // p18-plan-mode W4: a plan decision names its plan.
  if (q.plan != null) return w.plan({ plan: clip(q.plan.title) });
  return q.source === 'job'
    ? w.job({ project: q.project ?? '', title: clip(q.jobTitle ?? '') })
    : w.assistant({ title: clip(q.threadTitle ?? '') });
}

/** Needs-you kinds the thread already shows as cards (they are counted from the cards instead). */
const CARD_KINDS = new Set(['approval', 'deploy', 'failed', 'failed-more']);

export function decisionRows(
  open: readonly OpsItem[],
  needs: readonly NeedsYouItem[],
  /** The ops thread is unavailable (older master): approvals / deploys / failures come from needs-you. */
  fallback: boolean,
  t: Messages,
  locale: Locale,
): DecisionRow[] {
  const rows = open.flatMap((i) => {
    const r = cardRow(i, t);
    return r === null ? [] : [r];
  });
  for (const n of needs) {
    if (!fallback && CARD_KINDS.has(n.kind)) continue;
    const spec = cardFor(`needs:${n.kind}`);
    const info =
      n.kind === 'reason' ? describeReason(n.reason, n.context, { locale, params: n.params }) : null;
    rows.push({
      key: `needs:${n.key}`,
      card: null,
      href: n.kind === 'reason' ? (info?.action?.href ?? machineHref(n.context.workerId)) : n.action.href,
      group:
        n.kind === 'approval'
          ? 'approval'
          : n.kind === 'deploy'
            ? 'deploy'
            : n.kind.startsWith('failed')
              ? 'failure'
              : n.kind === 'question' && n.question.plan != null
                ? 'plan'
                : 'other',
      ...(n.kind === 'question' && n.question.plan != null ? { planId: n.question.plan.id } : {}),
      icon: spec.kind.icon,
      tone: n.tone === 'danger' ? 'red' : spec.kind.tone,
      text:
        n.kind === 'question'
          ? questionSentence(n.question, t)
          : n.kind === 'recovery' && n.recovery !== undefined
            ? t.panelSettings.recovery.pendingItem({
                action: t.panelSettings.recovery.actions[n.recovery.action] ?? n.recovery.action,
                user: n.recovery.target.username,
                by: n.recovery.requestedBy ?? '?',
              })
            : n.kind === 'backup-change' && n.backupChange !== undefined
              ? t.hostActions.backups.pending.needs({
                  what:
                    n.backupChange.change === 'recipients'
                      ? t.hostActions.backups.pending.recipients
                      : `${t.hostActions.backups.pending.offsite} (${n.backupChange.target})`,
                  when: `${n.backupChange.until.slice(0, 16).replace('T', ' ')} UTC`,
                })
              : (info?.sentence ?? (n.kind === 'reason' ? '' : n.sentence)),
      until: n.kind === 'backup-change' ? (n.backupChange?.until ?? null) : null,
      since: null,
    });
  }
  return rows;
}

function jump(card: string): void {
  const el = [...document.querySelectorAll<HTMLElement>('[data-card]')].find((e) => e.dataset.card === card);
  if (el !== undefined) focusCard(el);
}

function RowTime(props: { readonly row: DecisionRow; readonly now: number }): ReactNode {
  const { row, now } = props;
  const w = useT().home.needs;
  if (row.until !== null && Date.parse(row.until) > now)
    return <span className="font-dy-mono tabular-nums">{remainingText(Date.parse(row.until) - now)}</span>;
  if (row.since !== null) {
    const min = Math.max(0, Math.round((now - Date.parse(row.since)) / 60_000));
    return (
      <span className="font-dy-mono tabular-nums">
        {min < 60 ? w.minutes({ n: min }) : w.hours({ n: Math.floor(min / 60) })}
      </span>
    );
  }
  return null;
}

function RowLink(props: {
  readonly row: DecisionRow;
  readonly children: ReactNode;
  readonly className: string;
}): ReactNode {
  const { row } = props;
  if (row.card !== null)
    return (
      <a
        href={`#${row.card}`}
        className={props.className}
        onClick={(e) => {
          e.preventDefault();
          jump(row.card ?? '');
        }}
      >
        {props.children}
      </a>
    );
  return (
    <Link to={row.href ?? '/'} className={props.className}>
      {props.children}
    </Link>
  );
}

/** The pinned bar at the top of the thread. */
export function NeedsSummary(props: {
  readonly rows: readonly DecisionRow[];
  readonly loading: boolean;
  readonly unreadable: readonly string[];
  readonly now: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const w = useT().home.needs;
  const { rows } = props;
  const groups = (['approval', 'deploy', 'merge', 'failure', 'limit', 'other'] as const)
    .map((g) => ({ g, list: rows.filter((r) => r.group === g) }))
    .filter((x) => x.list.length > 0);
  const n = rows.length;
  return (
    <section
      id={NEEDS_ANCHOR}
      aria-labelledby={`${NEEDS_ANCHOR}-title`}
      tabIndex={-1}
      className="border-b border-dy-line bg-dy-thread/90 px-3 py-2 backdrop-blur-[14px] sm:px-6"
    >
      <div className="mx-auto flex max-w-[780px] flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2
          id={`${NEEDS_ANCHOR}-title`}
          className="m-0 flex items-center gap-2 text-[0.9375rem] font-extrabold tracking-[-0.01em]"
        >
          <span
            className={cx(
              'grid size-6 place-items-center rounded-full',
              n > 0 ? 'bg-dy-amber-soft text-dy-amber-ink' : 'bg-dy-green-soft text-dy-green',
            )}
            aria-hidden="true"
          >
            <DyIcon name={n > 0 ? 'shield' : 'checkc'} className="size-3.5" />
          </span>
          {props.loading ? w.loading : n === 0 ? w.none : w.count({ n })}
        </h2>
        {groups.length === 0 ? null : (
          <ul
            className="m-0 hidden list-none flex-wrap items-center gap-1.5 p-0 sm:flex"
            aria-label={w.byKind}
          >
            {groups.map(({ g, list }) => {
              const first = list[0];
              if (first === undefined) return null;
              return (
                <li key={g}>
                  <RowLink
                    row={first}
                    className="dy-press inline-flex items-center gap-1.5 rounded-full border border-dy-line-2 bg-dy-card px-2.5 py-[3px] text-[0.8125rem] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
                  >
                    <DyIcon name={first.icon} className={cx('size-3.5', INK[first.tone])} />
                    <b className="font-dy-mono font-medium">{list.length}</b>
                    {w.groups[g]({ n: list.length })}
                  </RowLink>
                </li>
              );
            })}
          </ul>
        )}
        {n === 0 ? null : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${NEEDS_ANCHOR}-list`}
            onClick={() => {
              setOpen((v) => !v);
            }}
            className="dy-press ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.8125rem] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
          >
            {open ? w.hide : w.list}
            <DyIcon
              name="chev"
              className={cx('size-3.5 transition-transform duration-150 ease-dy', open && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {open ? (
        <ul
          id={`${NEEDS_ANCHOR}-list`}
          className="dy-reveal mx-auto mt-1.5 grid max-w-[780px] list-none p-0"
          aria-label={w.pending}
        >
          {rows.map((r) => (
            <li key={r.key} className="border-t border-dy-line first:border-t-0">
              <RowLink
                row={r}
                className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 py-1.5 text-[0.875rem] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-teal-ink"
              >
                <DyIcon name={r.icon} className={cx('size-4', INK[r.tone])} />
                <span className="truncate">{r.text}</span>
                <span className="text-[0.78125rem] text-dy-muted">
                  <RowTime row={r} now={props.now} />
                </span>
              </RowLink>
            </li>
          ))}
        </ul>
      ) : null}
      {props.unreadable.length > 0 ? (
        <p className="mx-auto mt-1 max-w-[780px] text-[0.78125rem] text-dy-red-ink">
          {w.unreadable({ list: props.unreadable.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}

/** The same list in the context rail (mockup "Senden bekleyen"). */
export function NeedsRail(props: { readonly rows: readonly DecisionRow[]; readonly now: number }): ReactNode {
  const { rows } = props;
  const w = useT().home.needs;
  return (
    <RailSection title={w.rail} count={String(rows.length)} countLabel={w.railCount({ n: rows.length })}>
      {rows.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{w.railEmpty}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {rows.slice(0, 8).map((r) => (
            <li key={r.key}>
              <RowLink
                row={r}
                className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-[5px] text-[0.8125rem] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card"
              >
                <DyIcon name={r.icon} className={cx('size-3.5', INK[r.tone])} />
                <span className="truncate">{r.text}</span>
                <span className="text-[0.75rem] text-dy-muted">
                  <RowTime row={r} now={props.now} />
                </span>
              </RowLink>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}
