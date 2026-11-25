// p12-diyalog wave 2 (W3) — machine list leftovers in the Diyalog language: the pairing card (deny through step-up),
// the network map and compatibility views, the bulk configuration change (step-up), sorting, the parallel-jobs facts,
// and `/machines/add` (system picker, verified commands with copy, bundle, admin only). Flag off = classic.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { INSTALLERS } from '../src/diyalog/harness/screens/w3-machine-list';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';
import { findToast } from './toasts';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function worker(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: `SHA256:${id}`,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '1.0.41',
    runningJobs: 0,
    lastSeenAt: iso(1000),
    createdAt: iso(86_400_000),
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    archivedAt: null,
    ...over,
  };
}

function overview(
  id: string,
  running: number,
  max: number,
  cells: [string, string, string?][],
  net = { key: '10.0.0.0/24', label: '10.0.0.0/24 (private)' },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    capacity: { running, max },
    capabilitiesAt: iso(60_000),
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: net,
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: cells.map(([runtime, status, reason]) => ({
      runtime,
      status,
      version: '1.2.3',
      reason: reason ?? status,
    })),
    parallelism: { effective: max, configured: max, localCeiling: null, state: 'panel' },
    advice: null,
    capacityMode: null,
    ...over,
  };
}

const A = worker('w1', 'alpha-box', { lastSeenAt: iso(5000) });
const B = worker('w2', 'bravo-box', { state: 'busy', runningJobs: 2 });
const P = worker('w9', 'nova-lnx-04', {
  state: 'pending',
  connected: false,
  fingerprint: 'SHA256:pendingFP',
  pairingExpiresAt: '2099-10-13T10:10:00.000Z',
});

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [A, B, P] }),
    'GET /api/fleet/overview': ok({
      workers: [
        overview('w1', 0, 4, [
          ['claude-code', 'ready'],
          ['codex', 'not_authenticated', 'codex is not logged in'],
        ]),
        overview(
          'w2',
          2,
          3,
          [['pi', 'ready']],
          { key: 'unknown', label: 'Unknown network' },
          {
            parallelism: { effective: 3, configured: 6, localCeiling: 3, state: 'local_ceiling' },
            advice: {
              recommended: 2,
              limitedBy: 'memory',
              cpuCount: 4,
              memoryBytes: 8,
              reserveBytes: 1,
              perJobBytes: 1,
              byCpu: 4,
              byMemory: 2,
              basis: { runtime: 'pi', peakBytes: 1, perJobBytes: 1, source: 'default', attempts: 0 },
              runtimes: [{ runtime: 'pi', peakBytes: 1, perJobBytes: 1, source: 'default', attempts: 0 }],
            },
          },
        ),
      ],
    }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/projects': ok({ items: [] }),
    'GET /api/installers': ok(INSTALLERS),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Makineler list leftovers (Diyalog)', () => {
  it('shows the pairing card natively and denies through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w9/deny': () =>
          stepped
            ? { status: 200, body: worker('w9', 'nova-lnx-04', { state: 'quarantined' }) }
            : {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
              },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
        },
      }),
    });
    const card = await screen.findByTestId('pending-worker');
    expect(within(card).getByTestId('pending-fingerprint').textContent).toBe('SHA256:pendingFP');
    expect(within(card).getByRole('link', { name: 'nova-lnx-04' }).getAttribute('href')).toBe('/machines/w9');
    // Approve needs a full code; the classic English texts are gone.
    expect(within(card).getByRole<HTMLButtonElement>('button', { name: 'Onayla' }).disabled).toBe(true);
    expect(within(card).queryByText('Approve')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Reddet' }));
    await user.click(within(card).getByTestId('pairing-deny-confirm'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w9/deny')).toHaveLength(2);
    });
  });

  it('map groups machines by network; compatibility lists statuses in words and why not ready', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/machines', initialState: owner, routes: routes() });
    await screen.findAllByTestId('machine-row');
    await user.click(screen.getByRole('tab', { name: 'Ağ haritası' }));
    const groups = await screen.findAllByTestId('network-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain('10.0.0.0/24 (private)');
    expect(groups[0]?.textContent).toContain('1/1 çevrimiçi');
    expect(groups[1]?.textContent).toContain('Bilinmeyen ağ');
    await user.click(screen.getByRole('tab', { name: 'Uyumluluk' }));
    const matrix = await screen.findByTestId('compat-matrix');
    const cells = within(matrix).getAllByTestId('compat-cell');
    const codex = cells.find((c) => c.getAttribute('data-status') === 'not_authenticated');
    expect(codex?.textContent).toContain('Oturum kapalı');
    expect(codex?.getAttribute('title')).toBe('codex is not logged in');
    expect(within(matrix).getByTestId('compat-reasons').textContent).toContain('codex is not logged in');
    expect(screen.queryByText('Why not ready')).toBeNull();
  });

  it('sorts the list, shows the parallel-jobs facts in words', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/machines', initialState: owner, routes: routes() });
    let rows = await screen.findAllByTestId('machine-row');
    expect(rows[0]?.textContent).toContain('alpha-box');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sırala' }), 'load');
    rows = screen.getAllByTestId('machine-row');
    expect(rows[0]?.textContent).toContain('bravo-box');
    const parallel = within(rows[0] as HTMLElement).getByTestId('parallel-jobs');
    expect(parallel.textContent).toContain('yerel dosya sınırı (panel 6)');
    expect(within(rows[0] as HTMLElement).getByTestId('parallel-above').textContent).toContain('önerilen 2');
  });

  it('bulk "Yapılandırmayı değiştir…" applies one patch after step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines',
      initialState: owner,
      routes: routes({
        'POST /api/workers/config/bulk': () =>
          stepped
            ? {
                status: 200,
                body: {
                  items: [
                    { workerId: 'w1', changed: true, generation: 4 },
                    { workerId: 'w2', changed: false, generation: 2 },
                  ],
                },
              }
            : {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
              },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
        },
      }),
    });
    await screen.findAllByTestId('machine-row');
    const bar = screen.getByTestId('bulk-bar');
    expect(
      within(bar).getByRole<HTMLButtonElement>('button', { name: 'Yapılandırmayı değiştir…' }).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'alpha-box seç' }));
    await user.click(screen.getByRole('checkbox', { name: 'bravo-box seç' }));
    await user.click(within(bar).getByRole('button', { name: 'Yapılandırmayı değiştir…' }));
    const panel = await screen.findByTestId('bulk-config');
    const apply = within(panel).getByRole<HTMLButtonElement>('button', { name: 'Seçililere uygula' });
    expect(apply.disabled).toBe(true);
    await user.type(within(panel).getByLabelText('En çok paralel iş'), '2');
    await user.click(apply);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast(/1 makine değişti, 1 makine zaten böyleydi/)).toBeTruthy();
    const sent = requests.filter((r) => r.url === '/api/workers/config/bulk').at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(sent.workerIds).toEqual(['w1', 'w2']);
    expect(sent.patch).toEqual({ maxParallelJobs: 2 });
  });

  it('a viewer has no selection and no bulk bar', async () => {
    renderApp({ path: '/machines', initialState: viewer, routes: routes() });
    await screen.findAllByTestId('machine-row');
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'alpha-box seç' })).toBeNull();
  });
});

