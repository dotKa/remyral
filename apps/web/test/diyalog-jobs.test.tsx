// p12-diyalog Faz 4: İşler + Kuyruk (`/jobs`) in the Diyalog language — the list (filters in the URL, preset views,
// state pills, cost, run again, thread links, pages) and the queue (class lanes, reasons, reorder, run now with
// step-up, read-only viewers); flag off keeps the classic Jobs page.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthState } from '../src/auth/AuthProvider';
import { VIEW_STORAGE_KEY } from '../src/diyalog/screens/jobs/views';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

function fakeApi(): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: () => Promise.resolve({ stepUpValidUntil: '2099-01-01T00:00:00.000Z', stepUpScope: 'window' }),
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.resolve(sessionBody()),
  } as unknown as AuthApi;
}

const J1 = '11111111-1111-4111-8111-111111111111';
const J2 = '22222222-2222-4222-8222-222222222222';
const J3 = '33333333-3333-4333-8333-333333333333';

function job(
  id: string,
  st: string,
  title: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    project: 'acme',
    projectKind: 'repository',
    state: st,
    runtime: 'codex',
    title,
    attempts: 1,
    workerId: 'w1',
    createdBy: { type: 'user', id: USER.id },
    createdAt: iso(3_600_000),
    stateChangedAt: iso(1_800_000),
    ...over,
  };
}

function entry(id: string, position: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: id,
    project: 'acme',
    title: `Kuyruk işi ${String(position)}\nayrıntı`,
    runtime: 'claude-code',
    sandboxProfile: 'host-restricted',
    state: 'QUEUED',
    priority: 0,
    storedPriority: 0,
    priorityClass: 'normal',
    adjusted: null,
    position,
    waitingSince: iso(125_000),
    waitingSec: 125,
    category: 'profile_slot',
    reasons: [{ code: 'no_free_profile_slot', category: 'profile_slot', message: 'desktop-pc busy' }],
    estimatedStart: iso(-1_800_000),
    createdBy: USER.id,
    canReorder: true,
    ...over,
  };
}

function queue(
  jobs: Record<string, unknown>[],
  paused: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    generatedAt: iso(0),
    total: jobs.length,
    estimateNote: 'Estimated start: an estimate, not a promise.',
    pools: [
      {
        key: 'host-restricted',
        profile: 'host-restricted',
        machines: [
          {
            id: 'w1',
            name: 'desktop-pc',
            slots: 3,
            profileSlots: 1,
            running: 1,
            urgentReserve: 1,
            urgentReserveAuto: false,
            urgentReserveEffective: 1,
            subscriptionLogins: null,
          },
        ],
        jobs,
      },
    ],
    paused,
  };
}

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({
      status: 200,
      body: {
        workers: [
          {
            id: 'w1',
            name: 'desktop-pc',
            state: 'online',
            quarantineReason: null,
            connected: true,
            fingerprint: null,
            os: 'linux',
            arch: 'x64',
            osVersion: '6.8',
            hostname: 'desktop-pc',
            workerVersion: '1.0.0',
            runningJobs: 1,
            lastSeenAt: iso(1000),
            createdAt: iso(86_400_000),
            pairingExpiresAt: null,
            pairingExpired: false,
            drainRequestedAt: null,
            revokedAt: null,
          },
        ],
      },
    }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/workflows': () => ({ status: 200, body: { items: [] } }),
    ...over,
  };
}

