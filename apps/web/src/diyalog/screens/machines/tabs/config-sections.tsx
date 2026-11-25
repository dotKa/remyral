import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApiIssue } from '../../../../api/client';
import {
  CONFIG_RUNTIMES,
  type ConfigRuntime,
  type CredentialRef,
  type RuntimeSettings,
  SANDBOX_PROFILES,
  type SandboxProfileName,
  type WorkerConfigReport,
  type WorkerConfigView,
} from '../../../../api/workerConfig';
import type { Draft, Mutable } from '../../../../screens/fleet/workerConfig';
import { RuntimeMark } from '../../../RuntimeMark';
import { DyCheck, DyField, DyNotice, DyTextarea } from '../../forms';
import { DySelect } from '../../parts';
import { useT } from '../../../../i18n/I18nProvider';
import { profileName } from './config-shared';
import { DyModelPicker, useRuntimeModels } from '../../shared/ModelPicker';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yapılandırma: the editing sections (Genel, Runtime ve modeller, Kimlik
 * bilgileri) in the Diyalog language. Display and draft editing only; the classic helpers (`cloneSpec`, `cleanSpec`,
 * `parseLabels`) shape what is sent and the master validates every write.
 */

export function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((v) => v !== value);
}

function setRuntime(draft: Draft, r: ConfigRuntime, patch: Partial<RuntimeSettings>): Draft {
  return { ...draft, runtimes: { ...draft.runtimes, [r]: { ...(draft.runtimes[r] ?? {}), ...patch } } };
}

const RUNTIME_ID: Readonly<Record<ConfigRuntime, string>> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

/** The master's field issues under one path, as the classic panel shows them (path: code). */
export function FieldIssues(props: {
  readonly issues: readonly ApiIssue[];
  readonly prefix: string;
}): ReactNode {
  const mine = props.issues.filter((i) => i.path === props.prefix || i.path.startsWith(`${props.prefix}.`));
  if (mine.length === 0) return null;
  return (
    <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink" data-testid={`issues-${props.prefix}`}>
      {mine.map((i) => `${i.path}: ${i.code}`).join('; ')}
    </p>
  );
}

function Group(props: {
  readonly legend: string;
  readonly hint?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1 p-0 text-[0.875rem] font-bold">{props.legend}</legend>
      {props.hint === undefined ? null : <p className="m-0 text-[0.8125rem] text-dy-muted">{props.hint}</p>}
      <div className={props.className}>{props.children}</div>
    </fieldset>
  );
}

const gib = (bytes: number | undefined): string => (bytes === undefined ? '' : String(bytes / 1024 ** 3));

