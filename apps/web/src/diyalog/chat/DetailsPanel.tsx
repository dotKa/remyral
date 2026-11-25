import { useErrorText } from '../../i18n/errors';
import {
  type KeyboardEvent,
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import type { AssetKind, ChatAsset } from '../../api/chatOrganize';
import type { Plan } from '../../api/plans';
import { useRememberedState } from '../../lib/remembered';
import { openDecisions, waitingFor } from '../plan/planModel';
import { PlanTab } from '../plan/PlanTab';
import { cx } from '../../components/ui';
import { KIND_LABEL, useAssets } from '../../screens/chat/organize/sidebar';
import { shortTime } from '../../screens/chat/time';
import { absoluteText } from '../common/time';
import { DyIcon } from '../icons';
import { type PresenceState, presenceProps } from '../motion';
import { DyImageGrid, DyLightbox, type LightboxImage } from '../screens/outputs/Lightbox';
import { type DyState, StateBadge } from '../StateBadge';
import { ChatIcon, type ChatIconName } from './icons';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { WatchesPanel } from './WatchesPanel';

/**
 * p12-diyalog-parity: the conversation's details as a Diyalog side panel (classic ChatSidebar, p10-chat-organize) —
 * Yıldızlı, Görseller, Bağlantılar, Dosyalar, İşler of the open conversation or of all my conversations, every item
 * jumping to its message. Same requests (`GET /chat/assets`), same refresh rules (chat / organize invalidations,
 * jobs every 15 s). Desktop: a column beside the thread, under the full-width header; phones: a full-screen sheet
 * (Escape closes). p12-diyalog-cmdk: the column eases open / closed, the sheet slides from the right edge.
 * p15-watches: a sixth tab, Takipler — the caller's watches with their condition, last and next check, and Cancel.
 *
 * p17-chat-drawer (docs/design/p17-chat-drawer.md): one row layout for every list tab (a leading icon tile, the name,
 * one meta line, the actions aligned at the end), Görseller as a thumbnail grid opening the shared lightbox (←/→
 * across the tab's images, "Sohbette göster", download), skeletons that keep the rows' height, an empty state per
 * tab, readable times and sizes, the header + tab bar fixed above the scrolling list.
 *
 * p18-plans-ui (docs/design/p18-plan-mode.md, "Plans UI"): a seventh tab, Planlar (the conversation's active plan and
 * its earlier plans, plan/PlanTab.tsx). The tab row no longer scrolls sideways: every tab is a cell of a 4-column grid
 * (icon over a short label, two rows at 320 / 352 px and on the phone sheet), counts as small badges (Planlar: what
 * waits for the person; Takipler: the conversation's watches), arrow keys move between tabs (←/→ in reading order,
 * ↑/↓ by row, Home / End; roving tabindex). No "Ayrıntılar" heading any more — the region keeps its accessible name and
 * the close button sits at the end of the tab grid's row. The last tab is remembered for the session.
 */

/** The asset tabs, p15-watches' Takipler and p18-plans-ui's Planlar. */
type TabId = AssetKind | 'watches' | 'plans';

/** Tabs per row of the tab grid. */
const TAB_COLUMNS = 4;
const TAB_KEY = 'chat.details.tab';

const TABS: readonly { readonly id: AssetKind; readonly icon: ChatIconName }[] = [
  { id: 'starred', icon: 'star' },
  { id: 'media', icon: 'image' },
  { id: 'links', icon: 'link' },
  { id: 'files', icon: 'copy' },
  { id: 'jobs', icon: 'list' },
];

/**
 * p18-plans-ui: the tab an arrow key moves to in the tab grid (pure): ←/→ in reading order (wrapping), ↑/↓ by one row
 * of TAB_COLUMNS (staying put at the first / last row), Home / End; null for any other key.
 */
export function nextTab(i: number, count: number, key: string): number | null {
  const last = count - 1;
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return i >= last ? 0 : i + 1;
    case 'ArrowLeft':
      return i <= 0 ? last : i - 1;
    case 'ArrowDown':
      // The row below is shorter: its last tab.
      if (i + TAB_COLUMNS <= last) return i + TAB_COLUMNS;
      return Math.floor(i / TAB_COLUMNS) < Math.floor(last / TAB_COLUMNS) ? last : i;
    case 'ArrowUp':
      return i - TAB_COLUMNS >= 0 ? i - TAB_COLUMNS : i;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/** A job / draft state as one of the Diyalog states (word + icon + tone). */
export function assetState(s: string): DyState {
  const v = s.toUpperCase();
  if (['RUNNING', 'STARTING', 'ASSIGNED', 'PREPARING', 'VERIFYING', 'ACTIVE'].includes(v)) return 'running';
  if (['QUEUED', 'PENDING', 'RETRY_WAIT', 'CREATED', 'SCHEDULED'].includes(v)) return 'queued';
  if (['AWAITING_APPROVAL', 'PROPOSED', 'BLOCKED'].includes(v)) return 'needs';
  if (['PAUSED'].includes(v)) return 'paused';
  if (['EXPIRED'].includes(v)) return 'stale';
  if (['FAILED', 'LOST', 'ERROR'].includes(v)) return 'failed';
  if (['SUCCEEDED', 'CONFIRMED', 'DONE', 'COMPLETED', 'FINISHED'].includes(v)) return 'done';
  return 'cancelled';
}

/** A link without its scheme and a trailing slash ("example.com/docs/a"), for the meta line. Pure. */
export function linkPath(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
}

/** The download URL of a media item: the same route without `inline=1` (artifacts are served inline for preview). */
export function mediaDownload(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const rest = url
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== 'inline=1' && p !== '');
  return rest.length === 0 ? url.slice(0, q) : `${url.slice(0, q)}?${rest.join('&')}`;
}

/** The tab's images for the grid and the lightbox (items without a URL are not images that can be shown). Pure. */
export function mediaImages(
  items: readonly ChatAsset[],
  meta: (a: ChatAsset) => string,
  onJump: ((a: ChatAsset) => void) | null,
): { readonly asset: ChatAsset; readonly image: LightboxImage }[] {
  return items.flatMap((a) =>
    a.url === null
      ? []
      : [
          {
            asset: a,
            image: {
              src: a.url,
              name: a.label,
              download: mediaDownload(a.url),
              sizeBytes: a.sizeBytes,
              meta: meta(a),
              onShowInChat:
                a.messageId === null || onJump === null
                  ? null
                  : () => {
                      onJump(a);
                    },
            },
          },
        ],
  );
}

const ROW_ACTION =
  'dy-press grid size-11 shrink-0 place-items-center rounded-[8px] text-dy-muted outline-none focus-visible:ring-2 focus-visible:ring-dy-teal sm:size-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink';

/** The meta line: short parts separated by a middle dot, the whole line truncated with its text as the tooltip. */
function Meta(props: {
  readonly parts: readonly (ReactNode | null)[];
  readonly title?: string | undefined;
}): ReactNode {
  const parts = props.parts.filter((p) => p !== null && p !== '');
  if (parts.length === 0) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-[0.75rem] text-dy-faint"
      title={props.title}
      data-testid="details-meta"
    >
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {p}
        </Fragment>
      ))}
    </span>
  );
}