const LIST = {
  status: 200,
  body: {
    items: [
      job(J1, 'RUNNING', 'Login testini düzelt\nikinci satır', { createdAt: iso(60_000) }),
      job(J2, 'FAILED', 'Android build önbelleği', { runtime: 'pi' }),
      job(J3, 'SUCCEEDED', 'Başkasının işi', { createdBy: { type: 'user', id: 'someone-else' } }),
    ],
    nextCursor: 'c2',
  },
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog İşler (p12-diyalog Faz 4)', { timeout: 20_000 }, () => {
  it('lists jobs with state pills, runtime, machine, cost, run again and a thread link', async () => {
    const r = renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        // p14-web-perf-2: only the listed jobs' records.
        [`GET /api/usage/records?from=${encodeURIComponent(iso(3_600_000))}&jobs=${encodeURIComponent([J1, J2, J3].join(','))}&limit=500`]:
          () => ({
            status: 200,
            body: { items: [{ jobId: J2, cost: { costClass: 'reported', costUsd: 0.42 } }] },
          }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'İşler' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    const rows = await screen.findAllByTestId('job-row');
    expect(rows).toHaveLength(3);
    const first = rows[0] as HTMLElement;
    // Title = the first prompt line, as text.
    expect(within(first).getByRole('link', { name: 'Login testini düzelt' }).getAttribute('href')).toBe(
      `/jobs/${J1}`,
    );
    expect(first.textContent).not.toContain('ikinci satır');
    expect(within(first).getByTestId('job-state').textContent).toBe('Çalışıyor');
    expect(first.textContent).toContain('Codex');
    expect(first.textContent).toContain('desktop-pc');
    expect(
      within(first).getByRole('link', { name: "Login testini düzelt: thread'de aç" }).getAttribute('href'),
    ).toBe(`/jobs/${J1}`);
    // Running jobs cannot be run again; finished ones can.
    expect(within(first).queryByRole('link', { name: /Yeniden çalıştır/ })).toBeNull();
    const failed = rows[1] as HTMLElement;
    expect(within(failed).getByTestId('job-state').textContent).toBe('Başarısız');
    expect(
      within(failed)
        .getByRole('link', { name: 'Yeniden çalıştır: Android build önbelleği' })
        .getAttribute('href'),
    ).toBe(`/jobs/new?from=${J2}`);
    await waitFor(() => {
      expect(within(failed).getByTestId('job-cost').textContent).toBe('$0.42');
    });
    // The classic page is not mounted.
    expect(screen.queryByRole('heading', { level: 1, name: 'Jobs' })).toBeNull();
  });

  it('filters through the URL and the request; presets set the classic filter; a page moves the cursor', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/jobs?limit=50&cursor=c2': () => ({
          status: 200,
          body: {
            items: [job('44444444-4444-4444-8444-444444444444', 'CANCELLED', 'Eski iş')],
            nextCursor: null,
          },
        }),
        'GET /api/jobs?state=FAILED&limit=50': () => ({
          status: 200,
          body: { items: [job(J2, 'FAILED', 'Android build önbelleği')], nextCursor: null },
        }),
        'GET /api/jobs?state=FAILED&runtime=pi&limit=50': () => ({
          status: 200,
          body: {
            items: [job(J2, 'FAILED', 'Android build önbelleği', { runtime: 'pi' })],
            nextCursor: null,
          },
        }),
      }),
    });
    await screen.findAllByTestId('job-row');
    // Next page (keyset cursor).
    const pager = screen.getByRole('navigation', { name: 'İş sayfaları' });
    expect(pager.textContent).toContain('Sayfa 1');
    expect(within(pager).getByRole('button', { name: 'Önceki sayfa' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(pager).getByRole('button', { name: 'Sonraki sayfa' }));
    expect(await screen.findByText('Eski iş')).toBeTruthy();
    expect(r.requests.some((q) => q.url === '/api/jobs?limit=50&cursor=c2')).toBe(true);

    // Preset "Başarısız" = ?state=FAILED, remembered for this browser.
    const presets = screen.getByRole('navigation', { name: 'Hazır görünümler' });
    await user.click(within(presets).getByRole('button', { name: 'Başarısız' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/jobs?state=FAILED&limit=50')).toBe(true);
    });
    expect(within(presets).getByRole('button', { name: 'Başarısız' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe('failed');
    // A filter select narrows further (the preset no longer matches exactly).
    await user.selectOptions(screen.getByLabelText('Runtime'), 'pi');
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/jobs?state=FAILED&runtime=pi&limit=50')).toBe(true);
    });
    expect(within(presets).getByRole('button', { name: 'Başarısız' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('"Benim" narrows the loaded page to my jobs and says so; the remembered view opens next time', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({ 'GET /api/jobs?limit=50': () => LIST }),
    });
    await screen.findAllByTestId('job-row');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Hazır görünümler' })).getByRole('button', {
        name: 'Benim',
      }),
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('job-row')).toHaveLength(2);
    });
    expect(screen.queryByText('Başkasının işi')).toBeNull();
    expect(screen.getByTestId('local-view-note').textContent).toContain('Senin başlattığın');
  });

  it('opens the remembered preset when the list is opened bare', async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, 'running');
    const r = renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/jobs?state=RUNNING&limit=50': () => ({
          status: 200,
          body: { items: [job(J1, 'RUNNING', 'Login testini düzelt')], nextCursor: null },
        }),
      }),
    });
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/jobs?state=RUNNING&limit=50')).toBe(true);
    });
    expect(
      within(screen.getByRole('navigation', { name: 'Hazır görünümler' }))
        .getByRole('button', { name: 'Çalışan' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('sorts the loaded page by a column through the URL: ascending, descending, then the server order', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({ 'GET /api/jobs?limit=50': () => LIST }),
    });
    await screen.findAllByTestId('job-row');
    const order = (): string[] => screen.getAllByTestId('job-state').map((e) => e.textContent);
    expect(order()).toEqual(['Çalışıyor', 'Başarısız', 'Bitti']);
    expect(screen.getByTestId('job-sort-note').textContent).toContain('en yeni önce');
    const bar = screen.getByRole('group', { name: 'Sırala' });
    await user.click(within(bar).getByRole('button', { name: 'Durum' }));
    // FAILED < RUNNING < SUCCEEDED (the classic comparator: the state code).
    await waitFor(() => {
      expect(order()).toEqual(['Başarısız', 'Çalışıyor', 'Bitti']);
    });
    const pressed = within(bar).getByRole('button', { name: 'Durum, artan' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('job-sort-note').textContent).toContain('Bu sayfanın içinde');
    await user.click(pressed);
    await waitFor(() => {
      expect(order()).toEqual(['Bitti', 'Çalışıyor', 'Başarısız']);
    });
    await user.click(within(bar).getByRole('button', { name: 'Durum, azalan' }));
    await waitFor(() => {
      expect(order()).toEqual(['Çalışıyor', 'Başarısız', 'Bitti']);
    });
    expect(within(bar).getByRole('button', { name: 'Durum' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('a sorted link opens sorted (?sort=created&dir=asc)', async () => {
    renderApp({
      path: '/jobs?sort=created&dir=asc',
      initialState: state('owner'),
      routes: base({ 'GET /api/jobs?limit=50': () => LIST }),
    });
    await screen.findAllByTestId('job-row');
    // J1 was created a minute ago, the others an hour ago: oldest first puts it last.
    expect(screen.getAllByTestId('job-state').at(-1)?.textContent).toBe('Çalışıyor');
    expect(
      within(screen.getByRole('group', { name: 'Sırala' }))
        .getByRole('button', { name: 'Oluşturulma, artan' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('shows recent workflow runs natively above the jobs, each opening its run page', async () => {
    renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/workflows': () => ({
          status: 200,
          body: {
            runs: [
              {
                id: 'run-1',
                project: 'acme',
                name: 'release-check',
                version: 2,
                state: 'awaiting_merge',
                createdAt: iso(600_000),
                endedAt: null,
              },
            ],
          },
        }),
      }),
    });
    const panel = await screen.findByTestId('workflow-runs');
    const row = within(panel).getByTestId('workflow-run-row');
    expect(within(row).getByRole('link', { name: 'release-check v2' }).getAttribute('href')).toBe(
      '/jobs/workflows/run-1',
    );
    expect(row.textContent).toContain('Birleştirme bekliyor');
    expect(row.textContent).toContain('acme');
    // Not the classic table.
    expect(panel.querySelector('table')).toBeNull();
  });
});

describe('Diyalog Kuyruk (p12-diyalog Faz 4)', { timeout: 20_000 }, () => {
  const A = J1;
  const B = J2;
  const C = J3;

  it('shows pools with class lanes, positions, reasons in words, estimates, paused jobs and thread links', async () => {
    renderApp({
      path: '/jobs?tab=queue',
      initialState: state('owner'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/queue': () => ({
          status: 200,
          body: queue(
            [
              entry(A, 1, { priorityClass: 'urgent', priority: 50 }),
              entry(B, 2),
              entry(C, 3, { priorityClass: 'background', priority: -50, estimatedStart: null }),
            ],
            [
              {
                jobId: '55555555-5555-4555-8555-555555555555',
                project: 'acme',
                title: 'Onay bekleyen iş',
                runtime: 'codex',
                workerId: 'w1',
                workerName: 'desktop-pc',
                status: 'paused',
                since: iso(600_000),
                retainUntil: iso(-3_600_000),
                requestId: 'req-1',
                action: 'fs.delete',
                decision: null,
                blockedReason: null,
                waiting: null,
              },
            ],
          ),
        }),
      }),
    });
    const lanes = await screen.findAllByTestId('queue-lane');
    expect(lanes.map((l) => l.getAttribute('data-class'))).toEqual(['urgent', 'normal', 'background']);
    expect(lanes.map((l) => within(l).getByTestId('priority-badge').textContent)).toEqual([
      'Acil',
      'Normal',
      'Arka plan',
    ]);
    const rows = screen.getAllByTestId('queue-row');
    expect(rows.map((r) => within(r).getByTestId('queue-position').textContent)).toEqual(['1', '2', '3']);
    const reason = within(rows[1] as HTMLElement).getByTestId('queue-reason').textContent;
    expect(reason).toContain('Profil slotu dolu');
    expect(reason).toContain('desktop-pc busy');
    expect(within(rows[1] as HTMLElement).getByTestId('queue-estimate').textContent).toMatch(/^~/);
    expect(within(rows[2] as HTMLElement).getByTestId('queue-estimate').textContent).toBe('—');
    expect(rows[0]?.textContent).toContain('Kuyruk işi 1');
    expect(rows[0]?.textContent).not.toContain('ayrıntı');
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: "Kuyruk işi 1: thread'de aç" })
        .getAttribute('href'),
    ).toBe(`/jobs/${A}`);
    expect(screen.getByTestId('pool-machines').textContent).toContain('1 slot Acil için ayrılmış');
    // A paused job: its approval opens as the card in the ops thread.
    const paused = screen.getByTestId('paused-row');
    expect(within(paused).getByTestId('paused-for').textContent).toBe('duraklatılalı 10 dk');
    expect(
      within(paused).getByRole('link', { name: "Onay: Onay bekleyen iş: thread'de aç" }).getAttribute('href'),
    ).toBe('/needs#kart=approval:req-1');
  });

  it('reorders within the lane with ↑ and by drag and drop; shows the server note', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: '/jobs?tab=queue',
      initialState: state('operator'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/queue': () => ({ status: 200, body: queue([entry(A, 1), entry(B, 2), entry(C, 3)]) }),
        [`POST /api/jobs/${B}/queue/move`]: () => ({
          status: 200,
          body: { jobId: B, priority: 2, priorityClass: 'normal', exact: true, note: null },
        }),
        [`POST /api/jobs/${C}/queue/move`]: () => ({
          status: 200,
          body: {
            jobId: C,
            priority: 49,
            priorityClass: 'normal',
            exact: false,
            note: 'Normal kalır; daha fazla taşınamadı.',
          },
        }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Yukarı taşı: Kuyruk işi 2' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.url.endsWith(`/jobs/${B}/queue/move`))?.body).toEqual({ before: A });
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Yukarı taşı: Kuyruk işi 1' }).disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Aşağı taşı: Kuyruk işi 3' }).disabled).toBe(
      true,
    );
    // Operators reorder but do not "run now".
    expect(screen.queryByTestId('run-now')).toBeNull();
    const rows = screen.getAllByTestId('queue-row');
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? '',
      get types() {
        return [...store.keys()];
      },
      effectAllowed: 'all',
    };
    fireEvent.dragStart(rows[2] as HTMLElement, { dataTransfer });
    fireEvent.dragOver(rows[0] as HTMLElement, { dataTransfer });
    fireEvent.drop(rows[0] as HTMLElement, { dataTransfer });
    await waitFor(() => {
      expect(r.requests.find((q) => q.url.endsWith(`/jobs/${C}/queue/move`))?.body).toEqual({ before: A });
    });
    // p17-toasts-shortcuts: the master's note on a move is a toast.
    expect((await findToast(/daha fazla taşınamadı/)).textContent).toContain('daha fazla taşınamadı');
  });

  it('run now: admin only, through step-up (403 step_up_required → code → retried)', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    let stepped = false;
    const r = renderApp({
      path: '/jobs?tab=queue',
      initialState: state('owner'),
      api: fakeApi(),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/queue': () => ({ status: 200, body: queue([entry(A, 1)]) }),
        [`POST /api/jobs/${A}/queue/run-now`]: () =>
          stepped
            ? { status: 200, body: { jobId: A, priority: 51, priorityClass: 'urgent' } }
            : {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
              },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Şimdi çalıştır: Kuyruk işi 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Acil (urgent)');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    stepped = true;
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(
        r.requests.filter((q) => q.method === 'POST' && q.url.endsWith(`/jobs/${A}/queue/run-now`)).length,
      ).toBe(2);
    });
  });

  it('viewers read only: no move buttons, no run now, rows not draggable', async () => {
    renderApp({
      path: '/jobs?tab=queue',
      initialState: state('viewer'),
      routes: base({
        'GET /api/jobs?limit=50': () => LIST,
        'GET /api/queue': () => ({
          status: 200,
          body: queue([entry(A, 1, { canReorder: false }), entry(B, 2, { canReorder: false })]),
        }),
      }),
    });
    const rows = await screen.findAllByTestId('queue-row');
    expect(rows).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Yukarı taşı/ })).toBeNull();
    expect(screen.queryByTestId('run-now')).toBeNull();
    expect(rows[0]?.getAttribute('draggable')).toBe('false');
  });
});