export function GeneralSection(props: {
  readonly draft: Draft;
  readonly setDraft: (d: Draft) => void;
  readonly view: WorkerConfigView;
  readonly issues: readonly ApiIssue[];
  readonly labels: string;
  readonly setLabels: (s: string) => void;
}): ReactNode {
  const { draft, setDraft, view, issues } = props;
  const ws = draft.workspace;
  const known = new Set(view.projectOptions.map((p) => p.id));
  const unknown = draft.projects.filter((p) => !known.has(p));
  const setWs = (patch: Partial<Draft['workspace']>): void => {
    setDraft({ ...draft, workspace: { ...ws, ...patch } });
  };
  const maxBad = issues.some((i) => i.path === 'maxParallelJobs');
  const all = useT().machineConfig;
  const t = all.sections;
  return (
    <div className="flex flex-col gap-5">
      <Group
        legend={t.projects}
        hint={
          <>
            {t.projectsHint}
            <Link to="/projects" className="font-medium text-dy-teal-ink">
              {t.projects}
            </Link>
            ).
          </>
        }
        className="grid gap-x-4 sm:grid-cols-2"
      >
        {view.projectOptions.map((p) => {
          const on = draft.projects.includes(p.id);
          return (
            <DyCheck
              key={p.id}
              label={p.name === p.id ? p.id : `${p.id} (${p.name})`}
              checked={on}
              disabled={p.kind !== 'workspace' && p.repositoryUrl === null && !on}
              hint={
                p.id.includes(':') && on ? (
                  <span className="font-medium text-dy-amber-ink" data-testid="project-colon-warning">
                    {t.colonWarning}
                  </span>
                ) : p.kind === 'workspace' ? (
                  t.workspaceProject
                ) : p.repositoryUrl === null ? (
                  t.noRepo
                ) : (
                  <span className="font-dy-mono [overflow-wrap:anywhere]">{p.repositoryUrl}</span>
                )
              }
              onChange={(v) => {
                setDraft({ ...draft, projects: toggle(draft.projects, p.id, v) });
              }}
            />
          );
        })}
        {unknown.map((p) => (
          <DyCheck
            key={p}
            label={t.unregistered({ id: p })}
            checked
            onChange={(v) => {
              setDraft({ ...draft, projects: toggle(draft.projects, p, v) });
            }}
          />
        ))}
      </Group>
      <FieldIssues issues={issues} prefix="projects" />

      <Group legend={t.allowedRuntimes} className="grid gap-x-4 sm:grid-cols-4">
        {CONFIG_RUNTIMES.map((r) => (
          <DyCheck
            key={r}
            label={<RuntimeMark runtime={RUNTIME_ID[r]} />}
            checked={draft.allowedRuntimes.includes(r)}
            onChange={(v) => {
              setDraft({ ...draft, allowedRuntimes: toggle(draft.allowedRuntimes, r, v) });
            }}
          />
        ))}
      </Group>
      <FieldIssues issues={issues} prefix="allowedRuntimes" />

      <div className="grid gap-3 sm:grid-cols-2">
        <DyField
          label={t.maxParallel}
          type="number"
          min={0}
          max={64}
          inputMode="numeric"
          value={String(draft.maxParallelJobs)}
          hint={t.maxParallelHint}
          error={maxBad ? t.maxParallelBad : undefined}
          onChange={(v) => {
            setDraft({ ...draft, maxParallelJobs: Number(v) });
          }}
        />
      </div>

      <Group legend={t.allowedProfiles} className="grid gap-x-4 sm:grid-cols-3">
        {SANDBOX_PROFILES.map((p) => (
          <DyCheck
            key={p}
            label={
              <>
                {profileName(p, all.shared)}{' '}
                <span className="font-dy-mono text-[0.78125rem] text-dy-muted">{p}</span>
              </>
            }
            checked={draft.sandboxProfiles.includes(p)}
            onChange={(v) => {
              setDraft({
                ...draft,
                sandboxProfiles: toggle<SandboxProfileName>(draft.sandboxProfiles, p, v),
              });
            }}
          />
        ))}
      </Group>
      <FieldIssues issues={issues} prefix="sandboxProfiles" />

      <Group legend={t.workspace} className="grid gap-3 sm:grid-cols-2">
        <DyField
          label={t.retainFailed}
          type="number"
          min={0}
          inputMode="numeric"
          value={ws.retainFailed === undefined ? '' : String(ws.retainFailed)}
          placeholder={t.machineDefault}
          onChange={(v) => {
            setWs(v === '' ? { retainFailed: undefined } : { retainFailed: Number(v) });
          }}
        />
        <DyField
          label={t.minFree}
          type="number"
          min={0}
          inputMode="decimal"
          value={gib(ws.minFreeBytes)}
          placeholder={t.machineDefault}
          onChange={(v) => {
            setWs(
              v === '' ? { minFreeBytes: undefined } : { minFreeBytes: Math.round(Number(v) * 1024 ** 3) },
            );
          }}
        />
        <DyField
          label={t.cacheLimit}
          type="number"
          min={0}
          inputMode="decimal"
          hint={t.cacheHint}
          value={gib(ws.packageCacheMaxBytes)}
          placeholder={t.cacheDefault}
          onChange={(v) => {
            setWs(
              v === ''
                ? { packageCacheMaxBytes: undefined }
                : { packageCacheMaxBytes: Math.round(Number(v) * 1024 ** 3) },
            );
          }}
        />
        <DySelect
          label={t.submodules}
          value={ws.submodules ?? ''}
          options={[
            ['', t.submodulesDefault],
            ['skip', t.submodulesSkip],
            ['allowlisted', t.submodulesAllowlisted],
          ]}
          onChange={(v) => {
            setWs({ submodules: v === '' ? undefined : (v as 'skip' | 'allowlisted') });
          }}
        />
        {/* p17-disk-selfclean: the worker's own disk cleanup (default on) and its margin above the minimum free disk. */}
        <DySelect
          label={t.diskHygiene}
          value={ws.diskHygiene === undefined ? '' : ws.diskHygiene.enabled ? 'on' : 'off'}
          options={[
            ['', t.diskHygieneDefault],
            ['on', t.diskHygieneOn],
            ['off', t.diskHygieneOff],
          ]}
          onChange={(v) => {
            const margin = ws.diskHygiene?.marginBytes;
            setWs({
              diskHygiene:
                v === ''
                  ? margin === undefined
                    ? undefined
                    : { enabled: true, marginBytes: margin }
                  : { enabled: v === 'on', ...(margin === undefined ? {} : { marginBytes: margin }) },
            });
          }}
        />
        <DyField
          label={t.diskHygieneMargin}
          type="number"
          min={0}
          inputMode="decimal"
          hint={t.diskHygieneMarginHint}
          value={gib(ws.diskHygiene?.marginBytes)}
          placeholder={t.diskHygieneMarginDefault}
          onChange={(v) => {
            const enabled = ws.diskHygiene?.enabled ?? true;
            setWs({
              diskHygiene:
                v === ''
                  ? ws.diskHygiene === undefined || ws.diskHygiene.enabled
                    ? undefined
                    : { enabled }
                  : { enabled, marginBytes: Math.round(Number(v) * 1024 ** 3) },
            });
          }}
        />
      </Group>
      <FieldIssues issues={issues} prefix="workspace" />

      <DyTextarea
        label={t.labels}
        mono
        rows={3}
        value={props.labels}
        placeholder="site=home"
        hint={t.labelsHint}
        onChange={props.setLabels}
      />
      <FieldIssues issues={issues} prefix="labels" />
    </div>
  );
}

