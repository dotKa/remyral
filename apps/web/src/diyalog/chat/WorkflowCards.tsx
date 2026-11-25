import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { decideNodeRun } from '../../api/workflowEngine';
import { decideGate } from '../../api/workflows';
import {
  getWorkflowApproval,
  type WorkflowApproval,
  type WorkflowApprovalState,
  type WorkflowResult,
} from '../../api/workflowApprovals';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { invalidate } from '../../lib/invalidate';
import { formatSpan } from '../../screens/job/format';
import { useSubmit } from '../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyIcon } from '../icons';
import { useFlowSignal } from './flowEvents';
import { DyButton } from '../screens/parts';
import { type DyState, StateBadge } from '../StateBadge';

/**
 * p17-chat-flow (docs/design/p17-chat-flow.md): the workflow cards of the chat and "Senden bekleyen".
 *
 *  - {@link WorkflowApprovalCard}: a run's approval step — title, details, approver role, state; Onayla / Reddet with a
 *    reason through the run page's own route (`decideNodeRun`; p18-last-gaps: an engine-1 gate through engine 1's
 *    `decideGate` by node; the verification code by `useStepUp`), so authorization,
 *    audit and "one decision wins" are the run page's. It reads the live state — in a conversation on the stream's
 *    `flow` event (W4: pushed when the step is decided or closed anywhere; read again when the stream reopens), on
 *    "Senden bekleyen" polled while waiting — so a decision taken on another surface shows here too.
 *  - {@link WorkflowResultCard}: a finished run — state, steps done / total, duration, the last step's output summary
 *    (bounded by the master), "Run'ı aç".
 *
 * Titles, details and summaries are run data: rendered as plain text only.
 */

export const APPROVAL_POLL_MS = 10_000;

const APPROVAL_STATE: Readonly<Record<WorkflowApprovalState, DyState>> = {
  waiting: 'needs',
  approved: 'done',
  denied: 'failed',
  closed: 'cancelled',
};

const RESULT_STATE: Readonly<Record<WorkflowResult['state'], DyState>> = {
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

const runHref = (runId: string): string => `/jobs/workflows/${encodeURIComponent(runId)}`;

const LINK =
  'inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[0.84375rem] font-bold text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft';

export function WorkflowApprovalCard(props: {
  readonly runId: string;
  readonly nodeRunId: string;
  /** What the caller already has (the ops thread's payload); the card still reads the live state. */
  readonly initial?: WorkflowApproval | undefined;
  /** The step was decided here. */
  readonly onDecided?: ((next: WorkflowApproval) => void) | undefined;
  /**
   * W4: the card sits in a conversation whose stream pushes the step's decision (`flow` events): no polling — it reads
   * its state again on such an event and when the stream (re)opens. Absent ("Senden bekleyen"): polled while waiting.
   */
  readonly pushed?: boolean | undefined;
}): ReactNode {
  const t = useT();
  const w = t.chatFlow.approval;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const act = useSubmit();
  const [view, setView] = useState<WorkflowApproval | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { runId, nodeRunId, onDecided } = props;

  const load = useCallback(
    async (signal?: AbortSignal): Promise<WorkflowApproval | null> => {
      try {
        const v = await getWorkflowApproval(runId, nodeRunId, signal === undefined ? {} : { signal });
        setView(v);
        setError(null);
        return v;
      } catch (err) {
        if (signal?.aborted !== true) setError(sayError(err));
        return null;
      }
    },
    [runId, nodeRunId, sayError],
  );

  const waiting = view === null || view.state === 'waiting';
  const pushed = props.pushed === true;
  // W4: a pushed decision (or a reopened stream) — read the live state again.
  const signal = useFlowSignal(nodeRunId);
  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    if (!waiting || pushed)
      return () => {
        ac.abort();
      };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(ac.signal);
    }, APPROVAL_POLL_MS);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [load, waiting, pushed, signal]);

  const decide = (decision: 'approve' | 'deny'): void => {
    void act
      .run(async () => {
        try {
          await stepUp.run(
            () =>
              // p18-last-gaps: an engine-1 gate is decided through engine 1's gate route (by node).
              (view?.engine === 1
                ? decideGate(runId, view.node, decision, reason.trim())
                : decideNodeRun(runId, nodeRunId, decision, reason.trim())
              ).then(() => undefined),
            w.stepUp({ approve: decision === 'approve', node: view?.node ?? '' }),
          );
        } catch (err) {
          if (err instanceof StepUpCancelledError) return;
          throw err;
        }
      })
      .then(async (ok) => {
        // Whatever happened (decided here, or elsewhere first: 409), show the live state.
        const next = await load();
        if (ok && next !== null) {
          invalidate('approvals');
          onDecided?.(next);
        }
      });
  };

  if (view === null) {
    return (
      <div
        className="mt-2 rounded-[12px] border border-dy-line bg-dy-card px-3 py-2 text-[0.84375rem] text-dy-muted"
        data-testid="workflow-approval-card"
        role={error === null ? 'status' : 'alert'}
      >
        {error === null ? w.loading : `${w.unreadable} ${error}`}
      </div>
    );
  }
  const decided =
    view.decidedBy === null ? null : (
      <span className="text-[0.8125rem] text-dy-muted">{w.decided({ by: view.decidedBy })}</span>
    );
  return (
    <section
      className="mt-2 grid min-w-0 gap-2 rounded-[12px] border border-dy-line bg-dy-card p-3"
      data-testid="workflow-approval-card"
      data-state={view.state}
      aria-label={w.kind}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-[0.78125rem] font-bold text-dy-amber-ink">
          <DyIcon name="shield" className="size-3.5" />
          {w.kind}
        </span>
        <StateBadge state={APPROVAL_STATE[view.state]} label={w.states[view.state]} />
        {decided}
      </div>
      <p
        className="m-0 text-[0.9375rem] font-bold [overflow-wrap:anywhere]"
        data-testid="workflow-approval-title"
      >
        {view.title ?? w.untitled}
      </p>
      <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
        {w.step({ workflow: view.workflow, node: view.node })} · {w.role({ role: view.approverRole })}
        {view.engine === 1 ? <span data-testid="workflow-approval-classic">{` · ${w.classic}`}</span> : null}
      </p>
      {view.details === null ? null : (
        <pre
          className="m-0 max-h-48 overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-2.5 font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
          data-testid="workflow-approval-details"
        >
          {view.details}
        </pre>
      )}
      {view.untrusted ? <p className="m-0 text-[0.78125rem] text-dy-amber-ink">{w.untrusted}</p> : null}
      {view.state === 'waiting' && view.canDecide ? (
        <div className="grid gap-2 rounded-[10px] bg-dy-amber-soft p-2.5" role="group" aria-label={w.kind}>
          <label className="grid gap-1 text-[0.8125rem] font-bold text-dy-amber-ink">
            {w.reason}
            <input
              className="min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] font-normal text-dy-ink sm:min-h-9 sm:text-[0.875rem]"
              value={reason}
              maxLength={500}
              data-testid="workflow-approval-reason"
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
              data-testid="workflow-approval-approve"
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
              data-testid="workflow-approval-deny"
              onClick={() => {
                decide('deny');
              }}
            >
              {w.deny}
            </DyButton>
          </div>
          <p className="m-0 text-[0.78125rem] text-dy-amber-ink">{w.needsCode}</p>
        </div>
      ) : view.state === 'waiting' ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{w.cannotDecide}</p>
      ) : null}
      {act.error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {sayError(act.error)}
        </p>
      )}
      <div>
        <Link to={runHref(view.runId)} className={LINK} data-testid="workflow-approval-open">
          {w.openRun}
          <DyIcon name="chev" className="size-3.5 -rotate-90" />
        </Link>
      </div>
    </section>
  );
}

