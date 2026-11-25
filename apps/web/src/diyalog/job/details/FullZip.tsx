import { type ReactNode, useEffect, useId, useState } from 'react';
import { API_PREFIX } from '../../../api/client';
import { startDownload } from '../../../api/storage';
import {
  type ArchiveInfo,
  artifactsZipPath,
  getOutputReport,
  listJobArtifacts,
  type OutputReport,
} from '../../../api/workspaces';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DyButton } from '../../screens/parts';

/**
 * p18-outputs-delivery (docs/design/p18-outputs-delivery.md §1): "Tüm dosyaları indir (zip)" — the job's every file
 * in one archive (the stored files, the overflow zip's files unpacked at their paths, the summary), streamed by the
 * master (`GET /jobs/:id/artifacts/all.zip`) and downloaded by navigation (never read into the page). The figures
 * ("600 dosya · 1,2 MB") come from the listing's `archive`.
 */

/** Starts the full archive's download. */
export function downloadAllFiles(jobId: string): void {
  startDownload(`${API_PREFIX}${artifactsZipPath(jobId)}`);
}

export function FullZipButton(props: {
  readonly jobId: string;
  readonly archive: ArchiveInfo | null;
  readonly testId?: string;
  readonly variant?: 'primary' | 'secondary';
}): ReactNode {
  const t = useT().jobDetail.files;
  const f = useFormat();
  const id = useId();
  const a = props.archive;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <DyButton
        variant={props.variant ?? 'primary'}
        icon="tray"
        title={t.downloadAllFilesHint}
        aria-describedby={a === null ? undefined : id}
        onClick={() => {
          downloadAllFiles(props.jobId);
        }}
        data-testid={props.testId ?? 'dy-files-download-all'}
      >
        {t.downloadAllFiles}
      </DyButton>
      {a === null ? null : (
        <span
          id={id}
          className="text-[0.8125rem] text-dy-muted tabular-nums"
          data-testid="dy-files-archive-figures"
        >
          {t.archiveFigures({ files: a.files, size: f.bytes(a.bytes) })}
        </span>
      )}
    </span>
  );
}

/**
 * The archive figures and the output report of a workspace job (the job page's Çıktılar card, the Outputs screen's
 * job filter). Nothing for other jobs or an older master.
 */
export function useJobArchive(
  jobId: string,
  enabled: boolean,
  refreshKey: string,
): { readonly archive: ArchiveInfo | null; readonly report: OutputReport | null } {
  const [state, setState] = useState<{ archive: ArchiveInfo | null; report: OutputReport | null }>({
    archive: null,
    report: null,
  });
  useEffect(() => {
    if (!enabled || jobId === '') {
      setState({ archive: null, report: null });
      return;
    }
    const ctl = new AbortController();
    const signal = ctl.signal;
    void Promise.allSettled([
      listJobArtifacts(jobId, { limit: 1, signal }),
      getOutputReport(jobId, { signal }),
    ]).then(([l, r]) => {
      if (signal.aborted) return;
      setState({
        archive: l.status === 'fulfilled' ? l.value.archive : null,
        report: r.status === 'fulfilled' ? r.value : null,
      });
    });
    return () => {
      ctl.abort();
    };
  }, [jobId, enabled, refreshKey]);
  return state;
}
