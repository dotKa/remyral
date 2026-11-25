import { type ReactNode, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import type { Messages } from '@remyral/i18n';
import { useAuth } from '../auth/AuthProvider';
import { useIdeInbox } from './code/ideInbox';
import { useDocumentLang, useT } from '../i18n/I18nProvider';
import { DiyalogTextScope } from '../i18n/scope';
import { DyDialog } from './DyDialog';
import { cx } from '../components/ui';
import { PwaBridge } from '../pwa/PwaBridge';
import { isFullHeightRoute, useVisualViewportHeight } from '../shell/viewport';
import { badgeText, type NavBadges, useNavBadges, useUnreadTitle } from '../shell/navBadges';
import { type Section, SECTIONS } from '../shell/sections';
import { useShortcuts } from '../shell/shortcuts';
import { useNotificationSound } from '../sound/useNotificationSound';
import { StepUpProvider } from '../stepup/StepUpProvider';
import { chatRouteId } from './chat/route';
import { useKeyboardInset } from './chat/viewport';
import { isNeedsHash, NEEDS_PATH } from './ops/anchors';
import { ThemeSync } from '../theme/theme';
import { BrandSymbol } from './Brand';
import { DyIcon, type IconName } from './icons';
import { paletteKeyLabel, usePaletteShortcut } from './palette/shortcut';
import { PaletteOpener } from './palette/opener';
import { usePaletteIndex } from './palette/sources';
import { DyShortcuts, DyUpdateBanner, RailClock } from './ShellExtras';
import { DyServerUpdateBanner } from './onboarding/UpdateBanner';
import { ChatIcon } from './chat/icons';
import { diyalogScreen } from './screens/routes';
import { DyStepUpDialog } from './DyStepUpDialog';
import { DyToaster } from './toast/DyToaster';
import { useNotificationPreview } from './toast/notificationPreview';
import { DyNotFound, NotFoundReport } from './screens/NotFound';
import { RouteBoundary } from '../lib/RouteBoundary';
import { lazyScreen } from '../lib/lazyScreen';
import { DyRouteFailed, DyRouteLoading } from './RouteFallback';
import {
  DIYALOG_HOME as DiyalogHome,
  DIYALOG_JOB as DiyalogJob,
  DIYALOG_SOHBET as SohbetScreen,
  preloadDiyalogPath,
  usePreloadMainRoutes,
} from './preload';

// p14-web-perf: the shell's own screens load on demand (preload.ts starts them early and on rail intent).
const DySsoContinue = lazyScreen(() => import('./screens/SsoContinue'), 'DySsoContinue');
// p14-web-perf-2: the palette body in its own chunk — fetched when the shell is idle, mounted at the first open.
const CommandPalette = lazyScreen(() => import('./palette/CommandPalette'), 'CommandPalette');
const SHELL_PRELOADS = [CommandPalette.preload];

/**
 * p12-diyalog Faz 0: the Diyalog shell (docs/design/p12-diyalog.md §4) — since p15-classic-removal the only signed-in
 * frame. Left: a slim navigation rail (icons + counters; a bottom bar on phones). Centre: `/` is the Home panel
 * dashboard (DiyalogHome), `/chat*` the Sohbet screen, `/jobs/:id` the job control panel, every other screen comes
 * from `screens/routes.tsx`; a path none of them owns renders the route table's element (a redirect of a moved URL,
 * or the catch-all that reports "Sayfa bulunamadı"). Around the screens: step-up, PWA bridge, notification sound,
 * unread title, shortcuts — and (p17-toasts-shortcuts) the toasts with the new-notification preview.
 */

interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly to: string;
  readonly hash?: string | undefined;
  /** Counter shown on the icon, and its spoken unit. */
  readonly count?: number | undefined;
  readonly unit?: string | undefined;
  readonly active: (pathname: string) => boolean;
}