describe('/machines/add (Diyalog)', () => {
  it('per system: the verified two-line install with copy, the bundle and its install steps', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/machines/add', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Makine ekle' })).toBeTruthy();
    const commands = await screen.findByTestId('install-commands');
    expect(commands.textContent).toContain('sha256sum -c -');
    expect(commands.textContent).toContain('sudo sh remyral-bootstrap.sh');
    expect(screen.getByRole('link', { name: 'Kurulum paketini indir' }).getAttribute('href')).toBe(
      '/api/installers/1.0.41/linux/kit',
    );
    expect(screen.getByTestId('node-note').textContent).toContain('node-v24.21.0-linux-x64');
    expect(screen.getByTestId('node-note').textContent).toContain('/opt/remyral-worker/node');
    await user.click(screen.getByRole('button', { name: 'Kopyala: Çalıştır' }));
    // userEvent installs a clipboard stub: read back what was copied.
    expect(await navigator.clipboard.readText()).toBe('sudo sh remyral-bootstrap.sh');
    await user.click(screen.getByRole('radio', { name: /Windows x64/ }));
    expect(screen.getByRole('radio', { name: /Windows x64/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('install-commands').textContent).toContain('powershell -NoProfile');
    expect(screen.getByRole('link', { name: 'Kurulum paketini indir' }).getAttribute('href')).toBe(
      '/api/installers/1.0.41/windows/kit',
    );
    expect(screen.getByText(/Expand-Archive remyral-worker-1\.0\.41-windows\.zip/)).toBeTruthy();
    // The classic English page is not rendered.
    expect(screen.queryByRole('heading', { name: 'Add machine' })).toBeNull();
  });

  it('without a public origin the bundle is the way', async () => {
    renderApp({
      path: '/machines/add',
      initialState: owner,
      routes: routes({
        'GET /api/installers': ok({
          ...INSTALLERS,
          publicOrigin: null,
          current: {
            ...INSTALLERS.current,
            kits: INSTALLERS.current.kits.map((k) => ({ ...k, commands: null, kitUrl: null })),
          },
        }),
      }),
    });
    expect(await screen.findByText(/PUBLIC_ORIGIN ayarlı değil/)).toBeTruthy();
    expect(screen.queryByTestId('install-commands')).toBeNull();
  });

  it('a viewer is told only owners / admins add machines (no installer request)', async () => {
    const { requests } = renderApp({ path: '/machines/add', initialState: viewer, routes: routes() });
    expect(await screen.findByTestId('add-machine-admin-only')).toBeTruthy();
    expect(requests.some((r) => r.url === '/api/installers')).toBe(false);
  });
});
