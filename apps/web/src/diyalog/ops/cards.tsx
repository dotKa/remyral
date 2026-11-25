import { type Messages, messagesFor } from '@remyral/i18n';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type ApprovalRequest, approveRequest, denyRequest } from '../../api/approvals';
import { continueJob } from '../../api/approvalPause';
import { draftJobAction } from '../../api/chat';
import { approveOpsAction, denyOpsAction, kindText, type OpsAction } from '../../api/deploy';
import { requestMerge } from '../../api/gitflow';
import {
  cancelIntegration,
  type IntegrationView,
  retryIntegration,
  safePullRequestUrl,
  shortSha,
} from '../../api/integration';
import { getJob, type JobSummary } from '../../api/jobs';
import type { OpsItem, UsageLimitPause } from '../../api/opsThread';
import { resetText } from '../../api/runtimeUsage';
import { useAuth } from '../../auth/AuthProvider';
import { cx, toApiError } from '../../components/ui';
import { invalidate } from '../../lib/invalidate';
import { useNow } from '../../lib/now';
import { actionLabel } from '../../screens/approvals/actionLabel';
import { shortTime } from '../../screens/chat/time';
import { failureOf } from '../../screens/job/failure';
import { runAgainHref } from '../../screens/job/format';
import { CodeBlock } from '../CodeBlock';
import { Countdown } from '../Countdown';
import { DyIcon, type IconName } from '../icons';
import { KeyValue } from '../KeyValue';
import { CardButton, CardLink, type CardKind, LiveCard } from '../LiveCard';
import { Message } from '../Message';
import { runtimeDisplayName, RuntimeMark } from '../RuntimeMark';
import { StateBadge } from '../StateBadge';
import { INK } from '../tone';
import { DecisionPanel, useFreshStepUp } from './DecisionPanel';
import { useCardKeys } from './keys';
import { FAILED_WINDOW_MS } from './timeline';
import type { CardProps } from './types';
import { ApprovalDeadline, JobTimeLimit } from '../common/timeLimit';

/**
 * p12-diyalog Faz 1: the live cards of the operations thread, one per registered type (registry.ts). Each card is
 * decided where it appears, through the same API calls (and step-up rules) as its classic screen; after a decision
 * it collapses to the outcome line (who, when) and the thread keeps going with the follow-up events.
 */

const TR_AGO = messagesFor('tr').home.ago;

/** "az önce", "12 dk", "3 sa", "2 gün" ("just now", "12 min", … with `w` from `useT().home.ago`). */
export function agoText(iso: string, now: number, w: Messages['home']['ago'] = TR_AGO): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return w.justNow;
  if (s < 3600) return w.minutes({ n: Math.floor(s / 60) });
  if (s < 86_400) return w.hours({ n: Math.floor(s / 3600) });
  return w.days({ n: Math.floor(s / 86_400) });
}

function Outcome(props: {
  readonly tone: 'green' | 'red' | 'neutral' | 'amber';
  readonly icon: IconName;
  readonly text: string;
  readonly by?: string | null | undefined;
  readonly at?: string | null | undefined;
}): ReactNode {
  const f = useFormat();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="dy-outcome">
      <DyIcon name={props.icon} className={cx('size-4', INK[props.tone])} />
      <b className={cx('font-bold', INK[props.tone])}>{props.text}</b>
      {props.by === undefined || props.by === null ? null : <span className="text-dy-muted">{props.by}</span>}
      {props.at === undefined || props.at === null ? null : (
        <time dateTime={props.at} className="font-dy-mono text-[0.8125rem] text-dy-muted">
          {shortTime(props.at, new Date(), f)}
        </time>
      )}
    </span>
  );
}

function Notice(props: { readonly children: ReactNode; readonly tone?: 'red' | 'muted' }): ReactNode {
  return (
    <p
      role={props.tone === 'red' ? 'alert' : 'status'}
      className={cx(
        'm-0 w-full text-[0.8125rem]',
        props.tone === 'red' ? 'text-dy-red-ink' : 'text-dy-muted',
      )}
    >
      {props.children}
    </p>
  );
}

/** The signed-in account may make decisions at all (viewers cannot; the master decides per project). */
function useCanDecide(): boolean {
  const { state } = useAuth();
  return state.kind === 'signedIn' && state.user.role !== 'viewer';
}

// ------------------------------------------------------------------------------------------------ approval

function riskOf(
  risk: string,
  w: Messages['home']['cards']['approval'],
): { label: string; tone: 'amber' | 'red' } {
  if (risk === 'critical') return { label: w.critical, tone: 'red' };
  if (risk === 'high') return { label: w.high, tone: 'amber' };
  return { label: w.kind, tone: 'amber' };
}

