import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listApprovals, type ApprovalRequest } from '../../../api/approvals';
import {
  type DecisionRule,
  getDeployTargets,
  kindText as deployKindText,
  listOpsActions,
  type OpsAction,
  type ProjectDeployTargets,
} from '../../../api/deploy';
import { listProjects, type Project } from '../../../api/directory';
import { getProjectGitConfig, type ProjectGitConfig } from '../../../api/gitflow';
import { listJobs, type JobSummary } from '../../../api/jobs';
import { getProjectExecution, type ProjectExecution } from '../../../api/sandbox';
import { listProjectWorkers, type ProjectWorker } from '../../../api/workerConfig';
import { getWorkspaceSettings, type WorkspaceSettings } from '../../../api/workspaces';
import { useAuth } from '../../../auth/AuthProvider';
import type { TabItem } from '../../../lib/tabs';
import { toApiError } from '../../../components/ui';
import { firstLine } from '../../../screens/job/format';
import { targetText } from '../../../screens/deploy/DeploysPage';
import { Chip } from '../../Chip';
import { DyIcon } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { RuntimeMark } from '../../RuntimeMark';
import { StateBadge } from '../../StateBadge';
import {
  agoText,
  DyButtonLink,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  StatTile,
  StatTiles,
  ThreadLink,
} from '../parts';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import { DeploySections } from './tabs/DeploySections';
import { MachinesTab } from './tabs/MachinesTab';
import { MembersTab } from './tabs/MembersTab';
import { MemoryTab } from './tabs/MemoryTab';
import { LimitsTab, NetworkTab, PolicyTab } from './tabs/PolicyTab';
import { RepositoryTab } from './tabs/RepositoryTab';
import { FAILED_STATES, jobState, kindText, opsState, roleText, RUNNING_STATES } from './states';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import { ServicesPanel } from '../services/ServicesPanel';
import { DATE_TIME_NUMERIC } from '../../common/time';

// p19-ide W1: the Kod tab loads CodeMirror in its own chunk, only when the tab opens.
const CodeTab = lazy(() => import('../../code/CodeTab').then((m) => ({ default: m.CodeTab })));

/**
 * p12-diyalog Faz 4 — a project (`/projects/:id`). The classic tab ids stay (`?tab=repository|machines|policy|deploy|
 * memory|members`), so every deep link still lands. Genel bakış is new in the Diyalog language: what runs and what
 * failed, what waits for a person (approvals and deploys, each opening its card in the ops thread), the latest jobs
 * (each opening its job thread) and the project's repository / machines / deploy target / policy at a glance. The
 * other tabs reuse the classic sections — they hold the rules (validation, step-up, policy limits) — inside the
 * Diyalog frame, whose bridge gives them the Diyalog tokens and type.
 */

type Loaded<T> = T | null | 'error';

/** One read for the overview: null while loading, 'error' when it failed (shown quietly, as the classic page). */
function useLoad<T>(fn: () => Promise<T>, key: string): Loaded<T> {
  const [v, setV] = useState<Loaded<T>>(null);
  useEffect(() => {
    let live = true;
    setV(null);
    fn().then(
      (x) => {
        if (live) setV(x);
      },
      () => {
        if (live) setV('error');
      },
    );
    return () => {
      live = false;
    };
    // `fn` is rebuilt on every render; `key` names what it reads.
  }, [key]);
  return v;
}

const ok = <T,>(v: Loaded<T>): v is T => v !== null && v !== 'error';

function TabLink(props: { readonly tab: string; readonly children: ReactNode }): ReactNode {
  return (
    <Link
      to={`?tab=${props.tab}`}
      replace
      className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
    >
      {props.children}
    </Link>
  );
}

function Quiet(props: { readonly children: ReactNode }): ReactNode {
  return <p className="m-0 text-[0.875rem] text-dy-muted">{props.children}</p>;
}

