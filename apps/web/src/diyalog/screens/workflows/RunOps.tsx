import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ApiError } from '../../../api/client';
import type { RunOps } from '../../../api/workflows';
import { pauseRun, type RerunPlan, rerunRun, resumeRun } from '../../../api/workflowEngine';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyCheck, DyDialog, DyNotice } from '../kit';
import { DyButton, Pill } from '../parts';
import { DyConfirmDialog } from '../../common/actions';

/**
 * p14-workflow-engine 14.4 (docs/design/p14-workflow-engine.md §20.1, §20.2, §20.6): the run page's operations for
 * engine-2 runs — the paused / queued / pruned bands and the lineage (re-run of, error run of), Duraklat / Devam
 * ettir with a confirmation, and the re-run dialog: it first asks the master for the plan (`dryRun`) and shows what
 * is copied from this run and what runs again (side-effecting nodes and AI steps called out), optionally with the
 * latest version, then starts the re-run and opens it.
 */

const runHref = (id: string): string => `/jobs/workflows/${encodeURIComponent(id)}`;

/** The bands above the run: paused, queued, pruned, lineage. */
export function RunOpsBands(props: { readonly ops: RunOps | null }): ReactNode {
  const t = useT().workflows.ops;
  const fmt = useFormat();
  const o = props.ops;
  if (o === null) return null;
  return (
    <>
      {o.engineState === 'paused' ? (
        <DyNotice tone="amber" icon="pause" testId="workflow-paused">
          {o.pausedAt === null
            ? t.paused
            : t.pausedBanner({ by: o.pausedBy ?? '?', time: fmt.dateTime(o.pausedAt) })}
        </DyNotice>
      ) : null}
      {o.engineState === 'queued' ? (
        <DyNotice tone="neutral" icon="clock" testId="workflow-queued">
          {o.queuePosition === null ? t.queuedNoPos : t.queuedBanner({ n: o.queuePosition })}
          {o.concurrencyKey === null ? null : (
            <span className="ml-2 font-dy-mono text-dy-muted">
              {t.concurrencyKey({ key: o.concurrencyKey })}
            </span>
          )}
        </DyNotice>
      ) : null}
      {o.dataPrunedAt === null ? null : (
        <DyNotice tone="neutral" icon="trash" testId="workflow-pruned">
          {t.prunedBanner({ time: fmt.dateTime(o.dataPrunedAt) })}
        </DyNotice>
      )}
      {o.rerunOf === null ? null : (
        <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="workflow-rerun-of">
          {`${t.rerunOf}: `}
          <Link to={runHref(o.rerunOf)} className="font-dy-mono text-dy-teal-ink">
            {o.rerunOf.slice(0, 8)}
          </Link>
          {o.rerunFromNode === null ? null : ` · ${t.rerunFrom({ node: o.rerunFromNode })}`}
        </p>
      )}
      {o.errorOf === null ? null : (
        <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="workflow-error-of">
          {`${t.errorOf}: `}
          <Link to={runHref(o.errorOf)} className="font-dy-mono text-dy-teal-ink">
            {o.errorOf.slice(0, 8)}
          </Link>
        </p>
      )}
    </>
  );
}