/** One row of a list tab: icon tile, name, meta line, actions. */
function Row(props: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly meta: ReactNode;
  readonly actions: ReactNode;
}): ReactNode {
  return (
    <li className="flex min-w-0 items-start gap-3 px-3 py-2.5" data-testid="sidebar-item">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[8px] bg-dy-sunk text-dy-muted"
      >
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {props.title}
        {props.meta}
      </span>
      <span className="-mr-1 flex shrink-0 items-center gap-0.5 self-center">{props.actions}</span>
    </li>
  );
}

function Item(props: {
  readonly a: ChatAsset;
  readonly all: boolean;
  readonly onJump: (a: ChatAsset) => void;
}): ReactNode {
  const t = useT();
  const d = t.chat.details;
  const f = useFormat();
  const kinds: Readonly<Record<string, string>> = d.draftKinds;
  const a = props.a;
  const when = (
    <time key="when" dateTime={a.createdAt} title={absoluteText(a.createdAt, f)} className="shrink-0">
      {shortTime(a.createdAt, new Date(), f)}
    </time>
  );
  const where = props.all ? (
    <span key="where" className="min-w-0 truncate" title={a.threadTitle}>
      {a.threadTitle}
    </span>
  ) : null;
  const jump =
    a.messageId === null ? null : (
      <button
        type="button"
        onClick={() => {
          props.onJump(a);
        }}
        className={ROW_ACTION}
        aria-label={d.showInChatLabel({ label: a.label.slice(0, 80) })}
        title={d.showInChat}
      >
        <DyIcon name="msg" className="size-4" />
      </button>
    );
  const name = (text: string, clamp = false): ReactNode => (
    <span
      className={cx(
        'min-w-0 text-[0.84375rem] text-dy-ink',
        clamp ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'truncate',
      )}
      title={text}
    >
      {text}
    </span>
  );
  if (a.kind === 'starred')
    return (
      <Row
        icon={<ChatIcon name="star" filled className="size-4 text-dy-amber" />}
        title={name(a.label, true)}
        meta={<Meta parts={[a.role === 'user' ? d.you : t.shared.speaker.assistant, when, where]} />}
        actions={jump}
      />
    );
  if (a.kind === 'links')
    return (
      <Row
        icon={<ChatIcon name="link" className="size-4" />}
        title={
          a.url !== null ? (
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="min-w-0 truncate text-[0.84375rem] font-bold text-dy-ink underline-offset-2 hover:underline"
              title={a.url}
              aria-label={d.openLink({ url: a.domain ?? a.url })}
            >
              {a.domain ?? a.url}
            </a>
          ) : (
            name(a.domain ?? a.label)
          )
        }
        meta={
          <Meta
            parts={[
              a.url === null ? null : (
                <span key="path" className="min-w-0 truncate font-dy-mono">
                  {linkPath(a.url)}
                </span>
              ),
              when,
              where,
            ]}
            title={a.url ?? undefined}
          />
        }
        actions={jump}
      />
    );
  if (a.kind === 'files')
    return (
      <Row
        icon={<DyIcon name="file" className="size-4" />}
        title={name(a.label)}
        meta={
          <Meta
            parts={[
              a.source === null ? (a.detail ?? null) : d.source[a.source],
              a.sizeBytes === null ? null : (
                <span key="size" className="shrink-0 tabular-nums">
                  {f.bytes(a.sizeBytes)}
                </span>
              ),
              when,
              where,
            ]}
          />
        }
        actions={
          <>
            {a.url !== null ? (
              <a
                href={a.url}
                download={a.label}
                className={ROW_ACTION}
                aria-label={d.downloadLabel({ name: a.label })}
                title={d.download}
              >
                <DyIcon name="tray" className="size-4" />
              </a>
            ) : null}
            {jump}
          </>
        }
      />
    );
  const state = a.state ?? a.draftState;
  return (
    <Row
      icon={<ChatIcon name="list" className="size-4" />}
      title={name(a.label)}
      meta={
        <span className="flex min-w-0 flex-col gap-1">
          <Meta
            parts={[
              <span key="kind" className="shrink-0">
                {kinds[a.draftKind ?? ''] ?? KIND_LABEL[a.draftKind ?? ''] ?? d.draft}
              </span>,
              a.detail === null ? null : (
                <span key="detail" className="min-w-0 truncate" title={a.detail}>
                  {a.detail}
                </span>
              ),
              when,
            ]}
          />
          {state === null && !props.all ? null : (
            <span className="flex min-w-0 items-center gap-2 text-[0.75rem] text-dy-faint">
              {state === null ? null : <StateBadge state={assetState(state)} />}
              {where}
            </span>
          )}
        </span>
      }
      actions={
        <>
          {a.href !== null ? (
            <Link to={a.href} className={ROW_ACTION} aria-label={d.open} title={d.open}>
              <ChatIcon name="chevr" className="size-4" />
            </Link>
          ) : null}
          {jump}
        </>
      }
    />
  );
}

