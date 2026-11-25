import { useErrorText } from '../../i18n/errors';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import {
  type ChatThread,
  deleteThread,
  listThreadsPage,
  markAllThreadsRead,
  type SharedThread,
  updateThread,
} from '../../api/chat';
import {
  type ChatGroup,
  type ChatOrganize,
  type ChatTag,
  deleteGroup,
  moveThreadToGroup,
  pinThread,
  updateGroup,
} from '../../api/chatOrganize';
import { cx } from '../../components/ui';
import { invalidate, onInvalidate } from '../../lib/invalidate';
import { TagDot } from '../../screens/chat/organize/tags';
import { dragThread, useDropTarget } from '../../screens/chat/organize/ThreadSections';
import { LIST_POLL_MS, RenameField, type ThreadAction } from '../../screens/chat/threadActions';
import { groupThreads, type ThreadGroup } from '../../screens/chat/time';
import { badgeText } from '../../shell/navBadges';
import { DyIcon } from '../icons';
import { ChatIcon } from './icons';
import { DyMeaningResults } from './MeaningResults';
import {
  DyGroupNameDialog,
  DyManageTagsDialog,
  DyMoveToGroupDialog,
  DyThreadTagsDialog,
} from './OrganizeDialogs';
import { NARROW_ONLY, type PaneWidth, WIDE_ONLY } from './pane';
import { SharedSection } from './SharedSection';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { onRowKeys, onSearchKeys } from './rowKeys';
import { useFlip } from '../motionKit';
import { remember, remembered } from '../../lib/remembered';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog-parity: the conversation list of the Diyalog shell (docs/design/p12-diyalog.md §13.2) — every feature of
 * the classic chat list (p5-chat-ux, p9-chat-unread, p9-pagination, p10-chat-organize, p10-semantic-defaults-chat) in
 * the Diyalog language, over the same requests:
 *
 * - Yeni sohbet, search (titles; by meaning from 3 characters), Arşivi göster, tag filter, manage tags, new group,
 *   "Tümünü okundu say";
 * - Sabitlenenler, one collapsible section per group (rename / delete, its own "load more", drag a row onto it), then
 *   the rest by Bugün / Dün / Son 7 gün / Daha eski; a search, the archive or a tag filter show one flat list with each
 *   row's pin, group and tags;
 * - per row: unread count (bold title), pin, tags, archived, the linked project of the open conversation, and a menu —
 *   rename inline, pin, move to group, tags, archive / restore, delete (confirmed in the menu).
 *
 * Refreshes every LIST_POLL_MS while visible, on becoming visible, and at once on `chat` / `chat-organize`
 * invalidations (this tab read or got a message, organised something).
 */

const THREAD_PAGE = 100;
const THREAD_MAX = 200;
const SECTION_PAGE = 50;

/** The date section's name (the classic helper groups by English keys). */
function groupLabel(t: Messages, g: ThreadGroup): string {
  const l = t.chat.list.groups;
  return { Today: l.today, Yesterday: l.yesterday, 'Last 7 days': l.last7, Older: l.older }[g];
}

export interface ConversationListProps {
  /** The open conversation (`/chat/:id`), or null for a new conversation (`/chat`). */
  readonly activeId: string | null;
  /** The open conversation's linked project (from its detail; list rows do not carry it). */
  readonly activeProject?: string | null | undefined;
  /** Bumped by the page when it changed a conversation (rename / archive from the header). */
  readonly version?: number | undefined;
  readonly searchRef?: RefObject<HTMLInputElement | null> | undefined;
  /** A conversation was picked (the drawer closes). */
  readonly onNavigate: () => void;
  /** A row's menu changed a conversation (the page reloads it / leaves it when deleted). */
  readonly onChanged?: ((id: string, action: ThreadAction) => void) | undefined;
  /** "Yeni sohbet". */
  readonly onNew: () => void;
  /** Unread messages in conversations other than the open one (the toggle's dot, the phone drawer). */
  readonly onUnread?: ((n: number) => void) | undefined;
  /** Which breakpoint makes the list a column (pane.tsx). */
  readonly width: PaneWidth;
  /** Collapse button (desktop column). */
  readonly onCollapse?: (() => void) | undefined;
  /** The drawer's close button (phones). */
  readonly onClose?: (() => void) | undefined;
}

interface OrganizeActions {
  readonly pin: (t: ChatThread) => void;
  readonly move: (t: ChatThread) => void;
  readonly tags: (t: ChatThread) => void;
}

function useListTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => {
      setTick((n) => n + 1);
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') bump();
    }, LIST_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVisible);
    const off = onInvalidate(['chat', 'chat-organize'], bump);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return tick;
}

function ToolButton(props: {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly pressed?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly label?: string | undefined;
  readonly title?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      aria-label={props.label}
      title={props.title}
      data-testid={props.testId}
      className={cx(
        'dy-press inline-flex min-h-11 items-center gap-1.5 rounded-full border px-2.5 text-[0.78125rem] font-medium whitespace-nowrap disabled:opacity-50 sm:min-h-8',
        props.pressed === true
          ? 'border-dy-teal bg-dy-teal-soft text-dy-teal-ink'
          : 'border-dy-line-2 bg-dy-card text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
      )}
    >
      {props.children}
    </button>
  );
}

function TagPills(props: {
  readonly ids: readonly string[] | undefined;
  readonly tags: ReadonlyMap<string, ChatTag>;
}): ReactNode {
  const tl = useT().chat.list;
  const list = (props.ids ?? []).flatMap((id) => {
    const t = props.tags.get(id);
    return t === undefined ? [] : [t];
  });
  if (list.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-wrap gap-1"
      aria-label={tl.tagsLabel({ names: list.map((t) => t.name).join(', ') })}
      data-testid="dy-row-tags"
    >
      {list.slice(0, 3).map((t) => (
        <span
          key={t.id}
          data-testid="tag-chip"
          className="inline-flex h-[18px] max-w-[7.5rem] items-center gap-1 rounded-full bg-dy-sunk px-1.5 text-[0.6875rem] font-medium text-dy-muted"
        >
          <TagDot color={t.color} className="size-1.5" />
          <span className="truncate">{t.name}</span>
        </span>
      ))}
      {list.length > 3 ? (
        <span className="text-[0.6875rem] text-dy-faint">{`+${String(list.length - 3)}`}</span>
      ) : null}
    </span>
  );
}

