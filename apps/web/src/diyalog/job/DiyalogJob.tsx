import { useJobMessages } from './delivery';
import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { continueJob, OPEN_PAUSE } from '../../api/approvalPause';
import type { ApiError } from '../../api/client';
import { getJobContinuity } from '../../api/continuity';
import type { ExportResult } from '../../api/download';
import { exportJob, getJob, type JobDetail, setJobTitle } from '../../api/jobs';
import { getJobMemory } from '../../api/memoryRecords';
import { listUsageCosts } from '../../api/usage';
import { useAuth } from '../../auth/AuthProvider';
import { cx, toApiError } from '../../components/ui';
import { useMachineNames } from '../../lib/machineDirectory';
import { useNow } from '../../lib/now';
import { isRetiredRuntime, runtimeName } from '../../lib/reasons';
import {
  CANCELLABLE,
  costByJob,
  costText,
  firstLine,
  RERUNNABLE,
  runAgainHref,
  TERMINAL,
} from '../../screens/job/format';
import { CancelDialog, type Live } from '../../screens/live/liveJob';
import { useLive } from '../../screens/live/useLive';
import { ExportNotice } from '../../screens/records';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyHeaderTools } from '../topbar';
import { DyIcon } from '../icons';
import { CardKeysProvider, focusCard, useThreadKeys } from '../ops/keys';
import { cardFor } from '../registry';
import { DyButton, DyButtonLink, Panel } from '../screens/parts';
import { ActivityLog, lastQuestionKey } from './ActivityLog';
import { hasAgentBox, writeToAgent } from './agentMessage';
import { useFormat, useLocale, useT } from '../../i18n/I18nProvider';
import { ApprovalModePanel, useApprovalModeState } from './ApprovalModePanel';
import { AutoActivityPanel } from './AutoActivityPanel';
import { RelatedWorkPanels } from '../related/RelatedWork';
import { JobTimeLimit } from '../common/timeLimit';
import { JobClockEndPanel } from '../common/jobClock';
import { DetailsView } from './details/DetailsView';
import { JobApprovalCard, MergeChanges } from './cards';
import { JobComposer } from './JobComposer';
import { JobHeader, type MenuItem, relativeText } from './JobHeader';
import { platformTitle } from './platform';
import { logRows } from './log';
import { buildJobThread, type JobThreadItem } from './mapping';
import { JOB_SIDE_CARDS, JOB_URGENT_CARDS } from './register';
import { useResource } from './resource';
import { StepBar } from './StepBar';
import { TrustCertificateCard } from './trust-certificate';
import { SWITCHABLE_RUNTIMES, SWITCHABLE_STATES, SwitchAccountDialog } from './switch-account';
import { type JobFacts, jobSteps } from './steps';
import type { JobCardProps } from './types';
import { remember, remembered } from '../../lib/remembered';

/**
 * p12-diyalog: `/jobs/:id` in the Diyalog shell — the job's CONTROL PANEL (a job page that looked like a chat read
 * poorly, docs/design/p12-diyalog.md §10). It replaced the Faz 2 thread layout; the data mapping, the
 * cards and the live stream stay.
 *
 *   header      title, id, state, project + class, runtime + model, machine, duration, cost, menu, "Ayrıntılar"
 *   step bar    Taslak → Kuyruk → Başladı → (Onay) → Doğrulama → Birleştirme / PR → Yayın → Bitti (steps.ts)
 *   main        "Akış günlüğü": the job's activity log (filters, search, live follow) + "Ajana yaz" / job actions
 *   side        what waits for a person first (pending approval, pause, queue), then verification, integration /
 *               merge, deploy, outputs, continuity, memory, runtime outcome, sub-jobs, preview tunnels, the prompt
 *
 * Live through the job's own event stream (`useLive`, the classic page's stream — no extra polling where it exists).
 * "Ayrıntılar" (`?view=details`) swaps the panel body for the Files / Logs / Details / Approvals tabs (the former
 * classic job page's tab ids, so old `&tab=` links keep working).
 */

const NO_CHANGES: readonly never[] = [];

interface DetailState {
  readonly data: JobDetail | null;
  readonly error: ApiError | null;
  readonly stale: ApiError | null;
}

