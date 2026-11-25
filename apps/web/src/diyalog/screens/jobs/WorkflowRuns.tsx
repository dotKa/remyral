import { useErrorText } from '../../../i18n/errors';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  cancelWorkflowRun,
  decideGate,
  getWorkflowRun,
  listWorkflowRuns,
  type RunEdge,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowRunSummary,
} from '../../../api/workflows';
import { useAuth } from '../../../auth/AuthProvider';
import { cx, toApiError, useRetryCountdown } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import { runtimeName } from '../../../lib/reasons';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon, type IconName } from '../../icons';
import { jobStatePill } from '../../job/JobHeader';
import { KeyValue, type KeyValueRow } from '../../KeyValue';
import type { Tone } from '../../tone';
import { agoText, DyButton, EmptyLine, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DyConfirmDialog } from '../../common/actions';
import { ScreenFrame } from '../ScreenFrame';
import { RunIntegration } from './RunIntegration';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { decideNodeRun } from '../../../api/workflowEngine';
import { NodeRunsSection } from '../workflows/NodeRuns';
import { nodeName, v2Look } from '../workflows/runView';
import { NodeSideEffects, ResumeWait, TriggerFacts } from '../workflows/RunSideEffects';
import { CopiedMark, PauseResume, RerunDialog, RunOpsBands } from '../workflows/RunOps';
import type { SideEffect } from '../../../api/workflows';
import type { Messages } from '@remyral/i18n';
import { SolvedBefore } from '../../related/RelatedWork';

/**
 * p12-diyalog-w1: workflow runs in the Diyalog language — the recent runs on İşler (the classic `WorkflowRunsList`
 * read, `GET /workflow-runs`) and the run page `/jobs/workflows/:runId` (the classic `WorkflowRunView` rebuilt): the
 * DAG as an SVG graph with each step's state in a word and a colour, the same steps as a list (phones, screen
 * readers), the step details (job, placement, output, approval gate with Approve / Deny through step-up, as the
 * classic page), merge requests, the run's integration and "Çalıştırmayı iptal et" (two-step). Same calls, same 3 s
 * poll while the run is open. Agent output is data, rendered as text.
 */

const POLL_MS = 3_000;

// p14 14.4: a paused engine-2 run is open too (it polls, can be cancelled and resumed).
const RUN_OPEN = new Set(['starting', 'running', 'awaiting_merge', 'paused']);

interface Look {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
}

type RunStateKey = keyof Messages['jobs']['runs']['state'];
type NodeStateKey = keyof Messages['jobs']['runs']['nodeState'];

