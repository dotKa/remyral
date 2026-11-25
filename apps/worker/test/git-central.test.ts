import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitCommandError } from '../src/workspace/errors.js';
import { GitRunner, isGitAuthFailure, sshCommand } from '../src/workspace/git.js';
import { type GitAuthSource, withGitAuth } from '../src/workspace/git-auth.js';
import { GitReadiness, helperKind, type ProbeRun } from '../src/workspace/git-readiness.js';
import { renderJobGitConfig, writeJobGitConfig } from '../src/workspace/job-git-config.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { parseRepoUrl } from '../src/workspace/repo-url.js';
import { createOrigin, remoteSha } from './git-fixtures.js';
import { isWindows, tempDir } from './helpers.js';

const GIT_TIMEOUT = { timeout: 120_000 };
/** What github.com answers to an expired / revoked installation token (the 2026-10-22 failure, verbatim). */
const GITHUB_INVALID_TOKEN =
  'remote: Invalid username or token. Password authentication is not supported for Git operations.';

/**
 * A git wrapper that behaves like github.com for the token check: a push / fetch with REMYRAL_GIT_TOKEN
 * `expired-token` is refused with GitHub's message (exit 128); everything else runs the real git.
 */
async function githubLikeGit(dir: string): Promise<string> {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const path = join(dir, 'git-github-like');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in push|fetch)',
      '    if [ "$REMYRAL_GIT_TOKEN" = "expired-token" ]; then',
      `      echo "${GITHUB_INVALID_TOKEN}" >&2`,
      '      echo "fatal: Authentication failed for \'https://github.com/octoDev/demo-repo.git/\'" >&2',
      '      exit 128',
      '    fi;;',
      '  esac',
      'done',
      `exec "${real}" "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  return path;
}

async function manager(root: string, origin: string, gitBinary?: string): Promise<WorkspaceManager> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return WorkspaceManager.create({
    root,
    projects: { acme: [origin] },
    allowFileUrls: true,
    minFreeBytes: 0,
    ...(gitBinary === undefined ? {} : { gitBinary }),
  });
}

describe('p15-git-central: auth failure classification', () => {
  it('recognises GitHub’s refusal of an expired token, a missing credential and a refused key', () => {
    expect(isGitAuthFailure(new GitCommandError('push', 128, GITHUB_INVALID_TOKEN))).toBe(true);
    expect(
      isGitAuthFailure(
        new GitCommandError(
          'fetch',
          128,
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        ),
      ),
    ).toBe(true);
    expect(
      isGitAuthFailure(new GitCommandError('fetch', 128, 'git@host: Permission denied (publickey).')),
    ).toBe(true);
    expect(isGitAuthFailure(new GitCommandError('push', 1, '! [rejected] (stale info)'))).toBe(false);
    expect(isGitAuthFailure(new Error(GITHUB_INVALID_TOKEN))).toBe(false);
  });
});

describe.skipIf(isWindows)('p15-git-central: fresh credential at use time', GIT_TIMEOUT, () => {
  it('proof: a push with the token minted at job start fails exactly like the 2026-10-22 job', async () => {
    const dir = await tempDir('rw-gc-');
    const origin = await createOrigin(dir);
    const ws = await manager(join(dir, 'ws'), origin.url, await githubLikeGit(dir));
    // The token minted at job start is still accepted for the fetch …
    const startToken = { reveal: () => 'start-token' };
    const w = await ws.prepare({
      projectId: 'acme',
      jobId: 'job1',
      attemptId: 'a1',
      epoch: 1,
      repository: { url: origin.url, baseRef: 'main' },
      gitToken: startToken,
    });
    await writeFile(join(w.path, 'x.txt'), 'x\n');
    await ws.commit(w, {
      message: 'remyral: x\n\nRemyral-Attempt: a1/1',
      author: { name: 'A', email: 'a@example.com' },
    });
    // … but an hour later the same token has expired: the old code pushed with it (one credential per job).
    const expired = { reveal: () => 'expired-token' };
    const err = await ws.push(w, { expectedRemoteSha: null, gitToken: expired }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect(String(err)).toContain('git push failed (exit 128)');
    expect(String(err)).toContain('Invalid username or token. Password authentication is not supported');
  });

  it('asks for the credential right before the push and retries once with a fresh one after a refusal', async () => {
    const dir = await tempDir('rw-gc-');
    const origin = await createOrigin(dir);
    const ws = await manager(join(dir, 'ws'), origin.url, await githubLikeGit(dir));
    const calls: { purpose: string; retry: boolean }[] = [];
    let n = 0;
    const source: GitAuthSource = (req) => {
      calls.push({ ...req });
      n += 1;
      // The first push credential is the stale one (e.g. a cached / expired token); the retry gets a fresh one.
      const value = req.purpose === 'push' && !req.retry ? 'expired-token' : `fresh-${String(n)}`;
      return Promise.resolve({ kind: 'token', token: { reveal: () => value } });
    };
    const w = await ws.prepare({
      projectId: 'acme',
      jobId: 'job2',
      attemptId: 'a1',
      epoch: 1,
      repository: { url: origin.url, baseRef: 'main' },
      gitAuth: source,
    });
    await writeFile(join(w.path, 'y.txt'), 'y\n');
    await ws.commit(w, {
      message: 'remyral: y\n\nRemyral-Attempt: a1/1',
      author: { name: 'A', email: 'a@example.com' },
    });
    expect(calls).toEqual([{ purpose: 'fetch', retry: false }]);
    const pushed = await ws.push(w, { expectedRemoteSha: null, gitAuth: source });
    expect(calls).toEqual([
      { purpose: 'fetch', retry: false },
      { purpose: 'push', retry: false },
      { purpose: 'push', retry: true },
    ]);
    expect(remoteSha(origin, `refs/heads/${w.branch}`)).toBe(pushed.sha);
  });

  it('retries only once: a second refusal fails the push', async () => {
    const dir = await tempDir('rw-gc-');
    const origin = await createOrigin(dir);
    const ws = await manager(join(dir, 'ws'), origin.url, await githubLikeGit(dir));
    const w = await ws.prepare({
      projectId: 'acme',
      jobId: 'job3',
      attemptId: 'a1',
      epoch: 1,
      repository: { url: origin.url, baseRef: 'main' },
    });
    await ws.commit(w, {
      message: 'remyral: z\n\nRemyral-Attempt: a1/1',
      author: { name: 'A', email: 'a@example.com' },
    });
    let asked = 0;
    const err = await ws
      .push(w, {
        expectedRemoteSha: null,
        gitAuth: () => {
          asked += 1;
          return Promise.resolve({ kind: 'token', token: { reveal: () => 'expired-token' } });
        },
      })
      .catch((e: unknown) => e);
    expect(asked).toBe(2);
    expect(isGitAuthFailure(err)).toBe(true);
  });
});

describe.skipIf(isWindows)('p15-git-central: credential helper scoping', GIT_TIMEOUT, () => {
  it('answers only for the job’s repository; another host gets nothing; the machine’s global helper is ignored', async () => {
    const dir = await tempDir('rw-gc-');
    const home = join(dir, 'home');
    await mkdir(home);
    // The machine's own (stale) global helper, as Git Credential Manager / osxkeychain would answer.
    await writeFile(
      join(home, '.gitconfig'),
      '[credential]\n\thelper = "!f() { echo username=machine; echo password=MACHINE-STALE-SECRET; }; f"\n',
    );
    const runner = new GitRunner({ emptyHooksDir: dir, sourceEnv: { ...process.env, HOME: home } });
    const remote = parseRepoUrl('https://github.com/octoDev/demo-repo.git');
    const token = { reveal: () => 'ghs_jobScopedToken1234567890' };
    const fill = (url: string) =>
      runner.run({
        cwd: dir,
        args: ['credential', 'fill'],
        input: `url=${url}\n\n`,
        remote,
        token,
        okCodes: [128],
      });
    const ok = await fill('https://github.com/octoDev/demo-repo.git');
    expect(ok.stdout).toContain('password=ghs_jobScopedToken1234567890');
    expect(ok.stdout).not.toContain('MACHINE-STALE-SECRET');
    // Same host, another repository: no answer (scoped to the path, not only the host).
    const otherRepo = await fill('https://github.com/octoDev/another-repo.git');
    expect(otherRepo.stdout).not.toContain('ghs_jobScopedToken');
    expect(otherRepo.stdout).not.toContain('MACHINE-STALE-SECRET');
    expect(otherRepo.code).not.toBe(0);
    const otherHost = await fill('https://gitlab.example/octoDev/demo-repo.git');
    expect(otherHost.stdout).not.toContain('ghs_jobScopedToken');
    expect(otherHost.code).not.toBe(0);
  });

  it('the agent’s job-local config ignores the machine’s helper and identity and carries the project identity', async () => {
    const dir = await tempDir('rw-gc-');
    const home = join(dir, 'home');
    await mkdir(home);
    await writeFile(
      join(home, '.gitconfig'),
      [
        '[credential]',
        '\thelper = "!f() { echo username=machine; echo password=MACHINE-STALE-SECRET; }; f"',
        '[user]',
        '\tname = Windows User',
        '\temail = personal@example.com',
        '[url "git@github.com:"]',
        '\tinsteadOf = https://github.com/',
        '',
      ].join('\n'),
    );
    const state = join(dir, 'state');
    await mkdir(state);
    const cfg = await writeJobGitConfig(state, {
      identity: { name: 'Proje Botu', email: 'bot@example.com' },
      safeDirectories: [join(dir, 'wt')],
    });
    const env = { PATH: process.env.PATH ?? '', HOME: home, ...cfg.env };
    const run = (args: string[], input?: string) => {
      try {
        return execFileSync('git', args, { cwd: dir, env, input, encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        return (e as { stdout?: string }).stdout ?? '';
      }
    };
    expect(run(['config', 'user.email']).trim()).toBe('bot@example.com');
    expect(run(['config', 'user.name']).trim()).toBe('Proje Botu');
    expect(run(['config', '--get-all', 'credential.helper']).trim()).toBe('');
    expect(run(['config', '--get-regexp', '^url\\.'])).toBe('');
    const filled = run(['credential', 'fill'], 'url=https://github.com/octoDev/demo-repo.git\n\n');
    expect(filled).not.toContain('MACHINE-STALE-SECRET');
    expect(cfg.env.GH_CONFIG_DIR.startsWith(state)).toBe(true);
    expect((await readdir(cfg.env.GH_CONFIG_DIR)).length).toBe(0);
  });

  it('renders quoted values and refuses control characters', () => {
    const text = renderJobGitConfig({
      identity: { name: 'A "B" C', email: 'a@example.com' },
      safeDirectories: ['C:\\ws\\jobs\\j\\a', 'C:\\ws\\jobs\\j\\a'],
      platform: 'win32',
    });
    expect(text).toContain('\tname = "A \\"B\\" C"');
    expect(text.match(/directory = "C:\/ws\/jobs\/j\/a"/g)).toHaveLength(1);
    expect(text).toContain('\thelper =\n');
    expect(() =>
      renderJobGitConfig({ identity: { name: 'x', email: 'a@example.com' }, safeDirectories: ['a\nb'] }),
    ).toThrow(/control characters/);
  });
});

describe('p15-git-central: SSH deploy key lifecycle', () => {
  it('writes the key 0600 in a 0700 dir only for the command, pins known_hosts, and removes it afterwards', async () => {
    const dir = await tempDir('rw-gc-');
    const credDir = join(dir, 'cred');
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const knownHosts =
      'git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
    const seen: { keyFile: string; knownHostsFile: string }[] = [];
    const source: GitAuthSource = () =>
      Promise.resolve({ kind: 'ssh-key', privateKey: { reveal: () => key }, knownHosts });
    await withGitAuth(source, { purpose: 'fetch', credDir }, async (fields) => {
      expect(fields.ssh).toBeDefined();
      const ssh = fields.ssh ?? { keyFile: '', knownHostsFile: '' };
      seen.push(ssh);
      expect(await readFile(ssh.keyFile, 'utf8')).toBe(`${key}\n`);
      expect(await readFile(ssh.knownHostsFile, 'utf8')).toBe(`${knownHosts}\n`);
      if (!isWindows) {
        expect((await stat(ssh.keyFile)).mode & 0o777).toBe(0o600);
        expect((await stat(join(ssh.keyFile, '..'))).mode & 0o777).toBe(0o700);
      }
      const env = new GitRunner({ emptyHooksDir: dir }).env(fields);
      expect(env.GIT_SSH_COMMAND).toContain('-F none');
      expect(env.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
      expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
      // git's shell takes the paths with forward slashes on Windows (sshCommand).
      const knownHostsPath = isWindows ? ssh.knownHostsFile.split('\\').join('/') : ssh.knownHostsFile;
      expect(env.GIT_SSH_COMMAND).toContain(`UserKnownHostsFile='${knownHostsPath}'`);
      expect(env.GIT_SSH_COMMAND).not.toContain('OPENSSH PRIVATE KEY');
      return 'ok';
    });
    expect(await readdir(credDir)).toEqual([]);
    // Removed on failure too.
    await withGitAuth(source, { purpose: 'push', credDir }, () =>
      Promise.reject(new GitCommandError('push', 128, 'remote: rejected')),
    ).catch(() => undefined);
    expect(await readdir(credDir)).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('quotes Windows paths with forward slashes for git’s shell', () => {
    expect(
      sshCommand({ keyFile: 'C:\\data\\cred\\x\\key', knownHostsFile: "C:\\o'k\\kh" }, 'win32'),
    ).toContain("-i 'C:/data/cred/x/key'");
    expect(sshCommand({ keyFile: '/k', knownHostsFile: "/o'k" }, 'linux')).toContain(
      "UserKnownHostsFile='/o'\\''k'",
    );
  });
});

describe('p15-git-central: readiness (fake probes)', () => {
  it('Windows: GCM in the system config, autocrlf, a stale GitHub login in Credential Manager; the fix erases it', async () => {
    let stored = ['git:https://github.com', 'git:https://octoDev@github.com'];
    const calls: string[] = [];
    const run: ProbeRun = (file, args, opts) => {
      calls.push([file.split(/[\\/]/).pop(), ...args].join(' '));
      const ok = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: '' });
      const none = () => Promise.resolve({ code: 1, stdout: '', stderr: '' });
      if (file.endsWith('cmdkey.exe')) {
        if (args[0] === '/list') {
          return ok(
            stored
              .map((t) => `    Target: LegacyGeneric:target=${t}\n    Type: Generic\n    User: x\n`)
              .join('\n'),
          );
        }
        stored = stored.filter((t) => `/delete:${t}` !== args[0]);
        return ok('');
      }
      const a = args.join(' ');
      if (a === '--version') return ok('git version 2.47.1.windows.2\n');
      if (a === 'config --get-all credential.helper') return ok('manager\n');
      if (a === 'config --get core.autocrlf') return ok('true\n');
      if (a === 'credential reject') {
        expect(opts.input).toBe('protocol=https\nhost=github.com\n\n');
        stored = stored.slice(1); // GCM erases one entry; the other is left for cmdkey
        return ok('');
      }
      return none();
    };
    const r = new GitReadiness({
      gitBinary: () => Promise.resolve({ binary: 'C:\\git\\cmd\\git.exe', source: 'managed' }),
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\nonexistent-profile' },
      run,
    });
    const report = await r.detect();
    expect(report.git).toEqual({ present: true, version: '2.47.1.windows.2', source: 'managed' });
    expect(report.jobsIsolated).toBe(true);
    expect(report.problems).toEqual([
      { code: 'global_credential_helper', severity: 'info', count: 1, helpers: ['manager'] },
      { code: 'autocrlf_true', severity: 'info' },
      { code: 'os_store_github', severity: 'warning', fix: 'erase_github_credentials', count: 2 },
    ]);
    const fixed = await r.fix(['erase_github_credentials']);
    expect(fixed.results).toEqual([{ fix: 'erase_github_credentials', outcome: 'applied' }]);
    expect(calls).toContain('cmdkey.exe /delete:git:https://octoDev@github.com');
    expect(fixed.readiness.problems.map((p) => p.code)).not.toContain('os_store_github');
    // Never a value read out: no `-g`, no `credential fill`.
    expect(calls.some((c) => c.includes('fill') || c.includes(' -g'))).toBe(false);
  });

  it('git missing / too old are blocking', async () => {
    const missing = new GitReadiness({
      gitBinary: () => Promise.resolve({ binary: 'git', source: 'path' }),
      platform: 'linux',
      run: () => Promise.resolve({ code: null, stdout: '', stderr: '', missing: true }),
    });
    expect((await missing.detect()).problems).toEqual([{ code: 'git_missing', severity: 'blocking' }]);
    const old = new GitReadiness({
      gitBinary: () => Promise.resolve({ binary: 'git', source: 'path' }),
      platform: 'linux',
      env: { HOME: '/nonexistent-home' },
      run: (_f, args) =>
        Promise.resolve(
          args[0] === '--version'
            ? { code: 0, stdout: 'git version 2.25.1\n', stderr: '' }
            : { code: 1, stdout: '', stderr: '' },
        ),
    });
    const rep = await old.detect();
    expect(rep.problems[0]).toEqual({ code: 'git_too_old', severity: 'blocking' });
    expect(rep.jobsIsolated).toBe(false);
    expect(rep.osStoreUnchecked).toBe(true);
  });

  it('classifies helpers without keeping their command line', () => {
    expect(helperKind('manager')).toBe('manager');
    expect(helperKind('/usr/local/share/gcm-core/git-credential-manager')).toBe('manager');
    expect(helperKind('osxkeychain')).toBe('osxkeychain');
    expect(helperKind('store --file ~/.x')).toBe('store');
    expect(helperKind('cache --timeout=3600')).toBe('cache');
    expect(helperKind('!f() { echo password=SECRET; }; f')).toBe('other');
  });
});

describe.skipIf(isWindows)('p15-git-central: readiness and fix with real git', GIT_TIMEOUT, () => {
  it('detects rewrites, credentials in a rewrite, safe.directory=*, a store file and an identity; the fix removes the GitHub ones', async () => {
    const dir = await tempDir('rw-gc-');
    const home = join(dir, 'home');
    await mkdir(home);
    await writeFile(
      join(home, '.gitconfig'),
      [
        '[credential]',
        '\thelper = store',
        '[url "git@github.com:"]',
        '\tinsteadOf = https://github.com/',
        '[url "https://bob:ghp_SECRET123@github.com/"]',
        '\tinsteadOf = gh:',
        '[url "https://mirror.example/"]',
        '\tinsteadOf = https://example.org/',
        '[safe]',
        '\tdirectory = *',
        '[user]',
        '\temail = someone@example.com',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(home, '.git-credentials'),
      'https://bob:ghp_STALE@github.com\nhttps://bob:glpat_KEEP@gitlab.example\n',
      { mode: 0o600 },
    );
    const r = new GitReadiness({
      gitBinary: () => Promise.resolve({ binary: 'git', source: 'path' }),
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '', HOME: home },
      extraEnv: { GIT_CONFIG_NOSYSTEM: '1' },
    });
    const report = await r.detect();
    const codes = report.problems.map((p) => p.code);
    expect(codes).toEqual([
      'global_credential_helper',
      'global_insteadof',
      'insteadof_with_credentials',
      'safe_directory_wildcard',
      'credential_store_file',
      'global_identity',
    ]);
    expect(report.problems.find((p) => p.code === 'global_insteadof')?.count).toBe(2);
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(JSON.stringify(report)).not.toContain('ghp_');
    const fixed = await r.fix(['remove_github_insteadof', 'erase_github_credentials']);
    expect(fixed.results).toEqual([
      { fix: 'remove_github_insteadof', outcome: 'applied' },
      { fix: 'erase_github_credentials', outcome: 'applied' },
    ]);
    const config = await readFile(join(home, '.gitconfig'), 'utf8');
    expect(config).not.toContain('github.com');
    expect(config).toContain('mirror.example');
    const store = await readFile(join(home, '.git-credentials'), 'utf8');
    expect(store).not.toContain('github.com');
    expect(store).toContain('gitlab.example');
    expect(fixed.readiness.problems.map((p) => p.code)).not.toContain('global_insteadof');
  });
});
