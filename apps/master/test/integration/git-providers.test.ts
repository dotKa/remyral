import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  type AgentAdapter,
  basicScript,
  FakeRuntimeAdapter,
  type SessionRef,
  type SessionResult,
  type SpawnContext,
} from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { HostedWorkerCredentials } from '../../src/gitflow/credentials.js';
import { BareGit, FakeBitbucket, FakeGitLab, hostFetch } from '../helpers/fake-git-hosts.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 13;
const GL_URL = 'https://git.example.test/acme/app.git';
const BB_URL = 'https://bitbucket.org/acme/app.git';

/** Fake runtime: `edit <path> <line>` prompt lines are written into the worktree when the session spawns. */
class EditingAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;
  readonly inner = new FakeRuntimeAdapter({ runtime: 'codex', script: basicScript });
  probe() {
    return this.inner.probe();
  }
  capabilities() {
    return this.inner.capabilities();
  }
  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    for (const line of ctx.job.prompt.split('\n')) {
      const m = /^edit (\S+) (.*)$/.exec(line);
      if (m?.[1] !== undefined) await writeFile(join(ctx.workspaceRoot, m[1]), `${m[2] ?? ''}\n`);
    }
    return this.inner.spawn(ctx);
  }
  sendPrompt(ref: SessionRef, prompt: { text: string }) {
    return this.inner.sendPrompt(ref, prompt);
  }
  events(ref: SessionRef, cursor?: Parameters<FakeRuntimeAdapter['events']>[1]) {
    return this.inner.events(ref, cursor);
  }
  requestApproval(ref: SessionRef, d: Parameters<FakeRuntimeAdapter['requestApproval']>[1]) {
    return this.inner.requestApproval(ref, d);
  }
  cancel(ref: SessionRef) {
    return this.inner.cancel(ref);
  }
  resume(ref: SessionRef, ctx: SpawnContext) {
    return this.inner.resume(ref, ctx);
  }
  collectResult(ref: SessionRef): Promise<SessionResult> {
    return this.inner.collectResult(ref);
  }
  cleanup(ref: SessionRef) {
    return this.inner.cleanup(ref);
  }
  getCost(ref: SessionRef) {
    return this.inner.getCost(ref);
  }
}

interface ConnectionView {
  id: string;
  kind: string;
  version: number;
  tokenFingerprint: string;
  separatePushToken: boolean;
  expiresAt: string | null;
  rotatable: boolean;
  projects: string[];
}

/**
 * p16-git-providers end to end: real master (Postgres, BullMQ), real worker daemons pushing to a local bare repository,
 * fake GitLab / Bitbucket servers backed by the same repository — connections (permissions, test before save,
 * encryption at rest), project configuration rules, the full git flow on GitLab (verify → MR → test merge → merge
 * decision → merge) and on Bitbucket (verify → PR → conflicts), CI states gating the merge, push credentials issued
 * to a worker, rotation and the ops-safety expiry list.
 */
