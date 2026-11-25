import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client';
import { getInstallers, type InstallerOverview } from '../../api/installers';
import {
  getSecurityPolicy,
  putSecurityPolicy,
  SECURITY_PRESETS,
  type SecurityPreset,
} from '../../api/security';
import {
  completeOnboarding,
  markStep,
  type Onboarding,
  ONBOARDING_STEPS,
  type OnboardingStep,
  setOrganisation,
} from '../../api/selfhost';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { useStepUp } from '../../stepup/StepUpProvider';
import { DyCopyButton } from '../common/actions';
import { DyNotice } from '../common/notices';
import { DyField } from '../forms';
import { DyIcon } from '../icons';
import { DyButton, DyButtonLink, ErrorLine, Panel, Pill } from '../screens/parts';
import { ScreenFrame } from '../screens/ScreenFrame';
import { BrandLogo } from '../Brand';
import { MemoryImportPanel } from '../memory-import/MemoryImportPanel';
import { DomainStep } from './DomainStep';
import { useIsOwner, useOnboarding } from './useOnboarding';

/**
 * p16-selfhost-onboarding §5: `/onboarding` — the owners' first-run wizard (docs/design/p16-selfhost-onboarding.md).
 * A step list (with done / skipped / to do and "detected" facts the master derives) and one step at a time; every
 * step is skippable, the progress lives on the master (resumable on any device), `?step=<id>` opens a step directly.
 * Steps that change something sensitive use their own screens and routes (security preset with an authenticator code,
 * connections, machines); this screen links to them and records the owner's marks.
 */

const isStep = (v: string | null): v is OnboardingStep =>
  v !== null && (ONBOARDING_STEPS as readonly string[]).includes(v);

