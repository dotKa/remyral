import { type ReactNode, useId, useState } from 'react';
import type { Project } from '../../api/directory';
import { Spinner } from '../../components/ui';
import { useSharedT } from '../../i18n/scope';
import { formatBytes } from './attachment-files';
import { MAX_ZIPS, zipCan, type ZipMode } from './chat-zip';
import type { ZipItem } from './useSiteZips';

/**
 * p15-chat-zip: the composer's .zip chips and the chips of a sent message. A chip shows the archive's name, file count
 * and size, an expandable file list, why it is not a publishable site (or which files are left out), the project the
 * site is uploaded to, and the upload's progress / failure. Names render as text only; nothing of the site is ever
 * shown as HTML here (it would run on the console origin).
 */

function ZipIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M10 6h1M10 9h1M10 12h1M10 15h1" />
    </svg>
  );
}

function ZipChip(props: {
  readonly item: ZipItem;
  readonly projects: readonly Project[] | null;
  readonly projectsFailed: boolean;
  readonly onRemove: (key: string) => void;
  readonly onProject: (key: string, project: string) => void;
  readonly onMode?: ((key: string, mode: ZipMode) => void) | undefined;
  readonly onSendAnyway?: ((key: string) => void) | undefined;
  readonly onLeaveOut?: ((key: string) => void) | undefined;
}): ReactNode {
  const t = useSharedT().shared.chat;
  const z = t.zip;
  const { item } = props;
  const plan = item.plan;
  const [open, setOpen] = useState(false);
  const selectId = useId();
  const listId = useId();
  const modeName = useId();
  const can = plan === null ? { site: false, input: false } : zipCan(plan);
  const mode = item.mode;
  const inputMode = mode === 'input' || mode === 'both';
  const siteMode = mode === 'site' || mode === 'both';
  const editable =
    mode !== null && (item.phase === 'ready' || item.phase === 'failed' || item.phase === 'secrets');
  const p = item.progress;
  const bad = item.phase === 'refused' || item.phase === 'failed' || item.phase === 'secrets';
  // p16-zip-job-input: the file list / left-out files of what is sent (the input plan when input files go).
  const shown =
    plan === null
      ? null
      : mode === 'input' && plan.input !== null
        ? { files: plan.input.files, refused: plan.input.refused, total: plan.input.totalBytes }
        : { files: plan.files, refused: plan.refused, total: plan.totalBytes };
  return (
    <li
      data-testid="zip-chip"
      data-phase={item.phase}
      data-mode={mode ?? 'none'}
      className={`relative flex w-full max-w-md flex-col gap-1 rounded-md border bg-surface p-2 pr-8 text-meta ${
        bad ? 'border-danger/50' : 'border-line'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ZipIcon />
        <span className="truncate font-medium text-fg" title={item.name}>
          {item.name}
        </span>
        {shown === null ? null : (
          <span className="shrink-0 text-xs text-muted" data-testid="zip-summary">
            {z.summary({ n: shown.files.length, size: formatBytes(shown.total) })}
          </span>
        )}
      </span>
      {item.phase === 'reading' ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <Spinner /> {z.reading}
        </span>
      ) : null}
      {plan !== null && plan.strippedRoot !== null ? (
        <span className="text-xs text-muted">{z.stripped({ folder: plan.strippedRoot })}</span>
      ) : null}
      {plan !== null && mode === null ? (
        <div role="alert" className="text-xs text-danger" data-testid="zip-problems">
          <ul>
            {plan.problems.map((x) => (
              <li key={x}>{z.problems[x]}</li>
            ))}
            {(plan.input?.problems ?? []).map((x) => (
              <li key={`input-${x}`}>{z.inputProblems[x]}</li>
            ))}
          </ul>
          {plan.error === null ? null : <p className="text-muted">{plan.error}</p>}
          <p>{z.notSite}</p>
        </div>
      ) : null}
      {can.site && can.input && editable && props.onMode !== undefined ? (
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="zip-mode">
          <legend className="sr-only">{z.modeLabel}</legend>
          <span className="text-muted" aria-hidden="true">
            {z.modeLabel}
          </span>
          {(['both', 'site', 'input'] as const).map((m) => (
            <label key={m} className="inline-flex items-center gap-1 text-fg">
              <input
                type="radio"
                name={modeName}
                value={m}
                checked={mode === m}
                onChange={() => {
                  props.onMode?.(item.key, m);
                }}
              />
              {z.modes[m]}
            </label>
          ))}
        </fieldset>
      ) : null}
      {mode !== null && item.phase === 'ready' ? (
        <span className="text-xs text-muted" data-testid="zip-hint">
          {mode === 'both' ? z.bothHint : mode === 'site' ? z.site : z.input}
        </span>
      ) : null}
      {inputMode && plan?.input != null && plan.input.skipped > 0 ? (
        <span className="text-xs text-muted">{z.skippedFiles({ n: plan.input.skipped })}</span>
      ) : null}
      {editable ? (
        props.projects !== null && props.projects.length === 0 ? (
          <span role="alert" className="text-xs text-danger" data-testid="zip-no-project">
            {z.noProject}
          </span>
        ) : props.projects === null && props.projectsFailed ? (
          <span role="alert" className="text-xs text-danger">
            {z.projectsFailed}
          </span>
        ) : props.projects === null ? null : (
          <span className="flex items-center gap-2 text-xs">
            <label htmlFor={selectId} className="text-muted">
              {z.project}
            </label>
            <select
              id={selectId}
              data-testid="zip-project"
              className="min-w-0 rounded border border-line bg-canvas px-1 py-0.5 text-fg"
              value={item.project ?? ''}
              title={siteMode ? z.projectHint : z.projectHintInput}
              onChange={(e) => {
                props.onProject(item.key, e.target.value);
              }}
            >
              {props.projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </select>
          </span>
        )
      ) : null}
      {item.phase === 'uploading' ? (
        <span className="flex flex-col gap-0.5 text-xs text-muted" data-testid="zip-progress">
          <span className="inline-flex items-center gap-1">
            <Spinner />
            {p === null || p.phase === 'hashing'
              ? z.hashing
              : p.phase === 'checking'
                ? z.checking
                : z.progress({ sent: formatBytes(p.sentBytes), total: formatBytes(p.totalBytes) })}
          </span>
          {p?.retry == null ? null : <span>{z.retrying(p.retry)}</span>}
          <progress className="h-1 w-full" max={Math.max(1, p?.totalBytes ?? 1)} value={p?.sentBytes ?? 0} />
        </span>
      ) : null}
      {item.phase === 'uploaded' ? <span className="text-xs text-ok">{z.uploaded}</span> : null}
      {item.phase === 'secrets' ? (
        <div role="alert" className="flex flex-col gap-1 text-xs text-danger" data-testid="zip-secrets">
          <p>{z.secretsTitle({ n: item.findings.length })}</p>
          <ul className="max-h-32 overflow-auto font-mono">
            {item.findings.slice(0, 30).map((f) => (
              <li key={`${f.path}:${String(f.line)}:${f.rule}`} className="break-all">
                {z.secretLine({ path: f.path, line: f.line, rule: f.rule })}
              </li>
            ))}
            {item.findings.length > 30 ? <li>…</li> : null}
          </ul>
          {props.onSendAnyway === undefined ? null : (
            <span className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="zip-send-anyway"
                className="rounded border border-danger/60 px-1.5 py-0.5 text-danger hover:bg-danger-soft"
                onClick={() => {
                  props.onSendAnyway?.(item.key);
                }}
              >
                {z.sendAnyway}
              </button>
              <span className="text-muted">{z.sendAnywayHint}</span>
            </span>
          )}
        </div>
      ) : null}
      {item.allowSecrets && item.phase === 'ready' ? (
        <span className="text-xs text-warn" data-testid="zip-will-send-anyway">
          {z.willSendAnyway}
        </span>
      ) : null}
      {item.phase === 'failed' && item.error !== null ? (
        <div role="alert" className="text-xs text-danger" data-testid="zip-failed">
          <p>{z.failed({ error: item.error })}</p>
          {item.refusedByMaster.length === 0 ? null : (
            <ul className="mt-0.5">
              {item.refusedByMaster.slice(0, 20).map((r) => (
                <li key={`${r.path}-${r.reason}`} className="break-all">
                  <span className="font-mono">{r.path}</span>
                  {r.line === undefined ? '' : `:${String(r.line)}`} — {r.reason}
                </li>
              ))}
            </ul>
          )}
          {inputMode && item.refusedByMaster.some((r) => r.path !== '') && props.onLeaveOut !== undefined ? (
            <button
              type="button"
              data-testid="zip-leave-out"
              className="mt-1 rounded border border-line px-1.5 py-0.5 text-fg hover:bg-surface-2"
              onClick={() => {
                props.onLeaveOut?.(item.key);
              }}
            >
              {z.leaveOut({ n: item.refusedByMaster.filter((r) => r.path !== '').length })}
            </button>
          ) : null}
        </div>
      ) : null}
      {shown !== null && shown.refused.length > 0 && mode !== null ? (
        <div className="text-xs text-warn" data-testid="zip-refused">
          <p>{z.refusedFiles({ n: shown.refused.length })}</p>
          <ul>
            {shown.refused.slice(0, 20).map((r) => (
              <li key={`${r.path}-${r.reason}`} className="break-all">
                <span className="font-mono">{r.path}</span> — {r.reason}
              </li>
            ))}
            {shown.refused.length > 20 ? <li>…</li> : null}
          </ul>
        </div>
      ) : null}
      {shown !== null && shown.files.length > 0 ? (
        <>
          <button
            type="button"
            className="self-start text-xs text-accent hover:underline"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? z.hideFiles : z.showFiles({ n: shown.files.length })}
          </button>
          {open ? (
            <ul
              id={listId}
              className="max-h-40 overflow-auto rounded border border-line px-1.5 py-1 font-mono text-xs"
              data-testid="zip-files"
            >
              {shown.files.map((f) => (
                <li key={f.path} className="flex justify-between gap-2">
                  <span className="break-all">{f.path}</span>
                  <span className="shrink-0 text-muted tabular-nums">{formatBytes(f.size)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        onClick={() => {
          props.onRemove(item.key);
        }}
        aria-label={t.remove({ name: item.name })}
        className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

/** The composer's .zip chips (inside the attachment tray). */
export function ZipChips(props: {
  readonly items: readonly ZipItem[];
  readonly projects: readonly Project[] | null;
  readonly projectsFailed: boolean;
  readonly overflow: number;
  readonly onRemove: (key: string) => void;
  readonly onProject: (key: string, project: string) => void;
  /** p16-zip-job-input: site / input files / both, "send anyway", leave out refused files. */
  readonly onMode?: (key: string, mode: ZipMode) => void;
  readonly onSendAnyway?: (key: string) => void;
  readonly onLeaveOut?: (key: string) => void;
}): ReactNode {
  const t = useSharedT().shared.chat;
  if (props.items.length === 0 && props.overflow === 0) return null;
  return (
    <>
      {props.items.length === 0 ? null : (
        <ul className="flex flex-col gap-2" aria-label={t.attachedFiles} data-testid="zip-chips">
          {props.items.map((i) => (
            <ZipChip
              key={i.key}
              item={i}
              projects={props.projects}
              projectsFailed={props.projectsFailed}
              onRemove={props.onRemove}
              onProject={props.onProject}
              onMode={props.onMode}
              onSendAnyway={props.onSendAnyway}
              onLeaveOut={props.onLeaveOut}
            />
          ))}
        </ul>
      )}
      {props.overflow > 0 ? (
        <p role="alert" className="text-meta text-danger">
          {t.zip.tooMany({ n: MAX_ZIPS })}
        </p>
      ) : null}
    </>
  );
}

/** `meta.siteUploads` / `meta.archives` of a sent message as chips (anything malformed is skipped). */
export function MessageSiteZips(props: { readonly meta: Record<string, unknown> | null }): ReactNode {
  const z = useSharedT().shared.chat.zip;
  const rec = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const uploads = (Array.isArray(props.meta?.siteUploads) ? props.meta.siteUploads : []).flatMap((x) => {
    const o = rec(x);
    return o === null || typeof o.id !== 'string'
      ? []
      : [
          {
            id: o.id,
            name: typeof o.label === 'string' ? o.label.slice(0, 120) : 'site.zip',
            n: num(o.fileCount),
            size: num(o.totalBytes),
          },
        ];
  });
  const archives = (Array.isArray(props.meta?.archives) ? props.meta.archives : []).flatMap((x) => {
    const o = rec(x);
    return o === null || typeof o.name !== 'string' ? [] : [{ name: o.name.slice(0, 120) }];
  });
  // p16-zip-job-input: the message's job input bundles.
  const inputs = (Array.isArray(props.meta?.inputUploads) ? props.meta.inputUploads : []).flatMap((x) => {
    const o = rec(x);
    return o === null || typeof o.id !== 'string'
      ? []
      : [
          {
            id: o.id,
            name: typeof o.label === 'string' ? o.label.slice(0, 120) : 'files.zip',
            n: num(o.fileCount),
            size: num(o.totalBytes),
            secrets: Array.isArray(o.secretFindings) && o.secretFindings.length > 0,
          },
        ];
  });
  if (uploads.length === 0 && archives.length === 0 && inputs.length === 0) return null;
  return (
    <ul className="flex max-w-[85%] flex-wrap justify-end gap-2" data-testid="message-zips">
      {uploads.map((u) => (
        <li
          key={u.id}
          className="flex w-[19rem] max-w-full items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2 text-left text-fg"
          data-testid="message-site-upload"
        >
          {/* The sent bubble sets its own text colour: the chip names its colours so it reads on any bubble. */}
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
            <ZipIcon />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-meta font-semibold">{u.name}</span>
            <span className="truncate text-xs text-muted">
              {z.sentSite({ n: u.n, size: formatBytes(u.size) })}
            </span>
          </span>
        </li>
      ))}
      {inputs.map((u) => (
        <li
          key={`input-${u.id}`}
          className="flex w-[19rem] max-w-full items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2 text-left text-fg"
          data-testid="message-input-upload"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
            <ZipIcon />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-meta font-semibold">{u.name}</span>
            <span className="truncate text-xs text-muted">
              {z.sentInput({ n: u.n, size: formatBytes(u.size) })}
            </span>
            {u.secrets ? <span className="truncate text-xs text-warn">{z.sentWithSecrets}</span> : null}
          </span>
        </li>
      ))}
      {archives.map((a, i) => (
        <li
          key={`${a.name}-${String(i)}`}
          className="flex w-[19rem] max-w-full items-center gap-3 rounded-[10px] border border-danger/40 bg-surface px-3 py-2 text-left text-fg"
          data-testid="message-archive"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-danger-soft text-danger">
            <ZipIcon />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-meta font-semibold">{a.name}</span>
            <span className="truncate text-xs text-danger">{z.sentNotSite}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
