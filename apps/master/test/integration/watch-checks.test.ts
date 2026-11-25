import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import type { Role } from '../../src/auth/users.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { WatchChecks } from '../../src/chat/watch-checks.js';
import { FOLLOW_UP_CAP, WatchFollowUps } from '../../src/chat/watch-follow-up.js';
import { AuditLog } from '../../src/audit/audit.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p15-watches (Takipler, docs/design/p15-watches.md) against a real master database: `create_watch` composes a typed
 * condition, the master tests it once right away (dry test) and then evaluates it by itself — event conditions when
 * the triggers of migration 0119 notify `remana_watch` (no polling), external checks as `function` jobs (a worker's
 * result is simulated here; the worker side has its own tests) on a backoff schedule. Fires exactly once (several
 * evaluations racing, duplicate events), times out with the last check, survives a restart (a second engine on the
 * same database), and never starts an assistant turn.
 */
const PW = 'quartz-meadow-lantern-7';
const WORKER = 'wrk_dddddddddddddddddddddddddd';

const h = new Harness();
let store: ChatStore;
let tools: ChatTools;
let opId = '';
let outsiderId = '';

async function caller(userId: string, role: Role): Promise<ToolCaller> {
  const thread = (await store.createThread(userId, 'takip')).id;
  return {
    userId,
    subject: await loadSubject(h.db.pool, { id: userId, role }),
    threadId: thread,
    turnId: randomUUID(),
  };
}

async function insertJob(project: string, state = 'RUNNING'): Promise<string> {
  const now = h.clock.now();
  const { rows } = await h.db.pool.query<{ id: string }>(
    `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                       created_at, updated_at, state_changed_at)
     VALUES ($1, $2, $3, 0, 1, 0, 'user', 'test', $4, $4, $4) RETURNING id::text AS id`,
    [
      project,
      JSON.stringify({ runtime: 'codex', prompt: 'Start the dev server and open a preview' }),
      state,
      now,
    ],
  );
  return rows[0]?.id ?? '';
}

const setJobState = async (jobId: string, state: string): Promise<void> => {
  await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [jobId, state]);
};

const watch = async (id: string) =>
  (
    await h.db.pool.query<{
      state: string;
      end_reason: string | null;
      fire_count: number;
      check_count: number;
      unmet_streak: number;
      next_check_at: Date | null;
      pending_job_id: string | null;
      last_check: { met: boolean; summary: string; mode: string } | null;
      result: { url: string | null; value: unknown } | null;
    }>(
      `SELECT state, end_reason, fire_count, check_count, unmet_streak, next_check_at,
              pending_job_id::text AS pending_job_id, last_check, result FROM chat_watches WHERE id = $1`,
      [id],
    )
  ).rows[0];

const watchNotes = async (threadId: string) =>
  (await store.messages(threadId)).filter((m) => m.meta?.notice === 'chat-watch');

const bell = async (userId: string) =>
  (
    await h.db.pool.query<{ title: string; body: string; link: string | null; dedupe_key: string }>(
      `SELECT title, body, link, dedupe_key FROM notifications WHERE recipient_id = $1 AND kind = 'chat.watch'
        ORDER BY created_at, id`,
      [userId],
    )
  ).rows;

const fires = async (id: string) =>
  (await h.db.pool.query('SELECT 1 FROM chat_watch_fires WHERE watch_id = $1', [id])).rowCount ?? 0;

/** Assistant turns (the AI) — a watch must never start one. */
const turns = async () =>
  Number((await h.db.pool.query<{ n: string }>('SELECT count(*) AS n FROM chat_turns')).rows[0]?.n);

function created(out: Awaited<ReturnType<ChatTools['run']>>): {
  watchId: string;
  status: string;
  dryTest: { ran: boolean; met?: boolean; result?: string };
} {
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error('refused');
  return out.data as never;
}

