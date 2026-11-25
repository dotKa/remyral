import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  cancelNodeRun,
  decideNodeRun,
  getPayload,
  listNodeRuns,
  type NodeRun,
  payloadRef,
} from '../../../api/workflowEngine';
import { toApiError } from '../../../components/ui';
import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyButton, Pill } from '../parts';
import { DyConfirmDialog } from '../../common/actions';
import { previewText } from './ExpressionField';
import { CopiedMark } from './RunOps';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7.5): a node's runs on the run page (engine 2) —
 * attempts and, for nodes in a forEach / loop body, one entry per iteration (a selector), timings, the input the node
 * used and the output it produced (collapsible JSON with its size; large values load from the payload store), the
 * error, the wait (approve / deny an approval with step-up, cancel an open node run). Run data is workflow data,
 * possibly untrusted: rendered as text only.
 */

const OPEN = new Set(['pending', 'ready', 'running', 'waiting', 'retry_wait']);

function bytesOf(v: unknown): number {
  try {
    const j: unknown = JSON.stringify(v);
    return new TextEncoder().encode(typeof j === 'string' ? j : '').length;
  } catch {
    return 0;
  }
}

function DataBlock(props: {
  readonly runId: string;
  readonly label: string;
  readonly value: unknown;
}): ReactNode {
  const w = useT().workflows.run;
  const fmt = useFormat();
  const ref = payloadRef(props.value);
  const [loaded, setLoaded] = useState<unknown>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const sayError = useErrorText();
  const pruned =
    typeof props.value === 'object' &&
    props.value !== null &&
    (props.value as { $pruned?: unknown }).$pruned === true;
  const value = ref === null ? props.value : loaded;
  return (
    <details
      className="rounded-[10px] border border-dy-line bg-dy-sunk px-2.5 py-1.5"
      data-testid="node-run-data"
    >
      <summary className="cursor-pointer text-[0.8125rem] font-bold">
        {props.label}{' '}
        <span className="font-normal text-dy-muted">
          {pruned ? w.pruned : fmt.bytes(ref === null ? bytesOf(props.value) : ref.size)}
        </span>
      </summary>
      {ref !== null && loaded === undefined ? (
        <div className="mt-1 grid gap-1">
          <p className="m-0 text-[0.78125rem] text-dy-muted">{w.large}</p>
          <DyButton
            onClick={() => {
              getPayload(props.runId, ref.sha).then(
                (p) => {
                  setLoaded(p.value);
                },
                (err: unknown) => {
                  setError(toApiError(err));
                },
              );
            }}
          >
            {w.loadPayload}
          </DyButton>
          {error === null ? null : <p className="m-0 text-[0.78125rem] text-dy-red-ink">{sayError(error)}</p>}
        </div>
      ) : pruned ? null : (
        <pre className="m-0 mt-1 max-h-64 overflow-auto font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {previewText(value, 64_000)}
        </pre>
      )}
    </details>
  );
}

function scopeLabel(scope: string, t: ReturnType<typeof useT>['workflows']['run']): string {
  if (scope === '') return t.topLevel;
  return scope
    .split('/')
    .map((s) => {
      const m = /^(.*)\[(\d+)\]$/.exec(s);
      return m === null ? s : t.iteration({ group: m[1] ?? '', n: Number(m[2]) + 1 });
    })
    .join(' › ');
}

