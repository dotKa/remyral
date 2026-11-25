import { x25519Supported } from '@remyral/protocol/credential-seal';
import { sshPrivateKeyProblem } from '@remyral/protocol/git-central-rules';
import { type ReactNode, type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import {
  createCredential,
  CREDENTIAL_ID,
  CREDENTIAL_KINDS,
  type CredentialKind,
  type CredentialView,
  credentialValueProblem,
  DEFAULT_CREDENTIAL_ENV,
  envProblem,
  HOST_BOUND_KINDS,
  GIT_KINDS,
  listCredentials,
  parseAllowedHosts,
  listVaultWorkers,
  revokeCredential,
  rotateCredentialValue,
  rotateWorkerVaultKey,
  setCredentialProjects,
  unshareCredential,
  type VaultWorker,
} from '../../../api/vault';
import { DyPager } from '../../common/pager';
import { DySortBar, sortRows, useSortParam } from '../../common/sort';
import { useClientPage } from '../../../lib/pager';
import { sealable, sealFailure, sealForWorkers } from '../../../screens/credentialSeal';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { listProjects, type Project } from '../../../api/directory';
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
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DyTime } from '../records';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { toast } from '../../toast/store';

const KEY_SORT_KEYS = ['machine'] as const;
const KEY_COMPARE = {
  machine: (a: VaultWorker, b: VaultWorker): number => a.displayName.localeCompare(b.displayName),
} as const;
const CRED_SORT_KEYS = ['name'] as const;
const CRED_COMPARE = {
  name: (a: CredentialView, b: CredentialView): number => a.name.localeCompare(b.name),
} as const;

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Kimlik bilgileri in the Diyalog language, feature for feature with the classic
 * `CredentialsPage` (p5-credentials-models, ADR-0016). Write-only vault: a value is typed here, sealed in this
 * browser to each selected machine's X25519 vault key with the classic `sealForWorkers` (the protocol's
 * `credential-seal`), and only the ciphertext is sent; the field is cleared before anything leaves the page. No
 * value is ever shown again. Add, replace / share (new version), remove from one machine, revoke everywhere and
 * rotate a machine's vault key — every write through step-up. Without X25519 in WebCrypto nothing can be sealed.
 */

type VaultText = Messages['settings']['vault'];

const KIND_KEY: Readonly<
  Record<
    Exclude<CredentialKind, 'http-auth' | 'smtp' | 'git-ssh-key' | 'git-https-token'>,
    keyof VaultText['kinds']
  >
> = {
  anthropic: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
  gemini: 'gemini',
  'custom-openai-compatible': 'customOpenaiCompatible',
  'github-token': 'githubToken',
  generic: 'generic',
};

/** The kind's words (p14-workflow-engine 14.3: the host-bound kinds come from the catalog). */
function kindWord(t: Messages, k: CredentialKind): string {
  if (k === 'http-auth') return t.settings.credentials.kinds.httpAuth;
  if (k === 'smtp') return t.settings.credentials.kinds.smtp;
  // p15-git-central: repository credentials.
  if (k === 'git-ssh-key') return t.gitCentral.vault.kinds.gitSshKey;
  if (k === 'git-https-token') return t.gitCentral.vault.kinds.gitHttpsToken;
  return t.settings.vault.kinds[KIND_KEY[k]];
}

/**
 * The classic vault checks (`credentialValueProblem`, `envProblem`) return English sentences; these are their catalog
 * keys, so the user reads them in their language. Unknown texts pass as is.
 */
