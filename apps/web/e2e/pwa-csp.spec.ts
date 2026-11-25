import { expect, test } from '@playwright/test';
import { MASTER_ORIGIN } from './env';
import { createEnrolledAdmin, resetRateLimits, signInWithCode } from './fixtures';

/**
 * p8-pwa (docs/design/p8-pwa.md §2) on the production build (`csp` project: vite preview with the master's
 * CSP on every static response): the manifest is valid, the service worker registers and activates under
 * the CSP, Cache Storage holds only this build's static shell — never an API response, even after
 * authenticated API traffic — and a navigation without network shows the offline page.
 */
test('service worker: registers under the CSP, caches only the static shell, offline page', async ({
  page,
  context,
  baseURL,
}) => {
  await resetRateLimits();
  const csp = (await fetch(`${MASTER_ORIGIN}/healthz`)).headers.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'self'");
  const origin = new URL(baseURL ?? '').origin;
  await context.route(
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

  // Manifest: name, scope, the maskable icon and the shortcuts.
  const manifest = (await (await page.request.get('/manifest.json')).json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; purpose: string }[];
    shortcuts: { url: string }[];
  };
  expect(manifest).toMatchObject({ name: 'Remyral', start_url: '/', display: 'standalone' });
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok(), icon.src).toBe(true);
  expect(manifest.shortcuts.map((s) => s.url)).toEqual(['/approvals', '/jobs', '/chat']);

  // Sign in (authenticated API traffic flows while the worker is installed).
  const admin = await createEnrolledAdmin('pwa');
  await signInWithCode(page, admin);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana sayfa' })).toBeVisible();

  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, script: reg.active?.scriptURL ?? null };
  });
  expect(sw).toEqual({ scope: `${origin}/`, script: `${origin}/sw.js` });

  // More authenticated API calls, now with an active worker.
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { level: 1, name: 'Cihazlar' })).toBeVisible();
  await expect(page.getByTestId('dy-this-device')).toBeVisible();

  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) out.push(`${name} ${new URL(req.url).pathname}`);
    }
    return out;
  });
  expect(cached.length).toBeGreaterThan(3);
  for (const entry of cached) {
    const [name = '', path = ''] = entry.split(' ');
    expect(name).toMatch(/^remyral-shell-[0-9a-f]{16}$/);
    // Only hashed bundles/fonts and the fixed shell files; never /api, never index.html.
    expect(path, entry).toMatch(
      /^\/(assets\/[^/]+\.(js|css|woff2?|svg|png)|offline\.html|offline\.css|icon-192\.png|badge-96\.png|favicon\.svg)$/,
    );
  }

  // Offline: a navigation gets the offline page from the worker; API calls are not answered from cache.
  // Playwright's routing handles requests before the worker sees them; drop it so the navigation reaches
  // the service worker (CSP was asserted above).
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.setOffline(true);
  await page.goto('/jobs').catch(() => null);
  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
  const api = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
      return `status ${String(r.status)}`;
    } catch {
      return 'network error';
    }
  });
  expect(api).toBe('network error');
  await context.setOffline(false);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Ana sayfa' })).toBeVisible();

  expect(violations).toEqual([]);
});
