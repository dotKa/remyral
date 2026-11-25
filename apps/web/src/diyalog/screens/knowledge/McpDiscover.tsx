import { type ReactNode, useState } from 'react';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import {
  createMcpPreview,
  MCP_DISCOVERY_SOURCES,
  type McpDiscoverySource,
  type McpPreview,
  type McpSearchOutput,
  type McpSearchResult,
  searchMcpCatalog,
} from '../../../api/mcp';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { DyApiError, DyField, DyNotice } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { McpPreviewConfirm, McpWarningPills } from './McpInstall';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p14-mcp-chat (ADR-0054 P5, docs/design/p14-mcp-skills.md §5.5, §15): Yetenekler → Keşfet for MCP servers. Searches
 * the official MCP Registry, npm and PyPI through the master (registry data only, fixed hosts, untrusted text); an
 * admin's "Kur" makes the same install preview a chat card shows, confirmed with a fresh authenticator code.
 */

function ResultRow(props: {
  readonly r: McpSearchResult;
  readonly admin: boolean;
  readonly busy: boolean;
  readonly onInstall: (r: McpSearchResult) => void;
}): ReactNode {
  const all = useT();
  const t = all.mcp.install.discover;
  const r = props.r;
  return (
    <Row
      testId="mcp-discover-result"
      lead={<DyIcon name="cpu" className="size-4" />}
      title={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-dy-mono [overflow-wrap:anywhere]">{r.name}</span>
          {r.version === null ? null : <span className="font-dy-mono text-[0.8125rem]">{r.version}</span>}
          <Pill tone="neutral">{t.sources[r.source]}</Pill>
          {r.transport === null ? null : <Pill tone="teal">{all.mcp.transport[r.transport]}</Pill>}
        </span>
      }
      meta={
        <>
          <span className="w-full text-dy-muted [overflow-wrap:anywhere]" data-testid="mcp-discover-desc">
            {r.description === '' ? t.noDescription : r.description}
          </span>
          {r.repository === null ? null : (
            <a
              href={r.repository}
              target="_blank"
              rel="noreferrer noopener"
              className="font-dy-mono [overflow-wrap:anywhere]"
            >
              {t.repository}
            </a>
          )}
          {r.downloadsWeekly === null ? null : <span>{t.downloads({ n: r.downloadsWeekly })}</span>}
          {r.warnings.length === 0 ? null : (
            <span className="w-full">
              <McpWarningPills warnings={r.warnings} />
            </span>
          )}
        </>
      }
      actions={
        props.admin && (r.transport !== null || r.source !== 'registry') ? (
          <DyButton
            variant="secondary"
            icon="tray"
            busy={props.busy}
            data-testid="mcp-discover-install"
            onClick={() => {
              props.onInstall(r);
            }}
          >
            {t.install}
          </DyButton>
        ) : undefined
      }
    />
  );
}

export function McpDiscoverPanel(props: {
  readonly admin: boolean;
  readonly projects: readonly Project[];
}): ReactNode {
  const all = useT();
  const t = all.mcp.install.discover;
  const stepUp = useStepUp();
  const [q, setQ] = useState('');
  const [source, setSource] = useState<McpDiscoverySource | ''>('');
  const [data, setData] = useState<McpSearchOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [preview, setPreview] = useState<McpPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);

  function search(): void {
    if (q.trim().length < 2) return;
    setLoading(true);
    setError(null);
    searchMcpCatalog({ q: q.trim(), source }).then(
      (d) => {
        setData(d);
        setLoading(false);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setLoading(false);
      },
    );
  }

  async function install(r: McpSearchResult): Promise<void> {
    const key = `${r.source}:${r.ref}`;
    setInstalling(key);
    setError(null);
    setNotice(null);
    try {
      setPreview(
        await stepUp.run(
          () =>
            createMcpPreview({
              source: r.source,
              ref: r.ref,
              ...(r.version === null ? {} : { version: r.version }),
            }),
          t.stepUpPreview,
        ),
      );
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setInstalling(null);
    }
  }

  const failed = (data?.sources ?? []).filter((s) => s.error !== null);
  return (
    <div className="flex flex-col gap-4" data-testid="mcp-discover">
      {preview === null ? null : (
        <Panel title={all.mcp.install.proposal.title} testId="mcp-discover-preview">
          <McpPreviewConfirm
            preview={preview}
            projects={props.projects}
            onClosed={(m) => {
              setPreview(null);
              setNotice(m);
            }}
          />
        </Panel>
      )}
      <Panel title={t.title} sub={t.sub} testId="mcp-discover-search" flush>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
          role="search"
          className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-end"
        >
          <DyField label={t.searchLabel} value={q} onChange={setQ} wrapClassName="min-w-0 flex-1" />
          <DySelect
            label={t.sourceLabel}
            value={source}
            options={[
              ['', t.allSources] as const,
              ...MCP_DISCOVERY_SOURCES.map((s) => [s, t.sources[s]] as const),
            ]}
            onChange={(v) => {
              setSource(MCP_DISCOVERY_SOURCES.find((s) => s === v) ?? '');
            }}
          />
          <div>
            <DyButton type="submit" icon="search" busy={loading} data-testid="mcp-discover-submit">
              {t.searchButton}
            </DyButton>
          </div>
        </form>
        <p className="m-0 px-4 pb-2 text-[0.78125rem] text-dy-muted">{t.untrusted}</p>
        {failed.map((s) => (
          <DyNotice key={s.source} tone="amber" className="mx-4 mb-2">
            {t.sourceError({ source: t.sources[s.source], message: s.error ?? '' })}
          </DyNotice>
        ))}
        <DyApiError error={error} className="px-4 pb-3" />
        {data === null && loading ? (
          <SkeletonRows label={t.loading} rows={3} />
        ) : data === null ? (
          <EmptyLine testId="mcp-discover-idle">{t.idle}</EmptyLine>
        ) : data.results.length === 0 ? (
          <EmptyLine testId="mcp-discover-empty">{t.empty}</EmptyLine>
        ) : (
          <Rows label={t.resultsLabel} testId="mcp-discover-results">
            {data.results.map((r) => (
              <ResultRow
                key={`${r.source}:${r.ref}`}
                r={r}
                admin={props.admin}
                busy={installing === `${r.source}:${r.ref}`}
                onInstall={(x) => void install(x)}
              />
            ))}
          </Rows>
        )}
      </Panel>
    </div>
  );
}
