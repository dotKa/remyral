import { type ReactNode, useState } from 'react';
import { rotateWorkerKey, workerAction, type WorkerDetail } from '../../../../api/workers';
import { type LifecycleAction, lifecycleActions, useGuarded } from '../../../../screens/fleet/machineShared';
import { useSubmit } from '../../../../screens/useSubmit';
import type { IconName } from '../../../icons';
import type { Tone } from '../../../tone';
import { DyApiError } from '../../forms';
import { DyButton, Panel, Pill, Row, Rows } from '../../parts';
import { DyConfirmDialog } from '../../../common/actions';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yönetim → Erişim: drain, key rotation (start / approve the new key), revoke,
 * remove from the list and unarchive, in the Diyalog language. Which actions a machine has is the classic rule
 * (`lifecycleActions` / `archivable`); every action goes through step-up exactly as the classic `LifecycleActions`;
 * revoke and remove need a second press (remove also says what stays). The device keys are listed under it.
 */

const ACTION: Readonly<Record<LifecycleAction, { readonly icon: IconName; readonly danger: boolean }>> = {
  drain: { icon: 'pause', danger: false },
  rotate: { icon: 'key', danger: false },
  'approve-rotation': { icon: 'key', danger: false },
  revoke: { icon: 'shield', danger: true },
  archive: { icon: 'folder', danger: true },
  unarchive: { icon: 'folder', danger: false },
};

type Lifecycle = Messages['machineAdmin']['lifecycle'];

/** The label, hint and (for actions that need a second press) the confirm label of one action. */
function actionText(
  t: Lifecycle,
  a: LifecycleAction,
): { readonly label: string; readonly hint: string; readonly confirm?: string } {
  return a === 'approve-rotation' ? t.actions.approveRotation : t.actions[a];
}

function run(id: string, action: LifecycleAction): Promise<unknown> {
  return action === 'rotate' ? rotateWorkerKey(id) : workerAction(id, action);
}

const KEY_TONE: Readonly<Record<string, Tone>> = {
  active: 'green',
  pending: 'amber',
  revoked: 'red',
  superseded: 'neutral',
};

function keyStateText(t: Lifecycle, status: string): string {
  switch (status) {
    case 'active':
    case 'pending':
    case 'revoked':
    case 'superseded':
      return t.keyState[status];
    default:
      return status;
  }
}

export function AccessPanel(props: {
  readonly worker: WorkerDetail;
  readonly onChanged: () => void;
}): ReactNode {
  const w = props.worker;
  const all = useT().machineAdmin;
  const tl = all.lifecycle;
  const submit = useSubmit();
  const guarded = useGuarded();
  const [confirming, setConfirming] = useState<LifecycleAction | null>(null);
  const actions = lifecycleActions(w, w);

  const press = (a: LifecycleAction): void => {
    const t = actionText(tl, a);
    if (t.confirm !== undefined && confirming !== a) {
      setConfirming(a);
      return;
    }
    setConfirming(null);
    void submit
      .run(() => guarded(() => run(w.id, a), all.stepUp({ machine: w.name, what: t.label })))
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };

  return (
    <Panel title={tl.title} sub={tl.sub} flush testId="machine-access">
      {actions.length === 0 ? (
        <p className="m-0 px-4 pb-3 text-[0.875rem] text-dy-muted">{tl.none}</p>
      ) : (
        <>
          <Rows label={tl.actionsLabel} testId="lifecycle-actions">
            {actions.map((a) => {
              const t = actionText(tl, a);
              const look = ACTION[a];
              return (
                <Row
                  key={a}
                  title={<span className="font-normal">{t.hint}</span>}
                  actions={
                    <DyButton
                      variant={look.danger ? 'danger' : 'secondary'}
                      icon={look.icon}
                      busy={submit.busy}
                      disabled={submit.blocked}
                      aria-haspopup={t.confirm === undefined ? undefined : 'dialog'}
                      data-testid={`lifecycle-${a}`}
                      onClick={() => {
                        press(a);
                      }}
                    >
                      {t.label}
                    </DyButton>
                  }
                />
              );
            })}
          </Rows>
        </>
      )}
      {confirming === null ? null : (
        <DyConfirmDialog
          open
          onClose={() => {
            setConfirming(null);
          }}
          title={actionText(tl, confirming).label}
          description={
            confirming === 'archive' ? (
              <span data-testid="archive-confirm-note">{tl.archiveConfirm({ machine: w.name })}</span>
            ) : (
              actionText(tl, confirming).hint
            )
          }
          confirmLabel={actionText(tl, confirming).confirm ?? actionText(tl, confirming).label}
          cancelLabel={all.cancel}
          variant={ACTION[confirming].danger ? 'danger' : 'warn'}
          testId="lifecycle-confirm-dialog"
          confirmTestId={`lifecycle-${confirming}-confirm`}
          onConfirm={() => {
            press(confirming);
          }}
        />
      )}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} className="px-4 pb-3" />
      {w.credentials.length > 0 ? (
        <div className="border-t border-dy-line px-4 py-3">
          <h3 className="m-0 mb-1.5 text-[0.875rem] font-bold">{tl.deviceKeys}</h3>
          <ul
            className="m-0 flex list-none flex-col gap-1.5 p-0 text-[0.8125rem]"
            data-testid="credential-list"
          >
            {w.credentials.map((c) => {
              const s = { tone: KEY_TONE[c.status] ?? 'neutral', text: keyStateText(tl, c.status) };
              return (
                <li key={`${c.fingerprint}-${c.status}`} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 font-dy-mono [overflow-wrap:anywhere]">{c.fingerprint}</span>
                  <Pill tone={s.tone}>{s.text}</Pill>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
