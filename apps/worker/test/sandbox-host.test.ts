import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxRequestError, SandboxUnavailableError } from '../src/sandbox/errors.js';
import { collectIdentityFacts, evaluateIdentity, type IdentityFacts } from '../src/sandbox/host/identity.js';
import { posixLimitsPrelude, windowsJobObjectKiller } from '../src/sandbox/host/limits.js';
import { jobRunnerSpec } from '../src/sandbox/host/windows-jobrun.js';
import { parseEtime, parseLsofCwd, parsePs, sweepEscapedProcesses } from '../src/sandbox/host/reaper.js';
import { HostRestrictedRunner } from '../src/sandbox/host/runner.js';
import { buildSeatbeltProfile, PROTECTED_HOME_PATHS } from '../src/sandbox/host/seatbelt.js';
import {
  assertRuntimeSandboxNotWeaker,
  claudeSandboxSettings,
  codexSandboxConfig,
  RuntimeSandboxRunner,
  runtimeSandboxSupport,
} from '../src/sandbox/runtime-sandbox.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const itPosix = process.platform === 'win32' ? it.skip : it;

const facts = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  platform: 'darwin',
  username: '_remyral',
  uid: 450,
  groupNames: ['_remyral', 'everyone'],
  groupIds: [450, 12],
  consoleUid: 501,
  groupSids: [],
  ...over,
});

describe('dedicated worker OS user (ADR-0007)', () => {
  it('accepts the configured, unprivileged, non-console user', () => {
    expect(evaluateIdentity(facts(), '_remyral')).toMatchObject({ verified: true, problems: [] });
    expect(evaluateIdentity(facts({ platform: 'linux', consoleUid: null }), '_remyral').verified).toBe(true);
  });

  it('refuses root, admins, root-equivalent groups, the console owner, other users, and an unset name', () => {
    const cases: [Partial<IdentityFacts>, string | undefined, RegExp][] = [
      [{ uid: 0, username: 'root' }, 'root', /running as root/],
      [{ groupIds: [450, 80], groupNames: ['_remyral'] }, '_remyral', /admin/],
      [{ platform: 'linux', groupNames: ['remyral', 'docker'] }, '_remyral', /docker/],
      [{ platform: 'linux', groupNames: ['remyral', 'sudo'] }, '_remyral', /sudo/],
      [{ consoleUid: 450 }, '_remyral', /interactive console user/],
      [{ username: 'alex' }, '_remyral', /not the configured worker user/],
      [{}, undefined, /workerUser is not configured/],
      [
        { platform: 'win32', uid: null, username: 'remyral', groupSids: ['S-1-5-32-544'] },
        'remyral',
        /Administrators/,
      ],
      [
        { platform: 'win32', uid: null, username: 'SYSTEM', groupSids: ['S-1-5-18'] },
        'SYSTEM',
        /LocalSystem/,
      ],
    ];
    for (const [over, expected, re] of cases) {
      const r = evaluateIdentity(facts(over), expected);
      expect(r.verified, JSON.stringify(over)).toBe(false);
      expect(r.problems.join('; ')).toMatch(re);
    }
  });

  it('collects facts from id/stat (darwin) and whoami (windows) output', async () => {
    const exec = (cmd: string, args: readonly string[]): Promise<string> => {
      if (cmd === 'id' && args[0] === '-Gn') return Promise.resolve('staff admin everyone\n');
      if (cmd === 'id') return Promise.resolve('20 80 12\n');
      if (cmd === 'stat') return Promise.resolve('501\n');
      if (args[0] === '/groups')
        return Promise.resolve(
          '"Everyone","Well-known group","S-1-1-0","Mandatory"\r\n"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n',
        );
      return Promise.resolve('"desk\\remyral","S-1-5-21-1-2-3-1001"\r\n');
    };
    const d = await collectIdentityFacts('darwin', exec);
    expect(d).toMatchObject({
      groupNames: ['staff', 'admin', 'everyone'],
      groupIds: [20, 80, 12],
      consoleUid: 501,
    });
    const w = await collectIdentityFacts('win32', exec);
    expect(w.groupSids).toEqual(['S-1-1-0', 'S-1-5-32-544', 'S-1-5-21-1-2-3-1001']);
    expect(evaluateIdentity({ ...w, username: 'remyral' }, 'remyral').problems.join()).toMatch(
      /Administrators/,
    );
  });
});

