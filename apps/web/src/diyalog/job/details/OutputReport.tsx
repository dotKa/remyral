import type { ReactNode } from 'react';
import { deliveredOf, type OutputReport, skippedByCode } from '../../../api/workspaces';
import { useT } from '../../../i18n/I18nProvider';
import { DyNotice } from '../../common/notices';
import { downloadAllFiles } from './FullZip';

/**
 * p17-output-limits (docs/design/p17-output-limits.md §5): nothing about a job's files is silent — the overflow zip
 * ("N dosya zip olarak paketlendi") and the files not returned ("N dosya alınmadı: sebep", grouped by reason) on the
 * job's Dosyalar tab and, compact, in the chat's job card. Names are the agent's (untrusted): shown as text only.
 *
 * p18-outputs-delivery: a zipped delivery is said in full ("600 dosya üretildi: 499’u tek tek, 101’i out-rest.zip
 * içinde (iş başına 500 dosya sınırı).") with "Tümünü tek zip olarak indir." when the job is known (`jobId`).
 */
export function OutputReportNotices(props: {
  readonly report: OutputReport | null;
  /** The chat card: one line each, no file names. */
  readonly compact?: boolean;
  /** p18-outputs-delivery: the job, for "Tümünü tek zip olarak indir." (absent: no link). */
  readonly jobId?: string;
}): ReactNode {
  const t = useT().jobDetail.files.report;
  const r = props.report;
  if (r === null) return null;
  const delivered = deliveredOf(r);
  const zipLine =
    r.zip === null
      ? null
      : delivered === null
        ? t.zipped({ n: r.zip.files, name: r.zip.name })
        : t.delivered(delivered);
  const jobId = props.jobId;
  const downloadAll =
    jobId === undefined || r.zip === null ? null : (
      <button
        type="button"
        className="dy-press cursor-pointer border-0 bg-transparent p-0 font-bold text-dy-teal-ink underline underline-offset-2"
        onClick={() => {
          downloadAllFiles(jobId);
        }}
        data-testid="output-report-download-all"
      >
        {t.downloadAllOne}
      </button>
    );
  const groups = skippedByCode(r);
  const listed = groups.reduce((n, g) => n + g.count, 0);
  const unlisted = Math.max(0, r.skippedCount - listed);
  const compact = props.compact === true;
  if (r.zip === null && r.skippedCount === 0 && (compact || r.storage !== false)) return null;
  if (compact) {
    return (
      <div className="grid gap-0.5 text-[0.8125rem]" data-testid="job-result-output-report">
        {zipLine === null ? null : (
          <p className="m-0 text-dy-ink" data-testid="output-report-zipped">
            {zipLine}
            {downloadAll === null ? null : <> {downloadAll}</>}
          </p>
        )}
        {r.skippedCount === 0 ? null : (
          <p className="m-0 text-dy-amber-ink" data-testid="output-report-skipped">
            {groups.length === 1 && unlisted === 0 && groups[0] !== undefined
              ? t.skipped({ n: r.skippedCount, reason: t.reasons[groups[0].code] })
              : t.skippedMore({ n: r.skippedCount })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-2" data-testid="output-report">
      {zipLine === null ? null : (
        <DyNotice tone="teal" icon="folder" testId="output-report-zipped" action={downloadAll ?? undefined}>
          <p className="m-0 font-bold">{zipLine}</p>
          <p className="m-0 text-[0.8125rem]">{t.zippedHint}</p>
        </DyNotice>
      )}
      {r.skippedCount === 0 ? null : (
        <DyNotice tone="amber" icon="warn" testId="output-report-skipped">
          <ul className="m-0 grid list-none gap-1 p-0">
            {groups.map((g) => (
              <li key={g.code} data-testid="output-report-group" data-code={g.code}>
                <span className="font-bold">{t.skipped({ n: g.count, reason: t.reasons[g.code] })}</span>
                <details className="text-[0.8125rem]">
                  <summary className="cursor-pointer text-dy-muted">{t.details}</summary>
                  <ul className="m-0 mt-1 grid list-none gap-0.5 p-0">
                    {g.names.map((n, i) => (
                      <li key={`${n}-${String(i)}`} className="font-dy-mono break-all">
                        {n}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
            {unlisted === 0 ? null : <li>{t.skippedMore({ n: unlisted })}</li>}
          </ul>
        </DyNotice>
      )}
      {r.storage === false ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="output-report-no-storage">
          {t.noStorage}
        </p>
      ) : null}
      {r.maxFiles === null || r.returned === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="output-report-limit">
          {t.limit({ returned: r.returned, max: r.maxFiles })}
        </p>
      )}
    </div>
  );
}
