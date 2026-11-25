import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { REPO_ROOT } from './env';
import {
  createEnrolledAdmin,
  type EnrolledAdmin,
  resetRateLimits,
  withE2ePool,
  signInWithCode,
} from './fixtures';

/**
 * p10-chat-organize: the organised conversation list (Pinned, a group, tag chips), starring a message and the details
 * sidebar against the real master (e2e database), desktop 1280×800 and phone 390×844. Pins, groups, tags and messages
 * are seeded straight into the throw-away database; the star and the sidebar go through the API (p15-classic-removal: on
 * the Diyalog Sohbet). Asserts no sideways scroll and writes screenshots to docs/design/screens/chat-organize/.
 */
const OUT = `${REPO_ROOT}docs/design/screens/chat-organize/`;

const VIEWPORTS = [
  {
    name: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  {
    name: 'phone',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
] as const;

async function seed(admin: EnrolledAdmin): Promise<string> {
  return withE2ePool(async (pool) => {
    const user = (await pool.query('SELECT id FROM users WHERE username = $1', [admin.username])).rows[0];
    const userId = String(user?.id);
    const thread = async (title: string, ageHours: number): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO chat_threads (id, user_id, title, created_at, updated_at)
         VALUES ($1, $2, $3, now() - make_interval(hours => $4), now() - make_interval(hours => $4))`,
        [id, userId, title, ageHours],
      );
      return id;
    };
    const pinned = await thread('Weekly fleet check', 24 * 9);
    const release = await thread('Release notes for acme/web 2.4', 30);
    const docs = await thread('Deploy the docs site', 5);
    await thread('Which jobs used the most tokens?', 2);
    const main = await thread('Raspberry Pi cooling research', 0);
    await pool.query('INSERT INTO chat_thread_pins (thread_id, user_id, pinned_at) VALUES ($1, $2, now())', [
      pinned,
      userId,
    ]);
    await pool.query('INSERT INTO chat_thread_pins (thread_id, user_id, pinned_at) VALUES ($1, $2, now())', [
      main,
      userId,
    ]);
    const group = randomUUID();
    await pool.query(
      `INSERT INTO chat_groups (id, user_id, name, position, collapsed, created_at, updated_at)
       VALUES ($1, $2, 'Deploys', 0, false, now(), now())`,
      [group, userId],
    );
    for (const t of [release, docs]) {
      await pool.query(
        'INSERT INTO chat_thread_groups (thread_id, user_id, group_id, added_at) VALUES ($1, $2, $3, now())',
        [t, userId, group],
      );
    }
    const tag = async (name: string, color: string): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO chat_tags (id, user_id, name, color, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())`,
        [id, userId, name, color],
      );
      return id;
    };
    const urgent = await tag('urgent', 'red');
    const research = await tag('research', 'violet');
    for (const [t, g] of [
      [release, urgent],
      [main, research],
    ] as const) {
      await pool.query(
        'INSERT INTO chat_thread_tags (thread_id, user_id, tag_id, added_at) VALUES ($1, $2, $3, now())',
        [t, userId, g],
      );
    }
    const rows: [string, string][] = [
      ['user', 'Find the current Raspberry Pi 5 cooling options with sources.'],
      [
        'assistant',
        'The official Active Cooler is the default choice (https://www.raspberrypi.com/products/active-cooler/). ' +
          'For passive cooling see the review at https://www.jeffgeerling.com/blog/2023/raspberry-pi-5-cooling and ' +
          'the comparison on https://github.com/geerlingguy/raspberry-pi-pcie-devices/issues/1.',
      ],
      ['user', 'Which one is the quietest?'],
      ['assistant', 'A passive case is silent; the Active Cooler stays near 30 dB under load.'],
    ];
    let seq = 1;
    for (const [role, content] of rows) {
      await pool.query(
        `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, now() - make_interval(mins => $6))`,
        [randomUUID(), main, seq, role, content, (rows.length - seq) * 2],
      );
      seq += 1;
    }
    await pool.query('UPDATE chat_threads SET next_seq = $2 WHERE id = $1', [main, seq]);
    return main;
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled' });
}

/** p15-classic-removal: the Diyalog Sohbet scrolls the window vertically; nothing may scroll sideways. */
async function expectNoPageScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    vw: window.innerWidth,
  }));
  expect(m.width).toBeLessThanOrEqual(m.vw);
}

for (const vp of VIEWPORTS) {
  test.describe(`chat organise (${vp.name})`, () => {
    test.use({
      viewport: vp.viewport,
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
    });
    test.beforeEach(async () => {
      await resetRateLimits();
    });

    test(`sections, star, sidebar (${vp.name})`, async ({ page }) => {
      const admin = await createEnrolledAdmin(`chatorg${vp.name}`);
      const main = await seed(admin);
      await signInWithCode(page, admin, { tap: vp.hasTouch });
      await page.goto(`/chat/${main}`);
      await expect(page.getByText('A passive case is silent', { exact: false })).toBeVisible();
      await expectNoPageScroll(page);

      if (vp.name === 'desktop') {
        await expect(page.getByTestId('pinned-section')).toBeVisible();
        await expect(page.getByTestId('group-section')).toBeVisible();
        await shot(page, `diyalog-01-list-sections-${vp.name}`);
      } else {
        await page.getByTestId('dy-conversations-toggle').click();
        await expect(page.getByTestId('pinned-section')).toBeVisible();
        await shot(page, `diyalog-01-list-sections-${vp.name}`);
        await page.keyboard.press('Escape');
      }

      // Star the first answer.
      const answer = page.locator('[data-role="assistant"]').first();
      await answer.hover();
      await answer.getByRole('button', { name: 'Mesajı yıldızla' }).click();
      await expect(answer.getByRole('button', { name: 'Mesajın yıldızını kaldır' })).toBeVisible();

      // The details panel: closed by default, opens from the top bar.
      await expect(page.getByTestId('dy-details')).toHaveCount(0);
      await page.getByTestId('sidebar-toggle').click();
      const sidebar = page.getByTestId('dy-details');
      await expect(sidebar).toBeVisible();
      await expect(sidebar.getByTestId('sidebar-item')).toHaveCount(1);
      await expectNoPageScroll(page);
      await shot(page, `diyalog-02-sidebar-starred-${vp.name}`);
      await sidebar.getByRole('tab', { name: 'Bağlantılar' }).click();
      await expect(sidebar.getByText('www.raspberrypi.com')).toBeVisible();
      await shot(page, `diyalog-03-sidebar-links-${vp.name}`);
      await sidebar.getByRole('tab', { name: 'Yıldızlı' }).click();
      await expect(sidebar.getByTestId('sidebar-item')).toHaveCount(1);
      await sidebar.getByRole('button', { name: /^Sohbette göster/ }).click();
      await expect(page.locator('[data-jump="true"]')).toHaveCount(1);
      if (vp.name === 'phone') await expect(page.getByTestId('dy-details')).toHaveCount(0);
      await shot(page, `diyalog-04-jumped-${vp.name}`);

      // Remembered after a reload.
      await page.reload();
      await expect(page.getByText('A passive case is silent', { exact: false })).toBeVisible();
      await expect(page.getByTestId('dy-details')).toHaveCount(vp.name === 'phone' ? 0 : 1);
    });
  });
}
