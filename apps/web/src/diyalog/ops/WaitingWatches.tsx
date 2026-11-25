import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type ChatWatch, listWatches } from '../../api/chat';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { useDisplayZone } from '../../lib/displayZone';
import { onInvalidate } from '../../lib/invalidate';
import { POLL_MS } from '../../shell/notificationPoll';
import { agoText, whenText } from '../common/time';
import { DyIcon } from '../icons';
import { Panel } from '../screens/parts';

/**
 * p20-quick (UX research 2026-10-31 finding 11): the person's ACTIVE watches ("haber ver",
 * Takipler) were only in the conversation's side panel — nothing on the home or on "Senden bekleyenler" said that
 * Remyral was still waiting for something on their behalf. Here they are "Bekleniyor" rows: the watch's label, its
 * conversation, since when and until when (wall-clock in the person's time zone), a click opens the conversation.
 *
 * They are NOT decisions: never counted in the nav badge or the "Senden bekleyen" count. Source: the caller's own
 * watches (`GET /chat/watches`, active only; the master answers only the caller's rows), read on open, every POLL_MS
 * while the tab is visible and on chat invalidations. Labels are model / person text: plain text only.
 */

/** The caller's active watches; null while loading or when they cannot be read (older master, no chat access). */
export function useWaitingWatches(): readonly ChatWatch[] | null {
  const [items, setItems] = useState<readonly ChatWatch[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      listWatches().then(
        (w) => {
          if (alive) setItems(w.filter((x) => x.state === 'active'));
        },
        () => {
          if (alive) setItems((cur) => cur ?? null);
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, POLL_MS);
    const off = onInvalidate(['chat'], load);
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, []);
  return items;
}

const SHOWN = 6;

function WaitingRow(props: {
  readonly watch: ChatWatch;
  readonly now: number;
  readonly zone: string;
}): ReactNode {
  const all = useT();
  const w = all.watches.waiting;
  const format = useFormat();
  const x = props.watch;
  const href = x.threadId === null ? x.link : `/chat/${encodeURIComponent(x.threadId)}`;
  const ends = format.dateWith(x.expiresAt, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: props.zone,
  });
  return (
    <li className="border-t border-dy-line first:border-t-0" data-testid="waiting-watch" data-watch={x.id}>
      <Link
        to={href}
        aria-label={w.open({ label: x.label })}
        className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 px-4 py-2.5 text-inherit no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
      >
        <DyIcon name="clock" className="row-span-2 mt-0.5 size-4 shrink-0 text-dy-violet" />
        <span className="min-w-0 text-[0.9375rem] font-medium [overflow-wrap:anywhere]">{x.label}</span>
        <span className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 text-[0.8125rem] text-dy-muted">
          <span className="min-w-0 truncate" data-testid="waiting-watch-thread">
            {x.threadId === null
              ? w.noConversation
              : x.threadTitle === null || x.threadTitle === undefined
                ? w.inConversation
                : w.conversation({ title: x.threadTitle })}
          </span>
          <span className="tabular-nums">
            {w.since({ ago: agoText(x.createdAt, props.now, all.screenKit.time) })}
          </span>
          <span className="tabular-nums" data-testid="waiting-watch-until">
            {w.until({ when: `${ends} (${whenText(x.expiresAt, props.now, all.screenKit.time)})` })}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** The "Bekleniyor" panel (nothing while loading, unreadable or empty: it never stands in the way). */
export function WaitingWatches(props: {
  readonly watches: readonly ChatWatch[] | null;
  readonly now: number;
  readonly testId?: string | undefined;
}): ReactNode {
  const w = useT().watches.waiting;
  const zone = useDisplayZone();
  const [all, setAll] = useState(false);
  const list = props.watches;
  if (list === null || list.length === 0) return null;
  const rows = all ? list : list.slice(0, SHOWN);
  return (
    <Panel
      title={w.title}
      count={String(list.length)}
      countLabel={w.count({ n: list.length })}
      sub={w.sub}
      flush
      testId={props.testId ?? 'waiting-watches'}
    >
      <ul className="m-0 list-none p-0" aria-label={w.title}>
        {rows.map((x) => (
          <WaitingRow key={x.id} watch={x} now={props.now} zone={zone} />
        ))}
      </ul>
      {list.length > SHOWN && !all ? (
        <p className="m-0 border-t border-dy-line px-4 py-2">
          <button
            type="button"
            onClick={() => {
              setAll(true);
            }}
            className="dy-press inline-flex min-h-9 items-center rounded-lg px-1 text-[0.8125rem] font-bold text-dy-teal-ink"
          >
            {w.more({ n: list.length - SHOWN })}
          </button>
        </p>
      ) : null}
    </Panel>
  );
}
