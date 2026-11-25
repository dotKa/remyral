// p17-disk-selfclean — Makine → Genel bakış → Kapasite → Disk temizliği: the worker's own cleanup (last run, freed per
// category, what uses the space when it stayed low) and "Şimdi temizle" (admin, step-up, the remote op disk.clean).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOverview } from '../src/api/fleet';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  ADMIN_OPS_W1,
  ADMIN_OVERVIEW_W1,
  ADMIN_VIEW_W1,
  CAPACITY_W1,
} from '../src/diyalog/harness/screens/w3-machine-admin';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const OP = '00000000-0000-4000-8000-0000000000d1';
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const W2 = {
  id: 'w2',
  name: 'kestrel-mac',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w2',
  os: 'linux',
  arch: 'x64',
  osVersion: '6.8',
  hostname: 'kestrel',
  workerVersion: '1.1.3',
  runningJobs: 0,
  lastSeenAt: iso(1000),
  createdAt: iso(86_400_000),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
};

const RUN = {
  trigger: 'low_disk',
  startedAt: '2026-10-25T09:59:00.000Z',
  finishedAt: '2026-10-25T10:00:00.000Z',
  freeBefore: GiB / 4,
  freeAfter: GiB / 2,
  freedBytes: 300 * MiB,
  freed: [
    { category: 'temp', bytes: 200 * MiB, items: 3 },
    { category: 'logs', bytes: 100 * MiB, items: 2 },
  ],
  stillLow: true,
  errors: 1,
  // p17-worker-managed: per-job accounts' folders the worker may not delete, left in place quietly.
  skipped: 2,
};

const REPORT = {
  enabled: true,
  thresholdBytes: 2 * GiB,
  marginBytes: GiB,
  targetBytes: 3 * GiB,
  freeBytes: GiB / 2,
  checkedAt: '2026-10-25T10:00:00.000Z',
  running: false,
  lastRun: RUN,
  nextLowDiskAt: '2026-10-25T10:30:00.000Z',
  nextDailyAt: '2026-10-26T09:00:00.000Z',
  usage: {
    at: '2026-10-25T10:00:00.000Z',
    dataDir: [
      { name: 'runtimes', bytes: 3 * GiB },
      { name: 'other', bytes: 2 * GiB },
    ],
    workspaceRoot: [{ name: 'mirrors', bytes: 30 * GiB }],
  },
  reportedAt: '2026-10-25T10:00:01.000Z',
};

function overview(diskHygiene: unknown): Record<string, unknown> {
  return {
    id: 'w2',
    capacity: { running: 0, max: 3 },
    capabilitiesAt: iso(60_000),
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: { key: 'n', label: '10.0.0.0/24 (private)' },
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: [{ runtime: 'codex', status: 'ready', version: '1', reason: 'ready' }],
    ...ADMIN_OVERVIEW_W1,
    capacityMode: null,
    queue: { profileSlots: null, exclusiveProfiles: [], urgentReserve: 1, urgentReserveAuto: true },
    ...(diskHygiene === undefined ? {} : { diskHygiene }),
  };
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function op(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OP,
    workerId: 'w2',
    kind: 'disk.clean',
    params: {},
    state: 'sent',
    reason: null,
    detail: null,
    progress: null,
    result: null,
    requestedBy: 'u1',
    requestedAt: '2026-10-25T10:05:00.000Z',
    updatedAt: '2026-10-25T10:05:00.000Z',
    finishedAt: null,
    login: null,
    logs: null,
    ...over,
  };
}

function routes(diskHygiene: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
  const empty = {
    generatedAt: iso(0),
    settings: { nearThreshold: 80, notifyNear: true },
    entries: [],
    otherLimits: [],
  };
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W2] }),
    'GET /api/fleet/overview': ok({ workers: [overview(diskHygiene)] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok(empty),
    'GET /api/usage-limits/overview?history=1': ok(empty),
    'GET /api/workers/w2': ok({ ...W2, runtimes: [], credentials: [] }),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w2/ops': ok({ ...ADMIN_OPS_W1, workerId: 'w2' }),
    'GET /api/workers/w2/machine-admin': ok({ ...ADMIN_VIEW_W1, workerId: 'w2' }),
    'GET /api/workers/w2/capacity': ok({ ...CAPACITY_W1, workerId: 'w2' }),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Disk temizliği (p17-disk-selfclean)', () => {
  it('shows the last run per category and, when it stayed low, the space per top-level directory', async () => {
    renderApp({
      path: '/machines/w2',
      initialState: viewer,
      routes: routes({ supported: true, report: REPORT }),
    });
    const panel = await screen.findByTestId('disk-hygiene');
    expect(within(panel).getByText('Açık')).toBeTruthy();
    expect(within(panel).getByTestId('disk-hygiene-state').textContent).toContain('3 GB');
    const last = within(panel).getByTestId('disk-hygiene-last');
    expect(last.textContent).toContain('disk azaldı');
    expect(last.textContent).toContain('300 MB');
    expect(
      within(panel)
        .getAllByTestId('disk-hygiene-freed')
        .map((e) => e.textContent),
    ).toEqual([
      expect.stringContaining('Biten işlerin geçici klasörleri'),
      expect.stringContaining('Eski günlükler'),
    ]);
    expect(last.textContent).toContain('1 öğe silinemedi');
    expect(last.textContent).toContain('2 öğe başka bir hesaba ait');
    const usage = within(panel).getByTestId('disk-usage');
    expect(within(usage).getByTestId('disk-usage-workspace').textContent).toContain('mirrors');
    expect(within(usage).getByTestId('disk-usage-data').textContent).toContain('diğer');
    // A viewer gets no button.
    expect(within(panel).queryByTestId('disk-clean')).toBeNull();
  });

  it('"Şimdi temizle" goes through step-up and shows the operation and its run', async () => {
    let stepped = false;
    const user = userEvent.setup();
    const done = op({
      state: 'succeeded',
      result: { diskClean: { ...RUN, trigger: 'manual', freedBytes: 2 * GiB, stillLow: false, errors: 0 } },
      finishedAt: '2026-10-25T10:05:09.000Z',
    });
    const { requests } = renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes(
        { supported: true, report: REPORT },
        {
          'POST /api/auth/step-up': () => {
            stepped = true;
            return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
          },
          'POST /api/workers/w2/disk/clean': () =>
            stepped
              ? { status: 200, body: op() }
              : {
                  status: 403,
                  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
                },
          [`GET /api/workers/w2/ops/${OP}?after=0`]: ok(done),
        },
      ),
    });
    const panel = await screen.findByTestId('disk-hygiene');
    await user.click(within(panel).getByRole('button', { name: 'Şimdi temizle' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/workers/w2/disk/clean')).toBe(true);
    });
    const line = await within(panel).findByTestId('disk-clean-op', {}, { timeout: 5000 });
    expect(line.textContent).toContain('Disk temizliği');
    await waitFor(
      () => {
        expect(within(panel).getByTestId('disk-hygiene-last').textContent).toContain('elle');
      },
      { timeout: 5000 },
    );
  });

  it('an older worker explains it cannot; older masters (no field) parse as not supported', async () => {
    renderApp({ path: '/machines/w2', initialState: owner, routes: routes(undefined) });
    const panel = await screen.findByTestId('disk-hygiene');
    expect(panel.textContent).toContain('makineyi güncelleyin');
    expect(within(panel).queryByTestId('disk-clean')).toBeNull();
    const [o] = parseOverview({ workers: [overview(undefined)] });
    expect(o?.diskHygiene).toEqual({ supported: false, report: null });
  });
});