const under =
  (p: string) =>
  (pathname: string): boolean =>
    pathname === p || pathname.startsWith(`${p}/`);

/** The rail / phone-bar items in the current language (i18n Phase 1: labels from the `nav` catalog). */
function navItems(badges: NavBadges, t: Messages['nav']): readonly NavItem[] {
  const decisions = (badges['/approvals'] ?? 0) + (badges['/machines'] ?? 0) + (badges['/questions'] ?? 0);
  return [
    // p12-diyalog panels (2026-10-19): Home is the panel dashboard and the first item; Sohbet is its own screen.
    { key: 'home', label: t.home, icon: 'home', to: '/', active: (p) => p === '/' },
    {
      key: 'thread',
      label: t.chat,
      icon: 'bubble',
      // p12-diyalog Faz 3: Sohbet is its own screen (/chat); the home becomes the panel.
      to: '/chat',
      count: badges['/chat'] ?? 0,
      unit: t.unit.unread,
      active: under('/chat'),
    },
    // p17-needs-page: "Senden bekleyen" is its own page (it was a section at the top of the home).
    {
      key: 'needs',
      label: t.needs,
      icon: 'shield',
      to: NEEDS_PATH,
      count: decisions,
      unit: t.unit.waiting,
      active: (p) => under(NEEDS_PATH)(p) || under('/approvals')(p),
    },
    // p18-plans-ui: every plan of the person, their states at a glance (under "Senden bekleyen").
    { key: 'plans', label: t.plans, icon: 'flag', to: '/plans', active: under('/plans') },
    // Owner, 2026-10-19: no "Yeni iş" item — İşler has its "Yeni iş" button (→ /jobs/new) and a request can start in
    // Sohbet; two links to the same place were one too many. The `n` shortcut opens the /jobs/new form (classic).
    { key: 'jobs', label: t.jobs, icon: 'jobs', to: '/jobs', active: under('/jobs') },
    // p13-workflows-ui: the workflow definitions (list, editor), under İşler.
    {
      key: 'workflows',
      label: t.workflows,
      icon: 'branch',
      to: '/workflows',
      active: under('/workflows'),
    },
    // Owner, 2026-10-23: Otomasyonlar on the rail (it was reachable only from "Tümü").
    {
      key: 'automations',
      label: t.automations,
      icon: 'clock',
      to: '/automations',
      active: under('/automations'),
    },
    {
      key: 'machines',
      label: t.machines,
      icon: 'cpu',
      to: '/machines',
      count: badges['/machines'] ?? 0,
      unit: t.unit.pairing,
      active: under('/machines'),
    },
    { key: 'outputs', label: t.outputs, icon: 'tray', to: '/outputs', active: under('/outputs') },
    { key: 'usage', label: t.usage, icon: 'gauge', to: '/usage', active: under('/usage') },
    { key: 'projects', label: t.projects, icon: 'folder', to: '/projects', active: under('/projects') },
  ];
}

function settingsItem(t: Messages['nav']): NavItem {
  return { key: 'settings', label: t.settings, icon: 'gear', to: '/settings', active: under('/settings') };
}

function Counter(props: { readonly n: number | undefined }): ReactNode {
  if (props.n === undefined || props.n <= 0) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="dy-nav-count"
      className="absolute -top-1 left-[calc(50%+4px)] min-w-[18px] rounded-full bg-dy-amber px-1 text-center font-dy-mono text-[10.5px] leading-[18px] font-medium text-dy-on-fill tabular-nums"
    >
      {badgeText(props.n)}
    </span>
  );
}

/**
 * p14-web-perf: a link's screen starts loading as soon as the pointer is over it, it gets focus or a finger touches
 * it — usually well before the click, so the navigation never waits for the chunk.
 */
function preloadOnIntent(to: string): {
  readonly onMouseEnter: () => void;
  readonly onFocus: () => void;
  readonly onTouchStart: () => void;
} {
  const go = (): void => {
    preloadDiyalogPath(to);
  };
  return { onMouseEnter: go, onFocus: go, onTouchStart: go };
}

