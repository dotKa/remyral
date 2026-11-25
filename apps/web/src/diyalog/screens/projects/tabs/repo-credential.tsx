import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  deleteRepoCredential,
  getRepoCredential,
  knownHostsProblem,
  putRepoCredential,
  type RepoAuthKind,
  type RepoCredential,
} from '../../../../api/gitCentral';
import { type CredentialView, listCredentials } from '../../../../api/vault';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyApiError, DyField, DyNotice, DyTextarea, FormActions } from '../../forms';
import { DyButton, DySelect, Panel, SkeletonRows } from '../../parts';
import { DyFields } from '../../records';
import { useGuarded } from '../../machines/tabs/config-shared';
import { useCardForm } from '../../../formkit';
import { useDoneToast } from '../../../toast/useDoneToast';

const VAULT_KIND: Readonly<Record<RepoAuthKind, CredentialView['kind']>> = {
  'ssh-key': 'git-ssh-key',
  'https-token': 'git-https-token',
};

/**
 * p15-git-central §4: Projeler → Depo → "Depo erişimi (GitHub dışı / SSH)". A project's repository credential is a
 * reference to a vault credential (created and sealed to machines in Ayarlar → Kimlik bilgileri; the master never sees
 * the value): an SSH deploy key with pinned known_hosts lines, or an HTTPS token with its username, plus what it may
 * do at the host (untrusted-source jobs get only read-only ones). Project admins change it with step-up (security
 * event `integrations.git`); GitHub repositories need nothing here (the GitHub App's per-job token).
 */