/** A run's look; its words are `t.jobs.runs.state`. */
const RUN_STATE: Readonly<Record<RunStateKey, Omit<Look, 'label'>>> = {
  starting: { tone: 'teal', icon: 'retry' },
  running: { tone: 'teal', icon: 'retry' },
  awaiting_merge: { tone: 'amber', icon: 'merge' },
  succeeded: { tone: 'green', icon: 'checkc' },
  failed: { tone: 'red', icon: 'xc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

function isKey<K extends string>(map: Readonly<Record<K, unknown>>, k: string): k is K {
  return Object.hasOwn(map, k);
}

export function runLook(state: string, t: Messages): Look {
  if (!isKey(RUN_STATE, state)) return { label: state.replace(/_/g, ' '), tone: 'neutral', icon: 'clock' };
  return { ...RUN_STATE[state], label: t.jobs.runs.state[state] };
}

const NODE_STATE: Readonly<Record<Exclude<NodeStateKey, 'queued' | 'finishing'>, Omit<Look, 'label'>>> = {
  pending: { tone: 'neutral', icon: 'clock' },
  succeeded: { tone: 'green', icon: 'checkc' },
  failed: { tone: 'red', icon: 'xc' },
  skipped: { tone: 'neutral', icon: 'chev' },
  cancelled: { tone: 'neutral', icon: 'xc' },
  awaiting_approval: { tone: 'amber', icon: 'shield' },
  awaiting_merge: { tone: 'amber', icon: 'merge' },
};

/** What a step is doing, from its own state and its job's state (the classic `nodeLabel`, in words). */
export function nodeLook(n: WorkflowNode, t: Messages): Look {
  const w = t.jobs.runs.nodeState;
  if (n.state === 'queued') {
    if (n.jobState === null || n.jobState === 'QUEUED')
      return { label: w.queued, tone: 'neutral', icon: 'clock' };
    if (n.jobState === 'SUCCEEDED') return { label: w.finishing, tone: 'teal', icon: 'checkc' };
    const p = jobStatePill(n.jobState, false, false, t);
    return { label: p.label, tone: p.tone, icon: p.icon };
  }
  if (!isKey(NODE_STATE, n.state))
    return { label: n.state.replace(/_/g, ' '), tone: 'neutral', icon: 'clock' };
  return { ...NODE_STATE[n.state], label: w[n.state] };
}

/** The step's runtime and why it runs there (the classic `placementLine`, in words). */
export function placementText(n: WorkflowNode, t: Messages): string | null {
  const runtime = n.placement?.runtime ?? n.runtime;
  if (runtime === null) return null;
  const w = t.jobs.runs.placement;
  const notes = n.placement?.notes ?? [];
  return (
    w.runsWith({ runtime: runtimeName(runtime) }) +
    (n.placement?.model ? w.model({ model: n.placement.model }) : '') +
    (notes.length > 0 ? ` — ${notes.join('; ')}` : '') +
    (n.workerName ? w.on({ machine: n.workerName }) : '')
  );
}

// ------------------------------------------------------------------------------------------------ list

/** Recent workflow runs (İşler, above the jobs). Hidden when there are none or the read fails (as the classic). */
export function WorkflowRunsPanel(): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.jobs.runs;
  const [runs, setRuns] = useState<readonly WorkflowRunSummary[] | null>(null);
  const now = useNow();
  useEffect(() => {
    let live = true;
    listWorkflowRuns().then(
      (r) => {
        if (live) setRuns(r);
      },
      () => {
        if (live) setRuns(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (runs === null || runs.length === 0) return null;
  const shown = runs.slice(0, 10);
  return (
    <Panel
      title={w.panelTitle}
      count={String(shown.length)}
      countLabel={w.count({ n: shown.length })}
      flush
      testId="workflow-runs"
      className="mt-4"
    >
      <Rows label={w.panelTitle}>
        {shown.map((r) => {
          const look = runLook(r.state, t);
          const name = `${r.name} v${String(r.version)}`;
          return (
            <Row
              key={r.id}
              testId="workflow-run-row"
              lead={
                <DyIcon
                  name={look.icon}
                  className={cx('size-[18px]', r.state === 'running' && 'dy-breathe')}
                />
              }
              tone={look.tone}
              title={
                <Link
                  to={`/jobs/workflows/${encodeURIComponent(r.id)}`}
                  className="text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                >
                  {name}
                </Link>
              }
              meta={
                <>
                  <Pill tone={look.tone} icon={look.icon}>
                    {look.label}
                  </Pill>
                  <span>{r.project}</span>
                  <time dateTime={r.createdAt} title={fmt.dateWith(r.createdAt, DATE_TIME_NUMERIC)}>
                    {agoText(r.createdAt, now)}
                  </time>
                </>
              }
            />
          );
        })}
      </Rows>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ graph

/** p13-workflows-ui: the editor's canvas renderer, read-only with live states (a lazy chunk with React Flow). */
const RunGraph = lazy(() => import('../workflows/RunGraph'));

function Graph(props: {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly RunEdge[];
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}): ReactNode {
  const t = useT();
  return (
    <div
      className="-mx-4 -mb-4 h-[min(62vh,520px)] min-h-[320px] border-t border-dy-line"
      data-testid="workflow-graph"
    >
      <Suspense fallback={<SkeletonRows label={t.jobs.runs.graphLoading} rows={3} />}>
        <RunGraph
          nodes={props.nodes}
          edges={props.edges}
          selected={props.selected}
          onSelect={props.onSelect}
        />
      </Suspense>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ step details

function SubmitError(props: { readonly error: ApiError | null }): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const left = useRetryCountdown(props.error);
  if (props.error === null) return null;
  return (
    <p role="alert" className="m-0 rounded-[10px] bg-dy-red-soft px-3 py-2 text-[0.84375rem] text-dy-red-ink">
      {sayError(props.error)}
      {left > 0 ? ` ${t.shared.errors.retryIn({ wait: t.shared.errors.wait({ seconds: left }) })}` : ''}
    </p>
  );
}

function StepDetails(props: {
  readonly runId: string;
  readonly node: WorkflowNode;
  readonly canAct: boolean;
  readonly onChanged: () => void;
  /** p14 14.2: the node's side effects (master integrations). */
  readonly effects?: readonly SideEffect[];
  /** p14 14.4: re-run the finished run from this node (absent: not offered). */
  readonly onRerunFrom?: (() => void) | undefined;
}): ReactNode {
  const n = props.node;
  const t = useT();
  const w = t.jobs.runs;
  const fmt = useFormat();
  const act = useSubmit();
  const stepUp = useStepUp();
  const [reason, setReason] = useState('');
  const look = v2Look(n, t, fmt) ?? nodeLook(n, t);
  // p14: a typed approval node (engine 2) is decided through its node run.
  const nodeRunId = n.type !== 'ai.step' ? n.nodeRunId : undefined;
  const decide = (decision: 'approve' | 'deny'): void => {
    void act
      .run(async () => {
        try {
          await stepUp.run(
            () =>
              nodeRunId === undefined
                ? decideGate(props.runId, n.id, decision, reason.trim())
                : decideNodeRun(props.runId, nodeRunId, decision, reason.trim()).then(() => undefined),
            w.gateStepUp({ node: n.id, approve: decision === 'approve' }),
          );
        } catch (err) {
          if (err instanceof StepUpCancelledError) return;
          throw err;
        }
      })
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };
  const placement = placementText(n, t);
  const reused = n.jobId !== null && n.reusedJobId === n.jobId;
  const rows: KeyValueRow[] = [
    {
      k: w.key.state,
      v: (
        <Pill tone={look.tone} icon={look.icon}>
          {look.label}
        </Pill>
      ),
    },
  ];
  if (n.type !== 'ai.step') rows.push({ k: t.workflows.run.type, v: nodeName(n, t) });
  if (n.copiedFrom !== undefined && n.copiedFrom !== null)
    rows.push({ k: t.workflows.ops.copied, v: <CopiedMark copiedFrom={n.copiedFrom} /> });
  if (n.error !== undefined && n.error !== null && n.state !== 'skipped')
    rows.push({
      k: t.workflows.run.error,
      v: `${n.error.code}${n.error.message === '' ? '' : `: ${n.error.message}`}`,
    });
  if (n.attempts > 1) rows.push({ k: w.key.attempt, v: String(n.attempts), mono: true });
  if (n.workerName !== null || n.workerId !== null)
    rows.push({ k: w.key.machine, v: n.workerName ?? n.workerId ?? '', mono: true });
  if (n.parent !== null) rows.push({ k: w.key.planner, v: n.parent, mono: true });
  if (placement !== null)
    rows.push({ k: w.key.placement, v: <span data-testid="workflow-node-placement">{placement}</span> });
  if (n.jobId !== null)
    rows.push({
      k: reused ? w.key.sameResult : w.key.job,
      v: (
        <span>
          <Link
            to={`/jobs/${encodeURIComponent(n.jobId)}`}
            className="font-dy-mono text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            {n.jobId.slice(0, 8)}
          </Link>
          {reused ? <span className="block text-[0.8125rem] text-dy-muted">{w.reused}</span> : null}
        </span>
      ),
    });
  if (n.gate !== null)
    rows.push({
      k: w.key.gate,
      v: w.gateLine({
        role: n.gate.approverRole,
        status:
          n.gate.decision === null
            ? w.gateWaiting
            : w.gateDecided({
                decision:
                  n.gate.decision === 'approve'
                    ? w.gateApproved
                    : n.gate.decision === 'deny'
                      ? w.gateDenied
                      : n.gate.decision,
                by: n.gate.decidedBy ?? '?',
              }),
      }),
    });
  return (
    <div className="grid gap-3" data-testid="workflow-node-detail">
      <KeyValue rows={rows} />
      {n.reason === null ? null : (
        <p className="m-0 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]">{n.reason}</p>
      )}
      {n.outputs === null ? null : (
        <div>
          <p className="m-0 text-[0.78125rem] text-dy-muted">
            {w.output} <span className="font-dy-mono">{n.outputs.branch}</span>
          </p>
          <pre className="m-0 mt-1 max-h-56 overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-2.5 font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {n.outputs.summary}
          </pre>
        </div>
      )}
      {n.state === 'awaiting_approval' && props.canAct ? (
        <div
          className="grid gap-2 rounded-[12px] bg-dy-amber-soft p-3"
          data-testid="workflow-gate"
          aria-label={w.gateGroup}
          role="group"
        >
          <label className="grid gap-1 text-[0.8125rem] font-bold text-dy-amber-ink">
            {w.reasonOptional}
            <input
              className="min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] font-normal text-dy-ink sm:min-h-9 sm:text-[0.875rem]"
              value={reason}
              maxLength={500}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <DyButton
              variant="primary"
              icon="check"
              busy={act.busy}
              disabled={act.blocked}
              onClick={() => {
                decide('approve');
              }}
            >
              {w.approve}
            </DyButton>
            <DyButton
              variant="danger"
              icon="xc"
              busy={act.busy}
              disabled={act.blocked}
              onClick={() => {
                decide('deny');
              }}
            >
              {w.deny}
            </DyButton>
          </div>
          <p className="m-0 text-[0.78125rem] text-dy-amber-ink">{w.needsCode}</p>
        </div>
      ) : null}
      <SubmitError error={act.error} />
      {props.onRerunFrom === undefined ? null : (
        <div>
          <DyButton icon="retry" data-testid="workflow-rerun-from" onClick={props.onRerunFrom}>
            {t.workflows.ops.rerunFromHere}
          </DyButton>
        </div>
      )}
      <NodeSideEffects effects={props.effects ?? []} />
      {props.canAct ? <ResumeWait runId={props.runId} node={n} onChanged={props.onChanged} /> : null}
      {n.nodeRunId === undefined ? null : (
        <NodeRunsSection
          runId={props.runId}
          node={n.id}
          canAct={props.canAct}
          onChanged={props.onChanged}
          version={`${n.state}:${n.nodeRunState ?? ''}:${String(n.attempts)}:${String(n.iterations ?? 0)}`}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ run screen

interface RunState {
  readonly data: WorkflowRun | null;
  readonly error: ApiError | null;
}

export function WorkflowRunScreen(props: { readonly runId: string }): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const w = t.jobs.runs;
  const fmt = useFormat();
  const { runId } = props;
  const [s, setS] = useState<RunState>({ data: null, error: null });
  // p14 (§7.7): on a phone the steps list is the run view; the canvas opens on request.
  const [showGraph, setShowGraph] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // p14 14.4: the re-run dialog (undefined: closed; null: the whole run; else from this node).
  const [rerunFrom, setRerunFrom] = useState<string | null | undefined>(undefined);
  const cancel = useSubmit();
  const now = useNow();
  const { state: auth } = useAuth();
  const canAct = auth.kind !== 'signedIn' || auth.user.role !== 'viewer';
  const detailsRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    getWorkflowRun(runId).then(
      (d) => {
        setS({ data: d, error: null });
      },
      (err: unknown) => {
        setS((p) => ({ data: p.data, error: toApiError(err) }));
      },
    );
  }, [runId]);

  const open = s.data === null || RUN_OPEN.has(s.data.run.state);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(refresh, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [open, refresh]);

  const pick = (id: string, focus: boolean): void => {
    setSelected(id);
    if (focus)
      requestAnimationFrame(() => {
        detailsRef.current?.focus();
      });
  };

  const d = s.data;
  if (d === null) {
    return (
      <ScreenFrame title={w.title} back={{ to: '/jobs', label: w.back }} testId="dy-workflow-run">
        {s.error !== null ? (
          <ErrorLine error={s.error} what={w.run} onRetry={refresh} />
        ) : (
          <SkeletonRows label={w.loading} rows={4} />
        )}
      </ScreenFrame>
    );
  }

  const run = d.run;
  const ops = run.ops;
  // p14 14.4: an engine-2 run's own paused / queued state in words.
  const look: Look =
    ops?.engineState === 'paused'
      ? { label: t.workflows.ops.statePaused, tone: 'amber', icon: 'pause' }
      : ops?.engineState === 'queued'
        ? { label: t.workflows.ops.stateQueued, tone: 'neutral', icon: 'clock' }
        : runLook(run.state, t);
  const finished = ops !== null && ['succeeded', 'failed', 'cancelled'].includes(ops.engineState);
  const node = d.nodes.find((n) => n.id === selected) ?? null;
  const waiting = d.nodes.filter((n) => n.state === 'awaiting_approval');
  const done = d.nodes.filter((n) => n.state === 'succeeded' || n.state === 'skipped').length;

  return (
    <ScreenFrame
      title={`${run.name} v${String(run.version)}`}
      purpose={w.purpose}
      back={{ to: '/jobs', label: w.back }}
      live={open ? (s.error === null ? 'live' : 'error') : undefined}
      testId="dy-workflow-run"
      facts={
        <>
          <span data-testid="workflow-run-state">
            <Pill tone={look.tone} icon={look.icon}>
              {look.label}
            </Pill>
          </span>
          <Pill tone="neutral" icon="folder">
            {run.project}
          </Pill>
          <TriggerFacts triggerKind={run.triggerKind} sourceTrust={run.sourceTrust} />
          {run.definitionId === null ? null : (
            <Link
              to={`/workflows/${encodeURIComponent(run.definitionId)}`}
              data-testid="workflow-run-definition"
              className="no-underline"
            >
              <Pill tone="teal" icon="branch">
                {w.definition({ version: run.version })}
              </Pill>
            </Link>
          )}
          {/* p15-workflow-ai: ask the editor's assistant why this run failed (the run's node data, untrusted). */}
          {run.definitionId === null || run.state !== 'failed' ? null : (
            <Link
              to={`/workflows/${encodeURIComponent(run.definitionId)}?ai=debug&run=${encodeURIComponent(run.id)}`}
              data-testid="workflow-run-ai-debug"
              className="no-underline"
            >
              <Pill tone="violet" icon="brain">
                {t.workflowAi.run.ask}
              </Pill>
            </Link>
          )}
          <Pill tone="neutral" icon="jobs">
            {w.stepsDone({ done, total: d.nodes.length })}
          </Pill>
          <Pill tone="neutral" icon="clock">
            <time dateTime={run.createdAt}>{w.started({ ago: agoText(run.createdAt, now) })}</time>
          </Pill>
          {run.endedAt === null ? null : (
            <Pill tone="neutral" icon="checkc">
              <time dateTime={run.endedAt}>{w.ended({ ago: agoText(run.endedAt, now) })}</time>
            </Pill>
          )}
        </>
      }
      actions={
        finished && canAct ? (
          <DyButton
            icon="retry"
            data-testid="workflow-rerun"
            onClick={() => {
              setRerunFrom(null);
            }}
          >
            {t.workflows.ops.rerun}
          </DyButton>
        ) : open && canAct ? (
          <div className="flex flex-wrap items-center gap-2">
            <PauseResume
              runId={run.id}
              ops={ops}
              onChanged={(msg) => {
                setNotice(msg);
                refresh();
              }}
            />
            <DyButton
              variant="danger"
              icon="xc"
              data-testid="workflow-cancel"
              onClick={() => {
                setNotice(null);
                setConfirmCancel(true);
              }}
            >
              {w.cancelRun}
            </DyButton>
            <DyConfirmDialog
              open={confirmCancel}
              onClose={() => {
                setConfirmCancel(false);
              }}
              title={w.cancelRun}
              description={w.stopsRunning}
              confirmLabel={w.confirmCancel}
              cancelLabel={w.keep}
              busy={cancel.busy}
              confirmDisabled={cancel.blocked}
              testId="workflow-cancel-dialog"
              confirmTestId="workflow-cancel-confirm"
              onConfirm={() => {
                void cancel
                  .run(() => cancelWorkflowRun(run.id, 'cancelled from the console')) // i18n-ignore: audit reason
                  .then((ok) => {
                    if (ok) {
                      setConfirmCancel(false);
                      setNotice(w.cancelled);
                      refresh();
                    }
                  });
              }}
            >
              <SubmitError error={cancel.error} />
            </DyConfirmDialog>
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-4">
        {s.error === null ? null : (
          <p
            role="alert"
            className="m-0 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
          >
            {w.refreshFailed({ error: sayError(s.error) })}
          </p>
        )}
        {confirmCancel ? null : <SubmitError error={cancel.error} />}
        {notice === null ? null : (
          <p
            role="status"
            className="m-0 rounded-[10px] bg-dy-green-soft px-3.5 py-2 text-[0.875rem] text-dy-green"
          >
            {notice}
          </p>
        )}
        {run.reason === null ? null : (
          <p className="m-0 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]">{run.reason}</p>
        )}
        {/* p17-embeddings: a failed run — how a similar failure of the project was solved before. */}
        {run.state === 'failed' ? <SolvedBefore jobId={null} workflowRunId={run.id} /> : null}
        <RunOpsBands ops={ops} />
        {waiting.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-dy-amber-soft px-3.5 py-2.5 text-[0.875rem] text-dy-amber-ink"
            data-testid="workflow-waiting"
          >
            <DyIcon name="shield" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {waiting.length === 1
                ? w.waitingOne({ node: waiting[0]?.id ?? '' })
                : w.waitingMany({ n: waiting.length })}
            </span>
            <DyButton
              variant="warn"
              onClick={() => {
                const first = waiting[0];
                if (first !== undefined) pick(first.id, true);
              }}
            >
              {w.decide}
            </DyButton>
          </div>
        ) : null}
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start">
          <div className="grid min-w-0 gap-4">
            <div className="md:hidden">
              <DyButton
                icon="branch"
                aria-pressed={showGraph}
                data-testid="workflow-graph-toggle"
                onClick={() => {
                  setShowGraph((g) => !g);
                }}
              >
                {showGraph ? t.workflows.run.hideGraph : t.workflows.run.showGraph}
              </DyButton>
            </div>
            <Panel className={showGraph ? undefined : 'max-md:hidden'} title={w.graph} sub={w.graphSub}>
              <Graph
                nodes={d.nodes}
                edges={d.edges}
                selected={selected}
                onSelect={(id) => {
                  pick(id, false);
                }}
              />
            </Panel>
            <Panel
              title={w.steps}
              count={String(d.nodes.length)}
              countLabel={w.stepsCount({ n: d.nodes.length })}
              flush
              testId="workflow-steps"
            >
              {d.nodes.length === 0 ? (
                <EmptyLine>{w.noSteps}</EmptyLine>
              ) : (
                <Rows label={w.steps}>
                  {d.nodes.map((n) => {
                    const l = v2Look(n, t, fmt) ?? nodeLook(n, t);
                    const placement = placementText(n, t);
                    const sel = selected === n.id;
                    return (
                      <Row
                        key={n.id}
                        testId="workflow-step"
                        tone={l.tone}
                        lead={<DyIcon name={l.icon} className="size-[18px]" />}
                        className={sel ? 'bg-dy-sunk' : undefined}
                        title={
                          <button
                            type="button"
                            aria-pressed={sel}
                            onClick={() => {
                              pick(n.id, true);
                            }}
                            className="dy-press text-left font-dy-mono font-bold text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                          >
                            {n.id}
                          </button>
                        }
                        meta={
                          <>
                            <Pill tone={l.tone}>{l.label}</Pill>
                            <CopiedMark copiedFrom={n.copiedFrom} />
                            <span>{n.type === 'ai.step' ? n.role : nodeName(n, t)}</span>
                            {placement === null ? null : <span>{placement}</span>}
                          </>
                        }
                        trail={
                          n.jobId === null ? undefined : (
                            <Link
                              to={`/jobs/${encodeURIComponent(n.jobId)}`}
                              aria-label={w.openJob({ node: n.id })}
                              className="dy-press inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[0.8125rem] whitespace-nowrap text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
                            >
                              <DyIcon name="jobs" className="size-3.5" />
                              {w.job}
                            </Link>
                          )
                        }
                      />
                    );
                  })}
                </Rows>
              )}
            </Panel>
            {run.files.length > 0 ? (
              <Panel title={w.files} testId="workflow-run-files">
                <ul className="m-0 grid list-none gap-1 p-0 text-[0.875rem]">
                  {run.files.map((f) => (
                    <li key={f.name} className="flex flex-wrap items-center gap-2">
                      <DyIcon name="file" className="size-4 text-dy-muted" />
                      <span className="font-dy-mono break-all">{f.name}</span>
                      <span className="text-dy-muted">{f.pruned ? w.pruned : fmt.bytes(f.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
            {d.mergeRequests.length > 0 ? (
              <Panel title={w.mergeRequests} testId="workflow-merge-requests">
                <ul className="m-0 grid list-none gap-1.5 p-0 text-[0.875rem]">
                  {d.mergeRequests.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-2">
                      <DyIcon name="merge" className="size-4 text-dy-muted" />
                      <span className="font-dy-mono">{m.node}</span>
                      <Pill tone="neutral">{m.status}</Pill>
                      <span className="text-dy-muted">{w.branchCount({ n: m.branches.length })}</span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 mt-2 text-[0.8125rem] text-dy-muted">{w.mergeNote}</p>
              </Panel>
            ) : null}
            <RunIntegration runId={run.id} />
          </div>
          <div ref={detailsRef} tabIndex={-1} className="min-w-0 outline-none lg:sticky lg:top-[69px]">
            <Panel
              title={node === null ? w.step : <span className="font-dy-mono">{node.id}</span>}
              sub={node === null ? undefined : node.type === 'ai.step' ? node.role : nodeName(node, t)}
              testId="workflow-step-panel"
            >
              {node === null ? (
                <p className="m-0 text-[0.875rem] text-dy-muted">{w.pickStep}</p>
              ) : (
                <StepDetails
                  runId={run.id}
                  node={node}
                  canAct={canAct}
                  onChanged={refresh}
                  effects={d.sideEffects.filter((e) => e.nodeId === node.id)}
                  onRerunFrom={
                    finished && canAct && (node.scope ?? '') === ''
                      ? () => {
                          setRerunFrom(node.id);
                        }
                      : undefined
                  }
                />
              )}
            </Panel>
          </div>
        </div>
      </div>
      {ops === null ? null : (
        <RerunDialog
          runId={run.id}
          fromNode={rerunFrom ?? null}
          open={rerunFrom !== undefined}
          onClose={() => {
            setRerunFrom(undefined);
          }}
        />
      )}
    </ScreenFrame>
  );
}
