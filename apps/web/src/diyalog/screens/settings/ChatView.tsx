import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { ACCOUNT_STATE_TR, listRuntimeAccounts, type RuntimeAccount } from '../../../api/runtimeAccounts';
import {
  ASSISTANT_RUNTIMES,
  type AssistantRuntime,
  type ChatLimits,
  type ChatSettings,
  type ChatStatus,
  getChatSettings,
  getChatStatus,
  isAssistantRuntime,
  putChatSettings,
} from '../../../api/chat';
import {
  type ChatKnowledgePrefs,
  getChatKnowledgePrefs,
  putChatKnowledgePrefs,
} from '../../../api/chatKnowledge';
import type { ApiError } from '../../../api/client';
import { listModels, type ModelView } from '../../../api/models';
import { listWorkers, type WorkerSummary } from '../../../api/workers';
import { useAuth } from '../../../auth/AuthProvider';
import { useT } from '../../../i18n/I18nProvider';
import { toApiError } from '../../../components/ui';
import { type ChatSettingsForm, chatLimitsOf, toChatForm } from '../../../screens/chat/settingsForm';
import type { Tone } from '../../tone';
import { INK } from '../../tone';
import { RuntimeMark } from '../../RuntimeMark';
import { DyApiError, DyField, DyNotice, DySwitch, FormGrid } from '../forms';
import { DyFormScope, DyInstantToggle, DyTabs, useDyForm, useFormSection } from '../../formkit';
import { DySelect, Panel, SkeletonRows } from '../parts';
import { DyModelPicker, useRuntimeModels } from '../shared/ModelPicker';
import type { Messages } from '@remyral/i18n';
import { BackupMachines, FailoverTab } from './chat-failover';
import { RememberedConfirmationsPanel } from './chat-remembered';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Sohbet in the Diyalog language, same rules as the classic `ChatSettingsPage`
 * (p5-ops-chat, p10-semantic-defaults-chat, p11-usage-limit-fallback): everyone has "Sohbetlerim" (index / share /
 * related lookup, saved at once with the version check); owners and admins also get the assistant — kill switch,
 * machine, runtime with each engine's readiness on that machine, model profile, fallback engine at a usage limit and
 * the limits (checked by the classic `chatLimitsOf`), saved through step-up with the version check.
 */

type ChatText = Messages['settings']['chat'];

/** The classic limit checks (`chatLimitsOf` keeps the rules) answer in English; these are their catalog keys. */
const LIMIT_KEY: Readonly<Record<string, keyof ChatText['limitProblems']>> = {
  'Turns per 10 minutes must be a whole number ≥ 1.': 'turns',
  'Tool calls per turn must be a whole number ≥ 1.': 'toolCalls',
  'Daily tokens per user must be empty or a positive number.': 'userDaily',
  'Daily tokens (everyone) must be empty or a positive number.': 'daily',
  'Monthly cost must be empty or a positive number.': 'monthlyCost',
};

/** Readiness of one runtime's assistant engine on the chosen machine, as that machine last reported it (classic rule). */
function engineState(
  t: ChatText['engine'],
  settings: ChatSettings | null,
  workerId: string,
  runtime: AssistantRuntime,
): { tone: Tone; text: string } {
  if (workerId === '') return { tone: 'neutral', text: t.pickMachine };
  const w = settings?.engines.find((x) => x.workerId === workerId);
  if (w === undefined) return { tone: 'neutral', text: t.notReported };
  if (w.disabled) return { tone: 'amber', text: t.disabled };
  const e = w.engines.find((x) => x.runtime === runtime);
  if (e === undefined) return { tone: 'amber', text: t.unknown };
  if (e.ready) return { tone: 'green', text: w.online ? t.ready : t.readyOffline };
  return { tone: 'amber', text: t.notReady({ reason: e.reason }) };
}