const HELP_KEY: Readonly<Record<ConfigRuntime, 'claudeCode' | 'codex' | 'pi' | 'opencode'>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  pi: 'pi',
  opencode: 'opencode',
};

function AppliedRuntime(props: {
  readonly runtime: ConfigRuntime;
  readonly report: WorkerConfigReport | null;
}): ReactNode {
  const t = useT().machineConfig.sections;
  if (props.report === null) return null;
  const a = props.report.effective.runtimes?.[props.runtime];
  if (a === undefined)
    return (
      <p
        className="m-0 text-[0.8125rem] text-dy-muted sm:col-span-2"
        data-testid={`applied-${props.runtime}`}
      >
        {t.appliedNone}
      </p>
    );
  const parts: string[] = [];
  if (a.auth !== undefined) {
    const cred =
      a.auth.credential === undefined
        ? ''
        : ` ${a.auth.source === 'vault' ? t.vault : t.secret} “${a.auth.credential}”${a.auth.present === false ? ` ${t.missingOnMachine}` : ''}`;
    parts.push(t.authPart({ mode: a.auth.mode, credential: cred, env: a.auth.env ?? '' }));
  }
  if (a.modelProfile !== undefined) parts.push(t.profilePart({ value: a.modelProfile }));
  if (a.provider !== undefined) parts.push(t.providerPart({ value: a.provider }));
  if (a.model !== undefined) parts.push(t.modelPart({ value: a.model }));
  if (a.pinned === true) parts.push(t.pinnedPart);
  return (
    <p className="m-0 text-[0.8125rem] sm:col-span-2" data-testid={`applied-${props.runtime}`}>
      <span className="font-bold">{t.appliedTitle}</span>{' '}
      <span className="text-dy-muted">{parts.length === 0 ? t.appliedDefaults : parts.join(' · ')}</span>
    </p>
  );
}

const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** p15-model-picker: the picker's value of a runtime's settings (Pi keeps provider and model apart). */
export function pickerValue(r: ConfigRuntime, s: Partial<RuntimeSettings>): string {
  const m = s.model ?? '';
  if (r !== 'pi' || m === '' || m.includes('/')) return m;
  return s.provider !== undefined && s.provider !== '' ? `${s.provider}/${m}` : m;
}

/** The settings patch of a picked model ('' = the runtime's default; Pi splits `provider/model`). */
export function machineModelPatch(
  r: ConfigRuntime,
  s: Partial<RuntimeSettings>,
  v: string,
): Partial<RuntimeSettings> {
  if (r !== 'pi') return { model: v };
  if (v === '') return { model: '', provider: '' };
  const slash = v.indexOf('/');
  const head = slash > 0 ? v.slice(0, slash) : '';
  if (slash > 0 && PROVIDER.test(head)) return { provider: head, model: v.slice(slash + 1) };
  // A custom id without a provider part keeps the provider that was set.
  return { model: v, provider: s.provider ?? '' };
}

function RuntimeBox(props: { readonly runtime: ConfigRuntime; readonly children: ReactNode }): ReactNode {
  return (
    <fieldset className="m-0 grid min-w-0 gap-3 rounded-[12px] border border-dy-line p-4 sm:grid-cols-2">
      <legend className="px-1 text-[0.9375rem] font-bold">
        <RuntimeMark runtime={RUNTIME_ID[props.runtime]} />
      </legend>
      {props.children}
    </fieldset>
  );
}

