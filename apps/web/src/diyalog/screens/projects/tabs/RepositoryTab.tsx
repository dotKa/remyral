import type { ReactNode } from 'react';
import type { Project } from '../../../../api/directory';
import { ProjectGitIdentityPanel } from '../../shared/GitIdentity';
import { DyFormScope } from '../../../formkit';
import { useT } from '../../../../i18n/I18nProvider';
import { RepoCredentialPanel } from './repo-credential';
import { IntegrationPanel, RepositoryPanel, WorkspacePanel } from './repo-sections';

/**
 * Projeler → Depo (or Çalışma alanı for workspace projects) in the Diyalog language (p12-diyalog wave 2, W3):
 * repository, git identity, integration pipeline — or the workspace's network access and storage. p15-form-pattern: the
 * tab is one form (docs/design/p15-form-pattern.md): every card's open edits are saved by the tab's sticky bar.
 */
export function RepositoryTab(props: { readonly project: Project; readonly canEdit: boolean }): ReactNode {
  const { project, canEdit } = props;
  const tabs = useT().projects.screen.tabs;
  return project.kind === 'workspace' ? (
    <DyFormScope label={tabs.workspace} readOnly={!canEdit}>
      <WorkspacePanel project={project.id} canEdit={canEdit} />
    </DyFormScope>
  ) : (
    <DyFormScope label={tabs.repository} readOnly={!canEdit}>
      <RepositoryPanel project={project.id} canEdit={canEdit} />
      <ProjectGitIdentityPanel project={project.id} canEdit={canEdit} />
      {/* p15-git-central: a deploy key / HTTPS token for a non-GitHub or SSH repository. */}
      <RepoCredentialPanel project={project.id} canEdit={canEdit} />
      <IntegrationPanel project={project.id} canEdit={canEdit} />
    </DyFormScope>
  );
}