const PROBLEM_KEY: Readonly<Record<string, keyof VaultText['problems']>> = {
  'This is a Claude subscription (OAuth) token. The platform never stores subscription logins — use “Local login on the machine” for Claude Code instead (ADR-0014).':
    'claudeOauth',
  'At least 6 characters.': 'minLength',
  'At most 16 KiB.': 'maxSize',
  'Must not contain a NUL character.': 'nul',
  'An environment variable name (A–Z, 0–9, _).': 'envName',
  'Subscription tokens are never injected; use local login.': 'subscriptionEnv',
  'This variable controls how programs load code; it cannot carry a credential.': 'loaderEnv',
};
function problemText(t: VaultText, p: string | null): string | null {
  if (p === null) return null;
  const key = PROBLEM_KEY[p];
  return key === undefined ? p : t.problems[key];
}

const STATUS: Readonly<Record<string, { key: keyof VaultText['status']; tone: Tone; icon: IconName }>> = {
  pending: { key: 'pending', tone: 'teal', icon: 'retry' },
  applied: { key: 'applied', tone: 'green', icon: 'checkc' },
  rejected: { key: 'rejected', tone: 'red', icon: 'xc' },
  revoking: { key: 'revoking', tone: 'neutral', icon: 'clock' },
  revoked: { key: 'revoked', tone: 'neutral', icon: 'xc' },
  needs_reseal: { key: 'needsReseal', tone: 'amber', icon: 'key' },
  unsupported: { key: 'unsupported', tone: 'amber', icon: 'shield' },
};

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

