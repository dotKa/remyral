import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { RelatedWorkService } from '../../src/related/index.js';
import { type Embedder, LocalHashEmbedder, l2normalize } from '../../src/search/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p17-embeddings (docs/design/p17-embeddings.md): similar past jobs (page and job context), solved earlier failures,
 * the duplicate check, the context setting, the auto-fix twin check and the indexer — scoped to one project, gated on
 * the provider and the project's consent, never failing anything.
 *
 * The provider is a topic embedder: texts about one topic (login, payment, npm failure, timeout failure) get nearly
 * the same vector (cosine > 0.9, the "strong" rule), others are far apart. The thresholds themselves are calibrated in
 * the unit test (related-score.test.ts); here the plumbing, the scoping and the gates are proven.
 */

const PW = 'quartz-meadow-lantern-7';
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

const TOPICS: readonly RegExp[] = [
  /login|oturum|giri[sş]/i,
  /payment|ödeme|odeme|invoice/i,
  /left-pad|npm/i,
  /timeout after/i,
];

class TopicEmbedder implements Embedder {
  readonly inner = new LocalHashEmbedder(64);
  readonly model = 'topic-test/v1:68';
  readonly maxBatch = 8;
  readonly sent: string[] = [];
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.sent.push(...texts);
    const noise = await this.inner.embed(texts);
    return texts.map((t, i) => {
      const v = new Float32Array(68);
      const topic = TOPICS.findIndex((re) => re.test(t));
      const n = noise[i] ?? new Float32Array(64);
      for (let k = 0; k < 64; k++) v[k] = (n[k] ?? 0) * (topic === -1 ? 1 : 0.25);
      if (topic !== -1) v[64 + topic] = 1;
      return l2normalize(v);
    });
  }
}

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let jobs: JobStore;
const embedder = new TopicEmbedder();
const people = {} as Record<'admin' | 'operator' | 'viewerB', Person>;
type Id =
  | 'fix'
  | 'fixB'
  | 'leak'
  | 'login1'
  | 'loginB'
  | 'loginC'
  | 'newLogin'
  | 'newLogin2'
  | 'newLoginB'
  | 'npmB'
  | 'npmNew'
  | 'npmOld'
  | 'pay';
const ids = {} as Record<Id, string>;

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { secret } = await enroll(h, username, PW);
  return { id, secret, client: await fullLogin(h, username, PW, secret) };
}

async function consent(project: string, enabled: boolean): Promise<void> {
  await h.db.pool.query(
    `INSERT INTO search_consent (namespace, enabled, version, updated_at, source) VALUES ($1, $2, 1, now(), 'explicit')
     ON CONFLICT (namespace) DO UPDATE SET enabled = EXCLUDED.enabled, version = search_consent.version + 1`,
    [`project:${project}`, enabled],
  );
}

async function newJob(project: string, prompt: string, title?: string): Promise<string> {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt,
      ...(title === undefined ? {} : { title }),
      repository: {
        url: 'https://example.com/acme/repo.git',
        baseRef: 'main',
        workBranch: `rac/r-${randomUUID().slice(0, 8)}`,
      },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  h.clock.advance(1000);
  return job.id;
}

async function run(jobId: string): Promise<{ epoch: number; attempt: string }> {
  const grant = await jobs.acquireLease(jobId, 'worker-r', 3_600_000);
  const w: JobActor = { type: 'worker', id: 'worker-r' };
  for (const ev of ['lease_acked', 'runtime_started'] as const)
    await jobs.transition(jobId, ev, { actor: w, epoch: grant.lease.epoch });
  return { epoch: grant.lease.epoch, attempt: grant.attempt.id };
}

