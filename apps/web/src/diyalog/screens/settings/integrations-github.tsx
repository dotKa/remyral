import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  appConnections,
  completeGitHubConnect,
  getGitHubStatus,
  type GitHubStatus,
  isUserAuthorizationState,
  startGitHubConnect,
  syncGitHubInstallations,
} from '../../../api/github';
import { INTEGRATIONS_PATH, type Navigate } from '../../../screens/integrationsPaths';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DyButtonLink, Panel, Pill, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { useT } from '../../../i18n/I18nProvider';
import { toast } from '../../toast/store';
import { useGuardedOp } from './integrations-ops';
import { GitHubAccountsSection, GitHubAuthorizeCallback } from './integrations-github-repos';
import { GitHubAppsSection } from './integrations-github-connections';
import { ExtButton, ExtLink, type RemovedApp } from './integrations-github-app';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Entegrasyonlar → GitHub in the Diyalog language, feature for feature with the
 * classic `GitHubCard` and the GitHub redirect pages (p5-github-connect, ADR-0022): connect with GitHub's App Manifest
 * flow (step-up, then a top-level navigation to the master's manifest form) and the callback (`?code&state`, removed
 * from the address bar at once, exchanged once with step-up) and installed (`?installation_id`, only a hint the master
 * verifies) pages. No key or secret is ever shown.
 *
 * p17-github-apps-ui (connections are listed as GitHub Apps): the tab is three parts —
 *   1. "GitHub App'leri": every App connection as the same card (integrations-github-app.tsx; the first App is no
 *      longer a panel of its own), "App ekle" and the guide; without any App the first-connect form.
 *   2. "Tüm App'ler": what applies to every App at once (re-read the installations of all Apps, environment Apps
 *      included).
 *   3. "GitHub hesabı": the personal account Remyral may act for (p15-github-create-repo).
 */

const browserNavigate: Navigate = (url) => {
  window.location.assign(url);
};

