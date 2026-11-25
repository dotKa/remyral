import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { type Diff, getDiff } from '../../../api/live';
import {
  fileUrl,
  getSiteBundle,
  type OutputFile,
  type SiteBundle,
  type SiteBundleFile,
  siteFileUrl,
} from '../../../api/outputs';
import { isAppPackage } from '../../../api/previews';
import { cx, toApiError } from '../../../components/ui';
import { stripAnsi } from '../../../lib/ansi';
import {
  countNodes,
  JSON_NODES,
  parseDelimited,
  TABLE_COLS,
  TABLE_ROWS,
  useText,
} from '../../../screens/outputs/FileViewer';
import { classifyDiffLine, DIFF_PREVIEW_LINES } from '../../../screens/live/diffLines';
import { PREVIEW_CHARS } from '../../../screens/workspace/artifacts';
import { DyApiError, DyNotice } from '../kit';
import { DyButton, SkeletonRows } from '../parts';
import { DyMarkdown } from './shared';
import { DyLightbox, DyZoomImage, type LightboxImage } from './Lightbox';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2: in-app previews of job output in the Diyalog language, with the classic rules (p6-outputs §5)
 * unchanged — untrusted content is never markup of the console: text and Markdown are React text, CSV / TSV a bounded
 * table, JSON a bounded tree, images and PDFs from the same-origin download route (CSP + nosniff), a site bundle's
 * HTML only inside `<iframe sandbox="">` (no scripts, opaque origin, no referrer) — exactly the classic attributes.
 * The fetching, parsing and limits are the classic helpers (`screens/outputs/FileViewer.tsx`).
 */

const BOX = 'max-h-[60vh] overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk';

export function DyTextBlock(props: { readonly text: string }): ReactNode {
  return (
    <pre
      className={cx(BOX, 'm-0 p-3 font-dy-mono text-[0.78125rem] leading-5 break-words whitespace-pre-wrap')}
      data-testid="text-preview"
    >
      {props.text}
    </pre>
  );
}

