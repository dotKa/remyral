import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { REPO_ROOT } from './env';
import {
  createEnrolledAdmin,
  type EnrolledAdmin,
  resetRateLimits,
  signInWithCode,
  withE2ePool,
} from './fixtures';

/**
 * p5-chat-ux on the Diyalog Sohbet (p15-classic-removal: the classic chat page is gone): the chat against the real
 * master (e2e database), desktop 1280×800 and phone 390×844. A conversation is seeded straight into the throw-away
 * e2e database (no assistant worker runs here). Asserts no sideways page scroll, the draft card in its strip, the
 * conversation menu (desktop) and the conversation drawer + composer focus (phone); screenshots go to
 * docs/design/screens/chat-ux/ (`diyalog-*`).
 */
const OUT = `${REPO_ROOT}docs/design/screens/chat-ux/`;

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

const ANSWER = [
  'Two machines are idle right now:',
  '',
  '| Worker | OS | Running | Slots |',
  '| :--- | :--- | ---: | ---: |',
  '| **mac-studio** | macOS arm64 | 0 | 4 |',
  '| linux-01 | Linux x64 | 0 | 2 |',
  '| windows-worker-1 | Windows x64 | 1 | 2 |',
  '',
  '> `windows-worker-1` is busy with job `3f2b9c1e` (codex, 12 min).',
  '',
  'To check one yourself:',
  '',
  '```sh',
  'remyral-worker status --json | jq .slots',
  '```',
].join('\n');

const FOLLOW_UP = [
  'Here is a draft for the research job. It runs in the **General** workspace on whichever idle machine',
  'has Claude Code ready. Nothing runs until you confirm it.',
].join('\n');

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
    await thread('Why did the nightly build fail?', 24 * 20);
    await thread('Runtime pins on the Raspberry Pi', 24 * 4);
    await thread('Disk usage on linux-02', 24 * 3);
    await thread('Approve the deploy of acme/web', 26);
    await thread('Which jobs used the most tokens?', 2);
    const main = await thread('Which machines are idle?', 0);
    const turn = randomUUID();
    const draftId = randomUUID();
    const payload = {
      project: 'genel',
      spec: {
        runtime: 'claude-code',
        prompt: 'Research the current Raspberry Pi 5 cooling options and summarise them with sources.',
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        sourceTrust: 'trusted',
        limits: { maxDurationSec: 1800, maxCostUsd: 2 },
      },
    };
    await pool.query(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'job', $5, $6, $7, 'genel', 'proposed', now(), now() + interval '24 hours')`,
      [
        draftId,
        main,
        userId,
        turn,
        'Research Raspberry Pi 5 cooling',
        JSON.stringify(payload),
        createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      ],
    );
    const rows: [string, string, Record<string, unknown> | null][] = [
      ['user', 'Which machines are idle?', null],
      ['tool', 'list_workers: ok', { name: 'list_workers', isError: false }],
      ['tool', 'describe_worker: ok', { name: 'describe_worker', isError: false }],
      ['assistant', ANSWER, null],
      ['user', 'What failed today?', null],
      ['tool', 'list_jobs: ok', { name: 'list_jobs', isError: false }],
      [
        'assistant',
        'Nothing failed today. The last failure was yesterday at 23:10: `acme/web` lint job on linux-01 (eslint exited 1).',
        null,
      ],
      ['user', 'Run a research task in General about Raspberry Pi 5 cooling.', null],
      ['tool', 'list_projects: ok', { name: 'list_projects', isError: false }],
      ['tool', 'placement_preview: ok', { name: 'placement_preview', isError: false }],
      [
        'tool',
        'draft_job: draft card “Research Raspberry Pi 5 cooling”',
        { name: 'draft_job', isError: false, draftId },
      ],
      ['assistant', FOLLOW_UP, null],
    ];
    let seq = 1;
    for (const [role, content, meta] of rows) {
      await pool.query(
        `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, now() - make_interval(mins => $7))`,
        [
          randomUUID(),
          main,
          seq,
          role,
          content,
          meta === null ? null : JSON.stringify(meta),
          (rows.length - seq) * 2,
        ],
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

/** No sideways page scroll (the Diyalog Sohbet scrolls the window vertically, like the other threads). */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    vw: window.innerWidth,
  }));
  expect(m.width).toBeLessThanOrEqual(m.vw);
}

for (const vp of VIEWPORTS) {
  test.describe(`chat (${vp.name})`, () => {
    test.use({
      viewport: vp.viewport,
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
    });
    test.beforeEach(async () => {
      await resetRateLimits();
    });

    test(`thread, draft card, conversation list (${vp.name})`, async ({ page }) => {
      const admin = await createEnrolledAdmin(`chatux${vp.name}`);
      const main = await seed(admin);
      await signInWithCode(page, admin, { tap: vp.hasTouch });

      // A conversation: its title, the thread, the draft card collapsed in the strip under the answer.
      await page.goto(`/chat/${main}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Which machines are idle?' })).toBeVisible();
      const log = page.getByRole('log', { name: 'Sohbet' });
      await expect(log).toBeVisible();
      const toggle = log.getByRole('button', { name: 'Kartı aç: Research Raspberry Pi 5 cooling' });
      await expect(toggle).toBeVisible();
      await expectNoSidewaysScroll(page);
      await shot(page, `diyalog-01-thread-${vp.name}`);
      await toggle.click();
      await expect(log.getByRole('article', { name: 'Research Raspberry Pi 5 cooling' })).toBeVisible();
      await shot(page, `diyalog-02-draft-${vp.name}`);

      if (vp.name === 'desktop') {
        // The conversation's menu (rename / pin / move / tags / archive / delete).
        await page.getByRole('button', { name: 'Which machines are idle? için eylemler' }).first().click();
        await expect(page.getByRole('menu')).toBeVisible();
        await shot(page, `diyalog-03-thread-menu-${vp.name}`);
        await page.keyboard.press('Escape');
      } else {
        // Phone: the conversation list is a drawer.
        await page.getByTestId('dy-conversations-toggle').tap();
        await expect(page.getByTestId('dy-conversations')).toHaveAttribute('data-open', 'true');
        await shot(page, `diyalog-03-drawer-${vp.name}`);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('dy-conversations')).toHaveAttribute('data-open', 'false');
        // Typing: the bottom bar steps aside. No assistant worker runs in the e2e stack, so only the status answer
        // is replaced (an available assistant) to enable the composer.
        await page.route('**/api/chat/status', (route) =>
          route.fulfill({
            json: {
              enabled: true,
              available: true,
              code: null,
              message: null,
              worker: { id: 'mac-1', name: 'mac-1', online: true },
              runtime: 'claude-code',
              model: 'claude-sonnet-4-5',
              limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
            },
          }),
        );
        await page.reload();
        const field = page.getByRole('textbox', { name: 'Mesaj' });
        await field.fill('Show pending approvals\nand who can decide them');
        await field.focus();
        await expect(page.locator('[data-bottom-bar]')).toBeHidden();
        await expectNoSidewaysScroll(page);
        await shot(page, `diyalog-04-typing-${vp.name}`);
      }
    });
  });
}
