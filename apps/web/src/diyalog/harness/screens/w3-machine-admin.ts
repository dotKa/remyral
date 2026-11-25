import { ROUTES as MACHINES } from './machines';
import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: machine admin + capacity (`?path=/machines/w1?tab=admin`, `/machines/w1`).
 * atlas-win-01 (w1): device keys with a pending rotation, a restartable worker, machine administration on (with
 * commands, a running task and memory), capacity advice above the configured value, automatic capacity with a
 * history, the Acil reserve and package caches. Also used by apps/web/test/diyalog-w3-machine-admin.test.tsx.
 */

const NOW = Date.now();
const MIN = 60_000;
const GB = 2 ** 30;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

/** Fleet-overview additions for w1 (merged over the Faz 4 machine fixtures). */
export const ADMIN_OVERVIEW_W1 = {
  parallelism: { effective: 3, configured: 3, localCeiling: null, state: 'panel' },
  advice: {
    recommended: 2,
    limitedBy: 'memory',
    cpuCount: 8,
    memoryBytes: 16 * GB,
    reserveBytes: 4 * GB,
    perJobBytes: 5 * GB,
    byCpu: 7,
    byMemory: 2,
    basis: { runtime: 'codex', peakBytes: 3.4 * GB, perJobBytes: 5 * GB, source: 'measured', attempts: 14 },
    runtimes: [],
  },
  capacityMode: { mode: 'auto', slots: 2, min: 1, max: 4, suggestion: null },
  packageCaches: {
    enabled: true,
    disabledReason: null,
    maxBytes: 20 * GB,
    usedBytes: 12.6 * GB,
    projects: [
      {
        projectId: 'vitrin-web',
        bytes: 7.1 * GB,
        lastUsedAt: iso(40 * MIN),
        inUse: true,
        managers: [
          { manager: 'pnpm', bytes: 6.4 * GB },
          { manager: 'pip', bytes: 0.7 * GB },
        ],
      },
      {
        projectId: 'mobil-app',
        bytes: 5.5 * GB,
        lastUsedAt: iso(26 * 60 * MIN),
        inUse: false,
        managers: [{ manager: 'npm', bytes: 5.5 * GB }],
      },
    ],
    truncated: false,
    scannedAt: iso(12 * MIN),
    lastEviction: { at: iso(3 * 24 * 60 * MIN), projects: 2, bytes: 3.2 * GB },
    reportedAt: iso(12 * MIN),
  },
  queue: {
    profileSlots: { 'host-restricted': 1 },
    exclusiveProfiles: [],
    urgentReserve: 1,
    urgentReserveAuto: true,
  },
};

export const ADMIN_WORKER_W1_CREDENTIALS = [
  { fingerprint: 'SHA256:W1x9Qm2LrT0aV7bK4nE1sW8yH3cJ6dF5gP', status: 'active' },
  { fingerprint: 'SHA256:W1n3wK3yR0tat10nP3nd1ngAbCdEfGhIjK', status: 'pending' },
];

export const ADMIN_OPS_W1 = {
  workerId: 'w1',
  displayName: 'atlas-win-01',
  state: 'busy',
  connected: true,
  supported: true,
  report: {
    runtimes: [],
    login: [],
    service: { manager: 'windows-service', restartable: true },
    logs: { available: true, bytes: 120_000 },
  },
  reportedAt: iso(MIN),
  ops: [],
};

