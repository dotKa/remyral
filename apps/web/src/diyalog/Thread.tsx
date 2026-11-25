import { type ReactNode, useState } from 'react';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { arrivalStyle, useArrivals } from './motionKit';

/** How many of the newest items a thread renders at first; "show earlier" adds this many more. */
export const THREAD_WINDOW = 150;

/** p12-chat-scroll-anchor: `reveal` opens at most this many windows of older items to show its item. */
export const MAX_REVEAL_WINDOWS = 10;

/**
 * p12-diyalog: the conversation column — the app's main surface. A `role="log"` list: items arriving later are
 * announced politely (aria-relevant="additions"), and they rise in once (`dy-enter`, off under reduced motion);
 * the items present when the thread first had content stand still. p17-panel-motion: items arriving together follow
 * each other (`--dy-i`, a 50 ms stagger, at most 5 steps); a bulk load (an older page, a backlog) stands still
 * (`useArrivals`); `itemProps` may name the entrance (`data-enter`: me / card / quiet, motion.css).
 *
 * Virtualization-ready: the thread only takes `items` + `itemKey` + `renderItem`, never children, so a windowed
 * renderer can replace the body without touching callers. Today it renders the newest `windowSize` items (older
 * ones behind a button) and lets the browser skip off-screen items (`content-visibility: auto`).
 */
export function Thread<T>(props: {
  /** Accessible name of the log ("Operasyon sohbeti"). */
  readonly label: string;
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  /** Shown above the items (pinned summary card); not part of the log. */
  readonly header?: ReactNode | undefined;
  /** Shown when there are no items. */
  readonly empty?: ReactNode | undefined;
  /** True while the first page loads: the log is marked busy so it is not read out half-filled. */
  readonly busy?: boolean | undefined;
  readonly windowSize?: number | undefined;
  readonly className?: string | undefined;
  /**
   * p12-diyalog Faz 1: older items exist on the server (cursor pagination upward): once every loaded item is shown,
   * the "earlier" button loads the next older page instead.
   */
  readonly older?:
    { readonly hasMore: boolean; readonly loading: boolean; readonly onLoad: () => void } | undefined;
  /** Extra attributes per item (`data-notification` for read tracking). */
  readonly itemProps?: ((item: T) => Record<string, string | undefined>) | undefined;
  /**
   * p12-chat-scroll-anchor: this item's key must be rendered (the first unread message): as many older windows as it
   * takes are shown in the same render, at most MAX_REVEAL_WINDOWS.
   */
  readonly reveal?: string | null | undefined;
}): ReactNode {
  const t = useT().shared;
  const size = props.windowSize ?? THREAD_WINDOW;
  const [asked, setShown] = useState(size);
  const keys = props.items.map(props.itemKey);
  const fresh = useArrivals(keys, props.busy !== true);
  const revealAt = props.reveal === null || props.reveal === undefined ? -1 : keys.indexOf(props.reveal);
  const need = revealAt < 0 ? 0 : Math.ceil((props.items.length - revealAt) / size) * size;
  const shown = Math.max(asked, Math.min(need, size * MAX_REVEAL_WINDOWS));
  const hidden = Math.max(0, props.items.length - shown);
  const visible = props.items.slice(hidden);
  return (
    <div className={cx('flex flex-col gap-[18px]', props.className)}>
      {props.header}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => {
            setShown(shown + size);
          }}
          className="dy-press self-center rounded-full border border-dy-line-2 bg-dy-card px-3 py-1 text-[0.8125rem] text-dy-muted"
        >
          {t.thread.showOlder({ n: Math.min(hidden, size) })}
        </button>
      ) : props.older?.hasMore === true ? (
        <button
          type="button"
          disabled={props.older.loading}
          aria-busy={props.older.loading || undefined}
          onClick={props.older.onLoad}
          className="dy-press self-center rounded-full border border-dy-line-2 bg-dy-card px-3 py-1 text-[0.8125rem] text-dy-muted disabled:opacity-60"
        >
          {props.older.loading ? t.loading : t.thread.older}
        </button>
      ) : null}
      <ol
        role="log"
        aria-label={props.label}
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={props.busy === true ? true : undefined}
        className="m-0 flex list-none flex-col gap-[18px] p-0"
      >
        {visible.map((item) => {
          const k = props.itemKey(item);
          const i = fresh.get(k);
          return (
            <li
              key={k}
              {...props.itemProps?.(item)}
              data-key={k}
              data-fresh={i === undefined ? undefined : ''}
              style={arrivalStyle(i)}
              className={cx('dy-thread-item flex min-w-0 flex-col', i !== undefined && 'dy-enter')}
            >
              {props.renderItem(item)}
            </li>
          );
        })}
      </ol>
      {props.items.length === 0 && props.busy !== true ? props.empty : null}
    </div>
  );
}
