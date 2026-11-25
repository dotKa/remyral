import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { OpsItem } from '../../api/opsThread';
import { useAuth } from '../../auth/AuthProvider';
import { StarProvider, useStars } from '../../screens/chat/organize/Stars';
import { ChatRow, Typing } from '../chat/rows';
import type { Loaded } from '../../screens/home/homeData';
import { DyIcon } from '../icons';
import { Message } from '../Message';
import { cardFor } from '../registry';
import { Thread } from '../Thread';
import { EventLine } from './cards';
import { DraftItemCard } from './DraftCard';
import { focusCard, useThreadKeys } from './keys';
import { RunningDigest } from './RunningDigest';
import { ChatImages } from '../chat/ChatImages';
import { buildTimeline, chatItems, isOpenDecision, type TimelineItem } from './timeline';
import { CardsPreparing, CardStrip } from '../chat/CardStrip';
import type { OpsChatApi } from './useOpsChat';
import type { OpsEvents } from './useOpsEvents';
import './register';
import { ChatQuestion } from '../questions/ChatQuestion';
import { useFormat, useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog Faz 1: the operations thread — system events and live cards (GET /ops-thread) merged with the ops chat
 * in time order, the running-jobs digest as the newest card, the assistant's turn as it is written.
 *
 * Reading: the thread opens at its newest end; items that arrive while the reader is further up do not move the page —
 * a "new events" pill counts them and jumps to the first. Notification-backed items are marked read once they were on
 * screen (the bell follows). Keyboard: j / k between cards, a / d on the focused card (keys.tsx).
 */
type Row =
  | TimelineItem
  | { readonly kind: 'digest'; readonly key: string }
  | { readonly kind: 'live'; readonly key: string };

const NEAR_BOTTOM_PX = 240;

function nearBottom(): boolean {
  const doc = document.documentElement;
  return window.innerHeight + window.scrollY >= doc.scrollHeight - NEAR_BOTTOM_PX;
}

function scrollToEnd(): void {
  if (typeof window.scrollTo === 'function') window.scrollTo({ top: document.documentElement.scrollHeight });
}

export function OpsThreadView(props: {
  readonly events: OpsEvents;
  readonly chat: OpsChatApi;
  readonly data: Loaded | null;
  readonly dismissed: ReadonlySet<string>;
  readonly onDismiss: (key: string) => void;
  readonly now: number;
}): ReactNode {
  const { events, chat, data, dismissed, now } = props;
  const { state } = useAuth();
  const t = useT();
  const f = useFormat();
  const tt = t.home.thread;
  const me = state.kind === 'signedIn' ? state.user.username : '';
  const rootRef = useRef<HTMLDivElement>(null);
  useThreadKeys(rootRef);

  const detail = chat.chat.status === 'ready' ? chat.chat.detail : null;
  const stars = useStars(detail?.starred, () => undefined);
  const threadId = detail?.thread.id ?? null;
  const turnOpen = detail?.turn !== null && detail?.turn !== undefined;
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = buildTimeline(events.items, chatItems(detail), new Date(), { t, f });
    if (turnOpen || chat.live !== null) list.push({ kind: 'live', key: 'live' });
    list.push({ kind: 'digest', key: 'jobs:summary' });
    return list;
  }, [events.items, detail, turnOpen, chat.live, t, f]);

  // "1 / 5": the open decisions in thread order.
  const positions = useMemo(() => {
    const open = events.items.filter((i) => isOpenDecision(i, now, dismissed));
    return new Map(open.map((i, n) => [i.id, `${String(n + 1)} / ${String(open.length)}`] as const));
  }, [events.items, now, dismissed]);

  // ---- arrival, the "new events" pill, first scroll
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<readonly string[]>([]);
  const ready = events.status !== 'loading' && chat.chat.status !== 'loading';
  useEffect(() => {
    if (!ready) return;
    const keys = rows
      .filter((r) => r.kind !== 'day' && r.kind !== 'digest' && r.kind !== 'live')
      .map((r) => r.key);
    if (known.current === null) {
      known.current = new Set(keys);
      if (window.location.hash === '') scrollToEnd();
      return;
    }
    const before = known.current;
    const arrived = keys.filter((k) => !before.has(k));
    if (arrived.length === 0) return;
    // Only what lands after the newest item already shown is news (an older page lands above: history).
    let lastKnown = -1;
    keys.forEach((k, i) => {
      if (before.has(k)) lastKnown = i;
    });
    const newest = arrived.filter((k) => keys.indexOf(k) > lastKnown);
    for (const k of arrived) before.add(k);
    if (newest.length === 0) return;
    if (nearBottom()) scrollToEnd();
    else setFresh((f) => [...f, ...newest]);
  }, [rows, ready]);

  const jumpToNew = useCallback(() => {
    const first = fresh[0];
    setFresh([]);
    if (first === undefined) return;
    const li = rootRef.current?.querySelector<HTMLElement>(`li[data-key="${first.replace(/"/g, '')}"]`);
    const target = li?.querySelector<HTMLElement>('[data-card]') ?? li ?? null;
    if (target === null) {
      scrollToEnd();
      return;
    }
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    focusCard(target);
  }, [fresh]);

  // Clear the pill when the reader reaches the end by themselves.
  useEffect(() => {
    if (fresh.length === 0) return;
    const onScroll = (): void => {
      if (nearBottom()) setFresh([]);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [fresh.length]);

  // ---- read tracking: unread notification items that were on screen
  const { seen } = events;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof IntersectionObserver === 'undefined') return;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.notification;
          if (e.isIntersecting && id !== undefined && document.visibilityState === 'visible') pending.add(id);
        }
        if (pending.size > 0 && timer === null)
          timer = setTimeout(() => {
            timer = null;
            seen([...pending]);
            pending.clear();
          }, 1200);
      },
      { threshold: 0.6 },
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-notification]')) io.observe(el);
    return () => {
      io.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [rows, seen]);

  const renderOps = (item: OpsItem): ReactNode => {
    const spec = cardFor(item.type);
    const rendered =
      spec.render?.({
        item,
        position: positions.get(item.id),
        onChanged: events.patch,
        onChat: chat.reload,
        dismissed: item.type === 'job:failed' ? dismissed.has(`failed:${item.job.id}`) : undefined,
        onDismiss: props.onDismiss,
      }) ?? null;
    if (rendered !== null) return rendered;
    return item.type === 'event' ? <EventLine item={item} /> : null;
  };

  const renderRow = (r: Row): ReactNode => {
    switch (r.kind) {
      case 'day':
        return (
          <Message role="system">
            <span>{r.label}</span>
          </Message>
        );
      case 'ops':
        return renderOps(r.item);
      case 'row':
        return <ChatRow item={r} me={me} />;
      // p16-chat-complete: earlier versions are folded away on the home thread.
      case 'superseded':
        return null;
      case 'cards':
        return r.pending ? (
          <CardsPreparing n={r.cards.length} />
        ) : (
          <CardStrip cards={r.cards} threadId={threadId ?? ''} turnOpen={turnOpen} onChanged={chat.reload} />
        );
      // p20-chat-images: the images the turn showed (show_image), under its answer.
      case 'images':
        return <ChatImages images={r.images} />;
      case 'draft':
        return <DraftItemCard d={r.d} threadId={threadId ?? ''} onChanged={chat.reload} />;
      case 'question':
        return (
          <ChatQuestion set={r.q} threadId={threadId ?? ''} turnOpen={turnOpen} onAnswered={chat.reload} />
        );
      case 'live':
        return (
          <Typing
            text={chat.live?.text ?? ''}
            reconnecting={chat.reconnecting}
            done={chat.live?.done === true}
          />
        );
      case 'digest':
        return <RunningDigest data={data} />;
    }
  };

  const unreadOf = (r: Row): string | undefined =>
    r.kind === 'ops' && r.item.unread && r.item.event !== null ? r.item.event.notificationId : undefined;

  return (
    <StarProvider value={stars}>
      <div ref={rootRef}>
        <Thread
          label={tt.label}
          items={rows}
          itemKey={(r) => r.key}
          renderItem={renderRow}
          itemProps={(r) => ({ 'data-notification': unreadOf(r) })}
          busy={!ready}
          older={{ hasMore: events.hasOlder, loading: events.loadingOlder, onLoad: events.loadOlder }}
          empty={null}
          header={
            <>
              {events.status === 'error' ? (
                <Message role="system" tone="warn" icon="xc">
                  {tt.eventsError({ error: events.error ?? '' })}
                </Message>
              ) : null}
              {chat.chat.status === 'error' ? (
                <Message role="system" tone="warn" icon="xc">
                  {tt.chatError({ error: chat.chat.message })}
                </Message>
              ) : null}
              {detail === null ? null : (
                <Message role="system" icon="bubble">
                  <Link
                    to={`/chat/${encodeURIComponent(detail.thread.id)}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {tt.chatLink({ title: detail.thread.title })}
                  </Link>
                </Message>
              )}
            </>
          }
        />
        {fresh.length === 0 ? null : (
          <div className="pointer-events-none sticky bottom-[calc(8.5rem+env(safe-area-inset-bottom))] z-[6] flex justify-center md:bottom-[7.25rem]">
            <button
              type="button"
              onClick={jumpToNew}
              className="dy-pill dy-press pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-dy-ink px-3.5 py-1.5 text-[0.8125rem] font-bold text-dy-card shadow-dy-pop"
            >
              <DyIcon name="chev" className="size-3.5" />
              {tt.fresh({ n: fresh.length })}
            </button>
          </div>
        )}
      </div>
    </StarProvider>
  );
}