function WorkerPicker(props: {
  readonly workers: readonly VaultWorker[];
  readonly selected: readonly string[];
  readonly onChange: (ids: string[]) => void;
  readonly legend: string;
  readonly error?: string | null;
}): ReactNode {
  const t = useT().settings.vault;
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-[0.8125rem] font-bold">{props.legend}</legend>
      {props.workers.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noMachines}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {props.workers.map((w) => (
          <li key={w.workerId}>
            <label
              className={`flex min-h-11 items-start gap-2.5 py-1 text-[0.875rem] md:min-h-0 ${sealable(w) ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--dy-teal)]"
                disabled={!sealable(w)}
                checked={props.selected.includes(w.workerId)}
                onChange={(e) => {
                  props.onChange(
                    e.target.checked
                      ? [...props.selected, w.workerId]
                      : props.selected.filter((x) => x !== w.workerId),
                  );
                }}
              />
              <span className="min-w-0">
                <span className="font-medium" translate="no">
                  {w.displayName}
                </span>
                <span className="block font-dy-mono text-[0.75rem] break-all text-dy-muted">
                  {w.key === null ? (w.supported ? t.noVaultKey : t.vaultUnsupported) : w.key.fingerprint}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {props.error === undefined || props.error === null ? null : (
        <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{props.error}</p>
      )}
    </fieldset>
  );
}

function ValueField(props: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly error: string | null;
  /** p15-git-central: an SSH deploy key is multi-line (a password field would lose its line breaks). */
  readonly kind?: CredentialKind;
}): ReactNode {
  const all = useT();
  const t = all.settings.vault;
  if (props.kind === 'git-ssh-key') {
    return (
      <DyTextarea
        label={all.gitCentral.vault.keyValue}
        value={props.value}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        mono
        error={props.error}
        hint={all.gitCentral.vault.keyHint}
        data-testid="credential-ssh-key"
        onChange={props.onChange}
      />
    );
  }
  return (
    <DyField
      label={t.value}
      type="password"
      autoComplete="new-password"
      spellCheck={false}
      value={props.value}
      error={props.error}
      hint={t.valueHint}
      onChange={props.onChange}
    />
  );
}

function AddCredential(props: {
  readonly workers: readonly VaultWorker[];
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onDone: (c: CredentialView) => void;
}): ReactNode {
  const t = useT();
  const tc = t.settings.credentials;
  const tv = t.settings.vault;
  const submit = useSubmit();
  const guarded = useStepUpRun();
  const [hostsText, setHostsText] = useState('');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CredentialKind>('anthropic');
  const [env, setEnv] = useState(DEFAULT_CREDENTIAL_ENV.anthropic);
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!CREDENTIAL_ID.test(id)) errs.id = tv.idRule;
    if (name.trim() === '') errs.name = tv.required;
    const ep = problemText(tv, envProblem(env));
    if (ep !== null) errs.env = ep;
    const vp = problemText(tv, credentialValueProblem(value));
    if (vp !== null) errs.value = vp;
    // p15-git-central: a deploy key must be an unencrypted private key (the worker refuses anything else too).
    const kp = kind === 'git-ssh-key' && vp === null ? sshPrivateKeyProblem(value) : null;
    if (kp !== null) errs.value = t.gitCentral.vault.keyProblems[kp];
    if (selected.length === 0) errs.workers = tv.pickMachine;
    const bound = HOST_BOUND_KINDS.has(kind);
    const parsedHosts = parseAllowedHosts(hostsText);
    if (bound) {
      if (!parsedHosts.ok) errs.allowedHosts = tc.allowedHostsBad({ host: parsedHosts.bad });
      else if (parsedHosts.hosts.length === 0) errs.allowedHosts = tc.allowedHostsRequired;
    }
    const allowedHosts = bound && parsedHosts.ok ? parsedHosts.hosts : null;
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const targets = props.workers.filter((w) => selected.includes(w.workerId));
    void submit.run(async () => {
      const plain = value;
      // Clear the field before anything leaves the browser; only ciphertext is kept from here on.
      setValue('');
      const sealed = await sealForWorkers(plain, targets, { id, kind, env, version: 1 }).catch(
        (err: unknown) => {
          throw sealFailure(err);
        },
      );
      await guarded(async () => {
        const created = await createCredential({
          id,
          name: name.trim(),
          kind,
          env,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(allowedHosts === null ? {} : { allowedHosts }),
          workers: sealed,
        });
        setHostsText('');
        setId('');
        setName('');
        setDescription('');
        setSelected([]);
        props.onDone(created);
      }, tv.addStepUp);
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label={tv.add} className="grid gap-3 sm:grid-cols-2">
      <DyField
        label={tv.id}
        value={id}
        mono
        autoComplete="off"
        spellCheck={false}
        placeholder={tv.idPlaceholder}
        error={errors.id ?? null}
        onChange={(v) => {
          setId(v.trim().toLowerCase());
        }}
      />
      <DyField label={tv.name} value={name} error={errors.name ?? null} onChange={setName} />
      <DySelect
        label={tv.kind}
        value={kind}
        options={CREDENTIAL_KINDS.map((k) => [k, kindWord(t, k)] as const)}
        onChange={(v) => {
          const k = v as CredentialKind;
          // Follow the kind's default env var unless the admin typed another one (classic rule).
          if (env === DEFAULT_CREDENTIAL_ENV[kind]) setEnv(DEFAULT_CREDENTIAL_ENV[k]);
          setKind(k);
        }}
      />
      <DyField
        label={tv.env}
        value={env}
        mono
        spellCheck={false}
        error={errors.env ?? null}
        hint={tv.envHint}
        onChange={(v) => {
          setEnv(v.trim());
        }}
      />
      {HOST_BOUND_KINDS.has(kind) ? (
        <div className="grid gap-1 sm:col-span-2">
          <DyTextarea
            label={tc.allowedHosts}
            value={hostsText}
            rows={3}
            spellCheck={false}
            className="font-dy-mono"
            placeholder={tc.allowedHostsPlaceholder}
            hint={tc.allowedHostsHint}
            error={errors.allowedHosts ?? null}
            data-testid="credential-allowed-hosts"
            onChange={setHostsText}
          />
          <p className="m-0 text-[0.78125rem] text-dy-muted">{tc.functionOnly}</p>
        </div>
      ) : null}
      <DyField
        label={tv.description}
        value={description}
        maxLength={500}
        placeholder={tv.descriptionPlaceholder}
        wrapClassName="sm:col-span-2"
        onChange={setDescription}
      />
      <div className="sm:col-span-2">
        <WorkerPicker
          legend={tv.targets}
          workers={props.workers}
          selected={selected}
          onChange={setSelected}
          error={errors.workers ?? null}
        />
      </div>
      {GIT_KINDS.has(kind) ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted sm:col-span-2">{t.gitCentral.vault.gitOnly}</p>
      ) : null}
      <div className="sm:col-span-2">
        <ValueField value={value} kind={kind} onChange={setValue} error={errors.value ?? null} />
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        <FormActions>
          <DyButton type="submit" variant="primary" icon="key" busy={submit.busy} disabled={props.disabled}>
            {tv.sealAdd}
          </DyButton>
          <DyButton variant="ghost" onClick={props.onCancel}>
            {tv.cancel}
          </DyButton>
        </FormActions>
      </div>
    </form>
  );
}

function ReplaceValue(props: {
  readonly credential: CredentialView;
  readonly workers: readonly VaultWorker[];
  readonly disabled: boolean;
  readonly onDone: (c: CredentialView) => void;
}): ReactNode {
  const c = props.credential;
  const t = useT().settings.vault;
  const submit = useSubmit();
  const guarded = useStepUpRun();
  const [selected, setSelected] = useState<string[]>(
    c.workers.filter((w) => w.status !== 'revoked' && w.status !== 'revoking').map((w) => w.workerId),
  );
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    const vp = problemText(t, credentialValueProblem(value));
    if (vp !== null || selected.length === 0) {
      setError(vp ?? t.pickMachine);
      return;
    }
    setError(null);
    const targets = props.workers.filter((w) => selected.includes(w.workerId));
    void submit.run(async () => {
      const plain = value;
      setValue('');
      const version = c.version + 1;
      const sealed = await sealForWorkers(plain, targets, {
        id: c.id,
        kind: c.kind,
        env: c.env,
        version,
      }).catch((err: unknown) => {
        throw sealFailure(err);
      });
      await guarded(async () => {
        props.onDone(await rotateCredentialValue(c.id, { expectedVersion: c.version, workers: sealed }));
      }, t.replaceStepUp);
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={t.replaceAria({ id: c.id })}
      className="flex flex-col gap-3 border-t border-dy-line pt-4"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{t.newValue}</h3>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.replaceBody({ version: c.version + 1 })}</p>
      <WorkerPicker legend={t.machines} workers={props.workers} selected={selected} onChange={setSelected} />
      <ValueField value={value} kind={c.kind} onChange={setValue} error={error} />
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <FormActions>
        <DyButton type="submit" variant="primary" icon="key" busy={submit.busy} disabled={props.disabled}>
          {t.sealVersion}
        </DyButton>
      </FormActions>
    </form>
  );
}

/** One machine's copy: name, version and delivery state (word + icon + tone; the reason as text). */
function Delivery(props: { readonly credential: CredentialView; readonly index: number }): ReactNode {
  const c = props.credential;
  const t = useT().settings.vault;
  const w = c.workers[props.index];
  if (w === undefined) return null;
  const known = STATUS[w.status];
  const st =
    known === undefined
      ? { word: w.status, tone: 'neutral' as Tone, icon: 'flag' as IconName }
      : { word: t.status[known.key], tone: known.tone, icon: known.icon };
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span translate="no">{w.displayName}</span>
      <span data-testid={`status-${c.id}-${w.workerId}`} title={w.reason ?? undefined}>
        <Pill tone={st.tone} icon={st.icon}>
          {`v${String(w.version)}`} · {st.word}
        </Pill>
      </span>
      {w.reason === null ? null : <span className="text-[0.78125rem] text-dy-muted">{w.reason}</span>}
    </span>
  );
}

/**
 * p22-vault-projects: which projects may use a workflow HTTP / SMTP credential — every project (the default) or the
 * chosen ones. Saved with step-up; unknown projects are refused by the master.
 */
function CredentialProjects(props: {
  readonly credential: CredentialView;
  readonly disabled: boolean;
  readonly onChanged: (c: CredentialView) => void;
}): ReactNode {
  const c = props.credential;
  const t = useT().settings.credentials;
  const load = useSubmit();
  const save = useSubmit();
  const guarded = useStepUpRun();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [mode, setMode] = useState<'all' | 'chosen'>(c.projects === null ? 'all' : 'chosen');
  const [chosen, setChosen] = useState<string[]>(c.projects === null ? [] : [...c.projects]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load.run(async () => {
      setProjects(await listProjects());
    });
  }, []);

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (mode === 'chosen' && chosen.length === 0) {
      setError(t.projectsPick);
      return;
    }
    setError(null);
    const next = mode === 'all' ? null : [...chosen].sort();
    void save.run(() =>
      guarded(async () => {
        props.onChanged(await setCredentialProjects(c.id, next));
        toast.success(t.projectsSaved, { id: 'vault-projects-saved', testId: 'vault-projects-saved' });
      }, t.projectsStepUp),
    );
  }

  // A project the allowlist names that this account cannot see (or that was removed) stays listed by its id.
  const known = new Set((projects ?? []).map((p) => p.id));
  const extra = chosen.filter((id) => !known.has(id));
  return (
    <form
      onSubmit={onSubmit}
      aria-label={t.projectsAria({ id: c.id })}
      className="flex flex-col gap-3 border-t border-dy-line pt-4"
      data-testid="credential-projects"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{t.projects}</h3>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.projectsHint}</p>
      <DySelect
        label={t.projectsMode}
        value={mode}
        options={[
          ['all', t.projectsAll],
          ['chosen', t.projectsChosen],
        ]}
        onChange={(v) => {
          setMode(v === 'chosen' ? 'chosen' : 'all');
        }}
      />
      {mode === 'chosen' ? (
        <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
          <legend className="mb-1 text-[0.8125rem] font-bold">{t.projectsList}</legend>
          {projects === null ? (
            load.error === null ? (
              <SkeletonRows label={t.projectsLoading} rows={2} />
            ) : null
          ) : projects.length === 0 && extra.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.projectsNone}</p>
          ) : (
            [
              ...projects.map((p) => ({ id: p.id, name: p.name })),
              ...extra.map((id) => ({ id, name: id })),
            ].map((p) => (
              <DyCheck
                key={p.id}
                testId={`credential-project-${p.id}`}
                label={
                  <>
                    {p.name}{' '}
                    <span className="font-dy-mono text-[0.75rem] text-dy-muted" translate="no">
                      {p.id}
                    </span>
                  </>
                }
                checked={chosen.includes(p.id)}
                onChange={(on) => {
                  setChosen((list) => (on ? [...list, p.id] : list.filter((x) => x !== p.id)));
                }}
              />
            ))
          )}
          {error === null ? null : (
            <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{error}</p>
          )}
        </fieldset>
      ) : null}
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton type="submit" icon="shield" busy={save.busy} disabled={props.disabled}>
          {t.projectsSave}
        </DyButton>
      </FormActions>
    </form>
  );
}

function ManageCredential(props: {
  readonly credential: CredentialView;
  readonly workers: readonly VaultWorker[];
  readonly disabled: boolean;
  readonly onChanged: (c: CredentialView) => void;
  readonly onDone: (c: CredentialView) => void;
}): ReactNode {
  const c = props.credential;
  const act = useSubmit();
  const guarded = useStepUpRun();
  const t = useT().settings.vault;
  const holders = c.workers.filter((w) => w.status !== 'revoked' && w.status !== 'revoking');
  return (
    <div className="flex flex-col gap-4">
      {holders.length > 0 ? (
        <section aria-label={t.machinesOf({ id: c.id })} className="flex flex-col gap-2">
          <h3 className="m-0 text-[0.875rem] font-bold">{t.onMachines}</h3>
          <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-dy-line p-0">
            {holders.map((w) => (
              <li
                key={w.workerId}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-dy-line px-3 py-1.5 text-[0.875rem] first:border-t-0"
              >
                <Delivery credential={c} index={c.workers.indexOf(w)} />
                <ConfirmButton
                  label={t.unshare}
                  variant="ghost"
                  question={t.unshareQuestion({ id: c.id, machine: w.displayName })}
                  confirmLabel={t.unshareConfirm}
                  disabled={act.busy || props.disabled}
                  testId={`unshare-${w.workerId}`}
                  ariaLabel={t.unshareAria({ machine: w.displayName })}
                  onConfirm={() =>
                    void act.run(() =>
                      guarded(async () => {
                        props.onChanged(await unshareCredential(c.id, [w.workerId]));
                      }, t.unshareStepUp),
                    )
                  }
                />
              </li>
            ))}
          </ul>
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
        </section>
      ) : null}
      {HOST_BOUND_KINDS.has(c.kind) ? (
        <CredentialProjects credential={c} disabled={props.disabled} onChanged={props.onChanged} />
      ) : null}
      <ReplaceValue credential={c} workers={props.workers} disabled={props.disabled} onDone={props.onDone} />
    </div>
  );
}

function WorkerKeys(props: { readonly workers: readonly VaultWorker[] }): ReactNode {
  const act = useSubmit();
  const guarded = useStepUpRun();
  const t = useT().settings.vault;
  // The classic tables' sortable columns (machine / name, ascending first), kept in the URL (`?keysSort=`).
  const [keySort, setKeySort] = useSortParam(KEY_SORT_KEYS, {
    prefix: 'keys',
    initial: { key: 'machine', dir: 'asc' },
  });
  const byName = sortRows(props.workers, keySort, KEY_COMPARE);
  const { pageItems, pagination } = useClientPage(byName, {
    label: t.keyPages,
    prefix: 'keys',
  });
  return (
    <>
      <Panel
        title={t.keysTitle}
        sub={
          <>
            {t.keysSubA}
            <span className="font-dy-mono">remyral-worker vault key</span>
            {/* i18n-ignore: version, product or permission name */}
            {t.keysSubB}
          </>
        }
        flush
        testId="dy-vault-keys"
      >
        {props.workers.length === 0 ? (
          <EmptyLine>{t.keysEmpty}</EmptyLine>
        ) : (
          <>
            <DySortBar
              keys={KEY_SORT_KEYS}
              labels={{ machine: t.sortMachine }}
              sort={keySort}
              onSort={setKeySort}
              defaultNote={t.serverOrder}
              sortedNote={t.machinesSorted}
              className="border-b border-dy-line"
              testId="vault-key-sort"
            />
            <Rows label={t.keysTitle}>
              {pageItems.map((w) => (
                <Row
                  key={w.workerId}
                  lead={<DyIcon name="key" className="size-4" />}
                  tone={w.key === null ? 'amber' : undefined}
                  title={<span translate="no">{w.displayName}</span>}
                  meta={
                    w.key === null ? (
                      <span data-testid={`key-${w.workerId}`}>
                        {w.supported ? t.noKey : t.keyUnsupported}
                      </span>
                    ) : (
                      <span className="font-dy-mono break-all" data-testid={`key-${w.workerId}`}>
                        {w.key.fingerprint}
                      </span>
                    )
                  }
                  actions={
                    w.supported ? (
                      <DyButton
                        variant="ghost"
                        icon="retry"
                        aria-label={t.rotateAria({ machine: w.displayName })}
                        disabled={act.busy || !w.connected}
                        onClick={() =>
                          void act.run(() =>
                            guarded(async () => {
                              await rotateWorkerVaultKey(w.workerId);
                              // p17-toasts-rest: "requested" is a transient result → toast.
                              toast.success(t.rotateRequested({ machine: w.displayName }), {
                                id: 'vault-rotate-requested',
                                testId: 'vault-rotate-requested',
                              });
                            }, t.rotateStepUp),
                          )
                        }
                      >
                        {t.rotate}
                      </DyButton>
                    ) : undefined
                  }
                />
              ))}
            </Rows>
          </>
        )}
      </Panel>
      <DyPager {...pagination} />
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </>
  );
}

export function CredentialsView(): ReactNode {
  const location = useLocation();
  const focusId = /^#credential-([a-z0-9][a-z0-9_-]{0,47})$/.exec(location.hash)?.[1] ?? null;
  // p16-assistant-admin: the assistant's open_credential_rotation link (?replace=<id>) opens that credential's "new
  // value" form; the value is typed and sealed here, never in the chat.
  const replaceId =
    /^[a-z0-9][a-z0-9_-]{0,47}$/.exec(new URLSearchParams(location.search).get('replace') ?? '')?.[0] ?? null;
  const t = useT();
  const tv = t.settings.vault;
  const [workers, setWorkers] = useState<VaultWorker[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialView[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useStepUpRun();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [w, c] = await Promise.all([listVaultWorkers(), listCredentials()]);
      setWorkers(w);
      setCredentials(c);
    });
  }, [load]);

  useEffect(() => {
    void refresh();
    void x25519Supported().then(setSupported);
  }, []);

  useEffect(() => {
    if (replaceId !== null && credentials?.some((c) => c.id === replaceId) === true) setManaging(replaceId);
  }, [replaceId, credentials !== null]);

  const replace = (c: CredentialView): void => {
    setCredentials((list) => {
      const rest = (list ?? []).filter((x) => x.id !== c.id);
      return [c, ...rest].sort((a, b) => a.id.localeCompare(b.id));
    });
  };

  const disabled = supported !== true;
  const managed = credentials?.find((c) => c.id === managing) ?? null;
  const [sort, setSort] = useSortParam(CRED_SORT_KEYS, { initial: { key: 'name', dir: 'asc' } });
  const byName = sortRows(credentials ?? [], sort, CRED_COMPARE);
  const page = useClientPage(byName, { label: tv.pages });

  return (
    <div className="flex flex-col gap-4" data-testid="dy-credentials">
      {supported === false ? (
        <DyNotice tone="red" title={tv.noX25519Title}>
          <span data-testid="x25519-unsupported">{tv.noX25519}</span>
        </DyNotice>
      ) : null}
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {workers === null || credentials === null ? (
        load.error === null ? (
          <Panel title={tv.title} flush>
            <SkeletonRows label={tv.loading} rows={3} />
          </Panel>
        ) : null
      ) : (
        <>
          <Panel
            title={tv.title}
            count={String(credentials.length)}
            countLabel={tv.count({ n: credentials.length })}
            sub={tv.sub}
            aside={
              <DyButton
                variant="primary"
                icon="plus"
                onClick={() => {
                  setAdding(true);
                }}
              >
                {tv.add}
              </DyButton>
            }
            flush
            testId="credential-table"
          >
            {credentials.length === 0 ? (
              <EmptyLine>{tv.empty}</EmptyLine>
            ) : (
              <>
                <DySortBar
                  keys={CRED_SORT_KEYS}
                  labels={{ name: tv.sortName }}
                  sort={sort}
                  onSort={setSort}
                  defaultNote={tv.serverOrder}
                  sortedNote={tv.sorted}
                  className="border-b border-dy-line"
                  testId="credential-sort"
                />
                <Rows label={tv.title}>
                  {page.pageItems.map((c) => (
                    <Row
                      key={c.id}
                      testId="credential-row"
                      // p15-chat-vault: a chat credential chip links here (#credential-<id>): that row is marked.
                      {...(focusId === c.id ? { className: 'bg-dy-amber-soft' } : {})}
                      lead={<DyIcon name="key" className="size-4" />}
                      tone={c.state === 'revoked' ? 'neutral' : undefined}
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          {c.name}
                          <span className="font-dy-mono text-[0.78125rem] font-normal text-dy-muted">
                            {c.id}
                          </span>
                          {c.state === 'revoked' ? (
                            <Pill tone="neutral" icon="xc">
                              {tv.revokedPill}
                            </Pill>
                          ) : null}
                        </span>
                      }
                      meta={
                        <>
                          <span>{kindWord(t, c.kind)}</span>
                          <span className="font-dy-mono">{c.env}</span>
                          <span className="tabular-nums">v{c.version}</span>
                          {/* i18n-ignore: version, product or permission name */}
                          <span>
                            {c.lastUsedAt === null ? (
                              tv.neverUsed
                            ) : (
                              <>
                                {tv.lastUsed} <DyTime iso={c.lastUsedAt} />
                              </>
                            )}
                          </span>
                          {c.description === null ? null : <span className="w-full">{c.description}</span>}
                          {c.allowedHosts === null || c.allowedHosts.length === 0 ? null : (
                            <span className="w-full font-dy-mono" data-testid={`credential-hosts-${c.id}`}>
                              {t.settings.credentials.allowedHostsShown({ hosts: c.allowedHosts.join(', ') })}
                            </span>
                          )}
                          {HOST_BOUND_KINDS.has(c.kind) ? (
                            <span className="w-full" data-testid={`credential-projects-${c.id}`}>
                              {c.projects === null
                                ? t.settings.credentials.projectsShownAll
                                : t.settings.credentials.projectsShown({ projects: c.projects.join(', ') })}
                            </span>
                          ) : null}
                          <span
                            className="flex w-full flex-col gap-1"
                            aria-label={tv.machinesOf({ id: c.id })}
                          >
                            {c.workers.length === 0
                              ? tv.nowhere
                              : c.workers.map((w, i) => (
                                  <Delivery key={w.workerId} credential={c} index={i} />
                                ))}
                          </span>
                        </>
                      }
                      actions={
                        c.state === 'revoked' ? undefined : (
                          <>
                            <DyButton
                              disabled={disabled}
                              onClick={() => {
                                setManaging(c.id);
                              }}
                            >
                              {tv.replaceShare}
                            </DyButton>
                            <ConfirmButton
                              label={tv.revoke}
                              question={tv.revokeQuestion({ id: c.id })}
                              disabled={act.busy || disabled}
                              testId={`revoke-${c.id}`}
                              onConfirm={() =>
                                void act.run(() =>
                                  guarded(async () => {
                                    replace(await revokeCredential(c.id));
                                  }, tv.revokeStepUp),
                                )
                              }
                            />
                          </>
                        )
                      }
                    />
                  ))}
                </Rows>
              </>
            )}
          </Panel>
          <DyPager {...page.pagination} />
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          <WorkerKeys workers={workers} />
          <DyDialog
            open={adding}
            onClose={() => {
              setAdding(false);
            }}
            size="lg"
            title={tv.add}
            description={tv.addHint}
          >
            <AddCredential
              workers={workers}
              disabled={disabled}
              onCancel={() => {
                setAdding(false);
              }}
              onDone={(c) => {
                setAdding(false);
                replace(c);
              }}
            />
          </DyDialog>
          <DyDialog
            open={managed !== null}
            onClose={() => {
              setManaging(null);
            }}
            size="lg"
            title={managed === null ? tv.credential : tv.replaceTitle({ name: managed.name })}
            description={tv.replaceHint}
          >
            {managed !== null ? (
              <ManageCredential
                key={managed.id}
                credential={managed}
                workers={workers}
                disabled={disabled}
                onChanged={replace}
                onDone={(next) => {
                  setManaging(null);
                  replace(next);
                }}
              />
            ) : null}
          </DyDialog>
        </>
      )}
    </div>
  );
}
