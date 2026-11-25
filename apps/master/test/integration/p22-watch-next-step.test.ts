import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { WatchFollowUps } from '../../src/chat/watch-follow-up.js';
import { nextStepConsent } from '../../src/chat/watches.js';
import { GOAL_GRANT_TTL_MS } from '../../src/chat/goal-grants.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p22-watch-next-step (docs/design/p22-watch-next-step.md): a watch the assistant gave a next step hands the
 * conversation back to it whenever the watched thing ends — succeeded or failed — with that step; a watch without one
 * only tells (as before). The person's consent behind the step is kept and holds for GOAL_GRANT_TTL_MS.
 */
const PW = 'copper-lantern-river-8';
const PROJECT = 'ns-alpha';
const WORKER = 'wrk-ns-1';

describeIntegration('p22-watch-next-step (integration)', { timeout: 180_000 }, () => {
  const h = new Harness();
  let ownerId: string;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 } });
    ownerId = await h.createUser('owner1', PW);
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING',
      [PROJECT],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  async function job(): Promise<string> {
    const now = h.clock.now();
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                         created_at, updated_at, state_changed_at)
       VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', $3, $4, $4, $4) RETURNING id::text AS id`,
      [PROJECT, JSON.stringify({ runtime: 'codex', prompt: 'Copy the site files to out/' }), ownerId, now],
    );
    return rows[0]?.id ?? '';
  }

  async function end(jobId: string, outcome: 'succeeded' | 'failed'): Promise<void> {
    const attemptId = randomUUID();
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
       VALUES ($1, $2, 1, $3, 'ended', $4, $5, $5)`,
      [attemptId, jobId, WORKER, outcome, now],
    );
    await h.db.pool.query(
      `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at,
                             updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
      [attemptId, jobId, WORKER, outcome, JSON.stringify({ summary: 'All 27 files are in out/.' }), now],
    );
    await h.db.pool.query(
      `UPDATE jobs SET state = $3, current_attempt_id = $2, version = version + 1 WHERE id = $1`,
      [jobId, attemptId, outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED'],
    );
  }

  function followUps(sent: { text: string; watchId: string }[]): WatchFollowUps {
    return new WatchFollowUps({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      log: h.app.log,
      chat: () => ({
        idle: () => Promise.resolve(true),
        send: (_actor, _threadId, text, opts) => {
          sent.push({ text, watchId: opts.followUp.watchId });
          return Promise.resolve({ turnId: randomUUID() });
        },
      }),
    });
  }

  it('a succeeded job with a next step hands the conversation back with that step, once', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const thread = await store.createThread(ownerId, 'zip deploy');
    const subject = await loadSubject(h.db.pool, { id: ownerId, role: 'owner' });
    const jobId = await job();
    const consent = h.clock.now();
    const { watch } = await h.app.chatWatches.create(
      { userId: ownerId, subject, threadId: thread.id, turnId: null, nextStepConsentAt: consent },
      {
        target: 'job',
        id: jobId,
        language: 'tr',
        nextStep: "Dosyaları yeni depoya aktar,\n Coolify'da uygulamayı aç ve alan adını bağla",
      },
    );
    await end(jobId, 'succeeded');
    await h.app.chatWatches.tick();
    const w = await h.db.pool.query<{ state: string; end_reason: string; next_step: string }>(
      'SELECT state, end_reason, next_step FROM chat_watches WHERE id = $1',
      [watch.id],
    );
    expect(w.rows[0]).toMatchObject({
      state: 'done',
      end_reason: 'fired',
      next_step: "Dosyaları yeni depoya aktar, Coolify'da uygulamayı aç ve alan adını bağla",
    });
    const sent: { text: string; watchId: string }[] = [];
    const f = followUps(sent);
    await f.tick();
    await f.tick();
    const mine = sent.filter((x) => x.watchId === watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toMatch(/^Beklediğin şey bitti: .+ — başarıyla bitti\. /);
    expect(mine[0]?.text).toContain(
      '"Dosyaları yeni depoya aktar, Coolify\'da uygulamayı aç ve alan adını bağla"',
    );
    // The person's consent is kept with the watch, and holds for the grant's time only.
    expect((await nextStepConsent(h.db.pool, watch.id, ownerId, h.clock.now()))?.getTime()).toBe(
      consent.getTime(),
    );
    expect(
      await nextStepConsent(
        h.db.pool,
        watch.id,
        ownerId,
        new Date(consent.getTime() + GOAL_GRANT_TTL_MS + 1),
      ),
    ).toBeNull();
    expect(await nextStepConsent(h.db.pool, watch.id, randomUUID(), h.clock.now())).toBeNull();
  });

  it('a failed job with a next step is handed back too (the step is not done blindly)', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const thread = await store.createThread(ownerId, 'zip deploy 2');
    const subject = await loadSubject(h.db.pool, { id: ownerId, role: 'owner' });
    const jobId = await job();
    const { watch } = await h.app.chatWatches.create(
      { userId: ownerId, subject, threadId: thread.id, turnId: null, nextStepConsentAt: null },
      { target: 'job', id: jobId, language: 'en', nextStep: 'Push the files and deploy' },
    );
    await end(jobId, 'failed');
    await h.app.chatWatches.tick();
    const sent: { text: string; watchId: string }[] = [];
    await followUps(sent).tick();
    const mine = sent.filter((x) => x.watchId === watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toMatch(/^What you were waiting for has ended: .+ — it ended, state: failed\. /);
    expect(mine[0]?.text).toContain('If the result is not what you expected');
    // Created outside a person's turn: no consent (its drafts stay cards).
    expect(await nextStepConsent(h.db.pool, watch.id, ownerId, h.clock.now())).toBeNull();
  });

  it('a watch without a next step only tells — no turn (as before)', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const thread = await store.createThread(ownerId, 'tell me');
    const subject = await loadSubject(h.db.pool, { id: ownerId, role: 'owner' });
    const jobId = await job();
    const { watch } = await h.app.chatWatches.create(
      { userId: ownerId, subject, threadId: thread.id, turnId: null },
      { target: 'job', id: jobId, language: 'tr' },
    );
    await end(jobId, 'succeeded');
    await h.app.chatWatches.tick();
    const sent: { text: string; watchId: string }[] = [];
    await followUps(sent).tick();
    expect(sent.filter((x) => x.watchId === watch.id)).toEqual([]);
  });
});
