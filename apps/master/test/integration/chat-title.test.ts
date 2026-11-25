import { FakeAssistantEngine, fakeToolData } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

/**
 * p17-chat-github Part 1 (docs/design/p17-chat-github.md §1) end to end: real master (Postgres), a real assistant
 * worker whose fake engine plays the model as rule 49 tells it to (it names the conversation only when the turn's
 * context carries the platform's "conversation title" block).
 *
 * - a meaningful first message: first words at once, the assistant's title replaces them, a notice in the thread;
 *   never again (a later call changes nothing);
 * - a greeting first: provisional, no request in turn 1; asked from the 3rd message on, retitled once, then never;
 * - a title the user set is never overwritten (no request; a call changes nothing);
 * - a provisional title the assistant never fixes is no longer asked about after the 5th message.
 */
const PW = 'quartz-meadow-lantern-7';

interface Message {
  id: string;
  seq: number;
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}

const TITLES: Record<string, string> = {
  name_from_first_message: '“Coolify deploy hatası.”',
  name_from_conversation: 'Nginx ters vekil yapılandırması',
};

describeIntegration(
  'conversation titles from meaning (integration, p17-chat-github)',
  { timeout: 180_000 },
  () => {
    const h = new Harness();
    const engine = new FakeAssistantEngine();
    const dirs: string[] = [];
    const workers: { stop(): Promise<void> }[] = [];
    let owner: Client;
    let ownerSecret = '';
    let url = '';
    /** Every set_chat_title result the "model" got. */
    const results: unknown[] = [];

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
      expect(r.statusCode, r.body).toBe(200);
    }

    async function detail(id: string): Promise<{ title: string; messages: Message[]; turn: unknown }> {
      const r = await owner.req('GET', `/chat/threads/${id}`);
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json<{ thread: { title: string }; messages: Message[]; turn: unknown }>();
      return { title: b.thread.title, messages: b.messages, turn: b.turn };
    }

    async function newThread(): Promise<string> {
      const r = await owner.req('POST', '/chat/threads', {});
      expect(r.statusCode, r.body).toBe(201);
      return r.json<{ id: string }>().id;
    }

    /** Sends a message, waits for the answer; returns the context the model got. */
    async function ask(thread: string, text: string): Promise<string> {
      const before = engine.sessions.reduce((n, s) => n + s.turns.length, 0);
      const r = await owner.req('POST', `/chat/threads/${thread}/messages`, { text });
      expect(r.statusCode, r.body).toBe(202);
      const sent = r.json<{ message: Message }>().message;
      await expect
        .poll(
          async () => {
            const d = await detail(thread);
            return d.turn === null && d.messages.some((m) => m.seq > sent.seq && m.role === 'assistant');
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const turns = engine.sessions.flatMap((s) => s.turns);
      expect(turns.length).toBe(before + 1);
      return turns.at(-1)?.context ?? '';
    }

    const notices = (all: Message[]) => all.filter((m) => m.meta?.notice === 'chat-title');

    // The model as rule 49 tells it: name the conversation only when asked; "zorla" makes it call anyway.
    engine.script(/[\s\S]*/, async ({ message, context, call }) => {
      // p18-plan-mode: the user asks for a name → requested: true ("yalan-istek": a model claiming
      // a request the message does not make).
      const named = /adını “(.+?)” yap/.exec(message)?.[1];
      if (named !== undefined || message.includes('yalan-istek')) {
        const r = await call('set_chat_title', { title: named ?? 'Uydurma ad', requested: true });
        results.push({ requested: true, isError: r.isError, data: fakeToolData(r.content) });
        return `Yanıt: ${message}`;
      }
      const ask = /"request": "(name_from_first_message|name_from_conversation)"/.exec(context ?? '')?.[1];
      if (ask !== undefined || message.includes('zorla')) {
        const r = await call('set_chat_title', {
          title: ask === undefined ? 'Zorla verilen ad' : TITLES[ask],
        });
        results.push(fakeToolData(r.content));
      }
      return `Yanıt: ${message}`;
    });

    beforeAll(async () => {
      await h.start({
        securityPolicy: { preset: 'serbest' },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      url = await h.listen();
      await h.createUser('owner.title', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner.title', PW));
      owner = await fullLogin(h, 'owner.title', PW, ownerSecret);
    });

    afterAll(async () => {
      await Promise.all(workers.map((w) => w.stop().catch(() => undefined)));
      await h.stop();
      await removeDirs(dirs);
    });

    it('sets up the assistant machine', async () => {
      await stepUp();
      const dir = await tempDataDir(dirs);
      const assistantId = await pairRealWorker(h, url, owner, ownerSecret, dir);
      workers.push(
        await runRealWorker(url, dir, { capabilities: CAPS, assistant: { engine, clock: h.clock.now } }),
      );
      await stepUp();
      const s = await owner.req('PUT', '/chat/settings', {
        enabled: true,
        workerId: assistantId,
        runtime: 'claude-code',
        modelProfile: null,
        expectedVersion: 1,
      });
      expect(s.statusCode, s.body).toBe(200);
      await expect
        .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
          timeout: 20_000,
        })
        .toBe(true);
    });

    it('names a conversation from the meaning of its first message, once, with a notice', async () => {
      const id = await newThread();
      expect((await detail(id)).title).toBe('New conversation');
      const ctx = await ask(id, 'Coolify deploy neden başarısız oldu, loglara bakar mısın?');
      expect(ctx).toContain('conversation title');
      expect(ctx).toContain('name_from_first_message');
      const d = await detail(id);
      // Quotes and the trailing period removed.
      expect(d.title).toBe('Coolify deploy hatası');
      const n = notices(d.messages);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({
        role: 'error',
        meta: {
          notice: 'chat-title',
          title: 'Coolify deploy hatası',
          from: expect.stringContaining('Coolify deploy neden') as unknown,
        },
      });
      expect(results.at(-1)).toEqual({ renamed: true, title: 'Coolify deploy hatası' });
      // The notice never reaches the model: the next turn's history has no rename sentence.
      const second = await ask(id, 'peki zorla yeniden adlandır');
      expect(second).not.toContain('conversation title');
      const turn = engine.sessions.flatMap((s) => s.turns).at(-1);
      expect(turn?.history ?? '').not.toContain('Conversation renamed');
      expect(results.at(-1)).toMatchObject({ renamed: false, title: 'Coolify deploy hatası' });
      expect((await detail(id)).title).toBe('Coolify deploy hatası');
      expect(notices((await detail(id)).messages)).toHaveLength(1);
    });

    it('a greeting first: provisional, retitled once from the conversation after the 3rd message', async () => {
      const id = await newThread();
      const first = await ask(id, 'merhaba');
      expect(first).not.toContain('conversation title');
      expect((await detail(id)).title).toBe('merhaba');
      const { rows } = await h.db.pool.query<{ title_source: string }>(
        'SELECT title_source FROM chat_threads WHERE id = $1',
        [id],
      );
      expect(rows[0]?.title_source).toBe('provisional');
      // The 3rd message: asked from the conversation so far.
      const third = await ask(id, 'nginx reverse proxy ayarını yapmam lazım');
      expect(third).toContain('name_from_conversation');
      const d = await detail(id);
      expect(d.title).toBe('Nginx ters vekil yapılandırması');
      expect(notices(d.messages)).toHaveLength(1);
      // Never again.
      const fifth = await ask(id, 'zorla başka bir ad ver');
      expect(fifth).not.toContain('conversation title');
      expect((await detail(id)).title).toBe('Nginx ters vekil yapılandırması');
    });

    it('never overwrites a title the user set', async () => {
      const id = await newThread();
      await ask(id, 'selam');
      const r = await owner.req('PATCH', `/chat/threads/${id}`, { title: 'Benim adım' });
      expect(r.statusCode, r.body).toBe(200);
      const ctx = await ask(id, 'zorla: veritabanı yedekleri nerede tutuluyor?');
      expect(ctx).not.toContain('conversation title');
      expect(results.at(-1)).toMatchObject({ renamed: false, title: 'Benim adım' });
      const d = await detail(id);
      expect(d.title).toBe('Benim adım');
      expect(notices(d.messages)).toHaveLength(0);
      // A conversation created with a title is the user's too.
      const named = await owner.req('POST', '/chat/threads', { title: 'Hazır ad' });
      expect(named.statusCode).toBe(201);
      const nid = named.json<{ id: string }>().id;
      const c2 = await ask(nid, 'Coolify uygulamasını yeniden başlat lütfen');
      expect(c2).not.toContain('conversation title');
      expect((await detail(nid)).title).toBe('Hazır ad');
    });

    it('stops asking after the 5th message when a provisional title was never fixed', async () => {
      const id = await newThread();
      await ask(id, 'hi');
      // The model ignores the request at the 3rd and 5th message (rows changed by hand to simulate it).
      await h.db.pool.query("UPDATE chat_threads SET title_source = 'provisional' WHERE id = $1", [id]);
      const engineCalls = results.length;
      await ask(id, 'hello again');
      await ask(id, 'still here');
      // 3rd and 5th were asked (the script answered, so the title was set): reset it to see the cut-off.
      expect(results.length).toBeGreaterThan(engineCalls);
      await h.db.pool.query(
        "UPDATE chat_threads SET title_source = 'provisional', title = 'hi' WHERE id = $1",
        [id],
      );
      const seventh = await ask(id, 'one more');
      expect(seventh).not.toContain('conversation title');
      expect((await detail(id)).title).toBe('hi');
    });

    it("renames on the user's own request (any title, audited, a notice); a claimed request without one is refused", async () => {
      const id = await newThread();
      const r = await owner.req('PATCH', `/chat/threads/${id}`, { title: 'Elle verilen ad' });
      expect(r.statusCode, r.body).toBe(200);
      await ask(id, 'bu sohbetin adını “Deploy notları” yap lütfen');
      const d = await detail(id);
      expect(d.title).toBe('Deploy notları');
      expect(notices(d.messages).at(-1)?.meta).toMatchObject({
        title: 'Deploy notları',
        from: 'Elle verilen ad',
      });
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'chat.thread.rename' AND target = $1`,
        [`chat-thread:${id}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ via: 'chat' });
      // Without a request in the message (and without the platform block) a call changes nothing.
      await ask(id, 'yalan-istek: veritabanı yedekleri nerede?');
      expect(results.at(-1)).toMatchObject({ requested: true, isError: true });
      expect((await detail(id)).title).toBe('Deploy notları');
    });
  },
);