export function WizardScreen(): ReactNode {
  const t = useT().selfhost.wizard;
  const owner = useIsOwner();
  const { data, set, reload } = useOnboarding();
  const [params, setParams] = useSearchParams();
  const asked = params.get('step');
  const current: OnboardingStep | null = isStep(asked) ? asked : (data?.current ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (step: OnboardingStep): void => {
    setParams({ step }, { replace: false });
  };
  const act = async (fn: () => Promise<Onboarding>, then?: (o: Onboarding) => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const o = await fn();
      set(o);
      then?.(o);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err)));
    } finally {
      setBusy(false);
    }
  };
  const nextOf = (step: OnboardingStep): OnboardingStep => {
    const i = ONBOARDING_STEPS.indexOf(step);
    return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)] ?? 'done';
  };
  const mark = (step: OnboardingStep, state: 'done' | 'skipped' | 'todo', advance = true): void => {
    void act(
      () => markStep(step, state),
      () => {
        if (advance) go(nextOf(step));
      },
    );
  };

  if (!owner) return null;
  const view = data?.steps.find((s) => s.id === current) ?? null;
  return (
    <ScreenFrame
      title={t.title}
      purpose={t.purpose}
      width="wide"
      testId="dy-onboarding"
      facts={data === null ? null : <Pill tone="teal">{t.progress(data.progress)}</Pill>}
    >
      <ErrorLine error={error} what={t.what} />
      {data === null || current === null ? (
        <p className="text-dy-muted">{t.loading}</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
          <nav aria-label={t.stepsLabel}>
            {/* p17-remyral-brand: the Remyral lock-up over the steps (the product the wizard sets up). */}
            <BrandLogo alt="" height={28} className="mb-3 px-3" />
            <ol className="m-0 grid list-none gap-1 p-0" data-testid="dy-onboarding-steps">
              {data.steps.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === current ? 'step' : undefined}
                    data-testid={`dy-onboarding-step-${s.id}`}
                    data-state={s.state}
                    onClick={() => {
                      go(s.id);
                    }}
                    className={cx(
                      'dy-press flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[0.875rem]',
                      s.id === current ? 'bg-dy-card font-bold shadow-dy' : 'text-dy-muted',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        'grid size-6 shrink-0 place-items-center rounded-full text-[0.75rem] font-bold',
                        s.id === 'done'
                          ? 'bg-dy-sunk text-dy-muted'
                          : s.state === 'done'
                            ? 'bg-dy-teal text-dy-on-fill'
                            : s.state === 'skipped'
                              ? 'bg-dy-sunk text-dy-muted'
                              : 'border border-dy-line-2',
                      )}
                    >
                      {s.id === 'done' ? (
                        <DyIcon name="flag" className="size-3.5" />
                      ) : s.state === 'done' ? (
                        <DyIcon name="check" className="size-3.5" />
                      ) : (
                        String(i + 1)
                      )}
                    </span>
                    <span className="min-w-0 flex-1">{t.steps[s.id].title}</span>
                    <span className="sr-only">{t.state[s.state]}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <Panel
            title={t.steps[current].title}
            aside={
              view === null || current === 'done' ? null : (
                <Pill tone={view.state === 'done' ? 'teal' : view.state === 'skipped' ? 'neutral' : 'amber'}>
                  {view.detected ? t.state.detected : t.state[view.state]}
                </Pill>
              )
            }
            testId={`dy-onboarding-body-${current}`}
          >
            <div className="grid gap-4 px-4 pb-4">
              <StepBody
                step={current}
                data={data}
                busy={busy}
                act={act}
                reload={reload}
                onNext={() => {
                  go(nextOf(current));
                }}
              />
              {current === 'done' ? null : (
                <div className="flex flex-wrap items-center gap-2 border-t border-dy-line pt-3">
                  {current === ONBOARDING_STEPS[0] ? null : (
                    <DyButton
                      variant="ghost"
                      onClick={() => {
                        go(ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(current) - 1] ?? 'account');
                      }}
                    >
                      {t.back}
                    </DyButton>
                  )}
                  <span className="flex-1" />
                  {view?.state === 'todo' ? (
                    <>
                      <DyButton
                        busy={busy}
                        onClick={() => {
                          mark(current, 'skipped');
                        }}
                        data-testid="dy-onboarding-skip"
                      >
                        {t.skip}
                      </DyButton>
                      <DyButton
                        variant="primary"
                        busy={busy}
                        data-testid="dy-onboarding-done"
                        onClick={() => {
                          mark(current, 'done');
                        }}
                      >
                        {t.markDone}
                      </DyButton>
                    </>
                  ) : (
                    <>
                      {view?.detected === true ? null : (
                        <DyButton
                          variant="ghost"
                          busy={busy}
                          onClick={() => {
                            mark(current, 'todo', false);
                          }}
                        >
                          {t.undo}
                        </DyButton>
                      )}
                      <DyButton
                        variant="primary"
                        data-testid="dy-onboarding-next"
                        onClick={() => {
                          go(nextOf(current));
                        }}
                      >
                        {t.next}
                      </DyButton>
                    </>
                  )}
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}
    </ScreenFrame>
  );
}

type Act = (fn: () => Promise<Onboarding>, then?: (o: Onboarding) => void) => Promise<void>;

function StepBody(props: {
  readonly step: OnboardingStep;
  readonly data: Onboarding;
  readonly busy: boolean;
  readonly act: Act;
  readonly reload: () => void;
  readonly onNext: () => void;
}): ReactNode {
  const t = useT().selfhost.wizard.steps;
  const body = (text: string): ReactNode => <p className="m-0 text-[0.9375rem] text-dy-muted">{text}</p>;
  switch (props.step) {
    case 'account':
      return (
        <>
          {body(t.account.body)}
          <div>
            <DyButtonLink to="/settings/profile">{t.account.link}</DyButtonLink>
          </div>
        </>
      );
    case 'about_you':
      return (
        <>
          {body(t.about_you.body)}
          <MemoryImportPanel compact onChanged={props.reload} />
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.about_you.later}</p>
        </>
      );
    case 'organisation':
      return <OrganisationStep data={props.data} busy={props.busy} act={props.act} onNext={props.onNext} />;
    case 'domain':
      return <DomainStep />;
    case 'security':
      return <SecurityStep act={props.act} />;
    case 'machine':
      return <MachineStep detected={props.data.steps.some((s) => s.id === 'machine' && s.detected)} />;
    case 'git':
      return (
        <>
          {body(t.git.body)}
          <div className="flex flex-wrap gap-2">
            <DyButtonLink to="/settings/integrations?tab=github">{t.git.github}</DyButtonLink>
            <DyButtonLink to="/settings/integrations?tab=git-hosts">{t.git.gitlab}</DyButtonLink>
            <DyButtonLink to="/settings/integrations?tab=git-hosts">{t.git.bitbucket}</DyButtonLink>
          </div>
        </>
      );
    case 'integrations':
      return (
        <>
          {body(t.integrations.body)}
          <div className="flex flex-wrap gap-2">
            <DyButtonLink to="/settings/integrations?tab=ops">{t.integrations.coolify}</DyButtonLink>
            <DyButtonLink to="/settings/integrations?tab=ops">{t.integrations.cloudflare}</DyButtonLink>
            <DyButtonLink to="/settings/notifications">{t.integrations.smtp}</DyButtonLink>
          </div>
        </>
      );
    case 'project':
      return (
        <>
          {body(t.project.body)}
          <div>
            <DyButtonLink to="/projects" variant="primary">
              {t.project.open}
            </DyButtonLink>
          </div>
        </>
      );
    case 'sample_job':
      return <SampleJobStep detected={props.data.steps.some((s) => s.id === 'sample_job' && s.detected)} />;
    case 'done':
      return <DoneStep busy={props.busy} act={props.act} />;
  }
}

