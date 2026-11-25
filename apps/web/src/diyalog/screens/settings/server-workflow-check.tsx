import { type ReactNode, useState } from 'react';
import { runWorkflowCheck, type WorkflowCheck } from '../../../api/panelSettings';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyNotice } from '../../common/notices';
import { DyApiError } from '../forms';
import { DyButton, Panel } from '../parts';

/**
 * p17-panel-settings Part 6 (docs/design/p17-panel-settings.md §8): `workflow:normalise-check` from the panel — the
 * read-only dry run whose report the owner reads before moving version-1 workflows to engine 2 (the master also runs
 * it itself before that switch and refuses it while a definition fails).
 */
export function WorkflowCheckPanel(_props: { readonly owner: boolean }): ReactNode {
  const t = useT().panelSettings.workflowCheck;
  const act = useSubmit();
  const [report, setReport] = useState<WorkflowCheck | null>(null);
  return (
    <Panel title={t.title} testId="dy-workflow-check">
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      <p className="m-0 mt-1 text-[0.8125rem]">{t.needCheck}</p>
      <div className="mt-3">
        <DyButton
          busy={act.busy}
          onClick={() => {
            void act.run(async () => {
              setReport(await runWorkflowCheck());
            });
          }}
        >
          {act.busy ? t.running : t.run}
        </DyButton>
      </div>
      <DyApiError error={act.error} className="mt-2" />
      {report === null ? null : (
        <DyNotice
          tone={report.failures.length === 0 ? 'green' : 'red'}
          icon={report.failures.length === 0 ? 'checkc' : 'xc'}
          title={report.failures.length === 0 ? t.ok : t.failed({ n: report.failures.length })}
          testId="dy-workflow-check-report"
          className="mt-3"
        >
          <pre className="m-0 max-h-64 overflow-auto font-dy-mono text-[0.75rem] whitespace-pre-wrap">
            {report.lines.join('\n')}
          </pre>
        </DyNotice>
      )}
    </Panel>
  );
}
