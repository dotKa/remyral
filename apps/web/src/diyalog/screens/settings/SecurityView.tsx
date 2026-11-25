import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type ApiTokenSettings,
  type FleetPolicySettings,
  type InputPolicySettings,
  applyAutonomyToProjects,
  type AutonomySettings,
  getSecurityPolicy,
  putSecurityPolicy,
  SECURITY_PRESETS,
  type SecurityPolicyPatch,
  type SecurityPolicyView,
  type SecurityPreset,
  type StepUpSettings,
} from '../../../api/security';
import { cx, toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { fill, type Messages } from '@remyral/i18n';
import {
  DyFormScope,
  DyInstantToggle,
  DyTabs,
  UnsavedGuardProvider,
  useDyForm,
  useFormSection,
} from '../../formkit';
import { ConfirmButton, DyApiError, DyNotice, DySwitch } from '../forms';
import { DySelect, Panel, Pill, SkeletonRows } from '../parts';
import { useDoneToast } from '../../toast/useDoneToast';
import { InstallScriptsPanel } from './security-install-scripts';

/**
 * p15-autonomy (ADR-0056, docs/design/p15-autonomy.md §6): Ayarlar → Güvenlik — one policy document. A preset, the
 * authenticator window ("remember this device", always-fresh), per-event "TOTP iste" switches grouped by category,
 * the agent autonomy defaults and the risk-based master approval rules. Saving sends only what changed; the master
 * asks for a code only while it keeps "Güvenlik politikasını değiştirme" protected (the step-up provider then opens
 * its dialog and retries once).
 */

const WINDOW_CHOICES: readonly number[] = [5, 15, 30, 60, 240, 720, 1440, 4320, 10080, 43200];
const FRESH_CHOICES: readonly number[] = [5, 10, 15, 30, 60];
const MAX_JOB_CHOICES: readonly number[] = [60, 240, 720, 1440, 4320, 10080];
const RETRY_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 5];
const TOKEN_DAYS: readonly number[] = [30, 60, 90, 180, 365];
const CATEGORY_ORDER = [
  'security',
  'account',
  'users',
  'secrets',
  'machines',
  'deploy',
  'extensions',
  'workflows',
  'integrations',
  'policies',
  'jobs',
  'data',
] as const;

interface FormState {
  readonly stepUp: StepUpSettings;
  readonly events: Readonly<Record<string, boolean>>;
  readonly autonomy: AutonomySettings;
}

function formOf(v: SecurityPolicyView): FormState {
  return { stepUp: v.effective.stepUp, events: v.effective.events, autonomy: v.effective.autonomy };
}

/** The patch between the loaded policy and the form (only what changed). */
export function patchOf(v: SecurityPolicyView, f: FormState): SecurityPolicyPatch {
  const e = v.effective;
  const stepUp: Partial<StepUpSettings> = {};
  for (const k of ['windowMinutes', 'rememberDevice', 'alwaysFreshMinutes'] as const) {
    if (f.stepUp[k] !== e.stepUp[k]) (stepUp as Record<string, unknown>)[k] = f.stepUp[k];
  }
  const events: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(f.events)) if (e.events[id] !== on) events[id] = on;
  const autonomy: Record<string, unknown> = {};
  for (const k of [
    'newProjectsHostExecution',
    'newProjectsAutoApprove',
    'jobApproval',
    'chatDirect',
    'maxJobMinutes',
    'autoMode',
    'autoRetryMax',
    'chatDestructive',
    'chatMachineAdmin',
    'goalGrants',
    'autoExtendTime',
  ] as const) {
    if (f.autonomy[k] !== e.autonomy[k]) autonomy[k] = f.autonomy[k];
  }
  const auto: Record<string, boolean> = {};
  for (const [a, on] of Object.entries(f.autonomy.autoApprove))
    if (e.autonomy.autoApprove[a] !== on) auto[a] = on;
  if (Object.keys(auto).length > 0) autonomy.autoApprove = auto;
  return {
    ...(Object.keys(stepUp).length === 0 ? {} : { stepUp }),
    ...(Object.keys(events).length === 0 ? {} : { events }),
    ...(Object.keys(autonomy).length === 0 ? {} : { autonomy: autonomy }),
  };
}

type SecurityText = Messages['security'];

