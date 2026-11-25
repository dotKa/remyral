import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import {
  installerKitFileName,
  installerSigningPayload,
  releaseKeyId,
  releaseSigningPayload,
} from '@remyral/protocol';
import { REPO_ROOT } from './env';
import { createEnrolledAdmin, type EnrolledAdmin, resetRateLimits, signInWithCode } from './fixtures';
import { e2eReleasePublicKey, e2eReleaseSign } from './release-key';

/**
 * p6-release-upload: a real ~12 MB signed release.json (9 MiB artifact + three installer kits) uploaded
 * through Settings → Worker releases against the real master — in parts with a progress bar, one part
 * failing once on the way (retried), the verified version shown, then *Roll out to stable*. Desktop and
 * phone; writes docs/design/p6-ui-refactor/release-upload-*.png.
 */
const OUT = `${REPO_ROOT}docs/design/p6-ui-refactor/`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function releaseDocument(version: string): Buffer {
  const artifact = randomBytes(9 * 1024 * 1024);
  const keyId = releaseKeyId(e2eReleasePublicKey());
  const manifest = Buffer.from(
    `${JSON.stringify({ schema: 1, name: 'remyral-worker', version, channel: 'stable', protocolVersions: ['1.0'], minNode: '24.0.0', sha256: sha(artifact), size: artifact.length, createdAt: new Date().toISOString() })}\n`,
  );
  const kits = (['linux', 'macos', 'windows'] as const).map((os) => ({
    os,
    bytes: Buffer.from(`e2e kit ${version} ${os}`),
  }));
  const index = Buffer.from(
    `${JSON.stringify({
      schema: 1,
      name: 'remyral-worker-installers',
      version,
      releaseManifestSha256: sha(manifest),
      node: { version: '24.21.0' },
      kits: kits.map((k) => ({
        os: k.os,
        file: installerKitFileName(version, k.os),
        sha256: sha(k.bytes),
        size: k.bytes.length,
      })),
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  return Buffer.from(
    JSON.stringify({
      manifest: manifest.toString('base64'),
      signature: {
        keyId,
        signature: e2eReleaseSign(releaseSigningPayload(manifest)).toString('base64url'),
      },
      artifact: artifact.toString('base64'),
      installers: {
        index: index.toString('base64'),
        signature: {
          keyId,
          signature: e2eReleaseSign(installerSigningPayload(index)).toString('base64url'),
        },
        kits: kits.map((k) => ({ os: k.os, content: k.bytes.toString('base64') })),
      },
    }),
  );
}

const VIEWPORTS = [
  { name: 'desktop', version: '1.0.0', viewport: { width: 1280, height: 800 }, isMobile: false },
  { name: 'phone', version: '1.1.0', viewport: { width: 390, height: 844 }, isMobile: true },
] as const;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let admin: EnrolledAdmin;

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
  await resetRateLimits();
  admin = await createEnrolledAdmin('rel');
});

async function signIn(page: Page): Promise<void> {
  await signInWithCode(page, admin);
}

for (const vp of VIEWPORTS) {
  test(`chunked release upload with progress, retry and roll out (${vp.name})`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: vp.viewport,
      deviceScaleFactor: 1,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
    });
    const page = await context.newPage();
    await resetRateLimits();
    await signIn(page);
    // Slow every part down a little (to watch the progress) and fail part 1 once like a flaky proxy.
    const seen: string[] = [];
    let failed = false;
    await page.route('**/api/releases/uploads/*/parts/*', async (route) => {
      const n = route.request().url().split('/').at(-1) ?? '';
      seen.push(n);
      await new Promise((r) => setTimeout(r, 700));
      if (n === '1' && !failed) {
        failed = true;
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'bad_gateway', message: 'Bad gateway.' }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto('/settings/releases');
    await expect(page.getByTestId('dy-channels')).toBeVisible();
    await page.screenshot({ path: `${OUT}release-upload-idle-${vp.name}.png`, animations: 'disabled' });
    const doc = releaseDocument(vp.version);
    expect(doc.length).toBeGreaterThan(12 * 1024 * 1024);
    await page.getByLabel('İmzalı sürüm belgesi').setInputFiles({
      name: 'release.json',
      mimeType: 'application/json',
      buffer: doc,
    });
    const bar = page.getByRole('progressbar', { name: 'Sürüm yükleme' });
    await expect(bar).toBeVisible();
    await expect(page.getByText(/Parça 3 \/ \d+ yükleniyor|yeniden deneniyor/)).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: `${OUT}release-upload-progress-${vp.name}.png`, animations: 'disabled' });
    const done = page.getByTestId('release-upload-done');
    await expect(done).toContainText(vp.version, { timeout: 60_000 });
    expect(seen.filter((n) => n === '1')).toHaveLength(2); // retried once
    await page.screenshot({ path: `${OUT}release-upload-done-${vp.name}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'stable kanalında yay' }).click();
    await expect(page.getByTestId('release-upload-done')).toContainText(`stable → ${vp.version}, %100.`);
    await expect(page.getByTestId('dy-channels')).toContainText(vp.version);
    await page.screenshot({
      path: `${OUT}release-upload-rolled-out-${vp.name}.png`,
      animations: 'disabled',
    });
    await context.close();
  });
}
