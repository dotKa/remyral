import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  completeGitHubAuthorize,
  createGitHubRepository,
  type CreatedRepo,
  type GitHubAccount,
  getRepoOptions,
  type RepoOptions,
  type RepoOwner,
  removeGitHubAccount,
  setGitHubToken,
  startGitHubAuthorize,
} from '../../../api/github';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { INTEGRATIONS_PATH, type Navigate } from '../../../screens/integrationsPaths';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyCheck, DyDetails, DyDialog, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DyButtonLink, DySelect, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { useGuardedOp } from './integrations-coolify';
import { toast } from '../../toast/store';
import { DyConfirmDialog } from '../../common/actions';

/**
 * p15-github-create-repo (docs/design/p15-github-create-repo.md): the console side of "Remyral opens the repository".
 *
 * - {@link GitHubAccountsSection} — Ayarlar → Entegrasyonlar → GitHub → "GitHub hesabı": where Remyral can open
 *   repositories (per App installation: the method or why not), "GitHub hesabını yetkilendir" (GitHub's authorization
 *   page, back through the App's callback URL) and the fine-grained token fallback (write-only). No token is ever shown.
 * - {@link GitHubAuthorizeCallback} — the callback with a `u.` state: the code is removed from the address bar at once
 *   and exchanged exactly once (step-up).
 * - {@link NewGitHubRepoDialog} — "GitHub’da yeni private repo aç" (Projeler → Depo, the new project wizard).
 */

const browserNavigate: Navigate = (url) => {
  window.location.assign(url);
};

function ownerLine(o: RepoOwner, t: ReturnType<typeof useT>['githubRepos']['accounts']): string {
  return o.blocked === null ? (o.method === null ? '' : t.methods[o.method]) : t.blocked[o.blocked];
}

function AccountRow(props: { readonly account: GitHubAccount; readonly onRemoved: () => void }): ReactNode {
  const t = useT().githubRepos.accounts;
  const f = useFormat();
  const a = props.account;
  const [confirming, setConfirming] = useState(false);
  const act = useSubmit();
  const guarded = useGuardedOp();
  const expiry =
    a.kind === 'app_user'
      ? a.refreshExpiresAt === null && a.accessExpiresAt === null
        ? t.noExpiry
        : t.renews
      : a.accessExpiresAt === null
        ? t.noExpiry
        : t.expires({ at: f.dateTime(a.accessExpiresAt) });
  return (
    <Row
      title={a.login}
      meta={
        <span className="flex flex-col gap-1">
          <span>
            {t.kinds[a.kind]} · {expiry}
          </span>
          {a.usable ? null : <span className="text-dy-red-ink">{t.unusable}</span>}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
        </span>
      }
      trail={
        <span className="flex items-center gap-2" data-testid={`github-account-${a.login}`}>
          <Pill tone={a.usable ? 'green' : 'red'} icon={a.usable ? 'checkc' : 'xc'}>
            {t.kinds[a.kind]}
          </Pill>
          <DyButton
            variant="ghost"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t.remove}
          </DyButton>
          <DyConfirmDialog
            open={confirming}
            onClose={() => {
              setConfirming(false);
            }}
            title={t.removeConfirm({ login: a.login })}
            confirmLabel={t.remove}
            busy={act.busy}
            testId={`github-account-remove-${a.login}`}
            onConfirm={() => {
              setConfirming(false);
              void act.run(async () => {
                const done = await guarded(async () => {
                  await removeGitHubAccount(a.id);
                  return true;
                }, t.stepUpRemove);
                if (done === true) props.onRemoved();
              });
            }}
          />
        </span>
      }
    />
  );
}

