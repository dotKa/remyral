import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { setUpGitHubWebhook } from '../../../api/automations';
import {
  type BranchProtection,
  disconnectGitHub,
  getBranchProtection,
  type GitHubApp,
  type GitHubConnection,
  type GitHubInstallation,
  type GitHubRepository,
  type GitHubStatus,
  listGitHubRepositories,
  renameGitHubConnection,
  rotateGitHubKey,
  setGitHubInstallationAccepted,
  syncGitHubInstallations,
} from '../../../api/github';
import { useSubmit } from '../../../screens/useSubmit';
import { useT } from '../../../i18n/I18nProvider';
import { DyConfirmDialog } from '../../common/actions';
import { DyIcon } from '../../icons';
import { toast } from '../../toast/store';
import { DyApiError, DyDetails, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DyFields } from '../records';
import { useGuardedOp } from './integrations-ops';

/**
 * p17-github-apps-ui — one GitHub App connection in Ayarlar → Entegrasyonlar → GitHub → "GitHub App'leri". Every App
 * (the first one included; panel Apps and Apps from the environment) is rendered by {@link GitHubAppCard}: a collapsed
 * row (name, owner kind, `keyRef · App id`, state, installation and project counts) that opens to the App's fields and
 * warnings, its installations (accept / withdraw, repositories, configure on GitHub), "Kurulumları yenile" and
 * "Depolara kur", the projects using it (with the base-branch protection badge), and its maintenance: the automation
 * webhook, key rotation (.pem upload), rename and remove. Every action addresses this App (`connectionId`; the master
 * has taken it since p17-chat-github); an older master's single App has no id and its actions address the first App,
 * as they always did. No key or secret is ever shown.
 */

export const KEY_AGE_WARN_DAYS = 180;

/** An external GitHub link in the button vocabulary (GitHub's own pages; same-tab where classic is). */
export function ExtButton(props: {
  readonly href: string;
  readonly newTab?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <a
      href={props.href}
      {...(props.newTab === false ? {} : { target: '_blank', rel: 'noopener noreferrer' })} // i18n-ignore: product name or example value
      className="dy-press inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-medium whitespace-nowrap text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
    >
      <DyIcon name="globe" className="size-4" />
      {props.children}
    </a>
  );
}

export function ExtLink(props: { readonly href: string; readonly children: ReactNode }): ReactNode {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" className="text-dy-teal-ink">
      {props.children}
    </a>
  );
}

/** Warns when the project's base branch has no protection rule on GitHub (ADR-0010 relies on it). */
export function ProtectionPill(props: { readonly project: string }): ReactNode {
  const t = useT().integrations.github;
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
  if (p.state === 'protected')
    return (
      <span data-testid={`protection-${p.project}`} data-state={p.state}>
        <Pill tone="green" icon="shield">
          {t.protected({ branch: p.branch ?? t.baseBranchCap })}
        </Pill>
      </span>
    );
  return (
    <span
      data-testid={`protection-${p.project}`}
      data-state={p.state}
      className="inline-flex max-w-full min-w-0 items-start gap-1 rounded-[10px] bg-dy-amber-soft px-2 py-0.5 text-[0.75rem] font-bold text-dy-amber-ink"
    >
      <DyIcon name="flag" className="mt-px size-3 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {p.state === 'unprotected'
          ? t.unprotected({ branch: p.branch ?? t.baseBranch })
          : p.state === 'missing'
            ? t.missing({ branch: p.branch ?? t.baseBranch })
            : t.unknown({ branch: p.branch ?? t.baseBranch })}
      </span>
    </span>
  );
}

/** p17-chat-github: accepted / pending pill and the button that changes it (always-fresh authenticator code). */
export function InstallationAcceptance(props: {
  readonly installation: GitHubInstallation;
  readonly onStatus: (s: GitHubStatus) => void;
}): ReactNode {
  const t = useT().chatGithub.connections;
  const i = props.installation;
  const act = useSubmit();
  const guarded = useGuardedOp();
  const set = (accepted: boolean): void => {
    void act.run(async () => {
      const res = await guarded(
        () => setGitHubInstallationAccepted(i.installationId, accepted),
        accepted ? t.stepUpAccept : t.stepUpWithdraw,
      );
      if (res === null) return;
      props.onStatus(res);
      toast.success(
        accepted ? t.acceptedToast({ account: i.account }) : t.withdrawnToast({ account: i.account }),
        {
          id: `github-accept-${String(i.installationId)}`,
        },
      );
    });
  };
  return (
    <span
      className="inline-flex flex-wrap items-center gap-2"
      data-testid={`github-acceptance-${String(i.installationId)}`}
    >
      {i.accepted ? (
        <Pill tone="green" icon="checkc">
          {t.accepted}
        </Pill>
      ) : (
        <Pill tone="amber" icon="clock">
          {t.pending}
        </Pill>
      )}
      <DyButton
        variant={i.accepted ? 'ghost' : 'primary'}
        busy={act.busy}
        onClick={() => {
          set(!i.accepted);
        }}
      >
        {i.accepted ? t.withdraw : t.accept}
      </DyButton>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </span>
  );
}

