import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import {
  type DragEvent,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  DRAG_TYPE,
  dragPayload,
  getFolder,
  linkItems,
  type OutputFolder,
  type TreeNode,
  unlinkItems,
} from '../../../api/output-folders';
import {
  downloadZip,
  downloadZipOf,
  listOutputs,
  type OutputItem,
  type OutputType,
  updateOutputItem,
} from '../../../api/outputs';
import { findContext, type FoundContext } from '../../../api/search';
import { useAuth } from '../../../auth/AuthProvider';
import { cx, toApiError } from '../../../components/ui';
import { useOffsetList } from '../../../lib/pager';
import { displayName } from '../../../screens/outputs/format';
import { nodeKey } from '../../../screens/outputs/OutputsTree';
import { DyIcon, type IconName } from '../../icons';
import { DyChoice, DyDialog, DyPager } from '../kit';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import {
  DyButton,
  DySearch,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  SkeletonRows,
  ThreadLink,
} from '../parts';
import { OutputDetail } from './Detail';
import { WorkfilesOverview } from '../../workfiles/WorkfilesOverview';
import {
  AddToFolderDialog,
  Breadcrumb,
  DeleteFolderDialog,
  FolderCards,
  FolderFormDialog,
  FolderHeader,
  MoveFolderDialog,
} from './Folders';
import { NoteForm } from './NoteForm';
import type { Messages } from '@remyral/i18n';
import { HealthBadge, HealthThumb, siteWhere, UptimeBadge, type Viewer, When } from './shared';
import { DrillDown, OutputsTree } from './Tree';

/**
 * p12-diyalog Faz 4 (docs/design/p12-diyalog.md §12): Çıktılar — what jobs produced (live sites, files, notes) in the
 * Diyalog language. Same data, URL parameters and rules as the classic Outputs page (p6-outputs, p8-outputs-folders).
 * p12-diyalog-w2: every part is native now — the folder tree (classic keyboard) / phone drill-down, breadcrumb,
 * folder cards, header and dialogs (`Folders.tsx`, `Tree.tsx`), the item drawer as a side sheet with the previews
 * (`Detail.tsx`, `Preview.tsx`: sandboxed HTML exactly as the classic one), the note form, related jobs, the
 * Kartlar / Liste layout (remembered under the classic key) and the pager. Site links come already filtered to https
 * by `api/outputs.ts` and open without opener / referrer; previews use the classic same-origin paths.
 */

const TAB_IDS = ['all', 'site', 'file', 'note'] as const;
const WRITE_ROLES = new Set(['operator', 'admin', 'owner']);
const TREE_KEY = 'outputs.tree';
/** The classic layout key: Kartlar / Liste is one choice for both views of the screen. */
export const VIEW_KEY = 'outputs.view';
type Layout = 'grid' | 'list';

function storedView(): Layout {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TYPE_ICON: Readonly<Record<OutputType, IconName>> = { site: 'globe', file: 'file', note: 'pen' };

interface Filters {
  readonly project: string;
  readonly q: string;
  readonly tag: string;
  readonly pinned: boolean;
  readonly from: string;
  readonly to: string;
  readonly job: string;
  readonly folder: string;
  readonly path: string;
}

interface Scope {
  readonly node: TreeNode;
  readonly trail: readonly TreeNode[];
}

function storedTree(): boolean {
  try {
    return localStorage.getItem(TREE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

/** Under 1024 px the tree becomes the classic drill-down list (one column). */
function useNarrow(): boolean {
  const query = '(max-width: 1023px)';
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = (): void => {
      setNarrow(m.matches);
    };
    m.addEventListener('change', on);
    return () => {
      m.removeEventListener('change', on);
    };
  }, []);
  return narrow;
}

/** The scope of a tree node as list filters (search, tag, dates and pinned stay) — as the classic page. */
function filtersOf(node: TreeNode | null, f: Filters): Filters {
  const base: Filters = { ...f, project: '', job: '', path: '', folder: '' };
  if (node === null) return base;
  const project = node.project ?? '';
  switch (node.kind) {
    case 'project':
    case 'sites':
    case 'notes':
    case 'folders':
      return { ...base, project };
    case 'job':
      return { ...base, project, job: node.jobId ?? '' };
    case 'dir': {
      const slash = node.path.indexOf('/');
      return { ...base, project, job: node.jobId ?? '', path: slash < 0 ? '' : node.path.slice(slash + 1) };
    }
    case 'folder':
      return { ...base, folder: node.folderId ?? '' };
    case 'personal':
      return base;
  }
}

function dayStart(day: string, plusDays = 0): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + plusDays);
  return d.toISOString();
}

