import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Automation } from '../../../api/automations';
import { useT } from '../../../i18n/I18nProvider';
import { DyNotice } from '../kit';
import { DyButtonLink, Pill } from '../parts';

/**
 * p14-workflow-engine 14.2 (K2, design §3.1): an automation created by "Etkinleştir" for a workflow's trigger node —
 * shown as "workflow'a bağlı" in the Otomasyonlar screens; its trigger and target are changed on the canvas (the
 * master answers 409 `automation_bound` to edits and deletes here), so the edit link goes to the workflow.
 */

export function canvasHref(a: Pick<Automation, 'workflowBinding'>): string | null {
  const b = a.workflowBinding;
  return b === null || b.workflowId === '' ? null : `/workflows/${encodeURIComponent(b.workflowId)}`;
}

export function BindingPill(props: { readonly automation: Automation }): ReactNode {
  const t = useT().workflows.binding;
  if (props.automation.workflowBinding === null) return null;
  return (
    <span data-testid="automation-bound">
      <Pill tone="violet" icon="branch">
        {t.badge}
      </Pill>
    </span>
  );
}

/** The detail's notice and the canvas link instead of "Düzenle". */
export function BindingNotice(props: { readonly automation: Automation }): ReactNode {
  const t = useT().workflows.binding;
  const b = props.automation.workflowBinding;
  const href = canvasHref(props.automation);
  if (b === null) return null;
  return (
    <DyNotice
      tone="neutral"
      className="mb-4"
      testId="automation-binding"
      action={
        href === null ? undefined : (
          <Link to={href} className="text-dy-teal-ink">
            {t.open}
          </Link>
        )
      }
    >
      {t.note({ name: b.name, node: b.triggerNode })}
    </DyNotice>
  );
}

export function BindingEditLink(props: { readonly automation: Automation }): ReactNode {
  const t = useT().workflows.binding;
  const href = canvasHref(props.automation);
  if (href === null) return null;
  return (
    <span data-testid="automation-open-canvas">
      <DyButtonLink to={href} icon="pen">
        {t.open}
      </DyButtonLink>
    </span>
  );
}
