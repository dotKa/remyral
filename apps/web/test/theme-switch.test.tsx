// p17-remyral-brand: the light / dark switch (Açık / Koyu / Sistem) — applied on <html> before the first paint
// (public/theme-boot.js), in the account menu and Ayarlar → Profil, saved for the account (PUT /me/theme), followed
// from the session, every storage access guarded; and every Diyalog colour token has a light and a dark value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY } from '../src/theme/theme';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

const css = readFileSync(join(__dirname, '../src/diyalog/diyalog.css'), 'utf8');
const boot = readFileSync(join(__dirname, '../public/theme-boot.js'), 'utf8');
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'PUT /api/me/theme': (r) => ({
      status: 200,
      body: { theme: (r.body as { theme: string }).theme, changed: true },
    }),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      k in t ? t[k] : ((() => ({ status: 404, body: { error: 'not_found', message: 'x' } })) as Handler),
  });
}

const html = (): HTMLElement => document.documentElement;
/** Runs public/theme-boot.js as the browser would, against this page's window and document. */
const runBoot = (): void => {
  runInNewContext(boot, { window, document });
};

beforeEach(() => {
  window.localStorage.clear();
  html().removeAttribute('data-theme');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  html().removeAttribute('data-theme');
});

describe('theme state', () => {
  it('light / dark mark <html> and are remembered; system clears both', () => {
    applyTheme('dark');
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
    applyTheme('system');
    expect(html().hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readStoredTheme()).toBe('system');
  });

  it('storage that throws (private mode, blocked site data) never breaks the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readStoredTheme()).toBe('system');
    expect(() => {
      applyTheme('light');
    }).not.toThrow();
    expect(html().getAttribute('data-theme')).toBe('light');
    // The boot script too: no mark, no exception.
    html().removeAttribute('data-theme');
    expect(() => {
      runBoot();
    }).not.toThrow();
    expect(html().hasAttribute('data-theme')).toBe(false);
  });

  it('the boot script marks <html> from the stored choice before the app runs; it is loaded from <head>', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    runBoot();
    expect(html().getAttribute('data-theme')).toBe('dark');
    html().removeAttribute('data-theme');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'bogus');
    runBoot();
    expect(html().hasAttribute('data-theme')).toBe(false);
    const index = readFileSync(join(__dirname, '../index.html'), 'utf8');
    const head = index.slice(0, index.indexOf('</head>'));
    expect(head).toContain('<script src="/theme-boot.js"></script>');
    // Before any stylesheet or module (no flash); never inline (CSP).
    expect(head.indexOf('theme-boot.js')).toBeLessThan(
      head.indexOf('type="module"') === -1 ? Infinity : head.indexOf('type="module"'),
    );
  });
});

describe('the switch', () => {
  it('Ayarlar → Profil: Açık / Koyu / Sistem; a choice applies at once and is saved for the account', async () => {
    const user = userEvent.setup();
    const r = renderApp({ path: '/settings/profile', initialState: owner, routes: routes() });
    const panel = await screen.findByTestId('dy-theme-panel');
    const group = within(panel).getByRole('radiogroup', { name: 'Görünüm' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((b) => b.textContent),
    ).toEqual(['Açık', 'Koyu', 'Sistem']);
    // Sistem is the default.
    expect(within(group).getByRole('radio', { name: 'Sistem' }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(group).getByRole('radio', { name: 'Koyu' }));
    expect(html().getAttribute('data-theme')).toBe('dark');
    await waitFor(() => {
      expect(r.requests.find((q) => q.url === '/api/me/theme')?.body).toEqual({ theme: 'dark' });
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('the account menu has the same switch; a failed save keeps the choice in this browser and says so', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/',
      initialState: owner,
      routes: routes({
        'PUT /api/me/theme': () => ({ status: 500, body: { error: 'internal', message: 'boom' } }),
      }),
    });
    await user.click(await screen.findByTestId('dy-account'));
    const menu = await screen.findByTestId('dy-theme-menu');
    await user.click(within(menu).getByRole('radio', { name: 'Açık' }));
    expect(html().getAttribute('data-theme')).toBe('light');
    expect(await within(menu).findByText(/Görünüm hesabına kaydedilemedi/)).toBeTruthy();
  });

  it('follows the account: a theme chosen on another device arrives with the session', async () => {
    // No initial state: the console reads the session as on a real page load.
    renderApp({
      path: '/',
      routes: routes({
        'GET /api/auth/session': () => ({
          status: 200,
          body: { ...(sessionBody() as object), theme: 'dark' },
        }),
      }),
    });
    await waitFor(() => {
      expect(html().getAttribute('data-theme')).toBe('dark');
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('tokens', () => {
  const names = (re: RegExp): Set<string> =>
    new Set([...(re.exec(css)?.[1] ?? '').matchAll(/--dy-([a-z0-9-]+):/g)].map((m) => m[1] ?? ''));
  const light = names(/\[data-ui='diyalog'\] \{([^}]*)\}/);
  const darkMedia = names(/\[data-ui='diyalog'\]:not\(\[data-theme='light'\]\) \{([^}]*)\}/);
  const darkAttr = names(/\[data-ui='diyalog'\]\[data-theme='dark'\] \{([^}]*)\}/);
  // Shape and motion, not colour: the same in both themes.
  const SHAPE = new Set(['r-card', 'r-band', 'r-ctl', 'ease']);

  it('every Diyalog colour token has a light and a dark value', () => {
    expect(light.size).toBeGreaterThan(40);
    for (const n of light) {
      if (SHAPE.has(n)) continue;
      expect(darkMedia.has(n), `dark (system) --dy-${n}`).toBe(true);
      expect(darkAttr.has(n), `dark (chosen) --dy-${n}`).toBe(true);
    }
    for (const n of darkMedia) expect(light.has(n), `light --dy-${n}`).toBe(true);
  });

  it('the choice on <html> wins over the device: Koyu on a light device, Açık on a dark one', () => {
    expect(css).toContain(":root:not([data-theme='light']) [data-ui='diyalog']:not([data-theme='light']) {");
    expect(css).toContain(":root[data-theme='dark'] [data-ui='diyalog']:not([data-theme='light']),");
    const classic = readFileSync(join(__dirname, '../src/index.css'), 'utf8');
    expect(classic).toContain(":root:not([data-theme='light']) {");
    expect(classic).toContain(":root[data-theme='dark'] {");
  });
});
