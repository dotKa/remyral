import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui';
import { badgeText } from '../../shell/navBadges';
import { useT } from '../../i18n/I18nProvider';
import { usePresence } from '../motion';
import { ChatIcon } from './icons';

/**
 * p12-diyalog-parity: where the conversation list of the Sohbet screen lives (docs/design/p12-diyalog.md §13.2).
 *   wide windows   a column next to the nav rail; "Listeyi gizle" collapses it (remembered in this browser) and the
 *                  top bar's "Sohbetler" button brings it back; p12-diyalog-cmdk: it eases closed / open (220 ms);
 *   narrow / phone a drawer from the left edge over a scrim (Escape, the scrim or picking a conversation closes it;
 *                  focus goes to the search on open and back to the button on close).
 * "Wide" is ≥ 1024 px (`PaneWidth` keeps room for another breakpoint should another screen host the list).
 */

export type PaneWidth = 'chat';

const WIDE_QUERY: Readonly<Record<PaneWidth, string>> = {
  chat: '(min-width: 1024px)',
};

export const PANE_STORAGE_KEY = 'remyral.dy.conversations';
export const PANE_ID = 'dy-conversations';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(PANE_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function isWide(width: PaneWidth): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY[width]).matches;
}

export interface Pane {
  readonly width: PaneWidth;
  /** Desktop column hidden by the reader. */
  readonly collapsed: boolean;
  /** The drawer (narrow windows) is open. */
  readonly drawer: boolean;
  /** Unread messages in conversations other than the open one (the toggle's dot). */
  readonly unread: number;
  readonly setUnread: (n: number) => void;
  readonly toggle: () => void;
  readonly collapse: () => void;
  readonly closeDrawer: () => void;
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
  readonly searchRef: RefObject<HTMLInputElement | null>;
}

export function usePane(width: PaneWidth): Pane {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [unread, setUnread] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const remember = useCallback((v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(PANE_STORAGE_KEY, v ? 'collapsed' : 'open');
    } catch {
      // Storage unavailable: the choice lasts for this page view.
    }
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawer(false);
    toggleRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    if (isWide(width)) {
      remember(!collapsed);
      if (collapsed) requestAnimationFrame(() => searchRef.current?.focus());
    } else setDrawer((d) => !d);
  }, [width, collapsed, remember]);

  // Drawer: search focused on open, Escape closes, a resize to a wide window closes it.
  useEffect(() => {
    if (!drawer) return;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && document.querySelector('dialog[open]') === null) {
        e.preventDefault();
        closeDrawer();
      }
    };
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY[width]) : null;
    const onWide = (): void => {
      if (mq?.matches === true) setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    mq?.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      mq?.removeEventListener('change', onWide);
    };
  }, [drawer, width, closeDrawer]);

  return {
    width,
    collapsed,
    drawer,
    unread,
    setUnread,
    toggle,
    collapse: () => {
      remember(true);
      toggleRef.current?.focus();
    },
    closeDrawer,
    toggleRef,
    searchRef,
  };
}

/** Column classes per breakpoint (static strings: Tailwind sees them whole). */
const WIDE_CLASSES: Readonly<Record<PaneWidth, string>> = {
  chat: 'lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-dvh lg:w-[288px] lg:shrink-0 lg:transform-none lg:p-0 lg:shadow-none',
};
/** Shown only while the list is a drawer / only while it is a column. */
export const NARROW_ONLY: Readonly<Record<PaneWidth, string>> = {
  chat: 'lg:hidden',
};
export const WIDE_ONLY: Readonly<Record<PaneWidth, string>> = {
  chat: 'hidden lg:grid',
};

/** The list column / drawer around `children` (the ConversationList). */
export function PaneFrame(props: { readonly pane: Pane; readonly children: ReactNode }): ReactNode {
  const { pane } = props;
  const t = useT().chat.pane;
  // p12-diyalog-cmdk: the drawer slides in / out from the rail edge over a fading scrim; the wide column opens and
  // collapses (its width eases, the list inside keeps its width and slides) — motion.css, none under reduced motion.
  const ref = useRef<HTMLElement>(null);
  const drawer = usePresence(pane.drawer, ref);
  const column = usePresence(!pane.collapsed, ref);
  const scrim = usePresence<HTMLDivElement>(pane.drawer);
  // Below lg the drawer's state drives the CSS, from lg the column's (motion.css reads each in its own range).
  const state = drawer.mounted ? drawer.state : column.state;
  return (
    <>
      {scrim.mounted ? (
        <div
          ref={scrim.ref}
          aria-hidden="true"
          data-testid="dy-conversations-scrim"
          data-state={scrim.state}
          className={cx('dy-m-fade fixed inset-0 z-30 bg-dy-scrim', NARROW_ONLY[pane.width])}
          onClick={pane.closeDrawer}
        />
      ) : null}
      <aside
        ref={ref}
        id={PANE_ID}
        aria-label={t.label}
        data-testid="dy-conversations"
        data-open={pane.drawer ? 'true' : 'false'}
        data-collapsed={pane.collapsed ? 'true' : 'false'}
        data-state={state}
        inert={state === 'closed' ? true : undefined}
        className={cx(
          'dy-surface dy-m-column dy-m-drawer-left min-h-0 flex-col border-r border-dy-line bg-dy-bg',
          drawer.mounted
            ? 'fixed inset-y-0 left-0 z-40 flex w-[min(22rem,88vw)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-dy-pop'
            : 'hidden',
          column.mounted && WIDE_CLASSES[pane.width],
        )}
      >
        <div className="dy-m-inner flex min-h-0 w-full min-w-0 flex-1 flex-col lg:w-[288px] lg:min-w-[288px]">
          {props.children}
        </div>
      </aside>
    </>
  );
}

/**
 * The top bar's "Sohbetler" button: opens the drawer (narrow) or brings the collapsed column back (wide). Hidden on
 * wide windows while the column is shown (the column has its own collapse button). A dot marks unread messages in
 * other conversations.
 */
export function PaneToggle(props: { readonly pane: Pane }): ReactNode {
  const { pane } = props;
  const t = useT().chat.pane;
  const open = pane.drawer || !pane.collapsed;
  const label = pane.unread > 0 ? t.unread({ count: badgeText(pane.unread) }) : t.label;
  return (
    <button
      ref={pane.toggleRef}
      type="button"
      aria-label={label}
      aria-controls={PANE_ID}
      aria-expanded={pane.drawer || undefined}
      title={t.listTitle}
      data-testid="dy-conversations-toggle"
      data-state={open ? 'open' : 'closed'}
      onClick={pane.toggle}
      className={cx(
        'dy-press relative grid size-11 shrink-0 place-items-center rounded-[10px] text-dy-muted sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
        !pane.collapsed && NARROW_ONLY[pane.width],
      )}
    >
      <ChatIcon name="list" className="size-5" />
      {pane.unread > 0 ? (
        <span
          aria-hidden="true"
          data-testid="dy-conversations-unread"
          className="absolute top-1.5 right-1.5 size-2 rounded-full bg-dy-teal ring-2 ring-dy-thread"
        />
      ) : null}
    </button>
  );
}