function JobRow(props: { readonly job: JobSummary; readonly now: number }): ReactNode {
  const fmt = useFormat();
  const words = useT().projects;
  const timeWords = useT().screenKit.time;
  const { job } = props;
  const s = jobState(job.state, words);
  const title = firstLine(job.title) || job.id;
  return (
    <Row
      testId="dy-project-job"
      compact
      title={
        <Link
          to={`/jobs/${encodeURIComponent(job.id)}`}
          className="text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
        >
          {title}
        </Link>
      }
      meta={
        <>
          <StateBadge state={s.state} label={s.label} />
          {job.runtime === null ? null : <RuntimeMark runtime={job.runtime} />}
          <time dateTime={job.stateChangedAt} title={fmt.dateWith(job.stateChangedAt, DATE_TIME_NUMERIC)}>
            {agoText(job.stateChangedAt, props.now, timeWords)}
          </time>
        </>
      }
      actions={<ThreadLink target={{ kind: 'job', id: job.id }} about={title} />}
    />
  );
}

function DecisionRows(props: {
  readonly approvals: readonly ApprovalRequest[];
  readonly actions: readonly OpsAction[];
  readonly now: number;
}): ReactNode {
  const t = useT().projects.overview;
  const timeWords = useT().screenKit.time;
  return (
    <Rows label={t.decisions} testId="dy-project-decisions">
      {props.approvals.map((a) => {
        const what = a.headline.text || a.summary;
        return (
          <Row
            key={`a:${a.id}`}
            lead={<DyIcon name="shield" className="size-[18px]" />}
            tone="amber"
            title={what}
            meta={
              <>
                <Pill tone="amber">{t.approval}</Pill>
                <span>{a.action}</span>
                <span>{agoText(a.createdAt, props.now, timeWords)}</span>
              </>
            }
            actions={<ThreadLink target={{ kind: 'approval', id: a.id }} about={what} />}
          />
        );
      })}
      {props.actions.map((a) => {
        const what = `${deployKindText(a.kind)}${a.env === null ? '' : ` · ${a.env === 'production' ? 'production' : 'preview'}`}`;
        return (
          <Row
            key={`d:${a.id}`}
            lead={<DyIcon name="rocket" className="size-[18px]" />}
            tone={a.env === 'production' ? 'red' : 'amber'}
            title={what}
            meta={
              <>
                <Pill tone="amber">{t.deploy}</Pill>
                <span>{targetText(a)}</span>
                <span>{agoText(a.createdAt, props.now, timeWords)}</span>
              </>
            }
            actions={<ThreadLink target={{ kind: 'deploy', id: a.id }} about={what} />}
          />
        );
      })}
    </Rows>
  );
}

function targetsRows(
  t: ProjectDeployTargets,
  w: Messages['projects']['overview'],
): { k: string; v: ReactNode; mono?: boolean }[] {
  const rule = (r: DecisionRule): string => w.rules[r];
  const d = t.targets;
  if (d === null) return [];
  const rows: { k: string; v: ReactNode; mono?: boolean }[] = [];
  const res = (e: { uuids: readonly string[]; tags: readonly string[] } | null): string =>
    e === null
      ? '—'
      : `${w.resources({ n: e.uuids.length })}${e.tags.length > 0 ? w.tags({ n: e.tags.length }) : ''}`;
  if (d.coolify !== null) {
    rows.push({ k: w.coolifyPreview, v: res(d.coolify.preview) });
    rows.push({ k: w.coolifyProduction, v: res(d.coolify.production) });
  }
  if (d.pages !== null) rows.push({ k: w.pages, v: d.pages.projectName, mono: true });
  if (d.pagesProjects.length > 0) rows.push({ k: w.otherPages, v: d.pagesProjects.join(', '), mono: true });
  if (d.dns.zones.length > 0)
    rows.push({ k: w.dnsZones, v: d.dns.zones.map((z) => z.name).join(', '), mono: true });
  rows.push({ k: w.previewDeploy, v: rule(d.policy.previewDeploy) });
  rows.push({
    k: w.production,
    v: `${rule(d.policy.productionDeploy)}${d.policy.autoDeployProductionOnSuccess ? w.autoOnSuccess : ''}`,
  });
  return rows;
}

