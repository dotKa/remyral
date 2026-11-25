import type { Formatter, Messages } from '@remyral/i18n';
import { reviewRequestTerm } from '@remyral/protocol/git-host-rules';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { type ReactNode, useEffect, useState } from 'react';
import { hasAgentBox, writeToAgent } from './agentMessage';
import { Link, useNavigate } from 'react-router';
import { OPEN_PAUSE, resumeJob } from '../../api/approvalPause';
import { type ApprovalRequest, getApproval } from '../../api/approvals';
import type { JobContinuity, ToolClass } from '../../api/continuity';
import { deployOpen, getJobDeployOnSuccess, safeHttpsUrl } from '../../api/deployOnSuccess';
import {
  type DeployFixChain,
  fixPrefillState,
  getFixPlan,
  getJobDeployFixes,
} from '../../api/deployFeedback';
import { requestMerge } from '../../api/gitflow';
import {
  cancelIntegration,
  getJobIntegration,
  INTEGRATION_OPEN,
  type IntegrationView,
  retryIntegration,
  safePullRequestUrl,
  shortSha,
} from '../../api/integration';
import { runJobNow } from '../../api/jobs';
import type { InjectedItem } from '../../api/memoryRecords';
import { fileUrl, httpsUrl, listOutputs, type OutputItem, siteProviderText } from '../../api/outputs';
import { areaLabel, getJobRuntimeOutcome, type JobRuntimeOutcome, rateJob } from '../../api/runtimeAdvice';
import { getJobSubtasks } from '../../api/subtasks';
import {
  getJobVerification,
  overrideVerification,
  retryVerification,
  screenshotUrl,
  verificationOpen,
} from '../../api/verify';
import { useAuth } from '../../auth/AuthProvider';
import { cx } from '../../components/ui';
import { invalidate } from '../../lib/invalidate';
import { useNow } from '../../lib/now';
import { machineHref, runtimeName } from '../../lib/reasons';
import { mergeReadiness, useJobChanges } from '../../screens/jobChanges';
import { Markdown } from '../../screens/chat/markdown';
import { FullZipButton, useJobArchive } from './details/FullZip';
import { OutputReportNotices } from './details/OutputReport';
import { shortTime } from '../../screens/chat/time';
import { queueState } from '../../screens/job/queueState';
import { Countdown } from '../Countdown';
import { DyIcon, type IconName } from '../icons';
import { KeyValue } from '../KeyValue';
import { CardButton, CardLink, LiveCard } from '../LiveCard';
import { type DyState, StateBadge } from '../StateBadge';
import { RuntimeMark } from '../RuntimeMark';
import { INK } from '../tone';
import { ApprovalCard, agoText } from '../ops/cards';
import { DecisionPanel, useFreshStepUp } from '../ops/DecisionPanel';
import { causeWords } from './platform';
import { useResource } from './resource';
import type { JobCardProps } from './types';
import { toast } from '../toast/store';
import { DyConfirmDialog } from '../common/actions';

/**
 * p12-diyalog Faz 2: the cards of a job thread (docs/design/p12-diyalog.md §10). Each reads its data through the same
 * endpoint (and decides through the same calls and step-up rules) as its classic card on the job page, in the Diyalog
 * language; each renders nothing when the job has no such thing. Every text from agents, runtimes, repositories and
 * verifiers is rendered as text; only https links of known shapes (PR, deployed site, preview) become links, opened
 * outside the console with noopener.
 */

const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST']);

function Note(props: {
  readonly children: ReactNode;
  readonly tone?: 'red' | 'muted' | undefined;
}): ReactNode {
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

function Outcome(props: {
  readonly tone: 'green' | 'red' | 'neutral' | 'amber' | 'teal';
  readonly icon: IconName;
  readonly text: string;
  readonly at?: string | null | undefined;
}): ReactNode {
  const f = useFormat();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="dy-outcome">
      <DyIcon name={props.icon} className={cx('size-4', INK[props.tone])} />
      <b className={cx('font-bold', INK[props.tone])}>{props.text}</b>
      {props.at === undefined || props.at === null ? null : (
        <time dateTime={props.at} className="font-dy-mono text-[0.8125rem] text-dy-muted">
          {shortTime(props.at, new Date(), f)}
        </time>
      )}
    </span>
  );
}

type StepState = 'ok' | 'wait' | 'fail' | 'idle';

