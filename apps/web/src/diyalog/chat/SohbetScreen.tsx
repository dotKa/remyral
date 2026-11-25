import { useErrorText } from '../../i18n/errors';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  type ChatStatus,
  deleteThread,
  getChatStatus,
  type ThreadDetail,
  updateThread,
} from '../../api/chat';
import type { ChatAsset } from '../../api/chatOrganize';
import type { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { cx, toApiError } from '../../components/ui';
import { invalidate } from '../../lib/invalidate';
import { statusFix } from '../../screens/chat/chatStatus';
import { useSidebarOpen } from '../../screens/chat/organize/sidebar';
import { RenameField, type ThreadAction } from '../../screens/chat/threadActions';
import { usePresence } from '../motion';
import { ASK_STATE_KEY } from '../palette/opener';
import { TopTools } from '../TopTools';
import { ContextStrip } from './ContextStrip';
import { WorkflowLinkBar } from './WorkflowLink';
import { ConversationList } from './ConversationList';
import { FOCUS_COMPOSER_STATE } from '../ops/composerKeys';
import { DiyalogChat } from './DiyalogChat';
import { DetailsPanel } from './DetailsPanel';
import { PLAN_PARAM } from './route';
import { ChatIcon } from './icons';
import { type Pane, PaneFrame, PaneToggle, usePane } from './pane';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { HH_MM } from '../common/time';
import { useRememberedState } from '../../lib/remembered';
import { headerRouting } from '../screens/settings/chat-failover';
import { CostBrakeBanner } from '../ops/CostBrakeBanner';
import { fill } from '@remyral/i18n';
import { exportMarkdownUrl, removeShare } from '../../api/chatComplete';
import { useLocale } from '../../i18n/I18nProvider';
import { chatPrintPath } from './print';
import { ShareDialog, TransferDialog } from './ShareDialogs';
import { usePlanSurface } from '../plan/PlanLayout';

/**
 * p12-diyalog-parity (docs/design/p12-diyalog.md §13.3): the frame of the Diyalog Sohbet screen around the Faz 3
 * thread and composer — conversation list, header, knowledge / watches, details panel.
 */

/** `/chat?yeni=1`: a new conversation ("Yeni sohbet"), created by its first message. */
export const NEW_PARAM = 'yeni';

/** The assistant's state (`GET /chat/status`, every 30 s). */
export function useChatStatus(): { status: ChatStatus | null; error: ApiError | null } {
  // p14-web-perf: a revisit starts from the last status; the poll skips hidden tabs.
  const [status, setStatus] = useRememberedState<ChatStatus | null>('chat:status', null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      getChatStatus().then(
        (s) => {
          if (!live) return;
          setStatus(s);
          setError(null);
        },
        (err: unknown) => {
          if (live) setError(toApiError(err));
        },
      );
    };
    load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [setStatus]);
  return { status, error };
}

/** Engine · model · machine, or why nobody answers with the link that fixes it. */
export function AssistantLine(props: {
  readonly status: ChatStatus | null;
  readonly error: ApiError | null;
}): ReactNode {
  const sayError = useErrorText();
  const fmt = useFormat();
  const t = useT().chat.status;
  const tf = useT().chatFailover;
  if (props.error !== null)
    return (
      <p className="m-0 truncate text-[0.75rem] text-dy-red-ink" role="status">
        {t.readError({ error: sayError(props.error) })}
      </p>
    );
  const s = props.status;
  if (s === null) return null;
  if (!s.available) {
    const fix = statusFix(s);
    // The classic helper names the fix in English; Diyalog says it in the user's language.
    const fixLabel =
      fix.to === '/settings/chat' || s.worker === null
        ? t.fixSettings
        : t.fixMachine({ machine: s.worker.name });
    return (
      <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-[0.75rem] text-dy-amber-ink" role="status">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-dy-amber" />
        <span data-testid="chat-unavailable">{s.message ?? t.unavailable}</span>
        <Link to={fix.to} className="font-bold text-inherit underline underline-offset-2">
          {fixLabel}
        </Link>
      </p>
    );
  }
  const limited =
    s.fallback && s.limit !== null
      ? t.limited({ runtime: s.limit.runtime, time: fmt.dateWith(s.limit.until, HH_MM) })
      : '';
  // p15-chat-failover: which machine answers and why, when it is not the primary.
  const routed = s.routing === null ? null : headerRouting(tf, s.routing, s.primary?.name ?? '');
  const line = `${s.runtime} · ${s.model ?? t.defaultModel}${s.worker !== null ? ` · ${s.worker.name}` : ''}${routed === null ? '' : ` (${routed})`}${limited}`;
  return (
    <p className="m-0 flex min-w-0 items-center gap-1.5 text-[0.75rem] text-dy-muted" title={line}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-dy-green" />
      <span className="sr-only">{t.ready}</span>
      <span className="truncate font-dy-mono" data-testid="chat-status">
        {line}
      </span>
    </p>
  );
}

