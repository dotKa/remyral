import { type ReactNode, type SubmitEvent, useEffect, useId, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  createFolder,
  deleteFolder,
  DRAG_TYPE,
  FOLDER_DEPTH_MAX,
  folderPath,
  getTree,
  itemFolders,
  linkItems,
  listFolders,
  type OutputFolder,
  parseDragPayload,
  type TreeNode,
  updateFolder,
} from '../../../api/output-folders';
import { cx, toApiError } from '../../../components/ui';
import { parseTagText } from '../../../screens/outputs/format';
import { DyIcon } from '../../icons';
import { DyApiError, DyCheck, DyChoice, DyDialog, DyInput, DyTextarea } from '../kit';
import { DyButton, Pill, SkeletonRows } from '../parts';
import { DyMarkdown } from './shared';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { toast } from '../../toast/store';

/**
 * p12-diyalog-w2: own folders on the Diyalog Outputs screen (classic p8-outputs-folders rules and calls) — "Klasöre
 * ekle…" (the keyboard / phone way next to drag-and-drop), the folder form (name, who sees it, note, tags, pin),
 * Taşı…, Sil, a folder's header and sub-folder cards, the breadcrumb and an item's "Klasörlerde" list. Folder names
 * and notes are untrusted text (React text; the note through the classic Markdown parser, never HTML).
 */

export interface ProjectChoice {
  readonly id: string;
  readonly name: string;
}

/** Tree node labels come from the master in English; the fixed ones get their word in the user's language. */
export function nodeLabel(n: Pick<TreeNode, 'kind' | 'label'>, words: Messages['outputs']['nodes']): string {
  switch (n.kind) {
    case 'personal':
      return words.personal;
    case 'folders':
      return words.folders;
    case 'sites':
      return words.sites;
    case 'notes':
      return words.notes;
    default:
      return n.label;
  }
}

const LIST_BTN =
  'dy-press flex min-h-11 w-full items-center gap-2 rounded-[10px] border border-dy-line bg-dy-card px-3 text-left text-[0.875rem] disabled:opacity-55 sm:min-h-10 [@media(hover:hover)_and_(pointer:fine)]:enabled:hover:border-dy-ink';