function TouchList(props: { readonly r: ApprovalRequest }): ReactNode {
  const h = props.r.hints;
  const w = useT().home.cards.approval;
  if (h === null) return null;
  const outside = new Set(h.outside);
  const rows: { icon: IconName; verb: string; v: string }[] = [
    ...h.deletes.map((v) => ({ icon: 'xc' as const, verb: w.deletes, v })),
    ...h.writes.map((v) => ({ icon: 'file' as const, verb: w.writes, v })),
    ...h.installs.map((v) => ({ icon: 'plus' as const, verb: w.installs, v })),
    ...h.reaches.map((v) => ({ icon: 'globe' as const, verb: w.reaches, v })),
  ].slice(0, 6);
  if (rows.length === 0 && !h.elevated) return null;
  return (
    <ul
      className="m-0 grid list-none gap-px overflow-hidden rounded-[10px] border border-dy-line p-0 text-[0.84375rem]"
      aria-label={w.touches}
    >
      {rows.map((row) => (
        <li
          key={`${row.verb}:${row.v}`}
          className={cx(
            'grid grid-cols-[18px_52px_minmax(0,1fr)] items-center gap-2 px-2.5 py-1.5',
            outside.has(row.v) ? 'bg-dy-amber-soft' : 'bg-dy-card',
          )}
        >
          <DyIcon name={row.icon} className="size-3.5 text-dy-muted" />
          <span className="text-dy-muted">{row.verb}</span>
          {/* p12-diyalog-default (visual tour): the path truncates, the "workspace dışı" mark never does (it was cut
              off with the path on phones). */}
          <span className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 truncate font-dy-mono text-[0.8125rem]" title={row.v}>
              {row.v}
            </code>
            {outside.has(row.v) ? (
              <span className="shrink-0 rounded-[5px] bg-dy-amber px-1.5 py-px font-dy text-[0.6875rem] font-bold whitespace-nowrap text-dy-on-fill">
                {w.outsideWorkspace}
              </span>
            ) : null}
          </span>
        </li>
      ))}
      {h.elevated ? (
        <li className="bg-dy-red-soft px-2.5 py-1.5 font-medium text-dy-red-ink">{w.elevated}</li>
      ) : null}
    </ul>
  );
}

function approvalOutcome(r: ApprovalRequest, w: Messages['home']['cards']['approval']): ReactNode {
  const by = r.decidedBy?.username ?? null;
  switch (r.status) {
    case 'approved':
      return <Outcome tone="green" icon="checkc" text={w.approved} by={by} at={r.decidedAt} />;
    case 'denied':
      return (
        <span className="grid gap-0.5">
          <Outcome tone="red" icon="xc" text={w.denied} by={by} at={r.decidedAt} />
          {r.decisionReason === null ? null : (
            <span className="text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">{`“${r.decisionReason}”`}</span>
          )}
        </span>
      );
    case 'expired':
      return <Outcome tone="neutral" icon="clock" text={w.expired} at={r.decidedAt ?? r.expiresAt} />;
    default:
      return <Outcome tone="neutral" icon="xc" text={w.cancelled} at={r.decidedAt} />;
  }
}

