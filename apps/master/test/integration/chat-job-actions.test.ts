import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p10-chat-job-actions (docs/design/p10-chat-job-actions.md): the assistant finds jobs and drafts management actions;
 * nothing runs until the user confirms; the confirmation re-checks every job for the confirming user and calls the
 * Jobs UI's own services; per-job results, stale state as a clear line, audit source "chat".
 */

const PW = 'quartz-meadow-lantern-7';
const OTHER = 'chat-job-actions-other';

interface Result {
  action: string;
  done: number;
  skipped: number;
  refused: number;
  failed: number;
  jobId?: string;
  results: { jobId: string; outcome: string; message: string; state?: string; newJobId?: string }[];
}

describeIntegration('ops chat job actions (integration)', { timeout: 180_000 }, () => {
  const h = new Harness();
  const users: Record<'owner' | 'op' | 'admin' | 'viewer', { id: string; secret: string; client: Client }> =
    {} as never;
  let tools: ChatTools;
  let store: ChatStore;
  let jobs: JobStore;

  beforeAll(async () => {
    await h.start();
    for (const [key, role] of [
      ['owner', 'owner'],
      ['op', 'operator'],
      ['admin', 'admin'],
      ['viewer', 'viewer'],
    ] as const) {
      const name = `${key}.jobs`;
      const id = await h.createUser(name, PW, role);
      if (role === 'operator' || role === 'viewer') await h.grant(id, [PROJECT], role);
      const { secret } = await enroll(h, name, PW);
      users[key] = { id, secret, client: await fullLogin(h, name, PW, secret) };
    }
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()), ($2, $2, now()) ON CONFLICT DO NOTHING',
      [PROJECT, OTHER],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    tools = new ChatTools({ db: h.db.pool, store, clock: h.clock.now } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
  });

  async function caller(key: keyof typeof users, role: Role, userText?: string): Promise<ToolCaller> {
    const userId = users[key].id;
    const thread = await store.createThread(userId, 'jobs');
    let turnId = randomUUID();
    if (userText !== undefined) {
      await store.addMessage(thread.id, { role: 'user', content: userText });
      h.clock.advance(1_000);
      turnId = randomUUID();
      await store.createTurn({
        id: turnId,
        threadId: thread.id,
        userId,
        workerId: 'w-test',
        runtime: 'claude-code',
        model: undefined,
      });
    }
    return {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role }),
      threadId: thread.id,
      turnId,
    };
  }

  async function queued(prompt: string, priority = 0, project = PROJECT): Promise<string> {
    const { job } = await jobs.create({
      project,
      spec: jobSpec({ prompt, projectId: project }),
      priority,
      actor: { type: 'user', id: users.op.id },
      submit: true,
    });
    return job.id;
  }

  async function confirm(key: keyof typeof users, draftId: string, body?: unknown) {
    const u = users[key];
    h.clock.advance(30_000);
    const s = await u.client.req('POST', '/auth/step-up', { code: h.code(u.secret) });
    expect(s.statusCode, s.body).toBe(200);
    return u.client.req('POST', `/chat/drafts/${draftId}/confirm`, body);
  }

  const stateOf = async (id: string) =>
    (await h.db.pool.query<{ s: string }>('SELECT state::text AS s FROM jobs WHERE id = $1', [id])).rows[0]
      ?.s;

  it('find_jobs resolves by id prefix, words, state group and class, and lists the allowed actions per role', async () => {
    const a = await queued('Refactor the payment module\nmore');
    const b = await queued('Nightly crawl of the docs site', -50);
    const hidden = await queued('Secret other project job', 0, OTHER);
    const op = await caller('op', 'operator');
    const byPrefix = await tools.run(op, 'find_jobs', { idPrefix: a.slice(0, 6) });
    expect(byPrefix.ok, JSON.stringify(byPrefix)).toBe(true);
    const rows = (byPrefix as { data: { jobs: { id: string; title: string; actions: string[] }[] } }).data
      .jobs;
    expect(rows.map((r) => r.id)).toEqual([a]);
    expect(rows[0]?.title).toBe('Refactor the payment module');
    expect(rows[0]?.actions).toEqual(expect.arrayContaining(['cancel', 'set_class', 'move']));
    expect(rows[0]?.actions).not.toContain('run_now'); // admin only
    const byWords = await tools.run(op, 'find_jobs', { text: 'nightly crawl', stateGroup: 'queued' });
    expect(JSON.stringify(byWords)).toContain(b);
    const background = await tools.run(op, 'find_jobs', {
      stateGroup: 'queued',
      priorityClass: 'background',
    });
    const ids = (background as { data: { jobs: { id: string }[] } }).data.jobs.map((j) => j.id);
    expect(ids).toContain(b);
    expect(ids).not.toContain(a);
    // Another project's job is invisible to the operator (no membership), visible to the owner.
    expect(JSON.stringify(await tools.run(op, 'find_jobs', { idPrefix: hidden.slice(0, 8) }))).not.toContain(
      hidden,
    );
    const viewer = await caller('viewer', 'viewer');
    const v = await tools.run(viewer, 'find_jobs', { idPrefix: a.slice(0, 8) });
    expect((v as { data: { jobs: { actions: string[] }[] } }).data.jobs[0]?.actions).toEqual([]);
    const admin = await caller('admin', 'admin');
    const ad = await tools.run(admin, 'find_jobs', { idPrefix: a.slice(0, 8) });
    expect((ad as { data: { jobs: { actions: string[] }[] } }).data.jobs[0]?.actions).toContain('run_now');
    // Strict input: unknown fields are refused.
    expect(await tools.run(op, 'find_jobs', { sql: 'DROP TABLE jobs' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('cancels several jobs: nothing runs before the confirm, unchecked jobs stay, per-job results and audit source chat', async () => {
    const j1 = await queued('Background job one', -50);
    const j2 = await queued('Background job two', -50);
    const j3 = await queued('Background job three', -50);
    const done = await queued('Already finished job', -50);
    await jobs.transition(done, 'cancel_requested', {
      actor: { type: 'user', id: users.op.id },
      reason: 'x',
    });
    const c = await caller('op', 'operator');
    const out = await tools.run(c, 'draft_job_action', {
      action: 'cancel',
      jobIds: [j1, j2, j3, done],
      reason: 'not needed any more',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    expect(out.draft.kind).toBe('job_action');
    expect(out.draft.title).toBe('Cancel: 3 jobs');
    expect(out.data).toMatchObject({ leftOff: [{ id: done, state: 'CANCELLED' }] });
    expect((out.data as { status: string }).status).toContain('NOT executed');
    expect(await stateOf(j1)).toBe('QUEUED');
    // A job not on the card cannot be smuggled in.
    const smuggle = await confirm('op', out.draft.id, { jobIds: [j1, done] });
    expect(smuggle.statusCode).toBe(400);
    const res = await confirm('op', out.draft.id, { jobIds: [j1, j2] });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<{ result: Result }>().result;
    expect(r).toMatchObject({ action: 'cancel', done: 2, skipped: 1, refused: 0, failed: 0 });
    expect(r.results.find((x) => x.jobId === j3)).toMatchObject({
      outcome: 'skipped',
      message: 'unchecked on the card',
    });
    expect(await stateOf(j1)).toBe('CANCELLED');
    expect(await stateOf(j2)).toBe('CANCELLED');
    expect(await stateOf(j3)).toBe('QUEUED');
    const audit = await h.db.pool.query<{ target: string; outcome: string; m: Record<string, unknown> }>(
      `SELECT target, outcome, metadata AS m FROM audit_events WHERE action = 'chat.job_action' ORDER BY id`,
    );
    const mine = audit.rows.filter((a) => a.target === `job:${j1}` || a.target === `job:${j2}`);
    expect(mine).toHaveLength(2);
    expect(mine[0]?.m).toMatchObject({
      source: 'chat',
      action: 'cancel',
      result: 'done',
      draftId: out.draft.id,
    });
    const confirmAudit = await h.db.pool.query<{ m: Record<string, unknown> }>(
      `SELECT metadata AS m FROM audit_events WHERE action = 'chat.draft.confirm' AND target = $1`,
      [`chat-draft:${out.draft.id}`],
    );
    expect(confirmAudit.rows[0]?.m).toMatchObject({ kind: 'job_action', jobIdsOverride: [j1, j2] });
    // Confirmed once.
    expect((await confirm('op', out.draft.id)).statusCode).toBe(409);
  });

  it('a job that finished between draft and confirm is reported, not an error', async () => {
    const j = await queued('Will be cancelled elsewhere');
    const c = await caller('op', 'operator');
    const out = await tools.run(c, 'draft_job_action', { action: 'cancel', jobIds: [j] });
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    await users.op.client.req('POST', `/jobs/${j}/cancel`, { reason: 'from the jobs page' });
    const res = await confirm('op', out.draft.id);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<{ result: Result }>().result;
    expect(r.results[0]).toMatchObject({
      jobId: j,
      outcome: 'skipped',
      message: 'already CANCELLED — nothing to cancel',
    });
  });

  it('re-checks permission at confirm time for the confirming user (403 when nothing may run, draft stays open)', async () => {
    const j = await queued('Permission changes before confirm');
    const c = await caller('op', 'operator');
    const out = await tools.run(c, 'draft_job_action', { action: 'cancel', jobIds: [j] });
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    await h.grant(users.op.id, [PROJECT], 'viewer');
    try {
      const res = await confirm('op', out.draft.id);
      expect(res.statusCode, res.body).toBe(403);
      expect(await stateOf(j)).toBe('QUEUED');
      const d = await h.db.pool.query<{ state: string }>('SELECT state FROM chat_drafts WHERE id = $1', [
        out.draft.id,
      ]);
      expect(d.rows[0]?.state).toBe('proposed');
    } finally {
      await h.grant(users.op.id, [PROJECT], 'operator');
    }
    // Viewers cannot even draft it.
    const viewer = await caller('viewer', 'viewer');
    const v = await tools.run(viewer, 'draft_job_action', { action: 'cancel', jobIds: [j] });
    expect(v).toMatchObject({ ok: false, code: 'invalid' });
    expect(JSON.stringify(v)).toContain('operator role needed');
  });

  it('run now: admin only, only when the user asked for it, and with step-up', async () => {
    const j = await queued('Run me first');
    const op = await caller('op', 'operator', 'bunu hemen çalıştır');
    expect(
      JSON.stringify(await tools.run(op, 'draft_job_action', { action: 'run_now', jobIds: [j] })),
    ).toContain('administrator');
    const quiet = await caller('admin', 'admin', 'bu işin durumu ne?');
    expect(await tools.run(quiet, 'draft_job_action', { action: 'run_now', jobIds: [j] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const asked = await caller('admin', 'admin', 'şu işi öne al, şimdi çalıştır');
    const out = await tools.run(asked, 'draft_job_action', { action: 'run_now', jobIds: [j] });
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    // Without a fresh step-up the confirmation is refused before anything runs.
    h.clock.advance(11 * 60_000);
    expect((await users.admin.client.req('POST', `/chat/drafts/${out.draft.id}/confirm`)).statusCode).toBe(
      403,
    );
    const res = await confirm('admin', out.draft.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ result: Result }>().result).toMatchObject({ done: 1 });
    const q = await h.db.pool.query<{ priority: number; reason: string }>(
      'SELECT priority, reason FROM job_queue_priority WHERE job_id = $1',
      [j],
    );
    expect(q.rows[0]).toMatchObject({ reason: 'run_now' });
    expect(q.rows[0]?.priority).toBeGreaterThanOrEqual(50);
  });

  it('set_class moves a queued job to Arka plan (never to Acil) and move places it before another job', async () => {
    const a = await queued('Class change job');
    const b = await queued('Anchor job');
    const c = await caller('op', 'operator');
    expect(
      await tools.run(c, 'draft_job_action', { action: 'set_class', jobIds: [a], priorityClass: 'urgent' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    const out = await tools.run(c, 'draft_job_action', {
      action: 'set_class',
      jobIds: [a],
      priorityClass: 'background',
    });
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    const res = await confirm('op', out.draft.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ result: Result }>().result.results[0]).toMatchObject({
      outcome: 'done',
      message: 'Normal → Arka plan',
    });
    const q = await h.db.pool.query<{ priority: number }>(
      'SELECT priority FROM job_queue_priority WHERE job_id = $1',
      [a],
    );
    expect(q.rows[0]?.priority).toBe(-50);
    const reclass = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'job.queue.reclass' AND target = $1`,
      [`job:${a}`],
    );
    expect(reclass.rowCount).toBe(1);
    const mv = await tools.run(c, 'draft_job_action', { action: 'move', jobIds: [b], before: a });
    if (!mv.ok || mv.draft === undefined) throw new Error(JSON.stringify(mv));
    const moved = await confirm('op', mv.draft.id);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<{ result: Result }>().result.done).toBe(1);
    // The same service behind the REST route: operator+, Normal / Arka plan only; viewers are refused.
    const urgent = await users.op.client.req('POST', `/jobs/${a}/queue/class`, { priorityClass: 'urgent' });
    expect(urgent.statusCode).toBe(400);
    const back = await users.op.client.req('POST', `/jobs/${a}/queue/class`, { priorityClass: 'normal' });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ priorityClass: 'normal', from: 'background' });
    const viewer = await users.viewer.client.req('POST', `/jobs/${a}/queue/class`, {
      priorityClass: 'background',
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('run again: a new job with the same settings and a new work branch; urgent only from the user', async () => {
    const src = await queued('Write the release notes');
    await jobs.transition(src, 'cancel_requested', { actor: { type: 'user', id: users.op.id }, reason: 'x' });
    const c = await caller('op', 'operator', 'bunu tekrar çalıştır ama kısa yaz');
    const out = await tools.run(c, 'draft_job_action', {
      action: 'run_again',
      jobIds: [src],
      prompt: 'Write short release notes',
      priorityClass: 'urgent',
    });
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    expect(out.data).toMatchObject({ priorityNote: expect.stringContaining('not applied') as unknown });
    expect(out.draft.payload).toMatchObject({ priorityClass: 'normal', prompt: 'Write short release notes' });
    const res = await confirm('op', out.draft.id);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<{ result: Result }>().result;
    const newId = r.results[0]?.newJobId ?? '';
    expect(r.jobId).toBe(newId);
    const row = await h.db.pool.query<{
      spec: Record<string, unknown>;
      priority: number;
      created_by_id: string;
    }>('SELECT spec, priority, created_by_id FROM jobs WHERE id = $1', [newId]);
    const spec = row.rows[0]?.spec as { prompt: string; repository: { workBranch: string }; runtime: string };
    expect(spec.prompt).toBe('Write short release notes');
    expect(spec.runtime).toBe('codex');
    expect(spec.repository.workBranch).toMatch(/^agent\/chat-rerun-/);
    expect(row.rows[0]).toMatchObject({ priority: 0, created_by_id: users.op.id });
    // A queued job cannot "run again".
    const q = await queued('still queued');
    expect(await tools.run(c, 'draft_job_action', { action: 'run_again', jobIds: [q] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('quick buttons on a job card draft the same card; nothing runs until it is confirmed', async () => {
    const j = await queued('Started from a chat card');
    const thread = await store.createThread(users.op.id, 'quick');
    const res = await users.op.client.req('POST', `/chat/threads/${thread.id}/job-actions`, {
      action: 'cancel',
      jobIds: [j],
    });
    expect(res.statusCode, res.body).toBe(200);
    const draft = res.json<{ id: string; kind: string; state: string; payload: { origin: string } }>();
    expect(draft).toMatchObject({ kind: 'job_action', state: 'proposed', payload: { origin: 'button' } });
    expect(await stateOf(j)).toBe('QUEUED');
    const ok = await confirm('op', draft.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await stateOf(j)).toBe('CANCELLED');
    // Another user's conversation is not reachable.
    const foreign = await users.viewer.client.req('POST', `/chat/threads/${thread.id}/job-actions`, {
      action: 'cancel',
      jobIds: [j],
    });
    expect(foreign.statusCode).toBe(404);
    // A finished job: a clear refusal, no card.
    const again = await users.op.client.req('POST', `/chat/threads/${thread.id}/job-actions`, {
      action: 'cancel',
      jobIds: [j],
    });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('nothing to cancel');
  });
});
