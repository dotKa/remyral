// p14-diyalog-polish-2: the main-screen tour of the Diyalog harness at desktop (1440 x 900) and phone (390 x 844),
// light and dark, as WebP (needs `cwebp` on PATH; PNGs are kept when it is missing). Dev only — needs the Vite dev
// server (`pnpm --filter @remyral/web dev`).
//   node apps/web/scripts/diyalog-tour.mjs <out-dir> [screen …]
// Env: SHOTS_BASE (default http://127.0.0.1:5173), SHOTS_QUALITY (WebP quality, default 55).
// p17-ui-review: SHOTS_FULL=1 takes the whole page (the page's length is part of the review), SHOTS_SCHEMES=light
// limits the schemes, SHOTS_PNG=1 keeps PNGs. Keep the output in a gitignored folder (apps/web/test-results/…).
/* global document, window -- evaluated in the page */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const SCREENS = {
  home: '/',
  chat: '/chat',
  approvals: '/approvals',
  jobs: '/jobs',
  job: '/jobs/7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e',
  workflows: '/workflows',
  editor: '/workflows/wf-release',
  machines: '/machines',
  outputs: '/outputs',
  usage: '/usage',
  projects: '/projects',
  settings: '/settings',
  skills: '/skills',
  // p17-ui-review: the screens of the UI review (machine page tabs, fleet tools, settings pages, a project).
  machine: '/machines/w1',
  'machine-lnx': '/machines/w3',
  'machine-runtimes': '/machines/w1?tab=runtimes',
  'fleet-tools': '/machines/tools',
  'settings-server': '/settings/server-settings',
  // p17-ui-polish: the other server-settings tabs (fixtures in harness/screens/server-settings.ts).
  'settings-server-network': '/settings/server-settings?tab=network',
  'settings-server-search': '/settings/server-settings?tab=search',
  'settings-server-keys': '/settings/server-settings?tab=keys',
  'settings-server-maintenance': '/settings/server-settings?tab=maintenance',
  'settings-releases': '/settings/releases',
  'settings-backups': '/settings/backups',
  'settings-integrations': '/settings/integrations',
  'settings-github': '/settings/integrations?tab=github',
  project: '/projects/mobil-app',
  // p18-plan-mode: the plan panel — executing (column; phone: the pill), with the details open (docked under them),
  // and a plan in review in plan mode (decisions, plan card, proposal); the phone sheet behind the pill.
  'chat-plan': '/chat/0c1d2e3f-0000-4000-8000-0000000000b1',
  'chat-plan-details': '/chat/0c1d2e3f-0000-4000-8000-0000000000b1#click=Sohbet ayrıntılarını göster',
  'chat-plan-review': '/chat/0c1d2e3f-0000-4000-8000-0000000000b2',
  // The sheet is the phone's (a size without a path is skipped).
  'chat-plan-sheet': {
    phone: '/chat/0c1d2e3f-0000-4000-8000-0000000000b1#click=Planı genişlet: Sürüm 2.4 yayını',
  },
  // p18-plan-mode W3: the plan in edit mode (handles, "+ Madde ekle" per phase) and its history with the diff of the
  // latest change — on the phone inside the sheet (per-size paths; several clicks in order).
  'chat-plan-edit': {
    desk: '/chat/0c1d2e3f-0000-4000-8000-0000000000b1#click=Planı düzenle',
    phone:
      '/chat/0c1d2e3f-0000-4000-8000-0000000000b1#click=Planı genişlet: Sürüm 2.4 yayını#click=Planı düzenle',
  },
  'chat-plan-history': {
    desk: '/chat/0c1d2e3f-0000-4000-8000-0000000000b1#click=Plan işlemleri#click=Farkları gör',
    phone:
      '/chat/0c1d2e3f-0000-4000-8000-0000000000b1#click=Planı genişlet: Sürüm 2.4 yayını#click=Plan işlemleri#click=Farkları gör',
  },
  // p17-ui-polish: a screen state behind a click — `path#click=<button name>` presses that button before the shot.
  'fleet-bulk': '/machines/tools#click=Toplu işlem',
};

const [out, ...only] = process.argv.slice(2);
if (out === undefined) {
  console.error('usage: diyalog-tour.mjs <out-dir> [screen …]');
  process.exit(2);
}
const base = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5173';
const quality = process.env.SHOTS_QUALITY ?? '55';
const fullPage = process.env.SHOTS_FULL === '1';
const schemes = process.env.SHOTS_SCHEMES?.split(',') ?? ['light', 'dark'];
mkdirSync(out, { recursive: true });
const pick = only.length > 0 ? only : Object.keys(SCREENS);
const sizes = [
  ['desk', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
];

let webp = process.env.SHOTS_PNG !== '1';
if (webp) {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
  } catch {
    webp = false;
  }
}

const browser = await chromium.launch();
const warnings = [];
try {
  for (const key of pick) {
    const entry = SCREENS[key];
    if (entry === undefined) throw new Error(`unknown screen ${key}`);
    for (const [size, viewport] of sizes) {
      // p18-plan-mode W3: a screen may name a path per size (the same state is reached by other clicks on a phone).
      const path = typeof entry === 'string' ? entry : entry[size];
      if (path === undefined) continue;
      for (const scheme of schemes) {
        const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => warnings.push(`${key} ${size} ${scheme}: ${e.message}`));
        const [route, ...clicks] = path.split('#click=');
        await page.goto(`${base}/diyalog-harness.html?view=shell&path=${encodeURIComponent(route)}`);
        await page.waitForTimeout(1800);
        for (const click of clicks) {
          // An item of the open menu first, else a button (p18-plan-mode W3: "Plan işlemleri" → "Farkları gör").
          const item = page.getByRole('menuitem', { name: click });
          const target = (await item.count()) > 0 ? item : page.getByRole('button', { name: click });
          await target.first().click();
          await page.waitForTimeout(800);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1)
          warnings.push(`${key} ${size} ${scheme}: horizontal overflow ${String(overflow)} px`);
        const name = `${key}-${size}-${scheme}`;
        // p17-ui-polish: the page's height is part of the review (SHOTS_HEIGHTS=1 prints it).
        if (process.env.SHOTS_HEIGHTS === '1')
          console.log(
            `${name}: ${String(await page.evaluate(() => document.documentElement.scrollHeight))} px`,
          );
        const png = join(out, `${name}.png`);
        await page.screenshot({ path: png, fullPage });
        if (webp) {
          execFileSync('cwebp', ['-quiet', '-q', quality, png, '-o', join(out, `${name}.webp`)]);
          rmSync(png);
        }
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
for (const w of warnings) console.log(`WARN ${w}`);
console.log(`tour: ${out}`);
