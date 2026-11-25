// p12-diyalog visual check: screenshots of the harness (`/diyalog-harness.html?path=…`) at 1440 and 400 px, light
// and dark. Dev only — needs the Vite dev server running (`pnpm --filter @remyral/web dev`, or REMYRAL_WEB_PORT=…).
//   node apps/web/scripts/diyalog-shots.mjs <out-dir> <path> [<path> …]
// Env: SHOTS_BASE (default http://127.0.0.1:5173), SHOTS_FULL=1 for full-page shots, SHOTS_WIDTHS=1440,1024,768,400.
/* global document, window -- evaluated in the page */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out, ...paths] = process.argv.slice(2);
if (out === undefined || paths.length === 0) {
  console.error('usage: diyalog-shots.mjs <out-dir> <path> [<path> …]');
  process.exit(2);
}
const base = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5173';
const full = process.env.SHOTS_FULL === '1';
const widths = (process.env.SHOTS_WIDTHS ?? '1440,400').split(',').map(Number);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];
try {
  for (const path of paths) {
    for (const width of widths) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({
          viewport: { width, height: width > 600 ? 900 : 860 },
          colorScheme: scheme,
          deviceScaleFactor: 1,
        });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(`${path} ${String(width)} ${scheme}: ${e.message}`));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(`${path} ${String(width)} ${scheme}: console ${m.text()}`);
        });
        await page.goto(`${base}/diyalog-harness.html?path=${encodeURIComponent(path)}`);
        await page.waitForTimeout(1500);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1)
          errors.push(`${path} ${String(width)} ${scheme}: horizontal overflow ${String(overflow)} px`);
        const name = `${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}-${String(width)}-${scheme}.png`;
        await page.screenshot({ path: join(out, name), fullPage: full });
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
for (const e of errors) console.log(`WARN ${e}`);
console.log(`shots: ${out}`);
