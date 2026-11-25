import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ChatStore, type MessageRole } from '../../src/chat/store.js';
import { migrate } from '../../src/db/migrate.js';
import { createTestDatabase, describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';

interface ListItem {
  id: string;
  title: string;
  archived: boolean;
  unreadCount: number;
}

/**
 * p9-chat-unread: per user read position of a conversation. Counting rules (assistant answers and master notes
 * and failed answers count; the user's own messages and tool lines never do), the idempotent / monotonic mark-read
 * endpoint, "mark all", the unread summary, authorization (threads are private: another user's thread is a 404,
 * CSRF required, rate limited) and the migration's backfill.
 */
describeIntegration('chat unread state (integration, p9-chat-unread)', () => {
  let h: Harness;
  let store: ChatStore;
  let owner: Client;
  let other: Client;
  let viewer: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    await h.createUser('owner1', PW);
    const { secret } = await enroll(h, 'owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, secret);
    const otherId = await h.createUser('op.other', PW, 'operator');
    await h.grant(otherId, ['alpha'], 'operator');
    const { secret: s2 } = await enroll(h, 'op.other', PW);
    other = await fullLogin(h, 'op.other', PW, s2);
    const viewerId = await h.createUser('viewer.one', PW, 'viewer');
    await h.grant(viewerId, ['alpha'], 'viewer');
    const { secret: s3 } = await enroll(h, 'viewer.one', PW);
    viewer = await fullLogin(h, 'viewer.one', PW, s3);
  });

  afterAll(async () => {
    await h.stop();
  });

  async function newThread(c: Client): Promise<string> {
    const res = await c.req('POST', '/chat/threads', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function add(threadId: string, role: MessageRole, meta?: Record<string, unknown>): Promise<number> {
    const m = await store.addMessage(threadId, { role, content: `${role} text`, ...(meta ? { meta } : {}) });
    return m.seq;
  }

  async function list(c: Client, archived = false): Promise<ListItem[]> {
    const res = await c.req('GET', `/chat/threads${archived ? '?archived=true' : ''}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: ListItem[] }>().items;
  }

  async function unreadOf(c: Client, id: string): Promise<number | undefined> {
    return (await list(c)).find((t) => t.id === id)?.unreadCount;
  }

  async function summary(c: Client): Promise<{ total: number; threads: number }> {
    const res = await c.req('GET', '/chat/unread');
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it('counts answers, notes and failures since the last read; never the user’s own messages or tool lines', async () => {
    const id = await newThread(owner);
    expect(await unreadOf(owner, id)).toBe(0);
    await add(id, 'user');
    expect(await unreadOf(owner, id)).toBe(0);
    await add(id, 'tool', { name: 'list_workers', isError: false });
    expect(await unreadOf(owner, id)).toBe(0);
    await add(id, 'assistant');
    await add(id, 'assistant', { notice: 'chat-watch', watchId: randomUUID(), event: 'finished' });
    await add(id, 'error', { reason: 'engine_failed' });
    expect(await unreadOf(owner, id)).toBe(3);
    expect(await summary(owner)).toMatchObject({ total: 3, threads: 1 });

    // Marking read clears it; a later note makes it unread again; the user's own reply does not.
    const read = await owner.req('POST', `/chat/threads/${id}/read`, {});
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ threadId: id, lastReadSeq: 5, unreadCount: 0 });
    expect(await unreadOf(owner, id)).toBe(0);
    await add(id, 'user');
    expect(await unreadOf(owner, id)).toBe(0);
    await add(id, 'assistant', { notice: 'chat-watch', event: 'failed' });
    expect(await unreadOf(owner, id)).toBe(1);
    await owner.req('POST', `/chat/threads/${id}/read`, {});
  });

  it('mark read is idempotent, monotonic and clamped to the last message', async () => {
    const id = await newThread(owner);
    await add(id, 'user'); // 1
    await add(id, 'assistant'); // 2
    await add(id, 'assistant'); // 3
    await add(id, 'assistant'); // 4
    // Read up to the message the client has rendered (2): two answers stay unread.
    const r1 = await owner.req('POST', `/chat/threads/${id}/read`, { seq: 2 });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ lastReadSeq: 2, unreadCount: 2 });
    const at = r1.json<{ lastReadAt: string }>().lastReadAt;
    // Same call again: nothing changes (also the timestamp).
    h.clock.advance(5_000);
    const r2 = await owner.req('POST', `/chat/threads/${id}/read`, { seq: 2 });
    expect(r2.json()).toMatchObject({ lastReadSeq: 2, unreadCount: 2, lastReadAt: at });
    // Going back is ignored.
    const r3 = await owner.req('POST', `/chat/threads/${id}/read`, { seq: 1 });
    expect(r3.json()).toMatchObject({ lastReadSeq: 2, unreadCount: 2 });
    // Beyond the end is clamped to the last message.
    const r4 = await owner.req('POST', `/chat/threads/${id}/read`, { seq: 1_000 });
    expect(r4.json()).toMatchObject({ lastReadSeq: 4, unreadCount: 0 });
    expect(r4.json<{ lastReadAt: string }>().lastReadAt).not.toBe(at);
    // Bad input.
    expect((await owner.req('POST', `/chat/threads/${id}/read`, { seq: -1 })).statusCode).toBe(400);
    expect((await owner.req('POST', `/chat/threads/${id}/read`, { seq: 'x' })).statusCode).toBe(400);
    expect((await owner.req('POST', `/chat/threads/${id}/read`, { other: 1 })).statusCode).toBe(400);
    // An empty thread: read at 0.
    const empty = await newThread(owner);
    const r5 = await owner.req('POST', `/chat/threads/${empty}/read`, {});
    expect(r5.statusCode, r5.body).toBe(200);
    expect(r5.json()).toMatchObject({ lastReadSeq: 0, unreadCount: 0 });
  });

  it('keeps read state private: another user’s thread is a 404 and their reads never touch mine', async () => {
    const mine = await newThread(owner);
    await add(mine, 'assistant');
    const theirs = await newThread(other);
    await add(theirs, 'assistant');
    expect((await other.req('POST', `/chat/threads/${mine}/read`, {})).statusCode).toBe(404);
    expect((await owner.req('POST', `/chat/threads/${theirs}/read`, {})).statusCode).toBe(404);
    expect((await owner.req('POST', `/chat/threads/${randomUUID()}/read`, {})).statusCode).toBe(404);
    expect(await unreadOf(owner, mine)).toBe(1);
    expect(await unreadOf(other, theirs)).toBe(1);
    // The list never shows someone else's thread; "mark all" only touches the caller's.
    expect((await list(owner)).some((t) => t.id === theirs)).toBe(false);
    const all = await other.req('POST', '/chat/threads/read-all', {});
    expect(all.statusCode, all.body).toBe(200);
    expect(await unreadOf(owner, mine)).toBe(1);
    expect(await unreadOf(other, theirs)).toBe(0);
    // No row for another user's thread was created.
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chat_thread_reads r JOIN chat_threads t ON t.id = r.thread_id
        WHERE r.user_id <> t.user_id`,
    );
    expect(rows[0]?.n).toBe(0);
    // Viewers use the chat too (chat.use).
    const v = await newThread(viewer);
    await add(v, 'assistant');
    expect(await unreadOf(viewer, v)).toBe(1);
    expect((await viewer.req('POST', `/chat/threads/${v}/read`, {})).statusCode).toBe(200);
  });

  it('needs a session and the CSRF token', async () => {
    const id = await newThread(owner);
    const anon = h.client();
    expect((await anon.req('POST', `/chat/threads/${id}/read`, {})).statusCode).toBe(401);
    expect((await anon.req('GET', '/chat/unread')).statusCode).toBe(401);
    const noCsrf = owner.clone();
    noCsrf.sendCsrf = false;
    expect((await noCsrf.req('POST', `/chat/threads/${id}/read`, {})).statusCode).toBe(403);
    expect((await noCsrf.req('POST', '/chat/threads/read-all', {})).statusCode).toBe(403);
  });

  it('mark all as read, the summary leaves archived conversations out, the list still shows their count', async () => {
    await owner.req('POST', '/chat/threads/read-all', {});
    expect(await summary(owner)).toEqual({ total: 0, threads: 0 });
    const a = await newThread(owner);
    const b = await newThread(owner);
    const c = await newThread(owner);
    await add(a, 'assistant');
    await add(b, 'assistant');
    await add(b, 'assistant');
    await add(c, 'assistant');
    expect((await owner.req('PATCH', `/chat/threads/${c}`, { archived: true })).statusCode).toBe(200);
    expect(await summary(owner)).toEqual({ total: 3, threads: 2 });
    expect((await list(owner, true)).find((t) => t.id === c)?.unreadCount).toBe(1);
    const all = await owner.req('POST', '/chat/threads/read-all', {});
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json<{ updated: number }>().updated).toBeGreaterThanOrEqual(3);
    expect(await summary(owner)).toEqual({ total: 0, threads: 0 });
    expect((await list(owner, true)).find((t) => t.id === c)?.unreadCount).toBe(0);
    // Idempotent: nothing left to update.
    expect((await owner.req('POST', '/chat/threads/read-all', {})).json()).toEqual({ updated: 0 });
  });

  it('caps a conversation’s count at 100', async () => {
    const id = await newThread(owner);
    for (let i = 0; i < 105; i++) await add(id, 'assistant');
    expect(await unreadOf(owner, id)).toBe(100);
    await owner.req('POST', `/chat/threads/${id}/read`, {});
  });

  it('deleting a conversation removes its read rows', async () => {
    const id = await newThread(owner);
    await add(id, 'assistant');
    await owner.req('POST', `/chat/threads/${id}/read`, {});
    expect((await owner.req('DELETE', `/chat/threads/${id}`)).statusCode).toBe(204);
    const { rows } = await h.db.pool.query('SELECT 1 FROM chat_thread_reads WHERE thread_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('rate limits read updates per user', async () => {
    const id = await newThread(other);
    let limited = 0;
    for (let i = 0; i < 26; i++) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, () => other.req('POST', `/chat/threads/${id}/read`, {})),
      );
      limited += batch.filter((r) => r.statusCode === 429).length;
    }
    expect(limited).toBeGreaterThan(0);
    const res = await other.req('POST', `/chat/threads/${id}/read`, {});
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    // Another user is not affected.
    const mine = await newThread(owner);
    expect((await owner.req('POST', `/chat/threads/${mine}/read`, {})).statusCode).toBe(200);
  });
});

