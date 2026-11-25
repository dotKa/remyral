// p12-diyalog Faz 4 — Makineler: the machine list and the machine page in the Diyalog language (flag on), reusing
// the classic fleet rules and panels; flag off keeps the classic pages.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import type { WorkerOverview } from '../src/api/fleet';
import type { QuotaPause } from '../src/api/quotas';
import type { WorkerDetail } from '../src/api/workers';
import { isKnownReason, parseReason } from '../src/lib/reasons';
import { groupMachineReasons, machineReasons } from '../src/screens/fleet/machineTabs';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

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

function overview(id: string, running: number, max: number, runtimes: string[]): Record<string, unknown> {
  return {
    id,
    capacity: { running, max },
    capabilitiesAt: iso(60_000),
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: { key: 'n', label: '10.0.0.0/24 (private)' },
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: runtimes.map((r) => ({ runtime: r, status: 'ready', version: '1', reason: 'ready' })),
  };
}

const W1 = worker('w1', 'atlas-win-01', { os: 'windows', state: 'busy', runningJobs: 2 });
const W2 = worker('w2', 'kestrel-mac', { os: 'darwin', arch: 'arm64', runningJobs: 1 });
const W4 = worker('w4', 'ridge-lnx-03', {
  connected: false,
  state: 'offline',
  lastSeenAt: iso(2 * 3_600_000),
});

const USAGE = {
  generatedAt: iso(0),
  settings: { nearThreshold: 80, notifyNear: true },
  entries: [
    {
      workerId: 'w2',
      workerName: 'kestrel-mac',
      workerState: 'online',
      runtime: 'claude-code',
      auth: 'subscription',
      store: 'default',
      source: 'probe',
      plan: 'max',
      available: true,
      observedAt: iso(60_000),
      stale: false,
      reports: true,
      level: 'near',
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          label: null,
          usedPercent: 84,
          windowMinutes: 300,
          resetsAt: iso(-56 * 60_000),
          status: null,
          level: 'near',
          history: [
            { at: iso(20 * 3_600_000), usedPercent: 10 },
            { at: iso(8 * 3_600_000), usedPercent: 40 },
            { at: iso(60_000), usedPercent: 84 },
          ],
        },
      ],
      limit: null,
    },
  ],
  otherLimits: [],
};

const RUNNING = {
  id: 'job-7',
  project: 'mobil-app',
  projectKind: 'repo',
  state: 'RUNNING',
  runtime: 'claude-code',
  title: 'Flaky login testini düzelt',
  attempts: 1,
  workerId: 'w2',
  createdBy: { type: 'user', id: 'u1' },
  createdAt: iso(600_000),
  stateChangedAt: iso(300_000),
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W1, W2, W4] }),
    'GET /api/fleet/overview': ok({
      workers: [
        {
          ...overview('w1', 2, 3, ['codex']),
          // p15-merge-approvals item 4: free disk below the machine's minimum.
          load: {
            cpuPercent: 10,
            memoryFreeBytes: 2 ** 30,
            diskFreeBytes: 19.3 * 2 ** 30,
            workspaceDisk: { freeBytes: 19.3 * 2 ** 30, minFreeBytes: 20 * 2 ** 30 },
          },
        },
        overview('w2', 1, 4, ['claude-code', 'codex']),
        overview('w4', 0, 4, ['pi']),
      ],
    }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok(USAGE),
    'GET /api/usage-limits/overview?history=1': ok(USAGE),
    'GET /api/workers/w2': ok({ ...W2, runtimes: [], credentials: [] }),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [RUNNING], nextCursor: null }),
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