/** Duraklat (active) / Devam ettir (paused), each behind a confirmation. */
export function PauseResume(props: {
  readonly runId: string;
  readonly ops: RunOps | null;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const t = useT().workflows.ops;
  const act = useSubmit();
  const [confirm, setConfirm] = useState(false);
  const state = props.ops?.engineState;
  if (state !== 'active' && state !== 'paused') return null;
  const pausing = state === 'active';
  const close = (): void => {
    setConfirm(false);
    act.clearError();
  };
  return (
    <>
      <DyButton
        icon={pausing ? 'pause' : 'retry'}
        data-testid={pausing ? 'workflow-pause' : 'workflow-resume'}
        aria-haspopup="dialog"
        onClick={() => {
          setConfirm(true);
        }}
      >
        {pausing ? t.pause : t.resume}
      </DyButton>
      <DyConfirmDialog
        open={confirm}
        onClose={close}
        title={pausing ? t.pause : t.resume}
        description={pausing ? t.pauseHint : t.resumeHint}
        confirmLabel={pausing ? t.pauseConfirm : t.resumeConfirm}
        cancelLabel={t.keep}
        variant="primary"
        busy={act.busy}
        confirmDisabled={act.blocked}
        testId={pausing ? 'workflow-pause-dialog' : 'workflow-resume-dialog'}
        confirmTestId={pausing ? 'workflow-pause-confirm' : 'workflow-resume-confirm'}
        onConfirm={() => {
          void act
            .run(() => (pausing ? pauseRun(props.runId) : resumeRun(props.runId)).then(() => undefined))
            .then((ok) => {
              if (ok) {
                setConfirm(false);
                props.onChanged(pausing ? t.paused : t.resumed);
              }
            });
        }}
      >
        <DyApiError error={act.error} />
      </DyConfirmDialog>
    </>
  );
}

function NodeList(props: {
  readonly label: string;
  readonly nodes: readonly string[];
  readonly testId: string;
}) {
  const t = useT().workflows.ops;
  return (
    <div className="grid gap-1" data-testid={props.testId}>
      <span className="text-[0.8125rem] font-bold">{props.label}</span>
      {props.nodes.length === 0 ? (
        <span className="text-[0.84375rem] text-dy-muted">{t.none}</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {props.nodes.map((n) => (
            <Pill key={n} tone="neutral" className="font-dy-mono">
              {n}
            </Pill>
          ))}
        </span>
      )}
    </div>
  );
}

/** The re-run dialog: the dry-run plan, "en son sürümle", then the re-run itself (opens the new run). */
export function RerunDialog(props: {
  readonly runId: string;
  /** Re-run from this top-level node (null: the whole run). */
  readonly fromNode: string | null;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().workflows.ops;
  const navigate = useNavigate();
  const act = useSubmit();
  const [latest, setLatest] = useState(false);
  const [plan, setPlan] = useState<RerunPlan | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { open, runId, fromNode } = props;
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPlan(null);
    setError(null);
    rerunRun(runId, {
      ...(fromNode === null ? {} : { fromNode }),
      latestVersion: latest,
      dryRun: true,
    }).then(
      (r) => {
        if (live) setPlan(r.plan);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [open, runId, fromNode, latest]);
  useEffect(() => {
    if (!open) setLatest(false);
  }, [open]);
  const start = (): void => {
    void act
      .run(async () => {
        const r = await rerunRun(runId, {
          ...(fromNode === null ? {} : { fromNode }),
          latestVersion: latest,
        });
        if (r.runId !== null) {
          props.onClose();
          void navigate(runHref(r.runId));
        }
      })
      .then(() => undefined);
  };
  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={fromNode === null ? t.dialogTitle : t.dialogFrom({ node: fromNode })}
      description={fromNode === null ? t.dialogAll : undefined}
      size="md"
      testId="workflow-rerun-dialog"
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.keep}
          </DyButton>
          <DyButton
            variant="primary"
            icon="retry"
            busy={act.busy}
            disabled={plan === null || act.blocked}
            data-testid="workflow-rerun-confirm"
            onClick={start}
          >
            {t.confirm}
          </DyButton>
        </>
      }
    >
      <div className="grid gap-3">
        <DyCheck label={t.latest} checked={latest} onChange={setLatest} />
        <DyApiError error={error ?? act.error} />
        {plan === null ? (
          error === null ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{t.planLoading}</p>
          ) : null
        ) : (
          <div className="grid gap-3" data-testid="workflow-rerun-plan">
            <span className="text-[0.8125rem] text-dy-muted">{t.version({ n: plan.version })}</span>
            {plan.sideEffects.length === 0 ? null : (
              <DyNotice tone="amber" icon="flag" testId="workflow-rerun-effects">
                {t.runsAgain({ nodes: plan.sideEffects.join(', ') })}
              </DyNotice>
            )}
            {plan.aiSteps.length === 0 ? null : (
              <DyNotice tone="amber" icon="brain" testId="workflow-rerun-ai">
                {t.aiAgain({ nodes: plan.aiSteps.join(', ') })}
              </DyNotice>
            )}
            <NodeList label={t.fresh} nodes={plan.fresh} testId="workflow-rerun-fresh" />
            <NodeList label={t.copied} nodes={plan.copied} testId="workflow-rerun-copied" />
          </div>
        )}
      </div>
    </DyDialog>
  );
}

/** "önceki çalıştırmadan" on a node / node run a re-run copied. */
export function CopiedMark(props: { readonly copiedFrom: string | null | undefined }): ReactNode {
  const t = useT().workflows.ops;
  if (props.copiedFrom === null || props.copiedFrom === undefined) return null;
  return (
    <span title={t.copiedHint} data-testid="node-copied">
      <Pill tone="neutral" icon="copy">
        {t.copiedMark}
      </Pill>
    </span>
  );
}
