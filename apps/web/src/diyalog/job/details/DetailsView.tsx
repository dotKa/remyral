import { type ReactNode, useCallback } from 'react';
import type { ApprovalModeChange } from '../../../api/approvalMode';
import type { JobDetail } from '../../../api/jobs';
import { useJobChanges } from '../../../screens/jobChanges';
import { type Live, useLiveArtifacts } from '../../../screens/live/liveJob';
import { SegTabs } from '../../screens/ScreenFrame';
import { RepoChanges, RunArtifacts } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { RepoJobInputs } from './RepoInputs';
import { WorkfilesPanel } from '../../workfiles/WorkfilesPanel';
import { JobInputBundle } from './InputBundle';
import { HistoryTab } from './HistoryTab';
import { LogsTab } from './LogsTab';
import { McpTab } from './McpTab';
import { useT } from '../../../i18n/I18nProvider';
import { ApprovalsTab, RecordTab } from './RecordTab';

/**
 * p12-diyalog-w1: the job control panel's "Ayrıntılar" (`?view=details`, docs/design/p12-diyalog.md §14), natively in
 * the Diyalog language — it replaced the classic Changes / Logs / Details / Approvals tabs that sat here in a classic
 * frame. URL tabs (`&tab=`, the classic ids kept: `files`, `logs`, `details`, `approvals`; new `history`):
 *   Değişiklikler / Dosyalar  repository changes + merge actions, or the workspace's files; the run's artifacts + diff
 *   Loglar                    the live output (search, stream, follow, wrap, timestamps, copy, terminal)
 *   Geçmiş                    state history with technical details and folded loops, pause, approval-mode changes
 *   Kayıt                     record, attempts, leases, specification
 *   Onaylar                   the job's approvals (count of pending ones on the tab)
 * The page's one live stream feeds the tabs (switching never reopens it).
 */
export function DetailsView(props: {
  readonly detail: JobDetail;
  readonly state: string;
  readonly live: Live;
  readonly names: ReadonlyMap<string, string>;
  readonly canAct: boolean;
  readonly modeChanges: readonly ApprovalModeChange[];
  readonly reload: () => void;
}): ReactNode {
  const { detail, state, live, reload } = props;
  const j = detail.job;
  const isRepo = j.projectKind !== 'workspace';
  // p22-output-delivery: a repository job that delivers its files to Outputs shows them like a workspace job's.
  const delivers = isRepo && j.spec.delivery === 'outputs';
  const changes = useJobChanges(j.id, state, isRepo);
  const artifacts = useLiveArtifacts(live);
  const t = useT();
  const d = t.jobDetail.view;
  const mcpTab = t.mcp.job.tab;
  const onRequested = useCallback(() => {
    reload();
  }, [reload]);
  const tabs = [
    { id: 'files', label: isRepo ? d.tabs.changes : d.tabs.files },
    { id: 'logs', label: d.tabs.logs },
    { id: 'history', label: d.tabs.history },
    { id: 'details', label: d.tabs.record },
    {
      id: 'approvals',
      label: d.tabs.approvals,
      count: detail.approvals.filter((a) => a.status === 'pending').length,
    },
    // p14-mcp-core: the job's pinned MCP servers and tool calls (metadata only).
    { id: 'mcp', label: mcpTab },
  ];
  return (
    <section aria-label={d.label} className="min-w-0" data-testid="dy-job-details">
      <SegTabs label={d.label} items={tabs}>
        {(tab) =>
          tab === 'logs' ? (
            <LogsTab jobId={j.id} live={live} />
          ) : tab === 'history' ? (
            <HistoryTab detail={detail} names={props.names} modeChanges={props.modeChanges} />
          ) : tab === 'details' ? (
            <RecordTab detail={detail} names={props.names} />
          ) : tab === 'approvals' ? (
            <ApprovalsTab detail={detail} />
          ) : tab === 'mcp' ? (
            <McpTab jobId={j.id} />
          ) : (
            <div className="grid max-w-[1000px] gap-6">
              {/* p16-zip-job-input: the input files the job got from a .zip (repository and workspace jobs). */}
              <JobInputBundle jobId={j.id} />
              {/* p19-repo-job-inputs: chat attachments / earlier outputs a repository job got (never committed). */}
              {isRepo ? <RepoJobInputs jobId={j.id} /> : null}
              {delivers ? (
                <>
                  <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="dy-job-delivers-outputs">
                    {t.outputDelivery.job.delivered}
                  </p>
                  <FilesTab jobId={j.id} project={j.project} jobState={state} />
                </>
              ) : null}
              {isRepo ? (
                <RepoChanges
                  changes={changes}
                  jobState={state}
                  canAct={props.canAct}
                  onRequested={onRequested}
                  review={{ jobId: j.id, project: j.project }}
                />
              ) : (
                <>
                  <FilesTab jobId={j.id} project={j.project} jobState={state} />
                  {/* p15-workspace-retention: the whole working directory kept on the machine. */}
                  <WorkfilesPanel jobId={j.id} canManage={props.canAct} />
                </>
              )}
              <RunArtifacts jobId={j.id} artifacts={artifacts} />
            </div>
          )
        }
      </SegTabs>
    </section>
  );
}
