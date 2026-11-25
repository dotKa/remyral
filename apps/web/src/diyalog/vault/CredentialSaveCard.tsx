import { type SecretProvider, SECRET_PROVIDERS } from '@remyral/protocol/chat-secrets';
import { type ReactNode, useState } from 'react';
import { type ChatDraft, dismissDraft, markCredentialSaved } from '../../api/chat';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { KeyValue } from '../KeyValue';
import { CardButton, LiveCard } from '../LiveCard';
import { cardFor } from '../registry';
import { type DyState, StateBadge } from '../StateBadge';
import { forgetSecret, pastedSecret } from './pastedSecrets';
import { SaveSecretPanel } from './SaveSecretPanel';
import type { ChatCredentialKind } from './saveCredential';

/**
 * p15-chat-vault: the assistant's "kasaya kaydet" card (`credential_save`, propose_credential_save). The assistant only
 * proposed name / kind / hosts; this browser completes it: the pasted value comes from this tab's memory (the handle in
 * the card), or the person pastes it here again; it is sealed here to the chosen machines' vault keys
 * (POST /vault/credentials), then the card is marked done with the new credential's id. The master never sees it.
 */

const STATE: Readonly<Record<string, DyState>> = {
  proposed: 'needs',
  confirmed: 'done',
  dismissed: 'cancelled',
  expired: 'stale',
};

function provider(v: unknown): SecretProvider {
  return typeof v === 'string' && Object.hasOwn(SECRET_PROVIDERS, v) ? (v as SecretProvider) : 'generic';
}

export function CredentialSaveCard(props: {
  readonly d: ChatDraft;
  readonly threadId: string;
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT();
  const tv = t.chatVault;
  const sayError = useErrorText();
  const { d } = props;
  const p = d.payload;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handle = typeof p.secret === 'string' ? p.secret : null;
  const held = handle === null ? undefined : pastedSecret(handle);
  const name = typeof p.name === 'string' ? p.name : 'API_KEY_1';
  const kind: ChatCredentialKind =
    p.kind === 'http-auth' || p.kind === 'api-token' || p.kind === 'generic' ? p.kind : 'generic';
  const hosts = Array.isArray(p.allowedHosts)
    ? p.allowedHosts.filter((h): h is string => typeof h === 'string')
    : [];
  const savedName = typeof d.result?.name === 'string' ? d.result.name : null;
  const st = {
    state: STATE[d.state] ?? ('queued' as const),
    label: Object.hasOwn(t.drafts.states, d.state)
      ? t.drafts.states[d.state as keyof typeof t.drafts.states]
      : d.state,
  };
  const spec = cardFor('draft:credential_save');
  const proposed = d.state === 'proposed';

  async function dismiss(): Promise<void> {
    setBusy(true);
    try {
      await dismissDraft(d.id);
      props.onChanged();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LiveCard
      cardKey={`draft:${d.id}`}
      kind={{ ...spec.kind, label: tv.card.saveKind }}
      state={
        <span data-testid="draft-state" className="inline-flex">
          <StateBadge state={st.state} label={st.label} />
        </span>
      }
      title={d.title}
      {...(proposed
        ? {
            actions: (
              <>
                <CardButton
                  variant="primary"
                  icon="key"
                  expanded={open}
                  disabled={busy}
                  onClick={() => {
                    setOpen((o) => !o);
                  }}
                >
                  {tv.warning.save}
                </CardButton>
                <CardButton busy={busy} disabled={busy} onClick={() => void dismiss()}>
                  {t.drafts.card.dismiss}
                </CardButton>
              </>
            ),
            hint: tv.card.saveNote,
            panel: (
              <>
                {open ? (
                  <SaveSecretPanel
                    value={held?.value ?? null}
                    provider={held?.provider ?? provider(p.provider)}
                    initialName={name}
                    initialKind={kind}
                    initialHosts={hosts.length === 0 ? undefined : hosts}
                    onSaved={(c) => {
                      void markCredentialSaved(d.id, c.id).then(
                        () => {
                          if (handle !== null) forgetSecret(handle);
                          setOpen(false);
                          props.onChanged();
                        },
                        (err: unknown) => {
                          setError(sayError(err));
                        },
                      );
                    }}
                    onCancel={() => {
                      setOpen(false);
                    }}
                  />
                ) : null}
                {error === null ? null : (
                  <p role="alert" className="m-0 w-full text-[0.8125rem] text-dy-red-ink">
                    {error}
                  </p>
                )}
              </>
            ),
          }
        : {
            resolved: (
              <span className="text-dy-muted" data-testid="draft-outcome">
                {savedName === null ? st.label : tv.card.savedAs({ name: savedName })}
              </span>
            ),
          })}
    >
      <KeyValue
        rows={[
          { k: tv.save.name, v: name, mono: true },
          { k: tv.save.kind, v: tv.save.kinds[kind] },
          ...(hosts.length === 0 ? [] : [{ k: tv.save.hosts, v: hosts.join(', '), mono: true }]),
        ]}
      />
    </LiveCard>
  );
}