export function ApprovalCard(props: CardProps<'approval:request'>): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const c = t.home.cards;
  const w = c.approval;
  const { item } = props;
  const r = item.approval;
  const now = useNow();
  const fresh = useFreshStepUp('approvals.decide');
  const canDecide = useCanDecide();
  const [intent, setIntent] = useState<'approve' | 'deny' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'red' | 'muted' } | null>(null);
  const pending = r.status === 'pending';
  const risk = riskOf(r.risk, w);
  // The master asked for a fresh code (403 step_up_required): the field stays until the decision is through.
  const [codeAsked, setCodeAsked] = useState(false);
  const needsCode = (r.stepUp && !fresh) || codeAsked;

  async function send(kind: 'approve' | 'deny', reason: string): Promise<void> {
    const out = kind === 'approve' ? await approveRequest(r.id, reason) : await denyRequest(r.id, reason);
    props.onChanged({ ...item, approval: out.request, unread: false });
    setIntent(null);
    setNotice(
      out.final
        ? null
        : {
            text: w.recorded({ n: out.request.approvals, of: out.request.requiredApprovals }),
            tone: 'muted',
          },
    );
  }

  async function approveNow(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await send('approve', '');
    } catch (err) {
      const e = toApiError(err);
      // The master asks for a fresh code: the decision row opens with the field (never skipped).
      if (e.status === 403 && e.code === 'step_up_required') {
        setCodeAsked(true);
        setIntent('approve');
      } else setNotice({ text: sayError(e), tone: 'red' });
    } finally {
      setBusy(false);
    }
  }

  const open = (kind: 'approve' | 'deny'): void => {
    if (!pending || !canDecide) return;
    setNotice(null);
    setIntent(kind);
  };
  useCardKeys(item.id, {
    approve: () => {
      open('approve');
    },
    deny: () => {
      open('deny');
    },
  });

  const meta = pending
    ? c.waiting({ ago: agoText(r.createdAt, now, t.home.ago), stale: r.staleAt !== null })
    : agoText(r.createdAt, now, t.home.ago);
  const kind: CardKind = { label: risk.label, icon: 'shield', tone: risk.tone };
  return (
    <LiveCard
      cardKey={item.id}
      unread={item.unread}
      kind={kind}
      state={pending && r.jobPaused ? <StateBadge state="paused" label={w.jobPaused} /> : undefined}
      meta={meta}
      aside={pending ? props.position : undefined}
      title={
        <Link
          to={`/jobs/${encodeURIComponent(r.jobId)}`}
          className="text-inherit no-underline hover:underline"
        >
          {r.headline.text}
        </Link>
      }
      sub={
        <>
          <span>{r.project}</span>
          <span>{actionLabel(r.action)}</span>
          {r.requiredApprovals > 1 ? (
            <span className="font-dy-mono">{w.approvals({ n: r.approvals, of: r.requiredApprovals })}</span>
          ) : null}
        </>
      }
      {...(pending
        ? {
            actions: canDecide ? (
              <>
                <CardButton
                  variant="warn"
                  icon="check"
                  busy={busy}
                  expanded={intent === 'approve'}
                  onClick={() => {
                    if (needsCode) open('approve');
                    else void approveNow();
                  }}
                >
                  {w.approve}
                </CardButton>
                <CardButton
                  expanded={intent === 'deny'}
                  onClick={() => {
                    open('deny');
                  }}
                >
                  {w.denyWithReason}
                </CardButton>
                {props.onWriteAgent === undefined ? null : (
                  <CardButton variant="ghost" icon="msg" onClick={props.onWriteAgent}>
                    {w.writeAgent}
                  </CardButton>
                )}
                <CardLink to={`/approvals/${encodeURIComponent(r.id)}`} variant="ghost">
                  {w.details}
                </CardLink>
              </>
            ) : (
              <CardLink to={`/approvals/${encodeURIComponent(r.id)}`} variant="secondary">
                {w.details}
              </CardLink>
            ),
            hint: canDecide ? (r.stepUp ? w.hintCode : w.hint) : w.noRight,
            panel: (
              <>
                {intent === null ? null : (
                  <DecisionPanel
                    key={intent}
                    intent={intent}
                    needsCode={needsCode}
                    submitLabel={intent === 'approve' ? (needsCode ? w.submitWithCode : w.submit) : w.deny}
                    reason={
                      intent === 'deny' ? { required: true, placeholder: w.denyPlaceholder } : undefined
                    }
                    onSubmit={(reason) => send(intent, reason)}
                    onCancel={() => {
                      setIntent(null);
                    }}
                  />
                )}
                {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
                {/* p15-autonomy: the decision deadline and the job's time limit, extendable from the card. */}
                <ApprovalDeadline
                  request={r}
                  onChanged={(next) => {
                    props.onChanged({ ...item, approval: next });
                  }}
                />
                <JobTimeLimit jobId={r.jobId} state={r.status} />
              </>
            ),
          }
        : { resolved: approvalOutcome(r, w) })}
    >
      <div className="grid gap-3">
        {r.details?.description !== undefined ? (
          <blockquote className="m-0 rounded-[10px] bg-dy-sunk px-3 py-2.5 text-[0.9375rem]">
            <small className="mb-0.5 block text-[0.75rem] font-bold text-dy-muted">{w.agentSays}</small>
            <span className="[overflow-wrap:anywhere]">{r.details.description}</span>
          </blockquote>
        ) : null}
        {r.details?.command !== undefined ? (
          <CodeBlock code={r.details.command} />
        ) : r.details === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]">{r.summary}</p>
        ) : null}
        <TouchList r={r} />
        {props.extra}
        {pending ? (
          <Countdown
            until={r.expiresAt}
            from={r.createdAt}
            label={r.jobPaused ? w.expiresPaused : w.expires}
            tone={risk.tone}
          />
        ) : null}
        {notice !== null && !pending ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      </div>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ deploy

function deployOutcome(a: OpsAction, w: Messages['home']['cards']['deploy']): ReactNode {
  const by = a.decidedBy?.username ?? null;
  switch (a.state) {
    case 'denied':
      return <Outcome tone="red" icon="xc" text={w.denied} by={by} at={a.decidedAt} />;
    case 'expired':
      return <Outcome tone="neutral" icon="clock" text={w.expired} at={a.expiresAt} />;
    case 'refused':
      return <Outcome tone="red" icon="xc" text={w.refused} at={a.updatedAt} />;
    case 'failed':
      return <Outcome tone="red" icon="xc" text={w.failed} by={by} at={a.finishedAt ?? a.updatedAt} />;
    case 'succeeded':
      return (
        <Outcome tone="green" icon="checkc" text={w.succeeded} by={by} at={a.finishedAt ?? a.updatedAt} />
      );
    default:
      return <Outcome tone="green" icon="retry" text={w.running} by={by} at={a.decidedAt} />;
  }
}

function targetRows(a: OpsAction): { k: string; v: string; mono?: boolean }[] {
  const rows: { k: string; v: string; mono?: boolean }[] = [];
  for (const [k, v] of Object.entries(a.target)) {
    if (rows.length >= 3) break;
    if (typeof v === 'string' && v.length <= 120) rows.push({ k, v, mono: true });
  }
  return rows;
}

export function DeployCard(props: CardProps<'deploy:action'>): ReactNode {
  const { item } = props;
  const a = item.deploy;
  const t = useT();
  const w = t.home.cards.deploy;
  const now = useNow();
  const fresh = useFreshStepUp('deploy.production');
  const canDecide = useCanDecide();
  const [intent, setIntent] = useState<'approve' | 'deny' | null>(null);
  const pending = a.state === 'awaiting_approval';
  const production = a.env === 'production';
  const needsCode = a.policy.decision === 'approval_step_up' && !fresh;
  const open = (kind: 'approve' | 'deny'): void => {
    if (pending && canDecide) setIntent(kind);
  };
  useCardKeys(item.id, {
    approve: () => {
      open('approve');
    },
    deny: () => {
      open('deny');
    },
  });

  async function send(kind: 'approve' | 'deny', reason: string): Promise<void> {
    const next =
      kind === 'approve' ? await approveOpsAction(a.id, reason) : await denyOpsAction(a.id, reason);
    invalidate('approvals');
    props.onChanged({ ...item, deploy: next, unread: false });
    setIntent(null);
  }

  const title = `${a.project} ${kindText(a.kind)}${a.env === null ? '' : `, ${a.env}`}`;
  return (
    <LiveCard
      cardKey={item.id}
      unread={item.unread}
      kind={{
        label: production ? w.kindProduction : w.kind,
        icon: 'rocket',
        tone: production ? 'red' : 'amber',
      }}
      meta={
        pending
          ? t.home.cards.waiting({ ago: agoText(a.createdAt, now, t.home.ago), stale: false })
          : agoText(a.createdAt, now, t.home.ago)
      }
      aside={pending ? props.position : undefined}
      title={
        <Link
          to={`/deploys/${encodeURIComponent(a.id)}`}
          className="text-inherit no-underline hover:underline"
        >
          {title}
        </Link>
      }
      sub={
        <>
          <span>{a.project}</span>
          {a.requestedBy.username === null ? null : (
            <span>{w.requestedBy({ who: a.requestedBy.username })}</span>
          )}
          <span>{a.via === 'api' ? w.fromConsole : a.via}</span>
        </>
      }
      {...(pending
        ? {
            actions: canDecide ? (
              <>
                <CardButton
                  variant="primary"
                  icon="rocket"
                  expanded={intent === 'approve'}
                  onClick={() => {
                    open('approve');
                  }}
                >
                  {a.policy.decision === 'approval_step_up' ? w.publishWithCode : w.publish}
                </CardButton>
                <CardButton
                  expanded={intent === 'deny'}
                  onClick={() => {
                    open('deny');
                  }}
                >
                  {w.deny}
                </CardButton>
                <CardLink to={`/deploys/${encodeURIComponent(a.id)}`} variant="ghost">
                  {w.changes}
                </CardLink>
              </>
            ) : (
              <CardLink to={`/deploys/${encodeURIComponent(a.id)}`}>{w.changes}</CardLink>
            ),
            hint: canDecide ? undefined : w.noRight,
            panel:
              intent === null ? null : (
                <DecisionPanel
                  key={intent}
                  intent={intent}
                  needsCode={intent === 'approve' && needsCode}
                  submitLabel={intent === 'approve' ? w.publish : w.deny}
                  reason={intent === 'deny' ? { required: false, placeholder: w.denyPlaceholder } : undefined}
                  onSubmit={(reason) => send(intent, reason)}
                  onCancel={() => {
                    setIntent(null);
                  }}
                />
              ),
          }
        : { resolved: deployOutcome(a, w) })}
    >
      <div className="grid gap-3">
        {a.note === null ? null : <p className="m-0 text-[0.9375rem] [overflow-wrap:anywhere]">{a.note}</p>}
        {targetRows(a).length > 0 ? <KeyValue rows={targetRows(a)} /> : null}
        <p className="m-0 text-[0.84375rem] text-dy-muted">
          {a.policy.decision === 'approval_step_up'
            ? w.needsCode
            : a.policy.decision === 'approval'
              ? w.needsApproval
              : a.policy.reason}
        </p>
        {pending && a.expiresAt !== null ? (
          <Countdown until={a.expiresAt} from={a.createdAt} label={w.countdown} tone="amber" />
        ) : null}
      </div>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ merge

function mergeState(
  state: string,
  w: Messages['home']['cards']['merge'],
): { label: string; tone: 'teal' | 'amber' | 'red' | 'green' | 'neutral' } {
  switch (state) {
    case 'ready':
      return { label: w.ready, tone: 'teal' };
    case 'needs_human':
      return { label: w.needsHuman, tone: 'amber' };
    case 'failed':
      return { label: w.failed, tone: 'red' };
    case 'merged':
      return { label: w.merged, tone: 'green' };
    case 'cancelled':
      return { label: w.cancelled, tone: 'neutral' };
    default:
      return { label: state, tone: 'neutral' };
  }
}

function Chain(props: {
  readonly steps: readonly { readonly ok: boolean | null; readonly text: string }[];
}): ReactNode {
  const w = useT().home.cards.merge;
  return (
    <ul
      className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1.5 p-0 text-[0.84375rem]"
      aria-label={w.checks}
    >
      {props.steps.map((s, i) => (
        <li key={s.text} className="flex items-center gap-1.5">
          {i > 0 ? <span className="h-px w-3 bg-dy-line-2" aria-hidden="true" /> : null}
          <DyIcon
            name={s.ok === true ? 'checkc' : s.ok === false ? 'xc' : 'clock'}
            className={cx(
              'size-3.5',
              s.ok === true ? 'text-dy-green' : s.ok === false ? 'text-dy-red-ink' : 'text-dy-amber-ink',
            )}
          />
          <span className={s.ok === null ? 'font-bold text-dy-amber-ink' : undefined}>{s.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function MergeCard(props: CardProps<'merge:integration'>): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const w = t.home.cards.merge;
  const { item } = props;
  const m: IntegrationView = item.merge;
  const now = useNow();
  const canDecide = useCanDecide();
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'red' | 'muted' } | null>(null);
  const [requested, setRequested] = useState(false);
  const st = mergeState(m.state, w);
  const merged = m.branches.filter((b) => b.state === 'merged' || b.state === 'resolved').length;
  const pr = m.pullRequest;
  const prHref = pr === null ? null : safePullRequestUrl(pr.url);
  const open = m.state === 'ready' || m.state === 'needs_human' || m.state === 'failed';

  async function act(name: string, fn: () => Promise<IntegrationView | null>): Promise<void> {
    setBusy(name);
    setNotice(null);
    try {
      const next = await fn();
      if (next !== null) props.onChanged({ ...item, merge: next, unread: false });
    } catch (err) {
      setNotice({ text: sayError(err), tone: 'red' });
    } finally {
      setBusy(null);
    }
  }

  const steps = [
    { ok: merged === m.branches.length, text: w.branches({ merged, total: m.branches.length }) },
    ...(m.verification === null
      ? []
      : [
          {
            ok:
              m.verification.state === 'passed' || m.verification.state === 'warned'
                ? true
                : m.verification.state === 'failed' || m.verification.state === 'error'
                  ? false
                  : null,
            text: m.verification.summary ?? w.verification({ state: m.verification.state }),
          },
        ]),
    ...(m.state === 'ready' ? [{ ok: null, text: requested ? w.adminApproval : w.yourCall }] : []),
  ];

  return (
    <LiveCard
      cardKey={item.id}
      unread={item.unread}
      kind={{
        label: w.kind,
        icon: 'merge',
        tone: st.tone === 'red' ? 'red' : st.tone === 'amber' ? 'amber' : 'teal',
      }}
      state={
        <StateBadge
          state={
            m.state === 'ready'
              ? 'needs'
              : m.state === 'failed'
                ? 'failed'
                : m.state === 'merged'
                  ? 'done'
                  : 'stale'
          }
          label={st.label}
        />
      }
      meta={t.home.cards.ago({ ago: agoText(m.updatedAt, now, t.home.ago) })}
      aside={open ? props.position : undefined}
      title={
        <>
          <span translate="no" className="font-dy-mono font-medium">
            {m.branch}
          </span>
          {w.into({ target: m.targetBranch })}
          {pr === null ? '' : ` PR #${String(pr.number)}`}
        </>
      }
      sub={
        <>
          <span>{m.project}</span>
          <span>{w.jobBranches({ n: m.branches.length })}</span>
          <span className="font-dy-mono">{w.base({ target: m.targetBranch, sha: shortSha(m.baseSha) })}</span>
        </>
      }
      {...(open
        ? {
            actions: (
              <>
                {m.state === 'ready' && m.mergeJobId !== null && canDecide ? (
                  <CardButton
                    variant="primary"
                    icon="merge"
                    busy={busy === 'merge'}
                    disabled={requested}
                    onClick={() =>
                      void act('merge', async () => {
                        await requestMerge(m.mergeJobId ?? '', 'merge');
                        setRequested(true);
                        invalidate('approvals');
                        setNotice({
                          text: w.requested,
                          tone: 'muted',
                        });
                        return null;
                      })
                    }
                  >
                    {requested ? w.askedApproval : w.askApproval}
                  </CardButton>
                ) : null}
                {prHref === null ? null : (
                  <a
                    href={prHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="dy-press inline-flex items-center gap-[7px] rounded-[9px] border border-transparent px-[13px] py-[7px] text-sm font-medium whitespace-nowrap text-dy-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
                  >
                    <DyIcon name="globe" />
                    {w.openPr({ n: pr?.number ?? 0 })}
                  </a>
                )}
                {(m.state === 'needs_human' || m.state === 'failed') && canDecide ? (
                  <>
                    <CardButton
                      variant="primary"
                      icon="retry"
                      busy={busy === 'retry'}
                      onClick={() => void act('retry', () => retryIntegration(m.id))}
                    >
                      {w.retry}
                    </CardButton>
                    <CardButton
                      variant="danger"
                      expanded={cancelOpen}
                      onClick={() => {
                        setCancelOpen((v) => !v);
                      }}
                    >
                      {w.cancel}
                    </CardButton>
                  </>
                ) : null}
                {m.rootJobId === null ? null : (
                  <CardLink to={`/jobs/${encodeURIComponent(m.rootJobId)}`} variant="ghost">
                    {w.openJob}
                  </CardLink>
                )}
              </>
            ),
            hint: m.state === 'ready' ? w.hint : (m.reason ?? undefined),
            panel: (
              <>
                {cancelOpen ? (
                  <DecisionPanel
                    intent="deny"
                    needsCode={false}
                    submitLabel={w.cancelSubmit}
                    reason={{ required: false, placeholder: w.cancelPlaceholder }}
                    onSubmit={async (reason) => {
                      const next = await cancelIntegration(m.id, reason === '' ? undefined : reason);
                      props.onChanged({ ...item, merge: next, unread: false });
                      setCancelOpen(false);
                    }}
                    onCancel={() => {
                      setCancelOpen(false);
                    }}
                  />
                ) : null}
                {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
              </>
            ),
          }
        : {
            resolved:
              m.state === 'merged' ? (
                <Outcome tone="green" icon="merge" text={w.merged} at={m.updatedAt} />
              ) : (
                <Outcome tone="neutral" icon="xc" text={st.label} at={m.updatedAt} />
              ),
          })}
    >
      <Chain steps={steps} />
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ failed job

interface FailureFacts {
  readonly reason: string | null;
  readonly canContinue: boolean;
}

function useFailure(jobId: string): FailureFacts | null {
  const [facts, setFacts] = useState<FailureFacts | null>(null);
  useEffect(() => {
    let live = true;
    getJob(jobId).then(
      (d) => {
        if (live) setFacts({ reason: failureOf(d)?.reason ?? null, canContinue: d.continueAvailable });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [jobId]);
  return facts;
}

export function FailedJobCard(props: CardProps<'job:failed'>): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const w = t.home.cards.failed;
  const { item } = props;
  const j: JobSummary = item.job;
  const now = useNow();
  const canDecide = useCanDecide();
  const facts = useFailure(j.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lost = j.state === 'LOST';
  const dismissKey = `failed:${j.id}`;
  // p15-rerun-thread: the re-run is drafted in the conversation that started this job (named by the master), never in
  // whichever conversation the card happens to sit next to; none → the composer (`/jobs/new?from=`).
  const chatThread = item.chatThreadId;

  async function rerun(): Promise<void> {
    if (chatThread === null) return;
    setBusy('rerun');
    setNotice(null);
    try {
      await draftJobAction(chatThread, { action: 'run_again', jobIds: [j.id] });
      props.onChat();
      setOutcome(
        <span className="inline-flex flex-wrap items-center gap-2">
          <Outcome tone="amber" icon="retry" text={w.rerunDrafted} />
          <Link to={`/chat/${encodeURIComponent(chatThread)}`} className="text-dy-teal-ink underline">
            {w.openChat}
          </Link>
        </span>,
      );
    } catch (err) {
      setNotice(sayError(err));
    } finally {
      setBusy(null);
    }
  }

  async function cont(): Promise<void> {
    setBusy('continue');
    setNotice(null);
    try {
      const r = await continueJob(j.id);
      setOutcome(
        <span className="inline-flex flex-wrap items-center gap-2">
          <Outcome tone="green" icon="retry" text={w.continued} />
          <Link to={`/jobs/${encodeURIComponent(r.jobId)}`} className="text-dy-teal-ink underline">
            {w.openJob}
          </Link>
        </span>,
      );
    } catch (err) {
      setNotice(sayError(err));
    } finally {
      setBusy(null);
    }
  }

  const old = now - Date.parse(j.stateChangedAt) > FAILED_WINDOW_MS;
  const resolved =
    props.dismissed === true ? (
      <Outcome tone="neutral" icon="check" text={w.dismissed} />
    ) : outcome === null && old ? (
      <Outcome tone="neutral" icon="clock" text={w.old} at={j.stateChangedAt} />
    ) : (
      outcome
    );
  return (
    <LiveCard
      cardKey={item.id}
      unread={item.unread}
      kind={{ label: lost ? w.lost : w.failed, icon: 'xc', tone: 'red' }}
      meta={t.home.cards.ago({ ago: agoText(j.stateChangedAt, now, t.home.ago) })}
      aside={resolved === null ? props.position : undefined}
      title={
        <Link to={`/jobs/${encodeURIComponent(j.id)}`} className="text-inherit no-underline hover:underline">
          {j.title === '' ? t.home.untitledJob : j.title}
        </Link>
      }
      sub={
        <>
          <span>{j.project}</span>
          {j.runtime === null ? null : <RuntimeMark runtime={j.runtime} />}
          <span>{w.attempts({ n: j.attempts })}</span>
        </>
      }
      {...(resolved !== null
        ? { resolved }
        : {
            actions: (
              <>
                {canDecide && chatThread !== null ? (
                  <CardButton
                    variant="primary"
                    icon="retry"
                    busy={busy === 'rerun'}
                    onClick={() => void rerun()}
                  >
                    {w.retry}
                  </CardButton>
                ) : canDecide ? (
                  <CardLink to={runAgainHref(j.id)} variant="primary" icon="retry">
                    {w.retry}
                  </CardLink>
                ) : null}
                {canDecide && facts?.canContinue === true ? (
                  <CardButton busy={busy === 'continue'} onClick={() => void cont()}>
                    {w.resume}
                  </CardButton>
                ) : null}
                <CardLink to={`/jobs/${encodeURIComponent(j.id)}`} variant="ghost" icon="term">
                  {w.openLog}
                </CardLink>
                {props.onDismiss === undefined ? null : (
                  <CardButton variant="ghost" onClick={() => props.onDismiss?.(dismissKey)}>
                    {w.dismiss}
                  </CardButton>
                )}
              </>
            ),
            hint: chatThread !== null ? w.hint : undefined,
            panel: notice === null ? null : <Notice tone="red">{notice}</Notice>,
          })}
    >
      {facts?.reason === null || facts === null ? null : (
        <pre className="m-0 rounded-[10px] bg-dy-sunk px-3 py-2.5 font-dy-mono text-[0.8125rem] leading-[1.6] whitespace-pre-wrap text-dy-red-ink [overflow-wrap:anywhere]">
          {facts.reason}
        </pre>
      )}
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ limit

export function LimitCard(props: CardProps<'limit:paused'>): ReactNode {
  const { item } = props;
  const l: UsageLimitPause = item.limit;
  const t = useT();
  const w = t.home.cards.limit;
  const now = useNow();
  const over = Date.parse(l.resumeAt) <= now;
  const name = runtimeDisplayName(l.runtime);
  return (
    <LiveCard
      cardKey={item.id}
      unread={item.unread}
      kind={{ label: w.kind, icon: 'pause', tone: 'violet' }}
      meta={agoText(l.since, now, t.home.ago)}
      aside={over ? undefined : props.position}
      title={w.title({
        name: `${name}${l.model === null ? '' : ` (${l.model})`}`,
        when: resetText(l.resumeAt, now),
      })}
      sub={
        <>
          {l.workerName === null ? null : <span className="font-dy-mono">{l.workerName}</span>}
          {l.credential === null ? null : <span>{w.credential({ id: l.credential })}</span>}
          {l.project === null ? null : <span>{l.project}</span>}
          {l.hits > 1 ? <span>{w.hits({ n: l.hits })}</span> : null}
        </>
      }
      {...(over
        ? {
            resolved: <Outcome tone="green" icon="checkc" text={w.reopened} at={l.resumeAt} />,
          }
        : {
            actions: (
              <CardLink to="/usage" variant="ghost" icon="gauge">
                {w.seeLimits}
              </CardLink>
            ),
            hint: w.hint,
          })}
    >
      <div className="grid gap-2.5">
        {l.message === null ? null : (
          <p className="m-0 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]">{l.message}</p>
        )}
        {over ? null : <Countdown until={l.resumeAt} from={l.since} label={w.countdown} tone="violet" />}
      </div>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ events

const EVENT_ICON: Readonly<Record<string, IconName>> = {
  'approval.stale': 'clock',
  'approval.expiring': 'clock',
  'job.paused': 'pause',
  'job.waiting': 'clock',
  // p20-job-clock: a job's time limit is nearly used up.
  'job.time_warning': 'clock',
  'deploy.failed': 'rocket',
  'deploy.succeeded': 'rocket',
  'deploy.unhealthy': 'globe',
  'deploy.fix_started': 'rocket',
  'tools.updates': 'cpu',
  'monitor.down': 'globe',
  'monitor.up': 'globe',
  'worker.offline': 'cpu',
  'worker.pending': 'key',
  'worker.update_failed': 'cpu',
  'usage_limit.reached': 'pause',
  'usage_limit.reset': 'gauge',
  'usage_limit.near': 'gauge',
  'backup.failed': 'xc',
  'restore_drill.failed': 'xc',
  'verify.failed': 'xc',
  'budget.threshold': 'gauge',
  'budget.paused': 'pause',
  'chat.watch': 'bubble',
  'chat.note': 'bubble',
  'chat.failover': 'bubble',
  'chat.plan': 'flag',
  'memory.review_due': 'file',
  'memory.auto_learned': 'file',
  'backup.change_pending': 'shield',
  'account.recovery': 'key',
};

const WARN_KINDS = new Set([
  'deploy.failed',
  'deploy.unhealthy',
  'monitor.down',
  'worker.offline',
  'backup.failed',
  'restore_drill.failed',
  'verify.failed',
  'job.failed',
  'automation.failed',
  'backup.change_pending',
  'worker.update_failed',
]);

/** p12-diyalog panels: an event's icon and whether it is a warning (the Home "Son olaylar" list uses the same look). */
export function eventLook(e: { readonly kind: string; readonly severity: string }): {
  icon: IconName;
  warn: boolean;
} {
  const warn = e.severity === 'critical' || WARN_KINDS.has(e.kind);
  return { icon: EVENT_ICON[e.kind] ?? (warn ? 'xc' : 'bubble'), warn };
}

export function EventLine(props: { readonly item: OpsItem & { readonly type: 'event' } }): ReactNode {
  const { item } = props;
  const t = useT();
  const f = useFormat();
  const e = item.event;
  if (e === null) return null;
  const warn = e.severity === 'critical' || WARN_KINDS.has(e.kind);
  const text = (
    <>
      <b className="font-bold">{e.title}</b>
      {e.body === '' ? null : (
        <span className="hidden sm:inline">{` ${e.body.length > 140 ? `${e.body.slice(0, 139)}…` : e.body}`}</span>
      )}
    </>
  );
  return (
    <Message
      role="system"
      tone={warn ? 'warn' : 'neutral'}
      icon={EVENT_ICON[e.kind] ?? (warn ? 'xc' : 'bubble')}
      at={item.at}
      atText={shortTime(item.at, new Date(), f)}
    >
      {item.unread ? (
        <span className="size-1.5 rounded-full bg-dy-teal" data-testid="dy-unread">
          <span className="sr-only">{t.home.cards.unread}</span>
        </span>
      ) : null}
      {e.link === null ? (
        <span>{text}</span>
      ) : (
        <Link to={e.link} className="text-inherit no-underline hover:underline">
          {text}
        </Link>
      )}
    </Message>
  );
}
