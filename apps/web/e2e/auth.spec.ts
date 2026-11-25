import { expect, type Page, test } from '@playwright/test';
import { createEnrolledAdmin, createTestAdmin, resetRateLimits } from './fixtures';
import { Authenticator } from './totp';

// p15-classic-removal: the sign-in steps and the signed-in screens are the Diyalog ones (Turkish: a new account's
// language is Turkish until it picks another). Labels as in apps/web/test/diyalog-auth.test.tsx.
const INVALID = 'Giriş bilgileri geçersiz.';

test.beforeEach(async () => {
  await resetRateLimits();
});

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Kullanıcı adı').fill(username);
  await page.getByLabel('Parola', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Devam et' }).click();
}

async function expectNoClientSecrets(page: Page): Promise<void> {
  const storage = await page.evaluate(() => ({
    keys: Object.keys(window.localStorage),
    session: window.sessionStorage.length,
    // The session cookie is HttpOnly: only the CSRF double-submit cookie may be visible to scripts.
    cookieNames: document.cookie
      .split(';')
      .map((c) => c.split('=')[0]?.trim() ?? '')
      .filter(Boolean),
  }));
  // Only UI preferences live in this browser (language, list views), never a credential or a session token.
  expect(storage.keys.every((k) => k.startsWith('remyral.'))).toBe(true);
  expect(storage.keys).not.toContain('remyral.ui');
  expect(storage.session).toBe(0);
  expect(storage.cookieNames.every((n) => n === '__Host-ras-csrf')).toBe(true);
}

async function openAccountMenu(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByTestId('dy-account').first().click();
  return page.getByRole('region', { name: 'Hesap' });
}