describeIntegration('git providers: GitLab and Bitbucket (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let viewer: Client;
  let secret: string;
  let fileUrl: string;
  let bare: BareGit;
  let gl: FakeGitLab;
  let bb: FakeBitbucket;
  let glToken: string;
  let glPush: string;
  let bbToken: string;
  let glConn: ConnectionView;
  let bbConn: ConnectionView;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'h',
        GIT_AUTHOR_EMAIL: 'h@example.test',
        GIT_COMMITTER_NAME: 'h',
        GIT_COMMITTER_EMAIL: 'h@example.test',
      },
      encoding: 'utf8',
    }).trim();

  async function pushCommit(branch: string, file: string, content: string, message: string): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), 'rw-gp-'));
    dirs.push(work);
    git(work, 'init', '-q');
    git(work, 'fetch', '-q', fileUrl, `refs/heads/${branch}:refs/heads/x`);
    git(work, 'checkout', '-q', 'x');
    await writeFile(join(work, file), content);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', message);
    git(work, 'push', '-q', fileUrl, `x:refs/heads/${branch}`);
    return git(work, 'rev-parse', 'HEAD');
  }

  async function stepUp(c: Client = owner, s: string = secret): Promise<void> {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(s) })).statusCode).toBe(200);
  }

  beforeAll(async () => {
    fileUrl = await createBareRepo(dirs);
    bare = new BareGit(fileURLToPath(fileUrl));
    gl = new FakeGitLab(bare);
    bb = new FakeBitbucket(bare);
    const fetchFn = hostFetch({
      'https://git.example.test': await gl.start(),
      'https://api.bitbucket.org': await bb.start(),
    });
    glToken = gl.addToken(['api']);
    glPush = gl.addToken(['write_repository'], '2027-03-31');
    bbToken = bb.addToken();
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `gp${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      gitflow: { gitHostFetch: fetchFn, gitHostPollMs: 0, timing: { refreshIntervalMs: 0 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    for (const p of ['acme', 'acme-bb']) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        p,
        h.clock.now(),
      ]);
    }
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
  });
  afterAll(async () => {
    await h.stop();
    await gl.stop();
    await bb.stop();
    await removeDirs(dirs);
  });

  it('connections: admin + fresh step-up, tested before saving, encrypted at rest, never returned', async () => {
    expect((await viewer.req('GET', '/integrations/git-hosts')).statusCode).toBe(403);
    const input = {
      kind: 'gitlab',
      label: 'Şirket GitLab',
      baseUrl: 'https://git.example.test',
      tokenKind: 'group',
      scope: 'acme',
      token: glToken,
      pushToken: glPush,
    };
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('POST', '/integrations/git-hosts', input);
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: 'step_up_required' });

    // "Bağlantıyı test et" needs no code and stores nothing.
    const draft = await owner.req('POST', '/integrations/git-hosts/test', {
      ...input,
      token: 'glpat-not-a-real-token',
    });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json()).toMatchObject({ test: { ok: false, code: 'unauthorized' } });
    const good = await owner.req('POST', '/integrations/git-hosts/test', input);
    expect(good.json()).toMatchObject({ test: { ok: true, scopes: ['api'], expiresAt: '2027-06-30' } });

    await stepUp();
    const refused = await owner.req('POST', '/integrations/git-hosts', { ...input, scope: 'nobody' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'git_host_test_failed', test: { code: 'scope_mismatch' } });
    const weakPush = gl.addToken(['read_repository']);
    const weak = await owner.req('POST', '/integrations/git-hosts', { ...input, pushToken: weakPush });
    expect(weak.json()).toMatchObject({
      error: 'git_host_test_failed',
      test: { code: 'push_missing_scopes' },
    });

    const created = await owner.req('POST', '/integrations/git-hosts', input);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain(glToken);
    expect(created.body).not.toContain(glPush);
    glConn = created.json<{ connection: ConnectionView }>().connection;
    expect(glConn).toMatchObject({
      kind: 'gitlab',
      separatePushToken: true,
      expiresAt: '2027-06-30T23:59:59.000Z',
      rotatable: true,
    });
    const bbRes = await owner.req('POST', '/integrations/git-hosts', {
      kind: 'bitbucket',
      label: 'Bitbucket',
      tokenKind: 'repository',
      scope: 'acme/app',
      token: bbToken,
      expiresAt: '2027-01-15T00:00:00Z',
    });
    expect(bbRes.statusCode, bbRes.body).toBe(201);
    bbConn = bbRes.json<{ connection: ConnectionView }>().connection;
    expect(bbConn).toMatchObject({
      kind: 'bitbucket',
      rotatable: false,
      expiresAt: '2027-01-15T00:00:00.000Z',
    });
    const dup = await owner.req('POST', '/integrations/git-hosts', { ...input, label: 'şirket gitlab' });
    expect(dup.statusCode).toBe(409);

    const list = await owner.req('GET', '/integrations/git-hosts');
    expect(list.json<{ connections: ConnectionView[] }>().connections).toHaveLength(2);
    for (const t of [glToken, glPush, bbToken]) expect(list.body).not.toContain(t);
    const { rows } = await h.db.pool.query<{ secrets: Buffer }>('SELECT secrets FROM git_host_connections');
    for (const r of rows) {
      for (const t of [glToken, glPush, bbToken]) expect(r.secrets.toString('latin1')).not.toContain(t);
    }
    const audit = await h.db.pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE action = 'git_host.connect'",
    );
    expect(audit.rows).toHaveLength(2);
    expect(JSON.stringify(audit.rows)).not.toContain(glToken);

    const repos = await owner.req('GET', `/integrations/git-hosts/${glConn.id}/repositories`);
    expect(repos.json()).toMatchObject({ repositories: [{ fullPath: 'acme/app', defaultBranch: 'main' }] });
  });

  it('project configuration: the connection, its host and its token scope are enforced', async () => {
    await stepUp();
    const put = (project: string, body: Record<string, unknown>) =>
      owner.req('PUT', `/projects/${project}/git`, { expectedVersion: 0, baseBranch: 'main', ...body });
    const wrong = await put('acme', {
      provider: 'gitlab',
      repositoryUrl: GL_URL,
      hostConnectionId: bbConn.id,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ message: string }>().message).toContain('hostConnectionId:wrong_provider');
    const outside = await put('acme', {
      provider: 'gitlab',
      repositoryUrl: 'https://git.example.test/other/app.git',
      hostConnectionId: glConn.id,
    });
    expect(outside.json<{ message: string }>().message).toContain('repositoryUrl:outside_token_scope');
    const host = await put('acme', {
      provider: 'gitlab',
      repositoryUrl: 'https://gitlab.com/acme/app.git',
      hostConnectionId: glConn.id,
    });
    expect(host.json<{ message: string }>().message).toContain('repositoryUrl:not_on_this_host');
    const none = await put('acme', { provider: 'gitlab', repositoryUrl: GL_URL });
    expect(none.json<{ message: string }>().message).toContain('hostConnectionId:required');

    const ok = await put('acme', { provider: 'gitlab', repositoryUrl: GL_URL, hostConnectionId: glConn.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ config: { provider: 'gitlab', hostConnectionId: glConn.id } });
    const okBb = await put('acme-bb', {
      provider: 'bitbucket',
      repositoryUrl: BB_URL,
      hostConnectionId: bbConn.id,
      mergeMethod: 'squash',
    });
    expect(okBb.statusCode, okBb.body).toBe(200);

    const protection = await owner.req('GET', '/projects/acme/git/protection');
    expect(protection.json()).toMatchObject({ provider: 'gitlab', state: 'protected', branch: 'main' });
    const bbProtection = await owner.req('GET', '/projects/acme-bb/git/protection');
    expect(bbProtection.json()).toMatchObject({ provider: 'bitbucket', state: 'protected', rules: ['push'] });

    await stepUp();
    const inUse = await owner.req('DELETE', `/integrations/git-hosts/${glConn.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ error: 'git_host_in_use' });
  });

  async function newWorker(repoUrl: string, projects: string[]): Promise<void> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, owner, secret, dir);
    const w = await startJobWorker(url, dir, { fileUrl, repoUrl, projects, adapter: new EditingAdapter() });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
  }

  async function submit(project: string, repoUrl: string, prompt: string): Promise<string> {
    const spec = jobSpec({ prompt });
    const res = await owner.req('POST', '/jobs', {
      project,
      spec: { ...spec, repository: { ...(spec.repository as object), url: repoUrl } },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  const state = async (id: string) =>
    (await owner.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
  const changes = async (id: string) =>
    (await owner.req('GET', `/jobs/${id}/changes`)).json<{
      provider: string;
      verification: { status: string };
      pullRequest: { number: number; url: string } | null;
      mergeCheck: { state: string | null; files: string[]; precision: string | null };
      ci: { state: string | null; required: boolean };
      merged: { sha: string } | null;
      requests: { id: string; approvalRequestId: string | null; mode: string; status: string }[];
    }>();
  const pendingApproval = async (id: string): Promise<string | null> => {
    const { rows } = await h.db.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM approval_requests WHERE job_id = $1 AND status = 'pending' AND action = 'git.merge'",
      [id],
    );
    return rows[0]?.id ?? null;
  };

  it('GitLab: verify → merge request → test merge → merge decision → merge; a second job conflicts', async () => {
    await newWorker(GL_URL, ['acme']);
    const before = bare.head('main');
    const a = await submit('acme', GL_URL, 'edit README.md gitlab alpha\nchange the readme');
    await expect.poll(() => state(a), { timeout: 45_000 }).toBe('AWAITING_APPROVAL');
    const b = await submit('acme', GL_URL, 'edit README.md gitlab beta\nrewrite the readme');
    await expect.poll(() => state(b), { timeout: 45_000 }).toBe('AWAITING_APPROVAL');

    const ca = await changes(a);
    expect(ca).toMatchObject({
      provider: 'gitlab',
      verification: { status: 'passed' },
      mergeCheck: { state: 'clean' },
    });
    expect(ca.pullRequest?.url).toMatch(/\/acme\/app\/-\/merge_requests\/\d+$/);
    expect(gl.mrs.map((m) => m.state)).toEqual(['opened', 'opened']);
    // The worker asked for its push credential per fetch / push and got the connection's push token.
    const issued = await h.db.pool.query<{ metadata: { status: string } }>(
      "SELECT metadata FROM audit_events WHERE action = 'job.credential.issue' AND target = $1",
      [`job:${a}`],
    );
    expect(issued.rows.map((r) => r.metadata.status)).toContain('granted');
    expect(bare.head('main')).toBe(before);

    const approvalId = await pendingApproval(a);
    expect(approvalId).not.toBeNull();
    await stepUp();
    const ok = await owner.req('POST', `/approvals/${approvalId ?? ''}/approve`, { reason: 'reviewed' });
    expect(ok.statusCode, ok.body).toBe(200);
    await expect.poll(() => state(a), { timeout: 30_000 }).toBe('SUCCEEDED');
    const merged = await changes(a);
    expect(merged.merged?.sha).toBe(bare.head('main'));
    expect(gl.mrs.find((m) => m.iid === ca.pullRequest?.number)?.state).toBe('merged');
    expect(bare.commit(merged.merged?.sha ?? '').message).toMatch(/Remyral-Merge: /);
    // The merge went through GitLab's API with the approved head as the sha guard.
    expect(gl.requests.some((r) => r.method === 'PUT' && /\/merge_requests\/\d+\/merge$/.test(r.path))).toBe(
      true,
    );

    await h.app.gitflow.refresh(b, { force: true });
    const cb = await changes(b);
    expect(cb.mergeCheck).toMatchObject({
      state: 'conflicts',
      files: ['README.md'],
      precision: 'approximate',
    });
    const refusedMerge = await owner.req('POST', `/jobs/${b}/merge`, { mode: 'merge' });
    expect(refusedMerge.statusCode).toBe(409);
    expect(refusedMerge.json()).toMatchObject({ error: 'merge_conflicts' });
  });

  it('CI gates the merge: GitLab statuses failed / passed; Bitbucket verify → pull request with exact conflicts', async () => {
    await stepUp();
    const cfg = (await owner.req('GET', '/projects/acme/git')).json<{ config: { version: number } }>().config;
    const put = await owner.req('PUT', '/projects/acme/git', {
      expectedVersion: cfg.version,
      provider: 'gitlab',
      repositoryUrl: GL_URL,
      baseBranch: 'main',
      hostConnectionId: glConn.id,
      requireCi: true,
      ciTimeoutSec: 600,
    });
    expect(put.statusCode, put.body).toBe(200);
    await newWorker(GL_URL, ['acme']);
    const c = await submit('acme', GL_URL, 'edit ci.txt ci\nadd ci file');
    await expect.poll(() => state(c), { timeout: 45_000 }).toBe('AWAITING_APPROVAL');
    const head =
      bare.head(
        (await h.db.pool.query<{ branch: string }>('SELECT branch FROM job_git WHERE job_id = $1', [c]))
          .rows[0]?.branch ?? '',
      ) ?? '';
    gl.statuses.set(head, [{ name: 'test', status: 'running', target_url: 'https://ci.example.test/1' }]);
    await h.app.gitflow.refresh(c, { force: true });
    expect((await changes(c)).ci).toMatchObject({ state: 'pending', required: true });
    gl.statuses.set(head, [
      { name: 'test', status: 'success' },
      { name: 'lint', status: 'failed', allow_failure: true },
    ]);
    await h.app.gitflow.refresh(c, { force: true });
    expect((await changes(c)).ci.state).toBe('success');
    await workers.splice(0).reduce((p, w) => p.then(() => w.stop()), Promise.resolve());

    // Bitbucket: a commit on main first makes the job conflict; the pull request names the exact file.
    await newWorker(BB_URL, ['acme-bb']);
    const d = await submit('acme-bb', BB_URL, 'edit bb.txt from-job\nadd bb');
    await expect.poll(() => state(d), { timeout: 45_000 }).toBe('AWAITING_APPROVAL');
    const cd = await changes(d);
    expect(cd).toMatchObject({
      provider: 'bitbucket',
      verification: { status: 'passed' },
      mergeCheck: { state: 'clean' },
    });
    expect(cd.pullRequest?.url).toMatch(/^https:\/\/bitbucket\.org\/acme\/app\/pull-requests\/\d+$/);
    await pushCommit('main', 'bb.txt', 'from-main\n', 'main changes bb');
    await h.app.gitflow.refresh(d, { force: true });
    expect((await changes(d)).mergeCheck).toMatchObject({
      state: 'conflicts',
      files: ['bb.txt'],
      precision: 'exact',
    });
  });

  it('push credentials, rotation and the expiry list', async () => {
    const creds = new HostedWorkerCredentials({
      db: h.db.pool,
      hosts: () => h.app.gitHosts,
      log: { warn: () => undefined } as never,
    });
    const job =
      (
        await h.db.pool.query<{ id: string }>(
          "SELECT j.id::text AS id FROM jobs j JOIN job_git g ON g.job_id = j.id WHERE j.project = 'acme' LIMIT 1",
        )
      ).rows[0]?.id ?? '';
    const issued = await creds.issue({ jobId: job, project: 'acme', repositoryUrl: GL_URL, workerId: 'w' });
    expect(issued).toMatchObject({ token: glPush, username: 'oauth2' });
    expect(
      await creds.issue({ jobId: job, project: 'acme', repositoryUrl: BB_URL, workerId: 'w' }),
    ).toBeNull();
    // A job outside the git flow gets nothing (the untrusted-source gate: unit test gitflow-hosted-credentials).
    expect(
      await creds.issue({ jobId: randomUUID(), project: 'acme', repositoryUrl: GL_URL, workerId: 'w' }),
    ).toBeNull();
    const bbJob =
      (
        await h.db.pool.query<{ id: string }>(
          "SELECT j.id::text AS id FROM jobs j JOIN job_git g ON g.job_id = j.id WHERE j.project = 'acme-bb' LIMIT 1",
        )
      ).rows[0]?.id ?? '';
    expect(
      await creds.issue({ jobId: bbJob, project: 'acme-bb', repositoryUrl: BB_URL, workerId: 'w' }),
    ).toMatchObject({
      token: bbToken,
      username: 'x-token-auth',
    });

    const expiry = await owner.req('GET', '/ops-safety/expiry');
    expect(expiry.statusCode, expiry.body).toBe(200);
    const items = expiry.json<{
      items: { id: string; label: string; basis: string; dueAt: string | null }[];
    }>().items;
    const key = (id: string) => `githost:${id.replaceAll('-', '')}`;
    expect(items.find((i) => i.id === key(glConn.id))).toMatchObject({
      label: 'gitHostToken',
      basis: 'expires',
      dueAt: '2027-06-30T23:59:59.000Z',
    });
    expect(items.find((i) => i.id === `${key(glConn.id)}.push`)).toMatchObject({
      label: 'gitHostPushToken',
      basis: 'expires',
    });
    expect(items.find((i) => i.id === key(bbConn.id))).toMatchObject({
      basis: 'expires',
      dueAt: '2027-01-15T00:00:00.000Z',
    });

    // GitLab self-rotation: a new token, the old one dead at GitLab, the master keeps working with the new one.
    await stepUp();
    const rot = await owner.req('POST', `/integrations/git-hosts/${glConn.id}/rotate`, { days: 30 });
    expect(rot.statusCode, rot.body).toBe(200);
    const after = rot.json<{ connection: ConnectionView }>().connection;
    expect(after.tokenFingerprint).not.toBe(glConn.tokenFingerprint);
    expect(gl.tokens.has(glToken)).toBe(false);
    expect((await owner.req('POST', `/integrations/git-hosts/${glConn.id}/test`, {})).json()).toMatchObject({
      test: { ok: true },
    });
    expect((await owner.req('GET', '/projects/acme/git/protection')).json()).toMatchObject({
      state: 'protected',
    });
    const rotAudit = await h.db.pool.query(
      "SELECT 1 FROM audit_events WHERE action = 'git_host.token.rotate'",
    );
    expect(rotAudit.rowCount).toBe(1);
    await stepUp();
    const bbRot = await owner.req('POST', `/integrations/git-hosts/${bbConn.id}/rotate`, {});
    expect(bbRot.statusCode).toBe(409);
    expect(bbRot.json()).toMatchObject({ error: 'git_host_not_rotatable' });

    // A token entered by hand (Bitbucket rotation) replaces the old one after a passing test.
    const next = bb.addToken();
    await stepUp();
    const patched = await owner.req('PATCH', `/integrations/git-hosts/${bbConn.id}`, {
      token: next,
      expectedVersion: bbConn.version,
      expiresAt: '2027-12-31T00:00:00Z',
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(
      await creds.issue({ jobId: bbJob, project: 'acme-bb', repositoryUrl: BB_URL, workerId: 'w' }),
    ).toMatchObject({ token: next });
  });
});
