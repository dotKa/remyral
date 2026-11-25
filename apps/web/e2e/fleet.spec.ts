import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { loadE2eEnv, REPO_ROOT } from './env';
import { createEnrolledAdmin, resetRateLimits, signInWithCode } from './fixtures';
import { mobileIssues } from './mobile-checks';

/**
 * p5-fleet-ui against the real master: worker rows (no daemons) in two networks with different runtimes,
 * readiness and capacity; list, map and compatibility views; screenshots for docs/design/screens/p5-console/.
 * p15-classic-removal: on the Diyalog Makineler screens (`fleet-*` shots now show them).
 */
const OUT = `${REPO_ROOT}docs/design/screens/p5-console/`;

interface Pool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

async function withPool(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const dist = new URL('../../master/dist/', import.meta.url);
  const { createPool } = (await import(new URL('db/pool.js', dist).href)) as {
    createPool: (o: { connectionString: string; max?: number }) => Pool;
  };
  const pool = createPool({ connectionString: loadE2eEnv().databaseUrl, max: 1 });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

function workerId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz234567';
  return `wrk_${[...randomBytes(26)].map((b) => a[b % 32] ?? 'a').join('')}`;
}

const SUPPORTED = JSON.stringify({
  streaming: { status: 'supported' },
  cancel: { status: 'supported' },
  approval: { status: 'supported' },
});

const FLEET = [
  {
    name: 'mac-studio',
    os: 'darwin',
    arch: 'arm64',
    ip: '192.168.1.20',
    state: 'online',
    max: 4,
    runtimes: [
      ['claude-code', '2.1.0', 'match'],
      ['codex', '0.162.1', 'match'],
    ],
    profiles: ['host-restricted'],
    readiness: [
      { profile: 'host-restricted', ready: true },
      { profile: 'container', ready: false, reason: 'no rootless container engine' },
    ],
  },
  {
    name: 'linux-runner',
    os: 'linux',
    arch: 'x64',
    ip: '192.168.1.40',
    state: 'online',
    max: 2,
    runtimes: [
      ['codex', '0.160.0', 'mismatch'],
      ['opencode', '1.19.0', 'match'],
    ],
    profiles: ['container', 'runtime-sandbox'],
    readiness: [
      { profile: 'container', ready: true, runtimes: ['codex', 'opencode'] },
      { profile: 'runtime-sandbox', ready: true },
    ],
  },
  {
    name: 'pi-garage',
    os: 'linux',
    arch: 'arm64',
    ip: '10.8.0.12',
    state: 'offline',
    max: 1,
    runtimes: [['pi', '1.1.0', 'match']],
    profiles: ['container'],
    readiness: [{ profile: 'runtime-sandbox', ready: false, reason: 'bwrap cannot create user namespaces' }],
  },
] as const;

async function seed(): Promise<void> {
  await withPool(async (pool) => {
    // Idempotent: a retried worker process runs beforeAll again.
    const seeded = await pool.query('SELECT 1 FROM workers WHERE display_name = $1', ['mac-studio']);
    if (seeded.rows.length > 0) return;
    for (const w of FLEET) {
      const id = workerId();
      await pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, sandbox_profiles, sandbox_readiness, tools,
                              max_parallel_jobs, capabilities_at, connected_at, last_seen_at, last_ip, load, created_at,
                              updated_at, approved_at)
         VALUES ($1, $2, $3, $4, '0.1.0', $5, $6, '[{"name":"git","version":"2.47"}]', $7, now(),
                 now() - interval '1 hour', now() - interval '2 minutes', $8,
                 '{"cpuPercent":23,"memoryFreeBytes":8589934592,"diskFreeBytes":214748364800}', now(), now(), now())`,
        [
          id,
          w.name,
          w.state,
          JSON.stringify({
            os: w.os,
            osVersion: '1',
            arch: w.arch,
            hostname: w.name,
            cpuCount: 8,
            memoryBytes: 1,
            diskFreeBytes: 1,
          }),
          JSON.stringify(w.profiles),
          JSON.stringify(w.readiness),
          w.max,
          w.ip,
        ],
      );
      for (const [runtime, version, pin] of w.runtimes) {
        await pool.query(
          `INSERT INTO worker_runtimes (worker_id, runtime, version, os, arch, installed, authenticated, pinned_version,
                                       pin_status, capabilities, first_reported_at, last_reported_at)
           VALUES ($1, $2, $3, $4, $5, true, 'yes', $6, $7, $8, now(), now())`,
          [id, runtime, version, w.os, w.arch, pin === 'match' ? version : '0.162.1', pin, SUPPORTED],
        );
      }
    }
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

test.describe.configure({ timeout: 240_000 });
test.beforeAll(async () => {
  await seed();
});

for (const vp of VIEWPORTS) {
  test.describe(`fleet (${vp.name})`, () => {
    test.use({
      viewport: vp.viewport,
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
    });

    test(`list, map, compatibility and details (${vp.name})`, async ({ page }) => {
      await resetRateLimits();
      const admin = await createEnrolledAdmin('fleet');
      await signInWithCode(page, admin, { tap: vp.hasTouch });
      await page.goto('/machines');
      await expect(page.getByRole('heading', { level: 1, name: 'Makineler' })).toBeVisible();
      await expect(page.getByTestId('machine-row').filter({ hasText: 'mac-studio' })).toBeVisible();
      await shot(page, `fleet-01-list-${vp.name}`);
      if (vp.isMobile) expect(await mobileIssues(page)).toEqual([]);

      // p6-ui-machines: a row opens the machine page; its sections are URL tabs (the classic tab ids).
      await page
        .getByRole('link', { name: /pi-garage/ })
        .first()
        .click();
      await expect(page).toHaveURL(/\/machines\/wrk_/);
      await expect(page.getByRole('heading', { level: 1, name: 'pi-garage' })).toBeVisible();
      await shot(page, `fleet-02-details-${vp.name}`);
      if (vp.isMobile) expect(await mobileIssues(page)).toEqual([]);
      await page.getByRole('tab', { name: 'Runtime’lar' }).click();
      await expect(page).toHaveURL(/tab=runtimes/);
      if (vp.isMobile) expect(await mobileIssues(page)).toEqual([]);
      await page.getByRole('tab', { name: 'Etkinlik' }).click();
      await expect(page).toHaveURL(/tab=activity/);
      await page.goto('/machines');

      await page.getByRole('tab', { name: 'Ağ haritası' }).click();
      await expect(page.getByTestId('network-group').first()).toContainText('192.168.1.0/24');
      await shot(page, `fleet-03-map-${vp.name}`);

      await page.getByRole('tab', { name: 'Uyumluluk' }).click();
      await expect(page.getByTestId('compat-matrix')).toBeVisible();
      await shot(page, `fleet-04-compat-${vp.name}`);
    });
  });
}