export function RuntimesSection(props: {
  readonly draft: Draft;
  readonly setDraft: (d: Draft) => void;
  readonly issues: readonly ApiIssue[];
  readonly view: WorkerConfigView;
}): ReactNode {
  const { draft, setDraft, issues, view } = props;
  const t = useT().machineConfig.sections;
  const mp = useT().modelPicker;
  const catalog = useRuntimeModels();
  if (draft.allowedRuntimes.length === 0)
    return <p className="m-0 text-[0.875rem] text-dy-muted">{t.allowFirst}</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.runtimesIntro}</p>
      {draft.allowedRuntimes.map((r) => {
        const s = draft.runtimes[r] ?? {};
        const set = (patch: Partial<RuntimeSettings>): void => {
          setDraft(setRuntime(draft, r, patch));
        };
        const profiles = view.modelOptions.filter((m) => m.runtimes.includes(r));
        const current = s.modelProfile ?? '';
        const options: [string, string][] = [['', t.noProfile]];
        for (const m of profiles)
          options.push([
            m.id,
            `${m.displayName} (${m.provider}/${m.model})${m.enabled ? '' : ` — ${t.profileOff}`}`,
          ]);
        if (current !== '' && !profiles.some((m) => m.id === current))
          options.push([current, t.policyProfile({ id: current })]);
        const picked = profiles.find((m) => m.id === current);
        const name = RUNTIME_ID[r];
        return (
          <RuntimeBox key={r} runtime={r}>
            <p className="m-0 text-[0.8125rem] text-dy-muted sm:col-span-2">{t.help[HELP_KEY[r]]}</p>
            <DySelect
              label={t.modelProfile({ runtime: name })}
              value={current}
              options={options}
              onChange={(v) => {
                set({ modelProfile: v });
              }}
            />
            {picked !== undefined && !picked.enabled ? (
              <p className="m-0 text-[0.8125rem] font-medium text-dy-amber-ink sm:col-span-2">
                {t.profileDisabled}
              </p>
            ) : null}
            {/* p15-model-picker: the machine's default model from the list (this machine's models first). */}
            <DyModelPicker
              label={r === 'pi' ? t.piModel : r === 'opencode' ? t.openCodeModel : t.model({ runtime: name })}
              runtimes={[r]}
              value={pickerValue(r, s)}
              valueKind="model"
              workerId={view.workerId}
              catalog={catalog}
              defaultLabel={
                picked === undefined
                  ? undefined
                  : mp.defaultWith({
                      value:
                        r === 'pi' || r === 'opencode' ? `${picked.provider}/${picked.model}` : picked.model,
                    })
              }
              hint={r === 'claude-code' || r === 'codex' ? t.modelHint : undefined}
              testId={`model-picker-${r}`}
              onChange={(v) => {
                set(machineModelPatch(r, s, v));
              }}
            />
            {r === 'pi' ? (
              // Parity: a provider alone (Pi then takes that provider's default model) stays possible.
              <DyField
                label={t.piProvider}
                mono
                value={s.provider ?? ''}
                placeholder={picked?.provider ?? t.exampleProvider}
                onChange={(v) => {
                  set({ provider: v });
                }}
              />
            ) : null}
            <AppliedRuntime runtime={r} report={view.report} />
            <div className="sm:col-span-2">
              <FieldIssues issues={issues} prefix={`runtimes.${r}`} />
            </div>
          </RuntimeBox>
        );
      })}
    </div>
  );
}

