import type { MasterConfig } from '../config.js';
import { type KeyFileSpec, ROTATION_DAYS } from './expiry.js';

/**
 * p16-ops-safety §1: the master's key files whose age the expiry view tracks (paths from the environment; the files
 * are only `stat`ed, never read) and the public origin whose served certificate is checked.
 */
export function keyFileSpecs(
  c: Pick<
    MasterConfig,
    'totpKeyFile' | 'leaseSigningKeyFile' | 'notifications' | 'skillsPanelKeyFile' | 'sso' | 'gitflow'
  >,
): KeyFileSpec[] {
  return [
    {
      id: 'file:totp-key',
      label: 'totpKey',
      path: c.totpKeyFile,
      rotateEveryDays: ROTATION_DAYS.totpKey,
      runbook: 'docs/ops/deploy-coolify.md#31-files-on-the-host-key-material',
    },
    {
      id: 'file:lease-key',
      label: 'leaseKey',
      path: c.leaseSigningKeyFile,
      rotateEveryDays: ROTATION_DAYS.leaseKey,
      runbook: 'docs/ops/deploy-coolify.md#31-files-on-the-host-key-material',
    },
    {
      id: 'file:webhook-hmac',
      label: 'webhookHmac',
      path: c.notifications.webhook?.secretFile ?? null,
      rotateEveryDays: ROTATION_DAYS.webhookHmac,
      runbook: 'docs/ops/deploy-coolify.md#31-files-on-the-host-key-material',
    },
    {
      id: 'file:skills-panel-key',
      label: 'skillsPanelKey',
      path: c.skillsPanelKeyFile,
      rotateEveryDays: ROTATION_DAYS.skillsPanelKey,
      runbook: 'docs/ops/deploy-coolify.md#31-files-on-the-host-key-material',
    },
    {
      id: 'file:oidc-signing-key',
      label: 'oidcSigningKey',
      path: c.sso.oidc?.signingKeyFile ?? null,
      rotateEveryDays: ROTATION_DAYS.oidcSigningKey,
      runbook: 'docs/ops/coolify-sso.md',
    },
    {
      id: 'file:vapid-key',
      label: 'vapidKey',
      path: c.notifications.push?.vapidKeyFile ?? null,
      rotateEveryDays: ROTATION_DAYS.vapidKey,
      runbook: 'docs/ops/deploy-coolify.md#31-files-on-the-host-key-material',
    },
    {
      id: 'file:github-app-key',
      label: 'githubAppKeyFile',
      path: c.gitflow.github?.privateKeyFile ?? null,
      rotateEveryDays: ROTATION_DAYS.githubAppKey,
      runbook: 'docs/ops/github-app.md#7-alternative-key-file-on-the-master-unchanged',
    },
  ];
}

/** The origin whose certificate is checked: PUBLIC_ORIGIN (installers), else NOTIFY_PUBLIC_URL; https only. */
export function publicOriginOf(c: Pick<MasterConfig, 'installers' | 'notifications'>): string | null {
  const o = c.installers.publicOrigin ?? c.notifications.publicUrl;
  if (o === null) return null;
  try {
    const u = new URL(o);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