function Overview(props: { readonly project: Project }): ReactNode {
  const words = useT().projects;
  const t = words.overview;
  const { project } = props;
  const id = project.id;
  const now = Date.now();
  const workspace = project.kind === 'workspace';
  const jobs = useLoad(() => listJobs({ project: id }, null, { limit: 50 }), `jobs:${id}`);
  const approvals = useLoad(
    async () => (await listApprovals('pending')).filter((a) => a.project === id),
    `approvals:${id}`,
  );
  const waiting = useLoad(() => listOpsActions({ project: id, state: 'awaiting_approval' }), `ops:${id}`);
  const machines = useLoad<ProjectWorker[]>(() => listProjectWorkers(id), `workers:${id}`);
  const policy = useLoad<ProjectExecution>(() => getProjectExecution(id), `policy:${id}`);
  const targets = useLoad(() => getDeployTargets(id), `targets:${id}`);
  const repo = useLoad<{ git: ProjectGitConfig | null } | { ws: WorkspaceSettings }>(
    async () => (workspace ? { ws: await getWorkspaceSettings(id) } : { git: await getProjectGitConfig(id) }),
    `repo:${id}:${String(workspace)}`,
  );

  const items = ok(jobs) ? jobs.items : [];
  const running = items.filter((j) => RUNNING_STATES.has(j.state)).length;
  const failed = items.filter((j) => FAILED_STATES.has(j.state)).length;
  const pendingA = ok(approvals) ? approvals : [];
  const pendingD = ok(waiting) ? waiting : [];
  const decisions = pendingA.length + pendingD.length;
  const decisionsKnown = approvals !== null && waiting !== null;
  const assigned = ok(machines) ? machines.filter((w) => w.assigned) : [];
  const online = assigned.filter((w) => w.connected).length;
  const fullAccess = ok(policy) && policy.hostExecution && policy.unconfined && policy.allowAutoApprove;
  const tRows = ok(targets) ? targetsRows(targets, t) : [];

  return (
    <div className="flex flex-col gap-4" data-testid="dy-project-overview">
      <StatTiles label={t.summary}>
        <StatTile
          label={t.running}
          value={ok(jobs) ? running : '—'}
          note={ok(jobs) ? t.inLast({ n: items.length }) : undefined}
          testId="dy-stat-running"
        />
        <StatTile
          label={t.failed}
          value={ok(jobs) ? failed : '—'}
          note={failed > 0 ? t.review : ok(jobs) ? t.noProblem : undefined}
          tone={failed > 0 ? 'red' : 'green'}
          testId="dy-stat-failed"
        />
        <StatTile
          label={t.waiting}
          value={approvals === null && waiting === null ? '—' : decisions}
          note={decisions > 0 ? t.decision : t.noDecision}
          tone={decisions > 0 ? 'amber' : undefined}
          testId="dy-stat-decisions"
        />
        <StatTile
          label={t.machines}
          value={ok(machines) ? `${String(online)}/${String(assigned.length)}` : '—'}
          note={t.onlineAssigned}
          to="?tab=machines"
        />
      </StatTiles>

      {/* p12-diyalog-default (visual tour): "Senden bekleyenler" sits above the panels, so they wait until it is known
          (two quick reads) — drawn earlier, they jumped down when it arrived. */}
      {!decisionsKnown ? (
        <div className="rounded-[14px] border border-dy-line bg-dy-card">
          <SkeletonRows label={t.loadingSummary} rows={6} />
        </div>
      ) : (
        <>
          {decisions > 0 ? (
            <Panel
              title={t.decisions}
              count={String(decisions)}
              countLabel={t.decisionCount({ n: decisions })}
              sub={t.decisionsSub}
              flush
            >
              <DecisionRows approvals={pendingA} actions={pendingD} now={now} />
            </Panel>
          ) : null}

          {/* p17-ui-review: items-start — the jobs card ends with its last row instead of stretching to the height of
              the right column (an empty white block under "Tüm işler").
              p17-ui-polish: two independent column stacks (no grid rows) — the jobs and the machines that run them on
              the left, the repository, deploy target and policy on the right — so the taller right column no longer
              leaves a hole under the jobs card. On phones the columns dissolve (`contents`) and keep the old order:
              jobs, repository, machines, deploy target, policy. */}
          <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
              <div className="order-1 min-w-0 lg:order-none">
                <Panel title={t.recentJobs} flush testId="dy-project-jobs">
                  {jobs === null ? (
                    <SkeletonRows label={t.jobsLoading} />
                  ) : jobs === 'error' ? (
                    <EmptyLine>{t.jobsFailed}</EmptyLine>
                  ) : items.length === 0 ? (
                    <EmptyLine>{t.jobsEmpty}</EmptyLine>
                  ) : (
                    <Rows label={t.recentJobsOf({ id })}>
                      {items.slice(0, 8).map((j) => (
                        <JobRow key={j.id} job={j} now={now} />
                      ))}
                    </Rows>
                  )}
                  {items.length > 8 ? (
                    <div className="border-t border-dy-line px-4 py-2.5">
                      <Link
                        to={`/jobs?project=${encodeURIComponent(id)}`}
                        className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      >
                        {t.allJobs}
                      </Link>
                    </div>
                  ) : null}
                </Panel>
              </div>
              <div className="order-3 min-w-0 lg:order-none">
                <Panel
                  title={t.machines}
                  count={ok(machines) ? String(assigned.length) : undefined}
                  aside={<TabLink tab="machines">{t.open}</TabLink>}
                  testId="dy-overview-machines"
                >
                  {machines === null ? (
                    <Quiet>{t.loading}</Quiet>
                  ) : machines === 'error' ? (
                    <Quiet>{t.unreadable}</Quiet>
                  ) : assigned.length === 0 ? (
                    <Quiet>
                      {t.noMachines} <TabLink tab="machines">{t.assignMachine}</TabLink>
                    </Quiet>
                  ) : (
                    <ul className="m-0 grid list-none gap-1.5 p-0">
                      {assigned.slice(0, 5).map((w) => (
                        <li
                          key={w.workerId}
                          className="flex items-center justify-between gap-2 text-[0.875rem]"
                        >
                          <Link
                            to={`/machines/${encodeURIComponent(w.workerId)}`}
                            translate="no"
                            className="min-w-0 truncate font-dy-mono text-[0.8125rem] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                          >
                            {w.displayName}
                          </Link>
                          <StateBadge
                            state={w.connected ? 'done' : 'failed'}
                            label={w.connected ? t.connected : t.offline}
                          />
                        </li>
                      ))}
                      {assigned.length > 5 ? (
                        <li className="text-[0.8125rem] text-dy-muted">
                          {t.moreMachines({ n: assigned.length - 5 })}
                        </li>
                      ) : null}
                    </ul>
                  )}
                </Panel>
              </div>
            </div>

            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
              <div className="order-2 min-w-0 lg:order-none">
                <Panel
                  title={kindText(project.kind, words)}
                  aside={<TabLink tab="repository">{t.open}</TabLink>}
                  testId="dy-overview-repository"
                >
                  {repo === null ? (
                    <Quiet>{t.loading}</Quiet>
                  ) : repo === 'error' ? (
                    <Quiet>{t.unreadable}</Quiet>
                  ) : 'ws' in repo ? (
                    <Quiet>{words.egressModes[repo.ws.egress]}</Quiet>
                  ) : repo.git === null ? (
                    <Quiet>
                      {t.noRepo} <TabLink tab="repository">{t.registerRepo}</TabLink>
                    </Quiet>
                  ) : (
                    <KeyValue
                      rows={[
                        { k: t.repo, v: repo.git.repositoryUrl, mono: true },
                        { k: t.baseBranch, v: repo.git.baseBranch, mono: true },
                        { k: t.ci, v: repo.git.requireCi ? t.ciRequired : t.ciNotAwaited },
                      ]}
                    />
                  )}
                </Panel>
              </div>
              <div className="order-4 min-w-0 lg:order-none">
                <Panel
                  title={t.deployTarget}
                  aside={<TabLink tab="deploy">{t.open}</TabLink>}
                  testId="dy-overview-deploy"
                >
                  {targets === null ? (
                    <Quiet>{t.loading}</Quiet>
                  ) : targets === 'error' ? (
                    <Quiet>{t.unreadable}</Quiet>
                  ) : tRows.length === 0 ? (
                    <Quiet>
                      {t.noTarget} <TabLink tab="deploy">{t.addTarget}</TabLink>
                    </Quiet>
                  ) : (
                    <KeyValue rows={tRows} />
                  )}
                </Panel>
              </div>
              <div className="order-5 min-w-0 lg:order-none">
                <Panel
                  title={t.policy}
                  aside={<TabLink tab="policy">{t.open}</TabLink>}
                  testId="dy-overview-policy"
                >
                  {policy === null ? (
                    <Quiet>{t.loading}</Quiet>
                  ) : policy === 'error' ? (
                    <Quiet>{t.unreadable}</Quiet>
                  ) : (
                    <>
                      {fullAccess ? (
                        <Pill tone="red" icon="shield" className="mb-2">
                          {t.fullAccessOn}
                        </Pill>
                      ) : null}
                      <KeyValue
                        rows={[
                          { k: t.hostDirect, v: policy.hostExecution ? t.allowed : t.off },
                          { k: t.unconfined, v: policy.unconfined ? t.allowed : t.off },
                          { k: t.neverAsk, v: policy.allowAutoApprove ? t.allowed : t.off },
                          {
                            k: t.safeCommands,
                            v:
                              policy.safeCommands === 'off'
                                ? t.off
                                : policy.safeCommands === 'read-only'
                                  ? t.readOnly
                                  : t.readWrite,
                          },
                        ]}
                      />
                    </>
                  )}
                </Panel>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Deploy tab: a Diyalog summary of the latest ops actions (waiting ones open their card), then the classic sections. */
function DeployTab(props: {
  readonly project: Project;
  readonly canEdit: boolean;
  readonly canRun: boolean;
}): ReactNode {
  const words = useT().projects;
  const timeWords = useT().screenKit.time;
  const t = words.deployTab;
  const id = props.project.id;
  const actions = useLoad(() => listOpsActions({ project: id, limit: 8 }), `recent-ops:${id}`);
  const now = Date.now();
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t.title} sub={t.sub} flush testId="dy-project-ops">
        {actions === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : actions === 'error' ? (
          <EmptyLine>{t.failed}</EmptyLine>
        ) : actions.length === 0 ? (
          <EmptyLine>{t.empty}</EmptyLine>
        ) : (
          <Rows label={t.rows}>
            {actions.map((a) => {
              const s = opsState(a.state, words);
              const what = `${deployKindText(a.kind)}${a.env === null ? '' : ` · ${a.env}`}`;
              return (
                <Row
                  key={a.id}
                  testId="dy-project-op"
                  lead={<DyIcon name="rocket" className="size-[18px]" />}
                  tone={a.env === 'production' ? 'red' : undefined}
                  title={what}
                  meta={
                    <>
                      <StateBadge state={s.state} label={s.label} />
                      <span>{targetText(a)}</span>
                      <span>{agoText(a.createdAt, now, timeWords)}</span>
                    </>
                  }
                  actions={
                    a.state === 'awaiting_approval' ? (
                      <ThreadLink target={{ kind: 'deploy', id: a.id }} about={what} />
                    ) : (
                      <Link
                        to={`/deploys/${encodeURIComponent(a.id)}`}
                        className="text-[0.8125rem] font-medium text-dy-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
                      >
                        {t.details}
                      </Link>
                    )
                  }
                />
              );
            })}
          </Rows>
        )}
      </Panel>
      <DeploySections project={props.project} canEdit={props.canEdit} canRun={props.canRun} />
    </div>
  );
}

export function ProjectScreen(props: { readonly id: string }): ReactNode {
  const words = useT().projects;
  const t = words.screen;
  const tf = useT().forms.tabs.project;
  const { id } = props;
  const servicesLabel = useT().services.tab;
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : null;
  const canEdit = role === 'owner' || role === 'admin';
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    setProject(undefined);
    listProjects().then(
      (all) => {
        if (live) setProject(all.find((p) => p.id === id) ?? null);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [id]);

  const back = { to: '/projects', label: t.back };
  if (error !== null || project === undefined || project === null) {
    return (
      <ScreenFrame title={project === null ? t.notFound : id} back={back} testId="dy-project">
        <ErrorLine error={error} what={t.what} />
        {project === undefined && error === null ? <SkeletonRows label={t.loading} /> : null}
        {project === null ? (
          <Panel title={t.noSuch({ id })}>
            <p className="m-0 mb-3 text-[0.875rem] text-dy-muted">{t.noSuchHint}</p>
            <DyButtonLink to="/projects">{t.allProjects}</DyButtonLink>
          </Panel>
        ) : null}
      </ScreenFrame>
    );
  }

  const canRun = project.myRole !== 'viewer';
  const tabs: TabItem[] = [
    { id: 'overview', label: t.tabs.overview },
    // p19-ide W1: the repository's files (or a workspace project's kept working files), read-only.
    { id: 'code', label: t.tabs.code },
    { id: 'repository', label: project.kind === 'workspace' ? t.tabs.workspace : t.tabs.repository },
    { id: 'machines', label: t.tabs.machines },
    { id: 'policy', label: t.tabs.policy },
    // p15-form-pattern: the policy's network and limits cards are tabs of their own (one form each).
    { id: 'network', label: tf.network },
    { id: 'limits', label: tf.limits },
    { id: 'deploy', label: t.tabs.deploy },
    // p15-services: servers machines keep running for this project (no job slot).
    ...(project.kind === 'workspace' ? [] : [{ id: 'services', label: servicesLabel }]),
    { id: 'memory', label: t.tabs.memory },
    { id: 'members', label: t.tabs.members },
  ];
  return (
    <ScreenFrame
      title={project.name}
      back={back}
      testId="dy-project"
      purpose={
        <>
          <span translate="no" className="font-dy-mono text-[0.84375rem]">
            {project.id}
          </span>{' '}
          {t.purpose({ kind: kindText(project.kind, words), role: roleText(project.myRole, words) })}
        </>
      }
      facts={
        <>
          <Chip value={String(project.members)}>{t.chipMembers}</Chip>
          <Chip icon={project.kind === 'workspace' ? 'globe' : 'branch'}>
            {kindText(project.kind, words)}
          </Chip>
        </>
      }
      actions={
        canRun ? (
          <DyButtonLink
            to={`/jobs/new?project=${encodeURIComponent(project.id)}`}
            variant="primary"
            icon="plus"
          >
            {t.newJob}
          </DyButtonLink>
        ) : undefined
      }
    >
      <SegTabs label={t.tabsLabel({ id: project.id })} items={tabs}>
        {(tab) => {
          switch (tab) {
            case 'code':
              return (
                <Suspense fallback={<SkeletonRows label={t.tabs.code} rows={4} />}>
                  <CodeTab project={project.id} />
                </Suspense>
              );
            case 'repository':
              return <RepositoryTab project={project} canEdit={canEdit} />;
            case 'machines':
              return <MachinesTab project={project} canEdit={canEdit} />;
            case 'policy':
              return <PolicyTab project={project} canEdit={canEdit} />;
            case 'network':
              return <NetworkTab project={project} canEdit={canEdit} />;
            case 'limits':
              return <LimitsTab project={project} canEdit={canEdit} />;
            case 'deploy':
              return <DeployTab project={project} canEdit={canEdit} canRun={canRun} />;
            case 'services':
              return <ServicesPanel project={project.id} canManage={canRun} />;
            case 'memory':
              return <MemoryTab project={project} />;
            case 'members':
              return <MembersTab project={project} canEdit={canEdit} />;
            default:
              return <Overview project={project} />;
          }
        }}
      </SegTabs>
    </ScreenFrame>
  );
}
