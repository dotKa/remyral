import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { type Cookie, expect, type Page, test } from '@playwright/test';
import {
  createEnrolledAdmin,
  type EnrolledAdmin,
  type FakeWorker,
  resetRateLimits,
  startFakeWorker,
  withE2ePool,
} from './fixtures';

/**
 * p17-panel-motion (docs/design/p17-panel-motion.md §6): the panel's live moments in a real browser against the real
 * master — recorded as short videos for the owner, plus the performance check on a 500-message thread. Opt-in
 * (`E2E_MOTION=1`; videos are not part of the regular e2e run). Desktop 1280×800, Chromium.
 *
 *   machine   a real worker daemon (fake runtime) pairs while Makineler is open: Eşleşme bekliyor → Hazır
 *   job       a job composed on that machine goes live: log lines arrive, steps fill, the state chip changes; its
 *             approval is decided with a wrong code first (shake) and then the right one (check)
 *   chat      a conversation receives a request, an answer with a job draft card, the card is opened and queued (with
 *             the code when the policy asks for it), then the job's result card arrives
 *   perf      a 500-message conversation opens and receives new messages: long tasks (PerformanceObserver) and the
 *             motion modules' own CPU time (CDP profile), with motion and with reduced motion
 *
 * Videos: E2E_MOTION_OUT (default test-results/panel-motion/ under the working directory), one .webm per test.
 */
const OUT = process.env.E2E_MOTION_OUT ?? 'test-results/panel-motion/';
const PROJECT = `pm-${randomBytes(3).toString('hex')}`;
const REPO_URL = 'https://git.example.test/acme/app.git';

test.skip(process.env.E2E_MOTION !== '1', 'opt-in: E2E_MOTION=1 (records videos)');
test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.use({
  video: { mode: 'on', size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
  locale: 'tr-TR',
});

let admin: EnrolledAdmin;
let worker: FakeWorker | null = null;
let jobId = '';

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
  await resetRateLimits();
  await withE2ePool(async (pool) => {
    await pool.query(
      `INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO NOTHING`,
      [PROJECT, 'Acme Web'],
    );
  });
  admin = await createEnrolledAdmin('motion');
  await withE2ePool(async (pool) => {
    await pool.query(`UPDATE users SET locale = 'tr' WHERE username = $1`, [admin.username]);
  });
});

test.afterAll(async () => {
  await worker?.stop();
});

test.afterEach(async ({ page }, info) => {
  const video = page.video();
  // A step-up rotates the session: the next clip goes on with the current cookie.
  if (cookies !== null) cookies = await page.context().cookies();
  await page.close();
  if (video !== null) await copyFile(await video.path(), `${OUT}${info.title.split(' ')[0] ?? 'clip'}.webm`);
});

let cookies: Cookie[] | null = null;

/**
 * The Diyalog sign-in (password, then the code that submits itself), once, in a context that is not recorded (waiting
 * for the next authenticator time step would fill the clips); every clip then starts signed in with that session.
 */
async function signIn(page: Page): Promise<void> {
  if (cookies === null) {
    const browser = page.context().browser();
    if (browser === null) throw new Error('no browser');
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL ?? '', locale: 'tr-TR' });
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.getByLabel('Kullanıcı adı').fill(admin.username);
    await p.getByLabel('Parola', { exact: true }).fill(admin.password);
    await p.getByRole('button', { name: 'Devam et' }).click();
    await p.getByLabel('6 haneli kod').fill(await admin.authenticator.nextCode());
    await expect(p).not.toHaveURL(/\/login/, { timeout: 60_000 });
    cookies = await ctx.cookies();
    await ctx.close();
  }
  await page.context().addCookies(cookies);
}

/** The master's canonical JSON (sorted keys, no spaces) — what a draft's payload hash is taken over. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** Announce a change the way the console's own mutations do (the in-page invalidation bus), instead of the 10 s poll. */
async function nudge(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('remyral:invalidate', { detail: 'chat' })));
}

async function userId(): Promise<string> {
  return withE2ePool(async (pool) =>
    String((await pool.query('SELECT id FROM users WHERE username = $1', [admin.username])).rows[0]?.id),
  );
}