/** Simulates the worker: the check job ran and reported its result artifact. */
async function finishCheckJob(jobId: string, result: Record<string, unknown> | null, state = 'SUCCEEDED') {
  const attempt = randomUUID();
  if (result !== null) {
    const content = Buffer.from(JSON.stringify(result), 'utf8');
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind, redacted,
                                  content, created_at)
       VALUES ($1, $2, 'ws-function-result', 'function-result.json', 'application/json', $3, $4, 'function', false, $5, now())`,
      [attempt, jobId, content.length, createHash('sha256').update(content).digest('hex'), content],
    );
  }
  await setJobState(jobId, state);
}

const engine = (): WatchChecks =>
  (h.app.chatWatches as unknown as { deps: { checks: WatchChecks } }).deps.checks;

describeIntegration(
  'Takipler: deterministic watches (integration, p15-watches)',
  { timeout: 300_000 },
  () => {
    beforeAll(async () => {
      await h.start({ watchChecks: { dryWaitMs: 300, queueTimeoutSec: 600 } });
      opId = await h.createUser('op1', PW, 'operator');
      outsiderId = await h.createUser('op.other', PW, 'operator');
      for (const p of ['alpha', 'beta'])
        await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [p]);
      await h.grant(opId, ['alpha'], 'operator');
      await h.grant(outsiderId, ['beta'], 'operator');
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        watches: () => h.app.chatWatches,
      } as unknown as ChatToolsDeps);
      await engine().listen();
      for (let i = 0; i < 100 && !engine().listening; i++) await new Promise((r) => setTimeout(r, 100));
      expect(engine().listening).toBe(true);
    });
    afterAll(async () => {
      await h.stop();
    });

    it('event-driven: dry test, then the job change fires it exactly once — no polling, no AI', async () => {
      const turnsBefore = await turns();
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_state', jobId, states: ['succeeded'] },
          label: 'Build hazır',
        }),
      );
      expect(out.status).toBe('watching');
      expect(out.dryTest).toMatchObject({ ran: true, met: false });
      expect(out.dryTest.result).toContain('RUNNING');
      const w0 = await watch(out.watchId);
      // Event conditions are never scheduled.
      expect(w0).toMatchObject({ state: 'active', next_check_at: null, pending_job_id: null });

      // No tick runs: the trigger → NOTIFY → listener evaluates the watch.
      await setJobState(jobId, 'SUCCEEDED');
      await expect.poll(async () => (await watch(out.watchId))?.state, { timeout: 15_000 }).toBe('done');
      await engine().idle();
      expect(await watch(out.watchId)).toMatchObject({ end_reason: 'fired', fire_count: 1 });
      expect(await fires(out.watchId)).toBe(1);
      const posted = await watchNotes(c.threadId);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ role: 'assistant' });
      expect(posted[0]?.content).toContain('Build hazır');
      expect((await bell(opId)).filter((n) => n.dedupe_key === `chat.watch:${out.watchId}:met`)).toHaveLength(
        1,
      );

      // Duplicate wake-ups and racing evaluations change nothing.
      engine().wakeSubject(`job:${jobId}`);
      await Promise.all([1, 2, 3].map(() => engine().evaluate(out.watchId, 'event')));
      await engine().idle();
      expect(await fires(out.watchId)).toBe(1);
      expect(await watchNotes(c.threadId)).toHaveLength(1);
      expect(await turns()).toBe(turnsBefore);
    });

    it('racing evaluations of one met condition deliver once', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', { condition: { kind: 'job_state', jobId, states: ['failed'] } }),
      );
      await h.db.pool.query("UPDATE jobs SET state = 'FAILED', version = version + 1 WHERE id = $1", [jobId]);
      await Promise.all(Array.from({ length: 6 }, () => engine().evaluate(out.watchId, 'event')));
      await engine().idle();
      expect(await fires(out.watchId)).toBe(1);
      expect(await watchNotes(c.threadId)).toHaveLength(1);
    });

    it('dry test already met: delivered at once; the same condition asked twice is one watch', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha', 'SUCCEEDED');
      const out = created(
        await tools.run(c, 'create_watch', { condition: { kind: 'job_state', jobId, states: ['finished'] } }),
      );
      expect(out.status).toMatch(/met now/);
      expect(out.dryTest).toMatchObject({ met: true });
      expect(await watchNotes(c.threadId)).toHaveLength(1);

      const running = await insertJob('alpha');
      const a = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_state', jobId: running, states: ['failed'] },
        }),
      );
      const b = created(
        await tools.run(c, 'create_watch', {
          condition: { states: ['failed'], kind: 'job_state', jobId: running },
        }),
      );
      expect(b.watchId).toBe(a.watchId);
      expect(b.status).toMatch(/updated/);
    });

    it('a condition that can no longer happen ends with a note (the job failed, the watch wanted success)', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_state', jobId, states: ['succeeded'] },
        }),
      );
      await setJobState(jobId, 'FAILED');
      await expect.poll(async () => (await watch(out.watchId))?.state, { timeout: 15_000 }).toBe('done');
      expect((await watch(out.watchId))?.end_reason).toBe('never:never');
      expect(await fires(out.watchId)).toBe(0);
      expect((await watchNotes(c.threadId)).at(-1)?.content).toMatch(/hiçbir zaman|can never/);
    });

    it('job log pattern and outputs: evaluated on their rows; the matching line is delivered', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const ev = created(
        await tools.run(c, 'create_watch', { condition: { kind: 'job_event', jobId, contains: 'Step 3/5' } }),
      );
      const outp = created(
        await tools.run(c, 'create_watch', { condition: { kind: 'job_output', jobId, name: '*.apk' } }),
      );
      expect(ev.dryTest).toMatchObject({ met: false });
      const event = async (text: string, seq: number) =>
        h.db.pool.query(
          `INSERT INTO job_events (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id, stream_seq,
                                 kind, payload, ts, received_at, size_bytes)
         VALUES ($1, $2, 1, 1, $3, $4, $5, $4, 'message', $6, now(), now(), 10)`,
          [
            jobId,
            randomUUID(),
            WORKER,
            seq,
            randomUUID(),
            JSON.stringify({ kind: 'message', role: 'assistant', text }),
          ],
        );
      await event('Step 2/5: installing dependencies', 1);
      await engine().idle();
      expect((await watch(ev.watchId))?.state).toBe('active');
      await event('Step 3/5: building the APK', 2);
      await expect.poll(async () => (await watch(ev.watchId))?.state, { timeout: 15_000 }).toBe('done');
      expect((await watch(ev.watchId))?.result?.value).toMatchObject({ line: 'Step 3/5: building the APK' });

      const content = Buffer.from('apk');
      await h.db.pool.query(
        `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind, redacted,
                                  content, created_at)
       VALUES ($1, $2, 'ws-app', 'app-release.apk', 'application/octet-stream', 3, $3, 'output', false, $4, now())`,
        [randomUUID(), jobId, createHash('sha256').update(content).digest('hex'), content],
      );
      await expect.poll(async () => (await watch(outp.watchId))?.state, { timeout: 15_000 }).toBe('done');
      expect((await watchNotes(c.threadId)).at(-1)?.content).toContain('app-release.apk');
    });

    it('preview tunnel up: the event delivers the URL (the owner example)', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(await tools.run(c, 'create_watch', { condition: { kind: 'preview_up', jobId } }));
      expect(out.dryTest).toMatchObject({ met: false });
      const tunnel = randomUUID();
      await h.db.pool.query(
        `INSERT INTO preview_tunnels (id, project, name, hostname, zone_id, zone_name, protection, state, job_id, port,
                                    connector_state, opened_by_type, opened_by_id, expires_at, created_at, updated_at)
       VALUES ($1, 'alpha', 'web', 'web-abcdefghij.example.com', $2, 'example.com', 'none', 'active', $3, 3000,
               'starting', 'system', 'test', now() + interval '1 hour', now(), now())`,
        [tunnel, 'a'.repeat(32), jobId],
      );
      await expect
        .poll(async () => (await watch(out.watchId))?.last_check?.summary, { timeout: 15_000 })
        .toMatch(/starting/);
      expect((await watch(out.watchId))?.state).toBe('active');
      await h.db.pool.query("UPDATE preview_tunnels SET connector_state = 'running' WHERE id = $1", [tunnel]);
      await expect.poll(async () => (await watch(out.watchId))?.state, { timeout: 15_000 }).toBe('done');
      expect((await watch(out.watchId))?.result?.url).toBe('https://web-abcdefghij.example.com');
      const note = (await watchNotes(c.threadId)).at(-1);
      expect(note?.content).toContain('https://web-abcdefghij.example.com');
      expect(note?.meta).toMatchObject({ event: 'met', url: 'https://web-abcdefghij.example.com' });
    });

    it('HTTP checks run as function jobs on workers with backoff; refused targets are refused at once', async () => {
      const c = await caller(opId, 'operator');
      // The master never checks a private address; worker_probe is the way for a machine's localhost.
      const local = await tools.run(c, 'create_watch', {
        condition: { kind: 'http', project: 'alpha', url: 'http://127.0.0.1:3000/' },
      });
      expect(local).toMatchObject({ ok: false, code: 'invalid' });
      // Outside the user's projects: not found.
      expect(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'http', project: 'beta', url: 'https://example.com/' },
        }),
      ).toMatchObject({ ok: false, code: 'not_found' });

      const out = created(
        await tools.run(c, 'create_watch', {
          condition: {
            kind: 'http',
            project: 'alpha',
            url: 'https://app.example.com/health',
            expect: { status: [200], jsonata: 'body.ready = true' },
          },
          checkEverySec: 60,
        }),
      );
      // The dry test started a check job; nobody ran it within the (short) dry wait.
      const w1 = await watch(out.watchId);
      expect(w1?.pending_job_id).not.toBeNull();
      const { rows: job } = await h.db.pool.query<{
        state: string;
        spec: Record<string, unknown>;
        created_by_id: string;
      }>('SELECT state::text AS state, spec, created_by_id FROM jobs WHERE id = $1', [w1?.pending_job_id]);
      expect(job[0]).toMatchObject({ state: 'QUEUED', created_by_id: opId });
      expect(job[0]?.spec).toMatchObject({
        kind: 'function',
        function: { type: 'http', request: { method: 'GET', url: 'https://app.example.com/health' } },
      });

      // The worker answers "not ready": unmet, the next check in 60 s.
      const t0 = h.clock.now().getTime();
      await finishCheckJob(String(w1?.pending_job_id), {
        type: 'http',
        status: 200,
        headers: {},
        body: { ready: false },
        bodyEncoding: 'json',
        truncated: false,
        sizeBytes: 15,
        finalUrl: 'https://app.example.com/health',
        redirects: 0,
        credentialAttached: false,
        durationMs: 40,
      });
      await expect
        .poll(async () => (await watch(out.watchId))?.pending_job_id, { timeout: 15_000 })
        .toBeNull();
      const w2 = await watch(out.watchId);
      expect(w2?.last_check).toMatchObject({ met: false });
      expect(w2?.unmet_streak).toBe(1);
      expect((w2?.next_check_at?.getTime() ?? 0) - t0).toBe(60_000);

      // Not due yet: the tick starts nothing.
      await h.app.chatWatches.tick();
      expect((await watch(out.watchId))?.pending_job_id).toBeNull();
      // Due: a second check job; it fails (unreachable) → backoff 90 s.
      h.clock.advance(61_000);
      await h.app.chatWatches.tick();
      const second = (await watch(out.watchId))?.pending_job_id;
      expect(second).not.toBeNull();
      const t1 = h.clock.now().getTime();
      await finishCheckJob(String(second), null, 'FAILED');
      await expect
        .poll(async () => (await watch(out.watchId))?.pending_job_id, { timeout: 15_000 })
        .toBeNull();
      const w3 = await watch(out.watchId);
      expect(w3?.state).toBe('active');
      expect(w3?.unmet_streak).toBe(2);
      expect((w3?.next_check_at?.getTime() ?? 0) - t1).toBe(90_000);

      // Third check: ready → met, the JSONata value delivered.
      h.clock.advance(91_000);
      await h.app.chatWatches.tick();
      const third = (await watch(out.watchId))?.pending_job_id;
      await finishCheckJob(String(third), {
        type: 'http',
        status: 200,
        headers: {},
        body: { ready: true },
        bodyEncoding: 'json',
        truncated: false,
        sizeBytes: 14,
        finalUrl: 'https://app.example.com/health',
        redirects: 0,
        credentialAttached: false,
        durationMs: 30,
      });
      await expect.poll(async () => (await watch(out.watchId))?.state, { timeout: 15_000 }).toBe('done');
      expect(await fires(out.watchId)).toBe(1);
      const checks = await h.db.pool.query('SELECT mode FROM chat_watch_checks WHERE watch_id = $1', [
        out.watchId,
      ]);
      expect(checks.rowCount).toBeGreaterThanOrEqual(2);
    });

    it('a check job no machine takes is cancelled after the queue timeout and retried later', async () => {
      const c = await caller(opId, 'operator');
      const out = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'http', project: 'alpha', url: 'https://slow.example.com/' },
        }),
      );
      const job = (await watch(out.watchId))?.pending_job_id;
      expect(job).not.toBeNull();
      h.clock.advance(601_000);
      await h.app.chatWatches.tick();
      await engine().idle();
      const w = await watch(out.watchId);
      expect(w?.pending_job_id).toBeNull();
      expect(w?.last_check?.summary).toMatch(/makine|machine/);
      const { rows } = await h.db.pool.query<{ state: string }>(
        'SELECT state::text AS state FROM jobs WHERE id = $1',
        [job],
      );
      expect(rows[0]?.state).toBe('CANCELLED');
      expect(w?.next_check_at).not.toBeNull();
    });

    it('times out with "it did not happen" and the last check, in the thread and the bell', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_event', jobId, contains: 'deployed' },
          timeoutMinutes: 5,
          language: 'en',
        }),
      );
      h.clock.advance(6 * 60_000);
      await h.app.chatWatches.tick();
      expect((await watch(out.watchId))?.state).toBe('expired');
      const note = (await watchNotes(c.threadId)).at(-1);
      expect(note?.content).toMatch(/Did not happen/);
      expect(note?.content).toContain('has not shown up yet');
      expect((await bell(opId)).some((n) => n.dedupe_key === `chat.watch:${out.watchId}:timeout`)).toBe(true);
    });

    it('a watch that ended unmet hands the conversation back to the assistant, once (p19-watch-follow-up)', async () => {
      const sent: { userId: string; threadId: string; text: string; watchId: string }[] = [];
      let idle = true;
      const followUps = new WatchFollowUps({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        log: h.app.log,
        chat: () => ({
          idle: () => Promise.resolve(idle),
          send: (actor, threadId, text, opts) => {
            sent.push({ userId: actor.userId, threadId, text, watchId: opts.followUp.watchId });
            return Promise.resolve({ turnId: randomUUID() });
          },
        }),
      });
      const followUp = async (id: string) =>
        (
          await h.db.pool.query<{ follow_up: string | null }>(
            'SELECT follow_up FROM chat_watches WHERE id = $1',
            [id],
          )
        ).rows[0]?.follow_up;
      // Can never be met (the job failed): ends now with its note — and the assistant carries on.
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_state', jobId, states: ['succeeded'] },
        }),
      );
      await setJobState(jobId, 'FAILED');
      await expect.poll(async () => (await watch(out.watchId))?.state, { timeout: 15_000 }).toBe('done');
      // A turn runs in the conversation: nothing yet (tried again on the next pass).
      idle = false;
      expect(await followUps.tick()).toBe(0);
      expect(await followUp(out.watchId)).toBeNull();
      idle = true;
      // (Watches of earlier tests in this file that ended unmet get theirs too: only this one is looked at.)
      await followUps.tick();
      const mine = () => sent.filter((x) => x.watchId === out.watchId);
      expect(mine()).toHaveLength(1);
      expect(mine()[0]).toMatchObject({ userId: opId, threadId: c.threadId });
      expect(mine()[0]?.text).toMatch(
        /^(?:Takip sonuçsuz bitti|The watch ended without its condition): .+ — /,
      );
      expect(await followUp(out.watchId)).toBe('sent');
      // Once.
      await followUps.tick();
      expect(mine()).toHaveLength(1);
      const audit = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'chat.watch.follow_up' AND target = $1`,
        [`chat-watch:${out.watchId}`],
      );
      expect(audit.rowCount).toBe(1);

      // The person wrote after the watch ended: they are on it — no follow-up.
      const c2 = await caller(opId, 'operator');
      const job2 = await insertJob('alpha');
      const out2 = created(
        await tools.run(c2, 'create_watch', {
          condition: { kind: 'job_state', jobId: job2, states: ['succeeded'] },
        }),
      );
      await setJobState(job2, 'FAILED');
      await expect.poll(async () => (await watch(out2.watchId))?.state, { timeout: 15_000 }).toBe('done');
      h.clock.advance(1_000);
      await store.addMessage(c2.threadId, {
        role: 'user',
        content: 'durum nedir?',
        meta: { origin: 'user' },
      });
      await followUps.tick();
      expect(await followUp(out2.watchId)).toBe('skipped:user_active');

      // A met watch needs none; an old end (past the window) is left alone.
      const job3 = await insertJob('alpha');
      const out3 = created(
        await tools.run(c2, 'create_watch', {
          condition: { kind: 'job_state', jobId: job3, states: ['failed'] },
        }),
      );
      await setJobState(job3, 'FAILED');
      await expect.poll(async () => (await watch(out3.watchId))?.state, { timeout: 15_000 }).toBe('done');
      expect((await watch(out3.watchId))?.end_reason).toBe('fired');
      await followUps.tick();
      expect(await followUp(out3.watchId)).toBeNull();

      // At most FOLLOW_UP_CAP per conversation in six hours (a follow-up whose new watch fails again cannot loop).
      const c3 = await caller(opId, 'operator');
      const ids: string[] = [];
      for (let i = 0; i <= FOLLOW_UP_CAP; i++) {
        const j = await insertJob('alpha');
        const o = created(
          await tools.run(c3, 'create_watch', {
            condition: { kind: 'job_state', jobId: j, states: ['succeeded'] },
            label: `deneme ${String(i)}`,
          }),
        );
        await setJobState(j, 'FAILED');
        await expect.poll(async () => (await watch(o.watchId))?.state, { timeout: 15_000 }).toBe('done');
        await followUps.tick();
        ids.push(o.watchId);
      }
      expect(await Promise.all(ids.map(followUp))).toEqual([
        ...Array.from({ length: FOLLOW_UP_CAP }, () => 'sent'),
        'skipped:cap',
      ]);
      expect(sent.filter((x) => x.threadId === c3.threadId)).toHaveLength(FOLLOW_UP_CAP);
    });

    it('only the owner: list and cancel through the tools; a lost project access revokes', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', { condition: { kind: 'job_state', jobId, states: ['finished'] } }),
      );
      const listed = await tools.run(c, 'list_watches', {});
      const items = listed.ok
        ? (listed.data as { watches: { watchId: string; condition?: string; checkedBy?: string }[] }).watches
        : [];
      const mine = items.find((w) => w.watchId === out.watchId);
      expect(mine).toMatchObject({ checkedBy: 'event' });
      expect(mine?.condition).toBeTruthy();
      const o = await caller(outsiderId, 'operator');
      expect(await tools.run(o, 'cancel_watch', { watchId: out.watchId })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      expect(
        await tools.run(o, 'create_watch', { condition: { kind: 'job_state', jobId, states: ['finished'] } }),
      ).toMatchObject({ ok: false, code: 'not_found' });
      const cancel = await tools.run(c, 'cancel_watch', { watchId: out.watchId });
      expect(cancel.ok).toBe(true);
      expect((await watch(out.watchId))?.state).toBe('cancelled');
    });
    it('survives a restart: a new engine on the same database reconciles and fires', async () => {
      const c = await caller(opId, 'operator');
      const jobId = await insertJob('alpha');
      const out = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_state', jobId, states: ['cancelled'] },
        }),
      );
      // The running listener is stopped (the process "died"); the change happens while nobody listens.
      await engine().stop();
      await setJobState(jobId, 'CANCELLED');
      expect((await watch(out.watchId))?.state).toBe('active');
      const fresh = new WatchChecks({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        store,
        clock: h.clock.now,
        log: h.app.log,
        notifications: () => h.app.notifications,
      });
      try {
        // Boot: one reconcile pass over event watches (SQL only).
        await fresh.tick();
        expect((await watch(out.watchId))?.state).toBe('done');
        expect(await fires(out.watchId)).toBe(1);
      } finally {
        await fresh.stop();
      }
    });
  },
);