/** Loading: placeholders in the shape of the tab's content (rows or tiles), so nothing jumps when it arrives. */
function TabSkeleton(props: { readonly media: boolean; readonly label: string }): ReactNode {
  return (
    <div
      role="status"
      aria-label={props.label}
      aria-busy="true"
      data-dy-skeleton=""
      data-testid="details-skeleton"
      className="dy-breathe"
    >
      {props.media ? (
        <span aria-hidden="true" className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="block aspect-square rounded-[10px] bg-dy-line/80" />
          ))}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="block divide-y divide-dy-line overflow-hidden rounded-[12px] border border-dy-line"
        >
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 size-8 shrink-0 rounded-[8px] bg-dy-line/80" />
              <span className="grid min-w-0 flex-1 gap-2 pt-1">
                <span
                  className={cx('block h-3 rounded-full bg-dy-line/80', i % 2 === 0 ? 'w-3/4' : 'w-1/2')}
                />
                <span className="block h-2.5 w-1/3 rounded-full bg-dy-line/80" />
              </span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function EmptyState(props: { readonly icon: ChatIconName; readonly text: string }): ReactNode {
  return (
    <div
      data-testid="details-empty"
      data-dy-empty=""
      className="flex flex-col items-center gap-3 px-6 py-10 text-center"
    >
      <span
        aria-hidden="true"
        className="grid size-12 place-items-center rounded-full bg-dy-sunk text-dy-faint"
      >
        <ChatIcon name={props.icon} className="size-6" />
      </span>
      <p className="m-0 max-w-[16rem] text-[0.8125rem] text-dy-muted">{props.text}</p>
    </div>
  );
}

/** Görseller: the thumbnail grid and the lightbox over the tab's images. */
function MediaTab(props: {
  readonly items: readonly ChatAsset[];
  readonly all: boolean;
  readonly label: string;
  readonly onJump: (a: ChatAsset) => void;
}): ReactNode {
  const f = useFormat();
  const [zoom, setZoom] = useState<number | null>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = mediaImages(
    props.items,
    (a) =>
      [props.all ? a.threadTitle : null, shortTime(a.createdAt, new Date(), f)]
        .filter((s): s is string => s !== null && s !== '')
        .join(' · '),
    props.onJump,
  );
  const images = list.map((x) => x.image);
  return (
    <>
      <DyImageGrid
        images={images}
        cols={3}
        label={props.label}
        onOpen={setZoom}
        buttonRef={(i, el) => {
          thumbs.current[i] = el;
        }}
      />
      <DyLightbox
        images={images}
        index={zoom}
        onIndex={setZoom}
        wrap={false}
        returnFocus={(i) => thumbs.current[i] ?? null}
        onClose={() => {
          setZoom(null);
        }}
      />
    </>
  );
}

export function DetailsPanel(props: {
  readonly threadId: string | null;
  readonly onClose: () => void;
  readonly onJump: (a: ChatAsset) => void;
  /** p12-diyalog-cmdk: open / leaving (usePresence in SohbetScreen) and the element its exit is measured on. */
  readonly state?: PresenceState | undefined;
  readonly panelRef?: RefObject<HTMLElement | null> | undefined;
  /** p18-plan-mode: docked under the details (the plan, ≥ 64 rem). */
  readonly bottom?: ReactNode;
  /** p18-plans-ui: the conversation's active plan (null: none; undefined: not loaded yet) and "Planı aç". */
  readonly plan?: Plan | null | undefined;
  readonly onOpenPlan?: (() => void) | undefined;
  /** p18-plans-ui: show this plan (a link from the Planlar screen): the Planlar tab opens on it. */
  readonly planRequest?: { readonly id: string; readonly n: number } | null | undefined;
  /** p18-plans-ui: the conversation's watches (the Takipler badge). */
  readonly watchCount?: number | undefined;
}): ReactNode {
  const sayError = useErrorText();
  const tc = useT().chat;
  const d = tc.details;
  const base = useId();
  const tw = useT().watches.panel;
  const tp = useT().plan.tab;
  const [tab, setTab] = useRememberedState<TabId>(TAB_KEY, 'starred');
  // A plan link (the Planlar screen) opens the Planlar tab.
  const reqN = props.planRequest?.n ?? 0;
  useEffect(() => {
    if (reqN > 0) setTab('plans');
  }, [reqN, setTab]);
  const [allMine, setAllMine] = useState(props.threadId === null);
  const scope = allMine || props.threadId === null ? null : props.threadId;
  const watchesTab = tab === 'watches';
  const plansTab = tab === 'plans';
  const assetTab = !watchesTab && !plansTab;
  const { items, error, next, more, loadMore } = useAssets(assetTab ? tab : 'starred', scope, assetTab);
  const tabs: readonly { readonly id: TabId; readonly icon: ReactNode }[] = [
    ...TABS.map((t) => ({ id: t.id, icon: <ChatIcon name={t.icon} className="size-4" /> })),
    { id: 'watches', icon: <ChatIcon name="bell" className="size-4" /> },
    { id: 'plans', icon: <DyIcon name="flag" className="size-4" /> },
  ];
  const tabLabel = (id: TabId): string =>
    id === 'watches' ? tw.tab : id === 'plans' ? tp.label : d.tabs[id];
  // Small count badges: what waits for the person in the plan, the conversation's watches.
  const plan = props.plan ?? null;
  const planWaiting =
    plan === null ? 0 : openDecisions(plan) + waitingFor(plan).length + (plan.state === 'in_review' ? 1 : 0);
  const badges: Partial<
    Record<TabId, { readonly n: number; readonly tone: 'amber' | 'muted'; readonly text: string }>
  > = {
    ...(planWaiting > 0
      ? { plans: { n: planWaiting, tone: 'amber', text: tp.badge({ n: planWaiting }) } }
      : {}),
    ...(props.watchCount !== undefined && props.watchCount > 0
      ? { watches: { n: props.watchCount, tone: 'muted', text: `${tw.tab}: ${String(props.watchCount)}` } }
      : {}),
  };
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
  }, []);
  const pick = (i: number): void => {
    const t = tabs[i];
    if (t === undefined) return;
    setTab(t.id);
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const n = nextTab(
      tabs.findIndex((t) => t.id === tab),
      tabs.length,
      e.key,
    );
    if (n === null) return;
    e.preventDefault();
    pick(n);
    tabRefs.current[n]?.focus();
  };
  const label = tabLabel(tab);
  const icon: ChatIconName = TABS.find((t) => t.id === tab)?.icon ?? 'list';
  // Items that can be shown: media without a URL are left out of the grid (and so count as none).
  const shown = items === null ? null : tab === 'media' ? items.filter((a) => a.url !== null) : items;
  return (
    <aside
      ref={props.panelRef}
      {...presenceProps({ state: props.state ?? 'open' })}
      data-side="right"
      id="dy-details"
      aria-label={d.region}
      data-testid="dy-details"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onClose();
        }
      }}
      // Phones: a full-screen sheet from the right edge. From lg: a column under the conversation header (sticky
      // below it, as tall as the window minus the header), beside the thread — the header keeps the full width.
      className="dy-surface dy-m-column dy-m-drawer-right fixed inset-0 z-40 flex min-h-0 flex-col bg-dy-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:sticky lg:top-[var(--dy-sohbet-head,57px)] lg:z-auto lg:h-[calc(100dvh-var(--dy-sohbet-head,57px))] lg:w-[320px] lg:shrink-0 lg:border-l lg:border-dy-line lg:p-0 xl:w-[352px]"
    >
      <div className="dy-m-inner flex min-h-0 w-full flex-1 flex-col lg:w-[320px] lg:min-w-[320px] xl:w-[352px] xl:min-w-[352px]">
        {/* The header and the tab bar stay put; only the list under them scrolls (one divider line between). */}
        <div
          className="flex shrink-0 flex-col gap-1 border-b border-dy-line px-4 pt-2 pb-2"
          data-testid="details-head"
        >
          {/* p18-plans-ui: no heading — the tab grid starts at the top, the close button ends its first row. */}
          <div className="flex items-start gap-1">
            <div
              role="tablist"
              aria-label={d.title}
              onKeyDown={onTabKey}
              className="-ml-2 grid min-w-0 flex-1 grid-cols-4 gap-1"
              data-testid="details-tabs"
              data-columns={TAB_COLUMNS}
            >
              {tabs.map((t, i) => {
                const selected = t.id === tab;
                const badge = badges[t.id];
                const name = tabLabel(t.id);
                const describe = badge === undefined ? undefined : `${base}-badge-${t.id}`;
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabRefs.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`${base}-tab-${t.id}`}
                    aria-selected={selected}
                    aria-controls={`${base}-panel`}
                    aria-describedby={describe}
                    tabIndex={selected ? 0 : -1}
                    title={badge === undefined ? name : `${name} — ${badge.text}`}
                    data-tab-id={t.id}
                    onClick={() => {
                      pick(i);
                    }}
                    className={cx(
                      'dy-press relative flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-[10px] px-0.5 py-1 text-[0.6875rem] leading-tight font-bold outline-none focus-visible:ring-2 focus-visible:ring-dy-teal',
                      selected
                        ? 'bg-dy-ink text-dy-card'
                        : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                    )}
                  >
                    <span aria-hidden="true" className="grid place-items-center">
                      {t.icon}
                    </span>
                    <span className="max-w-full truncate">{name}</span>
                    {badge === undefined ? null : (
                      // The figure is drawn from the attribute (no text node): the tab's name and text stay its word;
                      // the figure is said through aria-describedby.
                      <span
                        aria-hidden="true"
                        data-testid={`details-badge-${t.id}`}
                        data-count={badge.n > 99 ? '99+' : String(badge.n)}
                        className={cx(
                          'absolute top-0.5 right-1 min-w-4 rounded-full px-1 text-center font-dy-mono text-[0.625rem] leading-4 tabular-nums after:content-[attr(data-count)]',
                          badge.tone === 'amber' ? 'bg-dy-amber text-dy-on-fill' : 'bg-dy-sunk text-dy-muted',
                        )}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {/* The badges' words (the tabs' descriptions). */}
            {Object.entries(badges).map(([id, b]) => (
              <span key={id} id={`${base}-badge-${id}`} hidden>
                {b.text}
              </span>
            ))}
            <button
              ref={closeBtn}
              type="button"
              aria-label={d.close}
              onClick={props.onClose}
              className="dy-press -mr-2 grid size-11 shrink-0 place-items-center rounded-[10px] text-dy-muted sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              <ChatIcon name="close" className="size-5" />
            </button>
          </div>
          {plansTab ? null : (
            <label className="flex min-h-11 items-center gap-2.5 text-[0.8125rem] text-dy-muted sm:min-h-8">
              <input
                type="checkbox"
                className="size-4 accent-[var(--dy-teal)]"
                checked={scope === null}
                disabled={props.threadId === null}
                onChange={(e) => {
                  setAllMine(e.target.checked);
                }}
              />
              {d.allMine}
            </label>
          )}
        </div>
        <div
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${tab}`}
          tabIndex={0}
          data-tab={tab}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6 outline-none"
        >
          {watchesTab ? <WatchesPanel threadId={scope} /> : null}
          {plansTab ? (
            <PlanTab
              threadId={props.threadId}
              plan={props.plan}
              onOpen={props.onOpenPlan ?? (() => undefined)}
              request={props.planRequest}
            />
          ) : null}
          {assetTab && error !== null ? (
            <p role="alert" className="m-0 mb-3 text-[0.8125rem] text-dy-red-ink">
              {sayError(error)}
            </p>
          ) : null}
          {!assetTab ? null : shown === null ? (
            error === null ? (
              <TabSkeleton media={tab === 'media'} label={d.tabLoading({ tab: label })} />
            ) : null
          ) : shown.length === 0 ? (
            <EmptyState icon={icon} text={d.empty[tab]} />
          ) : tab === 'media' ? (
            <MediaTab
              key={scope ?? 'all'}
              items={shown}
              all={scope === null}
              label={label}
              onJump={props.onJump}
            />
          ) : (
            <ul
              className="m-0 flex list-none flex-col divide-y divide-dy-line overflow-hidden rounded-[12px] border border-dy-line bg-dy-card p-0"
              aria-label={label}
              data-testid="details-list"
            >
              {shown.map((a) => (
                <Item key={a.key} a={a} all={scope === null} onJump={props.onJump} />
              ))}
            </ul>
          )}
          {assetTab && items !== null && next !== null ? (
            <button
              type="button"
              disabled={more}
              onClick={loadMore}
              className="dy-press mt-3 flex min-h-11 w-full items-center justify-center rounded-[10px] border border-dy-line-2 bg-dy-card text-[0.8125rem] font-medium text-dy-muted disabled:opacity-50 sm:min-h-9"
            >
              {more ? tc.loading : d.loadMore}
            </button>
          ) : null}
        </div>
        {props.bottom}
      </div>
    </aside>
  );
}
