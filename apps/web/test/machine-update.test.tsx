// p17-worker-managed Part 1 — Makine → Yönetim → Sürüm: the updater's last result is shown prominently (a silent
// rollback such as 1.1.4 → 1.1.3 with its reason and the updater's line), the machine list marks it ("geri alındı"), and
// owners/admins change the channel, pin, roll back (second press) and retry — each POST /workers/:id/update with step-up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { compareVersions } from '../src/screens/fleet/releaseVersion';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const W = {
  id: 'w9',
  name: 'windows-worker-1',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w9',
  os: 'win32',
  arch: 'x64',
  osVersion: '11',
  hostname: 'windows-worker-1',
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

const DETAIL =
  '1.1.4 did not connect and heartbeat within 90 s; 1.1.3 restored and healthy (health_check_failed … restored)';

const OVERVIEW = {
  id: 'w9',
  capacity: { running: 0, max: 2 },
  capabilitiesAt: iso(60_000),
  sandboxProfiles: [],
  sandboxReadiness: [],
  tools: [],
  load: null,
  network: { key: 'n', label: '10.0.0.0/24 (private)' },
  runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
  release: {
    channel: 'stable',
    targetVersion: null,
    lastAttempt: {
      id: 'a1',
      toVersion: '1.1.4',
      fromVersion: '1.1.3',
      status: 'rolled_back',
      reason: 'health_check_failed',
      detail: DETAIL,
      rollback: false,
      hasDiagnostics: true,
      at: iso(3_600_000),
    },
    previousVersion: '1.1.2',
  },
  compatibility: [{ runtime: 'codex', status: 'ready', version: '1', reason: 'ready' }],
};

const RELEASES = {
  releases: ['1.1.2', '1.1.3', '1.1.4'].map((version) => ({
    version,
    channel: 'stable',
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    keyId: 'k',
    protocolVersions: ['1.0'],
    minNode: '24.0.0',
    builtAt: iso(0),
    uploadedAt: iso(0),
  })),
  channels: [],
  attempts: [],
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const usage = ok({
    generatedAt: iso(0),
    settings: { nearThreshold: 80, notifyNear: true },
    entries: [],
    otherLimits: [],
  });
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W] }),
    'GET /api/workers?archived=1': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [OVERVIEW] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': usage,
    'GET /api/usage-limits/overview?history=1': usage,
    'GET /api/workers/w9': ok({ ...W, runtimes: [], credentials: [] }),
    'GET /api/jobs?worker=w9&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/releases': ok(RELEASES),
    ...extra,
  };
}

async function stepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('release versions in the browser', () => {
  it('orders like semver', () => {
    expect(compareVersions('1.1.3', '1.1.4')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.1.4-rc.1', '1.1.4')).toBe(-1);
    expect(compareVersions('1.1.4', '1.1.4')).toBe(0);
    expect(compareVersions('garbage', '1.0.0')).toBe(0);
  });
});

describe('Makine → Yönetim → Sürüm', () => {
  it('shows a rollback prominently with the reason and the updater line', async () => {
    renderApp({ path: '/machines/w9?tab=admin', initialState: owner, routes: routes() });
    const panel = await screen.findByTestId('machine-update');
    const last = within(panel).getByTestId('update-last-result');
    expect(last.textContent).toContain('Geri alındı');
    expect(last.textContent).toContain('1.1.3 → 1.1.4');
    expect(last.textContent).toContain('health_check_failed');
    expect(within(panel).getByTestId('update-last-detail').textContent).toContain('restored and healthy');
    expect(last.getAttribute('role')).toBe('alert');
  });

  it('roll back needs a second press and step-up; the body pins the previous version as a rollback', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepUpDone = false;
    const { requests } = renderApp({
      path: '/machines/w9?tab=admin',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w9/update': () =>
          stepUpDone
            ? {
                status: 202,
                body: {
                  workerId: 'w9',
                  channel: 'stable',
                  targetVersion: '1.1.2',
                  rollback: true,
                  force: false,
                },
              }
            : {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
              },
        'POST /api/auth/step-up': () => {
          stepUpDone = true;
          return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
        },
      }),
    });
    const panel = await screen.findByTestId('machine-update');
    await user.click(within(panel).getByTestId('update-rollback'));
    expect(requests.some((r) => r.url === '/api/workers/w9/update')).toBe(false);
    await user.click(within(panel).getByTestId('update-rollback-confirm'));
    await stepUp(user);
    await waitFor(() => {
      expect(within(panel).getByTestId('update-done')).toBeTruthy();
    });
    const bodies = requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w9/update');
    expect(bodies.at(-1)?.body).toEqual({ channel: 'stable', version: '1.1.2', rollback: true });
  });

  it('retry re-sends the failed version; pinning an older version is sent as a rollback', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const accepted = {
      status: 202,
      body: { workerId: 'w9', channel: 'stable', targetVersion: '1.1.4', rollback: false, force: false },
    };
    const { requests } = renderApp({
      path: '/machines/w9?tab=admin',
      initialState: { ...owner, session: null },
      routes: routes({
        'GET /api/auth/session': ok(sessionBody({ stepUpValidUntil: '2099-10-13T10:10:00.000Z' })),
        'POST /api/workers/w9/update': () => accepted,
      }),
    });
    const panel = await screen.findByTestId('machine-update');
    await user.click(within(panel).getByTestId('update-retry'));
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w9/update')).toHaveLength(
        1,
      );
    });
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ channel: 'stable', version: '1.1.4' });

    await waitFor(() => {
      expect(within(panel).getByRole('option', { name: '1.1.2' })).toBeTruthy();
    });
    await user.selectOptions(within(panel).getByLabelText('Sürüme sabitle'), '1.1.2');
    expect(within(panel).getByText(/çalışandan eski/)).toBeTruthy();
    await user.click(within(panel).getByTestId('update-pin'));
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w9/update')).toHaveLength(
        2,
      );
    });
    expect(requests.filter((r) => r.method === 'POST').at(-1)?.body).toEqual({
      channel: 'stable',
      version: '1.1.2',
      rollback: true,
    });
  });

  it('viewers see the result but no controls', async () => {
    renderApp({ path: '/machines/w9?tab=admin', initialState: viewer, routes: routes() });
    const panel = await screen.findByTestId('machine-update');
    expect(within(panel).getByTestId('update-last-result')).toBeTruthy();
    expect(within(panel).queryByTestId('update-actions')).toBeNull();
  });

  it('the machine list marks a rolled-back update', async () => {
    renderApp({ path: '/machines', initialState: owner, routes: routes() });
    const badge = await screen.findByTestId('machine-update-trouble');
    expect(badge.textContent).toContain('geri alındı');
    expect(badge.getAttribute('href')).toBe('/machines/w9?tab=admin');
  });
});
