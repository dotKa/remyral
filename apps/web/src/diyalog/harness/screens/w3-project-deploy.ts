import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Projeler → Deploy (`?path=/projects/mobil-app?tab=deploy`) — deploy targets
 * with Coolify, a Pages target and a further project, two DNS zones (one visible only to the Cloudflare token), preview
 * links, a ready site upload, uptime auto-monitor on and the verification settings. Also used by
 * apps/web/test/diyalog-w3-project-deploy.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

export const DEPLOY_TARGETS = {
  coolify: {
    preview: { uuids: ['a1b2c3'], tags: [] },
    production: { uuids: ['d4e5f6', 'g7h8i9'], tags: ['mobil'] },
  },
  pages: { projectName: 'mobil-landing' },
  pagesProjects: ['mobil-docs'],
  dns: { zones: [{ id: 'z1', name: 'mobil.example' }], protectedNames: ['mobil.example'] },
  policy: {
    previewDeploy: 'auto',
    productionDeploy: 'approval_step_up',
    dnsChange: 'approval',
    autoDeployProductionOnSuccess: false,
    pagesProject: 'approval',
    previewTunnel: 'auto',
    stableTunnel: 'approval',
  },
  previews: {
    zone: { id: 'z1', name: 'mobil.example' },
    prefix: 'pr',
    agentsMayOpen: true,
    accessEmails: ['alex@example.com'],
    maxActive: 5,
    maxPerJob: 3,
  },
};

export const DEPLOY_OPS = {
  coolify: null,
  cloudflare: {
    provider: 'cloudflare',
    settings: {},
    keyFingerprint: 'abc',
    usable: true,
    lastTest: {
      ok: true,
      zones: [
        { id: 'z1', name: 'mobil.example' },
        { id: 'z2', name: 'vitrin.test' },
      ],
    },
    lastTestAt: iso(HOUR),
    updatedAt: iso(HOUR),
  },
  controlPlaneResources: [],
  protectedHosts: [],
};

export const SITE_UPLOADS = {
  items: [
    {
      id: '9d0c3a1e-5b7f-4e2a-8c6d-1f2e3a4b5c6d',
      project: 'mobil-app',
      state: 'ready',
      label: 'landing-v3',
      fileCount: 42,
      totalBytes: 3_480_000,
      partSize: 4_194_304,
      partCount: 1,
      received: null,
      uploadedBy: { id: 'u1', username: 'alex' },
      createdAt: iso(26 * HOUR),
      completedAt: iso(26 * HOUR),
      lastDeployedAt: iso(20 * HOUR),
      lastActionId: null,
      files: null,
    },
  ],
};

export const VERIFY_SETTINGS = {
  project: 'mobil-app',
  verifyDefault: 'report',
  verifyRuntime: null,
  testCommand: 'pnpm test',
  healthAfterDeploy: true,
  healthScreenshots: true,
  healthKeyword: null,
  autoRollback: true,
  autoRollbackProduction: false,
  updatedAt: iso(48 * HOUR),
};

export const ROUTES: ScreenRoutes = {
  '/projects/mobil-app/deploy-targets': (_u, method) =>
    method === 'GET'
      ? { project: 'mobil-app', targets: DEPLOY_TARGETS, version: 4, updatedAt: iso(72 * HOUR) }
      : undefined,
  '/projects/mobil-app/site-uploads': (_u, method) => (method === 'GET' ? SITE_UPLOADS : undefined),
  '/uptime/settings': (u, method) =>
    method === 'GET' && u.searchParams.get('project') === 'mobil-app'
      ? { project: 'mobil-app', autoMonitor: true, updatedAt: iso(48 * HOUR) }
      : undefined,
  '/projects/mobil-app/verify-settings': (_u, method) => (method === 'GET' ? VERIFY_SETTINGS : undefined),
};
