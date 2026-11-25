export interface SettingsItem {
  readonly path: string;
  readonly label: string;
  /** Owner/admin only (the page's API refuses everyone else). */
  readonly admin?: boolean;
}

export interface SettingsGroup {
  readonly label: string;
  readonly items: readonly SettingsItem[];
}

/**
 * p6-ui-refactor §4 Settings: Account · Agents · Workspace, every section its own URL, no placeholder pages.
 * The default page is Profile & security.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: 'Account',
    items: [
      { path: '/settings/profile', label: 'Profile & security' },
      // p15-autonomy (ADR-0056): the security policy (owners / admins).
      { path: '/settings/security', label: 'Security', admin: true },
      // p16-ops-safety: keys and expiry, the cost brake, request limits, the rollout breaker (owners / admins).
      { path: '/settings/ops-safety', label: 'Operations safety', admin: true },
      { path: '/settings/devices', label: 'Devices' },
      // p16-api-tokens: personal API tokens (every role; the security policy may switch them off).
      { path: '/settings/api-tokens', label: 'API tokens' },
    ],
  },
  {
    label: 'Agents',
    items: [
      { path: '/settings/runtimes', label: 'Runtimes', admin: true },
      { path: '/settings/models', label: 'Models' },
      { path: '/settings/credentials', label: 'Credentials', admin: true },
      { path: '/settings/integrations', label: 'Integrations', admin: true },
      // p10-semantic-defaults-chat: everyone has "My conversations"; the assistant settings stay admin-only.
      { path: '/settings/chat', label: 'Chat' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { path: '/settings/users', label: 'Users', admin: true },
      // p16-api-tokens: service accounts and every personal token (owners / admins).
      { path: '/settings/service-accounts', label: 'Service accounts', admin: true },
      // p16-webhooks-out: outgoing webhooks for external automation (owners / admins).
      { path: '/settings/webhooks', label: 'Webhooks', admin: true },
      { path: '/settings/releases', label: 'Worker releases', admin: true },
      { path: '/settings/backups', label: 'Backups', admin: true },
      // p16-observability: system status, log search, recent traces (owners / admins).
      { path: '/settings/system', label: 'System status', admin: true },
      // p16-doctor: diagnostics and the support report (owners / admins).
      { path: '/settings/diagnostics', label: 'Diagnostics', admin: true },
      // p17-panel-settings: settings that used to be environment variables, key rotation, maintenance (owners / admins).
      { path: '/settings/server-settings', label: 'Server settings', admin: true },
      { path: '/settings/workfiles', label: 'Working files', admin: true },
      // p19-ide W3: the IDE extension allowlist (owners / admins).
      { path: '/settings/ide-extensions', label: 'Development environment', admin: true },
      { path: '/settings/context', label: 'Context' },
      { path: '/settings/notifications', label: 'Notifications' },
      // p16-api-tokens: the public API description (OpenAPI).
      { path: '/settings/api', label: 'API' },
    ],
  },
];
