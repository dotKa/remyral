import type { ScreenRoutes } from './types';

/**
 * p12-diyalog Faz 4 harness fixtures for the Makineler screens (`?path=/machines`, `?path=/machines/w2`). Return
 * undefined to fall through to the base fixtures. The same five machines as the home rail, plus one waiting to pair.
 */

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function worker(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: `SHA256:${id.toUpperCase()}x9Qm2LrT0aV7bK4nE1sW8yH3cJ6dF5gP`,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '1.0.41',
    runningJobs: 0,
    lastSeenAt: iso(1000),
    createdAt: iso(40 * 86_400_000),
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    archivedAt: null,
    ...over,
  };
}

const WORKERS = [
  worker('w1', 'atlas-win-01', { os: 'windows', state: 'busy', runningJobs: 2 }),
  worker('w2', 'kestrel-mac', { os: 'darwin', arch: 'arm64', runningJobs: 1, hostname: 'kestrel.local' }),
  worker('w3', 'ridge-lnx-01', { runningJobs: 1 }),
  worker('w4', 'ridge-lnx-03', { connected: false, state: 'offline', lastSeenAt: iso(126 * MIN) }),
  worker('w5', 'pebble-pi', { arch: 'arm64' }),
  worker('w6', 'nova-lnx-04', {
    state: 'pending',
    connected: false,
    pairingExpiresAt: iso(-12 * MIN),
    lastSeenAt: iso(2 * MIN),
  }),
];

function cell(runtime: string, status = 'ready'): Record<string, unknown> {
  return {
    runtime,
    status,
    version: '2.1.0',
    reason:
      status === 'ready'
        ? 'ready'
        : status === 'pin_mismatch'
          ? 'installed 2.1.0, pinned 2.2.1 (ADR-0012): install the pinned version'
          : `${runtime} is not logged in`,
  };
}

function overview(
  id: string,
  running: number,
  max: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    capacity: { running, max },
    capabilitiesAt: iso(MIN),
    sandboxProfiles: ['host', 'container'],
    sandboxReadiness: [
      { profile: 'container', ready: true, runtimes: null, reason: null },
      { profile: 'host', ready: true, runtimes: null, reason: null },
    ],
    tools: [
      { name: 'git', version: '2.47.0' },
      { name: 'node', version: '24.11.0' },
      { name: 'pnpm', version: '12.11.2' },
    ],
    load: { cpuPercent: 38, memoryFreeBytes: 9.4 * 2 ** 30, diskFreeBytes: 212 * 2 ** 30 },
    network: { key: '192.168.1.0/24', label: 'Ev ağı 192.168.1.0/24' },
    runtimePolicy: { assigned: null, effective: 'default', version: 3, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: [cell('claude-code'), cell('codex'), cell('opencode')],
    queue: { profileSlots: {}, urgentReserve: 1, urgentReserveAuto: true },
    ...over,
  };
}

const OVERVIEW = [
  // p17-ui-review: the Windows machine with all four runtimes, two of them off their pinned version, a login to
  // renew and a runtime policy not applied yet (the attention panel groups the repeated pin cards).
  overview('w1', 2, 3, {
    compatibility: [
      cell('codex'),
      cell('opencode', 'pin_mismatch'),
      cell('pi', 'pin_mismatch'),
      cell('claude-code', 'not_authenticated'),
    ],
    runtimePolicy: { assigned: 'strict', effective: 'strict', version: 4, stage: 'active', inSync: false },
    load: {
      cpuPercent: 61,
      memoryFreeBytes: 3.2 * 2 ** 30,
      diskFreeBytes: 148 * 2 ** 30,
      workspaceDisk: { freeBytes: 148 * 2 ** 30, minFreeBytes: 20 * 2 ** 30 },
    },
  }),
  overview('w2', 1, 4, { compatibility: [cell('claude-code'), cell('codex'), cell('pi')] }),
  overview('w3', 1, 4, {
    compatibility: [cell('claude-code'), cell('codex'), cell('opencode'), cell('pi')],
  }),
  overview('w4', 0, 4, { load: null }),
  overview('w5', 0, 1, { compatibility: [cell('pi')], sandboxProfiles: ['host'], sandboxReadiness: [] }),
];

/** 24 h of a window's usage: every 30 min, rising through the working day. */
function history(endPercent: number, startPercent: number): { at: string; usedPercent: number }[] {
  const n = 48;
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const wobble = Math.sin(i * 0.9) * 3;
    const v = startPercent + (endPercent - startPercent) * t * t + wobble;
    return { at: iso((n - 1 - i) * 30 * MIN), usedPercent: Math.max(0, Math.min(100, Math.round(v))) };
  });
}

function win(
  id: string,
  kind: string,
  used: number,
  resetsInMin: number,
  level: string,
  minutes: number,
  start: number,
) {
  return {
    id,
    kind,
    label: null,
    usedPercent: used,
    windowMinutes: minutes,
    resetsAt: iso(-resetsInMin * MIN),
    status: null,
    level,
    history: history(used, start),
  };
}

function entry(runtime: string, workerId: string, workerName: string, windows: unknown[], level = 'ok') {
  return {
    workerId,
    workerName,
    workerState: 'online',
    runtime,
    auth: 'subscription',
    store: null,
    source: 'probe',
    plan: 'max',
    available: true,
    observedAt: iso(2 * MIN),
    stale: false,
    reports: true,
    level,
    windows,
    limit: null,
  };
}