function ariaFor(item: NavItem, t: Messages['nav']): string {
  return item.count !== undefined && item.count > 0
    ? t.withCount({ label: item.label, n: item.count, unit: item.unit ?? '' })
    : item.label;
}

function RailLink(props: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly phone?: boolean;
}): ReactNode {
  const { item } = props;
  const t = useT().nav;
  const active = item.active(props.pathname);
  return (
    <Link
      to={{ pathname: item.to, hash: item.hash ?? '' }}
      {...preloadOnIntent(item.to)}
      aria-label={ariaFor(item, t)}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      className={cx(
        'dy-press relative flex flex-col items-center justify-center gap-1 rounded-[10px] text-[10.5px] leading-none font-medium no-underline',
        props.phone === true ? 'min-h-14 flex-1 py-1.5' : 'min-h-[50px] w-[78px] shrink-0 py-1.5',
        active
          ? 'bg-dy-card text-dy-ink shadow-dy'
          : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card/60 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
      )}
    >
      <span className="relative">
        <DyIcon name={item.icon} className="size-5" />
      </span>
      {/* p14-diyalog-polish: long names ("Senden bekleyenler", "Workflow’lar") wrap to a second line on the rail
          instead of being cut to "Senden …"; the phone bar keeps one line. p17-remyral-brand: the items are 78 px wide
          (rail 86 px) so the longest single word ("Otomasyonlar", 70 px in Inter 10.5 px) never breaks inside the
          word (TR and EN labels measured in the design note). */}
      <span
        className={cx(
          'max-w-full px-0.5',
          props.phone === true
            ? 'truncate'
            : 'line-clamp-2 text-center leading-[1.15] [overflow-wrap:anywhere]',
        )}
      >
        {item.label}
      </span>
      <Counter n={item.count} />
    </Link>
  );
}

function AllScreensButton(props: {
  readonly onOpen: () => void;
  readonly phone?: boolean;
  /** p12-diyalog-parity: what waits behind "Tümü" (the classic "More" badge: screens not on the phone bar). */
  readonly count?: number | undefined;
}): ReactNode {
  const n = props.count ?? 0;
  const t = useT().nav;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={n > 0 ? t.withCount({ label: t.all, n, unit: t.unit.waiting }) : undefined}
      onClick={props.onOpen}
      className={cx(
        'dy-press relative flex flex-col items-center justify-center gap-1 rounded-[10px] text-[10.5px] leading-none font-medium text-dy-muted',
        props.phone === true ? 'min-h-14 flex-1 py-1.5' : 'h-[50px] w-[78px] shrink-0',
        '[@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
      )}
    >
      <DyIcon name="grid" className="size-5" />
      {t.all}
      <Counter n={n} />
    </button>
  );
}