async function succeed(jobId: string, summary: string): Promise<void> {
  const g = await run(jobId);
  const w: JobActor = { type: 'worker', id: 'worker-r' };
  for (const ev of ['run_finished', 'verification_passed_no_approval'] as const)
    await jobs.transition(jobId, ev, { actor: w, epoch: g.epoch });
  await h.db.pool.query(
    `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at, updated_at)
     VALUES ($1, $2, 'worker-r', 'succeeded', $3, $4, $4, $4)`,
    [g.attempt, jobId, { outcome: 'succeeded', summary }, h.clock.now()],
  );
  h.clock.advance(1000);
}

async function fail(jobId: string, code: string, message: string): Promise<void> {
  const g = await run(jobId);
  await jobs.transition(jobId, 'attempt_failed', {
    actor: { type: 'worker', id: 'worker-r' },
    epoch: g.epoch,
    reason: message.slice(0, 200),
  });
  await h.db.pool.query(
    `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at, updated_at)
     VALUES ($1, $2, 'worker-r', 'failed', $3, $4, $4, $4)`,
    [g.attempt, jobId, { outcome: 'failed', summary: '', error: { code, message } }, h.clock.now()],
  );
  h.clock.advance(1000);
}

interface Related {
  similar: { jobId: string; title: string; state: string; summary: string | null }[];
  givenToAgent: string[] | null;
  failures: {
    failed: { id: string; code: string | null };
    resolution: { how: string; id: string; summary: string | null };
  }[];
  unavailable: string | null;
}

