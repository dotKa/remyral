import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import { defaultTarget, listModels, type ModelDefault } from '../../../api/models';
import { listProjectWorkers } from '../../../api/workerConfig';
import { useAuth } from '../../../auth/AuthProvider';
import { DyPager } from '../../common/pager';
import { DySortBar, sortRows, useSortParam } from '../../common/sort';
import { toApiError } from '../../../components/ui';
import { useResetPageOn } from '../../../lib/pageReset';
import { useClientPage } from '../../../lib/pager';
import { projectHref } from '../../../lib/reasons';
import { Chip } from '../../Chip';
import { DyIcon } from '../../icons';
import { RuntimeMark } from '../../RuntimeMark';
import {
  DyButton,
  DyButtonLink,
  DySearch,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { kindText, roleText } from './states';
import { useT } from '../../../i18n/I18nProvider';
import { NewProjectDialog } from './tabs/repo-new-project';
import { DyWizardHint } from '../../onboarding/nudge';

const PROJECT_SORT_KEYS = ['name', 'kind', 'members'] as const;
type ProjectSortKey = (typeof PROJECT_SORT_KEYS)[number];
const PROJECT_COMPARE: Readonly<Record<ProjectSortKey, (a: Project, b: Project) => number>> = {
  name: (a, b) => a.name.localeCompare(b.name, 'tr'),
  kind: (a, b) => a.kind.localeCompare(b.kind),
  members: (a, b) => a.members - b.members,
};

/**
 * p12-diyalog Faz 4 — Projeler (`/projects`): the projects the caller sees as rows (name, id, kind, the caller's role,
 * members, assigned machines) with a search; owners and admins register a project in a Diyalog dialog (the classic
 * fields, rules and step-up). Old deep links (`?project=<id>&section=…`) still open the project's tab.
 */

const SECTION_TAB: Readonly<Record<string, string>> = {
  repository: 'repository',
  workspace: 'repository',
  workers: 'machines',
  machines: 'machines',
  execution: 'policy',
  policy: 'policy',
  members: 'members',
};

/** Assigned machines per shown project (null: not readable). Read for the shown page only, as the classic list. */
function useMachineCounts(projects: readonly Project[] | null): Readonly<Record<string, number | null>> {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  // Keyed on the ids shown, not the array: a re-render must never read every project's machines again.
  const ids = projects === null ? null : projects.map((p) => p.id).join('\n');
  useEffect(() => {
    if (ids === null || ids === '') return;
    let live = true;
    for (const id of ids.split('\n')) {
      listProjectWorkers(id).then(
        (items) => {
          if (live) setCounts((m) => ({ ...m, [id]: items.filter((w) => w.assigned).length }));
        },
        () => {
          if (live) setCounts((m) => ({ ...m, [id]: null }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [ids]);
  return counts;
}

/** Per-project default models (classic "Default models" column); null when unreadable. */
function useModelDefaults(): readonly ModelDefault[] | null {
  const [defaults, setDefaults] = useState<readonly ModelDefault[] | null>(null);
  useEffect(() => {
    let live = true;
    listModels().then(
      (r) => {
        if (live) setDefaults(r.defaults);
      },
      () => {
        if (live) setDefaults(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return defaults;
}

function DefaultModels(props: {
  readonly project: string;
  readonly defaults: readonly ModelDefault[] | null;
}): ReactNode {
  const t = useT().projects.list;
  if (props.defaults === null) return null;
  const own = props.defaults.filter((d) => d.project === props.project);
  if (own.length === 0) return <span>{t.workspaceModels}</span>;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-2"
      data-testid="dy-project-models"
      title={own.map((d) => `${d.runtime}: ${defaultTarget(d)}`).join('\n')}
    >
      {t.defaultModels}
      {own.map((d) => (
        <RuntimeMark key={d.runtime} runtime={d.runtime} />
      ))}
    </span>
  );
}

function matches(p: Project, q: string): boolean {
  if (q === '') return true;
  const s = q.toLocaleLowerCase('tr');
  return p.name.toLocaleLowerCase('tr').includes(s) || p.id.toLocaleLowerCase('tr').includes(s);
}

export function ProjectsList(): ReactNode {
  const words = useT().projects;
  const t = words.list;
  const { state } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const role = state.kind === 'signedIn' ? state.user.role : null;
  const canEdit = role === 'owner' || role === 'admin';
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The classic table's sortable columns (project, kind, members), kept in the URL; name first by default.
  const [sort, setSort] = useSortParam(PROJECT_SORT_KEYS, { initial: { key: 'name', dir: 'asc' } });
  const shown = useMemo(
    () =>
      sortRows(
        (projects ?? []).filter((p) => matches(p, q.trim())),
        sort,
        PROJECT_COMPARE,
      ),
    [projects, q, sort],
  );
  const { pageItems, pagination } = useClientPage(shown, { label: t.pages });
  useResetPageOn(q);
  const pageShown = useMemo(() => (projects === null ? null : pageItems), [projects, pageItems]);
  const machines = useMachineCounts(pageShown);
  const defaults = useModelDefaults();

  const legacy = params.get('project');
  if (legacy !== null && legacy !== '') {
    const tab = SECTION_TAB[params.get('section') ?? ''];
    return (
      <Navigate
        replace
        to={`/projects/${encodeURIComponent(legacy)}${tab === undefined ? '' : `?tab=${tab}`}`}
      />
    );
  }

  const open = (): void => {
    setCreating(true);
  };
  const workspaces = (projects ?? []).filter((p) => p.kind === 'workspace').length;
  return (
    <ScreenFrame
      title={t.title}
      purpose={t.purpose}
      testId="dy-projects"
      facts={
        projects === null ? undefined : (
          <>
            <Chip value={String(projects.length)}>{t.chipProjects}</Chip>
            {workspaces > 0 ? <Chip value={String(workspaces)}>{t.chipWorkspaces}</Chip> : null}
          </>
        )
      }
      actions={
        canEdit ? (
          <>
            <DyButtonLink to="/settings/users" variant="ghost">
              {t.users}
            </DyButtonLink>
            <DyButton variant="primary" icon="plus" onClick={open}>
              {t.newProject}
            </DyButton>
          </>
        ) : undefined
      }
    >
      <NewProjectDialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onCreated={(id, then) => {
          setCreating(false);
          void load();
          // p15-github-create-repo: straight to Depo with the "new private repo" dialog open.
          void navigate(
            then?.newRepo === true ? `${projectHref(id, 'repository')}&newRepo=1` : projectHref(id),
          );
        }}
      />
      <ErrorLine error={error} what={t.what} onRetry={() => void load()} />
      <DySearch
        label={t.searchLabel}
        value={q}
        placeholder={t.searchPlaceholder}
        onChange={setQ}
        className="mb-4 max-w-sm"
      />
      <Panel
        title={t.allTitle}
        count={projects === null ? undefined : String(shown.length)}
        countLabel={t.count({ n: shown.length })}
        flush
        testId="dy-projects-list"
      >
        {projects === null && error === null ? <SkeletonRows label={t.loading} /> : null}
        {projects !== null && projects.length === 0 ? (
          <EmptyLine
            testId="dy-projects-empty"
            action={
              canEdit ? (
                <DyButton variant="primary" icon="plus" onClick={open}>
                  {t.newProject}
                </DyButton>
              ) : undefined
            }
          >
            {canEdit ? t.emptyEdit : t.emptyView}
            <span className="ml-2">
              <DyWizardHint step="project" />
            </span>
          </EmptyLine>
        ) : null}
        {projects !== null && projects.length > 0 && shown.length === 0 ? (
          <EmptyLine testId="dy-projects-nomatch">{t.noMatch({ q: q.trim() })}</EmptyLine>
        ) : null}
        {projects !== null && pageItems.length > 0 ? (
          <>
            <DySortBar
              keys={PROJECT_SORT_KEYS}
              labels={t.sort}
              sort={sort}
              onSort={setSort}
              defaultNote={t.sortDefault}
              sortedNote={t.sortSorted}
              className="border-b border-dy-line"
              testId="project-sort"
            />
            <Rows label={t.rowsLabel} testId="dy-project-rows">
              {pageItems.map((p) => {
                const m = machines[p.id];
                return (
                  <Row
                    key={p.id}
                    lead={<DyIcon name="folder" className="size-[18px]" />}
                    title={
                      <Link
                        to={projectHref(p.id)}
                        className="text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      >
                        {p.name}
                      </Link>
                    }
                    meta={
                      <>
                        {p.name !== p.id ? (
                          <span translate="no" className="font-dy-mono text-[0.78125rem]">
                            {p.id}
                          </span>
                        ) : null}
                        <span>{t.myRole({ role: roleText(p.myRole, words) })}</span>
                        <DefaultModels project={p.id} defaults={defaults} />
                      </>
                    }
                    trail={
                      <>
                        <Pill
                          tone={p.kind === 'workspace' ? 'violet' : 'teal'}
                          icon={p.kind === 'workspace' ? 'globe' : 'branch'}
                        >
                          {kindText(p.kind, words)}
                        </Pill>
                        <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                          {t.members({ n: p.members })}
                        </span>
                        <span
                          className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums"
                          data-testid="dy-project-machines"
                        >
                          {m === undefined || m === null ? t.machinesUnknown : t.machines({ n: m })}
                        </span>
                      </>
                    }
                  />
                );
              })}
            </Rows>
          </>
        ) : null}
        {projects !== null ? <DyPager {...pagination} className="px-4 pb-3" /> : null}
      </Panel>
    </ScreenFrame>
  );
}
