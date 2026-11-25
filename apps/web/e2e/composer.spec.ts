import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { loadE2eEnv, REPO_ROOT } from './env';
import { createEnrolledAdmin, resetRateLimits, signInWithCode } from './fixtures';

/**
 * p5-composer against the real master (docs/design/p5-composer.md §7, one page since p6-ui-composer): an owner composes a job
 * in the browser — placement preview from the master's own scheduler over a fleet row, project limits
 * prefilled — submits it and lands on the job; then schedules one on a cron with the step-up dialog.
 * Screenshots (mobile + desktop) go to docs/design/screens/p5-console/. p15-classic-removal: the Diyalog composer
 * (Ne / Nerede / Kurallar), Turkish labels of a new account.
 *
 * The fleet is one worker row written to the throw-away e2e database (no daemon: it is offline), so the
 * preview shows a real "waiting: worker is offline" verdict and the job stays QUEUED.
 */
const OUT = `${REPO_ROOT}docs/design/screens/p5-console/`;
const PROJECT = `e2e-${randomBytes(3).toString('hex')}`;

interface Pool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const dist = new URL('../../master/dist/', import.meta.url);
  const { createPool } = (await import(new URL('db/pool.js', dist).href)) as {
    createPool: (o: { connectionString: string; max?: number }) => Pool;
  };
  const pool = createPool({ connectionString: loadE2eEnv().databaseUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function workerId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz234567';
  return `wrk_${[...randomBytes(26)].map((b) => a[b % 32] ?? 'a').join('')}`;
}

async function seed(): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING',
      [PROJECT, 'E2E Acme'],
    );
    const id = workerId();
    await pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, sandbox_profiles, tools, max_parallel_jobs,
                            capabilities_at, connected_at, last_seen_at, last_ip, created_at, updated_at, approved_at)
       VALUES ($1, 'linux-builder', 'offline',
               '{"os":"linux","osVersion":"6.8","arch":"x64","hostname":"linux-builder","cpuCount":8,"memoryBytes":1,"diskFreeBytes":1}',
               '0.1.0', '["container"]', '[{"name":"git","version":"2.47"},{"name":"node","version":"24"}]', 2,
               now(), now() - interval '1 hour', now() - interval '5 minutes', '192.168.1.40', now(), now(), now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO worker_runtimes (worker_id, runtime, version, os, arch, installed, authenticated, pinned_version,
                                   pin_status, capabilities, first_reported_at, last_reported_at)
       VALUES ($1, 'codex', '0.162.1', 'linux', 'x64', true, 'yes', '0.162.1', 'match', '{}', now(), now())`,
      [id],
    );
    // Project run limits (quota policy): prefilled by the composer.
    await pool.query(
      `INSERT INTO quota_policies (version, policy, created_by, created_at)
       SELECT COALESCE(max(version), 0) + 1, $1, 'e2e', now() FROM quota_policies`,
      [JSON.stringify({ projects: { [PROJECT]: { jobLimits: { maxCostUsd: 4, maxTokens: 500000 } } } })],
    );
  });
}

const VIEWPORTS = [
  {
    name: 'mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  {
    name: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
] as const;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true, animations: 'disabled' });
}

// The first visit compiles the composer in the Vite dev server.
test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  await seed();
});

for (const vp of VIEWPORTS) {
  test.describe(`composer (${vp.name})`, () => {
    test.use({
      viewport: vp.viewport,
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
    });
    test.beforeEach(async () => {
      await resetRateLimits();
    });

    test(`compose, preview placement and submit a job (${vp.name})`, async ({ page }) => {
      const admin = await createEnrolledAdmin('composer');
      await signInWithCode(page, admin, { tap: vp.hasTouch });
      await page.goto('/jobs');
      await page.getByRole('link', { name: 'Yeni iş' }).first().click();
      // One page (p6-ui-composer): Ne, then Nerede and Kurallar as one-line summaries.
      await expect(page.getByRole('heading', { level: 1, name: 'Yeni iş' })).toBeVisible();
      await page.getByLabel('Proje').selectOption(PROJECT);
      await page.getByLabel('Depo adresi').fill('https://github.com/acme/app.git');
      await page.getByLabel('Temel dal').fill('main');
      await page.getByLabel('Ajanın görevi').fill('Upgrade the test runner and fix the deprecations.');
      // Codex is installed on the (offline) machine: it is chosen by itself and the job would wait.
      await expect(page.getByTestId('where-summary')).toContainText('Codex');
      await expect(page.getByTestId('placement-verdict').first()).toHaveAttribute('data-verdict', 'waiting');
      await shot(page, `composer-01-project-${vp.name}`);

      // Nerede: the other runtimes are not installed anywhere, said in plain words.
      await page.getByTestId('composer-toggle-where').click();
      await expect(page.getByTestId('runtime-reason-claude-code')).toBeVisible();
      await expect(page.getByRole('radio', { name: /^Codex/ })).toBeChecked();
      await shot(page, `composer-02-runtime-${vp.name}`);
      await page.getByLabel('Gerekli araçlar').fill('git, node');
      await expect(page.getByTestId('placement-verdict').first()).toHaveAttribute('data-verdict', 'waiting');
      await expect(page.getByTestId('placement-rejected').first()).toBeVisible();
      await shot(page, `composer-03-placement-${vp.name}`);

      // Kurallar: limits filled from the project's run limits.
      await page.getByTestId('composer-toggle-rules').click();
      await expect(page.getByTestId('project-limits')).toContainText('4');
      await expect(page.getByLabel('En yüksek maliyet (USD)')).toHaveValue('4');
      await shot(page, `composer-04-limits-${vp.name}`);

      // Submit stays on screen (sticky footer).
      await expect(page.getByTestId('composer-submit')).toBeInViewport();
      await page.getByTestId('composer-submit').click();
      await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('dy-job-state')).toBeVisible();
      await shot(page, `composer-07-submitted-${vp.name}`);
    });
  });
}

test('schedule a job on a cron with step-up', async ({ page }) => {
  await resetRateLimits();
  const admin = await createEnrolledAdmin('sched');
  await signInWithCode(page, admin);
  await page.goto('/jobs/new');
  await page.getByLabel('Proje').selectOption(PROJECT);
  await page.getByLabel('Depo adresi').fill('https://github.com/acme/app.git');
  await page.getByLabel('Temel dal').fill('main');
  await page.getByLabel('Ajanın görevi').fill('Nightly dependency upgrade.');
  await expect(page.getByTestId('where-summary')).toContainText('Codex');
  await page.getByTestId('composer-toggle-rules').click();
  await page.getByRole('radio', { name: /Tekrarla/ }).check();
  await page.getByLabel('Zamanlama adı').fill('Nightly upgrade');
  await page.getByLabel('Cron ifadesi (UTC)').fill('0 3 * * 1-5');
  await expect(page.getByTestId('cron-runs')).toContainText('Sonraki çalışmalar');
  await shot(page, 'composer-08-schedule-desktop');
  // Ctrl+Enter submits from anywhere in the form.
  await page.getByLabel('Zamanlama adı').press('Control+Enter');
  // The login was more than a moment ago only in principle; the master decides — answer the dialog if asked.
  const dialog = page.getByRole('dialog', { name: 'Sen olduğunu onayla' });
  if (await dialog.isVisible().catch(() => false)) {
    // Filled in one go: the dialog submits itself (p5-mobile).
    await dialog.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
  }
  // p6-automations: a schedule is an automation (the old /jobs/schedules list redirects there).
  await page.goto('/automations');
  await expect(page.getByText('Nightly upgrade').first()).toBeVisible();
  await shot(page, 'composer-09-schedules-desktop');
});
