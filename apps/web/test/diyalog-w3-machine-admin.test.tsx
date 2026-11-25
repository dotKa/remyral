// p12-diyalog wave 2 (W3) — Makine → Yönetim (access, restart, machine administration) and Genel bakış → Kapasite
// (parallel jobs, capacity mode, Acil reserve, package caches) rebuilt in the Diyalog language: same requests, the same
// confirmations and step-up, the same role gates; the classic English cards are gone from the Diyalog screen.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  ADMIN_OPS_W1,
  ADMIN_OVERVIEW_W1,
  ADMIN_VIEW_W1,
  CAPACITY_W1,
} from '../src/diyalog/harness/screens/w3-machine-admin';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';
import { findToast } from './toasts';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const admin: AuthState = { ...owner, user: { id: 'u3', username: 'adm', role: 'admin' } };
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const W2 = {
  id: 'w2',
  name: 'kestrel-mac',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w2',
  os: 'darwin',
  arch: 'arm64',
  osVersion: '15',
  hostname: 'kestrel-mac',
  workerVersion: '1.0.41',
  runningJobs: 0,
  lastSeenAt: iso(1000),
  createdAt: iso(86_400_000),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
};

const OVERVIEW_W2 = {
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
  // Manual capacity: the parallel-jobs warning and Apply apply (not under automatic capacity).
  capacityMode: null,
  queue: { profileSlots: null, exclusiveProfiles: [], urgentReserve: 1, urgentReserveAuto: true },
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W2] }),
    'GET /api/fleet/overview': ok({ workers: [OVERVIEW_W2] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/usage-limits/overview?history=1': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/workers/w2': ok({
      ...W2,
      runtimes: [],
      credentials: [
        { fingerprint: 'SHA256:old', status: 'active' },
        { fingerprint: 'SHA256:new', status: 'pending' },
      ],
    }),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w2/ops': ok({ ...ADMIN_OPS_W1, workerId: 'w2' }),
    'GET /api/workers/w2/machine-admin': ok({ ...ADMIN_VIEW_W1, workerId: 'w2' }),
    'GET /api/workers/w2/capacity': ok({ ...CAPACITY_W1, workerId: 'w2' }),
    ...extra,
  };
}

/** Step-up flow of the shell dialog (shared provider): type a code and confirm. */
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

