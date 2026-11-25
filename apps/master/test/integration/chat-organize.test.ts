import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ChatStore } from '../../src/chat/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';

interface ListItem {
  id: string;
  title: string;
  unreadCount: number;
  pinnedAt: string | null;
  groupId: string | null;
  tagIds: string[];
}
interface Group {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  threadCount: number;
}
interface Tag {
  id: string;
  name: string;
  color: string;
  threadCount: number;
}
interface Organize {
  groups: Group[];
  tags: Tag[];
  pinned: number;
}
interface Asset {
  kind: string;
  key: string;
  threadId: string;
  messageId: string | null;
  seq: number | null;
  label: string;
  url: string | null;
  href: string | null;
  domain: string | null;
  mediaType: string | null;
  source: string | null;
  draftKind: string | null;
  draftState: string | null;
  state: string | null;
}

/**
 * p10-chat-organize: pins, groups, tags and stars (CRUD, limits, privacy across users, rate limit) and the chat
 * sidebar's aggregation (starred, media, links, files, jobs) from messages, attachments, drafts and the jobs they made.
 */
describeIntegration('chat organisation and sidebar (integration, p10-chat-organize)', () => {
  let h: Harness;
  let store: ChatStore;
  let owner: Client;
  let ownerId: string;
  let other: Client;
  let otherId: string;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    ownerId = await h.createUser('owner1', PW);
    const { secret } = await enroll(h, 'owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, secret);
    otherId = await h.createUser('op.other', PW, 'operator');
    await h.grant(otherId, ['alpha'], 'operator');
    const { secret: s2 } = await enroll(h, 'op.other', PW);
    other = await fullLogin(h, 'op.other', PW, s2);
    await h.grant(ownerId, ['alpha', 'beta'], 'operator');
  });

  afterAll(async () => {
    await h.stop();
  });

  async function newThread(c: Client, title?: string): Promise<string> {
    const res = await c.req('POST', '/chat/threads', title === undefined ? {} : { title });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function list(c: Client, query = ''): Promise<{ items: ListItem[]; organize?: Organize }> {
    const res = await c.req('GET', `/chat/threads${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  type Res = Awaited<ReturnType<Client['req']>>;
  function ok(res: Res, code = 200): Res {
    expect(res.statusCode, res.body).toBe(code);
    return res;
  }

  async function assets(c: Client, kind: string, threadId: string | null, extra = ''): Promise<Asset[]> {
    const path =
      threadId === null ? `/chat/assets?kind=${kind}` : `/chat/threads/${threadId}/assets?kind=${kind}`;
    const res = await c.req('GET', `${path}${extra}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: Asset[] }>().items;
  }

  it('pins: section ordered by pin time, idempotent, limited, combined with the stream filters', async () => {
    const a = await newThread(owner, 'Pin A');
    const b = await newThread(owner, 'Pin B');
    const c = await newThread(owner, 'Pin C');
    h.clock.advance(1_000);
    const pa = ok(await owner.req('PUT', `/chat/threads/${a}/pin`, { pinned: true })).json<{
      pinnedAt: string;
    }>();
    h.clock.advance(1_000);
    ok(await owner.req('PUT', `/chat/threads/${c}/pin`, { pinned: true }));
    // Pinning again keeps the first pin time.
    h.clock.advance(1_000);
    const again = ok(await owner.req('PUT', `/chat/threads/${a}/pin`, { pinned: true })).json<{
      pinnedAt: string;
    }>();
    expect(again.pinnedAt).toBe(pa.pinnedAt);

    const pinned = await list(owner, '?pinned=true');
    expect(pinned.items.map((t) => t.id)).toEqual([c, a]);
    expect(pinned.organize?.pinned).toBe(2);
    const rest = await list(owner, '?pinned=false');
    expect(rest.items.map((t) => t.id)).toContain(b);
    expect(rest.items.map((t) => t.id)).not.toContain(a);
    // The default list is unchanged and carries the pin on each row.
    const all = await list(owner);
    expect(all.items.find((t) => t.id === a)?.pinnedAt).toBe(pa.pinnedAt);
    expect(all.items.find((t) => t.id === b)?.pinnedAt).toBeNull();
    // Search combines with the section.
    expect((await list(owner, '?pinned=true&q=Pin%20C')).items.map((t) => t.id)).toEqual([c]);

    ok(await owner.req('PUT', `/chat/threads/${c}/pin`, { pinned: false }));
    expect((await list(owner, '?pinned=true')).items.map((t) => t.id)).toEqual([a]);

    // At most 20 pins.
    const extra: string[] = [];
    for (let i = 0; i < 19; i++) extra.push(await newThread(owner, `Extra ${String(i)}`));
    for (const id of extra) ok(await owner.req('PUT', `/chat/threads/${id}/pin`, { pinned: true }));
    const over = await owner.req('PUT', `/chat/threads/${b}/pin`, { pinned: true });
    expect(over.statusCode, over.body).toBe(409);
    expect(over.json<{ error: string }>().error).toBe('too_many_pins');
    for (const id of extra) ok(await owner.req('PUT', `/chat/threads/${id}/pin`, { pinned: false }));
    // Bad input.
    expect((await owner.req('PUT', `/chat/threads/${a}/pin`, {})).statusCode).toBe(400);
    expect((await owner.req('PUT', `/chat/threads/${a}/pin`, { pinned: 'yes' })).statusCode).toBe(400);
  });

  it('groups: create, rename, collapse, move threads (one group each), delete ungroups', async () => {
    const g1 = ok(await owner.req('POST', '/chat/groups', { name: '  Deploys  ' }), 201).json<Group>();
    expect(g1).toMatchObject({ name: 'Deploys', position: 0, collapsed: false, threadCount: 0 });
    const g2 = ok(await owner.req('POST', '/chat/groups', { name: 'Research' }), 201).json<Group>();
    expect(g2.position).toBe(1);
    const dup = await owner.req('POST', '/chat/groups', { name: 'deploys' });
    expect(dup.statusCode).toBe(409);
    expect((await owner.req('POST', '/chat/groups', { name: '   ' })).statusCode).toBe(400);

    const t1 = await newThread(owner, 'Grouped 1');
    const t2 = await newThread(owner, 'Grouped 2');
    ok(await owner.req('PUT', `/chat/threads/${t1}/group`, { groupId: g1.id }));
    ok(await owner.req('PUT', `/chat/threads/${t2}/group`, { groupId: g1.id }));
    // Moving keeps one group per thread.
    ok(await owner.req('PUT', `/chat/threads/${t2}/group`, { groupId: g2.id }));
    expect((await list(owner, `?group=${g1.id}`)).items.map((t) => t.id)).toEqual([t1]);
    expect((await list(owner, `?group=${g2.id}`)).items.map((t) => t.id)).toEqual([t2]);
    const none = (await list(owner, '?group=none')).items.map((t) => t.id);
    expect(none).not.toContain(t1);
    expect(none).not.toContain(t2);
    const summary = ok(await owner.req('GET', '/chat/organize')).json<Organize>();
    expect(summary.groups.map((g) => [g.name, g.threadCount])).toEqual([
      ['Deploys', 1],
      ['Research', 1],
    ]);
    expect((await list(owner)).items.find((t) => t.id === t2)?.groupId).toBe(g2.id);

    const renamed = ok(
      await owner.req('PATCH', `/chat/groups/${g1.id}`, { name: 'Releases', collapsed: true, position: 5 }),
    ).json<Group>();
    expect(renamed).toMatchObject({ name: 'Releases', collapsed: true, position: 5, threadCount: 1 });
    expect((await owner.req('PATCH', `/chat/groups/${g1.id}`, {})).statusCode).toBe(400);

    // Ungroup, then delete a group: its threads become ungrouped, nothing else is deleted.
    ok(await owner.req('PUT', `/chat/threads/${t1}/group`, { groupId: null }));
    expect((await list(owner, '?group=none')).items.map((t) => t.id)).toContain(t1);
    expect((await owner.req('DELETE', `/chat/groups/${g2.id}`)).statusCode).toBe(204);
    expect((await list(owner)).items.find((t) => t.id === t2)?.groupId).toBeNull();
    expect((await owner.req('GET', `/chat/threads/${t2}`)).statusCode).toBe(200);
    expect((await owner.req('DELETE', `/chat/groups/${g2.id}`)).statusCode).toBe(404);
    expect((await owner.req('PUT', `/chat/threads/${t2}/group`, { groupId: g2.id })).statusCode).toBe(404);
  });

  it('tags: coloured, several per thread, filter, rename / recolour, delete removes them everywhere', async () => {
    const red = ok(await owner.req('POST', '/chat/tags', { name: 'urgent', color: 'red' }), 201).json<Tag>();
    const blue = ok(await owner.req('POST', '/chat/tags', { name: 'infra', color: 'blue' }), 201).json<Tag>();
    expect((await owner.req('POST', '/chat/tags', { name: 'x', color: '#f00' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/chat/tags', { name: 'URGENT', color: 'green' })).statusCode).toBe(409);

    const t = await newThread(owner, 'Tagged');
    const u = await newThread(owner, 'Tagged too');
    const set = ok(
      await owner.req('PUT', `/chat/threads/${t}/tags`, { tagIds: [red.id, blue.id, red.id] }),
    ).json<{ tagIds: string[] }>();
    expect(set.tagIds.sort()).toEqual([red.id, blue.id].sort());
    ok(await owner.req('PUT', `/chat/threads/${u}/tags`, { tagIds: [blue.id] }));
    expect((await list(owner, `?tag=${red.id}`)).items.map((x) => x.id)).toEqual([t]);
    expect((await list(owner, `?tag=${blue.id}`)).items.map((x) => x.id).sort()).toEqual([t, u].sort());
    // Tag + search combine.
    expect((await list(owner, `?tag=${blue.id}&q=too`)).items.map((x) => x.id)).toEqual([u]);
    const summary = ok(await owner.req('GET', '/chat/organize')).json<Organize>();
    expect(summary.tags.find((x) => x.id === blue.id)?.threadCount).toBe(2);

    const recoloured = ok(
      await owner.req('PATCH', `/chat/tags/${red.id}`, { name: 'p1', color: 'orange' }),
    ).json<Tag>();
    expect(recoloured).toMatchObject({ name: 'p1', color: 'orange', threadCount: 1 });
    // Replacing the set removes the others.
    ok(await owner.req('PUT', `/chat/threads/${t}/tags`, { tagIds: [red.id] }));
    expect((await list(owner)).items.find((x) => x.id === t)?.tagIds).toEqual([red.id]);
    expect((await owner.req('DELETE', `/chat/tags/${red.id}`)).statusCode).toBe(204);
    expect((await list(owner)).items.find((x) => x.id === t)?.tagIds).toEqual([]);
    // More than 10 tags on one thread are refused.
    const many = Array.from({ length: 11 }, () => randomUUID());
    expect((await owner.req('PUT', `/chat/threads/${t}/tags`, { tagIds: many })).statusCode).toBe(400);
  });

  it('stars: user and assistant messages only; ids in the thread view; starred tab jumps to the message', async () => {
    const t = await newThread(owner, 'Stars');
    const m1 = await store.addMessage(t, { role: 'user', content: 'Deploy the docs site please' });
    h.clock.advance(1_000);
    const m2 = await store.addMessage(t, {
      role: 'assistant',
      content: 'Done — https://docs.example.com/ is live.',
    });
    const tool = await store.addMessage(t, {
      role: 'tool',
      content: 'list_workers: 3',
      meta: { name: 'list_workers' },
    });
    ok(await owner.req('PUT', `/chat/messages/${m1.id}/star`, { starred: true }));
    h.clock.advance(1_000);
    const s2 = ok(await owner.req('PUT', `/chat/messages/${m2.id}/star`, { starred: true })).json<{
      starred: boolean;
      threadId: string;
    }>();
    expect(s2).toMatchObject({ starred: true, threadId: t });
    expect((await owner.req('PUT', `/chat/messages/${tool.id}/star`, { starred: true })).statusCode).toBe(
      400,
    );
    const detail = ok(await owner.req('GET', `/chat/threads/${t}`)).json<{ starred: string[] }>();
    expect(detail.starred.sort()).toEqual([m1.id, m2.id].sort());
    const starred = await assets(owner, 'starred', t);
    expect(starred.map((s) => [s.messageId, s.seq])).toEqual([
      [m2.id, m2.seq],
      [m1.id, m1.seq],
    ]);
    // Unstar is idempotent.
    ok(await owner.req('PUT', `/chat/messages/${m1.id}/star`, { starred: false }));
    ok(await owner.req('PUT', `/chat/messages/${m1.id}/star`, { starred: false }));
    expect((await assets(owner, 'starred', t)).map((s) => s.messageId)).toEqual([m2.id]);
    expect(
      (await owner.req('PUT', `/chat/messages/${randomUUID()}/star`, { starred: true })).statusCode,
    ).toBe(404);
  });

  it('keeps everything private: another user’s threads, messages, groups and tags are 404s and never mixed', async () => {
    const mine = await newThread(owner, 'Mine only');
    const msg = await store.addMessage(mine, {
      role: 'assistant',
      content: 'secret answer https://mine.example/',
    });
    const g = ok(await owner.req('POST', '/chat/groups', { name: 'Private group' }), 201).json<Group>();
    const tag = ok(
      await owner.req('POST', '/chat/tags', { name: 'private', color: 'pink' }),
      201,
    ).json<Tag>();
    const theirs = await newThread(other, 'Theirs');

    const nf = (res: { statusCode: number }) => {
      expect(res.statusCode).toBe(404);
    };
    nf(await other.req('PUT', `/chat/threads/${mine}/pin`, { pinned: true }));
    nf(await other.req('PUT', `/chat/threads/${mine}/group`, { groupId: null }));
    nf(await other.req('PUT', `/chat/threads/${mine}/tags`, { tagIds: [] }));
    nf(await other.req('PUT', `/chat/messages/${msg.id}/star`, { starred: true }));
    nf(await other.req('GET', `/chat/threads/${mine}/assets?kind=links`));
    nf(await other.req('PATCH', `/chat/groups/${g.id}`, { name: 'Hijacked' }));
    nf(await other.req('DELETE', `/chat/groups/${g.id}`));
    nf(await other.req('PATCH', `/chat/tags/${tag.id}`, { color: 'red' }));
    nf(await other.req('DELETE', `/chat/tags/${tag.id}`));
    // Their own thread cannot use my group or tag.
    nf(await other.req('PUT', `/chat/threads/${theirs}/group`, { groupId: g.id }));
    nf(await other.req('PUT', `/chat/threads/${theirs}/tags`, { tagIds: [tag.id] }));
    // Their summaries and the sidebar over all their conversations show none of mine.
    const theirOrganize = ok(await other.req('GET', '/chat/organize')).json<Organize>();
    expect(theirOrganize).toEqual({ groups: [], tags: [], pinned: 0 });
    expect(await assets(other, 'links', null)).toEqual([]);
    expect(await assets(other, 'starred', null)).toEqual([]);
    expect((await list(other, `?tag=${tag.id}`)).items).toEqual([]);
    expect((await list(other, `?group=${g.id}`)).items).toEqual([]);
    // The same group name is fine for another user.
    ok(await other.req('POST', '/chat/groups', { name: 'Private group' }), 201);
    // The database refuses a cross-user reference even without the service checks.
    await expect(
      h.db.pool.query(
        'INSERT INTO chat_thread_groups (thread_id, user_id, group_id, added_at) VALUES ($1, $2, $3, now())',
        [theirs, otherId, g.id],
      ),
    ).rejects.toThrow(/foreign key/);
    // Mine is untouched.
    const groups = ok(await owner.req('GET', '/chat/organize')).json<Organize>();
    expect(groups.groups.find((x) => x.id === g.id)?.name).toBe('Private group');
  });

  it('assistant mentions of conversations never read organisation (own threads only)', async () => {
    const res = await other.req('GET', '/chat/mentions?type=thread&q=Mine');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('aggregates links (deduplicated, with domain), media and files (attachments + job outputs) and jobs', async () => {
    const t = await newThread(owner, 'Assets');
    const u1 = await store.addMessage(t, {
      role: 'user',
      content:
        'See https://user:pw@example.com/a?x=1, and (https://example.com/a?x=1). Also javascript:alert(1)',
    });
    h.clock.advance(1_000);
    const a1 = await store.addMessage(t, {
      role: 'assistant',
      content: 'Docs: [guide](https://docs.example.org/guide). Again https://example.com/a?x=1.',
    });
    await store.addMessage(t, { role: 'tool', content: 'fetch https://tool.example/ignored' });

    const links = await assets(owner, 'links', t);
    expect(links.map((l) => [l.url, l.domain, l.messageId])).toEqual([
      ['https://docs.example.org/guide', 'docs.example.org', a1.id],
      ['https://example.com/a?x=1', 'example.com', a1.id],
    ]);
    expect(links.some((l) => l.url?.includes('pw@'))).toBe(false);

    // Attachments: an image (media) and a PDF (files), bound to a message.
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const pdf = Buffer.from('%PDF-1.4 test');
    const att = async (kind: string, name: string, type: string, body: Buffer): Promise<string> => {
      const id = randomUUID();
      await h.db.pool.query(
        `INSERT INTO chat_attachments (id, thread_id, user_id, message_id, kind, name, media_type, size_bytes, sha256,
                                       content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          t,
          ownerId,
          u1.id,
          kind,
          name,
          type,
          body.length,
          createHash('sha256').update(body).digest('hex'),
          body,
          h.clock.now(),
        ],
      );
      return id;
    };
    const img = await att('image', 'screen.png', 'image/png', png);
    const doc = await att('pdf', 'spec.pdf', 'application/pdf', pdf);

    // A confirmed job draft whose job produced an image and a markdown output; a dismissed automation draft;
    // a job in a project the owner can no longer read.
    const job = await insertJob('alpha');
    const hidden = await insertJob('gamma');
    const turnId = randomUUID();
    const d1 = await store.createDraft({
      threadId: t,
      userId: ownerId,
      turnId,
      kind: 'job',
      title: 'Build the docs',
      payload: { project: 'alpha' },
      project: 'alpha',
    });
    const anchor = await store.addMessage(t, {
      role: 'tool',
      content: 'create_job_draft: Build the docs',
      meta: { name: 'create_job_draft', isError: false, draftId: d1.id },
      turnId,
    });
    await store.decideDraft(d1.id, 'confirmed', { jobId: job, project: 'alpha', state: 'QUEUED' });
    h.clock.advance(1_000);
    const d2 = await store.createDraft({
      threadId: t,
      userId: ownerId,
      turnId,
      kind: 'automation',
      title: 'Nightly report',
      payload: {},
      project: 'alpha',
    });
    await store.decideDraft(d2.id, 'dismissed', null);
    await store.createDraft({
      threadId: t,
      userId: ownerId,
      turnId,
      kind: 'worker_config',
      title: 'Not work',
      payload: {},
      project: null,
    });
    await artifact(job, 'shot.png', 'image/png', png);
    await artifact(job, 'report.md', 'text/markdown', Buffer.from('# Report'));

    const media = await assets(owner, 'media', t);
    expect(media.map((m) => [m.label, m.source]).sort()).toEqual(
      [
        ['screen.png', 'attachment'],
        ['shot.png', 'artifact'],
      ].sort(),
    );
    const shot = media.find((m) => m.label === 'shot.png');
    expect(shot?.url).toBe(`/api/jobs/${job}/artifacts/ws-shot-png?inline=1`);
    expect(shot?.messageId).toBe(anchor.id);
    expect(media.find((m) => m.label === 'screen.png')?.url).toBe(`/api/chat/attachments/${img}/content`);

    const files = await assets(owner, 'files', t);
    expect(files.map((f) => f.label).sort()).toEqual(['report.md', 'spec.pdf']);
    expect(files.find((f) => f.label === 'spec.pdf')?.url).toBe(`/api/chat/attachments/${doc}/content`);

    const jobs = await assets(owner, 'jobs', t);
    expect(jobs.map((j) => j.label)).toEqual(['Nightly report', 'Build the docs']);
    const built = jobs.find((j) => j.label === 'Build the docs');
    expect(built).toMatchObject({
      draftKind: 'job',
      draftState: 'confirmed',
      state: 'RUNNING',
      href: `/jobs/${job}`,
      messageId: anchor.id,
    });
    expect(jobs.find((j) => j.label === 'Nightly report')).toMatchObject({
      draftState: 'dismissed',
      state: null,
      href: null,
    });

    // Live state follows the job.
    await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [job]);
    expect((await assets(owner, 'jobs', t)).find((j) => j.label === 'Build the docs')?.state).toBe(
      'SUCCEEDED',
    );

    // "All my conversations" includes this thread's items.
    expect((await assets(owner, 'media', null)).some((m) => m.label === 'shot.png')).toBe(true);

    // A project the caller cannot read (the operator is a member of alpha only): the draft is listed without its
    // live state or link, and the job's outputs are not.
    const theirs = await newThread(other, 'Elsewhere');
    const tid = randomUUID();
    const d3 = await store.createDraft({
      threadId: theirs,
      userId: otherId,
      turnId: tid,
      kind: 'job',
      title: 'Elsewhere',
      payload: {},
      project: 'gamma',
    });
    await store.decideDraft(d3.id, 'confirmed', { jobId: hidden });
    await artifact(hidden, 'hidden.png', 'image/png', png);
    expect(await assets(other, 'jobs', theirs)).toEqual([
      expect.objectContaining({ label: 'Elsewhere', draftState: 'confirmed', state: null, href: null }),
    ]);
    expect(await assets(other, 'media', theirs)).toEqual([]);
  });

  it('pages with an opaque cursor bound to the kind and scope', async () => {
    const t = await newThread(owner, 'Paging');
    for (let i = 0; i < 7; i++) {
      h.clock.advance(1_000);
      await store.addMessage(t, { role: 'assistant', content: `link https://p${String(i)}.example/` });
    }
    const first = await owner.req('GET', `/chat/threads/${t}/assets?kind=links&limit=3`);
    const p1 = ok(first).json<{ items: Asset[]; nextCursor: string | null }>();
    expect(p1.items.map((l) => l.domain)).toEqual(['p6.example', 'p5.example', 'p4.example']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = ok(
      await owner.req('GET', `/chat/threads/${t}/assets?kind=links&limit=3&cursor=${p1.nextCursor ?? ''}`),
    ).json<{ items: Asset[]; nextCursor: string | null }>();
    expect(p2.items.map((l) => l.domain)).toEqual(['p3.example', 'p2.example', 'p1.example']);
    const p3 = ok(
      await owner.req('GET', `/chat/threads/${t}/assets?kind=links&limit=3&cursor=${p2.nextCursor ?? ''}`),
    ).json<{ items: Asset[]; nextCursor: string | null }>();
    expect(p3.items.map((l) => l.domain)).toEqual(['p0.example']);
    expect(p3.nextCursor).toBeNull();
    // A cursor of another kind / scope is refused.
    const wrong = await owner.req('GET', `/chat/assets?kind=links&cursor=${p1.nextCursor ?? ''}`);
    expect(wrong.statusCode).toBe(400);
    expect((await owner.req('GET', `/chat/threads/${t}/assets?kind=nope`)).statusCode).toBe(400);
  });

  it('rate limits organisation writes per user', async () => {
    const t = await newThread(other, 'Limited');
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) {
      const res = await other.req('PUT', `/chat/threads/${t}/pin`, { pinned: i % 2 === 0 });
      if (res.statusCode === 429) limited = true;
      else expect(res.statusCode, res.body).toBe(200);
    }
    expect(limited).toBe(true);
  });

  async function insertJob(project: string): Promise<string> {
    const now = h.clock.now();
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING',
      [project, now],
    );
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                         created_at, updated_at, state_changed_at)
       VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', 'test', $3, $3, $3) RETURNING id::text AS id`,
      [project, JSON.stringify({ runtime: 'codex', prompt: 'x' }), now],
    );
    return rows[0]?.id ?? '';
  }

  async function artifact(jobId: string, name: string, mediaType: string, content: Buffer): Promise<void> {
    const id = `ws-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind, redacted,
                                  content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, $8, $9)`,
      [
        randomUUID(),
        jobId,
        id,
        name,
        mediaType,
        content.length,
        createHash('sha256').update(content).digest('hex'),
        content,
        h.clock.now(),
      ],
    );
  }
});