const DATE =
  'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] font-normal text-dy-ink sm:min-h-9 sm:text-[0.875rem]';

function FilterChip(props: {
  readonly children: ReactNode;
  readonly onClear: () => void;
  readonly label: string;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClear}
      className="dy-press inline-flex min-h-8 items-center gap-1.5 rounded-full border border-transparent bg-dy-teal-soft px-3 text-[0.8125rem] font-bold text-dy-teal-ink"
    >
      {props.children}
      <DyIcon name="xc" className="size-3.5" />
    </button>
  );
}

export function OutputsScreen(): ReactNode {
  const t = useT().outputs;
  const ts = t.screen;
  const sayError = useErrorText();
  const { state } = useAuth();
  const user = state.kind === 'signedIn' ? state.user : null;
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [filters, setFilters] = useState<Filters>(() => ({
    project: params.get('project') ?? '',
    q: params.get('q') ?? '',
    tag: params.get('tag') ?? '',
    pinned: params.get('pinned') === 'true',
    from: '',
    to: '',
    job: params.get('job') ?? '',
    folder: UUID_RE.test(params.get('folder') ?? '') ? (params.get('folder') ?? '') : '',
    path: '',
  }));
  const [search, setSearch] = useState(filters.q);
  const [open, setOpen] = useState<OutputItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [newProject, setNewProject] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState<Scope | null>(null);
  const [folderInfo, setFolderInfo] = useState<OutputFolder | null>(null);
  const [treeOpen, setTreeOpen] = useState(storedTree);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [folderForm, setFolderForm] = useState<{
    readonly folder?: OutputFolder;
    readonly parent?: OutputFolder | null;
  } | null>(null);
  const [moving, setMoving] = useState<OutputFolder | null>(null);
  const [deleting, setDeleting] = useState<OutputFolder | null>(null);
  const [addTo, setAddTo] = useState<{ readonly project: string; readonly keys: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<ApiError | null>(null);
  const [view, setView] = useState<Layout>(storedView);
  const narrow = useNarrow();

  useEffect(() => {
    listProjects().then(setProjects, () => undefined);
  }, []);

  const viewer: Viewer = useMemo(
    () => ({
      userId: user?.id ?? '',
      admin: user?.role === 'owner' || user?.role === 'admin',
      writable: new Set(projects.filter((p) => WRITE_ROLES.has(p.myRole)).map((p) => p.id)),
    }),
    [user, projects],
  );
  const writableProjects = projects.filter((p) => viewer.writable.has(p.id));
  const forcedType: OutputType | null =
    scope?.node.kind === 'sites' ? 'site' : scope?.node.kind === 'notes' ? 'note' : null;

  // Deep link: /outputs?item=<key> opens that item's drawer.
  const itemKey = params.get('item');
  useEffect(() => {
    if (itemKey === null) return;
    let live = true;
    listOutputs({ key: itemKey, limit: 1 }).then(
      (r) => {
        if (live && r.items[0] !== undefined) setOpen(r.items[0]);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [itemKey]);

  // The open own folder: header, breadcrumb and the deep link `/outputs?folder=<id>`.
  useEffect(() => {
    if (filters.folder === '') {
      setFolderInfo(null);
      return;
    }
    let live = true;
    getFolder(filters.folder).then(
      (f) => {
        if (!live) return;
        setFolderInfo(f);
        setScope((s) =>
          s?.node.folderId === f.id
            ? s
            : {
                node: {
                  project: f.project,
                  path: `folder:${f.id}`,
                  kind: 'folder',
                  label: f.name,
                  count: f.itemCount,
                  hasChildren: f.childCount > 0,
                  folderId: f.id,
                  jobId: null,
                  pinned: f.pinned,
                },
                trail: [],
              },
        );
      },
      () => {
        if (live) setFolderInfo(null);
      },
    );
    return () => {
      live = false;
    };
  }, [filters.folder, refresh]);

  function closeDrawer(): void {
    setOpen(null);
    if (params.has('item')) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('item');
          return next;
        },
        { replace: true },
      );
    }
  }

  function select(node: TreeNode | null, trail: readonly TreeNode[]): void {
    setScope(node === null ? null : { node, trail });
    setFilters((f) => filtersOf(node, f));
    setNotice(null);
    setZipError(null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('job');
        next.delete('project');
        if (node?.kind === 'folder' && node.folderId !== null) next.set('folder', node.folderId);
        else next.delete('folder');
        return next;
      },
      { replace: true },
    );
  }

  function changed(message?: string): void {
    setRefresh((n) => n + 1);
    setTreeRefresh((n) => n + 1);
    if (message !== undefined) setNotice(message);
  }

  function dropped(folder: TreeNode, item: { project: string; key: string }): void {
    if (folder.folderId === null) return;
    linkItems(folder.folderId, item.project, [item.key]).then(
      (r) => {
        changed(
          r.added > 0
            ? ts.dropAdded({ folder: folder.label })
            : r.already > 0
              ? ts.dropAlready({ folder: folder.label })
              : ts.dropRefused,
        );
      },
      (err: unknown) => {
        setNotice(sayError(err));
      },
    );
  }

  async function zipScope(): Promise<void> {
    const node = scope?.node;
    if (node === undefined) return;
    setZipBusy(true);
    setZipError(null);
    try {
      const name =
        node.kind === 'folder' && node.folderId !== null
          ? await downloadZipOf({ folder: node.folderId }, 'outputs-folder.zip')
          : await downloadZipOf(
              { project: node.project ?? '', tree: node.kind === 'project' ? '' : node.path },
              `outputs-${node.project ?? ''}.zip`,
            );
      setNotice(ts.zipSaved({ file: name }));
    } catch (err) {
      setZipError(toApiError(err));
    } finally {
      setZipBusy(false);
    }
  }

  const listing = scope === null || !['folders', 'personal'].includes(scope.node.kind);
  const listProps = {
    filters,
    viewer,
    onOpen: setOpen,
    onTag: (t: string) => {
      setFilters((f) => ({ ...f, tag: t }));
    },
    refreshKey: refresh,
    view,
    folder: scope?.node.kind === 'folder' ? folderInfo : null,
    onAddToFolder: (item: OutputItem) => {
      setAddTo({ project: item.project, keys: [item.key] });
    },
    onChanged: changed,
  };

  const tree = narrow ? (
    <DrillDown refreshKey={treeRefresh} onSelect={select} />
  ) : (
    <aside
      aria-label={ts.treeAside}
      className={cx('min-w-0 shrink-0 lg:sticky lg:top-[70px]', treeOpen && 'lg:w-64')}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={treeOpen}
          aria-controls="dy-outputs-tree"
          className="dy-press min-h-8 rounded-lg px-2 text-[0.8125rem] font-medium text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
          onClick={() => {
            const next = !treeOpen;
            setTreeOpen(next);
            try {
              localStorage.setItem(TREE_KEY, next ? 'open' : 'closed');
            } catch {
              // private mode: not remembered
            }
          }}
        >
          {treeOpen ? ts.hideFolders : ts.showFolders}
        </button>
      </div>
      {treeOpen ? (
        <div
          id="dy-outputs-tree"
          className="max-h-[70vh] overflow-y-auto rounded-[14px] border border-dy-line bg-dy-card p-2 shadow-dy"
        >
          <OutputsTree
            selected={scope === null ? null : nodeKey(scope.node)}
            refreshKey={treeRefresh}
            onSelect={select}
            onDropItem={dropped}
          />
        </div>
      ) : null}
    </aside>
  );

  return (
    <ScreenFrame
      title={ts.title}
      purpose={ts.purpose}
      testId="dy-outputs"
      actions={
        <>
          <DyButton
            icon="folder"
            onClick={() => {
              setFolderForm({});
            }}
          >
            {ts.newFolder}
          </DyButton>
          {writableProjects.length > 0 ? (
            <DyButton
              variant="primary"
              icon="pen"
              onClick={() => {
                setNewProject(
                  filters.project !== '' && viewer.writable.has(filters.project)
                    ? filters.project
                    : (writableProjects[0]?.id ?? ''),
                );
                setCreating(true);
              }}
            >
              {ts.newNote}
            </DyButton>
          ) : null}
        </>
      }
    >
      {notice !== null ? (
        <p
          role="status"
          className="mb-4 flex items-center gap-2 rounded-[10px] bg-dy-green-soft px-3.5 py-2.5 text-[0.875rem] text-dy-green"
        >
          <DyIcon name="checkc" className="size-4 shrink-0" />
          {notice}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
        {tree}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Breadcrumb
            scope={scope}
            folder={folderInfo}
            onSelect={(node, trail) => {
              select(node, trail);
            }}
          />
          {scope !== null && ['project', 'job', 'dir'].includes(scope.node.kind) ? (
            <div className="flex flex-wrap items-center gap-2">
              <DyButton icon="tray" busy={zipBusy} onClick={() => void zipScope()}>
                {ts.zipFolder}
              </DyButton>
            </div>
          ) : null}
          {folderInfo !== null && scope?.node.kind === 'folder' ? (
            <FolderHeader
              folder={folderInfo}
              zipBusy={zipBusy}
              onZip={() => void zipScope()}
              onEdit={() => {
                setFolderForm({ folder: folderInfo });
              }}
              onNew={() => {
                setFolderForm({ parent: folderInfo });
              }}
              onMove={() => {
                setMoving(folderInfo);
              }}
              onDelete={() => {
                setDeleting(folderInfo);
              }}
            />
          ) : null}
          <ErrorLine error={zipError} what="ZIP" />
          {scope !== null && ['folders', 'personal', 'folder'].includes(scope.node.kind) ? (
            <FolderCards
              node={scope.node}
              refreshKey={treeRefresh}
              onDropItem={dropped}
              onOpen={(node) => {
                select(node, [...scope.trail, node]);
              }}
              {...(scope.node.kind === 'folder'
                ? {}
                : {
                    onCreate: () => {
                      setFolderForm({});
                    },
                  })}
            />
          ) : null}
          {listing ? (
            <>
              <form
                aria-label={ts.filters}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
                onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  setFilters((f) => ({ ...f, q: search.trim() }));
                }}
              >
                <DySearch
                  label={ts.search}
                  placeholder={ts.searchPlaceholder}
                  value={search}
                  onChange={(v) => {
                    setSearch(v);
                    if (v === '') setFilters((f) => ({ ...f, q: '' }));
                  }}
                />
                <DySelect
                  label={ts.project}
                  value={filters.project}
                  options={[['', ts.allProjects], ...projects.map((p) => [p.id, p.name] as const)]}
                  onChange={(v) => {
                    setFilters((f) => ({ ...f, project: v }));
                  }}
                />
                <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
                  {ts.from}
                  <input
                    type="date"
                    value={filters.from}
                    onChange={(e) => {
                      setFilters((f) => ({ ...f, from: e.target.value }));
                    }}
                    className={DATE}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
                  {ts.to}
                  <input
                    type="date"
                    value={filters.to}
                    onChange={(e) => {
                      setFilters((f) => ({ ...f, to: e.target.value }));
                    }}
                    className={DATE}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-4">
                  <button
                    type="button"
                    aria-pressed={filters.pinned}
                    onClick={() => {
                      setFilters((f) => ({ ...f, pinned: !f.pinned }));
                    }}
                    className={cx(
                      'dy-press inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium',
                      filters.pinned
                        ? 'border-transparent bg-dy-ink font-bold text-dy-card'
                        : 'border-dy-line-2 bg-dy-card text-dy-ink',
                    )}
                  >
                    <DyIcon name="flag" className="size-3.5" />
                    {ts.pinnedOnly}
                  </button>
                  {filters.tag !== '' ? (
                    <FilterChip
                      label={ts.clearTag({ tag: filters.tag })}
                      onClear={() => {
                        setFilters((f) => ({ ...f, tag: '' }));
                      }}
                    >
                      {ts.tagChip({ tag: filters.tag })}
                    </FilterChip>
                  ) : null}
                  {filters.job !== '' && scope === null ? (
                    <FilterChip
                      label={ts.clearJob}
                      onClear={() => {
                        setFilters((f) => ({ ...f, job: '' }));
                      }}
                    >
                      {ts.jobChip} <span className="font-dy-mono">{filters.job.slice(0, 8)}</span>
                    </FilterChip>
                  ) : null}
                  <div
                    className="ml-auto inline-flex gap-0.5 rounded-[9px] border border-dy-line bg-dy-sunk p-[3px]"
                    role="group"
                    aria-label={ts.layout}
                  >
                    {(['grid', 'list'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={view === v}
                        onClick={() => {
                          setView(v);
                          try {
                            localStorage.setItem(VIEW_KEY, v);
                          } catch {
                            // private mode: the layout just is not remembered
                          }
                        }}
                        className={cx(
                          'inline-flex min-h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[0.8125rem] font-medium',
                          view === v
                            ? 'bg-dy-card text-dy-ink shadow-dy-seg'
                            : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                        )}
                      >
                        <DyIcon name={v === 'grid' ? 'grid' : 'jobs'} className="size-3.5" />
                        {v === 'grid' ? ts.cards : ts.list}
                      </button>
                    ))}
                  </div>
                  <button type="submit" className="sr-only">
                    {ts.search}
                  </button>
                </div>
              </form>
              {filters.project !== '' && filters.q !== '' && filters.job === '' && scope === null ? (
                <RelatedJobs
                  project={filters.project}
                  q={filters.q}
                  onPick={(jobId) => {
                    setFilters((f) => ({ ...f, job: jobId, q: '' }));
                    setSearch('');
                  }}
                />
              ) : null}
              {forcedType !== null ? (
                <OutputList type={forcedType} {...listProps} />
              ) : (
                <SegTabs label={ts.kinds} items={TAB_IDS.map((id) => ({ id, label: ts.tabs[id] }))}>
                  {(tab) => (
                    <OutputList type={tab === 'all' ? undefined : (tab as OutputType)} {...listProps} />
                  )}
                </SegTabs>
              )}
            </>
          ) : null}
          {/* p15-workspace-retention: working directories of repository-less jobs kept on machines. */}
          <WorkfilesOverview project={filters.project === '' ? undefined : filters.project} />
        </div>
      </div>
      <DyDialog
        size="sheet"
        open={open !== null}
        title={open === null ? '' : displayName(open)}
        onClose={closeDrawer}
        testId="output-drawer"
      >
        {open !== null ? (
          <OutputDetail
            item={open}
            viewer={viewer}
            onChanged={(i) => {
              setRefresh((n) => n + 1);
              if (i === null) closeDrawer();
              else setOpen(i);
            }}
          />
        ) : null}
      </DyDialog>
      <DyDialog
        size="sheet"
        open={creating}
        title={ts.newNote}
        description={ts.newNoteDescription}
        onClose={() => {
          setCreating(false);
        }}
        testId="new-note"
      >
        {creating ? (
          <div className="flex flex-col gap-3">
            <DyChoice
              label={ts.project}
              value={newProject}
              options={writableProjects.map((p) => [p.id, p.name] as const)}
              onChange={setNewProject}
            />
            <NoteForm
              key={newProject}
              project={newProject}
              onCancel={() => {
                setCreating(false);
              }}
              onSaved={() => {
                setCreating(false);
                setRefresh((n) => n + 1);
              }}
            />
          </div>
        ) : null}
      </DyDialog>
      {folderForm !== null ? (
        <FolderFormDialog
          open
          {...(folderForm.folder === undefined ? {} : { folder: folderForm.folder })}
          parent={folderForm.parent ?? null}
          projects={writableProjects.map((p) => ({ id: p.id, name: p.name }))}
          defaultProject={scope?.node.project}
          onClose={() => {
            setFolderForm(null);
          }}
          onSaved={(f) => {
            setFolderForm(null);
            changed(ts.folderSaved({ name: f.name }));
          }}
        />
      ) : null}
      {moving !== null ? (
        <MoveFolderDialog
          open
          folder={moving}
          onClose={() => {
            setMoving(null);
          }}
          onMoved={(f) => {
            setMoving(null);
            changed(ts.folderMoved({ name: f.name }));
          }}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteFolderDialog
          open
          folder={deleting}
          onClose={() => {
            setDeleting(null);
          }}
          onDeleted={(c) => {
            const name = deleting.name;
            setDeleting(null);
            select(null, []);
            changed(ts.folderDeleted({ name, sub: Math.max(0, c.folders - 1) }));
          }}
        />
      ) : null}
      {addTo !== null ? (
        <AddToFolderDialog
          open
          project={addTo.project}
          keys={addTo.keys}
          projectWritable={viewer.writable.has(addTo.project)}
          onClose={() => {
            setAddTo(null);
          }}
          onDone={(m) => {
            setAddTo(null);
            changed(m);
          }}
        />
      ) : null}
    </ScreenFrame>
  );
}

