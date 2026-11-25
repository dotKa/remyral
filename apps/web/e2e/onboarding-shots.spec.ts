import { mkdir } from 'node:fs/promises';
import { type Page, test } from '@playwright/test';
import { createEnrolledAdmin, type EnrolledAdmin, resetRateLimits, withE2ePool } from './fixtures';

/**
 * Review screenshots of the first-run setup (not part of any suite; run on demand): the signed-out first-owner
 * screen, every wizard step, the home card, empty-state hints and the update banner, in Turkish at 1440x900.
 * Output: ONBOARDING_SHOTS_DIR (default test-results/onboarding/ under apps/web). ONBOARDING_SCHEME=dark takes them in the
 * dark theme (p17-remyral-brand).
 */
const OUT = process.env.ONBOARDING_SHOTS_DIR ?? 'test-results/onboarding/';
const STEPS = [
  'account',
  'organisation',
  // p17-remyral-brand: the public address, TLS and access (read-only, self-hosted guidance).
  'domain',
  'security',
  'machine',
  'git',
  'integrations',
  'project',
  'sample_job',
  'done',
] as const;

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let admin: EnrolledAdmin;

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled', fullPage: true });
}

async function attempt(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.log(
      `SHOT FAILED ${name}: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}`,
    );
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/Username|Kullanıcı adı/).fill(admin.username);
  await page.getByLabel(/^(Password|Parola)$/).fill(admin.password);
  await page.getByRole('button', { name: /^(Continue|Devam et)$/ }).click();
  const code = page.getByLabel(/6-digit code|6 haneli kod/);
  await code.fill(await admin.authenticator.nextCode());
  await code.press('Enter').catch(() => undefined);
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 20_000 });
}

test('onboarding shots', async ({ browser }) => {
  await mkdir(OUT, { recursive: true });
  await resetRateLimits();
  admin = await createEnrolledAdmin('wiz');
  await withE2ePool(async (pool) => {
    await pool.query(`UPDATE users SET locale = 'tr' WHERE username = $1`, [admin.username]);
    // A fresh installation: the wizard is not completed and nothing was recorded yet.
    await pool.query(
      `INSERT INTO onboarding_state (id, organisation_name, steps, completed_at, updated_at)
       VALUES (1, NULL, '{}'::jsonb, NULL, now())
       ON CONFLICT (id) DO UPDATE SET organisation_name = NULL, steps = '{}'::jsonb, completed_at = NULL,
                                      completed_by = NULL, updated_at = now()`,
    );
  });
  const base = {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce' as const,
    colorScheme: process.env.ONBOARDING_SCHEME === 'dark' ? ('dark' as const) : ('light' as const),
  };

  // Signed out, no account yet: the first-owner screen and the login link to it.
  const out = await browser.newContext(base);
  await out.route('**/api/setup/status', (r) => r.fulfill({ json: { required: true } }));
  const p0 = await out.newPage();
  await attempt('00-login-ilk-kurulum', async () => {
    await p0.goto('/login');
    await shot(p0, '00-login-ilk-kurulum');
  });
  await attempt('01-setup', async () => {
    await p0.goto('/setup');
    await shot(p0, '01-setup');
  });
  await out.close();

  const ctx = await browser.newContext(base);
  ctx.setDefaultTimeout(15_000);
  // A newer signed release is available (the banner reads the master's verified feed status).
  await ctx.route('**/api/updates/status', (r) =>
    r.fulfill({
      json: {
        configured: true,
        currentVersion: '1.0.0',
        latest: {
          version: '1.1.0',
          publishedAt: new Date().toISOString(),
          minWorkerVersion: '1.0.77',
          breaking: [],
          summary: 'Tanılama, GitLab / Bitbucket ve webhook kataloğu.',
          notes: '## 1.1.0\n\n- Tanılama (doctor)\n- GitLab ve Bitbucket\n- Giden webhook kataloğu',
        },
        updateAvailable: true,
        newer: [],
        checkedAt: new Date().toISOString(),
        error: null,
        command: 'sudo remyral-ctl upgrade --to 1.1.0',
      },
    }),
  );
  const page = await ctx.newPage();
  await signIn(page);

  await attempt('02-home', async () => {
    await page.goto('/');
    await shot(page, '02-home-kart');
  });
  let n = 3;
  for (const step of STEPS) {
    const name = `${String(n).padStart(2, '0')}-adim-${step}`;
    n += 1;
    await attempt(name, async () => {
      await page.goto(`/onboarding?step=${step}`);
      await shot(page, name);
    });
    if (step === 'organisation') {
      const filled = `${String(n).padStart(2, '0')}-adim-organisation-kaydedildi`;
      n += 1;
      await attempt(filled, async () => {
        const field = page.getByRole('textbox').first();
        await field.fill('Acme Teknoloji');
        await page
          .getByRole('button', { name: /Kaydet/ })
          .first()
          .click();
        await page.waitForTimeout(800);
        await shot(page, filled);
      });
    }
  }
  for (const [path, name] of [
    ['/machines', 'bos-makineler'],
    ['/projects', 'bos-projeler'],
    ['/jobs', 'bos-isler'],
  ] as const) {
    const file = `${String(n).padStart(2, '0')}-${name}`;
    n += 1;
    await attempt(file, async () => {
      await page.goto(path);
      await shot(page, file);
    });
  }
  await ctx.close();
});
