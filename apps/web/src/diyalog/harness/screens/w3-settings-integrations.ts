import { SETTINGS_GITHUB } from './settings';
import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Ayarlar → Entegrasyonlar editing panels — the default git identity, the
 * vitrin-web base-branch protection (missing rule), the installation's repositories, AWS Bedrock (saved, in use, last
 * test ok), and a Cloudflare test with preview-tunnel permissions missing (on top of the base `/integrations/ops`).
 * Also used by apps/web/test/diyalog-w3-settings-integrations.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 60 * 60_000;

export const W3_GIT_IDENTITY = {
  identity: { name: 'Remyral Bot', email: 'bot@remyral.example' },
  effective: { identity: { name: 'Remyral Bot', email: 'bot@remyral.example' }, source: 'workspace' },
  updatedAt: iso(12 * DAY),
  updatedBy: null,
};

export const W3_PROTECTION = {
  project: 'vitrin-web',
  provider: 'github',
  branch: 'main',
  state: 'unprotected',
  classic: false,
  rules: [],
  reason: null,
  checkedAt: iso(DAY),
};

export const W3_REPOS = {
  items: [
    {
      installationId: 77,
      account: 'octo-org',
      fullName: 'octo-org/vitrin-web',
      cloneUrl: 'https://github.com/octo-org/vitrin-web.git',
      htmlUrl: 'https://github.com/octo-org/vitrin-web',
      defaultBranch: 'main',
      private: true,
      archived: false,
    },
    {
      installationId: 77,
      account: 'octo-org',
      fullName: 'octo-org/eski-site',
      cloneUrl: 'https://github.com/octo-org/eski-site.git',
      htmlUrl: 'https://github.com/octo-org/eski-site',
      defaultBranch: 'main',
      private: false,
      archived: true,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 100,
  errors: [],
};

export const W3_BEDROCK = {
  integration: {
    settings: { region: 'eu-central-1', model: 'cohere.embed-multilingual-v3' },
    keyIdHint: '7Q2X',
    keyFingerprint: '9a8b7c6d5e4f3a2b',
    usable: true,
    lastTest: {
      ok: true,
      model: 'cohere.embed-multilingual-v3',
      region: 'eu-central-1',
      dims: 1024,
      latencyMs: 182,
    },
    lastTestAt: iso(2 * DAY),
    updatedAt: iso(9 * DAY),
  },
  active: {
    provider: 'bedrock',
    model: 'bedrock:cohere.embed-multilingual-v3',
    region: 'eu-central-1',
    source: 'panel',
    panelInUse: true,
    panelInactiveReason: null,
  },
  env: { searchProvider: 'bedrock', region: 'us-east-1' },
  options: {
    regions: ['us-east-1', 'eu-central-1'],
    models: ['cohere.embed-multilingual-v3', 'cohere.embed-v4:0', 'amazon.titan-embed-text-v2:0'],
    defaultModel: 'cohere.embed-multilingual-v3',
  },
};

/** p17-ui-review: the GitHub tab with three connections (the panel App, a company organisation's App, an env App). */
function app(slug: string, name: string, owner: string, type: string): Record<string, unknown> {
  return {
    ...SETTINGS_GITHUB.app,
    appId: slug === 'remyral-demo' ? '1234' : slug === 'remyral-acme' ? '5678' : '9012',
    slug,
    name,
    owner: { login: owner, type },
    htmlUrl: `https://github.com/apps/${slug}`,
    installUrl: `https://github.com/apps/${slug}/installations/new`,
    settingsUrl: `https://github.com/settings/apps/${slug}`,
  };
}
function inst(id: number, account: string, accepted: boolean, keyRef: string): Record<string, unknown> {
  return {
    installationId: id,
    account,
    accountType: 'Organization',
    repositorySelection: 'all',
    suspended: false,
    htmlUrl: null,
    accepted,
    keyRef,
  };
}
const GITHUB_MULTI = {
  ...SETTINGS_GITHUB,
  maxConnections: 5,
  installations: SETTINGS_GITHUB.installations.map((i) => ({ ...i, accepted: true, keyRef: 'panel' })),
  connections: [
    {
      id: 1,
      keyRef: 'panel',
      label: null,
      source: 'panel',
      readOnly: false,
      appId: '1234',
      app: app('remyral-demo', 'Remyral (octo-org)', 'octo-org', 'User'),
      webhook: true,
      installations: [
        { ...inst(77, 'octo-org', true, 'panel'), accountType: 'User', repositorySelection: 'selected' },
      ],
      projects: [{ project: 'vitrin-web' }],
    },
    {
      id: 2,
      keyRef: 'panel-2',
      label: 'Acme şirketi',
      source: 'panel',
      readOnly: false,
      appId: '5678',
      app: app('remyral-acme', 'Remyral (acme)', 'acme-co', 'Organization'),
      webhook: false,
      installations: [inst(88, 'acme-co', true, 'panel-2'), inst(89, 'acme-labs', false, 'panel-2')],
      projects: [{ project: 'mobil-app' }],
    },
    {
      id: null,
      keyRef: 'ops-bot',
      label: null,
      source: 'env',
      readOnly: true,
      appId: '9012',
      app: null,
      webhook: false,
      installations: [],
      projects: [],
    },
  ],
};

export const ROUTES: ScreenRoutes = {
  '/integrations/github': (_u, method) => (method === 'GET' ? GITHUB_MULTI : undefined),
  '/settings/git-identity': (_u, method) => (method === 'GET' ? W3_GIT_IDENTITY : undefined),
  '/projects/vitrin-web/git/protection': () => W3_PROTECTION,
  '/integrations/github/repositories': () => W3_REPOS,
  '/integrations/bedrock': (_u, method) => (method === 'GET' ? W3_BEDROCK : undefined),
  '/integrations/github/installations/sync': () => SETTINGS_GITHUB,
};
