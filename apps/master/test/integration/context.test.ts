import { PLATFORM_POLICY_ID, verifyBundle } from '@remyral/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, verifyChain } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import {
  ContextBundleUnavailableError,
  ContextForbiddenError,
  ContextStore,
} from '../../src/context/index.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const DAY = 86_400_000;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
/** Format-correct fake Anthropic key assembled at runtime (never a literal in source). */
const CANARY = ['sk', 'ant', 'api03', 'Qw7Er9Ty2Ui4Op6As8Df1Gh3Jk5Lz0Xc'].join('-');

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let jobs: JobStore;
let store: ContextStore;
const people = {} as Record<Role, Person>;

const PROJECTS = [
  'acme',
  'agentmem',
  'alpha',
  'bravo',
  'del',
  'gate',
  'other-project',
  'perm',
  'roles',
  'ver',
];

async function person(username: string, role: Role): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  // p5-rbac: per-project accounts are members of the projects these tests use.
  if (role === 'operator' || role === 'viewer') await h.grant(id, PROJECTS, role);
  const { client, secret } = await enroll(h, username, PW);
  return { id, secret, client };
}

async function stepUp(p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

interface DocJson {
  document: { id: string; currentVersion: number; deletedAt: string | null; purgeAfter: string | null };
  version: { version: number; content: string; contentHash: string; provenance: Record<string, unknown> };
}

async function createDoc(p: Person, body: Record<string, unknown>): Promise<DocJson> {
  const res = await p.client.req('POST', '/context/docs', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<DocJson>();
}

interface BundleJson {
  bundleHash: string;
  pinned: boolean;
  items: { docId: string; layer: string; version: number; content: string | null; withheld: boolean }[];
}

async function bundle(
  project: string,
  runtime = 'claude-code',
  p: Person = people.operator,
): Promise<BundleJson> {
  const res = await p.client.req('GET', `/context/bundle?project=${project}&runtime=${runtime}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<BundleJson>();
}

async function auditCount(action: string, outcome: string, target?: string): Promise<number> {
  const { rows } = await h.db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND outcome = $2 AND ($3::text IS NULL OR target = $3)`,
    [action, outcome, target ?? null],
  );
  return rows[0]?.n ?? 0;
}

async function createJob(project: string, runtime = 'claude-code'): Promise<string> {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime,
      prompt: 'Fix the flaky test',
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/ctx' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  return job.id;
}

describeIntegration('context model (integration)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start();
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    store = new ContextStore({ pool: h.db.pool, audit, clock: h.clock.now });
    people.owner = await person('owner1', 'owner');
    people.admin = await person('admin1', 'admin');
    people.operator = await person('oper1', 'operator');
    people.viewer = await person('viewer1', 'viewer');
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('write permissions', () => {
    it('viewer cannot write; operator cannot write global; floors are enforced', async () => {
      const v = await people.viewer.client.req('POST', '/context/docs', {
        namespace: 'project:acme',
        kind: 'instructions',
        title: 'Nope',
        content: 'x',
      });
      expect(v.statusCode).toBe(403);
      const o = await people.operator.client.req('POST', '/context/docs', {
        namespace: 'global',
        kind: 'instructions',
        title: 'Nope',
        content: 'x',
      });
      expect(o.statusCode).toBe(403);
      const floor = await people.owner.client.req('POST', '/context/docs', {
        namespace: 'global',
        kind: 'instructions',
        title: 'Weak',
        content: 'x',
        writeRole: 'operator',
      });
      expect(floor.statusCode).toBe(400);
      expect(floor.json()).toMatchObject({ issues: [{ field: 'writeRole', code: 'below_floor' }] });
      const skill = await people.owner.client.req('POST', '/context/docs', {
        namespace: 'skill:lint',
        kind: 'instructions',
        title: 'Later',
        content: 'x',
      });
      expect(skill.statusCode).toBe(400);
      expect(await auditCount('context.doc.create', 'denied')).toBeGreaterThanOrEqual(4);

      // An operator may write project instructions, but not one locked to admins.
      await createDoc(people.operator, {
        namespace: 'project:perm',
        kind: 'instructions',
        title: 'Op rules',
        content: 'Operators wrote this.',
      });
      const locked = await createDoc(people.admin, {
        namespace: 'project:perm',
        kind: 'instructions',
        title: 'Admin rules',
        content: 'Admins wrote this.',
        writeRole: 'admin',
      });
      const res = await people.operator.client.req('POST', `/context/docs/${locked.document.id}/versions`, {
        expectedVersion: 1,
        content: 'Operator override',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('secret hygiene (ADR-0006, T-SEC-1)', () => {
    it('rejects a secret-looking value with its location and stores nothing', async () => {
      const res = await people.owner.client.req('POST', '/context/docs', {
        namespace: 'project:acme',
        kind: 'memory',
        title: 'API access',
        content: `Use this key:\n  ANTHROPIC ${CANARY}\n`,
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: string; findings: unknown[] }>();
      expect(body.error).toBe('context_secret_detected');
      expect(body.findings).toEqual([{ field: 'content', line: 2, column: 13, rule: 'anthropic-key' }]);
      expect(res.body).not.toContain(CANARY);

      const doc = await createDoc(people.owner, {
        namespace: 'project:acme',
        kind: 'memory',
        title: 'Clean',
        content: 'nothing secret',
      });
      const v2 = await people.owner.client.req('POST', `/context/docs/${doc.document.id}/versions`, {
        expectedVersion: 1,
        content: 'still clean',
        changeNote: `rotated to ${CANARY}`,
      });
      expect(v2.statusCode).toBe(400);
      expect(v2.json()).toMatchObject({ findings: [{ field: 'changeNote', rule: 'anthropic-key' }] });

      const dump = await h.db.pool.query<{ t: string }>(
        `SELECT coalesce(string_agg(t, ' '), '') AS t FROM (
           SELECT content || ' ' || title || ' ' || coalesce(change_note, '') AS t FROM context_doc_versions
           UNION ALL SELECT metadata::text FROM audit_events) x`,
      );
      expect(dump.rows[0]?.t).not.toContain(CANARY);
      expect(h.logs.text).not.toContain(CANARY);
      expect(await auditCount('context.doc.version', 'denied', `context:${doc.document.id}`)).toBe(1);
    });
  });

  describe('versioning and rollback', () => {
    it('versions are immutable, the pointer moves, rollback is audited', async () => {
      const created = await createDoc(people.admin, {
        namespace: 'project:ver',
        kind: 'instructions',
        title: 'Build',
        content: 'Use npm.',
        changeNote: 'initial',
      });
      const id = created.document.id;
      expect(created.version.provenance).toEqual({ type: 'user', userId: people.admin.id });

      const v2 = await people.admin.client.req('POST', `/context/docs/${id}/versions`, {
        expectedVersion: 1,
        content: 'Use pnpm.',
        changeNote: 'switch to pnpm',
      });
      expect(v2.statusCode, v2.body).toBe(200);
      expect(v2.json<DocJson>().document.currentVersion).toBe(2);

      const stale = await people.admin.client.req('POST', `/context/docs/${id}/versions`, {
        expectedVersion: 1,
        content: 'Use yarn.',
      });
      expect(stale.statusCode).toBe(409);

      const history = await people.viewer.client.req('GET', `/context/docs/${id}/versions`);
      expect(history.json<{ items: { version: number }[] }>().items.map((v) => v.version)).toEqual([2, 1]);

      const before = await bundle('ver');
      const rb = await people.admin.client.req('POST', `/context/docs/${id}/rollback`, {
        expectedVersion: 2,
        toVersion: 1,
        reason: 'pnpm broke CI',
      });
      expect(rb.statusCode, rb.body).toBe(200);
      expect(rb.json<DocJson>().version).toMatchObject({ version: 1, content: 'Use npm.' });
      const after = await bundle('ver');
      expect(after.bundleHash).not.toBe(before.bundleHash);
      expect(after.items.find((i) => i.docId === id)?.version).toBe(1);
      expect(await auditCount('context.doc.rollback', 'success', `context:${id}`)).toBe(1);

      // History is still linear: the next version is 3, version 2 is untouched.
      const v3 = await people.admin.client.req('POST', `/context/docs/${id}/versions`, {
        expectedVersion: 1,
        content: 'Use pnpm 12.',
      });
      expect(v3.json<DocJson>().version.version).toBe(3);
      const old = await people.viewer.client.req('GET', `/context/docs/${id}/versions/2`);
      expect(old.json<{ content: string }>().content).toBe('Use pnpm.');

      // Defence in depth: the database refuses edits and deletes of versions and documents.
      await expect(
        h.db.pool.query("UPDATE context_doc_versions SET content = 'x' WHERE doc_id = $1", [id]),
      ).rejects.toMatchObject({ code: 'RA000' });
      await expect(
        h.db.pool.query('DELETE FROM context_doc_versions WHERE doc_id = $1', [id]),
      ).rejects.toMatchObject({ code: 'RA000' });
      await expect(
        h.db.pool.query('DELETE FROM context_documents WHERE id = $1', [id]),
      ).rejects.toMatchObject({
        code: 'RA000',
      });
      expect(await auditCount('context.doc.version', 'success', `context:${id}`)).toBe(2);
    });
  });

  describe('retrieval permissions (T-INJ-5)', () => {
    it("a project never receives another project's documents or ungranted global ones", async () => {
      const a = await createDoc(people.admin, {
        namespace: 'project:alpha',
        kind: 'instructions',
        title: 'Alpha rules',
        content: 'Alpha only.',
      });
      const b = await createDoc(people.admin, {
        namespace: 'project:bravo',
        kind: 'instructions',
        title: 'Bravo rules',
        content: 'Bravo secret plans.',
      });
      const listed = await createDoc(people.admin, {
        namespace: 'global',
        kind: 'instructions',
        title: 'For bravo',
        content: 'Only bravo may read this.',
        projects: ['bravo'],
      });
      const alpha = await bundle('alpha');
      const ids = alpha.items.map((i) => i.docId);
      expect(ids).toContain(a.document.id);
      expect(ids).not.toContain(b.document.id);
      expect(ids).not.toContain(listed.document.id);
      const bravo = await bundle('bravo');
      expect(bravo.items.map((i) => i.docId)).toEqual(
        expect.arrayContaining([b.document.id, listed.document.id]),
      );
      expect(bravo.items.map((i) => i.docId)).not.toContain(a.document.id);

      // Granting alpha (admin + step-up) makes it visible there.
      h.clock.advance(11 * 60_000); // the admin's last TOTP is now stale
      const noStep = await people.admin.client.req('PUT', `/context/docs/${listed.document.id}/access`, {
        readRole: 'viewer',
        writeRole: 'admin',
        projects: ['alpha', 'bravo'],
      });
      expect(noStep.statusCode).toBe(403);
      await stepUp(people.admin);
      const grant = await people.admin.client.req('PUT', `/context/docs/${listed.document.id}/access`, {
        readRole: 'viewer',
        writeRole: 'admin',
        projects: ['alpha', 'bravo'],
      });
      expect(grant.statusCode, grant.body).toBe(200);
      expect((await bundle('alpha')).items.map((i) => i.docId)).toContain(listed.document.id);
      expect(await auditCount('context.doc.access', 'success', `context:${listed.document.id}`)).toBe(1);
    });

    it('role-scoped reads: hidden from viewers, withheld in bundles, bundle needs operator', async () => {
      const secretish = await createDoc(people.admin, {
        namespace: 'project:roles',
        kind: 'instructions',
        title: 'Incident playbook',
        content: 'Escalate to the on-call admin.',
        readRole: 'admin',
        writeRole: 'admin',
      });
      const id = secretish.document.id;
      expect((await people.viewer.client.req('GET', `/context/docs/${id}`)).statusCode).toBe(404);
      const list = await people.viewer.client.req('GET', '/context/docs?namespace=project:roles');
      expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
      expect((await people.admin.client.req('GET', `/context/docs/${id}`)).statusCode).toBe(200);

      const opView = await bundle('roles', 'codex', people.operator);
      const item = opView.items.find((i) => i.docId === id);
      expect(item).toMatchObject({ withheld: true, content: null });
      const adminView = await bundle('roles', 'codex', people.admin);
      expect(adminView.items.find((i) => i.docId === id)).toMatchObject({ withheld: false });
      expect(adminView.bundleHash).toBe(opView.bundleHash);

      const viewer = await people.viewer.client.req('GET', '/context/bundle?project=roles&runtime=codex');
      expect(viewer.statusCode).toBe(403);
      const bad = await people.operator.client.req('GET', '/context/bundle?project=roles&runtime=vim');
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('P6 gate: two workers reproduce the same project rules', () => {
    it('identical hash for both workers, pinned across edits; global edits change every reader', async () => {
      const global = await createDoc(people.admin, {
        namespace: 'global',
        kind: 'instructions',
        title: 'Org rules',
        content: 'Never force-push.',
      });
      const proj = await createDoc(people.operator, {
        namespace: 'project:gate',
        kind: 'instructions',
        title: 'Gate rules',
        content: 'Run pnpm verify before handing back.',
        runtimes: ['claude-code', 'codex'],
      });
      await createDoc(people.operator, {
        namespace: 'project:gate',
        kind: 'memory',
        title: 'Known flake',
        content: 'The websocket test flakes under load.',
      });
      const jobId = await createJob('gate');

      const w1 = await store.issueForJob(jobId, { type: 'worker', id: 'worker-mac' });
      const w2 = await store.issueForJob(jobId, { type: 'worker', id: 'worker-pi' });
      expect(w1.pinned).toBe(true);
      expect(w2.pinned).toBe(false);
      expect(w2.bundle.bundleHash).toBe(w1.bundle.bundleHash);
      expect(w2.bundle.items).toEqual(w1.bundle.items);
      expect(verifyBundle(w2.bundle)).toBe(true);
      expect(w1.bundle.items.map((i) => i.layer)).toEqual(['platform', 'global', 'project', 'memory']);
      expect(w1.bundle.items[0]?.docId).toBe(PLATFORM_POLICY_ID);
      expect(w1.bundle.items.map((i) => i.provenance.type)).toEqual(['platform', 'user', 'user', 'user']);

      // The console preview of the job shows the same pinned bundle.
      const preview = await people.operator.client.req(
        'GET',
        `/context/bundle?project=gate&runtime=claude-code&job=${jobId}`,
      );
      expect(preview.json<BundleJson>()).toMatchObject({ pinned: true, bundleHash: w1.bundle.bundleHash });

      // Changing the project rules changes the current bundle, but not what this job's workers receive.
      const edit = await people.operator.client.req('POST', `/context/docs/${proj.document.id}/versions`, {
        expectedVersion: 1,
        content: 'Run pnpm verify and pnpm build before handing back.',
      });
      expect(edit.statusCode).toBe(200);
      const current = await bundle('gate');
      expect(current.bundleHash).not.toBe(w1.bundle.bundleHash);
      const w3 = await store.issueForJob(jobId, { type: 'worker', id: 'worker-linux-1' });
      expect(w3.bundle.bundleHash).toBe(w1.bundle.bundleHash);
      const nextJob = await createJob('gate');
      const fresh = await store.issueForJob(nextJob, { type: 'worker', id: 'worker-linux-2' });
      expect(fresh.bundle.bundleHash).toBe(current.bundleHash);

      // A runtime the project rules do not apply to gets a different bundle.
      expect((await bundle('gate', 'pi')).bundleHash).not.toBe(current.bundleHash);

      // Changing a global doc changes the hash for every project that reads it.
      const other = await bundle('other-project');
      const edited = await people.admin.client.req('POST', `/context/docs/${global.document.id}/versions`, {
        expectedVersion: 1,
        content: 'Never force-push. Never skip hooks.',
      });
      expect(edited.statusCode).toBe(200);
      expect((await bundle('gate')).bundleHash).not.toBe(current.bundleHash);
      expect((await bundle('other-project')).bundleHash).not.toBe(other.bundleHash);

      // Every issuance is recorded with its hash (ADR-0010 §4).
      const { rows } = await h.db.pool.query<{ recipient_id: string; bundle_hash: string; pinned: boolean }>(
        'SELECT recipient_id, bundle_hash, pinned FROM context_bundle_deliveries WHERE job_id = $1 ORDER BY id',
        [jobId],
      );
      expect(rows.map((r) => [r.recipient_id, r.pinned])).toEqual([
        ['worker-mac', true],
        ['worker-pi', false],
        ['worker-linux-1', false],
      ]);
      expect(new Set(rows.map((r) => r.bundle_hash))).toEqual(new Set([w1.bundle.bundleHash]));
      expect(await auditCount('context.bundle.issue', 'success', `job:${jobId}`)).toBe(3);
      await expect(
        h.db.pool.query('DELETE FROM context_bundle_deliveries WHERE job_id = $1', [jobId]),
      ).rejects.toMatchObject({ code: 'RA000' });
    });
  });

  describe('agent memory provenance', () => {
    it('only the current attempt may record memory; it lands in its project with agent provenance', async () => {
      const jobId = await createJob('agentmem', 'codex');
      const grant = await jobs.acquireLease(jobId, 'worker-7', 3_600_000);
      const doc = await store.recordAgentMemory({
        jobId,
        attemptId: grant.attempt.id,
        workerId: 'worker-7',
        title: 'Build cache',
        content: 'The turbo cache lives in .cache/turbo.',
      });
      expect(doc.doc.namespace).toBe('project:agentmem');
      expect(doc.doc.kind).toBe('memory');
      expect(doc.version.provenance).toEqual({
        type: 'agent',
        jobId,
        attemptId: grant.attempt.id,
        workerId: 'worker-7',
      });
      const b = await bundle('agentmem', 'codex');
      expect(b.items.find((i) => i.docId === doc.doc.id)?.layer).toBe('memory');

      await expect(
        store.recordAgentMemory({
          jobId,
          attemptId: grant.attempt.id,
          workerId: 'worker-evil',
          title: 'x',
          content: 'y',
        }),
      ).rejects.toBeInstanceOf(ContextForbiddenError);
      expect(await auditCount('context.memory.record', 'denied')).toBe(1);
    });
  });

  describe('deletion and purge (A-UX-5)', () => {
    it('soft delete needs admin + step-up, hides immediately, purge removes rows after retention', async () => {
      const doc = await createDoc(people.operator, {
        namespace: 'project:del',
        kind: 'instructions',
        title: 'Old rules',
        content: 'Obsolete.',
      });
      const id = doc.document.id;
      const jobId = await createJob('del');
      await store.issueForJob(jobId, { type: 'worker', id: 'worker-1' });

      expect((await people.operator.client.req('DELETE', `/context/docs/${id}`)).statusCode).toBe(403);
      h.clock.advance(11 * 60_000); // the admin's last TOTP is now stale
      const stale = await people.admin.client.req('DELETE', `/context/docs/${id}`);
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });

      await stepUp(people.admin);
      const del = await people.admin.client.req(
        'DELETE',
        `/context/docs/${id}?retentionDays=7&reason=superseded`,
      );
      expect(del.statusCode, del.body).toBe(200);
      const deleted = del.json<{ document: DocJson['document'] }>().document;
      expect(deleted.deletedAt).not.toBeNull();
      expect(Date.parse(deleted.purgeAfter ?? '') - Date.parse(deleted.deletedAt ?? '')).toBe(7 * DAY);

      expect((await bundle('del')).items.map((i) => i.docId)).not.toContain(id);
      expect((await people.operator.client.req('GET', `/context/docs/${id}`)).statusCode).toBe(404);
      const adminList = await people.admin.client.req(
        'GET',
        '/context/docs?namespace=project:del&includeDeleted=true',
      );
      expect(adminList.json<{ items: unknown[] }>().items).toHaveLength(1);
      const write = await people.admin.client.req('POST', `/context/docs/${id}/versions`, {
        expectedVersion: 1,
        content: 'revive',
      });
      expect(write.statusCode).toBe(409);

      // The pinned job can no longer reproduce its rules: fail closed rather than substitute.
      await expect(store.issueForJob(jobId, { type: 'worker', id: 'worker-2' })).rejects.toBeInstanceOf(
        ContextBundleUnavailableError,
      );

      // Not yet due.
      await stepUp(people.admin);
      const early = await people.admin.client.req('POST', '/context/purge');
      expect(early.statusCode, early.body).toBe(200);
      expect(early.json<{ purged: string[] }>().purged).not.toContain(id);

      expect((await people.operator.client.req('POST', '/context/purge')).statusCode).toBe(403);
      // Role check independent of step-up: a freshly verified operator is still refused.
      await expect(
        store.purgeExpired({ id: people.operator.id, role: 'operator', mfaAt: h.clock.now() }),
      ).rejects.toBeInstanceOf(ContextForbiddenError);
      h.clock.advance(8 * DAY);
      people.admin.client = await fullLogin(h, 'admin1', PW, people.admin.secret);
      const purge = await people.admin.client.req('POST', '/context/purge');
      expect(purge.json<{ purged: string[] }>().purged).toContain(id);
      const left = await h.db.pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM context_documents WHERE id = $1)
              + (SELECT count(*) FROM context_doc_versions WHERE doc_id = $1) AS n`,
        [id],
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
      expect(await auditCount('context.doc.delete', 'success', `context:${id}`)).toBe(1);
      expect(await auditCount('context.doc.purge', 'success', `context:${id}`)).toBe(1);
      expect((await people.admin.client.req('GET', `/context/docs/${id}`)).statusCode).toBe(404);
    });
  });

  it('keeps the audit hash chain intact', async () => {
    const result = await verifyChain(h.db.pool);
    expect(result.ok).toBe(true);
  });
});