describeIntegration('chat unread migration (integration, p9-chat-unread)', () => {
  it('starts existing conversations fully read', async () => {
    const all = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const files = (await readdir(all)).filter((f) => f.endsWith('.sql')).sort();
    const target = files.find((f) => f.endsWith('_chat_unread.sql'));
    expect(target).toBeDefined();
    const before = await mkdtemp(join(tmpdir(), 'remyral-unread-mig-'));
    const db = await createTestDatabase({ migrated: false });
    try {
      for (const f of files.filter((f) => f < (target as string)))
        await copyFile(join(all, f), join(before, f));
      await migrate(db.pool, { dir: before });
      const userId = randomUUID();
      await db.pool.query(
        `INSERT INTO users (id, username, role, password_hash, created_at, updated_at)
         VALUES ($1, 'mig.user', 'owner', '$scrypt$x', now(), now())`,
        [userId],
      );
      const threadId = randomUUID();
      await db.pool.query(
        `INSERT INTO chat_threads (id, user_id, title, created_at, updated_at, next_seq)
         VALUES ($1, $2, 'Old', now(), now(), 4)`,
        [threadId, userId],
      );
      for (const [seq, role] of [
        [1, 'user'],
        [2, 'assistant'],
        [3, 'assistant'],
      ] as const) {
        await db.pool.query(
          `INSERT INTO chat_messages (id, thread_id, seq, role, content, created_at)
           VALUES ($1, $2, $3, $4, 'x', now())`,
          [randomUUID(), threadId, seq, role],
        );
      }
      await migrate(db.pool, { dir: all });
      const { rows } = await db.pool.query<{ last_read_seq: number }>(
        'SELECT last_read_seq FROM chat_thread_reads WHERE thread_id = $1 AND user_id = $2',
        [threadId, userId],
      );
      expect(rows).toEqual([{ last_read_seq: 3 }]);
      const store = new ChatStore({ pool: db.pool, clock: () => new Date() });
      expect((await store.listThreads(userId))[0]?.unreadCount).toBe(0);
      expect(await store.unreadSummary(userId)).toEqual({ total: 0, threads: 0 });
    } finally {
      await db.drop();
      await rm(before, { recursive: true, force: true });
    }
  });
});