function Row(props: {
  readonly thread: ChatThread;
  readonly active: boolean;
  /** p12-diyalog-cmdk: read in this view since its last change (cleared optimistically, before the next refresh). */
  readonly read?: boolean | undefined;
  readonly project: string | null;
  readonly flat: boolean;
  readonly groupName: string | null;
  readonly tags: ReadonlyMap<string, ChatTag> | null;
  readonly organize: OrganizeActions | null;
  readonly onNavigate: () => void;
  readonly onChanged: (id: string, action: ThreadAction) => void;
  readonly onError: (message: string) => void;
}): ReactNode {
  const sayError = useErrorText();
  const tc = useT().chat;
  const t = props.thread;
  const [renaming, setRenaming] = useState(false);
  // p9-chat-unread: the open conversation is being read (its count clears once the page marks it).
  const unread = props.active || props.read === true ? 0 : (t.unreadCount ?? 0);
  const pinned = props.flat && t.pinnedAt != null;

  async function run(fn: () => Promise<unknown>, action: ThreadAction): Promise<void> {
    try {
      await fn();
      props.onChanged(t.id, action);
    } catch (err) {
      props.onError(sayError(err));
    }
  }

  const items: RowMenuItem[] = [
    {
      key: 'rename',
      label: tc.menu.rename,
      icon: 'pen',
      returnFocus: false,
      onSelect: () => {
        setRenaming(true);
      },
    },
  ];
  const org = props.organize;
  if (org !== null)
    items.push(
      {
        key: 'pin',
        label: t.pinnedAt != null ? tc.menu.unpin : tc.menu.pin,
        chatIcon: 'pin',
        onSelect: () => {
          org.pin(t);
        },
      },
      {
        key: 'move',
        label: tc.menu.moveToGroup,
        chatIcon: 'group',
        returnFocus: false,
        onSelect: () => {
          org.move(t);
        },
      },
      {
        key: 'tags',
        label: tc.menu.tags,
        chatIcon: 'tag',
        returnFocus: false,
        onSelect: () => {
          org.tags(t);
        },
      },
    );
  items.push(
    {
      key: 'archive',
      label: t.archived ? tc.menu.unarchive : tc.menu.archive,
      chatIcon: 'archive',
      onSelect: () => {
        void run(() => updateThread(t.id, { archived: !t.archived }), t.archived ? 'restored' : 'archived');
      },
    },
    {
      key: 'delete',
      label: tc.delete,
      icon: 'trash',
      danger: true,
      confirm: { question: tc.menu.deleteQuestion, yes: tc.menu.deleteYes, no: tc.cancel },
      onSelect: () => {
        void run(() => deleteThread(t.id), 'deleted');
      },
    },
  );

  return (
    <li
      className={cx(
        'dy-row group relative flex items-center gap-0.5 rounded-[10px] pr-1',
        props.active
          ? 'bg-dy-card shadow-dy'
          : '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card/70 focus-within:bg-dy-card/70',
      )}
      data-testid="thread-item"
      data-thread-id={t.id}
      data-flip-key={t.id}
      {...(props.organize === null ? {} : dragThread(t.id))}
    >
      {renaming ? (
        <div className="flex min-h-11 flex-1 items-center px-1.5 py-1">
          <RenameField
            thread={t}
            className="h-9 w-full min-w-0 rounded-[8px] border border-dy-teal bg-dy-card px-2 text-base text-dy-ink outline-none sm:text-[0.875rem]"
            onError={(e) => {
              props.onError(sayError(e));
            }}
            onDone={(saved) => {
              setRenaming(false);
              if (saved) props.onChanged(t.id, 'renamed');
            }}
          />
        </div>
      ) : (
        <Link
          to={`/chat/${t.id}`}
          aria-current={props.active ? 'page' : undefined}
          data-row-link=""
          aria-label={
            unread > 0 ? tc.list.rowUnread({ title: t.title, count: badgeText(unread) }) : undefined
          }
          data-unread={unread > 0 ? 'true' : undefined}
          onClick={props.onNavigate}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[10px] py-1.5 pl-2.5 text-[0.875rem] text-dy-ink no-underline"
        >
          {pinned ? (
            <span className="shrink-0 text-dy-faint" title={tc.list.pinned}>
              <span className="sr-only">{tc.list.pinnedSr}</span>
              <ChatIcon name="pin" className="size-3.5" />
            </span>
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cx(
                'truncate',
                unread > 0 ? 'font-bold' : props.active ? 'font-bold' : 'font-medium',
              )}
            >
              {t.title}
            </span>
            {props.project !== null ||
            t.archived ||
            (props.flat && props.groupName !== null) ||
            (props.tags !== null && (t.tagIds?.length ?? 0) > 0) ? (
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.75rem] text-dy-faint">
                {props.project !== null ? (
                  <span className="inline-flex min-w-0 items-center gap-1" data-testid="dy-row-project">
                    <DyIcon name="folder" className="size-3" />
                    <span className="truncate">{props.project}</span>
                  </span>
                ) : null}
                {t.archived ? (
                  <span className="inline-flex items-center gap-1">
                    <ChatIcon name="archive" className="size-3" />
                    {tc.list.archived}
                  </span>
                ) : null}
                {props.flat && props.groupName !== null ? (
                  <span className="truncate" data-testid="dy-row-group">
                    {props.groupName}
                  </span>
                ) : null}
                {props.tags !== null ? <TagPills ids={t.tagIds} tags={props.tags} /> : null}
              </span>
            ) : null}
          </span>
          {unread > 0 ? (
            <span
              aria-hidden="true"
              data-testid="thread-unread"
              className="ml-auto min-w-5 shrink-0 rounded-full bg-dy-teal px-1.5 text-center font-dy-mono text-[0.6875rem] leading-5 font-medium text-dy-on-fill tabular-nums"
            >
              {badgeText(unread)}
            </span>
          ) : null}
        </Link>
      )}
      {renaming ? null : (
        <RowMenu
          label={tc.actionsFor({ title: t.title })}
          items={items}
          className={cx('shrink-0', !props.active && 'dy-row-actions')}
        />
      )}
    </li>
  );
}

