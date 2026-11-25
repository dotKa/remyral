import { FakeAssistantEngine, fakeToolData } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §6, W1 + W2 acceptance) end to end through the real transport: master ↔
 * real worker daemon with the scripted fake engine playing the model.
 *
 * W1: in plan mode a draft tool is refused and audited; a plan with 2 decisions cannot be approved until both are
 * answered (the answer route serves the panel and the card — one row); "Değişiklik iste" → v2 with diff counts; a
 * second session reads the same plan; approve at a stale version → 409 with the current plan.
 * W2: approve → first item in progress → job card (not executed) → confirm → job runs → item done by derivation → next
 * item in a continuation turn; failed job → item blocked with the reason; pause stops continuation; the older-worker
 * fallback; the partial unique index; cascade on thread delete; a shared reader reads only.
 */
const PW = 'violet-lantern-harbour-81';

interface Message {
  id: string;
  seq: number;
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  kind: string;
  state: string;
  result: Record<string, unknown> | null;
}
interface PlanItem {
  key: string;
  status: string;
  owner: string;
  links: { kind: string; id: string }[];
  note: string | null;
  statusBy: string;
}
interface Plan {
  id: string;
  state: string;
  version: number;
  rev: number;
  stalled: string | null;
  items: PlanItem[];
  decisions: { id: string; state: string; recommended: string | null; itemKey: string | null }[];
  lastChange: { added: number; removed: number; changed: number; moved: number } | null;
}
interface Detail {
  messages: Message[];
  drafts: Draft[];
  turn: unknown;
  questions?: {
    id: string;
    state: string;
    planId?: string | null;
    closeReason?: string | null;
    closeNote?: string;
  }[];
  plan?: { mode: string | null; active: Plan | null };
}