export const ADMIN_VIEW_W1 = {
  workerId: 'w1',
  displayName: 'atlas-win-01',
  connected: true,
  supported: true,
  desired: { enabled: true, autoApprove: false, generation: 4 },
  reported: {
    enabled: true,
    autoApprove: false,
    localVeto: false,
    helper: 'available',
    runtimes: ['claude-code'],
  },
  reportedAt: iso(MIN),
  projectAutoApprove: false,
  activeJob: { jobId: 'job-madmin-1', state: 'RUNNING', title: 'Docker Desktop’ı güncelle' },
  commands: [
    {
      requestId: 'cmd-3',
      jobId: 'job-madmin-1',
      attemptId: 'a1',
      kind: 'exec',
      summary: 'winget upgrade --id Docker.DockerDesktop --silent',
      purpose: 'Docker Desktop’ı en son sürüme güncelle',
      state: 'pending',
      reason: null,
      autoApproved: false,
      approvalId: 'ap-1',
      exitCode: null,
      durationMs: null,
      file: null,
      createdAt: iso(3 * MIN),
      updatedAt: iso(3 * MIN),
    },
    {
      requestId: 'cmd-2',
      jobId: 'job-madmin-1',
      attemptId: 'a1',
      kind: 'read_file',
      summary: 'C:\\ProgramData\\DockerDesktop\\install-settings.json',
      state: 'succeeded',
      reason: null,
      autoApproved: false,
      approvalId: null,
      exitCode: 0,
      durationMs: 40,
      file: null,
      createdAt: iso(6 * MIN),
      updatedAt: iso(6 * MIN),
    },
    {
      requestId: 'cmd-1',
      jobId: 'job-madmin-0',
      attemptId: 'a0',
      kind: 'exec',
      summary: 'Stop-Service -Name com.docker.service',
      state: 'denied',
      reason: 'denied_by_user',
      autoApproved: false,
      approvalId: 'ap-0',
      exitCode: null,
      durationMs: null,
      file: null,
      createdAt: iso(2 * 24 * 60 * MIN),
      updatedAt: iso(2 * 24 * 60 * MIN),
    },
  ],
  memory: {
    docId: 'doc-1',
    version: 3,
    content:
      '- Docker Desktop 4.36 kurulu (winget), WSL 2 arka ucu.\n- Node 24 LTS: C:\\Program Files\\nodejs (nvm yok).\n- Windows Defender dışlaması: D:\\remyral\\work',
    updatedAt: iso(2 * 24 * 60 * MIN),
  },
};

export const CAPACITY_W1 = {
  workerId: 'w1',
  mode: 'auto',
  min: 1,
  max: 4,
  slots: 2,
  effective: 3,
  configured: 4,
  reportedMax: 4,
  hardwareCeiling: 3,
  upper: 3,
  managed: true,
  metricsSupported: true,
  suggestion: null,
  lastDecision: {
    at: iso(14 * MIN),
    action: 'lower',
    from: 3,
    to: 2,
    estimate: null,
    reasons: [{ code: 'memory_low', text: 'Only 1.1 GB of memory available (below 1.5 GB).' }],
  },
  metrics: {
    at: iso(MIN),
    cpuPercent: 64,
    memoryAvailableBytes: 2.3 * GB,
    memoryTotalBytes: 16 * GB,
    swapUsedBytes: 0.4 * GB,
    swapTotalBytes: 4 * GB,
    swapInPerSec: 0,
    commitPercent: 71,
    memoryPressurePercent: null,
    running: 2,
    waiting: 1,
    oomFailures: 0,
    timeouts: 0,
    slowdownRatio: null,
  },
  events: [
    {
      id: 'e1',
      at: iso(26 * 60 * MIN),
      kind: 'mode',
      mode: 'auto',
      from: 3,
      to: 2,
      reasons: [],
      actor: { type: 'user', id: 'u1' },
    },
    {
      id: 'e2',
      at: iso(5 * 60 * MIN),
      kind: 'raise',
      mode: 'auto',
      from: 2,
      to: 3,
      reasons: [{ code: 'headroom', text: 'Jobs waited with headroom for 5 minutes.' }],
      actor: { type: 'system', id: null },
    },
    {
      id: 'e3',
      at: iso(14 * MIN),
      kind: 'lower',
      mode: 'auto',
      from: 3,
      to: 2,
      reasons: [{ code: 'memory_low', text: 'Only 1.1 GB of memory available (below 1.5 GB).' }],
      actor: { type: 'system', id: null },
    },
  ],
};

export const ROUTES: ScreenRoutes = {
  '/fleet/overview': (url, method) => {
    const base = MACHINES['/fleet/overview']?.(url, method) as
      { workers: Record<string, unknown>[] } | undefined;
    if (base === undefined) return undefined;
    return { workers: base.workers.map((o) => (o.id === 'w1' ? { ...o, ...ADMIN_OVERVIEW_W1 } : o)) };
  },
  '/workers/w1': (url, method) => {
    const base = MACHINES['/workers/w1']?.(url, method) as Record<string, unknown> | undefined;
    return base === undefined ? undefined : { ...base, credentials: ADMIN_WORKER_W1_CREDENTIALS };
  },
  '/workers/w1/ops': (_u, method) => (method === 'GET' ? ADMIN_OPS_W1 : undefined),
  '/workers/w1/machine-admin': (_u, method) => (method === 'GET' ? ADMIN_VIEW_W1 : undefined),
  '/workers/w1/capacity': (_u, method) => (method === 'GET' ? CAPACITY_W1 : undefined),
};
