import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type CodeEntry,
  type CodeFile,
  type CodeSource,
  getCodeFile,
  getCodeSource,
  getCodeTree,
  getWorkfileText,
} from '../../api/code';
import { getWorkfilesTree } from '../../api/workfiles';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../common/notices';
import { DyIcon } from '../icons';
import { DyButton, DyButtonLink, EmptyLine, SkeletonRows } from '../screens/parts';
import { toast } from '../toast/store';
import type { LineRange } from './cm';
import { CodeViewerPane, type ViewerApi } from './CodeEditor';
import { PullRequests } from './PullRequests';
import { addToChat } from './chatRef';
import { type CodeRef, codeHref } from './refs';

/**
 * p19-ide W1 (docs/design/p19-ide.md §8): the code browser of a project — the Kod tab and `/projects/:id/code`. A
 * repository project picks a branch or commit (its base branch, the branches of recent verified jobs, or one typed in)
 * and browses its files at that commit; a workspace project picks a job's kept working files. The file opens read-only
 * in CodeMirror (lazy chunk) with search, go to line, a link to the selected lines and "Sohbete ekle". Everything the
 * master sends is redacted repository content, shown as text only.
 */

export interface BrowserState {
  readonly ref?: string | undefined;
  readonly job?: string | undefined;
  readonly path?: string | undefined;
  readonly lines?: LineRange | null | undefined;
}

type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown };

interface Dir {
  readonly state: Load<{ readonly entries: readonly CodeEntry[]; readonly truncated: boolean }>;
}

const rangeText = (r: LineRange): string =>
  r.start === r.end ? String(r.start) : `${String(r.start)}-${String(r.end)}`;

