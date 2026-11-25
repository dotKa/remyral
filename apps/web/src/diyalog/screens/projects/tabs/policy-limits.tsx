import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getPackageCacheSetting,
  type PackageCacheSetting,
  putPackageCacheSetting,
} from '../../../../api/packageCaches';
import {
  type AdviceMode,
  type AdviceSettings,
  type AreaRule,
  getAdviceSettings,
  JOB_AREAS,
  type JobArea,
  putAdviceSettings,
} from '../../../../api/runtimeAdvice';
import {
  type FallbackFacts,
  getProjectUsageLimitPolicy,
  type ProjectUsageLimitPolicy,
  putProjectUsageLimitPolicy,
  type UsageLimitMode,
  type UsageLimitPolicy,
  usageLimitPolicyProblem,
} from '../../../../api/usageLimits';
import { adviceSettingsProblem } from '../../../../screens/runtimeAdviceSettings';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { runtimeDisplayName } from '../../../RuntimeMark';
import { sameValue, useCardForm, useSectionSave } from '../../../formkit';
import { DyCheck, DyDetails, DyField, DyNotice, DySwitch, FormActions } from '../../forms';
import { DyButton, DySelect, Panel, Pill } from '../../parts';
import { LoadState, ProblemLine, SaveResult, useProblemText } from './policy-common';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import { DATE_TIME_NUMERIC } from '../../../common/time';
import { listModels, MODEL_RUNTIMES, type ModelRuntime, type ModelView } from '../../../../api/models';
import { DyModelPicker, useRuntimeModels } from '../../shared/ModelPicker';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Politika: usage limits (wait / fallback / fail, paid-fallback opt-in with the
 * per-job estimates), runtime advice (mode, exploration, allowed runtimes, path rules) and package caches. Same calls
 * and client checks as the classic sections (`usageLimitPolicyProblem`, `adviceSettingsProblem`), every save through
 * step-up; owners / admins edit, everyone else reads. p15-form-pattern: usage limits and runtime advice are sections
 * of the tab's form (saved by its bar); the package-cache switch applies at once (an instant setting).
 */

const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;