/** The first-connect form (no App at all yet). */
function FirstConnect(props: { readonly status: GitHubStatus; readonly navigate: Navigate }): ReactNode {
  const t = useT().integrations.github;
  const { status } = props;
  const [target, setTarget] = useState<'user' | 'organization'>('user');
  const [org, setOrg] = useState('');
  const act = useSubmit();
  const guarded = useGuardedOp();
  const connect = async (): Promise<void> => {
    await act.run(async () => {
      const res = await guarded(
        () =>
          startGitHubConnect(
            target === 'user' ? { kind: 'user' } : { kind: 'organization', organization: org.trim() },
          ),
        t.stepUpConnect,
      );
      if (res !== null) props.navigate(res.formUrl);
    });
  };
  return (
    <div className="flex flex-col gap-3 text-[0.875rem]" data-testid="github-disconnected">
      <p className="m-0 max-w-[68ch] text-dy-muted">{t.connectIntro}</p>
      {status.fileApps.length > 0 ? (
        <DyNotice tone="neutral">
          {t.fileApps({ apps: status.fileApps.map((a) => `${a.keyRef}: App ${a.appId}`).join(', ') })}
        </DyNotice>
      ) : null}
      {!status.available ? (
        <DyNotice tone="amber" title={t.noOriginTitle}>
          {t.noOriginBody}
        </DyNotice>
      ) : (
        <form
          aria-label={t.connect}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <fieldset className="m-0 flex flex-col border-0 p-0">
            <legend className="mb-0.5 text-[0.8125rem] font-bold">{t.whereLegend}</legend>
            {(
              [
                ['user', t.whereUser],
                ['organization', t.whereOrg],
              ] as const
            ).map(([v, l]) => (
              <label key={v} className="flex min-h-11 items-center gap-2.5 md:min-h-8">
                <input
                  type="radio"
                  name="dy-github-target"
                  className="size-4 accent-[var(--dy-teal)]"
                  checked={target === v}
                  onChange={() => {
                    setTarget(v);
                  }}
                />
                {l}
              </label>
            ))}
          </fieldset>
          {target === 'organization' ? (
            <DyField
              label={t.organization}
              value={org}
              placeholder="acme" // i18n-ignore: product name or example value
              spellCheck={false}
              autoComplete="off"
              mono
              hint={t.orgHint}
              onChange={setOrg}
            />
          ) : null}
          <div>
            <DyButton
              type="submit"
              variant="primary"
              busy={act.busy}
              disabled={target === 'organization' && org.trim() === ''}
            >
              {t.connect}
            </DyButton>
          </div>
        </form>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </div>
  );
}

/** "Tüm App'ler": what applies to every App connection at once. */
function AllAppsPanel(props: { readonly onStatus: (s: GitHubStatus) => void }): ReactNode {
  const t = useT().integrations.github;
  const tc = useT().chatGithub.connections;
  const sync = useSubmit();
  return (
    <Panel title={tc.wideTitle} sub={tc.wideSub} testId="github-installation-wide">
      <div className="flex flex-col gap-2 text-[0.875rem]">
        <div>
          <DyButton
            icon="retry"
            busy={sync.busy}
            onClick={() => {
              void sync.run(async () => {
                props.onStatus(await syncGitHubInstallations());
                toast.success(t.synced, { id: 'github-synced', testId: 'github-synced' });
              });
            }}
          >
            {tc.syncAll}
          </DyButton>
        </div>
        <p className="m-0 max-w-[68ch] text-[0.8125rem] text-dy-muted">{tc.syncAllHint}</p>
        <DyApiError error={sync.error} retryLeft={sync.retryLeft} />
      </div>
    </Panel>
  );
}

/** GitHub connection panels; `onStatus` lets the page summary follow a change. */
export function GitHubPanel(props: {
  readonly navigate?: Navigate | undefined;
  readonly onStatus?: (s: GitHubStatus) => void;
}): ReactNode {
  const t = useT().integrations.github;
  const tc = useT().chatGithub.connections;
  const navigate = props.navigate ?? browserNavigate;
  const [status, setStatusRaw] = useState<GitHubStatus | null>(null);
  const [removed, setRemoved] = useState<RemovedApp | null>(null);
  const load = useSubmit();
  const { onStatus } = props;
  const setStatus = useCallback(
    (s: GitHubStatus) => {
      setStatusRaw(s);
      onStatus?.(s);
    },
    [onStatus],
  );

  useEffect(() => {
    void load.run(async () => {
      setStatus(await getGitHubStatus());
    });
  }, []);

  const apps = status === null ? [] : appConnections(status);
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={tc.title}
        testId="dy-github"
        count={apps.length === 0 ? undefined : String(apps.length)}
        countLabel={tc.appsCount({ n: apps.length })}
        aside={
          status !== null && apps.length === 0 ? (
            <Pill tone="neutral" icon="clock">
              {t.notConnected}
            </Pill>
          ) : undefined
        }
        sub={t.panelSub}
      >
        <div className="flex flex-col gap-3">
          <DyApiError error={load.error} retryLeft={load.retryLeft} />
          {removed === null ? null : (
            <DyNotice
              tone="green"
              live
              testId="github-removed"
              action={
                <DyButton
                  variant="ghost"
                  onClick={() => {
                    setRemoved(null);
                  }}
                >
                  {t.ok}
                </DyButton>
              }
            >
              {t.disconnected} <ExtLink href={removed.url}>{t.deleteThere}</ExtLink>.
              {removed.projects.length > 0
                ? t.disconnectedProjects({ projects: removed.projects.join(', ') })
                : ''}
            </DyNotice>
          )}
          {status === null ? (
            load.error === null ? (
              <SkeletonRows label={t.loading} rows={2} />
            ) : null
          ) : apps.length === 0 ? (
            <FirstConnect status={status} navigate={navigate} />
          ) : (
            <div data-testid="github-connected">
              <GitHubAppsSection
                status={status}
                onStatus={setStatus}
                onRemoved={(r) => {
                  setRemoved(r);
                  void load.run(async () => {
                    setStatus(await getGitHubStatus());
                  });
                }}
                navigate={navigate}
              />
            </div>
          )}
        </div>
      </Panel>
      {status !== null && apps.length > 0 ? (
        <>
          <AllAppsPanel onStatus={setStatus} />
          {/* p15-github-create-repo: the GitHub account Remyral may act for (personal-account repositories). */}
          <div
            className="shadow-dy-edge min-w-0 rounded-[var(--dy-r-card)] border border-dy-line bg-dy-card px-4 py-3.5"
            data-testid="github-account-panel"
          >
            <GitHubAccountsSection />
          </div>
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ redirects

/**
 * GitHub's `redirect_url` after the App was created: `?code=…&state=…`. The code is removed from the address bar at
 * once and exchanged exactly once (the state is single use), as the classic page does.
 */
export function GitHubCallbackScreen(): ReactNode {
  const location = useLocation();
  // p15-github-create-repo: the same callback URL carries the account authorization (state `u.…`). Decided once: the
  // address bar is cleared right after the first render.
  const [userAuth] = useState(() =>
    isUserAuthorizationState(new URLSearchParams(location.search).get('state') ?? ''),
  );
  return userAuth ? <GitHubAuthorizeCallback /> : <GitHubManifestCallback />;
}

function GitHubManifestCallback(): ReactNode {
  const t = useT().integrations.github;
  const location = useLocation();
  const navigate = useNavigate();
  const params = useRef(new URLSearchParams(location.search));
  const started = useRef(false);
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const act = useSubmit();
  const guarded = useGuardedOp();
  const code = params.current.get('code');
  const state = params.current.get('state');

  const finish = async (): Promise<void> => {
    if (code === null || state === null) return;
    setCancelled(false);
    await act.run(async () => {
      const res = await guarded(() => completeGitHubConnect(code, state), t.stepUpComplete);
      if (res === null) setCancelled(true);
      else setStatus(res);
    });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The code must not stay in the address bar or the history.
    void navigate(location.pathname, { replace: true });
    void finish();
  }, []);

  return (
    <ScreenFrame
      title={t.connect}
      purpose={t.callbackPurpose}
      back={{ to: INTEGRATIONS_PATH, label: t.integrations }}
      width="narrow"
      testId="dy-github-callback"
    >
      <Panel title="GitHub App" /* i18n-ignore product name */>
        <div className="flex flex-col gap-3 text-[0.875rem]">
          {code === null || state === null ? (
            <DyNotice tone="red">{t.noCode}</DyNotice>
          ) : status !== null && status.app !== null ? (
            <>
              <DyNotice tone="green" live>
                {t.appConnected({ name: status.app.name })}
              </DyNotice>
              <FormActions>
                <ExtButton href={status.app.installUrl} newTab={false}>
                  {t.install}
                </ExtButton>
                <DyButtonLink to={INTEGRATIONS_PATH}>{t.backToIntegrations}</DyButtonLink>
              </FormActions>
            </>
          ) : cancelled ? (
            <DyNotice tone="amber" action={<DyButton onClick={() => void finish()}>{t.retry}</DyButton>}>
              {t.notConfirmed}
            </DyNotice>
          ) : act.error === null ? (
            <SkeletonRows label={t.connecting} rows={1} />
          ) : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          {act.error !== null ? (
            <div>
              <DyButtonLink to={INTEGRATIONS_PATH}>{t.backToIntegrations}</DyButtonLink>
            </div>
          ) : null}
        </div>
      </Panel>
    </ScreenFrame>
  );
}

/**
 * GitHub's `setup_url` after an installation: `?installation_id=…&setup_action=install|update`. The id is only a
 * hint — the master accepts it only when GitHub lists it for the App.
 */
export function GitHubInstalledScreen(): ReactNode {
  const t = useT().integrations.github;
  const location = useLocation();
  const started = useRef(false);
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const act = useSubmit();
  const raw = new URLSearchParams(location.search).get('installation_id');
  const id = raw !== null && /^\d{1,18}$/.test(raw) ? Number(raw) : undefined;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void act.run(async () => {
      setStatus(await syncGitHubInstallations(id));
    });
  }, []);

  const inst = status?.installations.find((i) => i.installationId === id);
  return (
    <ScreenFrame
      title={t.installedTitle}
      purpose={t.installedPurpose}
      back={{ to: INTEGRATIONS_PATH, label: t.integrations }}
      width="narrow"
      testId="dy-github-installed"
    >
      <Panel title={t.installation}>
        <div className="flex flex-col gap-3 text-[0.875rem]">
          {status !== null ? (
            <DyNotice tone="green" live>
              {inst !== undefined
                ? t.installedOn({
                    account: inst.account,
                    repos: inst.repositorySelection === 'all' ? t.allRepos : t.selectedRepos,
                  })
                : t.installationsSynced}{' '}
              {t.pickRepo}
            </DyNotice>
          ) : act.error === null ? (
            <SkeletonRows label={t.installSaving} rows={1} />
          ) : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          <FormActions>
            <DyButtonLink to="/projects">{t.projects}</DyButtonLink>
            <DyButtonLink to={INTEGRATIONS_PATH}>{t.integrations}</DyButtonLink>
          </FormActions>
        </div>
      </Panel>
    </ScreenFrame>
  );
}