test('first login: enroll authenticator, store recovery codes, reach the console, log out', async ({
  page,
  context,
}) => {
  const admin = await createTestAdmin('enroll');
  await signIn(page, admin.username, admin.password);

  const qr = page.getByRole('img', { name: /QR kodu/ });
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(await qr.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);

  await page.getByText('Tarayamıyor musun? Kurulum anahtarını gir').click();
  const secret = (await page.getByTestId('enroll-secret').innerText()).replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const app = new Authenticator(secret);

  // A wrong code is rejected with the generic message and the form stays usable.
  await page.getByLabel('Uygulamadaki 6 haneli kod').fill(app.wrongCode());
  await page.getByRole('button', { name: 'Onayla ve devam et' }).click();
  await expect(page.getByTestId('api-error')).toContainText(INVALID);

  await page.getByLabel('Uygulamadaki 6 haneli kod').fill(await app.nextCode());
  await page.getByRole('button', { name: 'Onayla ve devam et' }).click();

  const codes = page.getByRole('list', { name: 'Kurtarma kodları' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  await expect(codes.first()).toHaveText(/^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '.txt indir' }).click();
  expect((await download).suggestedFilename()).toBe(`remyral-recovery-codes-${admin.username}.txt`);

  const continueButton = page.getByRole('button', { name: 'Konsola devam et' });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel('Bu kurtarma kodlarını güvenli bir yerde sakladım.').check();
  await continueButton.click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana sayfa' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Diyalog' }).first();
  await nav.getByRole('link', { name: 'Makineler' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Makineler' })).toBeVisible();
  await expectNoClientSecrets(page);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-ras');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');

  for (const [label, heading] of [
    ['İşler', 'İşler'],
    ['Projeler', 'Projeler'],
  ] as const) {
    await nav.getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  // The audit explorer lists this sign-in (p5-search-audit).
  await page.goto('/audit');
  await expect(page.getByRole('main')).toContainText('auth.totp.enroll.confirm');

  const menu = await openAccountMenu(page);
  await menu.getByRole('button', { name: 'Çıkış yap', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeVisible();
  await expect(page.getByText('Çıkış yaptın.')).toBeVisible();

  // The old session is gone server-side: protected pages bounce back to login (old URLs included).
  await page.goto('/fleet?ui=classic');
  await expect(page).toHaveURL(/\/login$/);
});

test('returning user: password + TOTP, step-up, log out everywhere', async ({ page }) => {
  const admin = await createEnrolledAdmin('totp');
  await signIn(page, admin.username, admin.password);

  await expect(page.getByRole('heading', { name: 'Authenticator kodunu gir' })).toBeVisible();
  const codeField = page.getByLabel('6 haneli kod');
  await expect(codeField).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(codeField).toHaveAttribute('inputmode', 'numeric');
  await codeField.fill(await admin.authenticator.nextCode());
  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('account-username').first()).toHaveText(admin.username);

  // Step-up dialog (ready for privileged actions).
  await page.goto('/settings/profile?tab=session');
  await page.getByRole('button', { name: 'Şimdi kodla doğrula' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sen olduğunu onayla' });
  await expect(dialog).toBeVisible();
  // A code filled in one go (one-time-code autofill / paste) submits itself (p5-mobile).
  await dialog.getByLabel('6 haneli kod').fill(admin.authenticator.wrongCode());
  await expect(dialog.getByTestId('api-error')).toContainText(INVALID);
  await dialog.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Doğrulandı\./)).toBeVisible();

  const session = page.getByTestId('dy-session');
  await session.getByRole('button', { name: 'Her yerden çıkış yap' }).click();
  await session.getByRole('button', { name: 'Evet, her yerden çık' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeVisible();
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
});

test('remember me + trust this device: next sign-in skips the code, step-up still asks, revoke', async ({
  page,
  context,
}) => {
  const admin = await createEnrolledAdmin('trust');
  await page.goto('/login');
  await page.getByLabel('Kullanıcı adı').fill(admin.username);
  await page.getByLabel('Parola', { exact: true }).fill(admin.password);
  await page.getByLabel('Beni hatırla').check();
  await page.getByRole('button', { name: 'Devam et' }).click();

  await page.getByLabel('Bu cihaza 30 gün güven').check();
  await page.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page).toHaveURL(/\/$/);
  const device = (await context.cookies()).find((c) => c.name === '__Host-rtd');
  expect(device?.httpOnly).toBe(true);
  expect(device?.sameSite).toBe('Strict');
  await expectNoClientSecrets(page);

  await page.goto('/settings/profile?tab=session');
  await expect(page.getByTestId('dy-session')).toContainText('Hatırlanan (Beni hatırla)');

  // A plain logout keeps the device trust: the next sign-in needs only the password.
  const menu = await openAccountMenu(page);
  await menu.getByRole('button', { name: 'Çıkış yap', exact: true }).click();
  await signIn(page, admin.username, admin.password);
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/settings/profile?tab=session');
  await expect(page.getByTestId('dy-session')).toContainText('Standart');

  // Step-up is never satisfied by the device: the dialog asks for a code.
  await page.getByRole('button', { name: 'Şimdi kodla doğrula' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sen olduğunu onayla' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
  await expect(dialog).toBeHidden();

  // Ayarlar → Cihazlar lists this browser; revoking it makes the next sign-in ask for the code again.
  await page.goto('/settings/devices');
  const trusted = page.getByTestId('dy-trusted-devices');
  await expect(trusted).toContainText('bu tarayıcı');
  await trusted.getByTestId('revoke-all-trusted').click();
  await trusted.getByTestId('revoke-all-trusted-confirm').click();
  await expect(trusted).toContainText('artık güvenilmiyor');
  const menu2 = await openAccountMenu(page);
  await menu2.getByRole('button', { name: 'Çıkış yap', exact: true }).click();
  await signIn(page, admin.username, admin.password);
  await expect(page.getByRole('heading', { name: 'Authenticator kodunu gir' })).toBeVisible();
});

test('wrong password shows the generic error and keeps the user on the login form', async ({ page }) => {
  const admin = await createTestAdmin('badpw');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Devam et' }).click();
  await expect(page.getByText('Kullanıcı adını gir.')).toBeVisible();
  await expect(page.getByLabel('Kullanıcı adı')).toBeFocused();

  await signIn(page, admin.username, `${admin.password}x`);
  await expect(page.getByTestId('api-error')).toContainText(INVALID);
  await expect(page.getByLabel('Parola', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeVisible();

  // Unknown user: exactly the same message (no account enumeration).
  await signIn(page, 'nobody-here', admin.password);
  await expect(page.getByTestId('api-error')).toContainText(INVALID);
});

test('wrong TOTP code shows the generic error, then the right code signs in', async ({ page }) => {
  const admin = await createEnrolledAdmin('badcode');
  await signIn(page, admin.username, admin.password);
  await expect(page.getByRole('heading', { name: 'Authenticator kodunu gir' })).toBeVisible();

  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page.getByText('Authenticator uygulamandaki 6 haneli kodu gir.')).toBeVisible();

  await page.getByLabel('6 haneli kod').fill(admin.authenticator.wrongCode());
  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page.getByTestId('api-error')).toContainText(INVALID);
  await expect(page.getByLabel('6 haneli kod')).toHaveValue('');

  await page.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('recovery code login', async ({ page }) => {
  const admin = await createEnrolledAdmin('recovery');
  await signIn(page, admin.username, admin.password);
  await page.getByRole('button', { name: 'Kurtarma kodu kullan' }).click();

  await page.getByLabel('Kurtarma kodu').fill('0000-0000-0000');
  await page.getByRole('button', { name: 'Kurtarma koduyla giriş yap' }).click();
  await expect(page.getByTestId('api-error')).toContainText(INVALID);

  await page.getByLabel('Kurtarma kodu').fill(admin.recoveryCodes[0] ?? '');
  await page.getByRole('button', { name: 'Kurtarma koduyla giriş yap' }).click();
  await expect(page).toHaveURL(/\/$/);
  const menu = await openAccountMenu(page);
  await expect(menu).toContainText('Kalan kurtarma kodu');
  await expect(menu).toContainText('9');
});