export function NodeRunsSection(props: {
  readonly runId: string;
  readonly node: string;
  readonly canAct: boolean;
  readonly onChanged: () => void;
  /** Re-read when the run's poll changes the node (its state word). */
  readonly version: string;
}): ReactNode {
  const t = useT();
  const w = t.workflows.run;
  const fmt = useFormat();
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const act = useSubmit();
  const [runs, setRuns] = useState<readonly NodeRun[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const load = useCallback(() => {
    listNodeRuns(props.runId, { node: props.node, limit: 100 }).then(
      (r) => {
        setRuns(r.nodeRuns);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [props.runId, props.node]);
  useEffect(load, [load, props.version]);

  if (error !== null && runs === null)
    return <p className="m-0 text-[0.8125rem] text-dy-red-ink">{sayError(error)}</p>;
  if (runs === null) return <p className="m-0 text-[0.8125rem] text-dy-muted">{w.loading}</p>;
  if (runs.length === 0) return <p className="m-0 text-[0.8125rem] text-dy-muted">{w.noRuns}</p>;

  const scopes = [...new Set(runs.map((r) => r.scope))];
  const current = scope !== null && scopes.includes(scope) ? scope : (scopes[scopes.length - 1] ?? '');
  const shown = runs.filter((r) => r.scope === current).sort((a, b) => b.attempt - a.attempt);

  const decide = (nr: NodeRun, decision: 'approve' | 'deny'): void => {
    void act
      .run(async () => {
        try {
          await stepUp.run(
            () => decideNodeRun(props.runId, nr.id, decision, reason.trim()),
            decision === 'approve' ? w.stepUpApprove({ node: nr.node }) : w.stepUpDeny({ node: nr.node }),
          );
        } catch (err) {
          if (err instanceof StepUpCancelledError) return;
          throw err;
        }
      })
      .then((ok) => {
        if (ok) {
          load();
          props.onChanged();
        }
      });
  };

  return (
    <div className="grid gap-2.5" data-testid="node-runs">
      {scopes.length > 1 ? (
        <label className="grid gap-1 text-[0.8125rem] font-bold">
          {w.iterations({ n: scopes.length })}
          <select
            value={current}
            data-testid="node-run-scope"
            onChange={(e) => {
              setScope(e.target.value);
            }}
            className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-2 text-[0.875rem] font-normal"
          >
            {scopes.map((s) => (
              <option key={s} value={s}>
                {scopeLabel(s, w)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {shown.map((nr) => (
        <section
          key={nr.id}
          aria-label={w.attempt({ n: nr.attempt })}
          className="grid gap-1.5 rounded-[12px] border border-dy-line p-2.5"
          data-testid="node-run"
          data-state={nr.state}
        >
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
            <Pill
              tone={
                nr.state === 'failed'
                  ? 'red'
                  : nr.state === 'succeeded'
                    ? 'green'
                    : OPEN.has(nr.state)
                      ? 'teal'
                      : 'neutral'
              }
            >
              {(w.states as Record<string, string | undefined>)[nr.state] ?? nr.state}
            </Pill>
            {shown.length > 1 || nr.attempt > 1 ? <span>{w.attempt({ n: nr.attempt })}</span> : null}
            {nr.outputPort === null ? null : <span className="font-dy-mono">{`→ ${nr.outputPort}`}</span>}
            <CopiedMark copiedFrom={nr.copiedFrom} />
            <span className="text-dy-muted">{w.placement({ where: nr.placement })}</span>
          </div>
          <p className="m-0 text-[0.75rem] text-dy-muted">
            {[
              nr.startedAt === null ? null : w.started({ time: fmt.dateTime(nr.startedAt) }),
              nr.endedAt === null ? null : w.ended({ time: fmt.dateTime(nr.endedAt) }),
              nr.dueAt === null ? null : w.resumesAt({ time: fmt.dateTime(nr.dueAt) }),
            ]
              .filter((x) => x !== null)
              .join(' · ')}
          </p>
          {nr.reason === null ? null : (
            <p className="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">{nr.reason}</p>
          )}
          {nr.error === null || nr.state === 'skipped' ? null : (
            <p
              className="m-0 text-[0.8125rem] text-dy-red-ink [overflow-wrap:anywhere]"
              data-testid="node-run-error"
            >
              <span className="font-dy-mono">{nr.error.code}</span>
              {nr.error.message === '' ? '' : `: ${nr.error.message}`}
            </p>
          )}
          {nr.input === null ? null : <DataBlock runId={props.runId} label={w.input} value={nr.input} />}
          {nr.output === null ? null : <DataBlock runId={props.runId} label={w.output} value={nr.output} />}
          {nr.state === 'waiting' && nr.waitKind === 'approval' && props.canAct ? (
            <div
              className="grid gap-2 rounded-[10px] bg-dy-amber-soft p-2.5"
              role="group"
              aria-label={w.decision}
            >
              <label className="grid gap-1 text-[0.8125rem] font-bold text-dy-amber-ink">
                {w.reason}
                <input
                  value={reason}
                  maxLength={500}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                  className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-normal text-dy-ink"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <DyButton
                  variant="primary"
                  icon="check"
                  busy={act.busy}
                  data-testid="node-run-approve"
                  onClick={() => {
                    decide(nr, 'approve');
                  }}
                >
                  {w.approve}
                </DyButton>
                <DyButton
                  variant="danger"
                  icon="xc"
                  busy={act.busy}
                  data-testid="node-run-deny"
                  onClick={() => {
                    decide(nr, 'deny');
                  }}
                >
                  {w.deny}
                </DyButton>
              </div>
            </div>
          ) : null}
          {OPEN.has(nr.state) && props.canAct ? (
            <DyButton
              variant="ghost"
              icon="xc"
              data-testid="node-run-cancel"
              aria-haspopup="dialog"
              onClick={() => {
                act.clearError();
                setConfirmCancel(nr.id);
              }}
            >
              {w.cancel}
            </DyButton>
          ) : null}
        </section>
      ))}
      {act.error === null || confirmCancel !== null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {sayError(act.error)}
        </p>
      )}
      <DyConfirmDialog
        open={confirmCancel !== null}
        onClose={() => {
          setConfirmCancel(null);
        }}
        confirmLabel={w.cancelConfirm}
        cancelLabel={w.keep}
        busy={act.busy}
        testId="node-run-cancel-dialog"
        confirmTestId="node-run-cancel-confirm"
        onConfirm={() => {
          const id = confirmCancel;
          if (id === null) return;
          const why = 'cancelled from the console'; // i18n-ignore: an audit reason, not UI text
          void act
            .run(() => cancelNodeRun(props.runId, id, why).then(() => undefined))
            .then((ok) => {
              if (ok) {
                setConfirmCancel(null);
                load();
                props.onChanged();
              }
            });
        }}
      >
        {act.error === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {sayError(act.error)}
          </p>
        )}
      </DyConfirmDialog>
    </div>
  );
}