async function addMessage(
  thread: string,
  role: string,
  content: string,
  meta: Record<string, unknown> | null = null,
): Promise<void> {
  await withE2ePool(async (pool) => {
    const seq = Number(
      (await pool.query('SELECT next_seq FROM chat_threads WHERE id = $1', [thread])).rows[0]?.next_seq ?? 1,
    );
    await pool.query(
      `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, now())`,
      [randomUUID(), thread, seq, role, content, meta === null ? null : JSON.stringify(meta)],
    );
    await pool.query('UPDATE chat_threads SET next_seq = $2, updated_at = now() WHERE id = $1', [
      thread,
      seq + 1,
    ]);
  });
}

async function newThread(title: string): Promise<string> {
  const uid = await userId();
  return withE2ePool(async (pool) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO chat_threads (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`,
      [id, uid, title],
    );
    return id;
  });
}

test('machine — a worker pairs while Makineler is open (connecting → Hazır)', async ({ page }) => {
  await signIn(page);
  await page.goto('/machines');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(800);
  worker = await startFakeWorker(admin, { project: PROJECT, repoUrl: REPO_URL });
  await expect(page.getByText('pocket-runner').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('worker-state').first()).toHaveAttribute('data-state', 'online', {
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
});

test('job — a job goes live; its approval takes a wrong code (shake), then the right one (check)', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/jobs');
  await page.getByRole('link', { name: 'Yeni iş' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Yeni iş' })).toBeVisible();
  await page.getByLabel('Proje', { exact: true }).selectOption(PROJECT);
  await page.getByLabel('Depo adresi').fill(REPO_URL);
  await page.getByLabel('Temel dal').fill('main');
  await expect(page.getByTestId('placement-verdict').first()).toHaveAttribute('data-verdict', 'placed');
  await page.getByLabel('Ajanın görevi').fill('Update the README and push the branch. [approval]');
  await page.getByTestId('composer-submit').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  jobId = page.url().split('/').pop() ?? '';
  const log = page.getByRole('log', { name: 'Akış günlüğü' });
  await expect(log.getByText('Reading the repository layout.').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  // The approval, decided in place with the authenticator code: the security policy is the strict preset for this step
  // (approvals ask for a code; the default preset does not) and the last code is old, so the decision asks for one. A
  // wrong code first (the field shakes, its ticks turn red), then the right one (the ticks fill, the check confirms).
  await withE2ePool(async (pool) => {
    await pool.query(`UPDATE security_policy SET document = '{"preset":"siki"}'::jsonb WHERE id = 1`);
    await pool.query(
      `UPDATE sessions SET mfa_at = now() - interval '13 hours'
        WHERE user_id = (SELECT id FROM users WHERE username = $1) AND stage = 'full'`,
      [admin.username],
    );
  });
  // The master reads the policy through a 5 s cache.
  await page.waitForTimeout(6_000);
  await page.goto('/approvals');
  const item = page
    .getByTestId('approval-card')
    .filter({ hasText: /Push the work branch/ })
    .first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  const detail = page.getByTestId('approval-detail');
  await detail.getByRole('button', { name: 'Onayla' }).click();
  const send = detail.getByRole('button', { name: 'Onayı gönder' });
  if (await send.isVisible().catch(() => false)) await send.click();
  const code = detail.locator('input[autocomplete="one-time-code"]');
  const asked = await code
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`p17-panel-motion approval: code asked = ${String(asked)}`);
  if (asked) {
    await page.waitForTimeout(500);
    await code.pressSequentially('000000', { delay: 110 });
    await code.press('Enter');
    await expect(detail.locator('[data-shake]')).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(1100);
    await code.pressSequentially(await admin.authenticator.nextCode(), { delay: 110 });
    await code.press('Enter');
  }
  await expect(detail.getByText(/Onaylandı/).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await withE2ePool(async (pool) => {
    await pool.query(`UPDATE security_policy SET document = '{"preset":"serbest"}'::jsonb WHERE id = 1`);
  });
  await page.goto(`/jobs/${jobId}`);
  // The run continues after the approval (the clip records it; how fast the fake run finishes is not the point here).
  await expect(page.getByText('Push approved; finishing up.').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('dy-job-state'))
    .toHaveAttribute('data-state', /SUCCEEDED|VERIFYING/, { timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);
});

test('chat — request → job draft card → queued → result card', async ({ page }) => {
  const thread = await newThread('README güncellemesi');
  await addMessage(thread, 'user', 'Acme Web için README’yi güncelleyen bir iş hazırlar mısın?');
  await addMessage(thread, 'assistant', 'Tabii. Önce projeye ve makinelere bakıyorum.');
  await signIn(page);
  await page.goto(`/chat/${thread}`);
  const log = page.getByRole('log', { name: 'Sohbet' });
  await expect(log.getByText('Önce projeye')).toBeVisible();
  await page.waitForTimeout(900);

  // The person's follow-up and the assistant's answer with a job draft card arrive.
  await addMessage(thread, 'user', 'Evet, pocket-runner üzerinde çalışsın.');
  await nudge(page);
  await page.waitForTimeout(900);
  const uid = await userId();
  const draftId = randomUUID();
  const turn = randomUUID();
  const payload = {
    project: PROJECT,
    spec: {
      runtime: 'codex',
      prompt: 'Update the README with the new install steps.',
      repository: { url: REPO_URL, baseRef: 'main', workBranch: 'remyral/readme-install' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      sourceTrust: 'trusted',
      limits: { maxDurationSec: 1800 },
    },
  };
  await withE2ePool(async (pool) => {
    await pool.query(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'job', $5, $6, $7, $8, 'proposed', now(), now() + interval '24 hours')`,
      [
        draftId,
        thread,
        uid,
        turn,
        'README kurulum adımlarını güncelle',
        JSON.stringify(payload),
        createHash('sha256').update(canonical(payload)).digest('hex'),
        PROJECT,
      ],
    );
  });
  await addMessage(thread, 'tool', 'draft_job: draft card', { name: 'draft_job', isError: false, draftId });
  await addMessage(thread, 'assistant', 'İş kartını hazırladım. Onaylayınca pocket-runner üzerinde başlar.');
  await nudge(page);
  const strip = page.getByTestId('card-strip').last();
  await expect(strip).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200);

  // Open the card and confirm it with the authenticator code (the sign-in was "a while ago": the card asks for it). A
  // wrong code first: the field shakes and its ticks turn red; then the right one: ticks fill, the check confirms.
  // The default security preset keeps a code valid for 12 h: the last code is made 13 h old.
  await withE2ePool(async (pool) => {
    await pool.query(
      `UPDATE sessions SET mfa_at = now() - interval '13 hours'
        WHERE user_id = (SELECT id FROM users WHERE username = $1) AND stage = 'full'`,
      [admin.username],
    );
  });
  await page.reload();
  const strip2 = page.getByTestId('card-strip').last();
  await expect(strip2).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await strip2.getByTestId('strip-primary').click();
  await page.waitForTimeout(700);
  const panel = page.getByTestId('strip-panel');
  // The reader scrolls the opened card above the composer, then confirms (keyboard: the composer may cover it).
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(500);
  const confirmButton = panel.getByRole('button', { name: 'Kuyruğa al', exact: true }).first();
  await confirmButton.focus();
  await confirmButton.press('Enter');
  // The card asks for the code itself, or once the master answers that a fresh step-up is required.
  const code = panel.locator('input[autocomplete="one-time-code"]');
  const asked = await code
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (asked) {
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(400);
    await code.pressSequentially('000000', { delay: 110 });
    await code.press('Enter');
    await expect(panel.locator('[data-shake]')).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(1000);
    await code.pressSequentially(await admin.authenticator.nextCode(), { delay: 110 });
    await code.press('Enter');
  }
  console.log(`p17-panel-motion chat: code asked = ${String(asked)}`);
  await expect(page.getByTestId('strip-card').first()).toContainText(/Onaylandı|Bitti/, { timeout: 20_000 });
  await page.waitForTimeout(1200);

  // The job's end note arrives with its result card.
  const confirmed = await withE2ePool(async (pool) => {
    const job: unknown = (
      await pool.query("SELECT result->>'jobId' AS job FROM chat_drafts WHERE id = $1", [draftId])
    ).rows[0]?.job;
    return typeof job === 'string' ? job : jobId;
  });
  await addMessage(thread, 'assistant', 'İş bitti: README güncellendi.', {
    notice: 'chat-watch',
    jobId: confirmed,
    jobSummary: 'README’ye kurulum adımları eklendi.',
  });
  await nudge(page);
  await expect(page.getByTestId('job-result-card').last()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2000);
});

