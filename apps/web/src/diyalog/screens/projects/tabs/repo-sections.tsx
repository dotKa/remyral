import { ProjectWorkfilesPolicy } from '../../settings/WorkfilesView';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { NewGitHubRepoDialog } from '../../settings/integrations-github-repos';
import { ApiError } from '../../../../api/client';
import { EGRESS_MODES, type EgressMode } from '../../../../api/directory';
import {
  getProjectGitConfig,
  GIT_PROVIDERS,
  type GitProvider,
  type ProjectGitConfig,
  putProjectGitConfig,
} from '../../../../api/gitflow';
import {
  type GitHostConnection,
  type GitHostRepository,
  type GitHostTest,
  listGitHostRepositories,
  listGitHosts,
  testGitHost,
} from '../../../../api/gitHosts';
import { testReason } from '../../settings/integrations-git-hosts';
import {
  type BranchProtection,
  getBranchProtection,
  getRepositoryState,
  getGitHubStatus,
  type GitHubRepository,
  type GitHubStatus,
  listGitHubRepositories,
  type RepositoryPage,
} from '../../../../api/github';
import {
  getIntegrationSettings,
  type IntegrationSettings,
  MAX_FIXES_LIMIT,
  MAX_RESOLUTIONS_LIMIT,
  putIntegrationSettings,
} from '../../../../api/integration';
import {
  formatBytes,
  getWorkspaceSettings,
  MAX_ALLOW_HOSTS,
  parseAllowHosts,
  putWorkspaceSettings,
  OUTPUT_FILES,
  OUTPUT_JOB_BYTES,
  QUOTA_BYTES,
  RETENTION_DAYS,
  type WorkspaceSettings,
} from '../../../../api/workspaces';
import { DyActor } from '../../../common/actor';
import { sameValue, useCardForm, useSectionSave } from '../../../formkit';
import { useSubmit } from '../../../../screens/useSubmit';
import { parseBound } from '../../../../screens/workspace/storage';
import { KeyValue, type KeyValueRow } from '../../../KeyValue';
import { DyApiError, DyCheck, DyField, DyNotice, DyTextarea, FormActions, FormGrid } from '../../forms';
import { DyButton, DySelect, Meter, Panel, Pill, SkeletonRows } from '../../parts';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../../common/time';
import { toast } from '../../../toast/store';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Depo / Çalışma alanı in the Diyalog language. The same reads and writes as the
 * classic sections in `screens/ProjectSettings.tsx` and `screens/workspace/StorageSection.tsx`: the registered
 * repository (GitHub App picker or manual URL, base branch, merge method, CI gate; `expectedVersion`, a 409 re-reads),
 * branch protection, the integration settings (mode, order, rounds), a workspace's network access (allow-list parsed
 * by `parseAllowHosts`) and its storage policy (bounds from `parseBound`). Every change goes through step-up
 * (`useGuarded`: a cancelled code dialog is not an error); viewers and operators read only, as classic.
 */

const MiB = 1024 * 1024;

// ------------------------------------------------------------------------------------------------ repository

interface GitForm {
  provider: GitProvider;
  repositoryUrl: string;
  baseBranch: string;
  mergeMethod: 'merge' | 'squash';
  requireCi: boolean;
  installationId: string;
  keyRef: string;
  appId: string;
  /** p16-git-providers: the GitLab / Bitbucket connection ('' = none chosen). */
  hostConnectionId: string;
}

function formOf(c: ProjectGitConfig | null): GitForm {
  return {
    provider: c?.provider ?? 'github',
    repositoryUrl: c?.repositoryUrl ?? '',
    baseBranch: c?.baseBranch ?? 'main',
    mergeMethod: c?.mergeMethod ?? 'merge',
    requireCi: c?.requireCi ?? false,
    installationId: c?.github === null || c === null ? '' : String(c.github.installationId),
    keyRef: c?.github?.keyRef ?? '',
    appId: c?.github?.appId ?? '',
    hostConnectionId: c?.hostConnectionId ?? '',
  };
}

const isHosted = (p: GitProvider): p is 'gitlab' | 'bitbucket' => p === 'gitlab' || p === 'bitbucket';

/**
 * p16-git-providers: GitLab / Bitbucket in Projeler → Depo — the connection (from Ayarlar → Entegrasyonlar),
 * "Bağlantıyı test et", and the repositories its token reaches (a pick fills the address and the base branch).
 */
