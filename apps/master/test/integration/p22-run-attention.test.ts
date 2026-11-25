import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { WatchFollowUps } from '../../src/chat/watch-follow-up.js';
import { assessGoal } from '../../src/chat/goal-model.js';
import { resultMeta, workflowRunResult } from '../../src/chat/flow-model.js';
import { resultText } from '../../src/chat/flow.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p22-run-attention (docs/design/p22-run-attention.md): a run that ends `succeeded` while a step could not do its work
 * is told apart — structured upstream data reaches an agent step whole (up to the data budget) or marked as cut, the
 * step's `OUTCOME:` line and every cut input land in `workflow_runs.attention`, and the result card, its note and the
 * goal ledger read it.
 */

const PW = 'amber-harbor-signal-4';
const PROJECT = 'att-alpha';
const WORKER = 'wrk-att-1';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/att.git', baseRef: 'main' },
};

describeIntegration('p22-run-attention (integration)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerId: string;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
    ownerId = await h.createUser('owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, (await enroll(h, 'owner1', PW)).secret);
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING',
      [PROJECT],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  async function runOf(name: string, big: string): Promise<string> {
    const d = await owner.req('POST', '/workflows', {
      project: PROJECT,
      definition: {
        schemaVersion: 2,
        name,
        defaults: DEFAULTS,
        nodes: [
          { id: 'seed', type: 'data.set', config: { fields: { body: big } } },
          { id: 'yaz', type: 'ai.step', role: 'executor', prompt: 'write the results' },
        ],
        edges: [{ from: 'seed', to: 'yaz' }],
      },
    });
    expect(d.statusCode, d.body).toBe(201);
    const res = await owner.req('POST', `/workflows/${d.json<{ id: string }>().id}/runs`, { inputs: {} });
    expect(res.statusCode, res.body).toBe(201);
    const runId = res.json<{ runId: string }>().runId;
    for (let i = 0; i < 5; i++) await h.app.workflows.progress();
    return runId;
  }

  async function finishStep(runId: string, summary: string): Promise<void> {
    const { rows } = await h.db.pool.query<{ job_id: string }>(
      `SELECT l.job_id::text AS job_id FROM workflow_node_run_jobs l JOIN workflow_node_runs nr ON nr.id = l.node_run_id
        WHERE nr.run_id = $1 AND nr.node_id = 'yaz'`,
      [runId],
    );
    const jobId = rows[0]?.job_id;
    expect(jobId).toBeDefined();
    const attemptId = randomUUID();
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
       VALUES ($1, $2, 1, $3, 'ended', 'succeeded', $4, $4)`,
      [attemptId, jobId, WORKER, now],
    );
    await h.db.pool.query(
      `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at,
                             updated_at)
       VALUES ($1, $2, $3, 'succeeded', $4, $5, $5, $5)`,
      [attemptId, jobId, WORKER, JSON.stringify({ summary }), now],
    );
    await h.db.pool.query(
      `UPDATE jobs SET state = 'SUCCEEDED', current_attempt_id = $2, version = version + 1 WHERE id = $1`,
      [jobId, attemptId],
    );
    for (let i = 0; i < 5; i++) await h.app.workflows.progress();
  }

  async function snapshotOf(runId: string): Promise<{ value: string; clippedFrom?: number }[]> {
    const { rows } = await h.db.pool.query<{ snapshot: { value: string; clippedFrom?: number }[] }>(
      `SELECT input->'snapshot' AS snapshot FROM workflow_node_runs WHERE run_id = $1 AND node_id = 'yaz'`,
      [runId],
    );
    return rows[0]?.snapshot ?? [];
  }

  it('a watched run with attention ends its watch so, posts the warning note and hands the conversation back', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const thread = await store.createThread(ownerId, 'leads');
    const subject = await loadSubject(h.db.pool, { id: ownerId, role: 'owner' });
    const runId = await runOf('att-watch', 'short');
    await h.app.chatWatches.create(
      { userId: ownerId, subject, threadId: thread.id, turnId: null },
      { target: 'workflow_run', id: runId, language: 'tr' },
    );
    await finishStep(runId, 'Yazamadım.\nOUTCOME: partial — 2. parti işlenmedi');
    await h.app.chatWatches.tick();
    const w = await h.db.pool.query<{ id: string; state: string; end_reason: string }>(
      `SELECT id::text AS id, state, end_reason FROM chat_watches WHERE target_uuid = $1`,
      [runId],
    );
    expect(w.rows[0]).toMatchObject({ state: 'done', end_reason: 'attention' });
    const notes = await h.db.pool.query<{
      content: string;
      meta: { workflowResult?: { attention?: unknown[] } };
    }>(`SELECT content, meta FROM chat_messages WHERE thread_id = $1 AND meta->>'notice' = 'chat-watch'`, [
      thread.id,
    ]);
    expect(notes.rows.at(-1)?.content).toContain('**Workflow bitti ama dikkat istiyor:**');
    // Markdown-escaped agent text.
    expect(notes.rows.at(-1)?.content).toContain('yaz işin bir kısmını yapamadı \\(2. parti işlenmedi\\)');
    expect(notes.rows.at(-1)?.meta.workflowResult?.attention).toHaveLength(1);

    const sent: { text: string; watchId: string }[] = [];
    const followUps = new WatchFollowUps({
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
    await followUps.tick();
    await followUps.tick();
    const mine = sent.filter((x) => x.watchId === w.rows[0]?.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toMatch(
      /^Workflow başarılı bitti ama dikkat istiyor: .+ \(run [0-9a-f-]{36}\) — yaz işin/,
    );
  });

  it('a plain job: its OUTCOME line is on the job view, its watch note says so, and the assistant gets the turn', async () => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const thread = await store.createThread(ownerId, 'job');
    const subject = await loadSubject(h.db.pool, { id: ownerId, role: 'owner' });
    const now = h.clock.now();
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                         created_at, updated_at, state_changed_at)
       VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', $3, $4, $4, $4) RETURNING id::text AS id`,
      [PROJECT, JSON.stringify({ runtime: 'codex', prompt: 'Update the leads' }), ownerId, now],
    );
    const jobId = rows[0]?.id ?? '';
    await h.app.chatWatches.create(
      { userId: ownerId, subject, threadId: thread.id, turnId: null },
      { target: 'job', id: jobId, language: 'tr' },
    );
    const attemptId = randomUUID();
    await h.db.pool.query(
      `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
       VALUES ($1, $2, 1, $3, 'ended', 'succeeded', $4, $4)`,
      [attemptId, jobId, WORKER, now],
    );
    await h.db.pool.query(
      `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at,
                             updated_at)
       VALUES ($1, $2, $3, 'succeeded', $4, $5, $5, $5)`,
      [
        attemptId,
        jobId,
        WORKER,
        JSON.stringify({ summary: 'Yazamadım.\nOUTCOME: none — panel anahtarı yok' }),
        now,
      ],
    );
    await h.db.pool.query(
      `UPDATE jobs SET state = 'SUCCEEDED', current_attempt_id = $2, version = version + 1 WHERE id = $1`,
      [jobId, attemptId],
    );
    // The job view carries the field.
    const view = await owner.req('GET', `/jobs/${jobId}`);
    expect(view.statusCode, view.body).toBe(200);
    const runs = view.json<{ orchestration: { runs: { resultAttention: unknown }[] } }>().orchestration.runs;
    expect(runs.at(-1)?.resultAttention).toEqual({ kind: 'none', note: 'panel anahtarı yok' });

    await h.app.chatWatches.tick();
    const w = await h.db.pool.query<{ id: string; state: string; end_reason: string }>(
      `SELECT id::text AS id, state, end_reason FROM chat_watches WHERE target_uuid = $1`,
      [jobId],
    );
    expect(w.rows[0]).toMatchObject({ state: 'done', end_reason: 'attention' });
    const notes = await h.db.pool.query<{ content: string; meta: { jobAttention?: unknown } }>(
      `SELECT content, meta FROM chat_messages WHERE thread_id = $1 AND meta->>'notice' = 'chat-watch'`,
      [thread.id],
    );
    expect(notes.rows.at(-1)?.content).toContain('**İş bitti ama dikkat istiyor:**');
    expect(notes.rows.at(-1)?.content).toContain('ajan işi yapamadığını söyledi: panel anahtarı yok');
    expect(notes.rows.at(-1)?.meta.jobAttention).toEqual({ kind: 'none', note: 'panel anahtarı yok' });

    const sent: { text: string; watchId: string }[] = [];
    const followUps = new WatchFollowUps({
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
    await followUps.tick();
    const mine = sent.filter((x) => x.watchId === w.rows[0]?.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toMatch(
      /^İş bitti ama dikkat istiyor: .+ \(iş [0-9a-f-]{36}\) — ajan işi yapamadığını/,
    );
  });

  it('hands a 20 KB data value to the agent step whole, and a step that did its work leaves no attention', async () => {
    const big = 'lead-905000000000;'.repeat(1100); // ~20 KB: over the old 4 KB clip
    const runId = await runOf('att-whole', big);
    const snap = await snapshotOf(runId);
    expect(snap).toHaveLength(1);
    expect(snap[0]?.value.length).toBeGreaterThan(big.length);
    expect(snap[0]?.value).toContain(big);
    expect(snap[0]?.clippedFrom).toBeUndefined();

    await finishStep(runId, 'All 280 leads updated.');
    const r = await workflowRunResult(h.db.pool, runId);
    expect(r?.state).toBe('succeeded');
    expect(r?.attention).toEqual([]);
    const stored = await h.db.pool.query<{ attention: unknown }>(
      'SELECT attention FROM workflow_runs WHERE id = $1',
      [runId],
    );
    expect(stored.rows[0]?.attention).toBeNull();
    expect(resultMeta(r as never)).not.toHaveProperty('attention');
  });

  it('marks a value over the data budget as cut, and a declared OUTCOME makes the succeeded run need attention', async () => {
    const big = 'x9'.repeat(30 * 1024); // 60 KB: over the 48 KB data budget
    const runId = await runOf('att-cut', big);
    const snap = await snapshotOf(runId);
    expect(snap[0]?.clippedFrom).toBeGreaterThan(48 * 1024);
    expect(snap[0]?.value.length).toBe(48 * 1024);

    await finishStep(
      runId,
      'Nothing was written: the gateway answer was cut off.\n\nOUTCOME: none — the input body ended mid-result',
    );
    const r = await workflowRunResult(h.db.pool, runId);
    expect(r?.state).toBe('succeeded');
    expect(r?.attention).toEqual([
      { node: 'yaz', kind: 'none', note: 'the input body ended mid-result' },
      {
        node: 'yaz',
        kind: 'input_cut',
        note: expect.stringMatching(/^seed\.summary: 49152 \/ \d+ chars$/) as unknown,
      },
    ]);
    expect(resultMeta(r as never)).toMatchObject({ attention: r?.attention });
    expect(resultText(r as never, 'tr')).toContain('**Workflow bitti ama dikkat istiyor:**');
    expect(resultText(r as never, 'tr')).toContain('yaz hiçbir şey yapamadı');

    // Goal ledger: such a run does not close its goal; the assistant owns it, then gets its check turn.
    const ended = new Date('2026-11-04T10:00:00Z');
    const facts = {
      origin: 'workflow_run' as const,
      plan: null,
      chatAvailable: true,
      openedAt: ended,
      records: [
        {
          kind: 'workflow_run' as const,
          id: runId,
          createdAt: ended,
          phase: 'succeeded' as const,
          endedAt: ended,
          detail: 'needs attention',
          attention: true,
        },
      ],
    };
    expect(assessGoal(facts, new Date(ended.getTime() + 60_000))).toMatchObject({
      state: 'open',
      owner: 'assistant',
    });
    expect(assessGoal(facts, new Date(ended.getTime() + 3 * 60_000))).toMatchObject({
      state: 'intervention',
      blockedReason: 'no_progress',
    });
    expect(
      assessGoal(
        { ...facts, records: facts.records.map((r) => ({ ...r, attention: false })) },
        new Date(ended.getTime() + 60_000),
      ),
    ).toMatchObject({ state: 'done' });
  });
});
