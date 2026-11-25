import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  archiveWorkflow,
  duplicateWorkflow,
  listWorkflows,
  type WorkflowSummary,
} from '../../../api/workflowDefs';
import { toApiError } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import { useSubmit } from '../../../screens/useSubmit';
import { RowMenu } from '../../chat/RowMenu';
import { DyIcon } from '../../icons';
import { runLook } from '../jobs/WorkflowRuns';
import { DyApiError, DyDialog, DyInput } from '../kit';
import {
  DyButton,
  DyButtonLink,
  DySearch,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { agoIn, WORKFLOW_NAME } from './model';
import { CopyToProjectDialog, isProjectAdmin, OffersDialog } from './SharingDialogs';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §2): `/workflows` — every workflow definition of the visible
 * projects (the latest version), with its last run, success rate and run count; filters (project, search, archived)
 * in the URL; actions Aç, Çalıştır (the composer's workflow run with this workflow), Kopyala (a new name, version 1)
 * and Arşivle / Arşivden çıkar. Writes need the project's operator role (workflows.define); the master decides.
 */

const RANK: Readonly<Record<string, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function canDefine(projects: readonly Project[] | null, project: string): boolean {
  const p = projects?.find((x) => x.id === project);
  return p !== undefined && (RANK[p.myRole] ?? 0) >= 1;
}

export function runHref(w: { readonly id: string; readonly project: string }): string {
  return `/jobs/new?mode=workflow&workflow=${encodeURIComponent(w.id)}&project=${encodeURIComponent(w.project)}`;
}

/**
 * p18-multi-project: the editor / viewer of a workflow row — a workflow the row's project attached from another
 * project opens through that project (`?project=`, read-only with "Bu projedeki ayarlar").
 */
export function workflowHref(w: Pick<WorkflowSummary, 'id' | 'project' | 'attachment'>): string {
  const base = `/workflows/${encodeURIComponent(w.id)}`;
  return w.attachment === undefined ? base : `${base}?project=${encodeURIComponent(w.project)}`;
}

/** "%83" of finished runs (succeeded / (succeeded + failed)); null without a finished run. */
export function successRate(w: WorkflowSummary): number | null {
  const done = w.succeeded + w.failed;
  return done === 0 ? null : Math.round((w.succeeded / done) * 100);
}

function DuplicateDialog(props: {
  readonly source: WorkflowSummary | null;
  readonly onClose: () => void;
  readonly onDone: (id: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const act = useSubmit();
  const w = useT().workflows;
  const t = w.list.duplicate;
  const src = props.source;
  const suffix = t.suffix;
  useEffect(() => {
    if (src !== null) setName(`${src.name}${suffix}`.slice(0, 64));
  }, [src, suffix]);
  const bad = !WORKFLOW_NAME.test(name);
  return (
    <DyDialog
      open={src !== null}
      onClose={props.onClose}
      size="sm"
      title={t.title}
      description={src === null ? undefined : t.description({ name: src.name, version: src.version })}
      testId="workflow-duplicate"
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
          <DyButton
            variant="primary"
            icon="copy"
            busy={act.busy}
            disabled={bad || act.blocked}
            onClick={() => {
              if (src === null) return;
              let id = '';
              void act
                .run(async () => {
                  id = (await duplicateWorkflow(src.id, name)).id;
                })
                .then((ok) => {
                  if (ok) props.onDone(id);
                });
            }}
          >
            {t.copy}
          </DyButton>
        </>
      }
    >
      <DyInput
        label={t.name}
        value={name}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        error={name !== '' && bad ? w.model.workflowNameInvalid : null}
        onChange={(e) => {
          setName(e.target.value.trim());
        }}
      />
      <DyApiError error={act.error} />
    </DyDialog>
  );
}

export function WorkflowsScreen(): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const gallery = t.workflowGallery;
  const l = t.workflows.list;
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<readonly WorkflowSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [dup, setDup] = useState<WorkflowSummary | null>(null);
  // p18-multi-project: "Paylaşılan workflow ekle" and "Projeye kopyala" of an attached workflow.
  const [offersOpen, setOffersOpen] = useState(false);
  const [copy, setCopy] = useState<WorkflowSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = useSubmit();
  const now = useNow();
  const ago = (iso: string): string => agoIn(t.workflows.time, iso, now);
  const navigate = useNavigate();

  const load = useCallback(() => {
    listWorkflows().then(
      (w) => {
        setItems(w);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setItems((p) => p ?? []);
      },
    );
  }, []);
  useEffect(() => {
    load();
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
  }, [load]);

  const project = params.get('project') ?? '';
  const q = params.get('q') ?? '';
  const archived = params.get('archived') === '1';
  const setParam = (k: string, v: string): void => {
    const next = new URLSearchParams(params);
    if (v === '') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? [])
      .filter((w) => w.archived === archived)
      .filter((w) => project === '' || w.project === project)
      .filter(
        (w) =>
          needle === '' ||
          w.name.toLowerCase().includes(needle) ||
          (w.description ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [items, q, archived, project]);
  const archivedCount = (items ?? []).filter((w) => w.archived).length;
  const projectIds = [
    ...new Set([...(projects ?? []).map((p) => p.id), ...(items ?? []).map((w) => w.project)]),
  ];
  const anyDefine = (projects ?? []).some((p) => (RANK[p.myRole] ?? 0) >= 1);
  const adminProjects = (projects ?? []).filter((p) => isProjectAdmin(projects, p.id));

  const toggleArchive = (w: WorkflowSummary): void => {
    setNotice(null);
    void act
      .run(async () => {
        await archiveWorkflow(w.id, !w.archived);
      })
      .then((ok) => {
        if (ok) {
          setNotice(w.archived ? l.unarchived({ name: w.name }) : l.archivedNotice({ name: w.name }));
          load();
        }
      });
  };

  return (
    <ScreenFrame
      title={l.title}
      purpose={l.purpose}
      testId="dy-workflows"
      actions={
        <>
          <DyButtonLink to="/workflows/templates" icon="grid">
            {gallery.open}
          </DyButtonLink>
          {adminProjects.length > 0 ? (
            <DyButton
              icon="branch"
              data-testid="workflow-offers-open"
              onClick={() => {
                setOffersOpen(true);
              }}
            >
              {t.workflowSharing.list.add}
            </DyButton>
          ) : null}
          {anyDefine ? (
            <DyButtonLink to="/workflows/new" variant="primary" icon="plus">
              {l.create}
            </DyButtonLink>
          ) : null}
        </>
      }
    >
      <ErrorLine error={error} what={l.title} onRetry={load} />
      <DyApiError error={act.error} />
      {notice === null ? null : (
        <p
          role="status"
          className="m-0 mb-4 rounded-[10px] bg-dy-green-soft px-3.5 py-2 text-[0.875rem] text-dy-green"
        >
          {notice}
        </p>
      )}
      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        <DySelect
          label={l.project}
          value={project}
          options={[['', l.allProjects], ...projectIds.map((p) => [p, p] as const)]}
          onChange={(v) => {
            setParam('project', v);
          }}
        />
        <DySearch
          label={l.search}
          value={q}
          placeholder={l.searchPlaceholder}
          onChange={(v) => {
            setParam('q', v);
          }}
        />
        <DyButton
          variant={archived ? 'primary' : 'secondary'}
          aria-pressed={archived}
          icon="tray"
          onClick={() => {
            setParam('archived', archived ? '' : '1');
          }}
        >
          {archivedCount > 0 ? l.archiveCount({ n: archivedCount }) : l.archive}
        </DyButton>
      </div>
      <Panel
        title={archived ? l.archivedTitle : l.title}
        count={items === null ? undefined : String(shown.length)}
        countLabel={l.count({ n: shown.length })}
        flush
        testId="workflow-list"
      >
        {items === null ? (
          <SkeletonRows label={l.loading} rows={4} />
        ) : shown.length === 0 ? (
          <EmptyLine
            testId="workflow-list-empty"
            action={
              anyDefine && !archived && q === '' ? (
                <>
                  <DyButtonLink to="/workflows/templates" icon="grid">
                    {gallery.emptyLink}
                  </DyButtonLink>
                  <DyButtonLink to="/workflows/new" icon="plus">
                    {l.createFirst}
                  </DyButtonLink>
                </>
              ) : undefined
            }
          >
            {archived ? l.emptyArchived : q !== '' || project !== '' ? l.emptyFilter : l.empty}
          </EmptyLine>
        ) : (
          <Rows label={l.title} className="grid-cols-[minmax(0,1fr)]">
            {shown.map((w) => {
              const rate = successRate(w);
              const last = w.lastRun === null ? null : runLook(w.lastRun.state, t);
              const editable = canDefine(projects, w.project);
              // p18-multi-project: a workflow this project attached from another project (read-only here).
              const att = w.attachment;
              const href = workflowHref(w);
              const runnable = !w.archived && editable && (att === undefined || att.state === 'enabled');
              return (
                <Row
                  key={`${w.project}:${w.id}`}
                  testId="workflow-row"
                  lead={<DyIcon name="branch" className="size-[18px]" />}
                  title={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <Link
                        to={href}
                        className="font-dy-mono font-bold text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      >
                        {w.name}
                      </Link>
                      <span className="font-dy-mono text-[0.78125rem] text-dy-muted">{`v${String(w.version)}`}</span>
                      {w.archived ? <Pill tone="neutral">{l.archivedPill}</Pill> : null}
                      {att === undefined ? null : (
                        <span data-testid="workflow-shared-pill">
                          <Pill tone="teal" icon="branch">
                            {t.workflowSharing.list.sharedPill({ owner: att.ownerProject })}
                          </Pill>
                        </span>
                      )}
                      {att?.pendingVersion == null ? null : (
                        <Pill tone="amber">{t.workflowSharing.list.pendingPill}</Pill>
                      )}
                      {att !== undefined && att.state !== 'enabled' ? (
                        <Pill tone="neutral">{t.workflowSharing.list.disabledPill}</Pill>
                      ) : null}
                    </span>
                  }
                  meta={
                    <>
                      {w.description === null ? null : (
                        <span className="w-full truncate text-dy-muted">{w.description}</span>
                      )}
                      <span>{w.project}</span>
                      <span>{l.steps({ n: w.nodes })}</span>
                      {last === null || w.lastRun === null ? (
                        <span>{l.neverRan}</span>
                      ) : (
                        <Link
                          to={`/jobs/workflows/${encodeURIComponent(w.lastRun.id)}`}
                          className="inline-flex items-center gap-1 text-dy-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
                          aria-label={l.lastRun({ state: last.label, ago: ago(w.lastRun.createdAt) })}
                        >
                          <Pill tone={last.tone} icon={last.icon}>
                            {last.label}
                          </Pill>
                          {ago(w.lastRun.createdAt)}
                        </Link>
                      )}
                      <span data-testid="workflow-rate">
                        {rate === null
                          ? l.runs({ n: w.runs })
                          : l.rate({ rate: fmt.percent(rate / 100), n: w.runs })}
                      </span>
                      <span>
                        {l.updatedBy({ who: w.createdBy ?? '—' })}
                        <time dateTime={w.createdAt} title={fmt.dateWith(w.createdAt, DATE_TIME_NUMERIC)}>
                          {ago(w.createdAt)}
                        </time>
                      </span>
                    </>
                  }
                  actions={
                    // p17-ui-polish: one primary action per row — Çalıştır when the row can run, else Aç — and
                    // the rest (Aç, Kopyala, Arşivle) in the row's menu.
                    <>
                      {runnable ? (
                        <DyButtonLink to={runHref(w)} icon="send" aria-label={l.runAria({ name: w.name })}>
                          {l.run}
                        </DyButtonLink>
                      ) : (
                        <DyButtonLink to={href} aria-label={l.openAria({ name: w.name })}>
                          {l.open}
                        </DyButtonLink>
                      )}
                      {editable && att !== undefined ? (
                        // p18-multi-project: an attached workflow is the owner's — open it here or copy it into
                        // this project; archiving belongs to the owner project.
                        <RowMenu
                          label={l.moreAria({ name: w.name })}
                          items={[
                            {
                              key: 'open',
                              label: t.workflowSharing.list.settings,
                              icon: 'gear' as const,
                              returnFocus: false,
                              onSelect: () => {
                                void navigate(href);
                              },
                            },
                            {
                              key: 'copy',
                              label: t.workflowSharing.list.copyToProject,
                              icon: 'copy',
                              returnFocus: false,
                              onSelect: () => {
                                setCopy(w);
                              },
                            },
                          ]}
                        />
                      ) : editable ? (
                        <RowMenu
                          label={l.moreAria({ name: w.name })}
                          items={[
                            ...(w.archived
                              ? []
                              : [
                                  {
                                    key: 'open',
                                    label: l.open,
                                    icon: 'pen' as const,
                                    returnFocus: false,
                                    onSelect: () => {
                                      void navigate(`/workflows/${encodeURIComponent(w.id)}`);
                                    },
                                  },
                                ]),
                            {
                              key: 'copy',
                              label: l.copy,
                              icon: 'copy',
                              returnFocus: false,
                              onSelect: () => {
                                setDup(w);
                              },
                            },
                            {
                              key: 'archive',
                              label: w.archived ? l.unarchiveAct : l.archiveAct,
                              icon: w.archived ? 'retry' : 'tray',
                              onSelect: () => {
                                if (!act.busy) toggleArchive(w);
                              },
                            },
                          ]}
                        />
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </Rows>
        )}
      </Panel>
      <DuplicateDialog
        source={dup}
        onClose={() => {
          setDup(null);
        }}
        onDone={(id) => {
          setDup(null);
          void navigate(`/workflows/${encodeURIComponent(id)}`);
        }}
      />
      <CopyToProjectDialog
        source={copy}
        onClose={() => {
          setCopy(null);
        }}
        onDone={(id) => {
          setCopy(null);
          void navigate(`/workflows/${encodeURIComponent(id)}`);
        }}
      />
      <OffersDialog
        open={offersOpen}
        projects={adminProjects}
        initialProject={adminProjects.some((p) => p.id === project) ? project : (adminProjects[0]?.id ?? '')}
        onClose={() => {
          setOffersOpen(false);
        }}
        onAttached={load}
      />
    </ScreenFrame>
  );
}
