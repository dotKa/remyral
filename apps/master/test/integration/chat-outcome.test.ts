import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { AuditLog } from '../../src/audit/audit.js';
import { withTransaction } from '../../src/db/pool.js';
import {
  claimDelivery,
  completeDelivery,
  type DeliveryRef,
  fenceDelivery,
  noteDeliveryMessage,
} from '../../src/chat/deliveries.js';
import type { PlanChat } from '../../src/chat/plans.js';
import { resumeText } from '../../src/chat/goals.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { WatchChecks } from '../../src/chat/watch-checks.js';
import { FOLLOW_UP_CAP, WatchFollowUps } from '../../src/chat/watch-follow-up.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p20-outcome (docs/design/p20-outcome-contract.md) against a real master database: a goal ends in a result or in ONE
 * persistent intervention. A service that keeps crashing (its check watch ends unmet each time) until the follow-up cap
 * → one intervention card on "Senden bekleyen" and one notification; the assistant away past the reevaluate time → an
 * intervention too; "Devam ettir" / "Vazgeç" through the routes. The leased delivery outbox: a plan continuation claimed
 * and then "crashed" (the process died between the message and the turn) is delivered again after its lease — one turn,
 * its orphan message gone — and a slow sender whose lease ran out is fenced off (no second turn).
 */
const PW = 'quartz-meadow-lantern-7';

const h = new Harness();
let store: ChatStore;
let tools: ChatTools;
let opId = '';
let opSecret = '';
let op: Client;

async function caller(userId: string): Promise<ToolCaller> {
  const thread = (await store.createThread(userId, 'servis')).id;
  return {
    userId,
    subject: await loadSubject(h.db.pool, { id: userId, role: 'operator' }),
    threadId: thread,
    turnId: randomUUID(),
  };
}

async function insertJob(project: string): Promise<string> {
  const now = h.clock.now();
  const { rows } = await h.db.pool.query<{ id: string }>(
    `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                       created_at, updated_at, state_changed_at)
     VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', 'test', $3, $3, $3) RETURNING id::text AS id`,
    [project, JSON.stringify({ runtime: 'codex', prompt: 'Start the preview service' }), now],
  );
  return rows[0]?.id ?? '';
}

const setJobState = async (jobId: string, state: string): Promise<void> => {
  await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [jobId, state]);
};

const watchState = async (id: string) =>
  (await h.db.pool.query<{ state: string }>('SELECT state FROM chat_watches WHERE id = $1', [id])).rows[0]
    ?.state;

const followUp = async (id: string) =>
  (
    await h.db.pool.query<{ follow_up: string | null }>('SELECT follow_up FROM chat_watches WHERE id = $1', [
      id,
    ])
  ).rows[0]?.follow_up;