function OrganisationStep(props: {
  readonly data: Onboarding;
  readonly busy: boolean;
  readonly act: Act;
  readonly onNext: () => void;
}): ReactNode {
  const t = useT().selfhost.wizard.steps.organisation;
  const [name, setName] = useState(props.data.organisationName ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void props.act(
          () => setOrganisation(name),
          () => {
            setSaved(true);
            props.onNext();
          },
        );
      }}
    >
      <p className="m-0 text-[0.9375rem] text-dy-muted">{t.body}</p>
      <DyField
        id="onboarding-organisation"
        label={t.label}
        placeholder={t.placeholder}
        maxLength={80}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSaved(false);
        }}
      />
      <div className="flex items-center gap-3">
        <DyButton type="submit" variant="primary" busy={props.busy} disabled={name.trim() === ''}>
          {t.save}
        </DyButton>
        {saved ? <span className="text-[0.875rem] text-dy-muted">{t.saved}</span> : null}
      </div>
    </form>
  );
}

function SecurityStep(props: { readonly act: Act }): ReactNode {
  const all = useT();
  const t = all.selfhost.wizard.steps.security;
  const names = all.security.presets;
  const stepUp = useStepUp();
  const [current, setCurrent] = useState<SecurityPreset | null>(null);
  const [applied, setApplied] = useState<SecurityPreset | null>(null);
  useEffect(() => {
    getSecurityPolicy().then(
      (p) => {
        setCurrent(p.effective.preset);
      },
      () => undefined,
    );
  }, []);
  return (
    <>
      <p className="m-0 text-[0.9375rem] text-dy-muted">{t.body}</p>
      <div className="grid gap-2 sm:grid-cols-3" data-testid="dy-onboarding-presets">
        {SECURITY_PRESETS.map((p) => (
          <div
            key={p}
            data-testid={`dy-onboarding-preset-${p}`}
            className={cx(
              'flex flex-col gap-2 rounded-[12px] border p-3',
              current === p ? 'border-dy-teal' : 'border-dy-line',
            )}
          >
            <span className="font-bold">{names[p].name}</span>
            <p className="m-0 flex-1 text-[0.8125rem] text-dy-muted">{names[p].description}</p>
            {current === p ? (
              <Pill tone="teal">{t.current}</Pill>
            ) : (
              <DyButton
                onClick={() => {
                  void props.act(async () => {
                    const view = await stepUp.run(() =>
                      putSecurityPolicy({ preset: p, resetOverrides: true }),
                    );
                    setCurrent(view.effective.preset);
                    setApplied(p);
                    return markStep('security', 'done');
                  });
                }}
              >
                {t.apply}
              </DyButton>
            )}
          </div>
        ))}
      </div>
      {applied === null ? null : (
        <DyNotice tone="green" live>
          {t.applied({ name: names[applied].name })}
        </DyNotice>
      )}
      <div>
        <Link to="/settings/security" className="text-[0.875rem] font-bold text-dy-teal-ink">
          {t.more}
        </Link>
      </div>
    </>
  );
}

