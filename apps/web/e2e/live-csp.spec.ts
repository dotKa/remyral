import { expect, test } from '@playwright/test';
import { MASTER_ORIGIN } from './env';
import { createEnrolledAdmin, createJobWithLogs, resetRateLimits, signInWithCode } from './fixtures';

/**
 * p5-live (T-INJ-4): hostile agent output — a `<script>`, an `<img onerror>` and an OSC 52 clipboard
 * write — renders inert in the production build under the master's CSP: no script runs, no CSP violation,
 * the clipboard is not written and no escape byte reaches the DOM. Runs in the `csp` project.
 */
test('hostile log lines render inert under the master CSP', async ({ page, baseURL, context }) => {
  await resetRateLimits();
  const csp = (await fetch(`${MASTER_ORIGIN}/healthz`)).headers.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  const origin = new URL(baseURL ?? '').origin;
  await page.route(
    (url) => url.origin === origin && !url.pathname.startsWith('/api/'),
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
    },
  );
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  await page.exposeFunction('reportCspViolation', (v: string) => {
    violations.push(v);
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { reportCspViolation: (v: string) => Promise<void> }).reportCspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });

  const ESC = '\u001b';
  const jobId = await createJobWithLogs([
    '<script>window.__pwned = 1</script>\n',
    '<img src=x onerror="window.__pwned = 2">\n',
    `${ESC}]52;c;cm0gLXJmIH4=\u0007clipboard attempt\n`,
    `${ESC}[1;31mred${ESC}[0m ${ESC}[2J${ESC}[?1049h done\n`,
  ]);

  const admin = await createEnrolledAdmin('live');
  await signInWithCode(page, admin);
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));

  // p15-classic-removal: the Diyalog job page's Ayrıntılar → Loglar (the former classic tab id `logs`).
  await page.goto(`/jobs/${jobId}?view=details&tab=logs`);
  const out = page.getByRole('log', { name: 'Log çıktısı' });
  await expect(out.getByText('<script>window.__pwned = 1</script>')).toBeVisible();
  await expect(out.getByText('clipboard attempt')).toBeVisible();
  await expect(out.getByText('red', { exact: true })).toHaveClass('ansi-fg-1 ansi-b');

  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await out.locator('script, img').count()).toBe(0);
  const html = await out.innerHTML();
  expect(html).not.toContain('\u001b');
  expect(html).not.toContain('52;c;');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('untouched');
  expect(violations).toEqual([]);
});
