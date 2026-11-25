import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatStore } from '../../src/chat/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-plans-ui (docs/design/p18-plan-mode.md, "Plans UI"): `GET /chat/plans` against a real master database — the
 * owner's plans across conversations with their figures and the overview counts, the filters (state, project, title
 * search), paging, the shared scope (read only, never "waits for you") and another user seeing nothing.
 */
const PW = 'amber-orchard-signal-42';

interface Row {
  id: string;
  threadId: string;
  threadTitle: string;
  role: string;
  title: string;
  state: string;
  needsYou: boolean;
  openDecisions: number;
  progress: { done: number; total: number };
  projects: string[];
}
interface Page {
  items: Row[];
  next: number | null;
  counts: Record<string, number>;
}

describeIntegration('plans list (integration)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let other: Client;
  let ownerId = '';
  let otherId = '';
  let store: ChatStore;
  const ids: Record<string, string> = {};
  const threads: Record<string, string> = {};

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 } });
    ownerId = await h.createUser('owner.plist', PW);
    owner = await fullLogin(h, 'owner.plist', PW, (await enroll(h, 'owner.plist', PW)).secret);
    otherId = await h.createUser('other.plist', PW);
    other = await fullLogin(h, 'other.plist', PW, (await enroll(h, 'other.plist', PW)).secret);
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });

    const make = async (name: string, title: string): Promise<void> => {
      const thread = (await store.createThread(ownerId, `Sohbet ${name}`)).id;
      threads[name] = thread;
      const out = await h.app.chatPlans.create(
        { userId: ownerId, threadId: thread, turnId: randomUUID(), planMode: true },
        {
          title,
          goal: 'Hedef',
          phases: [
            {
              title: 'Faz',
              items: [
                { key: 'a', title: 'Birinci', owner: 'assistant' },
                { key: 'b', title: 'Ikinci', owner: 'assistant', dependsOn: ['a'] },
              ],
            },
          ],
        },
      );
      expect(out.ok, JSON.stringify(out)).toBe(true);
      ids[name] = (out as { plan: { id: string } }).plan.id;
    };
    await make('review', 'Web sitesi %50 yenileme');
    await make('cancel', 'Eski göç planı');
    const cancel = await owner.req('POST', `/chat/plans/${ids.cancel ?? ''}/cancel`, {});
    expect(cancel.statusCode, cancel.body).toBe(200);
    // A project on the reviewed plan's conversation.
    await h.db.pool.query('UPDATE chat_threads SET project = $2 WHERE id = $1', [
      threads.review,
      'plist-alpha',
    ]);
    // The other user's own conversation with a plan, shared with the owner.
    const theirs = (await store.createThread(otherId, 'Paylaşılan sohbet')).id;
    const shared = await h.app.chatPlans.create(
      { userId: otherId, threadId: theirs, turnId: randomUUID(), planMode: true },
      {
        title: 'Paylaşılan plan',
        goal: 'g',
        phases: [{ title: 'F', items: [{ key: 'x', title: 'X', owner: 'assistant' }] }],
      },
    );
    expect(shared.ok, JSON.stringify(shared)).toBe(true);
    ids.shared = (shared as { plan: { id: string } }).plan.id;
    await h.db.pool.query(
      'INSERT INTO chat_thread_shares (thread_id, user_id, granted_by, created_at) VALUES ($1, $2, $3, now())',
      [theirs, ownerId, otherId],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  const list = async (c: Client, q = ''): Promise<Page> => {
    const r = await c.req('GET', `/chat/plans${q}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Page>();
  };

  describe('GET /chat/plans', () => {
    it('lists the owner’s plans with their figures and the overview', async () => {
      const page = await list(owner);
      expect(page.items.map((i) => i.id).sort()).toEqual([ids.review, ids.cancel].sort());
      const review = page.items.find((i) => i.id === ids.review);
      expect(review).toMatchObject({
        role: 'owner',
        state: 'in_review',
        threadId: threads.review,
        threadTitle: 'Sohbet review',
        needsYou: true,
        progress: { done: 0, total: 2 },
        projects: ['plist-alpha'],
      });
      expect(page.items.find((i) => i.id === ids.cancel)).toMatchObject({
        state: 'cancelled',
        needsYou: false,
      });
      expect(page.counts).toMatchObject({ total: 2, active: 1, review: 1, cancelled: 1, needsYou: 1 });
      expect(page.next).toBeNull();
    });

    it('filters by state, project and title (search text taken literally) and pages', async () => {
      expect((await list(owner, '?filter=cancelled')).items.map((i) => i.id)).toEqual([ids.cancel]);
      expect((await list(owner, '?filter=active')).items.map((i) => i.id)).toEqual([ids.review]);
      expect((await list(owner, '?project=plist-alpha')).items.map((i) => i.id)).toEqual([ids.review]);
      expect((await list(owner, `?q=${encodeURIComponent('%50')}`)).items.map((i) => i.id)).toEqual([
        ids.review,
      ]);
      expect((await list(owner, '?q=yok-boyle-bir-sey')).items).toEqual([]);
      const first = await list(owner, '?limit=1');
      expect(first.items).toHaveLength(1);
      expect(first.next).toBe(1);
      const second = await list(owner, '?limit=1&offset=1');
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(second.next).toBeNull();
    });

    it('shared plans are read only and never wait for the reader; another user sees only their own', async () => {
      const shared = await list(owner, '?scope=shared');
      expect(shared.items.map((i) => i.id)).toEqual([ids.shared]);
      expect(shared.items[0]).toMatchObject({ role: 'reader', needsYou: false });
      expect((await list(owner, '?scope=all')).items).toHaveLength(3);
      const theirs = await list(other);
      expect(theirs.items.map((i) => i.id)).toEqual([ids.shared]);
      expect(theirs.items[0]?.role).toBe('owner');
    });

    it('refuses bad parameters', async () => {
      for (const q of ['?filter=nope', '?scope=everyone', '?limit=0', '?project=bad%20id']) {
        const r = await owner.req('GET', `/chat/plans${q}`);
        expect(r.statusCode, q).toBe(400);
      }
    });
  });
});