function MachineStep(props: { readonly detected: boolean }): ReactNode {
  const t = useT().selfhost.wizard.steps.machine;
  const sayError = useErrorText();
  const [overview, setOverview] = useState<InstallerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getInstallers().then(setOverview, (err: unknown) => {
      setError(err instanceof ApiError ? sayError(err) : String(err));
    });
  }, [sayError]);
  const kits = overview?.current?.kits.filter((k) => k.commands !== null) ?? [];
  return (
    <>
      <p className="m-0 text-[0.9375rem] text-dy-muted">{t.body}</p>
      {error === null ? null : <DyNotice tone="red">{error}</DyNotice>}
      {overview !== null && kits.length === 0 ? <DyNotice tone="amber">{t.noRelease}</DyNotice> : null}
      <div className="grid gap-3" data-testid="dy-onboarding-install">
        {kits.map((k) =>
          k.commands === null ? null : (
            <div key={k.os} className="grid gap-1.5 rounded-[12px] border border-dy-line p-3">
              <span className="font-bold">{t.os[k.os]}</span>
              {[
                [t.download, k.commands.download],
                [t.run, k.commands.run],
              ].map(([label, cmd]) => (
                <div key={label} className="grid gap-1">
                  <div className="flex items-center justify-between gap-2 text-[0.8125rem] text-dy-muted">
                    {label}
                    <DyCopyButton text={cmd ?? ''} about={`${t.os[k.os]} · ${label ?? ''}`} />
                  </div>
                  <code className="block rounded-[8px] bg-dy-sunk px-2.5 py-2 font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]">
                    {cmd}
                  </code>
                </div>
              ))}
            </div>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <DyButtonLink to="/machines/add">{t.open}</DyButtonLink>
        {props.detected ? null : <span className="text-[0.875rem] text-dy-muted">{t.waiting}</span>}
      </div>
    </>
  );
}

function SampleJobStep(props: { readonly detected: boolean }): ReactNode {
  const t = useT().selfhost.wizard.steps.sample_job;
  const navigate = useNavigate();
  return (
    <>
      <p className="m-0 text-[0.9375rem] text-dy-muted">{t.body}</p>
      <blockquote className="m-0 rounded-[10px] border-l-4 border-dy-teal bg-dy-sunk px-3 py-2 text-[0.875rem]">
        {t.prompt}
      </blockquote>
      <div className="flex flex-wrap items-center gap-3">
        <DyButton
          variant="primary"
          data-testid="dy-onboarding-sample"
          onClick={() => {
            // The composer prefill (same as "Run again"): the owner picks the project and machine, then submits.
            void navigate('/jobs/new', { state: { prefill: { project: '', spec: { prompt: t.prompt } } } });
          }}
        >
          {t.start}
        </DyButton>
        <DyButtonLink to="/jobs">{t.jobs}</DyButtonLink>
        {props.detected ? null : <span className="text-[0.875rem] text-dy-muted">{t.waiting}</span>}
      </div>
    </>
  );
}

function DoneStep(props: { readonly busy: boolean; readonly act: Act }): ReactNode {
  const t = useT().selfhost.wizard;
  const navigate = useNavigate();
  return (
    <>
      <p className="m-0 text-[0.9375rem] text-dy-muted">{t.steps.done.body}</p>
      <div className="flex flex-wrap gap-2">
        <DyButtonLink to="/chat">{t.steps.done.chat}</DyButtonLink>
        <DyButtonLink to="/jobs">{t.steps.done.jobs}</DyButtonLink>
        <DyButtonLink to="/machines">{t.steps.done.machines}</DyButtonLink>
        <DyButtonLink to="/settings">{t.steps.done.settings}</DyButtonLink>
      </div>
      <div>
        <DyButton
          variant="primary"
          busy={props.busy}
          data-testid="dy-onboarding-finish"
          onClick={() => {
            void props.act(completeOnboarding, () => {
              void navigate('/', { replace: true });
            });
          }}
        >
          {t.steps.done.finish}
        </DyButton>
      </div>
    </>
  );
}