const goalNotes = async (goalId: string) =>
  (
    await h.db.pool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM notifications WHERE recipient_id = $1 AND dedupe_key LIKE $2`,
      [opId, `chat.goal:${goalId}:%`],
    )
  ).rows;

const threadTurns = async (threadId: string) =>
  Number(
    (
      await h.db.pool.query<{ n: string }>('SELECT count(*) AS n FROM chat_turns WHERE thread_id = $1', [
        threadId,
      ])
    ).rows[0]?.n,
  );

function created(out: Awaited<ReturnType<ChatTools['run']>>): { watchId: string } {
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error('refused');
  return out.data as never;
}

const engine = (): WatchChecks =>
  (h.app.chatWatches as unknown as { deps: { checks: WatchChecks } }).deps.checks;

describeIntegration('outcome contract (integration, p20-outcome)', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    await h.start({
      orchestration: { tickIntervalMs: 0 },
      watchChecks: { dryWaitMs: 300, queueTimeoutSec: 600 },
    });
    opId = await h.createUser('op1', PW, 'operator');
    ({ secret: opSecret } = await enroll(h, 'op1', PW));
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('alpha', 'alpha', now())");
    await h.grant(opId, ['alpha'], 'operator');
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
    // The ledger starts now: only records from here on are adopted.
    await h.app.chatGoals.tick();
    op = await fullLogin(h, 'op1', PW, opSecret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('a crashing service past the follow-up cap → ONE intervention card and ONE notification; the assistant away → intervention', async () => {
    const sent: { threadId: string; watchId: string }[] = [];
    const followUps = new WatchFollowUps({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      log: h.app.log,
      chat: () => ({
        idle: () => Promise.resolve(true),
        send: (_actor, threadId, _text, opts) => {
          sent.push({ threadId, watchId: opts.followUp.watchId });
          return Promise.resolve({ turnId: randomUUID() });
        },
      }),
    });
    const c = await caller(opId);
    const ids: string[] = [];
    // The service crashes each time; each follow-up starts it again with a new watch that fails again.
    for (let i = 0; i <= FOLLOW_UP_CAP; i++) {
      const job = await insertJob('alpha');
      const o = created(
        await tools.run(c, 'create_watch', {
          condition: { kind: 'job_state', jobId: job, states: ['succeeded'] },
          label: `onizleme ${String(i)}`,
        }),
      );
      await setJobState(job, 'FAILED');
      await expect.poll(async () => watchState(o.watchId), { timeout: 15_000 }).toBe('done');
      await followUps.tick();
      ids.push(o.watchId);
    }
    expect(await Promise.all(ids.map(followUp))).toEqual([
      ...Array.from({ length: FOLLOW_UP_CAP }, () => 'sent'),
      'skipped:cap',
    ]);
    // The outbox recorded each hand-off as sent with its turn.
    const { rows: deliveries } = await h.db.pool.query<{ state: string; turn_id: string | null }>(
      `SELECT state, turn_id::text AS turn_id FROM chat_deliveries WHERE kind = 'watch' AND ref_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(deliveries).toHaveLength(FOLLOW_UP_CAP);
    expect(deliveries.every((d) => d.state === 'sent' && d.turn_id !== null)).toBe(true);

    await h.app.chatGoals.tick();
    await h.app.chatGoals.tick();
    const cards = await h.app.chatGoals.list(opId, { state: 'intervention', threadId: c.threadId });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card).toMatchObject({
      origin: { kind: 'watch', id: ids[FOLLOW_UP_CAP] },
      blockedReason: 'follow_up_cap',
      owner: 'user',
      state: 'intervention',
      interventions: 1,
    });
    const capped = card?.id ?? '';
    // One notification and one note in the conversation, however often the ledger runs.
    await h.app.chatGoals.tick();
    expect(await goalNotes(capped)).toHaveLength(1);
    const notes = (await store.messages(c.threadId)).filter((m) => m.meta?.notice === 'goal-intervention');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.meta).toMatchObject({ goalId: capped, reason: 'follow_up_cap' });
    // The other three handed the conversation back to the assistant: it owns them, with a reevaluate time.
    const open = await h.app.chatGoals.list(opId, { state: 'open', threadId: c.threadId });
    expect(open).toHaveLength(FOLLOW_UP_CAP);
    expect(open.every((g) => g.owner === 'assistant' && g.reevaluateAt !== null)).toBe(true);
    // Nothing moved by the reevaluate time (no assistant machine here): each becomes an intervention, once.
    h.clock.advance(31 * 60_000);
    await h.app.chatGoals.tick();
    await h.app.chatGoals.tick();
    const all = await h.app.chatGoals.list(opId, { state: 'intervention', threadId: c.threadId });
    expect(all).toHaveLength(FOLLOW_UP_CAP + 1);
    expect(new Set(all.map((g) => g.id)).size).toBe(FOLLOW_UP_CAP + 1);
    for (const g of all.filter((x) => x.id !== capped)) {
      expect(g.blockedReason).toMatch(/^(assistant_unavailable|no_progress)$/);
      expect(await goalNotes(g.id)).toHaveLength(1);
    }

    // The routes: the caller's cards; "Vazgeç" closes one (a second time is refused); "Devam ettir" opens one again.
    // The clock moved past the session's idle limit above: sign in again.
    op = await fullLogin(h, 'op1', PW, opSecret);
    const listed = await op.req('GET', `/chat/goals?state=intervention&threadId=${c.threadId}`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ items: { id: string }[] }>().items).toHaveLength(FOLLOW_UP_CAP + 1);
    const cancel = await op.req('POST', `/chat/goals/${capped}/cancel`, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json()).toMatchObject({ state: 'cancelled' });
    expect((await op.req('POST', `/chat/goals/${capped}/cancel`, {})).statusCode).toBe(409);
    const other = all.find((g) => g.id !== capped)?.id ?? '';
    const resume = await op.req('POST', `/chat/goals/${other}/resume`, {});
    expect(resume.statusCode, resume.body).toBe(200);
    expect(resume.json()).toMatchObject({ state: 'open', owner: 'assistant', blockedReason: null });
    // Another user never sees it.
    const outsiderId = await h.createUser('op.other', PW, 'operator');
    await expect(h.app.chatGoals.get(outsiderId, other)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a plan continuation claimed then "crashed" is delivered again after its lease — one turn, no orphan message', async () => {
    const thread = await store.createThread(opId, 'plan');
    const planId = randomUUID();
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO chat_plans (id, thread_id, user_id, title, goal, state, version, rev, approved_version, cont_due,
                               created_at, updated_at)
       VALUES ($1, $2, $3, 'Sürüm 2.5', 'Önizlemeyi yayına al', 'executing', 1, 1, 1, true, $4, $4)`,
      [planId, thread.id, opId, now],
    );
    await h.db.pool.query(
      `INSERT INTO chat_plan_items (id, plan_id, key, phase, phase_title, position, title, status, owner, updated_at)
       VALUES ($1, $2, 'analiz', 0, 'Hazırlık', 0, 'Analiz', 'pending', 'assistant', $3)`,
      [randomUUID(), planId, now],
    );

    // The first attempt: claimed, its system message written (the chat service's message transaction) — and then the
    // process dies before the turn exists.
    const first = await claimDelivery(h.db.pool, {
      key: `plan:${planId}:${randomUUID()}`,
      kind: 'plan',
      refId: planId,
      threadId: thread.id,
      now,
    });
    expect(first).not.toBeNull();
    const crashed = first as DeliveryRef;
    await h.db.pool.query('UPDATE chat_plans SET cont_due = false WHERE id = $1', [planId]);
    await withTransaction(h.db.pool, async (tx) => {
      await fenceDelivery(tx, crashed, thread.id);
      const m = await store.addMessage(
        thread.id,
        {
          role: 'user',
          content: 'Onaylı plan v1 — sıradaki madde',
          meta: { origin: 'plan', delivery: crashed.key },
        },
        tx,
      );
      await noteDeliveryMessage(tx, crashed, m.id);
    });
    // While the lease runs nobody else claims the plan.
    expect(
      await claimDelivery(h.db.pool, {
        key: `plan:${planId}:${randomUUID()}`,
        kind: 'plan',
        refId: planId,
        threadId: thread.id,
        now,
      }),
    ).toBeNull();

    // The restarted master: a sender that behaves like the chat service (fence, message, then the turn and "sent" in
    // one transaction).
    const sends: string[] = [];
    const chat: PlanChat = {
      idle: () => Promise.resolve(true),
      planReady: () => Promise.resolve(true),
      send: async (actor, threadId, text, opts) => {
        const d = opts.delivery;
        if (d === undefined) throw new Error('a continuation without its claim');
        sends.push(d.key);
        const message = await withTransaction(h.db.pool, async (tx) => {
          await fenceDelivery(tx, d, threadId);
          const m = await store.addMessage(
            threadId,
            { role: 'user', content: text, meta: { origin: 'plan', delivery: d.key } },
            tx,
          );
          await noteDeliveryMessage(tx, d, m.id);
          return m;
        });
        const turnId = randomUUID();
        await withTransaction(h.db.pool, async (tx) => {
          await store.createTurn(
            {
              id: turnId,
              threadId,
              userId: actor.userId,
              workerId: 'wrk_test',
              runtime: 'claude',
              model: undefined,
              messageId: message.id,
            },
            tx,
          );
          await completeDelivery(tx, d, turnId, h.clock.now());
        });
        return { turnId };
      },
    };
    const deps = (h.app.chatPlans as unknown as { deps: { chat: () => PlanChat | null } }).deps;
    const realChat = deps.chat;
    deps.chat = () => chat;
    try {
      // Within the lease: nothing (the claim is still live, cont_due was taken).
      await h.app.chatPlans.tick();
      expect(sends).toHaveLength(0);
      // The lease ran out: expired, its orphan message removed, the plan due again and delivered once.
      h.clock.advance(3 * 60_000);
      await h.app.chatPlans.tick();
      expect(sends).toHaveLength(1);
      expect(await threadTurns(thread.id)).toBe(1);
      const delivered = (await store.messages(thread.id)).filter((m) => typeof m.meta?.delivery === 'string');
      expect(delivered.map((m) => m.meta?.delivery)).toEqual([sends[0]]);
      const { rows } = await h.db.pool.query<{ key: string; state: string; attempts: number }>(
        `SELECT key, state, attempts FROM chat_deliveries WHERE kind = 'plan' AND ref_id = $1 ORDER BY created_at, key`,
        [planId],
      );
      expect(Object.fromEntries(rows.map((r) => [r.key, r.state]))).toEqual({
        [crashed.key]: 'expired',
        [sends[0] ?? '']: 'sent',
      });
      const plan = await h.db.pool.query<{ cont_due: boolean; cont_turn: string | null }>(
        'SELECT cont_due, cont_turn::text AS cont_turn FROM chat_plans WHERE id = $1',
        [planId],
      );
      expect(plan.rows[0]?.cont_due).toBe(false);
      expect(plan.rows[0]?.cont_turn).not.toBeNull();

      // The slow first sender wakes up: fenced off — never a second turn.
      await expect(
        withTransaction(h.db.pool, (tx) => fenceDelivery(tx, crashed, thread.id)),
      ).rejects.toMatchObject({ code: 'delivery_superseded' });
      await expect(completeDelivery(h.db.pool, crashed, randomUUID(), h.clock.now())).rejects.toMatchObject({
        code: 'delivery_superseded',
      });
      // Later passes send nothing more (the continuation was delivered; nothing new is due).
      await h.app.chatPlans.tick();
      expect(sends).toHaveLength(1);
      expect(await threadTurns(thread.id)).toBe(1);
    } finally {
      deps.chat = realChat;
    }
  });

  it("p21-goal-check: the assistant's own reevaluate time gives it a check turn (at most twice), then the card", async () => {
    const thread = (await store.createThread(opId, 'seed')).id;
    const id = randomUUID();
    const now = h.clock.now();
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    await h.db.pool.query(
      `INSERT INTO chat_goals (id, user_id, thread_id, origin_kind, origin_id, title, outcome_condition, next_action,
         next_note, owner, reevaluate_at, state, detail, declared, opened_at, updated_at, last_progress_at)
       VALUES ($1, $2, $3, 'watch', $4, 'sample-site seed', 'seed SEED_TAMAM', 'assistant_turn',
         'seed servisinin kaydını kontrol et', 'assistant', $5, 'open', 'Servis henüz ayakta değil', true, $6, $6, $6)`,
      [id, opId, thread, randomUUID(), ago(1), ago(40)],
    );
    const goal = async () =>
      (
        await h.db.pool.query<{
          state: string;
          owner: string;
          next_action: string;
          blocked_reason: string | null;
          next_note: string | null;
          declared: boolean;
        }>(
          'SELECT state, owner, next_action, blocked_reason, next_note, declared FROM chat_goals WHERE id = $1',
          [id],
        )
      ).rows[0];
    // The assistant is reachable: its time ran out → its own check turn, no card.
    expect(await h.app.chatGoals.evaluate(id, true)).toBe(true);
    expect(await goal()).toMatchObject({
      state: 'open',
      owner: 'assistant',
      next_action: 'resume',
      blocked_reason: 'check_due',
      next_note: 'seed servisinin kaydını kontrol et',
      declared: true,
    });
    expect(await goalNotes(id)).toHaveLength(0);
    // The turn's text names the check and the recorded step, not the user's "Devam ettir".
    const text = resumeText(
      'tr',
      {
        id,
        title: 'sample-site seed',
        outcome: 'seed SEED_TAMAM',
        reason: 'check_due',
        nextNote: 'kaydı oku',
      },
      null,
    );
    expect(text).toContain('kendi kontrol zamanın geldi');
    expect(text).toContain('kaydı oku');
    expect(text).not.toContain('Devam ettir');
    // Held until its new reevaluate time.
    expect(await h.app.chatGoals.evaluate(id, true)).toBe(false);
    // Two check turns were already sent: the next overdue is the user's card.
    for (const n of [0, 1])
      await h.db.pool.query(
        `INSERT INTO chat_deliveries (key, kind, ref_id, thread_id, state, token, lease_until, created_at, updated_at, sent_at)
         VALUES ($1, 'goal', $2, $3, 'sent', $4, $5, $5, $5, $5)`,
        [`goal:${id}:check-${String(n)}`, id, thread, randomUUID(), now],
      );
    await h.db.pool.query(
      `UPDATE chat_goals SET reevaluate_at = $2, next_action = 'assistant_turn' WHERE id = $1`,
      [id, ago(1)],
    );
    expect(await h.app.chatGoals.evaluate(id, true)).toBe(true);
    expect(await goal()).toMatchObject({
      state: 'intervention',
      owner: 'user',
      blocked_reason: 'no_progress',
    });
    expect(await goalNotes(id)).toHaveLength(1);
  });
});
