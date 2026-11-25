import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatWorkfiles } from '../../src/chat/workfiles-actions.js';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo } from '../helpers/job-worker.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p15-workspace-retention against a real master (Postgres) and raw workers: ASSIGN_JOB keepFiles / seedFiles, the
 * records from WORKFILES_STATUS / CAPABILITIES, the job's "Çalışma dosyaları" (tree, file, zip streamed from the
 * machine), RBAC, pins (a pending deploy and an unfinished follow-up keep the files past their expiry), the sweep
 * (expiry, machine cap oldest-first, never a pinned one), "Temizle" and bulk clean-up (audited), the relay of a
 * follow-up on another machine (WORKFILES_FETCH fenced by its lease), run again from kept files, and "Repoya aktar"
 * (branch + pull request into the project's repository).
 */
const PW = 'quartz-meadow-lantern-7';
const WS = 'genel';
const REPO_PROJECT = 'site';
const REPO_URL = 'https://example.com/acme/site.git';
const DAY = 86_400_000;
const h = new Harness();
const dirs: string[] = [];
let jobs: JobStore;
let owner: Client;
let operator: Client;
let operatorId = '';
let viewer: Client;
let outsider: Client;
let a: RawWorker;
let b: RawWorker;
let aId = '';
let bId = '';
let fileUrl = '';
const secrets = new Map<string, string>();

/** Sessions do not survive the clock jumps of the expiry tests: log in again. */
async function relogin(): Promise<void> {
  owner = await fullLogin(h, 'owner1', PW, secrets.get('owner1') ?? '');
  operator = await fullLogin(h, 'oper1', PW, secrets.get('oper1') ?? '');
  viewer = await fullLogin(h, 'view1', PW, secrets.get('view1') ?? '');
  outsider = await fullLogin(h, 'oper2', PW, secrets.get('oper2') ?? '');
}
let wsUrl = '';

type Req = Extract<MasterToWorker, { type: 'WORKFILES_REQUEST' }>;

/** What machine A "keeps": job id → path → content. */
const kept = new Map<string, Map<string, Buffer>>();
const seenOps: string[] = [];

function caps(w: RawWorker, workerId: string, report?: unknown): void {
  w.sendJson(
    w.envelope(
      'CAPABILITIES',
      {
        runtimes: [],
        sandboxProfiles: ['host-restricted'],
        maxParallelJobs: 2,
        tools: [],
        features: ['workspace-v1', 'workfiles-v1'],
        ...(report === undefined ? {} : { workfiles: report }),
      },
      { workerId },
    ),
  );
}

/** Answers WORKFILES_REQUEST from `kept` (machine A) until the test ends. */
function respond(w: RawWorker, workerId: string): void {
  const state = { stop: false };
  void (async () => {
    while (!state.stop) {
      let m: Req;
      try {
        m = await w.next('WORKFILES_REQUEST', 60_000);
      } catch {
        continue;
      }
      const p = m.payload;
      seenOps.push(`${p.op.op}:${p.jobId.slice(0, 8)}`);
      const files = kept.get(p.jobId);
      const base = { requestId: p.requestId };
      let answer: Record<string, unknown>;
      if (files === undefined) answer = { ...base, status: 'not_found' };
      else if (p.op.op === 'list') {
        const dirsSeen = new Set<string>();
        const entries: Record<string, unknown>[] = [];
        for (const [path, c] of files) {
          const parts = path.split('/');
          for (let i = 1; i < parts.length; i++) dirsSeen.add(parts.slice(0, i).join('/'));
          entries.push({ path, kind: 'file', size: c.length, mtime: new Date().toISOString() });
        }
        for (const d of dirsSeen)
          entries.push({ path: d, kind: 'dir', size: 0, mtime: new Date().toISOString() });
        answer = { ...base, status: 'ok', entries, truncated: false };
      } else if (p.op.op === 'read') {
        const c = files.get(p.op.path);
        if (c === undefined) answer = { ...base, status: 'not_found' };
        else {
          const chunk = c.subarray(p.op.offset, p.op.offset + 192 * 1024);
          answer = {
            ...base,
            status: 'ok',
            offset: p.op.offset,
            data: chunk.toString('base64'),
            eof: p.op.offset + chunk.length >= c.length,
            size: c.length,
          };
        }
      } else if (p.op.op === 'delete') {
        kept.delete(p.jobId);
        answer = { ...base, status: 'ok' };
      } else {
        answer = { ...base, status: 'ok' };
      }
      w.sendJson(w.envelope('WORKFILES_DATA', answer, { workerId }));
    }
  })();
  stops.push(() => {
    state.stop = true;
  });
}
const stops: (() => void)[] = [];

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function pair(code: string): Promise<{ w: RawWorker; id: string }> {
  const w = await RawWorker.connect(wsUrl, new TestKey());
  const pending = await w.handshake({ pairingCode: code });
  const id = pending.workerId ?? '';
  expect((await owner.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
  await w.next('SESSION_ESTABLISHED');
  caps(w, id);
  await waitFor(async () => {
    const r = await h.db.pool.query<{ ok: boolean }>(
      `SELECT features ? 'workfiles-v1' AS ok FROM workers WHERE id = $1`,
      [id],
    );
    return r.rows[0]?.ok === true;
  });
  return { w, id };
}

const wsSpec = (prompt = 'make the presentation and deploy it') => ({
  runtime: 'claude-code',
  prompt,
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 3600 },
  workspace: { egress: 'none' },
});

async function finishedJob(workerId: string): Promise<{ id: string; attemptId: string }> {
  const { job } = await jobs.create({
    project: WS,
    actor: { type: 'user', id: operatorId },
    submit: true,
    spec: wsSpec(),
  });
  const grant = await jobs.acquireLease(job.id, workerId, 60 * 60_000);
  const actor: JobActor = { type: 'worker', id: workerId };
  await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
  await jobs
    .transition(job.id, 'attempt_failed', { actor, epoch: grant.lease.epoch, reason: 'deploy failed' })
    .catch(() => undefined);
  return { id: job.id, attemptId: grant.attempt.id };
}

/** Machine A reports a kept directory (WORKFILES_STATUS). */
async function reportKept(
  job: { id: string; attemptId: string },
  sizeBytes: number,
  files: Map<string, Buffer>,
) {
  kept.set(job.id, files);
  const keptAt = h.clock.now().toISOString();
  a.sendJson(
    a.envelope(
      'WORKFILES_STATUS',
      {
        maxBytes: 10 * 1024 ** 3,
        usedBytes: sizeBytes,
        kept: [
          {
            jobId: job.id,
            attemptId: job.attemptId,
            projectId: WS,
            outcome: 'failed',
            sizeBytes,
            files: files.size,
            keptAt,
            expiresAt: new Date(h.clock.now().getTime() + 14 * DAY).toISOString(),
            pinnedUntil: null,
          },
        ],
        removed: [],
      },
      { workerId: aId },
    ),
  );
  await waitFor(async () => {
    const r = await h.db.pool.query('SELECT 1 FROM job_workfiles WHERE attempt_id = $1', [job.attemptId]);
    return (r.rowCount ?? 0) > 0;
  });
}

const deck = () =>
  new Map<string, Buffer>([
    ['out/deck/index.html', Buffer.from('<h1>Sunum</h1>')],
    [
      'out/deck/slide.png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(300_000, 7),
      ]),
    ],
    ['notes/plan.md', Buffer.from('# plan')],
  ]);

