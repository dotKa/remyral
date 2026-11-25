// p16-ops-safety (docs/design/p16-ops-safety.md §5): Ayarlar → Operasyon güvenliği — keys and expiry (states, "check
// now", rotation stamps, a vault credential's expiry date), the cost brake (spend meters, mode / ceilings through the
// security policy, owners' lifts; an admin sees no lift form), request limits, the breaker thresholds; the breaker
// panel in Worker sürümleri (held rollout, reason, failing machine, Resume / Roll back); the cost brake band.
// p17-settings-tabs: the page is in tabs (`?tab=`): each card is reached through its tab, old anchors land on theirs.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { AuthProvider } from '../src/auth/AuthProvider';
import { CostBrakeBanner } from '../src/diyalog/ops/CostBrakeBanner';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import {
  fakeFetch,
  type Handler,
  type RecordedRequest,
  renderApp,
  sessionBody,
  stubCookies,
  USER,
} from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const admin: AuthState = { ...owner, user: { id: 'u2', username: 'ayse', role: 'admin' } };
const NOW = '2026-10-23T10:00:00.000Z';

const ok =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body });

const ITEMS = [
  {
    id: 'tls:public-origin',
    category: 'certificate',
    label: 'tlsCertificate',
    name: 'console.example.org',
    basis: 'expires',
    dueAt: '2026-10-28T00:00:00.000Z',
    daysLeft: 4,
    since: null,
    ageDays: null,
    rotateEveryDays: null,
    rotatedAt: null,
    state: 'urgent',
    detail: 'trusted · CloudFlare, Inc.',
    checkedAt: NOW,
    runbook: 'docs/ops/deploy-coolify.md',
    stampable: false,
    notifies: true,
  },
  {
    id: 'backup:age-identity',
    category: 'backup',
    label: 'backupIdentity',
    name: null,
    basis: 'rotation',
    dueAt: null,
    daysLeft: null,
    since: null,
    ageDays: null,
    rotateEveryDays: 365,
    rotatedAt: null,
    state: 'unknown',
    detail: 'record the date the identity was created or last rotated',
    checkedAt: null,
    runbook: 'docs/ops/backups.md',
    stampable: true,
    notifies: true,
  },
];
const EXPIRY = {
  items: ITEMS,
  summary: { total: 2, soon: 0, urgent: 1, expired: 0, unknown: 1, next: null },
  checkedAt: NOW,
};
const BRAKE = {
  mode: 'warn',
  warnPercent: 80,
  ceilings: [
    {
      scope: 'global',
      window: 'day',
      windowStart: '2026-10-23T00:00:00.000Z',
      windowEnd: '2026-10-24T00:00:00.000Z',
      spentUsd: 42.5,
      limitUsd: 50,
      percent: 85,
      level: 'warning',
      lifted: false,
    },
  ],
  engaged: [],
  lifts: [],
  blocking: false,
  projects: [],
  computedAt: NOW,
};
const POLICY = {
  version: 7,
  document: { preset: 'serbest' },
  effective: {
    preset: 'serbest',
    customized: false,
    stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
    events: {},
    autonomy: { autoApprove: {} },
    apiTokens: { personal: true, maxDays: 365, eventGrants: false },
    fleet: { unverifiedRuntimeUpdates: true },
    limits: {
      userReadPerMinute: 600,
      userWritePerMinute: 120,
      tokenReadPerMinute: 600,
      tokenWritePerMinute: 120,
      chatPerMinute: 10,
      chatPerHour: 120,
    },
    costBrake: { mode: 'warn', dailyUsd: 50, monthlyUsd: 500, warnPercent: 80 },
    rollout: {
      breaker: true,
      failurePercent: 30,
      minFailures: 1,
      watchMinutes: 30,
      jobFailureDelta: 30,
      minJobs: 5,
    },
  },
  updatedAt: NOW,
  updatedBy: null,
  catalog: { presets: ['serbest', 'dengeli', 'siki'], events: [] },
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody({ stepUpValidUntil: '2026-10-23T22:00:00.000Z' })),
    'GET /api/ops-safety/expiry': ok(EXPIRY),
    'POST /api/ops-safety/expiry/check': ok(EXPIRY),
    'POST /api/ops-safety/expiry/backup%3Aage-identity/rotated': ok({
      item: 'backup:age-identity',
      rotatedAt: NOW,
    }),
    'PUT /api/ops-safety/vault/openrouter-main/expiry': ok({ id: 'openrouter-main', expiresAt: NOW }),
    'GET /api/cost-brake': ok(BRAKE),
    'POST /api/cost-brake/lifts': ok({ id: 'l1' }),
    'GET /api/security/policy': ok(POLICY),
    'PUT /api/security/policy': ok({ ...POLICY, version: 8, changed: ['costBrake.mode'] }),
    ...over,
  };
}

