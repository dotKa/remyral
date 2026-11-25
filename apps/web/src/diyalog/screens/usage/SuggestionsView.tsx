import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { pauseAutomation, updateAutomation } from '../../../api/automations';
import { getSuggestions, type Suggestion, type SuggestionAction } from '../../../api/efficiency';
import { JOB_ROLES, type JobRole, putRoutingRule } from '../../../api/routing';
import { bulkWorkerConfig } from '../../../api/workerConfig';
import { RANK, readDismissed, type Role, safePath, writeDismissed } from '../../../screens/usage/suggestions';
import { DyConfirmDialog } from '../../common/actions';
import { DyIcon } from '../../icons';
import { DyApiError } from '../kit';
import { DyButton, EmptyLine, ErrorLine, Panel, Pill, Rows, SkeletonRows } from '../parts';
import { useGuarded, useLoad } from './common';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog-w2: Kullanım → Öneriler in the Diyalog language. Same `GET /usage/suggestions`, same role check
 * (`actionRole`), same confirm-then-apply through the mechanism's own route with step-up when the suggestion asks
 * for it, same per-browser dismiss list as the classic panel. Nothing is applied without a confirmation.
 */

/** What a suggestion's step does, in the user's language. */
export function actionLabel(t: Messages['usage']['suggestions']['actions'], a: SuggestionAction): string {
  switch (a.kind) {
    case 'routing_rule':
      return t.routingRule({ role: a.role, profile: a.modelProfile });
    case 'pause_automation':
      return t.pauseAutomation;
    case 'enable_reuse':
      return t.enableReuse({ hours: a.hours });
    case 'set_parallelism':
      return t.setParallelism({ n: a.value });
    case 'open':
      return t.open;
  }
}

async function applyAction(s: Suggestion, action: SuggestionAction): Promise<void> {
  switch (action.kind) {
    case 'routing_rule': {
      const role = JOB_ROLES.find((r) => r === action.role);
      if (role === undefined) throw new Error('unknown job kind'); // i18n-ignore: internal, never shown
      await putRoutingRule({
        project: null,
        role: role satisfies JobRole,
        modelProfile: action.modelProfile,
        runtimes: action.runtimes,
      });
      return;
    }
    case 'pause_automation':
      await pauseAutomation(action.automationId);
      return;
    case 'enable_reuse':
      await updateAutomation(action.automationId, { reuseWithinHours: action.hours });
      return;
    case 'set_parallelism':
      await bulkWorkerConfig({
        workerIds: [action.workerId],
        patch: { maxParallelJobs: action.value },
        changeNote: `Efficiency suggestion: ${s.title}`.slice(0, 1000), // i18n-ignore: audit note sent to the API
      });
      return;
    case 'open':
      return;
  }
}

function SuggestionRow(props: {
  readonly s: Suggestion;
  readonly role: Role;
  readonly onDone: (message: string) => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const { s } = props;
  const t = useT().usage.suggestions;
  const cancel = useT().usage.cancel;
  const navigate = useNavigate();
  const g = useGuarded();
  const [confirming, setConfirming] = useState(false);
  const a = s.action;
  const allowed = a !== null && (s.actionRole === null || RANK[props.role] >= RANK[s.actionRole]);
  const warn = s.severity === 'warning';
  const open = a?.kind === 'open' ? safePath(a.path) : null;
  return (
    <li className="border-t border-dy-line px-4 py-3.5 first:border-t-0" data-testid="suggestion">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={warn ? 'amber' : 'teal'} icon={warn ? 'flag' : 'brain'}>
          {warn ? t.warning : t.idea}
        </Pill>
        <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{s.title}</span>
        {s.project === null ? null : (
          <span className="font-dy-mono text-[0.8125rem] text-dy-muted">{s.project}</span>
        )}
      </div>
      <p className="m-0 mt-1 max-w-[72ch] text-[0.875rem] text-dy-muted">{s.detail}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {open !== null ? (
          <DyButton
            icon="chev"
            onClick={() => {
              void navigate(open);
            }}
          >
            {t.open}
          </DyButton>
        ) : null}
        {a !== null && a.kind !== 'open' && allowed ? (
          <>
            <DyButton
              aria-haspopup="dialog"
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t.start({ action: actionLabel(t.actions, a) })}
            </DyButton>
            <DyConfirmDialog
              open={confirming}
              onClose={() => {
                setConfirming(false);
              }}
              title={s.title}
              description={s.detail}
              confirmLabel={t.confirm({ action: actionLabel(t.actions, a) })}
              cancelLabel={cancel}
              variant="primary"
              busy={g.busy}
              testId="suggestion-confirm"
              onConfirm={() => {
                void g
                  .run(
                    () => applyAction(s, a),
                    t.stepUp({ action: actionLabel(t.actions, a) }),
                    s.actionStepUp,
                  )
                  .then((ok) => {
                    setConfirming(false);
                    if (ok) props.onDone(t.done({ action: actionLabel(t.actions, a) }));
                  });
              }}
            />
          </>
        ) : null}
        {a !== null && a.kind !== 'open' && !allowed ? (
          <span className="text-[0.8125rem] text-dy-muted">{t.roleOnly({ role: s.actionRole ?? '' })}</span>
        ) : null}
        <DyButton variant="ghost" onClick={props.onDismiss}>
          {t.hide}
        </DyButton>
        {s.actionStepUp && a !== null && a.kind !== 'open' && allowed ? (
          <span className="inline-flex items-center gap-1 text-[0.78125rem] text-dy-faint">
            <DyIcon name="key" className="size-3.5" />
            {t.needsCode}
          </span>
        ) : null}
      </div>
      {g.error === null ? null : (
        <div className="mt-2">
          <DyApiError error={g.error} />
        </div>
      )}
    </li>
  );
}

export function SuggestionsView(props: { readonly role: Role }): ReactNode {
  const t = useT().usage.suggestions;
  const { data, error, reload } = useLoad(getSuggestions);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const visible = (data ?? []).filter((s) => !dismissed.has(s.id));
  return (
    <section aria-label={t.section} className="flex flex-col gap-4" data-testid="dy-suggestions">
      <ErrorLine error={error} what={t.what} onRetry={reload} />
      <Panel title={t.title} count={data === null ? undefined : String(visible.length)} sub={t.sub} flush>
        {data === null ? (
          error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : visible.length === 0 ? (
          <EmptyLine testId="suggestions-empty">{t.empty}</EmptyLine>
        ) : (
          <Rows label={t.title}>
            {visible.map((s) => (
              <SuggestionRow
                key={s.id}
                s={s}
                role={props.role}
                onDone={(m) => {
                  setNotice(m);
                  reload();
                }}
                onDismiss={() => {
                  const next = new Set(dismissed).add(s.id);
                  writeDismissed(next);
                  setDismissed(next);
                }}
              />
            ))}
          </Rows>
        )}
      </Panel>
    </section>
  );
}
