// p14-i18n-shell (i18n Phase 2): the ⌘K command palette, the Diyalog sign-in frame, the step-up dialog, "Sayfa
// bulunamadı" and the session notices speak the user's language — Turkish verbatim by default, English when the
// language is "en" — and an English user finds palette items by their English and their Turkish names.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Locale } from '@remyral/i18n';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { noticeText } from '../src/diyalog/auth/notices';
import { DyStepUpDialog } from '../src/diyalog/DyStepUpDialog';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, stubCookies, USER } from './helpers';

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

/** Shell reads answer 404 (never a 401 that would sign out); the palette index lists stay empty. */
function shell(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/options': ok({ rememberMe: { idleDays: 7, absoluteDays: 30 }, trustedDevice: null }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

function chooseInBrowser(locale: Locale): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom's browser language is en-US: Turkish is chosen explicitly (as a Turkish browser would).
  chooseInBrowser('tr');
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('Diyalog sign-in frame in both languages', () => {
  it('tr (default): Turkish frame, fields and validation; <html lang="tr">', async () => {
    const user = userEvent.setup();
    renderApp({ routes: shell(), i18n: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeTruthy();
    expect(screen.getByText('Kontrol paneli')).toBeTruthy();
    expect(screen.getByLabelText('Kullanıcı adı')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Devam et' }));
    expect(screen.getByText('Kullanıcı adını gir.')).toBeTruthy();
    expect(document.documentElement.lang).toBe('tr');
    expect(document.title).toBe('Konsola giriş yap · Remyral');
  });

  it('en: English frame, fields, hint and validation; <html lang="en">', async () => {
    chooseInBrowser('en');
    const user = userEvent.setup();
    renderApp({ routes: shell(), i18n: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to the console' })).toBeTruthy();
    expect(screen.getByText('Control panel')).toBeTruthy();
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(await screen.findByLabelText('Remember me')).toBeTruthy();
    expect(screen.getByText(/up to 30 days \(it closes after 7 days without use\)/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter your username.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(screen.queryByText('Konsola giriş yap')).toBeNull();
    expect(document.documentElement.lang).toBe('en');
  });

  it('session notices follow the language (unknown text passes through)', () => {
    const en = messagesFor('en').auth.notice;
    const tr = messagesFor('tr').auth.notice;
    expect(noticeText('Your session has ended. Sign in again.', tr)).toBe(
      'Oturumun sona erdi. Yeniden giriş yap.',
    );
    expect(noticeText('Your session has ended. Sign in again.', en)).toBe(
      'Your session has ended. Sign in again.',
    );
    expect(noticeText('Signed out everywhere (3 sessions ended).', tr)).toBe(
      'Her yerden çıkış yapıldı (3 oturum kapatıldı).',
    );
    expect(noticeText('Signed out everywhere (1 session ended).', en)).toBe(
      'Signed out everywhere (1 session ended).',
    );
    expect(noticeText('Something the master said.', en)).toBe('Something the master said.');
  });
});

describe('step-up dialog in both languages', () => {
  function renderStepUp(locale: Locale) {
    const props = {
      open: true,
      verify: () => Promise.resolve(),
      onVerified: () => undefined,
      onCancel: () => undefined,
    };
    return render(
      <I18nProvider locale={locale}>
        <DyStepUpDialog {...props} />
      </I18nProvider>,
    );
  }

  it('tr: title, default reason, code label, buttons, wrong-length message', async () => {
    const user = userEvent.setup();
    renderStepUp('tr');
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    expect(
      within(dialog).getByText(/Bu işlem taze bir authenticator kodu ister\. Onay 10 dakika geçerli\./),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(within(dialog).getByText('Authenticator uygulamandaki 6 haneli kodu gir.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Vazgeç' })).toBeTruthy();
  });

  it('en: the same dialog in English', async () => {
    const user = userEvent.setup();
    renderStepUp('en');
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    expect(
      within(dialog).getByText(
        /This action needs a fresh authenticator code\. The confirmation lasts 10 minutes\./,
      ),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('6-digit code'), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(within(dialog).getByText('Enter the 6-digit code from your authenticator app.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('NotFound in both languages', () => {
  it('tr: "Sayfa bulunamadı" with the way back', async () => {
    renderApp({ path: '/nope', initialState: owner, routes: shell(), i18n: true });
    const page = await screen.findByTestId('dy-not-found');
    expect(within(page).getByRole('heading', { level: 1, name: 'Sayfa bulunamadı' })).toBeTruthy();
    expect(within(page).getByText('İstenen adres:')).toBeTruthy();
    expect(within(page).getByRole('link', { name: 'Ana sayfa' }).getAttribute('href')).toBe('/');
    expect(within(page).getByRole('button', { name: 'Tüm ekranlar' })).toBeTruthy();
  });

  it('en: "Page not found" with the way back', async () => {
    chooseInBrowser('en');
    renderApp({ path: '/nope', initialState: owner, routes: shell(), i18n: true });
    const page = await screen.findByTestId('dy-not-found');
    expect(within(page).getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(within(page).getByText('Requested address:')).toBeTruthy();
    expect(within(page).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    expect(within(page).getByRole('link', { name: 'Chat' }).getAttribute('href')).toBe('/chat');
    expect(within(page).getByRole('button', { name: 'All screens' })).toBeTruthy();
    expect(screen.queryByText('Sayfa bulunamadı')).toBeNull();
  });
});

describe('command palette in both languages', () => {
  async function openPalette(locale: Locale) {
    chooseInBrowser(locale);
    const user = userEvent.setup();
    renderApp({ path: '/nope', initialState: owner, routes: shell(), i18n: true });
    await screen.findByTestId('dy-not-found');
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByTestId('dy-palette-input');
    return { user, input };
  }
  const list = (): HTMLElement => screen.getByRole('listbox');

  it('tr: groups, actions, pages, key hints and the empty state', async () => {
    const { user, input } = await openPalette('tr');
    expect(screen.getByRole('dialog', { name: 'Komut paleti' })).toBeTruthy();
    expect(input.getAttribute('placeholder')).toBe('Sayfa, sohbet, iş, makine, eylem…');
    const actions = within(list()).getByRole('group', { name: 'Eylemler' });
    expect(within(actions).getByText('Yeni sohbet')).toBeTruthy();
    const pages = within(list()).getByRole('group', { name: 'Sayfalar' });
    expect(within(pages).getAllByText('İşler').length).toBeGreaterThan(0);
    expect(screen.getByText('Yalnızca görebildiklerin listelenir.')).toBeTruthy();
    await user.type(input, 'zzqqxx');
    expect((await screen.findByTestId('dy-palette-empty')).textContent).toBe(
      '“zzqqxx” ile eşleşen bir sayfa ya da kayıt yok. Anlamına göre aramayı dene.',
    );
  });

  it('en: the same palette in English; items are found by English and Turkish names', async () => {
    const { user, input } = await openPalette('en');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    expect(input.getAttribute('placeholder')).toBe('Page, chat, job, machine, action…');
    expect(input.getAttribute('aria-label')).toBe('Search pages, chats, jobs, machines');
    const actions = within(list()).getByRole('group', { name: 'Actions' });
    expect(within(actions).getByText('New chat')).toBeTruthy();
    expect(within(actions).getByText('Keyboard shortcuts')).toBeTruthy();
    const pages = within(list()).getByRole('group', { name: 'Pages' });
    expect(within(pages).getAllByText('Jobs').length).toBeGreaterThan(0);
    expect(screen.getByText('Only what you can see is listed.')).toBeTruthy();
    expect(screen.queryByText('Eylemler')).toBeNull();

    await user.type(input, 'queue');
    expect(within(list()).getAllByRole('option')[0]?.textContent).toContain('Queue');
    await user.clear(input);
    await user.type(input, 'kuyruk');
    expect(within(list()).getAllByRole('option')[0]?.textContent).toContain('Queue');
    // The AI group offers the meaning search for any query.
    expect(within(list()).getByRole('group', { name: 'With AI' })).toBeTruthy();
    expect(screen.getByText('Ask the assistant: “kuyruk”')).toBeTruthy();

    await user.clear(input);
    await user.type(input, 'zzqqxx');
    expect((await screen.findByTestId('dy-palette-empty')).textContent).toBe(
      'No page or record matches “zzqqxx”. Try searching by meaning.',
    );
  });
});