export function WorkflowResultCard(props: { readonly result: WorkflowResult }): ReactNode {
  const w = useT().chatFlow.result;
  const r = props.result;
  return (
    <section
      className="mt-2 grid min-w-0 gap-1.5 rounded-[12px] border border-dy-line bg-dy-card p-3"
      data-testid="workflow-result-card"
      data-state={r.state}
      data-attention={r.attention.length > 0 ? 'true' : undefined}
      aria-label={w.kind}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-[0.78125rem] font-bold text-dy-muted">
          <DyIcon name="jobs" className="size-3.5" />
          {w.kind}
        </span>
        {r.attention.length > 0 ? (
          <StateBadge state="needs" label={w.attention} />
        ) : (
          <StateBadge state={RESULT_STATE[r.state]} label={w.states[r.state]} />
        )}
      </div>
      <p className="m-0 font-dy-mono text-[0.9375rem] font-bold [overflow-wrap:anywhere]">{r.workflow}</p>
      <p className="m-0 flex flex-wrap gap-x-3 text-[0.8125rem] text-dy-muted tabular-nums">
        <span data-testid="workflow-result-steps">{w.steps({ done: r.stepsDone, total: r.stepsTotal })}</span>
        {r.durationMs === null ? null : (
          <span data-testid="workflow-result-duration">{w.duration({ span: formatSpan(r.durationMs) })}</span>
        )}
      </p>
      {r.attention.length === 0 ? null : (
        <div className="grid gap-0.5" data-testid="workflow-result-attention">
          <p className="m-0 text-[0.84375rem] font-bold text-dy-amber-ink">{w.attentionLead}</p>
          <ul className="m-0 grid gap-0.5 pl-4 text-[0.84375rem] [overflow-wrap:anywhere]">
            {r.attention.map((a) => (
              <li key={`${a.node}:${a.kind}:${a.note}`}>
                <span className="font-dy-mono">{a.node}</span> · {w.attentionKinds[a.kind]}
                {a.note === '' ? null : <span className="text-dy-muted"> — {a.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.reason === null ? null : (
        <p className="m-0 text-[0.84375rem] text-dy-red-ink [overflow-wrap:anywhere]">
          <b>{w.reason}:</b> {r.reason}
        </p>
      )}
      {r.summary === null ? null : (
        <p
          className="m-0 line-clamp-3 text-[0.84375rem] [overflow-wrap:anywhere]"
          data-testid="workflow-result-summary"
        >
          <span className="text-dy-muted">{w.summary}: </span>
          {r.summary}
        </p>
      )}
      <div>
        <Link to={runHref(r.runId)} className={LINK} data-testid="workflow-result-open">
          {w.openRun}
          <DyIcon name="chev" className="size-3.5 -rotate-90" />
        </Link>
      </div>
    </section>
  );
}
