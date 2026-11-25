import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  cancelFleetAction,
  type CatalogItem,
  continueFleetAction,
  type FleetAction,
  listFleetActions,
  retryFleetAction,
} from '../../../api/fleetTools';
import { toApiError } from '../../../components/ui';
import { useSubmit } from '../../../screens/useSubmit';
import { ConfirmButton, DyApiError } from '../forms';
import { DyButton, EmptyLine, Panel, SkeletonRows } from '../parts';
import { useGuarded, whenText } from './tabs/config-shared';
import {
  ACTION_POLL_MS,
  ActionStateWord,
  ActionTargets,
  countsText,
  stepUpWhy,
  useFleetWords,
} from './fleet-tools-parts';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p13-fleet-tools — the recent fleet actions with per-machine progress (sırada, beklemede (kanarya sonrası),
 * gönderildi, çalışıyor, başarılı, başarısız, atlandı, süresi doldu, iptal), the reason in Turkish + the worker's
 * detail, the job of machine-admin targets; "Tümüne devam et" (held canary-first rollout), "Başarısızları yeniden
 * dene", "İptal" (confirmed). Polls every 2 s while one runs.
 */

export interface FleetActionsState {
  readonly actions: FleetAction[] | null;
  readonly error: ApiError | null;
  readonly put: (a: FleetAction) => void;
  readonly reload: () => Promise<void>;
}

export function useFleetActions(): FleetActionsState {
  const [actions, setActions] = useState<FleetAction[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const reload = useCallback(async () => {
    try {
      setActions(await listFleetActions());
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const live = actions?.some((a) => a.state === 'running') === true;
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => {
      void reload();
    }, ACTION_POLL_MS);
    return () => {
      clearTimeout(t);
    };
  }, [live, actions, reload]);
  const put = useCallback((a: FleetAction) => {
    setActions((prev) => [a, ...(prev ?? []).filter((x) => x.id !== a.id)]);
  }, []);
  return { actions, error, put, reload };
}

function ActionCard(props: {
  readonly action: FleetAction;
  readonly label: string;
  readonly isAdmin: boolean;
  readonly onChanged: (a: FleetAction) => void;
}): ReactNode {
  const fmt = useFormat();
  const ft = useT().fleetTools;
  const t = ft.actions;
  const words = useFleetWords();
  const a = props.action;
  const submit = useSubmit();
  const guarded = useGuarded();
  const run = (fn: () => Promise<FleetAction>, what: string): void => {
    void submit.run(async () => {
      const next = await guarded(fn, stepUpWhy(ft.parts, a.kind, `${props.label}: ${what}`));
      if (next !== null) props.onChanged(next);
    });
  };
  const failed = (a.counts.failed ?? 0) + (a.counts.expired ?? 0);
  const open = a.state === 'running' || a.state === 'held';
  return (
    <li
      id={`fleet-action-${a.id}`}
      tabIndex={-1}
      className="flex min-w-0 scroll-mt-24 flex-col gap-2 border-t border-dy-line px-4 py-3 outline-none first:border-t-0 focus:bg-dy-teal-soft"
      data-testid="fleet-action"
      data-action={a.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-bold">{props.label}</span>
        <span className="text-[0.8125rem] text-dy-muted">{words.actionKind(a.kind)}</span>
        {a.version === null ? null : <span className="font-dy-mono text-[0.8125rem]">{a.version}</span>}
        <ActionStateWord action={a} />
        <span className="text-[0.8125rem] text-dy-muted">
          {a.rollout === 'canary-first' ? t.canaryFirst : t.allAtOnce} · {whenText(a.createdAt, fmt)}
        </span>
      </div>
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="action-counts">
        {countsText(a, ft.parts, words)}
        {open ? t.offlineUntil({ when: whenText(a.expiresAt, fmt) }) : ''}
      </p>
      <ActionTargets targets={a.targets} />
      {props.isAdmin && (a.state === 'held' || failed > 0 || open) ? (
        <div className="flex flex-wrap gap-2">
          {a.state === 'held' ? (
            <DyButton
              variant="primary"
              busy={submit.busy}
              onClick={() => {
                run(() => continueFleetAction(a.id), t.continueWhat);
              }}
            >
              {t.continue}
            </DyButton>
          ) : null}
          {failed > 0 ? (
            <DyButton
              icon="retry"
              busy={submit.busy}
              onClick={() => {
                run(() => retryFleetAction(a.id), t.retryWhat);
              }}
            >
              {t.retry}
            </DyButton>
          ) : null}
          {open ? (
            <ConfirmButton
              label={t.cancel}
              question={t.cancelQuestion}
              confirmLabel={t.cancelConfirm}
              busy={submit.busy}
              testId={`action-cancel-${a.id}`}
              onConfirm={() => {
                run(() => cancelFleetAction(a.id), t.cancelWhat);
              }}
            />
          ) : null}
        </div>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </li>
  );
}

export function ActionsPanel(props: {
  readonly state: FleetActionsState;
  readonly catalog: readonly CatalogItem[];
  readonly isAdmin: boolean;
}): ReactNode {
  const { actions, error, put } = props.state;
  const t = useT().fleetTools.actions;
  const label = (item: string): string => props.catalog.find((c) => c.id === item)?.label ?? item;
  return (
    <Panel
      title={t.title}
      count={actions === null ? undefined : String(actions.length)}
      countLabel={actions === null ? undefined : t.count({ n: actions.length })}
      sub={t.sub}
      flush
      testId="fleet-actions"
    >
      <DyApiError error={error} />
      {actions === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : actions.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0" aria-label={t.title}>
          {actions.map((a) => (
            <ActionCard key={a.id} action={a} label={label(a.item)} isAdmin={props.isAdmin} onChanged={put} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
