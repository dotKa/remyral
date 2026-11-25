import type { ReactNode } from 'react';
import type { Project } from '../../../../api/directory';
import { DyFormScope } from '../../../formkit';
import { RoutingRulesPanel } from '../../shared/RoutingRulesPanel';
import { AccountPolicyPanel } from './policy-accounts';
import { ExecutionPanel, SafeCommandsPanel, SubtasksPanel } from './policy-execution';
import { PackageCachesPanel, RuntimeAdvicePanel, UsageLimitPanel } from './policy-limits';
import { ProjectEgressPanel } from './policy-egress';
import { IdeExtensionsPolicyPanel } from './policy-ide';
import { ProjectEnvPanel } from './policy-env';
import { ProjectMcpPanel } from './policy-mcp';
import { ProjectNetworkPanel } from './policy-network';
import { SkillTrustPanel } from './policy-skills';
import { ApprovalWaitsPanel, OffPeakPanel, QueuePanel } from './policy-waits';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * Projeler → Politika in the Diyalog language (p12-diyalog wave 2, W3), split by p15-form-pattern into three tabs of
 * the project page (docs/design/p15-form-pattern.md §3) — each one form whose sticky bar saves every card of that tab
 * (a card keeps its own requests, client checks and step-up; owners / admins edit, everyone else reads):
 *
 * - **Politika** — what a job may do and who decides: execution policy (+ Full access), safe commands, long approval
 *   waits, sub-jobs, skill signatures, MCP servers (an instant switch), environment variables from vault credentials
 *   (p19-project-env, instant actions), IDE extensions (p19-ide W3).
 * - **Ağ erişimi** — the network a job reaches: repository network access (p14-repo-egress) and the workflow HTTP
 *   allowlist.
 * - **Sınırlar ve yönlendirme** — where and how it runs: routing rules (a resource list), runtime advice, off-peak
 *   window, usage limits, account selection, queue and package caches (an instant switch).
 */
function ReadOnly(props: { readonly canEdit: boolean }): ReactNode {
  const t = useT().projects.policy;
  return props.canEdit ? null : (
    <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="policy-read-only">
      {t.readOnly}
    </p>
  );
}

export function PolicyTab(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  const label = useT().projects.screen.tabs.policy;
  const id = props.project.id;
  const canEdit = props.canEdit;
  return (
    <DyFormScope label={label} readOnly={!canEdit} testId="dy-project-policy">
      <ReadOnly canEdit={canEdit} />
      <ExecutionPanel project={id} canEdit={canEdit} />
      <SafeCommandsPanel project={id} canEdit={canEdit} />
      <ApprovalWaitsPanel project={id} canEdit={canEdit} />
      <SubtasksPanel project={id} canEdit={canEdit} />
      <SkillTrustPanel project={id} canEdit={canEdit} />
      <ProjectMcpPanel project={id} canEdit={canEdit} />
      {/* p19-project-env: vault credentials given to the project's jobs as environment variables. */}
      <ProjectEnvPanel project={id} canEdit={canEdit} />
      {/* p19-ide W3: required / recommended / denied IDE extensions and enforced IDE settings. */}
      <IdeExtensionsPolicyPanel project={id} canEdit={canEdit} />
    </DyFormScope>
  );
}

export function NetworkTab(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  const t = useT().forms.tabs.project;
  const id = props.project.id;
  const canEdit = props.canEdit;
  return (
    <DyFormScope label={t.network} readOnly={!canEdit} testId="dy-project-network">
      <ReadOnly canEdit={canEdit} />
      {props.project.kind === 'workspace' ? null : <ProjectNetworkPanel project={id} canEdit={canEdit} />}
      <ProjectEgressPanel project={id} canEdit={canEdit} />
    </DyFormScope>
  );
}

export function LimitsTab(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  const t = useT().forms.tabs.project;
  const id = props.project.id;
  const canEdit = props.canEdit;
  return (
    <DyFormScope label={t.limits} readOnly={!canEdit} testId="dy-project-limits">
      <ReadOnly canEdit={canEdit} />
      <RoutingRulesPanel project={id} canWrite={canEdit} />
      <RuntimeAdvicePanel project={id} canEdit={canEdit} />
      <OffPeakPanel project={id} canEdit={canEdit} />
      <UsageLimitPanel project={id} canEdit={canEdit} />
      <AccountPolicyPanel project={id} canEdit={canEdit} />
      <QueuePanel project={id} canEdit={canEdit} />
      <PackageCachesPanel project={id} canEdit={canEdit} />
    </DyFormScope>
  );
}
