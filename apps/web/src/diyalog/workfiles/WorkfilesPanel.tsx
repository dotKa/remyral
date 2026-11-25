import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../api/client';
import { listProjects, type Project } from '../../api/directory';
import {
  exportWorkfiles,
  type ExportResult,
  getJobWorkfiles,
  getWorkfilesTree,
  imageEntries,
  removeWorkfiles,
  siteUploadFromWorkfiles,
  type WorkfileEntry,
  workfilePath,
  workfilesZipUrl,
  workfileUrl,
  type WorkfilesPin,
  type WorkfilesView,
} from '../../api/workfiles';
import { cx, toApiError } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { useText } from '../../screens/outputs/FileViewer';
import { runAgainHref } from '../../screens/job/format';
import { DyDialog } from '../DyDialog';
import { toast } from '../toast/store';
import { DyIcon } from '../icons';
import { DyConfirm } from '../common/actions';
import { DyApiError, DyInput, DyNotice } from '../screens/kit';
import { DyButton, Pill, SkeletonRows } from '../screens/parts';
import { DyLightbox, DyZoomImage, type LightboxImage } from '../screens/outputs/Lightbox';
import { DyJson, DyTable, DyTextBlock } from '../screens/outputs/Preview';
import { DyMarkdown } from '../screens/outputs/shared';

/**
 * p15-workspace-retention §8: "Çalışma dosyaları" of one repository-less job — on the job page (Dosyalar tab) and on
 * Çıktılar. State, machine, size, expiry and what still needs the files; the file tree (folders fold) with a preview
 * (text / Markdown / JSON / CSV as text, images in the lightbox, PDFs in the browser viewer, HTML only in a sandboxed
 * frame — never markup of the console), per-file download, a zip of everything, "Bu dosyalarla yeniden çalıştır",
 * "Repoya aktar", "Siteye yükle" and "Temizle". Everything is read through the caller's own rights; the master streams
 * the bytes from the machine.
 */

interface Node {
  readonly name: string;
  readonly path: string;
  readonly entry: WorkfileEntry | null;
  readonly children: Node[];
}

/** The flat listing as a tree (folders first, by name). */
export function buildTree(entries: readonly WorkfileEntry[]): Node[] {
  const root: Node = { name: '', path: '', entry: null, children: [] };
  const byPath = new Map<string, Node>([['', root]]);
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const ensure = (path: string): Node => {
    const hit = byPath.get(path);
    if (hit !== undefined) return hit;
    const slash = path.lastIndexOf('/');
    const parent = ensure(slash < 0 ? '' : path.slice(0, slash));
    const node: Node = { name: path.slice(slash + 1), path, entry: null, children: [] };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const e of sorted) {
    if (e.kind === 'dir') ensure(e.path);
    else {
      const slash = e.path.lastIndexOf('/');
      const parent = ensure(slash < 0 ? '' : e.path.slice(0, slash));
      const node: Node = { name: e.path.slice(slash + 1), path: e.path, entry: e, children: [] };
      parent.children.push(node);
      byPath.set(e.path, node);
    }
  }
  const order = (n: Node): void => {
    n.children.sort((a, b) =>
      a.entry === null && b.entry !== null
        ? -1
        : a.entry !== null && b.entry === null
          ? 1
          : a.name.localeCompare(b.name),
    );
    n.children.forEach(order);
  };
  order(root);
  return root.children;
}

