// p22-classic-removal §7: the phone check of a conversation with its plan open (harness fixture `chat-plan`) at
// 390 x 844 and 360 x 740. Dev only — needs the Vite dev server (`pnpm --filter @remyral/web dev`).
//   node apps/web/scripts/plan-phone-check.mjs [out-dir]
// Env: SHOTS_BASE (default http://127.0.0.1:5173), SHOTS_CHANNEL (e.g. `chrome` for the system Chrome).
// Checks (exit 1 on a failure): touch swipes inside the open sheet and on the dimmed thread above it leave the page
// where it was; the page is locked while the sheet is open and released after; at the half snap the plan list ends
// at the screen's edge (nothing scrollable is hidden below it); no horizontal overflow. With an out-dir it saves
// screenshots (closed, open, open with a shorter viewport standing in for the on-screen keyboard).
/* global document, window -- evaluated in the page */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5173';
const PLAN_THREAD = '0c1d2e3f-0000-4000-8000-0000000000b1'; // harness/planFixtures.ts PLAN_THREAD_ID
const out = process.argv[2];
if (out !== undefined) mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.SHOTS_CHANNEL === undefined ? {} : { channel: process.env.SHOTS_CHANNEL },
);
const failures = [];
const results = [];
for (const [w, h] of [
  [390, 844],
  [360, 740],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
  const swipe = (y, dy) =>
    cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(w / 2),
      y: Math.min(Math.max(Math.round(y), 5), h - 5),
      yDistance: dy,
      gestureSourceType: 'touch',
      speed: 1600,
    });
  await page.goto(`${BASE}/diyalog-harness.html?path=/chat/${PLAN_THREAD}`);
  await page.waitForSelector('[data-testid="plan-pill"]', { timeout: 30_000 });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.waitForTimeout(300);
  if (out !== undefined) await page.screenshot({ path: join(out, `${String(w)}-closed.png`) });
  const start = await scrollY();
  await page.locator('[data-testid="plan-pill"] button').first().click();
  await page.waitForTimeout(700);
  if (out !== undefined) await page.screenshot({ path: join(out, `${String(w)}-open.png`) });
  const sheetTop = await page.evaluate(
    () =>
      document.querySelector('[data-testid="plan-sheet"] .dy-plan-sheet-scroll')?.getBoundingClientRect()
        .top ?? 0,
  );
  for (let i = 0; i < 4; i++) await swipe(h - 40, -400); // scroll the plan down, past its end
  for (let i = 0; i < 6; i++) await swipe(Math.max(sheetTop, h / 2) + 60, 300); // back up, past its top
  await swipe(Math.max(60, sheetTop - 150), 300); // on the dimmed thread above the sheet
  const afterSwipes = await scrollY();
  const open = await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="plan-sheet"] .dy-plan-sheet-scroll');
    const r = sc?.getBoundingClientRect();
    return {
      locked: document.documentElement.hasAttribute('data-scroll-lock'),
      hiddenBelow: r === undefined ? null : Math.max(0, Math.round(r.bottom - window.innerHeight)),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const released = !(await page.evaluate(() => document.documentElement.hasAttribute('data-scroll-lock')));
  const afterClose = await scrollY();
  // A shorter viewport stands in for the on-screen keyboard (Android resizes the layout; iOS: `--dy-kb`).
  await page.locator('[data-testid="dy-composer-field"]').focus();
  await page.setViewportSize({ width: w, height: Math.round(h * 0.55) });
  await page.locator('[data-testid="plan-pill"] button').first().click();
  await page.waitForTimeout(700);
  if (out !== undefined) await page.screenshot({ path: join(out, `${String(w)}-keyboard-open.png`) });
  const r = { size: `${String(w)}x${String(h)}`, start, afterSwipes, afterClose, released, ...open };
  results.push(r);
  if (afterSwipes !== start)
    failures.push(
      `${r.size}: the page moved behind the open sheet (${String(start)} → ${String(afterSwipes)})`,
    );
  if (afterClose !== start) failures.push(`${r.size}: closing the sheet moved the page`);
  if (!open.locked) failures.push(`${r.size}: the page is not locked while the sheet is open`);
  if (!released) failures.push(`${r.size}: the lock stayed after closing`);
  if (open.hiddenBelow !== 0)
    failures.push(`${r.size}: ${String(open.hiddenBelow)} px of the plan list are below the screen`);
  if (open.overflowX > 0) failures.push(`${r.size}: horizontal overflow ${String(open.overflowX)} px`);
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
