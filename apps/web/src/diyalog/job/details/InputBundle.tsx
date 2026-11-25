import { type ReactNode, useEffect, useId, useState } from 'react';
import { getJobInputUpload, type JobInputUpload } from '../../../api/inputUploads';
import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p16-zip-job-input (ADR-0060): the job page's "Input files from a .zip" — what the job got in in/ (facts stay after the
 * bundle was pruned), whether the machine pulled it, how long it is kept (a follow-up can reuse it), the secret findings
 * the uploader sent anyway (file, rule, line — never a value) and the file list. Nothing renders for a job without one.
 */
export function JobInputBundle(props: { readonly jobId: string }): ReactNode {
  const t = useT().jobDetail.inputBundle;
  const fmt = useFormat();
  const sayError = useErrorText();
  const [data, setData] = useState<JobInputUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => {
    const ctl = new AbortController();
    getJobInputUpload(props.jobId, { signal: ctl.signal }).then(
      (v) => {
        setData(v);
        setError(null);
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(sayError(err));
      },
    );
    return () => {
      ctl.abort();
    };
  }, [props.jobId, sayError]);

  if (error !== null) {
    return (
      <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
        {t.loadError({ error })}
      </p>
    );
  }
  if (data === null) return null;
  const files = data.upload?.files ?? [];
  const findings = data.upload?.secretFindings ?? [];
  return (
    <section
      aria-label={t.title}
      className="grid gap-1.5 rounded-[11px] border border-dy-line px-3 py-2 text-[0.8125rem]"
      data-testid="dy-job-input-bundle"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{t.title}</h3>
      <p className="m-0 text-dy-ink">
        {t.facts({
          name: data.label ?? data.sourceId.slice(0, 8),
          n: data.fileCount,
          size: fmt.bytes(data.totalBytes),
        })}
      </p>
      <p className="m-0 text-dy-muted">
        {data.pulledAt === null ? t.notPulled : t.pulled({ when: fmt.dateTime(data.pulledAt) })}
      </p>
      <p className="m-0 text-dy-muted" data-testid="dy-job-input-kept">
        {data.kept && data.upload?.keptUntil != null
          ? t.keptUntil({ when: fmt.dateTime(data.upload.keptUntil) })
          : t.notKept}
      </p>
      {findings.length > 0 ? (
        <div className="text-dy-amber-ink">
          <p className="m-0">{t.withSecrets({ n: findings.length })}</p>
          <ul className="m-0 list-none p-0 font-dy-mono text-[0.75rem]">
            {findings.slice(0, 20).map((f) => (
              <li key={`${f.path}:${String(f.line)}:${f.rule}`} className="break-all">
                {f.path}:{String(f.line)} ({f.rule})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {files.length > 0 ? (
        <>
          <button
            type="button"
            className="justify-self-start text-[0.8125rem] text-dy-teal-ink hover:underline"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? t.hideFiles : t.showFiles({ n: files.length })}
          </button>
          {open ? (
            <ul
              id={listId}
              className="m-0 max-h-60 list-none overflow-auto rounded-[9px] border border-dy-line p-2 font-dy-mono text-[0.75rem]"
            >
              {files.slice(0, 500).map((f) => (
                <li key={f.path} className="flex justify-between gap-2">
                  <span className="break-all">{f.path}</span>
                  <span className="shrink-0 text-dy-muted tabular-nums">{fmt.bytes(f.size)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
