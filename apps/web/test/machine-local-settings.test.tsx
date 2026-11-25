// p17-worker-managed Part 2 — Makine → Yapılandırma → Yerel ayarlar: the worker's local settings in the configuration
// document (pins and the value in effect shown per field, pending restarts linked to the restart), runtime paths through
// their owner-only route (machine admin on, step-up), and the machine owner's local limits shown read-only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { configHistory, configView } from '../src/diyalog/harness/screens/w3-machine-config';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const admin: AuthState = { ...owner, user: { id: 'u3', username: 'adm', role: 'admin' } };

const W = 'w2';
const B = `/api/workers/${W}`;

const WORKER = {
  id: W,
  name: 'kestrel-mac',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:x',
  os: 'darwin',
  arch: 'arm64',
  osVersion: '15',
  hostname: 'kestrel-mac',
  workerVersion: '1.1.6',
  runningJobs: 0,
  lastSeenAt: new Date().toISOString(),
  createdAt: '2026-10-01T10:00:00.000Z',
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [],
  credentials: [],
};

/** The harness view with managed settings: pins, values in effect, a pending restart and local vetoes. */
function view(over: { machineAdmin?: boolean; supported?: boolean } = {}): Record<string, unknown> {
  const base = configView(W) as { report: Record<string, unknown> & { effective: Record<string, unknown> } };
  return {
    ...base,
    settings: { supported: over.supported ?? true, machineAdmin: over.machineAdmin ?? false },
    report: {
      ...base.report,
      effective: {
        ...base.report.effective,
        settings: {
          values: {
            updates: { enabled: true, channel: 'stable', healthTimeoutSec: 90 },
            logLevel: 'info',
            telemetry: { otlpEndpoint: null },
            assistant: { disabled: false, maxSessions: 8, sandbox: 'auto' },
            remoteOps: { npmRegistry: null, restartable: null, logFileBytes: 4 * 2 ** 20 },
            packageCaches: { enabled: true },
            probes: { loginRecheckMinutes: null, usageProbeMinutes: null, claudeLockMaxAgeMinutes: null },
            runtimePaths: { codex: { binary: '/opt/homebrew/bin/codex' } },
          },
          pinned: ['updates.channel'],
          pendingRestart: ['updates.enabled'],
        },
      },
      ceiling: {
        ...(base.report.ceiling as Record<string, unknown>),
        allowMachineAdmin: false,
        allowServices: false,
      },
    },
  };
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function stepUpGate(): { gate: (h: Handler) => Handler; route: Record<string, Handler> } {
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
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [WORKER] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    [`GET ${B}`]: ok(WORKER),
    [`GET /api/jobs?worker=${W}&state=RUNNING&limit=20`]: ok({ items: [], nextCursor: null }),
    [`GET ${B}/config`]: ok(view()),
    [`GET ${B}/config/history`]: ok(configHistory()),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

async function openLocal(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const panel = await screen.findByTestId('worker-config-panel');
  await user.click(await within(panel).findByRole('tab', { name: 'Yerel ayarlar' }));
  return within(panel).findByTestId('local-settings');
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

describe('Makine → Yapılandırma → Yerel ayarlar', () => {
  it('shows pins, values in effect, pending restarts and the local limits read-only', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/machines/${W}?tab=configuration`, initialState: owner, routes: routes() });
    const local = await openLocal(user);
    expect(within(local).getByTestId('settings-pending-restart').textContent).toContain('updates.enabled');
    expect(within(local).getByText('yerel dosyada sabit')).toBeTruthy();
    expect(within(local).getAllByText(/Şu an:/).length).toBeGreaterThan(5);
    const ceiling = within(local).getByTestId('local-ceiling');
    expect(ceiling.textContent).toContain('Makine yönetimi');
    expect(ceiling.textContent).toContain('Uzun süren servisler');
    expect(within(ceiling).queryByRole('button')).toBeNull();
    // Runtime paths without machine administration: explained, not editable.
    const paths = within(local).getByTestId('runtime-paths');
    expect(paths.textContent).toContain('makine yönetimini açın');
    expect(within(paths).queryByTestId('runtime-paths-save')).toBeNull();
  });

  it('p22-harness-gaps: a pending restart is named at the top of every machine tab, with the way to the restart', async () => {
    renderApp({ path: `/machines/${W}`, initialState: owner, routes: routes() });
    const banner = await screen.findByTestId('machine-restart-banner');
    expect(banner.textContent).toContain('Makinedeki Remyral yeniden başlatılmalı');
    // The panel's name of the setting, not its path.
    expect(banner.textContent).toContain('Güncellemeleri al');
    expect(within(banner).getByRole('link', { name: 'Yeniden başlat' }).getAttribute('href')).toContain(
      `/machines/${W}`,
    );
  });

  it('p22-harness-gaps: no banner without a pending restart, nor for a viewer', async () => {
    const quiet = view() as { report: { effective: { settings: Record<string, unknown> } } };
    quiet.report.effective.settings = { ...quiet.report.effective.settings, pendingRestart: [] };
    renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({ [`GET ${B}/config`]: ok(quiet) }),
    });
    await screen.findByTestId('worker-config-panel');
    expect(screen.queryByTestId('machine-restart-banner')).toBeNull();
  });

  it('settings travel in the configuration document (step-up)', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({ ...s.route, [`PUT ${B}/config`]: s.gate(ok(view())) }),
    });
    const local = await openLocal(user);
    await user.selectOptions(within(local).getByLabelText('Log seviyesi'), 'debug');
    await user.selectOptions(within(local).getByLabelText('Güncellemeleri al'), 'off');
    await user.type(within(local).getByLabelText('Sağlık bekleme süresi (sn)'), '180');
    await user.selectOptions(within(local).getByLabelText('Telemetri'), 'off');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'PUT' && r.url === `${B}/config` && r.body !== undefined),
      ).toBe(true);
    });
    const body = requests.filter((r) => r.method === 'PUT' && r.url === `${B}/config`).at(-1)?.body as {
      spec: { settings: unknown };
    };
    expect(body.spec.settings).toEqual({
      logLevel: 'debug',
      updates: { enabled: false, healthTimeoutSec: 180 },
      telemetry: { otlpEndpoint: null },
    });
  });

  it('p22-sandbox-settings: the Linux sandbox switches travel in the configuration document', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({ ...s.route, [`PUT ${B}/config`]: s.gate(ok(view())) }),
    });
    const local = await openLocal(user);
    const linux = within(local).getByTestId('settings-linux-sandbox');
    await user.selectOptions(within(linux).getByLabelText('Abonelik işleri paralel (ayrı ev dizini)'), 'on');
    await user.selectOptions(within(linux).getByLabelText('Her işe ayrı ağ'), 'auto');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'PUT' && r.url === `${B}/config` && r.body !== undefined),
      ).toBe(true);
    });
    const body = requests.filter((r) => r.method === 'PUT' && r.url === `${B}/config`).at(-1)?.body as {
      spec: { settings: unknown };
    };
    expect(body.spec.settings).toEqual({
      sandbox: { linuxLoginStoreView: true, linuxPrivateNetwork: 'auto' },
    });
  });

  it('an older machine says it must be updated', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({ [`GET ${B}/config`]: ok(view({ supported: false })) }),
    });
    const panel = await screen.findByTestId('worker-config-panel');
    await user.click(await within(panel).findByRole('tab', { name: 'Yerel ayarlar' }));
    expect(await within(panel).findByTestId('settings-unsupported')).toBeTruthy();
  });

  it('runtime paths: the owner saves them through their own route; an admin only reads', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests, unmount } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({
        ...s.route,
        [`GET ${B}/config`]: ok(view({ machineAdmin: true })),
        [`PUT ${B}/config/runtime-paths`]: s.gate(ok(view({ machineAdmin: true }))),
      }),
    });
    const local = await openLocal(user);
    const paths = within(local).getByTestId('runtime-paths');
    expect(paths.textContent).toContain('/opt/homebrew/bin/codex');
    await user.type(within(paths).getByLabelText('Codex çalıştırılabiliri'), '/usr/local/bin/codex');
    await user.type(
      within(paths).getByLabelText('Pi uzantı dosyaları (satır başına bir)'),
      '/etc/pi/gate.mjs',
    );
    await user.click(within(paths).getByTestId('runtime-paths-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'PUT' && r.url === `${B}/config/runtime-paths`).length).toBe(
        2,
      );
    });
    expect(requests.filter((r) => r.url === `${B}/config/runtime-paths`).at(-1)?.body).toEqual({
      runtimePaths: { codex: { binary: '/usr/local/bin/codex' }, pi: { extensions: ['/etc/pi/gate.mjs'] } },
      expectedGeneration: 3,
    });
    unmount();
    vi.unstubAllGlobals();

    renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: admin,
      routes: routes({ [`GET ${B}/config`]: ok(view({ machineAdmin: true })) }),
    });
    const asAdmin = await openLocal(user);
    const p2 = within(asAdmin).getByTestId('runtime-paths');
    expect(p2.textContent).toContain('yalnız sahip');
    expect(within(p2).queryByTestId('runtime-paths-save')).toBeNull();
  });
});
