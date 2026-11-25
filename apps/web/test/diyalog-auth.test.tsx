// p12-diyalog-w4: the sign-in steps, "Oturum denetleniyor…", the step-up confirmation, "Sayfa bulunamadı" and the
// Coolify sign-on page in the Diyalog language (flag on, the per-browser preference read before sign-in) — the same
// requests and rules as the classic screens — and flag off unchanged.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { noticeTr } from '../src/diyalog/auth/notices';
import { browser } from '../src/screens/ssoBrowser';
import { type Handler, INVALID, QR_SVG, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast, toastByTestId } from './toasts';

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function sessionAfterLogin(): Handler {
  let calls = 0;
  return () =>
    ++calls === 1
      ? { status: 401, body: { error: 'unauthorized', message: 'Authentication required.' } }
      : { status: 200, body: sessionBody() };
}

const OPTIONS = ok({ rememberMe: { idleDays: 7, absoluteDays: 30 }, trustedDevice: { days: 30 } });

/** Shell reads answer 404 (never a 401 that would sign out). */
function withShell(over: Record<string, Handler>): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/auth/options': OPTIONS,
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

beforeEach(() => {
  window.localStorage.clear();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('Diyalog sign-in steps', () => {
  it('login: Turkish fields, validation with focus, remember flag sent, no request on empty form', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      routes: {
        'GET /api/auth/options': OPTIONS,
        'POST /api/auth/login': () => ({ status: 200, body: { status: 'mfa_required', csrfToken: 'x' } }),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeTruthy();
    expect(screen.getByTestId('dy-auth').getAttribute('data-ui')).toBe('diyalog');
    const username = screen.getByLabelText('Kullanıcı adı');
    expect(username.getAttribute('autocomplete')).toBe('username');
    await user.click(screen.getByRole('button', { name: 'Devam et' }));
    expect(screen.getByText('Kullanıcı adını gir.')).toBeTruthy();
    expect(screen.getByText('Parolanı gir.')).toBeTruthy();
    expect(document.activeElement).toBe(username);
    expect(requests.filter((r) => r.url === '/api/auth/login')).toHaveLength(0);

    await user.type(username, 'alex');
    await user.type(screen.getByLabelText('Parola'), 'correct horse battery');
    await user.click(await screen.findByLabelText('Beni hatırla'));
    await user.click(screen.getByRole('button', { name: 'Devam et' }));
    expect(await screen.findByRole('heading', { name: 'Authenticator kodunu gir' })).toBeTruthy();
    expect(requests.find((r) => r.url === '/api/auth/login')?.body).toEqual({
      username: 'alex',
      password: 'correct horse battery',
      remember: true,
    });
  });

  it('login: the master’s error in Turkish (code + catalog), password cleared, Retry-After in Turkish blocks resubmission', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp({
      routes: {
        'POST /api/auth/login': () =>
          ++calls === 1
            ? { status: 401, body: INVALID }
            : {
                status: 429,
                body: { error: 'rate_limited', message: 'Too many attempts. Try again later.' },
                headers: { 'retry-after': '125' },
              },
      },
    });
    await user.type(await screen.findByLabelText('Kullanıcı adı'), 'alex');
    await user.type(screen.getByLabelText('Parola'), 'wrong password 123');
    await user.click(screen.getByRole('button', { name: 'Devam et' }));
    expect((await screen.findByTestId('api-error')).textContent).toBe('Giriş bilgileri geçersiz.');
    expect(screen.getByLabelText<HTMLInputElement>('Parola').value).toBe('');
    await user.type(screen.getByLabelText('Parola'), 'again password 123');
    await user.click(screen.getByRole('button', { name: 'Devam et' }));
    expect((await screen.findByTestId('retry-left')).textContent).toMatch(
      /^2 dk 0[45] sn sonra yeniden deneyebilirsin\.$/,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Devam et' }).disabled).toBe(true);
  });

  it('session-ended notices are shown in Turkish (unknown text passes through)', async () => {
    renderApp({
      routes: {},
      initialState: { kind: 'signedOut', notice: 'Your session has ended. Sign in again.' },
    });
    expect((await screen.findByTestId('dy-auth-notice')).textContent).toBe(
      'Oturumun sona erdi. Yeniden giriş yap.',
    );
    expect(noticeTr('Your sign-in attempt has ended. Sign in again.')).toBe(
      'Giriş denemen sona erdi. Yeniden giriş yap.',
    );
    expect(noticeTr('You are signed out.')).toBe('Çıkış yaptın.');
    expect(noticeTr('Signed out everywhere (3 sessions ended).')).toBe(
      'Her yerden çıkış yapıldı (3 oturum kapatıldı).',
    );
    expect(noticeTr('Too many wrong codes — this session was ended for safety. Sign in again.')).toMatch(
      /oturum kapatıldı/,
    );
    expect(noticeTr('Something the master said.')).toBe('Something the master said.');
  });

  it('TOTP: trust device above the code; an autofilled code submits once with the choice', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      initialState: { kind: 'secondFactor', method: 'totp' },
      routes: {
        'GET /api/auth/options': OPTIONS,
        'POST /api/auth/totp/verify': () => ({
          status: 200,
          body: { status: 'authenticated', csrfToken: 'y', user: USER },
        }),
        'GET /api/auth/session': ok(sessionBody()),
      },
    });
    const trust = await screen.findByLabelText('Bu cihaza 30 gün güven');
    const code = screen.getByLabelText('6 haneli kod');
    expect(trust.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    await user.click(trust);
    // A one-time-code autofill / paste fills the whole code in one change.
    fireEvent.change(code, { target: { value: '123 456' } });
    await waitFor(() => {
      expect(requests.filter((r) => r.url === '/api/auth/totp/verify')).toHaveLength(1);
    });
    expect(requests.find((r) => r.url === '/api/auth/totp/verify')?.body).toEqual({
      code: '123456',
      trustDevice: true,
    });
  });

  it('TOTP: a typed code waits for the button; switch to a recovery code and start over', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      initialState: { kind: 'secondFactor', method: 'totp' },
      routes: {
        'POST /api/auth/recovery': () => ({ status: 401, body: INVALID }),
      },
    });
    const code = await screen.findByLabelText('6 haneli kod');
    await user.type(code, '12345');
    await user.click(screen.getByRole('button', { name: 'Doğrula' }));
    expect(screen.getByText('Authenticator uygulamandaki 6 haneli kodu gir.')).toBeTruthy();
    await user.type(code, '6');
    expect(requests.filter((r) => r.url === '/api/auth/totp/verify')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Kurtarma kodu kullan' }));
    const rc = await screen.findByLabelText('Kurtarma kodu');
    await user.click(screen.getByRole('button', { name: 'Kurtarma koduyla giriş yap' }));
    expect(screen.getByText('Kurtarma kodlarından birini gir.')).toBeTruthy();
    await user.type(rc, ' abcd-efgh-ijkl ');
    await user.click(screen.getByRole('button', { name: 'Kurtarma koduyla giriş yap' }));
    expect((await screen.findByTestId('api-error')).textContent).toBe('Giriş bilgileri geçersiz.');
    expect(requests.find((r) => r.url === '/api/auth/recovery')?.body).toEqual({
      code: 'abcd-efgh-ijkl',
    });
    await user.click(screen.getByRole('button', { name: 'Authenticator kodu kullan' }));
    await user.click(await screen.findByRole('button', { name: 'Baştan başla' }));
    expect(await screen.findByRole('heading', { name: 'Konsola giriş yap' })).toBeTruthy();
  });

  it('enrollment: QR as an image, key and otpauth copy, confirm → recovery codes gated by the checkbox', async () => {
    const user = userEvent.setup();
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    const { requests, container } = renderApp({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          body: { status: 'enrollment_required', csrfToken: 'x' },
        }),
        'POST /api/auth/totp/enroll/start': ok({
          otpauthUri: 'otpauth://totp/Remyral:alex?secret=JBSWY3DPEHPK3PXP',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          qrSvg: QR_SVG,
        }),
        'POST /api/auth/totp/enroll/confirm': ok({
          status: 'authenticated',
          csrfToken: 'z',
          user: USER,
          recoveryCodes: Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-${String(i).padStart(4, '0')}`),
        }),
        'GET /api/auth/session': sessionAfterLogin(),
      },
    });
    await user.type(await screen.findByLabelText('Kullanıcı adı'), 'alex');
    await user.type(screen.getByLabelText('Parola'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Devam et' }));

    const img = await screen.findByRole('img', { name: /QR kodu/ });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(container.querySelector('svg rect[fill="white"]')).toBeNull();
    expect(screen.getByTestId('enroll-secret').textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(screen.getByRole('link', { name: 'Authenticator uygulamasında aç' }).getAttribute('href')).toMatch(
      /^otpauth:\/\/totp\//,
    );
    await user.click(screen.getByText('Tarayamıyor musun? Kurulum anahtarını gir'));
    await user.click(screen.getByRole('button', { name: 'Anahtarı kopyala' }));
    expect(write).toHaveBeenCalledWith('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    await user.click(screen.getByRole('button', { name: 'otpauth bağlantısını kopyala' }));
    expect(write).toHaveBeenLastCalledWith('otpauth://totp/Remyral:alex?secret=JBSWY3DPEHPK3PXP');
    expect(requests.filter((r) => r.url === '/api/auth/totp/enroll/start')).toHaveLength(1);

    await user.type(screen.getByLabelText('Uygulamadaki 6 haneli kod'), '654321');
    await user.click(screen.getByRole('button', { name: 'Onayla ve devam et' }));

    const list = await screen.findByRole('list', { name: 'Kurtarma kodları' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    const proceed = screen.getByRole<HTMLButtonElement>('button', { name: 'Konsola devam et' });
    expect(proceed.disabled).toBe(true);
    expect(screen.getByRole('link', { name: '.txt indir' }).getAttribute('download')).toBe(
      'remyral-recovery-codes-alex.txt',
    );
    await user.click(screen.getByRole('button', { name: 'Tümünü kopyala' }));
    expect(write).toHaveBeenLastCalledWith(
      Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-${String(i).padStart(4, '0')}`).join('\n'),
    );
    await user.click(screen.getByLabelText('Bu kurtarma kodlarını güvenli bir yerde sakladım.'));
    expect(proceed.disabled).toBe(false);
  });

  it('enrollment: a setup error offers Yeniden dene', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          body: { status: 'enrollment_required', csrfToken: 'x' },
        }),
        'POST /api/auth/totp/enroll/start': () =>
          ++calls === 1
            ? { status: 500, body: { error: 'internal_error', message: 'Internal server error.' } }
            : { status: 200, body: { otpauthUri: 'otpauth://totp/x', secret: 'ABCD', qrSvg: QR_SVG } },
      },
    });
    await user.type(await screen.findByLabelText('Kullanıcı adı'), 'alex');
    await user.type(screen.getByLabelText('Parola'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Devam et' }));
    expect(await screen.findByText('Internal server error.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(await screen.findByRole('img', { name: /QR kodu/ })).toBeTruthy();
  });

  it('forced password change: policy check in Turkish, hidden username, submit', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      initialState: { kind: 'passwordChange', user: USER, remainingRecoveryCodes: 10 },
      routes: {
        // p15-classic-removal: the classic password-change.test's server refusal and exact request, asserted here.
        'POST /api/auth/password/initial': (req) =>
          (req.body as { newPassword: string }).newPassword === 'a long passphrase here'
            ? { status: 200, body: { status: 'authenticated', csrfToken: 'c', user: USER } }
            : {
                status: 400,
                body: {
                  error: 'weak_password',
                  message: 'Password is too common. Choose a less predictable passphrase.',
                },
              },
        'GET /api/auth/session': ok(sessionBody()),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Kendi parolanı belirle' })).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>('input[name="username"][autocomplete="username"]')?.value,
    ).toBe('alex');
    await user.type(screen.getByLabelText('Yeni parola'), 'short');
    await user.type(screen.getByLabelText('Yeni parolayı tekrarla'), 'other');
    await user.click(screen.getByRole('button', { name: 'Parolayı belirle ve devam et' }));
    expect(screen.getByText('En az 12 karakter kullan.')).toBeTruthy();
    expect(screen.getByText('Parolalar eşleşmiyor.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Yeni parola'));
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    // The server's policy refusal is shown and the fields are cleared.
    await user.clear(screen.getByLabelText('Yeni parola'));
    await user.type(screen.getByLabelText('Yeni parola'), 'qwertyuiop12');
    await user.clear(screen.getByLabelText('Yeni parolayı tekrarla'));
    await user.type(screen.getByLabelText('Yeni parolayı tekrarla'), 'qwertyuiop12');
    await user.click(screen.getByRole('button', { name: 'Parolayı belirle ve devam et' }));
    expect(await screen.findByTestId('api-error')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Yeni parola').value).toBe('');
    await user.type(screen.getByLabelText('Yeni parola'), 'a long passphrase here');
    await user.type(screen.getByLabelText('Yeni parolayı tekrarla'), 'a long passphrase here');
    await user.click(screen.getByRole('button', { name: 'Parolayı belirle ve devam et' }));
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.method === 'POST' && r.url === '/api/auth/password/initial')
          .map((r) => r.body),
      ).toEqual([{ newPassword: 'qwertyuiop12' }, { newPassword: 'a long passphrase here' }]);
    });
  });

  it('"Oturum denetleniyor…" while the session is checked, then the login', async () => {
    renderApp({
      path: '/jobs',
      routes: {
        'GET /api/auth/session': () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }),
      },
    });
    expect(screen.getByTestId('dy-checking').textContent).toContain('Oturum denetleniyor…');
    expect(await screen.findByRole('heading', { name: 'Konsola giriş yap' })).toBeTruthy();
  });

  it('`` on the login URL picks the Diyalog steps', async () => {
    window.localStorage.clear();
    renderApp({ routes: {}, path: '/login' });
    expect(await screen.findByRole('heading', { name: 'Konsola giriş yap' })).toBeTruthy();
  });
});

