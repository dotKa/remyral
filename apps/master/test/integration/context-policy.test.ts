import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { splitExport } from '../../src/audit/export.js';
import type { Role } from '../../src/auth/users.js';
import {
  type ContextActor,
  ContextPolicyService,
  ContextStore,
  MemoryWriteRefusedError,
} from '../../src/context/index.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const DAY = 86_400_000;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const PROJECTS = ['hold', 'ret', 'exp', 'mem', 'prune', 'leak-a', 'leak-b', 'leak-c'];

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let jobs: JobStore;
let store: ContextStore;
let policy: ContextPolicyService;
const people = {} as Record<Role, Person>;

async function person(username: string, role: Role): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, PROJECTS, role);
  const { secret } = await enroll(h, username, PW);
  return { id, secret, client: await fullLogin(h, username, PW, secret) };
}

async function stepUp(p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

/** Advancing the clock by days ends every session (idle/absolute expiry): log everyone in again. */
async function advanceDays(days: number): Promise<void> {
  h.clock.advance(days * DAY);
  for (const [name, p] of Object.entries(people)) {
    h.clock.advance(30_000);
    p.client = await fullLogin(h, `${name === 'operator' ? 'oper' : name}1`, PW, p.secret);
  }
}

/** A direct store actor with a fresh step-up (the store checks it itself). */
function actor(p: Person, role: Role): ContextActor {
  return { id: p.id, role, mfaAt: h.clock.now() };
}

async function createDoc(ns: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await people.admin.client.req('POST', '/context/docs', {
    namespace: ns,
    kind: 'instructions',
    title,
    content: `${title} body`,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ document: { id: string } }>().document.id;
}

async function addVersion(id: string, expected: number, content: string): Promise<void> {
  const res = await people.admin.client.req('POST', `/context/docs/${id}/versions`, {
    expectedVersion: expected,
    content,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const BASE = {
  maxAgeDays: null,
  maxVersions: null,
  legalHold: false,
  deleteRetentionDays: 30,
  memory: { enabled: true, maxBytes: 16384, maxPerJob: 20, maxPerHour: 60 },
};

async function putPolicy(namespace: string, over: Record<string, unknown>): Promise<{ version: number }> {
  const current = await people.admin.client.req('GET', `/context/policies?namespace=${namespace}`);
  const version = current.json<{ items: { version: number }[] }>().items[0]?.version ?? 0;
  await stepUp(people.admin);
  const res = await people.admin.client.req('PUT', '/context/policies', {
    ...BASE,
    namespace,
    expectedVersion: version,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ version: number }>();
}

async function createJob(project: string): Promise<string> {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt: 'Do the thing',
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/p' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  return job.id;
}

interface ReceiptJson {
  action: string;
  docId: string;
  versions: number[];
  contentHashes: string[];
  actor: { type: string; id: string | null };
  reason: string | null;
}

async function receipts(ns: string): Promise<ReceiptJson[]> {
  const res = await people.admin.client.req('GET', `/context/deletion-receipts?namespace=${ns}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ items: ReceiptJson[] }>().items;
}

describeIntegration(
  'context policy: retention, legal hold, memory writes, leaks, export (integration)',
  () => {
    beforeAll(async () => {
      h = new Harness();
      await h.start();
      const audit = new AuditLog(h.db.pool, h.clock.now);
      jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
      store = new ContextStore({ pool: h.db.pool, audit, clock: h.clock.now });
      policy = new ContextPolicyService({ pool: h.db.pool, audit, clock: h.clock.now }, store);
      people.admin = await person('admin1', 'admin');
      people.operator = await person('oper1', 'operator');
      people.viewer = await person('viewer1', 'viewer');
    });
    afterAll(async () => {
      await h.stop();
    });

    describe('namespace policies', () => {
      it('returns the defaults, and only admins with a fresh step-up may change them (optimistic, audited)', async () => {
        const def = await people.viewer.client.req('GET', '/context/policies?namespace=project:ret');
        expect(def.statusCode).toBe(200);
        expect(def.json()).toEqual({
          items: [
            {
              namespace: 'project:ret',
              explicit: false,
              version: 0,
              ...BASE,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        });
        const body = { ...BASE, namespace: 'project:ret', expectedVersion: 0, deleteRetentionDays: 7 };
        expect((await people.operator.client.req('PUT', '/context/policies', body)).statusCode).toBe(403);
        h.clock.advance(11 * 60_000);
        const stale = await people.admin.client.req('PUT', '/context/policies', body);
        expect(stale.json<{ error: string }>().error).toBe('step_up_required');
        await stepUp(people.admin);
        const bad = await people.admin.client.req('PUT', '/context/policies', { ...body, maxVersions: 0 });
        expect(bad.statusCode).toBe(400);
        expect(bad.json<{ issues: unknown[] }>().issues).toEqual([
          { field: 'maxVersions', code: 'out_of_range' },
        ]);
        const ok = await people.admin.client.req('PUT', '/context/policies', body);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(ok.json()).toMatchObject({ explicit: true, version: 1, deleteRetentionDays: 7 });
        const conflict = await people.admin.client.req('PUT', '/context/policies', body);
        expect(conflict.statusCode).toBe(409);
        const { rows } = await h.db.pool.query<{ outcome: string }>(
          `SELECT outcome FROM audit_events WHERE action = 'context.policy.update' ORDER BY id`,
        );
        expect(rows.map((r) => r.outcome)).toContain('success');
        expect(rows.map((r) => r.outcome)).toContain('denied');
      });
    });

    describe('deletion and receipts', () => {
      it('uses the namespace retention for deletions and writes a receipt without content', async () => {
        const id = await createDoc('project:ret', 'Ret doc');
        await addVersion(id, 1, 'second version body');
        await stepUp(people.admin);
        const del = await people.admin.client.req('DELETE', `/context/docs/${id}?reason=obsolete`);
        expect(del.statusCode, del.body).toBe(200);
        const purgeAfter = Date.parse(del.json<{ document: { purgeAfter: string } }>().document.purgeAfter);
        expect(purgeAfter - h.clock.now().getTime()).toBe(7 * DAY);
        const [r] = await receipts('project:ret');
        expect(r).toMatchObject({ action: 'delete', docId: id, versions: [1, 2], reason: 'obsolete' });
        expect(r?.contentHashes).toHaveLength(2);
        expect(JSON.stringify(r)).not.toContain('body');
        expect(
          (await people.operator.client.req('GET', '/context/deletion-receipts?namespace=project:ret'))
            .statusCode,
        ).toBe(403);
      });
    });

    describe('legal hold', () => {
      it('blocks deletion and purge until released; the purge then leaves a receipt', async () => {
        const early = await createDoc('project:hold', 'Deleted before the hold');
        const kept = await createDoc('project:hold', 'Kept under hold');
        await stepUp(people.admin);
        expect(
          (await people.admin.client.req('DELETE', `/context/docs/${early}?retentionDays=0`)).statusCode,
        ).toBe(200);
        await putPolicy('project:hold', { legalHold: true });

        await stepUp(people.admin);
        const refused = await people.admin.client.req('DELETE', `/context/docs/${kept}`);
        expect(refused.statusCode).toBe(409);
        expect(refused.json<{ error: string }>().error).toBe('context_legal_hold');
        // Defence in depth: the database refuses too.
        await expect(
          h.db.pool.query(
            'UPDATE context_documents SET deleted_at = now(), purge_after = now() WHERE id = $1',
            [kept],
          ),
        ).rejects.toMatchObject({ code: 'RA000' });

        await advanceDays(1);
        await stepUp(people.admin);
        const run = await people.admin.client.req('POST', '/context/purge', {});
        expect(run.statusCode, run.body).toBe(200);
        expect(run.json<{ purged: string[]; held: number }>().purged).not.toContain(early);
        expect(run.json<{ held: number }>().held).toBeGreaterThanOrEqual(1);
        const still = await h.db.pool.query('SELECT 1 FROM context_documents WHERE id = $1', [early]);
        expect(still.rowCount).toBe(1);

        await putPolicy('project:hold', { legalHold: false });
        const after = await policy.runRetention();
        expect(after.purged).toContain(early);
        expect((await receipts('project:hold')).map((r) => [r.action, r.docId])).toEqual([
          ['purge', early],
          ['delete', early],
        ]);
      });
    });

    describe('retention sweep', () => {
      it('expires documents past max age and prunes versions, keeping the current and pinned ones', async () => {
        const pinnedOld = await createDoc('project:prune', 'Old but pinned by a running job');
        const busy = await createDoc('project:prune', 'Busy');
        const jobId = await createJob('prune');
        const pinned = await store.issueForJob(jobId, { type: 'worker', id: 'w1' });
        expect(pinned.pinned).toBe(true);
        const stale = await createDoc('project:prune', 'Stale');
        await addVersion(busy, 1, 'v2');
        await addVersion(busy, 2, 'v3');
        await addVersion(busy, 3, 'v4');
        await putPolicy('project:prune', { maxAgeDays: 30, maxVersions: 2 });

        await advanceDays(31);
        await addVersion(busy, 4, 'v5 keeps it fresh');
        const run = await policy.runRetention();
        // Not `pinnedOld`: an unfinished job's pinned bundle must stay reproducible; it expires later.
        expect(run.expired).toEqual([stale]);
        expect(run.expired).not.toContain(pinnedOld);
        // Versions 1..5, current 5: keep 4 and 5; version 1 is pinned by an unfinished job.
        expect(run.pruned).toEqual([{ docId: busy, versions: [2, 3] }]);
        const versions = await h.db.pool.query<{ version: number }>(
          'SELECT version FROM context_doc_versions WHERE doc_id = $1 ORDER BY version',
          [busy],
        );
        expect(versions.rows.map((r) => r.version)).toEqual([1, 4, 5]);
        // The pinned bundle is still reproducible.
        const again = await store.issueForJob(jobId, { type: 'worker', id: 'w2' });
        expect(again.bundle.bundleHash).toBe(pinned.bundle.bundleHash);
        const kinds = (await receipts('project:prune')).map((r) => [r.action, r.docId, r.versions]);
        expect(kinds).toEqual(
          expect.arrayContaining([
            ['expire', stale, [1]],
            ['prune', busy, [2, 3]],
          ]),
        );
        const bundle = await people.admin.client.req('GET', '/context/bundle?project=prune&runtime=codex');
        expect(bundle.json<{ items: { docId: string }[] }>().items.map((i) => i.docId)).not.toContain(stale);
        // Direct deletes of versions outside a prune transaction stay impossible.
        await expect(
          h.db.pool.query('DELETE FROM context_doc_versions WHERE doc_id = $1 AND version = 1', [busy]),
        ).rejects.toMatchObject({ code: 'RA000' });
        // The reindex feed sees every receipt in order.
        const feed = await policy.receiptsSince('0');
        expect(feed.map((r) => Number(r.id))).toEqual(
          [...feed.map((r) => Number(r.id))].sort((a, b) => a - b),
        );
      });
    });

    describe('memory-write policy', () => {
      it('enforces enabled, size and per-job quota for agent memories and audits refusals', async () => {
        await putPolicy('project:mem', {
          memory: { enabled: true, maxBytes: 300, maxPerJob: 2, maxPerHour: 60 },
        });
        const jobId = await createJob('mem');
        const grant = await jobs.acquireLease(jobId, 'worker-9', 3_600_000);
        const write = (content: string) =>
          store.recordAgentMemory({
            jobId,
            attemptId: grant.attempt.id,
            workerId: 'worker-9',
            title: 'note',
            content,
          });
        await write('one');
        await expect(write('x'.repeat(301))).rejects.toMatchObject({ code: 'memory_too_large' });
        await write('two');
        await expect(write('three')).rejects.toBeInstanceOf(MemoryWriteRefusedError);
        await expect(write('three')).rejects.toMatchObject({ code: 'memory_job_quota', httpStatus: 429 });
        await putPolicy('project:mem', {
          memory: { enabled: false, maxBytes: 300, maxPerJob: 20, maxPerHour: 60 },
        });
        await expect(write('four')).rejects.toMatchObject({ code: 'agent_memory_disabled' });
        const { rows } = await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_events WHERE action = 'context.memory.record' AND outcome = 'denied'`,
        );
        expect(rows[0]?.n).toBe(4);
      });
    });

    describe('cross-project leak check (property over random grants)', () => {
      it('no project ever receives a document it cannot read', async () => {
        const projects = ['leak-a', 'leak-b', 'leak-c'];
        let seed = 42;
        const rand = () => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed / 2147483648;
        };
        const docs: { id: string; ns: string }[] = [];
        for (const p of projects)
          docs.push({ id: await createDoc(`project:${p}`, `Own ${p}`), ns: `project:${p}` });
        for (let i = 0; i < 6; i++)
          docs.push({ id: await createDoc('global', `Global ${String(i)}`), ns: 'global' });
        const admin = () => actor(people.admin, 'admin');
        for (let round = 0; round < 8; round++) {
          // Random grants on every global document: all projects, a random subset, or none.
          for (const d of docs.filter((x) => x.ns === 'global')) {
            const r = rand();
            const grants = r < 0.3 ? '*' : projects.filter(() => rand() < 0.5);
            await store.setAccess(admin(), d.id, {
              readRole: 'viewer',
              writeRole: 'admin',
              projects: grants,
            });
          }
          const allowed = new Map<string, Set<string>>();
          const { rows } = await h.db.pool.query<{
            id: string;
            namespace: string;
            project_scope: string;
            grants: string[];
          }>(
            `SELECT d.id, d.namespace, d.project_scope,
                  COALESCE(array_agg(g.project) FILTER (WHERE g.project IS NOT NULL), '{}') AS grants
             FROM context_documents d LEFT JOIN context_doc_grants g ON g.doc_id = d.id
            WHERE d.deleted_at IS NULL GROUP BY d.id`,
          );
          for (const p of projects) {
            allowed.set(
              p,
              new Set(
                rows
                  .filter(
                    (d) =>
                      d.namespace === `project:${p}` ||
                      (d.namespace === 'global' && (d.project_scope === 'all' || d.grants.includes(p))),
                  )
                  .map((d) => d.id),
              ),
            );
          }
          for (const p of projects) {
            const view = await store.bundle(admin(), { project: p, runtime: 'codex' });
            for (const item of view.bundle.items.slice(1)) {
              expect(
                allowed.get(p)?.has(item.docId),
                `${p} got ${item.docId} in round ${String(round)}`,
              ).toBe(true);
            }
          }
        }
      });
    });

    describe('export', () => {
      it('exports a project’s live context as JSONL with a verifiable manifest (operator+, step-up, audited)', async () => {
        const id = await createDoc('project:exp', 'Exported');
        await addVersion(id, 1, 'second exported body');
        expect((await people.viewer.client.req('GET', '/context/export?project=exp')).statusCode).toBe(403);
        h.clock.advance(11 * 60_000);
        const noStepUp = await people.operator.client.req('GET', '/context/export?project=exp');
        expect(noStepUp.statusCode).toBe(403);
        await stepUp(people.operator);
        const res = await people.operator.client.req('GET', '/context/export?project=exp');
        expect(res.statusCode, res.body).toBe(200);
        expect(res.headers['content-type']).toContain('application/x-ndjson');
        const { body, manifest } = splitExport(res.body);
        expect(manifest).toMatchObject({ kind: 'context', record_count: 3, documents: 1, project: 'exp' });
        expect(createHash('sha256').update(body).digest('hex')).toBe(manifest.sha256);
        const lines = body
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(lines.map((l) => l.type)).toEqual(['document', 'version', 'version']);
        expect(lines[2]).toMatchObject({ doc_id: id, version: 2, content: 'second exported body' });
        const { rows } = await h.db.pool.query<{ metadata: { sha256: string } }>(
          `SELECT metadata FROM audit_events WHERE action = 'context.export.completed' ORDER BY id DESC LIMIT 1`,
        );
        expect(rows[0]?.metadata.sha256).toBe(manifest.sha256);
      });
    });
  },
);