describeIntegration('plan mode (integration, p18-plan-mode)', { timeout: 300_000 }, () => {
  const h = new Harness();
  const engine = new FakeAssistantEngine();
  const dirs: string[] = [];
  let worker: RunningWorker | undefined;
  let workerId = '';
  let owner: Client;
  let ownerSecret = '';
  let reader: Client;
  let readerId = '';
  let ownerId = '';
  let url = '';
  let thread = '';
  let planId = '';

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }
  async function detail(c: Client, id: string): Promise<Detail> {
    const r = await c.req('GET', `/chat/threads/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  async function idle(id: string): Promise<void> {
    await expect.poll(async () => (await detail(owner, id)).turn === null, { timeout: 20_000 }).toBe(true);
  }
  async function ask(id: string, text: string): Promise<Message> {
    const r = await owner.req('POST', `/chat/threads/${id}/messages`, { text });
    expect(r.statusCode, r.body).toBe(202);
    const seq = r.json<{ message: Message }>().message.seq;
    let last: Message | undefined;
    await expect
      .poll(
        async () => {
          const d = await detail(owner, id);
          last = d.messages
            .filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'))
            .at(-1);
          return d.turn === null && last !== undefined;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    return last as Message;
  }
  const plan = async (): Promise<Plan> => {
    const p = (await detail(owner, thread)).plan?.active;
    if (p == null) throw new Error('no active plan');
    return p;
  };
  const item = (p: Plan, key: string): PlanItem => {
    const i = p.items.find((x) => x.key === key);
    if (i === undefined) throw new Error(`no item ${key}`);
    return i;
  };
  const continuations = async (): Promise<Message[]> =>
    (await detail(owner, thread)).messages.filter((m) => m.role === 'user' && m.meta?.origin === 'plan');
  const planIdOf = (ctx: string | null): string => /"planId": "([0-9a-f-]{36})"/.exec(ctx ?? '')?.[1] ?? '';

  beforeAll(async () => {
    await h.start({
      securityPolicy: { preset: 'serbest' },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    ownerId = await h.createUser('owner.plan', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner.plan', PW));
    owner = await fullLogin(h, 'owner.plan', PW, ownerSecret);
    await h.grant(ownerId, ['alpha'], 'operator');
    // alpha has a registered repository (draft_job uses it).
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ('alpha', 1, 'git', 'https://example.com/acme/repo.git', 'main', 'merge', false, 3600, $1, $2)`,
      [ownerId, h.clock.now()],
    );
    readerId = await h.createUser('reader.plan', PW, 'viewer');
    await h.grant(readerId, ['alpha'], 'viewer');
    const { secret: rs } = await enroll(h, 'reader.plan', PW);
    reader = await fullLogin(h, 'reader.plan', PW, rs);

    // The model of the planning turn: tries a draft (refused in plan mode), writes the plan, asks two decisions.
    engine.script(/PLAN-A/, async (ctx) => {
      const draft = await ctx.call('draft_job', {
        project: 'alpha',
        title: 'Testleri düzelt',
        prompt: 'Fix the tests',
        runtime: 'codex',
      });
      const created = await ctx.call('plan_create', {
        title: 'Sürüm 2.4 yayını',
        goal: 'Sürüm 2.4 testleri geçmiş halde yayına çıksın.',
        risks: ['Flaky testler'],
        phases: [
          {
            title: 'Hazırlık',
            items: [
              {
                key: 'analiz',
                title: 'Değişiklikleri incele',
                activeTitle: 'İnceliyorum',
                owner: 'assistant',
              },
              {
                key: 'testler',
                title: 'Testleri düzelt',
                owner: 'job',
                dependsOn: ['analiz'],
                project: 'alpha',
              },
            ],
          },
          {
            title: 'Yayın',
            items: [
              {
                key: 'notlar',
                title: 'Changelog yaz',
                owner: 'job',
                dependsOn: ['testler'],
                project: 'alpha',
              },
            ],
          },
        ],
      });
      const id = (fakeToolData(created.content) as { planId: string }).planId;
      await ctx.call('plan_ask_decision', {
        planId: id,
        itemKey: 'testler',
        prompt: 'Hangi test ortamı?',
        kind: 'single',
        options: [{ label: 'preview' }, { label: 'production' }],
        recommended: 'preview',
        rationale: 'Önce doğrula.',
      });
      await ctx.call('plan_ask_decision', { planId: id, prompt: 'Sürüm notu dili?', kind: 'text' });
      return `draft: ${draft.isError ? 'refused' : 'ok'} ${draft.content}\nplan ${id}`;
    });
    // "Değişiklik iste": the revision adds a smoke test and renames the notes item.
    engine.script(/CHANGE-B/, async (ctx) => {
      const id = planIdOf(ctx.context);
      const r = await ctx.call('plan_update_items', {
        planId: id,
        baseVersion: 1,
        reason: 'Smoke test eklendi',
        ops: [
          {
            op: 'add',
            item: { key: 'smoke', title: 'Smoke test', owner: 'job', dependsOn: ['testler'] },
            phase: 1,
            after: null,
          },
          { op: 'rename', key: 'notlar', title: 'Changelog ve sürüm notu' },
        ],
      });
      return `revised ${r.isError ? r.content : 'ok'}`;
    });
    // Continuation turns: the assistant works the item the message names.
    engine.script(/Onaylı plan v\d+/, async (ctx) => {
      const id = planIdOf(ctx.context);
      const key = /sıradaki madde: .*? \(([a-z0-9-]+)\)/.exec(ctx.message)?.[1];
      if (key === undefined) return 'Bekliyorum.';
      if (key === 'analiz') {
        await ctx.call('plan_set_status', { planId: id, items: [{ key, status: 'in_progress' }] });
        await ctx.call('plan_set_status', {
          planId: id,
          items: [{ key, status: 'done', note: 'İncelendi' }],
        });
        return 'Analiz bitti.';
      }
      const r = await ctx.call('draft_job', {
        project: 'alpha',
        title: `Plan: ${key}`,
        prompt: `Do ${key}`,
        runtime: 'codex',
        planItem: key,
      });
      return `card ${r.isError ? r.content : 'ok'}`;
    });
  });
  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('sets up the assistant machine', async () => {
    const dataDir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
    worker = await runRealWorker(url, dataDir, {
      capabilities: CAPS,
      assistant: { engine, clock: h.clock.now },
    });
    await stepUp(owner, ownerSecret);
    const s = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect(s.statusCode, s.body).toBe(200);
    await expect
      .poll(
        async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean; plan: boolean }>(),
        {
          timeout: 20_000,
        },
      )
      .toMatchObject({ available: true, plan: true });
    thread = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
  });

  describe('W1: plan mode, plan, review', () => {
    it('plan mode is a conversation state; in it a draft tool is refused and audited', async () => {
      const on = await owner.req('PUT', `/chat/threads/${thread}/plan-mode`, { on: true });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json<{ mode: string | null }>().mode).not.toBeNull();
      expect((await detail(owner, thread)).plan?.mode).not.toBeNull();
      const reply = await ask(thread, 'PLAN-A 2.4 sürümünü yayına hazırla, önce planla');
      expect(reply.content).toContain('draft: refused');
      expect(reply.content).toContain('plan_mode_read_only');
      const d = await detail(owner, thread);
      expect(d.drafts).toEqual([]);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'chat.plan.refused_tool' AND target = $1`,
        [`chat-thread:${thread}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ tool: 'draft_job', kind: 'draft' });
      const p = d.plan?.active;
      expect(p).toMatchObject({ state: 'in_review', version: 1 });
      planId = p?.id ?? '';
      expect(p?.decisions.map((x) => x.state)).toEqual(['pending', 'pending']);
      expect(p?.decisions[0]).toMatchObject({ recommended: 'preview', itemKey: 'testler' });
      expect(item(p as Plan, 'testler')).toMatchObject({ status: 'pending' });
      // The plan card: the plan_create tool message carries the plan; decisions are question cards of the thread.
      expect(d.messages.some((m) => m.meta?.name === 'plan_create' && m.meta.planId === planId)).toBe(true);
      expect(d.questions?.filter((q) => q.planId === planId).length).toBe(2);
      // The plan-mode turn's input led with the instruction and carried the plan block from then on.
      const turns = engine.sessions.flatMap((s) => s.turns);
      expect(turns.at(-1)?.message).toMatch(/^PLAN MODE/);
    });

    it('cannot be approved while decisions are open; answers from the card and the panel are one row', async () => {
      const blocked = await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1 });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ error: 'plan_decisions_open', params: { count: 2 } });
      const [d1, d2] = (await plan()).decisions;
      // p19-plan-decide: a choice decision takes the person's own text ("Diğer") and a note.
      const row = async (id: string) =>
        (
          await h.db.pool.query<{ questions: { questions: { allowOther?: boolean }[] }; answers: unknown }>(
            'SELECT questions, answers FROM user_questions WHERE id = $1',
            [id],
          )
        ).rows[0];
      expect((await row(d1?.id ?? ''))?.questions.questions[0]?.allowOther).toBe(true);
      const a1 = await owner.req('POST', `/chat/threads/${thread}/questions/${d1?.id ?? ''}/answer`, {
        answers: [{ id: 'q1', choices: ['preview'], note: 'Önce küçük bir veriyle' }],
      });
      expect(a1.statusCode, a1.body).toBe(200);
      expect((await row(d1?.id ?? ''))?.answers).toEqual([
        { id: 'q1', choices: ['preview'], note: 'Önce küçük bir veriyle' },
      ]);
      // A plan decision starts no turn.
      expect(a1.json<{ turnId: string | null }>().turnId).toBeNull();
      const d = await detail(owner, thread);
      expect(d.turn).toBeNull();
      expect(d.plan?.active?.decisions[0]?.state).toBe('answered');
      expect(d.questions?.find((q) => q.id === d1?.id)?.state).toBe('answered');
      expect((await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1 })).statusCode).toBe(409);
      // p19-plan-decide: the conversation settled the second decision — the assistant closes it (no answer route).
      await ask(
        thread,
        `Türkçe olsun [[tool plan_close_decision {"planId":"${planId}","decisionId":"${d2?.id ?? ''}","answer":"Türkçe","reason":"Sohbette karar verildi."}]]`,
      );
      expect((await plan()).decisions[1]?.state).toBe('cancelled');
      const q2 = (await detail(owner, thread)).questions?.find((q) => q.id === d2?.id);
      expect(q2?.state).toBe('cancelled');
      // p20-decisions: what was settled is kept on the decision — its card folds as "Sohbette karara bağlandı: Türkçe".
      expect(q2).toMatchObject({ closeReason: 'settled_in_chat', closeNote: 'Türkçe' });
      // Closing it again is refused (not open any more).
      const again = await ask(
        thread,
        `Tekrar [[tool plan_close_decision {"planId":"${planId}","decisionId":"${d2?.id ?? ''}","reason":"x"}]]`,
      );
      expect(again.content).toBeTruthy();
      // An ask_user card later does not touch the plan's decisions (keyed by plan).
      await ask(thread, 'Bir sorum var [[tool ask_user {"questions":[{"prompt":"Devam?","kind":"text"}]}]]');
      expect((await plan()).decisions[1]?.state).toBe('cancelled');
    });

    it('"Değişiklik iste" → the assistant revises in plan mode → v2 with diff counts; another session reads it', async () => {
      const r = await owner.req('POST', `/chat/plans/${planId}/request-changes`, {
        version: 1,
        note: 'CHANGE-B testlerden sonra smoke test olsun',
      });
      expect(r.statusCode, r.body).toBe(200);
      await idle(thread);
      const p = await plan();
      expect(p).toMatchObject({ version: 2, state: 'in_review' });
      expect(p.lastChange).toMatchObject({ added: 1, changed: 1, removed: 0 });
      const versions = await h.db.pool.query(
        'SELECT version, author FROM chat_plan_versions WHERE plan_id = $1 ORDER BY version',
        [planId],
      );
      expect(versions.rows).toEqual([
        { version: 1, author: 'assistant' },
        { version: 2, author: 'assistant' },
      ]);
      // A second device (another session of the same person) and a reload read the same plan.
      const other = await fullLogin(h, 'owner.plan', PW, ownerSecret);
      const there = (await detail(other, thread)).plan?.active;
      expect(there).toMatchObject({ id: planId, version: 2, rev: p.rev });
      const single = await other.req('GET', `/chat/plans/${planId}`);
      expect(single.json<Plan>().items.map((i) => i.key)).toEqual(['analiz', 'testler', 'smoke', 'notlar']);
      const diff = await other.req('GET', `/chat/plans/${planId}/diff?from=1&to=2`);
      expect(diff.json()).toMatchObject({
        added: ['smoke'],
        changed: [{ key: 'notlar', fields: ['title'] }],
      });
    });

    it('a shared reader reads the plan but cannot change it', async () => {
      const share = await owner.req('PUT', `/chat/threads/${thread}/shares/${readerId}`);
      expect(share.statusCode, share.body).toBe(200);
      expect((await reader.req('GET', `/chat/plans/${planId}`)).statusCode).toBe(200);
      expect((await reader.req('GET', `/chat/threads/${thread}/plans`)).statusCode).toBe(200);
      expect((await reader.req('POST', `/chat/plans/${planId}/approve`, { version: 2 })).statusCode).toBe(
        404,
      );
      expect((await reader.req('PUT', `/chat/threads/${thread}/plan-mode`, { on: false })).statusCode).toBe(
        404,
      );
    });

    it('approving at a stale version is 409 with the current plan', async () => {
      const stale = await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: 'plan_version_conflict', plan: { version: 2 } });
    });

    it('one active plan per conversation (partial unique index)', async () => {
      await expect(
        h.db.pool.query(
          `INSERT INTO chat_plans (id, thread_id, user_id, title, goal, state, version, rev, created_at, updated_at)
           SELECT gen_random_uuid(), thread_id, user_id, 'x', 'y', 'drafting', 1, 1, now(), now() FROM chat_plans WHERE id = $1`,
          [planId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('W2: execution and live progress', () => {
    it('approve (not autonomous) → leaves plan mode → the first items run in continuation turns; a job item becomes a card', async () => {
      // p18-plan-autonomy: approved with "Otonom yürüt" off — the W2 card behaviour (chat-plan-autonomy.test.ts covers on).
      const ok = await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 2, autonomous: false });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<Plan & { autonomous: boolean }>()).toMatchObject({
        state: 'executing',
        autonomous: false,
      });
      expect((await detail(owner, thread)).plan?.mode).toBeNull();
      // Turn 1: analiz (the assistant's own item) in progress → done; turn 2 follows by itself: testler as a card.
      await expect
        .poll(async () => item(await plan(), 'testler').status, { timeout: 30_000 })
        .toBe('in_progress');
      await idle(thread);
      const p = await plan();
      expect(item(p, 'analiz')).toMatchObject({ status: 'done' });
      const conts = await continuations();
      expect(conts.length).toBe(2);
      expect(conts[0]?.content).toMatch(/Onaylı plan v2 — sıradaki madde: Değişiklikleri incele \(analiz\)/);
      // The card is NOT executed: a continuation turn is not the person's (approval grants nothing).
      const d = await detail(owner, thread);
      const card = d.drafts.find((x) => x.kind === 'job');
      expect(card?.state).toBe('proposed');
      expect(item(p, 'testler').links).toEqual([expect.objectContaining({ kind: 'draft', id: card?.id })]);
      const jobs = await h.db.pool.query("SELECT 1 FROM jobs WHERE project = 'alpha'");
      expect(jobs.rowCount).toBe(0);
    });

    it('confirmed card → its job runs → item done by derivation → the next item starts in a continuation turn', async () => {
      // The confirmation's outcome (a job created for the card) without placing it on the test machine: the job is
      // created as the card's result and runs, then succeeds (the confirm route itself is exercised below).
      const card = (await detail(owner, thread)).drafts.find((x) => x.kind === 'job');
      const jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      const { job } = await jobs.create({
        project: 'alpha',
        actor: { type: 'user', id: ownerId },
        submit: false,
        spec: {
          runtime: 'codex',
          prompt: 'Fix the tests',
          repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/plan' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      });
      await h.db.pool.query(`UPDATE jobs SET state = 'RUNNING', version = version + 1 WHERE id = $1`, [
        job.id,
      ]);
      await h.db.pool.query(
        `UPDATE chat_drafts SET state = 'confirmed', decided_at = now(), result = $2 WHERE id = $1`,
        [card?.id, JSON.stringify({ jobId: job.id })],
      );
      await h.app.chatPlans.tick();
      let p = await plan();
      expect(item(p, 'testler')).toMatchObject({ status: 'in_progress', statusBy: 'derived' });
      expect(item(p, 'testler').links.map((l) => l.kind)).toEqual(['draft', 'job']);
      await idle(thread);
      // Nothing ready while the job runs: no continuation turn.
      const before = (await continuations()).length;
      expect(before).toBe(2);
      await h.db.pool.query(`UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1`, [
        job.id,
      ]);
      await h.app.chatPlans.tick();
      await expect
        .poll(async () => (await continuations()).length, { timeout: 20_000 })
        .toBeGreaterThan(before);
      await idle(thread);
      p = await plan();
      expect(item(p, 'testler')).toMatchObject({ status: 'done', statusBy: 'derived' });
      expect((await continuations()).at(-1)?.content).toMatch(/sıradaki madde: Smoke test \(smoke\)/);
      expect(item(p, 'smoke').status).toBe('in_progress');
      expect(
        (await detail(owner, thread)).drafts.filter((x) => x.kind === 'job' && x.state === 'proposed').length,
      ).toBe(1);
    });

    it('confirm through the card route; the job fails → its item is blocked with the reason; the plan then waits', async () => {
      const card = (await detail(owner, thread)).drafts.find(
        (x) => x.kind === 'job' && x.state === 'proposed',
      );
      await stepUp(owner, ownerSecret);
      const c = await owner.req('POST', `/chat/drafts/${card?.id ?? ''}/confirm`);
      expect(c.statusCode, c.body).toBe(200);
      const jobId = c.json<{ result: { jobId: string } }>().result.jobId;
      // The test machine cannot run it (no eligible worker): the job fails at placement.
      await expect
        .poll(
          async () =>
            (await h.db.pool.query<{ state: string }>('SELECT state::text FROM jobs WHERE id = $1', [jobId]))
              .rows[0]?.state,
        )
        .toBe('FAILED');
      await h.app.chatPlans.tick();
      await expect.poll(async () => item(await plan(), 'smoke').status).toBe('blocked');
      expect(item(await plan(), 'smoke').note).toMatch(/failed|no eligible worker/);
      // The assistant is told: the continuation that started the next ready item names the blocked one too.
      await idle(thread);
      expect((await continuations()).at(-1)?.content).toMatch(
        /sıradaki madde: Changelog ve sürüm notu \(notlar\)\. Engellenen madde: Smoke test \(smoke\)/,
      );
      // Asked to go on with nothing it can do, the assistant makes no progress → the plan waits for the person.
      expect((await owner.req('POST', `/chat/plans/${planId}/resume`)).statusCode).toBe(200);
      await expect
        .poll(
          async () => (await detail(owner, thread)).messages.some((m) => m.meta?.notice === 'plan-continue'),
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
      expect((await continuations()).at(-1)?.content).toMatch(
        /madde engellendi\. Engellenen madde: Smoke test \(smoke\)/,
      );
      expect((await plan()).stalled).toBe('no_progress');
    });

    it('pause stops continuation; resume clears the wait', async () => {
      const sent = (await continuations()).length;
      const resumed = await owner.req('POST', `/chat/plans/${planId}/resume`);
      expect(resumed.statusCode, resumed.body).toBe(200);
      // The resume's own continuation lands first (p20-outcome: its claim adds a moment before the send).
      await expect
        .poll(async () => (await continuations()).length, { timeout: 20_000 })
        .toBeGreaterThan(sent);
      await idle(thread);
      const paused = await owner.req('POST', `/chat/plans/${planId}/pause`);
      expect(paused.statusCode, paused.body).toBe(200);
      expect(paused.json<Plan>().state).toBe('paused');
      const before = (await continuations()).length;
      await h.db.pool.query('UPDATE chat_plans SET cont_due = true, stalled = NULL WHERE id = $1', [planId]);
      await h.app.chatPlans.tick();
      await new Promise((r) => setTimeout(r, 500));
      expect((await continuations()).length).toBe(before);
      const audit = await h.db.pool.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_events WHERE target = $1 ORDER BY action`,
        [`chat-plan:${planId}`],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'chat.plan.approve',
          'chat.plan.create',
          'chat.plan.edit',
          'chat.plan.pause',
          'chat.plan.request_changes',
          'chat.plan.resume',
        ]),
      );
    });

    it('an older assistant machine: plan mode cannot be turned on', async () => {
      await h.db.pool.query(
        `UPDATE workers SET features = (SELECT coalesce(jsonb_agg(f), '[]'::jsonb) FROM jsonb_array_elements(features) f
                                         WHERE f <> '"assistant-plan-v1"'::jsonb) WHERE id = $1`,
        [workerId],
      );
      expect((await owner.req('GET', '/chat/status')).json<{ plan: boolean }>().plan).toBe(false);
      const r = await owner.req('PUT', `/chat/threads/${thread}/plan-mode`, { on: true });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'plan_mode_unavailable' });
    });

    it('deleting the conversation deletes its plans', async () => {
      expect((await owner.req('DELETE', `/chat/threads/${thread}`)).statusCode).toBe(204);
      const left = await h.db.pool.query('SELECT 1 FROM chat_plans WHERE id = $1', [planId]);
      expect(left.rowCount).toBe(0);
    });
  });
});
