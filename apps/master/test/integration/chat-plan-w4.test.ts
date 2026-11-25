import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatStore } from '../../src/chat/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-plan-mode W4 + the p17-chat-flow leftovers (docs/design/p18-plan-mode.md, "Implementation (W4)") against a real
 * master database. The assistant's plan tools are called on the service (what the tool dispatcher does), the person's
 * side through the REST routes:
 *
 *  - plan decisions in "Senden bekleyen" (`GET /questions/pending` names the plan, `GET /chat/plans/waiting` groups them)
 *    and answered there through the same question row;
 *  - `chat.plan` notifications (decision once per turn, back in review, blocked, done) to the owner only;
 *  - the conversation list search finds plan texts (title, goal, item titles and details), the owner's only;
 *  - the person's dependency edit (cycle refused) and a new phase;
 *  - a workflow result card linked to its plan item; a decided approval step told to its cards (`decided:` once);
 *  - a scheduled automation run's result posted into the conversation that created it (once, muted on request).
 */
const PW = 'amber-orchard-signal-42';
const PROJECT = 'w4-alpha';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/w4.git', baseRef: 'main' },
};
type Node = Record<string, unknown>;
const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({ id, type, config });

interface Plan {
  id: string;
  state: string;
  version: number;
  rev: number;
  items: {
    key: string;
    status: string;
    dependsOn: string[];
    phase: number;
    phaseTitle: string;
    title: string;
  }[];
}

