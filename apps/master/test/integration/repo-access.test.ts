import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { LocalGitProvider } from '../../src/gitflow/local-provider.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { BaseRefHealer } from '../../src/self-heal/base-ref.js';
import { type ProbeExec, RemoteProbe } from '../../src/self-heal/remote-probe.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, jobSpec, PROJECT, REPO_URL } from '../helpers/job-worker.js';
import { removeDirs } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const OTHER_URL = 'https://git.example.test/acme/other.git';
const SHA_MAIN = 'a'.repeat(40);
const SHA_DEV = 'b'.repeat(40);

/**
 * p22-git-preflight (docs/design/p22-git-preflight.md): the repository access preflight before dispatch (a job that can
 * never read its repository fails at once — no attempt, no runtime — with a reason code and a timeline event naming the
 * fix; verdicts are cached) and base ref healing of a repository without a git configuration (the anonymous view: a
 * missing chat work branch falls back to the repository's default branch). Real Postgres; the remote is a fake
 * `ls-remote`.
 */
describeIntegration(
  'repository access preflight and anonymous base ref healing (integration)',
  { timeout: 120_000 },
  () => {
    let h: Harness;
    let jobs: JobStore;
    let owner: Client;
    let creator: JobActor;
    const dirs: string[] = [];
    /** What the fake remote answers, per repository URL; every call is counted. */
    const remote = new Map<string, { code: number; stdout: string; stderr: string }>();
    let calls: string[] = [];
    const exec: ProbeExec = (args) => {
      const url = args[args.indexOf('--end-of-options') + 1] ?? '';
      calls.push(url);
      return Promise.resolve(remote.get(url) ?? { code: 128, stdout: '', stderr: 'fatal: unable to access' });
    };
    const probe = new RemoteProbe({ exec, resolve: () => Promise.resolve(['140.82.112.3']) });

    beforeAll(async () => {
      const fileUrl = await createBareRepo(dirs);
      const cacheDir = await mkdtemp(join(tmpdir(), 'rw-ra-cache-'));
      dirs.push(cacheDir);
      const provider = new LocalGitProvider({ url: fileUrl, cacheDir, allowFileUrls: true });
      h = new Harness();
      await h.start({
        gitflow: { providers: () => provider, timing: { refreshIntervalMs: 0 } },
        orchestration: { tickIntervalMs: 0, repoAccess: { probe } },
      });
      const ownerId = await h.createUser('owner.ra', PW, 'owner');
      const { secret } = await enroll(h, 'owner.ra', PW);
      owner = await fullLogin(h, 'owner.ra', PW, secret);
      creator = { type: 'user', id: ownerId };
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at, auto_approve_execution) VALUES ($1, $1, $2, true)',
        [PROJECT, h.clock.now()],
      );
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 1800, $3, $4)`,
        [PROJECT, REPO_URL, ownerId, h.clock.now()],
      );
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
    });
    afterAll(async () => {
      await h.stop();
      await removeDirs(dirs);
    });
    beforeEach(() => {
      calls = [];
    });

    async function queued(over: Record<string, unknown>): Promise<string> {
      const { job } = await jobs.create({
        project: PROJECT,
        spec: jobSpec(over),
        actor: creator,
        submit: true,
      });
      return job.id;
    }

    async function must(id: string) {
      const j = await jobs.get(id);
      if (j === null) throw new Error(`job ${id} not found`);
      return j;
    }

    it('fails a job whose private repository it can never read before dispatch, names the fix, caches the verdict', async () => {
      const url = 'https://git.example.test/acme/private.git';
      remote.set(url, {
        code: 128,
        stdout: '',
        stderr: "fatal: could not read Username for 'https://git.example.test': terminal prompts disabled",
      });
      const id = await queued({ repository: { url, baseRef: 'main', workBranch: 'feature' } });
      expect(await h.app.orchestrator.dispatch(id)).toBe('infeasible');
      const job = await jobs.get(id);
      expect(job?.state).toBe('FAILED');
      const t = await h.db.pool.query<{ trigger: string; reason: string }>(
        'SELECT trigger, reason FROM job_transitions WHERE job_id = $1 ORDER BY id DESC LIMIT 1',
        [id],
      );
      expect(t.rows[0]?.trigger).toBe('infeasible');
      expect(t.rows[0]?.reason).toMatch(
        /^repo_credentials_missing: git\.example\.test .*\(other repository\)$/,
      );
      const attempts = await h.db.pool.query('SELECT 1 FROM job_attempts WHERE job_id = $1', [id]);
      expect(attempts.rowCount).toBe(0);
      const ev = (await owner.req('GET', `/jobs/${id}/autonomy`)).json<{
        events: { kind: string; detail: Record<string, unknown> }[];
      }>();
      expect(ev.events).toContainEqual(
        expect.objectContaining({
          kind: 'repo_access',
          detail: {
            code: 'repo_credentials_missing',
            why: 'other_repository',
            via: 'anonymous',
            host: 'git.example.test',
          },
        }),
      );
      // A second job of the same repository: the cached verdict, no second remote call.
      const second = await queued({ repository: { url, baseRef: 'main', workBranch: 'feature' } });
      expect(await h.app.orchestrator.dispatch(second)).toBe('infeasible');
      expect(calls.filter((c) => c.includes('private'))).toHaveLength(1);
    });

    it('a public repository and an unreachable one pass (never failed on a guess)', async () => {
      remote.set('https://git.example.test/acme/public.git', {
        code: 0,
        stdout: `ref: refs/heads/main\tHEAD\n${SHA_MAIN}\tHEAD\n${SHA_MAIN}\trefs/heads/main\n`,
        stderr: '',
      });
      for (const url of [
        'https://git.example.test/acme/public.git',
        'https://git.example.test/acme/flaky.git',
      ]) {
        const id = await queued({ repository: { url, baseRef: 'main', workBranch: 'feature' } });
        const out = await h.app.orchestrator.dispatch(id);
        expect(out).not.toBe('infeasible');
        expect((await jobs.get(id))?.state).not.toBe('FAILED');
      }
    });

    it('heals a missing chat work branch of a repository without git configuration to its default branch', async () => {
      remote.set(OTHER_URL, {
        code: 0,
        stdout: `ref: refs/heads/develop\tHEAD\n${SHA_DEV}\tHEAD\n${SHA_MAIN}\trefs/heads/main\n${SHA_DEV}\trefs/heads/develop\n`,
        stderr: '',
      });
      const healer = new BaseRefHealer({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        providerFor: (p) => h.app.gitflow.providerFor(p),
        probe,
      });
      const id = await queued({
        repository: { url: OTHER_URL, baseRef: 'agent/chat-gone', workBranch: 'agent/chat-x' },
      });
      expect(await healer.heal(await must(id))).toMatchObject({
        kind: 'healed',
        from: 'agent/chat-gone',
        to: 'develop',
        reason: 'repository_default',
      });
      expect((await jobs.get(id))?.spec.repository?.baseRef).toBe('develop');
      const ev = (await owner.req('GET', `/jobs/${id}/autonomy`)).json<{
        events: { kind: string; detail: Record<string, unknown> }[];
      }>();
      expect(ev.events.find((e) => e.kind === 'base_ref')?.detail).toMatchObject({
        from: 'agent/chat-gone',
        to: 'develop',
        reason: 'repository_default',
      });
      // An existing branch (or tag) is left alone; a project without a probe answer is left alone too.
      const ok = await queued({ repository: { url: OTHER_URL, baseRef: 'main', workBranch: 'feature' } });
      expect(await healer.heal(await must(ok))).toEqual({ kind: 'ok' });
    });
  },
);
