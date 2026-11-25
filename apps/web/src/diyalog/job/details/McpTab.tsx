import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { getJobMcp, type JobMcp } from '../../../api/mcp';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DyApiError } from '../../common/notices';
import { EmptyLine, Pill, Row, Rows, SkeletonRows } from '../../screens/parts';
import { SectionHead } from './bits';

/**
 * p14-mcp-core (ADR-0054, docs/design/p14-mcp-skills.md §2.9, §5.5): the job's "MCP" tab — the servers pinned for it
 * (version, spec digest, hosts added to this job's connection only), why it got none (project switch off, untrusted
 * source) and its tool calls as metadata only (name, decision, outcome, duration, sizes; never arguments or results).
 */
export function McpTab(props: { readonly jobId: string }): ReactNode {
  const t = useT().mcp.job;
  const tt = useT().mcp.transport;
  const fmt = useFormat();
  const [data, setData] = useState<JobMcp | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { jobId } = props;
  useEffect(() => {
    const ac = new AbortController();
    getJobMcp(jobId, { signal: ac.signal }).then(setData, (err: unknown) => {
      if (!ac.signal.aborted) setError(toApiError(err));
    });
    return () => {
      ac.abort();
    };
  }, [jobId]);

  if (data === null)
    return (
      <div className="grid max-w-[1000px] gap-4" data-testid="dy-job-mcp">
        <DyApiError error={error} />
        {error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      </div>
    );
  const hosts = [...new Set(data.servers.flatMap((s) => s.egressHosts))].sort();
  const skipped =
    data.skipped === null
      ? null
      : data.skipped === 'project_switch_off' || data.skipped === 'untrusted_source'
        ? t.skipped[data.skipped]
        : t.skipped.other({ reason: data.skipped });
  return (
    <div className="grid max-w-[1000px] gap-6" data-testid="dy-job-mcp">
      <section aria-labelledby="dy-mcp-h">
        <SectionHead id="dy-mcp-h">{t.title}</SectionHead>
        {skipped !== null ? (
          <p className="m-0 text-[0.875rem]" data-testid="job-mcp-skipped">
            {skipped}
          </p>
        ) : data.setHash === null ? (
          <EmptyLine>{t.notIssued}</EmptyLine>
        ) : data.servers.length === 0 ? (
          <EmptyLine testId="job-mcp-none">{t.none}</EmptyLine>
        ) : (
          <>
            <p className="m-0 mb-2 font-dy-mono text-[0.78125rem] text-dy-muted">
              {t.setHash({ hash: data.setHash.slice(0, 19) })}
            </p>
            <Rows label={t.serversLabel} testId="job-mcp-servers">
              {data.servers.map((s) => (
                <Row
                  key={s.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-dy-mono">{s.id}</span>
                      <span className="font-dy-mono">{s.version}</span>
                      <Pill tone="teal">{tt[s.transport]}</Pill>
                    </span>
                  }
                  meta={
                    <>
                      <span className="font-dy-mono [overflow-wrap:anywhere]">{s.url ?? ''}</span>
                      <span className="font-dy-mono">{s.specSha256.slice(0, 12)}</span>
                    </>
                  }
                />
              ))}
            </Rows>
          </>
        )}
      </section>
      {hosts.length === 0 ? null : (
        <section aria-labelledby="dy-mcp-hosts-h">
          <SectionHead id="dy-mcp-hosts-h">{t.hostsTitle}</SectionHead>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-testid="job-mcp-hosts">
            {hosts.map((h) => (
              <li key={h} className="font-dy-mono text-[0.8125rem]">
                {h}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="dy-mcp-calls-h">
        <SectionHead id="dy-mcp-calls-h" count={String(data.calls.length)}>
          {t.callsTitle}
        </SectionHead>
        <p className="m-0 mb-2 text-[0.78125rem] text-dy-muted">{t.callsNote}</p>
        {data.calls.length === 0 ? (
          <EmptyLine>{t.callsNone}</EmptyLine>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[0.8125rem]" data-testid="job-mcp-calls">
              <thead>
                <tr className="border-b border-dy-line text-dy-muted">
                  <th className="py-1.5 pr-3 font-medium">{t.col.at}</th>
                  <th className="py-1.5 pr-3 font-medium">{t.col.tool}</th>
                  <th className="py-1.5 pr-3 font-medium">{t.col.decision}</th>
                  <th className="py-1.5 pr-3 font-medium">{t.col.outcome}</th>
                  <th className="py-1.5 pr-3 font-medium">{t.col.duration}</th>
                  <th className="py-1.5 font-medium">{t.col.size}</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <tr key={`${c.attemptId}:${String(c.seq)}`} className="border-b border-dy-line">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fmt.time(c.at)}</td>
                    <td className="py-1.5 pr-3 font-dy-mono [overflow-wrap:anywhere]">{`${c.server}/${c.tool}`}</td>
                    <td className="py-1.5 pr-3">{t.decisions[c.decision]}</td>
                    <td
                      className={
                        c.outcome === 'ok' ? 'py-1.5 pr-3' : 'py-1.5 pr-3 font-medium text-dy-red-ink'
                      }
                    >
                      {t.outcomes[c.outcome]}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{fmt.duration(c.durationMs)}</td>
                    <td className="py-1.5 tabular-nums">{`${fmt.bytes(c.argsBytes)} / ${fmt.bytes(c.resultBytes)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
