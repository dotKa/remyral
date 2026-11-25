#!/usr/bin/env node
/**
 * p17-remyral-brand (docs/design/p17-remyral-rebrand.md, "Brand assets"): derives the console's brand files from the
 * approved brand kit (brand/remyral/assets/png). Run by hand; the outputs are committed.
 *
 *   REMYRAL_SITE_DIR=<checkout of the remyral.com site> node apps/web/scripts/brand-assets.mjs
 *
 * Needs only the Playwright Chromium the e2e suite installs (`pnpm --filter @remyral/web e2e:install`): the images are
 * drawn on a canvas, no image library. By design, the colour logo is used as PNG only; the symbol is cropped
 * from icon-1024.png by its alpha bounding box. The two lock-ups (colour symbol + navy / white wordmark) are the ones
 * the remyral.com site uses (its scripts/brand_assets.py: the approved primary PNG, tightly cropped; on dark the
 * wordmark pixels recoloured white like the mono-white logo, then optimised) — copied from REMYRAL_SITE_DIR when set,
 * else re-made here the same way (unoptimised, ~3x larger).
 *
 * Writes:
 *   public/icon-192.png, public/icon-512.png   app icon: the colour symbol on a Deep Navy rounded tile
 *   public/icon-maskable-512.png               full-bleed navy, the symbol inside the 80 % safe zone
 *   public/apple-touch-icon.png (180)          full-bleed navy (iOS rounds the corners itself)
 *   public/badge-96.png                        the symbol's silhouette in white (Android uses the alpha only)
 *   public/favicon.ico                         the kit's favicon (16/32/48, colour symbol)
 *   public/favicon.svg                         navy tile + the colour symbol as an embedded PNG (no traced vector)
 *   public/brand/logo-on-light.png, logo-on-dark.png   lock-ups for the offline page
 *   src/assets/brand/logo-on-light.png, logo-on-dark.png, symbol.png   the same, bundled (hashed) for the app
 */
/* global tile, silhouette, symbol, lockup -- defined in the page by DRAW, used inside page.evaluate */
import { Buffer } from 'node:buffer';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(WEB, '../../brand/remyral');
const SITE = process.env.REMYRAL_SITE_DIR ?? '';
const NAVY = '#0A1F3D';

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const out = (rel, b64) => {
  const p = join(WEB, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(b64, 'base64'));
  console.log('wrote', rel);
};

// In the page: crop the symbol by alpha, then draw tiles / silhouettes / lock-ups.
const DRAW = `
window.load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
window.bbox = (img) => {
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const a = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++)
    if (a[(y * c.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};
window.png = (c) => c.toDataURL('image/png').split(',')[1];
// A square canvas of size s: optional navy fill (rounded radius r, 0 = full bleed), the symbol fitted into frac of s.
window.tile = async (src, s, frac, fill, r) => {
  const img = await load(src); const b = bbox(img);
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  if (fill) { g.fillStyle = fill; g.beginPath(); g.roundRect(0, 0, s, s, r); g.fill(); }
  const k = (s * frac) / Math.max(b.w, b.h); const w = b.w * k, h = b.h * k;
  g.drawImage(img, b.x, b.y, b.w, b.h, (s - w) / 2, (s - h) / 2, w, h);
  return png(c);
};
window.silhouette = async (src, s, frac) => {
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const g = c.getContext('2d');
  const tmp = new Image(); tmp.src = 'data:image/png;base64,' + await tile(src, s, frac, null, 0); await tmp.decode();
  g.drawImage(tmp, 0, 0);
  g.globalCompositeOperation = 'source-in'; g.fillStyle = '#ffffff'; g.fillRect(0, 0, s, s);
  return png(c);
};
window.symbol = async (src, h) => {
  const img = await load(src); const b = bbox(img);
  const w = Math.round((b.w * h) / b.h);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, w, h);
  return png(c);
};
// The primary lock-up cropped tightly; on dark the wordmark (right of the first transparent column run) turns white.
window.lockup = async (src, outH, white) => {
  const img = await load(src); const W = img.naturalWidth, H = img.naturalHeight;
  const s = document.createElement('canvas'); s.width = W; s.height = H;
  const sg = s.getContext('2d'); sg.drawImage(img, 0, 0);
  const a = sg.getImageData(0, 0, W, H).data; const col = new Array(W).fill(false); let y0 = H, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[(y * W + x) * 4 + 3] > 24) { col[x] = true; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const x0 = col.indexOf(true), x1 = col.lastIndexOf(true);
  let gs = x0; while (gs <= x1 && col[gs]) gs++; let ge = gs; while (ge <= x1 && !col[ge]) ge++;
  const split = Math.floor((gs + ge) / 2), pad = 6;
  const x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad), w = Math.min(W, x1 + pad + 1) - x, h = Math.min(H, y1 + pad + 1) - y;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(img, x, y, w, h, 0, 0, w, h);
  if (white) { const d = g.getImageData(0, 0, w, h); const p = d.data;
    for (let yy = 0; yy < h; yy++) for (let xx = split - x; xx < w; xx++) { const i = (yy * w + xx) * 4; p[i] = p[i + 1] = p[i + 2] = 255; }
    g.putImageData(d, 0, 0); }
  const oW = Math.round((w * outH) / h); const o = document.createElement('canvas'); o.width = oW; o.height = outH;
  const og = o.getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(c, 0, 0, oW, outH);
  return png(o);
};
`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: DRAW });
  const icon = dataUri(join(KIT, 'assets/png/icon-1024.png'));
  const primary = dataUri(join(KIT, 'assets/png/primary-1024.png'));

  out('public/icon-192.png', await page.evaluate(([s]) => tile(s, 192, 0.62, '#0A1F3D', 43), [icon]));
  out('public/icon-512.png', await page.evaluate(([s]) => tile(s, 512, 0.62, '#0A1F3D', 115), [icon]));
  out('public/icon-maskable-512.png', await page.evaluate(([s]) => tile(s, 512, 0.5, '#0A1F3D', 0), [icon]));
  out('public/apple-touch-icon.png', await page.evaluate(([s]) => tile(s, 180, 0.62, '#0A1F3D', 0), [icon]));
  out('public/badge-96.png', await page.evaluate(([s]) => silhouette(s, 96, 0.84), [icon]));
  const sym = await page.evaluate(([s]) => symbol(s, 96), [icon]);
  out('src/assets/brand/symbol.png', sym);
  const fav = await page.evaluate(([s]) => tile(s, 96, 0.66, null, 0), [icon]);
  writeFileSync(
    join(WEB, 'public/favicon.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${NAVY}"/>` +
      `<image href="data:image/png;base64,${fav}" x="0" y="0" width="32" height="32"/></svg>\n`,
  );
  console.log('wrote public/favicon.svg');
  copyFileSync(join(KIT, 'favicon.ico'), join(WEB, 'public/favicon.ico'));
  console.log('wrote public/favicon.ico');

  for (const [name, white] of [
    ['logo-on-light', false],
    ['logo-on-dark', true],
  ]) {
    const site = SITE === '' ? '' : join(SITE, `public/brand/${name}.png`);
    const b64 =
      site !== '' && existsSync(site)
        ? readFileSync(site).toString('base64')
        : await page.evaluate(([s, w]) => lockup(s, 144, w), [primary, white]);
    out(`public/brand/${name}.png`, b64);
    out(`src/assets/brand/${name}.png`, b64);
  }
} finally {
  await browser.close();
}