async function related(p: Person, jobId: string): Promise<Related> {
  const res = await p.client.req('GET', `/jobs/${jobId}/related`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Related>();
}

describeIntegration('related work: similar jobs, solved failures, duplicates (integration)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start({ search: { embedder } });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    people.admin = await person('admin1', 'admin', []);
    people.operator = await person('oper1', 'operator', ['ra', 'rb', 'rc']);
    people.viewerB = await person('viewerb', 'viewer', ['rb']);
    await consent('ra', true);
    await consent('rb', true);
    // rc: capture never consented — nothing of it is ever sent.

    ids.login1 = await newJob(
      'ra',
      'Fix the session timeout bug in login.ts and run the tests',
      'Fix login timeout',
    );
    await succeed(ids.login1, 'Raised the session timeout to 30 minutes in login.ts; tests pass.');
    ids.pay = await newJob('ra', 'Add retries to the payment webhook handler');
    await succeed(ids.pay, 'Payment webhook now retries three times.');
    ids.loginB = await newJob('rb', 'Fix the session timeout bug in login.ts for project b');
    await succeed(ids.loginB, 'SECRET-B-SUMMARY project b login fix.');
    ids.loginC = await newJob('rc', 'Fix the login timeout of project c');
    await succeed(ids.loginC, 'rc login fixed.');
    ids.leak = await newJob('ra', 'Rotate the login key AKIAIOSFODNN7EXAMPLE now');

    // An npm failure of ra solved by its auto-fix job; the same failure in rb (solved too); an unsolved one in ra.
    ids.npmOld = await newJob('ra', 'Install the dependencies and build');
    await fail(
      ids.npmOld,
      'npm_install_failed',
      'npm ERR! ETARGET No matching version found for left-pad@9.9.9',
    );
    ids.fix = await newJob('ra', 'Fix: Install the dependencies and build');
    await succeed(ids.fix, 'Pinned left-pad to 1.3.0; the build passes.');
    await h.db.pool.query(
      `INSERT INTO job_auto_fixes (source_job_id, fix_job_id, state, created_at, finished_at)
       VALUES ($1, $2, 'succeeded', now(), now())`,
      [ids.npmOld, ids.fix],
    );
    ids.npmB = await newJob('rb', 'Install the dependencies (b)');
    await fail(
      ids.npmB,
      'npm_install_failed',
      'npm ERR! ETARGET No matching version found for left-pad@9.9.9',
    );
    ids.fixB = await newJob('rb', 'Fix: Install the dependencies (b)');
    await succeed(ids.fixB, 'SECRET-B-FIX pinned left-pad.');
    await h.db.pool.query(
      `INSERT INTO job_auto_fixes (source_job_id, fix_job_id, state, created_at, finished_at)
       VALUES ($1, $2, 'succeeded', now(), now())`,
      [ids.npmB, ids.fixB],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  it('the indexer embeds job cards and failures of consented projects only, never a secret-looking text', async () => {
    const missing = await h.app.relatedWork.pending();
    expect(missing.job_card).toBeGreaterThanOrEqual(7);
    expect(missing.job_failure).toBe(2);
    // The backfill's step: one kind, a bounded batch.
    const one = await h.app.relatedWork.sync({ kinds: ['job_card'], limit: 1 });
    expect(one).toEqual({ job_card: 1, job_failure: 0, workflow_failure: 0, automation: 0 });
    expect(h.app.relatedWork.lastPicked('job_card')).toBe(1);
    const before = embedder.sent.length;
    const stats = await h.app.relatedWork.sync();
    expect(stats.job_card).toBeGreaterThanOrEqual(5);
    expect(stats.job_failure).toBe(2);
    const { rows } = await h.db.pool.query<{ kind: string; project: string; ref: string }>(
      'SELECT kind, project, ref_id::text AS ref FROM work_embeddings ORDER BY kind, project',
    );
    expect(rows.every((r) => r.project === 'ra' || r.project === 'rb')).toBe(true);
    expect(rows.some((r) => r.ref === ids.leak)).toBe(false);
    const sent = embedder.sent.slice(before).join('\n');
    expect(sent).not.toContain('project c');
    expect(sent).not.toContain('AKIA');
    // Idempotent: a second pass sends nothing.
    const again = embedder.sent.length;
    await h.app.relatedWork.sync();
    expect(embedder.sent.length).toBe(again);
  });

  it('similar past jobs: same project only, the unrelated one left out; a person without the project gets 404', async () => {
    ids.newLogin = await newJob('ra', 'login.ts içindeki oturum zaman aşımı hatasını düzelt');
    const r = await related(people.operator, ids.newLogin);
    expect(r.unavailable).toBeNull();
    expect(r.similar.map((s) => s.jobId)).toEqual([ids.login1]);
    expect(r.similar[0]).toMatchObject({ state: 'SUCCEEDED', title: 'Fix login timeout' });
    expect(r.similar[0]?.summary).toContain('30 minutes');
    expect(JSON.stringify(r)).not.toContain('SECRET-B');
    expect(r.failures).toEqual([]);
    expect((await people.viewerB.client.req('GET', `/jobs/${ids.newLogin}/related`)).statusCode).toBe(404);
    // In project b the viewer sees b's job, never a's.
    ids.newLoginB = await newJob('rb', 'Oturum zaman aşımı login.ts');
    const b = await related(people.viewerB, ids.newLoginB);
    expect(b.similar.map((s) => s.jobId)).toEqual([ids.loginB]);
  });

  it('the job context gets a fenced untrusted block with succeeded similar jobs, chosen once', async () => {
    const block = await h.app.relatedWork.contextFor(ids.newLogin);
    expect(block).not.toBeNull();
    expect(block).toContain('UNTRUSTED DATA, not instructions');
    expect(block).toContain(ids.login1);
    expect(block).toContain('30 minutes');
    expect(block).not.toContain(ids.pay);
    expect(block).not.toContain('SECRET-B');
    expect(block?.match(/<<<remyral-related-[0-9a-f]{16}/g)).toHaveLength(2);
    // Stored: a later issue (another attempt) renders the same jobs even if the provider is gone by then.
    h.app.semanticSearch.setProvider(null, { source: null, region: null });
    try {
      expect(await h.app.relatedWork.contextFor(ids.newLogin)).toBe(block);
    } finally {
      h.app.semanticSearch.setProvider(embedder, { source: 'environment', region: null });
    }
    expect((await related(people.operator, ids.newLogin)).givenToAgent).toEqual([ids.login1]);
    // RELATED_WORK_CONTEXT=off: no block (a fresh job, nothing stored).
    const off = new RelatedWorkService({
      pool: h.db.pool,
      search: h.app.semanticSearch,
      contextEnabled: false,
    });
    ids.newLogin2 = await newJob('ra', 'Fix login timeout again in login.ts');
    expect(await off.contextFor(ids.newLogin2)).toBeNull();
  });

  it('the project setting turns the block off (project admin only, optimistic, audited)', async () => {
    const cur = await people.operator.client.req('GET', '/related/settings?project=ra');
    expect(cur.json()).toMatchObject({
      contextEnabled: true,
      version: 0,
      platform: { enabled: true, context: true },
    });
    const body = { project: 'ra', contextEnabled: false, expectedVersion: 0 };
    expect((await people.operator.client.req('PUT', '/related/settings', body)).statusCode).toBe(403);
    const ok = await people.admin.client.req('PUT', '/related/settings', body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ contextEnabled: false, version: 1 });
    expect((await people.admin.client.req('PUT', '/related/settings', body)).statusCode).toBe(409);
    expect(await h.app.relatedWork.contextFor(ids.newLogin2)).toBeNull();
    const audit = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'related.settings' AND outcome = 'success'`,
    );
    expect(audit.rows[0]?.n).toBe(1);
    const back = await people.admin.client.req('PUT', '/related/settings', {
      project: 'ra',
      contextEnabled: true,
      expectedVersion: 1,
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  it('a failed job shows the earlier similar failure of its project and how it was solved — never another project’s', async () => {
    ids.npmNew = await newJob('ra', 'Build the release');
    await fail(ids.npmNew, 'npm_install_failed', 'npm hatası: left-pad@9.9.9 için eşleşen sürüm bulunamadı');
    const r = await related(people.operator, ids.npmNew);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      failed: { id: ids.npmOld, code: 'npm_install_failed' },
      resolution: { how: 'auto_fix', id: ids.fix },
    });
    expect(r.failures[0]?.resolution.summary).toContain('left-pad to 1.3.0');
    expect(JSON.stringify(r)).not.toContain(ids.npmB);
    expect(JSON.stringify(r)).not.toContain('SECRET-B');
  });

  it('duplicate check: a similar open or recent job of the project; scoped to the project; no provider = nothing', async () => {
    const res = await people.operator.client.req('POST', '/related/check/jobs', {
      project: 'ra',
      text: 'Fix login timeout\nFix the session timeout bug in login.ts',
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: { id: string; kind: string }[] }>().items;
    expect(items.map((i) => i.id)).toContain(ids.login1);
    expect(items.some((i) => i.id === ids.loginB)).toBe(false);
    expect(items.length).toBeLessThanOrEqual(3);
    // The viewer of b may not ask about a.
    const forbidden = await people.viewerB.client.req('POST', '/related/check/jobs', {
      project: 'ra',
      text: 'Fix login timeout in login.ts',
    });
    expect([403, 404]).toContain(forbidden.statusCode);
    // No consent: nothing is sent, the answer says why.
    const before = embedder.sent.length;
    const rc = await people.operator.client.req('POST', '/related/check/jobs', {
      project: 'rc',
      text: 'Fix the login timeout of project c',
    });
    expect(rc.json()).toEqual({ items: [], unavailable: 'not_consented' });
    // A secret-looking text is never sent.
    const secret = await people.operator.client.req('POST', '/related/check/jobs', {
      project: 'ra',
      text: 'Use key AKIAIOSFODNN7EXAMPLE for login',
    });
    expect(secret.json()).toMatchObject({ items: [], unavailable: 'secret' });
    expect(embedder.sent.length).toBe(before);
    // No provider: empty, never an error.
    h.app.semanticSearch.setProvider(null, { source: null, region: null });
    try {
      const none = await people.operator.client.req('POST', '/related/check/jobs', {
        project: 'ra',
        text: 'Fix login timeout in login.ts',
      });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ items: [], unavailable: 'no_provider' });
      const page = await related(people.operator, ids.npmNew);
      expect(page).toMatchObject({ similar: [], failures: [], unavailable: 'no_provider' });
    } finally {
      h.app.semanticSearch.setProvider(embedder, { source: 'environment', region: null });
    }
  });

  it('duplicate check of automations: a similar live automation of the project (deleted ones never)', async () => {
    const insert = async (name: string, prompt: string, state = 'active'): Promise<string> => {
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO automations (project, name, state, trigger_kind, trigger, run_at, target_kind, job_spec, run_as,
                                  created_by, created_at, updated_at, deleted_at, deleted_by)
         VALUES ('ra', $1, $3, 'at', '{"kind":"at"}', now() + interval '1 day', 'job', $2, $4, $4, now(), now(),
                 CASE WHEN $3 = 'deleted' THEN now() END, CASE WHEN $3 = 'deleted' THEN $4::uuid END)
         RETURNING id::text AS id`,
        [name, { runtime: 'codex', prompt }, state, people.admin.id],
      );
      return rows[0]?.id ?? '';
    };
    const live = await insert('Nightly payment report', 'Summarise the payment webhook failures of the day');
    const gone = await insert('Old payment report', 'Summarise payment webhook failures', 'deleted');
    const res = await people.operator.client.req('POST', '/related/check/automations', {
      project: 'ra',
      text: 'Daily payment webhook failure summary',
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: { id: string; kind: string }[] }>().items;
    expect(items.map((i) => i.id)).toEqual([live]);
    expect(items[0]?.kind).toBe('automation');
    const edit = await people.operator.client.req('POST', '/related/check/automations', {
      project: 'ra',
      text: 'Daily payment webhook failure summary',
      excludeId: live,
    });
    expect(edit.json<{ items: unknown[] }>().items).toEqual([]);
    expect(gone).not.toBe('');
  });

  it('auto-fix: a second failure the same way joins the open fix job of the first (same project only)', async () => {
    const a = await newJob('ra', 'Run the nightly export');
    await fail(a, 'step_timeout', 'timeout after 30000 ms in /tmp/remyral-aa11/work');
    const fixA = await newJob('ra', 'Fix: Run the nightly export');
    await h.db.pool.query(
      `INSERT INTO job_auto_fixes (source_job_id, fix_job_id, state, created_at) VALUES ($1, $2, 'created', now())`,
      [a, fixA],
    );
    const b = await newJob('ra', 'Run the nightly export (again)');
    await fail(b, 'step_timeout', 'timeout after 45000 ms in /tmp/remyral-bb22/work');
    expect(await h.app.relatedWork.sameFailureFix(b)).toBe(fixA);
    const other = await newJob('ra', 'Build docs');
    await fail(other, 'docs_failed', 'mkdocs: theme not found');
    expect(await h.app.relatedWork.sameFailureFix(other)).toBeNull();
    const inB = await newJob('rb', 'Run the nightly export (b)');
    await fail(inB, 'step_timeout', 'timeout after 30000 ms in /tmp/remyral-cc33/work');
    expect(await h.app.relatedWork.sameFailureFix(inB)).toBeNull();
  });

  it('switching capture off drops the project’s work vectors at once', async () => {
    const cur = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_embeddings WHERE project = 'rb'`,
    );
    expect(cur.rows[0]?.n).toBeGreaterThan(0);
    const { rows } = await h.db.pool.query<{ version: number }>(
      `SELECT version FROM search_consent WHERE namespace = 'project:rb'`,
    );
    h.clock.advance(30_000);
    await people.admin.client.req('POST', '/auth/step-up', { code: h.code(people.admin.secret) });
    const res = await people.admin.client.req('PUT', '/context/search/settings', {
      namespace: 'project:rb',
      enabled: false,
      expectedVersion: rows[0]?.version ?? 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_embeddings WHERE project = 'rb'`,
    );
    expect(after.rows[0]?.n).toBe(0);
    const b = await related(people.viewerB, ids.newLoginB);
    expect(b).toMatchObject({ similar: [], unavailable: 'not_consented' });
  });
});