function MyConversationsPanel(): ReactNode {
  const t = useT().settings.chat.mine;
  const [prefs, setPrefs] = useState<ChatKnowledgePrefs | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    getChatKnowledgePrefs().then(
      (p) => {
        if (live) setPrefs(p);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  // p15-form-pattern: personal one-bit preferences apply at once (instant switches with undo on a refusal).
  const save = async (next: Omit<ChatKnowledgePrefs, 'version'>): Promise<void> => {
    if (prefs === null) return;
    setPrefs(
      await putChatKnowledgePrefs({
        indexConversations: next.indexConversations,
        shareProjects: next.shareProjects,
        autoRelated: next.autoRelated,
        expectedVersion: prefs.version,
      }),
    );
  };
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-my-conversations">
      <div className="flex flex-col gap-4">
        <DyApiError error={error} />
        {prefs === null ? (
          error === null ? (
            <SkeletonRows label={t.loading} rows={3} />
          ) : null
        ) : (
          <>
            <DyInstantToggle
              label={t.index}
              hint={t.indexHint}
              checked={prefs.indexConversations}
              onCommit={(v) => save({ ...prefs, indexConversations: v })}
              savedText={(v) => (v ? t.indexOn : t.indexOff)}
              testId="chat-index"
            />
            <DyInstantToggle
              label={t.share}
              hint={t.shareHint}
              checked={prefs.shareProjects}
              onCommit={(v) => save({ ...prefs, shareProjects: v })}
              savedText={(v) => (v ? t.shareOn : t.shareOff)}
              testId="chat-share"
            />
            <DyInstantToggle
              label={t.related}
              hint={t.relatedHint}
              checked={prefs.autoRelated}
              onCommit={(v) => save({ ...prefs, autoRelated: v })}
              savedText={() => t.saved}
              testId="chat-related"
            />
          </>
        )}
      </div>
    </Panel>
  );
}

/** The assistant settings the admin tabs edit: loaded once, shared by the "Asistan" and "Sınırlar" forms. */
interface AdminData {
  readonly settings: ChatSettings | null;
  readonly setSettings: (s: ChatSettings) => void;
  readonly status: ChatStatus | null;
  readonly refreshStatus: () => void;
  readonly workers: readonly WorkerSummary[];
  readonly models: readonly ModelView[];
  readonly error: ApiError | null;
}

function useAssistantData(): AdminData {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    getChatSettings().then(
      (s) => {
        if (live) setSettings(s);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    getChatStatus().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => undefined,
    );
    listWorkers().then(
      (w) => {
        if (live) setWorkers(w.filter((x) => x.revokedAt === null && x.state !== 'pending'));
      },
      () => undefined,
    );
    listModels().then(
      (m) => {
        if (live) setModels(m.items.filter((x) => x.enabled));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const refreshStatus = (): void => {
    getChatStatus().then(setStatus, () => undefined);
  };
  return { settings, setSettings, status, refreshStatus, workers, models, error };
}

/** The request body: the loaded settings with `form`'s fields (the other tab's fields stay as loaded). */
function bodyOf(
  settings: ChatSettings,
  form: ChatSettingsForm,
  limits: ChatLimits,
  accounts: { readonly account: string; readonly fallbackAccount: string } | null,
  ids?: { readonly model: string; readonly fallbackModel: string },
  backups?: readonly string[],
): Parameters<typeof putChatSettings>[0] {
  return {
    // p15-model-picker: a model id instead of a profile (only one of the two is sent non-null).
    ...(ids === undefined
      ? {}
      : {
          model: form.modelProfile !== '' || ids.model === '' ? null : ids.model,
          fallbackModel:
            form.fallbackRuntime === '' || form.fallbackModelProfile !== '' || ids.fallbackModel === ''
              ? null
              : ids.fallbackModel,
        }),
    enabled: form.enabled,
    workerId: form.workerId === '' ? null : form.workerId,
    runtime: form.runtime,
    modelProfile: form.modelProfile === '' ? null : form.modelProfile,
    fallbackRuntime:
      form.fallbackRuntime === '' || form.fallbackRuntime === form.runtime ? null : form.fallbackRuntime,
    fallbackModelProfile:
      form.fallbackRuntime === '' || form.fallbackModelProfile === '' ? null : form.fallbackModelProfile,
    ...(accounts === null
      ? {}
      : {
          account: accounts.account === '' ? null : accounts.account,
          fallbackAccount:
            accounts.fallbackAccount === '' || accounts.fallbackAccount === accounts.account
              ? null
              : accounts.fallbackAccount,
        }),
    // p15-chat-failover: only the Asistan form sends the backup list (absent = unchanged).
    ...(backups === undefined ? {} : { backupWorkerIds: backups.filter((id) => id !== form.workerId) }),
    limits,
    expectedVersion: settings.version,
  };
}

type AssistantForm = Omit<ChatSettingsForm, 'turns' | 'userDaily' | 'daily' | 'monthlyCost' | 'toolCalls'> & {
  readonly account: string;
  readonly fallbackAccount: string;
  /** p15-model-picker: the engine's / fallback engine's model id ('' = a profile or the runtime's default). */
  readonly model: string;
  readonly fallbackModel: string;
  /** p15-chat-failover: the ordered backup machines. */
  readonly backups: readonly string[];
};

function assistantFormOf(s: ChatSettings): AssistantForm {
  const f = toChatForm(s);
  return {
    enabled: f.enabled,
    workerId: f.workerId,
    runtime: f.runtime,
    modelProfile: f.modelProfile,
    fallbackRuntime: f.fallbackRuntime,
    fallbackModelProfile: f.fallbackModelProfile,
    account: s.account ?? '',
    fallbackAccount: s.fallbackAccount ?? '',
    model: s.model ?? '',
    fallbackModel: s.fallbackModel ?? '',
    backups: [...s.backupWorkerIds],
  };
}

function AssistantTab(props: { readonly data: AdminData }): ReactNode {
  const tc = useT().settings.chat;
  const t = tc.assistant;
  const ta = useT().settings.chatAccounts;
  const runtimeName = useId();
  const { settings, workers, models } = props.data;
  // p13-runtime-accounts: the engine's account and fallback account ('' = the machine's default account; for the
  // fallback '' = Yok and 'auto' = Otomatik, p15-message-delivery item 2).
  const [accounts, setAccounts] = useState<readonly RuntimeAccount[] | null>(null);
  const mp = useT().modelPicker;
  const catalog = useRuntimeModels();
  const initial = useMemo(() => (settings === null ? null : assistantFormOf(settings)), [settings]);
  const form = useDyForm<AssistantForm>({
    initial,
    stepUpReason: t.stepUp,
    save: async (f) => {
      if (settings === null) return;
      const loaded = toChatForm(settings);
      const next = await putChatSettings(
        bodyOf(
          settings,
          { ...loaded, ...f },
          settings.limits,
          accounts === null ? null : { account: f.account, fallbackAccount: f.fallbackAccount },
          { model: f.model, fallbackModel: f.fallbackModel },
          f.backups,
        ),
      );
      props.data.setSettings(next);
      props.data.refreshStatus();
      return assistantFormOf(next);
    },
  });
  useFormSection(form);
  const f = form.value;
  const accountWorker = f?.workerId ?? '';
  const accountRuntime = f?.runtime ?? '';
  useEffect(() => {
    setAccounts(null);
    if (accountWorker === '' || (accountRuntime !== 'claude-code' && accountRuntime !== 'codex')) return;
    let live = true;
    listRuntimeAccounts({ worker: accountWorker, runtime: accountRuntime }).then(
      (r) => {
        if (!live) return;
        const supported = r.workers.find((w) => w.id === accountWorker)?.supported ?? false;
        setAccounts(supported ? r.accounts.filter((a) => a.workerId === accountWorker) : null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [accountWorker, accountRuntime]);

  if (f === null)
    return props.data.error === null ? (
      <Panel title={t.title} flush>
        <SkeletonRows label={t.loading} rows={4} />
      </Panel>
    ) : null;

  return (
    <Panel title={t.title} sub={t.sub} testId="dy-chat-assistant">
      <div className="flex flex-col gap-4" role="group" aria-label={t.formLabel}>
        <DySwitch
          label={t.enabled}
          hint={t.enabledHint}
          checked={f.enabled}
          onChange={(v) => {
            form.set({ enabled: v });
          }}
          testId="chat-enabled"
        />
        <div className="flex flex-col gap-1">
          <DySelect
            label={t.machine}
            value={f.workerId}
            options={[['', t.none], ...workers.map((w) => [w.id, `${w.name} (${w.state})`] as const)]}
            onChange={(v) => {
              // p15-chat-failover: the primary is never also a backup.
              form.set((cur) => ({ ...cur, workerId: v, backups: cur.backups.filter((id) => id !== v) }));
            }}
          />
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.machineHint}</p>
        </div>
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" data-testid="chat-runtime">
          <legend className="text-[0.8125rem] font-bold">{t.runtime}</legend>
          <p className="m-0 mb-1 text-[0.78125rem] text-dy-muted">{t.runtimeHint}</p>
          <ul className="m-0 flex list-none flex-col rounded-[10px] border border-dy-line p-0">
            {ASSISTANT_RUNTIMES.map((rt) => {
              const r = engineState(tc.engine, settings, f.workerId, rt);
              return (
                <li key={rt} className="border-t border-dy-line first:border-t-0">
                  <label className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                    <input
                      type="radio"
                      name={runtimeName}
                      value={rt}
                      checked={f.runtime === rt}
                      className="size-4 accent-[var(--dy-teal)]"
                      onChange={() => {
                        form.set((cur) => ({
                          ...cur,
                          runtime: rt,
                          // A profile of another runtime does not apply (classic).
                          modelProfile: models.some(
                            (m) => m.id === cur.modelProfile && m.runtimes.includes(rt),
                          )
                            ? cur.modelProfile
                            : '',
                          // p15-model-picker: a model id belongs to its runtime.
                          model: rt === cur.runtime ? cur.model : '',
                        }));
                      }}
                    />
                    <RuntimeMark runtime={rt} className="font-medium" />
                    <span data-testid={`chat-runtime-${rt}`} className={`text-[0.8125rem] ${INK[r.tone]}`}>
                      {r.text}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {/* p15-model-picker: a profile or a model of the engine's runtime (this machine's first), or a custom id. */}
        <DyModelPicker
          label={mp.chatModel}
          runtimes={[f.runtime]}
          value={f.modelProfile !== '' ? f.modelProfile : f.model}
          valueKind={f.modelProfile !== '' ? 'profile' : 'model'}
          workerId={f.workerId === '' ? undefined : f.workerId}
          catalog={catalog}
          defaultLabel={t.runtimeDefault}
          profiles={models
            .filter((m) => m.runtimes.includes(f.runtime))
            .map((m) => ({ value: m.id, label: m.displayName, detail: `${m.provider}/${m.model}` }))}
          testId="chat-model-picker"
          onChange={(v, kind) => {
            form.set(
              kind === 'profile'
                ? { modelProfile: v, model: '' }
                : kind === 'model'
                  ? { modelProfile: '', model: v }
                  : { modelProfile: '', model: '' },
            );
          }}
        />
        {accounts !== null && accounts.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="chat-account">
            <DySelect
              label={t.account}
              value={f.account}
              options={[
                ['', t.machineDefaultAccount],
                ...accounts.map(
                  (a) => [a.id, `${a.label} (${ACCOUNT_STATE_TR[a.state].toLowerCase()})`] as const,
                ),
              ]}
              onChange={(v) => {
                form.set({ account: v });
              }}
            />
            <DySelect
              label={ta.fallbackLabel}
              value={f.fallbackAccount}
              options={[
                ['auto', ta.auto],
                ['', ta.none],
                ...accounts
                  .filter((a) => a.id !== f.account)
                  .map((a) => [a.id, `${a.label} (${ACCOUNT_STATE_TR[a.state].toLowerCase()})`] as const),
              ]}
              onChange={(v) => {
                form.set({ fallbackAccount: v });
              }}
            />
            <p className="m-0 text-[0.78125rem] text-dy-muted">
              {f.fallbackAccount === 'auto' ? ta.autoHint : ta.hint}
            </p>
          </div>
        ) : null}
        <div className="flex flex-col gap-2" data-testid="chat-fallback">
          <DySelect
            label={t.fallbackRuntime}
            value={f.fallbackRuntime}
            options={[
              ['', t.noFallbackRuntime],
              ...ASSISTANT_RUNTIMES.filter((rt) => rt !== f.runtime).map(
                (rt) => [rt, `${rt} (${engineState(tc.engine, settings, f.workerId, rt).text})`] as const,
              ),
            ]}
            onChange={(v) => {
              form.set({
                fallbackRuntime: v === '' || !isAssistantRuntime(v) ? '' : v,
                fallbackModelProfile: '',
                fallbackModel: '',
              });
            }}
          />
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.fallbackHint}</p>
          {f.fallbackRuntime !== '' ? (
            <DyModelPicker
              label={mp.fallbackModel}
              runtimes={[f.fallbackRuntime]}
              value={f.fallbackModelProfile !== '' ? f.fallbackModelProfile : f.fallbackModel}
              valueKind={f.fallbackModelProfile !== '' ? 'profile' : 'model'}
              workerId={f.workerId === '' ? undefined : f.workerId}
              catalog={catalog}
              defaultLabel={t.runtimeDefault}
              profiles={models
                .filter((m) => f.fallbackRuntime !== '' && m.runtimes.includes(f.fallbackRuntime))
                .map((m) => ({ value: m.id, label: m.displayName, detail: `${m.provider}/${m.model}` }))}
              testId="chat-fallback-model-picker"
              onChange={(v, kind) => {
                form.set(
                  kind === 'profile'
                    ? { fallbackModelProfile: v, fallbackModel: '' }
                    : kind === 'model'
                      ? { fallbackModelProfile: '', fallbackModel: v }
                      : { fallbackModelProfile: '', fallbackModel: '' },
                );
              }}
            />
          ) : null}
        </div>
        {f.workerId === '' ? null : (
          <BackupMachines
            settings={settings}
            workers={workers}
            primary={f.workerId}
            runtime={f.runtime}
            fallbackRuntime={f.fallbackRuntime}
            value={f.backups}
            onChange={(next) => {
              form.set({ backups: [...next] });
            }}
          />
        )}
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

type LimitsForm = Pick<ChatSettingsForm, 'turns' | 'userDaily' | 'daily' | 'monthlyCost' | 'toolCalls'>;

function limitsFormOf(s: ChatSettings): LimitsForm {
  const f = toChatForm(s);
  return {
    turns: f.turns,
    userDaily: f.userDaily,
    daily: f.daily,
    monthlyCost: f.monthlyCost,
    toolCalls: f.toolCalls,
  };
}

/** The client check's sentence → the field it is about. */
const LIMIT_FIELD: Readonly<Record<keyof ChatText['limitProblems'], keyof LimitsForm>> = {
  turns: 'turns',
  toolCalls: 'toolCalls',
  userDaily: 'userDaily',
  daily: 'daily',
  monthlyCost: 'monthlyCost',
};

function LimitsTab(props: { readonly data: AdminData }): ReactNode {
  const tc = useT().settings.chat;
  const tl = tc.limits;
  const { settings } = props.data;
  const initial = useMemo(() => (settings === null ? null : limitsFormOf(settings)), [settings]);
  const form = useDyForm<LimitsForm>({
    initial,
    stepUpReason: tc.assistant.stepUp,
    // The classic checks (`chatLimitsOf`) decide; their sentence shows under the field it is about.
    validate: (f) => {
      if (settings === null) return null;
      const limits = chatLimitsOf({ ...toChatForm(settings), ...f });
      if (typeof limits !== 'string') return null;
      const key = LIMIT_KEY[limits];
      return {
        [key === undefined ? 'turns' : LIMIT_FIELD[key]]: key === undefined ? limits : tc.limitProblems[key],
      };
    },
    save: async (f) => {
      if (settings === null) return;
      const loaded = toChatForm(settings);
      const limits = chatLimitsOf({ ...loaded, ...f });
      if (typeof limits === 'string') return;
      const next = await putChatSettings(bodyOf(settings, loaded, limits, null));
      props.data.setSettings(next);
      props.data.refreshStatus();
      return limitsFormOf(next);
    },
  });
  useFormSection(form);
  const f = form.value;
  if (f === null)
    return props.data.error === null ? (
      <Panel title={tl.title} flush>
        <SkeletonRows label={tc.assistant.loading} rows={4} />
      </Panel>
    ) : null;
  const field = (k: keyof LimitsForm, label: string, hint: string): ReactNode => (
    <DyField
      label={label}
      hint={hint}
      inputMode="decimal"
      value={f[k]}
      error={form.fieldError(k)}
      onChange={(v) => {
        form.set({ [k]: v });
      }}
    />
  );
  return (
    <Panel title={tl.title} sub={tl.sub} testId="dy-chat-limits">
      <div className="flex flex-col gap-4">
        <FormGrid>
          {field('turns', tl.turns, tl.turnsHint)}
          {field('toolCalls', tl.toolCalls, tl.toolCallsHint)}
          {field('userDaily', tl.userDaily, tl.userDailyHint)}
          {field('daily', tl.daily, tl.dailyHint)}
          {field('monthlyCost', tl.monthlyCost, tl.monthlyCostHint)}
        </FormGrid>
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

function AssistantStatus(props: { readonly data: AdminData }): ReactNode {
  const t = useT().settings.chat.assistant;
  const status = props.data.status;
  return (
    <>
      {status !== null ? (
        <DyNotice tone={status.available ? 'green' : 'amber'}>
          <span data-testid="chat-settings-status">
            {status.available
              ? t.readyOn({
                  machine: status.worker?.name ?? null,
                  runtime: status.runtime,
                  model: status.model,
                })
              : (status.message ?? t.unavailable)}
          </span>
        </DyNotice>
      ) : null}
      <DyApiError error={props.data.error} />
    </>
  );
}

/**
 * p15-form-pattern: Sohbet in tabs — "Sohbetlerim" (instant switches, everyone), "Asistan" and "Sınırlar" (owners /
 * admins; one form each, saved through step-up with the version check; each sends only its own fields, the other
 * tab's as loaded).
 */
export function ChatView(): ReactNode {
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : '';
  const admin = role === 'owner' || role === 'admin';
  if (!admin)
    return (
      <div className="flex flex-col gap-4">
        <MyConversationsPanel />
        <RememberedConfirmationsPanel />
      </div>
    );
  return <AdminChatView />;
}

function AdminChatView(): ReactNode {
  const data = useAssistantData();
  const tt = useT().forms.tabs.chat;
  const tf = useT().chatFailover;
  return (
    <div className="flex flex-col gap-4">
      <AssistantStatus data={data} />
      <DyTabs
        label={tt.label}
        items={[
          { id: 'mine', label: tt.mine },
          { id: 'assistant', label: tt.assistant },
          { id: 'limits', label: tt.limits },
          { id: 'failover', label: tf.tab },
        ]}
      >
        {(tab) =>
          tab === 'failover' ? (
            <FailoverTab />
          ) : tab === 'assistant' ? (
            <DyFormScope label={tt.assistant}>
              <AssistantTab data={data} />
            </DyFormScope>
          ) : tab === 'limits' ? (
            <DyFormScope label={tt.limits}>
              <LimitsTab data={data} />
            </DyFormScope>
          ) : (
            <div className="flex flex-col gap-4">
              <MyConversationsPanel />
              <RememberedConfirmationsPanel />
            </div>
          )
        }
      </DyTabs>
    </div>
  );
}