function parentsOf(path: string): string[] {
  const parts = path.split('/');
  const out = [''];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function CodeBrowser(props: {
  readonly project: string;
  readonly initial: BrowserState;
  /** Route mode: the state goes to the address bar. */
  readonly onNavigate?: ((s: BrowserState) => void) | undefined;
  /** Kod tab: a link to the full-screen viewer. */
  readonly fullScreenLink?: boolean | undefined;
}): ReactNode {
  const all = useT();
  const t = all.code;
  const sayError = useErrorText();
  const { project, onNavigate } = props;
  const [source, setSource] = useState<Load<CodeSource>>({ kind: 'loading' });
  const [ref, setRef] = useState<string>(props.initial.ref ?? '');
  const [job, setJob] = useState<string>(props.initial.job ?? '');
  const [custom, setCustom] = useState('');
  const [sha, setSha] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Record<string, Dir>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(['']));
  const [path, setPath] = useState<string>(props.initial.path ?? '');
  const [file, setFile] = useState<Load<CodeFile> | null>(null);
  const [mark, setMark] = useState<LineRange | null>(props.initial.lines ?? null);
  const [selection, setSelection] = useState<LineRange | null>(null);
  const [treeShown, setTreeShown] = useState(true);
  const [goTo, setGoTo] = useState('');
  const viewer = useRef<ViewerApi | null>(null);
  const workfilesFlat = useRef<{ job: string; entries: CodeEntry[] } | null>(null);

  useEffect(() => {
    let live = true;
    getCodeSource(project).then(
      (s) => {
        if (!live) return;
        setSource({ kind: 'ready', value: s });
        if (s.kind === 'workspace' && job === '' && s.workfiles[0] !== undefined)
          setJob(s.workfiles[0].jobId);
      },
      (error: unknown) => {
        if (live) setSource({ kind: 'error', error });
      },
    );
    return () => {
      live = false;
    };
    // The source is read once per project; `job` only seeds the first pick.
  }, [project]);

  const ready = source.kind === 'ready' ? source.value : null;
  const workspace = ready?.kind === 'workspace';
  const usable = ready !== null && (workspace ? job !== '' : ready.supported);
  // What the tree is read at: the ref (repo) or the job (workfiles).
  const at = workspace ? `job:${job}` : `ref:${ref}`;

  const listDir = useCallback(
    async (dir: string): Promise<{ entries: CodeEntry[]; truncated: boolean }> => {
      if (workspace) {
        let flat = workfilesFlat.current;
        if (flat?.job !== job) {
          const tree = await getWorkfilesTree(job);
          flat = {
            job,
            entries: tree.entries
              .filter((e) => e.kind !== 'other')
              .map((e) => ({
                name: e.path.split('/').pop() ?? e.path,
                path: e.path,
                kind: e.kind === 'dir' ? ('dir' as const) : ('file' as const),
                size: e.kind === 'file' ? e.size : null,
              })),
          };
          workfilesFlat.current = flat;
        }
        const prefix = dir === '' ? '' : `${dir}/`;
        const children = flat.entries
          .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
          .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        return { entries: children, truncated: false };
      }
      const tree = await getCodeTree(project, ref === '' ? undefined : ref, dir);
      setSha(tree.sha);
      return { entries: [...tree.entries], truncated: tree.truncated };
    },
    [workspace, job, project, ref],
  );

  const loadDir = useCallback(
    (dir: string) => {
      setDirs((d) => ({ ...d, [dir]: { state: { kind: 'loading' } } }));
      listDir(dir).then(
        (value) => {
          setDirs((d) => ({ ...d, [dir]: { state: { kind: 'ready', value } } }));
        },
        (error: unknown) => {
          setDirs((d) => ({ ...d, [dir]: { state: { kind: 'error', error } } }));
        },
      );
    },
    [listDir],
  );

  // A new ref / job: a fresh tree, the open folders of the current file read again.
  useEffect(() => {
    if (!usable) return;
    setDirs({});
    const want = new Set(['', ...(path === '' ? [] : parentsOf(path))]);
    setOpen(want);
    for (const d of want) loadDir(d);
    // `path` only decides which folders open with the new tree.
  }, [at, usable, loadDir]);

  // The file.
  useEffect(() => {
    if (!usable || path === '') {
      setFile(null);
      return;
    }
    let live = true;
    setFile({ kind: 'loading' });
    setSelection(null);
    const read = workspace
      ? getWorkfileText(job, path)
      : getCodeFile(project, ref === '' ? undefined : ref, path);
    read.then(
      (f) => {
        if (live) setFile({ kind: 'ready', value: f });
      },
      (error: unknown) => {
        if (live) setFile({ kind: 'error', error });
      },
    );
    return () => {
      live = false;
    };
  }, [usable, workspace, job, project, ref, path]);

  const navigate = (next: BrowserState): void => {
    onNavigate?.(next);
  };

  const openFile = (p: string): void => {
    setPath(p);
    setMark(null);
    navigate({ ...(workspace ? { job } : { ref }), path: p });
  };

  const pickRef = (r: string): void => {
    setRef(r);
    setSha(null);
    navigate({ ref: r, path });
  };

  const toggle = (dir: string): void => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (dirs[dir] === undefined) loadDir(dir);
      }
      return next;
    });
  };

  const current = file?.kind === 'ready' ? file.value : null;
  const lines = selection ?? mark;
  const codeRef = (r: LineRange): CodeRef | null =>
    current === null
      ? null
      : {
          project,
          source: current.source,
          ref: current.ref,
          path: current.path,
          startLine: r.start,
          endLine: r.end,
        };

  const copyLink = (): void => {
    const href = codeHref({
      project,
      source: workspace ? 'workfiles' : 'repo',
      ref: workspace ? job : (current?.ref ?? (ref === '' ? undefined : ref)),
      path,
      ...(lines === null ? {} : { startLine: lines.start, endLine: lines.end }),
    });
    const url = `${window.location.origin}${href}`;
    const done = (ok: boolean): void => {
      toast({ tone: ok ? 'success' : 'error', title: ok ? t.viewer.copied : t.viewer.copyFailed });
    };
    if (!('clipboard' in navigator)) {
      done(false);
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => {
        done(true);
      },
      () => {
        done(false);
      },
    );
  };

  if (source.kind === 'loading') return <SkeletonRows label={t.loading} rows={4} />;
  if (source.kind === 'error') return <DyNotice tone="red">{sayError(source.error)}</DyNotice>;
  const s = source.value;
  if (s.kind === 'repository' && !s.supported) {
    return (
      <DyNotice tone="amber" testId="code-unsupported">
        {s.reason === 'no_repository' ? (
          <>
            {t.source.noRepo}{' '}
            <Link
              to={`/projects/${encodeURIComponent(project)}?tab=repository`}
              className="font-bold underline"
            >
              {t.source.registerRepo}
            </Link>
          </>
        ) : s.reason === 'provider_unavailable' ? (
          t.source.providerDown
        ) : (
          t.source.unsupported
        )}
      </DyNotice>
    );
  }
  if (s.kind === 'workspace' && s.workfiles.length === 0)
    return <EmptyLine testId="code-no-workfiles">{t.source.workspaceNone}</EmptyLine>;

  const branch = s.branches.find((b) => b.branch === ref || b.headSha === ref);

  return (
    <div className="grid gap-3" data-testid="code-browser">
      <div className="flex flex-wrap items-end gap-2">
        {s.kind === 'workspace' ? (
          <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
            {t.ref.workfiles}
            <select
              value={job}
              onChange={(e) => {
                setJob(e.target.value);
                setPath('');
                navigate({ job: e.target.value });
              }}
              className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-normal"
            >
              {s.workfiles.map((w) => (
                <option key={w.jobId} value={w.jobId}>
                  {`${w.title ?? w.jobId.slice(0, 8)}${w.workerConnected ? '' : ` (${t.source.offline})`}`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
              {t.ref.label}
              <select
                value={branch === undefined ? (ref === '' ? '' : 'custom') : branch.branch}
                onChange={(e) => {
                  if (e.target.value !== 'custom') pickRef(e.target.value);
                }}
                className="min-h-9 max-w-[min(28rem,100%)] rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-normal"
              >
                <option value="">{t.ref.base({ branch: s.defaultBranch ?? '' })}</option>
                {s.branches.length === 0 ? null : (
                  <optgroup label={t.ref.jobs}>
                    {s.branches.map((b) => (
                      <option key={b.jobId} value={b.branch}>
                        {`${b.title} · ${b.branch}`}
                      </option>
                    ))}
                  </optgroup>
                )}
                {branch === undefined && ref !== '' ? <option value="custom">{ref}</option> : null}
              </select>
            </label>
            <form
              className="flex items-end gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.trim() !== '') pickRef(custom.trim());
              }}
            >
              <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
                {t.ref.custom}
                <input
                  value={custom}
                  onChange={(e) => {
                    setCustom(e.target.value);
                  }}
                  placeholder={t.ref.customPlaceholder}
                  maxLength={255}
                  spellCheck={false}
                  className="min-h-9 w-56 max-w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.8125rem] font-normal"
                />
              </label>
              <DyButton type="submit">{t.ref.open}</DyButton>
            </form>
            {sha === null ? null : (
              <span className="pb-2 font-dy-mono text-[0.75rem] text-dy-muted" data-testid="code-sha">
                {t.ref.at({ sha: sha.slice(0, 10) })}
              </span>
            )}
            {branch === undefined ? null : (
              <DyButtonLink
                to={`/projects/${encodeURIComponent(project)}/code/jobs/${encodeURIComponent(branch.jobId)}`}
                icon="merge"
              >
                {t.ref.review}
              </DyButtonLink>
            )}
          </>
        )}
        {props.fullScreenLink === true ? (
          <DyButtonLink
            className="ml-auto"
            icon="layoutLr"
            to={codeHref({
              project,
              source: workspace ? 'workfiles' : 'repo',
              ref: workspace ? job : ref,
              path,
              ...(lines === null ? {} : { startLine: lines.start, endLine: lines.end }),
            })}
          >
            {t.viewer.fullScreen}
          </DyButtonLink>
        ) : null}
      </div>

      {s.kind === 'repository' ? <PullRequests project={project} /> : null}

      <div className="grid gap-3 md:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)]">
        <nav aria-label={t.tree.label} className="min-w-0 rounded-[12px] border border-dy-line bg-dy-card">
          <button
            type="button"
            aria-expanded={treeShown}
            onClick={() => {
              setTreeShown((v) => !v);
            }}
            className="flex w-full items-center gap-2 border-b border-dy-line px-3 py-2 text-left text-[0.8125rem] font-bold md:cursor-default"
          >
            <DyIcon name="tree" className="size-4" />
            {t.tree.label}
            <span className="ml-auto text-dy-muted md:hidden">{treeShown ? t.tree.hide : t.tree.show}</span>
          </button>
          <div
            className={cx(
              'max-h-[40vh] overflow-auto p-1.5 md:block md:max-h-[72vh]',
              !treeShown && 'hidden',
            )}
          >
            <TreeLevel
              dir=""
              depth={0}
              dirs={dirs}
              open={open}
              selected={path}
              onToggle={toggle}
              onOpen={openFile}
            />
          </div>
        </nav>

        <section className="grid min-w-0 content-start gap-2" aria-label={path === '' ? t.viewer.pick : path}>
          {path === '' ? (
            <EmptyLine>{t.viewer.pick}</EmptyLine>
          ) : file === null || file.kind === 'loading' ? (
            <SkeletonRows label={t.viewer.loading} rows={3} />
          ) : file.kind === 'error' ? (
            <DyNotice tone="red">{`${t.viewer.failed} ${sayError(file.error)}`}</DyNotice>
          ) : (
            <FileView
              file={file.value}
              mark={mark}
              selection={selection}
              viewer={viewer}
              goTo={goTo}
              setGoTo={setGoTo}
              onSelect={setSelection}
              onCopy={copyLink}
              onAdd={() => {
                const r = lines === null ? null : codeRef(lines);
                if (r !== null) addToChat(r, t.chat);
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function FileView(props: {
  readonly file: CodeFile;
  readonly mark: LineRange | null;
  readonly selection: LineRange | null;
  readonly viewer: RefObject<ViewerApi | null>;
  readonly goTo: string;
  readonly setGoTo: (v: string) => void;
  readonly onSelect: (r: LineRange | null) => void;
  readonly onCopy: () => void;
  readonly onAdd: () => void;
}): ReactNode {
  const t = useT().code;
  const fmt = useFormat();
  const { file } = props;
  const lines = props.selection ?? props.mark;
  const count = useMemo(() => (file.text === null ? 0 : file.text.split('\n').length), [file.text]);
  if (file.state !== 'text' || file.text === null) {
    return (
      <DyNotice tone="neutral" testId="code-file-summary">
        {file.state === 'binary'
          ? t.viewer.binary({ size: fmt.bytes(file.size) })
          : t.viewer.tooLarge({ size: fmt.bytes(file.size) })}
      </DyNotice>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 min-w-0 flex-1 truncate font-dy-mono text-[0.84375rem] font-bold" translate="no">
          {file.path}
        </h2>
        <span className="text-[0.75rem] text-dy-muted">{`${t.viewer.lines({ n: count })} · ${fmt.bytes(file.size)}`}</span>
      </div>
      {file.redacted ? (
        <DyNotice tone="amber" testId="code-redacted">
          {t.viewer.redacted}
        </DyNotice>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={file.path}>
        <DyButton
          icon="search"
          onClick={() => {
            props.viewer.current?.openSearch();
          }}
        >
          {t.viewer.search}
        </DyButton>
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(props.goTo);
            if (Number.isInteger(n) && n >= 1) props.viewer.current?.goToLine(n);
          }}
        >
          <input
            type="number"
            min={1}
            inputMode="numeric"
            aria-label={t.viewer.goToLabel}
            value={props.goTo}
            onChange={(e) => {
              props.setGoTo(e.target.value);
            }}
            className="min-h-9 w-20 rounded-[9px] border border-dy-line-2 bg-dy-card px-2 text-[0.875rem]"
          />
          <DyButton type="submit">{t.viewer.goTo}</DyButton>
        </form>
        <DyButton icon="copy" onClick={props.onCopy}>
          {t.viewer.copyLink}
        </DyButton>
        <DyButton
          icon="msg"
          variant={lines === null ? 'secondary' : 'primary'}
          disabled={lines === null}
          onClick={props.onAdd}
          data-testid="code-add-to-chat"
        >
          {t.chat.add}
        </DyButton>
        <span className="text-[0.8125rem] text-dy-muted" aria-live="polite" data-testid="code-selection">
          {lines === null ? t.viewer.selectHint : t.viewer.selected({ range: rangeText(lines) })}
        </span>
      </div>
      <CodeViewerPane
        text={file.text}
        path={file.path}
        label={t.viewer.editorLabel({ path: file.path })}
        mark={props.mark}
        onSelect={props.onSelect}
        apiRef={props.viewer}
        className="h-[70vh] min-h-[18rem] overflow-hidden rounded-[10px] border border-dy-line"
      />
    </>
  );
}

function TreeLevel(props: {
  readonly dir: string;
  readonly depth: number;
  readonly dirs: Readonly<Record<string, Dir>>;
  readonly open: ReadonlySet<string>;
  readonly selected: string;
  readonly onToggle: (dir: string) => void;
  readonly onOpen: (path: string) => void;
}): ReactNode {
  const t = useT().code.tree;
  const sayError = useErrorText();
  const d = props.dirs[props.dir];
  if (d === undefined || d.state.kind === 'loading')
    return (
      <p role="status" className="m-0 px-2 py-1 text-[0.8125rem] text-dy-muted">
        {t.loading}
      </p>
    );
  if (d.state.kind === 'error')
    return (
      <p className="m-0 px-2 py-1 text-[0.8125rem] text-dy-red-ink">{`${t.failed} ${sayError(d.state.error)}`}</p>
    );
  const { entries, truncated } = d.state.value;
  if (entries.length === 0) return <p className="m-0 px-2 py-1 text-[0.8125rem] text-dy-muted">{t.empty}</p>;
  return (
    <ul
      role={props.depth === 0 ? 'tree' : 'group'}
      aria-label={props.depth === 0 ? t.label : undefined}
      className="m-0 list-none p-0"
    >
      {entries.map((e) => {
        const isDir = e.kind === 'dir';
        const expanded = isDir && props.open.has(e.path);
        return (
          <li
            key={e.path}
            role="treeitem"
            aria-expanded={isDir ? expanded : undefined}
            aria-selected={e.path === props.selected}
          >
            <button
              type="button"
              disabled={e.kind === 'submodule'}
              onClick={() => {
                if (isDir) props.onToggle(e.path);
                else props.onOpen(e.path);
              }}
              style={{ paddingLeft: `${String(0.5 + props.depth * 0.85)}rem` }}
              className={cx(
                'flex w-full min-w-0 items-center gap-1.5 rounded-[7px] py-1 pr-2 text-left font-dy-mono text-[0.78125rem] disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                e.path === props.selected && 'bg-dy-teal-soft font-bold text-dy-teal-ink',
              )}
              data-testid="code-tree-item"
            >
              <DyIcon name={isDir ? 'folder' : 'file'} className="size-3.5 shrink-0" />
              <span className="truncate" translate="no">
                {e.name}
              </span>
              {e.kind === 'submodule' ? <span className="text-dy-muted">{` · ${t.submodule}`}</span> : null}
              {e.kind === 'symlink' ? <span className="text-dy-muted">{` · ${t.symlink}`}</span> : null}
            </button>
            {expanded ? (
              <TreeLevel
                dir={e.path}
                depth={props.depth + 1}
                dirs={props.dirs}
                open={props.open}
                selected={props.selected}
                onToggle={props.onToggle}
                onOpen={props.onOpen}
              />
            ) : null}
          </li>
        );
      })}
      {truncated ? <li className="px-2 py-1 text-[0.75rem] text-dy-muted">{t.truncated}</li> : null}
    </ul>
  );
}