describe('Makineler list (Diyalog)', () => {
  it('lists machines with state in words, slot cells, ready runtimes and the add action', async () => {
    renderApp({ path: '/machines', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Makineler' })).toBeTruthy();
    const rows = await screen.findAllByTestId('machine-row');
    expect(rows).toHaveLength(3);
    const kestrel = rows.find((r) => r.textContent.includes('kestrel-mac'));
    expect(kestrel).toBeTruthy();
    expect(
      within(kestrel as HTMLElement)
        .getByRole('link', { name: 'kestrel-mac' })
        .getAttribute('href'),
    ).toBe('/machines/w2');
    const ridge = rows.find((r) => r.textContent.includes('ridge-lnx-03')) as HTMLElement;
    expect(within(ridge).getByTestId('worker-state').textContent).toBe('Kapalı');
    expect(within(ridge).getByRole('img', { name: 'ridge-lnx-03: kapalı' })).toBeTruthy();
    expect(
      within(kestrel as HTMLElement).getByRole('img', { name: 'kestrel-mac: 1 / 4 slot dolu' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Makine ekle' }).getAttribute('href')).toBe('/machines/add');
    // The Diyalog screen replaced the classic page (its English heading is not there).
    expect(screen.queryByRole('heading', { level: 1, name: 'Machines' })).toBeNull();
  });

  it('filters by search text and state', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/machines', initialState: owner, routes: routes() });
    await screen.findAllByTestId('machine-row');
    await user.type(screen.getByRole('searchbox', { name: 'Ara' }), 'kestrel');
    await waitFor(() => {
      expect(screen.getAllByTestId('machine-row')).toHaveLength(1);
    });
    await user.clear(screen.getByRole('searchbox', { name: 'Ara' }));
    await user.type(screen.getByRole('searchbox', { name: 'Ara' }), 'nothing-like-this');
    expect(await screen.findByTestId('fleet-no-match')).toBeTruthy();
  });

  it('p17-ui-review: a machine whose runtimes need the user says so in the list, linked to its page', async () => {
    renderApp({
      path: '/machines',
      initialState: owner,
      routes: routes({
        'GET /api/fleet/overview': ok({
          workers: [
            {
              ...overview('w1', 2, 3, ['codex']),
              compatibility: [
                { runtime: 'codex', status: 'ready', version: '1', reason: 'ready' },
                { runtime: 'pi', status: 'pin_mismatch', version: '1', reason: 'installed 1, pinned 2' },
                { runtime: 'opencode', status: 'not_authenticated', version: '1', reason: 'not logged in' },
              ],
            },
            overview('w2', 1, 4, ['claude-code', 'codex']),
          ],
        }),
      }),
    });
    const pill = await screen.findByTestId('machine-runtime-issues');
    expect(pill.textContent).toBe('2 runtime dikkat istiyor');
    expect(pill.getAttribute('href')).toBe('/machines/w1');
    expect(screen.getAllByTestId('machine-runtime-issues')).toHaveLength(1);
  });

  it('a viewer gets no add action', async () => {
    renderApp({ path: '/machines', initialState: viewer, routes: routes() });
    await screen.findAllByTestId('machine-row');
    expect(screen.queryByRole('link', { name: 'Makine ekle' })).toBeNull();
  });
});

describe('machineReasons (p17-ui-review)', () => {
  it('says nothing in free English text: every reason is a catalog code or a page-local reason', () => {
    const w = { ...worker('w9', 'lnx-9'), runtimes: [], credentials: [] } as unknown as WorkerDetail;
    const o = {
      ...overview('w9', 0, 2, []),
      capabilitiesAt: null,
      compatibility: [
        { runtime: 'codex', status: 'pin_mismatch', version: '1', reason: 'installed 1, pinned 2' },
        { runtime: 'pi', status: 'pin_mismatch', version: '1', reason: 'installed 1, pinned 2' },
        { runtime: 'opencode', status: 'not_authenticated', version: '1', reason: 'not logged in' },
      ],
      runtimePolicy: { assigned: null, effective: 'strict', version: 2, stage: 'active', inSync: false },
      release: {
        channel: 'stable',
        targetVersion: null,
        lastAttempt: { toVersion: '1.0.42', status: 'rolled_back', reason: 'health_check', detail: 'x' },
      },
    } as unknown as WorkerOverview;
    const pause = {
      id: 'p1',
      scope: 'worker_runtime',
      workerId: 'w9',
      runtime: 'codex',
      accountId: null,
      workers: ['w9'],
      pausedAt: iso(0),
      resumeAt: iso(-60_000),
    } as QuotaPause;
    const reasons = machineReasons(w, o, [pause]);
    expect(reasons.length).toBeGreaterThanOrEqual(6);
    for (const r of reasons) {
      const code = parseReason(r.reason).code;
      expect(r.local !== undefined || (code !== null && isKnownReason(code)), r.reason).toBe(true);
    }
    // The two pin mismatches share one card; the rest stay one card each.
    const cards = groupMachineReasons(reasons);
    expect(cards.flatMap((c) => (c.kind === 'group' ? [c.items.length] : []))).toEqual([2]);
    expect(cards).toHaveLength(reasons.length - 1);
  });
});

describe('Makine page (Diyalog)', () => {
  it('shows slots with running jobs (thread links), limit windows with a 24 h sparkline and the near mark', async () => {
    renderApp({ path: '/machines/w2', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'kestrel-mac' })).toBeTruthy();
    const slots = await screen.findByTestId('machine-slots-panel');
    const link = await within(slots).findByRole('link', { name: "Flaky login testini düzelt: thread'de aç" });
    expect(link.getAttribute('href')).toBe('/jobs/job-7');
    const limits = await screen.findByTestId('machine-limit-claude-code');
    const meter = within(limits).getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('84');
    expect(within(limits).getByRole('img', { name: /son 24 saat: %10 → %84/ })).toBeTruthy();
    expect(limits.getAttribute('data-level')).toBe('near');
  });

  it('p15-merge-approvals: warns when the workspace disk is below the minimum, with the setting to change', async () => {
    renderApp({
      path: '/machines/w1',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w1': ok({ ...W1, runtimes: [], credentials: [] }),
        'GET /api/jobs?worker=w1&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
      }),
    });
    const disk = await screen.findByTestId('workspace-disk');
    expect(disk.textContent).toContain('19,3 GiB boş · en az 20,0 GiB isteniyor');
    expect(disk.textContent).toContain('bu makineye iş verilmiyor');
    const fix = within(disk).getByRole('link', { name: 'Yapılandırma → En az boş disk' });
    expect(fix.getAttribute('href')).toContain('configuration');
  });

  it('p17-chat-reconnect: lists the recent connection drops with the cause the machine reported', async () => {
    renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2': ok({
          ...W2,
          runtimes: [],
          credentials: [],
          disconnects: [
            {
              at: iso(60_000),
              receivedAt: iso(59_000),
              cause: 'pong_timeout',
              pongWaitMs: 10_012,
              loopDelayMaxMs: 41,
              connectedMs: 900_000,
            },
            {
              at: iso(3_600_000),
              receivedAt: iso(3_599_000),
              cause: 'socket_error',
              detail: 'read ECONNRESET',
            },
            {
              at: iso(7_200_000),
              receivedAt: iso(7_199_000),
              cause: 'pong_timeout',
              pongWaitMs: 21_400,
              loopDelayMaxMs: 12_800,
            },
            { at: iso(9_000_000), receivedAt: iso(8_999_000), cause: 'closed', code: 1006 },
          ],
        }),
      }),
    });
    const list = await screen.findByTestId('machine-disconnects');
    expect(screen.getByText('Son bağlantı kopmaları')).toBeTruthy();
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-cause'))).toEqual([
      'pong_timeout',
      'socket_error',
      'pong_timeout',
      'closed',
    ]);
    expect(items[0]?.textContent).toContain('master pinge yanıt vermedi');
    expect(items[0]?.textContent).toContain('10.012 ms beklendi');
    expect(items[0]?.textContent).toContain('büyük olasılıkla ağ kopması');
    expect(items[1]?.textContent).toContain('soket hatası · read ECONNRESET');
    expect(items[2]?.textContent).toContain('olay döngüsü gecikmesi en çok 12.800 ms');
    expect(items[2]?.textContent).toContain('makine takıldı');
    expect(items[3]?.textContent).toContain('master ya da aradaki vekil kapattı · kod 1006');
  });

  it('p17-chat-reconnect: no drops reported (or an older master) — no row', async () => {
    renderApp({ path: '/machines/w2', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'kestrel-mac' })).toBeTruthy();
    await screen.findByTestId('release-state');
    expect(screen.queryByTestId('machine-disconnects')).toBeNull();
  });

  it('p17-ui-review: groups runtimes with the same problem into one card, says the policy in Turkish, capacity is one line', async () => {
    const pin = (runtime: string): Record<string, unknown> => ({
      runtime,
      status: 'pin_mismatch',
      version: '2.1.0',
      reason: 'installed 2.1.0, pinned 2.2.1 (ADR-0012): install the pinned version',
    });
    renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'GET /api/fleet/overview': ok({
          workers: [
            {
              ...overview('w2', 1, 4, ['codex']),
              compatibility: [
                { runtime: 'codex', status: 'ready', version: '1', reason: 'ready' },
                pin('opencode'),
                pin('pi'),
                pin('claude-code'),
              ],
              runtimePolicy: {
                assigned: 'strict',
                effective: 'strict',
                version: 4,
                stage: 'active',
                inSync: false,
              },
              capacityMode: { mode: 'auto', slots: 2, min: 1, max: 4, suggestion: null },
            },
          ],
        }),
      }),
    });
    const panel = await screen.findByTestId('machine-reasons');
    const groups = within(panel).getAllByTestId('machine-reason-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain('kestrel-mac makinesinde 3 runtime sabitlenen sürümde değil.');
    expect(within(groups[0] as HTMLElement).getAllByRole('link', { name: 'Sabit sürümü kur' })).toHaveLength(
      1,
    );
    const policy = within(panel).getByTestId('machine-reason-policy');
    expect(policy.textContent).toContain('Makine runtime politikasını henüz uygulamadı.');
    expect(policy.textContent).not.toMatch(/runtime policy yet/);
    expect(
      within(policy).getByRole('link', { name: 'Runtime politikasını aç' }).getAttribute('href'),
    ).toContain('tab=sandbox');
    // One pin card + the policy note: the panel counts cards, not runtimes.
    expect(within(panel).getByLabelText('2 konu')).toBeTruthy();
    expect((await screen.findByTestId('machine-capacity-summary')).textContent).toBe(
      '2 paralel iş · Otomatik',
    );
  });

  it('keeps the classic tab ids: ?tab=admin opens Yönetim; Boşalt sends the classic drain', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let drained = false;
    const online = (): Record<string, unknown> => ({
      ...W2,
      state: drained ? 'draining' : 'online',
      drainRequestedAt: drained ? iso(0) : null,
      runtimes: [],
      credentials: [],
    });
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2': () => ({ status: 200, body: online() }),
        'POST /api/workers/w2/drain': () => {
          drained = true;
          return { status: 200, body: online() };
        },
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'kestrel-mac' });
    await user.click(screen.getByRole('tab', { name: 'Yönetim' }));
    const details = await screen.findByTestId('worker-details');
    expect(details.getAttribute('data-tab')).toBe('admin');
    await user.click(within(details).getByRole('button', { name: 'Boşalt' }));
    expect(requests.some((r) => r.url === '/api/workers/w2/drain')).toBe(false);
    await user.click(within(details).getByRole('button', { name: 'Boşaltmayı onayla' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/workers/w2/drain')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('worker-state')[0]?.getAttribute('data-state')).toBe('draining');
    });
  });

  it('a pending machine is approved with the pairing code after step-up (Diyalog pairing card)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let approved = false;
    let stepUpDone = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w9',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w9': () => ({
          status: 200,
          body: approved
            ? { ...worker('w9', 'nova-lnx-04'), runtimes: [], credentials: [] }
            : {
                ...worker('w9', 'nova-lnx-04', {
                  state: 'pending',
                  connected: false,
                  pairingExpiresAt: '2099-10-13T10:10:00.000Z',
                }),
                runtimes: [],
                credentials: [],
              },
        }),
        'GET /api/workers/w9/history': ok({ items: [] }),
        'GET /api/jobs?worker=w9&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
        'POST /api/workers/w9/approve': () => {
          if (!stepUpDone)
            return {
              status: 403,
              body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
            };
          approved = true;
          return { status: 200, body: worker('w9', 'nova-lnx-04') };
        },
        'POST /api/auth/step-up': () => {
          stepUpDone = true;
          return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
        },
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'nova-lnx-04' });
    await user.click(within(screen.getByTestId('page-actions')).getByRole('button', { name: 'Onayla…' }));
    const code = await screen.findByLabelText('Makinenin gösterdiği eşleşme kodu');
    await waitFor(() => {
      expect(document.activeElement).toBe(code);
    });
    await user.type(code, 'abcd-efgh');
    await user.click(within(screen.getByTestId('pending-worker')).getByRole('button', { name: 'Onayla' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId('worker-state')[0]?.getAttribute('data-state')).toBe('online');
    });
    expect(requests.filter((r) => r.url.endsWith('/approve')).at(-1)?.body).toEqual({
      pairingCode: 'ABCD-EFGH',
    });
  });

  it('an unknown machine says so with a way back', async () => {
    renderApp({
      path: '/machines/nope',
      initialState: owner,
      routes: routes({
        'GET /api/workers/nope': () => ({ status: 404, body: { error: 'not_found', message: 'Not found.' } }),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Makine bulunamadı' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tüm makineler' }).getAttribute('href')).toBe('/machines');
  });
});