export function CredentialsSection(props: {
  readonly draft: Draft;
  readonly setDraft: (d: Draft) => void;
  readonly issues: readonly ApiIssue[];
  readonly view: WorkerConfigView;
}): ReactNode {
  const { draft, setDraft, issues, view } = props;
  const pinned = new Set(view.report?.ceiling.pinnedRuntimes ?? []);
  const vaultOk = view.vault.supported;
  const t = useT().machineConfig.sections;
  return (
    <div className="flex flex-col gap-4">
      <DyNotice tone="neutral" icon="key">
        <span data-testid="credentials-intro">
          {t.credentialsIntro}{' '}
          <Link to="/settings/credentials" className="font-medium text-dy-teal-ink">
            {t.credentialsLink}
          </Link>{' '}
          {t.credentialsOutro}
        </span>
      </DyNotice>
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="vault-key">
        {t.vaultKey}{' '}
        {view.vault.keyFingerprint === null ? (
          <span>{vaultOk ? t.vaultKeyPending : t.vaultKeyUnsupported}</span>
        ) : (
          <span className="font-dy-mono break-all text-dy-ink">{view.vault.keyFingerprint}</span>
        )}
      </p>
      {draft.allowedRuntimes.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.authAllowFirst}</p>
      ) : null}
      {draft.allowedRuntimes.map((r) => {
        const auth = draft.runtimes[r]?.auth;
        const mode =
          auth === undefined
            ? ''
            : auth.mode === 'local-login'
              ? 'local-login'
              : auth.credentialRef.source === 'vault'
                ? 'vault'
                : 'worker-store';
        const ref = auth?.mode === 'secret-ref' ? auth.credentialRef : null;
        const setRef = (next: CredentialRef): void => {
          setDraft(setRuntime(draft, r, { auth: { mode: 'secret-ref', credentialRef: next } }));
        };
        const vaultChoice =
          ref?.source === 'vault' ? view.credentialOptions.find((c) => c.id === ref.id) : undefined;
        const name = RUNTIME_ID[r];
        return (
          <RuntimeBox key={r} runtime={r}>
            {pinned.has(r) ? (
              <p className="m-0 text-[0.8125rem] font-medium text-dy-amber-ink sm:col-span-2">
                {t.pinnedLocally}
              </p>
            ) : null}
            <DySelect
              label={t.authLabel({ runtime: name })}
              value={mode}
              options={[
                ['', t.authUnset],
                ['vault', t.authVault],
                ['worker-store', t.authStore],
                ['local-login', t.authLocal],
              ]}
              onChange={(v) => {
                const runtimes = { ...draft.runtimes };
                const cur = { ...(runtimes[r] ?? {}) } as Mutable<RuntimeSettings>;
                if (v === '') delete cur.auth;
                else if (v === 'local-login') cur.auth = { mode: 'local-login' };
                else if (v === 'vault')
                  cur.auth = { mode: 'secret-ref', credentialRef: { source: 'vault', id: '' } };
                else cur.auth = { mode: 'secret-ref', credentialRef: { source: 'worker-store', name: '' } };
                runtimes[r] = cur;
                setDraft({ ...draft, runtimes });
              }}
            />
            {ref?.source === 'vault' ? (
              <DySelect
                label={t.vaultCredential({ runtime: name })}
                value={ref.id}
                options={[
                  ['', t.choose],
                  ...view.credentialOptions
                    .filter((c) => c.state === 'active' || c.id === ref.id)
                    .map(
                      (c) =>
                        [
                          c.id,
                          `${c.name} (${c.kind}, ${c.env})${c.sharedWithWorker ? '' : ` — ${t.notOnMachine}`}`,
                        ] as const,
                    ),
                ]}
                onChange={(v) => {
                  setRef({ ...ref, id: v });
                }}
              />
            ) : null}
            {ref?.source === 'worker-store' ? (
              <DyField
                label={t.secretName({ runtime: name })}
                mono
                value={ref.name}
                placeholder={t.exampleProvider}
                hint={
                  <>
                    {t.onMachine}{' '}
                    <code className="font-dy-mono">{`remyral-worker secret set <${t.nameArg}>`}</code>
                  </>
                }
                onChange={(v) => {
                  setRef({ ...ref, name: v });
                }}
              />
            ) : null}
            {ref !== null ? (
              <DyField
                label={t.envVar({ runtime: name })}
                mono
                value={ref.env ?? ''}
                placeholder={
                  ref.source === 'vault' ? (vaultChoice?.env ?? t.credentialDefault) : t.runtimeDefault
                }
                onChange={(env) => {
                  const { env: _old, ...rest } = ref;
                  setRef(env === '' ? rest : { ...rest, env });
                }}
              />
            ) : null}
            {ref?.source === 'vault' && !vaultOk ? (
              <p className="m-0 text-[0.8125rem] font-medium text-dy-red-ink sm:col-span-2">
                {t.vaultUnsupported}
              </p>
            ) : null}
            {vaultChoice !== undefined && !vaultChoice.sharedWithWorker ? (
              <p
                className="m-0 text-[0.8125rem] font-medium text-dy-amber-ink sm:col-span-2"
                data-testid={`not-shared-${r}`}
              >
                {t.notShared({ name: vaultChoice.name })}
              </p>
            ) : null}
            <div className="sm:col-span-2">
              <FieldIssues issues={issues} prefix={`runtimes.${r}.auth`} />
            </div>
          </RuntimeBox>
        );
      })}
    </div>
  );
}