/** Desktop: slim left rail. */
function NavRail(props: {
  readonly badges: NavBadges;
  readonly onAll: () => void;
  readonly onHelp: () => void;
  readonly onSearch: () => void;
}): ReactNode {
  const { pathname } = useLocation();
  const t = useT().nav;
  return (
    <div className="dy-surface sticky top-0 hidden h-dvh w-[86px] shrink-0 flex-col items-center gap-1 border-r border-dy-line bg-dy-bg py-3 md:flex">
      {/* p17-remyral-brand: the Remyral symbol on its navy tile (the app icon) is the home link. */}
      <Link
        to="/"
        aria-label={t.homeLink}
        data-testid="dy-rail-home"
        className="dy-press mb-2 rounded-[10px]"
      >
        <BrandSymbol className="size-9" />
      </Link>
      {/* p12-diyalog-cmdk: the command palette (also ⌘K / Ctrl+K). */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t.search({ keys: paletteKeyLabel() })}
        aria-keyshortcuts="Meta+K Control+K"
        title={t.searchTitle({ keys: paletteKeyLabel() })}
        onClick={props.onSearch}
        data-testid="dy-palette-button"
        className="dy-press mb-1 flex h-[46px] w-[78px] flex-col items-center justify-center gap-0.5 rounded-[10px] text-[10.5px] leading-none font-medium text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card/60 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
      >
        <DyIcon name="search" className="size-5" />
        <span className="font-dy-mono text-[10px] text-dy-faint">{paletteKeyLabel()}</span>
      </button>
      <nav
        aria-label={t.landmark}
        className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto"
      >
        {navItems(props.badges, t).map((i) => (
          <RailLink key={i.key} item={i} pathname={pathname} />
        ))}
        <div className="mt-auto flex flex-col items-center gap-1 border-t border-dy-line pt-2">
          <RailLink item={settingsItem(t)} pathname={pathname} />
          <AllScreensButton onOpen={props.onAll} />
          <RailClock />
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={t.shortcuts}
            title={t.shortcutsTitle}
            onClick={props.onHelp}
            className="dy-press grid size-9 place-items-center rounded-[10px] text-dy-faint [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card/60 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
          >
            <ChatIcon name="keyboard" className="size-[18px]" />
          </button>
        </div>
      </nav>
    </div>
  );
}

const PHONE_KEYS = new Set(['home', 'thread', 'needs', 'jobs']);

/** Phone: bottom bar (thumb reach) — Ana sayfa, Sohbet, Senden bekleyenler, İşler, Tümü. */
function PhoneNav(props: { readonly badges: NavBadges; readonly onAll: () => void }): ReactNode {
  const { pathname } = useLocation();
  const t = useT().nav;
  return (
    <nav
      aria-label={t.landmark}
      data-bottom-bar
      className="dy-surface fixed inset-x-0 bottom-0 z-10 flex border-t border-dy-line bg-dy-bg/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur-md md:hidden"
    >
      {navItems(props.badges, t)
        .filter((i) => PHONE_KEYS.has(i.key))
        .map((i) => (
          <RailLink key={i.key} item={i} pathname={pathname} phone />
        ))}
      <AllScreensButton onOpen={props.onAll} phone count={props.badges['/machines'] ?? 0} />
    </nav>
  );
}

/**
 * p14-i18n-shell: a classic section's name in the Diyalog language (the classic `SECTIONS` labels stay English for
 * the classic console); an unknown section keeps its classic label.
 */
export function sectionLabel(s: Pick<Section, 'path' | 'label'>, t: Messages['nav']): string {
  const byPath: Readonly<Record<string, string>> = {
    '/': t.home,
    '/chat': t.chat,
    '/needs': t.needs,
    '/plans': t.plans,
    '/jobs': t.jobs,
    '/outputs': t.outputs,
    '/uptime': t.sections.uptime,
    '/automations': t.sections.automations,
    '/approvals': t.sections.approvals,
    '/machines': t.machines,
    '/projects': t.projects,
    '/skills': t.sections.skills,
    '/context': t.sections.context,
    '/usage': t.usage,
    '/audit': t.sections.audit,
    '/settings': t.settings,
  };
  return byPath[s.path] ?? s.label;
}