function InstallationRow(props: {
  readonly installation: GitHubInstallation;
  readonly onStatus: (s: GitHubStatus) => void;
}): ReactNode {
  const t = useT().integrations.github;
  const i = props.installation;
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<readonly GitHubRepository[] | null>(null);
  const load = useSubmit();
  const listId = useId();
  const toggle = async (): Promise<void> => {
    setOpen(!open);
    if (!open && repos === null)
      await load.run(async () => {
        setRepos((await listGitHubRepositories({ installationId: i.installationId, pageSize: 100 })).items);
      });
  };
  return (
    <li className="border-t border-dy-line px-4 py-3 first:border-t-0" data-testid="dy-installation">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <DyIcon name="folder" className="size-4 text-dy-muted" />
        <span className="font-medium" translate="no">
          {i.account}
        </span>
        <span className="text-[0.8125rem] text-dy-muted">
          {i.accountType === 'Organization' ? t.organization : t.account} ·{' '}
          {i.repositorySelection === 'all' ? t.allRepos : t.selectedRepos}
        </span>
        {i.suspended ? (
          <Pill tone="amber" icon="pause">
            {t.suspended}
          </Pill>
        ) : null}
        <InstallationAcceptance installation={i} onStatus={props.onStatus} />
        <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <DyButton variant="ghost" aria-expanded={open} aria-controls={listId} onClick={() => void toggle()}>
            {open ? t.hideRepos : t.showRepos}
          </DyButton>
          {i.htmlUrl !== null ? <ExtButton href={i.htmlUrl}>{t.configure}</ExtButton> : null}
        </span>
      </div>
      {open ? (
        <div id={listId} className="mt-2 pl-7">
          <DyApiError error={load.error} retryLeft={load.retryLeft} />
          {repos === null ? (
            load.error === null ? (
              <SkeletonRows label={t.reposLoading} rows={1} />
            ) : null
          ) : repos.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noRepos}</p>
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-0.5 p-0 text-[0.8125rem]"
              aria-label={t.reposOf({ account: i.account })}
            >
              {repos.map((r) => (
                <li key={r.fullName} className="font-dy-mono [overflow-wrap:anywhere]">
                  {r.fullName}
                  {r.archived ? <span className="font-dy-sans text-dy-muted"> {t.archived}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** p6-automations: point this App's webhook at the console (a new secret per App). */
function AutomationWebhook(props: {
  readonly connectionId: number | null;
  readonly set: boolean;
}): ReactNode {
  const t = useT().integrations.github;
  const tc = useT().chatGithub.connections;
  const save = useSubmit();
  const guarded = useGuardedOp();
  const [done, setDone] = useState<{ url: string; settingsUrl: string; events: readonly string[] } | null>(
    null,
  );
  return (
    <DyDetails
      summary={
        <span className="inline-flex flex-wrap items-center gap-2">
          {t.webhookSummary}
          {props.set ? (
            <Pill tone="green" icon="checkc">
              {tc.webhookSet}
            </Pill>
          ) : null}
        </span>
      }
      testId="github-webhook-setup"
    >
      <div className="flex flex-col gap-2 text-[0.875rem]">
        <p className="m-0 text-dy-muted">{t.webhookIntro}</p>
        <div>
          <DyButton
            busy={save.busy}
            onClick={() => {
              void save.run(async () => {
                const res = await guarded(
                  () => setUpGitHubWebhook({}, props.connectionId ?? undefined),
                  t.stepUpWebhook,
                );
                if (res !== null) setDone(res);
              });
            }}
          >
            {t.webhookSetup}
          </DyButton>
        </div>
        {done !== null ? (
          <DyNotice tone="green" live>
            {t.webhookDone.before}{' '}
            <code className="font-dy-mono text-[0.78125rem] break-all">{done.url}</code>
            {t.webhookDone.middle} <ExtLink href={done.settingsUrl}>{t.webhookDone.link}</ExtLink>{' '}
            {t.webhookDone.after({ events: done.events.join(', ') })}
          </DyNotice>
        ) : null}
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
      </div>
    </DyDetails>
  );
}

function RotateKey(props: {
  readonly app: GitHubApp;
  readonly connectionId: number | null;
  readonly onStatus: (s: GitHubStatus) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const t = useT().integrations.github;
  const app = props.app;
  const [pem, setPem] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  // p17-toasts-rest: stays inline on purpose — it tells the person what to do next (delete the old key on GitHub).
  const [done, setDone] = useState(false);
  const save = useSubmit();
  const guarded = useGuardedOp();
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (ref.current !== null && ref.current.open !== props.open) ref.current.open = props.open;
  }, [props.open]);
  const upload = async (): Promise<void> => {
    setDone(false);
    const key = pem;
    if (key === null) return;
    await save.run(async () => {
      const res = await guarded(
        () => rotateGitHubKey(key, {}, props.connectionId ?? undefined),
        t.stepUpRotate,
      );
      if (res !== null) {
        setPem(null);
        setFileName('');
        setDone(true);
        props.onStatus(res);
      }
    });
  };
  return (
    <details
      ref={ref}
      className="group/rotate min-w-0 rounded-[10px] border border-dy-line bg-dy-card"
      data-testid="github-rotate-key"
      onToggle={(e) => {
        props.onOpenChange(e.currentTarget.open);
      }}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3.5 text-[0.875rem] font-medium [&::-webkit-details-marker]:hidden">
        <DyIcon
          name="chev"
          className="size-4 shrink-0 -rotate-90 text-dy-muted transition-transform group-open/rotate:rotate-0 motion-reduce:transition-none"
        />
        {t.rotate}
      </summary>
      <div className="flex flex-col gap-2 border-t border-dy-line px-3.5 py-3 text-[0.875rem]">
        <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-dy-muted">
          <li>
            <ExtLink href={app.settingsUrl}>{t.rotateLink}</ExtLink> {t.rotateStep1}
          </li>
          <li>{t.rotateStep2}</li>
          <li>
            {t.rotateStep3} <span className="font-dy-mono">{app.keyFingerprint}</span>).
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept=".pem,application/x-pem-file"
            aria-label={t.keyFile}
            className="min-h-11 max-w-full text-[0.875rem] text-dy-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[9px] file:border file:border-dy-line-2 file:bg-dy-card file:px-3 file:font-medium file:text-dy-ink"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setDone(false);
              if (f === undefined) return;
              setFileName(f.name);
              void f.text().then(setPem);
            }}
          />
          <DyButton icon="key" busy={save.busy} disabled={pem === null} onClick={() => void upload()}>
            {t.uploadKey}
          </DyButton>
        </div>
        {fileName !== '' && pem !== null ? (
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.selected({ name: fileName })}</p>
        ) : null}
        {done ? (
          <DyNotice tone="green" live>
            {t.rotated}
          </DyNotice>
        ) : null}
        <DyApiError error={save.error} retryLeft={save.retryLeft} />
      </div>
    </details>
  );
}

/** What a removal left on GitHub (the App itself) and which projects lost it. */
export interface RemovedApp {
  readonly projects: readonly string[];
  readonly url: string;
}

/** Rename (panel Apps with an id) and remove (confirmed, always-fresh step-up). */
function AppActions(props: {
  readonly connection: GitHubConnection;
  readonly onStatus: (s: GitHubStatus) => void;
  readonly onRemoved: (removed: RemovedApp) => void;
}): ReactNode {
  const t = useT().chatGithub.connections;
  const c = props.connection;
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(c.label ?? '');
  const [confirming, setConfirming] = useState(false);
  const act = useSubmit();
  const guarded = useGuardedOp();
  return (
    <div className="flex flex-col gap-2">
      {renaming ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const id = c.id;
            if (id === null) return;
            void act.run(async () => {
              const res = await guarded(
                () => renameGitHubConnection(id, label.trim() === '' ? null : label.trim()),
                t.stepUpRename,
              );
              if (res === null) return;
              props.onStatus(res);
              setRenaming(false);
            });
          }}
        >
          <DyField label={t.labelField} value={label} maxLength={60} onChange={setLabel} />
          <FormActions>
            <DyButton type="submit" variant="primary" busy={act.busy}>
              {t.save}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setRenaming(false);
              }}
            >
              {t.cancel}
            </DyButton>
          </FormActions>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {c.id !== null ? (
            <DyButton
              variant="ghost"
              onClick={() => {
                setRenaming(true);
              }}
            >
              {t.rename}
            </DyButton>
          ) : null}
          <DyButton
            variant="danger"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t.remove}
          </DyButton>
        </div>
      )}
      <DyConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t.removeTitle}
        description={t.removeBody({ n: c.projects.length, projects: c.projects.join(', ') })}
        confirmLabel={t.removeConfirm}
        cancelLabel={t.cancel}
        busy={act.busy}
        testId="github-disconnect-confirm"
        onConfirm={() => {
          setConfirming(false);
          void act.run(async () => {
            const res = await guarded(() => disconnectGitHub({}, c.id ?? undefined), t.stepUpRemove);
            if (res === null) return;
            toast.success(t.removed, { id: `github-removed-${c.keyRef}` });
            props.onRemoved({ projects: res.affectedProjects, url: res.settingsUrl });
          });
        }}
      />
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </div>
  );
}

