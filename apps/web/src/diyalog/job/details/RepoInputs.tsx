import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { saveWithLink } from '../../../api/download';
import { fetchInput, type JobInput, listJobArtifacts } from '../../../api/workspaces';
import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md): the job page's input files of a REPOSITORY job — chat
 * attachments and earlier outputs the job got in a read-only scratch in/ next to its checkout (never committed). Each
 * with its size, where it came from and İndir. Nothing renders for a job without input files.
 */
export function RepoJobInputs(props: { readonly jobId: string }): ReactNode {
  const t = useT().jobDetail.repoInputs;
  const fmt = useFormat();
  const sayError = useErrorText();
  const [inputs, setInputs] = useState<readonly JobInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    listJobArtifacts(props.jobId, { limit: 1, signal: ctl.signal }).then(
      (v) => {
        setInputs(v.inputs);
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

  async function download(i: JobInput): Promise<void> {
    setBusy(i.id);
    try {
      const got = await fetchInput(props.jobId, i.id);
      saveWithLink(got.blob, got.filename ?? i.name);
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(null);
    }
  }

  if (error !== null) {
    return (
      <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
        {t.loadError({ error })}
      </p>
    );
  }
  if (inputs === null || inputs.length === 0) return null;
  return (
    <section
      aria-label={t.title}
      className="grid gap-1.5 rounded-[11px] border border-dy-line px-3 py-2 text-[0.8125rem]"
      data-testid="dy-job-repo-inputs"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{`${t.title} (${String(inputs.length)})`}</h3>
      <p className="m-0 text-dy-muted">{t.note}</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {inputs.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2" data-testid="dy-repo-input">
            <span className="min-w-0 flex-1 font-dy-mono break-all">{`in/${i.name}`}</span>
            <span className="text-dy-muted tabular-nums">{fmt.bytes(i.sizeBytes)}</span>
            {i.sourceJobId !== null ? (
              <Link
                to={`/jobs/${encodeURIComponent(i.sourceJobId)}`}
                className="font-dy-mono text-dy-teal-ink"
              >
                {t.fromJob({ id: i.sourceJobId.slice(0, 8) })}
              </Link>
            ) : (
              <span className="text-dy-muted">{t.uploaded}</span>
            )}
            {i.prunedReason !== null ? (
              <span className="text-dy-muted">{t.pruned}</span>
            ) : (
              <button
                type="button"
                className="text-dy-teal-ink hover:underline disabled:opacity-60"
                aria-label={t.downloadInput({ name: i.name })}
                disabled={busy === i.id}
                onClick={() => void download(i)}
              >
                {t.download}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