describe('parity (no classic feature lost)', () => {
  it('old deep links (?worker=&section=) still open the machine tab; archived machines on demand', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines',
      initialState: owner,
      routes: routes({
        'GET /api/workers?archived=1': ok({
          workers: [worker('w8', 'old-box', { archivedAt: iso(86_400_000), connected: false })],
        }),
      }),
    });
    await screen.findAllByTestId('machine-row');
    await user.click(screen.getByRole('checkbox', { name: 'Arşivdekileri göster' }));
    const archived = await screen.findByTestId('archived-list');
    expect(archived.textContent).toContain('old-box');
    expect(requests.some((r) => r.url === '/api/workers?archived=1')).toBe(true);
  });

  it('?worker=<id>&section=<card> redirects to the machine page tab', async () => {
    renderApp({ path: '/machines?worker=w2&section=machine-admin', initialState: owner, routes: routes() });
    const details = await screen.findByTestId('worker-details');
    expect(details.getAttribute('data-tab')).toBe('admin');
  });
});

describe('machine name (p15-chat-cards-scroll item 4)', () => {
  it('an admin renames the machine in place; the title, the list and the hostname line follow', async () => {
    const user = userEvent.setup();
    let current: Record<string, unknown> = { ...W2, label: null };
    const { requests } = renderApp({
      path: '/machines/w2',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2': () => ({ status: 200, body: { ...current, runtimes: [], credentials: [] } }),
        'PUT /api/workers/w2/name': (req) => {
          const name = (req.body as { name: string | null }).name;
          if (name === 'atlas-win-01')
            return {
              status: 409,
              body: { error: 'worker_name_taken', message: 'Another machine already has this name.' },
            };
          current = { ...W2, label: name, name: name ?? 'kestrel-mac' };
          return { status: 200, body: current };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'kestrel-mac' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Makine adını düzenle' }));
    const field = screen.getByRole('textbox', { name: 'Makine adı' });
    expect((field as HTMLInputElement).value).toBe('kestrel-mac');
    // A name another machine has: the master's refusal in words, the field stays.
    await user.clear(field);
    await user.type(field, 'atlas-win-01{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Başka bir makine zaten bu adı taşıyor.');
    // Too long: refused before asking the master.
    await user.clear(field);
    await user.type(field, 'x'.repeat(61));
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    expect((await screen.findByRole('alert')).textContent).toBe('En çok 60 karakter.');
    await user.clear(field);
    await user.type(field, '  Ofis Mac {Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ofis Mac' })).toBeTruthy();
    expect(screen.getByTestId('machine-name-saved').textContent).toBe('Makinenin adı artık “Ofis Mac”.');
    const puts = requests.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.body)).toEqual([{ name: 'atlas-win-01' }, { name: 'Ofis Mac' }]);
    // The hostname is still shown next to the new name; focus is back on the pencil.
    expect(screen.getByText('kestrel-mac')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Makine adını düzenle' }));
    });
    // Escape cancels; "Ana bilgisayar adına dön" clears the name.
    await user.click(screen.getByRole('button', { name: 'Makine adını düzenle' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Makine adı' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Makine adını düzenle' }));
    await user.click(screen.getByRole('button', { name: 'Ana bilgisayar adına dön' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'kestrel-mac' })).toBeTruthy();
    expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ name: null });
  });

  it('a viewer sees no pencil', async () => {
    renderApp({ path: '/machines/w2', initialState: viewer, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'kestrel-mac' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Makine adını düzenle' })).toBeNull();
  });
});
