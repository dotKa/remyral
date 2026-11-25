import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../../../api/client';
import type { Project } from '../../../../api/directory';
import type { InstantiateResult } from '../../../../api/workflowTemplates';
import { useErrorText } from '../../../../i18n/errors';
import { useT } from '../../../../i18n/I18nProvider';
import { ProjectChecks } from '../../../common/ProjectChecks';
import { DyButtonLink, Panel, Row, Rows } from '../../parts';

/**
 * p18-multi-project W4 (docs/design/p18-multi-project.md §2.5): a workflow template's "Kullan" also adds the new
 * workflow to other projects — the owner project's admin offers it, each project's admin attaches it (an attachment
 * with credential slots stays off until they are bound there). Only projects the user administers are offered here;
 * the master checks each one again and lists the refused ones.
 */

const ADMIN = new Set(['admin', 'owner']);

export function AttachTargets(props: {
  readonly projects: readonly Project[] | null;
  readonly owner: string;
  readonly chosen: readonly string[];
  readonly onChange: (next: string[]) => void;
}): ReactNode {
  const t = useT().multiProject.wfTemplate;
  const all = props.projects ?? [];
  const owner = all.find((p) => p.id === props.owner);
  // Offering needs the owner project's admin; attaching each target's admin.
  if (owner === undefined || !ADMIN.has(owner.myRole)) return null;
  const targets = all.filter((p) => p.id !== props.owner && ADMIN.has(p.myRole));
  if (targets.length === 0) return null;
  return (
    <ProjectChecks
      legend={t.attach}
      hint={t.attachHint}
      empty=""
      projects={targets}
      chosen={props.chosen.filter((p) => p !== props.owner)}
      onChange={props.onChange}
      max={20}
      testId="wizard-attach-targets"
    />
  );
}

export function AttachResult(props: { readonly result: InstantiateResult }): ReactNode {
  const t = useT().multiProject.wfTemplate;
  const say = useErrorText();
  const { result } = props;
  const wf = `/workflows/${encodeURIComponent(result.id)}`;
  return (
    <div className="grid gap-4" data-testid="wizard-attach-result">
      <Panel title={t.resultTitle} flush>
        <Rows label={t.resultTitle}>
          {result.attached.map((a) => (
            <Row
              key={a.project}
              testId="wizard-attached"
              tone={a.state === 'enabled' ? 'green' : 'amber'}
              title={
                a.state === 'enabled'
                  ? t.attached({ project: a.project })
                  : t.attachedDisabled({ project: a.project })
              }
              actions={
                <Link
                  to={`${wf}?project=${encodeURIComponent(a.project)}`}
                  className="text-[0.8125rem] font-bold text-dy-teal-ink no-underline hover:underline"
                >
                  {t.settings}
                </Link>
              }
            />
          ))}
          {result.refused.map((r) => (
            <Row
              key={r.project}
              testId="wizard-attach-refused"
              tone="amber"
              title={t.refused({ project: r.project })}
              meta={
                <span className="[overflow-wrap:anywhere]">{say(new ApiError(400, r.code, r.message))}</span>
              }
            />
          ))}
        </Rows>
      </Panel>
      <div>
        <DyButtonLink to={wf} variant="primary">
          {t.open}
        </DyButtonLink>
      </div>
    </div>
  );
}
