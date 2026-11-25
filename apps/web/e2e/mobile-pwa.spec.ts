import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { REPO_ROOT } from './env';
import { createEnrolledAdmin, createJobWithLogs, resetRateLimits, signInWithCode } from './fixtures';
import { mobileIssues } from './mobile-checks';

/**
 * p8-pwa mobile pass at 390 × 844 (docs/design/p8-pwa.md §7): the phone screens used from the installed
 * app — Devices (install + push), Approvals, a job, Chat — keep the p5-mobile bar (no horizontal page
 * scroll, every target ≥ 44 × 44 px), the bottom tab bar is present, and the head links the manifest.
 * Screenshots: docs/design/screens/p8-pwa/.
 */
const OUT = `${REPO_ROOT}docs/design/screens/p8-pwa/`;

test('installed-app screens at 390 px', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-iphone', 'runs once, on the iPhone descriptor');
  test.setTimeout(180_000);
  await mkdir(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await resetRateLimits();
  const admin = await createEnrolledAdmin('pwa');
  const job = await createJobWithLogs(['building\n', '\u001b[32mok\u001b[0m 12 tests passed\n']);
  await page.goto('/login');
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.json');
  expect(await page.locator('link[rel="apple-touch-icon"]').count()).toBe(1);
  await signInWithCode(page, admin, { tap: true });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-bottom-bar]')).toBeVisible();

  const screens: [string, string, () => Promise<void>][] = [
    [
      'devices',
      '/settings/devices',
      async () => {
        await expect(page.getByTestId('dy-this-device')).toBeVisible();
        // Headless Chromium reports Notification.permission "denied" whatever is granted, so either the
        // turn-on button or the "blocked" notice is the right state here.
        await expect(
          page
            .getByRole('button', { name: 'Push bildirimlerini aç' })
            .or(page.getByTestId('dy-this-device').getByText(/engellendi|engelli/)),
        ).toBeVisible();
        await expect(page.getByTestId('dy-push-devices')).toBeVisible();
      },
    ],
    [
      'notifications',
      '/settings/notifications',
      async () => {
        await expect(page.getByTestId('dy-settings')).toBeVisible();
      },
    ],
    ['approvals', '/approvals', () => Promise.resolve()],
    ['job', `/jobs/${job}`, () => Promise.resolve()],
    ['chat', '/chat', () => Promise.resolve()],
  ];
  for (const [name, route, check] of screens) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await check();
    await page.waitForTimeout(800);
    const issues = await mobileIssues(page);
    expect(issues, `${name}: ${JSON.stringify(issues)}`).toEqual([]);
    await page.screenshot({ path: `${OUT}${name}-390.png`, fullPage: false, animations: 'disabled' });
  }
});