function Seg<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (v: T) => void;
}): ReactNode {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="inline-flex w-fit gap-0.5 rounded-[9px] border border-dy-line bg-dy-sunk p-[3px]"
    >
      {props.options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          aria-pressed={props.value === v}
          onClick={() => {
            props.onChange(v);
          }}
          className={cx(
            'min-h-8 rounded-[6px] px-2.5 text-[0.8125rem] font-medium',
            props.value === v
              ? 'bg-dy-card text-dy-ink shadow-dy-seg'
              : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function DyTable(props: { readonly text: string; readonly sep: ',' | '\t' }): ReactNode {
  const t = useT().outputs.previews;
  const rows = useMemo(() => parseDelimited(props.text, props.sep), [props.text, props.sep]);
  const shown = rows.slice(0, TABLE_ROWS);
  const head = shown[0] ?? [];
  const body = shown.slice(1);
  const cols = Math.min(TABLE_COLS, Math.max(0, ...shown.map((r) => r.length)));
  return (
    <div className="flex flex-col gap-1">
      <div className={cx(BOX, 'bg-dy-card')} data-testid="table-preview">
        <table className="min-w-full border-collapse text-left text-[0.78125rem]">
          <thead className="sticky top-0 bg-dy-sunk">
            <tr>
              {Array.from({ length: cols }, (_, i) => (
                <th
                  key={i}
                  scope="col"
                  className="border-b border-dy-line px-2.5 py-1.5 font-bold whitespace-nowrap"
                >
                  {head[i] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {Array.from({ length: cols }, (_, j) => (
                  <td
                    key={j}
                    className="border-b border-dy-line px-2.5 py-1 align-top font-dy-mono whitespace-pre-wrap tabular-nums"
                  >
                    {r[j] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > TABLE_ROWS || shown.some((r) => r.length > TABLE_COLS) ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted">
          {t.tableCut({ rows: TABLE_ROWS, cols: TABLE_COLS })}
        </p>
      ) : null}
    </div>
  );
}

function JsonNode(props: {
  readonly name: string | null;
  readonly value: unknown;
  readonly depth: number;
}): ReactNode {
  const { name, value, depth } = props;
  const label = name === null ? null : <span className="text-dy-teal-ink">{JSON.stringify(name)}: </span>;
  if (typeof value !== 'object' || value === null) {
    return (
      <div className="pl-4 break-all">
        {label}
        <span className={typeof value === 'string' ? 'text-dy-green' : 'text-dy-ink'}>
          {JSON.stringify(value)}
        </span>
      </div>
    );
  }
  const entries: [string | null, unknown][] = Array.isArray(value)
    ? (value as unknown[]).map((v) => [null, v])
    : Object.entries(value);
  return (
    <details open={depth < 2} className="pl-4">
      <summary className="cursor-pointer">
        {label}
        {Array.isArray(value) ? '[' : '{'}
        <span className="text-dy-muted"> {entries.length} </span>
        {Array.isArray(value) ? ']' : '}'}
      </summary>
      {entries.map(([k, v], i) => (
        <JsonNode key={i} name={k} value={v} depth={depth + 1} />
      ))}
    </details>
  );
}

export function DyJson(props: { readonly text: string }): ReactNode {
  const t = useT().outputs.previews;
  const parsed = useMemo((): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(props.text) as unknown };
    } catch {
      return { ok: false };
    }
  }, [props.text]);
  const [mode, setMode] = useState<'tree' | 'text'>('tree');
  if (!parsed.ok) return <DyTextBlock text={props.text} />;
  const tree = countNodes(parsed.value, JSON_NODES) <= JSON_NODES;
  return (
    <div className="flex flex-col gap-2">
      {tree ? (
        <Seg
          label={t.jsonView}
          value={mode}
          options={[
            ['tree', t.tree],
            ['text', t.text],
          ]}
          onChange={setMode}
        />
      ) : null}
      {tree && mode === 'tree' ? (
        <div className={cx(BOX, 'p-2 font-dy-mono text-[0.78125rem] leading-5')} data-testid="json-tree">
          <JsonNode name={null} value={parsed.value} depth={0} />
        </div>
      ) : (
        <DyTextBlock text={JSON.stringify(parsed.value, null, 2)} />
      )}
    </div>
  );
}

const DIFF_CLASS: Readonly<Record<ReturnType<typeof classifyDiffLine>, string>> = {
  file: 'mt-2 bg-dy-card font-bold',
  meta: 'text-dy-muted',
  hunk: 'text-dy-teal-ink',
  add: 'bg-dy-green-soft text-dy-green',
  del: 'bg-dy-red-soft text-dy-red-ink',
  ctx: '',
};

function DyDiff(props: { readonly jobId: string }): ReactNode {
  const t = useT().outputs.previews;
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    getDiff(props.jobId).then(
      (d) => {
        if (live) setDiff(d);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [props.jobId]);
  const lines = useMemo(() => (diff === null ? [] : stripAnsi(diff.text).split('\n')), [diff]);
  if (error !== null) return <DyApiError error={error} />;
  if (diff === null) return <SkeletonRows label={t.diffLoading} rows={3} />;
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[0.78125rem] text-dy-muted">
        <span className="font-dy-mono">{diff.baseSha.slice(0, 10)}</span> →{' '}
        <span className="font-dy-mono">{diff.headSha.slice(0, 10)}</span>
        {` · ${t.lines({ n: lines.length })}`}
        {diff.truncated ? ` · ${t.truncatedByServer}` : ''}
      </p>
      <pre className={cx(BOX, 'm-0 p-2 font-dy-mono text-[0.75rem] leading-5')} data-testid="diff-view">
        {shown.map((l, i) => {
          const kind = classifyDiffLine(l);
          return (
            <div key={i} className={cx('whitespace-pre', DIFF_CLASS[kind])} data-kind={kind}>
              {l === '' ? ' ' : l}
            </div>
          );
        })}
      </pre>
      {!all && lines.length > DIFF_PREVIEW_LINES ? (
        <DyButton
          onClick={() => {
            setAll(true);
          }}
        >
          {t.showAll({ n: lines.length })}
        </DyButton>
      ) : null}
    </div>
  );
}

/** The preview of one output file, chosen by the master's preview kind. */
export function DyFileViewer(props: {
  readonly file: OutputFile;
  readonly jobId: string | null;
  readonly name: string;
  /**
   * p15-workspace-retention: the job's images in order (the lightbox goes next / previous across them) and this
   * file's place among them. Absent: the lightbox shows this image alone.
   */
  readonly gallery?: { readonly images: readonly LightboxImage[]; readonly index: number } | undefined;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().outputs.previews;
  const { file, jobId } = props;
  const [zoom, setZoom] = useState<number | null>(null);
  const textKind = ['markdown', 'text', 'json', 'csv', 'tsv'].includes(file.preview);
  const { text, error, truncated } = useText(
    textKind && file.download !== null && file.removed === null ? `${file.download}?inline=1` : null,
  );
  if (file.removed !== null) {
    return <DyNotice tone="neutral">{t.removed({ quota: file.removed === 'quota' })}</DyNotice>;
  }
  if (file.preview === 'diff' && jobId !== null) return <DyDiff jobId={jobId} />;
  if (file.download === null || file.preview === 'none') {
    return (
      <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="no-preview">
        {file.source === 'run' ? t.fromRun : isAppPackage(file.mediaType, props.name) ? t.appPackage : t.none}
      </p>
    );
  }
  if (file.preview === 'image') {
    // p15-workspace-retention: never squashed (object-contain in a bounded box); click → lightbox.
    const own: LightboxImage = {
      src: fileUrl(file.download, true),
      name: props.name,
      download: fileUrl(file.download, false),
    };
    const images = props.gallery?.images ?? [own];
    const at = props.gallery?.index ?? 0;
    return (
      <>
        <DyZoomImage
          src={own.src}
          name={t.imageAlt({ name: props.name })}
          onOpen={() => {
            setZoom(at);
          }}
        />
        <DyLightbox
          images={images}
          index={zoom}
          onIndex={setZoom}
          onClose={() => {
            setZoom(null);
          }}
        />
      </>
    );
  }
  if (file.preview === 'pdf') {
    return (
      <div className="flex flex-col gap-1.5">
        <iframe
          title={t.pdfTitle({ name: props.name })}
          src={fileUrl(file.download, true)}
          className="h-[70vh] w-full rounded-[10px] border border-dy-line bg-dy-card"
          referrerPolicy="no-referrer"
          data-testid="pdf-preview"
        />
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.pdfNote}</p>
      </div>
    );
  }
  if (error !== null) return <DyApiError error={error} />;
  if (text === null) return <SkeletonRows label={t.loading} rows={3} />;
  return (
    <div className="flex flex-col gap-1.5" data-testid="file-preview">
      {file.preview === 'markdown' ? (
        <div className={cx(BOX, 'bg-dy-card p-3')}>
          <DyMarkdown source={text} />
        </div>
      ) : file.preview === 'json' ? (
        <DyJson text={text} />
      ) : file.preview === 'csv' || file.preview === 'tsv' ? (
        <DyTable text={text} sep={file.preview === 'csv' ? ',' : '\t'} />
      ) : (
        <DyTextBlock text={text} />
      )}
      {truncated ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.cut({ chars: fmt.number(PREVIEW_CHARS) })}</p>
      ) : null}
    </div>
  );
}

/** The files of a site's bundle: HTML only in a sandboxed frame, images as images, the rest as source text. */
export function DySiteBundle(props: { readonly jobId: string }): ReactNode {
  const t = useT().outputs.previews;
  const [bundle, setBundle] = useState<SiteBundle | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<SiteBundleFile | null>(null);
  useEffect(() => {
    let live = true;
    getSiteBundle(props.jobId).then(
      (b) => {
        if (!live) return;
        setBundle(b);
        setSelected(b.files.find((f) => f.path === 'index.html') ?? b.files[0] ?? null);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [props.jobId]);
  if (error !== null) {
    return error.status === 404 ? (
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.bundleMissing}</p>
    ) : (
      <DyApiError error={error} />
    );
  }
  if (bundle === null) return <SkeletonRows label={t.bundleLoading} rows={2} />;
  if (bundle.flagged) return <DyNotice tone="amber">{t.bundleFlagged}</DyNotice>;
  if (bundle.removed !== null) return <DyNotice tone="neutral">{t.bundleRemoved}</DyNotice>;
  return (
    <div className="flex flex-col gap-2" data-testid="site-bundle">
      <label className="flex flex-col gap-1 text-[0.8125rem] font-bold">
        {t.file}
        <select
          value={selected?.path ?? ''}
          onChange={(e) => {
            setSelected(bundle.files.find((f) => f.path === e.target.value) ?? null);
          }}
          className="min-h-10 w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-normal sm:min-h-9"
        >
          {bundle.files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
        </select>
      </label>
      {selected === null ? null : <SiteFile key={selected.path} jobId={props.jobId} file={selected} />}
    </div>
  );
}

function SiteFile(props: { readonly jobId: string; readonly file: SiteBundleFile }): ReactNode {
  const t = useT().outputs.previews;
  const { jobId, file } = props;
  const url = siteFileUrl(jobId, file.path);
  const path = `/jobs/${encodeURIComponent(jobId)}/site-bundle/file?path=${encodeURIComponent(file.path)}`;
  const [html, setHtml] = useState<'render' | 'source'>('render');
  const [zoom, setZoom] = useState<number | null>(null);
  const source = useText(file.view === 'source' || (file.view === 'html' && html === 'source') ? path : null);
  if (file.view === 'html') {
    return (
      <div className="flex flex-col gap-2">
        <Seg
          label={t.htmlView}
          value={html}
          options={[
            ['render', t.render],
            ['source', t.source],
          ]}
          onChange={setHtml}
        />
        {html === 'render' ? (
          <iframe
            title={t.sandboxTitle({ path: file.path })}
            src={url}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-[60vh] w-full rounded-[10px] border border-dy-line bg-white"
            data-testid="html-preview"
          />
        ) : source.error !== null ? (
          <DyApiError error={source.error} />
        ) : source.text === null ? (
          <SkeletonRows label={t.sourceLoading} rows={2} />
        ) : (
          <DyTextBlock text={source.text} />
        )}
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.sandboxNote}</p>
      </div>
    );
  }
  if (file.view === 'image')
    return (
      <>
        <DyZoomImage
          src={url}
          name={t.imageAlt({ name: file.path })}
          onOpen={() => {
            setZoom(0);
          }}
        />
        <DyLightbox
          images={[{ src: url, name: file.path, download: null }]}
          index={zoom}
          onIndex={setZoom}
          onClose={() => {
            setZoom(null);
          }}
        />
      </>
    );
  if (file.view === 'none') return <p className="m-0 text-[0.875rem] text-dy-muted">{t.noneShort}</p>;
  if (source.error !== null) return <DyApiError error={source.error} />;
  if (source.text === null) return <SkeletonRows label={t.sourceLoading} rows={2} />;
  return <DyTextBlock text={source.text} />;
}