function SectionHead(props: {
  readonly label: string;
  readonly count?: number | undefined;
  readonly onDrop?: ((threadId: string) => void) | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const drop = useDropTarget(props.onDrop ?? (() => undefined));
  return (
    <div
      {...(props.onDrop === undefined ? {} : drop.props)}
      data-testid={props.testId}
      data-drop-over={drop.over ? 'true' : undefined}
      className={cx(
        'flex items-center gap-2 rounded-[8px] px-2.5 pt-1 pb-1.5',
        drop.over && 'bg-dy-teal-soft outline outline-1 outline-dy-teal',
      )}
    >
      <h3 className="m-0 min-w-0 flex-1 truncate text-[0.75rem] font-bold tracking-[0.02em] text-dy-faint">
        {props.label}
      </h3>
      {props.count === undefined ? null : (
        <span className="font-dy-mono text-[0.6875rem] text-dy-faint">{props.count}</span>
      )}
    </div>
  );
}

/** One group: a collapsible section (state saved on the master), rename / delete, a drop target, its own pages. */
function GroupBlock(props: {
  readonly group: ChatGroup;
  readonly refreshKey: string;
  readonly renderRow: (t: ChatThread) => ReactNode;
  readonly onDrop: (threadId: string, groupId: string) => void;
  readonly onRename: (g: ChatGroup) => void;
  readonly onChanged: () => void;
  readonly onError: (message: string) => void;
}): ReactNode {
  const sayError = useErrorText();
  const tc = useT().chat;
  const tl = tc.list;
  const g = props.group;
  const listId = useId();
  const [collapsed, setCollapsed] = useState(g.collapsed);
  const [items, setItems] = useState<ChatThread[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const { onError } = props;
  const drop = useDropTarget((id) => {
    props.onDrop(id, g.id);
  });
  useEffect(() => {
    setCollapsed(g.collapsed);
  }, [g.collapsed]);
  useEffect(() => {
    if (collapsed) return;
    let live = true;
    listThreadsPage({ pinned: false, group: g.id, limit: SECTION_PAGE }).then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setNext(page.nextCursor);
      },
      (err: unknown) => {
        if (live) onError(sayError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [collapsed, g.id, props.refreshKey, onError]);
  function loadMore(): void {
    if (next === null || more) return;
    setMore(true);
    listThreadsPage({ pinned: false, group: g.id, limit: SECTION_PAGE, cursor: next }).then(
      (page) => {
        setItems((list) => {
          const have = new Set((list ?? []).map((t) => t.id));
          return [...(list ?? []), ...page.items.filter((t) => !have.has(t.id))];
        });
        setNext(page.nextCursor);
        setMore(false);
      },
      (err: unknown) => {
        onError(sayError(err));
        setMore(false);
      },
    );
  }
  function toggle(): void {
    const v = !collapsed;
    setCollapsed(v);
    updateGroup(g.id, { collapsed: v }).catch((err: unknown) => {
      onError(sayError(err));
    });
  }
  return (
    <li data-testid="group-section" data-group={g.name}>
      <div
        {...drop.props}
        data-drop-over={drop.over ? 'true' : undefined}
        className={cx(
          'dy-row flex items-center gap-0.5 rounded-[8px] pr-1',
          drop.over && 'bg-dy-teal-soft outline outline-1 outline-dy-teal',
        )}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={toggle}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] px-2.5 text-left text-[0.78125rem] font-bold text-dy-muted sm:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
        >
          <ChatIcon name="chevr" className={cx('size-3.5 shrink-0', !collapsed && 'rotate-90')} />
          <span className="truncate">{g.name}</span>
          <span className="ml-auto font-dy-mono text-[0.6875rem] font-normal text-dy-faint">
            {g.threadCount}
          </span>
        </button>
        <RowMenu
          label={tl.groupActions({ name: g.name })}
          className="dy-row-actions"
          items={[
            {
              key: 'rename',
              label: tl.renameGroup,
              icon: 'pen',
              returnFocus: false,
              onSelect: () => {
                props.onRename(g);
              },
            },
            {
              key: 'delete',
              label: tl.deleteGroup,
              icon: 'trash',
              danger: true,
              confirm: {
                question: tl.deleteGroupQuestion({ name: g.name }),
                yes: tl.deleteGroup,
                no: tc.cancel,
              },
              onSelect: () => {
                deleteGroup(g.id).then(props.onChanged, (err: unknown) => {
                  onError(sayError(err));
                });
              },
            },
          ]}
        />
      </div>
      <div id={listId} hidden={collapsed}>
        {collapsed ? null : items === null ? (
          // p12-diyalog-default (visual tour): one placeholder per known conversation (up to 6), so the sections
          // below do not jump down when the group's rows arrive.
          <div
            role="status"
            aria-label={tl.groupLoading({ name: g.name })}
            aria-busy="true"
            className="grid gap-0.5"
          >
            {Array.from({ length: Math.max(1, Math.min(g.threadCount, 6)) }, (_, i) => (
              <span key={i} className="dy-breathe mx-1 block h-[2.375rem] rounded-[8px] bg-dy-sunk" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="m-0 px-2.5 py-1 text-[0.78125rem] text-dy-faint">{tl.groupEmpty}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={g.name}>
            {items.map((t) => props.renderRow(t))}
          </ul>
        )}
        {!collapsed && next !== null ? (
          <button
            type="button"
            disabled={more}
            onClick={loadMore}
            className="dy-press mx-2.5 mt-1 min-h-11 text-[0.78125rem] font-medium text-dy-teal-ink disabled:opacity-50 sm:min-h-8"
          >
            {more ? tc.loading : tl.groupMore({ name: g.name })}
          </button>
        ) : null}
      </div>
    </li>
  );
}

interface ListMemory {
  readonly items: ChatThread[];
  readonly next: string | null;
  readonly organize: ChatOrganize | null;
  readonly pinned: ChatThread[];
}
const LIST_KEY = 'chat:list';

export function ConversationList(props: ConversationListProps): ReactNode {
  const sayError = useErrorText();
  const all = useT();
  const tc = all.chat;
  const tl = tc.list;
  const searchId = useId();
  // p17-panel-motion: a conversation that moves (a new message lifts it to Bugün, pinned, moved to a group) glides there.
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // p14-web-perf: coming back to Sohbet shows the last list at once (lib/remembered.ts) while it is re-read.
  const [memory] = useState(() => remembered<ListMemory>(LIST_KEY));
  const [items, setItems] = useState<ChatThread[] | null>(memory?.items ?? null);
  const [next, setNext] = useState<string | null>(memory?.next ?? null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [organize, setOrganize] = useState<ChatOrganize | null>(memory?.organize ?? null);
  const [pinnedItems, setPinnedItems] = useState<ChatThread[]>(memory?.pinned ?? []);
  const [shared, setShared] = useState<readonly SharedThread[]>([]);
  const [orgTick, setOrgTick] = useState(0);
  const [dialog, setDialog] = useState<
    | { kind: 'move' | 'tags'; thread: ChatThread }
    | { kind: 'group'; group: ChatGroup | null }
    | { kind: 'manageTags' }
    | null
  >(null);
  const tick = useListTick();
  const version = props.version ?? 0;
  const shown = useRef(THREAD_PAGE);
  const filterKey = `${q}\u0000${String(archived)}\u0000${tagFilter ?? ''}`;
  const lastFilter = useRef(filterKey);
  const fail = useCallback((message: string) => {
    setError(message);
  }, []);

  useEffect(() => {
    let live = true;
    if (lastFilter.current !== filterKey) {
      lastFilter.current = filterKey;
      shown.current = THREAD_PAGE;
    }
    const plain = q === '' && !archived && tagFilter === null;
    const t = setTimeout(() => {
      listThreadsPage({
        q,
        archived,
        ...(tagFilter === null ? {} : { tag: tagFilter }),
        ...(shown.current > THREAD_PAGE ? { limit: Math.min(shown.current, THREAD_MAX) } : {}),
      }).then(
        (page) => {
          if (!live) return;
          setItems(page.items);
          setNext(page.nextCursor);
          setOrganize(page.organize);
          // p16-chat-complete: "Paylaşılanlar" comes with the first plain page.
          if (plain) setShared(page.shared);
          setError(null);
          if (plain) {
            const prev = remembered<ListMemory>(LIST_KEY);
            remember(LIST_KEY, {
              items: page.items,
              next: page.nextCursor,
              organize: page.organize,
              pinned: prev?.pinned ?? [],
            } satisfies ListMemory);
          }
        },
        (err: unknown) => {
          if (live) setError(sayError(err));
        },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, archived, tagFilter, filterKey, version, tick, orgTick]);

  const pinnedCount = organize?.pinned ?? 0;
  useEffect(() => {
    if (pinnedCount === 0) {
      setPinnedItems([]);
      return;
    }
    let live = true;
    listThreadsPage({ pinned: true }).then(
      (page) => {
        if (!live) return;
        setPinnedItems(page.items);
        const prev = remembered<ListMemory>(LIST_KEY);
        if (prev !== undefined) remember(LIST_KEY, { ...prev, pinned: page.items } satisfies ListMemory);
      },
      (err: unknown) => {
        if (live) setError(sayError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [pinnedCount, version, tick, orgTick]);

  const organized = useCallback(() => {
    setOrgTick((n) => n + 1);
    invalidate('chat-organize');
  }, []);
  const tagMap = useMemo(() => new Map((organize?.tags ?? []).map((t) => [t.id, t])), [organize]);
  const groupName = useMemo(() => new Map((organize?.groups ?? []).map((g) => [g.id, g.name])), [organize]);
  const actions = useMemo((): OrganizeActions | null => {
    if (organize === null) return null;
    return {
      pin: (t) => {
        pinThread(t.id, t.pinnedAt == null).then(organized, (err: unknown) => {
          setError(sayError(err));
        });
      },
      move: (t) => {
        setDialog({ kind: 'move', thread: t });
      },
      tags: (t) => {
        setDialog({ kind: 'tags', thread: t });
      },
    };
  }, [organize, organized]);
  const dropInto = useCallback(
    (threadId: string, groupId: string | null) => {
      moveThreadToGroup(threadId, groupId).then(organized, (err: unknown) => {
        setError(sayError(err));
      });
    },
    [organized],
  );
  const dropPin = useCallback(
    (threadId: string) => {
      pinThread(threadId, true).then(organized, (err: unknown) => {
        setError(sayError(err));
      });
    },
    [organized],
  );

  function loadMore(): void {
    if (next === null || more) return;
    setMore(true);
    listThreadsPage({ q, archived, ...(tagFilter === null ? {} : { tag: tagFilter }), cursor: next }).then(
      (page) => {
        setItems((list) => {
          const have = new Set((list ?? []).map((t) => t.id));
          const merged = [...(list ?? []), ...page.items.filter((t) => !have.has(t.id))];
          shown.current = merged.length;
          return merged;
        });
        setNext(page.nextCursor);
        setMore(false);
      },
      (err: unknown) => {
        setError(sayError(err));
        setMore(false);
      },
    );
  }

  async function markAll(): Promise<void> {
    setMarking(true);
    try {
      await markAllThreadsRead();
      setError(null);
      invalidate('chat');
    } catch (err) {
      setError(sayError(err));
    } finally {
      setMarking(false);
    }
  }

  const plain = q === '' && !archived && tagFilter === null;
  const sectioned = organize !== null && plain && (organize.pinned > 0 || organize.groups.length > 0);
  const flat = !sectioned && organize !== null;
  const rest =
    items === null ? [] : sectioned ? items.filter((t) => t.pinnedAt == null && t.groupId == null) : items;
  const dated = groupThreads(rest);

  // p12-diyalog-cmdk: a conversation opened here is read up to its last change — its count clears at once (and stays
  // cleared after switching away) until the list's next refresh brings the master's count; a newer message shows again.
  const readUpTo = useRef(new Map<string, string>());
  const activeRow = [...(items ?? []), ...pinnedItems].find((t) => t.id === props.activeId);
  useEffect(() => {
    if (activeRow === undefined) return;
    const prev = readUpTo.current.get(activeRow.id);
    if (prev === undefined || prev < activeRow.updatedAt)
      readUpTo.current.set(activeRow.id, activeRow.updatedAt);
  }, [activeRow]);
  const isRead = (t: ChatThread): boolean => {
    const at = readUpTo.current.get(t.id);
    return t.id === props.activeId || (at !== undefined && t.updatedAt <= at);
  };
  const seen = new Set<string>();
  const otherUnread = [...(items ?? []), ...pinnedItems].reduce((n, t) => {
    if (seen.has(t.id)) return n;
    seen.add(t.id);
    return n + (isRead(t) ? 0 : (t.unreadCount ?? 0));
  }, 0);
  const { onUnread } = props;
  useEffect(() => {
    if (onUnread !== undefined && plain && items !== null) onUnread(otherUnread);
  }, [onUnread, otherUnread, plain, items]);

  const pageChanged = useRef(props.onChanged);
  pageChanged.current = props.onChanged;
  const onChanged = useCallback((id: string, action: ThreadAction) => {
    setOrgTick((n) => n + 1);
    invalidate('chat');
    pageChanged.current?.(id, action);
  }, []);

  const renderRow = (t: ChatThread, inFlat = false): ReactNode => (
    <Row
      key={t.id}
      thread={t}
      active={t.id === props.activeId}
      read={isRead(t)}
      project={t.id === props.activeId ? (props.activeProject ?? null) : null}
      flat={inFlat}
      groupName={t.groupId == null ? null : (groupName.get(t.groupId) ?? null)}
      tags={organize === null ? null : tagMap}
      organize={actions}
      onNavigate={props.onNavigate}
      onChanged={onChanged}
      onError={fail}
    />
  );

  return (
    <nav aria-label={tc.pane.listTitle} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 px-3 pt-3 pb-2">
        <div className="flex items-center gap-1">
          <h2 className="m-0 flex-1 text-[0.9375rem] font-extrabold tracking-[-0.01em]">{tl.title}</h2>
          <button
            type="button"
            onClick={props.onNew}
            className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border border-dy-ink bg-dy-ink px-3 text-[0.8125rem] font-bold text-dy-card sm:min-h-9"
          >
            <DyIcon name="plus" />
            {tc.newChat}
          </button>
          {props.onCollapse === undefined ? null : (
            <button
              type="button"
              onClick={props.onCollapse}
              aria-label={tl.hide}
              title={tl.hide}
              className={cx(
                'dy-press size-9 place-items-center rounded-[10px] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                WIDE_ONLY[props.width],
              )}
            >
              <ChatIcon name="panel" className="size-[18px]" />
            </button>
          )}
          {props.onClose === undefined ? null : (
            <button
              type="button"
              onClick={props.onClose}
              aria-label={tl.close}
              className={cx(
                'dy-press grid size-11 place-items-center rounded-[10px] text-dy-muted',
                NARROW_ONLY[props.width],
              )}
            >
              <ChatIcon name="close" className="size-5" />
            </button>
          )}
        </div>
        <label htmlFor={searchId} className="sr-only">
          {tl.search}
        </label>
        <div className="flex items-center gap-2 rounded-[10px] border border-dy-line-2 bg-dy-card px-2.5 focus-within:border-dy-teal">
          <ChatIcon name="search" className="size-4 shrink-0 text-dy-faint" />
          <input
            ref={props.searchRef}
            id={searchId}
            type="search"
            name="dy-conversation-search"
            autoComplete="off"
            spellCheck={false}
            data-page-search
            value={q}
            placeholder={tl.search}
            onChange={(e) => {
              setQ(e.target.value);
            }}
            onKeyDown={(e) => {
              onSearchKeys(e, scrollRef.current);
            }}
            className="h-11 min-w-0 flex-1 border-0 bg-transparent text-base text-dy-ink outline-none placeholder:text-dy-faint focus-visible:outline-none sm:h-9 sm:text-[0.875rem]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="organize-bar">
          <ToolButton
            pressed={archived}
            onClick={() => {
              setArchived((a) => !a);
            }}
            testId="dy-show-archived"
          >
            <ChatIcon name="archive" className="size-3.5" />
            {tl.showArchived}
          </ToolButton>
          {organize !== null ? (
            <>
              {organize.tags.length > 0 ? (
                <label className="inline-flex min-w-0 items-center">
                  <span className="sr-only">{tl.filterByTag}</span>
                  <select
                    value={tagFilter ?? ''}
                    aria-label={tl.filterByTag}
                    onChange={(e) => {
                      setTagFilter(e.target.value === '' ? null : e.target.value);
                    }}
                    className={cx(
                      'min-h-11 max-w-[9rem] rounded-full border px-2.5 text-[0.78125rem] font-medium sm:min-h-8',
                      tagFilter === null
                        ? 'border-dy-line-2 bg-dy-card text-dy-muted'
                        : 'border-dy-teal bg-dy-teal-soft text-dy-teal-ink',
                    )}
                  >
                    <option value="">{tl.allTags}</option>
                    {organize.tags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <ToolButton
                onClick={() => {
                  setDialog({ kind: 'manageTags' });
                }}
              >
                <ChatIcon name="tag" className="size-3.5" />
                {tl.tags}
              </ToolButton>
              <ToolButton
                onClick={() => {
                  setDialog({ kind: 'group', group: null });
                }}
              >
                <ChatIcon name="group" className="size-3.5" />
                {tl.newGroup}
              </ToolButton>
            </>
          ) : null}
          {otherUnread > 0 ? (
            <ToolButton
              onClick={() => void markAll()}
              disabled={marking}
              label={tl.markAllRead}
              title={tl.markAllRead}
            >
              <ChatIcon name="readall" className="size-4" />
            </ToolButton>
          ) : null}
        </div>
        {error === null ? null : (
          <p role="status" className="m-0 text-[0.78125rem] text-dy-red-ink">
            {error}
          </p>
        )}
      </div>
      {/* p22-classic-removal §3: ↑ / ↓ / Home / End move between the conversations (rowKeys.ts). */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
        data-testid="thread-scroll"
        onKeyDown={onRowKeys}
      >
        {q.trim().length >= 3 ? <DyMeaningResults q={q} onNavigate={props.onNavigate} /> : null}
        {items === null ? (
          error === null ? (
            <p className="m-0 px-2.5 py-2 text-[0.8125rem] text-dy-faint" role="status">
              {tl.loadingList}
            </p>
          ) : null
        ) : items.length === 0 && !sectioned ? (
          <p className="m-0 px-2.5 py-2 text-[0.8125rem] text-dy-muted">
            {plain ? tl.emptyPlain : tl.emptyFiltered}
          </p>
        ) : (
          <ul ref={listRef} className="relative m-0 flex list-none flex-col gap-3 p-0" aria-label={tl.title}>
            {sectioned && pinnedItems.length > 0 ? (
              <li data-testid="pinned-section">
                <SectionHead label={tl.pinnedSection} onDrop={dropPin} />
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={tl.pinnedSection}>
                  {pinnedItems.map((t) => renderRow(t))}
                </ul>
              </li>
            ) : null}
            {sectioned
              ? organize.groups.map((g) => (
                  <GroupBlock
                    key={g.id}
                    group={g}
                    refreshKey={`${String(version)}:${String(tick)}:${String(orgTick)}`}
                    renderRow={(t) => renderRow(t)}
                    onDrop={dropInto}
                    onRename={(group) => {
                      setDialog({ kind: 'group', group });
                    }}
                    onChanged={organized}
                    onError={fail}
                  />
                ))
              : null}
            {/* p17-ui-polish: "Diğer sohbetler" and the first date heading under it are one heading ("Diğer
                sohbetler · Bugün") — two headings stacked with nothing between them read as an empty section. */}
            {sectioned && dated.length === 0 ? (
              <li>
                <SectionHead
                  label={tl.others}
                  testId="ungrouped-heading"
                  onDrop={(id) => {
                    dropInto(id, null);
                  }}
                />
              </li>
            ) : null}
            {dated.map((g, i) => (
              <li key={g.label}>
                {sectioned && i === 0 ? (
                  <SectionHead
                    label={`${tl.others} · ${groupLabel(all, g.label)}`}
                    testId="ungrouped-heading"
                    onDrop={(id) => {
                      dropInto(id, null);
                    }}
                  />
                ) : (
                  <SectionHead label={groupLabel(all, g.label)} />
                )}
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={groupLabel(all, g.label)}>
                  {g.items.map((t) => renderRow(t, flat))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {items !== null && next !== null ? (
          <button
            type="button"
            disabled={more}
            onClick={loadMore}
            className="dy-press mt-3 flex min-h-11 w-full items-center justify-center rounded-[10px] border border-dy-line-2 bg-dy-card text-[0.8125rem] font-medium text-dy-muted disabled:opacity-50 sm:min-h-9"
          >
            {more ? tc.loading : tl.loadMore}
          </button>
        ) : null}
        {/* p16-chat-complete: conversations other people shared with me (read-only). */}
        <SharedSection items={shared} activeId={props.activeId} onNavigate={props.onNavigate} />
      </div>
      {organize !== null ? (
        <>
          <DyMoveToGroupDialog
            thread={dialog?.kind === 'move' ? dialog.thread : null}
            groups={organize.groups}
            onClose={() => {
              setDialog(null);
            }}
            onDone={() => {
              setDialog(null);
              organized();
            }}
          />
          <DyThreadTagsDialog
            thread={dialog?.kind === 'tags' ? dialog.thread : null}
            tags={organize.tags}
            onClose={() => {
              setDialog(null);
            }}
            onDone={() => {
              setDialog(null);
              organized();
            }}
          />
          <DyGroupNameDialog
            open={dialog?.kind === 'group'}
            group={dialog?.kind === 'group' ? dialog.group : null}
            onClose={() => {
              setDialog(null);
            }}
            onDone={() => {
              setDialog(null);
              organized();
            }}
          />
          <DyManageTagsDialog
            open={dialog?.kind === 'manageTags'}
            tags={organize.tags}
            onClose={() => {
              setDialog(null);
            }}
            onChanged={organized}
          />
        </>
      ) : null}
    </nav>
  );
}