function useJobDetail(id: string): DetailState & { reload: () => void } {
  // p14-web-perf: a job opened before in this tab shows its last detail at once while it is re-read.
  const [s, setS] = useState<DetailState>(() => ({
    data: remembered<JobDetail>(`job:${id}`) ?? null,
    error: null,
    stale: null,
  }));
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => {
    setRevision((r) => r + 1);
  }, []);
  useEffect(() => {
    let live = true;
    getJob(id).then(
      (d) => {
        if (!live) return;
        remember(`job:${id}`, d);
        setS({ data: d, error: null, stale: null });
      },
      (err: unknown) => {
        if (!live) return;
        const e = toApiError(err);
        setS((p) =>
          p.data !== null && p.data.job.id === id
            ? { ...p, stale: e }
            : { data: null, error: e, stale: null },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [id, revision]);
  return { ...s, reload };
}

function TopBar(props: { readonly live: Live; readonly terminal: boolean }): ReactNode {
  const { live } = props;
  const w = useT().job.page;
  const bad = live.status === 'error' || live.status === 'behind';
  return (
    <div className="flex min-h-[53px] items-center gap-3 border-b border-dy-line bg-dy-thread/85 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-[14px] backdrop-saturate-150 sm:px-6">
      <Link
        to="/jobs"
        className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] px-1.5 text-sm font-bold text-dy-ink no-underline sm:min-h-9"
      >
        <DyIcon name="back" />
        {w.back}
      </Link>
      <span
        className="flex items-center gap-[7px] text-[0.78125rem] text-dy-muted"
        data-testid="dy-live"
        data-status={live.status}
      >
        <span
          className={cx(
            'size-2 rounded-full',
            bad
              ? 'bg-dy-red'
              : live.status === 'live' && !props.terminal
                ? 'dy-breathe bg-dy-green'
                : 'bg-dy-line-2',
          )}
          aria-hidden="true"
        />
        {props.terminal && live.status === 'live'
          ? w.liveDoneOpen
          : Object.hasOwn(w.live, live.status)
            ? w.live[live.status]
            : live.status}
        {live.status === 'behind' ? (
          <button type="button" onClick={live.reload} className="font-medium text-dy-teal-ink underline">
            {w.refresh}
          </button>
        ) : null}
      </span>
      <DyHeaderTools className="ml-auto" />
    </div>
  );
}

/** The prompt and the record's basics: always present, so the side column is never empty. */
function PromptPanel(props: {
  readonly detail: JobDetail;
  readonly now: number;
  readonly detailsHref: string;
}): ReactNode {
  const j = props.detail.job;
  const w = useT().job.prompt;
  const f = useFormat();
  const prompt = typeof j.spec.prompt === 'string' ? j.spec.prompt : '';
  const [open, setOpen] = useState(false);
  const long = prompt.length > 420;
  const by = j.createdBy.type === 'user' ? w.byPerson : j.createdBy.type;
  return (
    <Panel
      title={w.title}
      testId="dy-job-prompt-panel"
      aside={
        <Link
          to={props.detailsHref}
          className="text-[0.8125rem] text-dy-teal-ink no-underline hover:underline"
        >
          {w.details}
        </Link>
      }
      sub={w.sub({
        by,
        ago: relativeText(j.createdAt, props.now, f),
        attempts: props.detail.attempts.length,
      })}
    >
      {prompt === '' ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{w.empty}</p>
      ) : (
        <>
          <p
            className="m-0 text-[0.875rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-testid="dy-job-prompt"
          >
            {long && !open ? `${prompt.slice(0, 420)}…` : prompt}
          </p>
          {long ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                setOpen((v) => !v);
              }}
              className="dy-press mt-1.5 text-[0.8125rem] font-medium text-dy-teal-ink underline-offset-2 hover:underline"
            >
              {open ? w.less : w.more}
            </button>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function Loaded(props: {
  readonly detail: JobDetail;
  readonly reload: () => void;
  readonly stale: ApiError | null;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const w = t.job.page;
  const { locale } = useLocale();
  const fmt = useFormat();
  const { detail, reload } = props;
  const j = detail.job;
  const { state: authState } = useAuth();
  const stepUp = useStepUp();
  const canAct = authState.kind !== 'signedIn' || authState.user.role !== 'viewer';
  const names = useMachineNames();
  const now = useNow();
  const live = useLive(j.id, j.state);
  const state = live.jobState ?? j.state;
  const finished = TERMINAL.has(state);
  const tl = useT().timeLimits;
  const runtime = typeof j.spec.runtime === 'string' ? j.spec.runtime : null;
  const retired = isRetiredRuntime(runtime);
  const prompt = typeof j.spec.prompt === 'string' ? j.spec.prompt : '';
  const [params, setParams] = useSearchParams();
  const detailsOpen = params.get('view') === 'details';
  const toggleDetails = useCallback((): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get('view') === 'details') {
          next.delete('view');
          next.delete('tab');
        } else next.set('view', 'details');
        return next;
      },
      { replace: false },
    );
  }, [setParams]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // p15-message-delivery: messages sent to the agent, with their delivery state (re-read after each send).
  const [sentBump, setSentBump] = useState(0);
  const jobMessages = useJobMessages(j.id, !finished, sentBump);
  const [facts, setFacts] = useState<JobFacts>({});
  // Approvals decided here stay in the decision column (collapsed to their outcome) for this visit.
  const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(new Set());

  // The stream reported a state the page does not show yet, or it reconnected: re-read the job.
  useEffect(() => {
    if (state !== j.state) reload();
  }, [state, j.state, reload]);
  useEffect(() => {
    if (live.resyncs > 0) reload();
  }, [live.resyncs, reload]);

  // p15-job-titles: the job's own short title (the prompt is its description, in the side panel).
  // p19-verifier-jobs: a platform verifier is titled from the job it checks, in the reader's language (unless edited).
  const jobTitle =
    (j.titleSource === 'edited' ? j.title : platformTitle(j.platform, j.title, t)) || firstLine(prompt);
  useEffect(() => {
    document.title = `${jobTitle || w.docTitle} · Remyral`; // i18n-ignore: product name
  }, [jobTitle, w.docTitle]);
  const rename = useCallback(
    async (title: string): Promise<void> => {
      await setJobTitle(j.id, title);
      reload();
    },
    [j.id, reload],
  );

  const approvalMode = useApprovalModeState(j.id, state);
  const modeChanges = approvalMode.data?.changes ?? NO_CHANGES;
  const [modeRequested, setModeRequested] = useState(false);
  // p13-runtime-accounts: "Hesabı değiştir" dialog.
  const [switching, setSwitching] = useState(false);
  const modeHandled = useCallback(() => {
    setModeRequested(false);
  }, []);
  const continuity = useResource((signal) => getJobContinuity(j.id, { signal }), `${j.id}:${state}`, {
    poll: () => !finished,
    ms: 15_000,
  });
  const pinned = state === 'QUEUED' || state === 'DRAFT' ? 'queued' : 'issued';
  const memory = useResource((signal) => getJobMemory(j.id, { signal }), `${j.id}:${pinned}`);
  const cost = useResource(
    (signal) => listUsageCosts({ job: j.id }, { signal }).then((r) => costByJob(r).get(j.id)),
    `${j.id}:${String(finished)}`,
  );

  const items = useMemo(
    () => buildJobThread({ detail, events: live.events, modeChanges, names, messages: t, locale }),
    [detail, live.events, modeChanges, names, t, locale],
  );

  const rows = useMemo(
    () => logRows(items, detail.approvals, jobMessages.messages, t),
    [items, detail.approvals, jobMessages.messages, t],
  );
  // p14-ask-user: the agent ended its text with a question — "Cevap yaz" focuses the message box (nothing is sent).
  const tq = t.questions.job;
  const askedKey = state === 'RUNNING' && canAct ? lastQuestionKey(rows) : null;
  const reply =
    askedKey === null
      ? null
      : {
          key: askedKey,
          label: tq.replyInline,
          hint: tq.replyInlineHint,
          onReply: () => {
            if (hasAgentBox(j.id)) writeToAgent(j.id, '');
          },
        };
  const report = useCallback((f: JobFacts) => {
    setFacts((prev) => ({ ...prev, ...f }));
  }, []);
  const steps = useMemo(() => jobSteps(detail, state, facts, t, fmt), [detail, state, facts, t, fmt]);

  const pendingApproval = detail.approvals.some((a) => a.status === 'pending');
  const stale =
    state !== 'PAUSED' &&
    !finished &&
    detail.approvals.some((a) => a.status === 'pending' && a.staleAt !== null && a.pauseRequestedAt === null);
  const rtName = runtime === null ? w.agent : runtimeName(runtime);
  const nowText =
    state === 'RUNNING'
      ? pendingApproval
        ? w.now.waiting({ runtime: rtName })
        : w.now.running({ runtime: rtName })
      : state === 'AWAITING_APPROVAL'
        ? w.now.waiting({ runtime: rtName })
        : state === 'STARTING' || state === 'RESERVED'
          ? w.now.preparing
          : state === 'VERIFYING'
            ? w.now.verifying
            : null;

  // The decision column: approvals still open (and the ones decided during this visit).
  const status = useMemo(() => new Map(detail.approvals.map((a) => [a.id, a.status] as const)), [detail]);
  const approvals = useMemo(
    () =>
      items.filter(
        (i): i is JobThreadItem & { kind: 'approval' } =>
          i.kind === 'approval' &&
          (i.requestId === null ||
            (status.get(i.requestId) ?? 'pending') === 'pending' ||
            decidedHere.has(i.requestId)),
      ),
    [items, status, decidedHere],
  );

  // p20-decisions: this job's `git.merge` approvals (their card draws the changes they merge).
  const mergeApprovals = useMemo(
    () => new Set(detail.approvals.filter((a) => a.action === 'git.merge').map((a) => a.id)),
    [detail],
  );

  const detailsHref = useCallback(
    (tab: 'files' | 'logs' | 'details'): string => `?view=details${tab === 'files' ? '' : `&tab=${tab}`}`,
    [],
  );
  const openCancel = useCallback(() => {
    setCancelOpen(true);
  }, []);
  const cardProps: JobCardProps = {
    detail,
    state,
    finished,
    canAct,
    reload,
    names,
    onCancel: openCancel,
    detailsHref,
    continuity: continuity.data,
    memory: memory.data,
    report,
  };

  const rootRef = useRef<HTMLDivElement>(null);
  useThreadKeys(rootRef);
  const goToApproval = (requestId: string): void => {
    const el = [...document.querySelectorAll<HTMLElement>('[data-card]')].find(
      (e) => e.dataset.card === `approval:${requestId}`,
    );
    if (el !== undefined) focusCard(el);
  };

  // The one action that fits the state (as the classic header's primary button).
  const navigate = useNavigate();
  const [continuing, setContinuing] = useState(false);
  // p19-verifier-jobs: a platform verifier is never run again as ordinary work (its verification has a retry).
  const rerunnable = RERUNNABLE.has(state) && !retired && (j.platform ?? null) === null;
  const canContinue = detail.continueAvailable && finished && !retired && canAct;
  const working =
    CANCELLABLE.has(state) && state !== 'AWAITING_APPROVAL' && state !== 'BLOCKED' && state !== 'PAUSED';
  const firstPending = detail.approvals.find((a) => a.status === 'pending') ?? null;
  const pauseOpen = detail.pause !== null && OPEN_PAUSE.has(detail.pause.status);
  const endedWhilePaused = pauseOpen && (finished || state === 'CANCELLING');
  let primary: ReactNode = null;
  let primaryKind: 'continue' | 'cancel' | 'review' | 'rerun' | null = null;
  if (canContinue) {
    primaryKind = 'continue';
    primary = (
      <DyButton
        variant="primary"
        icon="retry"
        busy={continuing}
        data-testid="continue-job"
        onClick={() => {
          setContinuing(true);
          setNotice(null);
          continueJob(j.id).then(
            (r) => {
              void navigate(`/jobs/${encodeURIComponent(r.jobId)}`);
            },
            (err: unknown) => {
              setContinuing(false);
              setNotice(sayError(err));
            },
          );
        }}
      >
        {w.actions.continue}
      </DyButton>
    );
  } else if (working && canAct) {
    primaryKind = 'cancel';
    primary = (
      <DyButton variant="danger" icon="xc" onClick={openCancel}>
        {w.actions.cancel}
      </DyButton>
    );
  } else if (state === 'AWAITING_APPROVAL' && firstPending !== null) {
    primaryKind = 'review';
    primary = (
      <DyButton
        variant="warn"
        icon="shield"
        data-testid="review-approval"
        onClick={() => {
          goToApproval(firstPending.id);
        }}
      >
        {w.actions.review}
      </DyButton>
    );
  } else if (rerunnable && canAct) {
    primaryKind = 'rerun';
    primary = (
      <DyButtonLink to={runAgainHref(j.id)} variant="primary" icon="retry">
        {w.actions.rerun}
      </DyButtonLink>
    );
  }

  const menu: MenuItem[] = [];
  if (rerunnable && canAct && primaryKind !== 'rerun')
    menu.push({ key: 'rerun', label: w.actions.rerun, icon: 'retry', to: runAgainHref(j.id) });
  if (!finished && state !== 'CANCELLING' && !retired)
    menu.push({
      key: 'mode',
      label: w.actions.mode,
      icon: 'shield',
      onSelect: () => {
        if (detailsOpen) toggleDetails();
        setModeRequested(true);
      },
    });
  menu.push({
    key: 'template',
    label: w.actions.template,
    icon: 'file',
    to: `/jobs/templates/new?fromJob=${encodeURIComponent(j.id)}`,
  });
  menu.push({
    key: 'export',
    label: w.actions.export,
    icon: 'tray',
    onSelect: () => {
      setNotice(w.actions.exporting);
      stepUp
        .run(() => exportJob(j.id), w.actions.exportStepUp)
        .then(
          (r) => {
            setExported(r);
            setNotice(null);
          },
          (err: unknown) => {
            setNotice(err instanceof StepUpCancelledError ? null : sayError(err));
          },
        );
    },
  });
  if (canAct && runtime !== null && SWITCHABLE_RUNTIMES.has(runtime) && SWITCHABLE_STATES.has(state))
    menu.push({
      key: 'account',
      label: w.actions.account,
      icon: 'key',
      onSelect: () => {
        setSwitching(true);
      },
    });
  if (canAct && CANCELLABLE.has(state) && primaryKind !== 'cancel')
    menu.push({ key: 'cancel', label: w.actions.cancelJob, icon: 'xc', danger: true, onSelect: openCancel });

  const card = (type: Parameters<typeof cardFor>[0]): ReactNode => (
    <JobCardSlot key={type} type={type} props={cardProps} />
  );

  return (
    <CardKeysProvider>
      <div className="dy-surface flex min-h-dvh min-w-0 flex-1 flex-col bg-dy-thread">
        <div className="sticky top-0 z-[5]">
          <TopBar live={live} terminal={finished} />
        </div>
        <JobHeader
          detail={detail}
          state={state}
          title={jobTitle || w.untitled}
          onRename={canAct ? rename : undefined}
          stale={stale}
          waiting={pendingApproval && !finished}
          names={names}
          now={now}
          cost={cost.data === undefined || cost.data === null ? null : costText(cost.data)}
          checkpoint={(() => {
            const c = continuity.data?.checkpoints.at(-1);
            return c === undefined ? null : { n: c.n, at: c.takenAt };
          })()}
          memoryItems={memory.data?.pinned === true ? memory.data.items.length : null}
          detailsOpen={detailsOpen}
          onDetails={toggleDetails}
          menu={menu}
          primary={primary}
          steps={<StepBar steps={steps} />}
        />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 px-3 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] outline-none sm:px-6 md:pb-8"
        >
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {props.stale === null ? null : (
              <p
                role="alert"
                className="m-0 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
              >
                {w.staleError({ error: sayError(props.stale) })}
              </p>
            )}
            {retired ? (
              <p
                className="m-0 rounded-[10px] bg-dy-sunk px-3.5 py-2 text-[0.875rem] text-dy-muted"
                data-testid="retired-runtime-notice"
              >
                {w.retired}
              </p>
            ) : null}
            {state === 'CANCELLING' ? (
              <p
                role="status"
                className="m-0 rounded-[10px] bg-dy-sunk px-3.5 py-2 text-[0.875rem] text-dy-muted"
              >
                {w.cancelling}
              </p>
            ) : null}
            {endedWhilePaused ? (
              <p className="m-0 text-[0.84375rem] text-dy-muted" data-testid="pause-ended">
                {w.pauseEnded}
              </p>
            ) : null}
            {stale && firstPending !== null ? (
              <p className="m-0 flex flex-wrap items-center gap-x-2 rounded-[10px] bg-dy-amber-soft px-3.5 py-2 text-[0.875rem] text-dy-amber-ink">
                <span className="min-w-0 flex-1">{w.staleApproval}</span>
                <button
                  type="button"
                  onClick={() => {
                    goToApproval(firstPending.id);
                  }}
                  className="dy-press font-bold underline underline-offset-2"
                >
                  {w.decide}
                </button>
              </p>
            ) : null}
            {notice === null ? null : (
              <p role="status" className="m-0 text-[0.84375rem] text-dy-muted">
                {notice}
              </p>
            )}
            {switching && runtime !== null ? (
              <SwitchAccountDialog
                jobId={j.id}
                runtime={runtime}
                current={
                  detail.runtimeAccount === undefined || detail.runtimeAccount === null
                    ? null
                    : { workerId: detail.runtimeAccount.workerId, id: detail.runtimeAccount.id }
                }
                onClose={() => {
                  setSwitching(false);
                }}
                onDone={(text) => {
                  setSwitching(false);
                  setNotice(text);
                  reload();
                }}
              />
            ) : null}
            {exported === null ? null : (
              <div className="font-sans text-fg">
                <ExportNotice result={exported} />
              </div>
            )}
            {detailsOpen ? (
              <DetailsView
                detail={detail}
                state={state}
                live={live}
                names={names}
                canAct={canAct}
                modeChanges={modeChanges}
                reload={reload}
              />
            ) : (
              <div
                ref={rootRef}
                data-testid="dy-job-panel"
                className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-4"
              >
                <aside
                  aria-label={w.urgent}
                  data-testid="dy-job-urgent"
                  className="grid min-w-0 gap-3 empty:hidden lg:col-start-2 lg:row-start-1"
                >
                  {approvals.map((a) => (
                    <JobApprovalCard
                      key={a.key}
                      requestId={a.requestId}
                      action={a.action}
                      description={a.description}
                      at={a.at}
                      state={state}
                      // p20-decisions: a merge approval carries its changes — one decision, one block (the
                      // "Değişiklikler" card stays away while it is pending).
                      extra={
                        a.requestId !== null && mergeApprovals.has(a.requestId) ? (
                          <MergeChanges {...cardProps} requestId={a.requestId} />
                        ) : undefined
                      }
                      onDecided={() => {
                        if (a.requestId !== null) {
                          const id = a.requestId;
                          setDecidedHere((s) => new Set([...s, id]));
                        }
                        reload();
                      }}
                    />
                  ))}
                  {/* p22-runtime-diagnostics: the failed request's certificate, to trust for the project. */}
                  {state === 'FAILED' ? (
                    <TrustCertificateCard detail={detail} canAct={canAct} onDone={reload} />
                  ) : null}
                  {JOB_URGENT_CARDS.map(card)}
                </aside>
                <div className="min-w-0 lg:sticky lg:top-[69px] lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:self-start">
                  <ActivityLog
                    rows={rows}
                    runtime={runtime}
                    now={nowText}
                    partial={live.partial}
                    logsHref={detailsHref('logs')}
                    onApproval={goToApproval}
                    reply={reply}
                    onResend={(text) => {
                      writeToAgent(j.id, text);
                    }}
                    warning={
                      live.status === 'error' ? (
                        <p
                          role="alert"
                          className="m-0 bg-dy-red-soft px-4 py-2 text-[0.84375rem] text-dy-red-ink"
                        >
                          {w.liveError({ error: live.error === null ? null : sayError(live.error) })}
                        </p>
                      ) : null
                    }
                    footer={
                      <JobComposer
                        inline
                        detail={detail}
                        state={state}
                        canAct={canAct}
                        retired={retired}
                        onCancel={openCancel}
                        onSent={() => {
                          setSentBump((n) => n + 1);
                        }}
                      />
                    }
                  />
                </div>
                <aside
                  aria-label={w.side}
                  data-testid="dy-job-side"
                  className="grid min-w-0 content-start gap-3 lg:col-start-2 lg:row-start-2"
                >
                  {JOB_SIDE_CARDS.map(card)}
                  <ApprovalModePanel
                    openRequested={modeRequested}
                    onOpenHandled={modeHandled}
                    jobId={j.id}
                    mode={approvalMode}
                    changeable={!finished && state !== 'CANCELLING' && !retired && canAct}
                    onChanged={reload}
                  />
                  {/* p15-autonomy: the time limit, extendable while the job waits or runs (no restart). */}
                  {finished ? (
                    // p20-job-clock: what it used, the waits that did not count, "Aynı yerden devam et" after a timeout.
                    <JobClockEndPanel
                      jobId={j.id}
                      state={state}
                      onContinued={(id) => {
                        void navigate(`/jobs/${id}`);
                      }}
                    />
                  ) : (
                    <Panel title={tl.title} testId="dy-job-time-limit">
                      <div className="px-4 pb-4">
                        <JobTimeLimit jobId={j.id} state={state} />
                      </div>
                    </Panel>
                  )}
                  {/* p15-auto-mode: automatic retries, approvals auto mode granted, self-healing, the fix job. */}
                  <AutoActivityPanel
                    jobId={j.id}
                    state={state}
                    canAct={canAct}
                    onResolveStarted={(id) => {
                      void navigate(`/jobs/${id}`);
                    }}
                  />
                  {/* p17-embeddings: similar past jobs; a failed job: how a similar failure was solved before. */}
                  <RelatedWorkPanels jobId={j.id} state={state} />
                  <PromptPanel detail={detail} now={now} detailsHref={detailsHref('details')} />
                </aside>
              </div>
            )}
          </div>
        </main>
      </div>
      <CancelDialog
        jobId={j.id}
        open={cancelOpen}
        onClose={() => {
          setCancelOpen(false);
        }}
        onCancelled={(s) => {
          live.setJobState(s);
          reload();
        }}
      />
    </CardKeysProvider>
  );
}

/** One side panel (a registered job card); renders nothing when the job has no such thing. */
function JobCardSlot(props: { readonly type: string; readonly props: JobCardProps }): ReactNode {
  return cardFor(props.type).renderJob?.(props.props) ?? null;
}

export function DiyalogJob(props: { readonly id: string }): ReactNode {
  const sayError = useErrorText();
  const w = useT().job.page;
  const { data, error, stale, reload } = useJobDetail(props.id);
  if (error !== null) {
    return (
      <div className="dy-surface flex min-h-dvh flex-1 flex-col items-start gap-3 bg-dy-thread px-4 pt-6 sm:px-6">
        <Link
          to="/jobs"
          className="inline-flex items-center gap-1.5 text-sm font-bold text-dy-ink no-underline"
        >
          <DyIcon name="back" />
          {w.back}
        </Link>
        <p role="alert" className="m-0 text-dy-red-ink">
          {w.loadError({ error: sayError(error) })}
        </p>
        <button
          type="button"
          onClick={reload}
          className="dy-press rounded-[9px] border border-dy-line-2 bg-dy-card px-3 py-1.5 text-sm"
        >
          {w.retry}
        </button>
      </div>
    );
  }
  if (data?.job.id !== props.id) {
    return (
      <div
        className="dy-surface flex min-h-dvh flex-1 items-start bg-dy-thread px-4 pt-6 text-dy-muted sm:px-6"
        role="status"
      >
        {w.loading}
      </div>
    );
  }
  // Keyed by job: another job starts with a fresh live stream.
  return <Loaded key={data.job.id} detail={data} reload={reload} stale={stale} />;
}