describeIntegration(
  'kept working directories (integration, p15-workspace-retention)',
  { timeout: 240_000 },
  () => {
    beforeAll(async () => {
      fileUrl = await createBareRepo(dirs);
      const cacheDir = await mkdtemp(join(tmpdir(), 'rw-wf-cache-'));
      dirs.push(cacheDir);
      const provider = new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true });
      await h.start({
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
        gitflow: { providers: () => provider, timing: { refreshIntervalMs: 0 } },
      });
      wsUrl = await h.listen();
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      await h.createUser('owner1', PW, 'owner');
      const ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      secrets.set('owner1', ownerSecret);
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [
        REPO_PROJECT,
      ]);
      await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
      operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [WS, REPO_PROJECT], 'operator');
      secrets.set('oper1', (await enroll(h, 'oper1', PW)).secret);
      operator = await fullLogin(h, 'oper1', PW, secrets.get('oper1') ?? '');
      const vw = await h.createUser('view1', PW, 'viewer');
      await h.grant(vw, [WS], 'viewer');
      secrets.set('view1', (await enroll(h, 'view1', PW)).secret);
      viewer = await fullLogin(h, 'view1', PW, secrets.get('view1') ?? '');
      const out = await h.createUser('oper2', PW, 'operator');
      await h.grant(out, ['other'], 'operator');
      secrets.set('oper2', (await enroll(h, 'oper2', PW)).secret);
      outsider = await fullLogin(h, 'oper2', PW, secrets.get('oper2') ?? '');
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
      ({ w: a, id: aId } = await pair('WFAA-ABCD'));
      ({ w: b, id: bId } = await pair('WFBB-ABCD'));
      respond(a, aId);
      const put = await owner.req('PUT', `/projects/${REPO_PROJECT}/git`, {
        expectedVersion: 0,
        provider: 'git',
        repositoryUrl: REPO_URL,
        baseBranch: 'main',
        mergeMethod: 'merge',
      });
      expect(put.statusCode, put.body).toBe(200);
    });

    afterAll(async () => {
      for (const s of stops) s();
      a.close();
      b.close();
      await h.stop();
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    });

    it('assigns keepFiles (retention, cap) to workspace jobs on workfiles-v1 workers; 0 days keeps nothing', async () => {
      const job = await finishedJob(aId);
      const spec = { workspace: { egress: 'none' } };
      const got = await h.app.workfiles.assignment({ id: job.id, project: WS, spec }, aId);
      expect(got.keepFiles?.maxBytes).toBe(10 * 1024 ** 3);
      expect(Date.parse(got.keepFiles?.expiresAt ?? '') - h.clock.now().getTime()).toBe(14 * DAY);
      expect(await h.app.workfiles.assignment({ id: job.id, project: WS, spec: {} }, aId)).toEqual({});
      // A project's own 0 days: deleted at the end as before.
      expect((await viewer.req('PUT', `/projects/${WS}/workfiles`, { retentionDays: 0 })).statusCode).toBe(
        403,
      );
      const put = await owner.req('PUT', `/projects/${WS}/workfiles`, { retentionDays: 0 });
      expect(put.statusCode, put.body).toBe(200);
      expect(
        (await h.app.workfiles.assignment({ id: job.id, project: WS, spec }, aId)).keepFiles,
      ).toBeUndefined();
      expect(
        (await owner.req('PUT', `/projects/${WS}/workfiles`, { retentionDays: null })).json(),
      ).toMatchObject({
        retentionDays: null,
        effectiveDays: 14,
      });
    });

    it('records a kept directory, shows it with RBAC, and streams its tree, a file and a zip from the machine', async () => {
      const job = await finishedJob(aId);
      await reportKept(job, 300_028, deck());
      const row = await h.db.pool.query<{ expires_at: Date; state: string }>(
        'SELECT expires_at, state FROM job_workfiles WHERE attempt_id = $1',
        [job.attemptId],
      );
      expect(row.rows[0]?.state).toBe('kept');
      expect(row.rows[0]?.expires_at.getTime()).toBe(h.clock.now().getTime() + 14 * DAY);

      const one = await viewer.req('GET', `/jobs/${job.id}/workfiles`);
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json()).toMatchObject({
        workfiles: { jobId: job.id, workerId: aId, state: 'kept', outcome: 'failed', files: 3 },
        pins: [],
        retentionDays: 14,
      });
      expect((await outsider.req('GET', `/jobs/${job.id}/workfiles`)).statusCode).toBe(404);
      const list = await viewer.req('GET', `/workfiles?project=${WS}`);
      expect(list.json<{ items: { jobId: string }[] }>().items.map((i) => i.jobId)).toContain(job.id);

      const tree = await viewer.req('GET', `/jobs/${job.id}/workfiles/tree`);
      expect(tree.statusCode, tree.body).toBe(200);
      const entries = tree.json<{ entries: { path: string; preview: string }[] }>().entries;
      expect(entries.find((e) => e.path === 'out/deck/index.html')?.preview).toBe('html');
      expect(entries.find((e) => e.path === 'out/deck/slide.png')?.preview).toBe('image');

      // An image larger than one chunk: streamed in two reads, inline with its own type.
      const img = await viewer.req(
        'GET',
        `/jobs/${job.id}/workfiles/file?path=${encodeURIComponent('out/deck/slide.png')}&inline=1`,
      );
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.rawPayload.length).toBe(300_008);
      // HTML only for a sandboxed frame; a plain download is never text/html.
      const html = await viewer.req(
        'GET',
        `/jobs/${job.id}/workfiles/file?path=${encodeURIComponent('out/deck/index.html')}&inline=1`,
      );
      expect(html.headers['content-security-policy']).toContain('sandbox');
      const dl = await viewer.req(
        'GET',
        `/jobs/${job.id}/workfiles/file?path=${encodeURIComponent('out/deck/index.html')}`,
      );
      expect(dl.headers['content-type']).toBe('application/octet-stream');
      expect(String(dl.headers['content-disposition'])).toContain('attachment');
      expect(
        (
          await viewer.req(
            'GET',
            `/jobs/${job.id}/workfiles/file?path=${encodeURIComponent('../etc/passwd')}`,
          )
        ).statusCode,
      ).toBe(404);

      const zip = await viewer.req('GET', `/jobs/${job.id}/workfiles/zip`);
      expect(zip.statusCode).toBe(200);
      expect(zip.headers['content-type']).toBe('application/zip');
      expect(zip.rawPayload.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
      expect(zip.rawPayload.includes(Buffer.from('notes/plan.md'))).toBe(true);
    });

    it('a pending deploy and an unfinished follow-up pin the files past their expiry; then they expire', async () => {
      const job = await finishedJob(aId);
      await reportKept(job, 1000, new Map([['out/index.html', Buffer.from('<p>x</p>')]]));
      // A Pages deploy of this job waits for an approval.
      const action = randomUUID();
      await h.db.pool.query(
        `INSERT INTO ops_actions (id, project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
                                state, requested_by_type, requested_by_id, via, idempotency_key, created_at, updated_at, source)
       VALUES ($1, $2, 'pages.deploy', 'preview', '{}', $3, '{}', '{}', 'approval', 'needs approval',
               'awaiting_approval', 'user', $4, 'api', $5, now(), now(), $6)`,
        [
          action,
          WS,
          'a'.repeat(64),
          operatorId,
          `wf-${action.slice(0, 8)}`,
          JSON.stringify({ jobId: job.id }),
        ],
      );
      h.clock.advance(15 * DAY);
      await relogin();
      await h.app.workfiles.sweep(true);
      let r = await h.db.pool.query<{ state: string; pinned_until: Date | null; pin_reason: string | null }>(
        'SELECT state, pinned_until, pin_reason FROM job_workfiles WHERE attempt_id = $1',
        [job.attemptId],
      );
      expect(r.rows[0]).toMatchObject({ state: 'kept', pin_reason: 'deploy' });
      expect(r.rows[0]?.pinned_until?.getTime()).toBe(h.clock.now().getTime() + 14 * DAY);
      expect(seenOps).toContain(`extend:${job.id.slice(0, 8)}`);
      // "Temizle" is refused while the deploy is pending.
      const del = await operator.req('DELETE', `/jobs/${job.id}/workfiles`);
      expect(del.statusCode).toBe(409);
      expect(del.json<{ error: string }>().error).toBe('workfiles_pinned');
      // The deploy finished: the retention still applies after it (pinned until now + 14 days).
      await h.db.pool.query(`UPDATE ops_actions SET state = 'failed' WHERE id = $1`, [action]);
      h.clock.advance(13 * DAY);
      await relogin();
      await h.app.workfiles.sweep(true);
      r = await h.db.pool.query(
        'SELECT state, pinned_until, pin_reason FROM job_workfiles WHERE attempt_id = $1',
        [job.attemptId],
      );
      expect(r.rows[0]?.state).toBe('kept');
      h.clock.advance(2 * DAY);
      await relogin();
      await h.app.workfiles.sweep(true);
      const gone = await h.db.pool.query<{ state: string; delete_reason: string }>(
        'SELECT state, delete_reason FROM job_workfiles WHERE attempt_id = $1',
        [job.attemptId],
      );
      expect(gone.rows[0]).toMatchObject({ state: 'deleted', delete_reason: 'expired' });
      expect(kept.has(job.id)).toBe(false);
    });

    it('a follow-up on the same machine is seeded locally, on another machine by relay (fenced by its lease)', async () => {
      const src = await finishedJob(aId);
      await reportKept(src, 1000, new Map([['out/deck/index.html', Buffer.from('<h1>v1</h1>')]]));
      // "Yeniden çalıştır" from kept files (keptFilesFrom), through the REST API.
      const res = await operator.req('POST', '/jobs', {
        project: WS,
        spec: wsSpec('fix the deploy'),
        keptFilesFrom: src.id,
      });
      expect(res.statusCode, res.body).toBe(201);
      const nextId = res.json<{ job: { id: string } }>().job.id;
      expect(await h.app.workfiles.preferWorkers(nextId)).toEqual([aId]);
      const spec = { workspace: { egress: 'none' } };
      expect((await h.app.workfiles.assignment({ id: nextId, project: WS, spec }, aId)).seedFiles).toEqual({
        jobId: src.id,
        attemptId: src.attemptId,
        mode: 'local',
      });
      expect((await h.app.workfiles.assignment({ id: nextId, project: WS, spec }, bId)).seedFiles?.mode).toBe(
        'relay',
      );
      // The unfinished follow-up pins the source.
      expect((await h.app.workfiles.pins(src.id, src.attemptId)).map((p) => p.kind)).toContain('follow_up');
      // An outsider cannot start from a job they cannot read.
      expect(
        (await outsider.req('POST', '/jobs', { project: WS, spec: wsSpec(), keptFilesFrom: src.id }))
          .statusCode,
      ).toBe(404);

      // Machine B runs the follow-up and relays the seed through the master.
      const grant = await jobs.acquireLease(nextId, bId, 60 * 60_000);
      const fetch = (op: unknown, epoch = grant.lease.epoch) => {
        const requestId = randomUUID();
        b.sendJson(
          b.envelope(
            'WORKFILES_FETCH',
            { attemptId: grant.attempt.id, epoch, requestId, op },
            { workerId: bId, jobId: nextId },
          ),
        );
        return requestId;
      };
      fetch({ op: 'list' });
      const listed = await b.next('WORKFILES_FETCH_DATA', 10_000);
      expect(listed.payload.status).toBe('ok');
      expect(listed.payload.entries?.map((e) => e.path)).toContain('out/deck/index.html');
      fetch({ op: 'read', path: 'out/deck/index.html', offset: 0 });
      const read = await b.next('WORKFILES_FETCH_DATA', 10_000);
      expect(Buffer.from(read.payload.data ?? '', 'base64').toString()).toBe('<h1>v1</h1>');
      // A stale epoch is refused (and audited).
      fetch({ op: 'list' }, grant.lease.epoch + 5);
      expect((await b.next('WORKFILES_FETCH_DATA', 10_000)).payload.status).toBe('refused');
      const audit = await h.db.pool.query<{ outcome: string }>(
        `SELECT outcome FROM audit_events WHERE action = 'workfiles.relay' AND target = $1`,
        [`job:${nextId}`],
      );
      expect(audit.rows.map((x) => x.outcome).sort()).toEqual(['denied', 'success']);
    });

    it('applies the machine cap oldest-first in the sweep, never evicting a pinned directory', async () => {
      const MiB = 1024 ** 2;
      await owner.req('PUT', '/settings/workfiles', { machineCapBytes: 256 * MiB });
      // Clear what earlier tests left on machine A.
      await h.db.pool.query(
        `UPDATE job_workfiles SET state = 'deleted' WHERE worker_id = $1 AND state = 'kept'`,
        [aId],
      );
      const j1 = await finishedJob(aId);
      await reportKept(j1, 100 * MiB, new Map([['out/a', Buffer.from('a')]]));
      h.clock.advance(1000);
      const j2 = await finishedJob(aId);
      await reportKept(j2, 100 * MiB, new Map([['out/b', Buffer.from('b')]]));
      h.clock.advance(1000);
      const j3 = await finishedJob(aId);
      await reportKept(j3, 100 * MiB, new Map([['out/c', Buffer.from('c')]]));
      // The oldest is needed by an unfinished follow-up: the next oldest goes instead.
      await operator.req('POST', '/jobs', { project: WS, spec: wsSpec('continue'), keptFilesFrom: j1.id });
      await h.app.workfiles.sweep(true);
      const states = await h.db.pool.query<{ job_id: string; state: string; delete_reason: string | null }>(
        'SELECT job_id::text AS job_id, state, delete_reason FROM job_workfiles WHERE job_id = ANY($1)',
        [[j1.id, j2.id, j3.id]],
      );
      const by = Object.fromEntries(states.rows.map((r) => [r.job_id, [r.state, r.delete_reason]]));
      expect(by[j1.id]).toEqual(['kept', null]);
      expect(by[j2.id]).toEqual(['deleted', 'evicted']);
      expect(by[j3.id]).toEqual(['kept', null]);
      await owner.req('PUT', '/settings/workfiles', { machineCapBytes: 10 * 1024 ** 3 });
    });

    it('"Temizle" per job and bulk per machine are audited; viewers cannot clean up', async () => {
      const j = await finishedJob(aId);
      await reportKept(j, 10, new Map([['out/x', Buffer.from('x')]]));
      expect((await viewer.req('DELETE', `/jobs/${j.id}/workfiles`)).statusCode).toBe(403);
      const del = await operator.req('DELETE', `/jobs/${j.id}/workfiles`);
      expect(del.statusCode, del.body).toBe(200);
      expect(del.json()).toMatchObject({ workfiles: { state: 'deleted', deleteReason: 'user' } });
      const k1 = await finishedJob(aId);
      await reportKept(k1, 10, new Map([['out/y', Buffer.from('y')]]));
      const bulk = await operator.req('POST', '/workfiles/cleanup', { worker: aId });
      expect(bulk.statusCode, bulk.body).toBe(200);
      expect(bulk.json<{ removed: number }>().removed).toBeGreaterThanOrEqual(1);
      const audit = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE action IN ('workfiles.delete', 'workfiles.cleanup')`,
      );
      expect(new Set(audit.rows.map((r) => r.action))).toEqual(
        new Set(['workfiles.delete', 'workfiles.cleanup']),
      );
    });

    it('"Repoya aktar" pushes the kept files as a new branch (one commit on main) and refuses secrets', async () => {
      const j = await finishedJob(aId);
      await reportKept(
        j,
        100,
        new Map([
          ['out/deck/index.html', Buffer.from('<h1>Sunum</h1>')],
          ['out/deck/style.css', Buffer.from('h1{color:red}')],
          ['in/brief.md', Buffer.from('brief')],
        ]),
      );
      // Only operators of the target project.
      expect(
        (await viewer.req('POST', `/jobs/${j.id}/workfiles/export`, { project: REPO_PROJECT })).statusCode,
      ).toBe(403);
      const res = await operator.req('POST', `/jobs/${j.id}/workfiles/export`, {
        project: REPO_PROJECT,
        directory: 'out/deck',
        targetPath: 'presentation',
      });
      expect(res.statusCode, res.body).toBe(200);
      const exp = res.json<{ export: { branch: string; commit: string; files: number; mode: string } }>()
        .export;
      expect(exp).toMatchObject({ mode: 'branch_pr', branch: `remyral/files-${j.id.slice(0, 8)}`, files: 2 });
      const bare = fileURLToPath(fileUrl);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
      expect(git('rev-parse', `refs/heads/${exp.branch}`)).toBe(exp.commit);
      expect(git('show', `${exp.commit}:presentation/index.html`)).toBe('<h1>Sunum</h1>');
      // Base untouched; the README of main is still there in the new commit.
      expect(git('show', `${exp.commit}:README.md`)).toBe('# app');
      expect(git('rev-parse', `${exp.commit}^`)).toBe(git('rev-parse', 'refs/heads/main'));
      // Again: a new branch name, never the existing one.
      const again = await operator.req('POST', `/jobs/${j.id}/workfiles/export`, {
        project: REPO_PROJECT,
        directory: 'out/deck',
      });
      expect(again.json<{ export: { branch: string } }>().export.branch).toBe(
        `remyral/files-${j.id.slice(0, 8)}-2`,
      );

      // A secret in a file refuses the whole export (file + rule named, never the value).
      const s = await finishedJob(aId);
      await reportKept(s, 100, new Map([['out/.env', Buffer.from(`GITHUB_TOKEN=ghp_${'a'.repeat(36)}\n`)]]));
      const refused = await operator.req('POST', `/jobs/${s.id}/workfiles/export`, { project: REPO_PROJECT });
      expect(refused.statusCode).toBe(422);
      expect(refused.body).not.toContain('ghp_');
      const rows = await h.db.pool.query<{ state: string }>(
        'SELECT state FROM workfile_exports WHERE job_id = $1',
        [s.id],
      );
      expect(rows.rows[0]?.state).toBe('failed');
    });

    it('the assistant lists kept files and pushes them to a repository at once (list_workfiles, export_workfiles)', async () => {
      const j = await finishedJob(aId);
      await reportKept(j, 100, new Map([['out/report.md', Buffer.from('# Rapor')]]));
      const chat = new ChatWorkfiles({
        service: () => h.app.workfiles,
        exporter: () => h.app.workfilesExport,
        db: h.db.pool,
      });
      const subject = await loadSubject(h.db.pool, { id: operatorId, role: 'operator' });
      const listed = await chat.list(subject, { jobId: j.id });
      expect(listed.ok).toBe(true);
      const data = listed.ok ? listed.data : {};
      expect(data).toMatchObject({ workfiles: [{ jobId: j.id, state: 'kept' }] });
      expect(JSON.stringify(data.files)).toContain('out/report.md');
      // A viewer may read but not push; an outsider does not see the job.
      const vs = await h.db.pool.query<{ id: string }>(
        "SELECT id::text AS id FROM users WHERE username = 'view1'",
      );
      const viewerSubject = await loadSubject(h.db.pool, { id: vs.rows[0]?.id ?? '', role: 'viewer' });
      expect((await chat.plan(viewerSubject, { jobId: j.id, project: WS })).ok).toBe(false);
      const plan = await chat.plan(subject, { jobId: j.id, project: REPO_PROJECT });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const result = await chat.run(
        {
          subject,
          human: { id: operatorId, mfaAt: h.clock.now() } as never,
          actor: { type: 'user', id: operatorId, ip: '127.0.0.1', userAgent: 'vitest' } as never,
          direct: true,
        },
        { payload: plan.payload } as never,
      );
      expect(result).toMatchObject({ op: 'export_workfiles', mode: 'branch_pr', files: 1 });
      const exp = await h.db.pool.query<{ via: string; state: string }>(
        'SELECT via, state FROM workfile_exports WHERE job_id = $1',
        [j.id],
      );
      expect(exp.rows[0]).toEqual({ via: 'chat', state: 'succeeded' });
      // p22-slow-tools: the same files into the same project are not pushed twice (named with the commit) …
      const again = await chat.plan(subject, { jobId: j.id, project: REPO_PROJECT });
      expect(again.ok).toBe(false);
      expect(again.ok ? '' : again.message).toMatch(
        /already pushed to .+ \(branch .+, commit [0-9a-f]{40}\)/,
      );
      // … nor while an export of them is still running.
      await h.db.pool.query(
        `UPDATE workfile_exports SET state = 'running', created_at = now(), finished_at = NULL WHERE job_id = $1`,
        [j.id],
      );
      const running = await chat.plan(subject, { jobId: j.id, project: REPO_PROJECT });
      expect(running.ok ? '' : running.message).toContain('being pushed to');
      await h.db.pool.query(`UPDATE workfile_exports SET state = 'succeeded' WHERE job_id = $1`, [j.id]);
    });

    it('reconciles with CAPABILITIES: a directory the machine no longer has becomes lost', async () => {
      const j = await finishedJob(aId);
      await reportKept(j, 10, new Map([['out/z', Buffer.from('z')]]));
      caps(a, aId, { maxBytes: 10 * 1024 ** 3, usedBytes: 0, kept: [] });
      await waitFor(async () => {
        const r = await h.db.pool.query<{ state: string }>(
          'SELECT state FROM job_workfiles WHERE attempt_id = $1',
          [j.attemptId],
        );
        return r.rows[0]?.state === 'lost';
      });
      const v = await viewer.req('GET', `/jobs/${j.id}/workfiles`);
      expect(v.json()).toMatchObject({ workfiles: { state: 'lost', deleteReason: 'missing' } });
      expect((await viewer.req('GET', `/jobs/${j.id}/workfiles/tree`)).statusCode).toBe(410);
    });
  },
);
