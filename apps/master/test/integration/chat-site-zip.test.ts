import { createHash, randomUUID } from 'node:crypto';
import { FakeAssistantEngine, fakeToolData } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatSiteUploads } from '../../src/chat/site-uploads.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

/**
 * p15-chat-zip (docs/design/p15-chat-zip.md) end to end: real master (Postgres), a real assistant worker whose fake
 * engine plays the model as rule 34 tells it to, and the local fake Cloudflare. The console's part (unpacking the .zip
 * in the browser) is done here by uploading the files through the ordinary site-upload API, exactly as the chip does.
 *
 * - a message carrying a site upload: linked to the message, its facts on the message, the fenced block (upload id,
 *   files, index.html at the root) in the turn's context;
 * - "cloudflare'da yayınla": publish_site_upload runs at once (no card), the preview publish runs by the deploy policy
 *   and the live link is posted into the conversation when Cloudflare finishes;
 * - production waits for ONE approval (auto mode off) — after it the link arrives too; with auto mode it runs at once;
 * - oss-sec3: the .zip's file paths reach the model, so the first publish per environment is a card the person confirms
 *   with "remember"; later publishes of that project and environment run at once;
 * - a .zip that is not a site travels as a note only; someone else's upload is 404; retention keeps an upload a
 *   waiting publish needs.
 */
const PW = 'quartz-meadow-lantern-7';
const SITE = 'zipsite';
const OTHER = 'zipother';

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
  held?: { reason: string; rememberable: boolean };
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const UPLOAD_RE = /"uploadId":\s*"([0-9a-f-]{36})"/;

