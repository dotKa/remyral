// p14-i18n-foundation (ADR-0053): the console language — where it comes from (session → this browser → browser
// language → Turkish), the Profile "Dil / Language" switch in both shells (PUT /me/locale, live, no reload, rolled
// back on failure) and the Diyalog rail in both languages (i18n Phase 1).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Locale } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../src/api/auth';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  I18nProvider,
  initialLocale,
  LOCALE_STORAGE_KEY,
  readStoredLocale,
  useLocale,
  useT,
} from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

function session(locale: Locale | undefined): SessionInfo {
  return {
    user: USER,
    createdAt: '2026-10-20T10:00:00.000Z',
    expiresAt: '2026-10-20T22:00:00.000Z',
    idleExpiresAt: '2026-10-20T10:30:00.000Z',
    mfaAt: '2026-10-20T10:00:00.000Z',
    stepUpValidUntil: null,
    stepUpScope: 'window',
    alwaysFreshValidUntil: null,
    type: 'standard',
    ...(locale === undefined ? {} : { locale }),
  };
}

const signedIn = (locale: Locale | undefined): AuthState => ({
  kind: 'signedIn',
  user: USER,
  session: session(locale),
  remainingRecoveryCodes: null,
});

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

/** The master: GET /auth/session answers the stored language, PUT /me/locale stores it (or fails with `failWith`). */
function master(start: Locale, failWith?: number) {
  const state = { locale: start };
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), locale: state.locale },
    }),
    'PUT /api/me/locale': (req) => {
      if (failWith !== undefined)
        return { status: failWith, body: { error: 'internal', message: 'Something broke.' } };
      const next = (req.body as { locale: Locale }).locale;
      const changed = next !== state.locale;
      state.locale = next;
      return { status: 200, body: { locale: next, changed } };
    },
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
  };
  const routes = new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
  return { state, routes };
}

function languages(list: readonly string[]): void {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(list);
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = 'en';
  stubCookies('__Host-ras-csrf=tok');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('where the language comes from', () => {
  it('before sign-in: this browser’s last choice, else the browser language, else Turkish', () => {
    languages(['en-US', 'en']);
    expect(initialLocale()).toBe('en');
    languages(['de-DE', 'fr']);
    expect(initialLocale()).toBe('tr');
    languages(['tr-TR']);
    expect(initialLocale()).toBe('tr');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    expect(initialLocale()).toBe('en');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'xx');
    expect(readStoredLocale()).toBeNull();
    expect(initialLocale()).toBe('tr');
  });

  it('a blocked localStorage falls through to the browser language', () => {
    languages(['en-GB']);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readStoredLocale()).toBeNull();
    expect(initialLocale()).toBe('en');
  });

  it('without a provider everything is Turkish (the Diyalog default)', () => {
    function Probe() {
      return <span>{useT().nav.jobs}</span>;
    }
    render(<Probe />);
    expect(screen.getByText('İşler')).toBeTruthy();
  });

  it('the session language wins over the browser and is remembered in this browser', async () => {
    languages(['en-US']);
    function Probe() {
      return <span data-testid="p">{useT().nav.machines}</span>;
    }
    const { rerender } = render(
      <I18nProvider sessionLocale={undefined}>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('p').textContent).toBe('Machines');
    rerender(
      <I18nProvider sessionLocale="tr">
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('p').textContent).toBe('Makineler');
    });
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tr');
  });

  it('a failed save rolls the language back', async () => {
    const save = vi.fn(() => Promise.reject(new Error('nope')));
    let change: ((l: Locale) => Promise<void>) | null = null;
    function Probe() {
      const { changeLocale } = useLocale();
      change = changeLocale;
      return <span data-testid="p">{useT().nav.settings}</span>;
    }
    render(
      <I18nProvider sessionLocale="tr" save={save}>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('p').textContent).toBe('Ayarlar');
    await act(async () => {
      await expect(change?.('en')).rejects.toThrow('nope');
    });
    expect(save).toHaveBeenCalledWith('en');
    expect(screen.getByTestId('p').textContent).toBe('Ayarlar');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tr');
  });
});

