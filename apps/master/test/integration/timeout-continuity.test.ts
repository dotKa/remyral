import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeStep } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  createBareRepo,
  type JobWorker,
  jobSpec,
  PROJECT,
  REPO_URL,
  startJobWorker,
} from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;

/**
 * p22-timeout-continuity (docs/design/p22-timeout-continuity.md; production 2026-11-01): a git-flow
 * repository job that reaches its time limit keeps its work, and "Aynı yerden devam et" continues from it — real
 * master (Postgres), a real worker daemon with the fake runtime, real worktrees and pushes to a local bare repository,
 * the plain-git provider:
 *  - the run clock stops the job; the worker commits and pushes the unfinished work to the attempt branch (JOB_RESULT
 *    `partial`), nothing merges, the job is FAILED and still recognised as timed out;
 *  - the continuation starts from that commit (baseRef = the commit, the original target branch and base at job start)
 *    with the "your earlier changes are already in the working tree" note; its verified changes contain the earlier
 *    files too;
 *  - a commit kept only on the machine pins the continuation to it; a claim the remote does not confirm (and no kept
 *    ref) falls back to the base.
 */
describeIntegration('timeout continuity (integration, p22-timeout-continuity)', { timeout: 240_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  let bare: string;
  let worker: { id: string; w: JobWorker } | null = null;
  const dirs: string[] = [];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, HOME: cwd }, encoding: 'utf8' }).trim();
  const remote = (ref: string): string | null => {
    try {
      return git(bare, 'rev-parse', '--verify', '--quiet', ref);
    } catch {
      return null;
    }
  };

  /** First run: writes a file and works past its limit. A continuation: writes another file and finishes. */
  const script = (prompt: string): FakeStep[] =>
    prompt.includes('This job continues job')
      ? [
          { kind: 'write-file', path: 'second.txt', content: 'finished\n' },
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'finished the rest' } },
        ]
      : [
          { kind: 'write-file', path: 'first.txt', content: 'almost done\n' },
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'tests pass, build ok' } },
          { kind: 'sleep', ms: 180_000 },
        ];

  const state = async (id: string): Promise<string> =>
    (await admin.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
  const spec = async (id: string) =>
    (await admin.req('GET', `/jobs/${id}`)).json<{
      job: {
        spec: {
          prompt: string;
          repository: { baseRef: string; targetBranch?: string };
          requirements?: { workers?: string[] };
        };
      };
    }>().job.spec;

  beforeAll(async () => {
    fileUrl = await createBareRepo(dirs);
    bare = fileURLToPath(fileUrl);
    const cacheDir = await mkdtemp(join(tmpdir(), 'rw-tc-cache-'));
    dirs.push(cacheDir);
    const provider = new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true });
    h = new Harness(Date.now());
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `tc${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: {
          leaseTtlMs: 3_600_000,
          reconnectGraceMs: 7_200_000,
          retryBackoffMs: 0,
          effectRetryAfterMs: 0,
        },
      },
      gitflow: { providers: () => provider, timing: { refreshIntervalMs: 0 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      PROJECT,
      h.clock.now(),
    ]);
    const put = await admin.req('PUT', `/projects/${PROJECT}/git`, {
      expectedVersion: 0,
      provider: 'git',
      repositoryUrl: REPO_URL,
      baseBranch: 'main',
      mergeMethod: 'merge',
    });
    expect(put.statusCode, put.body).toBe(200);
  });
  afterAll(async () => {
    await worker?.w.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('the work is kept on the attempt branch and the continuation starts from it', async () => {
    const dir = await tempDataDir(dirs);
    const wid = await pairRealWorker(h, url, admin, secret, dir);
    const w = await startJobWorker(url, dir, { fileUrl, fake: { script } });
    worker = { id: wid, w };
    await expect.poll(() => h.app.fleetSessions.hasReported(wid), { timeout: 45_000 }).toBe(true);
    const baseBefore = remote('refs/heads/main');
    const res = await admin.req('POST', '/jobs', {
      project: PROJECT,
      spec: jobSpec({ prompt: 'build the search page', limits: { maxDurationSec: 60 } }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ job: { id: string } }>().job.id;
    await expect.poll(() => state(id), { timeout: 150_000, interval: 1_000 }).toBe('FAILED');

    // The worker kept the work: a WIP commit on the attempt branch (never main).
    const { rows } = await h.db.pool.query<{ partial: Record<string, unknown>; attempt_id: string }>(
      `SELECT r.result -> 'partial' AS partial, r.attempt_id::text AS attempt_id
         FROM jobs j JOIN job_runs r ON r.attempt_id = j.current_attempt_id WHERE j.id = $1`,
      [id],
    );
    const partial = rows[0]?.partial as { branch: string; commit: string; files: number; pushed: boolean };
    expect(partial).toMatchObject({
      branch: `rac/${id}/${rows[0]?.attempt_id ?? ''}`,
      pushed: true,
      files: 1,
    });
    expect(remote(`refs/heads/${partial.branch}`)).toBe(partial.commit);
    expect(remote('refs/heads/main')).toBe(baseBefore);
    expect(git(bare, 'show', `${partial.commit}:first.txt`)).toBe('almost done');

    // The job page view: timed out, kept work, continue offered.
    const view = (await admin.req('GET', `/jobs/${id}/time-limit`)).json<{
      clock: { timedOut: boolean; canContinue: boolean; keptWork: Record<string, unknown> | null };
    }>().clock;
    expect(view).toMatchObject({
      timedOut: true,
      canContinue: true,
      keptWork: { branch: partial.branch, commit: partial.commit, files: 1, pushed: true, workerId: wid },
    });

    // "Aynı yerden devam et": the new job starts at the kept commit, targets main, keeps the original base.
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const cont = await admin.req('POST', `/jobs/${id}/continue-after-timeout`, {});
    expect(cont.statusCode, cont.body).toBe(201);
    const next = cont.json<{ jobId: string; from: string; workerId: string | null }>();
    expect(next).toMatchObject({ from: 'pushed', workerId: null });
    const s = await spec(next.jobId);
    expect(s.repository).toMatchObject({ baseRef: partial.commit, targetBranch: 'main' });
    expect(s.requirements?.workers).toBeUndefined();
    expect(s.prompt).toContain('Your earlier changes are already in the working tree');
    expect(s.prompt).toContain(partial.commit.slice(0, 12));
    const base = await h.db.pool.query<{ base_sha: string }>(
      'SELECT base_sha FROM job_git WHERE job_id = $1',
      [next.jobId],
    );
    expect(base.rows[0]?.base_sha).toBe(baseBefore);
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'job.timeout.continue' AND target = $1`,
      [`job:${id}`],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ from: 'pushed', commit: partial.commit });

    // The continuation finishes: its verified changes (against the original base) hold both files.
    await expect.poll(() => state(next.jobId), { timeout: 60_000, interval: 500 }).toBe('AWAITING_APPROVAL');
    const changes = (await admin.req('GET', `/jobs/${next.jobId}/changes`)).json<{
      files: { path: string }[];
      verification: { status: string };
    }>();
    expect(changes.verification.status).toBe('passed');
    expect(changes.files.map((f) => f.path).sort()).toEqual(['first.txt', 'second.txt']);
    expect(remote('refs/heads/main')).toBe(baseBefore);

    // A commit kept only on the machine: the continuation is pinned to it.
    await h.db.pool.query(
      `UPDATE job_runs SET result = jsonb_set(result, '{partial}', $2::jsonb)
        WHERE attempt_id = (SELECT current_attempt_id FROM jobs WHERE id = $1)`,
      [
        id,
        JSON.stringify({
          ...partial,
          pushed: false,
          ref: `refs/remana/kept/${rows[0]?.attempt_id ?? ''}`,
          reason: 'push_failed',
        }),
      ],
    );
    const pinned = await admin.req('POST', `/jobs/${id}/continue-after-timeout`, {});
    expect(pinned.statusCode, pinned.body).toBe(201);
    expect(pinned.json()).toMatchObject({ from: 'machine', workerId: wid });
    const ps = await spec(pinned.json<{ jobId: string }>().jobId);
    expect(ps.repository.baseRef).toBe(partial.commit);
    expect(ps.requirements?.workers).toEqual([wid]);
    expect(ps.prompt).toContain('kept on this machine');
    await admin.req('POST', `/jobs/${pinned.json<{ jobId: string }>().jobId}/cancel`, { reason: 'test' });

    // A pushed claim the remote does not confirm (branch gone) and no kept ref: from the base, said so.
    git(bare, 'update-ref', '-d', `refs/heads/${partial.branch}`);
    await h.db.pool.query(
      `UPDATE job_runs SET result = jsonb_set(result, '{partial}', $2::jsonb)
        WHERE attempt_id = (SELECT current_attempt_id FROM jobs WHERE id = $1)`,
      [id, JSON.stringify(partial)],
    );
    const fresh = await admin.req('POST', `/jobs/${id}/continue-after-timeout`, {});
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect(fresh.json()).toMatchObject({ from: 'base' });
    const fs = await spec(fresh.json<{ jobId: string }>().jobId);
    expect(fs.repository.baseRef).toBe('main');
    expect(fs.prompt).toContain('nothing of the earlier run was kept');
    await admin.req('POST', `/jobs/${fresh.json<{ jobId: string }>().jobId}/cancel`, { reason: 'test' });
  });
});
