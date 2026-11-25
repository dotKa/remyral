import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { OpsItem } from '../../../api/opsThread';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useNow } from '../../../lib/now';
import { cancelIntegration } from '../../../api/integration';
import { useDismissed, useHomeData, useSnoozed } from '../../../screens/home/homeData';
import { remainingText } from '../../Countdown';
import { DyIcon } from '../../icons';
import { arrivalStyle, useArrivals } from '../../motionKit';
import { NEEDS_ANCHOR } from '../../ops/anchors';
import { useCardHash } from '../../ops/cardHash';
import { cardGroup, firstDeadline, groupCounts, useDecisions } from '../../ops/decisions';
import { CardKeysProvider, focusCard, useThreadKeys } from '../../ops/keys';
import type { DecisionRow } from '../../ops/NeedsSummary';
import { useOpsEvents } from '../../ops/useOpsEvents';
import { cardFor } from '../../registry';
import { INK } from '../../tone';
import { agoText, DyButtonLink } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { BulkMerges } from './BulkMerges';
import { GoalNeeds, useGoalNeeds } from './GoalNeeds';
import { PlanNeeds, usePlanNeeds } from './PlanNeeds';
import { useWaitingWatches, WaitingWatches } from '../../ops/WaitingWatches';
import '../../ops/register';

/**
 * p17-needs-page (docs/design/p17-needs-page.md): "Senden bekleyen" on its own page (`/needs`) — moved off the home,
 * unchanged in what it does (p12-diyalog §9): the live decision cards from `GET /ops-thread` (approval, deploy /
 * publish, merge, failure needing review, limit pause), decided inline with the authenticator code, most urgent first,
 * "1 / 5" positions, the first deadline as a countdown, counts by kind; a card decided during the visit stays
 * (collapsed to its outcome). The needs-you items without a card are rows with their **Çöz** link; a failed job can be
 * dismissed. `j` / `k` / `a` / `d` move and decide; `#kart=<key>` focuses a card, `#benden-bekleyen` the section.
 */

const SHOWN_CARDS = 6;

/** Rows that report a state (not a decision): a failed job, a runtime or machine problem, a blocked job, an
 *  automation, a memory review. Approvals, questions, deploys and pairings are decided, never ignored. */
const DISMISSIBLE = [
  'needs:failed:',
  'needs:runtime:',
  'needs:machine:',
  'needs:blocked:',
  'needs:automation:',
  'needs:memory-review:',
];
function isDismissible(key: string): boolean {
  return DISMISSIBLE.some((p) => key.startsWith(p));
}
const SHOWN_ROWS = 6;

function RowLine(props: {
  readonly row: DecisionRow;
  readonly now: number;
  readonly onDismiss?: (() => void) | undefined;
  /** "Yoksay" for status rows (they come back after a while if still true), "Kapat" for a failed job. */
  readonly dismissLabel?: string | undefined;
}): ReactNode {
  const { row } = props;
  const all = useT();
  const w = all.home.decisions;
  return (
    <li className="flex items-center gap-3 border-t border-dy-line px-4 py-2.5 first:border-t-0">
      <DyIcon name={row.icon} className={cx('size-4 shrink-0', INK[row.tone])} />
      <span className="min-w-0 flex-1 text-[0.9375rem] [overflow-wrap:anywhere]">{row.text}</span>
      {row.since === null ? null : (
        <span className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
          {agoText(row.since, props.now, all.screenKit.time)}
        </span>
      )}
      {row.href === null ? null : (
        <Link
          to={row.href}
          className="dy-press inline-flex min-h-8 shrink-0 items-center rounded-lg px-2 text-[0.84375rem] font-bold text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
        >
          {w.resolve}
        </Link>
      )}
      {props.onDismiss === undefined ? null : (
        <button
          type="button"
          onClick={props.onDismiss}
          className="dy-press inline-flex min-h-8 shrink-0 items-center rounded-lg px-2 text-[0.8125rem] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
        >
          {props.dismissLabel ?? w.dismiss}
        </button>
      )}
    </li>
  );
}

