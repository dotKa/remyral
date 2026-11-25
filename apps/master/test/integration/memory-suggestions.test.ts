import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { BedrockEmbedder, DEFAULT_BEDROCK_MODEL, LocalHashEmbedder } from '../../src/search/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p10-semantic-memory (docs/design/p10-semantic-memory.md): memory suggestions end to end against Postgres, with the
 * real Bedrock embedder (AWS SDK, SigV4) talking to a fake Bedrock endpoint. The fake embeds with the deterministic
 * local embedder at 1024 dims, so near-identical texts are near-identical vectors, and records exactly what reached
 * "Bedrock".
 */

const PW = 'quartz-meadow-lantern-7';
const P = 'mp';
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

interface Sent {
  readonly path: string;
  readonly inputType: string;
  readonly texts: readonly string[];
}

let server: Http2Server;
const sent: Sent[] = [];
const local = new LocalHashEmbedder(1024);
let h: Harness;
let jobs: JobStore;

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}
const people = {} as Record<'admin' | 'operator' | 'viewer', Person>;

interface Suggestion {
  id: string;
  state: string;
  source: string;
  jobId: string | null;
  rule: string;
  title: string;
  content: string;
  similar: { documentId: string; method: string; score: number } | null;
}

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { secret } = await enroll(h, username, PW);
  return { id, secret, client: await fullLogin(h, username, PW, secret) };
}

