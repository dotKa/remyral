import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { saveWithLink } from '../../../api/download';
import { isAppPackage } from '../../../api/previews';
import {
  artifactInlineUrl,
  fetchArtifact,
  fetchInput,
  formatBytes,
  INLINE_IMAGE_TYPES,
  INLINE_TEXT_TYPES,
  type JobArtifact,
  type JobArtifacts,
  listJobArtifacts,
  FILE_PAGE_SIZES,
  getOutputReport,
  type OutputReport,
  type PrunedReason,
} from '../../../api/workspaces';
import { downloadUrl, startDownload } from '../../../api/storage';
import { Markdown } from '../../../screens/chat/markdown';
import { orderArtifacts, PREVIEW_CHARS } from '../../../screens/workspace/artifacts';
import { DyIcon } from '../../icons';
import { DyButton, DyButtonLink, EmptyLine, Pill } from '../../screens/parts';
import { MonoBlock, Notice, SectionHead } from './bits';
import { OutputReportNotices } from './OutputReport';
import { FullZipButton } from './FullZip';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';

/** p17-object-storage: files above this size download by navigation instead of a fetch into memory. */
const LARGE_DOWNLOAD_BYTES = 32 * 1024 * 1024;
/** p17-output-limits: above this many outputs (on the page) the list is grouped by top folder. */
const GROUP_AT = 20;
/** p18-outputs-delivery: the URL state of the list (a reload keeps the page, its size and the filter). */
const PAGE_PARAM = 'sayfa';
const SIZE_PARAM = 'boyut';
const FILTER_PARAM = 'dosya';
/** Typing in the filter asks the master after this pause. */
const FILTER_DELAY_MS = 300;

/** The page numbers to show: the first, the last and two around the current one, gaps as null ("…"). */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  const out: (number | null)[] = [];
  for (let p = 1; p <= pages; p++) {
    if (keep.has(p)) out.push(p);
    else if (out.at(-1) !== null) out.push(null);
  }
  return out;
}

function sizeOf(raw: string | null): number {
  const n = Number(raw);
  return (FILE_PAGE_SIZES as readonly number[]).includes(n) ? n : FILE_PAGE_SIZES[0];
}

function pageOf(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 10_000) : 1;
}

/**
 * p12-diyalog-w1: the Dosyalar tab of a workspace job (docs/design/p12-diyalog.md §14) — the deliverables (summary
 * first), each with Önizle / İndir; the inputs with İndir and where they came from; "Yeni işte devam et" and
 * "Çıktılar’da aç". Same calls as the classic `WorkspaceArtifacts`. Previews never interpret content as HTML: text as
 * text, JSON pretty-printed as text, Markdown through the safe renderer, raster images from the master's same-origin
 * inline route (the CSP has no `blob:` in `img-src`). Files removed by retention or quota keep their metadata.
 */

type Preview =
  | { readonly id: string; readonly kind: 'text' | 'markdown' | 'json'; readonly text: string }
  | { readonly id: string; readonly kind: 'image'; readonly url: string };

function previewKind(mediaType: string): Preview['kind'] | null {
  if (mediaType === 'text/markdown') return 'markdown';
  if (mediaType === 'application/json') return 'json';
  if (INLINE_TEXT_TYPES.has(mediaType)) return 'text';
  if (INLINE_IMAGE_TYPES.has(mediaType)) return 'image';
  return null;
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

function prunedText(reason: PrunedReason, t: Messages['jobDetail']['files']): string {
  return reason === 'quota' ? t.prunedQuota : t.prunedRetention;
}

function PreviewBody(props: { readonly preview: Preview; readonly name: string }): ReactNode {
  const fmt = useFormat();
  const t = useT().jobDetail.files;
  const p = props.preview;
  const [failed, setFailed] = useState(false);
  if (p.kind === 'image')
    return failed ? (
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.imageFailed}</p>
    ) : (
      <img
        src={p.url}
        alt={t.previewOf({ name: props.name })}
        data-testid="dy-artifact-image"
        className="max-h-[70vh] max-w-full rounded-[10px] border border-dy-line"
        onError={() => {
          setFailed(true);
        }}
      />
    );
  const cut = p.text.length > PREVIEW_CHARS;
  const text = cut ? p.text.slice(0, PREVIEW_CHARS) : p.text;
  return (
    <div className="grid gap-1">
      {p.kind === 'markdown' ? (
        <div className="max-h-[70vh] overflow-auto rounded-[10px] border border-dy-line bg-dy-card p-3 text-[0.9375rem]">
          <Markdown text={text} />
        </div>
      ) : (
        <MonoBlock label={t.previewOf({ name: props.name })} testId="dy-artifact-text">
          {p.kind === 'json' ? pretty(text) : text}
        </MonoBlock>
      )}
      {cut ? (
        <p className="m-0 text-[0.75rem] text-dy-muted">{t.previewCut({ n: fmt.number(PREVIEW_CHARS) })}</p>
      ) : null}
    </div>
  );
}

