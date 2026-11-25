import type { ScreenRoutes } from './types';

/**
 * p12-diyalog-w2 harness fixtures for /deploys and /deploys/:id (`?path=/deploys/<D_WAIT>` waiting DNS change,
 * `/deploys/<D_OK>` a Pages publish with its health check, `/deploys/<D_COOLIFY>` a Coolify deploy). Return
 * undefined to fall through to the base fixtures.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

export const D_WAIT = 'd0000000-0000-4000-8000-0000000000d1';
export const D_OK = 'd0000000-0000-4000-8000-0000000000d2';
export const D_COOLIFY = 'd0000000-0000-4000-8000-0000000000d3';
const D_FAIL = 'd0000000-0000-4000-8000-0000000000d4';
const D_RUN = 'd0000000-0000-4000-8000-0000000000d5';
const AUTOMATION = 'e0000000-0000-4000-8000-0000000000e1';
const SHOT_JOB = 'f0000000-0000-4000-8000-0000000000f1';

function action(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project: 'vitrin-web',
    kind: 'pages.deploy',
    env: 'production',
    params: {},
    target: { project: 'vitrin-web', branch: 'main' },
    diff: {},
    policy: { decision: 'approval_step_up', reason: 'production deploys need an admin and a code' },
    state: 'succeeded',
    requestedBy: { type: 'user', id: 'u1', username: 'alex' },
    via: 'api',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(30 * MIN),
    updatedAt: iso(30 * MIN),
    expiresAt: null,
    finishedAt: null,
    ...over,
  };
}

const ACTIONS = [
  action(D_WAIT, {
    kind: 'dns.upsert',
    env: null,
    state: 'awaiting_approval',
    target: { type: 'CNAME', name: 'shop.vitrin.example' },
    diff: {
      action: 'update',
      type: 'CNAME',
      name: 'shop.vitrin.example',
      zone: 'vitrin.example',
      before: { content: 'old-shop.pages.dev', ttl: 1, proxied: true },
      after: { content: 'vitrin-web.pages.dev', ttl: 1, proxied: true },
    },
    via: 'chat',
    note: 'Mağaza alan adını yeni Pages projesine taşı.',
    createdAt: iso(8 * MIN),
    expiresAt: iso(-112 * MIN),
  }),
  action(D_RUN, {
    kind: 'coolify.deploy',
    state: 'deploying',
    project: 'odeme-api',
    target: { resources: [{ name: 'odeme-api', uuid: 'k8s0a1b2' }] },
    via: 'automation',
    source: { automationId: AUTOMATION },
    createdAt: iso(3 * MIN),
  }),
  action(D_OK, {
    kind: 'pages.publish',
    state: 'succeeded',
    rollbackAvailable: true,
    decidedBy: { id: 'u1', username: 'alex' },
    decidedAt: iso(44 * MIN),
    decisionReason: 'LCP düzeltmesi dahil.',
    finishedAt: iso(42 * MIN),
    createdAt: iso(46 * MIN),
    diff: {
      action: 'publish',
      project: 'vitrin-web',
      env: 'production',
      source: 'upload',
      fileCount: 42,
      bytes: 1_840_000,
      steps: [
        {
          step: 'create',
          project: 'vitrin-web',
          subdomain: 'vitrin-web.pages.dev',
          done: true,
          decision: { decision: 'auto' },
        },
        {
          step: 'deploy',
          env: 'production',
          fileCount: 42,
          bytes: 1_840_000,
          project: 'vitrin-web',
          decision: { decision: 'approval_step_up' },
        },
        {
          step: 'domain',
          domain: 'vitrin.example',
          attach: 'attach',
          decision: { decision: 'approval' },
          dns: { action: 'create', zone: 'vitrin.example', after: { content: 'vitrin-web.pages.dev' } },
        },
      ],
      links: { domain: 'https://vitrin.example', pagesDev: 'https://vitrin-web.pages.dev' },
    },
    result: {
      url: 'https://vitrin.example',
      steps: [
        { step: 'create', state: 'skipped', note: 'zaten var' },
        { step: 'deploy', state: 'done', actionId: D_FAIL },
        { step: 'domain', state: 'done' },
      ],
      deploymentId: '4f3c2b1a-pages',
    },
  }),
  action(D_COOLIFY, {
    kind: 'coolify.deploy',
    project: 'odeme-api',
    env: 'preview',
    policy: { decision: 'auto', reason: 'preview deploys run at once' },
    target: { resources: [{ name: 'odeme-api', uuid: 'k8s0a1b2' }] },
    diff: {
      action: 'deploy',
      env: 'preview',
      ref: 'feat/3ds',
      resources: [
        {
          name: 'odeme-api',
          uuid: 'k8s0a1b2',
          fqdn: 'https://preview.odeme-api.example',
          currentCommit: '1a2b3c4',
          to: 'feat/3ds@9f8e7d6',
        },
      ],
    },
    result: {
      deployments: [{ deploymentUuid: 'dep-77aa' }],
      statuses: [{ deploymentUuid: 'dep-77aa', status: 'finished' }],
    },
    createdAt: iso(70 * MIN),
    finishedAt: iso(66 * MIN),
  }),
  action(D_FAIL, {
    kind: 'pages.deploy',
    state: 'failed',
    error: 'Cloudflare: upload rejected (file too large: assets/video.mp4)',
    createdAt: iso(26 * 60 * MIN),
  }),
];

const HEALTH = {
  id: 'h-1',
  opsActionId: D_OK,
  previewId: null,
  kind: 'pages',
  env: 'production',
  url: 'https://vitrin.example/',
  protected: false,
  state: 'warned',
  probe: {
    ok: true,
    statusCode: 200,
    latencyMs: 182,
    error: null,
    detail: null,
    tlsExpiresAt: iso(-64 * 24 * 60 * MIN),
  },
  links: {
    pages: 12,
    assets: 48,
    external: 6,
    truncated: false,
    broken: [
      {
        url: 'https://vitrin.example/img/hero@2x.webp',
        kind: 'asset',
        status: 404,
        error: null,
        from: '/index.html',
      },
    ],
  },
  findings: [
    {
      source: 'master',
      severity: 'warn',
      kind: 'perf',
      message: 'Ana sayfa 1.8 MB; LCP görseli sıkıştırılmamış.',
      url: null,
    },
  ],
  browserJobId: SHOT_JOB,
  browserNote: null,
  screenshots: [],
  rollbackActionId: null,
  rollbackNote: null,
  attempts: 2,
  createdAt: iso(42 * MIN),
  finishedAt: iso(41 * MIN),
};

export const ROUTES: ScreenRoutes = {
  '/deploy/actions': (u, method) => {
    if (method !== 'GET') return undefined;
    const state = u.searchParams.get('state');
    return { items: state === null ? ACTIONS : ACTIONS.filter((a) => a.state === state), nextCursor: null };
  },
  '/deploy-health': (_u, method) => (method === 'GET' ? { items: [HEALTH] } : undefined),
  ...Object.fromEntries(
    ACTIONS.flatMap((a) => {
      const id = String(a.id);
      return [
        [`/deploy/actions/${id}`, (_u: URL, method: string) => (method === 'GET' ? a : undefined)],
        [
          `/deploy/actions/${id}/health`,
          (_u: URL, method: string) =>
            method === 'GET' ? { health: id === D_OK ? HEALTH : null } : undefined,
        ],
        [
          `/deploy/actions/${id}/logs`,
          (_u: URL, method: string) =>
            method === 'GET'
              ? {
                  items: [
                    {
                      deploymentUuid: 'dep-77aa',
                      logs: 'Building image…\nPushed registry/odeme-api:9f8e7d6\nHealthy after 14 s',
                    },
                  ],
                }
              : undefined,
        ],
      ];
    }),
  ),
};
