import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reasonWords, repoAccessHint } from '../../src/chat/job-result.js';
import type { Queryable } from '../../src/db/pool.js';
import type { ProjectGitConfig } from '../../src/gitflow/config-store.js';
import { type GitProvider, ProviderError } from '../../src/gitflow/types.js';
import type { JobRecord } from '../../src/jobs/store.js';
import { GitLsRemoteInspector } from '../../src/orchestration/remote-branch.js';
import { classifyFailure } from '../../src/self-heal/classify.js';
import { parseLsRemote, type ProbeExec, RemoteProbe } from '../../src/self-heal/remote-probe.js';
import { RepoAccessPreflight } from '../../src/self-heal/repo-access.js';

const itPosix = process.platform === 'win32' ? it.skip : it;

/** p22-git-preflight (docs/design/p22-git-preflight.md): the anonymous probe, the preflight verdicts, the hints. */

const URL_A = 'https://github.com/acme/app.git';
/** A public address for every host (no DNS in unit tests). */
const publicDns = () => Promise.resolve(['140.82.112.3']);

function fakeExec(answer: { code: number | null; stdout?: string; stderr?: string }) {
  const calls: (readonly string[])[] = [];
  const exec: ProbeExec = (args) => {
    calls.push(args);
    return Promise.resolve({ code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' });
  };
  return { exec, calls };
}

describe('RemoteProbe', () => {
  it('parses branches, tags and the default branch; an empty repository has neither', () => {
    const r = parseLsRemote(
      `ref: refs/heads/develop\tHEAD\n${'a'.repeat(40)}\tHEAD\n${'a'.repeat(40)}\trefs/heads/develop\n` +
        `${'b'.repeat(40)}\trefs/heads/feature/x\n${'c'.repeat(40)}\trefs/tags/v1\n${'d'.repeat(40)}\trefs/tags/v1^{}\n`,
    );
    expect(r.kind).toBe('readable');
    if (r.kind !== 'readable') return;
    expect(r.defaultBranch).toBe('develop');
    expect([...r.heads.keys()]).toEqual(['develop', 'feature/x']);
    expect([...r.tags]).toEqual(['v1']);
    expect(r.empty).toBe(false);
    expect(parseLsRemote('')).toMatchObject({ kind: 'readable', empty: true, defaultBranch: null });
  });

  it('a credential prompt is "denied", anything else unknown; https only, hardened argv; cached per repository', async () => {
    let now = 0;
    const denied = fakeExec({
      code: 128,
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
    const probe = new RemoteProbe({ resolve: publicDns, exec: denied.exec, clock: () => now });
    expect(await probe.probe(URL_A)).toEqual({ kind: 'denied' });
    expect(await probe.probe('https://GitHub.com/acme/app')).toEqual({ kind: 'denied' });
    expect(denied.calls).toHaveLength(1);
    const args = denied.calls[0] ?? [];
    expect(args).toContain('credential.helper=');
    expect(args).toContain('protocol.allow=never');
    expect(args.slice(args.indexOf('--end-of-options'))).toEqual([
      '--end-of-options',
      URL_A,
      'HEAD',
      'refs/heads/*',
      'refs/tags/*',
    ]);
    now += 3 * 60_000; // the refusal is cached for 2 minutes only
    await probe.probe(URL_A);
    expect(denied.calls).toHaveLength(2);

    expect(
      await new RemoteProbe({
        resolve: publicDns,
        exec: fakeExec({ code: 128, stderr: 'Could not resolve host' }).exec,
      }).probe(URL_A),
    ).toMatchObject({ kind: 'unknown' });
    expect(
      await new RemoteProbe({ resolve: publicDns, exec: fakeExec({ code: null }).exec }).probe(URL_A),
    ).toMatchObject({
      kind: 'unknown',
    });
    const ssh = fakeExec({ code: 0 });
    expect(
      await new RemoteProbe({ resolve: publicDns, exec: ssh.exec }).probe(
        'ssh://git@github.com/acme/app.git',
      ),
    ).toMatchObject({
      kind: 'unknown',
    });
    expect(ssh.calls).toHaveLength(0);
  });
});

function job(over: { url?: string; trusted?: boolean; project?: string } = {}): JobRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    project: over.project ?? 'p',
    currentAttemptId: null,
    spec: {
      sourceTrust: over.trusted === false ? 'untrusted' : 'trusted',
      repository: { url: over.url ?? URL_A, baseRef: 'main' },
    },
  } as unknown as JobRecord;
}

function pool(vault = false): Queryable {
  return {
    query: () => Promise.resolve({ rows: [{ report_only: false, vault }], rowCount: 1 }),
  } as unknown as Queryable;
}

const config = (provider: ProjectGitConfig['provider'], url = URL_A) =>
  ({ project: 'p', provider, repositoryUrl: url, baseBranch: 'main' }) as unknown as ProjectGitConfig;

const provider = (defaultBranch: () => Promise<string | null>) =>
  ({ kind: 'github', defaultBranch }) as unknown as GitProvider;

describe('RepoAccessPreflight', () => {
  const deniedProbe = () =>
    new RemoteProbe({
      resolve: publicDns,
      exec: fakeExec({ code: 128, stderr: 'fatal: Authentication failed' }).exec,
    });

  it('no git connection and a private repository → repo_credentials_missing (no_connection)', async () => {
    const pre = new RepoAccessPreflight({
      pool: pool(),
      probe: deniedProbe(),
      providerFor: () => Promise.resolve(null),
    });
    expect(await pre.check(job())).toMatchObject({
      ok: false,
      code: 'repo_credentials_missing',
      why: 'no_connection',
      via: 'anonymous',
      host: 'github.com',
    });
  });

  it('a vault repository credential, an ssh URL or a readable repository pass', async () => {
    const none = () => Promise.resolve(null);
    expect(
      await new RepoAccessPreflight({ pool: pool(true), probe: deniedProbe(), providerFor: none }).check(
        job(),
      ),
    ).toEqual({ ok: true });
    expect(
      await new RepoAccessPreflight({ pool: pool(), probe: deniedProbe(), providerFor: none }).check(
        job({ url: 'ssh://git@github.com/acme/app.git' }),
      ),
    ).toEqual({ ok: true });
    const open = new RemoteProbe({ resolve: publicDns, exec: fakeExec({ code: 0, stdout: '' }).exec });
    expect(
      await new RepoAccessPreflight({ pool: pool(), probe: open, providerFor: none }).check(job()),
    ).toEqual({ ok: true });
  });

  it('the project connection: another repository / untrusted source → missing; a 404 of the app → denied; 5xx passes', async () => {
    const withConn = (p: GitProvider, cfg = config('github')) =>
      new RepoAccessPreflight({
        pool: pool(),
        probe: deniedProbe(),
        providerFor: () => Promise.resolve({ provider: p, config: cfg }),
      });
    const fine = provider(() => Promise.resolve('main'));
    expect(await withConn(fine).check(job())).toEqual({ ok: true });
    expect(
      await withConn(fine, config('github', 'https://github.com/acme/other')).check(job()),
    ).toMatchObject({
      code: 'repo_credentials_missing',
      why: 'other_repository',
    });
    expect(await withConn(fine).check(job({ trusted: false }))).toMatchObject({ why: 'untrusted_source' });
    expect(await withConn(provider(() => Promise.resolve(null))).check(job())).toMatchObject({
      code: 'repo_access_denied',
      why: 'not_installed',
    });
    const refused = provider(() => Promise.reject(new ProviderError('GitHub refused', false, 401)));
    expect(await withConn(refused).check(job())).toMatchObject({
      code: 'repo_access_denied',
      why: 'connection_refused',
    });
    const down = provider(() => Promise.reject(new ProviderError('GitHub 502', true, 502)));
    expect(await withConn(down).check(job())).toEqual({ ok: true });
  });

  it('caches the verdict per project and repository', async () => {
    let n = 0;
    const counted = provider(() => {
      n++;
      return Promise.resolve('main');
    });
    const pre = new RepoAccessPreflight({
      pool: pool(),
      probe: deniedProbe(),
      providerFor: () => Promise.resolve({ provider: counted, config: config('github') }),
    });
    await pre.check(job());
    await pre.check(job());
    expect(n).toBe(1);
    pre.forgetProject('p');
    await pre.check(job());
    expect(n).toBe(2);
  });
});

describe('hints and classification', () => {
  const end = (trigger: string, reason: string) =>
    ({
      jobId: 'j',
      transitionId: '1',
      state: 'FAILED',
      fromState: 'QUEUED',
      trigger,
      attempts: 0,
      reason,
    }) as const;

  it('the chat card names the fix of a refused repository (TR and EN)', () => {
    const missing = 'repo_credentials_missing: github.com refuses … (no connection)';
    expect(reasonWords(end('infeasible', missing), 'tr')).toContain('GitHub’ı bağlayın');
    expect(reasonWords(end('infeasible', missing), 'en')).toContain('connect GitHub');
    expect(repoAccessHint('repo_access_denied: … (not installed, HTTP 404)', 'en')).toContain(
      'GitHub App installation',
    );
    expect(repoAccessHint('repo_access_denied: … (connection refused, HTTP 401)', 'tr')).toContain(
      'yenileyin',
    );
    expect(repoAccessHint('repo_credentials_missing: … (untrusted source)', 'en')).toContain(
      'trusted source',
    );
    expect(reasonWords(end('infeasible', 'no eligible worker'), 'en')).toBe('no machine can run this job');
    expect(
      reasonWords(
        end('verification_failed', 'head abc is not a descendant of the base at job start def (behind)'),
        'en',
      ),
    ).toContain('run the job again');
  });

  it('a broken cached clone of an old worker is retried on another machine', () => {
    for (const message of [
      "GitCommandError: git fetch failed (exit 128): fatal: detected dubious ownership in repository at 'C:/r/m.git'",
      'GitCommandError: git fetch failed (exit 1): fatal: bad object refs/heads/rac/1/2',
    ]) {
      expect(classifyFailure({ code: 'GitCommandError', message, phase: 'start' })).toMatchObject({
        class: 'transient',
        cause: 'git_cache',
        machineSpecific: true,
      });
    }
  });
});

describe('git egress: the probe and the lost-attempt inspector never reach a non-public host', () => {
  it('a host resolving to a private, loopback or metadata address is never handed to git', async () => {
    for (const address of ['10.0.0.7', '127.0.0.1', '169.254.169.254', 'fd00::1']) {
      const run = fakeExec({ code: 0, stdout: '' });
      const probe = new RemoteProbe({ resolve: () => Promise.resolve([address]), exec: run.exec });
      expect(await probe.probe('https://git.internal.example/acme/app.git')).toMatchObject({
        kind: 'unknown',
      });
      expect(run.calls).toHaveLength(0);
    }
    const literal = fakeExec({ code: 0, stdout: '' });
    expect(
      await new RemoteProbe({ resolve: publicDns, exec: literal.exec }).probe(
        'https://192.168.1.10/acme/app.git',
      ),
    ).toMatchObject({ kind: 'unknown' });
    expect(literal.calls).toHaveLength(0);
  });

  it('a public host is pinned to the checked address, redirects off; a listed internal origin may be private', async () => {
    const run = fakeExec({ code: 0, stdout: '' });
    await new RemoteProbe({ resolve: publicDns, exec: run.exec }).probe(URL_A);
    expect(run.calls[0]).toEqual(
      expect.arrayContaining([
        'http.followRedirects=false',
        'http.curloptResolve=github.com:443:140.82.112.3',
      ]),
    );
    const internal = fakeExec({ code: 0, stdout: '' });
    const probe = new RemoteProbe({ resolve: () => Promise.resolve(['10.0.0.7']), exec: internal.exec });
    probe.useInternalOrigins(new Set(['https://git.internal.example']));
    expect(await probe.probe('https://git.internal.example/acme/app.git')).toMatchObject({
      kind: 'readable',
    });
    expect(internal.calls[0]).toContain('http.curloptResolve=git.internal.example:443:10.0.0.7');
    const metadata = fakeExec({ code: 0, stdout: '' });
    const meta = new RemoteProbe({
      resolve: () => Promise.resolve(['169.254.169.254']),
      exec: metadata.exec,
      internalOrigins: new Set(['https://git.internal.example']),
    });
    expect(await meta.probe('https://git.internal.example/acme/app.git')).toMatchObject({ kind: 'unknown' });
    expect(metadata.calls).toHaveLength(0);
  });

  // The stand-in git is a /bin/sh script.
  itPosix(
    'the lost-attempt inspector answers unknown for a non-public host without running git',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rw-lsr-'));
      try {
        const marker = join(dir, 'ran');
        const git = join(dir, 'git');
        await writeFile(
          git,
          `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\trefs/heads/rac/j1/a1\\n' ${'a'.repeat(40)}\n`,
          { mode: 0o755 },
        );
        const branch = 'rac/j1/a1';
        const priv = new GitLsRemoteInspector({
          gitBinary: git,
          resolve: () => Promise.resolve(['10.1.2.3']),
        });
        expect(await priv.inspect('https://git.internal.example/acme/app.git', branch)).toBe('unknown');
        expect(await priv.inspect('ssh://git@git.internal.example/acme/app.git', branch)).toBe('unknown');
        await expect(stat(marker)).rejects.toThrow();
        const pub = new GitLsRemoteInspector({ gitBinary: git, resolve: publicDns });
        expect(await pub.inspect(URL_A, branch)).toBe('present');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