test('perf — a 500-message conversation opens and takes new messages without animation long tasks', async ({
  page,
}) => {
  const thread = await newThread('Uzun sohbet (500 mesaj)');
  await withE2ePool(async (pool) => {
    const values: string[] = [];
    const args: unknown[] = [thread];
    for (let i = 1; i <= 500; i++) {
      args.push(
        randomUUID(),
        i,
        i % 2 === 1 ? 'user' : 'assistant',
        `Mesaj ${String(i)}: ${'kısa bir satır '.repeat(4)}`,
      );
      const b = args.length - 3;
      values.push(
        `($${String(b)}, $1, $${String(b + 1)}, $${String(b + 2)}, $${String(b + 3)}, NULL, NULL, now() - make_interval(secs => ${String(600 - i)}))`,
      );
    }
    await pool.query(
      `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at) VALUES ${values.join(',')}`,
      args,
    );
    await pool.query('UPDATE chat_threads SET next_seq = 501 WHERE id = $1', [thread]);
  });
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __long: { start: number; duration: number }[] };
    w.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`/chat/${thread}`);
  await expect(page.getByRole('log', { name: 'Sohbet' }).getByText('Mesaj 500:')).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(1500);
  const entered = await page.evaluate(() => document.querySelectorAll('[role="log"] > li.dy-enter').length);
  // CPU profile of the arrivals: the time spent in the motion modules themselves, next to the long tasks of the whole
  // page; then the same arrivals with reduced motion (no motion work at all) as the baseline.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  let n = 0;
  const arrivals = async (): Promise<{
    long: number[];
    motionMs: number;
    totalMs: number;
    animated: number;
  }> => {
    const after = await page.evaluate(() => performance.now());
    await cdp.send('Profiler.start');
    for (let i = 0; i < 4; i++) {
      n += 1;
      await addMessage(thread, n % 2 === 1 ? 'user' : 'assistant', `Yeni mesaj ${String(n)}`);
      await nudge(page);
      await expect(page.getByText(`Yeni mesaj ${String(n)}`, { exact: true })).toBeVisible();
      await page.waitForTimeout(600);
    }
    const { profile } = (await cdp.send('Profiler.stop')) as {
      profile: {
        nodes: { id: number; callFrame: { url: string } }[];
        samples: number[];
        timeDeltas: number[];
      };
    };
    const urlOf = new Map(profile.nodes.map((x) => [x.id, x.callFrame.url]));
    let motion = 0;
    let total = 0;
    profile.samples.forEach((id, i) => {
      const dt = (profile.timeDeltas[i] ?? 0) / 1000;
      const url = urlOf.get(id) ?? '';
      if (url !== '') total += dt;
      if (/motionKit|codeMotion|\/motion\.ts/.test(url)) motion += dt;
    });
    const long = await page.evaluate((t) => {
      const w = window as unknown as { __long: { start: number; duration: number }[] };
      return w.__long.filter((e) => e.start >= t).map((e) => Math.round(e.duration));
    }, after);
    const animated = await page.evaluate(
      () => document.querySelectorAll('[role="log"] > li.dy-enter').length,
    );
    return { long, motionMs: Math.round(motion * 10) / 10, totalMs: Math.round(total), animated };
  };
  // Warm-up batch (JIT, first renders) not counted; then reduced motion, motion, reduced again.
  await arrivals();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await arrivals();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const withMotion = await arrivals();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedAgain = await arrivals();
  console.log(
    `p17-panel-motion perf: ${JSON.stringify({ enteredOnOpen: entered, reduced, withMotion, reducedAgain })}`,
  );
  expect(entered).toBe(0);
  expect(withMotion.animated).toBeGreaterThan(0);
  // The motion code's own JS stays far below a long task (50 ms) across four arrivals on a 500-message thread.
  expect(withMotion.motionMs).toBeLessThan(50);
});
