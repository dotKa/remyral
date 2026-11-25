import { randomUUID } from 'node:crypto';
import type { MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p14-ask-user (docs/design/p14-ask-user.md) against a real master (Postgres) and a raw worker: ASSIGN_JOB askUser
 * only for ask-user-v1 workers, QUESTION_REQUEST fenced by the live lease, idempotent ask, one open set per job, the
 * answer route (operator+ of the job's project; viewer and outsider refused; validation; identical answer idempotent,
 * different 409), the answer back to the worker, expiry, job end, "Senden bekleyenler", the notification without the
 * agent's text, audit; and the assistant's ask_user card (supersede, owner-only answer, 409 while the turn runs).
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const MIN = 60_000;
const h = new Harness();
let jobs: JobStore;
let owner: Client;
let operator: Client;
let operatorId = '';
let viewer: Client;
let outsider: Client;
let worker: RawWorker;
let workerId = '';

const QUESTIONS = [
  {
    id: 'env',
    prompt: 'Which environment? <img src=x onerror=alert(1)>',
    kind: 'single',
    options: [{ label: 'preview' }, { label: 'production' }],
    allowOther: true,
  },
  { id: 'note', prompt: 'Anything else?', kind: 'text' },
];

async function stepUp(c: Client, secret: string): Promise<void> {
  h.clock.advance(30_000);
  expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
}

async function runningJob(): Promise<{ id: string; attemptId: string; epoch: number }> {
  const { job } = await jobs.create({
    project: PROJECT,
    actor: { type: 'user', id: operatorId },
    submit: true,
    spec: {
      runtime: 'claude-code',
      prompt: 'Deploy the shop\nwith details',
      repository: { url: 'https://example.com/acme/shop.git', baseRef: 'main', workBranch: 'rac/ask' },
      sandboxProfile: 'host-restricted',
      sourceTrust: 'trusted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, workerId, 60 * MIN);
  const actor: JobActor = { type: 'worker', id: workerId };
  await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
  return { id: job.id, attemptId: grant.attempt.id, epoch: grant.lease.epoch };
}

async function ask(
  job: { id: string; attemptId: string; epoch: number },
  op: Record<string, unknown>,
  requestId = randomUUID(),
): Promise<Extract<MasterToWorker, { type: 'QUESTION_STATUS' }>['payload']> {
  worker.sendJson(
    worker.envelope(
      'QUESTION_REQUEST',
      { attemptId: job.attemptId, epoch: job.epoch, requestId, op },
      { workerId, jobId: job.id },
    ),
  );
  for (;;) {
    const m = await worker.next('QUESTION_STATUS', 10_000);
    if (m.payload.requestId === requestId) return m.payload;
  }
}

const askOp = (over: Record<string, unknown> = {}) => ({
  kind: 'ask',
  title: 'Deploy target',
  questions: QUESTIONS,
  timeoutSec: 1800,
  ...over,
});

describeIntegration('ask user (integration, p14-ask-user)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    const url = await h.listen();
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    await h.createUser('owner1', PW, 'owner');
    const ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [PROJECT]);
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
    operatorId = await h.createUser('oper1', PW, 'operator');
    await h.grant(operatorId, [PROJECT], 'operator');
    operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
    const vw = await h.createUser('view1', PW, 'viewer');
    await h.grant(vw, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
    const out = await h.createUser('oper2', PW, 'operator');
    await h.grant(out, ['other'], 'operator');
    outsider = await fullLogin(h, 'oper2', PW, (await enroll(h, 'oper2', PW)).secret);

    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'ASKU-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp(owner, ownerSecret);
    expect(
      (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'ASKU-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('ASSIGN_JOB askUser only for ask-user-v1 workers and agent jobs', async () => {
    const job = { id: randomUUID(), spec: {} };
    expect(await h.app.questions.assignment(job, workerId)).toBeUndefined();
    await h.db.pool.query(`UPDATE workers SET features = '["ask-user-v1"]'::jsonb WHERE id = $1`, [workerId]);
    expect(await h.app.questions.assignment(job, workerId)).toEqual({ maxTimeoutSec: 86_400 });
    expect(
      await h.app.questions.assignment({ id: job.id, spec: { kind: 'integration' } }, workerId),
    ).toBeUndefined();
  });

  it('a request without the live lease is refused and audited', async () => {
    const job = await runningJob();
    const s = await ask({ ...job, epoch: job.epoch + 7 }, askOp());
    expect(s).toMatchObject({ state: 'refused', reason: 'stale_lease' });
    const a = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'job.question.request' AND outcome = 'denied' AND target = $1`,
      [`job:${job.id}`],
    );
    expect(a.rowCount).toBe(1);
  });

  it('job question lifecycle: ask (idempotent), pending inbox, notification, answer, duplicate, refusals', async () => {
    const job = await runningJob();
    const requestId = randomUUID();
    const first = await ask(job, askOp(), requestId);
    expect(first.state).toBe('pending');
    const qid = first.questionId ?? '';
    // A retried ask (same request id) returns the same set; another open one is refused.
    expect((await ask(job, askOp(), requestId)).questionId).toBe(qid);
    expect(await ask(job, askOp())).toMatchObject({ state: 'refused', reason: 'open_question' });
    // The deadline never outlives the attempt's run limit.
    expect(Date.parse(first.deadlineAt ?? '')).toBeLessThanOrEqual(h.clock.now().getTime() + 1800 * 1000);

    // Visible on the job page, in the operator's inbox, not in the outsider's.
    const list = await operator.req('GET', `/jobs/${job.id}/questions`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ questions: { id: string; state: string }[] }>().questions[0]).toMatchObject({
      id: qid,
      state: 'pending',
    });
    const inbox = (await operator.req('GET', '/questions/pending')).json<{
      items: { id: string }[];
      total: number;
    }>();
    expect(inbox.items.map((i) => i.id)).toContain(qid);
    const other = (await outsider.req('GET', '/questions/pending')).json<{ items: { id: string }[] }>();
    expect(other.items.map((i) => i.id)).not.toContain(qid);
    expect((await viewer.req('GET', '/questions/pending')).json<{ items: unknown[] }>().items).toEqual([]);

    // The creator is notified — without the agent's text.
    const notes = await h.db.pool.query<{ title: string; body: string; link: string }>(
      `SELECT title, body, link FROM notifications WHERE recipient_id = $1 AND kind = 'job.question'`,
      [operatorId],
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]?.link).toBe(`/jobs/${job.id}`);
    expect(JSON.stringify(notes.rows[0])).not.toContain('Which environment');
    expect(JSON.stringify(notes.rows[0])).not.toContain('onerror');

    // Who may answer: operators of the project only.
    const url = `/jobs/${job.id}/questions/${qid}/answer`;
    const answers = [
      { id: 'env', choices: ['preview'] },
      { id: 'note', text: 'ship it' },
    ];
    expect((await viewer.req('POST', url, { answers })).statusCode).toBe(403);
    expect((await outsider.req('POST', url, { answers })).statusCode).toBe(404);
    // Validation against the stored questions.
    const bad = await operator.req('POST', url, { answers: [{ id: 'env', choices: ['staging'] }] });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json<{ error: string; params?: Record<string, string> }>()).toMatchObject({
      error: 'invalid_answer',
    });
    const ok = await operator.req('POST', url, { answers });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      ok.json<{ question: { state: string; answeredBy: { username: string } } }>().question,
    ).toMatchObject({
      state: 'answered',
      answeredBy: { username: 'oper1' },
    });
    // The same answer again is idempotent; a different one is refused.
    expect((await operator.req('POST', url, { answers })).statusCode).toBe(200);
    const diff = await owner.req('POST', url, {
      answers: [
        { id: 'env', other: 'staging' },
        { id: 'note', text: 'x' },
      ],
    });
    expect(diff.statusCode).toBe(409);
    expect(diff.json<{ error: string }>().error).toBe('question_closed');

    // The worker's long poll gets the answer.
    const st = await ask(job, { kind: 'status', questionId: qid });
    expect(st).toMatchObject({ state: 'answered', answers, answeredBy: 'oper1' });
    // Another job's question is not readable through this lease.
    const other2 = await runningJob();
    expect(await ask(other2, { kind: 'status', questionId: qid })).toMatchObject({
      state: 'refused',
      reason: 'not_found',
    });

    // Audited: ask (metadata only) and answer (who, when, hash — not the text).
    const audit = await h.db.pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE target = $1 AND action LIKE 'job.question.%' AND outcome = 'success'
        ORDER BY action`,
      [`job:${job.id}`],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['job.question.answer', 'job.question.ask']);
    expect(JSON.stringify(audit.rows)).not.toContain('ship it');
    expect(JSON.stringify(audit.rows)).not.toContain('Which environment');
    expect(audit.rows[0]?.metadata).toMatchObject({ questionId: qid, answered: ['env', 'note'] });
  });

  it('timeout: an unanswered set expires and the agent gets "expired"; job end withdraws open sets', async () => {
    const job = await runningJob();
    const s = await ask(job, askOp({ timeoutSec: 60 }));
    const qid = s.questionId ?? '';
    h.clock.advance(61_000);
    expect(await ask(job, { kind: 'status', questionId: qid })).toMatchObject({
      state: 'expired',
      reason: 'deadline',
    });
    const late = await operator.req('POST', `/jobs/${job.id}/questions/${qid}/answer`, {
      answers: [
        { id: 'env', choices: ['preview'] },
        { id: 'note', text: 'late' },
      ],
    });
    expect(late.statusCode).toBe(409);

    const job2 = await runningJob();
    const s2 = await ask(job2, askOp());
    await h.db.pool.query("UPDATE jobs SET state = 'CANCELLED', version = version + 1 WHERE id = $1", [
      job2.id,
    ]);
    expect(await h.app.questions.tick()).toBeGreaterThanOrEqual(1);
    const row = await h.db.pool.query<{ state: string; close_reason: string }>(
      'SELECT state, close_reason FROM user_questions WHERE id = $1',
      [s2.questionId],
    );
    expect(row.rows[0]).toEqual({ state: 'cancelled', close_reason: 'job_ended' });
    // The worker can withdraw its own open question (the tool call was aborted).
    const job3 = await runningJob();
    const s3 = await ask(job3, askOp());
    expect(await ask(job3, { kind: 'cancel', questionId: s3.questionId })).toMatchObject({
      state: 'cancelled',
      reason: 'withdrawn',
    });
  });

  it('assistant ask_user: card in the own conversation, supersede, owner-only answer, 409 while the turn runs', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      questions: () => h.app.questions,
    } as unknown as ChatToolsDeps);
    const thread = await store.createThread(operatorId, 'ask test');
    const c = {
      userId: operatorId,
      subject: await loadSubject(h.db.pool, { id: operatorId, role: 'operator' }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
    const first = await tools.run(c, 'ask_user', {
      questions: [{ prompt: 'A or B?', kind: 'single', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const out = await tools.run(c, 'ask_user', {
      title: 'Pick',
      questions: [
        { prompt: 'Which?', kind: 'multi', options: [{ label: 'x' }, { label: 'y' }], allowOther: true },
      ],
    });
    if (!out.ok || out.question === undefined) throw new Error('no question');
    expect(out.data).toMatchObject({ questionId: out.question.id });
    expect((out.data as { next: string }).next).toContain('End your turn');
    const qs = await h.app.questions.forThread(thread.id);
    expect(qs.map((q) => [q.state, q.closeReason])).toEqual([
      ['cancelled', 'superseded'],
      ['pending', null],
    ]);
    // The thread view lists the cards; another user cannot answer (404).
    const detail = await operator.req('GET', `/chat/threads/${thread.id}`);
    expect(detail.json<{ questions: { id: string }[] }>().questions.map((q) => q.id)).toContain(
      out.question.id,
    );
    const url = `/chat/threads/${thread.id}/questions/${out.question.id}/answer`;
    const answers = [{ id: 'q1', choices: ['x'], other: 'z' }];
    expect((await owner.req('POST', url, { answers })).statusCode).toBe(404);
    // While a turn runs in this conversation: 409, the card stays pending.
    await store.createTurn({
      id: randomUUID(),
      threadId: thread.id,
      userId: operatorId,
      workerId,
      runtime: 'claude-code',
      model: undefined,
    });
    const busy = await operator.req('POST', url, { answers });
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json<{ error: string }>().error).toBe('turn_in_progress');
    expect((await h.app.questions.forThread(thread.id)).at(-1)?.state).toBe('pending');
    // After the turn: the answer is stored even when the assistant cannot take the next turn here (no chat
    // worker configured: 409); a retry with the same answer tries to send again instead of refusing.
    h.clock.advance(10 * MIN);
    const sent = await operator.req('POST', url, { answers });
    expect([200, 409]).toContain(sent.statusCode);
    expect((await h.app.questions.forThread(thread.id)).at(-1)).toMatchObject({
      state: 'answered',
      answers: [{ id: 'q1', choices: ['x'], other: 'z' }],
    });
    const again = await operator.req('POST', url, { answers });
    expect(again.statusCode).toBe(sent.statusCode);
    // A normal message would close an open card (supersede): exercised through the service.
    await tools.run(c, 'ask_user', { questions: [{ prompt: 'Name?', kind: 'text' }] });
    expect(await h.app.questions.supersedeThread(thread.id)).toBe(1);
  });
});
