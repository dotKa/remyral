import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import {
  type ApprovalMode,
  type ApprovalModeChange,
  type ApprovalModeState,
  getApprovalMode,
  setApprovalMode,
} from '../../api/approvalMode';
import { type ChatDraft, draftJobAction } from '../../api/chat';
import type { ApiError } from '../../api/client';
import { cx, toApiError } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { fill, type Messages } from '@remyral/i18n';
import { type ActionJob } from '../../screens/chat/JobActionParts';
import { memoryChangeHref } from '../../screens/chat/drafts';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyErrorNotice, DyNotice, DyCopyButton, DY_INPUT } from '../forms';
import { DyIcon } from '../icons';
import { CardButton } from '../LiveCard';
import { jobState } from '../screens/projects/states';
import { StateBadge } from '../StateBadge';
import { approvalHint, approvalLabel, rec } from './summary';

/**
 * p12-diyalog-w4: the parts of a chat draft card in the Diyalog language — the job checklist of a job action card,
 * the per-job results, the result links, a confirmed memory change's link, the one-time webhook secret, the quick
 * buttons on a card that started a job, and the approval mode of a confirmed job (change it now). Every value comes
 * from the master and renders as text; links are console paths built from ids the master returned (UUID-checked).
 */

const UUID = /^[0-9a-f-]{36}$/i;

