import { useCallback, useEffect, useState } from 'react';
import { type ApprovalRequest, listApprovals } from '../api/approvals';
import { getChatUnread } from '../api/chat';
import { listPendingQuestions, type PendingQuestion } from '../api/questionsPending';
import { listWorkers, type WorkerSummary } from '../api/workers';
import { useDeferrals } from '../screens/home/deferrals';
import { onInvalidate } from '../lib/invalidate';
import { remember, remembered } from '../lib/remembered';
import { POLL_MS } from './notificationPoll';

/**
 * Section path → count that needs the user (pending approvals, machines waiting to be paired, p9-chat-unread: unread
 * chat messages over conversations that are not archived).
 */
export type NavBadges = Readonly<Record<string, number>>;

/**
 * Counts shown next to sidebar / bottom-bar items, polled like the notification bell (every 30 s while the
 * page is visible, when the page becomes visible again, and right after this tab decided an approval or
 * approved/denied a machine — see `lib/invalidate`). A section the user cannot read (403) or a
 * failed poll simply shows no badge — background polling never signs anyone out.
 */
const BADGES_KEY = 'nav-badges';

function sameBadges(a: NavBadges, b: NavBadges): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** What one poll read (null: that read failed or is not allowed — no badge). */
export interface BadgeSources {
  readonly approvals: readonly Pick<ApprovalRequest, 'id'>[] | null;
  readonly workers: readonly Pick<WorkerSummary, 'id' | 'state'>[] | null;
  readonly chatUnread: number | null;
  readonly questions: readonly Pick<PendingQuestion, 'id' | 'plan'>[] | null;
}

/**
 * The counts from one poll. p20-decisions: a decision the person put off or ignored (the master's per-person list,
 * the same set "Senden bekleyen" and the home leave out) is not counted — an approval (`approval:<id>`), a machine
 * pairing (`pairing:<id>`), a question (`question:<id>`) or a plan's decisions (`plan:<planId>`); it counts again when
 * its time is up.
 */
export function badgeCounts(src: BadgeSources, deferred: ReadonlySet<string>): NavBadges {
  const open = (key: string): boolean => !deferred.has(key);
  return {
    '/chat': src.chatUnread ?? 0,
    '/approvals': (src.approvals ?? []).filter((a) => open(`approval:${a.id}`)).length,
    '/machines': (src.workers ?? []).filter((w) => w.state === 'pending' && open(`pairing:${w.id}`)).length,
    '/questions': (src.questions ?? []).filter(
      (q) => open(`question:${q.id}`) && (q.plan == null || open(`plan:${q.plan.id}`)),
    ).length,
  };
}

const NO_SOURCES: BadgeSources = { approvals: null, workers: null, chatUnread: null, questions: null };

export function useNavBadges(): NavBadges {
  // p14-web-perf: a remount (switching shells) starts from the last counts instead of none.
  const [badges, setBadges] = useState<NavBadges>(() => remembered<NavBadges>(BADGES_KEY) ?? {});
  const [sources, setSources] = useState<BadgeSources | null>(null);
  // p20-decisions: the person's put-off / ignored decisions (one store with the home and /needs).
  const deferrals = useDeferrals();

  const refresh = useCallback(async (): Promise<void> => {
    const [approvals, workers, chat, questions] = await Promise.allSettled([
      listApprovals('pending'),
      listWorkers(),
      getChatUnread(),
      // p14-ask-user: questions waiting for this person's answer.
      listPendingQuestions(),
    ]);
    setSources({
      ...NO_SOURCES,
      approvals: approvals.status === 'fulfilled' ? approvals.value : null,
      workers: workers.status === 'fulfilled' ? workers.value : null,
      chatUnread: chat.status === 'fulfilled' ? chat.value.total : null,
      questions: questions.status === 'fulfilled' ? questions.value : null,
    });
  }, []);

  useEffect(() => {
    // Until the master's deferrals are read the remembered counts stay (no flash of a higher number).
    if (sources === null || !deferrals.loaded) return;
    const deferred = new Set([...deferrals.snoozed, ...deferrals.ignored]);
    const next = badgeCounts(sources, deferred);
    // p14-web-perf: the shell (and the screen inside it) re-renders only when a count changed, not on every poll.
    setBadges((prev) => (sameBadges(prev, next) ? prev : next));
    remember(BADGES_KEY, next);
  }, [sources, deferrals]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    // p5-live-fixes-2: a decision or a pairing approval in this tab updates the badges at once (p9-chat-unread: and
    // a conversation read or answered in this tab).
    const off = onInvalidate(['approvals', 'workers', 'chat', 'questions'], () => {
      void refresh();
    });
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return badges;
}

/** "99+" above 99. */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** p9-chat-unread: "(3) Chat · Remyral" — the unread prefix of the browser tab title. */
const TITLE_PREFIX = /^\(\d+\+?\) /;

export function titleWithUnread(title: string, unread: number): string {
  const base = title.replace(TITLE_PREFIX, '');
  return unread > 0 ? `(${badgeText(unread)}) ${base}` : base;
}

/**
 * p9-chat-unread: keeps the unread count in front of the document title on every page. Pages set their own title
 * (often after loading data), so the prefix is re-applied whenever the <title> changes.
 */
export function useUnreadTitle(unread: number): void {
  useEffect(() => {
    const apply = (): void => {
      const next = titleWithUnread(document.title, unread);
      if (next !== document.title) document.title = next;
    };
    apply();
    const el = document.querySelector('title');
    if (el === null || typeof MutationObserver === 'undefined') {
      return () => {
        document.title = titleWithUnread(document.title, 0);
      };
    }
    const mo = new MutationObserver(apply);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      mo.disconnect();
      document.title = titleWithUnread(document.title, 0);
    };
  }, [unread]);
}
