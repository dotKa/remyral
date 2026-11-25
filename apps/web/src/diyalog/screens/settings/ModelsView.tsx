import { type ReactNode, type SubmitEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteModel,
  listModels,
  type ModelDefault,
  MODEL_RUNTIMES,
  type ModelRuntime,
  type ModelView,
  pricingText,
  putModel,
  putModelDefault,
} from '../../../api/models';
import { useAuth } from '../../../auth/AuthProvider';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

const MODEL_SORT_KEYS = ['name'] as const;
const MODEL_COMPARE = {
  name: (a: ModelView, b: ModelView): number => a.displayName.localeCompare(b.displayName),
} as const;
import { DyPager } from '../../common/pager';
import { DySortBar, sortRows, useSortParam } from '../../common/sort';
import { useClientPage } from '../../../lib/pager';
import { EMPTY_MODEL_FORM, entryOf, type ModelForm, modelFormOf } from '../../../screens/modelForm';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { RuntimeMark, runtimeDisplayName } from '../../RuntimeMark';
import {
  ConfirmButton,
  DyApiError,
  DyCheck,
  DyDialog,
  DyField,
  DyNotice,
  DyTextarea,
  FormActions,
} from '../forms';
import { DyButton, DyButtonLink, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { RoutingRulesPanel } from '../shared/RoutingRulesPanel';
import { DyModelPicker, type ModelPickKind, runtimeModelsOf, useRuntimeModels } from '../shared/ModelPicker';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Modeller in the Diyalog language, feature for feature with the classic
 * `ModelsPage` (p5-credentials-models): the model catalog (profiles named by runtime policies, machine
 * configurations and the composer), create / edit / delete with step-up and the optimistic `expectedVersion`, the
 * stale-policy-copy warning, defaults (all projects and per project) and the global routing rules (the native
 * `RoutingRulesPanel`). Validation is the classic `entryOf` (its field keys, Turkish messages here). A credential is
 * referenced, never stored. Everyone reads; owners and admins write.
 */

const NAME_RT = (r: string): string => runtimeDisplayName(r);

type ModelsText = Messages['integrations']['models'];

/** The user's wording of the classic `entryOf` field errors (same keys, same checks). */
function errorText(t: ModelsText, key: string, raw: string): string {
  switch (key) {
    case 'id':
      return t.errors.id;
    case 'displayName':
    case 'model':
      return t.errors.required;
    case 'runtimes':
      return t.errors.runtimes;
    case 'provider':
      return t.errors.provider;
    case 'credName':
      return t.errors.credName;
    case 'credEnv':
      return t.errors.credEnv;
    case 'params': {
      const m = /^“(.*)” is not key=value\.$/.exec(raw);
      return m === null ? raw : t.errors.params({ line: m[1] ?? '' });
    }
    default:
      return raw;
  }
}

function useStepUpRun(): (fn: () => Promise<void>, why: string) => Promise<void> {
  const stepUp = useStepUp();
  return useCallback(
    async (fn, why) => {
      try {
        await stepUp.run(fn, why);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    },
    [stepUp],
  );
}

const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * p15-model-picker: a profile's model from the runtime model catalog (the selected runtimes' models together). Pi /
 * OpenCode ids are `provider/model`: choosing one fills the provider and the model; a Claude Code / Codex model fills
 * the provider from the catalog when it is still empty. A custom id stays possible.
 */
function ProfileModelField(props: {
  readonly form: ModelForm;
  readonly set: (patch: Partial<ModelForm>) => void;
  readonly label: string;
  readonly error: string | null;
}): ReactNode {
  const { form: f, set } = props;
  const catalog = useRuntimeModels();
  const runtimes: readonly ModelRuntime[] = f.runtimes.length === 0 ? MODEL_RUNTIMES : f.runtimes;
  const known = new Map<string, string | undefined>();
  for (const r of runtimes) for (const m of runtimeModelsOf(catalog, r).models) known.set(m.id, m.provider);
  const joined = f.provider !== '' && f.model !== '' ? `${f.provider}/${f.model}` : f.model;
  const value = known.has(joined) ? joined : f.model;
  return (
    <DyModelPicker
      label={props.label}
      runtimes={runtimes}
      value={value}
      defaultLabel={null}
      catalog={catalog}
      error={props.error}
      testId="profile-model-picker"
      onChange={(v) => {
        const slash = v.indexOf('/');
        const head = slash > 0 ? v.slice(0, slash) : '';
        if (slash > 0 && PROVIDER.test(head) && (known.has(v) || f.provider === '' || f.provider === head)) {
          set({ provider: head, model: v.slice(slash + 1) });
          return;
        }
        const provider = known.get(v);
        set(f.provider === '' && provider !== undefined ? { model: v, provider } : { model: v });
      }}
    />
  );
}

function ModelFormView(props: {
  readonly initial: ModelView | null;
  readonly onSaved: (m: ModelView) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [f, setF] = useState<ModelForm>(
    props.initial === null ? EMPTY_MODEL_FORM : modelFormOf(props.initial),
  );
  const t = useT().integrations.models;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = useSubmit();
  const guarded = useStepUpRun();
  const set = (patch: Partial<ModelForm>): void => {
    setF((x) => ({ ...x, ...patch }));
  };
  const err = (k: string): string | null => {
    const raw = errors[k];
    return raw === undefined ? null : errorText(t, k, raw);
  };

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    const { entry, errors: errs } = entryOf(f);
    setErrors(errs);
    if (entry === null) return;
    void submit.run(() =>
      guarded(async () => {
        props.onSaved(await putModel(entry.id, { entry, expectedVersion: props.initial?.version ?? 0 }));
      }, t.stepUpSave),
    );
  }

  return (
    <form onSubmit={onSubmit} aria-label={t.form.label} className="grid gap-3 sm:grid-cols-2">
      <DyField
        label={t.form.id}
        value={f.id}
        mono
        disabled={props.initial !== null}
        error={err('id')}
        hint={t.form.idHint}
        onChange={(v) => {
          set({ id: v.trim() });
        }}
      />
      <DyField
        label={t.form.displayName}
        value={f.displayName}
        error={err('displayName')}
        onChange={(v) => {
          set({ displayName: v });
        }}
      />
      <DyField
        label={t.form.provider}
        value={f.provider}
        mono
        placeholder={t.form.providerPlaceholder}
        error={err('provider')}
        onChange={(v) => {
          set({ provider: v.trim() });
        }}
      />
      <ProfileModelField form={f} set={set} label={t.form.model} error={err('model')} />
      <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0 sm:col-span-2">
        <legend className="text-[0.8125rem] font-bold">{t.form.runtimes}</legend>
        <div className="flex flex-wrap gap-x-5">
          {MODEL_RUNTIMES.map((r) => (
            <DyCheck
              key={r}
              label={<RuntimeMark runtime={r} />}
              checked={f.runtimes.includes(r)}
              onChange={(on) => {
                set({ runtimes: on ? [...f.runtimes, r] : f.runtimes.filter((x) => x !== r) });
              }}
            />
          ))}
        </div>
        {err('runtimes') === null ? null : (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{err('runtimes')}</p>
        )}
      </fieldset>
      <DySelect
        label={t.form.credential}
        value={f.credSource}
        options={[
          ['', t.form.credNone],
          ['vault', t.form.credVault],
          ['worker-store', t.form.credWorker],
        ]}
        onChange={(v) => {
          set({ credSource: v as ModelForm['credSource'] });
        }}
      />
      {f.credSource !== '' ? (
        <DyField
          label={f.credSource === 'vault' ? t.form.credId : t.form.secretName}
          value={f.credName}
          mono
          error={err('credName')}
          onChange={(v) => {
            set({ credName: v.trim() });
          }}
        />
      ) : (
        <span className="hidden sm:block" />
      )}
      {f.credSource !== '' ? (
        <DyField
          label={t.form.credEnv}
          value={f.credEnv}
          mono
          placeholder={t.form.credEnvPlaceholder}
          error={err('credEnv')}
          wrapClassName="sm:col-span-2"
          onChange={(v) => {
            set({ credEnv: v.trim() });
          }}
        />
      ) : null}
      <DyField
        label={t.form.contextWindow}
        type="number"
        min={1}
        value={f.contextWindow}
        onChange={(v) => {
          set({ contextWindow: v });
        }}
      />
      <DyField
        label={t.form.maxOutput}
        type="number"
        min={1}
        value={f.maxOutputTokens}
        onChange={(v) => {
          set({ maxOutputTokens: v });
        }}
      />
      <DyField
        label={t.form.inputPrice}
        type="number"
        min={0}
        step="any"
        value={f.inputPerMTok}
        onChange={(v) => {
          set({ inputPerMTok: v });
        }}
      />
      <DyField
        label={t.form.outputPrice}
        type="number"
        min={0}
        step="any"
        value={f.outputPerMTok}
        onChange={(v) => {
          set({ outputPerMTok: v });
        }}
      />
      <DyTextarea
        label={t.form.params}
        rows={3}
        mono
        value={f.params}
        placeholder="reasoningEffort=low" // i18n-ignore: product name or example value
        hint={t.form.paramsHint}
        error={err('params')}
        wrapClassName="sm:col-span-2"
        onChange={(v) => {
          set({ params: v });
        }}
      />
      <DyField
        label={t.form.description}
        value={f.description}
        maxLength={500}
        wrapClassName="sm:col-span-2"
        onChange={(v) => {
          set({ description: v });
        }}
      />
      <DyCheck
        className="sm:col-span-2"
        label={t.form.enabled}
        hint={t.form.enabledHint}
        checked={f.enabled}
        onChange={(on) => {
          set({ enabled: on });
        }}
      />
      <div className="flex flex-col gap-2 sm:col-span-2">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        {submit.error?.issues.length ? (
          <p className="m-0 text-[0.78125rem] text-dy-red-ink" data-testid="model-issues">
            {submit.error.issues.map((i) => `${i.path}: ${i.code}`).join('; ')}
          </p>
        ) : null}
        <FormActions>
          <DyButton type="submit" variant="primary" busy={submit.busy}>
            {t.form.save}
          </DyButton>
          <DyButton variant="ghost" onClick={props.onCancel}>
            {t.form.cancel}
          </DyButton>
        </FormActions>
      </div>
    </form>
  );
}

function profileName(models: readonly ModelView[], id: string): string {
  return models.find((m) => m.id === id)?.displayName ?? id;
}

/** p15-model-picker: what a default names — a profile (its name and id) or a model id. */
function DefaultTarget(props: {
  readonly models: readonly ModelView[];
  readonly d: ModelDefault;
}): ReactNode {
  const { d } = props;
  return d.profileId !== null ? (
    <span>
      → {profileName(props.models, d.profileId)}{' '}
      <span className="font-dy-mono text-[0.78125rem]">{d.profileId}</span>
    </span>
  ) : (
    <span>
      → <span className="font-dy-mono">{d.model}</span>
    </span>
  );
}

function Defaults(props: {
  readonly models: readonly ModelView[];
  readonly defaults: readonly ModelDefault[];
  readonly canWrite: boolean;
  readonly onChanged: (d: ModelDefault[]) => void;
}): ReactNode {
  const t = useT().integrations.models.defaults;
  const mp = useT().modelPicker;
  const [project, setProject] = useState('');
  const [runtime, setRuntime] = useState<ModelRuntime>('claude-code');
  const [choice, setChoice] = useState<{ value: string; kind: ModelPickKind }>({
    value: '',
    kind: 'default',
  });
  const submit = useSubmit();
  const guarded = useStepUpRun();
  const catalog = useRuntimeModels();
  const options = props.models.filter((m) => m.enabled && m.runtimes.includes(runtime));
  const save = (body: {
    project: string | null;
    runtime: ModelRuntime;
    profileId: string | null;
    model?: string | null;
  }): void =>
    void submit.run(() =>
      guarded(async () => {
        props.onChanged(await putModelDefault(body));
      }, t.stepUp),
    );
  const global = (r: ModelRuntime): ModelDefault | undefined =>
    props.defaults.find((d) => d.project === null && d.runtime === r);
  const perProject = props.defaults.filter((d) => d.project !== null);
  const clear = (d: ModelDefault): ReactNode =>
    props.canWrite ? (
      <DyButton
        variant="ghost"
        disabled={submit.busy}
        aria-label={t.clearLabel({ target: d.project ?? t.allProjectsLower, runtime: NAME_RT(d.runtime) })}
        onClick={() => {
          save({ project: d.project, runtime: d.runtime, profileId: null });
        }}
      >
        {t.remove}
      </DyButton>
    ) : undefined;
  return (
    <Panel title={t.title} sub={t.sub} flush testId="dy-model-defaults">
      <h3 className="m-0 px-4 pt-1 pb-1 text-[0.8125rem] font-bold text-dy-muted">{t.allProjects}</h3>
      <Rows label={t.listLabel}>
        {MODEL_RUNTIMES.map((r) => {
          const d = global(r);
          // p15-model-picker: each machine's own default for the runtime (it wins over a global model default).
          const machines = runtimeModelsOf(catalog, r).defaults.machines;
          return (
            <Row
              key={r}
              testId={`default-${r}`}
              title={<RuntimeMark runtime={r} className="font-bold" />}
              meta={
                <span className="grid gap-0.5">
                  {d ? <DefaultTarget models={props.models} d={d} /> : <span>{t.none}</span>}
                  {d !== undefined && d.model !== null ? (
                    <span className="text-[0.78125rem] text-dy-muted">{mp.softDefaultHint}</span>
                  ) : null}
                  {machines.length > 0 ? (
                    <span className="text-[0.78125rem] text-dy-muted" data-testid={`machine-defaults-${r}`}>
                      {mp.machineDefaults}:{' '}
                      {machines
                        .map((m) =>
                          mp.machineDefault({ name: m.workerName, value: m.model ?? m.modelProfile ?? '' }),
                        )
                        .join(', ')}
                    </span>
                  ) : null}
                </span>
              }
              actions={d ? clear(d) : undefined}
            />
          );
        })}
      </Rows>
      {perProject.length > 0 ? (
        <>
          <h3 className="m-0 border-t border-dy-line px-4 pt-3 pb-1 text-[0.8125rem] font-bold text-dy-muted">
            {t.perProject}
          </h3>
          <Rows label={t.perProjectLabel}>
            {perProject.map((d) => (
              <Row
                key={`${d.project ?? '*'}-${d.runtime}`}
                title={
                  <span>
                    <span className="font-dy-mono">{d.project}</span> · {NAME_RT(d.runtime)}
                  </span>
                }
                meta={<DefaultTarget models={props.models} d={d} />}
                actions={clear(d)}
              />
            ))}
          </Rows>
        </>
      ) : null}
      {props.canWrite ? (
        <form
          aria-label={t.formLabel}
          className="grid gap-3 border-t border-dy-line px-4 pt-3.5 pb-4 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice.value === '' || choice.kind === 'default') return;
            const target = project.trim() === '' ? null : project.trim();
            save(
              choice.kind === 'profile'
                ? { project: target, runtime, profileId: choice.value }
                : { project: target, runtime, profileId: null, model: choice.value },
            );
          }}
        >
          <DyField label={t.project} value={project} mono placeholder={t.allProjects} onChange={setProject} />
          <DySelect
            label={t.runtime}
            value={runtime}
            options={MODEL_RUNTIMES.map((r) => [r, NAME_RT(r)] as const)}
            onChange={(v) => {
              setRuntime(v as ModelRuntime);
              setChoice({ value: '', kind: 'default' });
            }}
          />
          <DyModelPicker
            label={t.profile}
            runtimes={[runtime]}
            value={choice.value}
            valueKind={choice.kind === 'profile' ? 'profile' : 'model'}
            defaultLabel={t.choose}
            catalog={catalog}
            profiles={options.map((m) => ({
              value: m.id,
              label: m.displayName,
              detail: `${m.provider}/${m.model}`,
            }))}
            testId="default-model-picker"
            onChange={(value, kind) => {
              setChoice({ value, kind });
            }}
          />
          <DyButton type="submit" busy={submit.busy}>
            {t.makeDefault}
          </DyButton>
        </form>
      ) : null}
      <div className="px-4 pb-3 empty:hidden">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

function credentialText(t: ModelsText, m: ModelView): string | null {
  const ref = m.credentialRef;
  if (ref === undefined) return null;
  return ref.source === 'vault' ? ref.id : t.machineSecret({ name: ref.name });
}

export function ModelsView(): ReactNode {
  const t = useT().integrations.models;
  const { state } = useAuth();
  const canWrite = state.kind === 'signedIn' && (state.user.role === 'owner' || state.user.role === 'admin');
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [defaults, setDefaults] = useState<ModelDefault[]>([]);
  const [dialog, setDialog] = useState<{ readonly target: ModelView | null; readonly seq: number } | null>(
    null,
  );
  const seq = useRef(0);
  const load = useSubmit();
  const del = useSubmit();
  const guarded = useStepUpRun();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const r = await listModels();
      setModels(r.items);
      setDefaults(r.defaults);
    });
  }, [load]);

  useEffect(() => {
    void refresh();
  }, []);

  const open = (target: ModelView | null): void => {
    seq.current += 1;
    setDialog({ target, seq: seq.current });
  };
  const close = (): void => {
    setDialog(null);
  };

  const stale = (models ?? []).filter((m) => m.usedBy.policies.some((p) => !p.inSync));
  // The classic table's sortable name column (ascending first), kept in the URL.
  const [sort, setSort] = useSortParam(MODEL_SORT_KEYS, { initial: { key: 'name', dir: 'asc' } });
  const byName = sortRows(models ?? [], sort, MODEL_COMPARE);
  const { pageItems, pagination } = useClientPage(byName, { label: t.pagesLabel });

  return (
    <div className="flex flex-col gap-5" data-testid="dy-models">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {models === null ? (
        load.error === null ? (
          <Panel title={t.title} flush>
            <SkeletonRows label={t.loading} rows={3} />
          </Panel>
        ) : null
      ) : (
        <>
          <DyApiError error={del.error} retryLeft={del.retryLeft} />
          {stale.map((m) => (
            <DyNotice
              key={m.id}
              tone="amber"
              action={
                <DyButtonLink to="/settings/runtimes" variant="secondary">
                  {t.openPolicies}
                </DyButtonLink>
              }
            >
              {t.stale({
                name: m.displayName,
                policies: m.usedBy.policies
                  .filter((p) => !p.inSync)
                  .map((p) => `${p.policy} v${String(p.version)}`)
                  .join(', '),
              })}
            </DyNotice>
          ))}
          <Panel
            title={t.title}
            count={String(models.length)}
            countLabel={t.count({ n: models.length })}
            aside={
              canWrite ? (
                <DyButton
                  variant="primary"
                  icon="plus"
                  onClick={() => {
                    open(null);
                  }}
                >
                  {t.add}
                </DyButton>
              ) : undefined
            }
            flush
            testId="model-table"
          >
            {models.length === 0 ? (
              <EmptyLine>
                {t.empty}
                {canWrite ? t.emptyAdd : ''}
              </EmptyLine>
            ) : (
              <>
                <DySortBar
                  keys={MODEL_SORT_KEYS}
                  labels={{ name: t.sortName }}
                  sort={sort}
                  onSort={setSort}
                  defaultNote={t.defaultNote}
                  sortedNote={t.sortedNote}
                  className="border-b border-dy-line"
                  testId="model-sort"
                />
                <Rows label={t.rowsLabel}>
                  {pageItems.map((m) => {
                    const cred = credentialText(t, m);
                    const price = pricingText(m.pricing);
                    return (
                      <Row
                        key={m.id}
                        testId="model-row"
                        lead={<DyIcon name="brain" className="size-4" />}
                        tone={m.enabled ? undefined : 'amber'}
                        title={
                          <span className="flex flex-wrap items-center gap-2">
                            {m.displayName}
                            <span className="font-dy-mono text-[0.78125rem] font-normal text-dy-muted">
                              {m.id}
                            </span>
                            {m.enabled ? null : (
                              <Pill tone="amber" icon="pause">
                                {t.off}
                              </Pill>
                            )}
                          </span>
                        }
                        meta={
                          <>
                            <span className="flex flex-wrap gap-x-2">
                              {m.runtimes.map((r) => (
                                <RuntimeMark key={r} runtime={r} />
                              ))}
                            </span>
                            <span className="font-dy-mono [overflow-wrap:anywhere]">
                              {m.provider}/{m.model}
                            </span>
                            {price === null ? null : <span>{price}</span>}
                            <span>
                              {cred === null ? (
                                t.noCredential
                              ) : (
                                <>
                                  {t.credential} <span className="font-dy-mono">{cred}</span>
                                </>
                              )}
                            </span>
                            <span className="tabular-nums">
                              {t.usage({
                                machines: m.usedBy.workers.length,
                                policies: m.usedBy.policies.length,
                              })}
                            </span>
                          </>
                        }
                        actions={
                          canWrite ? (
                            <>
                              <DyButton
                                aria-label={t.editName({ name: m.displayName })}
                                onClick={() => {
                                  open(m);
                                }}
                              >
                                {t.edit}
                              </DyButton>
                              <ConfirmButton
                                label={t.delete}
                                question={t.deleteQuestion({ name: m.displayName })}
                                disabled={del.busy}
                                testId={`delete-model-${m.id}`}
                                onConfirm={() =>
                                  void del.run(() =>
                                    guarded(async () => {
                                      await deleteModel(m.id);
                                      await refresh();
                                    }, t.stepUpDelete),
                                  )
                                }
                              />
                            </>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </Rows>
              </>
            )}
          </Panel>
          <DyPager {...pagination} />
          <Defaults models={models} defaults={defaults} canWrite={canWrite} onChanged={setDefaults} />
          <RoutingRulesPanel project={null} canWrite={canWrite} />
        </>
      )}
      <DyDialog
        open={dialog !== null}
        onClose={close}
        size="lg"
        title={dialog?.target ? t.editName({ name: dialog.target.displayName }) : t.dialogAdd}
        description={t.dialogDescription}
      >
        {dialog !== null ? (
          <ModelFormView
            key={dialog.seq}
            initial={dialog.target}
            onCancel={close}
            onSaved={() => {
              close();
              void refresh();
            }}
          />
        ) : null}
      </DyDialog>
    </div>
  );
}