export function Decisions(props: {
  readonly cards: readonly OpsItem[];
  /** Ids open right now (the rest of `cards` were decided during this visit and stay collapsed). */
  readonly open: ReadonlySet<string>;
  readonly rows: readonly DecisionRow[];
  readonly loading: boolean;
  readonly unreadable: readonly string[];
  readonly dismissed: ReadonlySet<string>;
  readonly onDismiss: (key: string) => void;
  /** p19-needs-snooze: put a card (its id) or a row (its needs-you key) off for a day. */
  readonly onSnooze?: ((key: string) => void) | undefined;
  /** p19-needs-snooze: how many are put off now, and bringing them back. */
  readonly snoozed?: number | undefined;
  readonly onUnsnooze?: (() => void) | undefined;
  readonly onChanged: (item: OpsItem) => void;
  readonly now: number;
  /**
   * p18-plan-mode W4: plan decisions shown in the plans section (by plan id) — counted here, listed there. Absent: every
   * row is listed here.
   */
  readonly plansShown?: ReadonlySet<string> | undefined;
}): ReactNode {
  const w = useT().home.decisions;
  const [all, setAll] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  useThreadKeys(rootRef);
  const n = props.open.size + props.rows.length;
  const openCards = props.cards.filter((c) => props.open.has(c.id));
  const positions = new Map(
    openCards.map((c, i) => [c.id, `${String(i + 1)} / ${String(openCards.length)}`] as const),
  );
  const cards = all ? props.cards : props.cards.slice(0, SHOWN_CARDS);
  const listed = props.rows.filter(
    (r) => r.planId === undefined || !(props.plansShown?.has(r.planId) ?? false),
  );
  const rows = allRows ? listed : listed.slice(0, SHOWN_ROWS);
  const groups = groupCounts(openCards, props.rows);
  const earliest = firstDeadline(openCards, props.now);
  // p17-panel-motion: a decision that arrives while the page is open tips up into place (never the first draw).
  const arrived = useArrivals(
    cards.map((c) => c.id),
    !props.loading,
  );
  return (
    <section
      id={NEEDS_ANCHOR}
      ref={rootRef}
      aria-labelledby={`${NEEDS_ANCHOR}-title`}
      tabIndex={-1}
      data-testid="dy-needs-decisions"
      className="scroll-mt-20 outline-none"
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2
          id={`${NEEDS_ANCHOR}-title`}
          className="m-0 flex items-center gap-2 text-[1.125rem] font-extrabold tracking-[-0.01em]"
        >
          <span
            className={cx(
              'grid size-7 place-items-center rounded-full',
              n > 0 ? 'bg-dy-amber-soft text-dy-amber-ink' : 'bg-dy-green-soft text-dy-green',
            )}
            aria-hidden="true"
          >
            <DyIcon name={n > 0 ? 'shield' : 'checkc'} className="size-4" />
          </span>
          {props.loading ? w.loading : n === 0 ? w.none : w.count({ n })}
        </h2>
        {groups.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={w.byKind}>
            {groups.map(({ g, n: count }) => (
              <li
                key={g}
                className="inline-flex items-center gap-1.5 rounded-full border border-dy-line-2 bg-dy-card px-2.5 py-[3px] text-[0.8125rem]"
              >
                <b className="font-dy-mono font-medium">{count}</b>
                {w.groups[g]({ n: count })}
              </li>
            ))}
          </ul>
        )}
        {earliest === undefined ? null : (
          <span
            className="ml-auto text-[0.8125rem] text-dy-muted"
            role="timer"
            data-testid="dy-first-deadline"
          >
            {w.firstDeadlineBefore}
            <b className="font-dy-mono font-medium text-dy-amber-ink tabular-nums">
              {remainingText(earliest - props.now)}
            </b>
            {w.firstDeadlineAfter}
          </span>
        )}
      </div>
      {props.unreadable.length > 0 ? (
        <p className="m-0 mb-3 text-[0.8125rem] text-dy-red-ink">
          {w.unreadable({ list: props.unreadable.join(', ') })}
        </p>
      ) : null}
      {props.loading && props.cards.length === 0 ? (
        // p12-diyalog-default (visual tour): card-sized placeholders (a decision is a live card, ~19 rem tall), so
        // the rows below do not jump down by a screen when the cards arrive.
        <div
          role="status"
          aria-label={w.skeleton}
          aria-busy="true"
          data-testid="dy-decisions-skeleton"
          className="grid gap-3 min-[1180px]:grid-cols-2"
        >
          {[0, 1].map((i) => (
            <span
              key={i}
              className="dy-breathe block h-[19rem] rounded-[14px] border border-dy-line bg-dy-card max-[1179px]:last:hidden"
            />
          ))}
        </div>
      ) : n === 0 && props.cards.length === 0 ? (
        <p className="m-0 rounded-[14px] border border-dy-line bg-dy-card px-4 py-4 text-[0.9375rem] text-dy-muted">
          {w.empty}
        </p>
      ) : (
        <div className="grid gap-3">
          {cards.length === 0 ? null : (
            <ul className="m-0 grid list-none gap-3 p-0 min-[1180px]:grid-cols-2" aria-label={w.cards}>
              {cards.map((item) => {
                const i = arrived.get(item.id);
                return (
                  <li
                    key={item.id}
                    className={cx('min-w-0', i !== undefined && 'dy-m-arrive')}
                    style={arrivalStyle(i)}
                    data-key={item.id}
                    data-group={cardGroup(item)}
                  >
                    {cardFor(item.type).render?.({
                      item,
                      position: positions.get(item.id),
                      onChanged: props.onChanged,
                      onChat: () => undefined,
                      dismissed:
                        item.type === 'job:failed' ? props.dismissed.has(`failed:${item.job.id}`) : undefined,
                      onDismiss: props.onDismiss,
                    }) ?? null}
                    {props.open.has(item.id) && props.onSnooze !== undefined ? (
                      <CardExits item={item} onSnooze={props.onSnooze} onChanged={props.onChanged} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {props.cards.length > SHOWN_CARDS ? (
            <button
              type="button"
              aria-expanded={all}
              onClick={() => {
                setAll((v) => !v);
              }}
              className="dy-press justify-self-start rounded-lg px-2 py-1 text-[0.875rem] font-medium text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
            >
              {all ? w.showLess : w.showAllCards({ n: props.cards.length })}
            </button>
          ) : null}
          {listed.length === 0 ? null : (
            <div className="overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy">
              <ul className="m-0 list-none p-0" aria-label={w.others}>
                {rows.map((r) => (
                  <RowLine
                    key={r.key}
                    row={r}
                    now={props.now}
                    onDismiss={
                      isDismissible(r.key)
                        ? () => {
                            props.onDismiss(r.key.slice('needs:'.length));
                          }
                        : props.onSnooze === undefined || !r.key.startsWith('needs:')
                          ? undefined
                          : () => {
                              props.onSnooze?.(r.key.slice('needs:'.length));
                            }
                    }
                    dismissLabel={
                      r.key.startsWith('needs:failed:')
                        ? undefined
                        : isDismissible(r.key)
                          ? w.ignore
                          : w.snooze
                    }
                  />
                ))}
              </ul>
              {listed.length > SHOWN_ROWS ? (
                <button
                  type="button"
                  aria-expanded={allRows}
                  onClick={() => {
                    setAllRows((v) => !v);
                  }}
                  className="dy-press w-full border-t border-dy-line px-4 py-2 text-left text-[0.84375rem] font-medium text-dy-teal-ink"
                >
                  {allRows ? w.showLess : w.showAll({ n: listed.length })}
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
      {props.snoozed === undefined || props.snoozed === 0 || props.onUnsnooze === undefined ? null : (
        <p
          className="m-0 mt-3 flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted"
          data-testid="dy-snoozed"
        >
          {w.snoozed({ n: props.snoozed })}
          <button
            type="button"
            onClick={props.onUnsnooze}
            className="dy-press inline-flex min-h-8 items-center rounded-lg px-2 font-bold text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
          >
            {w.unsnooze}
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * p19-needs-snooze: the ways out of a decision card besides deciding it — "Ertele" (a day, every device) on every
 * card, and on a merge that waits for a person "Birleştirmeden vazgeç" (the integration is cancelled; the job branches
 * stay), confirmed inline.
 */
function CardExits(props: {
  readonly item: OpsItem;
  readonly onSnooze: (key: string) => void;
  readonly onChanged: (item: OpsItem) => void;
}): ReactNode {
  const w = useT().home.decisions;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = props.item;
  const merge = item.type === 'merge:integration' ? item : null;
  const btn =
    'dy-press inline-flex min-h-9 items-center rounded-lg px-2.5 text-[0.84375rem] font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="dy-card-exits">
      <button
        type="button"
        title={w.snoozeHint}
        onClick={() => {
          props.onSnooze(item.id);
        }}
        className={cx(btn, 'text-dy-muted')}
        data-testid="dy-snooze"
      >
        <DyIcon name="clock" className="mr-1 size-3.5" />
        {w.snooze}
      </button>
      {merge === null ? null : confirming ? (
        <span role="group" className="flex flex-wrap items-center gap-1.5 text-[0.84375rem]">
          <span className="text-dy-ink">{w.mergeCancelConfirm}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              cancelIntegration(merge.merge.id).then(
                (view) => {
                  setBusy(false);
                  setConfirming(false);
                  props.onChanged({ ...merge, merge: view });
                },
                (err: unknown) => {
                  setBusy(false);
                  setError(err instanceof Error ? err.message : String(err));
                },
              );
            }}
            className={cx(btn, 'font-bold text-dy-red-ink')}
            data-testid="dy-merge-cancel-yes"
          >
            {w.confirmYes}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
            }}
            className={cx(btn, 'text-dy-muted')}
          >
            {w.confirmNo}
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          className={cx(btn, 'text-dy-red-ink')}
          data-testid="dy-merge-cancel"
        >
          {w.mergeCancel}
        </button>
      )}
      {error === null ? null : (
        <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
          {error}
        </span>
      )}
    </div>
  );
}

export function NeedsScreen(): ReactNode {
  // "thread'de aç" from a secondary screen (`/needs#kart=approval:<id>`) focuses that card.
  useCardHash();
  const t = useT();
  const w = t.home.needsPage;
  const data = useHomeData();
  const [dismissed, dismiss] = useDismissed();
  // p19-needs-snooze: decisions put off for a day (cards, rows and plans).
  const [snoozed, snooze, unsnooze] = useSnoozed();
  const now = useNow();
  const events = useOpsEvents();
  const d = useDecisions(data, events, dismissed, now, snoozed);
  const { hash } = useLocation();
  // p18-plan-mode W4: the plans that wait for the person (their decisions answered here, grouped by plan).
  const planNeeds = usePlanNeeds();
  const plansShown = new Set((planNeeds.plans ?? []).map((p) => p.planId));
  // p20-quick: "Bekleniyor" — the person's active watches, below the decisions (not counted with them).
  const waiting = useWaitingWatches();
  // p20-outcome: goals that cannot move on by themselves — one intervention card each.
  const goalNeeds = useGoalNeeds();

  // `#benden-bekleyen` (an old "Needs you" link): bring the decisions into view and focus them.
  useEffect(() => {
    if (hash !== `#${NEEDS_ANCHOR}`) return;
    const el = document.getElementById(NEEDS_ANCHOR);
    if (el === null) return;
    focusCard(el);
  }, [hash, data]);

  return (
    <CardKeysProvider>
      <ScreenFrame
        title={w.title}
        purpose={w.purpose}
        live={events.status === 'error' ? 'error' : 'live'}
        actions={
          <DyButtonLink to="/approvals" variant="ghost" icon="shield">
            {w.approvals}
          </DyButtonLink>
        }
        testId="dy-needs"
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {events.status === 'error' ? (
            <p
              role="alert"
              className="m-0 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
            >
              {t.home.page.eventsError({ error: events.error ?? '' })}
            </p>
          ) : null}
          <GoalNeeds goals={goalNeeds.goals} onChanged={goalNeeds.reload} plansShown={plansShown} />
          {/* p22-output-delivery: several merge decisions of one project approved together. */}
          <BulkMerges cards={d.cards} open={d.openIds} onChanged={events.patch} />
          <Decisions
            cards={d.cards}
            open={d.openIds}
            rows={d.rows}
            loading={d.loading}
            unreadable={d.unreadable}
            dismissed={dismissed}
            onDismiss={dismiss}
            onSnooze={snooze}
            snoozed={snoozed.size}
            onUnsnooze={unsnooze}
            onChanged={events.patch}
            now={now}
            plansShown={plansShown}
          />
          <PlanNeeds
            plans={planNeeds.plans}
            onChanged={planNeeds.reload}
            snoozed={snoozed}
            onSnooze={snooze}
          />
          <WaitingWatches watches={waiting} now={now} testId="dy-needs-waiting" />
        </div>
      </ScreenFrame>
    </CardKeysProvider>
  );
}
