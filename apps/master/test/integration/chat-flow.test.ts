import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatStore } from '../../src/chat/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p17-chat-flow (docs/design/p17-chat-flow.md) against a real master database and engine 2: a workflow's approval
 * step reaches the conversation that started the run (card message, once), "Senden bekleyen" (ops-thread card) and
 * the deciders (notification); a decision through the run page's route resumes the run on its port, the card's view
 * shows it decided and a second decision is refused; a run started from a conversation ends with a result card
 * (succeeded and failed); a job agent's question is posted into the conversation that started the job and stays a
 * job question (answered through the job route).
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'flow-alpha';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/flow.git', baseRef: 'main' },
};
type Node = Record<string, unknown>;
const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({ id, type, config });

describeIntegration('chat flow (integration, p17-chat-flow)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerId = '';
  let secret = '';
  let viewer: Client;
  let store: ChatStore;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
    ownerId = await h.createUser('owner1', PW);
    secret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, secret);
    const vid = await h.createUser('viewer1', PW, 'viewer');
    await h.grant(vid, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    owner = await fullLogin(h, 'owner1', PW, secret);
  });

  const doc = (name: string, nodes: Node[], edges: Node[], extra: Node = {}) => ({
    schemaVersion: 2,
    name,
    defaults: DEFAULTS,
    nodes,
    edges,
    ...extra,
  });
  async function define(d: Record<string, unknown>): Promise<string> {
    const res = await owner.req('POST', '/workflows', { project: PROJECT, definition: d });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }
  async function start(id: string, inputs: Record<string, string> = {}): Promise<string> {
    const res = await owner.req('POST', `/workflows/${id}/runs`, { inputs });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ runId: string }>().runId;
  }
  const progress = async (times = 3) => {
    for (let i = 0; i < times; i++) await h.app.workflows.progress();
  };
  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    const res = await owner.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  }
  /** A conversation of the owner whose confirmed card produced `result` (as confirming a run / job card does). */
  async function cardThread(kind: string, result: Record<string, unknown>): Promise<string> {
    const thread = await store.createThread(ownerId, `flow ${kind}`);
    const at = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                result, created_at, expires_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, 'card', '{}', $6, $7, 'confirmed', $8, $9, $9, $9)`,
      [
        randomUUID(),
        thread.id,
        ownerId,
        randomUUID(),
        kind,
        'a'.repeat(64),
        PROJECT,
        JSON.stringify(result),
        at,
      ],
    );
    return thread.id;
  }
  const notices = async (threadId: string, notice: string) =>
    (await store.messages(threadId)).filter((m) => m.meta?.notice === notice);

  describe('workflow approvals and results', () => {
    it('an approval step reaches the conversation, Senden bekleyen and the deciders; the card decision resumes the run', async () => {
      const id = await define(
        doc(
          'ship',
          [
            n('ask', 'control.approval', {
              approverRole: 'admin',
              title: 'Ship {{ $inputs.what }}?',
              details: 'Release notes: <b>bold</b>',
            }),
            n('yes', 'data.set', { fields: { shipped: true } }),
            n('no', 'data.set', { fields: { shipped: false } }),
          ],
          [
            { from: 'ask', fromPort: 'approved', to: 'yes' },
            { from: 'ask', fromPort: 'denied', to: 'no' },
          ],
          { inputs: { what: { required: true } } },
        ),
      );
      const runId = await start(id, { what: 'v1' });
      const thread = await cardThread('workflow_run', { runId });
      await progress();
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();

      // One card message in the conversation (once, however often the tick runs).
      const cards = await notices(thread, 'workflow-approval');
      expect(cards).toHaveLength(1);
      expect(cards[0]?.meta).toMatchObject({ runId, node: 'ask', workflow: 'ship', project: PROJECT });
      expect(cards[0]?.content).toContain('ship');
      const nodeRunId = String(cards[0]?.meta?.nodeRunId);

      // The card's live view: title / details as text, the role, waiting, decidable by the owner.
      const view = await owner.req('GET', `/workflows/runs/${runId}/node-runs/${nodeRunId}/approval`);
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({
        state: 'waiting',
        title: 'Ship v1?',
        details: 'Release notes: <b>bold</b>',
        approverRole: 'admin',
        canDecide: true,
        workflow: 'ship',
      });
      // A viewer reads it but may not decide; nobody outside the project reads it.
      const seen = await viewer.req('GET', `/workflows/runs/${runId}/node-runs/${nodeRunId}/approval`);
      expect(seen.statusCode).toBe(200);
      expect(seen.json()).toMatchObject({ canDecide: false });

      // The deciders were notified (once); "Senden bekleyen" shows the card.
      const notes = await h.db.pool.query<{ link: string }>(
        "SELECT link FROM notifications WHERE recipient_id = $1 AND kind = 'workflow.approval'",
        [ownerId],
      );
      expect(notes.rows).toEqual([{ link: `/jobs/workflows/${runId}` }]);
      const thread1 = await owner.req('GET', '/ops-thread');
      expect(thread1.statusCode, thread1.body).toBe(200);
      const page = thread1.json<{
        items: { id: string; type: string; payload: Record<string, unknown> | null }[];
        open: { approvals: number };
      }>();
      const open = page.items.find((i) => i.id === `workflow:${nodeRunId}`);
      expect(open).toMatchObject({ type: 'workflow:approval', payload: { runId, state: 'waiting' } });
      expect(page.open.approvals).toBeGreaterThanOrEqual(1);
      // A viewer may not decide: not in their "Senden bekleyen".
      const vthread = await viewer.req('GET', '/ops-thread');
      expect(
        vthread.json<{ items: { id: string }[] }>().items.some((i) => i.id === `workflow:${nodeRunId}`),
      ).toBe(false);

      // The card decides through the run page's route (step-up): the run resumes on the approved port.
      await stepUp();
      const ok = await owner.req('POST', `/workflows/runs/${runId}/node-runs/${nodeRunId}/approve`, {
        reason: 'go',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      // One decision wins: the other surface's decision is refused.
      const late = await owner.req('POST', `/workflows/runs/${runId}/node-runs/${nodeRunId}/deny`, {
        reason: 'too late',
      });
      expect(late.statusCode).toBe(409);
      await progress();
      const run = await owner.req('GET', `/workflows/runs/${runId}`);
      const rv = run.json<{ run: { state: string }; nodes: { id: string; nodeRunState: string }[] }>();
      expect(rv.run.state).toBe('succeeded');
      expect(Object.fromEntries(rv.nodes.map((x) => [x.id, x.nodeRunState]))).toMatchObject({
        ask: 'succeeded',
        yes: 'succeeded',
        no: 'skipped',
      });
      const decided = await owner.req('GET', `/workflows/runs/${runId}/node-runs/${nodeRunId}/approval`);
      expect(decided.json()).toMatchObject({ state: 'approved', decidedBy: 'owner1', canDecide: false });
      const after = await owner.req('GET', '/ops-thread');
      expect(
        after.json<{ items: { id: string }[] }>().items.some((i) => i.id === `workflow:${nodeRunId}`),
      ).toBe(false);

      // The run ended: one result card in the conversation that started it.
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      const results = await notices(thread, 'workflow-result');
      expect(results).toHaveLength(1);
      expect(results[0]?.meta?.workflowResult).toMatchObject({
        runId,
        workflow: 'ship',
        state: 'succeeded',
        stepsDone: 2,
        stepsTotal: 2,
        summary: '{"shipped":true}',
      });
      expect(typeof (results[0]?.meta?.workflowResult as { durationMs?: unknown }).durationMs).toBe('number');
    });

    it('a denial resumes on the denied port; a failed run gets a failed result card', async () => {
      const id = await define(
        doc(
          'guarded',
          [
            n('ask', 'control.approval', { approverRole: 'operator', title: 'Go?' }),
            n('boom', 'control.fail', { reason: 'denied by a person' }),
          ],
          [{ from: 'ask', fromPort: 'denied', to: 'boom' }],
        ),
      );
      const runId = await start(id);
      const thread = await cardThread('workflow_run', { runId });
      await progress();
      await h.app.chatFlow.tick();
      const card = (await notices(thread, 'workflow-approval'))[0];
      const nodeRunId = String(card?.meta?.nodeRunId);
      await stepUp();
      const no = await owner.req('POST', `/workflows/runs/${runId}/node-runs/${nodeRunId}/deny`, {
        reason: 'not now',
      });
      expect(no.statusCode, no.body).toBe(200);
      await progress();
      const v = await owner.req('GET', `/workflows/runs/${runId}/node-runs/${nodeRunId}/approval`);
      expect(v.json()).toMatchObject({ state: 'denied' });
      await h.app.chatFlow.tick();
      const results = await notices(thread, 'workflow-result');
      expect(results).toHaveLength(1);
      expect(results[0]?.meta?.workflowResult).toMatchObject({ state: 'failed', workflow: 'guarded' });
      expect(results[0]?.content).toContain('guarded');
    });

    it('a conversation that only watches the run gets no second result card (the watch note carries it)', async () => {
      const id = await define(doc('quick', [n('one', 'data.set', { fields: { a: 1 } })], []));
      const runId = await start(id);
      const thread = await cardThread('workflow_run', { runId });
      await h.db.pool.query(
        `INSERT INTO chat_watches (id, user_id, thread_id, target_kind, target_uuid, project, label, conditions,
                                   repeat, language, state, cursor, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, 'workflow_run', $4, $5, 'quick', '{finished}', 'once', 'en', 'active', '{}', $6, $6,
                 $6::timestamptz + interval '1 day')`,
        [randomUUID(), ownerId, thread, runId, PROJECT, h.clock.now()],
      );
      await progress();
      await h.app.chatFlow.tick();
      expect(await notices(thread, 'workflow-result')).toHaveLength(0);
      await h.app.chatWatches.tick();
      const watchNote = (await notices(thread, 'chat-watch'))[0];
      expect(watchNote?.meta?.workflowResult).toMatchObject({
        runId,
        state: 'succeeded',
        stepsDone: 1,
        stepsTotal: 1,
      });
    });

    it('a cancelled watch of the run no longer swallows its result card (p20-outcome)', async () => {
      const id = await define(doc('quick-cancelled', [n('one', 'data.set', { fields: { a: 1 } })], []));
      const runId = await start(id);
      const thread = await cardThread('workflow_run', { runId });
      // The person stopped the watch before the run ended: its end note never comes.
      await h.db.pool.query(
        `INSERT INTO chat_watches (id, user_id, thread_id, target_kind, target_uuid, project, label, conditions,
                                   repeat, language, state, end_reason, ended_at, cursor, created_at, updated_at,
                                   expires_at)
         VALUES ($1, $2, $3, 'workflow_run', $4, $5, 'quick', '{finished}', 'once', 'en', 'cancelled', 'cancelled',
                 $6, '{}', $6, $6, $6::timestamptz + interval '1 day')`,
        [randomUUID(), ownerId, thread, runId, PROJECT, h.clock.now()],
      );
      await progress();
      await h.app.chatFlow.tick();
      await h.app.chatWatches.tick();
      expect(await notices(thread, 'chat-watch')).toHaveLength(0);
      const results = await notices(thread, 'workflow-result');
      expect(results).toHaveLength(1);
      expect(results[0]?.meta?.workflowResult).toMatchObject({ runId, state: 'succeeded' });
    });
  });

  // p20-quick: only a watch that will tell the result (or already did) holds the card back.
  describe('workflow results and watches that will not tell them (p20-quick)', () => {
    async function watchOn(thread: string, runId: string, state: string, conditions: string): Promise<void> {
      await h.db.pool.query(
        `INSERT INTO chat_watches (id, user_id, thread_id, target_kind, target_uuid, project, label, conditions,
                                   repeat, language, state, cursor, created_at, updated_at, expires_at, ended_at)
         VALUES ($1, $2, $3, 'workflow_run', $4, $5, 'quick', $6::text[], 'once', 'en', $7::text, '{}', $8, $8,
                 $8::timestamptz + interval '1 day', CASE WHEN $7::text = 'active' THEN NULL ELSE $8 END)`,
        [randomUUID(), ownerId, thread, runId, PROJECT, conditions, state, h.clock.now()],
      );
    }
    async function quickRun(name: string): Promise<{ runId: string; thread: string }> {
      const id = await define(doc(name, [n('one', 'data.set', { fields: { a: 1 } })], []));
      const runId = await start(id);
      return { runId, thread: await cardThread('workflow_run', { runId }) };
    }

    it('a cancelled watch no longer swallows the result card', async () => {
      const { runId, thread } = await quickRun('quick-cancelled');
      await watchOn(thread, runId, 'cancelled', '{finished}');
      await progress();
      await h.app.chatFlow.tick();
      const results = await notices(thread, 'workflow-result');
      expect(results).toHaveLength(1);
      expect(results[0]?.meta?.workflowResult).toMatchObject({ runId, state: 'succeeded' });
    });

    it('an expired watch no longer swallows the result card', async () => {
      const { runId, thread } = await quickRun('quick-expired');
      await watchOn(thread, runId, 'expired', '{finished}');
      await progress();
      await h.app.chatFlow.tick();
      expect(await notices(thread, 'workflow-result')).toHaveLength(1);
    });

    it('an active watch that does not fire on this outcome does not swallow it either', async () => {
      const { runId, thread } = await quickRun('quick-failed-only');
      await watchOn(thread, runId, 'active', '{failed}');
      await progress();
      await h.app.chatFlow.tick();
      expect(await notices(thread, 'workflow-result')).toHaveLength(1);
    });

    it('a watch that already delivered the result (now done) gets no second card', async () => {
      const { runId, thread } = await quickRun('quick-delivered');
      await watchOn(thread, runId, 'active', '{finished}');
      await progress();
      await h.app.chatWatches.tick();
      expect((await notices(thread, 'chat-watch'))[0]?.meta?.workflowResult).toMatchObject({ runId });
      await h.app.chatFlow.tick();
      expect(await notices(thread, 'workflow-result')).toHaveLength(0);
    });
  });

  describe('job questions', () => {
    it('a question of a job started from a conversation is posted there and answered through the job route', async () => {
      const now = h.clock.now();
      const job = await h.db.pool.query<{ id: string }>(
        `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                           created_at, updated_at, state_changed_at)
         VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', $3, $4, $4, $4) RETURNING id::text AS id`,
        [PROJECT, JSON.stringify({ runtime: 'codex', prompt: 'Deploy the shop' }), ownerId, now],
      );
      const jobId = job.rows[0]?.id ?? '';
      const thread = await cardThread('job', { jobId });
      const other = await store.createThread(ownerId, 'unrelated');
      const qid = randomUUID();
      await h.db.pool.query(
        `INSERT INTO user_questions (id, source, job_id, attempt_id, request_id, project, title, questions, state,
                                     created_at, deadline_at)
         VALUES ($1, 'job', $2, $3, $4, $5, 'Target', $6, 'pending', $7, $8)`,
        [
          qid,
          jobId,
          randomUUID(),
          randomUUID(),
          PROJECT,
          JSON.stringify({
            v: 1,
            questions: [
              {
                id: 'env',
                prompt: 'Which environment?',
                kind: 'single',
                options: [{ label: 'preview' }, { label: 'production' }],
              },
            ],
          }),
          now,
          new Date(now.getTime() + 3_600_000),
        ],
      );
      expect(await h.app.chatFlow.jobQuestionAsked(jobId, qid)).toBe(1);
      // Once per question.
      expect(await h.app.chatFlow.jobQuestionAsked(jobId, qid)).toBe(0);
      const card = (await notices(thread, 'job-question'))[0];
      expect(card?.meta).toMatchObject({ questionId: qid, jobId });
      expect(await notices(other.id, 'job-question')).toHaveLength(0);

      // The conversation shows the job question (a job question, not the assistant's).
      const shown = await h.app.questions.forThread(thread);
      expect(shown.map((q) => [q.id, q.source, q.state])).toEqual([[qid, 'job', 'pending']]);
      expect(await h.app.questions.forThread(other.id)).toEqual([]);
      // A normal message in the conversation does not close it (only the assistant's own cards are superseded).
      await h.app.questions.supersedeThread(thread);
      expect((await h.app.questions.forThread(thread))[0]?.state).toBe('pending');

      // Answering from the card is the job route; the job page and the card read the same answered set.
      const ans = await owner.req('POST', `/jobs/${jobId}/questions/${qid}/answer`, {
        answers: [{ id: 'env', choices: ['production'] }],
      });
      expect(ans.statusCode, ans.body).toBe(200);
      const onJob = await owner.req('GET', `/jobs/${jobId}/questions`);
      expect(onJob.json<{ questions: { id: string; state: string }[] }>().questions[0]).toMatchObject({
        id: qid,
        state: 'answered',
      });
      expect((await h.app.questions.forThread(thread))[0]?.state).toBe('answered');
    });
  });
});