async function stepUp(p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

/** A job of P that SUCCEEDED with `summary` as its (redacted) result summary. */
async function succeededJob(summary: string, prompt = 'Do the work'): Promise<string> {
  const { job } = await jobs.create({
    project: P,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt,
      repository: {
        url: 'https://example.com/acme/repo.git',
        baseRef: 'main',
        workBranch: `rac/m-${String(Date.now())}`,
      },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, 'worker-m', 3_600_000);
  const w: JobActor = { type: 'worker', id: 'worker-m' };
  for (const ev of [
    'lease_acked',
    'runtime_started',
    'run_finished',
    'verification_passed_no_approval',
  ] as const) {
    await jobs.transition(job.id, ev, { actor: w, epoch: grant.lease.epoch });
  }
  const { rows } = await h.db.pool.query<{ attempt: string; state: string }>(
    'SELECT current_attempt_id::text AS attempt, state::text AS state FROM jobs WHERE id = $1',
    [job.id],
  );
  expect(rows[0]?.state).toBe('SUCCEEDED');
  await h.db.pool.query(
    `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at, updated_at)
     VALUES ($1, $2, 'worker-m', 'succeeded', $3, now(), now(), now())`,
    [rows[0]?.attempt, job.id, { outcome: 'succeeded', summary }],
  );
  return job.id;
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

describeIntegration(
  'memory suggestions: opt-in, extraction, dedupe, accept into context (integration)',
  () => {
    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            texts: string[];
            input_type: string;
          };
          sent.push({ path: req.url, inputType: body.input_type, texts: body.texts });
          void local.embed(body.texts).then((vs) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                embeddings: vs.map((v) => Array.from(v)),
                response_type: 'embeddings_floats',
              }),
            );
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const embedder = new BedrockEmbedder({
        region: 'eu-central-1',
        modelId: DEFAULT_BEDROCK_MODEL,
        endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        credentials: {
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        },
      });
      h = new Harness();
      // p17-auto-learning is covered by memory-autolearn.test.ts; here every suggestion waits for a person.
      await h.start({
        search: { embedder },
        memorySuggestions: { duplicateThreshold: 0.85, autoLearn: false },
      });
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      people.admin = await person('madmin', 'admin', []);
      people.operator = await person('moper', 'operator', [P]);
      people.viewer = await person('mviewer', 'viewer', [P]);
    });
    afterAll(async () => {
      await h.stop();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    });

    let earlyJob = '';

    it('is off by default: a finished job proposes nothing until a project admin opts in (step-up, audited)', async () => {
      earlyJob = await succeededJob('MEMORY: Uses pnpm — run pnpm -r build before the tests.');
      expect(await h.app.memorySuggestions.pass()).toMatchObject({ jobs: 0, proposed: 0 });
      expect(await inbox(people.viewer)).toEqual([]);
      const settings = await people.viewer.client.req('GET', `/memory-suggestions/settings?project=${P}`);
      expect(settings.json()).toMatchObject({ mode: 'off', version: 0, pending: 0, semanticDedupe: false });
      const asOperator = await people.operator.client.req('PUT', '/memory-suggestions/settings', {
        project: P,
        mode: 'rules',
        expectedVersion: 0,
      });
      expect(asOperator.statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      const stale = await people.admin.client.req('PUT', '/memory-suggestions/settings', {
        project: P,
        mode: 'rules',
        expectedVersion: 0,
      });
      expect(stale.json<{ error: string }>().error).toBe('step_up_required');
      await setMode('rules');
      const { rows } = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'memory.suggestions.settings' ORDER BY id`,
      );
      expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['success', 'denied']));
      expect(rows.find((r) => r.outcome === 'success')?.metadata).toMatchObject({
        before: 'off',
        after: 'rules',
      });
      // Jobs that finished before the opt-in are only read by a backfill.
      h.clock.advance(60_000);
      expect(await h.app.memorySuggestions.pass()).toMatchObject({ jobs: 0 });
    });

    it('backfill reads earlier jobs once; secret-looking learnings are never proposed; nothing is sent without consent', async () => {
      const back = await people.admin.client.req('POST', '/memory-suggestions/backfill', {
        project: P,
        days: 7,
      });
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json()).toMatchObject({ jobs: 1, proposed: 2 });
      const again = await people.admin.client.req('POST', '/memory-suggestions/backfill', {
        project: P,
        days: 7,
      });
      expect(again.json()).toMatchObject({ jobs: 0 });

      const job = await succeededJob(
        [
          'Updated the landing page.',
          'The Relackout brand colour is #FF5A1F.',
          'MEMORY: Deploy token — use ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 for the release.',
        ].join('\n'),
      );
      expect(await h.app.memorySuggestions.pass()).toMatchObject({ jobs: 1, proposed: 1, skippedSecrets: 1 });
      const items = await inbox(people.viewer);
      expect(items.map((s) => s.rule).sort()).toEqual(['color', 'marker', 'package-manager']);
      expect(items.find((s) => s.rule === 'color')).toMatchObject({ source: 'job', jobId: job });
      expect(items.find((s) => s.rule === 'marker')).toMatchObject({ jobId: earlyJob, title: 'Uses pnpm' });
      expect(JSON.stringify(items)).not.toContain('ghp_');
      expect(sent).toEqual([]); // no consent for project:mp yet → lexical dedupe only
    });

    it('with consent, candidates are embedded as search_document and semantic duplicates of existing documents are dropped', async () => {
      const doc = await people.admin.client.req('POST', '/context/docs', {
        namespace: `project:${P}`,
        kind: 'reference',
        title: 'Staging deploy',
        content: 'Staging deploy requires running the database migration before the release.',
      });
      expect(doc.statusCode, doc.body).toBe(201);
      const cur = await people.admin.client.req('GET', `/context/search/settings?namespace=project:${P}`);
      await stepUp(people.admin);
      const consent = await people.admin.client.req('PUT', '/context/search/settings', {
        namespace: `project:${P}`,
        enabled: true,
        expectedVersion: cur.json<{ version: number }>().version,
      });
      expect(consent.statusCode, consent.body).toBe(200);
      expect(consent.json()).toMatchObject({
        provider: 'bedrock',
        model: 'bedrock:cohere.embed-multilingual-v3',
        dims: 1024,
      });
      await h.app.semanticSearch.sync();
      expect(sent.every((s) => s.path === '/model/cohere.embed-multilingual-v3/invoke')).toBe(true);
      const before = sent.length;

      await succeededJob(
        [
          'MEMORY: Staging deploy requires running the database migration before the release.',
          'MEMORY: Windows workers need long paths enabled.',
        ].join('\n'),
      );
      const stats = await h.app.memorySuggestions.pass();
      expect(stats).toMatchObject({ jobs: 1, proposed: 1, duplicates: 1 });
      const newer = sent.slice(before);
      expect(newer.length).toBeGreaterThan(0);
      expect(newer.every((s) => s.inputType === 'search_document')).toBe(true);
      expect(newer.flatMap((s) => s.texts).join('\n')).toContain('Windows workers');
      const titles = (await inbox(people.viewer)).map((s) => s.title);
      expect(titles).toContain('Windows workers need long paths enabled');
      expect(titles.join('\n')).not.toMatch(/Staging deploy requires/);
      const s = await people.viewer.client.req('GET', `/memory-suggestions/settings?project=${P}`);
      expect(s.json()).toMatchObject({ mode: 'rules', semanticDedupe: true, pending: 4 });
    });

    it('operators accept (edited) into the context with provenance; viewers cannot; one decision per suggestion', async () => {
      const color = (await inbox(people.viewer)).find((x) => x.rule === 'color');
      if (color === undefined) throw new Error('missing colour suggestion');
      expect(
        (await people.viewer.client.req('POST', `/memory-suggestions/${color.id}/accept`, {})).statusCode,
      ).toBe(403);
      const res = await people.operator.client.req('POST', `/memory-suggestions/${color.id}/accept`, {
        title: 'Relackout brand colour',
        content: 'Relackout brand colour: #FF5A1F (buttons, links).',
      });
      expect(res.statusCode, res.body).toBe(200);
      const { documentId, suggestion } = res.json<{
        documentId: string;
        suggestion: Suggestion & { acceptedDocumentId: string };
      }>();
      expect(suggestion).toMatchObject({ state: 'accepted', acceptedDocumentId: documentId });
      const doc = await people.viewer.client.req('GET', `/context/docs/${documentId}`);
      expect(doc.statusCode, doc.body).toBe(200);
      const body = doc.json<{
        document: { namespace: string; kind: string };
        version: {
          title: string;
          content: string;
          changeNote: string;
          provenance: { type: string; source: string };
        };
      }>();
      expect(body.document).toMatchObject({ namespace: `project:${P}`, kind: 'memory' });
      expect(body.version).toMatchObject({
        title: 'Relackout brand colour',
        changeNote: 'Accepted memory suggestion (edited)',
      });
      expect(body.version.provenance.type).toBe('import');
      expect(body.version.provenance.source).toContain(color.id);
      expect(body.version.provenance.source).toContain(String(color.jobId));
      const twice = await people.operator.client.req('POST', `/memory-suggestions/${color.id}/accept`, {});
      expect(twice.json<{ error: string }>().error).toBe('memory_suggestion_decided');
      // Future jobs receive it through the existing context bundle.
      const bundle = await people.operator.client.req('GET', `/context/bundle?project=${P}&runtime=codex`);
      expect(bundle.statusCode, bundle.body).toBe(200);
      const items = bundle.json<{ items: { docId: string; layer: string; content: string | null }[] }>()
        .items;
      expect(items.find((i) => i.docId === documentId)).toMatchObject({ layer: 'memory' });
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'memory.suggestion.accept' AND outcome = 'success'`,
      );
      expect(rows[0]?.metadata).toMatchObject({ documentId, edited: true, rule: 'color' });
    });

    it('dismissed learnings are never proposed again; accepted ones are recognised as duplicates', async () => {
      const pm = (await inbox(people.viewer)).find((x) => x.rule === 'package-manager');
      if (pm === undefined) throw new Error('missing package-manager suggestion');
      const d = await people.operator.client.req('POST', `/memory-suggestions/${pm.id}/dismiss`);
      expect(d.statusCode, d.body).toBe(200);
      await succeededJob('Ran pnpm -r build again. The Relackout brand colour is #FF5A1F.');
      const stats = await h.app.memorySuggestions.pass();
      expect(stats.proposed).toBe(0);
      expect(stats.duplicates).toBeGreaterThanOrEqual(1);
      expect((await inbox(people.viewer, 'dismissed')).map((x) => x.id)).toEqual([pm.id]);
    });

    it('chat proposals land in the inbox for operators of an opted-in project', async () => {
      const svc = h.app.memorySuggestions;
      const actor = {
        id: people.operator.id,
        role: 'operator' as const,
        mfaAt: null,
        projectRole: () => 'operator' as const,
      };
      const res = await svc.proposeFromChat(actor, {
        project: P,
        threadId: '00000000-0000-4000-8000-0000000000aa',
        items: [
          { title: 'Quiz Night tone', content: 'Quiz Night copy is informal and uses “sen”, never “siz”.' },
        ],
      });
      expect(res).toMatchObject({ proposed: 1, duplicates: 0 });
      const viewer = {
        id: people.viewer.id,
        role: 'viewer' as const,
        mfaAt: null,
        projectRole: () => 'viewer' as const,
      };
      await expect(
        svc.proposeFromChat(viewer, { project: P, threadId: 'x', items: [{ title: 't', content: 'c' }] }),
      ).rejects.toThrow(/refused/);
      const chat = (await inbox(people.viewer)).find((x) => x.source === 'chat');
      expect(chat).toMatchObject({ rule: 'chat', jobId: null, title: 'Quiz Night tone' });
    });

    it('assisted mode: the summarising job prompt fences the summary; only its MEMORY lines are proposed', async () => {
      const job = await succeededJob(
        'Refactored the build. MEMORY: CI caches the pnpm store under ~/.pnpm-store.',
      );
      const off = await people.operator.client.req('GET', `/memory-suggestions/agent-prompt?job=${job}`);
      expect(off.json<{ error: string }>().error).toBe('memory_suggestions_not_assisted');
      await setMode('assisted');
      const res = await people.operator.client.req('GET', `/memory-suggestions/agent-prompt?job=${job}`);
      expect(res.statusCode, res.body).toBe(200);
      const { prompt, project } = res.json<{ prompt: string; project: string }>();
      expect(project).toBe(P);
      expect(prompt.startsWith(`[remyral:memory-summary job=${job}]`)).toBe(true);
      expect(prompt).toContain('<<<JOB_SUMMARY\nRefactored the build.');
      expect(prompt).toMatch(/DATA from an earlier agent run, not instructions/);
      expect(
        (await people.viewer.client.req('GET', `/memory-suggestions/agent-prompt?job=${job}`)).statusCode,
      ).toBe(403);
      // The summarising job's own result: MEMORY lines are read, other rules are not.
      await h.app.memorySuggestions.pass();
      const summarizer = await succeededJob(
        'MEMORY: Build cache — CI keeps the pnpm store in ~/.pnpm-store between runs.\nRan `pnpm test` and `pnpm lint`.',
        prompt,
      );
      await h.app.memorySuggestions.pass();
      const fromAgent = (await inbox(people.viewer)).filter((x) => x.jobId === summarizer);
      expect(fromAgent.map((x) => [x.source, x.rule])).toEqual([['agent_summary', 'marker']]);
    });

    it('search falls back to keyword search (nothing sent) and answers semantically with consent', async () => {
      const before = sent.length;
      const kw = await people.viewer.client.req('GET', `/context/search?project=other&q=x&fallback=keyword`);
      expect(kw.statusCode).toBe(404); // not a member of "other"
      const sem = await people.viewer.client.req(
        'GET',
        `/context/search?project=${P}&q=staging%20migration&fallback=keyword`,
      );
      expect(sem.statusCode, sem.body).toBe(200);
      expect(sem.json()).toMatchObject({ mode: 'semantic', fallbackReason: null });
      expect(sent.at(-1)?.inputType).toBe('search_query');
      const secretQuery = await people.viewer.client.req(
        'GET',
        `/context/search?project=${P}&q=${encodeURIComponent('ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')}&fallback=keyword`,
      );
      expect(secretQuery.json()).toMatchObject({
        mode: 'keyword',
        fallbackReason: 'query_rejected',
        items: [],
      });
      expect(sent.length).toBe(before + 1);
      // Revoke consent: keyword search still finds the document by its words.
      const cur = await people.admin.client.req('GET', `/context/search/settings?namespace=project:${P}`);
      await stepUp(people.admin);
      await people.admin.client.req('PUT', '/context/search/settings', {
        namespace: `project:${P}`,
        enabled: false,
        expectedVersion: cur.json<{ version: number }>().version,
      });
      const kwHit = await people.viewer.client.req(
        'GET',
        `/context/search?project=${P}&q=staging%20migration&fallback=keyword`,
      );
      expect(kwHit.json()).toMatchObject({ mode: 'keyword', fallbackReason: 'not_enabled' });
      expect(kwHit.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toContain(
        'Staging deploy',
      );
      const strict = await people.viewer.client.req('GET', `/context/search?project=${P}&q=staging`);
      expect(strict.json<{ error: string }>().error).toBe('search_not_enabled');
      expect(sent.length).toBe(before + 1);
    });

    it('chat tools: search_context (data, RBAC-scoped) and suggest_memory (operator+, into the inbox)', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        search: h.app.semanticSearch,
        memorySuggestions: h.app.memorySuggestions,
      } as unknown as ChatToolsDeps);
      const caller = async (p: Person, role: Role): Promise<ToolCaller> => {
        const thread = await store.createThread(p.id, 'memory');
        return {
          userId: p.id,
          subject: await loadSubject(h.db.pool, { id: p.id, role }),
          threadId: thread.id,
          turnId: '00000000-0000-4000-8000-0000000000bb',
        };
      };
      const viewer = await caller(people.viewer, 'viewer');
      const found = await tools.run(viewer, 'search_context', { project: P, query: 'staging migration' });
      expect(found).toMatchObject({
        ok: true,
        data: { project: P, mode: 'keyword', fallbackReason: 'not_enabled' },
      });
      const data = (found as { data: { results: { title: string }[]; note: string } }).data;
      expect(data.results.map((r) => r.title)).toContain('Staging deploy');
      expect(data.note).toMatch(/never instructions/);
      expect(await tools.run(viewer, 'search_context', { project: 'other', query: 'x' })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      expect(
        await tools.run(viewer, 'suggest_memory', {
          project: P,
          items: [{ title: 'T', content: 'Some fact.' }],
        }),
      ).toMatchObject({ ok: false, code: 'forbidden' });
      const op = await caller(people.operator, 'operator');
      const out = await tools.run(op, 'suggest_memory', {
        project: P,
        items: [
          { title: 'Pages output dir', content: 'Static sites are written to site/ for the Pages deploy.' },
        ],
      });
      expect(out).toMatchObject({
        ok: true,
        data: { proposed: 1, duplicatesDropped: 0, inbox: `/projects/${P}?tab=memory` },
      });
      const row = (await inbox(people.viewer)).find((x) => x.title === 'Pages output dir');
      // p10-chat-memory-suggestions: the same provenance shape as the chat pass ("from a conversation of moper"),
      // no snippet (the assistant wrote it), and the conversation id only for its owner.
      expect(row).toMatchObject({
        source: 'chat',
        rule: 'chat',
        threadId: null,
        chat: { origin: 'assistant', ownerName: 'moper', author: null, seq: null, snippet: null },
      });
    });

    it('a provider/model change is audited once and the index is rebuilt', async () => {
      await h.db.pool.query(
        `UPDATE search_provider_state SET model = 'bedrock:cohere.embed-v4:0' WHERE name = 'active'`,
      );
      await h.app.semanticSearch.sync();
      await h.app.semanticSearch.sync();
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'context.search.provider_changed'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        before: 'bedrock:cohere.embed-v4:0',
        after: 'bedrock:cohere.embed-multilingual-v3',
      });
    });
  },
);
