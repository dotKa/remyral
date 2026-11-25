import { expect, type Locator, test } from '@playwright/test';
import { MASTER_ORIGIN } from './env';
import {
  createEnrolledAdmin,
  createWorkspaceJobWithFiles,
  resetRateLimits,
  signInWithCode,
} from './fixtures';

/**
 * p9-files-image-preview: image previews on the job page's Files tab and in the Outputs drawer decode under the
 * production headers — the master's CSP (`img-src 'self' data:`, no blob:) plus the console's COEP
 * `require-corp` / COOP (apps/web/Dockerfile). Live the Files tab showed a broken image because it rendered a
 * `blob:` object URL that the CSP refuses. Runs in the `csp` project (production build).
 *
 * The service worker is blocked: requests it makes bypass `page.route`, so a document it serves would carry no
 * injected CSP and the test would pass against the broken build (checked: with the old blob: preview this test
 * fails — naturalWidth 0 and an `img-src` violation).
 */
test.use({ serviceWorkers: 'block' });

// Tiny real images (2×2 PNG / JPEG, 1×1 GIF / WebP) so the browser has something to decode.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DAwMDAxMDAwMAAAA0hAQGx4n3OAAAAAElFTkSuQmCC',
  'base64',
);
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/fyiiigD/9k=',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

const FILES = [
  { name: 'generated-images/hero.png', mediaType: 'image/png', content: PNG },
  { name: 'photo.jpg', mediaType: 'image/jpeg', content: JPEG },
  { name: 'spinner.gif', mediaType: 'image/gif', content: GIF },
  { name: 'banner.webp', mediaType: 'image/webp', content: WEBP },
];

async function decoded(img: Locator): Promise<void> {
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
      timeout: 10_000,
    })
    .toBe(true);
}

test('image previews decode under the production CSP and COEP (Files tab + Outputs)', async ({
  page,
  baseURL,
}) => {
  await resetRateLimits();
  const csp = (await fetch(`${MASTER_ORIGIN}/healthz`)).headers.get('content-security-policy') ?? '';
  expect(csp).toContain("img-src 'self' data:");
  const origin = new URL(baseURL ?? '').origin;
  // Static assets get the console's production document headers (nginx); /api keeps the master's own.
  await page.route(
    (url) => url.origin === origin && !url.pathname.startsWith('/api/'),
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'content-security-policy': csp,
          'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-origin',
        },
      });
    },
  );
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Cross-Origin|ERR_BLOCKED/i.test(msg.text())) violations.push(msg.text());
  });
  await page.exposeFunction('reportCspViolation', (v: string) => {
    violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { reportCspViolation: (v: string) => Promise<void> }).reportCspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });

  const jobId = await createWorkspaceJobWithFiles(FILES);
  const admin = await createEnrolledAdmin('files');
  await signInWithCode(page, admin);
  await expect(page).toHaveURL(/\/$/);

  // Job page → Ayrıntılar → Dosyalar (p15-classic-removal: the Diyalog job page): every raster type decodes from the
  // same-origin inline route.
  const doc = await page.goto(`/jobs/${jobId}?view=details&tab=files`);
  expect(doc?.headers()['content-security-policy']).toBe(csp);
  for (const f of FILES) {
    await page.getByRole('button', { name: `Önizle: ${f.name}` }).click();
    const img = page.getByTestId('dy-artifact-image');
    await expect(img).toHaveAttribute(
      'src',
      new RegExp(`^/api/jobs/${jobId}/artifacts/ws-[a-z0-9-]+\\?inline=1$`),
    );
    await decoded(img);
    await page.getByRole('button', { name: `Önizlemeyi gizle: ${f.name}` }).click();
  }

  // Outputs drawer: the same route, the same headers.
  await page.goto(`/outputs?job=${jobId}`);
  await page.getByText('generated-images/hero.png').first().click();
  const preview = page.getByTestId('image-preview');
  await expect(preview).toBeVisible();
  await decoded(preview);

  expect(violations).toEqual([]);
});
