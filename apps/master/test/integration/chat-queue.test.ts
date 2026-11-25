import { randomUUID } from 'node:crypto';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
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

const PW = 'quartz-meadow-lantern-7';

interface Message {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  meta: Record<string, unknown> | null;
  turnId: string | null;
}
interface Queued {
  id: string;
  content: string;
  holdReason: string | null;
}
interface Detail {
  messages: Message[];
  turn: { id: string; state: string } | null;
  queued?: Queued[];
}

/**
 * p22-chat-queue (docs/design/p22-chat-queue.md): a message the owner writes while the assistant is answering waits in
 * the queue and is delivered — together with the others that waited, as ONE turn whose input is their texts in order —
 * when the running turn ends; exactly once (concurrent ends, the sweep after a restart). Real worker transport, fake
 * engine (`[[slow MS]]` keeps a turn open).
 */
describeIntegration('chat message queue (p22-chat-queue)', { timeout: 120_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerId = '';
  let secret: string;
  const dirs: string[] = [];
  const engine = new FakeAssistantEngine();
  let worker: RunningWorker | undefined;

  async function newThread(): Promise<string> {
    const res = await owner.req('POST', '/chat/threads', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function detail(id: string): Promise<Detail> {
    const res = await owner.req('GET', `/chat/threads/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Detail>();
  }

  async function settled(id: string, assistants: number): Promise<Detail> {
    let d: Detail | undefined;
    await expect
      .poll(
        async () => {
          d = await detail(id);
          return d.turn === null && d.messages.filter((m) => m.role === 'assistant').length >= assistants;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    return d as Detail;
  }

  function lastEngineMessage(): string | undefined {
    return engine.sessions.flatMap((s) => s.turns).at(-1)?.message;
  }

  async function turnCount(threadId: string): Promise<number> {
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chat_turns WHERE thread_id = $1',
      [threadId],
    );
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      chat: { sweepIntervalMs: 0 },
    });
    url = await h.listen();
    ownerId = await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
  });

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('queues a message written during a turn and delivers two queued messages as one turn after it', async () => {
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const dir = await tempDataDir(dirs);
    const workerId = await pairRealWorker(h, url, owner, secret, dir);
    worker = await runRealWorker(url, dir, { capabilities: CAPS, assistant: { engine, clock: h.clock.now } });
    h.clock.advance(30_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const put = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect(put.statusCode, put.body).toBe(200);
    await expect
      .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);

    const thread = await newThread();
    const first = await owner.req('POST', `/chat/threads/${thread}/messages`, {
      text: '[[slow 2500]] first',
      queue: true,
    });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json<{ turnId?: string }>().turnId).toEqual(expect.any(String));

    // Without `queue` (older consoles, system callers): unchanged 409.
    const refused = await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'no queue' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe('turn_in_progress');

    const second = await owner.req('POST', `/chat/threads/${thread}/messages`, {
      text: 'second',
      queue: true,
    });
    expect(second.statusCode, second.body).toBe(202);
    const q2 = second.json<{ queued?: Queued; message?: Message }>();
    expect(q2.message).toBeUndefined();
    expect(q2.queued?.content).toBe('second');
    const third = await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'third', queue: true });
    expect(third.statusCode, third.body).toBe(202);

    // Shown in the thread at once (a reload / another device sees it), not as a message yet.
    const during = await detail(thread);
    expect(during.queued?.map((q) => q.content)).toEqual(['second', 'third']);
    expect(during.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '[[slow 2500]] first',
    ]);

    const after = await settled(thread, 2);
    expect(after.queued).toEqual([]);
    // Each queued message is its own row, after the first answer; ONE turn answered both (its input: both texts).
    expect(
      after.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.role),
    ).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    const users = after.messages.filter((m) => m.role === 'user');
    expect(users.map((m) => m.content)).toEqual(['[[slow 2500]] first', 'second', 'third']);
    expect(users[2]?.meta).toMatchObject({ queued: true, origin: 'user', queuedWith: [users[1]?.id] });
    expect(lastEngineMessage()).toBe('second\n\nthird');
    expect(after.messages.at(-1)?.content).toContain('Echo: second\n\nthird');
    expect(await turnCount(thread)).toBe(2);
    const { rows } = await h.db.pool.query<{ state: string; n: number; turns: number }>(
      `SELECT state, count(*)::int AS n, count(DISTINCT turn_id)::int AS turns FROM chat_queued_messages
        WHERE thread_id = $1 GROUP BY state`,
      [thread],
    );
    expect(rows).toEqual([{ state: 'delivered', n: 2, turns: 1 }]);
    const audit = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.message.queue_delivered'",
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('edits and removes a queued message before delivery; a delivered one can no longer be changed', async () => {
    const thread = await newThread();
    expect(
      (await owner.req('POST', `/chat/threads/${thread}/messages`, { text: '[[slow 2500]] go', queue: true }))
        .statusCode,
    ).toBe(202);
    const x = (
      await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'drop me', queue: true })
    ).json<{ queued: Queued }>().queued;
    const y = (
      await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'keep me', queue: true })
    ).json<{ queued: Queued }>().queued;
    expect((await owner.req('DELETE', `/chat/threads/${thread}/queued/${x.id}`)).statusCode).toBe(204);
    const edited = await owner.req('PATCH', `/chat/threads/${thread}/queued/${y.id}`, {
      text: 'kept and edited',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<Queued>().content).toBe('kept and edited');
    expect((await detail(thread)).queued?.map((q) => q.content)).toEqual(['kept and edited']);

    const after = await settled(thread, 2);
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '[[slow 2500]] go',
      'kept and edited',
    ]);
    expect(lastEngineMessage()).toBe('kept and edited');
    const late = await owner.req('DELETE', `/chat/threads/${thread}/queued/${y.id}`);
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: string }>().error).toBe('message_not_queued');
    expect((await owner.req('DELETE', `/chat/threads/${thread}/queued/${x.id}`)).statusCode).toBe(409);
  });

  it('a stop ("Şimdi gönder") ends the turn and delivers what waited', async () => {
    const thread = await newThread();
    expect(
      (
        await owner.req('POST', `/chat/threads/${thread}/messages`, {
          text: '[[slow 20000]] long',
          queue: true,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (await owner.req('POST', `/chat/threads/${thread}/messages`, { text: 'now please', queue: true }))
        .statusCode,
    ).toBe(202);
    expect((await owner.req('POST', `/chat/threads/${thread}/cancel`, {})).statusCode).toBe(202);
    const after = await settled(thread, 1);
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '[[slow 20000]] long',
      'now please',
    ]);
    expect(lastEngineMessage()).toBe('now please');
  });

  it('delivers exactly once when two turn-end handlers race', async () => {
    const thread = await newThread();
    const now = h.clock.now();
    for (const text of ['one', 'two']) {
      await h.db.pool.query(
        `INSERT INTO chat_queued_messages (id, thread_id, user_id, content, meta, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '{"origin":"user"}', 'queued', $5, $5)`,
        [randomUUID(), thread, ownerId, text, now],
      );
    }
    const turns = engine.sessions.flatMap((s) => s.turns).length;
    const results = await Promise.all([
      h.app.chat.drainQueues(),
      h.app.chat.drainQueues(),
      h.app.chat.drainQueues(),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    const after = await settled(thread, 1);
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['one', 'two']);
    expect(await turnCount(thread)).toBe(1);
    expect(engine.sessions.flatMap((s) => s.turns).length).toBe(turns + 1);
    expect(lastEngineMessage()).toBe('one\n\ntwo');
    // Nothing more on the next pass.
    expect(await h.app.chat.drainQueues()).toBe(0);
  });

  it('the sweep delivers messages left waiting by a stopped master, after the quiet window', async () => {
    const thread = await newThread();
    const now = h.clock.now();
    // A turn that just ended (its end handler died with the process): the sweep waits the quiet window first.
    await h.db.pool.query(
      `INSERT INTO chat_turns (id, thread_id, user_id, worker_id, runtime, state, reason, created_at, finished_at)
       SELECT $1, $2, $3, id, 'claude-code', 'failed', 'lost', $4, $4 FROM workers LIMIT 1`,
      [randomUUID(), thread, ownerId, now],
    );
    await h.db.pool.query(
      `INSERT INTO chat_queued_messages (id, thread_id, user_id, content, meta, state, created_at, updated_at)
       VALUES ($1, $2, $3, 'left waiting', '{"origin":"user"}', 'queued', $4, $4)`,
      [randomUUID(), thread, ownerId, now],
    );
    await h.app.chat.sweep();
    expect((await detail(thread)).queued?.map((q) => q.content)).toEqual(['left waiting']);
    h.clock.advance(15_000);
    await h.app.chat.sweep();
    const after = await settled(thread, 1);
    expect(after.queued).toEqual([]);
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['left waiting']);
    expect(lastEngineMessage()).toBe('left waiting');
  });
});
