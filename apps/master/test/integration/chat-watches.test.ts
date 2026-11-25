import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import type { Role } from '../../src/auth/users.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import type { Notifier, OutboundMessage } from '../../src/notifications/notifier.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-chat-notify (docs/design/p6-chat-notify.md) against a real master database: the assistant's notify_when /
 * list_watches / cancel_watch / notify_me tools for the signed-in user, the orchestrator tick step that fires
 * watches (thread note + chat.watch notification through the user's own enabled channels), expiry, cancel,
 * draft binding, re-checked authorization and that nothing ever reaches another user.
 */
const PW = 'quartz-meadow-lantern-7';
const WORKER = 'wrk_cccccccccccccccccccccccccc';

class MemoryEmail implements Notifier {
  readonly channel = 'email' as const;
  readonly sent: { message: OutboundMessage; target: string }[] = [];
  acceptsTarget(): boolean {
    return true;
  }
  send(message: OutboundMessage, target: string): Promise<void> {
    this.sent.push({ message, target });
    return Promise.resolve();
  }
}

const email = new MemoryEmail();
const h = new Harness();
let store: ChatStore;
let tools: ChatTools;
let ownerId = '';
let opId = '';
let outsiderId = '';
let op: Client;
let outsider: Client;
let opSecret = '';
let outsiderSecret = '';

async function caller(userId: string, role: Role, threadId?: string): Promise<ToolCaller> {
  const thread = threadId ?? (await store.createThread(userId, 'watch test')).id;
  return {
    userId,
    subject: await loadSubject(h.db.pool, { id: userId, role }),
    threadId: thread,
    turnId: randomUUID(),
  };
}

async function insertJob(project: string, prompt = 'Fix the flaky login test'): Promise<string> {
  const now = h.clock.now();
  const { rows } = await h.db.pool.query<{ id: string }>(
    `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                       created_at, updated_at, state_changed_at)
     VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', 'test', $3, $3, $3) RETURNING id::text AS id`,
    [project, JSON.stringify({ runtime: 'codex', prompt }), now],
  );
  return rows[0]?.id ?? '';
}

async function setJobState(jobId: string, state: string): Promise<void> {
  await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [jobId, state]);
}

const notes = async (userId: string, kind = 'chat.watch') =>
  (
    await h.db.pool.query<{ id: string; title: string; body: string; link: string | null }>(
      `SELECT id::text AS id, title, body, link FROM notifications WHERE recipient_id = $1 AND kind = $2
        ORDER BY created_at, id`,
      [userId, kind],
    )
  ).rows;

/** The user's notification about `link` (the fake clock gives equal timestamps, so look it up by link). */
const noteFor = async (userId: string, link: string) => (await notes(userId)).find((n) => n.link === link);

const watchNotes = async (threadId: string) =>
  (await store.messages(threadId)).filter((m) => m.meta?.notice === 'chat-watch');

const watchRow = async (id: string) =>
  (
    await h.db.pool.query<{
      state: string;
      end_reason: string | null;
      fire_count: number;
      target_kind: string;
    }>('SELECT state, end_reason, fire_count, target_kind FROM chat_watches WHERE id = $1', [id])
  ).rows[0];

function watchIdOf(out: Awaited<ReturnType<ChatTools['run']>>): string {
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error('watch refused');
  return (out.data as { watchId: string }).watchId;
}