/** The mockup's vertical step list (`.steps`): icon, text with a small line under it, a mono fact on the right. */
export function Steps(props: {
  readonly label: string;
  readonly steps: readonly {
    readonly key: string;
    readonly state: StepState;
    readonly text: ReactNode;
    readonly sub?: ReactNode | undefined;
    readonly fact?: ReactNode | undefined;
  }[];
}): ReactNode {
  const w = useT().jobCards.steps;
  return (
    <ol className="m-0 grid list-none p-0" aria-label={props.label}>
      {props.steps.map((s, i) => (
        <li
          key={s.key}
          data-step={s.state}
          className="relative grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 py-[7px] text-[0.9375rem]"
        >
          {i < props.steps.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute top-[26px] bottom-[-6px] left-[10px] w-[1.5px] bg-dy-line-2"
            />
          ) : null}
          <DyIcon
            name={s.state === 'ok' ? 'checkc' : s.state === 'fail' ? 'xc' : 'clock'}
            className={cx(
              'mt-0.5 size-[18px]',
              s.state === 'ok'
                ? 'text-dy-green'
                : s.state === 'fail'
                  ? 'text-dy-red-ink'
                  : s.state === 'wait'
                    ? 'text-dy-amber-ink'
                    : 'text-dy-faint',
            )}
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="sr-only">
              {s.state === 'ok' ? w.ok : s.state === 'fail' ? w.fail : s.state === 'wait' ? w.wait : ''}
            </span>
            {s.text}
            {s.sub === undefined ? null : (
              <small className="block text-[0.8125rem] text-dy-muted">{s.sub}</small>
            )}
          </span>
          <span className="font-dy-mono text-[0.78125rem] whitespace-nowrap text-dy-muted">{s.fact}</span>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------------------------------------ approval

/**
 * An approval of this job, decided in the thread: the Faz 1 approval card (code field inside the card, deny with a
 * reason, a master-asked step-up re-opening the field) over the request read by id (`GET /approvals/:id`).
 */
export function JobApprovalCard(props: {
  readonly requestId: string | null;
  readonly action: string;
  readonly description: string;
  readonly at: string;
  /** The job state: a change re-reads the request (decided elsewhere, expired). */
  readonly state: string;
  readonly onDecided: () => void;
  /**
   * p20-decisions: the rest of the same decision, drawn inside this card (a `git.merge` approval: the changes it
   * merges — files, verification, merge check — and "Birleştirmeden kabul et"), so one decision is one block.
   */
  readonly extra?: ReactNode;
}): ReactNode {
  const w = useT().jobCards.approval;
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [failed, setFailed] = useState(false);
  const { requestId, state } = props;
  useEffect(() => {
    if (requestId === null) return;
    const ctl = new AbortController();
    getApproval(requestId, { signal: ctl.signal }).then(
      (r) => {
        setRequest(r.request);
        setFailed(false);
      },
      () => {
        if (!ctl.signal.aborted) setFailed(true);
      },
    );
    return () => {
      ctl.abort();
    };
  }, [requestId, state]);
  if (requestId === null || (request === null && failed)) {
    return (
      <LiveCard
        kind={{ label: w.label, icon: 'shield', tone: 'amber' }}
        meta={requestId === null ? w.saving : undefined}
        title={props.action}
        actions={
          requestId === null ? undefined : (
            <CardLink to={`/approvals/${encodeURIComponent(requestId)}`} variant="secondary">
              {w.openPage}
            </CardLink>
          )
        }
      >
        <p className="m-0 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]">{props.description}</p>
      </LiveCard>
    );
  }
  // p12-diyalog-default (visual tour): about an approval card's height (agent's words, command, effects, timer,
  // buttons) while it is read, not 6 rem — the activity log / side panels around it jumped by ~27 rem. Measured in
  // the harness: ~41 rem in the 400 px side column and on phones, ~33 rem across a 768–1023 px column.
  if (request === null)
    return (
      <div
        className="dy-breathe h-[41rem] rounded-[14px] border border-dy-line bg-dy-card md:max-lg:h-[33rem]"
        aria-hidden="true"
        data-testid="dy-approval-pending"
      />
    );
  return (
    <ApprovalCard
      item={{
        type: 'approval:request',
        id: `approval:${request.id}`,
        at: props.at,
        subject: null,
        unread: false,
        event: null,
        approval: request,
      }}
      onChanged={(next) => {
        if (next.type === 'approval:request') setRequest(next.approval);
        invalidate('approvals');
        props.onDecided();
      }}
      onChat={() => undefined}
      extra={props.extra}
      // p12-diyalog Faz 3: "Ajana yaz" fills the job's message box (whichever page shows it, agentMessage.ts).
      onWriteAgent={
        state !== 'RUNNING' || request.status !== 'pending' || !hasAgentBox(request.jobId)
          ? undefined
          : () => {
              writeToAgent(request.jobId, w.writeAgent({ headline: request.headline.text.slice(0, 120) }));
            }
      }
    />
  );
}

// ------------------------------------------------------------------------------------------------ pause

export function PauseCard(props: JobCardProps): ReactNode {
  const sayError = useErrorText();
  const w = useT().jobCards.pause;
  const p = props.detail.pause;
  const [busy, setBusy] = useState<'resume' | 'restart' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (
    p === null ||
    !OPEN_PAUSE.has(p.status) ||
    TERMINAL_STATES.has(props.state) ||
    props.state === 'CANCELLING'
  )
    return null;
  const machine = p.workerName ?? props.names.get(p.workerId) ?? p.workerId;
  const limit = p.cause === 'usage_limit';
  const restart = p.cause === 'worker_restart';
  // p13-runtime-accounts: a person moved the job to another runtime account.
  const accountSwitch = p.cause === 'account_switch';
  const decided = p.decision !== null || limit || restart || accountSwitch;
  const blocked = p.blockedReason !== null;
  const title = limit
    ? w.limitTitle({
        runtime: runtimeName(p.usageLimit?.runtime ?? '') || null,
        account: props.detail.runtimeAccount?.label ?? null,
      })
    : accountSwitch
      ? w.accountSwitchTitle
      : restart
        ? w.restartTitle
        : p.decision === null
          ? w.waitingTitle
          : w.decidedTitle;
  async function run(mode: 'resume' | 'restart'): Promise<void> {
    setBusy(mode);
    setError(null);
    try {
      await resumeJob(props.detail.job.id, mode);
      setConfirm(false);
      props.reload();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <LiveCard
      cardKey="job:pause"
      kind={{
        label: limit ? w.kindLimit : restart ? w.kindRestart : accountSwitch ? w.kindAccount : w.kindPaused,
        icon: 'pause',
        tone: 'violet',
      }}
      state={
        <StateBadge
          state="paused"
          label={p.status === 'resuming' ? w.resuming : p.status === 'pausing' ? w.pausing : w.paused}
        />
      }
      meta={agoText(p.pausedAt ?? p.requestedAt, Date.now())}
      title={title}
      sub={
        <>
          <Link
            to={machineHref(p.workerId)}
            className="font-dy-mono text-inherit underline-offset-2 hover:underline"
          >
            {machine}
          </Link>
          {p.cause === 'approval' && p.summary !== '' ? (
            <span className="[overflow-wrap:anywhere]">{p.summary}</span>
          ) : null}
        </>
      }
      actions={
        props.canAct ? (
          <>
            <CardButton
              variant="primary"
              icon="retry"
              busy={busy === 'resume'}
              disabled={!decided || blocked || p.status === 'pausing'}
              onClick={() => void run('resume')}
            >
              {w.resumeNow}
            </CardButton>
            <CardButton
              disabled={busy !== null || p.status === 'pausing'}
              onClick={() => {
                setConfirm(true);
              }}
            >
              {w.restart}
            </CardButton>
            <CardButton variant="danger" onClick={props.onCancel}>
              {w.cancel}
            </CardButton>
          </>
        ) : undefined
      }
      hint={!decided && !blocked ? w.hintDecision({ machine }) : limit && !blocked ? w.hintLimit : undefined}
      panel={
        <>
          <DyConfirmDialog
            open={confirm}
            onClose={() => {
              setConfirm(false);
            }}
            description={w.restartText}
            confirmLabel={w.confirmRestart}
            cancelLabel={w.back}
            busy={busy === 'restart'}
            testId="pause-restart-dialog"
            onConfirm={() => {
              setConfirm(false);
              void run('restart');
            }}
          />
          {error === null ? null : <Note tone="red">{error}</Note>}
        </>
      }
    >
      <div className="grid gap-3">
        {blocked ? <Note tone="red">{p.blockedReason}</Note> : null}
        {limit && p.resumeAt !== null && Date.parse(p.resumeAt) > Date.now() ? (
          <Countdown
            until={p.resumeAt}
            from={p.pausedAt ?? p.requestedAt}
            label={w.limitCountdown}
            tone="violet"
          />
        ) : null}
        <Countdown
          until={p.retainUntil}
          from={p.pausedAt ?? p.requestedAt}
          label={limit ? w.retainLimit : w.retainCancel}
          tone="neutral"
        />
        {p.resumeMode === 'session' ? (
          <p className="m-0 text-[0.84375rem] text-dy-muted">{w.resumeSession}</p>
        ) : p.resumeMode === 'continuation' ? (
          <p className="m-0 text-[0.84375rem] text-dy-muted">{w.resumeContinuation}</p>
        ) : null}
      </div>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ queue

export function QueueCard(props: JobCardProps): ReactNode {
  const sayError = useErrorText();
  const w = useT().jobCards.queue;
  const q = queueState(props.state, props.detail.scheduling);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (q === null) return null;
  const until = q.until;
  return (
    <LiveCard
      cardKey="job:queue"
      kind={{
        label: q.kind === 'quota' ? w.kindQuota : w.kindDeferred,
        icon: 'clock',
        tone: q.kind === 'quota' ? 'violet' : 'neutral',
      }}
      state={<StateBadge state="queued" />}
      title={q.kind === 'quota' ? w.titleQuota : w.titleDeferred}
      actions={
        q.kind !== 'quota' && props.canAct ? (
          <CardButton
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              runJobNow(props.detail.job.id).then(
                () => {
                  setBusy(false);
                  props.reload();
                },
                (err: unknown) => {
                  setBusy(false);
                  setError(sayError(err));
                },
              );
            }}
          >
            {w.startNow}
          </CardButton>
        ) : undefined
      }
      panel={error === null ? null : <Note tone="red">{error}</Note>}
    >
      {until === null || Date.parse(until) <= Date.now() ? null : (
        <Countdown until={until} label={w.countdown} tone={q.kind === 'quota' ? 'violet' : 'neutral'} />
      )}
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ subtasks

const SUB_STATE: Readonly<Record<string, DyState>> = {
  SUCCEEDED: 'done',
  FAILED: 'failed',
  LOST: 'failed',
  CANCELLED: 'cancelled',
  RUNNING: 'running',
  STARTING: 'running',
  VERIFYING: 'running',
  AWAITING_APPROVAL: 'needs',
  PAUSED: 'paused',
};

export function SubtasksCard(props: JobCardProps): ReactNode {
  const id = props.detail.job.id;
  const w = useT().jobCards.subtasks;
  const { data } = useResource((signal) => getJobSubtasks(id, { signal }), `${id}:${props.state}`, {
    poll: (v) => v !== null && v.children.some((c) => !TERMINAL_STATES.has(c.state)),
    ms: 15_000,
  });
  if (data === null || (data.children.length === 0 && data.parent === null)) return null;
  const done = data.children.filter((c) => c.state === 'SUCCEEDED').length;
  return (
    <LiveCard
      cardKey="job:subtasks"
      kind={{ label: w.label, icon: 'jobs', tone: 'teal' }}
      aside={data.children.length === 0 ? undefined : `${String(done)}/${String(data.children.length)}`}
      title={data.children.length === 0 ? w.isChild : w.split({ n: data.children.length })}
      sub={
        data.parent === null ? undefined : (
          <span>
            {w.parent}
            <Link
              to={`/jobs/${encodeURIComponent(data.parent.jobId)}`}
              className="text-inherit underline underline-offset-2"
            >
              {data.parent.title}
            </Link>
          </span>
        )
      }
    >
      {data.children.length === 0 ? undefined : (
        <ul
          className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3"
          aria-label={w.label}
        >
          {data.children.map((c) => (
            <li
              key={c.jobId}
              className="min-w-0 rounded-[10px] border border-dy-line bg-dy-card px-2.5 py-2 text-[0.8125rem]"
            >
              <Link
                to={`/jobs/${encodeURIComponent(c.jobId)}`}
                className="block truncate font-bold text-inherit no-underline hover:underline"
              >
                {c.title}
              </Link>
              <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-dy-muted">
                <RuntimeMark runtime={c.runtime} />
                {c.worker === null ? null : (
                  <span className="font-dy-mono">{props.names.get(c.worker) ?? c.worker}</span>
                )}
                <StateBadge state={SUB_STATE[c.state] ?? 'queued'} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ continuity

type Words = Messages['jobCards'];

/** A text of a closed set, or the raw value when the master sends one this console does not know. */
function known(map: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(map, key) ? (map[key] ?? key) : key;
}

const toolText = (w: Words, name: string, cls: ToolClass): string => `${name} (${w.continuity.classes[cls]})`;

function bytesText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`; // i18n-ignore: unit symbol (output kept as before)
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; // i18n-ignore: unit symbol
}

export function ContinuityCard(props: JobCardProps): ReactNode {
  const c: JobContinuity | null = props.continuity;
  const now = useNow();
  const t = useT().jobCards;
  const w = t.continuity;
  const f = useFormat();
  if (c === null || (c.checkpoints.length === 0 && c.restarts.length === 0)) return null;
  const last = c.checkpoints.at(-1);
  const unknown = c.restarts.flatMap((r) => r.unknownOutcome);
  return (
    <LiveCard
      cardKey="job:continuity"
      kind={{ label: w.label, icon: 'flag', tone: unknown.length > 0 ? 'amber' : 'teal' }}
      meta={last === undefined ? undefined : w.meta({ n: last.n, ago: agoText(last.takenAt, now) })}
      title={
        c.restarts.length === 0
          ? w.checkpoints({ n: c.checkpoints.length })
          : w.restarts({ n: c.restarts.length })
      }
      resolved={
        unknown.length === 0 && c.restarts.every((r) => r.status === 'resumed') ? (
          <Outcome
            tone="teal"
            icon="flag"
            text={last === undefined ? w.resumed : w.lastCheckpoint({ n: last.n })}
            at={last?.takenAt}
          />
        ) : undefined
      }
    >
      <div className="grid gap-3 text-[0.875rem]">
        {c.restarts.length === 0 ? null : (
          <ul className="m-0 grid list-none gap-2 p-0" aria-label={w.restartsLabel}>
            {c.restarts.map((r) => (
              <li key={r.pauseId} className="grid gap-0.5">
                <span className="[overflow-wrap:anywhere]">
                  <b className="font-bold">{r.summary}</b>
                  <span className="text-dy-muted">{` · ${known(w.restartStatus, r.status)}`}</span>
                </span>
                <span className="text-[0.8125rem] text-dy-muted">
                  {r.resume === 'session'
                    ? w.resumeSession({ n: r.checkpoint })
                    : w.resumeContinuation({ n: r.checkpoint })}
                </span>
                {r.unknownOutcome.length === 0 ? null : (
                  <span
                    className="rounded-[8px] bg-dy-amber-soft px-2.5 py-1.5 text-[0.8125rem] text-dy-amber-ink"
                    data-testid="dy-unknown-outcome"
                  >
                    {w.unknownOutcome({
                      calls: r.unknownOutcome.map((u) => toolText(t, u.toolName, u.class)).join(', '),
                    })}
                  </span>
                )}
                {r.blockedReason === null ? null : <Note tone="red">{r.blockedReason}</Note>}
              </li>
            ))}
          </ul>
        )}
        {c.checkpoints.length === 0 ? null : (
          <KeyValue
            rows={c.checkpoints.slice(-4).map((cp) => ({
              k: `#${String(cp.n)} · ${shortTime(cp.takenAt, new Date(), f)}`,
              v: w.checkpointRow({
                files: cp.files,
                size: bytesText(cp.bytes),
                snapshot: cp.kind === 'snapshot',
                lastTool: cp.lastTool === null ? null : toolText(t, cp.lastTool.toolName, cp.lastTool.class),
                inFlight: cp.inFlight,
              }),
              mono: true,
            }))}
          />
        )}
      </div>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ verification

const VERIFY_STATE: Readonly<Record<string, DyState>> = {
  waiting: 'queued',
  checking: 'running',
  verifying: 'running',
  passed: 'done',
  warned: 'stale',
  failed: 'failed',
  // p19-verifier-jobs: "Doğrulanamadı" — the verifier could not run; not a verdict on the job.
  error: 'cancelled',
  skipped: 'cancelled',
};

const CHECK_STEP: Readonly<Record<string, StepState>> = {
  pass: 'ok',
  warn: 'wait',
  fail: 'fail',
  skipped: 'idle',
};

export function VerificationCard(props: JobCardProps): ReactNode {
  const id = props.detail.job.id;
  const t = useT();
  const w = t.jobCards.verification;
  const wv = t.verifierJobs;
  const f = useFormat();
  const sayError = useErrorText();
  const { state: auth } = useAuth();
  const fresh = useFreshStepUp('deploy.production');
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  // p19-verifier-jobs: "Doğrulamayı yeniden dene" (the master checks jobs.create in the project).
  const mayRetry = auth.kind === 'signedIn' && auth.user.role !== 'viewer';
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [all, setAll] = useState(false);
  const { data: v, set } = useResource(
    (signal) => getJobVerification(id, { signal }),
    `${id}:${String(props.finished)}`,
    {
      poll: (x) => x !== null && props.finished && verificationOpen(x.state),
    },
  );
  const { report } = props;
  const vState = v?.state ?? null;
  useEffect(() => {
    report?.({ verification: vState });
  }, [report, vState]);
  if (v === null) return null;
  const st = { label: known(w.states, v.state), state: VERIFY_STATE[v.state] ?? ('queued' as const) };
  const open = verificationOpen(v.state);
  const tone = v.state === 'failed' ? 'red' : v.state === 'warned' || v.state === 'error' ? 'amber' : 'teal';
  const cause = v.state === 'error' ? causeWords(v.errorCause, t) : null;
  const retry = async (): Promise<void> => {
    setRetrying(true);
    setRetryNote(null);
    try {
      set(await retryVerification(id));
      setRetryNote(wv.retried);
    } catch (err) {
      setRetryNote(wv.retryFailed({ error: sayError(err) }));
    } finally {
      setRetrying(false);
    }
  };
  const findings = all ? v.findings : v.findings.slice(0, 5);
  return (
    <LiveCard
      cardKey="job:verification"
      kind={{ label: v.mode === 'gate' ? w.kindGate : w.kind, icon: 'checkc', tone }}
      state={<StateBadge state={st.state} label={st.label} />}
      meta={v.finishedAt === null ? undefined : shortTime(v.finishedAt, new Date(), f)}
      title={v.summary ?? (open ? w.checking : st.label)}
      sub={
        <>
          <span>
            {v.mode === 'gate' ? (v.hasDeployOnSuccess ? w.gateDeploy : w.gateReportOnly) : w.report}
          </span>
          {v.verifierJobId === null ? null : (
            <Link
              to={`/jobs/${encodeURIComponent(v.verifierJobId)}`}
              className="text-inherit underline underline-offset-2"
            >
              {w.verifierJob}
            </Link>
          )}
        </>
      }
      actions={
        v.state === 'error' && mayRetry ? (
          <CardButton
            variant="primary"
            icon="retry"
            busy={retrying}
            onClick={() => {
              void retry();
            }}
          >
            {retrying ? wv.retrying : wv.retry}
          </CardButton>
        ) : v.holdsDeploy && isAdmin ? (
          <CardButton
            variant="warn"
            icon="rocket"
            expanded={overriding}
            onClick={() => {
              setOverriding((x) => !x);
            }}
          >
            {w.override}
          </CardButton>
        ) : undefined
      }
      hint={v.holdsDeploy && isAdmin ? w.overrideHint : undefined}
      panel={
        overriding ? (
          <DecisionPanel
            intent="approve"
            needsCode={!fresh}
            submitLabel={w.overrideSubmit}
            reason={{ required: false, placeholder: w.overridePlaceholder }}
            onSubmit={async (reason) => {
              set(await overrideVerification(id, reason.trim()));
              setOverriding(false);
            }}
            onCancel={() => {
              setOverriding(false);
            }}
          />
        ) : null
      }
    >
      <div className="grid gap-3">
        {cause === null ? null : (
          <p className="m-0 text-[0.875rem] font-bold [overflow-wrap:anywhere]" data-testid="dy-verify-cause">
            {wv.couldNotRun({ cause })}
          </p>
        )}
        {retryNote === null ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted" role="status" data-testid="dy-verify-retry-note">
            {retryNote}
          </p>
        )}
        {v.reason === null ? null : (
          <p
            className={cx(
              'm-0 text-[0.875rem] [overflow-wrap:anywhere]',
              tone === 'red' ? 'text-dy-red-ink' : 'text-dy-muted',
            )}
          >
            {v.reason}
          </p>
        )}
        {v.checks.length === 0 ? null : (
          <Steps
            label={w.checks}
            steps={v.checks.map((c, i) => ({
              key: `${c.id}:${String(i)}`,
              state: CHECK_STEP[c.status] ?? 'idle',
              text: <span className="font-dy-mono text-[0.84375rem]">{c.id}</span>,
              sub: c.detail ?? undefined,
              fact: c.source === 'master' ? w.sourcePlatform : w.sourceVerifier,
            }))}
          />
        )}
        {v.screenshots.length === 0 ? null : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="dy-verify-shots">
            {v.screenshots.map((s) => (
              <figure key={`${s.jobId}-${s.artifactId}`} className="m-0 grid min-w-0 gap-1">
                <img
                  src={screenshotUrl(s)}
                  alt={w.screenshot({ name: s.name, width: s.width })}
                  loading="lazy"
                  className="max-h-44 w-full rounded-[10px] border border-dy-line object-cover object-top"
                />
                <figcaption className="truncate font-dy-mono text-[0.75rem] text-dy-muted">
                  {s.width === null ? s.name : `${String(s.width)} px`}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        {v.findings.length === 0 ? null : (
          <div className="grid gap-1.5">
            <ul className="m-0 grid list-none gap-1 p-0 text-[0.84375rem]" aria-label={w.findings}>
              {findings.map((g, i) => (
                <li key={String(i)} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
                  <span
                    className={cx(
                      'font-bold',
                      g.severity === 'fail'
                        ? 'text-dy-red-ink'
                        : g.severity === 'warn'
                          ? 'text-dy-amber-ink'
                          : 'text-dy-muted',
                    )}
                  >
                    {g.severity === 'fail'
                      ? w.severity.fail
                      : g.severity === 'warn'
                        ? w.severity.warn
                        : w.severity.info}
                  </span>
                  <span className="[overflow-wrap:anywhere]">{g.message}</span>
                </li>
              ))}
            </ul>
            {v.findings.length > findings.length ? (
              <button
                type="button"
                className="justify-self-start text-[0.8125rem] font-medium text-dy-teal-ink underline-offset-2 hover:underline"
                onClick={() => {
                  setAll(true);
                }}
              >
                {w.showAll({ n: v.findings.length })}
              </button>
            ) : null}
          </div>
        )}
        {v.override === null ? null : (
          <p className="m-0 text-[0.84375rem]">
            {w.overridden({ time: shortTime(v.override.at, new Date(), f), reason: v.override.reason })}
          </p>
        )}
      </div>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ integration

const INTEGRATION_STATE: Readonly<Record<string, DyState>> = {
  merging: 'running',
  resolving: 'running',
  verifying: 'running',
  fixing: 'running',
  publishing: 'running',
  ready: 'needs',
  merged: 'done',
  needs_human: 'stale',
  failed: 'failed',
  cancelled: 'cancelled',
};

function integrationSteps(m: IntegrationView, requested: boolean, t: Words, f: Formatter) {
  const w = t.integration;
  const merged = m.branches.filter((b) => b.state === 'merged' || b.state === 'resolved').length;
  const conflicts = m.branches.filter((b) => b.state === 'conflict' || b.state === 'resolved');
  const steps: { key: string; state: StepState; text: ReactNode; sub?: ReactNode; fact?: ReactNode }[] = [
    {
      key: 'branches',
      state:
        merged === m.branches.length && m.branches.length > 0
          ? 'ok'
          : m.state === 'merging'
            ? 'wait'
            : 'idle',
      text: w.branchesMerged,
      sub: m.branches.map((b) => b.title).join(', ') || undefined,
      fact: `${String(merged)}/${String(m.branches.length)}`,
    },
  ];
  if (conflicts.length > 0 || m.resolutionRounds > 0)
    steps.push({
      key: 'conflicts',
      state: conflicts.some((b) => b.state === 'conflict')
        ? m.state === 'resolving'
          ? 'wait'
          : 'fail'
        : 'ok',
      text: conflicts.some((b) => b.state === 'conflict') ? w.conflict : w.conflictResolved,
      sub: [...new Set(conflicts.flatMap((b) => b.conflictFiles))].slice(0, 4).join(', ') || undefined,
      fact: w.resolutions({ n: m.resolutionRounds, max: m.maxResolutions }),
    });
  if (m.verification !== null) {
    const vs = m.verification.state;
    steps.push({
      key: 'tests',
      state:
        vs === 'passed' || vs === 'warned'
          ? 'ok'
          : vs === 'failed' || vs === 'error'
            ? 'fail'
            : vs === 'running'
              ? 'wait'
              : 'idle',
      text: w.tests,
      sub: m.verification.summary ?? undefined,
      fact: m.fixRounds > 0 ? w.fixes({ n: m.fixRounds }) : vs,
    });
  }
  if (m.pullRequest !== null)
    steps.push({
      key: 'pr',
      state: 'ok',
      text: w.prOpened({ n: m.pullRequest.number }),
      fact: shortTime(m.updatedAt, new Date(), f),
    });
  if (m.state === 'ready')
    steps.push({
      key: 'approval',
      state: 'wait',
      text: w.approval,
      sub: w.approvalSub,
      fact: requested ? w.requested : w.waiting,
    });
  if (m.state === 'merged')
    steps.push({
      key: 'merged',
      state: 'ok',
      text: w.mergedInto({ target: m.targetBranch }),
      fact: shortTime(m.updatedAt, new Date(), f),
    });
  return steps;
}

export function IntegrationCard(props: JobCardProps): ReactNode {
  const sayError = useErrorText();
  const t = useT().jobCards;
  const w = t.integration;
  const f = useFormat();
  const id = props.detail.job.id;
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const needsWord = useT().shared.actionToast.openNeeds;
  const { data: m, set } = useResource(
    (signal) => getJobIntegration(id, { signal }),
    `${id}:${props.state}`,
    {
      poll: (x) => x !== null && INTEGRATION_OPEN.has(x.state),
      ms: 5_000,
    },
  );
  const { report } = props;
  const mState = m?.state ?? null;
  const mPr = m?.pullRequest !== null && m?.pullRequest !== undefined;
  useEffect(() => {
    report?.({ integration: mState === null ? null : { state: mState, pr: mPr } });
  }, [report, mState, mPr]);
  if (m === null) return null;
  const st = { label: known(w.states, m.state), state: INTEGRATION_STATE[m.state] ?? ('queued' as const) };
  const pr = m.pullRequest === null ? null : safePullRequestUrl(m.pullRequest.url);
  const act = async (name: string, fn: () => Promise<IntegrationView | null>): Promise<void> => {
    setBusy(name);
    setNote(null);
    try {
      const next = await fn();
      if (next !== null) set(next);
    } catch (err) {
      setNote(sayError(err));
    } finally {
      setBusy(null);
    }
  };
  const decidable = m.state === 'ready' || m.state === 'needs_human' || m.state === 'failed';
  return (
    <LiveCard
      cardKey="job:integration"
      kind={{
        label: w.label,
        icon: 'merge',
        tone: m.state === 'failed' ? 'red' : m.state === 'needs_human' ? 'amber' : 'teal',
      }}
      state={<StateBadge state={st.state} label={st.label} />}
      meta={
        <span className="font-dy-mono">
          {w.meta({ branch: m.branch, target: m.targetBranch, sha: shortSha(m.baseSha) })}
        </span>
      }
      title={
        m.state === 'merged'
          ? w.titleMerged({ branch: m.branch, target: m.targetBranch })
          : m.state === 'ready'
            ? w.titleReady({ branch: m.branch, target: m.targetBranch })
            : st.label
      }
      sub={m.reason === null ? undefined : <span className="[overflow-wrap:anywhere]">{m.reason}</span>}
      actions={
        decidable || pr !== null ? (
          <>
            {m.state === 'ready' && m.mergeJobId !== null && props.canAct ? (
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
                    props.reload();
                    // p17-toasts-shortcuts: "the approval card comes to the thread" is a toast (errors stay here).
                    toast.info(w.requestOpened, {
                      id: `merge-request-${id}`,
                      testId: 'integration-requested',
                      actions: [{ label: needsWord, to: '/needs' }],
                    });
                    return null;
                  })
                }
              >
                {requested ? w.requestedButton : w.requestButton}
              </CardButton>
            ) : null}
            {(m.state === 'needs_human' || m.state === 'failed') && props.canAct ? (
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
                    setCancelOpen((x) => !x);
                  }}
                >
                  {w.cancel}
                </CardButton>
              </>
            ) : null}
            {pr === null ? null : (
              <a
                href={pr}
                target="_blank"
                rel="noopener noreferrer"
                className="dy-press inline-flex items-center gap-[7px] rounded-[9px] border border-transparent px-[13px] py-[7px] text-sm font-medium whitespace-nowrap text-dy-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
              >
                <DyIcon name="globe" />
                {w.openPr({ n: String(m.pullRequest?.number ?? '') })}
              </a>
            )}
            <CardLink to={props.detailsHref('files')} variant="ghost">
              {w.seeDiff}
            </CardLink>
          </>
        ) : undefined
      }
      hint={m.state === 'ready' ? w.hintReady : undefined}
      panel={
        <>
          {cancelOpen ? (
            <DecisionPanel
              intent="deny"
              needsCode={false}
              submitLabel={w.cancelSubmit}
              reason={{ required: false, placeholder: w.reasonOptional }}
              onSubmit={async (reason) => {
                set(await cancelIntegration(m.id, reason === '' ? undefined : reason));
                setCancelOpen(false);
              }}
              onCancel={() => {
                setCancelOpen(false);
              }}
            />
          ) : null}
          {note === null ? null : <Note tone="red">{note}</Note>}
        </>
      }
      resolved={
        m.state === 'merged' || m.state === 'cancelled' ? (
          <Outcome
            tone={m.state === 'merged' ? 'green' : 'neutral'}
            icon={m.state === 'merged' ? 'merge' : 'xc'}
            text={st.label}
            at={m.updatedAt}
          />
        ) : undefined
      }
    >
      <Steps label={w.stepsLabel} steps={integrationSteps(m, requested, t, f)} />
      {m.warnings.length === 0 ? null : (
        <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-[0.8125rem] text-dy-amber-ink">
          {m.warnings.slice(0, 4).map((w, i) => (
            <li key={String(i)} className="[overflow-wrap:anywhere]">
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ changes (merge)

/**
 * A repository job's own changes and its protected merge (no integration): branch → target, files, CI, the merge
 * check and "Request merge" / "Accept without merging" — the classic Changes panel's actions, which open the admin +
 * step-up approval that then arrives in this thread as an approval card.
 */
type ChangeStep = { key: string; state: StepState; text: ReactNode; sub?: ReactNode; fact?: ReactNode };

/** The steps of a job's changes (files, verification, CI, merge check, review request, merged / waiting). */
function changeSteps(
  d: NonNullable<ReturnType<typeof useJobChanges>['data']>,
  ready: ReturnType<typeof mergeReadiness>,
  tc: Messages['jobCards'],
): ChangeStep[] {
  const w = tc.changes;
  const pr = d.pullRequest === null ? null : safePullRequestUrl(d.pullRequest.url);
  const ci = d.ci.state;
  const mc = d.mergeCheck.state;
  const steps: ChangeStep[] = [
    {
      key: 'files',
      state: 'ok',
      text: w.filesChanged({ n: d.totals.files }),
      sub:
        d.files
          .slice(0, 3)
          .map((f) => f.path)
          .join(', ') || undefined,
      fact: (
        <>
          <span className="text-dy-green">{`+${String(d.totals.additions)}`}</span>{' '}
          <span className="text-dy-red-ink">{`−${String(d.totals.deletions)}`}</span>
        </>
      ),
    },
    {
      key: 'verify',
      state: d.verification.status === 'passed' ? 'ok' : d.verification.status === 'failed' ? 'fail' : 'wait',
      text: w.platformVerify,
      sub: d.verification.reason ?? undefined,
      fact: d.verification.status,
    },
  ];
  if (ci !== null || d.ci.required)
    steps.push({
      key: 'ci',
      state: ci === 'success' ? 'ok' : ci === 'failure' || ci === 'error' ? 'fail' : 'wait',
      text: d.ci.required ? w.ciRequired : w.ci,
      fact: ci ?? w.ciWaiting,
    });
  if (d.merged === null)
    steps.push({
      key: 'merge-check',
      state: mc === 'clean' ? 'ok' : mc === 'conflicts' || mc === 'base_moved' ? 'fail' : 'wait',
      text:
        mc === 'conflicts'
          ? w.conflictsWith({ target: d.targetBranch ?? null })
          : mc === 'clean'
            ? w.clean
            : w.mergeCheck,
      sub:
        mc === 'conflicts' ? d.mergeCheck.files.slice(0, 4).join(', ') : (d.mergeCheck.reason ?? undefined),
    });
  if (pr !== null && d.pullRequest !== null)
    steps.push({ key: 'pr', state: 'ok', text: reviewRequestLabel(d.provider, d.pullRequest.number) });
  if (d.merged !== null)
    steps.push({ key: 'merged', state: 'ok', text: w.merged, fact: shortSha(d.merged.sha) });
  else if (ready.open !== null)
    steps.push({
      key: 'req',
      state: 'wait',
      text: w.awaitingApproval,
      sub: tc.integration.approvalSub,
    });
  return steps;
}

/**
 * p20-decisions (docs/design/p20-decisions.md): the open merge request's approval is pending in this job's decision
 * column — the approval card draws the changes (one decision, one block), so this card stays away until it is decided.
 */
export function mergeDecisionPending(
  open: ReturnType<typeof mergeReadiness>['open'],
  approvals: readonly { readonly id: string; readonly status: string }[],
): boolean {
  const id = open?.approvalRequestId ?? null;
  return id !== null && approvals.some((a) => a.id === id && a.status === 'pending');
}

export function ChangesCard(props: JobCardProps): ReactNode {
  const sayError = useErrorText();
  const tc = useT().jobCards;
  const w = tc.changes;
  const j = props.detail.job;
  const repo = j.projectKind !== 'workspace';
  const show = repo && (props.finished || props.state === 'AWAITING_APPROVAL');
  const changes = useJobChanges(j.id, props.state, show);
  const { requested, reload: reloadChanges } = changes;
  const { reload } = props;
  useEffect(() => {
    if (requested === null) return;
    reload();
    // p17-toasts-shortcuts: the result of "İstek aç" is a toast (it was a line under the card).
    toast.info(requested.created ? w.requestOpened : w.requestExists, {
      id: `changes-request-${j.id}`,
      testId: 'changes-requested',
    });
  }, [requested, reload, w, j.id]);
  const integration = useResource((signal) => getJobIntegration(j.id, { signal }), j.id);
  const d = changes.data;
  if (!show || d === null || !d.enabled || integration.data !== null) return null;
  if (d.commits.length === 0 && d.totals.files === 0 && d.merged === null) return null;
  const ready = mergeReadiness(d, props.state);
  // p20-decisions: the pending merge approval card shows these changes with its Onayla / Reddet.
  if (mergeDecisionPending(ready.open, props.detail.approvals)) return null;
  const platformMerge =
    props.state === 'AWAITING_APPROVAL' &&
    ready.open?.status === 'pending' &&
    ready.open.mode === 'merge' &&
    ready.open.requestedBy === null;
  const pr = d.pullRequest === null ? null : safePullRequestUrl(d.pullRequest.url);
  const mc = d.mergeCheck.state;
  const steps = changeSteps(d, ready, tc);
  return (
    <LiveCard
      cardKey="job:changes"
      kind={{ label: w.label, icon: 'branch', tone: mc === 'conflicts' ? 'amber' : 'teal' }}
      state={
        d.merged !== null ? (
          <StateBadge state="done" label={w.merged} />
        ) : ready.offer ? (
          <StateBadge state="needs" />
        ) : undefined
      }
      meta={
        d.branch === null ? undefined : (
          <span className="font-dy-mono">{`${d.branch} → ${d.targetBranch ?? ''}`}</span>
        )
      }
      title={
        d.merged !== null
          ? w.mergedInto({ target: d.targetBranch ?? null })
          : ready.offer
            ? w.askMerge
            : w.commits({ n: d.commits.length })
      }
      actions={
        <>
          {ready.offer && props.canAct ? (
            <>
              <CardButton
                variant="primary"
                icon="merge"
                busy={changes.busy === 'merge'}
                disabled={!ready.ready || changes.busy !== null}
                onClick={() => void changes.request('merge')}
              >
                {w.requestMerge}
              </CardButton>
              <CardButton
                busy={changes.busy === 'leave_open'}
                disabled={changes.busy !== null}
                onClick={() => void changes.request('leave_open')}
              >
                {w.acceptNoMerge}
              </CardButton>
            </>
          ) : platformMerge && props.canAct ? (
            // p15-merge-approvals: the platform opened the merge approval itself; keeping the PR open replaces it.
            <CardButton
              busy={changes.busy === 'leave_open'}
              disabled={changes.busy !== null}
              onClick={() => void changes.request('leave_open')}
            >
              {w.acceptNoMerge}
            </CardButton>
          ) : null}
          {pr === null ? null : (
            <a
              href={pr}
              target="_blank"
              rel="noopener noreferrer"
              className="dy-press inline-flex items-center gap-[7px] rounded-[9px] px-[13px] py-[7px] text-sm font-medium whitespace-nowrap text-dy-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              <DyIcon name="globe" />
              {reviewRequestLabel(d.provider, d.pullRequest?.number ?? 0)}
            </a>
          )}
          <CardLink to={props.detailsHref('files')} variant="ghost">
            {w.seeDiffFiles({ n: d.totals.files })}
          </CardLink>
        </>
      }
      hint={
        ready.offer && !ready.ready && ready.why !== null ? ready.why : ready.offer ? w.hintAdmin : undefined
      }
      panel={
        <>
          {changes.requestError === null ? null : <Note tone="red">{sayError(changes.requestError)}</Note>}
          {changes.error === null ? null : (
            <button
              type="button"
              className="text-[0.8125rem] text-dy-muted underline"
              onClick={reloadChanges}
            >
              {w.reread}
            </button>
          )}
        </>
      }
    >
      <Steps label={w.stepsLabel} steps={steps} />
    </LiveCard>
  );
}

/**
 * p20-decisions (docs/design/p20-decisions.md): the changes a pending `git.merge` approval
 * merges, inside that approval card — files with +/−, verification, CI and the merge check, the diff link and "Kabul et,
 * birleştirme" (keep the review request open instead). It was a second "Değişiklikler · Karar bekliyor" card under
 * the approval for the same decision. Other risks (agent tool approvals, a production deploy) stay their own cards.
 */
export function MergeChanges(props: JobCardProps & { readonly requestId: string }): ReactNode {
  const sayError = useErrorText();
  const tc = useT().jobCards;
  const w = tc.changes;
  const j = props.detail.job;
  const show = j.projectKind !== 'workspace';
  const changes = useJobChanges(j.id, props.state, show);
  const { requested } = changes;
  const { reload } = props;
  useEffect(() => {
    if (requested === null) return;
    reload();
    toast.info(requested.created ? w.requestOpened : w.requestExists, {
      id: `changes-request-${j.id}`,
      testId: 'changes-requested',
    });
  }, [requested, reload, w, j.id]);
  const d = changes.data;
  if (!show || d === null || !d.enabled) return null;
  const ready = mergeReadiness(d, props.state);
  if (ready.open?.approvalRequestId !== props.requestId) return null;
  const keepOpen =
    props.state === 'AWAITING_APPROVAL' &&
    ready.open.status === 'pending' &&
    ready.open.mode === 'merge' &&
    ready.open.requestedBy === null &&
    props.canAct;
  return (
    <section
      className="grid gap-1.5 rounded-[10px] border border-dy-line px-3 py-2"
      aria-label={w.label}
      data-testid="merge-changes"
    >
      <p className="m-0 flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
        <DyIcon name="branch" className="size-3.5" />
        <span className="font-bold text-dy-ink">{w.label}</span>
        {d.branch === null ? null : (
          <span className="font-dy-mono">{`${d.branch} → ${d.targetBranch ?? ''}`}</span>
        )}
      </p>
      <Steps label={w.stepsLabel} steps={changeSteps(d, { ...ready, open: null }, tc)} />
      <div className="flex flex-wrap items-center gap-1.5">
        <CardLink to={props.detailsHref('files')} variant="ghost">
          {w.seeDiffFiles({ n: d.totals.files })}
        </CardLink>
        {keepOpen ? (
          <CardButton
            busy={changes.busy === 'leave_open'}
            disabled={changes.busy !== null}
            onClick={() => void changes.request('leave_open')}
          >
            {w.acceptNoMerge}
          </CardButton>
        ) : null}
      </div>
      {changes.requestError === null ? null : <Note tone="red">{sayError(changes.requestError)}</Note>}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ deploy

const DEPLOY_TARGET = { pages: 'Cloudflare Pages', coolify: 'Coolify' } as const; // i18n-ignore: product names

export function DeployCard(props: JobCardProps): ReactNode {
  const id = props.detail.job.id;
  const w = useT().jobCards.deploy;
  const { data: d } = useResource(
    (signal) => getJobDeployOnSuccess(id, { signal }),
    `${id}:${String(props.finished)}`,
    {
      poll: (x) => x !== null && props.finished && deployOpen(x.state),
    },
  );
  const { report } = props;
  const dState = d?.state ?? null;
  const dWaiting = d?.opsActionState === 'awaiting_approval';
  useEffect(() => {
    report?.({ deploy: dState === null ? null : { state: dState, waiting: dWaiting } });
  }, [report, dState, dWaiting]);
  if (d === null) return null;
  const where = `${DEPLOY_TARGET[d.target]} (${d.env})`;
  const url = safeHttpsUrl(d.url);
  const waiting = d.opsActionState === 'awaiting_approval';
  const title =
    d.state === 'succeeded'
      ? w.succeeded({ where })
      : d.state === 'failed'
        ? w.failed({ where })
        : d.state === 'refused'
          ? w.refused({ where })
          : d.state === 'skipped'
            ? w.skipped({ where })
            : waiting
              ? w.waiting({ where })
              : props.finished
                ? w.running({ where })
                : w.later({ where });
  const st: DyState =
    d.state === 'succeeded'
      ? 'done'
      : d.state === 'failed' || d.state === 'refused'
        ? 'failed'
        : d.state === 'skipped'
          ? 'cancelled'
          : waiting
            ? 'needs'
            : props.finished
              ? 'running'
              : 'queued';
  const chain =
    d.publish === null
      ? null
      : [
          d.publish.createIfMissing
            ? w.createIfMissing({ project: d.publish.pagesProject ?? w.pagesProject })
            : (d.publish.pagesProject ?? w.pagesProject),
          ...(d.publish.domain === null
            ? []
            : [`${d.publish.domain}${d.publish.dns === 'skip' ? w.dnsSkip : ' + CNAME'}`]),
        ];
  return (
    <LiveCard
      cardKey="job:deploy"
      kind={{
        label: d.env === 'production' ? w.kindProduction : w.kind,
        icon: 'rocket',
        tone:
          d.state === 'failed' || d.state === 'refused' ? 'red' : d.env === 'production' ? 'amber' : 'teal',
      }}
      state={<StateBadge state={st} />}
      title={title}
      sub={
        <>
          {d.directory === null ? null : <span className="font-dy-mono">{`${d.directory}/`}</span>}
          <span>
            {d.covers === 'none'
              ? w.agentAsked({ who: d.approvedBy.username ?? d.approvedBy.id })
              : w.approved({ who: d.approvedBy.username ?? d.approvedBy.id, code: d.stepUp })}
          </span>
        </>
      }
      actions={
        url !== null || d.opsActionId !== null ? (
          <>
            {url === null ? null : (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="dy-press inline-flex items-center gap-[7px] rounded-[9px] border border-dy-ink bg-dy-ink px-[13px] py-[7px] text-sm font-bold whitespace-nowrap text-dy-card no-underline"
              >
                <DyIcon name="globe" />
                {w.openSite}
              </a>
            )}
            {d.opsActionId === null ? null : (
              <CardLink
                to={`/deploys/${encodeURIComponent(d.opsActionId)}`}
                variant={waiting ? 'primary' : 'ghost'}
                icon="rocket"
              >
                {waiting ? w.goApproval : w.record}
              </CardLink>
            )}
            {url === null ? null : (
              <CardLink to={`/outputs?tab=site&job=${encodeURIComponent(id)}`} variant="ghost">
                {w.showInOutputs}
              </CardLink>
            )}
            {d.state === 'failed' && d.opsActionId !== null ? (
              <>
                <CardLink
                  to={`/deploys/${encodeURIComponent(d.opsActionId)}?logs=build`}
                  variant="ghost"
                  icon="term"
                >
                  {w.seeLogs}
                </CardLink>
                <FixJobCardButton actionId={d.opsActionId} />
              </>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="grid gap-2.5">
        {url === null ? null : (
          <p
            className="m-0 font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]"
            data-testid="dy-deploy-url"
          >
            {url}
          </p>
        )}
        {chain === null ? null : (
          <Steps
            label={w.chainLabel}
            steps={chain.map((c, i) => ({
              key: String(i),
              state:
                d.state === 'succeeded'
                  ? 'ok'
                  : d.state === 'failed' || d.state === 'refused'
                    ? 'fail'
                    : 'idle',
              text: c,
            }))}
          />
        )}
        <FixChainLine jobId={id} />
        {d.reason !== null && d.state !== 'succeeded' ? (
          <p
            className={cx(
              'm-0 text-[0.875rem] [overflow-wrap:anywhere]',
              d.state === 'failed' || d.state === 'refused' ? 'text-dy-red-ink' : 'text-dy-muted',
            )}
          >
            {d.reason}
          </p>
        ) : null}
      </div>
    </LiveCard>
  );
}

/** p12-deploy-feedback: "Düzeltme işi başlat" — the master's fix plan opened in the composer (nothing is created yet). */
function FixJobCardButton(props: { readonly actionId: string }): ReactNode {
  const sayError = useErrorText();
  const w = useT().jobCards.deploy;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <CardButton
        variant="primary"
        icon="pen"
        busy={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void getFixPlan(props.actionId)
            .then((plan) => navigate('/jobs/new', { state: fixPrefillState(plan) }))
            .catch((err: unknown) => {
              setError(sayError(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {w.fixStart}
      </CardButton>
      {error === null ? null : (
        <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
          {error}
        </span>
      )}
    </>
  );
}

/** p12-deploy-feedback: the fix chain of a job (job → deploy failed → fix job → redeploy). */
function FixChainLine(props: { readonly jobId: string }): ReactNode {
  const w = useT().jobCards.deploy;
  const [c, setC] = useState<DeployFixChain | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    void getJobDeployFixes(props.jobId, { signal: ctl.signal })
      .then(setC)
      .catch(() => undefined);
    return () => {
      ctl.abort();
    };
  }, [props.jobId]);
  if (c === null || (c.fixOf === null && c.fixes.length === 0)) return null;
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]" data-testid="deploy-fix-chain">
      {c.fixOf === null ? null : (
        <li>
          {w.fixOf}
          {c.fixOf.sourceJobId === null ? null : (
            <>
              {' '}
              (<Link to={`/jobs/${encodeURIComponent(c.fixOf.sourceJobId)}`}>{w.sourceJob}</Link>
              {c.fixOf.opsActionId === null ? null : (
                <>
                  , <Link to={`/deploys/${encodeURIComponent(c.fixOf.opsActionId)}`}>{w.failedDeploy}</Link>
                </>
              )}
              , {w.attempt({ n: c.fixOf.attempt })})
            </>
          )}
          .
        </li>
      )}
      {c.fixes.map((f) => (
        <li key={f.id}>
          {f.state === 'created' && f.fixJobId !== null ? (
            <>
              {w.autoFixStarted}{' '}
              <Link to={`/jobs/${encodeURIComponent(f.fixJobId)}`}>{f.fixJobId.slice(0, 8)}</Link> (
              {w.attempt({ n: f.attempt })})
            </>
          ) : (
            <span className="text-dy-muted">{w.autoFixNotStarted({ reason: f.reason ?? null })}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ outputs

const PREVIEW_CHARS = 20_000;

/** Inline preview of one output file: an image as an image, Markdown through the safe renderer, text as text. */
function FilePreview(props: { readonly item: OutputItem }): ReactNode {
  const w = useT().jobCards.outputs;
  const f = props.item.file;
  const download = f?.download ?? null;
  const kind = f?.preview ?? 'none';
  const textual =
    kind === 'markdown' || kind === 'text' || kind === 'json' || kind === 'csv' || kind === 'tsv';
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unreadable = w.unreadable;
  useEffect(() => {
    if (!textual || download === null) return;
    const ctl = new AbortController();
    fetch(fileUrl(download, true), { credentials: 'same-origin', signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
        const t = await r.text();
        setText(t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS)}\n…` : t);
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : unreadable);
      });
    return () => {
      ctl.abort();
    };
  }, [download, textual, unreadable]);
  if (f === null || download === null) return null;
  if (kind === 'image')
    return (
      <img
        src={fileUrl(download, true)}
        alt={w.previewAlt({ name: props.item.name })}
        loading="lazy"
        className="max-h-[50vh] max-w-full rounded-[10px] border border-dy-line"
        data-testid="dy-image-preview"
      />
    );
  if (!textual) return <Note>{w.noPreview}</Note>;
  if (error !== null) return <Note tone="red">{w.previewError({ error })}</Note>;
  if (text === null) return <Note>{w.previewLoading}</Note>;
  return kind === 'markdown' ? (
    <div
      className="max-h-[50vh] overflow-auto rounded-[10px] border border-dy-line bg-dy-card p-3 text-[0.9375rem]"
      data-testid="dy-markdown-preview"
    >
      <Markdown text={text} />
    </div>
  ) : (
    <pre className="m-0 max-h-[50vh] overflow-auto rounded-[10px] bg-dy-sunk px-3 py-2 font-dy-mono text-[0.78125rem] whitespace-pre">
      {text}
    </pre>
  );
}

function OutputRow(props: { readonly item: OutputItem }): ReactNode {
  const { item } = props;
  const w = useT().jobCards.outputs;
  const [open, setOpen] = useState(false);
  const f = item.file;
  const site = item.site;
  if (site !== null) {
    const url = httpsUrl(site.url);
    return (
      <li className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 py-1.5">
        <DyIcon name="globe" className="size-4 text-dy-muted" />
        <span className="min-w-0">
          <b className="block truncate font-bold">{item.title ?? item.name}</b>
          <small className="text-[0.8125rem] text-dy-muted">{`${siteProviderText(site.provider)}, ${site.env}`}</small>
        </span>
        {url === null ? null : (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[0.84375rem] font-medium text-dy-teal-ink underline-offset-2 hover:underline"
          >
            {w.open}
          </a>
        )}
      </li>
    );
  }
  if (f === null) return null;
  const previewable =
    f.download !== null &&
    f.removed === null &&
    f.preview !== 'none' &&
    f.preview !== 'pdf' &&
    f.preview !== 'diff';
  return (
    <li className="grid gap-2 py-1.5">
      <span className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5">
        <DyIcon name="file" className="size-4 text-dy-muted" />
        <span className="min-w-0">
          <b className="block truncate font-dy-mono text-[0.84375rem] font-medium">{item.name}</b>
          <small className="text-[0.8125rem] text-dy-muted">
            {`${f.mediaType}${f.sizeBytes === null ? '' : `, ${bytesText(f.sizeBytes)}`}${f.removed === null ? '' : `, ${w.contentRemoved}`}`}
          </small>
        </span>
        <span className="flex items-center gap-3 text-[0.84375rem]">
          {previewable ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                setOpen((x) => !x);
              }}
              className="font-medium text-dy-teal-ink underline-offset-2 hover:underline"
            >
              {open ? w.hide : w.preview}
            </button>
          ) : null}
          {f.download === null || f.removed !== null ? null : (
            <a
              href={fileUrl(f.download, false)}
              download
              className="text-dy-muted underline-offset-2 hover:underline"
            >
              {w.download}
            </a>
          )}
        </span>
      </span>
      {open ? <FilePreview item={item} /> : null}
    </li>
  );
}

export function OutputsCard(props: JobCardProps): ReactNode {
  const id = props.detail.job.id;
  const w = useT().jobCards.outputs;
  const { data } = useResource(
    (signal) => listOutputs({ job: id, limit: 24 }, { signal }),
    `${id}:${props.state}`,
  );
  // p18-outputs-delivery: a workspace job's every file in one zip (primary), and its zipped-delivery line.
  const workspace = props.detail.job.projectKind === 'workspace';
  const { archive, report } = useJobArchive(id, workspace, `${id}:${props.state}`);
  const full = workspace && archive !== null && archive.files > 0;
  // Preview links (tunnels) have their own card.
  const items = (data?.items ?? []).filter(
    (i) => i.site?.provider !== 'tunnel' && (i.file !== null || i.site !== null),
  );
  if (items.length === 0) return null;
  const files = items.filter((i) => i.file !== null).length;
  const sites = items.length - files;
  return (
    <LiveCard
      cardKey="job:outputs"
      kind={{ label: w.label, icon: 'tray', tone: 'teal' }}
      aside={
        data !== null && data.total > items.length
          ? `${String(items.length)}/${String(data.total)}`
          : undefined
      }
      title={[files > 0 ? w.files({ n: files }) : null, sites > 0 ? w.sites({ n: sites }) : null]
        .filter(Boolean)
        .join(', ')}
      actions={
        <>
          {full ? <FullZipButton jobId={id} archive={archive} testId="job-outputs-download-all" /> : null}
          <CardLink to={`/outputs?job=${encodeURIComponent(id)}`} variant="secondary" icon="tray">
            {w.openInOutputs}
          </CardLink>
          <CardLink to={props.detailsHref('files')} variant="ghost">
            {w.allFiles}
          </CardLink>
        </>
      }
    >
      {workspace ? <OutputReportNotices report={report} compact jobId={id} /> : null}
      <ul className="m-0 grid list-none divide-y divide-dy-line p-0 text-[0.875rem]" aria-label={w.label}>
        {items.map((i) => (
          <OutputRow key={i.key} item={i} />
        ))}
      </ul>
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ runtime outcome

export function RuntimeOutcomeCard(props: JobCardProps): ReactNode {
  const sayError = useErrorText();
  const w = useT().jobCards.runtime;
  const id = props.detail.job.id;
  const ended = props.state === 'SUCCEEDED' || props.state === 'FAILED';
  const { data: view, set } = useResource(
    (signal) => getJobRuntimeOutcome(id, { signal }),
    `${id}:${String(ended)}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (view === null || (view.classification === null && view.decision === null)) return null;
  const c = view.classification;
  const rating = view.rating?.value ?? null;
  const rate = (r: 1 | -1): void => {
    setBusy(true);
    setError(null);
    rateJob(id, rating === r ? null : r)
      .then(() => getJobRuntimeOutcome(id))
      .then(
        (v: JobRuntimeOutcome) => {
          set(v);
        },
        (err: unknown) => {
          setError(sayError(err));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  const rows = [
    ...(c === null
      ? []
      : [
          {
            k: w.area,
            v: `${areaLabel(c.area)}${c.kind === null ? '' : `, ${c.kind}`}${
              c.signals.length === 0
                ? ''
                : ` (${c.signals
                    .slice(0, 3)
                    .map((s) => `${s.source} “${s.detail}”`)
                    .join(', ')})`
            }`,
          },
        ]),
    ...(view.decision === null
      ? []
      : [
          {
            k: w.choice,
            v: `${runtimeName(view.decision.runtime)} (${known(w.how, view.decision.how)}): ${view.decision.reasons.join('; ')}`,
          },
        ]),
    ...(view.outcome === null
      ? []
      : [
          {
            k: w.result,
            v: w.outcome({ good: view.outcome.good, reasons: view.outcome.reasons.join(', ') }),
          },
        ]),
  ];
  return (
    <LiveCard
      cardKey="job:runtime"
      kind={{ label: w.label, icon: 'gauge', tone: 'violet' }}
      title={
        view.decision === null
          ? w.titleArea({ area: areaLabel(c?.area ?? null).toLowerCase() })
          : w.chosen({ runtime: runtimeName(view.decision.runtime) })
      }
      actions={
        ended && props.canAct ? (
          <>
            <span className="text-[0.84375rem] text-dy-muted">{w.question}</span>
            <button
              type="button"
              aria-pressed={rating === 1}
              aria-label={w.good}
              disabled={busy}
              onClick={() => {
                rate(1);
              }}
              data-testid="dy-rate-up"
              className={cx(
                'dy-press inline-flex size-9 items-center justify-center rounded-[9px] border',
                rating === 1
                  ? 'border-dy-green bg-dy-green-soft text-dy-green'
                  : 'border-dy-line-2 bg-dy-card text-dy-muted',
              )}
            >
              <DyIcon name="thumbUp" className="size-[18px]" />
            </button>
            <button
              type="button"
              aria-pressed={rating === -1}
              aria-label={w.bad}
              disabled={busy}
              onClick={() => {
                rate(-1);
              }}
              data-testid="dy-rate-down"
              className={cx(
                'dy-press inline-flex size-9 items-center justify-center rounded-[9px] border',
                rating === -1
                  ? 'border-dy-red bg-dy-red-soft text-dy-red-ink'
                  : 'border-dy-line-2 bg-dy-card text-dy-muted',
              )}
            >
              <DyIcon name="thumbDown" className="size-[18px]" />
            </button>
          </>
        ) : undefined
      }
      hint={ended && props.canAct ? w.hint : undefined}
      panel={error === null ? null : <Note tone="red">{error}</Note>}
    >
      <KeyValue rows={rows} />
    </LiveCard>
  );
}

// ------------------------------------------------------------------------------------------------ memory

function injectedTitleOf(i: InjectedItem, w: Words): string {
  if (i.title === null && i.docId === '') return w.memory.ownerRule;
  return i.title ?? i.kind;
}

/** p17-chat-flow item 6: where a pinned memory record is read (its project's memory tab, global or personal rules). */
function injectedHref(i: InjectedItem): string | null {
  if (i.recordType === null || i.docId === '') return null;
  const id = encodeURIComponent(i.docId);
  if (i.namespace.startsWith('user:') || i.scope?.startsWith('user:') === true)
    return '/settings/profile#personal-rules';
  if (i.namespace.startsWith('project:'))
    return `/projects/${encodeURIComponent(i.namespace.slice('project:'.length))}?tab=memory&record=${id}`;
  return `/settings/context?record=${id}`;
}

/** p17-chat-flow item 6: the pinned bundle's version as shown ("sha256:ab12cd34…" → "ab12cd34"). */
export function bundleVersion(hash: string | null): string {
  if (hash === null) return '—';
  return hash.replace(/^sha256:/, '').slice(0, 8);
}

export function MemoryCard(props: JobCardProps): ReactNode {
  const all = useT();
  const t = all.jobCards;
  const w = t.memory;
  const m = props.memory;
  if (m === null) return null;
  const items = [...m.items].sort((a, b) => a.position - b.position);
  const records = items.filter((i) => i.recordType !== null).length;
  const changed = items.filter((i) => i.statusNow !== null && i.statusNow !== 'active').length;
  return (
    <LiveCard
      cardKey="job:memory"
      kind={{ label: w.label, icon: 'brain', tone: 'violet' }}
      title={!m.pinned ? w.notPinned : items.length === 0 ? w.none : w.given({ n: items.length })}
      resolved={
        m.pinned && items.length > 0 ? (
          <Outcome
            tone={changed > 0 ? 'amber' : 'neutral'}
            icon="brain"
            text={changed > 0 ? w.changed({ n: changed }) : w.sameVersion}
          />
        ) : undefined
      }
    >
      {items.length === 0 ? undefined : (
        <>
          {/* p17-chat-flow item 6: how many memory records the job used and which pinned version of the set. */}
          <p className="m-0 mb-1.5 text-[0.84375rem] font-bold" data-testid="dy-memory-used">
            {all.chatFlow.memory.used({ n: records, version: bundleVersion(m.bundleHash) })}
          </p>
          <ol className="m-0 grid list-none gap-1 p-0 text-[0.84375rem]" aria-label={w.listLabel}>
            {items.map((i) => (
              <li
                key={`${String(i.position)}:${i.docId}`}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-2"
              >
                <span className="text-right font-dy-mono text-dy-faint">{i.position}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="text-dy-muted">{`${known(w.layers, i.layer)}${i.recordType === null ? '' : ` · ${known(w.records, i.recordType)}`} · `}</span>
                  {injectedHref(i) === null ? (
                    injectedTitleOf(i, t)
                  ) : (
                    <Link
                      to={injectedHref(i) ?? ''}
                      className="text-dy-ink underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      data-testid="dy-memory-record-link"
                    >
                      {injectedTitleOf(i, t)}
                    </Link>
                  )}
                  {i.statusNow === null || i.statusNow === 'active' ? null : (
                    <span className="ml-1.5 text-dy-amber-ink" data-testid="dy-memory-changed">
                      {w.changedSince({ status: known(w.now, i.statusNow) })}
                    </span>
                  )}
                </span>
                <span className="font-dy-mono text-dy-muted">{`v${String(i.version)}`}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </LiveCard>
  );
}

/** p16-git-providers: `PR #12` (GitHub, Bitbucket) or `MR !12` (GitLab). */
function reviewRequestLabel(provider: string | null, n: number): string {
  const term = reviewRequestTerm(provider);
  return `${term.short} ${term.numberPrefix}${String(n)}`;
}