function DetailsToggle(props: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly toggleRef?: RefObject<HTMLButtonElement | null> | undefined;
}): ReactNode {
  const t = useT().chat.header;
  return (
    <button
      ref={props.toggleRef}
      type="button"
      aria-label={props.open ? t.hideDetails : t.showDetails}
      aria-expanded={props.open}
      aria-controls="dy-details"
      title={t.detailsHint}
      data-testid="sidebar-toggle"
      onClick={props.onToggle}
      className={cx(
        'dy-press grid size-11 shrink-0 place-items-center rounded-[10px] sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card',
        props.open ? 'bg-dy-card text-dy-teal-ink shadow-dy' : 'text-dy-muted',
      )}
    >
      <ChatIcon name="panel" className="size-5" />
    </button>
  );
}

function Header(props: {
  readonly pane: Pane;
  readonly detail: ThreadDetail | null;
  readonly threadId: string | null;
  readonly status: ChatStatus | null;
  readonly statusError: ApiError | null;
  readonly detailsOpen: boolean;
  readonly onDetails: () => void;
  readonly detailsToggleRef?: RefObject<HTMLButtonElement | null> | undefined;
  readonly onChanged: (id: string, action: ThreadAction) => void;
  /** p18-plan-mode: plan mode is on (the "Planlama" badge) and the plan column's toggle (≥ 64 rem). */
  readonly planMode?: boolean | undefined;
  readonly planToggle?: ReactNode;
}): ReactNode {
  const sayError = useErrorText();
  const tc = useT().chat;
  const tp = useT().plan;
  const tx = useT().chatComplete;
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { state: auth } = useAuth();
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // p16-chat-complete: share / hand over dialogs.
  const [dialog, setDialog] = useState<'share' | 'transfer' | null>(null);
  const t = props.detail?.thread ?? null;
  const reader = props.detail?.access === 'reader';
  const ownerName = props.detail?.owner?.username ?? '';
  useEffect(() => {
    setRenaming(false);
    setError(null);
  }, [props.threadId]);
  async function run(fn: () => Promise<unknown>, id: string, action: ThreadAction): Promise<void> {
    try {
      await fn();
      props.onChanged(id, action);
    } catch (err) {
      setError(sayError(err));
    }
  }
  // p16-chat-complete: export (Markdown download, print → PDF) for owner and reader; share / hand over for the owner;
  // a reader can leave.
  const exportItems: RowMenuItem[] =
    t === null
      ? []
      : [
          {
            key: 'export-md',
            label: tx.exporter.markdown,
            icon: 'file',
            onSelect: () => {
              const a = document.createElement('a');
              a.href = exportMarkdownUrl(t.id, locale === 'en' ? 'en' : 'tr');
              a.download = '';
              a.rel = 'noopener';
              document.body.append(a);
              a.click();
              a.remove();
            },
          },
          {
            key: 'export-pdf',
            label: tx.exporter.pdf,
            icon: 'file',
            returnFocus: false,
            onSelect: () => {
              void navigate(chatPrintPath(t.id));
            },
          },
        ];
  const items: RowMenuItem[] =
    t === null
      ? []
      : reader
        ? [
            ...exportItems,
            {
              key: 'leave',
              label: tx.shared.leave,
              icon: 'xc',
              danger: true,
              onSelect: () => {
                if (auth.kind !== 'signedIn') return;
                void run(() => removeShare(t.id, auth.user.id), t.id, 'deleted');
              },
            },
          ]
        : [
            ...exportItems,
            {
              key: 'share',
              label: tx.share.menu,
              chatIcon: 'link',
              returnFocus: false,
              onSelect: () => {
                setDialog('share');
              },
            },
            {
              key: 'transfer',
              label: tx.transfer.menu,
              icon: 'send',
              returnFocus: false,
              onSelect: () => {
                setDialog('transfer');
              },
            },
            {
              key: 'rename',
              label: tc.menu.rename,
              icon: 'pen',
              returnFocus: false,
              onSelect: () => {
                setRenaming(true);
              },
            },
            {
              key: 'archive',
              label: t.archived ? tc.menu.unarchive : tc.menu.archive,
              chatIcon: 'archive',
              onSelect: () => {
                void run(
                  () => updateThread(t.id, { archived: !t.archived }),
                  t.id,
                  t.archived ? 'restored' : 'archived',
                );
              },
            },
            {
              key: 'delete',
              label: tc.delete,
              icon: 'trash',
              danger: true,
              confirm: {
                question: tc.menu.deleteQuestion,
                yes: tc.menu.deleteYes,
                no: tc.cancel,
              },
              onSelect: () => {
                void run(() => deleteThread(t.id), t.id, 'deleted');
              },
            },
          ];
  return (
    <div className="relative z-[2] flex min-h-[57px] flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-dy-line bg-dy-thread/85 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] backdrop-blur-[14px] backdrop-saturate-150 sm:px-4">
      <PaneToggle pane={props.pane} />
      <div className="order-last flex min-w-0 basis-full flex-col gap-0.5 px-1 pb-1 sm:order-none sm:flex-1 sm:basis-0 sm:px-0 sm:pb-0">
        {t !== null && renaming ? (
          <RenameField
            thread={t}
            className="h-9 w-full min-w-0 rounded-[8px] border border-dy-teal bg-dy-card px-2 text-base font-bold text-dy-ink outline-none"
            onError={(e) => {
              setError(sayError(e));
            }}
            onDone={(saved) => {
              setRenaming(false);
              if (saved) props.onChanged(t.id, 'renamed');
            }}
          />
        ) : (
          <h1 className="m-0 flex min-w-0 items-baseline gap-2 text-base font-extrabold tracking-[-0.01em]">
            <span className="truncate">
              {t !== null ? t.title : props.threadId !== null ? tc.title : tc.newChat}
            </span>
            {t?.archived === true ? (
              <span className="shrink-0 text-[0.75rem] font-medium text-dy-faint">{tc.archivedMark}</span>
            ) : null}
            {props.planMode === true ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 self-center rounded-full bg-dy-violet-soft px-2 py-px text-[0.75rem] font-bold text-dy-violet"
                data-testid="dy-plan-badge"
              >
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {tp.badge}
              </span>
            ) : null}
          </h1>
        )}
        {reader ? (
          <p className="m-0 truncate text-[0.75rem] text-dy-muted" data-testid="chat-shared-line">
            {fill(tx.shared.readonly, { owner: ownerName })}
          </p>
        ) : (
          <AssistantLine status={props.status} error={props.statusError} />
        )}
        {error === null ? null : (
          <p role="alert" className="m-0 text-[0.75rem] text-dy-red-ink">
            {error}
          </p>
        )}
      </div>
      <span className="flex-1 sm:hidden" aria-hidden="true" />
      {props.planToggle}
      <DetailsToggle open={props.detailsOpen} onToggle={props.onDetails} toggleRef={props.detailsToggleRef} />
      {t !== null && !renaming ? <RowMenu label={tc.actionsFor({ title: t.title })} items={items} /> : null}
      <TopTools />
      {t === null || reader ? null : (
        <>
          <ShareDialog
            open={dialog === 'share'}
            threadId={t.id}
            onClose={() => {
              setDialog(null);
            }}
          />
          <TransferDialog
            open={dialog === 'transfer'}
            threadId={t.id}
            onClose={() => {
              setDialog(null);
            }}
            onDone={() => {
              setDialog(null);
              props.onChanged(t.id, 'deleted');
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * p12-diyalog-parity: the Sohbet screen — `/chat` (the latest conversation; `?yeni=1` a new one) and `/chat/:id`. The
 * conversation list (a column on wide windows, a drawer otherwise), the header (title, rename, menu, assistant line,
 * details toggle, top-bar tools) with the knowledge / watches strip, the Faz 3 thread and composer (DiyalogChat,
 * embedded) in the centre, the details panel on the right.
 */
export function SohbetScreen(props: { readonly threadId: string | null }): ReactNode {
  const navigate = useNavigate();
  const t = useT().chat;
  const location = useLocation();
  const { search, key: navKey } = location;
  const navState: unknown = location.state;
  const fresh = props.threadId === null && new URLSearchParams(search).has(NEW_PARAM);
  const pane = usePane('chat');
  const { status, error: statusError } = useChatStatus();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [version, setVersion] = useState(0);
  const [listVersion, setListVersion] = useState(0);
  const { state: auth } = useAuth();
  const [detailsOpen, setDetailsOpen] = useSidebarOpen(auth.kind === 'signedIn' ? auth.user.id : 'anonymous');
  const jumpRef = useRef<((id: string) => void) | null>(null);
  // `/chat` shows the latest conversation: the list highlights it, the header and the panel are about it.
  // p12-diyalog-cmdk: the screen is not remounted per conversation; a new route forgets the previous conversation's
  // detail at once (React's "adjust state while rendering"), so nothing of it leaks into the next one.
  // A palette question ("Asistana sor") always starts its own new conversation, even from /chat?yeni=1.
  const asks = navState !== null && typeof navState === 'object' && ASK_STATE_KEY in navState;
  const routeKey = fresh ? (asks ? `new:${navKey}` : 'new') : (props.threadId ?? 'latest');
  const [shownRoute, setShownRoute] = useState(routeKey);
  if (shownRoute !== routeKey) {
    setShownRoute(routeKey);
    setDetail(null);
  }
  const threadId = props.threadId ?? (fresh ? null : (detail?.thread.id ?? null));

  const onDetail = useCallback((d: ThreadDetail | null) => {
    setDetail(d);
  }, []);

  // A new conversation got its first message: give it its own URL.
  useEffect(() => {
    if (fresh && detail !== null)
      void navigate(`/chat/${encodeURIComponent(detail.thread.id)}`, { replace: true });
  }, [fresh, detail, navigate]);

  const onChanged = useCallback(
    (id: string, action: ThreadAction) => {
      setListVersion((v) => v + 1);
      invalidate('chat');
      if (id !== threadId) return;
      if (action === 'deleted') void navigate(`/chat?${NEW_PARAM}=1`);
      else setVersion((v) => v + 1);
    },
    [navigate, threadId],
  );

  const onJump = useCallback(
    (a: ChatAsset) => {
      if (a.messageId === null) return;
      if (typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 1024px)').matches)
        setDetailsOpen(false);
      if (a.threadId === threadId && jumpRef.current !== null) jumpRef.current(a.messageId);
      else void navigate(`/chat/${a.threadId}?m=${a.messageId}`);
    },
    [threadId, navigate, setDetailsOpen],
  );

  // The screen stays mounted across conversations: until the new one loads, the previous one's detail is not shown.
  const shown =
    threadId === null || detail === null || (props.threadId !== null && detail.thread.id !== props.threadId)
      ? null
      : detail;
  // p12-diyalog-cmdk: the details panel opens and closes with motion (a column from lg, a sheet on phones).
  const details = usePresence(detailsOpen);
  // p18-plan-mode: the plan — a column / docked under the details (lg), a bar + drawer (tablet), a pill + sheet (phone).
  const plan = usePlanSurface({
    threadId,
    detail: shown,
    userId: auth.kind === 'signedIn' ? auth.user.id : 'anonymous',
    detailsOpen,
    onChanged: () => {
      setVersion((v) => v + 1);
    },
  });
  // p18-plans-ui: a plan link (`?plan=<id>`) — once the conversation is read, show that plan and drop the parameter.
  const planParam = new URLSearchParams(search).get(PLAN_PARAM);
  const [planRequest, setPlanRequest] = useState<{ readonly id: string; readonly n: number } | null>(null);
  const openPlan = plan.open;
  const planHandled = useRef<string | null>(null);
  useEffect(() => {
    if (planParam === null || shown === null || planHandled.current === navKey) return;
    planHandled.current = navKey;
    const rest = new URLSearchParams(search);
    rest.delete(PLAN_PARAM);
    const q = rest.toString();
    void navigate({ search: q === '' ? '' : `?${q}` }, { replace: true });
    if (shown.plan?.active?.id === planParam) openPlan();
    else {
      setDetailsOpen(true);
      setPlanRequest((r) => ({ id: planParam, n: (r?.n ?? 0) + 1 }));
    }
  }, [planParam, shown, search, navKey, navigate, openPlan, setDetailsOpen]);
  // "Planı aç" in the details' Planlar tab: on desktop the plan docks under the details; below lg the details sheet
  // closes first (the plan has its own drawer / sheet).
  const openPlanFromDetails = useCallback(() => {
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 64rem)').matches)
      setDetailsOpen(false);
    openPlan();
  }, [openPlan, setDetailsOpen]);
  // The header's height for what sits under it (knowledge strip, details column), re-measured when it wraps.
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const head = headRef.current;
    const root = rootRef.current;
    if (head === null || root === null) return;
    const set = (): void => {
      root.style.setProperty(
        '--dy-sohbet-head',
        `${String(Math.round(head.getBoundingClientRect().height))}px`,
      );
    };
    set();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(set);
    ro.observe(head);
    return () => {
      ro.disconnect();
    };
  }, []);
  return (
    <div
      ref={rootRef}
      className="dy-surface flex min-h-[var(--app-vh,100dvh)] min-w-0 flex-1"
      data-testid="dy-sohbet"
    >
      <PaneFrame pane={pane}>
        <ConversationList
          width={pane.width}
          activeId={threadId}
          activeProject={shown?.knowledge?.project ?? null}
          version={listVersion}
          searchRef={pane.searchRef}
          onNavigate={() => {
            if (pane.drawer) pane.closeDrawer();
          }}
          onChanged={onChanged}
          onNew={() => {
            if (pane.drawer) pane.closeDrawer();
            // p17-toasts-shortcuts: an explicit "Yeni sohbet" puts the caret in the composer (on touch screens too).
            void navigate(`/chat?${NEW_PARAM}=1`, { state: { [FOCUS_COMPOSER_STATE]: true } });
          }}
          onUnread={pane.setUnread}
          onCollapse={pane.collapse}
          onClose={pane.closeDrawer}
        />
      </PaneFrame>
      {/* p12-diyalog-cmdk: the conversation header spans the whole content area — thread and details panel sit under
          it side by side, so opening the details never narrows the header. */}
      <section
        aria-label={t.title}
        className="flex min-w-0 flex-1 flex-col bg-dy-thread"
        data-testid="dy-sohbet-main"
      >
        <div ref={headRef} className="sticky top-0 z-[5]" data-testid="dy-sohbet-head" data-dy-sticky="">
          <Header
            pane={pane}
            detail={shown}
            threadId={threadId}
            status={status}
            statusError={statusError}
            detailsOpen={detailsOpen}
            detailsToggleRef={detailsToggle}
            planMode={plan.planMode}
            planToggle={plan.toggle}
            onDetails={() => {
              setDetailsOpen(!detailsOpen);
            }}
            onChanged={onChanged}
          />
        </div>
        <div className="flex min-w-0 flex-1" data-testid="dy-sohbet-body">
          <div className="flex min-w-0 flex-1 flex-col" data-testid="dy-sohbet-thread">
            {/* p16-ops-safety: while the cost brake holds assistant turns, say so before the user writes. */}
            <CostBrakeBanner className="mx-3 mt-2 sm:mx-4" />
            {/* Knowledge and watches: pinned under the one-line header from 768 px; on phones (two-line header) they
                scroll with the conversation so the thread keeps the room. */}
            {/* p12-diyalog-default (visual tour): until the conversation's details are read, the strip's usual height
                is kept (one line from 768 px, three on phones), so the thread below does not jump down. */}
            {threadId !== null && shown === null ? (
              <div
                aria-hidden="true"
                data-testid="dy-knowledge-pending"
                className="h-[6.625rem] md:h-[2.8125rem]"
              />
            ) : null}
            {threadId !== null && shown !== null ? (
              <div className="z-[4] md:sticky md:top-[var(--dy-sohbet-head,57px)]" data-dy-sticky="">
                <ContextStrip
                  threadId={threadId}
                  knowledge={shown.knowledge}
                  watches={shown.watches}
                  onChanged={() => {
                    setVersion((v) => v + 1);
                  }}
                />
                {/* p15-workflow-ai: a conversation of the workflow editor's AI panel links back to its workflow. */}
                <WorkflowLinkBar link={shown.workflow} threadId={threadId} />
                {plan.bar}
              </div>
            ) : null}
            <DiyalogChat
              key={routeKey}
              threadId={props.threadId}
              embedded
              fresh={fresh}
              onDetail={onDetail}
              version={version}
              jumpRef={jumpRef}
              onOpenPlan={plan.open}
              composerTop={plan.pill}
            />
          </div>
          {details.mounted ? (
            <DetailsPanel
              key={threadId ?? 'none'}
              threadId={threadId}
              state={details.state}
              panelRef={details.ref}
              onJump={onJump}
              bottom={plan.dock}
              plan={shown === null ? undefined : plan.plan}
              onOpenPlan={openPlanFromDetails}
              planRequest={planRequest}
              watchCount={shown?.watches.length}
              onClose={() => {
                setDetailsOpen(false);
                // The panel leaves inert: focus goes back to the button that opens it.
                detailsToggle.current?.focus();
              }}
            />
          ) : null}
          {plan.column}
        </div>
      </section>
      {plan.overlays}
    </div>
  );
}
