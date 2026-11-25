#!/usr/bin/env node
// p8-pwa: renders the PWA icons that the existing ones lack from the brand mark (public/favicon.svg: the
// "R" stroke on the dark rounded square) with the locally installed Playwright Chromium — no network.
//
//   pnpm --filter @remyral/web exec node scripts/pwa-icons.mjs
//
// Writes public/icon-maskable-512.png (full-bleed background, mark inside the 80 % safe zone) and
// public/badge-96.png (white mark on transparent: Android's status-bar badge uses the alpha channel only).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const MARK = 'M9 23V9h8a5 5 0 0 1 0 10h-8m8 0 6 4';

/** The mark's 32-unit box scaled by `scale` around the centre. */
function svg({ size, background, stroke, scale, width }) {
  const t = 16 - 16 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${
    background ? `<rect width="32" height="32" fill="${background}"/>` : ''
  }<g transform="translate(${t} ${t}) scale(${scale})"><path d="${MARK}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

const icons = [
  {
    file: 'icon-maskable-512.png',
    size: 512,
    transparent: false,
    // Maskable safe zone: a circle of 80 % diameter; the mark (~14 × 14 units of 32) at 0.75 stays inside.
    markup: svg({ size: 512, background: '#1f2937', stroke: '#93c5fd', scale: 0.75, width: 2.5 }),
  },
  {
    file: 'badge-96.png',
    size: 96,
    transparent: true,
    markup: svg({ size: 96, background: null, stroke: '#ffffff', scale: 1.35, width: 3 }),
  },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // Nothing may be fetched while rendering.
  await page.route('**/*', (route) => route.abort());
  for (const icon of icons) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${icon.markup}</body></html>`,
    );
    const png = await page.locator('svg').screenshot({ omitBackground: icon.transparent });
    writeFileSync(`${pub}${icon.file}`, png);
    console.log(`pwa-icons: wrote public/${icon.file}`);
  }
} finally {
  await browser.close();
}