export function RepoCredentialPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().gitCentral.repo;
  const { project } = props;
  const [data, setData] = useState<RepoCredential | null>(null);
  const [vault, setVault] = useState<CredentialView[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<RepoAuthKind>('ssh-key');
  const [credentialId, setCredentialId] = useState('');
  const [username, setUsername] = useState('');
  const [knownHosts, setKnownHosts] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('write');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const load = useSubmit();
  const save = useSubmit();
  const guarded = useGuarded();

  const apply = useCallback((r: RepoCredential) => {
    setData(r);
    const c = r.credential;
    setKind(c?.kind ?? 'ssh-key');
    setCredentialId(c?.credentialId ?? '');
    setUsername(c?.username ?? '');
    setKnownHosts(c?.knownHosts ?? '');
    setAccess(c?.access ?? 'write');
  }, []);

  useEffect(() => {
    void load.run(async () => {
      apply(await getRepoCredential(project));
    });
  }, [project, apply]);

  useEffect(() => {
    if (!editing || vault !== null) return;
    // Admins list the vault; without vault access the id is typed instead.
    listCredentials().then(setVault, () => {
      setVault([]);
    });
  }, [editing, vault]);

  const candidates = (vault ?? []).filter((c) => c.kind === VAULT_KIND[kind] && c.state === 'active');

  const submit = async (): Promise<boolean> => {
    setDone(null);
    if (credentialId.trim() === '') {
      setError(t.noCredentials);
      return false;
    }
    if (kind === 'ssh-key') {
      const p = knownHostsProblem(knownHosts.trim());
      if (p !== null) {
        setError(t.knownHostsProblems[p]);
        return false;
      }
    }
    setError(null);
    let saved = false;
    const ok = await save.run(async () => {
      const r = await guarded(
        () =>
          putRepoCredential(project, {
            kind,
            credentialId: credentialId.trim(),
            access,
            ...(kind === 'https-token' && username.trim() !== '' ? { username: username.trim() } : {}),
            ...(kind === 'ssh-key' ? { knownHosts: knownHosts.trim() } : {}),
          }),
        t.why({ project }),
      );
      if (r !== null) {
        apply(r);
        setEditing(false);
        setDone(t.saved);
        saved = true;
      }
    });
    return ok && saved;
  };
  // p15-form-pattern: the open edit fields join the Depo tab's form (its bar saves them; İptal closes them).
  const loaded = data?.credential ?? null;
  const card = useCardForm({
    dirty:
      props.canEdit &&
      editing &&
      data !== null &&
      (kind !== (loaded?.kind ?? 'ssh-key') ||
        credentialId !== (loaded?.credentialId ?? '') ||
        username !== (loaded?.username ?? '') ||
        knownHosts !== (loaded?.knownHosts ?? '') ||
        access !== (loaded?.access ?? 'write')),
    busy: save.busy,
    save: submit,
    discard: () => {
      if (data !== null) apply(data);
      setError(null);
      setEditing(false);
    },
  });

  const c = data?.credential ?? null;
  const oldWorkers = (data?.workers ?? []).filter((w) => !w.supported);
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-project-repo-credential">
      <div className="flex min-w-0 flex-col gap-3 text-[0.875rem]">
        <p className="m-0 text-dy-muted">{t.githubNote}</p>
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {data === null ? (
          load.error === null ? (
            <SkeletonRows label={t.loading} rows={1} />
          ) : null
        ) : !editing ? (
          <>
            {c === null ? (
              <p className="m-0" data-testid="repo-credential-none">
                {t.none}
              </p>
            ) : (
              <DyFields
                rows={[
                  {
                    k: t.credential,
                    v: (
                      <span className="font-dy-mono" data-testid="repo-credential-current">
                        {t.current({ name: c.credentialName ?? c.credentialId, kind: t.kinds[c.kind] })}
                      </span>
                    ),
                  },
                  { k: t.access, v: c.access === 'read' ? t.accessRead : t.accessWrite },
                  ...(c.username === null ? [] : [{ k: t.username, v: c.username }]),
                  ...(c.knownHosts === null
                    ? []
                    : [
                        {
                          k: t.knownHosts,
                          v: (
                            <pre className="m-0 whitespace-pre-wrap font-dy-mono text-[0.75rem]">
                              {c.knownHosts}
                            </pre>
                          ),
                        },
                      ]),
                ]}
              />
            )}
            {c !== null && data.workers.length === 0 ? <DyNotice tone="amber">{t.noWorkers}</DyNotice> : null}
            {c !== null && data.workers.length > 0 ? (
              <p className="m-0 text-dy-muted">
                {t.workers({ names: data.workers.map((w) => w.name).join(', ') })}
              </p>
            ) : null}
            {oldWorkers.length > 0 ? (
              <DyNotice tone="amber">
                {t.oldWorkers({ names: oldWorkers.map((w) => w.name).join(', ') })}
              </DyNotice>
            ) : null}
            {props.canEdit ? (
              <FormActions>
                <DyButton
                  icon="pen"
                  data-testid="repo-credential-edit"
                  onClick={() => {
                    setDone(null);
                    setEditing(true);
                  }}
                >
                  {c === null ? t.set : t.edit}
                </DyButton>
                {c !== null ? (
                  <DyButton
                    variant="ghost"
                    busy={save.busy}
                    onClick={() => {
                      void save.run(async () => {
                        const r = await guarded(() => deleteRepoCredential(project), t.why({ project }));
                        if (r !== null) {
                          apply(r);
                          setDone(t.removed);
                        }
                      });
                    }}
                  >
                    {t.remove}
                  </DyButton>
                ) : null}
              </FormActions>
            ) : (
              <p className="m-0 text-dy-muted">{t.readOnly}</p>
            )}
          </>
        ) : (
          <form
            aria-label={t.title}
            className="grid gap-3 sm:grid-cols-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <DySelect
              label={t.kind}
              value={kind}
              options={[
                ['ssh-key', t.kinds['ssh-key']],
                ['https-token', t.kinds['https-token']],
              ]}
              onChange={(v) => {
                setKind(v === 'https-token' ? 'https-token' : 'ssh-key');
                setCredentialId('');
              }}
            />
            {vault !== null && vault.length > 0 ? (
              <DySelect
                label={t.credential}
                value={credentialId}
                options={[
                  ['', t.pick] as const,
                  ...candidates.map((v) => [v.id, `${v.name} (${v.id})`] as const),
                ]}
                onChange={setCredentialId}
              />
            ) : (
              <DyField
                label={t.credential}
                value={credentialId}
                mono
                spellCheck={false}
                onChange={setCredentialId}
              />
            )}
            <p className="m-0 text-[0.78125rem] text-dy-muted sm:col-span-2">
              {vault !== null && candidates.length === 0 ? t.noCredentials : t.credentialHint}
            </p>
            {kind === 'https-token' ? (
              <DyField
                label={t.username}
                value={username}
                mono
                spellCheck={false}
                placeholder="git" // i18n-ignore: git's default username
                hint={t.usernameHint}
                onChange={setUsername}
              />
            ) : (
              <DyTextarea
                label={t.knownHosts}
                value={knownHosts}
                rows={3}
                mono
                spellCheck={false}
                hint={t.knownHostsHint}
                wrapClassName="sm:col-span-2"
                data-testid="repo-credential-known-hosts"
                onChange={setKnownHosts}
              />
            )}
            <DySelect
              label={t.access}
              value={access}
              options={[
                ['write', t.accessWrite],
                ['read', t.accessRead],
              ]}
              onChange={(v) => {
                setAccess(v === 'read' ? 'read' : 'write');
              }}
            />
            <p className="m-0 text-[0.78125rem] text-dy-muted sm:col-span-2">{t.accessHint}</p>
            {error !== null ? (
              <p className="m-0 text-[0.8125rem] text-dy-red sm:col-span-2" role="alert">
                {error}
              </p>
            ) : null}
            <FormActions className="sm:col-span-2">
              {card.inScope ? null : (
                <DyButton type="submit" variant="primary" busy={save.busy} data-testid="repo-credential-save">
                  {t.save}
                </DyButton>
              )}
              <DyButton
                variant="ghost"
                onClick={() => {
                  apply(data);
                  setError(null);
                  setEditing(false);
                }}
              >
                {t.cancel}
              </DyButton>
            </FormActions>
          </form>
        )}
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
      </div>
    </Panel>
  );
}