function OutputList(props: {
  readonly type: OutputType | undefined;
  readonly filters: Filters;
  readonly viewer: Viewer;
  readonly onOpen: (item: OutputItem) => void;
  readonly onTag: (tag: string) => void;
  readonly refreshKey: number;
  readonly view: Layout;
  readonly folder: OutputFolder | null;
  readonly onAddToFolder: (item: OutputItem) => void;
  readonly onChanged: (message?: string) => void;
}): ReactNode {
  const t = useT().outputs;
  const tl = t.list;
  const fmt = useFormat();
  const { type, filters } = props;
  const [selected, setSelected] = useState<ReadonlyMap<string, OutputItem>>(new Map());
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<ApiError | null>(null);
  const [zipNote, setZipNote] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);
  // Pin changes made here, until the list reloads with them.
  const [pins, setPins] = useState<ReadonlyMap<string, boolean>>(new Map());

  const filterKey = JSON.stringify({ type: type ?? null, filters });
  const list = useOffsetList<OutputItem>({
    key: `${filterKey}:${String(props.refreshKey)}`,
    label: tl.pages,
    fetchPage: (offset, limit) => {
      const from = dayStart(filters.from);
      const to = dayStart(filters.to, 1);
      return listOutputs({
        ...(type === undefined ? {} : { type }),
        ...(filters.project === '' ? {} : { project: filters.project }),
        ...(filters.q === '' ? {} : { q: filters.q }),
        ...(filters.tag === '' ? {} : { tag: filters.tag }),
        ...(filters.pinned ? { pinned: true } : {}),
        ...(filters.job === '' ? {} : { job: filters.job }),
        ...(filters.folder === '' ? {} : { folder: filters.folder }),
        ...(filters.path === '' ? {} : { path: filters.path }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        limit,
        offset,
      });
    },
  });
  const seenKey = useRef(filterKey);
  const { reset } = list;
  useEffect(() => {
    if (seenKey.current === filterKey) return;
    seenKey.current = filterKey;
    setPins(new Map());
    reset();
  }, [filterKey, reset]);
  const items = list.loaded ? list.items : null;

  function toggle(item: OutputItem): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.key)) next.delete(item.key);
      else next.set(item.key, item);
      return next;
    });
  }

  const chosen = [...selected.values()];
  const chosenProjects = new Set(chosen.map((i) => i.project));
  const chosenBytes = chosen.reduce((n, i) => n + (i.file?.sizeBytes ?? 0), 0);

  async function zip(): Promise<void> {
    const project = chosen[0]?.project;
    if (project === undefined || chosenProjects.size !== 1) return;
    setZipBusy(true);
    setZipError(null);
    setZipNote(null);
    try {
      const name = await downloadZip(
        project,
        chosen.map((i) => i.key),
      );
      setZipNote(t.screen.zipSaved({ file: name }));
      setSelected(new Map());
    } catch (err) {
      setZipError(toApiError(err));
    } finally {
      setZipBusy(false);
    }
  }

  async function removeFromFolder(item: OutputItem): Promise<void> {
    const folder = props.folder;
    if (folder === null) return;
    try {
      await unlinkItems(folder.id, item.project, [item.key]);
      list.reload();
      props.onChanged(tl.removedFromFolder({ folder: folder.name }));
    } catch (err) {
      setError(toApiError(err));
    }
  }

  async function pin(item: OutputItem, on: boolean): Promise<void> {
    setPinning(item.key);
    setError(null);
    try {
      const saved = await updateOutputItem({ project: item.project, key: item.key, pinned: on });
      setPins((m) => new Map(m).set(item.key, saved.pinned));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setPinning(null);
    }
  }

  const shownError = error ?? list.error;
  return (
    <div className="flex flex-col gap-3">
      <ErrorLine
        error={shownError}
        what={tl.what}
        onRetry={() => {
          setError(null);
          list.reload();
        }}
      />
      {selected.size > 0 ? (
        <div
          className="sticky top-[60px] z-[4] flex flex-wrap items-center gap-2 rounded-[12px] border border-dy-line bg-dy-card p-2 shadow-dy-pop"
          data-testid="selection-bar"
        >
          <span className="px-1 text-[0.875rem]">
            <b className="font-dy-mono font-medium">{selected.size}</b> {tl.selected} ·{' '}
            <span className="font-dy-mono">{fmt.bytes(chosenBytes)}</span>
          </span>
          <DyButton
            variant="primary"
            icon="tray"
            busy={zipBusy}
            disabled={chosenProjects.size !== 1}
            onClick={() => void zip()}
          >
            {tl.zip}
          </DyButton>
          <DyButton
            variant="ghost"
            onClick={() => {
              setSelected(new Map());
            }}
          >
            {tl.clear}
          </DyButton>
          {chosenProjects.size > 1 ? (
            <span className="text-[0.78125rem] text-dy-amber-ink">{tl.oneProject}</span>
          ) : null}
        </div>
      ) : null}
      <ErrorLine error={zipError} what="ZIP" />
      {zipNote !== null ? (
        <p role="status" className="m-0 text-[0.875rem] text-dy-green">
          {zipNote}
        </p>
      ) : null}
      <Panel
        title={tl.titles[type ?? 'all']}
        count={
          list.pagination.total === null || list.pagination.total === undefined
            ? undefined
            : String(list.pagination.total)
        }
        countLabel={tl.count({ n: list.pagination.total ?? 0 })}
        flush
        // p14-diyalog-polish-2: output cards sit on the page grid, not inside a second card.
        bare={props.view === 'grid' && items !== null && items.length > 0}
      >
        {items === null && shownError === null ? (
          <SkeletonRows label={tl.loading} rows={4} />
        ) : items !== null && items.length === 0 && list.pagination.page === 1 ? (
          <EmptyLine testId="outputs-empty">
            {props.folder !== null
              ? tl.empty.folder
              : type === 'site'
                ? tl.empty.site
                : type === 'note'
                  ? tl.empty.note
                  : tl.empty.all}
          </EmptyLine>
        ) : (
          <ul
            aria-label={tl.label}
            data-testid="outputs-list"
            data-layout={props.view}
            className={cx(
              'm-0 list-none p-0',
              props.view === 'grid' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'grid',
            )}
          >
            {(items ?? []).map((raw) => {
              const pinned = pins.get(raw.key) ?? raw.pinned;
              const item = pinned === raw.pinned ? raw : { ...raw, pinned };
              return (
                <OutputEntry
                  key={item.key}
                  view={props.view}
                  item={item}
                  writable={props.viewer.writable.has(item.project)}
                  selected={selected.has(item.key)}
                  pinBusy={pinning === item.key}
                  onToggle={() => {
                    toggle(item);
                  }}
                  onOpen={() => {
                    props.onOpen(item);
                  }}
                  onTag={props.onTag}
                  onPin={() => void pin(item, !item.pinned)}
                  onAddToFolder={() => {
                    props.onAddToFolder(item);
                  }}
                  {...(props.folder?.writable === true
                    ? {
                        onRemove: () => {
                          void removeFromFolder(item);
                        },
                      }
                    : {})}
                />
              );
            })}
          </ul>
        )}
      </Panel>
      <DyPager {...list.pagination} className="mt-0 px-0" />
    </div>
  );
}