/** The policy and how to send a patch (the master asks for a code while the policy itself is protected). */
interface PolicyApi {
  readonly view: SecurityPolicyView;
  readonly send: (p: SecurityPolicyPatch) => Promise<SecurityPolicyView>;
}

function minutesTextOf(t: SecurityText): (m: number) => string {
  return (m) =>
    m % 1440 === 0
      ? t.stepUp.days({ n: m / 1440 })
      : m % 60 === 0
        ? t.stepUp.hours({ n: m / 60 })
        : t.stepUp.minutes({ n: m });
}

/** Otomatik mod: the switch applies at once; the retry count is a small form. */
function AutoModeTab(props: { readonly policy: PolicyApi }): ReactNode {
  const am = useT().autoMode.settings;
  const { view, send } = props.policy;
  const e = view.effective;
  const initial = useMemo(() => ({ autoRetryMax: e.autonomy.autoRetryMax }), [e.autonomy.autoRetryMax]);
  const form = useDyForm<{ autoRetryMax: number }>({
    initial,
    save: async (v) => {
      const next = await send({ autonomy: { autoRetryMax: v.autoRetryMax } });
      return { autoRetryMax: next.effective.autonomy.autoRetryMax };
    },
  });
  useFormSection(form);
  return (
    <Panel title={am.title} sub={am.hint} testId="security-auto-mode">
      <div className="grid gap-3 px-4 pb-4">
        <DyInstantToggle
          testId="auto-mode"
          label={<span className="font-bold">{am.switchLabel}</span>}
          hint={e.autonomy.autoMode ? am.on : am.off}
          checked={e.autonomy.autoMode}
          onCommit={async (v) => {
            await send({ autonomy: { autoMode: v } });
          }}
        />
        <DySelect
          label={am.retries}
          value={String(form.value?.autoRetryMax ?? e.autonomy.autoRetryMax)}
          options={RETRY_CHOICES.map(
            (n) => [String(n), n === 0 ? am.retriesOff : am.retriesN({ n })] as const,
          )}
          onChange={(v) => {
            form.set({ autoRetryMax: Number(v) });
          }}
        />
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

/** Hazır ayarlar: applying a preset is an action (a confirm), not a form. */
function PresetsTab(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().security;
  const { view, send } = props.policy;
  const e = view.effective;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice, { testId: 'security-saved' });
  const presetName = (p: SecurityPreset): string => t.presets[p].name;
  const apply = async (p: SecurityPreset): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await send({ preset: p, resetOverrides: true });
      setNotice(
        (next.changed?.length ?? 0) === 0
          ? t.page.nothing
          : t.page.saved({ count: next.changed?.length ?? 0 }),
      );
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t.presets.title} testId="security-presets">
      <div className="grid gap-3 px-4 pb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {SECURITY_PRESETS.map((p) => {
            const current = e.preset === p;
            return (
              <div
                key={p}
                data-testid={`preset-${p}`}
                className={cx(
                  'flex min-w-0 flex-col gap-2 rounded-[12px] border p-3',
                  current ? 'border-dy-teal bg-dy-sunk' : 'border-dy-line',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-bold">{presetName(p)}</span>
                  {current && e.customized ? <Pill tone="amber">{t.presets.customized}</Pill> : null}
                </div>
                <p className="m-0 flex-1 text-[0.8125rem] text-dy-muted">{t.presets[p].description}</p>
                {current && !e.customized ? null : (
                  <ConfirmButton
                    label={t.presets.apply}
                    question={t.presets.confirmApply({ name: presetName(p) })}
                    busy={busy}
                    testId={`apply-preset-${p}`}
                    onConfirm={() => void apply(p)}
                  />
                )}
              </div>
            );
          })}
        </div>
        <DyApiError error={error} />
      </div>
    </Panel>
  );
}

