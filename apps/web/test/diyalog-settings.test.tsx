// p12-diyalog Faz 4 — Ayarlar in the Diyalog language (flag on): settings navigation (admin-only items hidden for
// others), Profil with the interface switch, Entegrasyonlar with the Cloudflare DNS probe, Yedekler with standby
// readiness, Worker sürümleri with a step-up roll-out, Kullanıcılar, and flag off =
// the classic settings unchanged.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  SETTINGS_BACKUPS,
  SETTINGS_GITHUB,
  SETTINGS_OPS,
  SETTINGS_RELEASES,
} from '../src/diyalog/harness/screens/settings';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'viewer' },
  session: null,
  remainingRecoveryCodes: null,
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

/** Every route the shell and the pages read; anything else answers 404 (never a 401 that would sign out). */
function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/integrations/github': ok(SETTINGS_GITHUB),
    'GET /api/integrations/ops': ok(SETTINGS_OPS),
    'GET /api/backups/status': ok(SETTINGS_BACKUPS),
    'GET /api/releases': ok(SETTINGS_RELEASES),
    'GET /api/releases?limit=25': ok(SETTINGS_RELEASES),
    'GET /api/users': ok({
      items: [
        {
          id: USER.id,
          username: 'alex',
          role: 'owner',
          totpEnrolled: true,
          disabled: false,
          disabledAt: null,
          lockedUntil: null,
          lastLoginAt: null,
          createdAt: '2026-10-01T10:00:00.000Z',
          memberships: [],
        },
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          username: 'oper1',
          role: 'operator',
          totpEnrolled: true,
          disabled: false,
          disabledAt: null,
          lockedUntil: null,
          lastLoginAt: null,
          createdAt: '2026-10-01T10:00:00.000Z',
          memberships: [{ project: 'alpha', role: 'operator' }],
        },
      ],
    }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settingsNav = (): HTMLElement => screen.getByRole('navigation', { name: 'Ayarlar' });

/** p17-ui-polish: the side list's groups fold; open every closed one. */
async function openAllGroups(nav: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  for (const b of within(nav).queryAllByRole('button', { expanded: false })) await user.click(b);
}