function HostedRepoFields(props: {
  readonly kind: 'gitlab' | 'bitbucket';
  readonly connections: readonly GitHostConnection[] | null;
  readonly unavailable: boolean;
  readonly form: GitForm;
  readonly setForm: (f: GitForm) => void;
}): ReactNode {
  const w = useT().gitHosts;
  const t = w.repo;
  const { form, setForm } = props;
  const mine = (props.connections ?? []).filter((c) => c.kind === props.kind);
  const [test, setTest] = useState<GitHostTest | null>(null);
  const [q, setQ] = useState('');
  const [repos, setRepos] = useState<GitHostRepository[] | null>(null);
  const act = useSubmit();
  const load = useSubmit();
  const id = form.hostConnectionId;
  useEffect(() => {
    setRepos(null);
    if (id === '' || props.unavailable) return;
    const timer = setTimeout(
      () => {
        void load.run(async () => {
          setRepos(await listGitHostRepositories(id, q));
        });
      },
      q === '' ? 0 : 250,
    );
    return () => {
      clearTimeout(timer);
    };
    // load.run is stable.
  }, [id, q, props.unavailable]);

  if (props.unavailable)
    return (
      <DyNotice tone="amber" className="sm:col-span-2">
        {t.connectionsUnavailable}
      </DyNotice>
    );
  if (props.connections !== null && mine.length === 0)
    return (
      <DyNotice tone="amber" className="sm:col-span-2">
        <span data-testid="repo-no-connections">{t.noConnections({ kind: w.kinds[props.kind] })}</span>
      </DyNotice>
    );
  return (
    <>
      <DySelect
        label={t.connection}
        value={id}
        options={[
          ['', t.pickConnection],
          ...mine.map((c) => [c.id, t.connectionValue({ label: c.label, host: c.webHost })] as const),
        ]}
        onChange={(v) => {
          setTest(null);
          setForm({ ...form, hostConnectionId: v });
        }}
      />
      <div className="flex items-end">
        <DyButton
          icon="retry"
          disabled={id === '' || act.busy}
          busy={act.busy}
          onClick={() =>
            void act.run(async () => {
              setTest(await testGitHost(id));
            })
          }
        >
          {t.testConnection}
        </DyButton>
      </div>
      {test === null ? null : (
        <DyNotice tone={test.ok ? 'green' : 'red'} live className="sm:col-span-2">
          <span data-testid="repo-host-test">
            {test.ok
              ? w.settings.testOk({ name: test.tokenName ?? '' })
              : w.settings.testFailed({ reason: testReason(w.settings, test.code) })}
          </span>
        </DyNotice>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="sm:col-span-2" />
      {id === '' ? null : (
        <div className="flex min-w-0 flex-col gap-2 sm:col-span-2" data-testid="repo-host-picker">
          <DyField
            label={t.search}
            value={q}
            mono
            spellCheck={false}
            autoComplete="off"
            placeholder={t.searchPlaceholder}
            onChange={setQ}
          />
          <DyApiError error={load.error} retryLeft={load.retryLeft} />
          {repos === null ? (
            load.error === null ? (
              <SkeletonRows label={t.reposLoading} rows={2} />
            ) : null
          ) : repos.length === 0 ? (
            <p className="m-0 text-[0.84375rem] text-dy-muted">{t.noRepos}</p>
          ) : (
            <ul aria-label={t.reposLabel} className="m-0 flex list-none flex-col gap-1 p-0">
              {repos.map((r) => {
                const on = form.repositoryUrl === r.cloneUrl;
                return (
                  <li key={r.fullPath}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        setForm({
                          ...form,
                          repositoryUrl: r.cloneUrl,
                          baseBranch: r.defaultBranch ?? form.baseBranch,
                        });
                      }}
                      className={
                        on
                          ? 'dy-press flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-[9px] border border-dy-teal bg-dy-teal-soft px-3 py-1.5 text-left text-[0.875rem] md:min-h-9'
                          : 'dy-press flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-[9px] border border-dy-line bg-dy-card px-3 py-1.5 text-left text-[0.875rem] md:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2'
                      }
                    >
                      <span className="font-dy-mono [overflow-wrap:anywhere]">{r.fullPath}</span>
                      <span className="text-[0.78125rem] text-dy-muted">{r.defaultBranch ?? ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** The base branch's protection on GitHub (repository projects with the GitHub App only). */
export function ProtectionPill(props: { readonly project: string }): ReactNode {
  const t = useT().projectTabs.repo;
  const [p, setP] = useState<BranchProtection | null>(null);
  useEffect(() => {
    let live = true;
    getBranchProtection(props.project)
      .then((r) => {
        if (live) setP(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.project]);
  if (p === null || p.state === 'not_applicable') return null;
  const branch = p.branch ?? t.baseBranchFallback;
  if (p.state === 'protected')
    return (
      <span data-testid={`protection-${p.project}`} data-state={p.state}>
        <Pill tone="green" icon="shield">
          {t.protected({ branch })}
        </Pill>
      </span>
    );
  return (
    <span data-testid={`protection-${p.project}`} data-state={p.state}>
      <Pill tone="amber" icon="shield" className="whitespace-normal">
        {p.state === 'unprotected'
          ? t.unprotected({ branch })
          : p.state === 'missing'
            ? t.missing({ branch })
            : t.unknown({ branch })}
      </Pill>
    </span>
  );
}

/**
 * p18-project-bootstrap: the repository's state first — an EMPTY repository (no branch yet) reads "Boş repo — ilk iş
 * ana dalı oluşturur" instead of a missing-branch protection warning; otherwise the protection pill as before.
 */
export function RepoStatePill(props: { readonly project: string }): ReactNode {
  const t = useT().projectTabs.repo;
  const [empty, setEmpty] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getRepositoryState(props.project)
      .then((r) => {
        if (live) setEmpty(r.state === 'empty');
      })
      .catch(() => {
        if (live) setEmpty(false);
      });
    return () => {
      live = false;
    };
  }, [props.project]);
  if (empty === null) return null;
  if (!empty) return <ProtectionPill project={props.project} />;
  return (
    <span data-testid={`repo-empty-${props.project}`} title={t.emptyHint}>
      <Pill tone="teal" icon="branch" className="whitespace-normal">
        {t.empty}
      </Pill>
    </span>
  );
}

const PICKER_PAGE_SIZE = 10;

/** Repositories the panel-connected GitHub App can reach (search + pages from the master); a pick fills the form. */
function RepoPicker(props: {
  readonly selected: string;
  readonly onPick: (r: GitHubRepository) => void;
}): ReactNode {
  const t = useT().projectTabs.repo;
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RepositoryPage | null>(null);
  const load = useSubmit();
  useEffect(() => {
    const t = setTimeout(
      () => {
        void load.run(async () => {
          setData(await listGitHubRepositories({ q, page, pageSize: PICKER_PAGE_SIZE }));
        });
      },
      q === '' ? 0 : 250,
    );
    return () => {
      clearTimeout(t);
    };
    // load.run is stable.
  }, [q, page]);
  const pages = data === null ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:col-span-2" data-testid="repo-picker">
      <DyField
        label={t.search}
        value={q}
        spellCheck={false}
        autoComplete="off"
        placeholder={t.searchPlaceholder}
        mono
        onChange={(v) => {
          setQ(v);
          setPage(1);
        }}
      />
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {data === null ? (
        load.error === null ? (
          <SkeletonRows label={t.reposLoading} rows={2} />
        ) : null
      ) : (
        <>
          {data.errors.length > 0 ? <DyNotice tone="amber">{data.errors.join('; ')}</DyNotice> : null}
          {data.items.length === 0 ? (
            <p className="m-0 text-[0.84375rem] text-dy-muted">{t.noRepos}</p>
          ) : (
            <ul aria-label={t.reposLabel} className="m-0 flex list-none flex-col gap-1 p-0">
              {data.items.map((r) => {
                const on = props.selected === r.cloneUrl;
                return (
                  <li key={`${String(r.installationId)}:${r.fullName}`}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        props.onPick(r);
                      }}
                      className={
                        on
                          ? 'dy-press flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-[9px] border border-dy-teal bg-dy-teal-soft px-3 py-1.5 text-left text-[0.875rem] md:min-h-9'
                          : 'dy-press flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-[9px] border border-dy-line bg-dy-card px-3 py-1.5 text-left text-[0.875rem] md:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2'
                      }
                    >
                      <span className="font-dy-mono [overflow-wrap:anywhere]">{r.fullName}</span>
                      <span className="text-[0.78125rem] text-dy-muted">
                        {r.defaultBranch}
                        {r.private ? t.private : ''}
                        {r.archived ? t.archived : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
            <DyButton
              variant="ghost"
              disabled={page <= 1}
              onClick={() => {
                setPage(page - 1);
              }}
            >
              {t.previous}
            </DyButton>
            <span className="tabular-nums">{t.pageOf({ page, pages, total: data.total })}</span>
            <DyButton
              variant="ghost"
              disabled={page >= pages}
              onClick={() => {
                setPage(page + 1);
              }}
            >
              {t.next}
            </DyButton>
          </div>
        </>
      )}
    </div>
  );
}

export function RepositoryPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const { project } = props;
  const t = useT().projectTabs.repo;
  const [config, setConfig] = useState<ProjectGitConfig | null | undefined>(undefined);
  const [form, setForm] = useState<GitForm>(formOf(null));
  const [editing, setEditing] = useState(false);
  const [github, setGithub] = useState<GitHubStatus | null>(null);
  const [manual, setManual] = useState(false);
  // p15-github-create-repo: "GitHub’da yeni private repo aç" (also opened by the new project wizard: ?newRepo=1).
  const [search, setSearch] = useSearchParams();
  const [newRepo, setNewRepo] = useState(search.get('newRepo') === '1' && props.canEdit);
  const tr = useT().githubRepos.create;
  const load = useSubmit();
  const save = useSubmit();
  const sectionSave = useSectionSave();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const c = await getProjectGitConfig(project);
      setConfig(c);
      setForm(formOf(c));
    });
  }, [load, project]);

  useEffect(() => {
    void refresh();
    // refresh depends on the project only (load.run is stable).
  }, [project]);

  useEffect(() => {
    if (!editing || !props.canEdit) return;
    let live = true;
    getGitHubStatus()
      .then((s) => {
        if (live) setGithub(s);
      })
      .catch(() => {
        if (live) setGithub(null);
      });
    return () => {
      live = false;
    };
  }, [editing, props.canEdit]);

  // p16-git-providers: the GitLab / Bitbucket connections (an administrator read; refused = shown as unavailable).
  const [hosts, setHosts] = useState<GitHostConnection[] | null>(null);
  const [hostsUnavailable, setHostsUnavailable] = useState(false);
  const wantHosts =
    (editing && props.canEdit && isHosted(form.provider)) || isHosted(config?.provider ?? 'git');
  useEffect(() => {
    if (!wantHosts || hosts !== null) return;
    let live = true;
    listGitHosts()
      .then((list) => {
        if (live) setHosts(list);
      })
      .catch(() => {
        if (live) setHostsUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, [wantHosts, hosts]);

  // p17-chat-github: any connection with an accepted installation offers the picker (several GitHub Apps).
  const usableConnection = github?.connections.find(
    (c) => (c.app?.keyUsable ?? c.source === 'env') && c.installations.some((i) => i.accepted),
  );
  const panelApp =
    github?.app?.keyUsable === true && github.installations.length > 0
      ? github.app
      : (usableConnection?.app ?? null);
  const pickerAppId = form.provider === 'github' && !manual ? (panelApp?.appId ?? null) : null;
  const picking = pickerAppId !== null;

  const submit = async (): Promise<boolean> => {
    const flags = { conflict: false };
    const ok = await sectionSave(
      save,
      async () => {
        try {
          const saved = await putProjectGitConfig(project, {
            expectedVersion: config?.version ?? 0,
            provider: form.provider,
            repositoryUrl: form.repositoryUrl.trim(),
            baseBranch: form.baseBranch.trim(),
            mergeMethod: form.mergeMethod,
            requireCi: form.requireCi,
            ...(form.provider === 'github'
              ? {
                  github: {
                    installationId: Number(form.installationId),
                    ...(form.keyRef.trim() === '' ? {} : { keyRef: form.keyRef.trim() }),
                    ...(form.keyRef.trim().startsWith('panel') && form.appId !== ''
                      ? { appId: form.appId }
                      : {}),
                  },
                }
              : {}),
            ...(isHosted(form.provider) && form.hostConnectionId !== ''
              ? { hostConnectionId: form.hostConnectionId }
              : {}),
          });
          setConfig(saved);
          setForm(formOf(saved));
          setEditing(false);
          // p17-toasts-rest: a save result → toast. Saved from the tab's sticky bar, the bar's own "Kaydedildi"
          // toast is the result (one toast, not two).
          if (!card.inScope) toast.success(t.saved, { id: 'repo-git-saved', testId: 'repo-git-saved' });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) flags.conflict = true;
          throw err;
        }
      },
      t.stepUp({ project }),
    );
    if (!ok && flags.conflict) await refresh();
    return ok;
  };
  // p15-form-pattern: "Düzenle" opens the fields; open fields with changes join the Depo tab's form (its bar saves
  // them, İptal closes them).
  const card = useCardForm({
    dirty: props.canEdit && editing && config !== undefined && !sameValue(form, formOf(config)),
    busy: save.busy,
    save: submit,
    discard: () => {
      setForm(formOf(config ?? null));
      setEditing(false);
    },
  });

  const tw = useT().gitHosts;
  const providerLabel = (p: GitProvider): string =>
    p === 'github' ? t.githubApp : p === 'git' ? t.plainGit : tw.kinds[p];
  const hostConn = hosts?.find((h) => h.id === config?.hostConnectionId);
  const rows: KeyValueRow[] =
    config === null || config === undefined
      ? []
      : [
          { k: t.provider, v: providerLabel(config.provider) },
          ...(config.hostConnectionId === null
            ? []
            : [
                {
                  k: tw.repo.connection,
                  v:
                    hostConn === undefined
                      ? config.hostConnectionId
                      : tw.repo.connectionValue({ label: hostConn.label, host: hostConn.webHost }),
                },
              ]),
          { k: t.address, v: config.repositoryUrl, mono: true },
          { k: t.baseBranch, v: config.baseBranch, mono: true },
          {
            k: t.merge,
            v: t.mergeValue({ squash: config.mergeMethod === 'squash', ci: config.requireCi }),
          },
          ...(config.github === null
            ? []
            : [
                {
                  k: t.installation,
                  v: t.installationValue({
                    id: String(config.github.installationId),
                    key: config.github.keyRef,
                  }),
                  mono: true,
                },
              ]),
        ];

  return (
    <Panel
      title={t.title}
      sub={t.sub}
      testId="dy-repository"
      aside={
        config !== null && config !== undefined && config.provider !== 'git' ? (
          <RepoStatePill project={project} />
        ) : undefined
      }
    >
      {props.canEdit ? (
        <NewGitHubRepoDialog
          open={newRepo}
          project={project}
          currentRepository={config?.repositoryUrl ?? null}
          suggestedName={project.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}
          onClose={() => {
            setNewRepo(false);
            if (search.get('newRepo') !== null) {
              const next = new URLSearchParams(search);
              next.delete('newRepo');
              setSearch(next, { replace: true });
            }
          }}
          onCreated={(r) => {
            if (r.linked) void refresh();
          }}
        />
      ) : null}
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {config === undefined ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : !editing ? (
        <div className="flex flex-col gap-3">
          {config === null ? (
            <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="repo-none">
              {t.none}
            </p>
          ) : (
            <div data-testid="repo-view">
              <KeyValue rows={rows} />
            </div>
          )}
          {props.canEdit ? (
            <div className="flex flex-wrap gap-2">
              <DyButton
                variant={config === null ? 'primary' : 'secondary'}
                icon={config === null ? 'plus' : 'pen'}
                onClick={() => {
                  setEditing(true);
                }}
              >
                {config === null ? t.register : t.edit}
              </DyButton>
              <DyButton
                icon="plus"
                data-testid="repo-new-github"
                onClick={() => {
                  setNewRepo(true);
                }}
              >
                {tr.open}
              </DyButton>
            </div>
          ) : null}
        </div>
      ) : (
        <form
          aria-label={t.editForm({ project })}
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            card.submit();
          }}
        >
          <DySelect
            label={t.provider}
            value={form.provider}
            options={[
              ['github', t.githubApp],
              ['gitlab', tw.kinds.gitlab],
              ['bitbucket', tw.kinds.bitbucket],
              ['git', t.plainGit],
            ]}
            onChange={(v) => {
              const next = GIT_PROVIDERS.find((p) => p === v) ?? 'github';
              setForm({ ...form, provider: next, ...(isHosted(next) ? {} : { hostConnectionId: '' }) });
            }}
          />
          {isHosted(form.provider) ? (
            <HostedRepoFields
              kind={form.provider}
              connections={hosts}
              unavailable={hostsUnavailable}
              form={form}
              setForm={setForm}
            />
          ) : null}
          {picking ? (
            <>
              <RepoPicker
                selected={form.repositoryUrl}
                onPick={(r) => {
                  setForm({
                    ...form,
                    repositoryUrl: r.cloneUrl,
                    baseBranch: r.defaultBranch,
                    installationId: String(r.installationId),
                    keyRef: r.keyRef,
                    appId: github?.connections.find((c) => c.keyRef === r.keyRef)?.appId ?? pickerAppId,
                  });
                }}
              />
              <p
                className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere] sm:col-span-2"
                data-testid="repo-picked"
              >
                {form.repositoryUrl === '' ? t.notPicked : t.picked({ url: form.repositoryUrl })}
              </p>
            </>
          ) : (
            <DyField
              label={t.url}
              value={form.repositoryUrl}
              placeholder="https://github.com/kurum/depo.git" // i18n-ignore: example URL
              spellCheck={false}
              autoComplete="off"
              mono
              onChange={(v) => {
                setForm({ ...form, repositoryUrl: v });
              }}
            />
          )}
          {form.provider === 'github' && panelApp !== null ? (
            <div className="sm:col-span-2">
              <DyButton
                variant="ghost"
                onClick={() => {
                  setManual(!manual);
                }}
              >
                {manual ? t.fromGithub : t.manual}
              </DyButton>
            </div>
          ) : null}
          <DyField
            label={t.baseBranch}
            value={form.baseBranch}
            mono
            onChange={(v) => {
              setForm({ ...form, baseBranch: v });
            }}
          />
          <DySelect
            label={t.mergeMethod}
            value={form.mergeMethod}
            options={[
              ['merge', 'merge'],
              ['squash', 'squash'],
            ]}
            onChange={(v) => {
              setForm({ ...form, mergeMethod: v === 'squash' ? 'squash' : 'merge' });
            }}
          />
          {form.provider === 'github' && !picking ? (
            <>
              <DyField
                label={t.installationId}
                inputMode="numeric"
                value={form.installationId}
                mono
                onChange={(v) => {
                  setForm({ ...form, installationId: v.replace(/\D/g, '') });
                }}
              />
              <DyField
                label={t.keyRef}
                value={form.keyRef}
                placeholder="default" // i18n-ignore: key name
                mono
                hint={t.keyRefHint}
                onChange={(v) => {
                  setForm({ ...form, keyRef: v });
                }}
              />
            </>
          ) : null}
          {form.provider === 'gitlab' ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted sm:col-span-2">{tw.repo.mergeHint}</p>
          ) : null}
          <DyCheck
            className="sm:col-span-2"
            label={t.requireCi}
            checked={form.requireCi}
            onChange={(v) => {
              setForm({ ...form, requireCi: v });
            }}
          />
          <FormActions className="sm:col-span-2">
            {card.inScope ? null : (
              <DyButton type="submit" variant="primary" busy={save.busy}>
                {t.save}
              </DyButton>
            )}
            <DyButton
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setForm(formOf(config));
              }}
            >
              {t.cancel}
            </DyButton>
          </FormActions>
        </form>
      )}
      <DyApiError error={save.error} retryLeft={save.retryLeft} className="mt-3" />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ integration

type IntegrationWords = Messages['projectTabs']['integration'];

function roundsError(w: IntegrationWords, raw: string, max: number): string | null {
  const t = raw.trim();
  return /^\d{1,2}$/.test(t) && Number(t) <= max ? null : w.roundsError({ max });
}

export function IntegrationPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const { project } = props;
  const t = useT().projectTabs.integration;
  const MODE_TEXT = t.mode;
  const ORDER_TEXT = t.order;
  const [data, setData] = useState<IntegrationSettings | null>(null);
  const [serverCanEdit, setServerCanEdit] = useState(false);
  const [mode, setMode] = useState<IntegrationSettings['mode']>('master');
  const [order, setOrder] = useState<IntegrationSettings['order']>('dependency');
  const [resolutions, setResolutions] = useState('');
  const [fixes, setFixes] = useState('');
  const load = useSubmit();
  const save = useSubmit();
  const sectionSave = useSectionSave();

  const apply = useCallback((d: IntegrationSettings) => {
    setData(d);
    setMode(d.mode);
    setOrder(d.order);
    setResolutions(String(d.maxResolutions));
    setFixes(String(d.maxFixes));
  }, []);

  useEffect(() => {
    void load.run(async () => {
      const r = await getIntegrationSettings(project);
      setServerCanEdit(r.canEdit);
      apply(r.settings);
    });
    // load.run is stable.
  }, [project]);

  const canEdit = props.canEdit && serverCanEdit;
  const resolutionsError = roundsError(t, resolutions, MAX_RESOLUTIONS_LIMIT);
  const fixesError = roundsError(t, fixes, MAX_FIXES_LIMIT);
  const dirty =
    data !== null &&
    (mode !== data.mode ||
      order !== data.order ||
      resolutions.trim() !== String(data.maxResolutions) ||
      fixes.trim() !== String(data.maxFixes));

  const store = (): Promise<boolean> => {
    if (resolutionsError !== null || fixesError !== null) return Promise.resolve(false);
    const body: IntegrationSettings = {
      mode,
      order,
      maxResolutions: Number(resolutions.trim()),
      maxFixes: Number(fixes.trim()),
    };
    return sectionSave(
      save,
      async () => {
        apply(await putIntegrationSettings(project, body));
        // p17-toasts-rest: a save result → toast. Saved from the tab's sticky bar, the bar's own "Kaydedildi"
        // toast is the result (one toast, not two).
        if (!card.inScope)
          toast.success(t.saved, { id: 'repo-integration-saved', testId: 'repo-integration-saved' });
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: canEdit && dirty,
    busy: save.busy,
    save: store,
    discard: () => {
      if (data !== null) apply(data);
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="dy-integration">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {data === null ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : canEdit ? (
        <form
          className="flex max-w-xl flex-col gap-3"
          data-testid="integration-settings"
          aria-label={t.form({ project })}
          onSubmit={(e) => {
            e.preventDefault();
            card.submit();
          }}
        >
          <FormGrid>
            <DySelect
              label={t.modeLabel}
              value={mode}
              options={[
                ['master', MODE_TEXT.master],
                ['off', MODE_TEXT.off],
              ]}
              onChange={(v) => {
                setMode(v === 'off' ? 'off' : 'master');
              }}
            />
            <DySelect
              label={t.orderLabel}
              value={order}
              options={[
                ['dependency', ORDER_TEXT.dependency],
                ['completion', ORDER_TEXT.completion],
              ]}
              onChange={(v) => {
                setOrder(v === 'completion' ? 'completion' : 'dependency');
              }}
            />
            <DyField
              label={t.resolutions}
              inputMode="numeric"
              value={resolutions}
              hint={t.resolutionsHint({ max: MAX_RESOLUTIONS_LIMIT })}
              error={resolutionsError}
              onChange={setResolutions}
            />
            <DyField
              label={t.fixes}
              inputMode="numeric"
              value={fixes}
              hint={t.fixesHint({ max: MAX_FIXES_LIMIT })}
              error={fixesError}
              onChange={setFixes}
            />
          </FormGrid>
          {card.inScope ? null : (
            <FormActions>
              <DyButton
                type="submit"
                variant="primary"
                busy={save.busy}
                disabled={!dirty || resolutionsError !== null || fixesError !== null}
              >
                {t.save}
              </DyButton>
            </FormActions>
          )}
          <DyApiError error={save.error} retryLeft={save.retryLeft} />
        </form>
      ) : (
        <div data-testid="integration-settings-read">
          <KeyValue
            rows={[
              { k: t.modeKey, v: MODE_TEXT[data.mode] },
              { k: t.orderKey, v: ORDER_TEXT[data.order] },
              { k: t.resolutionsKey, v: t.rounds({ n: data.maxResolutions }) },
              { k: t.fixesKey, v: t.rounds({ n: data.maxFixes }) },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ workspace

/** Shown wherever `web` egress is chosen or in effect (the classic `WebEgressRisk`). */
export function WebRisk(): ReactNode {
  const t = useT().projectTabs.workspace;
  return (
    <DyNotice tone="amber" testId="web-egress-risk">
      {t.webRisk}
    </DyNotice>
  );
}

/** Radio choice of the egress mode, each with its sentence (the classic RadioCards). */
export function EgressChoice(props: {
  readonly name: string;
  readonly value: EgressMode;
  readonly onChange: (v: EgressMode) => void;
}): ReactNode {
  const t = useT().projectTabs.workspace;
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.access}</legend>
      {EGRESS_MODES.map((m) => {
        const on = props.value === m;
        return (
          <label
            key={m}
            className={
              on
                ? 'flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[10px] border border-dy-teal bg-dy-teal-soft px-3 py-2'
                : 'flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[10px] border border-dy-line bg-dy-card px-3 py-2'
            }
          >
            <input
              type="radio"
              name={props.name}
              value={m}
              checked={on}
              className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
              onChange={() => {
                props.onChange(m);
              }}
            />
            <span className="min-w-0">
              <span className="block text-[0.875rem] font-bold">{t.egress[m].label}</span>
              <span className="block text-[0.8125rem] text-dy-muted">{t.egress[m].text}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function WorkspacePanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const fmt = useFormat();
  const { project } = props;
  const t = useT().projectTabs.workspace;
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [egress, setEgress] = useState<EgressMode>('none');
  const [hosts, setHosts] = useState('');
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useSubmit();
  const save = useSubmit();
  const sectionSave = useSectionSave();

  const reset = (s: WorkspaceSettings): void => {
    setSettings(s);
    setEgress(s.egress);
    setHosts(s.allowHosts.join('\n'));
    setHostsError(null);
  };

  useEffect(() => {
    void load.run(async () => {
      reset(await getWorkspaceSettings(project));
    });
    // load.run is stable.
  }, [project]);

  const submit = (): Promise<boolean> => {
    const parsed = parseAllowHosts(hosts);
    if (egress === 'allowlist' && parsed.error !== null) {
      setHostsError(parsed.error);
      return Promise.resolve(false);
    }
    if (egress === 'allowlist' && parsed.hosts.length === 0) {
      setHostsError(t.noHosts);
      return Promise.resolve(false);
    }
    setHostsError(null);
    return sectionSave(
      save,
      async () => {
        const saved = await putWorkspaceSettings(project, {
          egress,
          allowHosts: egress === 'allowlist' ? parsed.hosts : [],
        });
        reset(saved);
        setEditing(false);
        // p17-toasts-rest: a save result → toast. Saved from the tab's sticky bar, the bar's own "Kaydedildi"
        // toast is the result (one toast, not two).
        if (!card.inScope)
          toast.success(t.saved, { id: 'workspace-settings-saved', testId: 'workspace-settings-saved' });
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty:
      props.canEdit &&
      editing &&
      settings !== null &&
      (egress !== settings.egress || hosts !== settings.allowHosts.join('\n')),
    busy: save.busy,
    save: submit,
    discard: () => {
      if (settings !== null) reset(settings);
      setEditing(false);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t.access} sub={t.sub} testId="dy-workspace">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {settings === null ? (
          load.error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : !editing ? (
          <div className="flex flex-col gap-3">
            <div data-testid="workspace-view">
              <KeyValue
                rows={[
                  {
                    k: t.network,
                    v: (
                      <>
                        <b>{t.egress[settings.egress].label}</b> — {t.egress[settings.egress].text}
                      </>
                    ),
                  },
                  ...(settings.egress === 'allowlist'
                    ? [
                        {
                          k: t.hosts,
                          v: settings.allowHosts.length === 0 ? '—' : settings.allowHosts.join(', '),
                          mono: true,
                        },
                      ]
                    : []),
                  ...(settings.updatedAt === null
                    ? []
                    : [
                        {
                          k: t.changed,
                          v: (
                            <>
                              {fmt.dateWith(settings.updatedAt, DATE_TIME_NUMERIC)}
                              {settings.updatedBy === null ? null : (
                                <>
                                  {' · '}
                                  <DyActor actor={settings.updatedBy} />
                                </>
                              )}
                            </>
                          ),
                        },
                      ]),
                ]}
              />
            </div>
            {settings.egress === 'web' ? <WebRisk /> : null}
            {props.canEdit ? (
              <div>
                <DyButton
                  icon="pen"
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  {t.edit}
                </DyButton>
              </div>
            ) : null}
          </div>
        ) : (
          <form
            aria-label={t.editForm({ project })}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <EgressChoice name={`egress-${project}`} value={egress} onChange={setEgress} />
            {egress === 'allowlist' ? (
              <DyTextarea
                label={t.hosts}
                rows={5}
                mono
                value={hosts}
                spellCheck={false}
                placeholder={'api.example.com\ndocs.example.org:8443'} // i18n-ignore: example hosts
                hint={t.hostsHint({ max: MAX_ALLOW_HOSTS })}
                error={hostsError}
                onChange={setHosts}
              />
            ) : null}
            {egress === 'web' ? <WebRisk /> : null}
            <FormActions>
              {card.inScope ? null : (
                <DyButton type="submit" variant="primary" busy={save.busy}>
                  {t.save}
                </DyButton>
              )}
              <DyButton
                variant="ghost"
                onClick={() => {
                  reset(settings);
                  setEditing(false);
                }}
              >
                {t.cancel}
              </DyButton>
            </FormActions>
          </form>
        )}
        <DyApiError error={save.error} retryLeft={save.retryLeft} className="mt-3" />
      </Panel>
      {settings === null ? null : (
        <StoragePanel settings={settings} canEdit={props.canEdit} onSaved={reset} />
      )}
      {/* p15-workspace-retention: how long this project's kept working directories stay. */}
      <ProjectWorkfilesPolicy project={props.project} canEdit={props.canEdit} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ storage

/** "" → null, a whole number within bounds, or an error in the user's language (the classic `parseBound` decides validity). */
function bound(
  t: Messages['projectTabs']['storage'],
  text: string,
  min: number,
  max: number,
  unit: string,
): { value: number | null; error: string | null } {
  const r = parseBound(text, min, max, unit);
  if (r.error === null) return r;
  return {
    value: null,
    error: /^\d+$/.test(text.trim()) ? t.outOfRange({ min, max, unit }) : t.notNumber({ unit }),
  };
}

export function StoragePanel(props: {
  readonly settings: WorkspaceSettings;
  readonly canEdit: boolean;
  readonly onSaved: (s: WorkspaceSettings) => void;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().projectTabs.storage;
  const s = props.settings;
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState('');
  const [quota, setQuota] = useState('');
  // p17-output-limits: the project's lower output limits (empty: the server's).
  const [maxFiles, setMaxFiles] = useState('');
  const [jobMiB, setJobMiB] = useState('');
  const [errors, setErrors] = useState<{
    days: string | null;
    quota: string | null;
    files: string | null;
    job: string | null;
  }>({
    days: null,
    quota: null,
    files: null,
    job: null,
  });
  const save = useSubmit();
  const sectionSave = useSectionSave();
  const daysText = s.artifactRetentionDays === null ? '' : String(s.artifactRetentionDays);
  const quotaText = s.storageQuotaBytes === null ? '' : String(Math.round(s.storageQuotaBytes / MiB));
  const filesText = s.outputMaxFiles === null ? '' : String(s.outputMaxFiles);
  const jobText = s.outputMaxJobBytes === null ? '' : String(Math.round(s.outputMaxJobBytes / MiB));
  const out = s.outputLimits;

  const startEdit = (): void => {
    setDays(s.artifactRetentionDays === null ? '' : String(s.artifactRetentionDays));
    setQuota(s.storageQuotaBytes === null ? '' : String(Math.round(s.storageQuotaBytes / MiB)));
    setMaxFiles(filesText);
    setJobMiB(jobText);
    setErrors({ days: null, quota: null, files: null, job: null });
    setEditing(true);
  };

  const submit = (): Promise<boolean> => {
    const d = bound(t, days, RETENTION_DAYS.min, RETENTION_DAYS.max, t.days);
    const q = bound(t, quota, QUOTA_BYTES.min / MiB, QUOTA_BYTES.max / MiB, 'MiB'); // i18n-ignore: unit symbol
    const fl = bound(t, maxFiles, OUTPUT_FILES.min, OUTPUT_FILES.max, t.filesUnit);
    const jb = bound(t, jobMiB, OUTPUT_JOB_BYTES.min / MiB, OUTPUT_JOB_BYTES.max / MiB, 'MiB'); // i18n-ignore: unit symbol
    setErrors({ days: d.error, quota: q.error, files: fl.error, job: jb.error });
    if (d.error !== null || q.error !== null || fl.error !== null || jb.error !== null)
      return Promise.resolve(false);
    return sectionSave(
      save,
      async () => {
        const saved = await putWorkspaceSettings(s.project, {
          egress: s.egress,
          allowHosts: s.allowHosts,
          artifactRetentionDays: d.value,
          storageQuotaBytes: q.value === null ? null : q.value * MiB,
          // An older master ignores these (no output overrides there).
          ...(out === null
            ? {}
            : { outputMaxFiles: fl.value, outputMaxJobBytes: jb.value === null ? null : jb.value * MiB }),
        });
        props.onSaved(saved);
        setEditing(false);
        // p17-toasts-rest: a save result → toast. Saved from the tab's sticky bar, the bar's own "Kaydedildi"
        // toast is the result (one toast, not two).
        if (!card.inScope)
          toast.success(t.saved, { id: 'workspace-storage-saved', testId: 'workspace-storage-saved' });
      },
      t.stepUp({ project: s.project }),
    );
  };
  const card = useCardForm({
    dirty:
      props.canEdit &&
      editing &&
      (days.trim() !== daysText ||
        quota.trim() !== quotaText ||
        maxFiles.trim() !== filesText ||
        jobMiB.trim() !== jobText),
    busy: save.busy,
    save: submit,
    discard: () => {
      setEditing(false);
    },
  });

  const u = s.usage;
  const quotaB = s.storageQuotaBytes;
  const pct =
    quotaB === null ? null : quotaB === 0 ? 100 : Math.min(100, Math.round((u.bytes / quotaB) * 100));
  return (
    <Panel title={t.title} sub={t.sub} testId="workspace-storage">
      <div className="flex flex-col gap-3">
        <div data-testid="storage-usage">
          {pct === null || quotaB === null ? (
            <p className="m-0 text-[0.875rem]">{t.usedNoQuota({ size: formatBytes(u.bytes) })}</p>
          ) : (
            <Meter
              label={t.used}
              value={pct}
              tone={pct >= 100 ? 'red' : pct >= 85 ? 'amber' : 'teal'}
              text={t.usedOf({ used: formatBytes(u.bytes), quota: formatBytes(quotaB), pct })}
            />
          )}
          {pct !== null && pct >= 100 ? (
            <p className="m-0 mt-1 text-[0.8125rem] text-dy-red-ink">{t.full}</p>
          ) : null}
        </div>
        <KeyValue
          rows={[
            {
              k: t.files,
              v: t.filesValue({
                outputs: u.artifactFiles,
                outputSize: formatBytes(u.artifactBytes),
                inputs: u.inputFiles,
                inputSize: formatBytes(u.inputBytes),
                pruned: u.prunedFiles,
              }),
            },
            ...(u.oldestAt === null ? [] : [{ k: t.oldest, v: fmt.dateWith(u.oldestAt, DATE_TIME_NUMERIC) }]),
            {
              k: t.retention,
              v: (
                <span data-testid="storage-retention">
                  {s.artifactRetentionDays === null ? t.keep : t.deleteAfter({ n: s.artifactRetentionDays })}
                </span>
              ),
            },
            ...(out === null
              ? []
              : [
                  {
                    k: t.outputLimit,
                    v: (
                      <span data-testid="storage-output-limit" className="grid gap-0.5">
                        <span>
                          {t.outputLimitValue({
                            files: out.effectiveMaxFiles,
                            size: formatBytes(out.effectiveMaxJobBytes),
                          })}
                          {s.outputMaxFiles !== null || s.outputMaxJobBytes !== null
                            ? ` · ${t.outputOwn}`
                            : ''}
                        </span>
                        <span className="text-[0.8125rem] text-dy-muted">
                          {t.outputServer({
                            files: out.server.maxFiles,
                            size: formatBytes(out.server.maxJobBytes),
                          })}
                          {' · '}
                          {t.outputZip}
                        </span>
                      </span>
                    ),
                  },
                ]),
          ]}
        />
        {out?.server.storage === 'unavailable' ? (
          <DyNotice tone="amber" testId="storage-output-no-store">
            {t.outputNoStorage}
          </DyNotice>
        ) : null}
        {props.canEdit && !editing ? (
          <div>
            <DyButton icon="pen" onClick={startEdit}>
              {t.edit}
            </DyButton>
          </div>
        ) : null}
        {editing ? (
          <form
            aria-label={t.editForm({ project: s.project })}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <FormGrid>
              <DyField
                label={t.keepDays}
                inputMode="numeric"
                value={days}
                placeholder={t.noLimit}
                hint={t.keepDaysHint}
                error={errors.days}
                onChange={setDays}
              />
              <DyField
                label={t.quota}
                inputMode="numeric"
                value={quota}
                placeholder={t.noQuota}
                hint={t.quotaHint({ min: QUOTA_BYTES.min / MiB })}
                error={errors.quota}
                onChange={setQuota}
              />
              {out === null ? null : (
                <>
                  <DyField
                    label={t.maxFiles}
                    inputMode="numeric"
                    value={maxFiles}
                    placeholder={t.serverValue}
                    hint={t.maxFilesHint({ server: out.server.maxFiles, ceiling: out.ceilingMaxFiles })}
                    error={errors.files}
                    onChange={setMaxFiles}
                  />
                  <DyField
                    label={t.maxJobBytes}
                    inputMode="numeric"
                    value={jobMiB}
                    placeholder={t.serverValue}
                    hint={t.maxJobBytesHint({ server: formatBytes(out.server.maxJobBytes) })}
                    error={errors.job}
                    onChange={setJobMiB}
                  />
                </>
              )}
            </FormGrid>
            <DyNotice tone="amber">{t.warning}</DyNotice>
            <FormActions>
              {card.inScope ? null : (
                <DyButton type="submit" variant="primary" busy={save.busy}>
                  {t.save}
                </DyButton>
              )}
              <DyButton
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                }}
              >
                {t.cancel}
              </DyButton>
            </FormActions>
          </form>
        ) : null}
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
      </div>
    </Panel>
  );
}
