import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  type Activation,
  getActivation,
  putActivation,
  type TriggerBinding,
} from '../../../api/workflowEngine';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import type { Tone } from '../../tone';
import { DyApiError, DyCopy, DyDialog, DyNotice } from '../kit';
import { DyButton, Pill } from '../parts';
import { nodeTypeText } from './nodeCatalog';

/**
 * p14-workflow-engine 14.2 (K2, design §3.1 / §6): "Tetikleyiciler" of the editor — every trigger node of the saved
 * workflow with its bound automation's status, the webhook address, the last run and whether the node changed since
 * the last activation; "Etkinleştir" reconciles them into automations (step-up for webhook / GitHub triggers), "Devre
 * dışı bırak" pauses them. A newly created webhook secret is shown once. Activation always uses the saved version.
 */

const STATUS_TONE: Readonly<Record<TriggerBinding['status'], Tone>> = {
  active: 'green',
  paused: 'amber',
  inactive: 'neutral',
  failed: 'red',
};

export function ActivationDialog(props: {
  readonly open: boolean;
  readonly workflowId: string;
  /** Unsaved changes on the canvas (activation uses the last saved version). */
  readonly dirty: boolean;
  /** The user may activate in this project (operator+). */
  readonly canActivate: boolean;
  readonly onClose: () => void;
  /**
   * p18-multi-project: the project that attached the workflow — its own automations, webhook address and secret; the
   * version comes from the attachment (no pin here).
   */
  readonly project?: string | undefined;
}): ReactNode {
  const t = useT();
  const a = t.workflows.activation;
  const fmt = useFormat();
  const stepUp = useStepUp();
  const act = useSubmit();
  const [view, setView] = useState<Activation | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [secrets, setSecrets] = useState<Activation['webhookSecrets']>([]);
  const [pin, setPin] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { open, workflowId, project } = props;

  const load = useCallback(() => {
    getActivation(workflowId, project).then(
      (v) => {
        setView(v);
        setPin(v.pinnedVersion);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [workflowId, project]);
  useEffect(() => {
    if (!open) return;
    setSecrets([]);
    setDone(null);
    load();
  }, [open, load]);

  const apply = (enabled: boolean): void => {
    setDone(null);
    void act
      .run(async () => {
        try {
          const v = await stepUp.run(
            () =>
              putActivation(
                workflowId,
                project === undefined ? { enabled, pinnedVersion: pin } : { enabled, project },
              ),
            a.stepUpReason,
          );
          setView(v);
          setSecrets(v.webhookSecrets);
          setDone(enabled ? a.enabled : a.disabled);
        } catch (err) {
          if (err instanceof StepUpCancelledError) return;
          throw err;
        }
      })
      .then(() => undefined);
  };

  const bound = view?.triggers.filter((x) => x.binding === 'automation') ?? [];
  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={a.title}
      description={a.sub}
      size="md"
      testId="workflow-activation"
      footer={
        view === null || bound.length === 0 ? (
          <DyButton onClick={props.onClose}>{t.shell.close}</DyButton>
        ) : (
          <>
            {view.enabled ? (
              <DyButton
                icon="pause"
                busy={act.busy}
                disabled={!props.canActivate || act.blocked}
                data-testid="workflow-deactivate"
                onClick={() => {
                  apply(false);
                }}
              >
                {a.disable}
              </DyButton>
            ) : null}
            <DyButton
              variant="primary"
              icon="check"
              busy={act.busy}
              disabled={!props.canActivate || act.blocked}
              data-testid="workflow-activate"
              onClick={() => {
                apply(true);
              }}
            >
              {a.enable}
            </DyButton>
          </>
        )
      }
    >
      <div className="grid gap-3">
        {view === null && error === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{a.loading}</p>
        ) : null}
        <DyApiError error={error ?? act.error} retryLeft={act.retryLeft} />
        {done === null ? null : (
          <DyNotice tone="green" live testId="workflow-activation-done">
            {done}
          </DyNotice>
        )}
        {props.dirty ? <DyNotice tone="amber">{a.unsaved}</DyNotice> : null}
        {!props.canActivate ? <DyNotice tone="neutral">{a.noPermission}</DyNotice> : null}
        {view !== null && view.needsExternal ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{a.needsExternal}</p>
        ) : null}
        {view !== null && bound.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="workflow-activation-none">
            {a.none}
          </p>
        ) : null}
        {secrets.map((s) => (
          <DyNotice
            key={s.nodeId}
            tone="amber"
            title={a.secretTitle({ node: s.nodeId })}
            testId="workflow-secret"
          >
            <span className="grid gap-2">
              <span>{a.secretOnce}</span>
              <code className="break-all font-dy-mono text-[0.78125rem]">{s.secret}</code>
              <span>
                <DyCopy text={s.secret} label={a.copy} />
              </span>
            </span>
          </DyNotice>
        ))}
        {view === null ? null : (
          <ul className="m-0 grid list-none gap-2 p-0" data-testid="workflow-triggers">
            {view.triggers.map((x) => (
              <li
                key={x.nodeId}
                className="grid gap-1 rounded-[12px] border border-dy-line p-3"
                data-testid="workflow-trigger"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-dy-mono font-bold">{x.nodeId}</span>
                  <span className="text-[0.8125rem] text-dy-muted">
                    {nodeTypeText(t.workflows, x.type)?.label ?? x.type}
                  </span>
                  <Pill tone={x.binding === 'none' ? 'teal' : STATUS_TONE[x.status]}>
                    {x.binding === 'none' ? a.alwaysOn : a.status[x.status]}
                  </Pill>
                </span>
                {!x.upToDate ? (
                  <span className="text-[0.8125rem] text-dy-amber-ink" data-testid="workflow-trigger-stale">
                    {a.outOfDate}
                  </span>
                ) : null}
                {x.webhookUrl === null ? null : (
                  <span className="grid gap-1 text-[0.8125rem]">
                    <span className="text-dy-muted">{a.webhookUrl}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="break-all font-dy-mono">{x.webhookUrl}</code>
                      <DyCopy text={x.webhookUrl} label={a.copy} />
                    </span>
                  </span>
                )}
                {x.lastRun === null ? null : (
                  <span className="text-[0.8125rem] text-dy-muted">
                    {a.lastRun({ state: x.lastRun.state, time: fmt.dateTime(x.lastRun.at) })}
                  </span>
                )}
                {x.automationId === null ? null : (
                  <Link
                    to={`/automations/${encodeURIComponent(x.automationId)}`}
                    className="text-[0.8125rem] text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                  >
                    {a.openAutomation}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        {view === null || view.orphans.length === 0 ? null : (
          <div className="grid gap-1" data-testid="workflow-trigger-orphans">
            <span className="text-[0.8125rem] font-bold">{a.orphans}</span>
            <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]">
              {view.orphans.map((o) => (
                <li key={o.nodeId} className="flex flex-wrap items-center gap-2">
                  <span className="font-dy-mono">{o.nodeId}</span>
                  <Link
                    to={`/automations/${encodeURIComponent(o.automationId)}`}
                    className="text-dy-teal-ink"
                  >
                    {a.openAutomation}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {view !== null && bound.length > 0 && project !== undefined ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="workflow-activation-shared">
            {t.workflowSharing.editor.activationNote}
          </p>
        ) : null}
        {view === null || bound.length === 0 || project !== undefined ? null : (
          <label className="grid gap-1 text-[0.8125rem] font-bold">
            {a.pinned}
            <select
              value={pin === null ? '' : String(pin)}
              data-testid="workflow-activation-pin"
              className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-2 font-normal"
              onChange={(e) => {
                setPin(e.target.value === '' ? null : Number(e.target.value));
              }}
            >
              <option value="">{a.latest}</option>
              {[
                ...new Set([
                  view.latestVersion,
                  ...(view.pinnedVersion === null ? [] : [view.pinnedVersion]),
                ]),
              ].map((v) => (
                <option key={v} value={String(v)}>
                  {a.pinnedTo({ version: v })}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </DyDialog>
  );
}