function StepUpTab(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().security;
  const { view, send } = props.policy;
  const minutesText = minutesTextOf(t);
  const form = useDyForm<StepUpSettings>({
    initial: view.effective.stepUp,
    save: async (v) => {
      const next = await send(patchOf(view, { ...formOf(view), stepUp: v }));
      return next.effective.stepUp;
    },
  });
  useFormSection(form);
  const f = form.value ?? view.effective.stepUp;
  const w = f.windowMinutes;
  const windowOptions: (readonly [string, string])[] = [
    ['server', t.stepUp.serverDefaultPlain],
    ...WINDOW_CHOICES.map((m) => [String(m), minutesText(m)] as const),
  ];
  if (w !== null && !WINDOW_CHOICES.includes(w)) windowOptions.push([String(w), minutesText(w)]);
  return (
    <Panel title={t.stepUp.title} sub={t.stepUp.hint} testId="security-stepup">
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-3">
        <DySelect
          label={t.stepUp.window}
          value={w === null ? 'server' : String(w)}
          options={windowOptions}
          onChange={(v) => {
            form.set({ windowMinutes: v === 'server' ? null : Number(v) });
          }}
        />
        <DySelect
          label={t.stepUp.rememberDevice}
          value={f.rememberDevice === null ? 'server' : f.rememberDevice ? 'on' : 'off'}
          options={[
            ['server', t.stepUp.rememberServer],
            ['on', t.stepUp.rememberOn],
            ['off', t.stepUp.rememberOff],
          ]}
          onChange={(v) => {
            form.set({ rememberDevice: v === 'server' ? null : v === 'on' });
          }}
        />
        <DySelect
          label={t.stepUp.alwaysFresh}
          value={f.alwaysFreshMinutes === null ? 'off' : String(f.alwaysFreshMinutes)}
          options={[
            ['off', t.stepUp.alwaysFreshOff],
            ...FRESH_CHOICES.map((m) => [String(m), t.stepUp.minutes({ n: m })] as const),
          ]}
          onChange={(v) => {
            form.set({ alwaysFreshMinutes: v === 'off' ? null : Number(v) });
          }}
        />
        <p className="m-0 text-[0.78125rem] text-dy-muted sm:col-span-3">
          {t.stepUp.rememberDeviceHint} {t.stepUp.alwaysFreshHint}
        </p>
        <div className="sm:col-span-3">
          <DyApiError error={form.error} retryLeft={form.retryLeft} />
        </div>
      </div>
    </Panel>
  );
}

