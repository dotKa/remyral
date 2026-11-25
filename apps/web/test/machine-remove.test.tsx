// p17-worker-managed Parts 3 and 4 — Makine → Yönetim: "Makineden kaldır" (second press, always-fresh step-up, purge
// choice, queued for an offline machine and cancellable, a refusal / older build with the kit's manual command), the
// owner's machine-admin helper install, and the rootless Docker setup job (Linux, machine admin on).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { ADMIN_OPS_W1, ADMIN_VIEW_W1 } from '../src/diyalog/harness/screens/w3-machine-admin';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const admin: AuthState = { ...owner, user: { id: 'u3', username: 'adm', role: 'admin' } };

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const W = {
  id: 'w5',
  name: 'pi-garage',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w5',
  os: 'linux',
  arch: 'arm64',
  osVersion: '13',
  hostname: 'pi-garage',
  workerVersion: '1.1.6',
  runningJobs: 0,
  lastSeenAt: iso(1000),
  createdAt: iso(86_400_000),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
};

const MANUAL = ['sudo ./uninstall.sh   # in the installer kit folder'];

function removal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId: 'w5',
    os: 'linux',
    supported: true,
    connected: true,
    revoked: false,
    removal: null,
    manual: MANUAL,
    ...over,
  };
}

function record(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    purge: false,
    state,
    opId: null,
    opState: null,
    reason: null,
    detail: null,
    requestedBy: 'u1',
    requestedAt: iso(1000),
    updatedAt: iso(1000),
    finishedAt: null,
    ...extra,
  };
}

const OP = {
  id: '00000000-0000-4000-8000-0000000000c1',
  workerId: 'w5',
  kind: 'helper.manage',
  params: { action: 'admin_helper.install' },
  state: 'sent',
  reason: null,
  detail: null,
  progress: null,
  result: null,
  requestedBy: 'u1',
  requestedAt: iso(0),
  updatedAt: iso(0),
  finishedAt: null,
  login: null,
  logs: null,
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function gate(): { gate: (h: Handler) => Handler; route: Record<string, Handler> } {
  let done = false;
  return {
    gate: (h) => (req) =>
      done
        ? h(req)
        : {
            status: 403,
            body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
          },
    route: {
      'POST /api/auth/step-up': () => {
        done = true;
        return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
      },
    },
  };
}

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
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': usage,
    'GET /api/usage-limits/overview?history=1': usage,
    'GET /api/workers/w5': ok({ ...W, runtimes: [], credentials: [] }),
    'GET /api/jobs?worker=w5&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w5/ops': ok({ ...ADMIN_OPS_W1, workerId: 'w5' }),
    'GET /api/workers/w5/machine-admin': ok({ ...ADMIN_VIEW_W1, workerId: 'w5', activeJob: null }),
    'GET /api/workers/w5/remove': ok(removal()),
    ...extra,
  };
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
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

describe('Makine → Yönetim → Makineden kaldır', () => {
  it('second press, step-up, purge chosen; the state is shown afterwards', async () => {
    const s = gate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w5?tab=admin',
      initialState: admin,
      routes: routes({
        ...s.route,
        'POST /api/workers/w5/remove': s.gate(ok(removal({ removal: record('sent', { purge: true }) }))),
      }),
    });
    const panel = await screen.findByTestId('machine-remove');
    await user.click(within(panel).getByLabelText(/Verileri de sil/));
    await user.click(within(panel).getByTestId('remove-worker'));
    expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/remove'))).toBe(false);
    await user.click(within(panel).getByTestId('remove-confirm'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(within(panel).getByTestId('removal-state').textContent).toContain('Makineye gönderildi');
    });
    expect(
      requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w5/remove').at(-1)?.body,
    ).toEqual({
      purge: true,
    });
  });

  it('an older build shows the kit’s manual uninstall instead of the button', async () => {
    renderApp({
      path: '/machines/w5?tab=admin',
      initialState: admin,
      routes: routes({ 'GET /api/workers/w5/remove': ok(removal({ supported: false })) }),
    });
    const panel = await screen.findByTestId('machine-remove');
    expect(within(panel).getByTestId('removal-manual').textContent).toContain('uninstall.sh');
    expect(within(panel).queryByTestId('remove-worker')).toBeNull();
  });

  it('a refusal shows the reason and the manual command; a queued removal can be cancelled', async () => {
    const r1 = renderApp({
      path: '/machines/w5?tab=admin',
      initialState: admin,
      routes: routes({
        'GET /api/workers/w5/remove': ok(
          removal({
            removal: record('refused', { reason: 'helper_unavailable', detail: 'no privileged updater' }),
          }),
        ),
      }),
    });
    const refused = await screen.findByTestId('machine-remove');
    expect(within(refused).getByTestId('removal-state').textContent).toContain('helper_unavailable');
    expect(within(refused).getByTestId('removal-manual')).toBeTruthy();
    r1.unmount();
    vi.unstubAllGlobals();
    stubCookies('__Host-ras-csrf=csrf-1');

    const s = gate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w5?tab=admin',
      initialState: admin,
      routes: routes({
        ...s.route,
        'GET /api/workers/w5/remove': ok(removal({ connected: false, removal: record('requested') })),
        'DELETE /api/workers/w5/remove': s.gate(
          ok(removal({ connected: false, removal: record('cancelled') })),
        ),
      }),
    });
    const queued = await screen.findByTestId('machine-remove');
    expect(within(queued).getByTestId('removal-state').textContent).toContain('bağlanınca');
    await user.click(within(queued).getByTestId('remove-cancel'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'DELETE' && r.url === '/api/workers/w5/remove'),
      ).toHaveLength(2);
    });
  });
});

describe('Makine yönetimi: helper and rootless Docker', () => {
  it('the owner installs the helper (step-up); the operation is followed', async () => {
    const s = gate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w5?tab=admin',
      initialState: owner,
      routes: routes({
        ...s.route,
        'POST /api/workers/w5/machine-admin/helper': s.gate(ok(OP)),
        [`GET /api/workers/w5/ops/${OP.id}?after=0`]: ok({ ...OP, state: 'succeeded' }),
      }),
    });
    const section = await screen.findByTestId('machine-admin-helper-manage');
    await user.click(within(section).getByTestId('helper-install'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(within(section).getByTestId('helper-op')).toBeTruthy();
    });
    expect(
      requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w5/machine-admin/helper').at(-1)
        ?.body,
    ).toEqual({
      action: 'install',
    });
  });

  it('an admin sees no helper buttons but starts the rootless Docker job on Linux', async () => {
    const s = gate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w5?tab=admin',
      initialState: admin,
      routes: routes({
        ...s.route,
        'POST /api/workers/w5/machine-admin/tasks': s.gate(() => ({
          status: 201,
          body: { jobId: 'job-d1', state: 'QUEUED' },
        })),
      }),
    });
    const section = await screen.findByTestId('machine-admin-helper-manage');
    expect(within(section).queryByTestId('helper-install')).toBeNull();
    await user.click(within(section).getByTestId('rootless-docker'));
    await confirmStepUp(user);
    expect(await within(section).findByTestId('rootless-docker-started')).toBeTruthy();
    expect(
      requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w5/machine-admin/tasks').at(-1)
        ?.body,
    ).toEqual({
      title: '',
      prompt: '',
      setup: 'rootless-docker',
    });
  });
});
