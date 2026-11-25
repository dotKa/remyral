import { randomUUID } from 'node:crypto';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { ChatStore } from '../../src/chat/store.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
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
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

interface Message {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  meta: Record<string, unknown> | null;
  turnId: string | null;
  supersededAt?: string;
  supersededBy?: string;
}
interface Draft {
  id: string;
  kind: string;
  title: string;
  state: string;
  project: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  restricted?: boolean;
}
interface Detail {
  thread: { id: string; title: string };
  messages: Message[];
  drafts: Draft[];
  turn: unknown;
  access?: 'owner' | 'reader';
  owner?: { id: string; username: string } | null;
}

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md) with a real worker on fake engines (Claude Code + Codex): edit
 * forks the conversation, regenerate with another engine / model, retry, the replay rule (409 turn_acted, then
 * acknowledged), export (Markdown / JSON, redacted, cards' final state), sharing read-only with per-reader card
 * permissions, handing over (audited), and the assistant's read_job_log / read_job_diff / list_site_upload_files.
 */
describeIntegration(
  'ops chat: edit / regenerate / retry, export, share (p16-chat-complete)',
  { timeout: 180_000 },
  () => {
    let h: Harness;
    let url: string;
    let owner: Client;
    let ownerSecret: string;
    let ownerId = '';
    let op: Client;
    let opId = '';
    let reader: Client;
    let readerId = '';
    const dirs: string[] = [];
    let worker: RunningWorker | undefined;
    let workerId = '';
    const claude = new FakeAssistantEngine('claude-code');
    const codex = new FakeAssistantEngine('codex');
    let alphaJob = '';
    let betaJob = '';

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    }

    async function detail(c: Client, t: string): Promise<Detail> {
      const res = await c.req('GET', `/chat/threads/${t}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Detail>();
    }

    async function idle(c: Client, t: string): Promise<void> {
      await expect.poll(async () => (await detail(c, t)).turn, { timeout: 30_000 }).toBeNull();
    }

    async function newThread(c: Client = owner): Promise<string> {
      const res = await c.req('POST', '/chat/threads', {});
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }

    const current = (d: Detail): Message[] => d.messages.filter((m) => m.supersededAt === undefined);

    /** Sends and waits for the turn's end (answer or error line). */
    async function ask(
      c: Client,
      t: string,
      text: string,
      body: Record<string, unknown> = {},
    ): Promise<Message> {
      const res = await c.req('POST', `/chat/threads/${t}/messages`, { text, ...body });
      expect(res.statusCode, res.body).toBe(202);
      await idle(c, t);
      const last = current(await detail(c, t))
        .filter((m) => m.role === 'assistant' || m.role === 'error')
        .at(-1);
      expect(last).toBeDefined();
      return last as Message;
    }

    async function answered(c: Client, t: string, n: number): Promise<Message[]> {
      await expect
        .poll(async () => current(await detail(c, t)).filter((m) => m.role === 'assistant').length, {
          timeout: 30_000,
        })
        .toBe(n);
      await idle(c, t);
      return current(await detail(c, t));
    }

    beforeAll(async () => {
      h = new Harness();
      await h.start({
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      url = await h.listen();
      ownerId = await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      opId = await h.createUser('op.alpha', PW, 'operator');
      await h.grant(opId, ['alpha'], 'operator');
      const { secret: opSecret } = await enroll(h, 'op.alpha', PW);
      op = await fullLogin(h, 'op.alpha', PW, opSecret);
      readerId = await h.createUser('viewer.beta', PW, 'viewer');
      await h.grant(readerId, ['beta'], 'viewer');
      const { secret: readerSecret } = await enroll(h, 'viewer.beta', PW);
      reader = await fullLogin(h, 'viewer.beta', PW, readerSecret);

      const audit = new AuditLog(h.db.pool, h.clock.now);
      const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
      const creator: JobActor = { type: 'user', id: opId };
      const spec = (prompt: string, branch: string) => ({
        runtime: 'codex',
        prompt,
        repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: branch },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      });
      alphaJob = (
        await jobs.create({
          project: 'alpha',
          actor: creator,
          submit: true,
          spec: spec('Fix the flake', 'w/a'),
        })
      ).job.id;
      await h.grant(ownerId, ['beta'], 'operator');
      betaJob = (
        await jobs.create({
          project: 'beta',
          actor: { type: 'user', id: ownerId },
          submit: true,
          spec: spec('Beta work', 'w/b'),
        })
      ).job.id;
    });

    afterAll(async () => {
      await worker?.stop().catch(() => undefined);
      await h.stop();
      await removeDirs(dirs);
    });

    it('sets up the assistant with two engines; the status names the ready ones', async () => {
      await stepUp();
      const dataDir = await tempDataDir(dirs);
      workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
      worker = await runRealWorker(url, dataDir, {
        capabilities: CAPS,
        assistant: { engine: claude, clock: h.clock.now, extraEngines: { codex } },
      });
      await stepUp();
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
      const s = (await owner.req('GET', '/chat/status')).json<{ engines: string[] }>();
      expect([...s.engines].sort()).toEqual(['claude-code', 'codex']);
    });

    it('edit forks the conversation: later rows are superseded, the model history ends before the edit', async () => {
      const t = await newThread();
      await ask(owner, t, 'first question');
      await ask(owner, t, 'second question');
      const before = await detail(owner, t);
      const first = before.messages.find((m) => m.role === 'user' && m.content === 'first question');
      expect(first).toBeDefined();
      const edited = await owner.req('POST', `/chat/threads/${t}/messages/${first?.id ?? ''}/edit`, {
        text: 'first question, rephrased',
      });
      expect(edited.statusCode, edited.body).toBe(202);
      const all = await answered(owner, t, 1);
      expect(all.map((m) => [m.role, m.role === 'user' ? m.content : ''])).toEqual([
        ['user', 'first question, rephrased'],
        ['assistant', ''],
      ]);
      expect(all[0]?.meta?.editOf).toBe(first?.id);
      const d = await detail(owner, t);
      const old = d.messages.filter((m) => m.supersededAt !== undefined);
      expect(old).toHaveLength(4);
      expect(old.every((m) => m.supersededBy === all[0]?.id)).toBe(true);
      // The model saw no history: the edit replaced the first message.
      const turn = claude.sessions.flatMap((s) => s.turns).at(-1);
      expect(turn?.message).toBe('first question, rephrased');
      expect(turn?.history ?? '').not.toContain('second question');
      // A superseded message cannot be edited again; another user's thread is 404.
      expect(
        (
          await owner.req('POST', `/chat/threads/${t}/messages/${first?.id ?? ''}/edit`, { text: 'x' })
        ).json(),
      ).toMatchObject({ error: 'message_superseded' });
      expect(
        (await op.req('POST', `/chat/threads/${t}/messages/${all[0]?.id ?? ''}/edit`, { text: 'x' }))
          .statusCode,
      ).toBe(404);
      const { rows } = await h.db.pool.query<{ origin: string | null; message_id: string | null }>(
        `SELECT origin, message_id::text AS message_id FROM chat_turns WHERE thread_id = $1 AND origin IS NOT NULL`,
        [t],
      );
      expect(rows).toEqual([{ origin: 'edit', message_id: all[0]?.id }]);
      const audit = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.message.edit'",
      );
      expect(audit.rows[0]?.n).toBe(1);
    });

    it('regenerate answers the last message again, optionally with another ready engine and model', async () => {
      const t = await newThread();
      await ask(owner, t, 'summarise the fleet');
      const codexTurns = codex.sessions.reduce((n, s) => n + s.turns.length, 0);
      // Only engines the answering machine has ready; model names are validated; only the last message.
      expect(
        (await owner.req('POST', `/chat/threads/${t}/regenerate`, { runtime: 'opencode' })).json(),
      ).toMatchObject({ error: 'engine_not_ready' });
      expect(
        (await owner.req('POST', `/chat/threads/${t}/regenerate`, { model: 'bad model!' })).json(),
      ).toMatchObject({ error: 'invalid_model' });
      expect(
        (await owner.req('POST', `/chat/threads/${t}/regenerate`, { messageId: randomUUID() })).json(),
      ).toMatchObject({ error: 'not_last_message' });
      const res = await owner.req('POST', `/chat/threads/${t}/regenerate`, {
        runtime: 'codex',
        model: 'gpt-5.1-codex',
      });
      expect(res.statusCode, res.body).toBe(202);
      const all = await answered(owner, t, 1);
      expect(codex.sessions.reduce((n, s) => n + s.turns.length, 0)).toBe(codexTurns + 1);
      expect(codex.sessions.at(-1)?.turns.at(-1)?.message).toBe('summarise the fleet');
      expect(codex.sessions.at(-1)?.options.model).toBe('gpt-5.1-codex');
      const answer = all.find((m) => m.role === 'assistant');
      expect(answer?.meta?.regenerated).toEqual({
        origin: 'regenerate',
        runtime: 'codex',
        model: 'gpt-5.1-codex',
      });
      const d = await detail(owner, t);
      expect(d.messages.filter((m) => m.supersededAt !== undefined).map((m) => m.role)).toEqual([
        'assistant',
      ]);
      expect(all.filter((m) => m.role === 'user')).toHaveLength(1);
    });

    it('retry answers a stopped / failed last turn again with one call', async () => {
      const t = await newThread();
      const sent = await owner.req('POST', `/chat/threads/${t}/messages`, { text: 'long one [[slow 2000]]' });
      expect(sent.statusCode, sent.body).toBe(202);
      await expect
        .poll(async () => ((await detail(owner, t)).turn as { state?: string } | null)?.state, {
          timeout: 15_000,
        })
        .toBe('running');
      expect((await owner.req('POST', `/chat/threads/${t}/cancel`)).statusCode).toBe(202);
      await idle(owner, t);
      expect(current(await detail(owner, t)).at(-1)?.role).toBe('error');
      const res = await owner.req('POST', `/chat/threads/${t}/regenerate`, { mode: 'retry' });
      expect(res.statusCode, res.body).toBe(202);
      const all = await answered(owner, t, 1);
      expect(all.find((m) => m.role === 'assistant')?.content).toContain('Echo: long one');
      expect(all.find((m) => m.role === 'assistant')?.meta?.regenerated).toMatchObject({ origin: 'retry' });
      expect(all.some((m) => m.role === 'error' && m.meta?.notice === undefined)).toBe(false);
      const audit = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.turn.retry'",
      );
      expect(audit.rows[0]?.n).toBe(1);
    });

    it('a turn that acted is not replayed without confirmation (409 turn_acted with what it did)', async () => {
      claude.script(/^note me/, async ({ call }) => {
        await call('notify_me', { title: 'Queue', message: 'Three jobs wait.' });
        return 'Sent you a note.';
      });
      const t = await newThread();
      await ask(owner, t, 'note me about the queue');
      const notes = async (): Promise<number> =>
        (
          await h.db.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM notifications WHERE kind = 'chat.note'",
          )
        ).rows[0]?.n ?? 0;
      const sent = await notes();
      const { rows } = await h.db.pool.query<{ actions: number }>(
        'SELECT actions FROM chat_turns WHERE thread_id = $1',
        [t],
      );
      expect(rows.map((r) => r.actions)).toEqual([1]);
      const refused = await owner.req('POST', `/chat/threads/${t}/regenerate`, {});
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: 'turn_acted',
        params: { count: 1 },
        effects: { actions: 1, tools: [{ name: 'notify_me' }] },
      });
      const user = (await detail(owner, t)).messages.find((m) => m.role === 'user');
      expect(
        (
          await owner.req('POST', `/chat/threads/${t}/messages/${user?.id ?? ''}/edit`, {
            text: 'note me again',
          })
        ).statusCode,
      ).toBe(409);
      // Nothing ran meanwhile.
      expect(await notes()).toBe(sent);
      const ok = await owner.req('POST', `/chat/threads/${t}/regenerate`, { acknowledgeActions: true });
      expect(ok.statusCode, ok.body).toBe(202);
      await answered(owner, t, 1);
      expect(await notes()).toBe(sent + 1);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'chat.turn.regenerate' ORDER BY id DESC LIMIT 1",
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ acknowledgedActions: 1 });
    });

    let shared = '';
    it('exports a conversation as Markdown and JSON: redacted, cards with their final state, audited', async () => {
      const t = await newThread();
      shared = t;
      await ask(owner, t, 'about alpha and beta', {
        mentions: [
          { type: 'project', id: 'alpha' },
          { type: 'project', id: 'beta' },
        ],
      });
      // A row written before a redaction rule existed still leaves the export redacted.
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      await store.addMessage(t, { role: 'assistant', content: `The token was ${TOKEN}.` });
      const turnId = randomUUID();
      const alphaCard = await store.createDraft({
        threadId: t,
        userId: ownerId,
        turnId,
        kind: 'job',
        title: 'Alpha secret fix',
        payload: { spec: { prompt: 'x' } },
        project: 'alpha',
      });
      await store.decideDraft(alphaCard.id, 'confirmed', { jobId: alphaJob });
      const betaCard = await store.createDraft({
        threadId: t,
        userId: ownerId,
        turnId,
        kind: 'job',
        title: 'Beta follow-up',
        payload: { spec: { prompt: 'y' } },
        project: 'beta',
      });
      await store.decideDraft(betaCard.id, 'confirmed', { jobId: betaJob });

      const md = await owner.req('GET', `/chat/threads/${t}/export?format=markdown&lang=tr`);
      expect(md.statusCode, md.body).toBe(200);
      expect(md.headers['content-type']).toContain('text/markdown');
      expect(md.headers['content-disposition']).toContain('attachment; filename="about-alpha-and-beta.md"');
      expect(md.body).toContain('# about alpha and beta');
      expect(md.body).not.toContain(TOKEN);
      expect(md.body).toContain('[REDACTED');
      expect(md.body).toContain('**Alpha secret fix** — durum: confirmed');
      expect(md.body).toContain(`/jobs/${alphaJob}`);
      expect(md.body).toContain('@alpha');
      const json = await owner.req('GET', `/chat/threads/${t}/export?format=json`);
      expect(json.statusCode).toBe(200);
      const doc = json.json<{
        access: string;
        items: { kind: string; restricted?: boolean; title?: string }[];
      }>();
      expect(doc.access).toBe('owner');
      expect(doc.items.filter((i) => i.kind === 'card').map((i) => i.title)).toEqual([
        'Alpha secret fix',
        'Beta follow-up',
      ]);
      expect(JSON.stringify(doc)).not.toContain(TOKEN);
      expect((await op.req('GET', `/chat/threads/${t}/export`)).statusCode).toBe(404);
      const audit = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'chat.thread.export'",
      );
      expect(audit.rows[0]?.n).toBe(2);
    });

    it('shares read-only: the reader sees only cards and mentions of what they may read', async () => {
      const t = shared;
      // Only the owner shares; never with oneself; unknown users are 404.
      expect((await reader.req('PUT', `/chat/threads/${t}/shares/${opId}`)).statusCode).toBe(404);
      expect((await owner.req('PUT', `/chat/threads/${t}/shares/${ownerId}`)).json()).toMatchObject({
        error: 'share_self',
      });
      const users = (await owner.req('GET', '/chat/share/users?q=viewer')).json<{
        items: { id: string }[];
      }>();
      expect(users.items.map((u) => u.id)).toEqual([readerId]);
      const add = await owner.req('PUT', `/chat/threads/${t}/shares/${readerId}`);
      expect(add.statusCode, add.body).toBe(200);
      expect(add.json<{ items: { username: string }[] }>().items.map((s) => s.username)).toEqual([
        'viewer.beta',
      ]);

      const list = (await reader.req('GET', '/chat/shared')).json<{
        items: { id: string; owner: { username: string } }[];
      }>();
      expect(list.items).toMatchObject([{ id: t, owner: { username: 'owner1' } }]);
      // Not in the reader's own list.
      const own = (await reader.req('GET', '/chat/threads')).json<{
        items: { id: string }[];
        shared: { id: string; owner: { username: string } }[];
      }>();
      expect(own.items.map((i) => i.id)).not.toContain(t);
      // The first plain page carries "Paylaşılanlar" too (no extra request for the console).
      expect(own.shared.map((s) => [s.id, s.owner.username])).toEqual([[t, 'owner1']]);

      const d = await detail(reader, t);
      expect(d.access).toBe('reader');
      expect(d.owner).toMatchObject({ username: 'owner1' });
      const alpha = d.drafts.find((x) => x.restricted === true);
      expect(alpha).toMatchObject({
        title: '',
        payload: {},
        project: null,
        result: null,
        state: 'confirmed',
      });
      expect(d.drafts.find((x) => x.title === 'Beta follow-up')).toMatchObject({ project: 'beta' });
      const user = d.messages.find((m) => m.role === 'user');
      const chips = (user?.meta?.mentions ?? []) as { label: string; restricted?: boolean }[];
      expect(chips.map((c) => [c.label, c.restricted === true])).toEqual([
        ['', true],
        ['beta', false],
      ]);
      // The reader's job links go through their own permissions.
      expect((await reader.req('GET', `/jobs/${alphaJob}`)).statusCode).toBe(404);
      // Read-only: no message, edit, regenerate, rename, delete, sharing.
      expect((await reader.req('POST', `/chat/threads/${t}/messages`, { text: 'hi' })).statusCode).toBe(404);
      expect((await reader.req('POST', `/chat/threads/${t}/regenerate`, {})).statusCode).toBe(404);
      expect(
        (await reader.req('POST', `/chat/threads/${t}/messages/${user?.id ?? ''}/edit`, { text: 'x' }))
          .statusCode,
      ).toBe(404);
      expect((await reader.req('PATCH', `/chat/threads/${t}`, { title: 'mine' })).statusCode).toBe(404);
      expect((await reader.req('DELETE', `/chat/threads/${t}`)).statusCode).toBe(404);
      expect((await reader.req('GET', `/chat/threads/${t}/shares`)).statusCode).toBe(404);
      // The reader's export is their view.
      const doc = (await reader.req('GET', `/chat/threads/${t}/export?format=json`)).json<{
        access: string;
        items: { kind: string; restricted?: boolean; links?: unknown[] }[];
      }>();
      expect(doc.access).toBe('reader');
      expect(doc.items.filter((i) => i.kind === 'card').map((i) => i.restricted)).toEqual([true, false]);
      // A user it is not shared with sees nothing.
      expect((await op.req('GET', `/chat/threads/${t}`)).statusCode).toBe(404);
      // The reader leaves.
      expect((await reader.req('DELETE', `/chat/threads/${t}/shares/${readerId}`)).statusCode).toBe(204);
      expect((await reader.req('GET', `/chat/threads/${t}`)).statusCode).toBe(404);
      const audit = await h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'chat.thread.%share' ORDER BY id",
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['chat.thread.share', 'chat.thread.unshare']);
    });

    it('hands a conversation over: the new owner owns it, open cards are dismissed, the old owner keeps reading', async () => {
      const t = await newThread();
      await ask(owner, t, 'handover topic');
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const open = await store.createDraft({
        threadId: t,
        userId: ownerId,
        turnId: randomUUID(),
        kind: 'job',
        title: 'Open card',
        payload: {},
        project: 'alpha',
      });
      const res = await owner.req('POST', `/chat/threads/${t}/transfer`, { userId: opId, keepAccess: true });
      expect(res.statusCode, res.body).toBe(200);
      const mine = (await op.req('GET', '/chat/threads')).json<{ items: { id: string }[] }>();
      expect(mine.items.map((i) => i.id)).toContain(t);
      const d = await detail(op, t);
      expect(d.access).toBe('owner');
      expect(d.drafts.find((x) => x.id === open.id)).toMatchObject({ state: 'dismissed' });
      expect((await detail(owner, t)).access).toBe('reader');
      expect(
        (await owner.req('POST', `/chat/threads/${t}/messages`, { text: 'still mine?' })).statusCode,
      ).toBe(404);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'chat.thread.transfer'",
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.metadata).toMatchObject({ to: opId, keepAccess: true, dismissedCards: 1 });
    });

    it('read_job_log and read_job_diff read only jobs the caller can read, paged and redacted', async () => {
      const insertChunk = async (job: string, seq: number, stream: string, text: string): Promise<void> => {
        await h.db.pool.query(
          `INSERT INTO job_log_chunks (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id, stream,
                                     chunk_seq, stream_seq, ts, received_at, text, size_bytes)
         VALUES ($1, $2, 1, 1, 'w_test', $3, $4, $5, $3, $3, $6, $6, $7, $8)`,
          [
            job,
            '00000000-0000-4000-8000-000000000001',
            seq,
            randomUUID(),
            stream,
            h.clock.now(),
            text,
            text.length,
          ],
        );
      };
      for (let i = 1; i <= 5; i++)
        await insertChunk(alphaJob, i, i === 5 ? 'stderr' : 'stdout', `line ${String(i)}`);
      await insertChunk(alphaJob, 6, 'stdout', `token ${TOKEN}`);
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, verification, changes, created_at, updated_at)
       VALUES ($1, 'alpha', 'git', 'main', 'passed', $2, now(), now())`,
        [
          alphaJob,
          JSON.stringify({
            commits: [],
            files: [
              { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
              { path: 'src/b.ts', status: 'added', additions: 10, deletions: 0 },
              { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
            ],
            totals: { files: 3, additions: 14, deletions: 2 },
            truncated: false,
          }),
        ],
      );
      const tool = (data: string): Record<string, unknown> => {
        const start = data.indexOf('{');
        const end = data.lastIndexOf('}');
        return JSON.parse(data.slice(start, end + 1)) as Record<string, unknown>;
      };
      const t = await newThread(op);
      const page1 = await ask(op, t, `[[tool read_job_log {"jobId":"${alphaJob}","limit":2}]]`);
      expect(page1.content).not.toContain(TOKEN);
      const r1 = tool(page1.content.slice(page1.content.indexOf('REMYRAL-DATA')));
      expect(r1).toMatchObject({ order: 'newest-first' });
      const items1 = r1.items as { text: string; stream: string }[];
      expect(items1.map((i) => i.text)).toEqual([expect.stringContaining('[REDACTED'), 'line 5']);
      const cursor = r1.nextCursor as string;
      expect(cursor).toMatch(/^\d+:\d+:\d+$/);
      const page2 = await ask(
        op,
        t,
        `[[tool read_job_log {"jobId":"${alphaJob}","limit":2,"cursor":"${cursor}"}]]`,
      );
      const r2 = tool(page2.content.slice(page2.content.indexOf('REMYRAL-DATA')));
      expect((r2.items as { text: string }[]).map((i) => i.text)).toEqual(['line 4', 'line 3']);
      const err = await ask(op, t, `[[tool read_job_log {"jobId":"${alphaJob}","stream":"stderr"}]]`);
      expect((tool(err.content.slice(err.content.indexOf('REMYRAL-DATA'))).items as unknown[]).length).toBe(
        1,
      );
      // A job of a project the caller cannot see is "not found".
      const foreign = await ask(op, t, `[[tool read_job_log {"jobId":"${betaJob}"}]]`);
      expect(foreign.content).toContain('read_job_log refused');
      expect(foreign.content).toContain('not found');

      const diff = await ask(op, t, `[[tool read_job_diff {"jobId":"${alphaJob}","limit":2}]]`);
      const d1 = tool(diff.content.slice(diff.content.indexOf('REMYRAL-DATA')));
      expect(d1).toMatchObject({ available: true, totalFiles: 3, nextOffset: 2 });
      expect((d1.files as { path: string }[]).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
      const one = await ask(op, t, `[[tool read_job_diff {"jobId":"${alphaJob}","file":"README.md"}]]`);
      expect((tool(one.content.slice(one.content.indexOf('REMYRAL-DATA'))).files as unknown[]).length).toBe(
        1,
      );
      const noDiff = await ask(op, t, `[[tool read_job_diff {"jobId":"${betaJob}"}]]`);
      expect(noDiff.content).toContain('read_job_diff refused');
      // The owner sees beta's job: no git record yet → it says why.
      const t2 = await newThread();
      const why = await ask(owner, t2, `[[tool read_job_diff {"jobId":"${betaJob}"}]]`);
      expect(why.content).toContain('"available": false');
    });

    it('list_site_upload_files pages through every path of an upload', async () => {
      const manifest = Array.from({ length: 30 }, (_, i) => ({ path: `p/${String(i)}.html`, size: 10 }));
      const uploadId = randomUUID();
      await h.db.pool.query(
        `INSERT INTO site_uploads (id, project, uploaded_by, state, label, manifest, file_count, total_bytes, part_size,
                                 part_count, site_sha256, created_at)
       VALUES ($1, 'alpha', $2, 'ready', 'site.zip', $3, 30, 300, 65536, 1, $4, $5)`,
        [uploadId, opId, JSON.stringify(manifest), 'a'.repeat(64), h.clock.now()],
      );
      const t = await newThread(op);
      const r = await ask(
        op,
        t,
        `[[tool list_site_upload_files {"uploadId":"${uploadId}","offset":25,"limit":3}]]`,
      );
      expect(r.content).toContain('p/25.html');
      expect(r.content).toContain('p/27.html');
      expect(r.content).not.toContain('p/28.html');
      expect(r.content).toMatch(/"nextOffset":\s*28/);
      const hidden = await ask(
        reader,
        await newThread(reader),
        `[[tool list_site_upload_files {"uploadId":"${uploadId}"}]]`,
      );
      expect(hidden.content).toContain('not found');
    });
  },
);
