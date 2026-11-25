import type { ScreenRoutes } from './types';

/**
 * p12-diyalog Faz 4 harness fixtures for the Projeler screens: three projects (`mobil-app` has jobs, a waiting
 * production deploy, a Pages target and machines; the base fixtures' approvals also belong to it). Return undefined
 * to fall through to the base fixtures.
 */

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const PROJECTS = [
  { id: 'mobil-app', name: 'Mobil uygulama', kind: 'repository', members: 4, myRole: 'owner' },
  { id: 'vitrin-web', name: 'Vitrin web sitesi', kind: 'repository', members: 3, myRole: 'owner' },
  { id: 'arastirma', name: 'Pazar araştırması', kind: 'workspace', members: 2, myRole: 'owner' },
  { id: 'ops-scripts', name: 'ops-scripts', kind: 'repository', members: 1, myRole: 'owner' },
].map((p) => ({ ...p, createdAt: iso(40 * 24 * 60 * MIN), createdBy: { username: 'alex' } }));

function job(
  id: string,
  state: string,
  title: string,
  runtime: string,
  msAgo: number,
): Record<string, unknown> {
  return {
    id,
    project: 'mobil-app',
    projectKind: 'repository',
    state,
    runtime,
    title,
    attempts: 1,
    workerId: 'w1',
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(msAgo + 1000),
    stateChangedAt: iso(msAgo),
  };
}

const JOBS = [
  job(
    '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e',
    'RUNNING',
    'Vitest 5’e geç ve deprecation uyarılarını temizle',
    'claude-code',
    4 * MIN,
  ),
  job('j-p2', 'AWAITING_APPROVAL', 'Android build cache temizliği', 'pi', 12 * MIN),
  job('j-p3', 'FAILED', 'Flaky login testini bul ve düzelt', 'codex', 26 * MIN),
  job('j-p4', 'SUCCEEDED', 'Bildirim izin ekranını yeniden tasarla', 'opencode', 3 * 60 * MIN),
  job('j-p5', 'SUCCEEDED', 'Ödeme formuna erişilebilirlik etiketleri ekle', 'claude-code', 26 * 60 * MIN),
  job('j-p6', 'CANCELLED', 'Eski analytics SDK’sını kaldır', 'codex', 50 * 60 * MIN),
];

function action(
  id: string,
  state: string,
  kind: string,
  env: string | null,
  msAgo: number,
): Record<string, unknown> {
  return {
    id,
    project: 'mobil-app',
    kind,
    env,
    params: {},
    target: { resources: [{ name: env === 'production' ? 'mobil-api-prod' : 'mobil-api-preview' }] },
    diff: {},
    policy: { decision: state === 'awaiting_approval' ? 'approval_step_up' : 'auto', reason: '' },
    state,
    requestedBy: { type: 'user', id: 'u1', username: 'alex' },
    via: 'web',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(msAgo),
    updatedAt: iso(msAgo),
    expiresAt: state === 'awaiting_approval' ? iso(-110 * MIN) : null,
    finishedAt: null,
  };
}

const ACTIONS = [
  action('d-p1', 'awaiting_approval', 'coolify.deploy', 'production', 10 * MIN),
  action('d-p2', 'succeeded', 'coolify.deploy', 'preview', 95 * MIN),
  action('d-p3', 'failed', 'pages.deploy', null, 26 * 60 * MIN),
];

const TARGETS = {
  coolify: {
    preview: { uuids: ['a1b2c3'], tags: [] },
    production: { uuids: ['d4e5f6', 'g7h8i9'], tags: ['mobil'] },
  },
  pages: { projectName: 'mobil-landing' },
  pagesProjects: [],
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
  previews: null,
};

function pworker(id: string, name: string, connected: boolean): Record<string, unknown> {
  return {
    workerId: id,
    displayName: name,
    state: connected ? 'online' : 'offline',
    connected,
    managed: true,
    supported: true,
    assigned: true,
    effective: true,
    blocked: null,
    generation: 3,
    appliedGeneration: 3,
  };
}

const projectOf = (url: URL): string | null => {
  const m = /^\/(?:api\/)?projects\/([^/]+)\//.exec(url.pathname);
  return m === null ? null : decodeURIComponent(m[1] ?? '');
};

export const ROUTES: ScreenRoutes = {
  '/projects': (_u, method) => (method === 'GET' ? { items: PROJECTS } : undefined),
  '/jobs': (u) =>
    u.searchParams.get('project') === 'mobil-app' ? { items: JOBS, nextCursor: null } : undefined,
  '/deploy/actions': (u) => {
    // No project: the Deploys list (p12-diyalog-w2 fixtures in deploys.ts).
    if (u.searchParams.get('project') === null) return undefined;
    if (u.searchParams.get('project') !== 'mobil-app') return { items: [], nextCursor: null };
    const state = u.searchParams.get('state');
    return { items: state === null ? ACTIONS : ACTIONS.filter((a) => a.state === state), nextCursor: null };
  },
  '/projects/mobil-app/workers': () => ({
    items: [
      pworker('w1', 'atlas-win-01', true),
      pworker('w2', 'kestrel-mac', true),
      pworker('w4', 'ridge-lnx-03', false),
    ],
  }),
  '/projects/vitrin-web/workers': () => ({ items: [pworker('w3', 'ridge-lnx-01', true)] }),
  '/projects/arastirma/workers': () => ({ items: [] }),
  '/projects/ops-scripts/workers': () => ({ items: [pworker('w5', 'pebble-pi', true)] }),
  '/projects/mobil-app/deploy-targets': (u) => ({
    project: projectOf(u) ?? 'mobil-app',
    targets: TARGETS,
    version: 4,
    updatedAt: iso(3 * 24 * 60 * MIN),
  }),
  '/projects/mobil-app/git': () => ({
    config: {
      project: 'mobil-app',
      version: 2,
      provider: 'github',
      repositoryUrl: 'https://github.com/remyral/mobil-app.git',
      baseBranch: 'main',
      mergeMethod: 'squash',
      requireCi: true,
      ciTimeoutSec: 1800,
      github: null,
      updatedAt: iso(9 * 24 * 60 * MIN),
    },
  }),
  '/projects/mobil-app/execution': () => ({
    project: 'mobil-app',
    hostExecution: false,
    unconfined: false,
    allowAutoApprove: false,
    safeCommands: 'read-only',
    subtasks: true,
    delegationRuntimes: [],
  }),
  // The list's "default models" line (classic Default models column).
  '/models': (_u, method) =>
    method === 'GET'
      ? {
          items: [],
          defaults: [
            { project: 'mobil-app', runtime: 'claude-code', profileId: 'sonnet' },
            { project: 'mobil-app', runtime: 'codex', profileId: 'gpt' },
          ],
        }
      : undefined,
  '/integrations/ops': () => ({
    coolify: null,
    cloudflare: null,
    controlPlaneResources: [],
    protectedHosts: [],
  }),
};
