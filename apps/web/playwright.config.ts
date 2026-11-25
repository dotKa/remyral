import { defineConfig, devices } from '@playwright/test';
import { loadE2eEnv, MASTER_ORIGIN, PORTS } from './e2e/env';
import { e2eReleasePublicKey } from './e2e/release-key';
import { e2eVapidKeyFile } from './e2e/vapid-key';

/**
 * E2E: real master (apps/master/dist, throw-away DB `remyral_e2e_web`, dedicated Redis DB) + the web
 * console, Chromium only. Not part of `pnpm verify` (needs the dev stack, a browser and ~1 min); run with
 * `pnpm --filter @remyral/web e2e` after `pnpm --filter @remyral/web e2e:install` once.
 *
 * - project `dev`: Vite dev server (proxy /api -> master), the main flows and the screenshots.
 * - project `csp`: the production build (`vite preview`, same proxy) with the master's own CSP header
 *   injected, asserting the bundle runs without a single CSP violation.
 * - projects `mobile-iphone` / `mobile-pixel` (p5-mobile, A-UX-1): `mobile*.spec.ts` on the iPhone 15 and
 *   Pixel 7 descriptors (viewport, DPR, touch, user agent). The brief keeps e2e on Chromium only, so the
 *   iPhone descriptor runs in Chromium too (WebKit-specific behaviour is UNVERIFIED, see p5-mobile.md §6).
 */
const env = loadE2eEnv();
const devURL = `http://127.0.0.1:${String(PORTS.dev)}`;
const previewURL = `http://127.0.0.1:${String(PORTS.preview)}`;
const webEnv = { REMYRAL_MASTER_ORIGIN: MASTER_ORIGIN };
/** Server start budget; raise it on a loaded machine (E2E_SERVER_TIMEOUT_MS). */
const serverTimeout = Number(process.env.E2E_SERVER_TIMEOUT_MS ?? 120_000);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'dev',
      testIgnore: [/csp\.spec\.ts/, /mobile.*\.spec\.ts/],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: devURL },
    },
    {
      name: 'csp',
      testMatch: /csp\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: previewURL },
    },
    {
      // p14-web-perf: opt-in route timings on the production build (e2e/perf-routes.perf.ts; `*.perf.ts` is outside
      // every other project's default match).
      name: 'perf',
      testMatch: /\.perf\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: previewURL },
    },
    {
      name: 'mobile-iphone',
      testMatch: /mobile.*\.spec\.ts/,
      use: { ...devices['iPhone 15'], browserName: 'chromium', baseURL: devURL },
    },
    {
      name: 'mobile-pixel',
      testMatch: /mobile.*\.spec\.ts/,
      use: { ...devices['Pixel 7'], baseURL: devURL },
    },
  ],
  webServer: [
    {
      name: 'master',
      // The worker packages are built too: the mobile project runs a real worker daemon (e2e/fake-worker.mjs).
      command:
        "pnpm --filter '@remyral/master...' --filter '@remyral/worker...' --workspace-concurrency=1 run build && node e2e/master-server.mjs",
      url: `${MASTER_ORIGIN}/readyz`,
      reuseExistingServer: false,
      timeout: serverTimeout,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        MASTER_HOST: '127.0.0.1',
        MASTER_PORT: String(PORTS.master),
        LOG_LEVEL: 'warn',
        DATABASE_URL: env.databaseUrl,
        E2E_ADMIN_DB_URL: env.adminDbUrl,
        REDIS_URL: env.redisUrl,
        TOTP_KEY_FILE: env.totpKeyFile,
        TRUST_PROXY_HOPS: '0',
        // p6-release-upload: the deterministic test-only release key (e2e/release-key.ts).
        RELEASE_PUBLIC_KEYS: e2eReleasePublicKey(),
        // p8-pwa: Web Push configured (throw-away VAPID key), so the Devices page shows the push controls.
        PUSH_VAPID_PRIVATE_KEY_FILE: e2eVapidKeyFile(),
        PUSH_VAPID_SUBJECT: 'mailto:e2e@example.com',
      },
    },
    {
      name: 'web-dev',
      command: 'pnpm exec vite',
      url: `${devURL}/login`,
      reuseExistingServer: false,
      timeout: Math.max(60_000, serverTimeout / 2),
      env: { ...webEnv, REMYRAL_WEB_PORT: String(PORTS.dev) },
    },
    {
      name: 'web-preview',
      command: 'pnpm exec vite build --logLevel warn && pnpm exec vite preview',
      url: `${previewURL}/login`,
      reuseExistingServer: false,
      timeout: serverTimeout,
      env: { ...webEnv, NODE_ENV: 'production', REMYRAL_WEB_PREVIEW_PORT: String(PORTS.preview) },
    },
  ],
});