/** Settings → Integrations → GitHub → "GitHub hesabı" (shown while an App is connected). */
export function GitHubAccountsSection(props: { readonly navigate?: Navigate | undefined }): ReactNode {
  const t = useT().githubRepos.accounts;
  const navigate = props.navigate ?? browserNavigate;
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [token, setToken] = useState('');
  const load = useSubmit();
  const act = useSubmit();
  const pat = useSubmit();
  const guarded = useGuardedOp();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setOpts(await getRepoOptions());
    });
  }, [load]);
  useEffect(() => {
    void refresh();
    // load once (refresh is stable enough; re-run after changes explicitly).
  }, []);

  const authorize = async (): Promise<void> => {
    await act.run(async () => {
      const res = await guarded(() => startGitHubAuthorize(), t.stepUpAuthorize);
      if (res !== null) navigate(res.authorizeUrl);
    });
  };

  const anyUnusable = opts?.accounts.some((a) => !a.usable) === true;
  return (
    <section aria-label={t.title} className="flex flex-col gap-2" data-testid="github-accounts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[0.9375rem] font-bold">{t.title}</h3>
        {opts?.canAuthorize === true ? (
          <DyButton icon="key" busy={act.busy} onClick={() => void authorize()}>
            {anyUnusable ? t.reauthorize : t.authorize}
          </DyButton>
        ) : null}
      </div>
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      {opts?.canAuthorize === true ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.authorizeHint}</p>
      ) : opts !== null ? (
        <DyNotice tone="amber">{t.noSecret}</DyNotice>
      ) : null}
      <DyApiError error={load.error ?? act.error} retryLeft={load.retryLeft} />
      {opts === null ? (
        load.error === null ? (
          <SkeletonRows label={t.title} rows={1} />
        ) : null
      ) : (
        <>
          {opts.accounts.length === 0 ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{t.none}</p>
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-dy-line">
              <Rows label={t.title}>
                {opts.accounts.map((a) => (
                  <AccountRow key={a.id} account={a} onRemoved={() => void refresh()} />
                ))}
              </Rows>
            </div>
          )}
          {opts.owners.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h4 className="m-0 text-[0.875rem] font-bold">{t.owners}</h4>
              <ul
                className="m-0 flex list-none flex-col gap-1 p-0 text-[0.875rem]"
                data-testid="github-repo-owners"
              >
                {opts.owners.map((o) => (
                  <li
                    key={o.installationId}
                    data-blocked={o.blocked ?? undefined}
                    className="flex flex-wrap gap-2"
                  >
                    <Pill
                      tone={o.blocked === null ? 'green' : 'amber'}
                      icon={o.blocked === null ? 'checkc' : 'flag'}
                    >
                      {o.login}
                    </Pill>
                    <span className="text-dy-muted">
                      {t.ownerType[o.type]} — {ownerLine(o, t)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DyDetails summary={t.pat.toggle} testId="github-pat">
            <form
              className="flex flex-col gap-3 p-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                void pat.run(async () => {
                  const res = await guarded(() => setGitHubToken(token.trim()), t.pat.stepUp);
                  if (res !== null) {
                    setToken('');
                    // p17-toasts-rest: the token save result → toast (the token itself is never shown).
                    toast.success(t.pat.saved({ login: res.login }), {
                      id: 'github-pat-saved',
                      testId: 'github-pat-saved',
                    });
                    await refresh();
                  }
                });
              }}
            >
              <DyField
                label={t.pat.label}
                type="password"
                autoComplete="off"
                spellCheck={false}
                mono
                value={token}
                hint={t.pat.hint}
                onChange={setToken}
              />
              <div>
                <DyButton type="submit" busy={pat.busy} disabled={token.trim() === ''}>
                  {t.pat.save}
                </DyButton>
              </div>
              <DyApiError error={pat.error} retryLeft={pat.retryLeft} />
            </form>
          </DyDetails>
        </>
      )}
    </section>
  );
}

/**
 * GitHub's redirect after "GitHub hesabını yetkilendir": `?code=…&state=u.…`. Rendered by the callback screen for a
 * `u.` state; the code leaves the address bar at once and is exchanged once (the state is single use).
 */
export function GitHubAuthorizeCallback(): ReactNode {
  const t = useT().githubRepos;
  const location = useLocation();
  const navigate = useNavigate();
  const params = useRef(new URLSearchParams(location.search));
  const started = useRef(false);
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const act = useSubmit();
  const guarded = useGuardedOp();
  const code = params.current.get('code');
  const state = params.current.get('state');

  const finish = async (): Promise<void> => {
    if (code === null || state === null) return;
    setCancelled(false);
    await act.run(async () => {
      const res = await guarded(() => completeGitHubAuthorize(code, state), t.callback.stepUp);
      if (res === null) setCancelled(true);
      else setAccount(res);
    });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void navigate(location.pathname, { replace: true });
    void finish();
  }, []);

  const tg = useT().integrations.github;
  return (
    <ScreenFrame
      title={t.callback.title}
      purpose={t.callback.purpose}
      back={{ to: INTEGRATIONS_PATH, label: tg.integrations }}
      width="narrow"
      testId="dy-github-authorize-callback"
    >
      <Panel title={t.callback.title}>
        <div className="flex flex-col gap-3 text-[0.875rem]">
          {account !== null ? (
            <DyNotice tone="green" live>
              {t.accounts.authorized({ login: account.login })}
            </DyNotice>
          ) : cancelled ? (
            <DyNotice tone="amber" action={<DyButton onClick={() => void finish()}>{tg.retry}</DyButton>}>
              {tg.notConfirmed}
            </DyNotice>
          ) : act.error === null ? (
            <SkeletonRows label={t.callback.working} rows={1} />
          ) : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          <FormActions>
            <DyButtonLink to={INTEGRATIONS_PATH}>{tg.backToIntegrations}</DyButtonLink>
          </FormActions>
        </div>
      </Panel>
    </ScreenFrame>
  );
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function repoNameOk(name: string): boolean {
  return REPO_NAME.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name);
}