describe('Makine → Yönetim (Diyalog)', () => {
  it('lists the access actions in Turkish with the device keys; revoke needs a second press and step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=admin',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/revoke': () =>
          stepped
            ? { status: 200, body: { ...W2, state: 'quarantined' } }
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
    const access = await screen.findByTestId('machine-access');
    expect(within(access).getByRole('button', { name: 'Boşalt' })).toBeTruthy();
    // A pending rotation: approve the new key instead of starting another rotation.
    expect(within(access).getByRole('button', { name: 'Yeni anahtarı onayla' })).toBeTruthy();
    expect(within(access).queryByRole('button', { name: 'Anahtarı yenile' })).toBeNull();
    const keys = within(access).getByTestId('credential-list');
    expect(keys.textContent).toContain('Etkin');
    expect(keys.textContent).toContain('Onay bekliyor');

    await user.click(within(access).getByRole('button', { name: 'Anahtarı iptal et' }));
    expect(requests.some((r) => r.url.endsWith('/revoke'))).toBe(false);
    await user.click(within(access).getByRole('button', { name: 'İptali onayla' }));
    await stepUp(user);
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w2/revoke')).toHaveLength(
        2,
      );
    });
    // The classic English card is not on the Diyalog screen.
    expect(screen.queryByText('Revoke')).toBeNull();
    expect(screen.queryByText('Machine admin (AI with root / Administrator rights)')).toBeNull();
  });

  // p15-classic-removal: the classic fleet-archive.test, on the Diyalog machine page.
  it('a machine that can never work again leaves the list after a second press, and comes back', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const dead = { ...W2, state: 'quarantined', connected: false, quarantineReason: 'revoked' };
    const archived = { ...dead, archivedAt: iso(0) };
    const detail = (w: Record<string, unknown>) => ({
      ...w,
      runtimes: [],
      credentials: [{ fingerprint: 'SHA256:old', status: 'revoked' }],
    });
    const first = renderApp({
      path: '/machines/w2?tab=admin',
      initialState: owner,
      routes: routes({
        'GET /api/workers': ok({ workers: [dead] }),
        'GET /api/workers/w2': ok(detail(dead)),
        'POST /api/workers/w2/archive': ok(archived),
      }),
    });
    const access = await screen.findByTestId('machine-access');
    await user.click(within(access).getByRole('button', { name: 'Listeden kaldır' }));
    expect(first.requests.some((r) => r.url.endsWith('/archive'))).toBe(false);
    expect(within(access).getByTestId('archive-confirm-note')).toBeTruthy();
    await user.click(within(access).getByRole('button', { name: 'Kaldırmayı onayla' }));
    await waitFor(() => {
      expect(
        first.requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w2/archive'),
      ).toHaveLength(1);
    });
    first.unmount();
    vi.unstubAllGlobals();
    const second = renderApp({
      path: '/machines/w2?tab=admin',
      initialState: owner,
      routes: routes({
        'GET /api/workers': ok({ workers: [archived] }),
        'GET /api/workers?archived=1': ok({ workers: [archived] }),
        'GET /api/workers/w2': ok(detail(archived)),
        'POST /api/workers/w2/unarchive': ok(dead),
      }),
    });
    const again = await screen.findByTestId('machine-access');
    await user.click(within(again).getByRole('button', { name: 'Arşivden çıkar' }));
    await waitFor(() => {
      expect(
        second.requests.filter((r) => r.method === 'POST' && r.url === '/api/workers/w2/unarchive'),
      ).toHaveLength(1);
    });
  });

  it('restarts the worker after a confirming second press, with the drain wait in seconds', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const op = {
      id: 'op-1',
      workerId: 'w2',
      kind: 'service.restart',
      params: {},
      state: 'running',
      reason: null,
      detail: null,
      progress: { step: 'draining' },
      result: null,
      requestedBy: null,
      requestedAt: iso(0),
      updatedAt: iso(0),
      finishedAt: null,
      login: null,
      logs: null,
    };
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=admin',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/restart': ok(op),
        'GET /api/workers/w2/ops/op-1?after=0': ok({ ...op, state: 'succeeded' }),
      }),
    });
    const panel = await screen.findByTestId('worker-restart');
    const minutes = await within(panel).findByLabelText('Şu kadar dakika sonra vazgeç');
    await user.clear(minutes);
    await user.type(minutes, '15');
    await user.click(within(panel).getByRole('button', { name: 'Makine servisini yeniden başlat' }));
    expect(requests.some((r) => r.url.endsWith('/restart'))).toBe(false);
    await user.click(within(panel).getByRole('button', { name: 'Yeniden başlatmayı onayla' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/workers/w2/restart')?.body).toEqual({
        drain: true,
        drainTimeoutSec: 900,
      });
    });
    expect((await within(panel).findByTestId('op-line')).textContent).toContain('Başarılı');
  });

  it('machine administration: commands, memory and the owner switch (two presses, expected generation)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const off = {
      ...ADMIN_VIEW_W1,
      workerId: 'w2',
      desired: { enabled: false, autoApprove: false, generation: 7 },
    };
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=admin',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2/machine-admin': ok(off),
        'PUT /api/workers/w2/machine-admin': ok({
          ...off,
          desired: { enabled: true, autoApprove: false, generation: 8 },
        }),
        'GET /api/workers/w2/machine-admin/commands/cmd-2': ok({
          ...ADMIN_VIEW_W1.commands[1],
          op: { path: 'C:/x.json' },
          output: '{"ok":true}',
          truncated: false,
        }),
      }),
    });
    const section = await screen.findByTestId('machine-admin');
    const cmds = await within(section).findAllByTestId('admin-command');
    expect(cmds).toHaveLength(3);
    expect(cmds[0]?.textContent).toContain('Onay bekliyor');
    await user.click(within(cmds[1] as HTMLElement).getByRole('button', { name: /ayrıntılar/i }));
    expect((await within(section).findByTestId('admin-command-output')).textContent).toBe('{"ok":true}');
    expect(within(section).getByTestId('machine-memory-content').textContent).toContain('Docker Desktop');

    // Off → the first press only warns; the second sends the change with the expected generation.
    expect(within(section).queryByTestId('machine-task-form')).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Makine yönetimini aç…' }));
    expect(await within(section).findByTestId('machine-admin-warning')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await user.click(within(section).getByRole('button', { name: 'Anladım — makine yönetimini aç' }));
    await waitFor(() => {
      expect(
        requests.find((r) => r.method === 'PUT' && r.url === '/api/workers/w2/machine-admin')?.body,
      ).toEqual({
        enabled: true,
        autoApprove: false,
        expectedGeneration: 7,
      });
    });
    // Enabled → the task form appears.
    expect(await within(section).findByTestId('machine-task-form')).toBeTruthy();
  });

  it('starts a machine task and saves the memory with its expected version', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=admin',
      initialState: admin,
      routes: routes({
        'POST /api/workers/w2/machine-admin/tasks': ok({ jobId: 'job-9', state: 'QUEUED' }),
        'PUT /api/workers/w2/machine-memory': ok({ ...ADMIN_VIEW_W1.memory, version: 4 }),
      }),
    });
    const section = await screen.findByTestId('machine-admin');
    // An admin (not owner) cannot switch it.
    expect(await within(section).findByTestId('machine-admin-owner-only')).toBeTruthy();
    expect(within(section).queryByTestId('machine-admin-switch')).toBeNull();

    const form = within(section).getByTestId('machine-task-form');
    await user.type(within(form).getByLabelText('Başlık'), 'Node güncelle');
    await user.type(within(form).getByLabelText('Ajan bu makinede ne yapsın?'), 'Node 24 kur');
    await user.click(within(form).getByRole('button', { name: 'Makine görevini başlat' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/workers/w2/machine-admin/tasks')?.body).toEqual({
        title: 'Node güncelle',
        prompt: 'Node 24 kur',
        approvalPolicy: 'ask-all',
        maxDurationSec: 3600,
      });
    });
    const started = await within(section).findByTestId('machine-task-started');
    expect(within(started).getByRole('link').getAttribute('href')).toBe('/jobs/job-9');

    await user.click(within(section).getByRole('button', { name: 'Hafızayı düzenle' }));
    const area = within(section).getByLabelText('Makine hafızası');
    await user.type(area, '\n- yeni satır');
    await user.click(within(section).getByRole('button', { name: 'Hafızayı kaydet' }));
    await waitFor(() => {
      const body = requests.find((r) => r.url === '/api/workers/w2/machine-memory')?.body as
        { expectedVersion: number; content: string } | undefined;
      expect(body?.expectedVersion).toBe(3);
      expect(body?.content.endsWith('- yeni satır')).toBe(true);
    });
  });

  it('a viewer sees access state but no restart and no machine administration', async () => {
    renderApp({ path: '/machines/w2?tab=admin', initialState: viewer, routes: routes() });
    expect(await screen.findByTestId('machine-access')).toBeTruthy();
    expect(screen.queryByTestId('worker-restart')).toBeNull();
    expect(screen.queryByTestId('machine-admin')).toBeNull();
  });
});

