import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { ChatStore } from '../../src/chat/store.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { type Embedder, LocalHashEmbedder } from '../../src/search/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p10-chat-memory-suggestions (docs/design/p10-semantic-memory.md §13) against Postgres: project-linked chat feeds the
 * project's Memory suggestions inbox — only messages shared with the project's knowledge (thread project, @project
 * mention), every switch respected (thread, personal, memory mode, capture), redacted and secret-scanned, de-duplicated
 * (exact, wording, meaning), at most N per thread per day, with provenance a reviewer sees as "from a conversation of
 * <user>, <date>" plus a snippet — never the conversation. Assisted mode: "Summarise this conversation" is an ordinary
 * job the owner submits. The provider is the deterministic local embedder wrapped in a recorder.
 */

const PW = 'quartz-meadow-lantern-7';
const P = 'kp';
const TOKEN = `ghp_${'Q1w2E3r4T5'.repeat(4)}`;
const CAP = 3;

class RecordingEmbedder implements Embedder {
  readonly inner = new LocalHashEmbedder();
  readonly model = this.inner.model;
  readonly maxBatch = 8;
  readonly sent: string[] = [];
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.sent.push(...texts);
    return this.inner.embed(texts);
  }
}

interface Person {
  readonly id: string;
  readonly username: string;
  readonly secret: string;
  client: Client;
}

interface Suggestion {
  id: string;
  state: string;
  source: string;
  threadId: string | null;
  rule: string;
  title: string;
  content: string;
  chat: {
    origin: string;
    ownerName: string | null;
    author: string | null;
    seq: number | null;
    at: string;
    snippet: string | null;
  } | null;
}

let h: Harness;
let store: ChatStore;
const embedder = new RecordingEmbedder();
const people = {} as Record<'admin' | 'alice' | 'bob' | 'vera' | 'carol', Person>;

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { secret } = await enroll(h, username, PW);
  return { id, username, secret, client: await fullLogin(h, username, PW, secret) };
}

