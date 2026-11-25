import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../api/client';
import { cleanupWorkfiles, listWorkfiles, type WorkfilesView } from '../../api/workfiles';
import { toApiError } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyConfirm } from '../common/actions';
import { DyApiError } from '../screens/kit';
import { Pill, SkeletonRows } from '../screens/parts';
import { WorkfilesPanel } from './WorkfilesPanel';

/**
 * p15-workspace-retention §8: Çıktılar → "Makinelerde tutulan çalışma dosyaları" — every kept working directory the
 * reader can see (job, machine, size, expiry, state), totals, a bulk "Temizle" per machine and per project (pinned
 * ones are skipped and said so), and a row opens the job's file tree.
 */
export function WorkfilesOverview(props: { readonly project?: string | undefined }): ReactNode {
  const t = useT().workfiles;
  const fmt = useFormat();
  const sayError = useErrorText();
  const [data, setData] = useState<{
    items: WorkfilesView[];
    totals: { bytes: number; count: number };
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const { project } = props;
  useEffect(() => {
    const ctl = new AbortController();
    listWorkfiles(
      { ...(project === undefined ? {} : { project }), state: 'kept' },
      { signal: ctl.signal },
    ).then(
      (r) => {
        setData({ items: r.items, totals: r.totals });
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(toApiError(err));
      },
    );
    return () => {
      ctl.abort();
    };
  }, [project, reload]);
  if (error !== null) return <DyApiError error={error} />;
  if (data === null) return <SkeletonRows label={t.loading} rows={1} />;
  const machines = [...new Map(data.items.map((i) => [i.workerId, i.workerName ?? i.workerId])).entries()];
  const clean = async (scope: { worker?: string; project?: string }): Promise<void> => {
    try {
      const r = await cleanupWorkfiles(scope);
      setNotice(t.list.cleanDone({ n: r.removed + r.pending, skipped: r.skipped.length }));
      setReload((n) => n + 1);
    } catch (err) {
      setNotice(sayError(err));
    }
  };
  return (
    <details className="rounded-[12px] border border-dy-line bg-dy-card p-3" data-testid="workfiles-overview">
      <summary className="cursor-pointer text-[0.9375rem] font-bold">
        {t.list.title}{' '}
        <span className="font-normal text-dy-muted tabular-nums">
          · {t.list.total({ size: fmt.bytes(data.totals.bytes), n: data.totals.count })}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="m-0 text-[0.84375rem] text-dy-muted">{t.list.sub}</p>
        {data.items.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.list.empty}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {machines.map(([id, name]) => (
                <DyConfirm
                  key={id}
                  label={t.list.cleanMachine({ name })}
                  question={t.actions.cleanConfirm}
                  icon="trash"
                  variant="danger"
                  onConfirm={() => {
                    void clean({ worker: id });
                  }}
                />
              ))}
              {project === undefined ? null : (
                <DyConfirm
                  label={t.list.cleanProject({ name: project })}
                  question={t.actions.cleanConfirm}
                  icon="trash"
                  variant="danger"
                  onConfirm={() => {
                    void clean({ project });
                  }}
                />
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-[0.8125rem]">
                <thead>
                  <tr className="text-dy-muted">
                    <th scope="col" className="py-1 pr-3 font-bold">
                      {t.list.job}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-bold">
                      {t.list.machine}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-bold">
                      {t.list.size}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-bold">
                      {t.list.expires}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-bold">
                      {t.list.state}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((v) => (
                    <tr key={v.attemptId} className="border-t border-dy-line" data-testid="workfiles-row">
                      <td className="py-1.5 pr-3">
                        <button
                          type="button"
                          aria-expanded={openJob === v.jobId}
                          onClick={() => {
                            setOpenJob((cur) => (cur === v.jobId ? null : v.jobId));
                          }}
                          className="text-left text-dy-teal-ink underline"
                        >
                          {v.jobTitle ?? v.jobId.slice(0, 8)}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3">{v.workerName ?? v.workerId}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{fmt.bytes(v.sizeBytes)}</td>
                      <td className="py-1.5 pr-3">{fmt.dateTime(v.pinnedUntil ?? v.expiresAt)}</td>
                      <td className="py-1.5 pr-3">
                        <Pill tone={v.pinnedUntil === null ? 'neutral' : 'amber'}>{t.state[v.state]}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {openJob === null ? null : <WorkfilesPanel key={openJob} jobId={openJob} />}
          </>
        )}
        {notice === null ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted" role="status">
            {notice}
          </p>
        )}
      </div>
    </details>
  );
}