describe('Diyalog rail (i18n Phase 1)', () => {
  const railLabels = async (): Promise<string[]> => {
    const nav = (await screen.findAllByRole('navigation', { name: 'Diyalog' }))[0] as HTMLElement;
    return within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('title') ?? '');
  };

  it('Turkish by default — even on an English browser once the master says tr', async () => {
    languages(['en-US']);
    const m = master('tr');
    renderApp({ path: '/settings/profile', initialState: signedIn('tr'), routes: m.routes, i18n: true });
    expect(await railLabels()).toEqual([
      'Ana sayfa',
      'Sohbet',
      'Senden bekleyenler',
      'Planlar',
      'İşler',
      'Workflow’lar',
      'Otomasyonlar',
      'Makineler',
      'Çıktılar',
      'Kullanım',
      'Projeler',
      'Ayarlar',
    ]);
    expect(document.documentElement.lang).toBe('tr');
    expect(screen.getByRole('button', { name: 'Klavye kısayolları' })).toBeTruthy();
  });

  it('English when the user chose en', async () => {
    const m = master('en');
    renderApp({ path: '/settings/profile', initialState: signedIn('en'), routes: m.routes, i18n: true });
    expect(await railLabels()).toEqual([
      'Home',
      'Chat',
      'Needs you',
      'Plans',
      'Jobs',
      'Workflows',
      'Automations',
      'Machines',
      'Outputs',
      'Usage',
      'Projects',
      'Settings',
    ]);
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

describe('Profile → Dil / Language', () => {
  it('Diyalog: switching saves on the master and the rail changes at once, without a reload', async () => {
    const user = userEvent.setup();
    const m = master('tr');
    const r = renderApp({
      path: '/settings/profile',
      initialState: signedIn('tr'),
      routes: m.routes,
      i18n: true,
    });
    const panel = await screen.findByTestId('dy-language');
    const select = within(panel).getByRole('combobox', { name: 'Dil / Language' });
    expect((select as HTMLSelectElement).value).toBe('tr');
    expect(
      within(panel)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Türkçe', 'English']);
    await user.selectOptions(select, 'en');
    // p17-toasts-rest: the result is a toast (in the new language), not a line in the panel.
    expect(await findToast('Language saved.')).toBeTruthy();
    expect(within(panel).queryByText('Language saved.')).toBeNull();
    const put = r.requests.filter((q) => q.method === 'PUT' && q.url === '/api/me/locale');
    expect(put.map((q) => q.body)).toEqual([{ locale: 'en' }]);
    expect(put[0]?.headers['x-csrf-token']).toBe('tok');
    expect(m.state.locale).toBe('en');
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
    expect(within(nav).getByRole('link', { name: 'Jobs' })).toBeTruthy();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    // Every other Diyalog feature on the page is still there (parity).
    expect(screen.getByTestId('dy-language')).toBeTruthy();
    // p15-form-pattern: the session is the "Oturum" tab of Profil (in English now).
    expect(screen.getByRole('tab', { name: 'Session' })).toBeTruthy();
    // And back.
    await user.selectOptions(select, 'tr');
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: 'İşler' })).toBeTruthy();
    });
    expect(m.state.locale).toBe('tr');
  });

  it('Diyalog: a failed save keeps Turkish and says why', async () => {
    const user = userEvent.setup();
    const m = master('tr', 500);
    renderApp({ path: '/settings/profile', initialState: signedIn('tr'), routes: m.routes, i18n: true });
    const panel = await screen.findByTestId('dy-language');
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Dil / Language' }), 'en');
    expect(await within(panel).findByText('Dil kaydedilemedi: Something broke.')).toBeTruthy();
    expect(within(panel).getByRole<HTMLSelectElement>('combobox').value).toBe('tr');
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
    expect(within(nav).getByRole('link', { name: 'İşler' })).toBeTruthy();
  });
});
