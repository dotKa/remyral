import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * p18-plan-autonomy (docs/design/p18-plan-mode.md, "Implementation (autonomy)") end to end through the real transport:
 * master ↔ real worker daemon with the scripted fake engine playing the model.
 *
 * Approve (autonomous by default) → the continuation turn drafts a job → the job is created and dispatched without a
 * confirm call (audit `chat.direct_action`, trigger plan); it fails, the plan continues, the assistant retries — the
 * third failure of the same item stops the retries (blocked, notice, notification). Approved with autonomous off → the
 * draft stays a card ("Senden bekleniyor"); the ⋯ toggle turns it on / off (audited). A plan paused before the draft →
 * a card. A step that needs an authenticator code → a card, the item waits.
 */
const PW = 'violet-lantern-harbour-82';

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
  links: { kind: string; id: string }[];
  note: string | null;
  awaitsUser: boolean;
  failures: number;
}
interface Plan {
  id: string;
  state: string;
  version: number;
  autonomous: boolean;
  items: PlanItem[];
}
interface Detail {
  messages: Message[];
  drafts: Draft[];
  turn: unknown;
  plan?: { mode: string | null; active: Plan | null };
}

describeIntegration('plan autonomy (integration, p18-plan-autonomy)', { timeout: 300_000 }, () => {
  const h = new Harness();
  const engine = new FakeAssistantEngine();
  const dirs: string[] = [];
  const seen: string[] = [];
  let worker: RunningWorker | undefined;
  let workerId = '';
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let url = '';

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
  }
  async function detail(id: string): Promise<Detail> {
    const r = await owner.req('GET', `/chat/threads/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  async function idle(id: string): Promise<void> {
    await expect.poll(async () => (await detail(id)).turn === null, { timeout: 20_000 }).toBe(true);
  }
  async function plan(thread: string): Promise<Plan> {
    const p = (await detail(thread)).plan?.active;
    if (p == null) throw new Error('no active plan');
    return p;
  }
  const item = (p: Plan, key: string): PlanItem => {
    const i = p.items.find((x) => x.key === key);
    if (i === undefined) throw new Error(`no item ${key}`);
    return i;
  };
  const jobCards = async (thread: string): Promise<Draft[]> =>
    (await detail(thread)).drafts.filter((d) => d.kind === 'job');
  const directAudit = async (
    planId: string,
  ): Promise<{ outcome: string; metadata: Record<string, unknown> }[]> =>
    (
      await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'chat.direct_action'
            AND metadata->>'planId' = $1 ORDER BY id`,
        [planId],
      )
    ).rows;
  const planIdOf = (ctx: string | null): string => /"planId": "([0-9a-f-]{36})"/.exec(ctx ?? '')?.[1] ?? '';

  /** A conversation with an approved one-item plan (item `key`, a job of project alpha). */
  async function planned(key: string): Promise<{ thread: string; planId: string }> {
    const thread = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
    const r = await owner.req('POST', `/chat/threads/${thread}/messages`, {
      text: `PLAN-${key} projeyi derle`,
      mode: 'plan',
    });
    expect(r.statusCode, r.body).toBe(202);
    await expect
      .poll(async () => (await detail(thread)).plan?.active?.state, { timeout: 20_000 })
      .toBe('in_review');
    await idle(thread);
    return { thread, planId: (await plan(thread)).id };
  }

  beforeAll(async () => {
    await h.start({
      securityPolicy: { preset: 'serbest' },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    ownerId = await h.createUser('owner.auto', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner.auto', PW));
    owner = await fullLogin(h, 'owner.auto', PW, ownerSecret);
    await h.grant(ownerId, ['alpha'], 'operator');
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ('alpha', 1, 'git', 'https://example.com/acme/repo.git', 'main', 'merge', false, 3600, $1, $2)`,
      [ownerId, h.clock.now()],
    );

    // The planning turn: one job item named by the message.
    engine.script(/PLAN-([a-z]+)/, async (ctx) => {
      const key = /PLAN-([a-z]+)/.exec(ctx.message)?.[1] ?? 'x';
      const created = await ctx.call('plan_create', {
        title: `Derleme planı ${key}`,
        goal: 'Projeyi derle ve testleri çalıştır.',
        phases: [
          { title: 'Derleme', items: [{ key, title: `Derle ${key}`, owner: 'job', project: 'alpha' }] },
        ],
      });
      return `plan ${created.isError ? created.content : 'ok'}`;
    });
    // Continuation turns: the assistant drafts the job of the next (or the blocked) item; `halt` pauses the plan first.
    engine.script(/Onaylı plan v\d+/, async (ctx) => {
      seen.push(ctx.message);
      const id = planIdOf(ctx.context);
      const key =
        /sıradaki madde: .*? \(([a-z0-9-]+)\)/.exec(ctx.message)?.[1] ??
        /Engellenen madde: .*? \(([a-z0-9-]+)\)/.exec(ctx.message)?.[1];
      if (key === undefined) return 'Bekliyorum.';
      if (key === 'halt') await ctx.call('plan_set_state', { planId: id, state: 'paused', note: 'Bekle' });
      const r = await ctx.call('draft_job', {
        project: 'alpha',
        title: `Plan: ${key}`,
        prompt: `Build ${key}`,
        runtime: 'codex',
        planItem: key,
      });
      return `job ${r.content}`;
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
    await stepUp();
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
  });

  describe('approved autonomous (the default)', () => {
    let thread = '';
    let planId = '';

    it('the continuation turn’s job is created and dispatched without a confirm call; audited with trigger plan', async () => {
      ({ thread, planId } = await planned('build'));
      const ok = await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1 });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<Plan>()).toMatchObject({ state: 'executing', autonomous: true });
      await expect
        .poll(async () => (await jobCards(thread)).map((d) => d.state), { timeout: 30_000 })
        .toEqual(['confirmed']);
      const [card] = await jobCards(thread);
      const jobId = card?.result?.jobId;
      expect(typeof jobId).toBe('string');
      const job = await h.db.pool.query<{ state: string; project: string }>(
        'SELECT state::text AS state, project FROM jobs WHERE id = $1',
        [jobId],
      );
      // Dispatched: it left CREATED (here it fails at placement — the test machine runs no codex jobs).
      expect(job.rows[0]?.project).toBe('alpha');
      await expect
        .poll(
          async () =>
            (
              await h.db.pool.query<{ state: string }>(
                'SELECT state::text AS state FROM jobs WHERE id = $1',
                [jobId],
              )
            ).rows[0]?.state,
        )
        .not.toBe('CREATED');
      const audit = await directAudit(planId);
      expect(audit[0]).toMatchObject({
        outcome: 'success',
        metadata: {
          trigger: 'plan',
          planId,
          planVersion: 1,
          planItem: 'build',
          approvedBy: 'plan',
          kind: 'job',
        },
      });
      // The continuation was told the plan runs on its own.
      expect(seen[0]).toContain('AUTONOMOUS PLAN');
      expect(seen[0]).toContain('do not ask the user to confirm');
      const approve = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'chat.plan.approve' AND target = $1`,
        [`chat-plan:${planId}`],
      );
      expect(approve.rows[0]?.metadata).toMatchObject({ autonomous: true });
      // A card that ran by itself never tells the owner the plan waits for them.
      const waiting = await h.db.pool.query(
        'SELECT 1 FROM notifications WHERE recipient_id = $1 AND dedupe_key LIKE $2',
        [ownerId, `chat.plan:${planId}:waiting:%`],
      );
      expect(waiting.rows).toEqual([]);
    });

    it('a failure leads to another continuation and a retry; the third failure of the same item stops it', async () => {
      await expect
        .poll(
          async () => {
            await h.app.chatPlans.tick();
            return (await detail(thread)).messages.some(
              (m) => m.meta?.notice === 'plan-continue' && m.meta.reason === 'item_failed',
            );
          },
          { timeout: 90_000, interval: 300 },
        )
        .toBe(true);
      await idle(thread);
      const p = await plan(thread);
      expect(item(p, 'build')).toMatchObject({ status: 'blocked', failures: 3, awaitsUser: false });
      expect((await jobCards(thread)).map((d) => d.state)).toEqual(['confirmed', 'confirmed', 'confirmed']);
      // Each retry was a continuation naming the blocked item.
      expect(
        seen.filter((m) => /Engellenen madde: Derle build \(build\)/.test(m)).length,
      ).toBeGreaterThanOrEqual(2);
      // No fourth attempt by itself.
      await h.app.chatPlans.tick();
      await idle(thread);
      expect(await jobCards(thread)).toHaveLength(3);
      const note = await h.db.pool.query<{ title: string; link: string }>(
        `SELECT title, link, kind FROM notifications WHERE recipient_id = $1 AND dedupe_key LIKE $2`,
        [ownerId, `chat.plan:${planId}:blocked:build:capped:%`],
      );
      // p18-plan-mode W4: the plan's own notification kind (chat.plan).
      expect(note.rows).toEqual([
        { title: 'Plan engellendi: Derleme planı build', link: `/chat/${thread}`, kind: 'chat.plan' },
      ]);
      const capped = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'chat.plan.item_capped' AND target = $1`,
        [`chat-plan:${planId}`],
      );
      expect(capped.rowCount).toBe(1);
      // "Devam et" clears the count (the platform may retry again).
      expect((await owner.req('POST', `/chat/plans/${planId}/resume`)).statusCode).toBe(200);
      const left = await h.db.pool.query<{ failures: number }>(
        `SELECT failures FROM chat_plan_items WHERE plan_id = $1 AND key = 'build'`,
        [planId],
      );
      expect(left.rows[0]?.failures).toBe(0);
      await expect.poll(async () => (await jobCards(thread)).length, { timeout: 20_000 }).toBe(4);
      await owner.req('POST', `/chat/plans/${planId}/pause`);
      await idle(thread);
    });
  });

  it('approved with autonomous off → the draft stays a card ("Senden bekleniyor"); the ⋯ toggle is audited', async () => {
    const { thread, planId } = await planned('manual');
    const ok = await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1, autonomous: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<Plan>().autonomous).toBe(false);
    await expect
      .poll(async () => (await jobCards(thread)).map((d) => d.state), { timeout: 30_000 })
      .toEqual(['proposed']);
    await idle(thread);
    expect(item(await plan(thread), 'manual')).toMatchObject({ status: 'in_progress', awaitsUser: true });
    expect(await directAudit(planId)).toEqual([]);
    expect(seen.at(-1)).not.toContain('AUTONOMOUS PLAN');
    const on = await owner.req('POST', `/chat/plans/${planId}/autonomy`, { autonomous: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<Plan>().autonomous).toBe(true);
    const off = await owner.req('POST', `/chat/plans/${planId}/autonomy`, { autonomous: false });
    expect(off.json<Plan>().autonomous).toBe(false);
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'chat.plan.autonomy' AND target = $1 ORDER BY id`,
      [`chat-plan:${planId}`],
    );
    expect(audit.rows.map((r) => r.metadata.autonomous)).toEqual([true, false]);
    // The card made before stays a card (turning autonomy on runs nothing retroactively).
    await idle(thread);
    expect((await jobCards(thread)).map((d) => d.state)).toEqual(['proposed']);
    await owner.req('POST', `/chat/plans/${planId}/cancel`);
  });

  it('a plan paused before the draft → a card', async () => {
    const { thread, planId } = await planned('halt');
    expect((await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1 })).statusCode).toBe(200);
    await expect
      .poll(async () => (await jobCards(thread)).map((d) => d.state), { timeout: 30_000 })
      .toEqual(['proposed']);
    await idle(thread);
    expect((await plan(thread)).state).toBe('paused');
    expect(await directAudit(planId)).toEqual([]);
    await owner.req('POST', `/chat/plans/${planId}/cancel`);
  });

  it('a step that needs an authenticator code stays a card and the item waits', async () => {
    await h.setSecurityPolicy({ preset: 'serbest', events: { 'chat.cards': true } });
    try {
      const { thread, planId } = await planned('coded');
      await stepUp();
      expect((await owner.req('POST', `/chat/plans/${planId}/approve`, { version: 1 })).statusCode).toBe(200);
      await expect
        .poll(async () => (await jobCards(thread)).map((d) => d.state), { timeout: 30_000 })
        .toEqual(['proposed']);
      await idle(thread);
      expect(item(await plan(thread), 'coded')).toMatchObject({ status: 'in_progress', awaitsUser: true });
      const audit = await directAudit(planId);
      expect(audit.map((a) => [a.outcome, a.metadata.reason, a.metadata.trigger])).toEqual([
        ['denied', 'needs_code', 'plan'],
      ]);
      const tool = (await detail(thread)).messages.find(
        (m) => m.role === 'assistant' && m.content.startsWith('job '),
      );
      expect(tool?.content).toContain('authenticator code');
      // Nothing is due while the card waits: no further continuation.
      const before = seen.length;
      await h.app.chatPlans.tick();
      await idle(thread);
      expect(seen.length).toBe(before);
    } finally {
      await h.setSecurityPolicy({ preset: 'serbest' });
    }
  });
});
