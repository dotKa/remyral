import type { ScreenRoutes } from './types';

/**
 * p12-diyalog-w1 harness fixtures for the composer page: `/jobs/new` (empty) and `/jobs/new?project=vitrin-web` (the
 * project's repository, placement with candidates and a rejected machine, model profiles, runtime advice, budgets,
 * deploy targets, the context bundle, a workflow definition).
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const W1 = 'w1';
const W2 = 'w2';
const W5 = 'w5';

const WORKERS = [
  {
    id: W1,
    name: 'ridge-mac-01',
    state: 'online',
    connected: true,
    os: 'darwin',
    arch: 'arm64',
    tools: ['git', 'node'],
  },
  {
    id: W2,
    name: 'ridge-lnx-02',
    state: 'busy',
    connected: true,
    os: 'linux',
    arch: 'x64',
    tools: ['git', 'docker', 'node'],
  },
  {
    id: W5,
    name: 'ridge-pi-05',
    state: 'offline',
    connected: false,
    os: 'linux',
    arch: 'arm64',
    tools: ['git'],
  },
];

function preview(project: string): Record<string, unknown> {
  return {
    project,
    hostExecution: true,
    unconfinedExecution: false,
    autoApproveExecution: false,
    fullAccess: {
      available: false,
      reasons: [
        { code: 'unconfined_not_opted_in', message: 'the project does not allow the unconfined profile' },
      ],
      workers: [],
    },
    sandboxProfile: 'host-restricted',
    issues: [],
    placement: {
      runtime: 'claude-code',
      verdict: 'placed',
      holds: [],
      candidates: [
        { workerId: W1, score: 0.91, breakdown: {} },
        { workerId: W2, score: 0.74, breakdown: {} },
      ],
      rejected: [
        {
          workerId: W5,
          reasons: [{ code: 'offline', permanent: false, message: 'worker is offline' }],
        },
      ],
      summary: [],
      explanation: 'least loaded machine with Claude Code ready and the project checkout cached',
    },
    routing: {
      role: 'execute',
      roleSource: 'inferred',
      rule: { modelProfile: 'sonnet', runtimes: ['claude-code', 'codex'], scope: 'project' },
      runtime: 'claude-code',
    },
    runtimes: [
      { runtime: 'claude-code', verdict: 'placed', eligible: [W1, W2], feasible: [W1, W2], summary: [] },
      { runtime: 'codex', verdict: 'placed', eligible: [W2], feasible: [W2], summary: [] },
      {
        runtime: 'opencode',
        verdict: 'waiting',
        eligible: [],
        feasible: [W5],
        summary: [{ code: 'offline', permanent: false, message: 'worker is offline', workers: [W5] }],
      },
      {
        runtime: 'pi',
        verdict: 'infeasible',
        eligible: [],
        feasible: [],
        summary: [
          {
            code: 'runtime_not_installed',
            permanent: true,
            message: 'pi is not installed (installed: claude-code 2.1, codex 0.9)',
            workers: [W1, W2],
          },
        ],
      },
    ],
    modelProfiles: [
      {
        name: 'sonnet',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        isDefault: true,
        workers: [W1, W2],
      },
      {
        name: 'opus',
        provider: 'anthropic',
        model: 'claude-opus-4-1',
        isDefault: false,
        workers: [W1],
        source: 'catalog',
        value: 'anthropic/claude-opus-4-1',
        displayName: 'Opus',
        pricing: { inputPerMTok: 15, outputPerMTok: 75 },
      },
    ],
    model: {
      runtime: 'claude-code',
      defaultProfile: 'sonnet',
      defaultScope: 'project',
      defaultSource: 'routing',
    },
    sandbox: [
      { profile: 'container', workers: [W1, W2] },
      { profile: 'runtime-sandbox', workers: [W1] },
      { profile: 'host-restricted', workers: [W1, W2] },
      { profile: 'unconfined', workers: [] },
    ],
    limits: { maxCostUsd: 8, maxWallTimeSec: 7200 },
    workers: WORKERS,
  };
}

export const ROUTES: ScreenRoutes = {
  '/projects/vitrin-web/git': () => ({
    config: {
      project: 'vitrin-web',
      version: 1,
      provider: 'github',
      repositoryUrl: 'https://github.com/octo-org/vitrin-web.git',
      baseBranch: 'main',
      mergeMethod: 'squash',
      requireCi: true,
      ciTimeoutSec: 600,
      github: null,
      updatedAt: iso(86_400_000),
    },
  }),
  '/jobs/placement-preview': (_url, method) => (method === 'POST' ? preview('vitrin-web') : undefined),
  '/routing/advice': (_url, method) =>
    method === 'POST'
      ? {
          mode: 'advice',
          classification: {
            kind: 'execute',
            area: 'frontend',
            areaSource: 'prompt',
            signals: [{ source: 'prompt', detail: 'e-posta şablonu' }],
          },
          advice: {
            recommended: 'claude-code',
            text: 'Recommended runtime for this project’s frontend jobs: Claude Code — 91% good outcomes (n=23) vs Codex 74% (n=19); median 12 min; est. cost $0.42.',
          },
        }
      : undefined,
  '/budgets': () => ({
    items: [
      {
        budget: {
          id: 'b1',
          name: 'Aylık vitrin',
          metric: 'cost_usd',
          limit: 200,
          scope: { type: 'project', value: 'vitrin-web' },
          window: 'month',
          enabled: true,
          version: 1,
          billing: 'all',
          timeZone: 'Europe/Istanbul',
          thresholds: [0.8],
          onExceeded: 'warn',
          createdAt: iso(0),
          updatedAt: iso(0),
        },
        evaluation: {
          used: 162,
          limit: 200,
          ratio: 0.81,
          status: 'warning',
          complete: true,
          records: 40,
          unknownRecords: 0,
          subscriptionRecords: 0,
          window: { start: iso(864_000_000), end: iso(-1_728_000_000) },
        },
      },
    ],
  }),
  '/projects/vitrin-web/deploy-targets': () => ({
    project: 'vitrin-web',
    targets: {
      coolify: null,
      pages: { projectName: 'vitrin-web' },
      pagesProjects: ['vitrin-kampanya'],
      dns: { zones: [{ id: 'z1', name: 'demo.test' }], protectedNames: [] },
      policy: {
        previewDeploy: 'auto',
        productionDeploy: 'approval_step_up',
        dnsChange: 'approval',
        autoDeployProductionOnSuccess: true,
        pagesProject: 'approval',
        previewTunnel: 'auto',
      },
    },
    version: 1,
    updatedAt: iso(0),
  }),
  '/context/bundle': () => ({
    bundleHash: 'sha256:5c1f0a9e3b7d2c4e8f6a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e',
    items: [
      {
        position: 1,
        layer: 'platform',
        kind: 'policy',
        title: 'Platform kuralları',
        version: 4,
        content: 'Onaysız push yok.',
        withheld: false,
      },
      {
        position: 2,
        layer: 'project',
        kind: 'instructions',
        title: 'vitrin-web talimatları',
        version: 2,
        content: 'pnpm kullan; Tailwind.',
        withheld: false,
      },
      {
        position: 3,
        layer: 'memory',
        kind: 'record',
        recordType: 'lesson',
        title: 'E-posta testleri',
        version: 1,
        content: null,
        withheld: true,
      },
    ],
    omitted: [],
  }),
  '/workflows': () => ({
    definitions: [
      {
        id: 'wf1',
        project: 'vitrin-web',
        name: 'Planla, uygula, doğrula',
        version: 2,
        nodes: 3,
        description: null,
        createdAt: iso(0),
      },
    ],
  }),
  '/workflows/wf1': () => ({
    id: 'wf1',
    project: 'vitrin-web',
    name: 'Planla, uygula, doğrula',
    version: 2,
    description: 'Üç adımlı akış: plan, uygulama, doğrulama kapısı.',
    inputs: [{ name: 'hedef', required: true, description: 'Ne değişecek' }],
    nodes: [
      { id: 'plan', role: 'plan', runtime: 'claude-code', gate: false, dynamic: false },
      { id: 'uygula', role: 'execute', runtime: 'codex', gate: false, dynamic: false },
      { id: 'dogrula', role: 'verify', runtime: 'claude-code', gate: true, dynamic: false },
    ],
    edges: [
      { from: 'plan', to: 'uygula' },
      { from: 'uygula', to: 'dogrula' },
    ],
    defaults: {
      runtime: 'claude-code',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      repository: null,
    },
  }),
  '/schedules/cron-preview': () => ({
    nextRuns: [iso(-3_600_000), iso(-90_000_000), iso(-176_400_000)],
  }),
};