function TreeView(props: {
  readonly nodes: readonly Node[];
  readonly depth: number;
  readonly open: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
  readonly selected: string | null;
  readonly onSelect: (e: WorkfileEntry) => void;
}): ReactNode {
  const t = useT().workfiles.tree;
  const fmt = useFormat();
  return (
    <ul
      className="m-0 list-none p-0"
      role={props.depth === 0 ? 'tree' : 'group'}
      aria-label={props.depth === 0 ? t.label : undefined}
    >
      {props.nodes.map((n) => {
        const pad = { paddingLeft: `${String(0.5 + props.depth * 0.875)}rem` };
        if (n.entry === null) {
          const isOpen = props.open.has(n.path);
          return (
            <li key={n.path} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
              <button
                type="button"
                onClick={() => {
                  props.onToggle(n.path);
                }}
                aria-label={isOpen ? t.collapse({ name: n.name }) : t.expand({ name: n.name })}
                style={pad}
                className="flex min-h-9 w-full items-center gap-1.5 rounded-[6px] pr-2 text-left text-[0.84375rem] font-bold [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              >
                <DyIcon name="chev" className={cx('size-3.5 shrink-0', isOpen ? '' : '-rotate-90')} />
                <DyIcon name="folder" className="size-4 shrink-0 text-dy-muted" />
                <span className="truncate">{n.name}</span>
              </button>
              {isOpen ? <TreeView {...props} nodes={n.children} depth={props.depth + 1} /> : null}
            </li>
          );
        }
        const e = n.entry;
        const other = e.kind === 'other';
        return (
          <li key={n.path} role="treeitem" aria-selected={props.selected === e.path}>
            <button
              type="button"
              disabled={other}
              onClick={() => {
                props.onSelect(e);
              }}
              style={pad}
              data-testid="workfile-entry"
              className={cx(
                'flex min-h-9 w-full items-center gap-1.5 rounded-[6px] pr-2 text-left text-[0.84375rem]',
                props.selected === e.path
                  ? 'bg-dy-teal-soft'
                  : '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                other && 'text-dy-faint',
              )}
            >
              <span className="size-3.5 shrink-0" aria-hidden="true" />
              <DyIcon name="file" className="size-4 shrink-0 text-dy-muted" />
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              <span className="shrink-0 text-[0.75rem] text-dy-faint tabular-nums">
                {other ? t.other : fmt.bytes(e.size)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FilePreview(props: {
  readonly jobId: string;
  readonly entry: WorkfileEntry;
  readonly images: readonly LightboxImage[];
  readonly imageIndex: number;
}): ReactNode {
  const t = useT().workfiles;
  const { jobId, entry } = props;
  const [zoom, setZoom] = useState<number | null>(null);
  const textKind = ['markdown', 'json', 'csv', 'tsv', 'text'].includes(entry.preview);
  const text = useText(textKind ? workfilePath(jobId, entry.path) : null);
  const download = workfileUrl(jobId, entry.path, false);
  let body: ReactNode;
  if (entry.preview === 'image') {
    body = (
      <>
        <DyZoomImage
          src={workfileUrl(jobId, entry.path, true)}
          name={entry.path}
          onOpen={() => {
            setZoom(Math.max(props.imageIndex, 0));
          }}
        />
        <DyLightbox
          images={
            props.images.length > 0
              ? props.images
              : [{ src: workfileUrl(jobId, entry.path, true), name: entry.path, download }]
          }
          index={zoom}
          onIndex={setZoom}
          onClose={() => {
            setZoom(null);
          }}
        />
      </>
    );
  } else if (entry.preview === 'pdf') {
    body = (
      <iframe
        title={t.preview.title({ name: entry.path })}
        src={workfileUrl(jobId, entry.path, true)}
        referrerPolicy="no-referrer"
        className="h-[70vh] w-full rounded-[10px] border border-dy-line bg-dy-card"
      />
    );
  } else if (entry.preview === 'html') {
    body = (
      <div className="flex flex-col gap-1">
        <iframe
          title={t.preview.title({ name: entry.path })}
          src={workfileUrl(jobId, entry.path, true)}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-[60vh] w-full rounded-[10px] border border-dy-line bg-white"
          data-testid="workfile-html"
        />
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.preview.html}</p>
      </div>
    );
  } else if (!textKind) {
    body = <p className="m-0 text-[0.875rem] text-dy-muted">{t.preview.none}</p>;
  } else if (text.error !== null) {
    body = <DyApiError error={text.error} />;
  } else if (text.text === null) {
    body = <SkeletonRows label={t.loading} rows={3} />;
  } else if (entry.preview === 'markdown') {
    body = (
      <div className="max-h-[60vh] overflow-auto rounded-[10px] border border-dy-line bg-dy-card p-3">
        <DyMarkdown source={text.text} />
      </div>
    );
  } else if (entry.preview === 'json') {
    body = <DyJson text={text.text} />;
  } else if (entry.preview === 'csv' || entry.preview === 'tsv') {
    body = <DyTable text={text.text} sep={entry.preview === 'csv' ? ',' : '\t'} />;
  } else {
    body = <DyTextBlock text={text.text} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="workfile-preview">
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 min-w-0 flex-1 truncate font-dy-mono text-[0.8125rem]">{entry.path}</p>
        <a href={download} download className="text-[0.8125rem] font-bold text-dy-teal-ink underline">
          {t.actions.download}
        </a>
      </div>
      {body}
    </div>
  );
}

function ExportDialog(props: {
  readonly view: WorkfilesView;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().workfiles.export;
  const sayError = useErrorText();
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [project, setProject] = useState('');
  const [directory, setDirectory] = useState('out');
  const [targetPath, setTargetPath] = useState('');
  const [repoName, setRepoName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ExportResult | null>(null);
  useEffect(() => {
    if (!props.open) return;
    let live = true;
    listProjects().then(
      (p) => {
        if (live) setProjects(p.filter((x) => x.kind !== 'workspace'));
      },
      () => {
        if (live) setProjects([]);
      },
    );
    return () => {
      live = false;
    };
  }, [props.open]);
  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDone(
        await exportWorkfiles(props.view.jobId, {
          project,
          directory,
          ...(targetPath.trim() === '' ? {} : { targetPath: targetPath.trim() }),
          ...(mode === 'new' ? { newRepository: { name: repoName.trim(), private: true } } : {}),
        }),
      );
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.title}
      description={t.sub}
      testId="workfiles-export"
      backdropClose={false}
      footer={
        done === null ? (
          <DyButton
            variant="primary"
            busy={busy}
            disabled={project === '' || (mode === 'new' && repoName.trim() === '')}
            onClick={() => {
              void send();
            }}
            data-testid="workfiles-export-send"
          >
            {t.send}
          </DyButton>
        ) : null
      }
    >
      {done !== null ? (
        <DyNotice tone="green">
          {t.done({ branch: done.branch })}{' '}
          {done.pullRequest === null ? null : (
            <a href={done.pullRequest.url} target="_blank" rel="noopener noreferrer" className="underline">
              {t.openPr({ n: done.pullRequest.number })}
            </a>
          )}
          {done.repository === null ? null : (
            <a href={done.repository.htmlUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {t.openRepo}
            </a>
          )}
        </DyNotice>
      ) : (
        <div className="flex flex-col gap-3">
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 text-[0.8125rem] font-bold">{t.mode}</legend>
            {(['existing', 'new'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-[0.875rem]">
                <input
                  type="radio"
                  name="workfiles-export-mode"
                  checked={mode === m}
                  onChange={() => {
                    setMode(m);
                  }}
                />
                {m === 'existing' ? t.existing : t.newRepo}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1 text-[0.8125rem] font-bold">
            {t.project}
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
              }}
              className="min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-normal"
              data-testid="workfiles-export-project"
            >
              <option value="">{t.pickProject}</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {mode === 'new' ? (
            <DyInput
              label={t.repoName}
              value={repoName}
              onChange={(e) => {
                setRepoName(e.target.value);
              }}
            />
          ) : null}
          <DyInput
            label={t.directory}
            hint={t.directoryHint}
            value={directory}
            onChange={(e) => {
              setDirectory(e.target.value);
            }}
          />
          <DyInput
            label={t.targetPath}
            hint={t.targetHint}
            value={targetPath}
            onChange={(e) => {
              setTargetPath(e.target.value);
            }}
          />
          {error === null ? null : <DyNotice tone="red">{error}</DyNotice>}
        </div>
      )}
    </DyDialog>
  );
}

function SiteDialog(props: {
  readonly view: WorkfilesView;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().workfiles.site;
  const sayError = useErrorText();
  const [directory, setDirectory] = useState('out');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ uploadId: string; files: number; project: string } | null>(null);
  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDone(await siteUploadFromWorkfiles(props.view.jobId, { project: props.view.project, directory }));
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.title}
      description={t.sub}
      testId="workfiles-site"
      footer={
        done === null ? (
          <DyButton
            variant="primary"
            busy={busy}
            onClick={() => {
              void send();
            }}
          >
            {t.send}
          </DyButton>
        ) : null
      }
    >
      {done !== null ? (
        <DyNotice tone="green">
          {t.done({ n: done.files })}{' '}
          <Link to={`/projects/${encodeURIComponent(done.project)}?tab=deploy`} className="underline">
            {t.open}
          </Link>
        </DyNotice>
      ) : (
        <div className="flex flex-col gap-3">
          <DyInput
            label={t.directory}
            value={directory}
            onChange={(e) => {
              setDirectory(e.target.value);
            }}
          />
          {error === null ? null : <DyNotice tone="red">{error}</DyNotice>}
        </div>
      )}
    </DyDialog>
  );
}

export function WorkfilesPanel(props: {
  readonly jobId: string;
  /** May clean up / export (operator of the project); the master checks again. */
  readonly canManage?: boolean;
  /** Hide the whole panel when nothing is (or was) kept (Çıktılar). */
  readonly hideWhenNone?: boolean;
}): ReactNode {
  const t = useT().workfiles;
  const fmt = useFormat();
  const sayError = useErrorText();
  const { jobId } = props;
  const [info, setInfo] = useState<{
    workfiles: WorkfilesView | null;
    pins: WorkfilesPin[];
    retentionDays: number;
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tree, setTree] = useState<{ entries: WorkfileEntry[]; truncated: boolean } | null>(null);
  const [treeError, setTreeError] = useState<ApiError | null>(null);
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set(['out']));
  const [selected, setSelected] = useState<WorkfileEntry | null>(null);
  const [dialog, setDialog] = useState<'export' | 'site' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    getJobWorkfiles(jobId, { signal: ctl.signal }).then(
      (r) => {
        setInfo(r);
        setError(null);
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(toApiError(err));
      },
    );
    return () => {
      ctl.abort();
    };
  }, [jobId, reload]);

  const kept = info?.workfiles?.state === 'kept';
  useEffect(() => {
    if (!kept) return;
    const ctl = new AbortController();
    setTree(null);
    setTreeError(null);
    getWorkfilesTree(jobId, { signal: ctl.signal }).then(
      (r) => {
        setTree({ entries: r.entries, truncated: r.truncated });
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setTreeError(toApiError(err));
      },
    );
    return () => {
      ctl.abort();
    };
  }, [jobId, kept, reload]);

  const nodes = useMemo(() => (tree === null ? [] : buildTree(tree.entries)), [tree]);
  const images = useMemo(
    () =>
      tree === null
        ? []
        : imageEntries(tree.entries).map((e) => ({
            path: e.path,
            image: {
              src: workfileUrl(jobId, e.path, true),
              name: e.path,
              download: workfileUrl(jobId, e.path, false),
            },
          })),
    [tree, jobId],
  );
  const toggle = useCallback((path: string) => {
    setOpenDirs((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (error !== null) return <DyApiError error={error} />;
  if (info === null) return <SkeletonRows label={t.loading} rows={2} />;
  const v = info.workfiles;
  if (v === null) {
    if (props.hideWhenNone === true) return null;
    return (
      <section aria-label={t.title} className="flex flex-col gap-1" data-testid="workfiles-panel">
        <h3 className="m-0 text-[0.9375rem] font-bold">{t.title}</h3>
        <p className="m-0 text-[0.84375rem] text-dy-muted">
          {info.retentionDays === 0 ? t.notKeptRetention : t.none}
        </p>
      </section>
    );
  }
  const clean = async (): Promise<void> => {
    try {
      await removeWorkfiles(jobId);
      // p17-toasts-rest: "Temizlendi" is a transient result → toast; a failure stays next to the files.
      setNotice(null);
      toast.success(t.actions.cleanDone, { id: 'workfiles-cleaned', testId: 'workfiles-cleaned' });
      setReload((n) => n + 1);
    } catch (err) {
      setNotice(sayError(err));
    }
  };
  const machine = v.workerName ?? v.workerId;
  const pinKinds = [...new Set(info.pins.map((p) => p.kind))];
  return (
    <section
      aria-label={t.title}
      className="flex flex-col gap-3"
      data-testid="workfiles-panel"
      data-state={v.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-[0.9375rem] font-bold">{t.title}</h3>
        <Pill tone={v.state === 'kept' ? 'teal' : 'neutral'}>{t.state[v.state]}</Pill>
        {v.deleteReason === null || v.state === 'kept' ? null : (
          <span className="text-[0.8125rem] text-dy-muted">
            {(t.deleteReason as Readonly<Record<string, string>>)[v.deleteReason] ?? v.deleteReason}
          </span>
        )}
      </div>
      <p className="m-0 text-[0.84375rem] text-dy-muted">{t.sub}</p>
      <ul
        className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.8125rem]"
        data-testid="workfiles-facts"
      >
        <li>
          {t.facts.machine({ name: machine })}
          {v.workerConnected ? null : <span className="text-dy-amber-ink"> · {t.facts.offline}</span>}
        </li>
        <li className="tabular-nums">{t.facts.size({ size: fmt.bytes(v.sizeBytes), n: v.files })}</li>
        {v.state === 'kept' ? <li>{t.facts.expires({ when: fmt.dateTime(v.expiresAt) })}</li> : null}
        {v.pinnedUntil !== null && v.state === 'kept' ? (
          <li>{t.facts.pinned({ when: fmt.dateTime(v.pinnedUntil) })}</li>
        ) : null}
        {v.dropped > 0 ? <li className="text-dy-amber-ink">{t.facts.dropped({ n: v.dropped })}</li> : null}
        {v.redacted > 0 ? <li>{t.facts.redacted({ n: v.redacted })}</li> : null}
      </ul>
      {pinKinds.length === 0 ? null : (
        <p className="m-0 text-[0.8125rem]" data-testid="workfiles-pins">
          <span className="font-bold">{t.pins.title}: </span>
          {pinKinds.map((k) => (t.pins as Readonly<Record<string, string>>)[k] ?? k).join(', ')}
        </p>
      )}
      {v.state === 'kept' ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            <a
              href={workfilesZipUrl(jobId)}
              download
              className="dy-press inline-flex min-h-10 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-ink no-underline sm:min-h-8"
              data-testid="workfiles-zip"
            >
              <DyIcon name="tray" className="size-4" />
              {t.actions.zip}
            </a>
            <Link
              to={runAgainHref(jobId)}
              className="dy-press inline-flex min-h-10 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-ink no-underline sm:min-h-8"
            >
              <DyIcon name="retry" className="size-4" />
              {t.actions.continue}
            </Link>
            {props.canManage === false ? null : (
              <>
                <DyButton
                  icon="branch"
                  onClick={() => {
                    setDialog('export');
                  }}
                  data-testid="workfiles-export-open"
                >
                  {t.actions.export}
                </DyButton>
                <DyButton
                  icon="globe"
                  onClick={() => {
                    setDialog('site');
                  }}
                >
                  {t.actions.siteUpload}
                </DyButton>
                <DyConfirm
                  label={t.actions.clean}
                  question={t.actions.cleanConfirm}
                  icon="trash"
                  variant="danger"
                  disabled={pinKinds.length > 0}
                  testId="workfiles-clean"
                  onConfirm={() => {
                    void clean();
                  }}
                />
              </>
            )}
          </div>
          {treeError !== null ? (
            <DyApiError error={treeError} />
          ) : tree === null ? (
            <SkeletonRows label={t.loading} rows={3} />
          ) : (
            <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(14rem,1fr)_2fr]">
              <div className="max-h-[60vh] min-w-0 overflow-auto rounded-[10px] border border-dy-line bg-dy-card p-1">
                {nodes.length === 0 ? (
                  <p className="m-0 p-2 text-[0.84375rem] text-dy-muted">{t.tree.empty}</p>
                ) : (
                  <TreeView
                    nodes={nodes}
                    depth={0}
                    open={openDirs}
                    onToggle={toggle}
                    selected={selected?.path ?? null}
                    onSelect={setSelected}
                  />
                )}
                {tree.truncated ? (
                  <p className="m-0 p-2 text-[0.78125rem] text-dy-muted">{t.tree.truncated}</p>
                ) : null}
              </div>
              {selected === null ? (
                <p className="m-0 text-[0.84375rem] text-dy-muted">{t.tree.select}</p>
              ) : (
                <FilePreview
                  key={selected.path}
                  jobId={jobId}
                  entry={selected}
                  images={images.map((x) => x.image)}
                  imageIndex={images.findIndex((x) => x.path === selected.path)}
                />
              )}
            </div>
          )}
        </>
      ) : null}
      {notice === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted" role="status">
          {notice}
        </p>
      )}
      <ExportDialog
        view={v}
        open={dialog === 'export'}
        onClose={() => {
          setDialog(null);
        }}
      />
      <SiteDialog
        view={v}
        open={dialog === 'site'}
        onClose={() => {
          setDialog(null);
        }}
      />
    </section>
  );
}
