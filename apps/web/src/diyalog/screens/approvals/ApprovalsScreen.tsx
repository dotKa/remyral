import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  approveRequest,
  denyRequest,
  getApproval,
  listApprovalsPage,
} from '../../../api/approvals';
import type { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import type { TabItem } from '../../../lib/tabs';
import { useTabParam } from '../../../lib/tabs';
import { cx, toApiError } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import { useCursorList } from '../../../lib/pager';
import { onInvalidate } from '../../../lib/invalidate';
import { useOpsEvents } from '../../ops/useOpsEvents';
import { DyIcon } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { DecisionPanel, useFreshStepUp } from '../../ops/DecisionPanel';
import { DyApiError, DyNotice, DyPager } from '../kit';
import {
  agoText,
  DyButton,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Rows,
  SkeletonRows,
  ThreadLink,
} from '../parts';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import {
  useActionText,
  HeadlineLine,
  PausePills,
  ReadableCall,
  RiskPill,
  STATUS_LOOK,
  StatusPill,
  untilText,
} from './call';
import { absoluteText } from '../../common/time';
import { useFormat, useLocale, useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §14): Onaylar (`/approvals`, `/approvals/:id`) in the Diyalog language.
 * Same requests, URL state and rules as the classic `ApprovalsPage`: Bekleyen / Karar verilen tabs (`?tab=decided`),
 * each with its own keyset pages (`?pendingCursor=` / `?decidedCursor=`), the request in a side column (≥ lg) or on
 * its own (phones). Decisions go through the same calls; the authenticator code is asked in place (the Diyalog
 * `DecisionPanel`, the home card's convention) when the request needs it or the master answers `step_up_required`.
 */

type Filter = 'pending' | 'decided';

const TAB_IDS = ['pending', 'decided'] as const;

function useCanDecide(): boolean {
  const { state } = useAuth();
  return state.kind === 'signedIn' && state.user.role !== 'viewer';
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function useApprovalList(filter: Filter) {
  const t = useT();
  const list = useCursorList<ApprovalRequest>({
    key: filter,
    label: filter === 'pending' ? t.needs.list.pendingPages : t.needs.list.decidedPages,
    prefix: filter,
    ...(filter === 'pending' ? { refreshMs: 30_000 } : {}),
    fetchPage: (cursor, limit) =>
      listApprovalsPage(filter === 'pending' ? 'pending' : null, { cursor, limit }),
  });
  // A request that arrives while the screen is open shows at once: the live ops stream (the same one that keeps
  // "Senden bekleyenler" current) re-reads the list whenever its set of open items changes; a decision made in another
  // part of this page (invalidate) and coming back to the tab do the same. The 30 s re-read stays as the fallback.
  const events = useOpsEvents();
  const openKey = `${String(events.items.length)}:${events.items.at(-1)?.id ?? ''}:${JSON.stringify(events.open)}`;
  const { reload } = list;
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    reload();
  }, [openKey, reload]);
  useEffect(() => {
    const off = onInvalidate(['approvals'], reload);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);
  // "Karar verilen" pages through every request newest first and hides the pending ones (as the classic page).
  const items =
    list.loaded && list.error === null
      ? filter === 'pending'
        ? list.items
        : list.items.filter((i) => i.status !== 'pending')
      : null;
  return { ...list, items };
}

function outcomeLine(
  out: { final: boolean; request: ApprovalRequest },
  kind: 'approve' | 'deny',
  label: string,
  t: Messages,
): string {
  const o = t.needs.outcome;
  if (!out.final)
    return o.partial({ label, approvals: out.request.approvals, required: out.request.requiredApprovals });
  return kind === 'approve' ? o.approved({ label }) : o.denied({ label });
}

/** Approve straight away (no code needed) or open the decision row; the master's `step_up_required` opens the code. */
function useDecision(request: ApprovalRequest, onDone: (message: string) => void) {
  const fresh = useFreshStepUp('approvals.decide');
  const [intent, setIntent] = useState<'approve' | 'deny' | null>(null);
  const [codeAsked, setCodeAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const needsCode = (request.stepUp && !fresh) || codeAsked;
  const actionText = useActionText();
  const t = useT();
  const label = actionText(request.action);

  async function send(kind: 'approve' | 'deny', reason: string): Promise<void> {
    const out =
      kind === 'approve' ? await approveRequest(request.id, reason) : await denyRequest(request.id, reason);
    setIntent(null);
    onDone(outcomeLine(out, kind, label, t));
  }

  async function approveNow(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await send('approve', '');
    } catch (err) {
      const e = toApiError(err);
      if (e.status === 403 && e.code === 'step_up_required') {
        setCodeAsked(true);
        setIntent('approve');
      } else setError(e);
    } finally {
      setBusy(false);
    }
  }

  return { intent, setIntent, needsCode, busy, error, setError, send, approveNow, label };
}

function DecisionRow(props: {
  readonly request: ApprovalRequest;
  readonly withNote: boolean;
  readonly onDone: (message: string) => void;
  readonly compact?: boolean;
}): ReactNode {
  const d = useDecision(props.request, props.onDone);
  const canDecide = useCanDecide();
  const w = useT().needs.decide;
  if (!canDecide)
    return (
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="cannot-decide">
        {w.cannot}
      </p>
    );
  return (
    <div className="grid w-full gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <DyButton
          variant="warn"
          icon="check"
          busy={d.busy}
          aria-expanded={d.intent === 'approve'}
          aria-label={props.compact === true ? w.approveAria({ label: d.label }) : undefined}
          onClick={() => {
            d.setError(null);
            if (d.needsCode || props.withNote) d.setIntent('approve');
            else void d.approveNow();
          }}
        >
          {w.approve}
        </DyButton>
        <DyButton
          variant="danger"
          icon="xc"
          aria-expanded={d.intent === 'deny'}
          aria-label={props.compact === true ? w.denyAria({ label: d.label }) : undefined}
          onClick={() => {
            d.setError(null);
            d.setIntent('deny');
          }}
        >
          {w.denyWithReason}
        </DyButton>
        {props.request.stepUp ? (
          <span className="inline-flex items-center gap-1 text-[0.78125rem] text-dy-muted">
            <DyIcon name="key" className="size-3.5" />
            {w.needsCode}
          </span>
        ) : null}
      </div>
      {d.intent === null ? null : (
        <DecisionPanel
          key={d.intent}
          intent={d.intent}
          needsCode={d.needsCode}
          submitLabel={
            d.intent === 'approve' ? (d.needsCode ? w.submitCodeApprove : w.submitApprove) : w.submitDeny
          }
          reason={
            d.intent === 'deny'
              ? { required: true, placeholder: w.denyPlaceholder }
              : props.withNote
                ? { required: false, placeholder: w.notePlaceholder }
                : undefined
          }
          onSubmit={(reason) => d.send(d.intent ?? 'approve', reason)}
          onCancel={() => {
            d.setIntent(null);
          }}
        />
      )}
      <DyApiError error={d.error} />
    </div>
  );
}

function RequestRow(props: {
  readonly item: ApprovalRequest;
  readonly selected: boolean;
  readonly search: string;
  readonly onDone: (message: string) => void;
}): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const { locale } = useLocale();
  const { item } = props;
  const now = useNow();
  const pending = item.status === 'pending';
  const actionText = useActionText();
  const label = actionText(item.action);
  return (
    <li
      data-testid="approval-row"
      className={cx(
        'grid gap-2 border-t border-dy-line px-4 py-3 first:border-t-0',
        props.selected && 'bg-dy-teal-soft/50 shadow-[inset_3px_0_0_var(--dy-teal)]',
      )}
    >
      <Link
        to={`/approvals/${encodeURIComponent(item.id)}${props.search}`}
        aria-current={props.selected ? 'true' : undefined}
        data-testid="approval-card"
        className="block min-w-0 rounded-md text-dy-ink no-underline"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <RiskPill risk={item.risk} />
          <span className="text-[0.9375rem] font-bold">{label}</span>
          {pending ? <PausePills request={item} /> : <StatusPill status={item.status} />}
        </span>
        <HeadlineLine headline={item.headline} details={item.details} />
        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.8125rem] text-dy-muted">
          <span>
            {item.project} · {t.needs.row.job} <span className="font-dy-mono">{shortId(item.jobId)}</span>
          </span>
          <time dateTime={item.createdAt} title={absoluteText(item.createdAt, fmt)}>
            {t.needs.row.requested({ ago: agoText(item.createdAt, now) })}
          </time>
          {pending ? (
            <time
              dateTime={item.expiresAt}
              title={absoluteText(item.expiresAt, fmt)}
              className="font-medium text-dy-ink"
            >
              {t.needs.row.expires({ until: untilText(item.expiresAt, now, t.needs.until) })}
            </time>
          ) : item.decidedAt === null ? null : (
            <span>
              {t.needs.status[item.status].toLocaleLowerCase(locale === 'tr' ? 'tr-TR' : 'en')}
              {item.decidedBy === null ? '' : `, ${item.decidedBy.username}`} · {agoText(item.decidedAt, now)}
            </span>
          )}
        </span>
      </Link>
      {pending ? <DecisionRow request={item} withNote={false} onDone={props.onDone} compact /> : null}
    </li>
  );
}