describeIntegration('plan W4 + chat flow leftovers (integration)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let other: Client;
  let ownerId = '';
  let otherId = '';
  let secret = '';
  let store: ChatStore;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
    ownerId = await h.createUser('owner.w4', PW);
    secret = (await enroll(h, 'owner.w4', PW)).secret;
    owner = await fullLogin(h, 'owner.w4', PW, secret);
    otherId = await h.createUser('other.w4', PW);
    other = await fullLogin(h, 'other.w4', PW, (await enroll(h, 'other.w4', PW)).secret);
    // The project exists (the owner reaches every project; the other user only reads it).
    await h.grant(otherId, [PROJECT], 'viewer');
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    owner = await fullLogin(h, 'owner.w4', PW, secret);
  });

  const caller = (threadId: string, turnId = randomUUID()) => ({
    userId: ownerId,
    threadId,
    turnId,
    planMode: true,
  });
  async function newPlan(threadId: string, turnId = randomUUID()): Promise<string> {
    const out = await h.app.chatPlans.create(caller(threadId, turnId), {
      title: 'Sürüm 2.4 yayın planı',
      goal: 'Müşteriler yeni faturalama ekranını görsün',
      phases: [
        {
          title: 'Hazırlık',
          items: [
            { key: 'tests', title: 'Testleri düzelt', owner: 'assistant', detail: 'Kırmızı zebra testleri' },
            { key: 'notes', title: 'Changelog yaz', owner: 'assistant', dependsOn: ['tests'] },
          ],
        },
      ],
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    return (out as { plan: { id: string } }).plan.id;
  }
  const plan = async (planId: string): Promise<Plan> => {
    const r = await owner.req('GET', `/chat/plans/${planId}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Plan>();
  };
  const planNotes = async (planId: string) =>
    (
      await h.db.pool.query<{ recipient_id: string; title: string; dedupe_key: string; link: string }>(
        `SELECT recipient_id::text AS recipient_id, title, dedupe_key, link FROM notifications
          WHERE kind = 'chat.plan' AND dedupe_key LIKE $1 ORDER BY created_at, dedupe_key`,
        [`chat.plan:${planId}:%`],
      )
    ).rows;

  describe('plans', () => {
    it('decisions reach "Senden bekleyen" grouped by plan, are answered there and notify once per turn', async () => {
      const thread = (await store.createThread(ownerId, 'w4 decisions')).id;
      const turn = randomUUID();
      const planId = await newPlan(thread, turn);
      for (const prompt of ['Hangi ortama?', 'Hangi gün?']) {
        const out = await h.app.chatPlans.askDecision(caller(thread, turn), {
          planId,
          itemKey: 'tests',
          prompt,
          kind: 'single',
          options: [{ label: 'A' }, { label: 'B' }],
          recommended: 'A',
          rationale: 'safer',
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
      }
      // One notification for the turn, to the owner, linking the conversation (p18-leftovers: next to the plan's
      // "ready for review" one).
      const notes = (await planNotes(planId)).filter((x) => !x.dedupe_key.includes(':ready:'));
      expect(notes).toEqual([
        {
          recipient_id: ownerId,
          title: 'Plan senden karar bekliyor: Sürüm 2.4 yayın planı',
          dedupe_key: `chat.plan:${planId}:decision:${turn}`,
          link: `/chat/${thread}`,
        },
      ]);

      // "Senden bekleyen": the pending questions name their plan and item …
      const pending = await owner.req('GET', '/questions/pending');
      expect(pending.statusCode, pending.body).toBe(200);
      const mine = pending
        .json<{
          items: {
            id: string;
            plan?: { id: string; title: string; itemKey: string | null; itemTitle: string | null } | null;
          }[];
        }>()
        .items.filter((q) => q.plan?.id === planId);
      expect(mine).toHaveLength(2);
      expect(mine[0]?.plan).toEqual({
        id: planId,
        title: 'Sürüm 2.4 yayın planı',
        itemKey: 'tests',
        itemTitle: 'Testleri düzelt',
      });
      // … and the plan groups them (in review: it waits for approval too).
      const waiting = await owner.req('GET', '/chat/plans/waiting');
      expect(waiting.statusCode, waiting.body).toBe(200);
      const w = waiting
        .json<{
          items: {
            planId: string;
            state: string;
            threadId: string;
            questions: { id: string; questions: { id: string }[] }[];
          }[];
        }>()
        .items.find((x) => x.planId === planId);
      expect(w).toMatchObject({ state: 'in_review', threadId: thread });
      expect(w?.questions).toHaveLength(2);
      // Another user sees nothing of it.
      const theirs = await other.req('GET', '/chat/plans/waiting');
      expect(theirs.json<{ items: { planId: string }[] }>().items.some((x) => x.planId === planId)).toBe(
        false,
      );

      // Answered from there through the same question row: the plan has one decision left.
      const q = w?.questions[0];
      const ans = await owner.req('POST', `/chat/threads/${thread}/questions/${q?.id ?? ''}/answer`, {
        answers: [{ id: q?.questions[0]?.id ?? 'q1', choices: ['A'] }],
      });
      expect(ans.statusCode, ans.body).toBe(200);
      const after = await owner.req('GET', '/chat/plans/waiting');
      expect(
        after
          .json<{ items: { planId: string; questions: unknown[] }[] }>()
          .items.find((x) => x.planId === planId)?.questions,
      ).toHaveLength(1);
    });

    it('back in review, blocked and done notify the owner; set_depends refuses a cycle; a new phase', async () => {
      const thread = (await store.createThread(ownerId, 'w4 lifecycle')).id;
      const planId = await newPlan(thread);
      let p = await plan(planId);
      // The person: a cycle is refused, a dependency and a new phase are kept.
      const cycle = await owner.req('PATCH', `/chat/plans/${planId}/items`, {
        baseRev: p.rev,
        ops: [{ op: 'set_depends', key: 'tests', dependsOn: ['notes'] }],
      });
      expect(cycle.statusCode).toBe(409);
      expect(cycle.json<{ error: string }>().error).toBe('plan_invalid');
      const ok = await owner.req('PATCH', `/chat/plans/${planId}/items`, {
        baseRev: p.rev,
        ops: [
          { op: 'set_depends', key: 'notes', dependsOn: [] },
          { op: 'add', item: { title: 'Duyuru yap' }, phase: 1, phaseTitle: 'Yayın', after: null },
        ],
      });
      expect(ok.statusCode, ok.body).toBe(200);
      p = ok.json<Plan>();
      expect(p.items.find((i) => i.key === 'notes')?.dependsOn).toEqual([]);
      expect(p.items.at(-1)).toMatchObject({ phase: 1, phaseTitle: 'Yayın', title: 'Duyuru yap' });

      // Approve (cards rule), then the assistant changes the structure → back in review → notified.
      const ap = await owner.req('POST', `/chat/plans/${planId}/approve`, {
        version: p.version,
        autonomous: false,
      });
      expect(ap.statusCode, ap.body).toBe(200);
      p = ap.json<Plan>();
      const up = await h.app.chatPlans.update(caller(thread), {
        planId,
        baseVersion: p.version,
        reason: 'bir adım eklendi',
        ops: [{ op: 'rename', key: 'notes', title: 'Sürüm notlarını yaz' }],
      });
      expect(up.ok, JSON.stringify(up)).toBe(true);
      p = await plan(planId);
      expect(p.state).toBe('in_review');
      expect((await planNotes(planId)).map((x) => x.title)).toContain(
        'Plan yeniden incelemede: Sürüm 2.4 yayın planı',
      );

      // Executing again: the assistant blocks an item with a reason → notified, listed as waiting.
      const ap2 = await owner.req('POST', `/chat/plans/${planId}/approve`, {
        version: p.version,
        autonomous: false,
      });
      expect(ap2.statusCode, ap2.body).toBe(200);
      const bl = await h.app.chatPlans.setStatus(caller(thread), {
        planId,
        items: [{ key: 'tests', status: 'blocked', note: 'CI anahtarı yok' }],
      });
      expect(bl.ok, JSON.stringify(bl)).toBe(true);
      expect((await planNotes(planId)).map((x) => x.title)).toContain(
        'Plan engellendi: Sürüm 2.4 yayın planı',
      );
      const waiting = await owner.req('GET', '/chat/plans/waiting');
      const w = waiting
        .json<{ items: { planId: string; waiting: { key: string; why: string; note: string | null }[] }[] }>()
        .items.find((x) => x.planId === planId);
      expect(w?.waiting).toEqual(
        expect.arrayContaining([
          { key: 'tests', title: 'Testleri düzelt', why: 'blocked', note: 'CI anahtarı yok' },
          expect.objectContaining({ why: 'mine', title: 'Duyuru yap' }),
        ]),
      );

      // Everything skipped → the assistant finishes the plan → "Plan tamamlandı" once.
      p = await plan(planId);
      const skip = await owner.req('PATCH', `/chat/plans/${planId}/items`, {
        baseRev: p.rev,
        ops: p.items.map((i) => ({ op: 'skip', key: i.key })),
      });
      expect(skip.statusCode, skip.body).toBe(200);
      const done = await h.app.chatPlans.setState(caller(thread), { planId, state: 'done' });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      const titles = (await planNotes(planId)).map((x) => x.title);
      expect(titles.filter((t) => t === 'Plan tamamlandı: Sürüm 2.4 yayın planı')).toHaveLength(1);
      // Only the owner was told.
      expect((await planNotes(planId)).every((x) => x.recipient_id === ownerId)).toBe(true);
    });

    it('the conversation list search finds plan texts — the owner’s own conversations only', async () => {
      const thread = (await store.createThread(ownerId, 'w4 search')).id;
      await newPlan(thread);
      const find = async (c: Client, q: string): Promise<string[]> => {
        const r = await c.req('GET', `/chat/threads?q=${encodeURIComponent(q)}`);
        expect(r.statusCode, r.body).toBe(200);
        return r.json<{ items: { id: string }[] }>().items.map((i) => i.id);
      };
      expect(await find(owner, 'faturalama ekranını')).toContain(thread); // goal
      expect(await find(owner, 'zebra')).toContain(thread); // item detail
      expect(await find(owner, 'Changelog')).toContain(thread); // item title
      expect(await find(owner, 'yayın planı')).toContain(thread); // plan title
      expect(await find(owner, 'hiç-olmayan-kelime')).not.toContain(thread);
      expect(await find(other, 'zebra')).not.toContain(thread);
    });
  });

  describe('chat flow leftovers', () => {
    const doc = (name: string, nodes: Node[], edges: Node[]) => ({
      schemaVersion: 2,
      name,
      defaults: DEFAULTS,
      nodes,
      edges,
    });
    async function define(d: Record<string, unknown>): Promise<string> {
      const res = await owner.req('POST', '/workflows', { project: PROJECT, definition: d });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }
    async function start(id: string): Promise<string> {
      const res = await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ runId: string }>().runId;
    }
    const progress = async (times = 3) => {
      for (let i = 0; i < times; i++) await h.app.workflows.progress();
    };
    async function card(
      threadId: string,
      kind: string,
      result: Record<string, unknown>,
      payload = {},
    ): Promise<string> {
      const id = randomUUID();
      const at = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                  result, created_at, expires_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'card', $6, $7, $8, 'confirmed', $9, $10, $10, $10)`,
        [
          id,
          threadId,
          ownerId,
          randomUUID(),
          kind,
          JSON.stringify(payload),
          'a'.repeat(64),
          PROJECT,
          JSON.stringify(result),
          at,
        ],
      );
      return id;
    }
    const notices = async (threadId: string, notice: string) =>
      (await store.messages(threadId)).filter((m) => m.meta?.notice === notice);

    it('a run linked to a plan item: its result card names the item', async () => {
      const id = await define(doc('w4-quick', [n('one', 'data.set', { fields: { a: 1 } })], []));
      const runId = await start(id);
      const thread = (await store.createThread(ownerId, 'w4 linked')).id;
      const draftId = await card(thread, 'workflow_run', { runId });
      const planId = await newPlan(thread);
      const p = await plan(planId);
      expect(
        (await owner.req('POST', `/chat/plans/${planId}/approve`, { version: p.version, autonomous: false }))
          .statusCode,
      ).toBe(200);
      const linked = await h.app.chatPlans.setStatus(caller(thread), {
        planId,
        items: [{ key: 'tests', status: 'in_progress', link: { kind: 'draft', id: draftId } }],
      });
      expect(linked.ok, JSON.stringify(linked)).toBe(true);
      await progress();
      await h.app.chatFlow.tick();
      const results = await notices(thread, 'workflow-result');
      expect(results).toHaveLength(1);
      expect(results[0]?.meta?.planItem).toEqual({ planId, key: 'tests', title: 'Testleri düzelt' });
    });

    it('a decided approval step is told to its cards once (decided:)', async () => {
      const id = await define(
        doc('w4-gate', [n('ask', 'control.approval', { approverRole: 'operator', title: 'Go?' })], []),
      );
      const runId = await start(id);
      const thread = (await store.createThread(ownerId, 'w4 gate')).id;
      await card(thread, 'workflow_run', { runId });
      await progress();
      await h.app.chatFlow.tick();
      const nodeRunId = String((await notices(thread, 'workflow-approval'))[0]?.meta?.nodeRunId);
      expect(await h.app.chatFlow.approvalDecided(nodeRunId)).toBe(1);
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      const ok = await owner.req('POST', `/workflows/runs/${runId}/node-runs/${nodeRunId}/approve`, {
        reason: 'go',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      const keys = await h.db.pool.query('SELECT 1 FROM chat_flow_events WHERE key = $1', [
        `decided:${nodeRunId}`,
      ]);
      expect(keys.rowCount).toBe(1);
    });

    it('a scheduled automation run reports into the conversation that created it — once, and not when muted', async () => {
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO automations (project, name, state, trigger_kind, trigger, cron, next_run_at, target_kind,
                                  job_spec, run_as, created_by, created_at, updated_at)
         VALUES ($1, 'w4 nightly', 'active', 'cron', '{"kind":"cron","cron":"0 3 * * *"}', '0 3 * * *',
                 now() + interval '300 days', 'job', '{"runtime":"codex","prompt":"x"}', $2, $2, now(), now())
         RETURNING id::text AS id`,
        [PROJECT, ownerId],
      );
      const automationId = rows[0]?.id ?? '';
      const thread = (await store.createThread(ownerId, 'w4 automation')).id;
      await card(thread, 'automation', { automationId, state: 'active' }, { action: 'create' });
      const run = async (key: string, state: string): Promise<void> => {
        await h.db.pool.query(
          `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, state, reason, created_at, finished_at)
           VALUES ($1, $2, 'cron', $3, $4, 'no eligible machine', $5, $5)`,
          [automationId, PROJECT, key, state, h.clock.now()],
        );
      };
      await run('w4-1', 'error');
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      const posted = await notices(thread, 'automation-result');
      expect(posted).toHaveLength(1);
      expect(posted[0]?.meta?.scheduled).toMatchObject({
        target: `automation:${automationId}`,
        kind: 'automation',
        outcome: 'failed',
      });
      expect(posted[0]?.content).toContain('w4 nightly');
      // Muted for this conversation (owner only): the next run is not posted.
      const mute = await owner.req('PUT', `/chat/threads/${thread}/result-mutes`, {
        target: `automation:${automationId}`,
        muted: true,
      });
      expect(mute.statusCode, mute.body).toBe(200);
      const notMine = await other.req('PUT', `/chat/threads/${thread}/result-mutes`, {
        target: `automation:${automationId}`,
        muted: false,
      });
      expect(notMine.statusCode).toBe(404);
      h.clock.advance(1_000);
      await run('w4-2', 'error');
      await h.app.chatFlow.tick();
      expect(await notices(thread, 'automation-result')).toHaveLength(1);
      const list = await owner.req('GET', `/chat/threads/${thread}/result-mutes`);
      expect(list.json()).toEqual({ targets: [`automation:${automationId}`] });
      expect(otherId).not.toBe(ownerId);
    });
  });
});