/** Whether a card starts open: the only App, or one that needs the owner. */
export function needsAttention(c: GitHubConnection): boolean {
  const app = c.app;
  if (
    app !== null &&
    (!app.keyUsable || app.keyAgeDays >= KEY_AGE_WARN_DAYS || app.missingPermissions.length > 0)
  )
    return true;
  if (c.installations.some((i) => !i.accepted)) return true;
  return !c.readOnly && c.installations.length === 0;
}

/** One GitHub App connection — the same component and layout for every App. */
export function GitHubAppCard(props: {
  readonly status: GitHubStatus;
  readonly connection: GitHubConnection;
  /** More than one App: the default one carries the "Varsayılan App" mark. */
  readonly many: boolean;
  readonly defaultOpen: boolean;
  readonly onStatus: (s: GitHubStatus) => void;
  readonly onRemoved: (removed: RemovedApp) => void;
}): ReactNode {
  const t = useT().integrations.github;
  const tc = useT().chatGithub.connections;
  const c = props.connection;
  const app = c.app;
  const isDefault = props.many && c.keyRef === props.status.defaultKeyRef;
  const [open] = useState(props.defaultOpen);
  const [rotating, setRotating] = useState(false);
  const sync = useSubmit();
  const title = c.label ?? app?.owner.login ?? c.keyRef;
  const kind = app === null ? null : app.owner.type === 'Organization' ? t.organizationLower : t.accountLower;
  const pending = c.installations.some((i) => !i.accepted);
  const keyBroken = app !== null && !app.keyUsable;
  const details = new Map(props.status.projects.map((p) => [p.project, p]));
  const rotateNow = (
    <DyButton
      onClick={() => {
        setRotating(true);
      }}
    >
      {t.rotateNow}
    </DyButton>
  );
  const refresh = (): void => {
    void sync.run(async () => {
      props.onStatus(await syncGitHubInstallations(undefined, {}, c.id ?? undefined));
      // p17-toasts-rest: a sync result → toast.
      toast.success(t.synced, { id: 'github-synced', testId: 'github-synced' });
    });
  };
  return (
    <li className="list-none" data-testid="github-connection" data-key-ref={c.keyRef}>
      <details
        open={open}
        className="group/app min-w-0 rounded-[10px] border border-dy-line bg-dy-card"
        data-testid="github-app"
      >
        <summary className="flex min-h-12 cursor-pointer list-none items-start gap-2 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
          <DyIcon
            name="chev"
            className="mt-1 size-4 shrink-0 -rotate-90 text-dy-muted transition-transform group-open/app:rotate-0 motion-reduce:transition-none"
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium" translate="no">
              {title}
            </span>
            {kind === null ? null : <span className="text-[0.8125rem] text-dy-muted">{kind}</span>}
            <span className="font-dy-mono text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
              {c.keyRef} · App {c.appId /* i18n-ignore: product name */}
            </span>
            {keyBroken ? (
              <Pill tone="red" icon="xc">
                {tc.keyUnusable}
              </Pill>
            ) : pending ? (
              <Pill tone="amber" icon="clock">
                {tc.pendingPill}
              </Pill>
            ) : c.readOnly ? null : (
              <Pill tone="green" icon="checkc">
                {t.connected}
              </Pill>
            )}
            {c.readOnly ? (
              <Pill tone="neutral" icon="key">
                {tc.envSource}
              </Pill>
            ) : null}
            {isDefault ? (
              <Pill tone="teal" icon="flag" title={tc.defaultHint}>
                {tc.defaultApp}
              </Pill>
            ) : null}
            <span className="text-[0.8125rem] text-dy-muted sm:ml-auto" data-testid="github-app-counts">
              {tc.counts({ installations: c.installations.length, projects: c.projects.length })}
            </span>
          </span>
        </summary>
        <div className="flex flex-col gap-4 border-t border-dy-line px-3.5 py-3.5">
          {isDefault ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="github-default-app">
              {tc.defaultHint}
            </p>
          ) : null}
          {c.readOnly ? <p className="m-0 text-[0.8125rem] text-dy-muted">{tc.envHint}</p> : null}
          {app === null ? null : (
            <>
              <DyFields
                rows={[
                  {
                    k: t.fieldApp,
                    v: (
                      <>
                        <ExtLink href={app.htmlUrl}>{app.name}</ExtLink>{' '}
                        <span className="font-dy-mono text-[0.8125rem] text-dy-muted">
                          {t.appId({ slug: app.slug, id: app.appId })}
                        </span>
                      </>
                    ),
                  },
                  {
                    k: t.fieldOwner,
                    v: t.owner({ login: app.owner.login, kind: kind ?? t.accountLower }),
                  },
                  {
                    k: t.fieldKey,
                    v: (
                      <>
                        <span className="font-dy-mono break-all">{app.keyFingerprint}</span> ·{' '}
                        <span data-testid="github-key-age">
                          {app.keyAgeDays === 0 ? t.keyToday : t.keyAge({ days: app.keyAgeDays })}
                        </span>
                      </>
                    ),
                  },
                ]}
              />
              {!app.keyUsable ? (
                <DyNotice tone="red" action={rotateNow}>
                  {t.keyUnusable}
                </DyNotice>
              ) : app.keyAgeDays >= KEY_AGE_WARN_DAYS ? (
                <DyNotice tone="amber" action={rotateNow}>
                  {t.keyOld({ days: app.keyAgeDays })}
                </DyNotice>
              ) : null}
              {app.missingPermissions.length > 0 ? (
                <DyNotice
                  tone="amber"
                  action={<ExtButton href={app.settingsUrl}>{t.openAppSettings}</ExtButton>}
                >
                  {t.missingPermissions({ permissions: app.missingPermissions.join(', ') })}
                </DyNotice>
              ) : null}
            </>
          )}

          <section aria-label={t.installations} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="m-0 text-[0.875rem] font-bold">{t.installations}</h4>
              <div className="flex flex-wrap gap-2">
                {c.readOnly ? null : (
                  <DyButton icon="retry" busy={sync.busy} onClick={refresh}>
                    {t.syncInstallations}
                  </DyButton>
                )}
                {app === null ? null : (
                  <ExtButton href={app.installUrl} newTab={false}>
                    {t.install}
                  </ExtButton>
                )}
              </div>
            </div>
            <DyApiError error={sync.error} retryLeft={sync.retryLeft} />
            {c.installations.length === 0 ? (
              <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="github-no-installations">
                {t.noInstallations}
              </p>
            ) : (
              <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-dy-line p-0">
                {c.installations.map((i) => (
                  <InstallationRow key={i.installationId} installation={i} onStatus={props.onStatus} />
                ))}
              </ul>
            )}
            {pending ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="github-pending-hint">
                {tc.pendingHint}
              </p>
            ) : null}
          </section>

          <section aria-label={t.projectsLabel} className="flex flex-col gap-2">
            <h4 className="m-0 text-[0.875rem] font-bold">{t.projects}</h4>
            {c.projects.length === 0 ? (
              <p className="m-0 text-[0.875rem] text-dy-muted">
                {t.noProjects.before}{' '}
                <Link className="text-dy-teal-ink" to="/projects">
                  {t.projects}
                </Link>{' '}
                {t.noProjects.after}
              </p>
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-dy-line">
                <Rows label={t.projectRows}>
                  {c.projects.map((name) => {
                    const p = details.get(name);
                    return (
                      <Row
                        key={name}
                        title={name}
                        meta={
                          p === undefined ? undefined : (
                            <span className="min-w-0 font-dy-mono [overflow-wrap:anywhere]">
                              {p.repositoryUrl} · {p.baseBranch}
                            </span>
                          )
                        }
                        trail={<ProtectionPill project={name} />}
                      />
                    );
                  })}
                </Rows>
              </div>
            )}
          </section>

          {c.readOnly ? null : (
            <div className="flex flex-col gap-2 border-t border-dy-line pt-3">
              <AutomationWebhook connectionId={c.id} set={c.webhook} />
              {app === null ? null : (
                <RotateKey
                  app={app}
                  connectionId={c.id}
                  onStatus={props.onStatus}
                  open={rotating}
                  onOpenChange={setRotating}
                />
              )}
              <AppActions connection={c} onStatus={props.onStatus} onRemoved={props.onRemoved} />
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
