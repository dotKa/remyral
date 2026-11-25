import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { listModels, MODEL_RUNTIMES, type ModelView } from '../../../api/models';
import {
  effectiveRule,
  JOB_ROLES,
  type JobRole,
  listRoutingRules,
  putRoutingRule,
  type RoutingRule,
} from '../../../api/routing';
import { toApiError } from '../../../components/ui';
import { useSubmit } from '../../../screens/useSubmit';
import { useSectionSave, useUnsavedGuard } from '../../formkit';
import { runtimeDisplayName } from '../../RuntimeMark';
import { DyApiError, DyCheck, FormActions } from '../forms';
import { DyButton, DySelect, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

type RoutingWords = Messages['knowledge']['routing'];

/**
 * p12-diyalog wave 2 (W3): routing rules in the Diyalog language — a job kind's preferred model profile and runtime
 * order. Global on Settings → Modeller (`project` null), per-project overrides on Projeler → Politika (a project rule
 * replaces the global rule of that kind as a whole). Same calls as the classic `RoutingRules`
 * (`GET /routing/rules`, `PUT /routing/rules`); writes are admin (`canWrite`) and always go through step-up.
 */

function ruleText(t: RoutingWords, r: RoutingRule, models: readonly ModelView[]): string {
  const parts: string[] = [];
  if (r.modelProfile !== null)
    parts.push(
      t.ruleModel({ name: models.find((m) => m.id === r.modelProfile)?.displayName ?? r.modelProfile }),
    );
  if (r.runtimes.length > 0)
    parts.push(t.ruleRuntimes({ list: r.runtimes.map((x) => runtimeDisplayName(x)).join(' → ') }));
  return parts.join(' · ');
}

export function RoutingRulesPanel(props: {
  /** null: the global rules (Settings → Modeller); else this project's overrides. */
  readonly project: string | null;
  readonly canWrite: boolean;
}): ReactNode {
  const t = useT().knowledge.routing;
  const roleText = (r: JobRole): string => t.roles[r];
  const [rules, setRules] = useState<RoutingRule[] | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [role, setRole] = useState<JobRole>('plan');
  const [profile, setProfile] = useState('');
  const [order, setOrder] = useState<string[]>([]);
  const submit = useSubmit();
  const sectionSave = useSectionSave();

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([listRoutingRules(props.project), listModels()]);
      setRules(r);
      setModels(m.items);
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, [props.project]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = (body: {
    role: JobRole;
    modelProfile: string | null;
    runtimes: readonly string[];
  }): Promise<boolean> =>
    sectionSave(
      submit,
      async () => {
        setRules(await putRoutingRule({ project: props.project, ...body }));
      },
      t.stepUp,
    );
  // p15-form-pattern: a resource list — rows keep their own actions and the rule form its own button; a filled-in
  // rule form still counts as unsaved for the leave guard (it is not part of the tab's bar).
  const snapshot = JSON.stringify([role, profile, order]);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const pending = props.canWrite && (profile !== '' || order.length > 0) && snapshot !== savedSnapshot;
  const saveForm = async (): Promise<boolean> => {
    const ok = await save({ role, modelProfile: profile === '' ? null : profile, runtimes: order });
    if (ok) setSavedSnapshot(snapshot);
    return ok;
  };
  useUnsavedGuard({
    dirty: pending,
    save: saveForm,
    discard: () => {
      setProfile('');
      setOrder([]);
    },
  });

  const global = props.project === null;
  const scope = props.project === null ? t.scopeAll : t.scopeProject({ project: props.project });
  const options = models.filter(
    (m) =>
      m.enabled && (order.length === 0 || order.some((r) => (m.runtimes as readonly string[]).includes(r))),
  );

  return (
    <Panel title={t.title} testId="dy-routing-rules" sub={global ? t.subGlobal : t.subProject} flush>
      <section aria-label={t.rules}>
        {loadError !== null ? (
          <div className="px-4">
            <ErrorLine error={loadError} what={t.rules} onRetry={() => void load()} />
          </div>
        ) : null}
        {rules === null && loadError === null ? <SkeletonRows label={t.loading} rows={3} /> : null}
        {rules !== null ? (
          <Rows label={t.list({ scope })}>
            {JOB_ROLES.map((r) => {
              const own = rules.find((x) => x.project === props.project && x.role === r);
              const inherited = global ? null : effectiveRule(rules, null, r);
              return (
                <Row
                  key={r}
                  testId={`routing-${r}`}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {roleText(r)}
                      {own !== undefined && !global ? <Pill tone="violet">{t.override}</Pill> : null}
                    </span>
                  }
                  meta={
                    own !== undefined ? (
                      <span>{ruleText(t, own, models)}</span>
                    ) : inherited !== null ? (
                      <span>{t.inherited({ rule: ruleText(t, inherited, models) })}</span>
                    ) : (
                      <span>{t.none}</span>
                    )
                  }
                  actions={
                    own !== undefined && props.canWrite ? (
                      <DyButton
                        variant="ghost"
                        disabled={submit.busy}
                        aria-label={t.removeLabel({ role: roleText(r), scope })}
                        onClick={() => {
                          void save({ role: r, modelProfile: null, runtimes: [] });
                        }}
                      >
                        {t.remove}
                      </DyButton>
                    ) : undefined
                  }
                />
              );
            })}
          </Rows>
        ) : null}
        {props.canWrite && rules !== null ? (
          <form
            aria-label={t.form}
            className="flex flex-col gap-3 border-t border-dy-line px-4 pt-3 pb-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (profile === '' && order.length === 0) return;
              void saveForm();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <DySelect
                label={t.role}
                value={role}
                options={JOB_ROLES.map((r) => [r, roleText(r)] as const)}
                onChange={(v) => {
                  setRole(v as JobRole);
                }}
              />
              <DySelect
                label={t.profile}
                value={profile}
                options={[['', t.noProfile], ...options.map((m) => [m.id, m.displayName] as const)]}
                onChange={setProfile}
              />
            </div>
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.order}</legend>
              <p className="m-0 text-[0.78125rem] text-dy-muted">{t.orderHint}</p>
              <div className="flex flex-wrap gap-x-5">
                {MODEL_RUNTIMES.map((r) => {
                  const at = order.indexOf(r);
                  return (
                    <DyCheck
                      key={r}
                      label={
                        at === -1 ? runtimeDisplayName(r) : `${String(at + 1)}. ${runtimeDisplayName(r)}`
                      }
                      checked={at !== -1}
                      onChange={(on) => {
                        setOrder((o) => (on ? [...o, r] : o.filter((x) => x !== r)));
                      }}
                    />
                  );
                })}
              </div>
            </fieldset>
            <FormActions>
              <DyButton
                type="submit"
                variant="primary"
                busy={submit.busy}
                disabled={profile === '' && order.length === 0}
              >
                {t.save}
              </DyButton>
            </FormActions>
          </form>
        ) : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} className="px-4 pb-4" />
      </section>
    </Panel>
  );
}
