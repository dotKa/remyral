import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { REPO_ROOT } from './env';
import {
  ageStepUp,
  createEnrolledAdmin,
  type EnrolledAdmin,
  type FakeWorker,
  resetRateLimits,
  startFakeWorker,
  withE2ePool,
} from './fixtures';
import { mobileIssues } from './mobile-checks';

/**
 * p5-mobile, acceptance A-UX-1 ("mobile dashboard spawns, supervises and cancels jobs securely") against the
 * real master and a real worker daemon running the fake runtime (e2e/fake-worker.mjs), on phone device
 * descriptors (projects `mobile-iphone` / `mobile-pixel` in playwright.config.ts):
 *
 *   sign in with password + TOTP → compose a job in the composer → watch its live events → approve the
 *   agent's in-run approval request with a fresh authenticator code (step-up dialog) → see the run finish →
 *   compose a second job and cancel it while it runs.
 *
 * Every screen on the way is checked for horizontal page scroll and touch targets < 44 px (mobile-checks.ts).
 * p15-classic-removal: on the Diyalog screens (Turkish labels of a new account); the approval's code is asked in
 * place on the decision, not in a dialog.
 * Screenshots: docs/design/screens/p5-mobile/.
 */
const OUT = `${REPO_ROOT}docs/design/screens/p5-mobile/`;
const PROJECT = `m-${randomBytes(3).toString('hex')}`;
const REPO_URL = 'https://git.example.test/acme/app.git';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let admin: EnrolledAdmin;
let worker: FakeWorker | null = null;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await mkdir(OUT, { recursive: true });
  await resetRateLimits();
  await withE2ePool(async (pool) => {
    await pool.query(
      `INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT, 'Pocket App'],
    );
  });
  admin = await createEnrolledAdmin('phone');
  worker = await startFakeWorker(admin, { project: PROJECT, repoUrl: REPO_URL });
});

test.afterAll(async () => {
  await worker?.stop();
});

function device(name: string): string {
  return name.replace(/^mobile-/, '');
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false, animations: 'disabled' });
}

/** No horizontal page scroll and no touch target below 44 × 44 px on the current screen. */
async function expectMobileOk(page: Page, where: string): Promise<void> {
  const issues = await mobileIssues(page);
  expect(issues, `${where}: ${JSON.stringify(issues)}`).toEqual([]);
}

async function nav(page: Page, label: string): Promise<void> {
  // The bottom bar is the primary navigation on phones.
  await page.locator('[data-bottom-bar]').getByRole('link', { name: label }).tap();
}

async function compose(page: Page, prompt: string): Promise<string> {
  await nav(page, 'İşler');
  await page.getByRole('link', { name: 'Yeni iş' }).first().tap();
  await expect(page.getByRole('heading', { level: 1, name: 'Yeni iş' })).toBeVisible();
  await page.getByLabel('Proje').selectOption(PROJECT);
  await page.getByLabel('Depo adresi').fill(REPO_URL);
  await page.getByLabel('Temel dal').fill('main');
  // The runtime a machine can run now is chosen by itself (p6-ui-composer).
  await expect(page.getByTestId('where-summary')).toContainText('Codex');
  await expect(page.getByTestId('placement-verdict').first()).toHaveAttribute('data-verdict', 'placed');
  await page.getByLabel('Ajanın görevi').fill(prompt);
  await page.getByTestId('composer-submit').tap();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

test('A-UX-1: sign in, compose, supervise, approve with step-up, cancel', async ({ page }, info) => {
  const d = device(info.project.name);

  // 1. Sign in: password, then the authenticator code (one-time-code field).
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeVisible();
  await expectMobileOk(page, 'login');
  await shot(page, `01-login-${d}`);
  await page.getByLabel('Kullanıcı adı').fill(admin.username);
  await page.getByLabel('Parola', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Devam et' }).tap();
  const code = page.getByLabel('6 haneli kod');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await expectMobileOk(page, 'totp');
  await shot(page, `02-totp-${d}`);
  // A code filled in one go submits itself.
  await code.fill(await admin.authenticator.nextCode());
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/machines');
  await expect(page.getByText('pocket-runner').first()).toBeVisible();
  await expectMobileOk(page, 'fleet');
  await shot(page, `03-fleet-${d}`);

  // 2. Compose a job that will ask for an approval.
  const approvalJob = await compose(page, 'Update the README and push the branch. [approval]');

  // 3. Supervise: the activity log fills; the run stops at the approval request.
  const log = page.getByRole('log', { name: 'Akış günlüğü' });
  await expect(log).toBeVisible();
  await expect(log.getByText('Reading the repository layout.').first()).toBeVisible({ timeout: 30_000 });
  await expectMobileOk(page, 'job detail (live)');
  await shot(page, `04-job-live-${d}`);

  // 4. Approve from Onaylar. The sign-in was "a while ago" → the decision asks for a code in place.
  await ageStepUp(admin.username);
  await page.goto('/approvals');
  const item = page
    .getByTestId('approval-card')
    .filter({ hasText: /Push the work branch to origin/ })
    .first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  await expectMobileOk(page, 'approvals inbox');
  await shot(page, `05-approvals-${d}`);
  await item.tap();
  const detail = page.getByTestId('approval-detail');
  await expect(detail.getByRole('button', { name: 'Onayla' })).toBeVisible();
  await expectMobileOk(page, 'approval detail');
  await shot(page, `06-approval-detail-${d}`);
  await detail.getByRole('button', { name: 'Onayla' }).tap();
  const stepUpCode = detail.locator('input[autocomplete="one-time-code"]');
  await expect(stepUpCode).toBeVisible();
  await expect(stepUpCode).toBeFocused();
  await expectMobileOk(page, 'step-up code');
  await shot(page, `07-step-up-${d}`);
  // An authenticator/OS one-time-code autofill inserts all six digits at once; the decision submits itself.
  await stepUpCode.fill(await admin.authenticator.nextCode());
  await expect(stepUpCode).toBeHidden({ timeout: 15_000 });

  // 5. The run continues and finishes.
  await page.goto(`/jobs/${approvalJob}`);
  await expect(page.getByText('Push approved; finishing up.').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('dy-job-state')).toHaveAttribute(
    'data-state',
    /SUCCEEDED|VERIFYING|AWAITING_APPROVAL/,
    { timeout: 30_000 },
  );
  await shot(page, `08-job-finished-${d}`);

  // 6. A second job runs "forever"; cancel it from the phone.
  const holdJob = await compose(page, 'Run the test suite in watch mode. [hold]');
  await expect(page.getByTestId('dy-job-state')).toHaveAttribute('data-state', 'RUNNING', {
    timeout: 30_000,
  });
  await page.getByTestId('dy-job-header').getByRole('button', { name: 'İptal et' }).tap();
  const cancel = page.getByRole('dialog');
  await cancel.getByRole('textbox').fill('Started by mistake.');
  await expectMobileOk(page, 'cancel confirmation');
  await shot(page, `09-cancel-confirm-${d}`);
  await cancel.getByRole('button', { name: 'Confirm cancel' }).tap();
  await expect(page.getByTestId('dy-job-state')).toHaveAttribute('data-state', /CANCELLING|CANCELLED/, {
    timeout: 30_000,
  });
  await shot(page, `10-cancelled-${d}`);

  // The master's record agrees: the second job was cancelled, both ran on the worker.
  await expect
    .poll(
      async () =>
        withE2ePool(async (pool) =>
          (await pool.query('SELECT state FROM jobs WHERE id = $1::uuid', [holdJob])).rows.map((r) =>
            String(r.state),
          ),
        ),
      { timeout: 30_000 },
    )
    .toEqual(['CANCELLED']);
  expect(worker?.spawned()).toEqual(expect.arrayContaining([approvalJob, holdJob]));
});