/** "GitHub’da yeni private repo aç": owner, name, visibility, first commit, link to the project. */
export function NewGitHubRepoDialog(props: {
  readonly open: boolean;
  readonly project: string | null;
  /** The project's current repository (the link replaces it only when ticked). */
  readonly currentRepository?: string | null | undefined;
  readonly suggestedName?: string | undefined;
  readonly onClose: () => void;
  readonly onCreated?: (r: CreatedRepo) => void;
}): ReactNode {
  const t = useT().githubRepos.create;
  const ta = useT().githubRepos.accounts;
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(props.suggestedName ?? '');
  const [description, setDescription] = useState('');
  const [priv, setPriv] = useState(true);
  const [autoInit, setAutoInit] = useState(true);
  const [gitignore, setGitignore] = useState('');
  const [link, setLink] = useState(true);
  const [replace, setReplace] = useState(false);
  const [bad, setBad] = useState(false);
  const [done, setDone] = useState<CreatedRepo | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuardedOp();
  const key = useRef(`web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

  useEffect(() => {
    if (!props.open) return;
    setDone(null);
    key.current = `web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    void load.run(async () => {
      const o = await getRepoOptions();
      setOpts(o);
      const usable = o.owners.filter((x) => x.blocked === null);
      setOwner((cur) => (cur !== '' && usable.some((x) => x.login === cur) ? cur : (usable[0]?.login ?? '')));
    });
  }, [props.open]);

  const usable = opts?.owners.filter((o) => o.blocked === null) ?? [];
  const submit = async (): Promise<void> => {
    if (!repoNameOk(name.trim())) {
      setBad(true);
      return;
    }
    setBad(false);
    await act.run(async () => {
      const res = await guarded(
        () =>
          createGitHubRepository({
            owner,
            name: name.trim(),
            ...(description.trim() === '' ? {} : { description: description.trim() }),
            private: priv,
            autoInit,
            ...(autoInit && gitignore !== '' ? { gitignoreTemplate: gitignore } : {}),
            ...(props.project !== null && link ? { project: props.project } : {}),
            ...(replace ? { replaceLink: true } : {}),
            idempotencyKey: key.current,
          }),
        t.stepUp,
      );
      if (res !== null) {
        setDone(res);
        props.onCreated?.(res);
      }
    });
  };

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.title}
      description={t.sub}
      size="md"
      backdropClose={false}
      testId="github-new-repo"
      footer={
        done === null ? (
          <>
            <DyButton onClick={props.onClose}>{t.cancel}</DyButton>
            <DyButton
              variant="primary"
              busy={act.busy}
              disabled={usable.length === 0 || name.trim() === ''}
              onClick={() => void submit()}
            >
              {t.submit}
            </DyButton>
          </>
        ) : (
          <DyButton variant="primary" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
        )
      }
    >
      {done !== null ? (
        <div className="flex flex-col gap-2" data-testid="github-new-repo-done">
          <DyNotice tone="green" live>
            {t.created({ name: done.fullName })}{' '}
            {done.project === null ? null : done.linked ? t.linked({ project: done.project }) : t.notLinked}
          </DyNotice>
          {done.warnings.map((w) => {
            const k = w.split(':')[0] ?? w;
            const known = (t.warnings as Readonly<Record<string, string>>)[k];
            return (
              <DyNotice key={w} tone="amber">
                {known ?? w}
              </DyNotice>
            );
          })}
          <a href={done.htmlUrl} target="_blank" rel="noopener noreferrer" className="text-dy-teal-ink">
            {t.openOnGitHub}
          </a>
        </div>
      ) : opts === null ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : (
          <DyApiError error={load.error} retryLeft={load.retryLeft} />
        )
      ) : usable.length === 0 ? (
        <DyNotice tone="amber" action={<DyButtonLink to={INTEGRATIONS_PATH}>{t.toSettings}</DyButtonLink>}>
          {t.noOwner}
          {opts.owners.length > 0 ? (
            <ul className="m-0 mt-1 pl-4">
              {opts.owners.map((o) => (
                <li key={o.installationId}>
                  {o.login}: {o.blocked === null ? '' : ta.blocked[o.blocked]}
                </li>
              ))}
            </ul>
          ) : null}
        </DyNotice>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DySelect
            label={t.owner}
            value={owner}
            options={usable.map((o) => [o.login, `${o.login} (${ta.ownerType[o.type]})`] as const)}
            onChange={setOwner}
          />
          <DyField
            label={t.name}
            value={name}
            mono
            spellCheck={false}
            autoComplete="off"
            hint={t.nameHint}
            error={bad ? t.nameInvalid : undefined}
            onChange={setName}
          />
          <DyField label={t.description} value={description} maxLength={350} onChange={setDescription} />
          <DyCheck label={t.private} checked={priv} onChange={setPriv} />
          <DyCheck label={t.autoInit} checked={autoInit} onChange={setAutoInit} />
          {autoInit ? (
            <DySelect
              label={t.gitignore}
              value={gitignore}
              options={[
                ['', t.gitignoreNone] as const,
                ...opts.gitignoreTemplates.map((g) => [g, g] as const),
              ]}
              onChange={setGitignore}
            />
          ) : null}
          {props.project === null ? null : (
            <DyCheck label={t.link({ project: props.project })} checked={link} onChange={setLink} />
          )}
          {props.project !== null && link && props.currentRepository != null ? (
            <DyCheck
              label={t.replaceLink({ current: props.currentRepository })}
              checked={replace}
              onChange={setReplace}
            />
          ) : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
        </form>
      )}
    </DyDialog>
  );
}
