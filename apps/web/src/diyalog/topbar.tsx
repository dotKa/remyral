import { ThemeSwitch } from './ThemeSwitch';
import { useErrorText } from '../i18n/errors';
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
import { Link, useNavigate } from 'react-router';
import type { SessionInfo } from '../api/auth';
import { ApiError } from '../api/client';
import {
  type AppNotification,
  listNotifications,
  markAllRead,
  markRead,
  type Severity,
} from '../api/notifications';
import { useAuth } from '../auth/AuthProvider';
import { useFormat, useT } from '../i18n/I18nProvider';
import { cx } from '../components/ui';
import { DyConfirm } from './common/actions';
import { DyApiError } from './common/notices';
import { PUSH_EVENT } from '../pwa/serviceWorker';
import { useSubmit } from '../screens/useSubmit';
import { POLL_MS } from '../shell/notificationPoll';
import { useCoolifyLinks } from '../shell/OpenCoolify';
import { formatRelativeUnit, type Formatter, type Locale, type Messages } from '@remyral/i18n';
import { DyIcon } from './icons';
import { DyPopover } from './Popover';
import { remember, remembered } from '../lib/remembered';
import { OPEN_BELL_EVENT, publishNotificationPage } from '../lib/notificationFeed';

/**
 * p12-diyalog-parity (§13.5): the classic header's notification bell and account menu in the Diyalog language — the
 * same behaviour as `shell/NotificationBell.tsx` and `shell/AccountMenu.tsx`:
 *   bell     unread badge (99+), polled every 30 s while visible, on becoming visible and when a push arrives; the
 *            panel lists the latest page (severity mark + word for screen readers, unread bold, relative time),
 *            opening an item marks it read and goes to its in-app link, "Tümünü okundu say", "Daha fazla", empty /
 *            loading / error states, the settings link; Escape and outside click close it, focus returns;
 *   account  user name + role, the session's timing (type, signed in, idle timeout, ends, step-up, recovery codes left;
 *            re-read on open), Open Coolify (owner / admin when configured), Çıkış yap, Her yerden çıkış yap.
 * Titles and bodies are rendered as text.
 */

const PAGE = 20;

const SEVERITY_DOT: Readonly<Record<Severity, string>> = {
  info: 'bg-dy-faint',
  warning: 'bg-dy-amber',
  critical: 'bg-dy-red',
};

/** "3 dakika önce" / "3 minutes ago" (seconds → days; Turkish unless a locale is given). */
export function timeAgoTr(iso: string, now: number = Date.now(), locale: Locale = 'tr'): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return formatRelativeUnit(locale, s, 'second');
  if (abs < 3600) return formatRelativeUnit(locale, Math.round(s / 60), 'minute');
  if (abs < 86_400) return formatRelativeUnit(locale, Math.round(s / 3600), 'hour');
  return formatRelativeUnit(locale, Math.round(s / 86_400), 'day');
}

/** Escape and outside pointer close a disclosure; Escape returns focus to its button. */
function useDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLDivElement | null>,
  button: RefObject<HTMLButtonElement | null>,
  panel?: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close();
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent): void => {
      // p12-diyalog-cmdk: the panel renders in a portal (DyPopover) — a click inside it is not outside.
      if (
        root.current &&
        e.target instanceof Node &&
        !root.current.contains(e.target) &&
        panel?.current?.contains(e.target) !== true
      )
        close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close, root, button, panel]);
}

// p12-diyalog-cmdk: both panels are DyPopovers — placed inside the window from their button (flip / shift / inner
// scroll), a bottom sheet on phones, opening and closing with motion.
const TOOL_BUTTON =
  'dy-press relative grid size-11 place-items-center rounded-[10px] text-dy-muted sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink';

function BellGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="size-5"
    >
      <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

/**
 * p14-web-perf: the bell sits in every screen's top bar, so it remounts on each navigation. It starts from the last
 * page it read (lib/remembered.ts) and skips the immediate re-read when that page is fresh (the 30 s poll goes on).
 */
interface BellMemory {
  readonly at: number;
  readonly latest: readonly AppNotification[];
  readonly next: string | null;
  readonly unread: number;
}
const BELL_KEY = 'bell';
const BELL_FRESH_MS = 10_000;