function useStepped(): (fn: () => Promise<void>, why: string) => Promise<void> {
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

// ------------------------------------------------------------------------------------------------ usage limits

const LIMIT_MODES: readonly UsageLimitMode[] = ['auto', 'wait', 'fallback', 'fail'];

/** What the policy does, in one sentence (the classic `describeUsageLimitPolicy`, in the user's language). */
export function describePolicy(p: UsageLimitPolicy, t: Messages['projects']['limits']['describe']): string {
  const chain = p.fallbacks.map(
    (f) => `${runtimeDisplayName(f.runtime)}${f.model === undefined ? '' : ` (${f.model})`}`,
  );
  switch (p.mode) {
    case 'fail':
      return t.fail;
    case 'wait':
      return t.wait;
    case 'fallback':
      return chain.length === 0 ? t.fallbackNone : t.fallback({ chain: chain.join(' → ') });
    case 'auto':
      return t.auto({ hours: p.maxWaitHours, chain: chain.length === 0 ? t.noFallback : chain.join(' → ') });
  }
}

function FallbackFactsList(props: { readonly facts: readonly FallbackFacts[] }): ReactNode {
  const t = useT().projects.limits;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-1.5 p-0 text-[0.875rem]"
      data-testid="usage-limit-fallback-facts"
    >
      {props.facts.map((f, i) => (
        <li
          key={`${f.runtime}-${f.profile ?? ''}-${String(i)}`}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
        >
          <span className="font-bold">
            {i + 1}. {runtimeDisplayName(f.runtime)}
            {f.profile === null ? '' : ` (${f.profile})`}
          </span>
          <span className="text-dy-muted">
            {f.paid === 'credential' ? t.paidKey : t.paidMaybe}
            {f.estimate === null
              ? ''
              : t.estimate({
                  cost: `$${f.estimate.avgCostUsdPerJob.toFixed(2)}`,
                  jobs: f.estimate.jobs,
                  all: f.estimate.basis !== 'project',
                })}
          </span>
          {f.blocked ? (
            <Pill tone="amber" icon="pause" className="whitespace-normal">
              <span data-testid="usage-limit-fallback-blocked">{t.skipped}</span>
            </Pill>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function UsageLimitPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const words = useT().projects;
  const t = words.limits;
  const problemText = useProblemText();
  const { project } = props;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<ProjectUsageLimitPolicy | null>(null);
  // p15-model-picker: the fallbacks' model lists (catalog + machines) and the model profiles.
  const catalog = useRuntimeModels(props.project);
  const [profiles, setProfiles] = useState<readonly ModelView[]>([]);
  useEffect(() => {
    let live = true;
    listModels().then(
      (m) => {
        if (live) setProfiles(m.items.filter((x) => x.enabled));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const [draft, setDraft] = useState<UsageLimitPolicy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const apply = useCallback((p: ProjectUsageLimitPolicy) => {
    setData(p);
    setDraft(p.own ?? p.effective);
  }, []);
  const refresh = useCallback(() => {
    void run(async () => {
      apply(await getProjectUsageLimitPolicy(project));
    });
  }, [run, project, apply]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (policy: UsageLimitPolicy | null): Promise<boolean> => {
    setDone(null);
    if (policy !== null) {
      const p = problemText(usageLimitPolicyProblem(policy));
      setProblem(p);
      if (p !== null) return false;
    }
    return sectionSave(
      saver,
      async () => {
        apply(await putProjectUsageLimitPolicy(project, policy));
        setDone(policy === null ? words.policy.followsDefault : t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const base = data === null ? null : (data.own ?? data.effective);
  const card = useCardForm({
    dirty: props.canEdit && draft !== null && base !== null && !sameValue(draft, base),
    busy: saver.busy,
    save: () => (draft === null ? Promise.resolve(false) : save(draft)),
    discard: () => {
      if (base !== null) setDraft(base);
      setProblem(null);
    },
  });

  const setFallback = (i: number, f: { runtime: string; model?: string } | null): void => {
    if (draft === null) return;
    const list = [...draft.fallbacks];
    if (f === null) list.splice(i, 1);
    else list[i] = f;
    setDraft({ ...draft, fallbacks: list });
  };
  const moveUp = (i: number): void => {
    if (draft === null) return;
    const list = [...draft.fallbacks];
    const a = list[i];
    const b = list[i - 1];
    if (a === undefined || b === undefined) return;
    list[i] = b;
    list[i - 1] = a;
    setDraft({ ...draft, fallbacks: list });
  };
  const noFallbacks = draft !== null && (draft.mode === 'fail' || draft.mode === 'wait');

  return (
    <Panel title={t.title} sub={t.sub} testId="usage-limit-panel">
      <section
        aria-label={t.region({ project })}
        data-testid="usage-limit-section"
        className="flex flex-col gap-3"
      >
        <LoadState loaded={data !== null} error={loader.error} what={t.what} onRetry={refresh} />
        {data === null || draft === null ? null : (
          <>
            <p className="m-0 text-[0.875rem]" data-testid="usage-limit-current">
              <Pill tone={data.source === 'default' ? 'neutral' : 'violet'} className="mr-2 align-[1px]">
                {data.source === 'default' ? words.policy.workspaceDefault : words.policy.thisProject}
              </Pill>
              {describePolicy(data.effective, t.describe)}
              {data.effective.allowPaidFallback ? t.paidAllowed : ''}
            </p>
            {data.fallbacks.length > 0 ? <FallbackFactsList facts={data.fallbacks} /> : null}
            {props.canEdit ? (
              <form
                aria-label={t.what}
                className="flex flex-col gap-3 rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5"
                data-testid="usage-limit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  card.submit();
                }}
              >
                <DySelect
                  label={t.whenLimit}
                  value={draft.mode}
                  options={LIMIT_MODES.map((m) => [m, t.modes[m]] as const)}
                  onChange={(v) => {
                    setDraft({ ...draft, mode: v as UsageLimitMode });
                  }}
                />
                {draft.mode === 'auto' ? (
                  <DyField
                    label={t.waitHours}
                    inputMode="decimal"
                    value={String(draft.maxWaitHours)}
                    wrapClassName="sm:w-64"
                    onChange={(v) => {
                      setDraft({ ...draft, maxWaitHours: Number(v) });
                    }}
                  />
                ) : null}
                <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={noFallbacks}>
                  <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.fallbacks}</legend>
                  <p className="m-0 text-[0.78125rem] text-dy-muted">
                    {t.fallbacksHint}
                    {noFallbacks ? t.noFallbacksMode : ''}
                  </p>
                  {draft.fallbacks.map((f, i) => (
                    <div
                      key={`${f.runtime}-${String(i)}`}
                      data-testid="usage-limit-fallback"
                      className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,14rem)_auto]"
                    >
                      <DySelect
                        label={t.fallbackRuntime({ n: i + 1 })}
                        value={f.runtime}
                        options={RUNTIMES.map((r) => [r, runtimeDisplayName(r)] as const)}
                        onChange={(v) => {
                          setFallback(i, { ...f, runtime: v });
                        }}
                      />
                      {/* p15-model-picker: the fallback's model from its runtime's list (profiles first). */}
                      <DyModelPicker
                        label={t.profile}
                        runtimes={
                          (MODEL_RUNTIMES as readonly string[]).includes(f.runtime)
                            ? [f.runtime as ModelRuntime]
                            : []
                        }
                        value={f.model ?? ''}
                        catalog={catalog}
                        profiles={profiles
                          .filter((m) => (m.runtimes as readonly string[]).includes(f.runtime))
                          .map((m) => ({
                            value: m.id,
                            label: m.displayName,
                            detail: `${m.provider}/${m.model}`,
                          }))}
                        testId="fallback-model-picker"
                        onChange={(v) => {
                          setFallback(
                            i,
                            v === '' ? { runtime: f.runtime } : { runtime: f.runtime, model: v },
                          );
                        }}
                      />
                      <span className="col-span-2 flex gap-1 sm:col-span-1">
                        <DyButton
                          variant="ghost"
                          disabled={i === 0}
                          aria-label={t.moveUp({ n: i + 1 })}
                          onClick={() => {
                            moveUp(i);
                          }}
                        >
                          {words.policy.up}
                        </DyButton>
                        <DyButton
                          variant="ghost"
                          aria-label={t.removeFallback({ n: i + 1 })}
                          onClick={() => {
                            setFallback(i, null);
                          }}
                        >
                          {words.policy.remove}
                        </DyButton>
                      </span>
                    </div>
                  ))}
                  {draft.fallbacks.length < 4 ? (
                    <div>
                      <DyButton
                        variant="ghost"
                        icon="plus"
                        onClick={() => {
                          setDraft({ ...draft, fallbacks: [...draft.fallbacks, { runtime: 'codex' }] });
                        }}
                      >
                        {t.addFallback}
                      </DyButton>
                    </div>
                  ) : null}
                </fieldset>
                <DyCheck
                  label={t.paid}
                  hint={t.paidHint}
                  checked={draft.allowPaidFallback}
                  onChange={(on) => {
                    setDraft({ ...draft, allowPaidFallback: on });
                  }}
                />
                {draft.allowPaidFallback ? <DyNotice tone="amber">{t.paidWarn}</DyNotice> : null}
                <FormActions>
                  {card.inScope ? null : (
                    <DyButton type="submit" variant="primary" busy={saver.busy}>
                      {t.save}
                    </DyButton>
                  )}
                  {data.source === 'project' ? (
                    <DyButton
                      variant="ghost"
                      busy={saver.busy}
                      onClick={() => {
                        void save(null);
                      }}
                    >
                      {words.policy.useWorkspaceDefault}
                    </DyButton>
                  ) : null}
                </FormActions>
              </form>
            ) : null}
          </>
        )}
        <ProblemLine problem={problem} />
        <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
      </section>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ runtime advice

const ADVICE_MODES: readonly AdviceMode[] = ['off', 'advice', 'auto'];

function rulesText(rules: readonly AreaRule[], area: JobArea): string {
  return (rules.find((r) => r.area === area)?.globs ?? []).join('\n');
}

export function RuntimeAdvicePanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().projects.advice;
  const problemText = useProblemText();
  const { project } = props;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [draft, setDraft] = useState<AdviceSettings | null>(null);
  // The loaded settings (edits are against them) and a key that resets the uncontrolled path-rule boxes on discard.
  const [base, setBase] = useState<AdviceSettings | null>(null);
  const [gen, setGen] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      const s = await getAdviceSettings(project);
      setDraft(s);
      setBase(s);
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (): Promise<boolean> => {
    if (draft === null) return false;
    setDone(null);
    const p = problemText(adviceSettingsProblem(draft));
    setProblem(p);
    if (p !== null) return false;
    return sectionSave(
      saver,
      async () => {
        const s = await putAdviceSettings(project, draft);
        setDraft(s);
        setBase(s);
        setDone(t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && draft !== null && base !== null && !sameValue(draft, base),
    busy: saver.busy,
    save,
    discard: () => {
      setDraft(base);
      setGen((n) => n + 1);
      setProblem(null);
    },
  });

  const setRules = (area: JobArea, text: string): void => {
    if (draft === null) return;
    const globs = text
      .split('\n')
      .map((g) => g.trim())
      .filter((g) => g !== '')
      .slice(0, 30);
    const others = draft.areaRules.filter((r) => r.area !== area);
    setDraft({ ...draft, areaRules: globs.length === 0 ? others : [...others, { area, globs }] });
  };
  const num = (k: 'explorationPct' | 'minSamples' | 'halfLifeDays' | 'rerunWindowDays', v: string): void => {
    if (draft === null) return;
    setDraft({ ...draft, [k]: Number(v) });
  };
  const ro = !props.canEdit;

  return (
    <Panel title={t.title} sub={t.sub} testId="runtime-advice-panel">
      <section
        aria-label={t.region({ project })}
        data-testid="runtime-advice-section"
        className="flex flex-col gap-3"
      >
        <LoadState loaded={draft !== null} error={loader.error} what={t.what} onRetry={refresh} />
        {draft === null ? null : (
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={ro}>
            <DySelect
              label={t.mode}
              value={draft.mode}
              options={ADVICE_MODES.map((m) => [m, t.modes[m]] as const)}
              onChange={(v) => {
                setDraft({ ...draft, mode: v as AdviceMode });
              }}
            />
            {draft.mode === 'auto' ? <DyNotice tone="teal">{t.autoNote}</DyNotice> : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <DyField
                label={t.exploration}
                inputMode="numeric"
                value={String(draft.explorationPct)}
                onChange={(v) => {
                  num('explorationPct', v);
                }}
              />
              <DyField
                label={t.minSamples}
                inputMode="numeric"
                value={String(draft.minSamples)}
                onChange={(v) => {
                  num('minSamples', v);
                }}
              />
              <DyField
                label={t.halfLife}
                inputMode="numeric"
                value={String(draft.halfLifeDays)}
                onChange={(v) => {
                  num('halfLifeDays', v);
                }}
              />
              <DyField
                label={t.rerunWindow}
                inputMode="numeric"
                value={String(draft.rerunWindowDays)}
                onChange={(v) => {
                  num('rerunWindowDays', v);
                }}
              />
            </div>
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.runtimes}</legend>
              <div className="flex flex-wrap gap-x-5">
                {RUNTIMES.map((r) => (
                  <DyCheck
                    key={r}
                    label={runtimeDisplayName(r)}
                    checked={draft.allowedRuntimes.includes(r)}
                    disabled={ro}
                    onChange={(on) => {
                      setDraft({
                        ...draft,
                        allowedRuntimes: on
                          ? [...draft.allowedRuntimes, r]
                          : draft.allowedRuntimes.filter((x) => x !== r),
                      });
                    }}
                  />
                ))}
              </div>
            </fieldset>
            <DyCheck
              label={t.allowPaid}
              checked={draft.allowPaid}
              disabled={ro}
              onChange={(on) => {
                setDraft({ ...draft, allowPaid: on });
              }}
            />
            <DyDetails key={gen} summary={t.pathRules}>
              <p className="m-0 mb-2 text-[0.78125rem] text-dy-muted">{t.pathRulesHint}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {JOB_AREAS.map((a) => (
                  <label key={a} className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
                    {t.areas[a]}
                    <textarea
                      aria-label={t.areaRules({ area: t.areas[a] })}
                      rows={3}
                      defaultValue={rulesText(draft.areaRules, a)}
                      onBlur={(e) => {
                        setRules(a, e.target.value);
                      }}
                      className="min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 py-2 font-dy-mono text-[0.8125rem] font-normal text-dy-ink"
                    />
                  </label>
                ))}
              </div>
            </DyDetails>
            <ProblemLine problem={problem} />
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
            {props.canEdit && !card.inScope ? (
              <FormActions>
                <DyButton
                  variant="primary"
                  busy={saver.busy}
                  onClick={card.submit}
                  data-testid="runtime-advice-save"
                >
                  {t.save}
                </DyButton>
              </FormActions>
            ) : null}
          </fieldset>
        )}
      </section>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ package caches

export function PackageCachesPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().projects.caches;
  const { project } = props;
  const stepped = useStepped();
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<PackageCacheSetting | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      setData(await getPackageCacheSetting(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = (enabled: boolean): void => {
    setDone(null);
    void saver.run(() =>
      stepped(async () => {
        setData(await putPackageCacheSetting(project, enabled));
        setDone(enabled ? t.savedOn : t.savedOff);
      }, t.stepUp({ project })),
    );
  };

  return (
    <Panel title={t.title} sub={t.sub} testId="package-caches-panel">
      <section
        aria-label={t.region({ project })}
        data-testid="package-caches-section"
        className="flex flex-col gap-3"
      >
        <LoadState loaded={data !== null} error={loader.error} what={t.what} onRetry={refresh} />
        {data === null ? null : props.canEdit ? (
          <DySwitch
            label={t.share}
            hint={
              data.updatedBy === null
                ? t.defaultOn
                : t.changedBy({
                    by: data.updatedBy,
                    at: data.updatedAt === null ? '' : fmt.dateWith(data.updatedAt, DATE_TIME_NUMERIC),
                  })
            }
            checked={data.enabled}
            busy={saver.busy}
            testId="package-caches-switch"
            onChange={(on) => {
              if (!saver.busy) save(on);
            }}
          />
        ) : (
          <p className="m-0 text-[0.875rem]" data-testid="package-caches-current">
            {data.enabled ? t.on : t.off}
          </p>
        )}
        <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
      </section>
    </Panel>
  );
}
