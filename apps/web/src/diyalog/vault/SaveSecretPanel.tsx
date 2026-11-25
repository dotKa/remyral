import { CREDENTIAL_TOKEN_NAME, SECRET_PROVIDERS, type SecretProvider } from '@remyral/protocol/chat-secrets';
import { type ReactNode, useEffect, useState } from 'react';
import {
  type CredentialView,
  envProblem,
  listCredentials,
  listVaultWorkers,
  parseAllowedHosts,
  type VaultWorker,
} from '../../api/vault';
import type { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { sealFailure } from '../../screens/credentialSeal';
import { useSubmit } from '../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyApiError, DyField, DyTextarea, FormActions } from '../screens/forms';
import { DyButton, DySelect } from '../screens/parts';
import { type ChatCredentialKind, holders, sealAndCreate, vaultKindOf } from './saveCredential';

/**
 * p15-chat-vault: the "Kasaya kaydet" panel — under the composer's pasted-secret warning and on the assistant's
 * `credential_save` card. Name (provider-based), kind (HTTP authentication with allowed hosts / API key / generic) and
 * machines; the value comes from this tab's memory (`value`) or, when the tab no longer has it, from a password field
 * here. Sealing happens in this browser; nothing else ever sees the value.
 */
export function SaveSecretPanel(props: {
  readonly value: string | null;
  readonly provider: SecretProvider;
  readonly initialName: string;
  readonly initialKind?: ChatCredentialKind | undefined;
  readonly initialHosts?: readonly string[] | undefined;
  readonly onSaved: (c: CredentialView) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().chatVault.save;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const facts = SECRET_PROVIDERS[props.provider];
  const [name, setName] = useState(props.initialName);
  const [kind, setKind] = useState<ChatCredentialKind>(
    props.initialKind ?? (facts.hosts.length > 0 ? 'http-auth' : 'generic'),
  );
  const [hostsText, setHostsText] = useState((props.initialHosts ?? facts.hosts).join('\n'));
  const [typed, setTyped] = useState('');
  const [workers, setWorkers] = useState<VaultWorker[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([listVaultWorkers(), listCredentials()]).then(
      ([w, c]) => {
        if (!live) return;
        setWorkers(w);
        setCredentials(c);
      },
      (err: unknown) => {
        if (live) setLoadError(sealFailure(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const vaultKind = vaultKindOf(kind, props.provider);
  const able = workers === null ? [] : holders(workers, vaultKind);
  const chosen = selected ?? able.map((w) => w.workerId);

  // Not a <form>: the panel sits inside the composer's form (nested forms are invalid; Enter would send the message).
  function save(): void {
    const errs: Record<string, string> = {};
    if (!CREDENTIAL_TOKEN_NAME.test(name) || envProblem(name) !== null) errs.name = t.nameRule;
    else if (credentials.some((c) => c.state === 'active' && c.name === name)) errs.name = t.nameTaken;
    const parsed = parseAllowedHosts(hostsText);
    if (kind === 'http-auth') {
      if (!parsed.ok) errs.hosts = t.hostsBad({ host: parsed.bad });
      else if (parsed.hosts.length === 0) errs.hosts = t.hostsRequired;
    }
    const targets = able.filter((w) => chosen.includes(w.workerId));
    if (targets.length === 0) errs.workers = t.pickMachine;
    const value = props.value ?? typed;
    if (value === '') errs.value = t.valueHint;
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    void submit.run(async () => {
      try {
        await stepUp.run(async () => {
          const created = await sealAndCreate({
            value,
            name,
            kind,
            provider: props.provider,
            allowedHosts: parsed.ok ? parsed.hosts : [],
            workers: targets,
            takenIds: new Set(credentials.map((c) => c.id)),
          });
          setTyped('');
          props.onSaved(created);
        }, t.stepUp);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  }

  return (
    <div
      role="form"
      aria-label={t.title}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          e.stopPropagation();
          save();
        }
      }}
      data-testid="vault-save-panel"
      className="grid gap-2.5 rounded-xl border border-dy-line-2 bg-dy-card p-3"
    >
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.intro}</p>
      <DyField
        label={t.name}
        value={name}
        mono
        spellCheck={false}
        autoComplete="off"
        hint={t.nameHint}
        error={errors.name ?? null}
        onChange={(v) => {
          setName(v.trim());
        }}
      />
      <DySelect
        label={t.kind}
        value={kind}
        options={(['http-auth', 'api-token', 'generic'] as const).map((k) => [k, t.kinds[k]] as const)}
        onChange={(v) => {
          setKind(v as ChatCredentialKind);
          setSelected(null);
        }}
      />
      {kind === 'http-auth' ? (
        <DyTextarea
          label={t.hosts}
          value={hostsText}
          rows={2}
          mono
          spellCheck={false}
          hint={t.hostsHint}
          error={errors.hosts ?? null}
          data-testid="vault-save-hosts"
          onChange={setHostsText}
        />
      ) : null}
      <fieldset className="m-0 grid gap-1 border-0 p-0">
        <legend className="mb-1 text-[0.8125rem] font-bold">{t.machines}</legend>
        {workers !== null && able.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noMachines}</p>
        ) : null}
        {able.map((w) => (
          <label key={w.workerId} className="flex items-center gap-2 text-[0.875rem]">
            <input
              type="checkbox"
              className="size-4 accent-[var(--dy-teal)]"
              checked={chosen.includes(w.workerId)}
              onChange={(e) => {
                setSelected(
                  e.target.checked ? [...chosen, w.workerId] : chosen.filter((x) => x !== w.workerId),
                );
              }}
            />
            <span translate="no">{w.displayName}</span>
          </label>
        ))}
        <p className="m-0 text-[0.75rem] text-dy-muted">{t.machinesHint}</p>
        {errors.workers === undefined ? null : (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{errors.workers}</p>
        )}
      </fieldset>
      {props.value === null ? (
        <DyField
          label={t.value}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={typed}
          hint={t.valueHint}
          error={errors.value ?? null}
          onChange={setTyped}
        />
      ) : null}
      <DyApiError error={submit.error ?? loadError} retryLeft={submit.retryLeft} />
      <FormActions>
        <DyButton variant="primary" icon="key" busy={submit.busy} disabled={workers === null} onClick={save}>
          {t.submit}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </FormActions>
    </div>
  );
}