/** A read here changed the counts: the next mount re-reads instead of trusting the remembered page. */
function staleBell(): void {
  const m = remembered<BellMemory>(BELL_KEY);
  if (m !== undefined) remember(BELL_KEY, { ...m, at: 0 });
}

export function DyNotificationBell(): ReactNode {
  const sayError = useErrorText();
  const [memory] = useState(() => remembered<BellMemory>(BELL_KEY));
  const [open, setOpen] = useState(false);
  const [latest, setLatest] = useState<readonly AppNotification[] | null>(memory?.latest ?? null);
  const [older, setOlder] = useState<readonly AppNotification[]>([]);
  const [next, setNext] = useState<string | null>(memory?.next ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const olderRef = useRef(older);
  olderRef.current = older;
  const [unread, setUnread] = useState(memory?.unread ?? 0);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const t = useT().shell.bell;
  const { locale } = useFormat();
  const readFailed = t.readFailed;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const page = await listNotifications({ limit: PAGE });
      // p17-toasts-shortcuts: the new-notification preview reads the same page (no second poll).
      publishNotificationPage(page.items);
      setLatest(page.items);
      if (olderRef.current.length === 0) setNext(page.nextCursor);
      setUnread(page.unreadCount);
      setError(null);
      remember(BELL_KEY, {
        at: Date.now(),
        latest: page.items,
        next: page.nextCursor,
        unread: page.unreadCount,
      } satisfies BellMemory);
    } catch (err) {
      // Background polling never signs anyone out; the next navigation surfaces an ended session.
      setError(err instanceof ApiError ? sayError(err) : readFailed);
    }
  }, [readFailed]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (next === null) return;
    setLoadingMore(true);
    try {
      const page = await listNotifications({ limit: PAGE, cursor: next });
      setOlder((list) => [...list, ...page.items]);
      setNext(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? sayError(err) : readFailed);
    } finally {
      setLoadingMore(false);
    }
  }, [next, readFailed]);

  const items = useMemo(() => {
    if (latest === null) return null;
    const seen = new Set(latest.map((n) => n.id));
    return [...latest, ...older.filter((n) => !seen.has(n.id))];
  }, [latest, older]);

  const freshAtMount = useRef(memory !== undefined && Date.now() - memory.at < BELL_FRESH_MS);
  useEffect(() => {
    if (freshAtMount.current) freshAtMount.current = false;
    else void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onPush = (): void => {
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(PUSH_EVENT, onPush);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(PUSH_EVENT, onPush);
    };
  }, [refresh]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismiss(open, close, root, button, panel);
  // p17-toasts-shortcuts: "Bildirimleri göster" on a grouped notification preview opens this list.
  useEffect(() => {
    const onOpen = (): void => {
      setOpen(true);
    };
    window.addEventListener(OPEN_BELL_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_BELL_EVENT, onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function openItem(n: AppNotification): Promise<void> {
    if (n.readAt === null) {
      try {
        const r = await markRead(n.id);
        setUnread(r.unreadCount);
        staleBell();
        const mark = (x: AppNotification): AppNotification =>
          x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x;
        setLatest((prev) => prev?.map(mark) ?? prev);
        setOlder((prev) => prev.map(mark));
      } catch {
        // Navigation still works; the item stays unread.
      }
    }
    if (n.link) {
      setOpen(false);
      void navigate(n.link);
    }
  }

  async function readAll(): Promise<void> {
    try {
      await markAllRead();
      setUnread(0);
      staleBell();
      const mark = (x: AppNotification): AppNotification =>
        x.readAt ? x : { ...x, readAt: new Date().toISOString() };
      setLatest((prev) => prev?.map(mark) ?? prev);
      setOlder((prev) => prev.map(mark));
    } catch (err) {
      setError(err instanceof ApiError ? sayError(err) : t.markFailed);
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread > 0 ? t.withUnread({ n: unread }) : t.title}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className={TOOL_BUTTON}
        data-testid="dy-bell"
      >
        <BellGlyph />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute top-0.5 right-0.5 min-w-[18px] rounded-full bg-dy-red px-1 text-center font-dy-mono text-[10.5px] leading-[18px] font-medium text-dy-on-fill tabular-nums"
          >
            {unread > 99 ? '99+' : String(unread)}
          </span>
        ) : null}
      </button>
      <DyPopover
        open={open}
        anchorRef={button}
        panelRef={panel}
        onDismiss={() => {
          close();
          button.current?.focus();
        }}
        id={panelId}
        role="region"
        ariaLabel={t.title}
        contentKey={items === null ? 'loading' : String(items.length)}
        className="flex max-h-[34rem] w-[24rem] flex-col"
        sheetClassName="flex flex-col"
      >
        <div className="flex items-center justify-between gap-2 border-b border-dy-line px-4 py-2.5">
          <h2 className="m-0 text-[0.9375rem] font-extrabold">{t.title}</h2>
          <button
            type="button"
            disabled={unread === 0}
            onClick={() => void readAll()}
            className="min-h-9 text-[0.78125rem] font-bold text-dy-teal-ink disabled:cursor-default disabled:text-dy-faint"
          >
            {t.readAll}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {error === null ? null : (
            <p role="status" className="m-0 px-4 py-3 text-[0.84375rem] text-dy-red-ink">
              {error}
            </p>
          )}
          {items === null ? (
            error === null ? (
              <p className="m-0 px-4 py-6 text-[0.84375rem] text-dy-faint" role="status">
                {t.loading}
              </p>
            ) : null
          ) : items.length === 0 ? (
            <p className="m-0 px-4 py-6 text-[0.84375rem] text-dy-muted">{t.empty}</p>
          ) : (
            <ul className="m-0 list-none p-0" aria-label={t.listLabel}>
              {items.map((n) => (
                <li key={n.id} className="border-b border-dy-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void openItem(n)}
                    className={cx(
                      'flex w-full gap-3 px-4 py-3 text-left [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                      n.readAt === null && 'bg-dy-teal-soft/40',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cx('mt-1.5 size-2 shrink-0 rounded-full', SEVERITY_DOT[n.severity])}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="sr-only">
                        {t.itemPrefix({ severity: t.severity[n.severity], unread: n.readAt === null })}
                      </span>
                      <span
                        className={cx(
                          'block text-[0.875rem]',
                          n.readAt === null ? 'font-bold' : 'font-medium',
                        )}
                      >
                        {n.title}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[0.78125rem] text-dy-muted">
                        {n.body}
                      </span>
                      <span className="mt-1 block text-[0.75rem] text-dy-faint">
                        <time dateTime={n.createdAt}>{timeAgoTr(n.createdAt, Date.now(), locale)}</time>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {items !== null && next !== null ? (
            <div className="border-t border-dy-line px-4 py-2">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="inline-flex min-h-11 w-full items-center justify-center text-[0.84375rem] font-bold text-dy-teal-ink disabled:text-dy-faint sm:min-h-9"
              >
                {loadingMore ? t.loadingMore : t.more}
              </button>
            </div>
          ) : null}
        </div>
        <div className="border-t border-dy-line px-4 py-2.5">
          <Link
            to="/settings/notifications"
            onClick={() => {
              setOpen(false);
            }}
            className="text-[0.78125rem] font-bold text-dy-teal-ink"
          >
            {t.settings}
          </Link>
        </div>
      </DyPopover>
    </div>
  );
}

function When(props: { readonly iso: string; readonly short?: boolean }): ReactNode {
  const format = useFormat();
  const d = new Date(props.iso);
  if (Number.isNaN(d.getTime())) return <span>—</span>;
  return <time dateTime={props.iso}>{props.short === true ? format.time(d) : format.dateTime(d)}</time>;
}

function stepUpText(s: SessionInfo, t: Messages['shell']['account'], format: Formatter): ReactNode {
  if (s.stepUpScope === 'session')
    return s.stepUpValidUntil ? (
      <span>
        {t.stepUpSession}
        <span className="block text-[0.75rem] text-dy-faint">{t.stepUpSessionNote}</span>
      </span>
    ) : (
      <span>{t.stepUpSessionPending}</span>
    );
  return s.stepUpValidUntil ? (
    <span>
      <time dateTime={s.stepUpValidUntil}>
        {t.stepUpValidUntil({ time: format.time(s.stepUpValidUntil) })}
      </time>
    </span>
  ) : (
    <span>{t.stepUpNotRecent}</span>
  );
}

export function DyAccountMenu(): ReactNode {
  const { state, actions } = useAuth();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const submit = useSubmit();
  const coolifyLinks = useCoolifyLinks();
  const t = useT().shell.account;
  const format = useFormat();
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismiss(open, close, root, button, panel);
  useEffect(() => {
    if (open) void actions.refreshSession().catch(() => undefined);
  }, [open, actions]);
  if (state.kind !== 'signedIn') return null;
  const { user, session } = state;
  const rows: [string, ReactNode][] =
    session === null
      ? []
      : [
          [t.sessionType, session.type === 'remembered' ? t.remembered : t.standard],
          [t.signedIn, <When key="c" iso={session.createdAt} />],
          [t.idle, <When key="i" iso={session.idleExpiresAt} short={session.type !== 'remembered'} />],
          [t.ends, <When key="e" iso={session.expiresAt} />],
          [t.stepUp, <span key="s">{stepUpText(session, t, format)}</span>],
        ];
  if (state.remainingRecoveryCodes !== null)
    rows.push([t.recoveryLeft, String(state.remainingRecoveryCodes)]);
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o);
        }}
        data-testid="dy-account"
        className="dy-press flex min-h-11 items-center gap-2 rounded-[10px] px-2 text-[0.875rem] text-dy-ink sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full bg-dy-me text-[0.6875rem] font-extrabold text-dy-me-ink uppercase"
        >
          {user.username.slice(0, 1)}
        </span>
        <span className="max-w-32 truncate font-bold" data-testid="account-username">
          {user.username}
        </span>
        <span className="hidden rounded-full bg-dy-sunk px-2 text-[0.6875rem] font-medium text-dy-muted sm:inline">
          {user.role}
        </span>
        <DyIcon name="chev" className="size-3.5 text-dy-faint" />
        <span className="sr-only">{t.menu}</span>
      </button>
      <DyPopover
        open={open}
        anchorRef={button}
        panelRef={panel}
        onDismiss={() => {
          close();
          button.current?.focus();
        }}
        id={panelId}
        role="region"
        ariaLabel={t.region}
        contentKey={rows.length === 0 ? 'loading' : 'ready'}
        className="flex w-[21rem] flex-col gap-3 p-4"
        sheetClassName="flex flex-col gap-3 p-4"
      >
        <div>
          <p className="m-0 text-[0.9375rem] font-extrabold">{user.username}</p>
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.role({ role: user.role })}</p>
        </div>
        {rows.length === 0 ? (
          <p className="m-0 text-[0.84375rem] text-dy-faint">{t.loading}</p>
        ) : (
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.84375rem]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-dy-muted">{k}</dt>
                <dd className="m-0 tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {/* p17-remyral-brand: the light / dark switch. */}
        <ThemeSwitch compact />
        <div className="flex flex-col gap-2">
          {coolifyLinks.map((l) => (
            <a
              key={l.key}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={l.testId}
              className="dy-press inline-flex min-h-11 items-center justify-center rounded-[10px] border border-dy-line-2 px-2 text-center text-[0.875rem] font-bold text-dy-ink no-underline sm:min-h-9"
            >
              {t.openCoolify({ label: l.label })}
              <span className="sr-only">{t.newTab}</span>
            </a>
          ))}
          <button
            type="button"
            disabled={submit.busy}
            onClick={() => void submit.run(() => actions.logout())}
            className="dy-press inline-flex min-h-11 items-center justify-center rounded-[10px] border border-dy-line-2 bg-dy-card text-[0.875rem] font-bold text-dy-ink disabled:opacity-50 sm:min-h-9"
          >
            {t.logout}
          </button>
          <DyConfirm
            label={t.logoutAll}
            question={t.logoutAllQuestion}
            confirmLabel={t.logoutAllConfirm}
            disabled={submit.busy}
            testId="topbar-logout-all"
            className="w-full"
            onConfirm={() => void submit.run(() => actions.logoutAll())}
          />
          {/* The master's error and the Retry-After countdown (the one Diyalog API error band). */}
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        </div>
      </DyPopover>
    </div>
  );
}

/** The right end of every Diyalog top bar: the bell and the account menu. */
export function DyHeaderTools(props: { readonly className?: string | undefined }): ReactNode {
  return (
    <div className={cx('flex items-center gap-1', props.className)} data-testid="dy-header-tools">
      <DyNotificationBell />
      <DyAccountMenu />
    </div>
  );
}