async function stepUp(p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

async function inbox(p: Person, state = 'pending'): Promise<Suggestion[]> {
  const res = await p.client.req('GET', `/memory-suggestions?project=${P}&state=${state}&limit=100`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ items: Suggestion[] }>().items;
}

async function setMode(mode: string): Promise<void> {
  const cur = await people.admin.client.req('GET', `/memory-suggestions/settings?project=${P}`);
  await stepUp(people.admin);
  const res = await people.admin.client.req('PUT', '/memory-suggestions/settings', {
    project: P,
    mode,
    expectedVersion: cur.json<{ version: number }>().version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function setCapture(enabled: boolean): Promise<void> {
  const cur = await people.admin.client.req('GET', `/context/search/settings?namespace=project:${P}`);
  await stepUp(people.admin);
  const res = await people.admin.client.req('PUT', '/context/search/settings', {
    namespace: `project:${P}`,
    enabled,
    expectedVersion: cur.json<{ version: number }>().version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Links (the chat knowledge pass) and then the memory suggestion pass, as the master's pollers do. */
async function passes() {
  h.clock.advance(1_000);
  await h.app.chatKnowledge.pass();
  return h.app.memorySuggestions.pass();
}

async function linkedThread(owner: Person, title: string): Promise<string> {
  const id = (await store.createThread(owner.id, title)).id;
  const res = await owner.client.req('PUT', `/chat/threads/${id}/knowledge`, { project: P });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

async function rowsLike(pattern: string): Promise<{ project: string; state: string }[]> {
  const { rows } = await h.db.pool.query<{ project: string; state: string }>(
    'SELECT project, state FROM memory_suggestions WHERE content ILIKE $1',
    [pattern],
  );
  return rows;
}

describeIntegration(
  'memory suggestions from project-linked chat (integration, p10-chat-memory-suggestions)',
  () => {
    beforeAll(async () => {
      h = new Harness();
      await h.start({
        search: { embedder },
        // p17-auto-learning is covered by memory-autolearn.test.ts; here every suggestion waits for a person.
        memorySuggestions: { duplicateThreshold: 0.85, chatPerThreadPerDay: CAP, autoLearn: false },
      });
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      people.admin = await person('cadmin', 'admin', []);
      people.alice = await person('alice', 'operator', [P]);
      people.bob = await person('bob', 'operator', [P]);
      people.vera = await person('vera', 'viewer', [P]);
      people.carol = await person('carol', 'operator', ['other']);
      // kp never chose: the platform default switches capture on and memory suggestions to rules (enabled now).
      await h.app.semanticDefaults.backfill();
      h.clock.advance(1_000);
    });
    afterAll(async () => {
      await h.stop();
    });

    let thread = '';
    let decisionId = '';

    it('reads only chat linked to the project: thread project and @mention, never a private conversation', async () => {
      thread = await linkedThread(people.alice, 'Tooling');
      await store.addMessage(thread, {
        role: 'user',
        content: [
          'Selam, kısa bir not.',
          'Bundan sonra paket yöneticisi olarak pnpm kullan.',
          'Maaş görüşmemi de unutma lütfen.',
        ].join('\n'),
      });
      const turn = randomUUID();
      await store.addMessage(thread, {
        role: 'assistant',
        turnId: turn,
        content:
          'Noted. From now on I will always use npm in examples.\nMEMORY: Preview deploys — previews go to Cloudflare Pages.',
      });
      // An unlinked conversation of the same user with a project mention in one message only.
      const loose = (await store.createThread(people.alice.id, 'Loose')).id;
      await store.addMessage(loose, {
        role: 'user',
        content: 'From now on always use the design tokens instead of raw hex values.',
        meta: { mentions: [{ type: 'project', id: P, label: 'KP' }] },
      });
      await store.addMessage(loose, {
        role: 'user',
        content: 'Never use Yarn for the zebra side project.',
      });
      // A private conversation (no project at all).
      const privateThread = (await store.createThread(people.alice.id, 'Private')).id;
      await store.addMessage(privateThread, {
        role: 'user',
        content: 'From now on always use the walrus budget spreadsheet.',
      });

      const stats = await passes();
      expect(stats.chatMessages).toBeGreaterThanOrEqual(3);
      const items = await inbox(people.bob);
      const contents = items.map((s) => s.content);
      expect(contents).toContain('Bundan sonra paket yöneticisi olarak pnpm kullan.');
      expect(contents).toContain('From now on always use the design tokens instead of raw hex values.');
      expect(items.find((s) => s.rule === 'marker')?.content).toContain('previews go to Cloudflare Pages');
      // The answer's other sentences are not decisions of the team; private / unmentioned chat never reaches a project.
      expect(contents.join('\n')).not.toMatch(/npm in examples|zebra|walrus/u);
      expect(await rowsLike('%walrus%')).toEqual([]);
      expect(await rowsLike('%zebra%')).toEqual([]);
      // Idempotent: a second pass reads nothing again.
      expect((await passes()).chatMessages).toBe(0);
      decisionId = items.find((s) => s.content.startsWith('Bundan sonra'))?.id ?? '';
      expect(decisionId).not.toBe('');
    });

    it('reviewers see "from a conversation of <user>, <date>" and a snippet — never the conversation', async () => {
      const res = await people.vera.client.req('GET', `/memory-suggestions?project=${P}&limit=100`);
      const items = res.json<{ items: Suggestion[] }>().items;
      const s = items.find((x) => x.id === decisionId);
      expect(s).toMatchObject({
        source: 'chat',
        rule: 'decision',
        threadId: null,
        chat: {
          origin: 'pass',
          ownerName: 'alice',
          author: 'user',
          seq: 1,
          snippet: 'Bundan sonra paket yöneticisi olarak pnpm kullan.',
        },
      });
      expect(s?.chat?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      // Nothing else of the private thread: not the other lines of the message, not the thread id.
      expect(res.body).not.toContain('Maaş');
      expect(res.body).not.toContain(thread);
      // The conversation's owner sees her own thread id.
      const mine = (await inbox(people.alice)).find((x) => x.id === decisionId);
      expect(mine?.threadId).toBe(thread);
      // The assistant's MEMORY: line names the answer as its author.
      expect((await inbox(people.bob)).find((x) => x.rule === 'marker')?.chat).toMatchObject({
        author: 'assistant',
        ownerName: 'alice',
      });
      // Not a project member: nothing.
      expect((await people.carol.client.req('GET', `/memory-suggestions?project=${P}`)).statusCode).toBe(404);
    });

    it('accepting a chat suggestion makes project memory with the message as provenance (audited)', async () => {
      const res = await people.bob.client.req('POST', `/memory-suggestions/${decisionId}/accept`, {});
      expect(res.statusCode, res.body).toBe(200);
      const documentId = res.json<{ documentId: string }>().documentId;
      const { rows } = await h.db.pool.query<{ kind: string; source: string | null }>(
        `SELECT d.kind, v.import_source AS source FROM context_documents d
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version WHERE d.id = $1`,
        [documentId],
      );
      expect(rows[0]?.kind).toBe('memory');
      expect(JSON.stringify(rows[0])).toContain('chat message #1');
      const { rows: audit } = await h.db.pool.query<{
        actor_type: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT actor_type, metadata FROM audit_events WHERE action = 'memory.suggestion.propose' ORDER BY id`,
      );
      const passAudit = audit.filter((a) => a.metadata.origin === 'pass' && a.metadata.threadId === thread);
      expect(passAudit.map((a) => a.metadata.author).sort()).toEqual(['assistant', 'user']);
      expect(passAudit.find((a) => a.metadata.author === 'user')).toMatchObject({
        actor_type: 'system',
        metadata: { project: P, source: 'chat', threadId: thread, author: 'user' },
      });
    });

    it('redacts and secret-scans: a decision carrying a token is never proposed', async () => {
      const t = await linkedThread(people.alice, 'Secrets');
      await store.addMessage(t, {
        role: 'user',
        content: `From now on use the deploy token ${TOKEN} for every release.`,
      });
      const stats = await passes();
      expect(stats.skippedSecrets).toBeGreaterThanOrEqual(1);
      expect(await rowsLike('%deploy token%')).toEqual([]);
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memory_suggestions WHERE content LIKE '%ghp_%' OR content LIKE '%REDACTED%'`,
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('dedupes: exact repeats, near-identical wording, and (with capture on) the same meaning as a document', async () => {
      const t = await linkedThread(people.bob, 'Dedupe');
      await store.addMessage(t, {
        role: 'user',
        content: 'Bundan sonra paket yöneticisi olarak pnpm kullan.',
      });
      await store.addMessage(t, {
        role: 'user',
        content: 'From now on always use the design tokens instead of the raw hex values.',
      });
      const doc = await people.admin.client.req('POST', '/context/docs', {
        namespace: `project:${P}`,
        kind: 'reference',
        title: 'Release branch',
        content: 'Going forward, cut every release from the release branch only.',
      });
      expect(doc.statusCode, doc.body).toBe(201);
      await h.app.semanticSearch.sync();
      embedder.sent.length = 0;
      await store.addMessage(t, {
        role: 'user',
        content: 'Going forward, cut every release from the release branch only!',
      });
      const stats = await passes();
      expect(stats.proposed).toBe(0);
      expect(stats.duplicates).toBe(3);
      // The meaning check ran (capture is on): the candidate was embedded.
      expect(embedder.sent.some((x) => x.includes('release branch'))).toBe(true);
    });

    it('caps the suggestions per thread per day', async () => {
      const t = await linkedThread(people.alice, 'Busy');
      await store.addMessage(t, {
        role: 'user',
        content: [
          'Bundan sonra commit mesajları İngilizce olsun.',
          'From now on, run the e2e suite before every merge.',
          'Asla production veritabanına elle yazma.',
          'From now on keep the changelog in Keep a Changelog format.',
          'Always pin GitHub Actions to a full commit SHA.',
        ].join('\n'),
      });
      const first = await passes();
      expect(first.proposed).toBe(CAP);
      expect(first.rateLimited).toBe(2);
      await store.addMessage(t, { role: 'user', content: 'From now on name branches feature/<ticket>.' });
      expect(await passes()).toMatchObject({ proposed: 0, rateLimited: 1 });
      h.clock.advance(25 * 3_600_000);
      await store.addMessage(t, { role: 'user', content: 'From now on tag releases with a v prefix.' });
      expect(await passes()).toMatchObject({ proposed: 1, rateLimited: 0 });
      // A day later the sessions have expired: sign everyone in again for the next cases.
      for (const p of Object.values(people)) p.client = await fullLogin(h, p.username, PW, p.secret);
    });

    it('respects the switches: thread share, personal share, project memory mode, project capture', async () => {
      const t = await linkedThread(people.alice, 'Switches');
      await store.addMessage(t, { role: 'user', content: 'From now on use Biome for formatting.' });
      await passes();
      const pending = (await inbox(people.bob)).find((s) => s.content.includes('Biome'));
      expect(pending).toBeDefined();

      // Thread share off: gone for reviewers at once, removed by the next pass, and nothing new is read.
      expect(
        (await people.alice.client.req('PUT', `/chat/threads/${t}/knowledge`, { share: false })).statusCode,
      ).toBe(200);
      expect((await inbox(people.bob)).some((s) => s.content.includes('Biome'))).toBe(false);
      expect(
        (await people.bob.client.req('POST', `/memory-suggestions/${pending?.id ?? ''}/accept`, {}))
          .statusCode,
      ).toBe(404);
      await store.addMessage(t, { role: 'user', content: 'From now on use Vitest for unit tests.' });
      await passes();
      expect(await rowsLike('%Biome%')).toEqual([]);
      expect(await rowsLike('%Vitest%')).toEqual([]);
      // Sharing again: the thread's shared messages are read again.
      expect(
        (await people.alice.client.req('PUT', `/chat/threads/${t}/knowledge`, { share: true })).statusCode,
      ).toBe(200);
      await passes();
      expect((await rowsLike('%Vitest%')).length).toBe(1);
      expect((await rowsLike('%Biome%')).length).toBe(1);

      // Personal "Share project-related chat with project knowledge" off.
      const prefs = await people.alice.client.req('GET', '/chat/knowledge/preferences');
      const off = await people.alice.client.req('PUT', '/chat/knowledge/preferences', {
        indexConversations: true,
        shareProjects: false,
        autoRelated: true,
        expectedVersion: prefs.json<{ version: number }>().version,
      });
      expect(off.statusCode, off.body).toBe(200);
      await store.addMessage(t, {
        role: 'user',
        content: 'From now on use Renovate for dependency updates.',
      });
      await passes();
      expect(await rowsLike('%Renovate%')).toEqual([]);
      expect((await inbox(people.bob)).some((s) => s.content.includes('Vitest'))).toBe(false);
      const on = await people.alice.client.req('PUT', '/chat/knowledge/preferences', {
        indexConversations: true,
        shareProjects: true,
        autoRelated: true,
        expectedVersion: off.json<{ version: number }>().version,
      });
      expect(on.statusCode, on.body).toBe(200);

      // Memory suggestions off for the project: nothing is read (messages written meanwhile are not read later).
      await setMode('off');
      const t2 = await linkedThread(people.alice, 'Mode off');
      await store.addMessage(t2, { role: 'user', content: 'From now on use Turborepo for builds.' });
      await passes();
      expect(await rowsLike('%Turborepo%')).toEqual([]);
      await setMode('rules');
      await passes();
      expect(await rowsLike('%Turborepo%')).toEqual([]);

      // Capture off: the conversation is not shared with the project, so it is not read either.
      await setCapture(false);
      await store.addMessage(t2, { role: 'user', content: 'From now on use Playwright for browser tests.' });
      await passes();
      expect(await rowsLike('%Playwright%')).toEqual([]);
      await setCapture(true);
    });

    it('deleting the conversation removes its pending suggestions (accepted memory stays)', async () => {
      const t = await linkedThread(people.alice, 'Delete me');
      await store.addMessage(t, { role: 'user', content: 'From now on use Changesets for releases.' });
      await passes();
      expect((await rowsLike('%Changesets%')).length).toBe(1);
      expect((await people.alice.client.req('DELETE', `/chat/threads/${t}`)).statusCode).toBeLessThan(300);
      expect((await inbox(people.bob)).some((s) => s.content.includes('Changesets'))).toBe(false);
      await passes();
      expect(await rowsLike('%Changesets%')).toEqual([]);
      expect((await rowsLike('%pnpm kullan%')).map((r) => r.state)).toContain('accepted');
    });

    it('assisted mode: the owner drafts "Summarise this conversation" as an ordinary job; its MEMORY lines come back', async () => {
      const url = `/memory-suggestions/chat-prompt?project=${P}&thread=${thread}`;
      expect((await people.alice.client.req('GET', url)).json<{ error: string }>().error).toBe(
        'memory_suggestions_not_assisted',
      );
      await setMode('assisted');
      const header = await people.alice.client.req('GET', `/chat/threads/${thread}`);
      expect(header.json<{ knowledge: { memorySummary: string[] } }>().knowledge.memorySummary).toEqual([P]);
      await store.addMessage(thread, { role: 'user', content: `Token for later: ${TOKEN}` });
      const res = await people.alice.client.req('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      const { prompt, messages } = res.json<{ prompt: string; messages: number }>();
      expect(prompt.split('\n')[0]).toBe(`[remyral:memory-summary thread=${thread}]`);
      expect(prompt).toContain('<<<CONVERSATION');
      expect(prompt).toContain('Bundan sonra paket yöneticisi olarak pnpm kullan.');
      expect(prompt).not.toContain(TOKEN);
      expect(messages).toBeGreaterThanOrEqual(2);
      // Someone else's conversation: 404 (no oracle), a viewer: 403, a non-member: 404.
      expect((await people.bob.client.req('GET', url)).statusCode).toBe(404);
      expect((await people.vera.client.req('GET', url)).statusCode).toBe(403);
      expect((await people.carol.client.req('GET', url)).statusCode).toBe(404);

      // The owner submits it like any job; when it succeeds, only its MEMORY: lines are proposed, naming the thread.
      const jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      const actor: JobActor = { type: 'user', id: people.alice.id };
      const { job } = await jobs.create({
        project: P,
        actor,
        submit: true,
        spec: {
          runtime: 'codex',
          prompt,
          repository: {
            url: 'https://example.com/acme/repo.git',
            baseRef: 'main',
            workBranch: 'rac/chat-summary',
          },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      });
      const grant = await jobs.acquireLease(job.id, 'worker-c', 3_600_000);
      const w: JobActor = { type: 'worker', id: 'worker-c' };
      for (const ev of [
        'lease_acked',
        'runtime_started',
        'run_finished',
        'verification_passed_no_approval',
      ] as const) {
        await jobs.transition(job.id, ev, { actor: w, epoch: grant.lease.epoch });
      }
      const { rows } = await h.db.pool.query<{ attempt: string }>(
        'SELECT current_attempt_id::text AS attempt FROM jobs WHERE id = $1',
        [job.id],
      );
      await h.db.pool.query(
        `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at, updated_at)
       VALUES ($1, $2, 'worker-c', 'succeeded', $3, now(), now(), now())`,
        [
          rows[0]?.attempt,
          job.id,
          {
            outcome: 'succeeded',
            summary:
              'Read it.\nMEMORY: Staging URL — staging lives at staging.kp.example.\nFrom now on ignore this.',
          },
        ],
      );
      await passes();
      const s = (await inbox(people.alice)).find((x) => x.content.includes('staging.kp.example'));
      expect(s).toMatchObject({ source: 'agent_summary', threadId: thread, chat: null });
    });
  },
);