const bodies = (requests: RecordedRequest[], method: string, url: string): unknown[] =>
  requests.filter((r) => r.method === method && r.url === url).map((r) => r.body);

beforeEach(() => {
  stubCookies('rmn_csrf=t');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ayarlar → Operasyon güvenliği', () => {
  it('lists keys and certificates with their state, checks now and records a rotation', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/settings/ops-safety', initialState: owner, routes: routes() });
    const panel = await screen.findByTestId('ops-expiry');
    const rows = await within(panel).findAllByTestId('ops-expiry-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('TLS sertifikası · console.example.org');
    expect(rows[0]?.textContent).toContain('7 gün içinde');
    expect(rows[0]?.textContent).toContain('4 gün kaldı');
    expect(rows[1]?.textContent).toContain('Bilinmiyor');
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: /yenilendi/i })).toBeNull();
    await user.click(
      within(rows[1] as HTMLElement).getByRole('button', { name: /bugün yenilendi olarak kaydet/ }),
    );
    expect((await screen.findByTestId('ops-expiry-done')).textContent).toContain('Yedek age kimliği');
    expect(
      requests.some(
        (r) => r.method === 'POST' && r.url === '/api/ops-safety/expiry/backup%3Aage-identity/rotated',
      ),
    ).toBe(true);
    await user.click(within(panel).getByRole('button', { name: 'Şimdi denetle' }));
    await waitFor(() => {
      expect(bodies(requests, 'POST', '/api/ops-safety/expiry/check')).toHaveLength(1);
    });
  });

  it('records the expiry date of a vault credential', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/settings/ops-safety', initialState: owner, routes: routes() });
    const panel = await screen.findByTestId('ops-expiry');
    await user.type(within(panel).getByLabelText('Kimlik bilgisi kimliği'), 'openrouter-main');
    const date = within(panel).getByLabelText('Bitiş tarihi');
    await user.clear(date);
    await user.type(date, '2026-11-30');
    await user.click(within(panel).getByRole('button', { name: 'Tarihi kaydet' }));
    await waitFor(() => {
      expect(bodies(requests, 'PUT', '/api/ops-safety/vault/openrouter-main/expiry')).toEqual([
        { expiresAt: '2026-11-30T00:00:00.000Z' },
      ]);
    });
  });

  it('cost brake: shows the spend, saves the mode through the security policy, owners lift it', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/ops-safety?tab=brake',
      initialState: owner,
      routes: routes(),
    });
    const panel = await screen.findByTestId('ops-brake');
    const meter = await within(panel).findByTestId('ops-ceiling');
    expect(meter.textContent).toContain('Tüm model kullanımı · Bugün (UTC)');
    expect(meter.textContent).toContain('Uyarı eşiğinde');
    await user.selectOptions(within(panel).getByLabelText('Tavana ulaşınca'), 'block');
    await user.click(within(panel).getAllByRole('button', { name: 'Kaydet' })[0] as HTMLElement);
    await waitFor(() => {
      expect(bodies(requests, 'PUT', '/api/security/policy')).toEqual([
        {
          costBrake: { mode: 'block', dailyUsd: 50, monthlyUsd: 500, warnPercent: 80 },
          expectedVersion: 7,
        },
      ]);
    });
    await user.type(within(panel).getByLabelText('Neden'), 'release day');
    await user.click(within(panel).getByRole('button', { name: 'Freni kaldır' }));
    await waitFor(() => {
      expect(bodies(requests, 'POST', '/api/cost-brake/lifts')).toEqual([
        { scope: 'global', hours: 2, reason: 'release day' },
      ]);
    });
  });

  it('an admin sees the brake but cannot lift it', async () => {
    renderApp({ path: '/settings/ops-safety?tab=brake', initialState: admin, routes: routes() });
    const panel = await screen.findByTestId('ops-brake');
    expect(await within(panel).findByText('Freni yalnızca bir sahip kaldırabilir.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Freni kaldır' })).toBeNull();
  });

  it('request limits and the breaker thresholds save their section', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/ops-safety?tab=limits',
      initialState: owner,
      routes: routes(),
    });
    const limits = await screen.findByTestId('ops-limits');
    const chat = within(limits).getByLabelText('Sohbet mesajı / dakika (kişi)');
    await user.clear(chat);
    await user.type(chat, '5');
    await user.click(within(limits).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(bodies(requests, 'PUT', '/api/security/policy').at(-1)).toMatchObject({
        limits: { chatPerMinute: 5, chatPerHour: 120, userReadPerMinute: 600 },
      });
    });
    await user.click(screen.getByRole('tab', { name: 'Sürüm devre kesici' }));
    const breaker = await screen.findByTestId('ops-breaker-settings');
    await user.click(within(breaker).getByRole('switch', { name: 'Devre kesici açık' }));
    await user.click(within(breaker).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(bodies(requests, 'PUT', '/api/security/policy').at(-1)).toMatchObject({
        rollout: { breaker: false, failurePercent: 30 },
      });
    });
  });

  // ------------------------------------------------------------------ p17-settings-tabs
  const tabNames = (): string[] =>
    within(screen.getByTestId('ops-safety-tabs'))
      .getAllByRole('tab')
      .map((t) => t.textContent);

  it('renders its cards as tabs; only the open tab renders (Anahtarlar ve süreler first, the clean URL)', async () => {
    renderApp({ path: '/settings/ops-safety', initialState: owner, routes: routes() });
    await screen.findByTestId('ops-expiry');
    expect(tabNames()).toEqual([
      'Anahtarlar ve süreler',
      'Maliyet freni',
      'Proje tavanları',
      'İstek sınırları',
      'Sürüm devre kesici',
    ]);
    expect(screen.getByRole('tab', { name: 'Anahtarlar ve süreler' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.queryByTestId('ops-brake')).toBeNull();
    expect(screen.queryByTestId('ops-limits')).toBeNull();
    expect(screen.queryByTestId('ops-breaker-settings')).toBeNull();
  });

  it('a tab click writes ?tab= and the arrow keys move between tabs (one tab stop)', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings/ops-safety', initialState: owner, routes: routes() });
    await screen.findByTestId('ops-expiry');
    await user.click(screen.getByRole('tab', { name: 'Maliyet freni' }));
    expect(await screen.findByTestId('ops-brake')).toBeTruthy();
    expect(screen.queryByTestId('ops-expiry')).toBeNull();
    const brakeTab = screen.getByRole('tab', { name: 'Maliyet freni' });
    expect(brakeTab.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Anahtarlar ve süreler' }).getAttribute('tabindex')).toBe('-1');
    brakeTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Proje tavanları' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Proje tavanları');
    expect(await screen.findByTestId('ops-projects')).toBeTruthy();
    await user.keyboard('{End}');
    expect(await screen.findByTestId('ops-breaker-settings')).toBeTruthy();
    await user.keyboard('{Home}');
    expect(await screen.findByTestId('ops-expiry')).toBeTruthy();
  });

  it.each([
    ['?tab=brake', 'ops-brake'],
    ['?tab=limits', 'ops-limits'],
    ['?tab=breaker', 'ops-breaker-settings'],
    ['#ops-brake', 'ops-brake'],
    ['#cost-brake', 'ops-brake'],
    ['#ops-limits', 'ops-limits'],
    ['#ops-breaker-settings', 'ops-breaker-settings'],
    ['#ops-expiry', 'ops-expiry'],
  ])('a deep link (%s) opens the tab that holds the card', async (suffix, card) => {
    renderApp({ path: `/settings/ops-safety${suffix}`, initialState: owner, routes: routes() });
    expect(await screen.findByTestId(card)).toBeTruthy();
  });

  it('Proje tavanları is an owner tab: an admin has no such tab and its link lands on the first tab', async () => {
    renderApp({ path: '/settings/ops-safety?tab=projects', initialState: admin, routes: routes() });
    expect(await screen.findByTestId('ops-expiry')).toBeTruthy();
    expect(tabNames()).toEqual([
      'Anahtarlar ve süreler',
      'Maliyet freni',
      'İstek sınırları',
      'Sürüm devre kesici',
    ]);
    expect(screen.queryByTestId('ops-projects')).toBeNull();
  });

  it('an owner saves a project ceiling in its own tab (step-up)', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/ops-safety?tab=projects',
      initialState: owner,
      routes: routes({ 'PUT /api/cost-brake/projects/mobil-app': ok({ project: 'mobil-app' }) }),
    });
    const panel = await screen.findByTestId('ops-projects');
    expect(await within(panel).findByText('Proje tavanı yok.')).toBeTruthy();
    await user.type(within(panel).getByLabelText('Proje kimliği'), 'mobil-app');
    await user.type(within(panel).getByLabelText('Günlük tavan ($, boş: yok)'), '20');
    await user.click(within(panel).getByRole('button', { name: 'Proje tavanını kaydet' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/cost-brake/projects/mobil-app')).toBe(
        true,
      );
    });
    expect((await screen.findByTestId('ops-projects-done')).textContent).toContain('mobil-app');
  });
});

