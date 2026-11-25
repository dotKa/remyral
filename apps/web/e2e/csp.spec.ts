import { expect, test } from '@playwright/test';
import { MASTER_ORIGIN } from './env';
import { createTestAdmin, resetRateLimits } from './fixtures';
import { Authenticator } from './totp';

/**
 * The production bundle must run under the master's Content-Security-Policy (`default-src 'self'`, no
 * 'unsafe-inline'). The header is taken from the running master, so this test follows any CSP change,
 * and applied to every response of the `vite preview` server (which serves the real build output).
 */
test('production build runs under the master CSP without violations', async ({ page, baseURL }) => {
  await resetRateLimits();
  const csp = (await fetch(`${MASTER_ORIGIN}/healthz`)).headers.get('content-security-policy');
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain('unsafe-inline');

  const origin = new URL(baseURL ?? '').origin;
  // Static assets only; /api responses already carry the master's headers.
  const isStatic = (url: URL): boolean => url.origin === origin && !url.pathname.startsWith('/api/');
  await page.route(isStatic, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': csp ?? '' },
    });
  });

  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  await page.exposeFunction('reportCspViolation', (v: string) => {
    violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { reportCspViolation: (v: string) => Promise<void> }).reportCspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });

  const admin = await createTestAdmin('csp');
  const main = await page.goto('/login');
  expect(main?.headers()['content-security-policy']).toBe(csp);
  // p15-classic-removal: the Diyalog sign-in steps (Turkish for a new account).
  await page.getByLabel('Kullanıcı adı').fill(admin.username);
  await page.getByLabel('Parola', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Devam et' }).click();

  const qr = page.getByRole('img', { name: /QR kodu/ });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  // Styles from the external stylesheet are applied (not blocked): the card has a border colour.
  expect(await page.locator('main').evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid');

  await page.getByText('Tarayamıyor musun? Kurulum anahtarını gir').click();
  const secret = (await page.getByTestId('enroll-secret').innerText()).replace(/\s/g, '');
  await page.getByLabel('Uygulamadaki 6 haneli kod').fill(await new Authenticator(secret).nextCode());
  await page.getByRole('button', { name: 'Onayla ve devam et' }).click();
  await expect(page.getByRole('list', { name: 'Kurtarma kodları' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '.txt indir' }).click();
  await download;
  await page.getByLabel('Bu kurtarma kodlarını güvenli bir yerde sakladım.').check();
  await page.getByRole('button', { name: 'Konsola devam et' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ana sayfa' })).toBeVisible();
  // Client-side navigation to Makineler (other specs may have seeded machines: no empty-state check).
  await page
    .getByRole('navigation', { name: 'Diyalog' })
    .first()
    .getByRole('link', { name: 'Makineler' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Makineler' })).toBeVisible();
  await page.goto('/settings/profile?tab=session');
  await page.getByRole('button', { name: 'Şimdi kodla doğrula' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  expect(violations).toEqual([]);
});