/** The jobs of a job action card: a checkbox per job while the card is open (all checked by default). */
export function JobChecklist(props: {
  readonly jobs: readonly ActionJob[];
  readonly open: boolean;
  readonly checked: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (id: string) => void;
}): ReactNode {
  const w = useT().drafts.parts;
  const n = props.checked.size;
  return (
    <div className="grid gap-1.5">
      {props.open && props.jobs.length > 1 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" role="status" data-testid="job-action-count">
          {w.selected({ n, total: props.jobs.length })}
        </p>
      ) : null}
      <ul
        className="m-0 grid list-none overflow-hidden rounded-[10px] border border-dy-line p-0"
        data-testid="job-action-jobs"
        aria-label={w.jobsRegion}
      >
        {props.jobs.map((j) => {
          const st = jobState(j.state);
          const label = `${j.title || w.untitled} (${j.id.slice(0, 8)})`;
          const row = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block font-medium [overflow-wrap:anywhere]">{j.title || w.untitled}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-dy-muted">
                  <Link
                    to={`/jobs/${j.id}`}
                    className="font-dy-mono text-dy-teal-ink underline-offset-2 hover:underline"
                    translate="no"
                  >
                    {j.id.slice(0, 8)}
                  </Link>
                  {j.project === '' ? null : <span>{j.project}</span>}
                </span>
              </span>
              <StateBadge state={st.state} label={st.label} />
            </>
          );
          return (
            <li
              key={j.id}
              data-testid="job-action-job"
              className="border-t border-dy-line bg-dy-card first:border-t-0"
            >
              {props.open ? (
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
                    checked={props.checked.has(j.id)}
                    disabled={props.disabled}
                    aria-label={w.include({ label })}
                    onChange={() => {
                      props.onToggle(j.id);
                    }}
                  />
                  {row}
                </label>
              ) : (
                <div className="flex items-start gap-2.5 px-3 py-2">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const OUTCOME_TONE: Readonly<Record<string, 'green' | 'neutral' | 'red'>> = {
  done: 'green',
  skipped: 'neutral',
  refused: 'red',
  failed: 'red',
};

const OUTCOME_INK = { green: 'text-dy-green', neutral: 'text-dy-muted', red: 'text-dy-red-ink' } as const;

/** Per-job results of a confirmed job action card. */
export function JobActionResults(props: { readonly result: Record<string, unknown> }): ReactNode {
  const w = useT().drafts.parts;
  const rows = Array.isArray(props.result.results) ? props.result.results.map(rec) : [];
  if (rows.length === 0) return null;
  return (
    <ul
      className="m-0 grid list-none gap-1 p-0 text-[0.875rem]"
      data-testid="job-action-results"
      aria-label={w.resultsRegion}
    >
      {rows.map((r) => {
        const id = typeof r.jobId === 'string' ? r.jobId : '';
        const outcome = typeof r.outcome === 'string' ? r.outcome : 'failed';
        const o = {
          word: Object.hasOwn(w.outcomes, outcome)
            ? w.outcomes[outcome as keyof Messages['drafts']['parts']['outcomes']]
            : outcome,
          tone: OUTCOME_TONE[outcome] ?? ('red' as const),
        };
        const next = typeof r.newJobId === 'string' && UUID.test(r.newJobId) ? r.newJobId : null;
        return (
          <li
            key={id}
            data-testid="job-action-result"
            data-outcome={outcome}
            className="flex flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]"
          >
            <b className={cx('font-bold', OUTCOME_INK[o.tone])}>{o.word}</b>
            <span className="font-dy-mono text-[0.8125rem]">{id.slice(0, 8)}</span>
            {typeof r.title === 'string' && r.title !== '' ? <span>{r.title}</span> : null}
            {typeof r.message === 'string' && r.message !== '' ? (
              <span className="text-dy-muted">{`— ${r.message}`}</span>
            ) : null}
            {next === null ? null : (
              <Link
                to={`/jobs/${next}`}
                className="font-bold text-dy-teal-ink underline-offset-2 hover:underline"
              >
                {w.openNewJob}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Where a confirmed draft's result lives (job, workflow run, automation, monitor, deploy, skills, machine tools). */
export function resultLink(
  r: Record<string, unknown>,
  t: Messages,
): { readonly to: string; readonly label: string } | null {
  const l = t.drafts.parts.links;
  if (typeof r.jobId === 'string' && UUID.test(r.jobId)) return { to: `/jobs/${r.jobId}`, label: l.job };
  // p18-multi-project W5: a job batch (one job per project) — its page.
  if (typeof r.batchId === 'string' && UUID.test(r.batchId))
    return { to: `/jobs/batches/${r.batchId}`, label: t.multiProject.cards.jobBatch.kind };
  // p18-multi-project W3: an attached shared workflow — its page in the attaching project.
  if (
    typeof r.attachmentId === 'string' &&
    typeof r.link === 'string' &&
    /^\/workflows\/[0-9a-f-]{36}\?project=/.test(r.link)
  )
    return { to: r.link, label: t.multiProject.cards.workflowAttach.kind };
  if (typeof r.runId === 'string' && UUID.test(r.runId))
    return { to: `/jobs/workflows/${r.runId}`, label: l.run };
  // p13-workflows-ui: a saved workflow definition.
  if (typeof r.workflowId === 'string' && UUID.test(r.workflowId))
    return { to: `/workflows/${r.workflowId}`, label: l.workflow };
  if (typeof r.automationId === 'string' && UUID.test(r.automationId))
    return { to: `/automations/${r.automationId}`, label: l.automation };
  if (typeof r.monitorId === 'string')
    return { to: `/uptime/${encodeURIComponent(r.monitorId)}`, label: l.monitor };
  if (typeof r.actionId === 'string')
    return { to: `/deploys/${encodeURIComponent(r.actionId)}`, label: l.deploy };
  if (typeof r.skillId === 'string') return { to: '/skills', label: l.skills };
  if (typeof r.opId === 'string' && typeof r.workerId === 'string')
    return { to: `/machines/${encodeURIComponent(r.workerId)}?tab=tools`, label: l.machineTools };
  return null;
}

/** p11-memory-layers: the confirmed memory change and where to see it. */
export function MemoryResult(props: {
  readonly draft: ChatDraft;
  readonly result: Record<string, unknown>;
}): ReactNode {
  const w = useT().drafts.parts;
  const r = props.result;
  if (typeof r.recordId !== 'string') return null;
  const conflicts = typeof r.possibleConflicts === 'number' ? r.possibleConflicts : 0;
  const href = memoryChangeHref(props.draft, r.recordId);
  return (
    <p className="m-0 text-[0.875rem]" data-testid="memory-change-result">
      {w.memoryDone({ status: typeof r.status === 'string' ? r.status : null })}
      <Link to={href} className="font-bold text-dy-teal-ink underline-offset-2 hover:underline">
        {href.startsWith('/settings/profile') ? w.openRules : w.openMemory}
      </Link>
      {conflicts > 0 ? w.conflicts({ n: conflicts }) : ''}
    </p>
  );
}

/** p6-automations: a webhook secret comes only in the confirmation response — shown once, never stored. */
export function WebhookSecret(props: { readonly url: string; readonly secret: string }): ReactNode {
  const w = useT().drafts.parts;
  return (
    <div className="grid gap-2" data-testid="draft-webhook-secret">
      <DyNotice tone="amber" live>
        {w.webhookSave}
      </DyNotice>
      <p className="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
        <span className="text-dy-muted">{w.address}</span>
        <code className="font-dy-mono">{props.url}</code>
      </p>
      <code
        className="block rounded-[10px] bg-dy-cmd px-3 py-2.5 font-dy-mono text-[0.8125rem] text-dy-cmd-ink [overflow-wrap:anywhere]"
        translate="no"
        data-testid="draft-webhook-secret-value"
      >
        {props.secret}
      </code>
      <div className="flex flex-wrap gap-2">
        <DyCopyButton text={props.secret} label={w.copySecret} />
        <DyCopyButton text={props.url} label={w.copyAddress} />
      </div>
    </div>
  );
}

/** p16-assistant-admin: an invited user's temporary password — only in the confirmation answer, shown once here. */
export function TemporaryPassword(props: { readonly username: string; readonly value: string }): ReactNode {
  const w = useT().assistantAdmin.password;
  return (
    <div className="grid gap-2" data-testid="admin-temporary-password">
      <DyNotice tone="amber" live>
        {w.save}
      </DyNotice>
      <p className="m-0 text-[0.8125rem] text-dy-muted">
        {w.title} · {fill(w.user, { username: props.username })}
      </p>
      <code
        className="block rounded-[10px] bg-dy-cmd px-3 py-2.5 font-dy-mono text-[0.8125rem] text-dy-cmd-ink [overflow-wrap:anywhere]"
        translate="no"
        data-testid="admin-temporary-password-value"
      >
        {props.value}
      </code>
      <div className="flex flex-wrap gap-2">
        <DyCopyButton text={props.value} label={w.copy} />
      </div>
    </div>
  );
}

/**
 * Quick buttons on a card that started a job: İptal et and Yeniden çalıştır draft a job action card in this
 * conversation (nothing runs until that card is confirmed); İşi aç goes to the job.
 */
export function JobQuickButtons(props: {
  readonly threadId: string;
  readonly jobId: string;
  readonly onDrafted: () => void;
}): ReactNode {
  const w = useT().drafts.parts;
  const [busy, setBusy] = useState<'cancel' | 'run_again' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [drafted, setDrafted] = useState<'cancel' | 'run_again' | null>(null);

  async function draft(action: 'cancel' | 'run_again'): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      await draftJobAction(props.threadId, { action, jobIds: [props.jobId] });
      setDrafted(action);
      props.onDrafted();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-2" data-testid="job-quick-actions">
      <div className="flex flex-wrap items-center gap-2">
        <CardButton
          icon="xc"
          busy={busy === 'cancel'}
          disabled={busy !== null || props.threadId === ''}
          onClick={() => void draft('cancel')}
        >
          {w.cancel}
        </CardButton>
        <CardButton
          icon="retry"
          busy={busy === 'run_again'}
          disabled={busy !== null || props.threadId === ''}
          onClick={() => void draft('run_again')}
        >
          {w.runAgain}
        </CardButton>
        <Link
          to={`/jobs/${props.jobId}`}
          className="dy-press inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-[7px] text-sm font-bold text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
        >
          {w.openJob}
          <DyIcon name="chev" className="size-3.5 -rotate-90" />
        </Link>
      </div>
      {drafted === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted" role="status" data-testid="job-quick-drafted">
          {drafted === 'cancel' ? w.draftedCancel : w.draftedRunAgain}
        </p>
      )}
      <DyErrorNotice error={error} retryLeft={0} />
    </div>
  );
}

function applicationText(c: ApprovalModeChange, t: Messages): string {
  const w = t.drafts.approvalMode;
  if (c.delivery === 'not_running') return w.notRunning;
  if (c.application === null) return w.waiting;
  return Object.hasOwn(w.applications, c.application) ? w.applications[c.application] : c.application;
}

/**
 * p6-approval-mode-switch on a confirmed job card: the job's approval mode now and — for whoever may change it — a
 * select to change it before it starts or while it runs (the master decides what is allowed; a machine
 * administration job going to "never ask" needs a fresh code, which the shell's step-up asks for).
 */
export function JobApprovalMode(props: { readonly jobId: string; readonly state: string }): ReactNode {
  const { jobId, state } = props;
  const t = useT();
  const w = t.drafts.approvalMode;
  const selectId = useId();
  const stepUp = useStepUp();
  const [data, setData] = useState<ApprovalModeState | null>(null);
  const [choice, setChoice] = useState<ApprovalMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    getApprovalMode(jobId).then(
      (d) => {
        setData(d);
        setChoice(null);
      },
      () => undefined,
    );
  }, [jobId]);
  useEffect(() => {
    load();
  }, [load, state]);
  const last = data?.changes.at(-1) ?? null;
  const waiting = last?.delivery === 'sent' && last.application === null;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(load, 2_000);
    return () => {
      clearTimeout(t);
    };
  }, [waiting, load, data]);
  if (data === null) return null;

  const selected = choice ?? data.current;
  // A master that lists no options still shows the current mode (never an empty select).
  const options =
    data.options.length > 0 ? data.options : [{ mode: data.current, allowed: true, reason: null }];
  const option = options.find((o) => o.mode === selected);

  async function apply(): Promise<void> {
    if (data === null || choice === null || choice === data.current) return;
    setBusy(true);
    setError(null);
    const body = { mode: choice, expectedSeq: data.seq };
    try {
      const r = await stepUp.run(() => setApprovalMode(jobId, body), w.stepUp);
      setData(r.approvalMode);
      setChoice(null);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
      if (toApiError(err).status === 409) load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={w.region}
      className="grid gap-2 rounded-[10px] border border-dy-line px-3 py-2.5"
      data-testid="approval-mode"
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        {data.canChange ? (
          <label htmlFor={selectId} className="grid min-w-0 gap-1 text-[0.8125rem] font-bold">
            {w.label}
            <select
              id={selectId}
              value={selected}
              disabled={busy}
              data-testid="approval-mode-select"
              onChange={(e) => {
                setChoice(e.target.value as ApprovalMode);
                setError(null);
              }}
              className={cx(DY_INPUT, 'border-dy-line-2 font-normal sm:w-auto')}
            >
              {options.map((o) => (
                <option key={o.mode} value={o.mode} disabled={!o.allowed && o.mode !== data.current}>
                  {approvalLabel(o.mode, t)}
                  {!o.allowed && o.mode !== data.current ? w.notAllowed : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="m-0 text-[0.875rem]">
            <span className="text-[0.8125rem] font-bold text-dy-muted">{`${w.label} `}</span>
            <span data-testid="approval-mode-current">{approvalLabel(data.current, t)}</span>
          </p>
        )}
        {data.canChange && choice !== null && choice !== data.current ? (
          <CardButton
            variant="primary"
            busy={busy}
            disabled={option?.allowed === false}
            onClick={() => void apply()}
          >
            {data.live === null ? w.change : w.changeNow}
          </CardButton>
        ) : null}
        {data.current !== data.original ? (
          <span className="text-[0.8125rem] text-dy-muted" data-testid="approval-mode-original">
            {w.original({ mode: approvalLabel(data.original, t) })}
          </span>
        ) : null}
      </div>
      {data.canChange && choice !== null && option !== undefined ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {approvalHint(option.mode, t)}
          {option.reason !== null ? <span className="block text-dy-amber-ink">{option.reason}</span> : null}
          {data.live !== null && option.allowed ? w.liveNote : ''}
        </p>
      ) : null}
      {last === null ? null : (
        <DyNotice
          tone={
            last.application === 'refused'
              ? 'red'
              : last.application === 'partial' || last.application === 'next_turn'
                ? 'amber'
                : 'neutral'
          }
          live
        >
          <span data-testid="approval-mode-applied" data-application={last.application ?? last.delivery}>
            {applicationText(last, t)}
            {last.detail !== null && last.application !== 'live' ? ` ${last.detail}` : ''}
            {last.pendingResolved > 0 ? w.resolved({ n: last.pendingResolved }) : ''}
          </span>
        </DyNotice>
      )}
      <DyErrorNotice error={error} retryLeft={0} />
    </section>
  );
}

/** The confirmed job a card started (job / machine task; run again / continue of one job), for the quick buttons. */
export function startedJob(
  d: Pick<ChatDraft, 'kind' | 'state'>,
  result: Record<string, unknown> | null,
): string | null {
  if (d.state !== 'confirmed' || result === null) return null;
  const id = result.jobId;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (d.kind === 'job' || d.kind === 'machine_task') return id;
  if (
    d.kind === 'job_action' &&
    (result.action === 'run_again' || result.action === 'continue' || result.action === 'resolve_conflicts')
  )
    return id;
  return null;
}
