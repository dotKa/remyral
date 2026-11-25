import { useMemo, useRef } from 'react';
import type { OpsItem } from '../../api/opsThread';
import { useLocale, useT } from '../../i18n/I18nProvider';
import type { Loaded } from '../../screens/home/homeData';
import { buildNeedsYou } from '../../screens/home/needsYou';
import { type DecisionRow, decisionRows } from './NeedsSummary';
import { isOpenDecision } from './timeline';
import type { OpsEvents } from './useOpsEvents';

/**
 * p17-needs-page (docs/design/p17-needs-page.md): "Senden bekleyen" as one model for both places that show it — the
 * decisions page (`/needs`, every card and row) and the home's summary tile (count, kinds, the most urgent one). Both
 * read the same remembered sources (the classic Home reads, `GET /ops-thread`), so moving between the two is instant
 * and the counts agree.
 */

export type DecisionGroup = 'approval' | 'deploy' | 'merge' | 'failure' | 'limit' | 'plan' | 'other';

export const DECISION_GROUPS: readonly DecisionGroup[] = [
  'approval',
  'deploy',
  'merge',
  'failure',
  'limit',
  // p18-plan-mode W4: plan decisions (grouped under their plan on the page).
  'plan',
  'other',
];

const GROUP_RANK: Readonly<Record<string, number>> = {
  'approval:request': 0,
  'deploy:action': 1,
  'merge:integration': 2,
  'job:failed': 3,
  'limit:paused': 4,
  // p17-chat-flow: right after the job approvals.
  'workflow:approval': 0,
};

/** A card's deadline (expiry / resume), or null. */
export function deadline(i: OpsItem): number | null {
  const iso =
    i.type === 'approval:request'
      ? i.approval.expiresAt
      : i.type === 'workflow:approval'
        ? i.approval.dueAt
        : i.type === 'deploy:action'
          ? i.deploy.expiresAt
          : i.type === 'limit:paused'
            ? i.limit.resumeAt
            : null;
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Most urgent first: critical approvals, then whatever runs out soonest (approval / deploy expiry), then the rest by
 * kind (approval, deploy, merge, failure, limit) and newest first within a kind.
 */
export function urgentFirst(items: readonly OpsItem[]): OpsItem[] {
  const critical = (i: OpsItem): number =>
    i.type === 'approval:request' && i.approval.risk === 'critical' ? 0 : 1;
  const timed = (i: OpsItem): number | null =>
    i.type === 'approval:request' || i.type === 'deploy:action' ? deadline(i) : null;
  return [...items].sort((a, b) => {
    const c = critical(a) - critical(b);
    if (c !== 0) return c;
    const ta = timed(a);
    const tb = timed(b);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
    const g = (GROUP_RANK[a.type] ?? 9) - (GROUP_RANK[b.type] ?? 9);
    if (g !== 0) return g;
    return Date.parse(b.at) - Date.parse(a.at);
  });
}

export function cardGroup(i: OpsItem): DecisionGroup {
  switch (i.type) {
    case 'approval:request':
      return 'approval';
    case 'deploy:action':
      return 'deploy';
    case 'merge:integration':
      return 'merge';
    case 'job:failed':
      return 'failure';
    case 'limit:paused':
      return 'limit';
    case 'workflow:approval':
      return 'approval';
    default:
      return 'other';
  }
}

/** How many open decisions of each kind (only the kinds that have some, in the fixed order). */
export function groupCounts(
  openCards: readonly OpsItem[],
  rows: readonly DecisionRow[],
): { readonly g: DecisionGroup; readonly n: number }[] {
  const all = [...openCards.map(cardGroup), ...rows.map((r) => r.group)];
  return DECISION_GROUPS.map((g) => ({ g, n: all.filter((x) => x === g).length })).filter((x) => x.n > 0);
}

/** The first deadline still ahead among the open cards, or undefined. */
export function firstDeadline(openCards: readonly OpsItem[], now: number): number | undefined {
  return openCards
    .map(deadline)
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b)[0];
}

export interface Decisions {
  /** Every card shown: the open ones, plus those decided during this visit (collapsed to their outcome). */
  readonly cards: readonly OpsItem[];
  /** Open cards, most urgent first. */
  readonly openCards: readonly OpsItem[];
  readonly openIds: ReadonlySet<string>;
  /** Needs-you items without a card (pairing, blocked, automation, memory review, machine problem, …). */
  readonly rows: readonly DecisionRow[];
  /** Open cards + rows. */
  readonly count: number;
  /** Either source is still on its first read. */
  readonly loading: boolean;
  readonly unreadable: readonly string[];
}

const NONE: ReadonlySet<string> = new Set();

export function useDecisions(
  data: Loaded | null,
  events: OpsEvents,
  dismissed: ReadonlySet<string>,
  now: number,
  /** p19-needs-snooze: decisions put off for a day (card ids, needs-you row keys) — not shown, not counted. */
  snoozed: ReadonlySet<string> = NONE,
): Decisions {
  const t = useT();
  const { locale } = useLocale();
  const needs = useMemo(
    () =>
      data === null ? [] : buildNeedsYou({ ...data, dismissed }, now).filter((n) => !snoozed.has(n.key)),
    [data, dismissed, now, snoozed],
  );
  const fallback = events.status === 'off' || events.status === 'error';
  const openItems = useMemo(
    () => events.items.filter((i) => !snoozed.has(i.id) && isOpenDecision(i, now, dismissed)),
    [events.items, now, dismissed, snoozed],
  );
  const openIds = useMemo(() => new Set(openItems.map((i) => i.id)), [openItems]);
  // Cards that were open during this visit stay (collapsed to their outcome) after they are decided.
  const everOpen = useRef(new Set<string>());
  for (const id of openIds) everOpen.current.add(id);
  const cards = useMemo(
    () => urgentFirst(events.items.filter((i) => everOpen.current.has(i.id) && !snoozed.has(i.id))),
    // `openIds` changes whenever `everOpen` grows.
    [events.items, openIds, snoozed],
  );
  const openCards = useMemo(() => urgentFirst(openItems), [openItems]);
  const rows = useMemo(
    () =>
      decisionRows([], needs, fallback, t, locale).filter(
        // p19-needs-snooze: a plan put off takes its decisions with it.
        (r) => r.planId === undefined || !snoozed.has(`plan:${r.planId}`),
      ),
    [needs, fallback, t, locale, snoozed],
  );
  return {
    cards,
    openCards,
    openIds,
    rows,
    count: openIds.size + rows.length,
    // p12-diyalog-default (visual tour): both sources (needs-you rows, live cards) before the list is drawn.
    loading: data === null || events.status === 'loading',
    unreadable: data?.errors ?? [],
  };
}