describe('Makine → Genel bakış → Kapasite (Diyalog)', () => {
  it('recommends, warns above it and applies through the managed configuration', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'POST /api/workers/config/bulk': ok({ items: [{ workerId: 'w2', generation: 5, changed: true }] }),
      }),
    });
    const advice = await screen.findByTestId('capacity-advice');
    expect(within(advice).getByTestId('capacity-recommended').textContent).toContain(
      'Önerilen: 2 paralel iş',
    );
    expect(within(advice).getByTestId('capacity-warning').textContent).toContain('3 paralel iş');
    await user.click(within(advice).getByRole('button', { name: '2 paralel işi uygula' }));
    await waitFor(() => {
      const body = requests.find((r) => r.url === '/api/workers/config/bulk')?.body as
        { workerIds: string[]; patch: { maxParallelJobs: number }; changeNote: string } | undefined;
      expect(body?.workerIds).toEqual(['w2']);
      expect(body?.patch).toEqual({ maxParallelJobs: 2 });
      expect(body?.changeNote.startsWith('Capacity advice: ')).toBe(true);
    });
    expect(screen.queryByText('Parallel jobs')).toBeNull();
  });

  it('saves the Acil reserve and shows the package caches', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'PUT /api/workers/w2/urgent-reserve': ok({ urgentReserve: 0, urgentReserveAuto: false }),
      }),
    });
    const slots = await screen.findByTestId('queue-slots-card');
    expect(within(slots).getByTestId('queue-reserve-current').textContent).toContain(
      '1 slot Acil işler için ayrılıyor.',
    );
    await user.selectOptions(within(slots).getByLabelText('Acil ayrımı'), '0');
    // p15-form-pattern: the capacity settings are one form; its sticky bar saves the reserve.
    expect(within(slots).queryByRole('button', { name: 'Ayrımı kaydet' })).toBeNull();
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/workers/w2/urgent-reserve')?.body).toEqual({ reserve: 0 });
    });
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast('Acil ayrımı kaydedildi.')).toBeTruthy();
    const caches = screen.getByTestId('package-caches');
    expect(within(caches).getByTestId('package-caches-summary').textContent).toContain('%63');
    expect(within(caches).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
  });

  it('capacity mode opens on demand and saves the mode with step-up bounds', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const manual = { ...CAPACITY_W1, workerId: 'w2', mode: 'manual', events: [], lastDecision: null };
    const { requests } = renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2/capacity': ok(manual),
        'PUT /api/workers/w2/capacity': ok({ ...manual, mode: 'suggest' }),
      }),
    });
    const mode = await screen.findByTestId('capacity-mode');
    await user.click(within(mode).getByRole('button', { name: 'Kur' }));
    const sentence = await within(screen.getByTestId('capacity-mode')).findByTestId('capacity-mode-sentence');
    expect(sentence.textContent).toContain('Elle:');
    await user.click(screen.getByTestId('capacity-mode-suggest'));
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/workers/w2/capacity')?.body).toEqual({
        mode: 'suggest',
        min: 1,
        max: 4,
      });
    });
  });

  it('a viewer gets the figures without any change control', async () => {
    renderApp({ path: '/machines/w2', initialState: viewer, routes: routes() });
    const advice = await screen.findByTestId('capacity-advice');
    expect(within(advice).queryByRole('button')).toBeNull();
    const slots = await screen.findByTestId('queue-slots-card');
    expect(within(slots).queryByRole('button', { name: 'Ayrımı kaydet' })).toBeNull();
    expect(
      within(screen.getByTestId('capacity-mode')).getByRole('button', { name: 'Ayrıntılar' }),
    ).toBeTruthy();
  });
  it('p17-worker-1-1-1: the agent’s purpose above the command; the helper readiness with its reason', async () => {
    const view = {
      ...ADMIN_VIEW_W1,
      workerId: 'w2',
      reported: {
        ...ADMIN_VIEW_W1.reported,
        helper: 'missing',
        helperReason: 'state_dir_not_traversable',
        helperDetail: 'english fallback',
      },
    };
    renderApp({
      path: '/machines/w2?tab=admin',
      initialState: admin,
      routes: routes({ 'GET /api/workers/w2/machine-admin': ok(view) }),
    });
    const section = await screen.findByTestId('machine-admin');
    const cmds = await within(section).findAllByTestId('admin-command');
    expect(within(cmds[0] as HTMLElement).getByTestId('admin-command-purpose').textContent).toBe(
      'Amaç (ajanın açıklaması, doğrulanmadı): “Docker Desktop’ı en son sürüme güncelle”',
    );
    // Older workers send no purpose: nothing is shown.
    expect(within(cmds[1] as HTMLElement).queryByTestId('admin-command-purpose')).toBeNull();
    expect(within(section).getByTestId('machine-admin-helper').textContent).toBe(
      'Kullanılamıyor — Makine yazılımının hesabı yardımcının yanıt klasörüne (state/machine-admin) erişemiyor; bu sürümün kurulum paketini bir kez root olarak yeniden çalıştırın.',
    );
  });
});
