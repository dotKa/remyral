import { writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page, type Request, test } from '@playwright/test';
import { createEnrolledAdmin, resetRateLimits, withE2ePool, signInWithCode } from './fixtures';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §7): route timings of the Diyalog UI on the production build, measured
 * against the real master with a throttled network. Not part of `pnpm e2e` (project `perf`, opt-in):
 *
 *   PERF_OUT=/tmp/perf.json pnpm --filter @remyral/web exec playwright test --project perf
 *
 * `PERF_BASES="before=http://127.0.0.1:4188,after=http://127.0.0.1:4174"` measures several preview servers (e.g. a
 * build of the previous commit next to this one) in one run, alternating them per round; default: this build only.
 * Network: 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up (a mid mobile / busy Wi-Fi link), cache disabled for the cold
 * load, enabled afterwards (the immutable bundles stay cached, as in production). Service workers are blocked, so
 * every number is a first visit's (a returning browser reads the precached bundles from Cache Storage).
 */
const RUNS = Number(process.env.PERF_RUNS ?? 3);

async function seedJobs(n: number): Promise<void> {
  await withE2ePool(async (pool) => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM jobs');
    if (Number(rows[0]?.n ?? 0) >= n) return;
    await pool.query(
      `WITH s AS (
         SELECT gen_random_uuid() AS id, now() - (i * interval '7 minutes') AS t, i,
                CASE WHEN i % 10 = 0 THEN 'FAILED' WHEN i % 97 = 0 THEN 'BLOCKED' ELSE 'SUCCEEDED' END::job_state AS st
           FROM generate_series(1, $1::int) i),
       j AS (
         INSERT INTO jobs (id, project, spec, state, priority, version, created_by_type, created_by_id,
                           created_at, updated_at, state_changed_at)
         SELECT id, 'genel', jsonb_build_object('runtime', (ARRAY['claude-code','codex','pi','opencode'])[1 + i % 4],
                                                'prompt', 'Perf task ' || i),
                st, 0, 1, 'system', 'perf', t, t + interval '4 minutes', t + interval '4 minutes'
           FROM s RETURNING id, created_at)
       INSERT INTO job_transitions (job_id, version, from_state, to_state, trigger, actor_type, occurred_at)
       SELECT id, 1, NULL, 'DRAFT', 'create', 'system', created_at FROM j`,
      [n],
    );
  });
}

async function throttle(page: Page, cacheDisabled: boolean): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
}

async function timed(what: () => Promise<void>, ready: Locator): Promise<number> {
  const t0 = Date.now();
  await what();
  await expect(ready).toBeVisible({ timeout: 60_000 });
  return Date.now() - t0;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

test('Diyalog route timings (production build, throttled network)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'perf', 'opt-in perf project');
  test.setTimeout(30 * 60_000);
  await resetRateLimits();
  await seedJobs(1500);
  const admin = await createEnrolledAdmin('perf');
  const bases = (process.env.PERF_BASES ?? `build=${info.project.use.baseURL ?? ''}`)
    .split(',')
    .map((b) => b.split('=') as [string, string]);
  const results: Record<string, number[]> = {};

  for (let run = 0; run < RUNS; run++)
    for (const [label, base] of bases) {
      const add = (k: string, v: number): void => {
        (results[`${label}: ${k}`] ??= []).push(v);
      };
      // No service worker: its precache would serve the bundles from Cache Storage and hide the first visit's cost.
      const context = await browser.newContext({
        baseURL: base,
        viewport: { width: 1280, height: 800 },
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      // Sign in through the Diyalog steps (p15-classic-removal: the only sign-in).
      await signInWithCode(page, admin);
      await expect(page).toHaveURL(/\/$/);

      // Cold load of the home: empty HTTP cache, throttled. JS bytes as transferred (compressed).
      await throttle(page, true);
      let jsBytes = 0;
      const onFinished = (req: Request): void => {
        if (req.resourceType() !== 'script') return;
        void req.sizes().then((z) => {
          jsBytes += z.responseBodySize;
        });
      };
      page.on('requestfinished', onFinished);
      const home = page.getByTestId('dy-home').getByRole('heading', { name: 'Çalışan işler' });
      add(
        'cold home (panels visible)',
        await timed(async () => {
          await page.goto('/');
        }, home),
      );
      await page.waitForLoadState('networkidle');
      add('cold home JS transferred (KB)', Math.round(jsBytes / 1024));
      await throttle(page, false);

      const rail = (href: string): Locator => page.locator(`nav a[href="${href}"]:visible`).first();
      const jobRow = page
        .getByTestId('dy-jobs')
        .locator(
          'a[href^="/jobs/"]:not([href^="/jobs/new"]):not([href^="/jobs/templates"]):not([href^="/jobs/workflows"])',
        )
        .first();
      add('→ İşler (first job row)', await timed(() => rail('/jobs').click(), jobRow));
      add(
        '→ Makineler',
        await timed(
          () => rail('/machines').click(),
          page.getByTestId('dy-machines').getByRole('heading', { name: 'Makineler', level: 1 }),
        ),
      );
      add('→ İşler again', await timed(() => rail('/jobs').click(), jobRow));
      add('→ job detail', await timed(() => jobRow.click(), page.getByTestId('dy-job-header')));
      add('→ Sohbet', await timed(() => rail('/chat').click(), page.getByTestId('dy-sohbet')));
      add('→ Ana sayfa again', await timed(() => rail('/').click(), home));
      await context.close();
    }

  const summary = Object.fromEntries(
    Object.entries(results).map(([k, v]) => [k, { median: median(v), runs: v }]),
  );
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.PERF_OUT) await writeFile(process.env.PERF_OUT, JSON.stringify(summary, null, 2));
});