describeIntegration(
  'a .zip in the chat published on Cloudflare (integration, p15-chat-zip)',
  { timeout: 240_000 },
  () => {
    const h = new Harness();
    const cf = new FakeCloudflare();
    const engine = new FakeAssistantEngine();
    const dirs: string[] = [];
    const workers: { stop(): Promise<void> }[] = [];
    let url = '';
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let other: Client;

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
      expect(r.statusCode, r.body).toBe(200);
    }

    /** What the chip does after unpacking: start → parts → complete; returns the upload id. */
    async function upload(c: Client, project: string, label: string): Promise<string> {
      // Distinct creation times: retention keeps the newest uploads of a project by time.
      h.clock.advance(1_000);
      const files = [
        {
          path: 'index.html',
          content: Buffer.from(`<!doctype html><title>${label}</title><h1>${label}</h1>`),
        },
        { path: 'assets/app.css', content: Buffer.from('body{margin:0}') },
      ];
      const s = await c.req('POST', `/projects/${project}/site-uploads`, {
        files: files.map((f) => ({ path: f.path, size: f.content.length, sha256: sha(f.content) })),
        label,
      });
      expect(s.statusCode, s.body).toBe(201);
      const up = s.json<{ id: string; partSize: number; partCount: number }>();
      const all = Buffer.concat(files.map((f) => f.content));
      for (let n = 0; n < up.partCount; n++) {
        const part = all.subarray(n * up.partSize, (n + 1) * up.partSize);
        const r = await c.req('PUT', `/projects/${project}/site-uploads/${up.id}/parts/${String(n)}`, part, {
          'content-type': 'application/octet-stream',
          'x-part-sha256': sha(part),
        });
        expect(r.statusCode, r.body).toBe(200);
      }
      const done = await c.req('POST', `/projects/${project}/site-uploads/${up.id}/complete`, {});
      expect(done.statusCode, done.body).toBe(200);
      return up.id;
    }

    async function detail(
      c: Client,
      id: string,
    ): Promise<{ messages: Message[]; drafts: Draft[]; turn: unknown }> {
      const r = await c.req('GET', `/chat/threads/${id}`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    }

    async function newThread(c: Client): Promise<string> {
      const r = await c.req('POST', '/chat/threads', {});
      expect(r.statusCode, r.body).toBe(201);
      return r.json<{ id: string }>().id;
    }

    /** Sends a message and waits for the end of its turn. */
    async function ask(
      c: Client,
      thread: string,
      body: Record<string, unknown>,
    ): Promise<{ sent: Message; reply: string }> {
      const r = await c.req('POST', `/chat/threads/${thread}/messages`, body);
      expect(r.statusCode, r.body).toBe(202);
      const sent = r.json<{ message: Message }>().message;
      let last: Message | undefined;
      await expect
        .poll(
          async () => {
            const d = await detail(c, thread);
            // The publish note may land before or after the answer (a preview publish can finish within the turn).
            last = d.messages
              .filter(
                (m) =>
                  m.seq > sent.seq &&
                  (m.role === 'assistant' || m.role === 'error') &&
                  m.meta?.notice !== 'site-publish',
              )
              .at(-1);
            return d.turn === null && last !== undefined;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      return { sent, reply: (last as Message).content };
    }

    async function publishOf(thread: string): Promise<{ id: string; state: string; env: string | null }> {
      const { rows } = await h.db.pool.query<{ id: string; state: string; env: string | null }>(
        `SELECT id::text AS id, state, env FROM ops_actions
        WHERE kind = 'pages.publish' AND source->>'chatThreadId' = $1 ORDER BY created_at DESC LIMIT 1`,
        [thread],
      );
      const a = rows[0];
      if (a === undefined) throw new Error('no publish');
      return a;
    }

    async function poll(): Promise<void> {
      h.clock.advance(20_000);
      await h.app.ops.pollDeploying();
    }

    // The model, as rule 34 tells it to behave: the upload id from the message's context, publish at once.
    engine.script(/^cloudflare'da yayınla/i, async ({ call, context }) => {
      const id = UPLOAD_RE.exec(context ?? '')?.[1];
      if (id === undefined) return 'no upload in the context';
      const r = await call('publish_site_upload', { uploadId: id });
      return `Publish: ${r.content}`;
    });
    engine.script(/^canlıda yayınla/i, async ({ call, context }) => {
      const id = UPLOAD_RE.exec(context ?? '')?.[1];
      if (id === undefined) return 'no upload in the context';
      const r = await call('publish_site_upload', { uploadId: id, env: 'production' });
      return `Publish: ${r.content}`;
    });
    engine.script(/^yüklediklerim/i, async ({ call }) => {
      const r = await call('list_site_uploads', {});
      return `List: ${r.content}`;
    });

    beforeAll(async () => {
      await cf.start();
      await h.start({
        // As the owner's deployment: commands run at once; auto mode off so production waits for an approval.
        securityPolicy: { preset: 'serbest', autonomy: { autoMode: false } },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
        ops: {
          internalOrigins: [cf.base],
          cloudflareApi: `${cf.base}/client/v4`,
          limits: { perProjectPer10Min: 200 },
        },
      });
      url = await h.listen();
      ownerId = await h.createUser('owner.zip', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner.zip', PW));
      owner = await fullLogin(h, 'owner.zip', PW, ownerSecret);
      const otherId = await h.createUser('op.other', PW, 'operator');
      other = await fullLogin(h, 'op.other', PW, (await enroll(h, 'op.other', PW)).secret);
      for (const id of [SITE, OTHER]) {
        await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [id]);
      }
      await h.grant(otherId, [OTHER], 'operator');
      cf.pagesProjects.set('zip-main', {
        name: 'zip-main',
        production_branch: 'main',
        domains: [],
        deployments: [],
      });
      await stepUp();
      expect(
        (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
          .statusCode,
      ).toBe(200);
      for (const project of [SITE, OTHER]) {
        const t = await owner.req('PUT', `/projects/${project}/deploy-targets`, {
          targets: { pages: { projectName: 'zip-main' } },
        });
        expect(t.statusCode, t.body).toBe(200);
      }
    });
    afterAll(async () => {
      await Promise.all(workers.map((w) => w.stop().catch(() => undefined)));
      await h.stop();
      await cf.stop();
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

    it('"cloudflare\'da yayınla" with a dropped site .zip: linked to the message, published at once, live link posted', async () => {
      const uploadId = await upload(owner, SITE, 'deck.zip');
      const thread = await newThread(owner);
      const { sent, reply } = await ask(owner, thread, {
        text: "cloudflare'da yayınla",
        siteUploads: [uploadId],
      });
      // The message keeps the facts; the upload is linked to it.
      expect(sent.meta?.siteUploads).toEqual([
        {
          id: uploadId,
          project: SITE,
          label: 'deck.zip',
          fileCount: 2,
          totalBytes: expect.any(Number) as unknown,
          indexAtRoot: true,
          files: ['index.html', 'assets/app.css'],
          moreFiles: 0,
        },
      ]);
      const link = await h.db.pool.query<{ chat_thread_id: string; chat_message_id: string }>(
        'SELECT chat_thread_id::text, chat_message_id::text FROM site_uploads WHERE id = $1',
        [uploadId],
      );
      expect(link.rows[0]).toEqual({ chat_thread_id: thread, chat_message_id: sent.id });
      // The model saw the fenced block: upload id, project, files, index.html at the root.
      const ctx = engine.sessions.flatMap((s) => s.turns).at(-1)?.context ?? '';
      expect(ctx).toContain('site upload of this message');
      expect(ctx).toContain(uploadId);
      expect(ctx).toMatch(/"indexAtRoot": true/);
      expect(ctx).toContain('assets/app.css');
      // oss-sec3: the file paths of the .zip reached the model (untrusted content), so the first publish is a card;
      // the person confirms it and ticks "remember" — the preview publish then runs by the deploy policy.
      expect(reply).toContain('untrustedContent');
      const held = (await detail(owner, thread)).drafts;
      expect(held.map((x) => [x.kind, x.state])).toEqual([['ops_action', 'proposed']]);
      expect(held[0]?.held).toEqual({ reason: 'untrusted_content', rememberable: true });
      const ok = await owner.req('POST', `/chat/drafts/${held[0]?.id ?? ''}/confirm`, { remember: true });
      expect(ok.statusCode, ok.body).toBe(200);
      const d = (await detail(owner, thread)).drafts;
      expect(d.map((x) => [x.kind, x.state])).toEqual([['ops_action', 'confirmed']]);
      const pub = await publishOf(thread);
      expect(pub.env).toBe('preview');
      if (pub.state !== 'succeeded') await poll();
      expect((await publishOf(thread)).state).toBe('succeeded');
      // The live link arrives in the conversation.
      await expect
        .poll(async () =>
          (await detail(owner, thread)).messages.find((m) => m.meta?.notice === 'site-publish'),
        )
        .toMatchObject({
          role: 'assistant',
          content: expect.stringMatching(
            /^Published \(preview, zipsite\): https:\/\/\S+\.pages\.dev/,
          ) as unknown,
          meta: { opsActionId: pub.id, state: 'succeeded' },
        });
      expect(cf.pagesProjects.get('zip-main')?.deployments.length).toBeGreaterThanOrEqual(1);
      // One note only, even when the poller looks again.
      await poll();
      const notes = (await detail(owner, thread)).messages.filter((m) => m.meta?.notice === 'site-publish');
      expect(notes).toHaveLength(1);
      // Remembered: the next dropped .zip of this project is published to preview at once (no card).
      const again = await upload(owner, SITE, 'deck2.zip');
      const t2 = await newThread(owner);
      const r2 = await ask(owner, t2, { text: "cloudflare'da yayınla", siteUploads: [again] });
      expect(r2.reply).toContain('executed');
      expect(r2.reply).not.toContain('NOT executed');
      expect((await detail(owner, t2)).drafts.map((x) => [x.kind, x.state])).toEqual([
        ['ops_action', 'confirmed'],
      ]);
    });

    it('production waits for ONE approval (auto mode off); after it the link is posted; with auto mode it runs at once', async () => {
      const uploadId = await upload(owner, SITE, 'prod.zip');
      const thread = await newThread(owner);
      const { reply } = await ask(owner, thread, { text: 'canlıda yayınla', siteUploads: [uploadId] });
      // oss-sec3: production is another target than the remembered preview — a card first, confirmed with "remember".
      expect(reply).toContain('untrustedContent');
      const card = (await detail(owner, thread)).drafts[0];
      expect(card?.held?.reason).toBe('untrusted_content');
      const confirmed = await owner.req('POST', `/chat/drafts/${card?.id ?? ''}/confirm`, { remember: true });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const pub = await publishOf(thread);
      expect(pub).toMatchObject({ state: 'awaiting_approval', env: 'production' });
      // Retention keeps an upload a waiting publish needs (the newest 5 per project otherwise).
      for (let i = 0; i < 5; i++) await upload(owner, SITE, `filler-${String(i)}.zip`);
      const kept = await h.db.pool.query('SELECT 1 FROM site_uploads WHERE id = $1', [uploadId]);
      expect(kept.rowCount).toBe(1);
      await stepUp();
      const ok = await owner.req('POST', `/deploy/actions/${pub.id}/approve`, {});
      expect(ok.statusCode, ok.body).toBe(200);
      if ((await publishOf(thread)).state !== 'succeeded') await poll();
      expect((await publishOf(thread)).state).toBe('succeeded');
      await expect
        .poll(async () =>
          (await detail(owner, thread)).messages.find((m) => m.meta?.notice === 'site-publish'),
        )
        .toMatchObject({ content: expect.stringContaining('Published (production, zipsite)') as unknown });

      // Auto mode (the owner's default): production runs at once, approved via the security policy.
      await h.setSecurityPolicy({ preset: 'serbest', autonomy: { autoMode: true } });
      const auto = await upload(owner, SITE, 'auto.zip');
      const t2 = await newThread(owner);
      const r2 = await ask(owner, t2, { text: 'canlıda yayınla', siteUploads: [auto] });
      expect(r2.reply).toContain('executed');
      const p2 = await publishOf(t2);
      expect(p2.state).not.toBe('awaiting_approval');
      await h.setSecurityPolicy({ preset: 'serbest', autonomy: { autoMode: false } });
    });

    it('a .zip that is not a site travels as a note only; the model is told it cannot be published', async () => {
      const thread = await newThread(owner);
      const { sent } = await ask(owner, thread, {
        text: '',
        archives: [{ name: 'notes.zip', fileCount: 3, totalBytes: 1200, problems: ['no_index'] }],
      });
      expect(sent.meta?.archives).toEqual([
        { name: 'notes.zip', fileCount: 3, totalBytes: 1200, problems: ['no_index'] },
      ]);
      const turn = engine.sessions.flatMap((s) => s.turns).at(-1);
      expect(turn?.message).toContain('notes.zip');
      expect(turn?.context ?? '').toContain('not a site and not uploaded');
      expect(turn?.context ?? '').toContain('there is no index.html at its root');
      // Malformed notes are refused by the schema.
      const bad = await owner.req('POST', `/chat/threads/${thread}/messages`, {
        text: 'x',
        archives: [{ name: 'a/b.zip', fileCount: 1, totalBytes: 1, problems: [] }],
      });
      expect(bad.statusCode).toBe(400);
    });

    it('someone else’s upload, an unknown id or one still receiving is "not found"; nothing is linked', async () => {
      const mine = await upload(owner, SITE, 'mine.zip');
      const t = await newThread(other);
      for (const id of [mine, randomUUID()]) {
        const r = await other.req('POST', `/chat/threads/${t}/messages`, {
          text: 'publish',
          siteUploads: [id],
        });
        expect(r.statusCode, r.body).toBe(404);
        expect(r.json<{ error: string }>().error).toBe('upload_not_found');
      }
      const receiving = await owner.req('POST', `/projects/${SITE}/site-uploads`, {
        files: [{ path: 'index.html', size: 3, sha256: sha(Buffer.from('abc')) }],
      });
      expect(receiving.statusCode, receiving.body).toBe(201);
      const ot = await newThread(owner);
      const r = await owner.req('POST', `/chat/threads/${ot}/messages`, {
        text: 'x',
        siteUploads: [receiving.json<{ id: string }>().id],
      });
      expect(r.statusCode).toBe(404);
      const link = await h.db.pool.query('SELECT chat_message_id FROM site_uploads WHERE id = $1', [mine]);
      expect(link.rows[0]).toEqual({ chat_message_id: null });
    });

    it('tools: list_site_uploads (attached here first) and publish_site_upload refusals', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        ops: () => h.app.ops,
        siteUploads: () => new ChatSiteUploads({ db: h.db.pool }),
      } as unknown as ChatToolsDeps);
      const thread = await store.createThread(ownerId, 'zips');
      const c: ToolCaller = {
        userId: ownerId,
        subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
      const id = await upload(owner, SITE, 'here.zip');
      await h.db.pool.query('UPDATE site_uploads SET chat_thread_id = $2 WHERE id = $1', [id, thread.id]);
      const list = await tools.run(c, 'list_site_uploads', { limit: 3 });
      expect(list.ok, JSON.stringify(list)).toBe(true);
      const data = (list.ok ? list.data : {}) as { uploads: Record<string, unknown>[] };
      expect(data.uploads[0]).toMatchObject({
        uploadId: id,
        project: SITE,
        name: 'here.zip',
        indexAtRoot: true,
        attachedInThisConversation: true,
      });
      expect(data.uploads).toHaveLength(3);
      // A draft (card) for the upload's own project; nothing is requested until it runs.
      const draft = await tools.run(c, 'publish_site_upload', { uploadId: id, domain: 'x.example.test' });
      expect(draft.ok, JSON.stringify(draft)).toBe(true);
      expect(draft.ok ? draft.data : null).toMatchObject({
        kind: 'ops_action',
        action: 'pages.publish',
        project: SITE,
      });
      // Unknown / invisible uploads, unknown fields.
      expect(await tools.run(c, 'publish_site_upload', { uploadId: randomUUID() })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      expect(await tools.run(c, 'publish_site_upload', { uploadId: id, token: 'x' })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
      const otherSubject = await loadSubject(h.db.pool, {
        id: (await h.db.pool.query<{ id: string }>("SELECT id::text FROM users WHERE username = 'op.other'"))
          .rows[0]?.id as string,
        role: 'operator',
      });
      const oc: ToolCaller = { ...c, subject: otherSubject, userId: otherSubject.userId };
      expect(await tools.run(oc, 'publish_site_upload', { uploadId: id })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      const otherList = await tools.run(oc, 'list_site_uploads', {});
      expect(JSON.stringify(otherList)).not.toContain(id);
      expect(await tools.run(oc, 'list_site_uploads', { project: SITE })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      // Nothing the assistant sees holds the Cloudflare token.
      expect(JSON.stringify([list, draft])).not.toContain(cf.token);
    });

    it('the list tool answers through the assistant too (fenced, ids for the next turn)', async () => {
      const thread = await newThread(owner);
      const { reply } = await ask(owner, thread, { text: 'yüklediklerim neler' });
      const data = fakeToolData(reply.replace(/^List: /, '')) as { uploads: unknown[] } | null;
      expect(data?.uploads.length).toBeGreaterThan(0);
    });
  },
);
