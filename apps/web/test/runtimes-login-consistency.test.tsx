// p14-login-status-consistency: Makine → Runtime’lar — the runtime's compatibility cell (CAPABILITIES probe) and the
// subscription login row (remote-ops login report) must not contradict each other. After a login check the tab keeps
// reloading the cell (bounded) until it agrees, showing "refreshing" meanwhile instead of "signed out"; when the
// machine's jobs use an API key (secret-ref) or no sign-in method at all, it says so instead of "signed out".
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { configView } from '../src/diyalog/harness/screens/w3-machine-config';
import { opFixture, opsStatusFixture } from '../src/diyalog/harness/screens/w3-machine-runtimes';
import { LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const OP = '00000000-0000-4000-8000-0000000000d1';
const NAME = 'linux-worker-1';

const W2 = {
  id: 'w2',
  name: NAME,
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w2',
  os: 'linux',
  arch: 'x64',
  osVersion: '6',
  hostname: NAME,
  workerVersion: '1.0.46',
  runningJobs: 0,
  lastSeenAt: iso(1000),
  createdAt: iso(86_400_000),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [],
  credentials: [],
};

function overview(claude: 'ready' | 'not_authenticated'): unknown {
  return {
    workers: [
      {
        id: 'w2',
        capacity: { running: 0, max: 2 },
        capabilitiesAt: iso(60_000),
        sandboxProfiles: ['host'],
        sandboxReadiness: [],
        tools: [],
        load: null,
        network: { key: '172.31.43.0/24', label: '172.31.43.0/24' },
        runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
        release: { channel: 'stable', targetVersion: null, lastAttempt: null },
        compatibility: [
          {
            runtime: 'claude-code',
            status: claude,
            version: '2.1.296',
            reason:
              claude === 'ready'
                ? 'ready'
                : 'not authenticated (configure runtimeAuth, or log in again: Remote operations → Log in)',
          },
        ],
        queue: { profileSlots: {}, urgentReserve: 1, urgentReserveAuto: true },
      },
    ],
  };
}

/** The remote-ops status with Claude Code's subscription login reported as active. */
function opsLoggedIn(): Record<string, unknown> {
  const s = opsStatusFixture('w2');
  const report = s.report as { login: Record<string, unknown>[] };
  report.login = [
    { runtime: 'claude-code', status: 'logged_in', method: 'claude.ai', checkedAt: iso(11_000) },
  ];
  return s;
}

function config(mode: 'local-login' | 'secret-ref' | null): unknown {
  const v = configView('w2') as { report: { effective: { runtimeAuth: Record<string, string> } } };
  const auth: Record<string, string> = { ...v.report.effective.runtimeAuth };
  if (mode === null) delete auth['claude-code'];
  else auth['claude-code'] = mode;
  v.report.effective.runtimeAuth = auth;
  return v;
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler>): Record<string, Handler> {
  const usage = ok({
    generatedAt: iso(0),
    settings: { nearThreshold: 80, notifyNear: true },
    entries: [],
    otherLimits: [],
  });
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W2] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': usage,
    'GET /api/usage-limits/overview?history=1': usage,
    'GET /api/workers/w2': ok(W2),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w2/ops': ok(opsLoggedIn()),
    'GET /api/fleet/overview': ok(overview('not_authenticated')),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The row's explanation once the machine's configuration has been read (it reads "refreshing" meanwhile). */
async function explanation(row: HTMLElement): Promise<string | undefined> {
  await waitFor(() => {
    expect(within(row).getByTestId('runtime-auth-claude-code').dataset.explanation).not.toBe('refreshing');
  });
  return within(row).getByTestId('runtime-auth-claude-code').dataset.explanation;
}

const TEXT = {
  tr: {
    check: 'Denetle',
    refreshing: 'Durum yenileniyor',
    ready: 'Hazır',
    secretRef: `${NAME} makinesinde Claude Code işleri bir API anahtarıyla çalışacak şekilde ayarlı`,
    secretPill: 'API anahtarı bağlı değil',
    none: 'kimlik doğrulama yöntemi seçilmemiş',
    nonePill: 'Kimlik doğrulama seçilmedi',
    openConfig: 'Yapılandırmayı aç',
    stale: 'runtime raporu oturumu hala kapalı gösteriyor',
    signedOut: 'oturumu kapalı.',
    switchToLogin: 'İşler abonelik oturumunu kullansın',
    notUsedKey: 'İşler bu oturumu kullanmıyor',
  },
  en: {
    check: 'Check',
    refreshing: 'Refreshing status',
    ready: 'Ready',
    secretRef: `Claude Code jobs on ${NAME} are set to run with an API key`,
    secretPill: 'API key not bound',
    none: 'No sign-in method is chosen for Claude Code jobs',
    nonePill: 'No sign-in method chosen',
    openConfig: 'Open configuration',
    stale: 'runtime report still shows it signed out',
    signedOut: 'is signed out on',
    switchToLogin: 'Use the subscription login for jobs',
    notUsedKey: 'Jobs do not use this login',
  },
} as const;

describe.each(['tr', 'en'] as const)('runtime login consistency (%s)', (locale) => {
  const w = TEXT[locale];
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  });

  it('after a login check: "refreshing" while the cell still says signed out, then the fresh state', async () => {
    const user = userEvent.setup();
    let ended = false;
    let overviewAfter = 0;
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      i18n: true,
      routes: routes({
        'GET /api/workers/w2/config': ok(config('local-login')),
        // The machine's new CAPABILITIES land only on the second reload after the check ended.
        'GET /api/fleet/overview': () => {
          if (ended) overviewAfter += 1;
          return { status: 200, body: overview(overviewAfter >= 3 ? 'ready' : 'not_authenticated') };
        },
        'POST /api/workers/w2/runtimes/claude-code/login-status': ok(
          opFixture(OP, 'w2', { kind: 'login.status', state: 'sent', finishedAt: null }),
        ),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: () => {
          ended = true;
          return {
            status: 200,
            body: opFixture(OP, 'w2', { kind: 'login.status', params: { runtime: 'claude-code' } }),
          };
        },
      }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    // Before any operation: the login is active but the cell is not — never a bare "signed out".
    expect(await explanation(claude)).toBe('stale');
    expect(claude.textContent).toContain(w.stale);
    expect(claude.textContent).not.toContain(w.signedOut);

    await user.click(within(claude).getByRole('button', { name: w.check }));
    await waitFor(() => {
      expect(within(claude).getByTestId('runtime-auth-claude-code').dataset.explanation).toBe('refreshing');
    });
    expect(claude.textContent).toContain(w.refreshing);
    // Bounded polling of the compatibility cell until it agrees with the login report.
    await waitFor(
      () => {
        expect(within(claude).queryByTestId('runtime-auth-claude-code')).toBeNull();
      },
      { timeout: 9_000 },
    );
    expect(claude.textContent).toContain(w.ready);
    expect(overviewAfter).toBeGreaterThanOrEqual(3);
    // Read once by the runtimes tab and once by the machine page's restart banner (p22-harness-gaps; no pending
    // restart, so it does not poll) — never polled while the login check runs.
    expect(requests.filter((r) => r.url === '/api/workers/w2/config')).toHaveLength(2);
  }, 15_000);

  it('secret-ref: jobs use an API key that is not bound — says so and links to the configuration', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      i18n: true,
      routes: routes({ 'GET /api/workers/w2/config': ok(config('secret-ref')) }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    expect(await explanation(claude)).toBe('secret-ref');
    const notice = within(claude).getByTestId('runtime-auth-claude-code');
    expect(notice.textContent).toContain(w.secretRef);
    expect(claude.textContent).toContain(w.secretPill);
    expect(claude.textContent).not.toContain(w.signedOut);
    expect(within(notice).getByRole('link', { name: w.openConfig }).getAttribute('href')).toBe(
      '/machines/w2?tab=configuration',
    );
  });

  it('no sign-in method chosen: the subscription login is not used by jobs', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      i18n: true,
      routes: routes({ 'GET /api/workers/w2/config': ok(config(null)) }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    expect(await explanation(claude)).toBe('none');
    const notice = within(claude).getByTestId('runtime-auth-claude-code');
    expect(notice.textContent).toContain(w.none);
    expect(claude.textContent).toContain(w.nonePill);
    expect(within(notice).getByRole('link', { name: w.openConfig })).toBeTruthy();
  });

  it('one click switches the jobs to the subscription login (configuration write, current generation)', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      i18n: true,
      routes: routes({
        'GET /api/workers/w2/config': ok(config(null)),
        'PUT /api/workers/w2/config': ok(config('local-login')),
      }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    expect(await explanation(claude)).toBe('none');
    await user.click(within(claude).getByRole('button', { name: w.switchToLogin }));
    expect((await within(claude).findByTestId('runtime-auth-switch-claude-code')).dataset.result).toBe(
      'saved',
    );
    const put = requests.find((r) => r.method === 'PUT' && r.url === '/api/workers/w2/config');
    const body = put?.body as {
      spec: { runtimes: Record<string, { auth?: unknown }>; allowedRuntimes: string[] };
      expectedGeneration: number;
    };
    expect(body.spec.runtimes['claude-code']?.auth).toEqual({ mode: 'local-login' });
    expect(body.spec.allowedRuntimes).toContain('claude-code');
    expect(body.expectedGeneration).toBe(3);
    expect(put?.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('an active login that jobs do not use (API key) says so under the login row', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      i18n: true,
      routes: routes({
        'GET /api/workers/w2/config': ok(config('secret-ref')),
        'GET /api/fleet/overview': ok(overview('ready')),
      }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    const note = await within(claude).findByTestId('login-not-used-claude-code');
    expect(note.dataset.auth).toBe('secret-ref');
    expect(note.textContent).toContain(w.notUsedKey);
    expect(within(claude).queryByTestId('runtime-auth-claude-code')).toBeNull();
  });
});

describe('the master names why a runtime is signed out for jobs (every Diyalog reason)', () => {
  it('no sign-in method / an API key: the configuration is the fix, not logging in again', async () => {
    // p14-i18n-reasons: these are the previous master's texts (LEGACY fallback); the cause path is in
    // i18n-reasons.test.tsx.
    const { describeReason } = await import('../src/lib/reasons');
    const describeReasonTr = (raw: string, ctx: Parameters<typeof describeReason>[1]) =>
      describeReason(raw, ctx, { locale: 'tr' });
    const ctx = { workerId: 'w2', workerName: NAME, runtime: 'claude-code' };
    const none = describeReasonTr(
      'not_authenticated: not authenticated: no sign-in method is configured for jobs on this machine (runtimeAuth not set), so jobs do not use its subscription login — choose …',
      ctx,
    );
    expect(none.sentence).toBe(
      `${NAME} makinesinde Claude Code işleri için bir kimlik doğrulama yöntemi seçilmemiş, bu yüzden işler abonelik oturumunu kullanmıyor.`,
    );
    expect(none.action?.label).toBe('Yapılandırmayı aç');
    expect(none.action?.href).toContain('section=configuration');
    const key = describeReasonTr(
      'not_authenticated: not authenticated: jobs on this machine use an API key (secret-ref) that is not available there, not its subscription login — bind …',
      ctx,
    );
    expect(key.sentence).toContain('API anahtarını kullanıyor');
    const plain = describeReasonTr(
      'not_authenticated: not authenticated (configure runtimeAuth, or log in again: Remote operations → Log in)',
      ctx,
    );
    expect(plain.sentence).toBe(`Claude Code ${NAME} makinesinde oturumu kapalı.`);
    expect(plain.action?.label).toBe('Yeniden giriş yap');
  });
});