function subLine(item: OutputItem, t: Messages['outputs'], bytes: (n: number) => string): string {
  if (item.site !== null) return siteWhere(item.site, t);
  if (item.file !== null)
    return `${item.file.mediaType}${item.file.sizeBytes !== null ? ` · ${bytes(item.file.sizeBytes)}` : ''}`;
  if (item.note !== null) return item.note.author.username ?? '';
  return '';
}

interface EntryProps {
  readonly view: Layout;
  readonly item: OutputItem;
  readonly writable: boolean;
  readonly selected: boolean;
  readonly pinBusy: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
  readonly onTag: (tag: string) => void;
  readonly onPin: () => void;
  readonly onAddToFolder: () => void;
  readonly onRemove?: () => void;
}

/** One output as a list row or a card (Kartlar); the card / the row's type mark drags onto a folder. */
function OutputEntry(props: EntryProps): ReactNode {
  const t = useT().outputs;
  const te = t.entry;
  const fmt = useFormat();
  const { item } = props;
  const name = displayName(item);
  const selectable = item.file !== null && item.file.download !== null;
  const icon = TYPE_ICON[item.type];
  const sub = subLine(item, t, (n) => fmt.bytes(n));
  const onDragStart = (e: DragEvent): void => {
    e.dataTransfer.setData(DRAG_TYPE, dragPayload(item.project, item.key));
    e.dataTransfer.effectAllowed = 'link';
  };
  const title = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {selectable ? (
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-[var(--dy-teal)]"
          aria-label={te.select({ name })}
          checked={props.selected}
          onChange={props.onToggle}
        />
      ) : null}
      <button
        type="button"
        onClick={props.onOpen}
        className="min-w-0 text-left font-bold [overflow-wrap:anywhere] text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
      >
        {name}
      </button>
      {item.pinned ? (
        <Pill tone="teal" icon="flag">
          {t.pinned}
        </Pill>
      ) : null}
    </span>
  );
  const meta = (
    <>
      <span>{t.types[item.type]}</span>
      <span translate="no">{item.project}</span>
      <When iso={item.createdAt} />
      {item.title !== null && item.title !== item.name ? (
        <span className="max-w-full truncate font-dy-mono text-[0.75rem]">{item.name}</span>
      ) : null}
      {sub !== '' ? <span className="[overflow-wrap:anywhere]">{sub}</span> : null}
      {item.site !== null && item.site.protection === 'none' ? (
        <Pill tone="amber" icon="globe">
          {te.publicLink}
        </Pill>
      ) : null}
      {item.file?.removed != null ? (
        <Pill tone="neutral" icon="trash">
          {te.removed}
        </Pill>
      ) : null}
      {item.noteCount > 0 ? (
        <span>
          <span className="font-dy-mono">{item.noteCount}</span> {te.noteUnit({ n: item.noteCount })}
        </span>
      ) : null}
      {item.site !== null ? (
        <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
          <UptimeBadge item={item} />
          <HealthBadge item={item} />
        </span>
      ) : null}
      {item.site !== null ? <HealthThumb item={item} /> : null}
      {item.note !== null && item.note.body !== '' ? (
        <span className="line-clamp-2 w-full text-[0.84375rem] break-words whitespace-pre-line text-dy-muted">
          {item.note.body}
        </span>
      ) : null}
      {item.tags.length > 0 ? (
        <span className="flex w-full flex-wrap gap-1.5" role="list" aria-label={t.tags}>
          {item.tags.map((tag) => (
            <span role="listitem" key={tag}>
              <button
                type="button"
                className="dy-press min-h-7 rounded-full border border-dy-line bg-dy-sunk px-2 text-[0.75rem] text-dy-ink"
                aria-label={te.filterTag({ tag })}
                onClick={() => {
                  props.onTag(tag);
                }}
              >
                {tag}
              </button>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
  const actions = (
    <>
      {item.site?.url ? (
        <a
          href={item.site.url}
          target="_blank"
          rel="noopener noreferrer"
          className="dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-dy-ink bg-dy-ink px-3 text-[0.875rem] font-bold whitespace-nowrap text-dy-card no-underline"
        >
          <DyIcon name="globe" className="size-4" />
          {t.openSite}
        </a>
      ) : null}
      {props.writable ? (
        <DyButton
          aria-pressed={item.pinned}
          aria-label={item.pinned ? te.unpinLabel({ name }) : te.pinLabel({ name })}
          icon="flag"
          busy={props.pinBusy}
          onClick={props.onPin}
          data-testid="row-pin"
          className={cx(item.pinned && 'border-dy-teal text-dy-teal-ink')}
        >
          {item.pinned ? t.pinnedState : t.pin}
        </DyButton>
      ) : null}
      <DyButton
        variant="ghost"
        icon="folder"
        aria-label={te.addLabel({ name })}
        onClick={props.onAddToFolder}
      >
        {t.addToFolder}
      </DyButton>
      {props.onRemove !== undefined ? (
        <DyButton variant="danger" aria-label={te.removeLabel({ name })} onClick={props.onRemove}>
          {te.remove}
        </DyButton>
      ) : null}
      {item.jobId !== null ? <ThreadLink target={{ kind: 'job', id: item.jobId }} about={name} /> : null}
    </>
  );
  if (props.view === 'grid') {
    return (
      <li
        data-testid="output-row"
        data-type={item.type}
        draggable
        onDragStart={onDragStart}
        className={cx(
          'shadow-dy-edge flex min-w-0 flex-col gap-2.5 rounded-[12px] border bg-dy-card p-3.5',
          props.selected ? 'border-dy-teal ring-2 ring-dy-teal/40' : 'border-dy-line',
        )}
      >
        <div className="flex items-start gap-2.5">
          <span
            className="grid size-8 shrink-0 cursor-grab place-items-center rounded-[8px] bg-dy-sunk text-dy-muted"
            title={te.drag}
          >
            <DyIcon name={icon} className="size-4" />
          </span>
          <div className="min-w-0 flex-1 pt-1">{title}</div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-dy-muted">
          {meta}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-dy-line pt-2.5">
          {actions}
        </div>
      </li>
    );
  }
  return (
    <Row
      testId="output-row"
      className={cx(props.selected && 'bg-dy-teal-soft/60')}
      lead={
        <span
          draggable
          onDragStart={onDragStart}
          data-type={item.type}
          className="grid size-[22px] cursor-grab place-items-center"
          title={te.drag}
        >
          <DyIcon name={icon} className="size-[18px]" />
        </span>
      }
      title={title}
      meta={meta}
      actions={actions}
    />
  );
}

/**
 * Next to the keyword matches: jobs of the chosen project whose result summary matches the search (by meaning where
 * the project has semantic search, else by keywords). Choosing one narrows the list to that job. Summaries are text.
 */
function RelatedJobs(props: {
  readonly project: string;
  readonly q: string;
  readonly onPick: (jobId: string) => void;
}): ReactNode {
  const t = useT().outputs.screen;
  const [found, setFound] = useState<FoundContext | null>(null);
  useEffect(() => {
    let live = true;
    setFound(null);
    findContext(props.project, props.q, { type: 'job_summary', limit: 6 }).then(
      (r) => {
        if (live) setFound(r);
      },
      () => {
        // Optional extra: the keyword list stays the answer when this fails.
        if (live) setFound(null);
      },
    );
    return () => {
      live = false;
    };
  }, [props.project, props.q]);
  if (found === null || found.items.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-[12px] border border-dy-line bg-dy-card px-3.5 py-3"
      aria-label={t.related}
      data-testid="outputs-related-jobs"
    >
      <h3 className="m-0 flex items-center gap-1.5 text-[0.8125rem] font-bold text-dy-muted">
        <DyIcon name="brain" className="size-3.5" />
        {t.relatedTitle({ semantic: found.mode === 'semantic' })}
      </h3>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {found.items.map((h) => (
          <li key={h.id} className="max-w-full min-w-0">
            <button
              type="button"
              title={h.snippet}
              className="dy-press block min-h-8 max-w-80 truncate rounded-full border border-dy-line-2 bg-dy-card px-3 text-left text-[0.78125rem] [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-teal"
              onClick={() => {
                props.onPick(h.id);
              }}
            >
              <span className="font-dy-mono">{h.id.slice(0, 8)}</span> · {h.snippet}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
