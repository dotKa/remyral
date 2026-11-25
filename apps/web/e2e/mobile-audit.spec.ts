import { mkdir } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { REPO_ROOT } from './env';
import {
  createEnrolledAdmin,
  createJobWithLogs,
  createTestAdmin,
  resetRateLimits,
  signInWithCode,
} from './fixtures';
import { mobileIssues } from './mobile-checks';

/**
 * p5-mobile audit (docs/design/p5-mobile.md §2): every console route at 360 × 740 and 390 × 844 — no
 * horizontal page scroll, no touch target below 44 × 44 px. Runs once (Pixel project: touch + mobile UA);
 * the viewport is set explicitly. Screenshots: docs/design/screens/p5-mobile/audit-*.png.
 * p15-classic-removal: the Diyalog sign-in and screens (the only console); the old `/jobs/schedules` stays in the list
 * (it redirects to Otomasyonlar — old links land on a screen with a heading). `/jobs/interactive` (the OpenHands
 * canvas, removed by ADR-0023) left the list.
 */
const OUT = `${REPO_ROOT}docs/design/screens/p5-mobile/`;

const SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
] as const;

const ROUTES: readonly [string, string][] = [
  ['home', '/'],
  ['machines', '/machines'],
  ['jobs', '/jobs'],
  ['composer', '/jobs/new'],
  ['schedules', '/jobs/schedules'],
  ['job-detail', 'JOB'],
  ['approvals', '/approvals'],
  ['audit', '/audit'],
  ['usage', '/usage'],
  ['settings', '/settings'],
  ['devices', '/settings/devices'],
  ['users', '/settings/users'],
  ['projects', '/projects'],
  ['project', '/projects/e2e'],
  ['chat', '/chat'],
  ['models', '/settings/models'],
  ['credentials', '/settings/credentials'],
  ['runtimes', '/settings/runtimes'],
  ['integrations', '/settings/integrations'],
  ['notifications', '/settings/notifications'],
  ['context', '/context'],
  ['skills', '/skills'],
];

test.describe.configure({ timeout: 300_000 });

async function expectOk(page: Page, where: string): Promise<void> {
  const issues = await mobileIssues(page);
  expect(issues, `${where}: ${JSON.stringify(issues)}`).toEqual([]);
}

for (const size of SIZES) {
  const w = String(size.width);

  test(`sign-in screens at ${w} px`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile-pixel', 'layout audit runs once');
    await mkdir(OUT, { recursive: true });
    await page.setViewportSize(size);
    await resetRateLimits();
    const fresh = await createTestAdmin('audit');
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeVisible();
    await expectOk(page, 'login');
    await page.getByLabel('Kullanıcı adı').fill(fresh.username);
    await page.getByLabel('Parola', { exact: true }).fill(fresh.password);
    await page.getByRole('button', { name: 'Devam et' }).tap();
    await expect(page.getByRole('img', { name: /QR kodu/ })).toBeVisible();
    await page.getByText('Tarayamıyor musun? Kurulum anahtarını gir').tap();
    await expectOk(page, 'enroll');
    await page.screenshot({ path: `${OUT}audit-enroll-${w}.png`, fullPage: true, animations: 'disabled' });

    const enrolled = await createEnrolledAdmin('audit');
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Kullanıcı adı').fill(enrolled.username);
    await page.getByLabel('Parola', { exact: true }).fill(enrolled.password);
    await page.getByRole('button', { name: 'Devam et' }).tap();
    await expect(page.getByRole('heading', { name: 'Authenticator kodunu gir' })).toBeVisible();
    await expectOk(page, 'totp');
    await page.getByRole('button', { name: 'Kurtarma kodu kullan' }).tap();
    await expect(page.getByLabel('Kurtarma kodu')).toBeVisible();
    await expectOk(page, 'recovery code');
  });

  test(`console routes at ${w} px`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile-pixel', 'layout audit runs once');
    await mkdir(OUT, { recursive: true });
    await page.setViewportSize(size);
    await resetRateLimits();
    const admin = await createEnrolledAdmin('audit');
    // A job whose output has long unbroken tokens (hashes, URLs) — the case that used to widen the page.
    const job = await createJobWithLogs([
      `fetching https://git.example.test/acme/app.git?ref=${'a'.repeat(80)}\n`,
      'sha256:6ccb921d4de157257c702fc7eb519b17d6d646970f1d6c2b3e1f0a9c8b7d6e5f4 verified\n',
      '\u001b[32mok\u001b[0m 42 tests passed\n',
    ]);
    await signInWithCode(page, admin, { tap: true });
    await expect(page).toHaveURL(/\/$/);

    for (const [name, route] of ROUTES) {
      await page.goto(route === 'JOB' ? `/jobs/${job}` : route);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      // Let lazy panels (previews, tables) render before measuring; the live view streams over SSE, so the
      // network never goes idle — wait a fixed moment instead.
      await page.waitForTimeout(1_000);
      await expectOk(page, name);
      await page.screenshot({
        path: `${OUT}audit-${name}-${w}.png`,
        fullPage: false,
        animations: 'disabled',
      });
    }

    // Open states: account menu and notification panel.
    await page.goto('/jobs');
    await page.getByTestId('dy-account').first().tap();
    await expectOk(page, 'account menu');
    await page.keyboard.press('Escape');
    await page.getByTestId('dy-bell').first().tap();
    await expectOk(page, 'notifications panel');
    await page.keyboard.press('Escape');

    // The job's Ayrıntılar → Loglar with long lines (the former classic Logs tab id).
    await page.goto(`/jobs/${job}?view=details&tab=logs`);
    await expect(page.getByRole('log', { name: 'Log çıktısı' })).toBeVisible();
    await expectOk(page, 'job logs');
  });
}