// Builds macOS Seatbelt paths with this host's path module: not meaningful on a Windows host.
describePosix('Seatbelt profile (macOS host-restricted)', () => {
  const spec = {
    workspace: '/r/jobs/j/a',
    sandboxDir: '/r/sandboxes/j/a',
    workspaceRoot: '/r',
    workerDataDir: '/Users/_remyral/Library/Application Support/remyral-worker',
    mirrorObjects: '/r/mirrors/abc.git/objects',
    homes: ['/Users/_remyral', '/Users/owner'],
    proxyPort: 51234,
  };

  it('passes every path as a -D parameter, never in the profile text', () => {
    const sb = buildSeatbeltProfile({ ...spec, workspace: '/r/jobs/j/a") (allow file-write* (subpath "/x' });
    expect(sb.profile).not.toContain('/r/');
    expect(sb.profile).not.toContain('/Users/');
    expect(Object.values(sb.params)).toContain('/r/jobs/j/a") (allow file-write* (subpath "/x');
    expect(sb.argv.slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
    expect(sb.argv.filter((a) => a === '-D')).toHaveLength(Object.keys(sb.params).length);
  });

  it('orders rules: deny writes, allow own dirs, deny secrets except own (require-not), deny .git, network only to the proxy', () => {
    const { profile, params } = buildSeatbeltProfile(spec);
    const lines = profile.split('\n');
    const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(idx(/^\(deny file-write\*\)$/)).toBeLessThan(idx(/^\(allow file-write\*/));
    expect(idx(/^\(allow file-write\*/)).toBeLessThan(idx(/^\(deny file-read-data/));
    expect(idx(/^\(allow file-read/)).toBe(-1);
    expect(idx(/^\(deny file-write\* \(literal/)).toBe(lines.length - 3);
    const jobsRule =
      lines.find((l) => l.startsWith('(deny file-read-data') && l.includes('require-not')) ?? '';
    // Own worktree, sandbox dir, mirror objects + the ancestors (root, jobs, jobs/j, sandboxes, ...).
    expect(jobsRule.match(/require-not/g)?.length).toBeGreaterThanOrEqual(3 + 5);
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('network-bind');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:51234"))');
    expect(buildSeatbeltProfile({ ...spec, allowListen: true }).profile).toContain(
      '(allow network-inbound (local ip "localhost:*"))',
    );
    const values = Object.values(params);
    for (const home of spec.homes) {
      expect(values).toContain(`${home}/.ssh`);
      expect(values).toContain(`${home}/Library/Keychains`);
    }
    expect(values).toContain('/r/jobs/j/a/.git');
    expect(values).toContain(spec.workerDataDir);
    expect(values).toContain('/r/mirrors');
    expect(PROTECTED_HOME_PATHS).toContain('Library/Application Support/Google/Chrome');
  });

  it('no proxy → no outbound at all; keychain can be allowed for local-login', () => {
    const { profile, params } = buildSeatbeltProfile({ ...spec, proxyPort: undefined, allowKeychain: true });
    expect(profile).not.toContain('network-outbound');
    expect(Object.values(params)).not.toContain('/Users/owner/Library/Keychains');
    expect(Object.values(params)).toContain('/Users/owner/.ssh');
  });

  it('refuses relative paths and bad ports', () => {
    expect(() => buildSeatbeltProfile({ ...spec, workspace: 'jobs/x' })).toThrow(SandboxRequestError);
    expect(() => buildSeatbeltProfile({ ...spec, proxyPort: 70000 })).toThrow(SandboxRequestError);
  });
});

describe('host limits', () => {
  it('POSIX prelude sets nofile/fsize/nproc/core and execs the runtime', () => {
    const [sh, c, script, name] = posixLimitsPrelude(DEFAULT_LIMITS, 'darwin');
    expect([sh, c, name]).toEqual(['/bin/sh', '-c', 'remyral-limits']);
    expect(script).toBe(
      `ulimit -c 0 && ulimit -n 4096 && ulimit -f ${String((2 * 1024 ** 3) / 1024)} && { ulimit -u 512 2>/dev/null || ulimit -p 512; } && exec "$@"`,
    );
    expect(posixLimitsPrelude(DEFAULT_LIMITS, 'linux')[2]).toContain(
      `ulimit -f ${String((2 * 1024 ** 3) / 512)}`,
    );
    expect(() => posixLimitsPrelude({ ...DEFAULT_LIMITS, pids: 0 }, 'linux')).toThrow(SandboxRequestError);
  });

  // Needs /bin/sh.
  itPosix('the prelude runs under this /bin/sh and applies the process limit', async () => {
    const [sh, c, script, name] = posixLimitsPrelude(DEFAULT_LIMITS, process.platform);
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        sh ?? '/bin/sh',
        [c ?? '-c', script ?? '', name ?? '', '/bin/sh', '-c', 'ulimit -n'],
        (err, stdout) => {
          if (err) reject(new Error(err.message));
          else resolve(stdout.trim());
        },
      );
    });
    expect(out).toBe('4096');
  });

  it('Windows job runner spec and killer (real Windows: docs/design/p5-sandbox-ops.md)', async () => {
    expect(jobRunnerSpec(['C:\\rt\\claude.exe', '-p', 'a b'], 'C:\\w', DEFAULT_LIMITS, 8)).toEqual({
      v: 1,
      commandLine: 'C:\\rt\\claude.exe -p "a b"',
      cwd: 'C:\\w',
      memoryBytes: 4 * 1024 ** 3,
      maxProcesses: 512,
      cpuRatePercent: 25,
    });
    const calls: (readonly string[])[] = [];
    const killer = windowsJobObjectKiller((args) => {
      calls.push(args);
      return Promise.resolve({ exitCode: calls.length === 1 ? 128 : 1, stderr: 'denied' });
    });
    expect(killer.kind).toBe('windows-job-object');
    await killer.kill(4242);
    expect(calls[0]).toEqual(['/PID', '4242', '/T', '/F']);
    await expect(killer.kill(4242)).rejects.toThrow(/taskkill failed/);
    await expect(killer.kill(0)).rejects.toThrow(RangeError);
  });

  it('host runner refuses an unverified identity with the reason and remedy', async () => {
    const runner = new HostRestrictedRunner({
      identity: {
        verified: false,
        username: 'alex',
        uid: 501,
        problems: ['member of privileged group(s): admin'],
      },
      workspaceRoot: '/r',
      workerDataDir: '/d',
      platform: 'darwin',
    });
    expect(runner.check()).toMatchObject({
      ready: false,
      reasonCode: 'worker_identity_unsafe',
      filesystemConfinement: 'seatbelt',
    });
    await expect(
      runner
        .confiner({
          jobId: 'j',
          attemptId: 'a',
          workspacePath: '/r/jobs/j/a',
          network: { mode: 'none' },
          limits: DEFAULT_LIMITS,
        })
        .confine({
          command: 'x',
          args: [],
          cwd: '/',
          env: {},
          secretNames: [],
        }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    const noRunner = new HostRestrictedRunner({
      identity: { verified: true, username: 'remyral', uid: null, problems: [] },
      workspaceRoot: 'C:\\r',
      workerDataDir: 'C:\\d',
      platform: 'win32',
    });
    // p5-sandbox-ops: no verified job runner → no host jobs on Windows (limits could not be enforced).
    expect(noRunner.check()).toMatchObject({ ready: false, reasonCode: 'limits_unsupported' });
    const win = new HostRestrictedRunner({
      identity: { verified: true, username: 'remyral', uid: null, problems: [] },
      workspaceRoot: 'C:\\r',
      workerDataDir: 'C:\\d',
      platform: 'win32',
      windowsJobRunner: () => ({
        script: 'C:\\d\\sandbox\\remyral-jobrun.ps1',
        source: 'data',
        verified: true,
      }),
    });
    expect(win.check()).toMatchObject({ ready: true, filesystemConfinement: 'none', egressEnforced: false });
    expect(win.kind).toBe('host-restricted:job-object');
  });
});

describe('runtime-sandbox config builders (never weaker than host-restricted)', () => {
  it('Codex: workspace-write, tool network off, /tmp excluded; externalSandbox inside our container', () => {
    const host = codexSandboxConfig({ inContainer: false });
    expect(host.turnSandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    });
    expect(host.execArgs).toContain('sandbox_workspace_write.network_access=false');
    expect(() => {
      assertRuntimeSandboxNotWeaker('codex', host);
    }).not.toThrow();
    const inC = codexSandboxConfig({ inContainer: true });
    expect(inC.turnSandboxPolicy).toEqual({ type: 'externalSandbox', networkAccess: 'restricted' });
    expect(() => {
      assertRuntimeSandboxNotWeaker('codex', inC);
    }).not.toThrow();
    for (const weak of [
      { ...host, turnSandboxPolicy: { ...host.turnSandboxPolicy, networkAccess: true } },
      { ...host, turnSandboxPolicy: { type: 'dangerFullAccess' } },
      { ...host, threadSandbox: 'danger-full-access' },
      { ...inC, turnSandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } },
    ]) {
      expect(() => {
        assertRuntimeSandboxNotWeaker('codex', weak);
      }, JSON.stringify(weak)).toThrow(SandboxRequestError);
    }
  });

  it('Claude: enabled, failIfUnavailable, no unsandboxed escape, no auto-allow, no tool network, protected reads denied', () => {
    const s = claudeSandboxSettings({
      workspace: '/r/jobs/j/a',
      tmpDir: '/r/sandboxes/j/a/tmp',
      denyRead: ['/Users/_remyral/.ssh'],
    });
    expect(s).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      network: { allowedDomains: [], allowAllUnixSockets: false, allowLocalBinding: false },
      filesystem: {
        allowWrite: ['/r/jobs/j/a', '/r/sandboxes/j/a/tmp'],
        denyWrite: ['/r/jobs/j/a/.git'],
        denyRead: ['/Users/_remyral/.ssh'],
      },
    });
    expect(() => {
      assertRuntimeSandboxNotWeaker('claude-code', s);
    }).not.toThrow();
    for (const weak of [
      { ...s, failIfUnavailable: false },
      { ...s, allowUnsandboxedCommands: true },
      { ...s, autoAllowBashIfSandboxed: true },
      { ...s, excludedCommands: ['docker *'] },
      { ...s, network: { ...s.network, allowedDomains: ['*'] } },
      { ...s, filesystem: { ...s.filesystem, denyRead: [] } },
      { ...s, enabled: false },
    ]) {
      expect(() => {
        assertRuntimeSandboxNotWeaker('claude-code', weak);
      }).toThrow(SandboxRequestError);
    }
    expect(() => {
      assertRuntimeSandboxNotWeaker('pi', {});
    }).toThrow(/no native sandbox/);
  });

  it('support matrix: not on macOS (Seatbelt cannot nest), Codex Linux/Windows, Claude Linux, never Pi/OpenCode', () => {
    expect(runtimeSandboxSupport('codex', 'darwin')).toMatchObject({
      ready: false,
      reasonCode: 'runtime_has_no_sandbox',
    });
    expect(runtimeSandboxSupport('codex', 'linux').ready).toBe(true);
    expect(runtimeSandboxSupport('codex', 'win32').ready).toBe(true);
    expect(runtimeSandboxSupport('claude-code', 'linux').ready).toBe(true);
    expect(runtimeSandboxSupport('claude-code', 'win32').ready).toBe(false);
    expect(runtimeSandboxSupport('pi', 'linux').ready).toBe(false);
    expect(runtimeSandboxSupport('opencode', 'linux').ready).toBe(false);
  });

  it('RuntimeSandboxRunner layers on the host baseline and refuses without it', async () => {
    const host = new HostRestrictedRunner({
      identity: { verified: false, username: 'x', uid: 1, problems: ['p'] },
      workspaceRoot: '/r',
      workerDataDir: '/d',
      platform: 'linux',
    });
    const rs = new RuntimeSandboxRunner(host, 'linux');
    expect(rs.check('codex')).toMatchObject({ ready: false, reasonCode: 'worker_identity_unsafe' });
    const ctx = {
      jobId: 'j',
      attemptId: 'a',
      runtime: 'pi' as const,
      workspacePath: '/r/jobs/j/a',
      network: { mode: 'none' as const },
      limits: DEFAULT_LIMITS,
    };
    await expect(
      rs.confiner(ctx).confine({ command: 'x', args: [], cwd: '/', env: {}, secretNames: [] }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

describe('escaped-process reaper (host profiles)', () => {
  it('parses ps etime and lsof cwd output', () => {
    expect(parseEtime('05')).toBeNaN();
    expect(parseEtime('01:05')).toBe(65);
    expect(parseEtime('02:01:05')).toBe(7265);
    expect(parseEtime('3-02:01:05')).toBe(3 * 86400 + 7265);
    expect(parsePs('  101     1   450      00:03\n 102 101 450 1-00:00:00\nbad line\n')).toEqual([
      { pid: 101, ppid: 1, uid: 450, elapsedSec: 3 },
      { pid: 102, ppid: 101, uid: 450, elapsedSec: 86400 },
    ]);
    expect(parseLsofCwd('p101\nfcwd\nn/r/jobs/j/a\np102\nfcwd\nn/\n')).toEqual(
      new Map([
        [101, '/r/jobs/j/a'],
        [102, '/'],
      ]),
    );
  });

  it('macOS: kills recent orphans of the user in the attempt dirs; all recent ones only when exclusive', async () => {
    const ps = () =>
      Promise.resolve(
        [
          '201 1 450 00:02', // recent orphan, cwd in workspace → ours
          '202 1 450 00:02', // recent orphan, cwd elsewhere → ambiguous
          '203 1 450 10:00', // older than the job → not ours
          '204 1 999 00:01', // other user
          '205 77 450 00:01', // has a live parent (still in some tree)
        ].join('\n'),
      );
    const lsof = () => Promise.resolve('p201\nfcwd\nn/r/jobs/j/a/sub\np202\nfcwd\nn/\n');
    const killed: number[] = [];
    const deps = {
      platform: 'darwin' as const,
      uid: 450,
      selfPid: 1,
      ps,
      lsof,
      kill: (pid: number) => {
        killed.push(pid);
      },
      now: () => 10_000,
    };
    const inDirs = await sweepEscapedProcesses({
      token: 't',
      startedAtMs: 5_000,
      orphans: 'in-dirs',
      dirs: ['/r/jobs/j/a'],
      deps,
    });
    expect(inDirs).toEqual({ killed: [201], suspicious: [202] });
    const all = await sweepEscapedProcesses({
      token: 't',
      startedAtMs: 5_000,
      orphans: 'all-recent',
      dirs: ['/r/jobs/j/a'],
      deps,
    });
    expect(all).toEqual({ killed: [201, 202], suspicious: [] });
  });

  it('Linux: kills processes whose initial environment carries the attempt token', async () => {
    const proc = await tempDir('rw-proc-');
    for (const [pid, env] of [
      ['301', 'PATH=/bin\0REMYRAL_SANDBOX_TOKEN=abc\0'],
      ['302', 'PATH=/bin\0REMYRAL_SANDBOX_TOKEN=other\0'],
      ['303', 'REMYRAL_SANDBOX_TOKEN=abcd\0'],
    ] as const) {
      await mkdir(join(proc, pid), { recursive: true });
      await writeFile(join(proc, pid, 'environ'), env);
    }
    await mkdir(join(proc, 'self'), { recursive: true });
    const killed: number[] = [];
    const r = await sweepEscapedProcesses({
      token: 'abc',
      startedAtMs: 0,
      orphans: 'in-dirs',
      dirs: [],
      deps: {
        platform: 'linux',
        uid: 1,
        selfPid: 999,
        procRoot: proc,
        kill: (pid) => {
          killed.push(pid);
        },
      },
    });
    expect(r.killed).toEqual([301]);
    expect(killed).toEqual([301]);
  });
});