describe('Diyalog step-up, NotFound and Coolify sign-on', () => {
  it('step-up: the Diyalog dialog asks for the code, autofill submits once, then the action runs', async () => {
    const user = userEvent.setup();
    let confirmed = 0;
    const { requests } = renderApp({
      // p15-form-pattern: "Şimdi kodla doğrula" is in the "Oturum" tab of Profil.
      path: '/settings/profile?tab=session',
      initialState: owner,
      routes: withShell({
        'POST /api/auth/step-up': () => {
          confirmed++;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const opener = await screen.findByRole('button', { name: 'Şimdi kodla doğrula' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    expect(dialog.getAttribute('data-testid')).toBe('dy-stepup');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).getByText(/Onay 10 dakika geçerli\./)).toBeTruthy();
    const code = within(dialog).getByLabelText('6 haneli kod');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    fireEvent.change(code, { target: { value: '654321' } });
    // p17-toasts-rest: the confirmation is a toast.
    expect(await findToast(/^Doğrulandı\./)).toBeTruthy();
    expect(confirmed).toBe(1);
    expect(requests.find((r) => r.url === '/api/auth/step-up')?.body).toEqual({ code: '654321' });
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('step-up: Vazgeç / Escape cancel without a request; a wrong length is refused in Turkish', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/profile?tab=session',
      initialState: owner,
      routes: withShell({}),
    });
    await user.click(await screen.findByRole('button', { name: 'Şimdi kodla doğrula' }));
    let dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    expect(within(dialog).getByText('Authenticator uygulamandaki 6 haneli kodu gir.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    expect(dialog.hasAttribute('open')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Şimdi kodla doğrula' }));
    dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await waitFor(() => {
      expect(dialog.hasAttribute('open')).toBe(false);
    });
    expect(requests.some((r) => r.url === '/api/auth/step-up')).toBe(false);
    expect(toastByTestId('privileged-confirmed')).toBeUndefined();
  });

  it('an unknown path (top level and under /settings) is the Diyalog "Sayfa bulunamadı"', async () => {
    const { unmount } = renderApp({ path: '/nope', initialState: owner, routes: withShell({}) });
    const page = await screen.findByTestId('dy-not-found');
    expect(within(page).getByRole('heading', { level: 1, name: 'Sayfa bulunamadı' })).toBeTruthy();
    expect(within(page).getByText('/nope')).toBeTruthy();
    expect(within(page).getByRole('link', { name: 'Ana sayfa' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText('Page not found')).toBeNull();
    unmount();
    renderApp({ path: '/settings/nope', initialState: owner, routes: withShell({}) });
    expect(await screen.findByTestId('dy-not-found')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  const R = 'A1b2C3d4E5f6G7h8I9j0_-xyzXYZ0123456789abcdef';

  it('SSO: the gate ticket waits for a click and goes only to the fixed path', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    renderApp({
      path: `/sso/continue?flow=coolify&r=${R}`,
      initialState: owner,
      routes: withShell({}),
    });
    const button = await screen.findByRole('button', { name: 'Coolify’ye devam et' });
    expect(screen.getByTestId('dy-sso')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(assign).toHaveBeenCalledWith(`/api/coolify-sso/ticket?r=${R}`);
  });

  it('SSO: OIDC with a stale step-up asks for the code in the Diyalog dialog, cancel → Onayla ve devam et', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp({
      path: `/sso/continue?flow=oidc&r=${R}`,
      initialState: {
        kind: 'signedIn',
        user: USER,
        session: {
          user: USER,
          createdAt: '2026-10-14T10:00:00.000Z',
          expiresAt: '2026-10-14T22:00:00.000Z',
          idleExpiresAt: '2026-10-14T10:30:00.000Z',
          mfaAt: '2026-10-14T10:00:00.000Z',
          stepUpValidUntil: null,
          stepUpScope: 'window',
          alwaysFreshValidUntil: null,
          type: 'standard',
        },
        remainingRecoveryCodes: null,
      },
      routes: withShell({
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
      }),
    });
    let dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    expect(within(dialog).getByText(/Coolify seni oturum açtırmak istiyor/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    await user.click(await screen.findByRole('button', { name: 'Onayla ve devam et' }));
    dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/api/oidc/authorize/resume?r=${R}`);
    });
  });

  it('SSO: malformed links and other roles are refused in Turkish', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    const { unmount } = renderApp({
      path: '/sso/continue?flow=oidc&r=https://evil.example',
      initialState: owner,
      routes: withShell({}),
    });
    expect((await screen.findByTestId('dy-sso-invalid')).textContent).toMatch(/geçersiz/);
    unmount();
    renderApp({
      path: `/sso/continue?flow=coolify&r=${R}`,
      initialState: { ...owner, user: { ...USER, role: 'viewer' } },
      routes: withShell({}),
    });
    expect((await screen.findByTestId('dy-sso-role')).textContent).toMatch(/sahip ya da yönetici/);
    expect(assign).not.toHaveBeenCalled();
  });
});