/** Every section of the console ("Tüm ekranlar"). */
function AllScreens(props: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const all = useT();
  const t = all.shell;
  return (
    <DyDialog open={props.open} onClose={props.onClose} title={t.allScreens.title} size="sm">
      <nav aria-label={t.allScreens.title}>
        <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
          {SECTIONS.map((s) => (
            <li key={s.path}>
              <Link
                to={s.path}
                {...preloadOnIntent(s.path)}
                onClick={props.onClose}
                className="dy-press flex min-h-11 items-center gap-2.5 rounded-[10px] border border-dy-line px-3 text-[0.875rem] font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              >
                <s.icon className="size-5 shrink-0 text-dy-muted" />
                {sectionLabel(s, all.nav)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </DyDialog>
  );
}

/**
 * What the route table renders for a path no Diyalog screen owns: a redirect of a moved URL (`/fleet…`,
 * `/jobs/schedules`, `/settings/projects`) or the catch-all that reports the path as unknown.
 */
function RouteOutlet(): ReactNode {
  return (
    <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
      <PwaBridge />
      <Outlet />
    </main>
  );
}

/** Second path segments under /jobs that are screens (or the `schedules` redirect), not job ids. */
const JOB_SCREENS = new Set(['new', 'templates', 'schedules', 'workflows', 'batches']);

/**
 * p12-diyalog Faz 2: the job id when the route is a job page (`/jobs/:id`) — rendered as the job thread in the Diyalog
 * shell; null for every other route.
 */
export function jobThreadId(pathname: string): string | null {
  const m = /^\/jobs\/([^/]+)\/?$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return id === '' || JOB_SCREENS.has(id) ? null : id;
}

export function DiyalogShell(): ReactNode {
  const badges = useNavBadges();
  useUnreadTitle(badges['/chat'] ?? 0);
  const { state: auth } = useAuth();
  // p14-i18n-foundation: `<html lang>` follows the Diyalog language (the classic shell keeps "en").
  useDocumentLang();
  // p19-ide W2: "Sohbete ekle" from an open Tam IDE tab becomes a pending chat reference here.
  useIdeInbox();
  useNotificationSound(auth.kind === 'signedIn' ? auth.user.id : null);
  useNotificationPreview(auth.kind === 'signedIn' ? auth.user.id : null);
  const { pathname, hash, search } = useLocation();
  const home = pathname === '/';
  // p17-needs-page: the decisions left the home — an old link to them (`/#benden-bekleyen`, `/#kart=approval:<id>`
  // from a bookmark, a notification or "thread'de aç" of an older tab) goes on to `/needs` with the same hash.
  const movedNeeds = home && isNeedsHash(hash);
  const jobId = jobThreadId(pathname);
  // p12-diyalog Faz 3 + parity: `/chat` and `/chat/:id` are the Diyalog Sohbet screen — the conversation list, the
  // header and the details panel (SohbetScreen, §13) around the Faz 3 thread and composer (DiyalogChat, §11).
  const chatId = chatRouteId(pathname);
  // p12-diyalog Faz 4: secondary screens (null = no Diyalog screen owns this path: the route table's element).
  // p12-diyalog-w4: `/sso/continue` (Coolify sign-on) in the Diyalog language.
  const screen =
    home || jobId !== null || chatId !== undefined ? null : pathname === '/sso/continue' ? (
      <DySsoContinue />
    ) : (
      diyalogScreen(pathname)
    );
  // p12-diyalog-w4: the route table's catch-all reports an unknown path; the shell shows "Sayfa bulunamadı" for it.
  const [missing, setMissing] = useState<string | null>(null);
  const notFound = missing === pathname && screen === null && !home && jobId === null && chatId === undefined;
  // p12-diyalog-final: the Sohbet follows the visual viewport (`--app-vh`) and keeps its sticky composer above an iOS
  // on-screen keyboard (`--dy-kb`, chat/viewport.ts); it scrolls the window like the other threads.
  useVisualViewportHeight(isFullHeightRoute(pathname));
  useKeyboardInset(chatId !== undefined);
  const [help, setHelp] = useState(false);
  const [all, setAll] = useState(false);
  usePreloadMainRoutes(SHELL_PRELOADS);
  useShortcuts(() => {
    setHelp(true);
  });
  const openAll = (): void => {
    setAll(true);
  };
  // p12-diyalog-cmdk: the command palette — ⌘K / Ctrl+K, the rail's search button, the phone top-bar search.
  const [palette, setPalette] = useState(false);
  // Mounted from the first open on (it keeps its own state — recent items, the dialog element — afterwards).
  const [paletteMounted, setPaletteMounted] = useState(false);
  if (palette && !paletteMounted) setPaletteMounted(true);
  const togglePalette = useCallback(() => {
    setPalette((o) => !o);
  }, []);
  const openPalette = useCallback(() => {
    setPalette(true);
  }, []);
  usePaletteShortcut(togglePalette);
  const paletteIndex = usePaletteIndex(auth.kind === 'signedIn');
  const skipLabel = useT().shell.skipToContent;
  const { refresh: refreshIndex } = paletteIndex;
  useEffect(() => {
    if (palette) refreshIndex();
  }, [palette, refreshIndex]);
  // Step-up and the shell's dialogs are direct children of the scope root: they take the Diyalog palette (chat.css).
  return (
    <DiyalogTextScope>
      <div data-ui="diyalog" className="bg-dy-bg">
        <StepUpProvider dialog={DyStepUpDialog}>
          <PaletteOpener.Provider value={openPalette}>
            <NotFoundReport value={setMissing}>
              {/* p17-remyral-brand: the account's light / dark choice, also when made on another device. */}
              <ThemeSync />
              <DyUpdateBanner />
              {/* p16-selfhost-onboarding: a newer signed control-plane release (owners). */}
              <DyServerUpdateBanner />
              <a
                href="#main"
                data-touch-exempt
                className="sr-only z-50 rounded-md bg-dy-card px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
              >
                {skipLabel}
              </a>
              <div className="flex min-h-dvh" data-shell="page">
                <NavRail
                  badges={badges}
                  onAll={openAll}
                  onHelp={() => {
                    setHelp(true);
                  }}
                  onSearch={openPalette}
                />
                <RouteBoundary
                  resetKey={pathname}
                  loading={<DyRouteLoading />}
                  failed={(reload) => <DyRouteFailed onReload={reload} />}
                >
                  {movedNeeds ? (
                    <Navigate replace to={{ pathname: NEEDS_PATH, search, hash }} />
                  ) : home ? (
                    <div className="flex min-w-0 flex-1 flex-col">
                      <PwaBridge />
                      <DiyalogHome />
                    </div>
                  ) : chatId !== undefined ? (
                    <div className="flex min-w-0 flex-1 flex-col">
                      <PwaBridge />
                      {/* p12-diyalog-cmdk: not keyed by the conversation — the list stays mounted (data, scroll, open groups)
                      while only the thread reloads. */}
                      <SohbetScreen threadId={chatId} />
                    </div>
                  ) : jobId !== null ? (
                    <div className="flex min-w-0 flex-1 flex-col">
                      <PwaBridge />
                      <DiyalogJob key={jobId} id={jobId} />
                    </div>
                  ) : screen !== null ? (
                    screen
                  ) : notFound ? (
                    <DyNotFound onAll={openAll} />
                  ) : (
                    <RouteOutlet />
                  )}
                </RouteBoundary>
                <PhoneNav badges={badges} onAll={openAll} />
              </div>
              <AllScreens
                open={all}
                onClose={() => {
                  setAll(false);
                }}
              />
              <DyShortcuts
                open={help}
                onClose={() => {
                  setHelp(false);
                }}
              />
              {/* p17-toasts-shortcuts: action results and new-notification previews, bottom right / bottom. */}
              <DyToaster />
              {paletteMounted ? (
                <Suspense fallback={null}>
                  <CommandPalette
                    open={palette}
                    onClose={() => {
                      setPalette(false);
                    }}
                    index={paletteIndex.index}
                    onHelp={() => {
                      setHelp(true);
                    }}
                    onAll={openAll}
                  />
                </Suspense>
              ) : null}
            </NotFoundReport>
          </PaletteOpener.Provider>
        </StepUpProvider>
      </div>
    </DiyalogTextScope>
  );
}