/** Picks a folder (writable by the caller) for items of one project, then links them (the item stays). */
export function AddToFolderDialog(props: {
  readonly open: boolean;
  readonly project: string;
  readonly keys: readonly string[];
  readonly projectWritable: boolean;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}): ReactNode {
  const t = useT().outputs;
  const ta = t.folders.add;
  const [folders, setFolders] = useState<OutputFolder[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState<'personal' | 'project'>('personal');
  const listId = useId();

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    setFolders(null);
    setError(null);
    listFolders(props.project).then(
      (f) => {
        if (live) setFolders(f);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [props.open, props.project]);

  async function add(folder: OutputFolder): Promise<void> {
    setBusy(folder.id);
    setError(null);
    try {
      const r = await linkItems(folder.id, props.project, props.keys);
      const parts = [
        r.added > 0 ? ta.added({ n: r.added, folder: folder.name }) : null,
        r.already > 0 ? ta.already({ n: r.already }) : null,
        r.refused.length > 0 ? ta.refused({ n: r.refused.length }) : null,
      ].filter((x) => x !== null);
      props.onDone(parts.join(' ') || ta.nothing);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function createAndAdd(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const name = newName.trim();
    if (name === '') return;
    setBusy('new');
    setError(null);
    try {
      const f = await createFolder(
        newScope === 'project'
          ? { scope: 'project', project: props.project, name }
          : { scope: 'personal', name },
      );
      setNewName('');
      await add(f);
    } catch (err) {
      setError(toApiError(err));
      setBusy(null);
    }
  }

  const all = folders ?? [];
  const usable = all.filter((f) => f.writable && (f.scope === 'personal' || f.project === props.project));
  const q = filter.trim().toLowerCase();
  const shown = usable
    .map((f) => ({ f, path: folderPath(f, all) }))
    .filter((x) => q === '' || x.path.toLowerCase().includes(q));

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={ta.title}
      description={ta.description({ n: props.keys.length })}
      testId="add-to-folder"
    >
      <div className="flex flex-col gap-3">
        <DyApiError error={error} />
        <DyInput
          label={ta.find}
          type="search"
          value={filter}
          maxLength={120}
          aria-controls={listId}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
        />
        {folders === null && error === null ? (
          <SkeletonRows label={t.tree.loading} rows={2} />
        ) : (
          <ul
            id={listId}
            className="m-0 flex max-h-72 list-none flex-col gap-1.5 overflow-y-auto p-0"
            aria-label={ta.list}
          >
            {shown.map(({ f, path }) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={LIST_BTN}
                  aria-busy={busy === f.id || undefined}
                  disabled={busy !== null}
                  onClick={() => void add(f)}
                >
                  <DyIcon name="folder" className="size-4 shrink-0 text-dy-muted" />
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                  <span className="shrink-0 text-[0.75rem] text-dy-muted">
                    {f.scope === 'personal' ? ta.mine : ta.project}
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 ? (
              <li className="text-[0.875rem] text-dy-muted">{usable.length === 0 ? ta.none : ta.noMatch}</li>
            ) : null}
          </ul>
        )}
        <form
          className="flex flex-col gap-2.5 border-t border-dy-line pt-3"
          onSubmit={(e) => void createAndAdd(e)}
        >
          <DyInput
            label={ta.newFolder}
            value={newName}
            maxLength={120}
            placeholder={ta.namePlaceholder}
            onChange={(e) => {
              setNewName(e.target.value);
            }}
          />
          {props.projectWritable ? (
            <fieldset className="m-0 flex flex-wrap gap-4 border-0 p-0 text-[0.875rem]">
              <legend className="sr-only">{ta.whoSees}</legend>
              {(['personal', 'project'] as const).map((s) => (
                <label key={s} className="flex min-h-10 items-center gap-2">
                  <input
                    type="radio"
                    name="dy-new-folder-scope"
                    className="size-4 accent-[var(--dy-teal)]"
                    checked={newScope === s}
                    onChange={() => {
                      setNewScope(s);
                    }}
                  />
                  {s === 'personal' ? ta.onlyMe : ta.projectEveryone({ project: props.project })}
                </label>
              ))}
            </fieldset>
          ) : null}
          <DyButton
            type="submit"
            busy={busy === 'new'}
            disabled={newName.trim() === ''}
            className="sm:self-start"
          >
            {ta.createAndAdd}
          </DyButton>
        </form>
      </div>
    </DyDialog>
  );
}

/** Create or edit a folder (name, note, tags, pin; on create also who sees it). */
export function FolderFormDialog(props: {
  readonly open: boolean;
  readonly folder?: OutputFolder | undefined;
  readonly parent?: OutputFolder | null;
  readonly projects: readonly ProjectChoice[];
  readonly defaultProject?: string | null | undefined;
  readonly onClose: () => void;
  readonly onSaved: (folder: OutputFolder) => void;
}): ReactNode {
  const t = useT().outputs;
  const tf = t.folders.form;
  const editing = props.folder;
  const parent = props.parent ?? null;
  const [name, setName] = useState(editing?.name ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [tags, setTags] = useState((editing?.tags ?? []).join(', '));
  const [pinned, setPinned] = useState(editing?.pinned ?? false);
  const [place, setPlace] = useState<string>(
    props.defaultProject != null && props.projects.some((p) => p.id === props.defaultProject)
      ? props.defaultProject
      : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const common = { name: name.trim(), note, tags: parseTagText(tags), pinned };
      const saved =
        editing !== undefined
          ? await updateFolder(editing.id, common)
          : parent !== null
            ? await createFolder({
                scope: parent.scope,
                ...(parent.project === null ? {} : { project: parent.project }),
                parentId: parent.id,
                ...common,
              })
            : place === ''
              ? await createFolder({ scope: 'personal', ...common })
              : await createFolder({ scope: 'project', project: place, ...common });
      props.onSaved(saved);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      testId="folder-form"
      title={editing !== undefined ? tf.edit : parent !== null ? tf.newIn({ name: parent.name }) : tf.new}
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} aria-label={tf.label}>
        <DyApiError error={error} />
        <DyInput
          label={tf.name}
          required
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        {editing === undefined && parent === null ? (
          <DyChoice
            label={tf.who}
            value={place}
            options={[
              ['', tf.onlyMe],
              ...props.projects.map(
                (p) => [p.id, t.folders.add.projectEveryone({ project: p.name })] as const,
              ),
            ]}
            onChange={setPlace}
          />
        ) : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            {(editing ?? parent)?.scope === 'personal'
              ? tf.visibilityMine
              : tf.visibilityProject({ project: (editing ?? parent)?.project ?? '' })}
          </p>
        )}
        <DyTextarea
          label={tf.note}
          rows={4}
          maxLength={20_000}
          value={note}
          placeholder={tf.notePlaceholder}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
        <DyInput
          label={t.tags}
          hint={t.tagsHint}
          value={tags}
          onChange={(e) => {
            setTags(e.target.value);
          }}
        />
        <DyCheck label={t.pinTop} checked={pinned} onChange={setPinned} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
          <DyButton type="submit" variant="primary" busy={busy} disabled={name.trim() === ''}>
            {t.save}
          </DyButton>
        </div>
      </form>
    </DyDialog>
  );
}

/** Move a folder within its place (project or My folders): not into itself or below itself. */
export function MoveFolderDialog(props: {
  readonly open: boolean;
  readonly folder: OutputFolder;
  readonly onClose: () => void;
  readonly onMoved: (folder: OutputFolder) => void;
}): ReactNode {
  const t = useT().outputs;
  const { folder } = props;
  const [all, setAll] = useState<OutputFolder[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    listFolders(folder.project ?? undefined).then(
      (f) => {
        if (live) setAll(f);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [props.open, folder.project]);

  const list = all ?? [];
  const byId = new Map(list.map((f) => [f.id, f]));
  const below = (f: OutputFolder): boolean => {
    let cur: OutputFolder | undefined = f;
    for (let i = 0; cur !== undefined && i < 8; i += 1) {
      if (cur.id === folder.id) return true;
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    return false;
  };
  const targets = list.filter(
    (f) => f.scope === folder.scope && f.project === folder.project && f.writable && !below(f),
  );

  async function move(parentId: string | null): Promise<void> {
    setBusy(parentId ?? 'top');
    setError(null);
    try {
      props.onMoved(await updateFolder(folder.id, { parentId }));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.folders.move.title({ name: folder.name })}
      testId="move-folder"
    >
      <div className="flex flex-col gap-2">
        <DyApiError error={error} />
        {all === null && error === null ? <SkeletonRows label={t.tree.loading} rows={2} /> : null}
        <ul
          className="m-0 flex max-h-80 list-none flex-col gap-1.5 overflow-y-auto p-0"
          aria-label={t.folders.move.targets}
        >
          {folder.parentId !== null ? (
            <li>
              <button
                type="button"
                className={LIST_BTN}
                disabled={busy !== null}
                onClick={() => void move(null)}
              >
                <DyIcon name="home" className="size-4 shrink-0 text-dy-muted" />
                {t.folders.move.top}
              </button>
            </li>
          ) : null}
          {targets
            .filter((f) => f.id !== folder.parentId)
            .map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={LIST_BTN}
                  disabled={busy !== null}
                  aria-busy={busy === f.id || undefined}
                  onClick={() => void move(f.id)}
                >
                  <DyIcon name="folder" className="size-4 shrink-0 text-dy-muted" />
                  <span className="min-w-0 truncate">{folderPath(f, list)}</span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </DyDialog>
  );
}

/** Confirms deleting a folder and its sub-folders (the items stay). */
export function DeleteFolderDialog(props: {
  readonly open: boolean;
  readonly folder: OutputFolder;
  readonly onClose: () => void;
  readonly onDeleted: (counts: { folders: number; links: number }) => void;
}): ReactNode {
  const t = useT().outputs;
  const tr = t.folders.remove;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { folder } = props;
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      size="sm"
      testId="delete-folder"
      title={tr.title({ name: folder.name })}
      description={folder.childCount > 0 ? tr.withChildren({ n: folder.childCount }) : tr.itemsStay}
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
          <DyButton
            variant="danger"
            icon="trash"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              deleteFolder(folder.id).then(
                (c) => {
                  setBusy(false);
                  props.onDeleted(c);
                },
                (err: unknown) => {
                  setBusy(false);
                  setError(toApiError(err));
                },
              );
            }}
          >
            {tr.confirm}
          </DyButton>
        </>
      }
    >
      <DyApiError error={error} />
    </DyDialog>
  );
}

/** The header of an own folder: where it lives, pin, count, tags, note and the folder's actions. */
export function FolderHeader(props: {
  readonly folder: OutputFolder;
  readonly onEdit: () => void;
  readonly onNew: () => void;
  readonly onMove: () => void;
  readonly onDelete: () => void;
  readonly onZip: () => void;
  readonly zipBusy: boolean;
}): ReactNode {
  const t = useT().outputs;
  const th = t.folders.header;
  const { folder } = props;
  return (
    <section
      aria-label={th.label({ name: folder.name })}
      className="flex flex-col gap-2.5 rounded-[14px] border border-dy-line bg-dy-card p-4 shadow-dy"
      data-testid="folder-header"
    >
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
        <DyIcon name="folder" className="size-4 text-dy-teal-ink" />
        <span className="text-[1rem] font-bold text-dy-ink">{folder.name}</span>
        <Pill tone="neutral">
          {folder.scope === 'personal' ? t.nodes.personal : th.project({ project: folder.project ?? '' })}
        </Pill>
        {folder.pinned ? (
          <Pill tone="teal" icon="flag">
            {t.pinned}
          </Pill>
        ) : null}
        <span>
          <span className="font-dy-mono">{folder.itemCount}</span> {th.itemUnit({ n: folder.itemCount })}
        </span>
        {folder.tags.length > 0 ? <span>· {folder.tags.join(', ')}</span> : null}
      </div>
      {folder.note !== '' ? <DyMarkdown source={folder.note} className="text-[0.875rem]" /> : null}
      <div className="flex flex-wrap gap-2">
        <DyButton icon="tray" busy={props.zipBusy} onClick={props.onZip}>
          {t.screen.zipFolder}
        </DyButton>
        {folder.writable ? (
          <>
            {folder.depth < FOLDER_DEPTH_MAX ? (
              <DyButton icon="plus" onClick={props.onNew}>
                {th.sub}
              </DyButton>
            ) : null}
            <DyButton icon="pen" onClick={props.onEdit}>
              {t.edit}
            </DyButton>
            <DyButton icon="folder" onClick={props.onMove}>
              {th.move}
            </DyButton>
            <DyButton variant="danger" icon="trash" onClick={props.onDelete}>
              {t.delete}
            </DyButton>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** "Klasörlerde" of an item drawer, with "Klasöre ekle…". */
export function ItemFolders(props: {
  readonly project: string;
  readonly itemKey: string;
  readonly projectWritable: boolean;
  readonly onOpenFolder?: (folder: OutputFolder) => void;
}): ReactNode {
  const t = useT().outputs;
  const ti = t.folders.item;
  const [list, setList] = useState<OutputFolder[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    itemFolders(props.project, props.itemKey).then(
      (f) => {
        if (live) setList(f);
      },
      () => {
        if (live) setList([]);
      },
    );
    return () => {
      live = false;
    };
  }, [props.project, props.itemKey, reload]);

  return (
    <section className="flex flex-col gap-2" aria-label={ti.title} data-testid="item-folders">
      <h3 className="m-0 text-[0.9375rem] font-bold">{ti.title}</h3>
      {list === null ? (
        <SkeletonRows label={t.tree.loading} rows={1} />
      ) : list.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{ti.none}</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {list.map((f) => {
            const path = [...f.ancestors.map((a) => a.name), f.name].join(' / ');
            return (
              <li key={f.id}>
                {props.onOpenFolder === undefined ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-dy-sunk px-2.5 py-0.5 text-[0.78125rem]">
                    <DyIcon name="folder" className="size-3" />
                    {path}
                    {f.scope === 'personal' ? ti.mine : ''}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="dy-press inline-flex min-h-8 items-center gap-1 rounded-full bg-dy-sunk px-2.5 text-[0.78125rem] [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-teal-ink"
                    onClick={() => props.onOpenFolder?.(f)}
                  >
                    <DyIcon name="folder" className="size-3" />
                    {path}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <DyButton
          icon="folder"
          onClick={() => {
            setAdding(true);
          }}
        >
          {t.addToFolder}
        </DyButton>
      </div>
      <AddToFolderDialog
        open={adding}
        project={props.project}
        keys={[props.itemKey]}
        projectWritable={props.projectWritable}
        onClose={() => {
          setAdding(false);
        }}
        onDone={(m) => {
          setAdding(false);
          // p17-toasts-shortcuts: "added to the folder" is a toast.
          toast.success(m, { id: 'item-folders', testId: 'item-folders-note' });
          setReload((n) => n + 1);
        }}
      />
    </section>
  );
}

/** The breadcrumb: Tüm çıktılar › … › the selected node (each step selectable). */
export function Breadcrumb(props: {
  readonly scope: { readonly node: TreeNode; readonly trail: readonly TreeNode[] } | null;
  readonly folder: OutputFolder | null;
  readonly onSelect: (node: TreeNode | null, trail: readonly TreeNode[]) => void;
}): ReactNode {
  const t = useT().outputs;
  const { scope, folder } = props;
  let steps: readonly TreeNode[] = scope === null ? [] : scope.trail.length > 0 ? scope.trail : [scope.node];
  // A folder opened by a link (no trail): its place and ancestors come from the folder itself.
  if (scope !== null && scope.trail.length === 0 && folder !== null && scope.node.folderId === folder.id) {
    const asNode = (id: string, label: string): TreeNode => ({
      project: folder.project,
      path: `folder:${id}`,
      kind: 'folder',
      label,
      count: null,
      hasChildren: true,
      folderId: id,
      jobId: null,
      pinned: false,
    });
    const place: TreeNode =
      folder.scope === 'personal'
        ? {
            ...asNode('', t.nodes.personal),
            path: 'personal',
            kind: 'personal',
            folderId: null,
            project: null,
          }
        : { ...asNode('', t.nodes.folders), path: 'folders', kind: 'folders', folderId: null };
    steps = [place, ...folder.ancestors.map((a) => asNode(a.id, a.name)), scope.node];
  }
  const step =
    'dy-press min-h-8 max-w-[16rem] truncate rounded-md px-1 text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline';
  return (
    <nav aria-label={t.tree.crumb} data-testid="outputs-breadcrumb">
      <ol className="m-0 flex list-none flex-wrap items-center gap-0.5 p-0 text-[0.84375rem]">
        <li className="flex items-center">
          {scope === null ? (
            <span aria-current="page" className="px-1 font-bold text-dy-ink">
              {t.tree.all}
            </span>
          ) : (
            <button
              type="button"
              className={step}
              onClick={() => {
                props.onSelect(null, []);
              }}
            >
              {t.tree.all}
            </button>
          )}
        </li>
        {steps.map((n, i) => (
          <li key={`${n.project ?? ''}|${n.path}|${String(i)}`} className="flex min-w-0 items-center gap-0.5">
            <DyIcon name="chev" className="size-3.5 -rotate-90 text-dy-faint" />
            {i === steps.length - 1 ? (
              <span aria-current="page" className="max-w-[18rem] truncate px-1 font-bold text-dy-ink">
                {nodeLabel(n, t.nodes)}
              </span>
            ) : (
              <button
                type="button"
                className={step}
                onClick={() => {
                  props.onSelect(n, steps.slice(0, i + 1));
                }}
              >
                {nodeLabel(n, t.nodes)}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Folder cards of a folder list node (Klasörler, Klasörlerim) or the sub-folders of a folder. */
export function FolderCards(props: {
  readonly node: TreeNode;
  readonly refreshKey: number;
  readonly onOpen: (node: TreeNode) => void;
  readonly onCreate?: () => void;
  readonly onDropItem?: (folder: TreeNode, item: { project: string; key: string }) => void;
}): ReactNode {
  const t = useT().outputs;
  const { node } = props;
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    setNodes(null);
    setError(null);
    getTree(node.project, node.path).then(
      (r) => {
        if (live) setNodes(r.nodes.filter((n) => n.kind === 'folder'));
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [node.project, node.path, props.refreshKey]);

  if (error !== null) return <DyApiError error={error} />;
  if (nodes === null) return <SkeletonRows label={t.tree.loading} rows={2} />;
  if (nodes.length === 0 && node.kind === 'folder') return null;
  return (
    <section className="flex flex-col gap-2" aria-label={t.folders.cards.label} data-testid="folder-cards">
      {nodes.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.folders.cards.none}</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {nodes.map((n) => (
            <li key={n.path}>
              <FolderCard node={n} onOpen={props.onOpen} onDropItem={props.onDropItem} />
            </li>
          ))}
        </ul>
      )}
      {props.onCreate !== undefined ? (
        <div>
          <DyButton icon="plus" onClick={props.onCreate}>
            {t.screen.newFolder}
          </DyButton>
        </div>
      ) : null}
    </section>
  );
}

function FolderCard(props: {
  readonly node: TreeNode;
  readonly onOpen: (node: TreeNode) => void;
  readonly onDropItem?: ((folder: TreeNode, item: { project: string; key: string }) => void) | undefined;
}): ReactNode {
  const t = useT().outputs;
  const { node: n } = props;
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      data-testid="folder-card"
      className={cx(
        'dy-press flex min-h-12 w-full items-center gap-2.5 rounded-[12px] border bg-dy-card px-3.5 py-2.5 text-left text-[0.875rem] [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink',
        over ? 'border-dy-teal ring-2 ring-dy-teal' : 'border-dy-line',
      )}
      onClick={() => {
        props.onOpen(n);
      }}
      onDragOver={(e) => {
        if (props.onDropItem === undefined || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (props.onDropItem === undefined) return;
        const payload = parseDragPayload(e.dataTransfer.getData(DRAG_TYPE));
        if (payload === null) return;
        e.preventDefault();
        props.onDropItem(n, payload);
      }}
    >
      <DyIcon name="folder" className="size-[18px] shrink-0 text-dy-teal-ink" />
      <span className="min-w-0 flex-1 truncate font-bold">{n.label}</span>
      {n.pinned ? (
        <Pill tone="teal" icon="flag">
          {t.pinned}
        </Pill>
      ) : null}
      <span className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">{n.count ?? 0}</span>
    </button>
  );
}