describeIntegration('chat watches (integration, p6-chat-notify)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await h.start({ notifications: { notifiers: [email] } });
    ownerId = await h.createUser('owner1', PW);
    opId = await h.createUser('op1', PW, 'operator');
    ({ secret: opSecret } = await enroll(h, 'op1', PW));
    outsiderId = await h.createUser('op.other', PW, 'operator');
    ({ secret: outsiderSecret } = await enroll(h, 'op.other', PW));
    for (const p of ['alpha', 'beta']) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [p]);
    }
    await h.grant(opId, ['alpha'], 'operator');
    await h.grant(outsiderId, ['beta'], 'operator');
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      watches: () => h.app.chatWatches,
    } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('watches a job for the caller only; another user cannot watch what they cannot read', async () => {
    const jobId = await insertJob('alpha');
    const c = await caller(opId, 'operator');
    const out = await tools.run(c, 'notify_when', { target: 'job', id: jobId });
    const watchId = watchIdOf(out);
    expect(out.ok && out.data).toMatchObject({
      status: 'watching',
      on: ['finished'],
      repeat: 'once',
      currentState: 'RUNNING',
      channels: { inApp: 'sent', email: 'no_address' },
    });
    // p15-merge-approvals item 3: a short label — "Job <8> · <first words of the prompt>", at most ~40 title chars.
    const stored = await h.db.pool.query<{ label: string }>('SELECT label FROM chat_watches WHERE id = $1', [
      watchId,
    ]);
    expect(stored.rows[0]?.label).toMatch(new RegExp(`^(Job|İş) ${jobId.slice(0, 8)}( · .{1,40})?$`));
    // Asking again updates the same watch.
    const again = await tools.run(c, 'notify_when', { target: 'job', id: jobId, on: ['failed'] });
    expect(watchIdOf(again)).toBe(watchId);
    expect(again.ok && again.data).toMatchObject({ status: expect.stringContaining('updated') as unknown });
    await tools.run(c, 'notify_when', { target: 'job', id: jobId, on: ['finished'] });

    // The outsider (beta only) gets "not found", and the tool has no recipient field to abuse.
    const o = await caller(outsiderId, 'operator');
    expect(await tools.run(o, 'notify_when', { target: 'job', id: jobId })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await tools.run(o, 'notify_when', { target: 'job', id: jobId, recipient: opId })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    // Conditions come from the fixed enum and must fit the kind.
    expect(await tools.run(c, 'notify_when', { target: 'job', id: jobId, on: ['online'] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await tools.run(c, 'notify_when', { target: 'job', id: jobId, repeat: 'every' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });

    // Nothing while it runs; then it succeeds and the tick tells the op once (thread + bell).
    await h.app.chatWatches.tick();
    expect(await watchNotes(c.threadId)).toHaveLength(0);
    await h.db.pool.query(
      `INSERT INTO job_deploy_on_success (job_id, project, target, env, target_snapshot, covers, approved_by,
                                          approved_at, via, state, url, created_at, updated_at, expires_at)
       VALUES ($1, 'alpha', 'pages', 'preview', '{}', 'auto', $2, now(), 'api', 'succeeded',
               'https://abc.alpha-site.pages.dev', now(), now(), now() + interval '1 day')`,
      [jobId, opId],
    );
    await setJobState(jobId, 'SUCCEEDED');
    expect(await h.app.chatWatches.tick()).toBeGreaterThan(0);
    const posted = await watchNotes(c.threadId);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.role).toBe('assistant');
    expect(posted[0]?.content).toContain('succeeded');
    // Console links travel in the meta (rendered as in-app links), the live URL stays in the Markdown.
    expect(posted[0]?.meta?.links).toEqual([
      { label: 'Open', href: `/jobs/${jobId}` },
      { label: 'Outputs', href: `/outputs?job=${jobId}` },
    ]);
    expect(posted[0]?.content).not.toContain('](/');
    expect(posted[0]?.content).toContain('https://abc.alpha-site.pages.dev');
    // p15-chat-cards-scroll: the job's end carries the job id and outcome — the console draws the job result card.
    expect(posted[0]?.meta).toMatchObject({ jobId, jobOutcome: 'succeeded' });
    const bell = await notes(opId);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ link: `/jobs/${jobId}` });
    expect(bell[0]?.title).toContain('succeeded');
    expect(await watchRow(watchId)).toMatchObject({ state: 'done', end_reason: 'fired', fire_count: 1 });
    // Dedupe: more ticks change nothing; nobody else heard of it.
    await h.app.chatWatches.tick();
    await h.app.chatWatches.tick();
    expect(await watchNotes(c.threadId)).toHaveLength(1);
    expect(await notes(opId)).toHaveLength(1);
    expect(await notes(outsiderId)).toHaveLength(0);
    expect(await notes(ownerId)).toHaveLength(0);
  });

  it('concurrent ticks (two replicas) deliver once', async () => {
    const c = await caller(opId, 'operator');
    const jobId = await insertJob('alpha');
    const w = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: jobId }));
    await setJobState(jobId, 'SUCCEEDED');
    await Promise.all([h.app.chatWatches.tick(), h.app.chatWatches.tick(), h.app.chatWatches.tick()]);
    await h.app.chatWatches.tick();
    expect(await watchNotes(c.threadId)).toHaveLength(1);
    expect((await notes(opId)).filter((n) => n.link === `/jobs/${jobId}`)).toHaveLength(1);
    expect(await watchRow(w)).toMatchObject({ state: 'done', fire_count: 1 });
  });

  it('fires only on the asked condition, in the thread language (Turkish)', async () => {
    const c = await caller(opId, 'operator');
    await store.addMessage(c.threadId, { role: 'user', content: 'iş bitince başarısız olursa haber ver' });
    const ok = await insertJob('alpha', 'Build');
    const bad = await insertJob('alpha', 'Deploy');
    const w1 = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: ok, on: ['failed'] }));
    const w2 = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: bad, on: ['failed'] }));
    const before = (await notes(opId)).length;
    await setJobState(ok, 'SUCCEEDED');
    await setJobState(bad, 'FAILED');
    await h.app.chatWatches.tick();
    expect(await watchRow(w1)).toMatchObject({ state: 'done', fire_count: 0 });
    expect(await watchRow(w2)).toMatchObject({ state: 'done', end_reason: 'fired', fire_count: 1 });
    const posted = await watchNotes(c.threadId);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.content).toContain('başarısız oldu');
    expect(await notes(opId)).toHaveLength(before + 1);
    expect(await noteFor(opId, `/jobs/${bad}`)).toBeDefined();
    expect(await noteFor(opId, `/jobs/${ok}`)).toBeUndefined();
  });

  it('respects the notification settings: e-mail only when the user switched chat.watch e-mail on', async () => {
    const c = await caller(opId, 'operator');
    const jobId = await insertJob('alpha');
    await h.db.pool.query(
      "INSERT INTO notification_targets (user_id, email, updated_at) VALUES ($1, 'op@example.com', now())",
      [opId],
    );
    // Off for chat.watch, on for another kind: no e-mail.
    await h.db.pool.query(
      `INSERT INTO notification_preferences (user_id, kind, channel, enabled, updated_at)
       VALUES ($1, 'job.failed', 'email', true, now())`,
      [opId],
    );
    const w = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: jobId }));
    await setJobState(jobId, 'CANCELLED');
    await h.app.chatWatches.tick();
    const last = await noteFor(opId, `/jobs/${jobId}`);
    expect(last).toBeDefined();
    const d1 = await h.db.pool.query('SELECT 1 FROM notification_deliveries WHERE notification_id = $1', [
      last?.id,
    ]);
    expect(d1.rowCount).toBe(0);
    expect(await watchRow(w)).toMatchObject({ state: 'done' });

    await h.db.pool.query(
      `INSERT INTO notification_preferences (user_id, kind, channel, enabled, updated_at)
       VALUES ($1, 'chat.watch', 'email', true, now())`,
      [opId],
    );
    const job2 = await insertJob('alpha');
    const out = await tools.run(c, 'notify_when', { target: 'job', id: job2 });
    expect(out.ok && out.data).toMatchObject({ channels: { email: 'queued' } });
    await setJobState(job2, 'SUCCEEDED');
    await h.app.chatWatches.tick();
    const n2 = await noteFor(opId, `/jobs/${job2}`);
    const d2 = await h.db.pool.query<{ channel: string }>(
      'SELECT channel FROM notification_deliveries WHERE notification_id = $1',
      [n2?.id],
    );
    expect(d2.rows).toEqual([{ channel: 'email' }]);
    await h.app.notifications.runOnce();
    expect(email.sent.some((s) => s.target === 'op@example.com')).toBe(true);
    expect(email.sent.every((s) => s.target === 'op@example.com')).toBe(true);
  });

  it('expires after its window and says so in the thread', async () => {
    const c = await caller(opId, 'operator');
    const jobId = await insertJob('alpha');
    const w = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: jobId, expiresInHours: 1 }));
    h.clock.advance(2 * 3600_000);
    await h.app.chatWatches.tick();
    expect(await watchRow(w)).toMatchObject({ state: 'expired' });
    const posted = await watchNotes(c.threadId);
    expect(posted.at(-1)?.meta).toMatchObject({ event: 'expired' });
    await setJobState(jobId, 'SUCCEEDED');
    const before = (await notes(opId)).length;
    await h.app.chatWatches.tick();
    expect(await notes(opId)).toHaveLength(before);
  });

  it('lists and cancels (tool and REST); another user cannot see or cancel it', async () => {
    op = await fullLogin(h, 'op1', PW, opSecret);
    outsider = await fullLogin(h, 'op.other', PW, outsiderSecret);
    const c = await caller(opId, 'operator');
    const jobA = await insertJob('alpha');
    const jobB = await insertJob('alpha');
    const wa = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: jobA }));
    const wb = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: jobB }));
    const listed = await tools.run(c, 'list_watches', {});
    expect(listed.ok && (listed.data as { watches: unknown[] }).watches).toHaveLength(2);

    const detail = await op.req('GET', `/chat/threads/${c.threadId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(
      detail
        .json<{ watches: { id: string }[] }>()
        .watches.map((w) => w.id)
        .sort(),
    ).toEqual([wa, wb].sort());
    // p20-quick: the caller's list (the home's / "Senden bekleyenler"'s "Bekleniyor" rows) names each conversation.
    const mine = (await op.req('GET', '/chat/watches')).json<{
      items: { id: string; threadId: string | null; threadTitle?: string | null }[];
    }>().items;
    const ownTitle = (await op.req('GET', `/chat/threads/${c.threadId}`)).json<{
      thread: { title: string };
    }>().thread.title;
    expect(mine.filter((w) => w.id === wa || w.id === wb).map((w) => w.threadTitle)).toEqual([
      ownTitle,
      ownTitle,
    ]);
    expect((await outsider.req('GET', `/chat/watches?threadId=${c.threadId}`)).statusCode).toBe(404);
    expect((await outsider.req('GET', '/chat/watches')).json<{ items: unknown[] }>().items).toHaveLength(0);
    expect((await outsider.req('DELETE', `/chat/watches/${wa}`)).statusCode).toBe(404);
    expect(await watchRow(wa)).toMatchObject({ state: 'active' });

    const del = await op.req('DELETE', `/chat/watches/${wa}`);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toMatchObject({ id: wa, state: 'cancelled' });
    expect((await op.req('DELETE', `/chat/watches/${wa}`)).statusCode).toBe(409);
    // Another user's watch id through the tool: not found.
    const o = await caller(outsiderId, 'operator');
    expect(await tools.run(o, 'cancel_watch', { watchId: wb })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    const all = await tools.run(c, 'cancel_watch', { all: true });
    expect(all.ok && (all.data as { cancelled: unknown[] }).cancelled).toHaveLength(1);
    await setJobState(jobA, 'SUCCEEDED');
    await setJobState(jobB, 'SUCCEEDED');
    const before = (await notes(opId)).length;
    await h.app.chatWatches.tick();
    expect(await notes(opId)).toHaveLength(before);
  });

  it('re-checks access when it fires: a lost membership revokes the watch silently', async () => {
    const c = await caller(opId, 'operator');
    const jobId = await insertJob('alpha', 'secret project work');
    const w = watchIdOf(await tools.run(c, 'notify_when', { target: 'job', id: jobId }));
    await h.db.pool.query("DELETE FROM project_memberships WHERE user_id = $1 AND project_id = 'alpha'", [
      opId,
    ]);
    try {
      await setJobState(jobId, 'SUCCEEDED');
      const before = (await notes(opId)).length;
      await h.app.chatWatches.tick();
      expect(await watchRow(w)).toMatchObject({ state: 'revoked', end_reason: 'access_lost' });
      expect(await notes(opId)).toHaveLength(before);
      const posted = await watchNotes(c.threadId);
      expect(posted.at(-1)?.content).not.toContain('secret project');
    } finally {
      await h.grant(opId, ['alpha'], 'operator');
    }
  });

  it('tells each approval a job asks for, then the end', async () => {
    const c = await caller(opId, 'operator');
    const jobId = await insertJob('alpha');
    const w = watchIdOf(
      await tools.run(c, 'notify_when', { target: 'job', id: jobId, on: ['approval_requested', 'finished'] }),
    );
    const at = h.clock.now();
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO approval_requests (job_id, epoch, approval_key, kind, action, requested_action, risk, summary,
                                      requested_by_type, policy_version, approver_role, required_approvals,
                                      step_up, status, created_at, expires_at, details)
       VALUES ($1, 0, 'gate:t-watch', 'gate', 'git.merge', 'merge', 'high', 'Merge it',
               'system', 0, 'operator', 1, false, 'pending', $2, $3,
               '{"tool":"Bash","description":"Merge the *reviewed* branch","command":"git merge work"}')
       RETURNING id::text AS id`,
      [jobId, at, new Date(at.getTime() + 24 * 3_600_000)],
    );
    const approvalId = rows[0]?.id ?? '';
    await h.app.chatWatches.tick();
    await h.app.chatWatches.tick();
    let posted = await watchNotes(c.threadId);
    expect(posted).toHaveLength(1);
    // p10-approval-readable: the agent's own words, labelled unverified, Markdown-escaped.
    expect(posted[0]?.content).toMatch(/(unverified|doğrulanmadı)\): “Merge the \\\*reviewed\\\* branch”/);
    expect(posted[0]?.meta?.links).toEqual([
      { label: 'Open the approval', href: `/approvals/${approvalId}` },
    ]);
    expect(await watchRow(w)).toMatchObject({ state: 'active', fire_count: 1 });
    await setJobState(jobId, 'FAILED');
    await h.app.chatWatches.tick();
    posted = await watchNotes(c.threadId);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.content).toContain('failed');
    expect(await watchRow(w)).toMatchObject({ state: 'done', fire_count: 2 });
  });

  it('a watch on a draft card follows what confirming it creates', async () => {
    const c = await caller(opId, 'operator');
    const draft = await store.createDraft({
      threadId: c.threadId,
      userId: opId,
      turnId: c.turnId,
      kind: 'job',
      title: 'Landing page',
      payload: { project: 'alpha' },
      project: 'alpha',
    });
    const w = watchIdOf(await tools.run(c, 'notify_when', { target: 'draft', id: draft.id }));
    // Another user's draft id is not found.
    const o = await caller(outsiderId, 'operator');
    expect(await tools.run(o, 'notify_when', { target: 'draft', id: draft.id })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    await h.app.chatWatches.tick();
    expect(await watchRow(w)).toMatchObject({ state: 'active', target_kind: 'draft' });
    const jobId = await insertJob('alpha', 'Landing page');
    await store.decideDraft(draft.id, 'confirmed', { jobId });
    await h.app.chatWatches.tick();
    expect(await watchRow(w)).toMatchObject({ state: 'active', target_kind: 'job' });
    await setJobState(jobId, 'SUCCEEDED');
    await h.app.chatWatches.tick();
    expect(await watchRow(w)).toMatchObject({ state: 'done', fire_count: 1 });
    expect(await noteFor(opId, `/jobs/${jobId}`)).toBeDefined();

    // A dismissed card ends its watch.
    const d2 = await store.createDraft({
      threadId: c.threadId,
      userId: opId,
      turnId: c.turnId,
      kind: 'job',
      title: 'Other',
      payload: { project: 'alpha' },
      project: 'alpha',
    });
    const w2 = watchIdOf(await tools.run(c, 'notify_when', { target: 'draft', id: d2.id }));
    await store.decideDraft(d2.id, 'dismissed', null);
    await h.app.chatWatches.tick();
    expect(await watchRow(w2)).toMatchObject({ state: 'done', end_reason: 'draft_dismissed' });
  });

  it('machines: every change, by name', async () => {
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
       VALUES ($1, 'mac-mini', 'online', '{}'::jsonb, '1.0.0', $2, $2, $2)`,
      [WORKER, now],
    );
    const c = await caller(opId, 'operator');
    const w = watchIdOf(
      await tools.run(c, 'notify_when', {
        target: 'worker',
        id: 'mac-mini',
        on: ['online', 'offline'],
        repeat: 'every',
      }),
    );
    await h.app.chatWatches.tick();
    expect(await watchNotes(c.threadId)).toHaveLength(0);
    await h.db.pool.query("UPDATE workers SET state = 'offline' WHERE id = $1", [WORKER]);
    await h.app.chatWatches.tick();
    await h.db.pool.query("UPDATE workers SET state = 'online' WHERE id = $1", [WORKER]);
    await h.app.chatWatches.tick();
    await h.app.chatWatches.tick();
    const posted = await watchNotes(c.threadId);
    expect(posted.map((m) => m.content.includes('offline'))).toEqual([true, false]);
    expect(posted[1]?.content).toContain('online');
    expect(await watchRow(w)).toMatchObject({ state: 'active', fire_count: 2 });
  });

  it('automations: every run with repeat "every"', async () => {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO automations (project, name, state, trigger_kind, trigger, cron, next_run_at, target_kind,
                                job_spec, run_as, created_by, created_at, updated_at)
       VALUES ('alpha', 'nightly', 'active', 'cron', '{"kind":"cron","cron":"0 3 * * *"}', '0 3 * * *',
               now() + interval '300 days', 'job', '{"runtime":"codex","prompt":"x"}', $1, $1, now(), now())
       RETURNING id::text AS id`,
      [ownerId],
    );
    const automationId = rows[0]?.id ?? '';
    const c = await caller(opId, 'operator');
    const w = watchIdOf(
      await tools.run(c, 'notify_when', { target: 'automation', id: automationId, repeat: 'every' }),
    );
    const run = async (state: string, key: string): Promise<void> => {
      await h.db.pool.query(
        `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, state, created_at, finished_at)
         VALUES ($1, 'alpha', 'manual', $2, $3, $4, $4)`,
        [automationId, key, state, h.clock.now()],
      );
    };
    h.clock.advance(1_000);
    await run('succeeded', 'r1');
    await run('skipped', 'r2');
    await h.app.chatWatches.tick();
    h.clock.advance(1_000);
    await run('failed', 'r3');
    await h.app.chatWatches.tick();
    await h.app.chatWatches.tick();
    const posted = await watchNotes(c.threadId);
    expect(posted).toHaveLength(2);
    expect(posted[0]?.content).toContain('succeeded');
    expect(posted[1]?.content).toContain('failed');
    expect(await watchRow(w)).toMatchObject({ state: 'active', fire_count: 2 });
  });

  describe('notify_me', () => {
    it('sends the caller a note now, to the caller only, and is rate-limited', async () => {
      const c = await caller(outsiderId, 'operator');
      const out = await tools.run(c, 'notify_me', { title: 'Summary', message: 'The deploy is live.' });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.ok && out.data).toMatchObject({ channels: { inApp: 'sent', email: 'no_address' } });
      const mine = await notes(outsiderId, 'chat.note');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ title: 'Summary', link: `/chat/${c.threadId}` });
      expect(await notes(opId, 'chat.note')).toHaveLength(0);
      // There is no field for anyone else.
      expect(
        await tools.run(c, 'notify_me', { title: 'x', message: 'y', to: 'evil@example.com' }),
      ).toMatchObject({ ok: false, code: 'invalid' });
      for (let i = 1; i < 10; i++) {
        expect((await tools.run(c, 'notify_me', { title: `n${String(i)}`, message: 'm' })).ok).toBe(true);
      }
      expect(await tools.run(c, 'notify_me', { title: 'one too many', message: 'm' })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
      h.clock.advance(3_600_001);
      expect((await tools.run(c, 'notify_me', { title: 'later', message: 'm' })).ok).toBe(true);
    });
  });
});
