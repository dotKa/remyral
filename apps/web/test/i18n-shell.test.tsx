// p14-i18n-shell (i18n Phase 2): the Diyalog shell chrome comes from the catalog — the rail clock, the "Tüm ekranlar"
// dialog (classic sections included), the keyboard shortcuts, the whole-UI switch, the bell's frame and the account
// menu render in Turkish by default and in English when the user's language is `en`.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Locale } from '@remyral/i18n';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { Countdown, remainingSpoken } from '../src/diyalog/Countdown';
import { sectionLabel } from '../src/diyalog/DiyalogShell';
import { timeAgoTr } from '../src/diyalog/topbar';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { messagesFor } from '@remyral/i18n';
import { type Handler, renderApp, sessionBody } from './helpers';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const page = { status: 200, body: { items: [], nextCursor: null, unreadCount: 0 } };

/** Every route answers an empty page; the session and the clock answer for real. */
const routes = new Proxy(
  {},
  {
    get: (_t, key: string): Handler => {
      if (key === 'GET /api/auth/session') return () => ({ status: 200, body: sessionBody() });
      if (key === 'GET /api/time') return () => ({ status: 200, body: { now: new Date().toISOString() } });
      return () => page;
    },
  },
);

interface Words {
  readonly all: string;
  readonly allTitle: string;
  readonly audit: string;
  readonly approvals: string;
  readonly shortcuts: string;
  readonly goJobs: string;
  readonly then: string;
  readonly ok: string;
  readonly bell: string;
  readonly readAll: string;
  readonly empty: string;
  readonly account: RegExp;
  readonly accountRegion: string;
  readonly role: string;
  readonly logout: string;
  readonly clock: string;
}

const WORDS: Readonly<Record<Locale, Words>> = {
  tr: {
    all: 'Tümü',
    allTitle: 'Tüm ekranlar',
    audit: 'Denetim kaydı',
    approvals: 'Onaylar',
    shortcuts: 'Klavye kısayolları',
    goJobs: 'İşlere git',
    then: 'sonra',
    ok: 'Tamam',
    bell: 'Bildirimler',
    readAll: 'Tümünü okundu say',
    empty: 'Bildirimin yok.',
    account: /Hesap menüsü/,
    accountRegion: 'Hesap',
    role: 'Rol: owner',
    logout: 'Çıkış yap',
    clock: 'Sunucu saati',
  },
  en: {
    all: 'All',
    allTitle: 'All screens',
    audit: 'Audit',
    approvals: 'Approvals',
    shortcuts: 'Keyboard shortcuts',
    goJobs: 'Go to Jobs',
    then: 'then',
    ok: 'OK',
    bell: 'Notifications',
    readAll: 'Mark all read',
    empty: 'No notifications.',
    account: /Account menu/,
    accountRegion: 'Account',
    role: 'Role: owner',
    logout: 'Sign out',
    clock: 'Server time',
  },
};

beforeEach(() => {
  window.localStorage.clear();
});

describe.each(['tr', 'en'] as const)('Diyalog shell chrome in %s', (locale) => {
  const w = WORDS[locale];

  function renderShell(): void {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    renderApp({ path: '/', initialState: signedIn, routes, i18n: true });
  }

  it('rail clock, "Tüm ekranlar" and the keyboard shortcuts', async () => {
    const user = userEvent.setup();
    renderShell();
    const nav = (await screen.findAllByRole('navigation', { name: 'Diyalog' }))[0] as HTMLElement;
    const clock = await within(nav).findByTestId('server-clock');
    expect(clock.getAttribute('title')).toContain(w.clock);

    await user.click(within(nav).getByRole('button', { name: w.all }));
    const all = screen.getByRole('dialog', { name: w.allTitle });
    expect(within(all).getByRole('link', { name: w.audit })).toBeTruthy();
    expect(within(all).getByRole('link', { name: w.approvals })).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.click(within(nav).getByRole('button', { name: w.shortcuts }));
    const help = await screen.findByRole('dialog', { name: w.shortcuts });
    expect(within(help).getByText(w.goJobs)).toBeTruthy();
    // p17-toasts-shortcuts: combos are one key cap each ("⌥J" / "Alt+J"): no "then" chords left.
    expect(within(help).queryByText(w.then)).toBeNull();
    expect(help.textContent).toMatch(/(⌥|Alt\+)J/);
    expect(within(help).getByRole('button', { name: w.ok })).toBeTruthy();
  });

  it('bell frame and account menu', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click((await screen.findAllByTestId('dy-bell'))[0] as HTMLElement);
    const bell = await screen.findByRole('region', { name: w.bell });
    expect(within(bell).getByRole('button', { name: w.readAll })).toBeTruthy();
    expect(await within(bell).findByText(w.empty)).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.click((await screen.findAllByRole('button', { name: w.account }))[0] as HTMLElement);
    const panel = await screen.findByRole('region', { name: w.accountRegion });
    expect(within(panel).getByText(w.role)).toBeTruthy();
    await waitFor(() => {
      expect(within(panel).getByRole('button', { name: w.logout })).toBeTruthy();
    });
  });
});

describe('shell helpers in both languages', () => {
  it('section labels follow the language; an unknown section keeps its classic label', () => {
    expect(sectionLabel({ path: '/audit', label: 'Audit' }, messagesFor('tr').nav)).toBe('Denetim kaydı');
    expect(sectionLabel({ path: '/audit', label: 'Audit' }, messagesFor('en').nav)).toBe('Audit');
    expect(sectionLabel({ path: '/elsewhere', label: 'Else' }, messagesFor('tr').nav)).toBe('Else');
  });

  it('relative time and the countdown', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(timeAgoTr('2026-10-20T11:57:00Z', now)).toBe('3 dakika önce');
    expect(timeAgoTr('2026-10-20T11:57:00Z', now, 'en')).toBe('3 minutes ago');
    expect(remainingSpoken(125 * 60_000)).toBe('2 saat 5 dakika');
    expect(remainingSpoken(61 * 60_000, messagesFor('en').shell.countdown)).toBe('1 hour 1 minute');
    const past = new Date(Date.now() - 1000).toISOString();
    render(
      <I18nProvider locale="en">
        <Countdown until={past} label="Resets" />
      </I18nProvider>,
    );
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Resets: time is up');
  });
});