describe('Worker sürümleri: rollout circuit breaker', () => {
  const HELD = {
    settings: { breaker: true, failurePercent: 30, watchMinutes: 30 },
    channels: [
      {
        channel: 'stable',
        version: '1.1.0',
        rolloutPercent: 50,
        hold: {
          id: 'h1',
          channel: 'stable',
          version: '1.1.0',
          rolloutPercent: 50,
          previousVersion: '1.0.0',
          reason: 'update_failures',
          evidence: {
            machines: [{ workerId: 'wrk_b', verdict: 'update_failed', reason: 'health_check_failed' }],
          },
          trippedAt: NOW,
        },
        verdict: {
          judged: 2,
          failing: 1,
          pending: 0,
          failurePercent: 50,
          jobFailurePercent: { before: null, after: null },
        },
        machines: [],
        jobs: {},
      },
    ],
    recent: [],
  };

  it('shows why the rollout is held and resumes / rolls back it', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/releases',
      initialState: owner,
      routes: routes({
        'GET /api/releases': ok({ releases: [], channels: [], attempts: [], attemptsNextCursor: null }),
        'GET /api/releases?limit=50': ok({
          releases: [],
          channels: [],
          attempts: [],
          attemptsNextCursor: null,
        }),
        'GET /api/releases/breaker': ok(HELD),
        'POST /api/releases/channels/stable/resume': ok({ hold: {} }),
        'POST /api/releases/channels/stable/rollback': ok({ channelVersion: '1.0.0', machines: ['wrk_b'] }),
      }),
    });
    const row = await screen.findByTestId('dy-breaker-hold');
    expect(row.textContent).toContain('stable kanalında 1.1.0 yayılımı %50 seviyesinde durduruldu');
    expect(row.textContent).toContain('1/2 güncellenen makine hata verdi (%50).');
    expect(row.textContent).toContain('wrk_b: güncelleme başarısız');
    await user.click(within(row).getByRole('button', { name: 'Devam ettir' }));
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'POST' && r.url === '/api/releases/channels/stable/resume'),
      ).toBe(true);
    });
    expect((await screen.findByTestId('dy-breaker-done')).textContent).toContain('Yayılım devam ediyor.');
    await user.click(
      within(await screen.findByTestId('dy-breaker-hold')).getByRole('button', { name: 'Geri al (1.0.0)' }),
    );
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'POST' && r.url === '/api/releases/channels/stable/rollback'),
      ).toBe(true);
    });
  });
});