function roleText(role: string, t: Messages): string {
  return role === 'operator' || role === 'admin' || role === 'owner' ? t.needs.roles[role] : role;
}

function Decisions(props: { readonly decisions: readonly ApprovalDecision[] }): ReactNode {
  const fmt = useFormat();
  const w = useT().needs.decisions;
  const now = useNow();
  if (props.decisions.length === 0) return null;
  return (
    <section aria-label={w.title} className="grid gap-1.5">
      <h3 className="m-0 text-[0.9375rem] font-bold">{w.title}</h3>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {props.decisions.map((d) => (
          <li
            key={`${d.username}-${d.decidedAt}`}
            className="rounded-[10px] border border-dy-line px-3 py-2 text-[0.875rem]"
          >
            <Pill
              tone={d.decision === 'approve' ? 'green' : 'red'}
              icon={d.decision === 'approve' ? 'checkc' : 'xc'}
            >
              {d.decision === 'approve' ? w.approved : w.denied}
            </Pill>{' '}
            <b>{d.username}</b> <span className="text-dy-muted">({d.role})</span>{' '}
            <time dateTime={d.decidedAt} title={absoluteText(d.decidedAt, fmt)} className="text-dy-muted">
              {agoText(d.decidedAt, now)}
            </time>
            {d.reason === null ? null : (
              <p className="m-0 mt-1 text-dy-muted [overflow-wrap:anywhere]">“{d.reason}”</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function effectText(r: ApprovalRequest, t: Messages): string {
  if (r.kind === 'gate') return t.needs.effect.gate;
  if (r.status === 'pending' && r.jobPaused) return t.needs.effect.paused;
  return t.needs.effect.waiting;
}

function requesterText(by: ApprovalRequest['requestedBy'], t: Messages): string {
  const w = t.needs.requester;
  if (by.type === 'worker') return `${w.machine}${by.id === null ? '' : ` ${shortId(by.id)}`}`;
  if (by.type === 'system') return `${w.system}${by.id === null ? '' : ` (${by.id})`}`;
  return by.id === null ? by.type : `${by.type} ${by.id}`;
}

function Detail(props: { readonly id: string; readonly onChanged: () => void }): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.needs.detail;
  const actionText = useActionText();
  const [data, setData] = useState<{ request: ApprovalRequest; decisions: ApprovalDecision[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const [tick, setTick] = useState(0);
  const now = useNow();
  const { id, onChanged } = props;
  useEffect(() => {
    setNotice(null);
  }, [id]);
  useEffect(() => {
    let live = true;
    setError(null);
    getApproval(id).then(
      (d) => {
        if (live) setData(d);
      },
      (err: unknown) => {
        if (live) {
          setData(null);
          setError(toApiError(err));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [id, tick]);

  if (error !== null)
    return (
      <Panel title={w.request}>
        <ErrorLine
          error={error}
          what={w.request}
          onRetry={() => {
            setTick((t) => t + 1);
          }}
        />
      </Panel>
    );
  if (data === null || data.request.id !== id)
    return (
      <Panel title={w.request}>
        <SkeletonRows label={w.loading} rows={4} />
      </Panel>
    );
  const r = data.request;
  const pending = r.status === 'pending';
  return (
    <section
      aria-labelledby="dy-approval-title"
      data-testid="approval-detail"
      className="min-w-0 overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy"
    >
      <div className="grid gap-2 border-b border-dy-line px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <RiskPill risk={r.risk} />
          {pending ? <PausePills request={r} /> : null}
          <span className="ml-auto inline-flex" data-testid="request-status">
            <StatusPill status={r.status} />
          </span>
        </div>
        <h2
          id="dy-approval-title"
          className="m-0 text-[1.25rem] leading-tight font-extrabold tracking-[-0.015em]"
        >
          {actionText(r.action)}
        </h2>
        {r.requestedAction !== r.action ? (
          <p className="m-0 text-[0.78125rem] text-dy-muted">
            {w.reportedAction} <code className="font-dy-mono text-dy-ink">{r.requestedAction}</code>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1">
          <ThreadLink target={{ kind: 'approval', id: r.id }} about={actionText(r.action)} />
          <Link
            to={`/jobs/${encodeURIComponent(r.jobId)}`}
            className="dy-press inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[0.8125rem] font-medium text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
          >
            <DyIcon name="jobs" className="size-3.5" />
            {w.openJob}
          </Link>
        </div>
      </div>
      <div className="grid gap-4 px-4 py-4">
        <div className="grid gap-1.5">
          <h3 className="m-0 text-[0.8125rem] font-bold text-dy-muted">
            {r.requestedBy.type === 'worker' ? w.wantsByMachine : w.wantsByRequester}
          </h3>
          <ReadableCall details={r.details} hints={r.hints} summary={r.summary} />
        </div>
        <KeyValue
          rows={[
            { k: w.project, v: r.project },
            {
              k: w.job,
              v: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Link to={`/jobs/${encodeURIComponent(r.jobId)}`} className="font-dy-mono text-dy-teal-ink">
                    {shortId(r.jobId)}
                  </Link>
                  <span className="font-dy-mono text-[0.78125rem] text-dy-muted">{r.jobState}</span>
                </span>
              ),
            },
            { k: w.effect, v: <span data-testid="request-effect">{effectText(r, t)}</span> },
            {
              k: w.requested,
              v: (
                <span>
                  <time dateTime={r.createdAt} title={absoluteText(r.createdAt, fmt)}>
                    {agoText(r.createdAt, now)}
                  </time>{' '}
                  · {requesterText(r.requestedBy, t)}
                </span>
              ),
            },
            ...(pending
              ? [
                  {
                    k: w.expiry,
                    v: (
                      <time dateTime={r.expiresAt} title={absoluteText(r.expiresAt, fmt)}>
                        {untilText(r.expiresAt, now, t.needs.until)}
                      </time>
                    ),
                  },
                ]
              : []),
            { k: w.whoDecides, v: roleText(r.approverRole, t) },
            { k: w.approvals, v: `${String(r.approvals)} / ${String(r.requiredApprovals)}`, mono: true },
          ]}
        />
        {pending ? null : (
          <DyNotice
            tone={STATUS_LOOK[r.status].tone === 'green' ? 'green' : 'neutral'}
            testId="request-outcome"
          >
            {t.needs.status[r.status]}
            {r.decidedBy === null ? '' : `, ${r.decidedBy.username}`}
            {r.decidedAt === null ? '' : ` · ${absoluteText(r.decidedAt, fmt)}`}
            {r.decisionReason === null ? '.' : `: “${r.decisionReason}”`}
          </DyNotice>
        )}
        <Decisions decisions={data.decisions} />
        {pending ? (
          <div className="grid gap-1.5 border-t border-dy-line pt-3">
            <DecisionRow
              key={r.id}
              request={r}
              withNote
              onDone={(m) => {
                setNotice(m);
                setTick((t) => t + 1);
                onChanged();
              }}
            />
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.needs.decide.once}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function ApprovalsScreen(props: { readonly id: string | null }): ReactNode {
  const { id } = props;
  const t = useT();
  const w = t.needs;
  const { search } = useLocation();
  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);
  const tabs: TabItem[] = TAB_IDS.map((tabId) =>
    tabId === 'pending' && pendingCount !== undefined
      ? { id: tabId, label: w.tabs[tabId], count: pendingCount }
      : { id: tabId, label: w.tabs[tabId] },
  );
  const [tab] = useTabParam(tabs);
  const filter: Filter = tab === 'decided' ? 'decided' : 'pending';
  const list = useApprovalList(filter);
  const [flash, setFlash] = useState<string | null>(null);
  const { page, pageSize, hasNext } = list.pagination;
  useEffect(() => {
    if (filter === 'pending' && list.items !== null && !hasNext)
      setPendingCount((page - 1) * pageSize + list.items.length);
  }, [filter, list.items, hasNext, page, pageSize]);
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = detailRef.current;
    if (id === null || el === null || typeof el.scrollIntoView !== 'function') return;
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.top > window.innerHeight - 80) el.scrollIntoView({ block: 'start' });
  }, [id]);
  // Detail links keep the list's tab and page (the left column stays where it was).
  const keep = search;

  const onDone = (message: string): void => {
    setFlash(message);
    list.reload();
  };

  const inbox = (
    <Panel
      title={filter === 'pending' ? w.list.pendingTitle : w.list.decidedTitle}
      flush
      testId="approvals-inbox"
    >
      {flash === null ? null : (
        <div className="px-4 pb-2">
          <DyNotice tone="green" live>
            {flash}
          </DyNotice>
        </div>
      )}
      {list.items === null ? (
        list.error === null ? (
          <SkeletonRows label={w.list.loading} rows={3} />
        ) : (
          <div className="px-4 pb-3">
            <ErrorLine error={list.error} what={w.list.what} onRetry={list.reload} />
          </div>
        )
      ) : list.items.length === 0 ? (
        <EmptyLine testId="empty-state">
          {filter === 'pending' ? w.list.emptyPending : w.list.emptyDecided}
        </EmptyLine>
      ) : (
        <Rows label={filter === 'pending' ? w.list.pendingTitle : w.list.decidedTitle}>
          {list.items.map((item) => (
            <RequestRow key={item.id} item={item} selected={item.id === id} search={keep} onDone={onDone} />
          ))}
        </Rows>
      )}
      {list.items === null ? null : <DyPager {...list.pagination} />}
    </Panel>
  );

  return (
    <ScreenFrame
      title={w.screen.title}
      purpose={w.screen.purpose}
      back={id === null ? undefined : { to: `/approvals${search}`, label: w.screen.back }}
      live={filter === 'pending' ? (list.error === null ? 'live' : 'error') : undefined}
      testId="dy-approvals"
    >
      <div
        className={
          id === null
            ? 'grid grid-cols-[minmax(0,1fr)] items-start gap-4'
            : 'grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]'
        }
      >
        <div className={id === null ? 'min-w-0' : 'hidden min-w-0 lg:block'}>
          <SegTabs label={w.screen.tabsLabel} items={tabs}>
            {() => inbox}
          </SegTabs>
        </div>
        {id === null ? null : (
          <div ref={detailRef} className="min-w-0 scroll-mt-20 lg:sticky lg:top-[68px]">
            <Detail id={id} onChanged={list.reload} />
          </div>
        )}
      </div>
    </ScreenFrame>
  );
}