describe('p19-verifier-jobs: platform verifier jobs in the list', { timeout: 20_000 }, () => {
  it('a verifier shows the checked job’s outcome and a "Doğrulama" badge, never "Başarısız" or run again', async () => {
    const V = '55555555-5555-4555-8555-555555555555';
    renderApp({
      path: '/jobs',
      initialState: state('owner'),
      routes: base({
        'GET /api/jobs?limit=50': () => ({
          status: 200,
          body: {
            items: [
              job(V, 'FAILED', 'Doğrula: Bahar indirimi', {
                platform: {
                  purpose: 'verify',
                  checkedJobId: J1,
                  checkedTitle: 'Bahar indirimi',
                  outcome: 'unverifiable',
                  errorCause: 'git_auth',
                },
              }),
              job(J2, 'FAILED', 'Android build önbelleği', { platform: null }),
            ],
            nextCursor: null,
          },
        }),
      }),
    });
    const rows = await screen.findAllByTestId('job-row');
    const verifier = rows[0] as HTMLElement;
    expect(within(verifier).getByRole('link', { name: 'Doğrula: Bahar indirimi' })).toBeTruthy();
    expect(within(verifier).getByTestId('job-state').textContent).toBe('Doğrulanamadı');
    expect(within(verifier).getByTestId('platform-badge').textContent).toBe('Doğrulama');
    expect(within(verifier).queryByRole('link', { name: /Yeniden çalıştır/ })).toBeNull();
    const ordinary = rows[1] as HTMLElement;
    expect(within(ordinary).getByTestId('job-state').textContent).toBe('Başarısız');
    expect(within(ordinary).queryByTestId('platform-badge')).toBeNull();
  });
});
