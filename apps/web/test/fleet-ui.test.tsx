import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOverview } from '../src/api/fleet';
import type { WorkerSummary } from '../src/api/workers';
import { filterWorkers, groupByNetwork, sortWorkers } from '../src/screens/fleet/parts';

const A = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'wrk_cccccccccccccccccccccccccc';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function summary(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: null,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '0.1.0',
    protocolVersion: '1.0',
    runningJobs: 0,
    lastSeenAt: '2026-10-13T10:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    approvedAt: null,
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    ...over,
  };
}

const ready = (runtime: string, version = '1.0.0') => ({
  runtime,
  status: 'ready',
  version,
  reason: 'ready',
});
const missing = (runtime: string) => ({
  runtime,
  status: 'not_installed',
  version: null,
  reason: `${runtime} is not installed on this worker`,
});

function overview(id: string, over: Partial<Record<keyof WorkerOverview, unknown>> = {}) {
  return {
    id,
    capacity: { running: 0, max: 2 },
    capabilitiesAt: '2026-10-13T10:00:00.000Z',
    sandboxProfiles: ['container'],
    sandboxReadiness: [
      { profile: 'container', ready: true, runtimes: ['codex'], reason: null },
      {
        profile: 'runtime-sandbox',
        ready: false,
        runtimes: null,
        reason: 'bwrap cannot create user namespaces',
      },
    ],
    tools: [{ name: 'git', version: '2.47' }],
    load: {
      cpuPercent: 12,
      memoryFreeBytes: 8 * 2 ** 30,
      diskFreeBytes: 200 * 2 ** 30,
      // p15-merge-approvals item 4: below the minimum (the machine page warns).
      workspaceDisk: { freeBytes: 19.3 * 2 ** 30, minFreeBytes: 20 * 2 ** 30 },
    },
    network: { key: '192.168.1.0/24', label: '192.168.1.0/24 (private)' },
    runtimePolicy: { assigned: null, effective: 'default', version: 3, stage: 'active', inSync: true },
    release: {
      channel: 'stable',
      targetVersion: null,
      lastAttempt: {
        toVersion: '0.2.0',
        status: 'rolled_back',
        reason: 'health_check_failed',
        at: '2026-10-12T00:00:00.000Z',
      },
    },
    compatibility: [ready('codex'), missing('claude-code'), missing('opencode'), missing('pi')],
    ...over,
  };
}

const OVERVIEW = [
  overview(A, { capacity: { running: 2, max: 2 } }),
  overview(B, {
    capacity: { running: 1, max: 4 },
    network: { key: '10.0.0.0/24', label: '10.0.0.0/24 (private)' },
    compatibility: [
      ready('codex'),
      {
        runtime: 'claude-code',
        status: 'pin_mismatch',
        version: '2.0.1',
        reason: 'installed 2.0.1, pinned 2.1.0 (ADR-0012): install the pinned version',
      },
      ready('opencode'),
      missing('pi'),
    ],
  }),
  overview(C, { capacity: { running: 0, max: 1 } }),
];

describe('fleet helpers', () => {
  const ws = [
    summary(A, 'linux-a'),
    summary(B, 'mac-b', { os: 'darwin' }),
    summary(C, 'pi-c', { state: 'offline', connected: false, lastSeenAt: null }),
  ] as unknown as WorkerSummary[];
  const ov = new Map((OVERVIEW as unknown as WorkerOverview[]).map((o) => [o.id, o] as const));

  it('filters by text, state and ready runtime', () => {
    expect(filterWorkers(ws, ov, { text: 'darwin', state: '', runtime: '' }).map((w) => w.id)).toEqual([B]);
    expect(filterWorkers(ws, ov, { text: '', state: 'offline', runtime: '' }).map((w) => w.id)).toEqual([C]);
    expect(filterWorkers(ws, ov, { text: '', state: '', runtime: 'opencode' }).map((w) => w.id)).toEqual([B]);
    // pin_mismatch is not "ready".
    expect(filterWorkers(ws, ov, { text: '', state: '', runtime: 'claude-code' })).toEqual([]);
  });

  it('sorts by load, state and last seen', () => {
    expect(sortWorkers(ws, ov, 'load').map((w) => w.id)).toEqual([A, B, C]);
    expect(sortWorkers(ws, ov, 'state').map((w) => w.id)).toEqual([A, B, C]);
    expect(sortWorkers(ws, ov, 'seen').at(-1)?.id).toBe(C);
  });

  it('groups by network, biggest first', () => {
    expect(groupByNetwork(ws, ov).map((g) => [g.key, g.workers.length])).toEqual([
      ['192.168.1.0/24', 2],
      ['10.0.0.0/24', 1],
    ]);
  });
});