const USAGE = {
  generatedAt: iso(0),
  settings: { nearThreshold: 80, notifyNear: true },
  entries: [
    entry('claude-code', 'w2', 'kestrel-mac', [
      win('five_hour', 'session', 72, 56, 'ok', 300, 8),
      win('seven_day', 'weekly', 41, 3 * 24 * 60, 'ok', 10080, 30),
    ]),
    entry(
      'codex',
      'w2',
      'kestrel-mac',
      [
        win('primary', 'session', 88, 161, 'near', 300, 20),
        win('secondary', 'weekly', 35, 4 * 24 * 60, 'ok', 10080, 22),
      ],
      'near',
    ),
    entry(
      'codex',
      'w1',
      'atlas-win-01',
      [
        win('primary', 'session', 88, 161, 'near', 300, 12),
        win('secondary', 'weekly', 35, 4 * 24 * 60, 'ok', 10080, 25),
      ],
      'near',
    ),
    entry('pi', 'w2', 'kestrel-mac', [win('daily', 'session', 18, 9 * 60, 'ok', 1440, 2)]),
    // p17-ui-review: two Claude accounts on the Windows machine and a full set on the Linux one.
    {
      ...entry('claude-code', 'w1', 'atlas-win-01', [
        win('five_hour', 'session', 46, 120, 'ok', 300, 5),
        win('seven_day', 'weekly', 63, 2 * 24 * 60, 'ok', 10080, 40),
      ]),
      account: 'default',
      accountLabel: 'Kişisel',
    },
    {
      ...entry(
        'claude-code',
        'w1',
        'atlas-win-01',
        [
          win('five_hour', 'session', 97, 34, 'limited', 300, 30),
          win('seven_day', 'weekly', 81, 2 * 24 * 60, 'near', 10080, 50),
        ],
        'limited',
      ),
      account: 'team',
      accountLabel: 'Ekip hesabı',
    },
    entry('claude-code', 'w3', 'ridge-lnx-01', [
      win('five_hour', 'session', 22, 200, 'ok', 300, 2),
      win('seven_day', 'weekly', 54, 5 * 24 * 60, 'ok', 10080, 35),
    ]),
    entry('codex', 'w3', 'ridge-lnx-01', [
      win('primary', 'session', 12, 250, 'ok', 300, 1),
      win('secondary', 'weekly', 30, 6 * 24 * 60, 'ok', 10080, 20),
    ]),
    entry('opencode', 'w3', 'ridge-lnx-01', [win('daily', 'session', 9, 14 * 60, 'ok', 1440, 1)]),
  ],
  otherLimits: [],
};

function running(
  id: string,
  title: string,
  runtime: string,
  project: string,
  workerId: string,
  msAgo: number,
) {
  return {
    id,
    project,
    projectKind: 'repo',
    state: 'RUNNING',
    runtime,
    title,
    attempts: 1,
    workerId,
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(msAgo + 30_000),
    stateChangedAt: iso(msAgo),
  };
}

const JOBS_BY_WORKER: Readonly<Record<string, unknown[]>> = {
  w1: [
    running('j1', 'Sipariş e-postası şablonunu yeniden yaz', 'codex', 'vitrin-web', 'w1', 4 * MIN),
    running('j2', 'Flaky login testini bul ve düzelt', 'opencode', 'mobil-app', 'w1', 9 * MIN),
  ],
  w2: [
    running(
      '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e',
      'Vitest 5’e geç ve deprecation uyarılarını temizle',
      'claude-code',
      'mobil-app',
      'w2',
      18 * MIN,
    ),
  ],
  w3: [running('j3', 'Ödeme sayfası erişilebilirlik turu', 'claude-code', 'vitrin-web', 'w3', 2 * MIN)],
};

function detail(id: string): unknown {
  const w = WORKERS.find((x) => x.id === id);
  if (w === undefined) return undefined;
  return {
    ...w,
    runtimes: [
      {
        runtime: 'claude-code',
        version: '2.1.0',
        installed: true,
        authenticated: 'yes',
        pinnedVersion: '2.1.0',
        pinStatus: 'match',
        present: true,
      },
      {
        runtime: 'codex',
        version: '0.48.0',
        installed: true,
        authenticated: 'yes',
        pinnedVersion: null,
        pinStatus: 'unpinned',
        present: true,
      },
    ],
    credentials: [{ fingerprint: String(w.fingerprint), status: 'active' }],
  };
}

const workerRoutes: Record<string, (url: URL) => unknown> = {};
for (const w of WORKERS) {
  const id = String(w.id);
  workerRoutes[`/workers/${id}`] = () => detail(id);
  workerRoutes[`/workers/${id}/history`] = () => ({
    items: [
      {
        at: iso(40 * 86_400_000),
        action: 'worker.paired',
        outcome: 'success',
        actorType: 'user',
        detail: {},
      },
      {
        at: iso(3 * 86_400_000),
        action: 'worker.release',
        outcome: 'success',
        actorType: 'system',
        detail: { from: '1.0.40', to: '1.0.41' },
      },
    ],
  });
}

export const ROUTES: ScreenRoutes = {
  '/workers': (url) => (url.searchParams.get('archived') === '1' ? { workers: [] } : { workers: WORKERS }),
  '/fleet/overview': () => ({ workers: OVERVIEW }),
  '/usage-limits/overview': () => USAGE,
  '/jobs': (url) => {
    const w = url.searchParams.get('worker');
    if (w === null) return undefined;
    return {
      items: url.searchParams.get('state') === 'RUNNING' ? (JOBS_BY_WORKER[w] ?? []) : [],
      nextCursor: null,
    };
  },
  ...workerRoutes,
};