export function FilesTab(props: {
  readonly jobId: string;
  readonly project: string;
  readonly jobState: string;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT().jobDetail.files;
  const { jobId } = props;
  const uid = useId();
  const [params, setParams] = useSearchParams();
  // p18-outputs-delivery: real pages — the page, its size and the file-name filter live in the URL.
  const page = pageOf(params.get(PAGE_PARAM));
  const size = sizeOf(params.get(SIZE_PARAM));
  const filter = params.get(FILTER_PARAM) ?? '';
  const [typed, setTyped] = useState(filter);
  const [data, setData] = useState<JobArtifacts | null>(null);
  const [report, setReport] = useState<OutputReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const setList = useCallback(
    (next: { page?: number; size?: number; filter?: string }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const put = (k: string, v: string | null): void => {
            if (v === null) p.delete(k);
            else p.set(k, v);
          };
          if (next.page !== undefined) put(PAGE_PARAM, next.page <= 1 ? null : String(next.page));
          if (next.size !== undefined)
            put(SIZE_PARAM, next.size === FILE_PAGE_SIZES[0] ? null : String(next.size));
          if (next.filter !== undefined)
            put(FILTER_PARAM, next.filter.trim() === '' ? null : next.filter.trim());
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The filter asks the master after a short pause (and starts again from page 1).
  useEffect(() => {
    if (typed.trim() === filter) return;
    const timer = setTimeout(() => {
      setList({ filter: typed, page: 1 });
    }, FILTER_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [typed, filter, setList]);

  const load = useCallback(async () => {
    try {
      const list = await listJobArtifacts(jobId, {
        limit: size,
        offset: (page - 1) * size,
        ...(filter === '' ? {} : { q: filter }),
      });
      setData(list);
      setError(null);
    } catch (err) {
      setError(sayError(err));
    }
  }, [jobId, page, size, filter]);
  useEffect(() => {
    void load();
  }, [load, props.jobState]);
  useEffect(() => {
    let live = true;
    // p17-output-limits: the zip / not-returned notices (an older master: none).
    void getOutputReport(jobId)
      .catch(() => null)
      .then((rep) => {
        if (live) setReport(rep);
      });
    return () => {
      live = false;
    };
  }, [jobId, props.jobState]);
  // A page past the end (the list shrank, a stale link): the last page.
  const pages = data === null ? 1 : Math.max(1, Math.ceil(data.total / size));
  useEffect(() => {
    if (data !== null && page > pages) setList({ page: pages });
  }, [data, page, pages, setList]);

  const act = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(sayError(err));
    } finally {
      setBusy(null);
    }
  };

  const openPreview = (a: JobArtifact): void => {
    const kind = previewKind(a.mediaType);
    if (kind === null) return;
    if (preview?.id === a.id) {
      setPreview(null);
      return;
    }
    if (kind === 'image') {
      setActionError(null);
      setPreview({ id: a.id, kind, url: artifactInlineUrl(jobId, a.id) });
      return;
    }
    void act(`preview:${a.id}`, async () => {
      const got = await fetchArtifact(jobId, a.id, true);
      setPreview({ id: a.id, kind, text: new TextDecoder().decode(await got.blob.arrayBuffer()) });
    });
  };

  if (data === null)
    return error === null ? (
      <p role="status" className="m-0 text-[0.875rem] text-dy-muted">
        {t.loading}
      </p>
    ) : (
      <div className="grid justify-items-start gap-2">
        <Notice tone="red">{t.loadError({ error })}</Notice>
        <DyButton onClick={() => void load()}>{t.retry}</DyButton>
      </div>
    );

  const artifacts = orderArtifacts(data.artifacts);
  const from = data.total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(data.total, (page - 1) * size + data.artifacts.length);
  const row = (a: JobArtifact): ReactNode => {
    const kind = previewKind(a.mediaType);
    const open = preview?.id === a.id;
    return (
      <li
        key={a.id}
        data-testid="dy-artifact"
        className="grid gap-2 rounded-[12px] border border-dy-line bg-dy-card px-3.5 py-3 text-[0.875rem]"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <DyIcon name="file" className="size-4 text-dy-muted" />
          <b className="font-dy-mono font-medium break-all">{a.name}</b>
          {a.kind === 'summary' ? <Pill tone="teal">{t.summary}</Pill> : null}
          {a.redacted ? <Pill tone="amber">{t.redacted}</Pill> : null}
          {isAppPackage(a.mediaType, a.name) ? <Pill tone="neutral">{t.appPackage}</Pill> : null}
          {a.prunedReason === null ? null : <Pill tone="neutral">{prunedText(a.prunedReason, t)}</Pill>}
          <span className="text-[0.8125rem] text-dy-muted">{`${a.mediaType} · ${formatBytes(a.sizeBytes)}`}</span>
        </span>
        {a.prunedReason === null ? (
          <span className="flex flex-wrap gap-2">
            {kind === null ? null : (
              <DyButton
                icon="search"
                aria-expanded={open}
                aria-label={t.previewNamed({
                  action: open ? t.hidePreview : t.preview,
                  name: a.name,
                })}
                busy={busy === `preview:${a.id}`}
                onClick={() => {
                  openPreview(a);
                }}
              >
                {open ? t.hidePreview : t.preview}
              </DyButton>
            )}
            <DyButton
              icon="tray"
              aria-label={t.downloadNamed({ name: a.name })}
              busy={busy === `download:${a.id}`}
              onClick={() =>
                void act(`download:${a.id}`, async () => {
                  // p17-object-storage: a large file is downloaded by navigation (a presigned link or
                  // the streamed file), never read into the page's memory.
                  if (a.sizeBytes > LARGE_DOWNLOAD_BYTES) {
                    startDownload(
                      downloadUrl(`/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(a.id)}`),
                    );
                    return;
                  }
                  const got = await fetchArtifact(jobId, a.id, false);
                  saveWithLink(got.blob, got.filename ?? a.name);
                })
              }
            >
              {t.download}
            </DyButton>
          </span>
        ) : null}
        {open ? <PreviewBody preview={preview} name={a.name} /> : null}
      </li>
    );
  };
  // p17-output-limits: many files are grouped by their top folder (folded), the rest stays a flat list.
  const outputs = artifacts.filter((a) => a.kind !== 'summary');
  const grouped = outputs.length > GROUP_AT;
  const top = grouped ? artifacts.filter((a) => a.kind === 'summary' || !a.name.includes('/')) : artifacts;
  const folders = new Map<string, JobArtifact[]>();
  if (grouped) {
    for (const a of outputs) {
      const i = a.name.indexOf('/');
      if (i < 0) continue;
      const f = a.name.slice(0, i);
      folders.set(f, [...(folders.get(f) ?? []), a]);
    }
  }
  const continueTo = `/jobs/new?${new URLSearchParams({ project: props.project, continueFrom: jobId }).toString()}`;
  return (
    <div className="grid gap-5" data-testid="dy-files">
      <section aria-labelledby="dy-deliverables" className="grid gap-2">
        <SectionHead
          id="dy-deliverables"
          count={String(data.total)}
          aside={
            data.total > 0 || (data.archive?.files ?? 0) > 0 ? (
              // p18-outputs-delivery: every file of the job in one zip is the tab's primary action.
              <FullZipButton jobId={jobId} archive={data.archive} />
            ) : undefined
          }
        >
          {t.deliverables}
        </SectionHead>
        <OutputReportNotices report={report} jobId={jobId} />
        {data.total > 0 || filter !== '' ? (
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2" data-testid="dy-files-tools">
            <label className="grid min-w-[12rem] flex-1 gap-1 text-[0.8125rem] text-dy-muted">
              {t.filterLabel}
              <input
                type="search"
                value={typed}
                placeholder={t.filterPlaceholder}
                onChange={(e) => {
                  setTyped(e.target.value);
                }}
                maxLength={200}
                className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 text-[0.875rem] text-dy-ink"
                data-testid="dy-files-filter"
              />
            </label>
            <label className="grid gap-1 text-[0.8125rem] text-dy-muted">
              {t.pageSize}
              <select
                value={size}
                onChange={(e) => {
                  setList({ size: Number(e.target.value), page: 1 });
                }}
                className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-2 text-[0.875rem] text-dy-ink"
                data-testid="dy-files-page-size"
              >
                {FILE_PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {String(n)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {artifacts.length === 0 ? (
          filter !== '' ? (
            <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="dy-files-no-match">
              {t.noMatch({ q: filter })}
            </p>
          ) : (
            <div className="rounded-[12px] border border-dashed border-dy-line-2">
              <EmptyLine testId="dy-files-empty">
                {t.emptyBefore} <span className="font-dy-mono">{'out/'}</span> {t.emptyAfter}
              </EmptyLine>
            </div>
          )
        ) : (
          <div className="grid gap-2">
            <ul className="m-0 grid list-none gap-2 p-0" aria-label={t.deliverables}>
              {top.map(row)}
            </ul>
            {[...folders.entries()].map(([name, items]) => (
              <details
                key={name}
                data-testid="dy-artifact-folder"
                className="rounded-[12px] border border-dy-line bg-dy-sunk px-3 py-2"
              >
                <summary className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.875rem] font-bold">
                  <DyIcon name="folder" className="size-4 text-dy-muted" />
                  <span className="font-dy-mono break-all">{t.folder({ name, n: items.length })}</span>
                </summary>
                <ul className="m-0 mt-2 grid list-none gap-2 p-0" aria-label={name}>
                  {items.map(row)}
                </ul>
              </details>
            ))}
          </div>
        )}
        {data.total > 0 ? (
          <nav
            aria-label={t.pages}
            className="flex flex-wrap items-center gap-x-3 gap-y-2"
            data-testid="dy-files-pages"
          >
            <span className="text-[0.8125rem] text-dy-muted tabular-nums" id={`${uid}-range`} role="status">
              {t.pageRange({ from, to, total: data.total })}
            </span>
            {pages > 1 ? (
              <ul className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
                <li>
                  <DyButton
                    variant="ghost"
                    disabled={page <= 1}
                    onClick={() => {
                      setList({ page: page - 1 });
                    }}
                    data-testid="dy-files-prev"
                  >
                    {t.prevPage}
                  </DyButton>
                </li>
                {pageWindow(page, pages).map((p, i) =>
                  p === null ? (
                    <li key={`gap-${String(i)}`} aria-hidden="true" className="px-1 text-dy-muted">
                      …
                    </li>
                  ) : (
                    <li key={p}>
                      <DyButton
                        variant={p === page ? 'primary' : 'secondary'}
                        aria-current={p === page ? 'page' : undefined}
                        aria-label={t.pageN({ n: p })}
                        onClick={() => {
                          setList({ page: p });
                        }}
                        className="min-w-9 justify-center tabular-nums"
                      >
                        {String(p)}
                      </DyButton>
                    </li>
                  ),
                )}
                <li>
                  <DyButton
                    variant="ghost"
                    disabled={page >= pages}
                    onClick={() => {
                      setList({ page: page + 1 });
                    }}
                    data-testid="dy-files-next"
                  >
                    {t.nextPage}
                  </DyButton>
                </li>
              </ul>
            ) : null}
          </nav>
        ) : null}
      </section>
      {actionError === null ? null : <Notice tone="red">{actionError}</Notice>}
      <section aria-labelledby="dy-inputs" className="grid gap-2">
        <SectionHead id="dy-inputs" count={String(data.inputs.length)}>
          {t.inputs}
        </SectionHead>
        {data.inputs.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.noInputs}</p>
        ) : (
          <ul
            className="m-0 grid list-none divide-y divide-dy-line rounded-[12px] border border-dy-line bg-dy-card p-0"
            aria-label={t.inputs}
          >
            {data.inputs.map((i) => (
              <li
                key={i.id}
                data-testid="dy-input"
                className="flex flex-wrap items-center gap-2 px-3.5 py-2 text-[0.875rem]"
              >
                <span className="min-w-0 flex-1 font-dy-mono break-all">{i.name}</span>
                <span className="text-[0.8125rem] text-dy-muted">
                  {`${i.mediaType} · ${formatBytes(i.sizeBytes)}`}
                  {i.source !== 'upload' && i.sourceJobId !== null
                    ? i.source === 'upstream'
                      ? t.fromUpstream
                      : i.source === 'subtask'
                        ? t.fromSubtask
                        : t.fromJob
                    : ''}
                </span>
                {i.source !== 'upload' && i.sourceJobId !== null ? (
                  <Link
                    to={`/jobs/${encodeURIComponent(i.sourceJobId)}`}
                    className="font-dy-mono text-[0.8125rem] text-dy-teal-ink"
                  >
                    {i.sourceJobId.slice(0, 8)}
                  </Link>
                ) : null}
                {i.prunedReason !== null ? (
                  <Pill tone="neutral">{prunedText(i.prunedReason, t)}</Pill>
                ) : (
                  <DyButton
                    variant="ghost"
                    icon="tray"
                    aria-label={t.downloadInput({ name: i.name })}
                    busy={busy === `input:${i.id}`}
                    onClick={() =>
                      void act(`input:${i.id}`, async () => {
                        const got = await fetchInput(jobId, i.id);
                        saveWithLink(got.blob, got.filename ?? i.name);
                      })
                    }
                  >
                    {t.download}
                  </DyButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="flex flex-wrap items-center gap-2">
        <DyButtonLink to={continueTo} icon="retry">
          {t.continueInNewJob}
        </DyButtonLink>
        {data.total > 0 ? (
          <DyButtonLink
            to={`/outputs?tab=file&job=${encodeURIComponent(jobId)}`}
            variant="ghost"
            icon="folder"
          >
            {t.openInOutputs}
          </DyButtonLink>
        ) : null}
        <DyButton variant="ghost" icon="retry" onClick={() => void load()}>
          {t.refresh}
        </DyButton>
      </div>
    </div>
  );
}
