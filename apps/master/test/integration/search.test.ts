import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { type Embedder, LocalHashEmbedder } from '../../src/search/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-vector (docs/design/p6-vector.md): consent-bound capture, RBAC-scoped search, deletion through the
 * context deletion receipts, consent revocation, reindex. The provider is the deterministic local embedder
 * wrapped in a recorder, so the test can prove what was (and was not) ever sent to "the provider".
 */

const PW = 'quartz-meadow-lantern-7';
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

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
  readonly secret: string;
  client: Client;
}

interface Hit {
  type: string;
  id: string;
  namespace: string;
  title: string;
  snippet: string;
  version: string;
  score: number;
}

let h: Harness;
let jobs: JobStore;
const embedder = new RecordingEmbedder();
const people = {} as Record<'admin' | 'operator' | 'viewer', Person>;
const docs: Record<string, string> = {};

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

async function createDoc(ns: string, title: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await people.admin.client.req('POST', '/context/docs', {
    namespace: ns,
    kind: 'reference',
    title,
    content,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ document: { id: string } }>().document.id;
}

async function setConsent(
  namespace: string,
  enabled: boolean,
): Promise<{ version: number; indexed: number }> {
  const cur = await people.admin.client.req('GET', `/context/search/settings?namespace=${namespace}`);
  expect(cur.statusCode, cur.body).toBe(200);
  await stepUp(people.admin);
  const res = await people.admin.client.req('PUT', '/context/search/settings', {
    namespace,
    enabled,
    expectedVersion: cur.json<{ version: number }>().version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function search(p: Person, project: string, q: string) {
  return p.client.req('GET', `/context/search?project=${project}&q=${encodeURIComponent(q)}`);
}

async function hits(p: Person, project: string, q: string): Promise<Hit[]> {
  const res = await search(p, project, q);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ items: Hit[] }>().items;
}

async function vectors(): Promise<
  { namespace: string; doc_id: string | null; job_id: string | null; source_version: string }[]
> {
  const { rows } = await h.db.pool.query<{
    namespace: string;
    doc_id: string | null;
    job_id: string | null;
    source_version: string;
  }>('SELECT namespace, doc_id::text, job_id::text, source_version FROM search_embeddings ORDER BY id');
  return rows;
}

describeIntegration(
  'semantic search: consent-bound capture, RBAC, deletion and reindex (integration)',
  () => {
    beforeAll(async () => {
      h = new Harness();
      await h.start({ search: { embedder } });
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      people.admin = await person('admin1', 'admin', []);
      people.operator = await person('oper1', 'operator', ['sa', 'sb']);
      people.viewer = await person('viewer1', 'viewer', ['sa']);
      docs.runbook = await createDoc(
        'project:sa',
        'Deploy runbook',
        'How to roll back a failed kubernetes deployment: kubectl rollout undo, then verify the health checks.',
      );
      docs.coffee = await createDoc(
        'project:sa',
        'Coffee machine',
        'Descale the coffee machine every month.',
      );
      docs.adminOnly = await createDoc(
        'project:sa',
        'Deploy admin notes',
        'Deployment rollback escalation contacts.',
        {
          readRole: 'admin',
          writeRole: 'admin',
        },
      );
      docs.other = await createDoc(
        'project:sb',
        'Deploy rollback for sb',
        'Project sb kubernetes deployment rollback.',
      );
      docs.globalAll = await createDoc(
        'global',
        'Global deploy policy',
        'Every deployment rollback needs a ticket.',
        {},
      );
      docs.globalListed = await createDoc(
        'global',
        'Listed deploy note',
        'Deployment rollback note only for sb.',
        {
          projects: ['sb'],
        },
      );
    });
    afterAll(async () => {
      await h.stop();
    });

    it('is off by default: nothing is indexed or sent, search answers search_not_enabled', async () => {
      const s = await people.viewer.client.req('GET', '/context/search/settings?namespace=project:sa');
      expect(s.json()).toMatchObject({
        available: true,
        enabled: false,
        version: 0,
        indexed: 0,
        model: embedder.model,
      });
      await h.app.semanticSearch.sync();
      expect(await vectors()).toEqual([]);
      expect(embedder.sent).toEqual([]);
      const res = await search(people.viewer, 'sa', 'deployment rollback');
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('search_not_enabled');
    });

    it('only admins with a fresh step-up give consent (optimistic, audited)', async () => {
      const body = { namespace: 'project:sa', enabled: true, expectedVersion: 0 };
      expect((await people.operator.client.req('PUT', '/context/search/settings', body)).statusCode).toBe(
        403,
      );
      h.clock.advance(11 * 60_000);
      const stale = await people.admin.client.req('PUT', '/context/search/settings', body);
      expect(stale.json<{ error: string }>().error).toBe('step_up_required');
      await stepUp(people.admin);
      const ok = await people.admin.client.req('PUT', '/context/search/settings', body);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ enabled: true, version: 1 });
      const again = await people.admin.client.req('PUT', '/context/search/settings', body);
      expect(again.json<{ error: string }>().error).toBe('search_consent_conflict');
      const { rows } = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'context.search.consent' ORDER BY id`,
      );
      expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['success', 'denied']));
      expect(rows.find((r) => r.outcome === 'success')?.metadata).toMatchObject({
        namespace: 'project:sa',
        before: false,
        after: true,
      });
    });

    it('captures only consented namespaces and only documents (never other projects or ungranted text)', async () => {
      const stats = await h.app.semanticSearch.sync();
      expect(stats.indexedDocs).toBe(3);
      const v = await vectors();
      expect(v.map((r) => r.namespace)).toEqual(['project:sa', 'project:sa', 'project:sa']);
      expect(embedder.sent.join('\n')).not.toMatch(/Project sb|only for sb|needs a ticket/);
    });

    it('search is scoped by project membership and document read role', async () => {
      const asViewer = await hits(people.viewer, 'sa', 'how do I roll back a kubernetes deployment');
      expect(asViewer[0]?.title).toBe('Deploy runbook');
      expect(asViewer[0]).toMatchObject({
        type: 'context_doc',
        id: docs.runbook,
        namespace: 'project:sa',
        version: '1',
      });
      expect(asViewer.map((x) => x.id)).not.toContain(docs.adminOnly);
      expect(asViewer.map((x) => x.id)).not.toContain(docs.other);
      const asAdmin = await hits(people.admin, 'sa', 'deployment rollback escalation');
      expect(asAdmin.map((x) => x.id)).toContain(docs.adminOnly);
      // Not a member of sb.
      expect((await search(people.viewer, 'sb', 'rollback')).statusCode).toBe(404);
      // Member of sb, but sb never consented.
      expect((await search(people.operator, 'sb', 'rollback')).json<{ error: string }>().error).toBe(
        'search_not_enabled',
      );
    });

    it('global documents join only with global consent, and only when granted to the project', async () => {
      await setConsent('global', true);
      await h.app.semanticSearch.sync();
      const found = await hits(people.viewer, 'sa', 'deployment rollback ticket');
      expect(found.map((x) => x.id)).toContain(docs.globalAll);
      expect(found.map((x) => x.id)).not.toContain(docs.globalListed);
    });

    it('indexes job result summaries of the project, never the prompt', async () => {
      const { job } = await jobs.create({
        project: 'sa',
        actor: CREATOR,
        submit: true,
        spec: {
          runtime: 'codex',
          prompt: 'zebra-prompt-text must never be indexed',
          repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/p' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      });
      const attempt = randomUUID();
      await h.db.pool.query(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
       VALUES ($1, $2, 1, 'w-search', 'ended', 'succeeded', now(), now())`,
        [attempt, job.id],
      );
      await h.db.pool.query(
        `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at, updated_at)
       VALUES ($1, $2, 'w-search', 'succeeded', $3, now(), now(), now())`,
        [
          attempt,
          job.id,
          { outcome: 'succeeded', summary: 'Fixed the flaky payment webhook retry handler.' },
        ],
      );
      const stats = await h.app.semanticSearch.sync();
      expect(stats.indexedJobs).toBe(1);
      const found = await hits(people.viewer, 'sa', 'payment webhook retry');
      expect(found[0]).toMatchObject({ type: 'job_summary', id: job.id, version: attempt });
      expect(found[0]?.snippet).toContain('payment webhook');
      expect(embedder.sent.join('\n')).not.toContain('zebra-prompt-text');
    });

    it('refuses secret-looking queries before they reach the provider', async () => {
      const before = embedder.sent.length;
      const res = await search(people.viewer, 'sa', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('search_query_rejected');
      expect(embedder.sent.length).toBe(before);
    });

    it('new versions are re-embedded; deletions disappear at once and their vectors go with the receipt', async () => {
      const v2 = await people.admin.client.req('POST', `/context/docs/${String(docs.coffee)}/versions`, {
        expectedVersion: 1,
        content: 'Descale the espresso machine weekly with citric acid.',
      });
      expect(v2.statusCode, v2.body).toBe(200);
      await h.app.semanticSearch.sync();
      expect((await vectors()).find((r) => r.doc_id === docs.coffee)?.source_version).toBe('2');

      await stepUp(people.admin);
      const del = await people.admin.client.req(
        'DELETE',
        `/context/docs/${String(docs.runbook)}?reason=obsolete`,
      );
      expect(del.statusCode, del.body).toBe(200);
      // Before the indexer ran: the live-row check already hides it.
      expect(
        (await hits(people.viewer, 'sa', 'kubernetes deployment rollback')).map((x) => x.id),
      ).not.toContain(docs.runbook);
      const stats = await h.app.semanticSearch.sync();
      expect(stats.receipts).toBeGreaterThanOrEqual(1);
      expect((await vectors()).some((r) => r.doc_id === docs.runbook)).toBe(false);
      const { rows } = await h.db.pool.query<{ c: string; m: string }>(
        `SELECT s.receipt_cursor::text AS c, (SELECT max(id)::text FROM context_deletion_receipts) AS m
         FROM search_index_state s WHERE name = 'context'`,
      );
      expect(rows[0]?.c).toBe(rows[0]?.m);
    });

    it('reindex rebuilds a namespace (admin, step-up, audited)', async () => {
      expect(
        (await people.operator.client.req('POST', '/context/search/reindex', { namespace: 'project:sa' }))
          .statusCode,
      ).toBe(403);
      await stepUp(people.admin);
      const res = await people.admin.client.req('POST', '/context/search/reindex', {
        namespace: 'project:sa',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ indexedDocs: 2, indexedJobs: 1 });
      const { rows } = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'context.search.reindex' AND outcome = 'success'`,
      );
      expect(rows).toHaveLength(1);
    });

    it('revoking consent deletes the namespace vectors immediately and stops search', async () => {
      const off = await setConsent('project:sa', false);
      expect(off.indexed).toBe(0);
      expect((await vectors()).filter((r) => r.namespace === 'project:sa')).toEqual([]);
      expect((await search(people.viewer, 'sa', 'espresso')).json<{ error: string }>().error).toBe(
        'search_not_enabled',
      );
      // A later pass does not bring them back.
      await h.app.semanticSearch.sync();
      expect((await vectors()).filter((r) => r.namespace === 'project:sa')).toEqual([]);
      const { rows } = await h.db.pool.query<{ metadata: { removedVectors: number } }>(
        `SELECT metadata FROM audit_events WHERE action = 'context.search.consent' AND outcome = 'success' ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0]?.metadata.removedVectors).toBe(3);
    });
  },
);
