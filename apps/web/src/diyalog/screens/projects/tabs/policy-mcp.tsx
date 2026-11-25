import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getProjectMcp, MCP_ALL_PROJECTS, type ProjectMcp, setProjectMcp } from '../../../../api/mcp';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { RuntimeMark } from '../../../RuntimeMark';
import { DyNotice, DySwitch } from '../../forms';
import { Panel, Row, Rows } from '../../parts';
import { LoadState, SaveResult } from './policy-common';

/**
 * p14-mcp-core (ADR-0054, docs/design/p14-mcp-skills.md §2.1): Projeler → Politika → "MCP sunucuları". The project
 * switch is authoritative and **off by default**: while off, no external MCP server reaches a job of this project,
 * whatever is assigned. Owners / admins flip it with step-up (audited, owners notified on enable); everyone else reads.
 * Lists the servers assigned to this project (or to all projects).
 */
export function ProjectMcpPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const t = useT().mcp;
  const stepUp = useStepUp();
  const loader = useSubmit();
  const saver = useSubmit();
  const { project } = props;
  const [data, setData] = useState<ProjectMcp | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      setData(await getProjectMcp(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = (allowed: boolean): void => {
    setDone(null);
    void saver.run(async () => {
      try {
        const d = await stepUp.run(() => setProjectMcp(project, allowed), t.project.stepUp);
        setData(d);
        setDone(d.allowed ? t.project.savedOn : t.project.savedOff);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  return (
    <Panel title={t.project.title} sub={t.project.sub} testId="project-mcp-panel">
      <div className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={loader.error} what={t.project.loading} onRetry={refresh} />
        {data === null ? null : (
          <>
            <DySwitch
              label={t.project.switchLabel}
              checked={data.allowed}
              disabled={!props.canEdit}
              busy={saver.busy}
              testId="project-mcp-switch"
              hint={data.allowed ? t.project.on : t.project.off}
              onChange={toggle}
            />
            <DyNotice tone="amber">{t.panel.windowsNote}</DyNotice>
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.project.untrustedNote}</p>
            <h4 className="m-0 text-[0.8125rem] font-bold">{t.project.assignmentsTitle}</h4>
            {data.assignments.length === 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="project-mcp-none">
                {t.project.assignmentsNone}
              </p>
            ) : (
              <Rows label={t.project.assignmentsTitle} testId="project-mcp-assignments">
                {data.assignments.map((a) => (
                  <Row
                    key={a.id}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-dy-mono">{a.serverId}</span>
                        <span className="[overflow-wrap:anywhere]">{a.title}</span>
                      </span>
                    }
                    meta={
                      <>
                        <span>{a.project === MCP_ALL_PROJECTS ? t.assign.all : a.project}</span>
                        <span>
                          {a.runtimes === null
                            ? t.assign.runtimesAll
                            : a.runtimes.map((r) => <RuntimeMark key={r} runtime={r} className="mr-2" />)}
                        </span>
                        <span>
                          {a.version === null ? t.assign.latest : t.assign.pinned({ version: a.version })}
                        </span>
                      </>
                    }
                  />
                ))}
              </Rows>
            )}
            <Link to="/skills?tab=mcp" className="text-[0.8125rem] font-medium text-dy-teal-ink">
              {t.project.manage}
            </Link>
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
