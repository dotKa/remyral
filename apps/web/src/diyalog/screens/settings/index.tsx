import { Fragment, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { GITHUB_CALLBACK_PATH, GITHUB_INSTALLED_PATH } from '../../../screens/integrationsPaths';
import { SETTINGS_HOME } from '../../../shell/settingsHome';
import { lazyScreen } from '../../../lib/lazyScreen';

const ContextView = lazyScreen(() => import('../knowledge/ContextView'), 'ContextView');
const BackupsView = lazyScreen(() => import('./BackupsView'), 'BackupsView');
const ChatView = lazyScreen(() => import('./ChatView'), 'ChatView');
const CredentialsView = lazyScreen(() => import('./CredentialsView'), 'CredentialsView');
const DevicesView = lazyScreen(() => import('./DevicesView'), 'DevicesView');
const NotificationsView = lazyScreen(() => import('./NotificationsView'), 'NotificationsView');
const GitHubCallbackScreen = lazyScreen(() => import('./integrations-github'), 'GitHubCallbackScreen');
const GitHubInstalledScreen = lazyScreen(() => import('./integrations-github'), 'GitHubInstalledScreen');
const IntegrationsView = lazyScreen(() => import('./IntegrationsView'), 'IntegrationsView');
const ModelsView = lazyScreen(() => import('./ModelsView'), 'ModelsView');
const ProfileView = lazyScreen(() => import('./ProfileView'), 'ProfileView');
const ReleasesView = lazyScreen(() => import('./ReleasesView'), 'ReleasesView');
const RuntimesView = lazyScreen(() => import('./RuntimesView'), 'RuntimesView');
const SettingsFrame = lazyScreen(() => import('./SettingsFrame'), 'SettingsFrame');
const UsersView = lazyScreen(() => import('./UsersView'), 'UsersView');
const SecurityView = lazyScreen(() => import('./SecurityView'), 'SecurityView');
const WorkfilesView = lazyScreen(() => import('./WorkfilesView'), 'WorkfilesView');
// p16-api-tokens: personal API tokens, service accounts, the API description.
const ApiTokensView = lazyScreen(() => import('./ApiTokensView'), 'ApiTokensView');
const ServiceAccountsView = lazyScreen(() => import('./ServiceAccountsView'), 'ServiceAccountsView');
const ApiDocsView = lazyScreen(() => import('./ApiDocsView'), 'ApiDocsView');
// p16-ops-safety: keys and expiry, the cost brake, request limits, the rollout breaker.
const OpsSafetyView = lazyScreen(() => import('./OpsSafetyView'), 'OpsSafetyView');
// p16-observability: Sistem durumu (status, logs, traces).
const SystemView = lazyScreen(() => import('./SystemView'), 'SystemView');
// p16-webhooks-out: outgoing webhooks.
const WebhooksView = lazyScreen(() => import('./WebhooksView'), 'WebhooksView');
// p16-doctor: Tanılama (doctor, machine doctors, support report).
const DiagnosticsView = lazyScreen(() => import('./DiagnosticsView'), 'DiagnosticsView');
// p17-panel-settings: settings that used to be environment variables, key rotation, maintenance jobs.
const ServerSettingsView = lazyScreen(() => import('./ServerSettingsView'), 'ServerSettingsView');
// p19-ide W3: Geliştirme ortamı — the IDE extension allowlist and policy.
const IdeExtensionsView = lazyScreen(() => import('./IdeExtensionsView'), 'IdeExtensionsView');

/**
 * p12-diyalog Faz 4 + wave 2 (W3) — Ayarlar (`/settings/*`, docs/design/p12-diyalog.md §12). Every settings section
 * is a Diyalog page inside the Diyalog settings frame. The GitHub App callback / installed flows are native screens
 * of their own. Unknown sub-pages return null: the shell shows "Sayfa bulunamadı".
 */

const DIYALOG: Readonly<Record<string, () => ReactNode>> = {
  '/settings/credentials': () => <CredentialsView />,
  '/settings/profile': () => <ProfileView />,
  // p15-autonomy (ADR-0056).
  '/settings/security': () => <SecurityView />,
  // p16-ops-safety.
  '/settings/ops-safety': () => <OpsSafetyView />,
  '/settings/users': () => <UsersView />,
  '/settings/devices': () => <DevicesView />,
  '/settings/chat': () => <ChatView />,
  '/settings/notifications': () => <NotificationsView />,
  '/settings/runtimes': () => <RuntimesView />,
  '/settings/models': () => <ModelsView />,
  '/settings/context': () => <ContextView />,
  '/settings/integrations': () => <IntegrationsView />,
  '/settings/backups': () => <BackupsView />,
  // p15-workspace-retention: kept working directories of repository-less jobs.
  '/settings/workfiles': () => <WorkfilesView />,
  '/settings/releases': () => <ReleasesView />,
  // p16-api-tokens (ADR-0058).
  '/settings/api-tokens': () => <ApiTokensView />,
  '/settings/service-accounts': () => <ServiceAccountsView />,
  '/settings/api': () => <ApiDocsView />,
  // p16-observability.
  '/settings/system': () => <SystemView />,
  // p16-webhooks-out (ADR-0059).
  '/settings/webhooks': () => <WebhooksView />,
  // p16-doctor (ADR-0062).
  '/settings/diagnostics': () => <DiagnosticsView />,
  // p17-panel-settings.
  '/settings/server-settings': () => <ServerSettingsView />,
  // p19-ide W3.
  '/settings/ide-extensions': () => <IdeExtensionsView />,
};

export function matchSettings(pathname: string): ReactNode | null {
  if (pathname === '/settings') return <Navigate to={SETTINGS_HOME} replace />;
  // p12-diyalog wave 2 (W3): GitHub's redirect pages, native (their own frame, not the settings navigation).
  if (pathname === GITHUB_CALLBACK_PATH) return <GitHubCallbackScreen />;
  if (pathname === GITHUB_INSTALLED_PATH) return <GitHubInstalledScreen />;
  const own = DIYALOG[pathname];
  if (own !== undefined)
    return (
      <SettingsFrame path={pathname}>
        <Fragment key={pathname}>{own()}</Fragment>
      </SettingsFrame>
    );
  return null;
}