function EventsTab(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().security;
  const { view, send } = props.policy;
  const form = useDyForm<Readonly<Record<string, boolean>>>({
    initial: view.effective.events,
    save: async (v) => {
      const next = await send(patchOf(view, { ...formOf(view), events: v }));
      return next.effective.events;
    },
  });
  useFormSection(form);
  const events = form.value ?? view.effective.events;
  const byCategory = CATEGORY_ORDER.map((c) => ({
    category: c,
    events: view.events.filter((x) => x.category === c),
  })).filter((g) => g.events.length > 0);
  const coreOff = view.events.some((x) => x.core && events[x.id] === false);
  return (
    <Panel title={t.events.title} sub={t.events.hint} testId="security-events">
      <div className="grid gap-5 px-4 pb-4">
        {byCategory.map((g) => (
          <fieldset
            key={g.category}
            className="m-0 grid gap-3 border-0 p-0"
            data-testid={`events-${g.category}`}
          >
            <legend className="mb-1 p-0 text-[0.8125rem] font-bold text-dy-faint">
              {t.events.categories[g.category]}
            </legend>
            {g.events.map((x) => (
              <DySwitch
                key={x.id}
                testId={`event-${x.id}`}
                label={
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {(t.events.labels as Readonly<Record<string, string>>)[x.id] ?? x.id}
                    {x.core ? <Pill tone="violet">{t.events.core}</Pill> : null}
                  </span>
                }
                hint={t.events.ask}
                checked={events[x.id] === true}
                onChange={(v) => {
                  form.set((cur) => ({ ...cur, [x.id]: v }));
                }}
              />
            ))}
          </fieldset>
        ))}
        {coreOff ? (
          <DyNotice tone="amber" testId="core-off">
            {t.events.coreOffWarning}
          </DyNotice>
        ) : null}
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

function AutonomyTab(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().security;
  const tAdmin = useT().assistantAdmin.settings;
  const minutesText = minutesTextOf(t);
  const { view, send } = props.policy;
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice, { testId: 'security-saved' });
  const stepUp = useStepUp();
  const form = useDyForm<AutonomySettings>({
    initial: view.effective.autonomy,
    save: async (v) => {
      const next = await send(patchOf(view, { ...formOf(view), autonomy: v }));
      return next.effective.autonomy;
    },
  });
  useFormSection(form);
  const a = form.value ?? view.effective.autonomy;
  const set = (patch: Partial<AutonomySettings>): void => {
    setNotice(null);
    form.set(patch);
  };

  async function applyExisting(): Promise<void> {
    setApplying(true);
    setApplyError(null);
    setNotice(null);
    try {
      const out = await stepUp.run(() => applyAutonomyToProjects());
      setNotice(t.autonomy.applied({ count: out.count }));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setApplyError(toApiError(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Panel title={t.autonomy.title} sub={t.autonomy.hint} testId="security-autonomy">
      <div className="grid gap-4 px-4 pb-4">
        <DySwitch
          testId="autonomy-host"
          label={t.autonomy.hostExecution}
          checked={a.newProjectsHostExecution}
          onChange={(v) => {
            set({ newProjectsHostExecution: v });
          }}
        />
        <DySwitch
          testId="autonomy-auto"
          label={t.autonomy.autoApprove}
          checked={a.newProjectsAutoApprove}
          onChange={(v) => {
            set({ newProjectsAutoApprove: v });
          }}
        />
        <DySelect
          label={t.autonomy.jobApproval}
          value={a.jobApproval}
          options={[
            ['allow-all', t.autonomy.jobApprovalAllowAll],
            ['ask-sensitive', t.autonomy.jobApprovalAskSensitive],
          ]}
          onChange={(v) => {
            set({ jobApproval: v === 'allow-all' ? 'allow-all' : 'ask-sensitive' });
          }}
        />
        <DySwitch
          testId="autonomy-chat"
          label={t.autonomy.chatDirect}
          hint={t.autonomy.chatDirectHint}
          checked={a.chatDirect}
          onChange={(v) => {
            set({ chatDirect: v });
          }}
        />
        <DySwitch
          testId="autonomy-chat-destructive"
          label={tAdmin.chatDestructive}
          hint={tAdmin.chatDestructiveHint}
          checked={a.chatDestructive}
          onChange={(v) => {
            set({ chatDestructive: v });
          }}
        />
        <DySwitch
          testId="autonomy-chat-machine-admin"
          label={tAdmin.chatMachineAdmin}
          hint={tAdmin.chatMachineAdminHint}
          checked={a.chatMachineAdmin}
          onChange={(v) => {
            set({ chatMachineAdmin: v });
          }}
        />
        <DySwitch
          testId="autonomy-goal-grants"
          label={tAdmin.goalGrants}
          hint={tAdmin.goalGrantsHint}
          checked={a.goalGrants}
          onChange={(v) => {
            set({ goalGrants: v });
          }}
        />
        <DySwitch
          testId="autonomy-auto-extend-time"
          label={tAdmin.autoExtendTime}
          hint={tAdmin.autoExtendTimeHint}
          checked={a.autoExtendTime}
          onChange={(v) => {
            set({ autoExtendTime: v });
          }}
        />
        <DySelect
          label={t.autonomy.maxJobMinutes}
          value={String(a.maxJobMinutes)}
          options={[
            ...MAX_JOB_CHOICES.map((m) => [String(m), minutesText(m)] as const),
            ...(MAX_JOB_CHOICES.includes(a.maxJobMinutes)
              ? []
              : [[String(a.maxJobMinutes), minutesText(a.maxJobMinutes)] as const]),
          ]}
          onChange={(v) => {
            set({ maxJobMinutes: Number(v) });
          }}
        />
        <p className="m-0 -mt-2 text-[0.78125rem] text-dy-muted">{t.autonomy.maxJobMinutesHint}</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* An action on the saved defaults: not while this tab holds unsaved edits. */}
          <ConfirmButton
            label={t.autonomy.applyExisting}
            question={t.autonomy.applyConfirm}
            busy={applying}
            disabled={form.dirty}
            testId="apply-autonomy"
            onConfirm={() => void applyExisting()}
          />
          <span className="text-[0.78125rem] text-dy-muted">{t.autonomy.applyExistingHint}</span>
        </div>
        <fieldset className="m-0 grid gap-3 border-0 p-0" data-testid="autonomy-rules">
          <legend className="mb-1 p-0 text-[0.8125rem] font-bold text-dy-faint">
            {t.autonomy.rulesTitle}
          </legend>
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.autonomy.rulesHint}</p>
          {Object.keys(a.autoApprove).map((k) => (
            <DySwitch
              key={k}
              testId={`rule-${k}`}
              label={(t.autonomy.actions as Readonly<Record<string, string>>)[k] ?? k}
              hint={t.autonomy.passes}
              checked={a.autoApprove[k] === true}
              onChange={(v) => {
                set({ autoApprove: { ...a.autoApprove, [k]: v } });
              }}
            />
          ))}
        </fieldset>
        <DyApiError error={form.error ?? applyError} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

/** p16-api-tokens (ADR-0058): personal tokens allowed, the longest lifetime, event grants (one form). */
function TokensTab(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().security.apiTokens;
  const { view, send } = props.policy;
  const form = useDyForm<ApiTokenSettings>({
    initial: view.effective.apiTokens,
    save: async (v) => {
      const e = view.effective.apiTokens;
      const patch: Partial<ApiTokenSettings> = {
        ...(v.personal === e.personal ? {} : { personal: v.personal }),
        ...(v.maxDays === e.maxDays ? {} : { maxDays: v.maxDays }),
        ...(v.eventGrants === e.eventGrants ? {} : { eventGrants: v.eventGrants }),
      };
      const next = await send({ apiTokens: patch });
      return next.effective.apiTokens;
    },
  });
  useFormSection(form);
  const a = form.value ?? view.effective.apiTokens;
  const days = TOKEN_DAYS.includes(a.maxDays) ? TOKEN_DAYS : [...TOKEN_DAYS, a.maxDays].sort((x, y) => x - y);
  return (
    <Panel title={t.title} sub={t.hint} testId="security-api-tokens">
      <div className="grid gap-4 px-4 pb-4">
        <DySwitch
          testId="tokens-personal"
          label={t.personal}
          hint={t.personalHint}
          checked={a.personal}
          onChange={(v) => {
            form.set({ personal: v });
          }}
        />
        <DySelect
          label={t.maxDays}
          value={String(a.maxDays)}
          options={days.map((d) => [String(d), fill(t.days, { n: d })] as const)}
          onChange={(v) => {
            form.set({ maxDays: Number(v) });
          }}
        />
        <p className="m-0 -mt-2 text-[0.78125rem] text-dy-muted">{t.maxDaysHint}</p>
        <DySwitch
          testId="tokens-grants"
          label={t.eventGrants}
          hint={t.eventGrantsHint}
          checked={a.eventGrants}
          onChange={(v) => {
            form.set({ eventGrants: v });
          }}
        />
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

/** p16-runtime-updates: Filo — unverified runtime updates (on by default in every preset). */
function FleetTab(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().runtimeUpdates.policy;
  const { view, send } = props.policy;
  const form = useDyForm<FleetPolicySettings>({
    initial: view.effective.fleet,
    save: async (v) => {
      const next = await send({ fleet: { unverifiedRuntimeUpdates: v.unverifiedRuntimeUpdates } });
      return next.effective.fleet;
    },
  });
  useFormSection(form);
  const a = form.value ?? view.effective.fleet;
  return (
    <Panel title={t.title} sub={t.hint} testId="security-fleet">
      <div className="grid gap-4 px-4 pb-4">
        <DySwitch
          testId="fleet-unverified"
          label={t.switch}
          hint={t.switchHint}
          checked={a.unverifiedRuntimeUpdates}
          onChange={(v) => {
            form.set({ unverifiedRuntimeUpdates: v });
          }}
        />
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

/** p16-zip-job-input (ADR-0060): native executables as job input files from a .zip (off by default). */
function InputsPanel(props: { readonly policy: PolicyApi }): ReactNode {
  const t = useT().security.inputs;
  const { view, send } = props.policy;
  const form = useDyForm<InputPolicySettings>({
    initial: view.effective.inputs,
    save: async (v) => {
      const next = await send({ inputs: { executables: v.executables } });
      return next.effective.inputs;
    },
  });
  useFormSection(form);
  const a = form.value ?? view.effective.inputs;
  return (
    <Panel title={t.title} sub={t.hint} testId="security-inputs">
      <div className="grid gap-4 px-4 pb-4">
        <DySwitch
          testId="inputs-executables"
          label={t.switch}
          hint={t.switchHint}
          checked={a.executables}
          onChange={(v) => {
            form.set({ executables: v });
          }}
        />
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

/**
 * p15-form-pattern: Güvenlik in tabs — Otomatik mod (an instant switch + the retry count), Hazır ayarlar (actions),
 * Kod doğrulama, Kod istenen olaylar and Ajan otonomisi (one form each). Each form sends only its own part of the
 * policy (the patch of that part against the loaded version); the master asks for a code while it keeps "Güvenlik
 * politikasını değiştirme" protected (the step-up provider opens its dialog and retries once).
 */
export function SecurityView(): ReactNode {
  // The view brings its own unsaved-changes guard (it was rendered by the classic console too).
  return (
    <UnsavedGuardProvider>
      <SecurityViewBody />
    </UnsavedGuardProvider>
  );
}

function SecurityViewBody(): ReactNode {
  const t = useT().security;
  const tt = useT().forms.tabs.security;
  const scriptsTab = useT().installScripts.tab;
  const format = useFormat();
  const stepUp = useStepUp();
  const [view, setView] = useState<SecurityPolicyView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    getSecurityPolicy().then(
      (v) => {
        if (live) setView(v);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const policy = useMemo<PolicyApi | null>(
    () =>
      view === null
        ? null
        : {
            view,
            send: async (p) => {
              // useDyForm / DyInstantToggle already run their save through step-up; a preset or the retry count
              // inside them must not ask twice, so this sends as is and lets the caller's runner answer a 403.
              const next = await putSecurityPolicy({ ...p, expectedVersion: view.version });
              setView(next);
              return next;
            },
          },
    [view],
  );
  // The presets' confirm is not a form: it runs its own step-up.
  const presetPolicy = useMemo<PolicyApi | null>(
    () => (policy === null ? null : { view: policy.view, send: (p) => stepUp.run(() => policy.send(p)) }),
    [policy, stepUp],
  );

  if (view === null || policy === null || presetPolicy === null)
    return error === null ? (
      <Panel title={t.page.loading}>
        <SkeletonRows label={t.page.loading} rows={4} />
      </Panel>
    ) : (
      <DyApiError error={error} />
    );

  return (
    <div className="grid gap-5" data-testid="dy-security">
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="security-version">
        {view.updatedAt === null || view.updatedBy === null
          ? t.page.versionNever({ version: String(view.version) })
          : t.page.version({
              version: String(view.version),
              who: view.updatedBy,
              when: format.dateTime(view.updatedAt),
            })}
      </p>
      <DyNotice tone="neutral">{t.page.chatHint}</DyNotice>
      <DyTabs
        label={tt.label}
        items={[
          { id: 'auto', label: tt.auto },
          { id: 'presets', label: tt.presets },
          { id: 'stepup', label: tt.stepUp },
          { id: 'events', label: tt.events },
          { id: 'autonomy', label: tt.autonomy },
          { id: 'tokens', label: tt.tokens },
          { id: 'fleet', label: tt.fleet },
          // p19-install-scripts: approved npm install scripts (their own list; not part of the policy document).
          { id: 'scripts', label: scriptsTab },
        ]}
      >
        {(tab) =>
          tab === 'scripts' ? (
            <InstallScriptsPanel />
          ) : (
            <DyFormScope
              label={
                tt[
                  tab === 'stepup'
                    ? 'stepUp'
                    : (tab as 'auto' | 'presets' | 'events' | 'autonomy' | 'tokens' | 'fleet')
                ]
              }
            >
              {tab === 'presets' ? (
                <PresetsTab policy={presetPolicy} />
              ) : tab === 'stepup' ? (
                <StepUpTab policy={policy} />
              ) : tab === 'events' ? (
                <EventsTab policy={policy} />
              ) : tab === 'autonomy' ? (
                <AutonomyTab policy={policy} />
              ) : tab === 'tokens' ? (
                <TokensTab policy={policy} />
              ) : tab === 'fleet' ? (
                <div className="grid gap-4">
                  <FleetTab policy={policy} />
                  <InputsPanel policy={policy} />
                </div>
              ) : (
                <AutoModeTab policy={policy} />
              )}
            </DyFormScope>
          )
        }
      </DyTabs>
    </div>
  );
}
