import type { ScreenRoutes } from './types';

/**
 * p12-diyalog Faz 4 harness fixtures for İşler + Kuyruk (`/jobs`, `/jobs?tab=queue`). `/jobs` with a state filter is
 * the home's request: it falls through to the base fixtures.
 */

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function job(
  id: string,
  state: string,
  title: string,
  runtime: string,
  project: string,
  minAgo: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    project,
    projectKind: 'repository',
    state,
    runtime,
    title,
    attempts: 1,
    workerId: 'w1',
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(minAgo * MIN),
    stateChangedAt: iso(Math.max(0, minAgo - 7) * MIN),
    ...over,
  };
}

const id = (n: number): string => `9a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;

const JOBS = [
  job(id(1), 'RUNNING', 'Sipariş e-postası şablonunu yeniden yaz', 'claude-code', 'vitrin-web', 4),
  job(id(2), 'RUNNING', 'Flaky login testini bul ve düzelt', 'codex', 'mobil-app', 9, { workerId: 'w2' }),
  job(id(3), 'VERIFYING', 'Ödeme sayfası erişilebilirlik turu', 'opencode', 'vitrin-web', 12),
  job(
    id(4),
    'AWAITING_APPROVAL',
    'Vitest 5’e geç ve deprecation uyarılarını temizle',
    'claude-code',
    'mobil-app',
    31,
    {
      workerId: 'w2',
    },
  ),
  job(id(5), 'FAILED', 'Android build cache temizliği', 'pi', 'mobil-app', 46, {
    workerId: 'w5',
    attempts: 2,
  }),
  job(id(6), 'SUCCEEDED', 'README’ye kurulum adımlarını ekle', 'codex', 'ops-scripts', 95, {
    workerId: 'w3',
  }),
  job(id(7), 'QUEUED', 'Kampanya sayfası için görsel optimizasyonu', 'claude-code', 'vitrin-web', 2, {
    workerId: null,
  }),
  job(id(8), 'CANCELLED', 'Eski deploy betiğini sil', 'opencode', 'ops-scripts', 180, {
    createdBy: { type: 'automation', id: 'a1' },
  }),
  job(id(9), 'SUCCEEDED', 'Haftalık bağımlılık raporu', 'genel', 'genel', 260, {
    runtime: 'claude-code',
    projectKind: 'workspace',
    workerId: 'w4',
  }),
];

function entry(
  n: number,
  position: number,
  cls: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jobId: id(20 + n),
    project: 'vitrin-web',
    title: 'Kuyruktaki iş',
    runtime: 'claude-code',
    sandboxProfile: 'host-restricted',
    state: 'QUEUED',
    priority: cls === 'urgent' ? 50 : cls === 'background' ? -50 : 0,
    storedPriority: 0,
    priorityClass: cls,
    adjusted: null,
    position,
    waitingSince: iso(position * 3 * MIN),
    waitingSec: position * 180,
    category: 'slot',
    reasons: [{ code: 'no_free_slot', category: 'slot', message: 'every slot on 3 machines is busy' }],
    estimatedStart: iso(-position * 9 * MIN),
    createdBy: 'u1',
    canReorder: true,
    ...over,
  };
}

const QUEUE = {
  generatedAt: iso(0),
  total: 6,
  estimateNote: 'Estimated start: from the median duration of similar jobs; an estimate, not a promise.',
  pools: [
    {
      key: 'host-restricted',
      profile: 'host-restricted',
      machines: [
        {
          id: 'w1',
          name: 'atlas-win-01',
          slots: 3,
          profileSlots: null,
          running: 2,
          urgentReserve: 1,
          urgentReserveAuto: false,
          urgentReserveEffective: 1,
          subscriptionLogins: { runtimes: ['claude-code'], perLogin: true },
        },
        {
          id: 'w2',
          name: 'kestrel-mac',
          slots: 4,
          profileSlots: 2,
          running: 2,
          urgentReserve: 0,
          urgentReserveAuto: true,
          urgentReserveEffective: 1,
          subscriptionLogins: null,
        },
      ],
      jobs: [
        entry(1, 1, 'urgent', {
          title: 'Ödeme webhook’u 500 veriyor, acil düzelt',
          adjusted: { reason: 'run_now', by: 'alex', at: iso(MIN) },
          category: 'subscription_login',
          reasons: [
            {
              code: 'subscription_login_busy',
              category: 'subscription_login',
              message: 'Claude Code login on atlas-win-01 is in use by another job',
            },
          ],
        }),
        entry(2, 2, 'normal', { title: 'Kampanya sayfası için görsel optimizasyonu' }),
        entry(3, 3, 'normal', {
          title: 'Sipariş geçmişi sayfasına sayfalama ekle',
          runtime: 'codex',
          project: 'mobil-app',
          category: 'profile_slot',
          reasons: [
            {
              code: 'no_free_profile_slot',
              category: 'profile_slot',
              message: 'kestrel-mac busy for host-restricted (2/2 host-restricted slots in use)',
            },
          ],
        }),
        entry(4, 4, 'background', {
          title: 'Eski log dosyalarını arşivle',
          runtime: 'pi',
          project: 'ops-scripts',
          category: 'off_peak',
          reasons: [
            { code: 'off_peak_window', category: 'off_peak', message: 'waits for the 22:00–07:00 window' },
          ],
          estimatedStart: null,
        }),
      ],
    },
    {
      key: 'container@w3',
      profile: 'container',
      machines: [
        {
          id: 'w3',
          name: 'ridge-lnx-01',
          slots: 4,
          profileSlots: null,
          running: 4,
          urgentReserve: 0,
          urgentReserveAuto: true,
          urgentReserveEffective: 0,
          subscriptionLogins: null,
        },
      ],
      jobs: [
        entry(5, 1, 'normal', {
          title: 'Docker imajını küçült',
          runtime: 'opencode',
          project: 'ops-scripts',
          sandboxProfile: 'container',
          canReorder: true,
        }),
        entry(6, 2, 'normal', {
          title: 'Grafana panosunu güncelle',
          runtime: 'codex',
          project: 'ops-scripts',
          sandboxProfile: 'container',
          category: 'dependency',
          reasons: [
            { code: 'depends_on', category: 'dependency', message: 'waits for job 7c1e09ab to finish' },
          ],
        }),
      ],
    },
  ],
  paused: [
    {
      jobId: id(40),
      project: 'mobil-app',
      title: 'Vitest 5’e geç ve deprecation uyarılarını temizle',
      runtime: 'claude-code',
      workerId: 'w2',
      workerName: 'kestrel-mac',
      status: 'paused',
      since: iso(18 * MIN),
      retainUntil: iso(-6 * 60 * MIN),
      requestId: 'a1',
      action: 'fs.delete',
      decision: null,
      blockedReason: null,
      waiting: null,
    },
  ],
};

/** p12-diyalog-w1: a workflow run with a fan-out, a planned step, a waiting gate and a running integration. */
export const HARNESS_RUN = 'wr-5f6a7b8c-0000-4000-8000-000000000001';

const RUNS = {
  runs: [
    {
      id: HARNESS_RUN,
      project: 'vitrin-web',
      name: 'release-check',
      version: 3,
      state: 'running',
      createdAt: iso(22 * MIN),
      endedAt: null,
    },
    {
      id: 'wr-5f6a7b8c-0000-4000-8000-000000000002',
      project: 'mobil-app',
      name: 'nightly-deps',
      version: 1,
      state: 'succeeded',
      createdAt: iso(9 * 60 * MIN),
      endedAt: iso(8 * 60 * MIN),
    },
  ],
};

function node(
  nid: string,
  role: string,
  state: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: nid,
    role,
    state,
    parent: null,
    jobId: null,
    jobState: null,
    workerId: null,
    attempts: 1,
    reason: null,
    outputs: null,
    gate: null,
    ...over,
  };
}

const RUN = {
  run: {
    ...RUNS.runs[0],
    definitionId: 'wf-release',
    reason: null,
    files: [{ name: 'brief.md', sizeBytes: 4200, pruned: false }],
  },
  nodes: [
    node('plan', 'planner', 'succeeded', {
      jobId: id(51),
      jobState: 'SUCCEEDED',
      workerId: 'w1',
      workerName: 'kestrel-mac',
      runtime: 'claude-code',
      outputs: { summary: 'Üç alt görev planlandı: lint, test, a11y.', branch: 'wf/plan' },
    }),
    node('lint', 'worker', 'succeeded', { jobId: id(52), jobState: 'SUCCEEDED', runtime: 'codex' }),
    node('test', 'worker', 'queued', {
      jobId: id(53),
      jobState: 'RUNNING',
      workerId: 'w2',
      workerName: 'ridge-lnx-01',
      runtime: 'opencode',
      placement: {
        runtime: 'opencode',
        source: 'planner',
        model: null,
        tools: [],
        machine: null,
        notes: ['planlayıcı seçti'],
      },
    }),
    node('a11y-extra', 'worker', 'pending', { parent: 'plan' }),
    node('release-gate', 'gate', 'awaiting_approval', {
      gate: { approverRole: 'operator', decision: null, decidedBy: null },
    }),
  ],
  edges: [
    { from: 'plan', to: 'lint' },
    { from: 'plan', to: 'test' },
    { from: 'plan', to: 'a11y-extra' },
    { from: 'lint', to: 'release-gate' },
    { from: 'test', to: 'release-gate' },
    { from: 'a11y-extra', to: 'release-gate' },
  ],
  mergeRequests: [{ id: 'mr1', node: 'release-gate', status: 'waiting', branches: ['wf/lint', 'wf/test'] }],
};

const RUN_INTEGRATION = {
  integration: {
    id: 'int-1',
    project: 'vitrin-web',
    source: 'workflow',
    rootJobId: null,
    runId: HARNESS_RUN,
    nodeId: null,
    branch: 'int/release-check-3',
    targetBranch: 'main',
    baseSha: 'a1b2c3d4e5f6',
    headSha: 'f6e5d4c3b2a1',
    orderMode: 'dependency',
    state: 'verifying',
    reason: null,
    resolutionRounds: 1,
    maxResolutions: 3,
    fixRounds: 0,
    maxFixes: 2,
    branches: [
      {
        position: 1,
        jobId: id(52),
        title: 'Lint düzeltmeleri',
        branch: 'wf/lint',
        sha: '1111111aaaa',
        paths: ['src/'],
        state: 'merged',
        mergedSha: '2222222bbbb',
        conflictFiles: [],
        resolutionJobId: null,
        resolutionJobState: null,
        detail: null,
      },
      {
        position: 2,
        jobId: id(53),
        title: 'Test güncellemeleri',
        branch: 'wf/test',
        sha: '3333333cccc',
        paths: ['test/'],
        state: 'resolved',
        mergedSha: '4444444dddd',
        conflictFiles: ['package.json'],
        resolutionJobId: id(54),
        resolutionJobState: 'SUCCEEDED',
        detail: null,
      },
    ],
    jobs: [{ jobId: id(54), kind: 'resolve', round: 1, state: 'SUCCEEDED', createdAt: iso(5 * MIN) }],
    warnings: [],
    verification: { state: 'running', jobId: id(55), summary: null, checks: [], findings: [] },
    pullRequest: null,
    mergeJobId: null,
    log: [{ at: iso(5 * MIN), message: 'package.json çakışması çözüldü' }],
    createdAt: iso(10 * MIN),
    updatedAt: iso(2 * MIN),
  },
};

export const ROUTES: ScreenRoutes = {
  '/jobs': (url) => {
    // The home asks for single states; only the full list (and its presets) is the screen's.
    const state = url.searchParams.get('state');
    if (state !== null && url.searchParams.get('limit') !== '50') return undefined;
    if (state === 'RUNNING' || state === 'VERIFYING' || state === 'FAILED') return undefined;
    const items = state === null ? JOBS : JOBS.filter((j) => j.state === state);
    return { items, nextCursor: state === null ? 'c2' : null };
  },
  '/queue': () => QUEUE,
  '/workflows': () => RUNS,
  [`/workflows/runs/${HARNESS_RUN}`]: () => RUN,
  [`/workflows/runs/${HARNESS_RUN}/integration`]: () => RUN_INTEGRATION,
  '/usage/records': () => ({
    items: [
      { jobId: id(5), cost: { costClass: 'reported', costUsd: 0.37 } },
      { jobId: id(6), cost: { costClass: 'estimated', costUsd: 1.12 } },
      { jobId: id(1), cost: { costClass: 'subscription', costUsd: null } },
    ],
  }),
};