describe('Diyalog Ayarlar (p12-diyalog Faz 4)', () => {
  it('/settings opens Profil; the navigation marks it and shows admin sections to an owner', async () => {
    renderApp({ path: '/settings', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Profil ve güvenlik' })).toBeTruthy();
    const nav = settingsNav();
    expect(within(nav).getByRole('link', { name: 'Profil ve güvenlik' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await openAllGroups(nav);
    for (const name of ['Kullanıcılar', 'Yedekler', 'Makine sürümleri', 'Entegrasyonlar', 'Runtime’lar'])
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
    // Phones: a disclosure naming the current section; the links render once it is opened (classic behaviour).
    const disclosure = screen.getByTestId('dy-settings-disclosure');
    expect(disclosure.textContent).toContain('Profil ve güvenlik');
    expect(screen.queryByRole('navigation', { name: 'Ayarlar bölümleri' })).toBeNull();
    await userEvent.setup().click(within(disclosure).getByText('Ayarlar'));
    expect(await screen.findByRole('navigation', { name: 'Ayarlar bölümleri' })).toBeTruthy();
  });

  it('hides admin-only sections from a viewer, as the classic settings do', async () => {
    renderApp({
      path: '/settings/profile',
      initialState: viewer,
      routes: routes({
        'GET /api/auth/session': ok({
          ...(sessionBody() as Record<string, unknown>),
          user: { ...USER, role: 'viewer' },
        }),
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Profil ve güvenlik' });
    const nav = settingsNav();
    await openAllGroups(nav);
    for (const name of ['Kullanıcılar', 'Yedekler', 'Makine sürümleri', 'Entegrasyonlar', 'Kimlik bilgileri'])
      expect(within(nav).queryByRole('link', { name })).toBeNull();
    for (const name of ['Bildirimler', 'Cihazlar', 'Modeller', 'Bağlam'])
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
  });

  it('Entegrasyonlar: connection states and the stored Cloudflare DNS probe per zone', async () => {
    renderApp({ path: '/settings/integrations', initialState: owner, routes: routes() });
    const conns = await screen.findAllByTestId('dy-connection');
    expect(conns.map((c) => c.textContent)).toEqual([
      expect.stringContaining('GitHub'),
      expect.stringContaining('Coolify'),
      expect.stringContaining('Cloudflare'),
    ]);
    expect(conns[0]?.textContent).toContain('Bağlı');
    expect(conns[0]?.textContent).toContain('1 kurulum');
    const zones = screen.getAllByTestId('dy-dns-zone');
    expect(zones).toHaveLength(2);
    expect(zones[0]?.textContent).toContain('example.org');
    expect(zones[0]?.textContent).toContain('Okunabiliyor');
    expect(zones[1]?.textContent).toContain('demo.test');
    expect(zones[1]?.textContent).toContain('İzin eksik');
    expect(zones[1]?.textContent).toContain('sunum');
    // Editing stays in the provider cards (write-only tokens, step-up) — p15-form-pattern: in their own tab.
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Coolify ve Cloudflare' }));
    expect(await screen.findByTestId('ops-integrations')).toBeTruthy();
  });

  it('Yedekler: health, standby lag and the drill checks', async () => {
    renderApp({ path: '/settings/backups', initialState: owner, routes: routes() });
    const health = await screen.findByTestId('dy-backup-health');
    expect(health.textContent).toContain('Yedekler ilgi istiyor.');
    expect(health.textContent).toContain('WAL gönderimi 6 dk geride.');
    expect(screen.getByTestId('dy-standby-tile').textContent).toContain('6 dk');
    expect(
      within(screen.getByTestId('dy-standby')).getByText('00000001000000000000002A', { exact: false }),
    ).toBeTruthy();
    const checks = screen.getByTestId('dy-drill-checks');
    expect(within(checks).getAllByRole('listitem')).toHaveLength(2);
    // p17-ui-review: the drill's check names in words, not the raw identifiers.
    expect(checks.textContent).toContain('Satır sayıları');
    expect(checks.textContent).toContain('Denetim zinciri');
    expect(checks.textContent).not.toContain('row counts');
  });

  it('Worker sürümleri: channels, a failed attempt’s reason, and a roll-out confirmed with a code', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    let promoted: unknown = null;
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/releases',
      initialState: owner,
      routes: routes({
        'PUT /api/releases/channels/canary': (req) => {
          if (!stepped)
            return { status: 403, body: { error: 'step_up_required', message: 'Confirm with a code.' } };
          promoted = req.body;
          return {
            status: 200,
            body: {
              channel: 'canary',
              version: '1.0.42-rc1',
              rolloutPercent: 60,
              updatedAt: '2026-10-19T10:00:00Z',
            },
          };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const channels = await screen.findByTestId('dy-channels');
    expect(
      within(channels).getByRole('meter', { name: 'canary yayılımı' }).getAttribute('aria-valuenow'),
    ).toBe('30');
    // p17-settings-tabs: the attempts are a tab of their own; Yayılım (the clean URL) holds the roll-out form.
    expect(screen.queryByTestId('dy-attempts')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Güncelleme denemeleri' }));
    const attempts = await screen.findAllByTestId('dy-attempt');
    expect(attempts[1]?.textContent).toContain('Geri alındı');
    expect(within(attempts[1] as HTMLElement).getByRole('button', { name: 'Neden? (crash)' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Yayılım' }));

    const form = await screen.findByRole('form', { name: 'Bir sürümü yay' });
    await user.selectOptions(within(form).getByLabelText('Kanal'), 'canary');
    await user.selectOptions(within(form).getByLabelText('Sürüm'), '1.0.42-rc1');
    const pct = within(form).getByLabelText('Yayılım %');
    await user.clear(pct);
    await user.type(pct, '60');
    await user.click(within(form).getByRole('button', { name: 'Yay' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(promoted).toEqual({ version: '1.0.42-rc1', rolloutPercent: 60 });
    });
    expect(await screen.findByText('canary → 1.0.42-rc1, %60.')).toBeTruthy();
    expect(r.requests.filter((q) => q.method === 'PUT').length).toBe(2); // refused once, then after the code
  });

  it('Kullanıcılar is a Diyalog page (p12-diyalog wave 2): accounts as rows, the owner adds and manages', async () => {
    renderApp({ path: '/settings/users', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Kullanıcılar' })).toBeTruthy();
    const page = screen.getByTestId('dy-settings');
    const rows = await within(page).findAllByTestId('user-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('alpha (operatör)');
    expect(within(page).getByRole('button', { name: 'Kullanıcı ekle' })).toBeTruthy();
    expect(within(page).getByRole('button', { name: 'oper1 yönet' })).toBeTruthy();
    expect(within(page).queryByRole('table', { name: 'Users' })).toBeNull();
  });

  it('GitHub callback is a native Diyalog screen (p12-diyalog wave 2); no code → start again', async () => {
    renderApp({
      path: '/settings/integrations/github/callback',
      initialState: owner,
      routes: routes(),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'GitHub’ı bağla' })).toBeTruthy();
    expect(screen.getByTestId('dy-github-callback').textContent).toContain('GitHub bir kod döndürmedi');
    expect(screen.queryByRole('heading', { level: 1, name: 'Connect GitHub' })).toBeNull();
  });
});

describe('Ayarlar side list groups (p17-ui-polish)', () => {
  it('folds the groups: the current page’s group open without a toggle, the others closed with their count', async () => {
    renderApp({ path: '/settings/server-settings', initialState: owner, routes: routes() });
    await screen.findByRole('heading', { level: 1, name: 'Sunucu ayarları' });
    const nav = settingsNav();
    expect(within(nav).queryByRole('button', { name: 'Sistem' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Sunucu ayarları' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Yedekler' })).toBeTruthy();
    const team = within(nav).getByRole('button', { name: 'Ekip ve erişim' });
    expect(team.getAttribute('aria-expanded')).toBe('false');
    expect(team.textContent).toContain('4');
    expect(within(nav).queryByRole('link', { name: 'Kullanıcılar' })).toBeNull();
    await userEvent.setup().click(team);
    expect(team.getAttribute('aria-expanded')).toBe('true');
    expect(within(nav).getByRole('link', { name: 'Kullanıcılar' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('remyral.dy.settings.nav') ?? '{}')).toEqual({
      team: true,
    });
  });

  it('remembers the opened groups per viewer, and works when storage is blocked', async () => {
    window.localStorage.setItem('remyral.dy.settings.nav', JSON.stringify({ agents: true, team: 'x' }));
    const first = renderApp({ path: '/settings/profile', initialState: owner, routes: routes() });
    await screen.findByRole('heading', { level: 1, name: 'Profil ve güvenlik' });
    expect(within(settingsNav()).getByRole('link', { name: 'Modeller' })).toBeTruthy();
    expect(within(settingsNav()).queryByRole('link', { name: 'Kullanıcılar' })).toBeNull();
    first.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderApp({ path: '/settings/profile', initialState: owner, routes: routes() });
    await screen.findByRole('heading', { level: 1, name: 'Profil ve güvenlik' });
    const agents = within(settingsNav()).getByRole('button', { name: 'Ajanlar' });
    await userEvent.setup().click(agents);
    expect(within(settingsNav()).getByRole('link', { name: 'Modeller' })).toBeTruthy();
  });
});