describe('cost brake band', () => {
  function mount(brake: unknown): void {
    const f = fakeFetch({ 'GET /api/cost-brake': ok(brake) });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <AuthProvider
          initialState={{ kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null }}
        >
          <StepUpProvider>
            <CostBrakeBanner />
          </StepUpProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  }
  const engaged = { ...BRAKE.ceilings[0], level: 'exceeded', spentUsd: 51, percent: 102 };

  it('says that work is held in block mode', async () => {
    mount({ ...BRAKE, mode: 'block', engaged: [engaged], blocking: true });
    const band = await screen.findByTestId('dy-cost-brake-banner');
    expect(band.textContent).toContain('Maliyet freni devrede');
    expect(band.textContent).toContain('acil olmayan yeni işler bekliyor');
    // p17-settings-tabs: the band opens the brake's own tab.
    expect(within(band).getByRole('link', { name: 'Ayrıntılar' }).getAttribute('href')).toBe(
      '/settings/ops-safety?tab=brake',
    );
  });

  it('warns without holding in warn mode, and stays away while nothing is engaged', async () => {
    mount({ ...BRAKE, engaged: [engaged] });
    expect((await screen.findByTestId('dy-cost-brake-banner')).textContent).toContain(
      'yalnızca uyarı modunda',
    );
  });

  it('is absent while nothing is engaged', async () => {
    mount(BRAKE);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('dy-cost-brake-banner')).toBeNull();
  });
});
