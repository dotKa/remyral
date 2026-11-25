import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxRunners } from '../src/sandbox/factory.js';
import { SandboxSettings } from '../src/sandbox/config.js';
import {
  buildHostBwrapArgs,
  type HostBwrapSpec,
  LinuxIsolationController,
  type Lstat,
  PROBE_SCRIPT,
  probeVerdict,
  type StartProcess,
} from '../src/sandbox/host/linux-isolation.js';
import { HostRestrictedRunner } from '../src/sandbox/host/runner.js';
import { isolationStep } from '../src/sandbox/prepare.js';
import { profileSlots } from '../src/sandbox/profile-slots.js';
import {
  type JobSandboxRequirements,
  type RunningAttempt,
  selectProfile,
  type WorkerSandboxCapabilities,
} from '../src/sandbox/policy.js';
import { RuntimeSandboxRunner } from '../src/sandbox/runtime-sandbox.js';
import { buildSandboxStatus } from '../src/sandbox/status.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/**
 * p19-linux-host-isolation (ADR-0066, docs/design/p19-linux-host-isolation.md): per-attempt bubblewrap views on Linux,
 * the cross-attempt self-check, profile slots / selection with `bwrap`, the host runner's argv, status and Prepare.
 * The real bubblewrap run is the Linux-only integration test (linux-host-isolation.integration.test.ts).
 */

const ALL = 'ok';
const okProbe = [
  'started',
  'own_workspace',
  'own_sandbox',
  'peer_workspace',
  'peer_sandbox',
  'peer_listing',
  'data_dir',
  'data_listing',
  'proc_peer',
  'system_write',
  'peer_write',
]
  .map((k) => `R ${k} ${ALL}`)
  .join('\n');

const files = (map: Record<string, 'dir' | 'file'>): Lstat => {
  return (p) =>
    Promise.resolve(
      map[p] === undefined ? null : { isDirectory: () => map[p] === 'dir', isFile: () => map[p] === 'file' },
    );
};

/** Fake bwrap: the victim writes its ready file; the prober prints `stdout` (or fails as `fail`). */
const fakeStart = (
  out: (args: readonly string[], pid: boolean) => { code: number; stdout: string; stderr: string },
  calls: string[][] = [],
): StartProcess => {
  return (_file, args, opts) => {
    calls.push([...args]);
    const pid = args.includes('--unshare-pid');
    const script = args[args.length - 1] ?? '';
    if (script.includes('READY')) {
      const r = out(args, pid);
      if (r.code !== 0) return { wait: () => Promise.resolve(r), kill: () => undefined };
      // Runs until killed, like `exec sleep 30`.
      void writeFile(opts.env.READY ?? '/nonexistent', 'up');
      let end: (v: { code: number; stdout: string; stderr: string }) => void = () => undefined;
      const done = new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
        end = res;
      });
      return {
        wait: () => done,
        kill: () => {
          end({ code: 137, stdout: '', stderr: '' });
        },
      };
    }
    return { wait: () => Promise.resolve(out(args, pid)), kill: () => undefined };
  };
};

// Builds Linux paths (bubblewrap) with this host's path module: not meaningful on a Windows host.
describePosix('bubblewrap view of one attempt (buildHostBwrapArgs)', () => {
  const spec: HostBwrapSpec = {
    workspace: '/var/lib/rw/workspaces/jobs/j1/a1',
    sandboxDir: '/var/lib/rw/workspaces/sandboxes/j1/a1',
    workspaceRoot: '/var/lib/rw/workspaces',
    workerDataDir: '/var/lib/rw',
    readableInDataDir: ['/var/lib/rw/runtimes', '/var/lib/rw/tools', '/var/lib/rw/mcp'],
    mirrorObjects: '/var/lib/rw/workspaces/mirrors/p/objects',
    writable: ['/var/lib/rw/caches/host/p'],
    homes: ['/var/lib/rw/home'],
    mask: ['/var/lib/rw/home/.claude', '/var/lib/rw/home/.claude.json'],
    pidNamespace: true,
  };
  const fs = files({
    '/var/lib/rw': 'dir',
    '/var/lib/rw/workspaces': 'dir',
    '/var/lib/rw/runtimes': 'dir',
    '/var/lib/rw/tools': 'dir',
    '/var/lib/rw/workspaces/mirrors/p/objects': 'dir',
    '/var/lib/rw/caches/host/p': 'dir',
    '/var/lib/rw/home': 'dir',
    '/var/lib/rw/home/.ssh': 'dir',
    '/var/lib/rw/home/.claude': 'dir',
    '/var/lib/rw/home/.claude.json': 'file',
    '/var/lib/rw/workspaces/jobs/j1/a1/.git': 'file',
  });

  it('host read-only, private /dev /proc /tmp, data dir masked, only the attempt bound back', async () => {
    const args = await buildHostBwrapArgs(spec, spec.workspace, fs);
    const s = args.join(' ');
    expect(args.slice(0, 4)).toEqual([
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--die-with-parent',
    ]);
    expect(s).toContain('--ro-bind / / --dev /dev --tmpfs /dev/shm --proc /proc --tmpfs /tmp');
    // The workspace root lies in the data dir: one mask covers both.
    expect(s).toContain('--tmpfs /var/lib/rw ');
    expect(s).not.toContain('--tmpfs /var/lib/rw/workspaces ');
    expect(s).toContain('--ro-bind /var/lib/rw/runtimes /var/lib/rw/runtimes');
    expect(s).toContain('--ro-bind /var/lib/rw/tools /var/lib/rw/tools');
    expect(s).not.toContain('/var/lib/rw/mcp'); // missing paths are not bound
    expect(s).toContain(
      '--ro-bind /var/lib/rw/workspaces/mirrors/p/objects /var/lib/rw/workspaces/mirrors/p/objects',
    );
    expect(s).toContain('--bind /var/lib/rw/caches/host/p /var/lib/rw/caches/host/p');
    expect(s).toContain(`--bind ${spec.sandboxDir} ${spec.sandboxDir}`);
    expect(s).toContain(`--bind ${spec.workspace} ${spec.workspace}`);
    expect(s).toContain(`--ro-bind ${spec.workspace}/.git ${spec.workspace}/.git`);
    // The home lies in the masked data dir and is not bound back: nothing of it to hide.
    expect(s).not.toContain('/var/lib/rw/home');
    // Masks become read-only last; cwd is the worktree.
    expect(args.slice(-4)).toEqual(['--remount-ro', '/var/lib/rw', '--chdir', spec.workspace]);
    // The attempt's own dirs come after the masks (later mounts cover earlier ones).
    expect(args.indexOf('--tmpfs', 12)).toBeLessThan(args.indexOf(spec.workspace));
  });

  it('a subscription-login attempt keeps the worker home read-write, its protected paths hidden on top', async () => {
    const args = await buildHostBwrapArgs(
      { ...spec, sharedHome: '/var/lib/rw/home', mask: [], pidNamespace: false },
      spec.workspace,
      fs,
    );
    const s = args.join(' ');
    expect(args).not.toContain('--unshare-pid');
    expect(s).toContain('--bind /var/lib/rw/home /var/lib/rw/home');
    expect(s).toContain('--tmpfs /var/lib/rw/home/.ssh --remount-ro /var/lib/rw/home/.ssh');
    expect(args.indexOf('/var/lib/rw/home/.ssh')).toBeGreaterThan(args.indexOf('/var/lib/rw/home'));
    // Its login store stays (not masked).
    expect(s).not.toContain('/dev/null /var/lib/rw/home/.claude.json');
  });

  it('a home outside the data dir: protected paths and the login stores of other attempts are hidden', async () => {
    const fs2 = files({
      '/var/lib/rw': 'dir',
      '/home/w/.ssh': 'dir',
      '/home/w/.claude': 'dir',
      '/home/w/.claude.json': 'file',
    });
    const s = (
      await buildHostBwrapArgs(
        { ...spec, homes: ['/home/w'], mask: ['/home/w/.claude', '/home/w/.claude.json'] },
        spec.workspace,
        fs2,
      )
    ).join(' ');
    expect(s).toContain('--tmpfs /home/w/.ssh --remount-ro /home/w/.ssh');
    expect(s).toContain('--tmpfs /home/w/.claude --remount-ro /home/w/.claude');
    expect(s).toContain('--ro-bind /dev/null /home/w/.claude.json');
  });

  it('refuses relative paths and paths with newlines', async () => {
    await expect(buildHostBwrapArgs({ ...spec, workspace: 'rel/ws' }, '/x', fs)).rejects.toThrow(
      /absolute path/,
    );
    await expect(
      buildHostBwrapArgs({ ...spec, writable: ['/var/lib/rw/caches\n--bind / /'] }, '/x', fs),
    ).rejects.toThrow(/absolute path/);
  });
});

describe('cross-attempt self-check', () => {
  it('the probe verdict: every expectation must hold', () => {
    expect(probeVerdict(okProbe)).toBeNull();
    expect(probeVerdict(okProbe.replace('R peer_workspace ok', 'R peer_workspace leak'))).toBe(
      'peer_workspace: leak',
    );
    expect(probeVerdict(okProbe.replace('R proc_peer ok\n', ''))).toBe('proc_peer: no answer');
    expect(probeVerdict('')).toMatch(/started: no answer/);
    // The probe looks for the peer's token only as REMYRAL_PROBE_TOKEN=… (its own env carries it as PEER_TOKEN).
    expect(PROBE_SCRIPT).toContain('REMYRAL_PROBE_TOKEN=$PEER_TOKEN');
  });

  const layout = async (): Promise<{ root: string; data: string }> => {
    const data = await tempDir('lhi-');
    const root = join(data, 'workspaces');
    await mkdir(root, { recursive: true });
    await mkdir(join(data, 'runtimes'), { recursive: true });
    return { root, data };
  };

  const controller = async (
    start: StartProcess,
    over: Partial<ConstructorParameters<typeof LinuxIsolationController>[0]> = {},
  ): Promise<LinuxIsolationController> => {
    const { root, data } = await layout();
    return new LinuxIsolationController({
      mode: 'auto',
      workspaceRoot: root,
      dataDir: data,
      readableInDataDir: [join(data, 'runtimes')],
      findBwrap: () => Promise.resolve('/usr/bin/bwrap'),
      trusted: () => Promise.resolve(null),
      start,
      ...over,
    });
  };

  it('passes with a PID namespace when both probes hold', async () => {
    const calls: string[][] = [];
    const c = await controller(fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' }), calls));
    expect(c.status()).toMatchObject({ active: false, code: 'host_isolation_unverified' });
    const s = await c.verify();
    expect(s).toMatchObject({ active: true, pidNamespace: true, bwrap: '/usr/bin/bwrap' });
    expect(c.active()).toMatchObject({ bwrap: '/usr/bin/bwrap', pidNamespace: true, privateNetwork: false });
    // Two directions, victim + prober each.
    expect(calls).toHaveLength(4);
    expect(calls.every((a) => a.includes('--unshare-user') && a.includes('--unshare-pid'))).toBe(true);
  });

  it('falls back to user + mount namespaces when the host refuses a private /proc in a PID namespace', async () => {
    const c = await controller(
      fakeStart((_a, pid) =>
        pid
          ? {
              code: 1,
              stdout: '',
              stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
            }
          : { code: 0, stdout: okProbe, stderr: '' },
      ),
    );
    expect(await c.verify()).toMatchObject({ active: true, pidNamespace: false });
    expect(c.status().detail).toMatch(/refuses a private \/proc/);
  });

  it('a leak keeps it off (one at a time) with the failing check named', async () => {
    const c = await controller(
      fakeStart(() => ({
        code: 0,
        stdout: okProbe.replace('R proc_peer ok', 'R proc_peer leak'),
        stderr: '',
      })),
    );
    const s = await c.verify();
    expect(s).toMatchObject({ active: false, code: 'host_isolation_selftest_failed' });
    expect(s.detail).toMatch(/proc_peer: leak/);
    expect(c.active()).toBeNull();
  });

  it('user namespaces refused, bubblewrap missing or untrusted, owner switch off', async () => {
    const userns = await controller(
      fakeStart(() => ({
        code: 1,
        stdout: '',
        stderr:
          'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces',
      })),
    );
    expect(await userns.verify()).toMatchObject({ active: false, code: 'host_isolation_userns_refused' });
    const missing = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      {
        findBwrap: () => Promise.resolve(null),
      },
    );
    const m = await missing.verify();
    expect(m).toMatchObject({ active: false, code: 'host_isolation_bwrap_missing' });
    expect(m.detail).toContain('sudo apt install bubblewrap');
    const untrusted = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      {
        trusted: () => Promise.resolve('/usr/local/bin/bwrap is writable by group or others'),
      },
    );
    expect(await untrusted.verify()).toMatchObject({ code: 'host_isolation_bwrap_untrusted' });
    const off = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      { mode: 'off' },
    );
    expect(await off.verify()).toMatchObject({ active: false, code: 'host_isolation_disabled' });
  });

  it('p19-auto-bwrap: bubblewrap installed later is picked up without a restart; the watch then stops', async () => {
    let installed = false;
    let looks = 0;
    const c = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      {
        findBwrap: () => {
          looks += 1;
          return Promise.resolve(installed ? '/usr/bin/bwrap' : null);
        },
      },
    );
    expect(await c.verify()).toMatchObject({ active: false, code: 'host_isolation_bwrap_missing' });
    let changed = 0;
    const picked = new Promise<void>((resolve) => {
      c.watchBwrap(() => {
        changed += 1;
        resolve();
      }, 10);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(changed).toBe(0); // still missing: nothing re-reported
    expect(c.active()).toBeNull();
    installed = true; // the privileged helper installed it
    await picked;
    expect(c.status()).toMatchObject({ active: true });
    expect(c.active()).toMatchObject({ bwrap: '/usr/bin/bwrap', pidNamespace: true, privateNetwork: false });
    const after = looks;
    await new Promise((r) => setTimeout(r, 50));
    expect(looks).toBe(after); // stopped once found
    expect(changed).toBe(1);
    // Owner switch off: no watch at all.
    const off = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      {
        mode: 'off',
        findBwrap: () => {
          looks += 1;
          return Promise.resolve(null);
        },
      },
    );
    const before = looks;
    off.watchBwrap(() => undefined, 10)();
    await new Promise((r) => setTimeout(r, 30));
    expect(looks).toBe(before);
  });

  it('Prepare re-runs it and reports done / needs_owner / failed', async () => {
    const ok = await controller(fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })));
    expect(await isolationStep(ok)).toMatchObject({ state: 'done' });
    const missing = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      {
        findBwrap: () => Promise.resolve(null),
      },
    );
    expect(await isolationStep(missing)).toMatchObject({
      state: 'needs_owner',
      code: 'host_isolation_bwrap_missing',
    });
    const leak = await controller(
      fakeStart(() => ({ code: 0, stdout: okProbe.replace('R data_dir ok', 'R data_dir leak'), stderr: '' })),
    );
    expect(await isolationStep(leak)).toMatchObject({
      state: 'failed',
      code: 'host_isolation_selftest_failed',
    });
  });
});

describe('profile slots and selection with bubblewrap views', () => {
  it('host-restricted gets the slots, runtime-sandbox stays one at a time and alone; no local-login block', () => {
    const r = profileSlots({
      maxParallelJobs: 3,
      profiles: ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'],
      filesystemConfinement: 'bwrap',
      localLoginRuntimes: ['claude-code'],
    });
    expect(r.profileConcurrency).toEqual({
      container: 3,
      'runtime-sandbox': 1,
      'host-restricted': 3,
      unconfined: 1,
    });
    expect(r.exclusiveProfiles.sort()).toEqual(['runtime-sandbox', 'unconfined']);
    expect(r.localLogin).toBeUndefined();
    // Without the view (self-check not passed): today's rule.
    expect(
      profileSlots({ maxParallelJobs: 3, profiles: ['host-restricted'], filesystemConfinement: 'none' }),
    ).toEqual({ profileConcurrency: { 'host-restricted': 1 }, exclusiveProfiles: ['host-restricted'] });
  });

  const FAM = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const attempt = (over: Partial<RunningAttempt> = {}): RunningAttempt => ({
    family: OTHER,
    projectId: 'p',
    profile: 'host-restricted',
    runtime: 'codex',
    authMode: 'secret-ref',
    ...over,
  });
  const caps = (
    attempts: readonly RunningAttempt[] | undefined,
    running?: number,
  ): WorkerSandboxCapabilities => ({
    platform: 'linux',
    container: { ready: true },
    hostRestricted: { ready: true, filesystemConfinement: 'bwrap', egressEnforced: false, concurrency: 3 },
    runtimeSandboxes: ['codex', 'claude-code'],
    unconfined: { ready: true },
    runningAttempts: running ?? attempts?.length ?? 0,
    ...(attempts === undefined ? {} : { attempts }),
  });
  const job = (over: Partial<JobSandboxRequirements> = {}): JobSandboxRequirements => ({
    profile: 'host-restricted',
    runtime: 'claude-code',
    sourceTrust: 'trusted',
    needsEgress: true,
    hostExecutionOptIn: true,
    authMode: 'secret-ref',
    family: FAM,
    projectId: 'p',
    ...over,
  });
  const policy = {
    allowedProfiles: ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'] as const,
  };
  const why = (r: ReturnType<typeof selectProfile>): string => (r.ok ? 'ok' : r.error.message);

  it('host attempts run beside other views (any family) and beside containers', () => {
    const r = selectProfile(job(), caps([attempt(), attempt({ profile: 'container' })]), policy);
    expect(r).toMatchObject({ ok: true, profile: 'host-restricted' });
    expect(r.ok && r.notes.join()).toMatch(/own bubblewrap view/);
  });

  it('never beside an attempt without a view; runtime-sandbox keeps the old rule', () => {
    for (const blocker of [attempt({ profile: 'runtime-sandbox' }), attempt({ profile: 'unconfined' })]) {
      const r = selectProfile(job(), caps([blocker]), policy);
      expect(r.ok).toBe(false);
      expect(why(r)).toMatch(/without its own bubblewrap view/);
      expect(!r.ok && r.error.busy).toBe(true);
    }
    const rs = selectProfile(job({ profile: 'runtime-sandbox' }), caps([attempt()]), policy);
    expect(why(rs)).toMatch(/without filesystem confinement/);
    expect(selectProfile(job({ profile: 'runtime-sandbox' }), caps([]), policy).ok).toBe(true);
  });

  it('subscription-login attempts: beside API-key ones and their own family, not beside another family', () => {
    const ll = job({ authMode: 'local-login' });
    expect(selectProfile(ll, caps([attempt()]), policy).ok).toBe(true);
    expect(
      selectProfile(ll, caps([attempt({ authMode: 'local-login', family: FAM, runtime: 'codex' })]), policy)
        .ok,
    ).toBe(true);
    const r = selectProfile(ll, caps([attempt({ authMode: 'local-login' })]), policy);
    expect(why(r)).toMatch(/share the worker's home on Linux/);
    // An API-key attempt does not wait for a running subscription-login one.
    expect(selectProfile(job(), caps([attempt({ authMode: 'local-login' })]), policy).ok).toBe(true);
  });

  it('running attempts not known: conservative (alone)', () => {
    expect(why(selectProfile(job(), caps(undefined, 1), policy))).toMatch(/not known/);
    expect(selectProfile(job(), caps(undefined, 0), policy).ok).toBe(true);
  });
});

// Builds Linux paths (bubblewrap) with this host's path module: not meaningful on a Windows host.
describePosix('host runner on Linux with an active view', () => {
  const active = (pidNamespace = true): LinuxIsolationController => {
    const c = new LinuxIsolationController({
      mode: 'auto',
      workspaceRoot: '/unused',
      dataDir: '/unused',
      readableInDataDir: [],
      findBwrap: () => Promise.resolve('/usr/bin/bwrap'),
    });
    // The controller's state after a passed self-check.
    Object.defineProperty(c, 'active', { value: () => ({ bwrap: '/usr/bin/bwrap', pidNamespace }) });
    return c;
  };

  const setup = async (keepHome: boolean) => {
    const data = await tempDir('lhr-');
    const root = join(data, 'workspaces');
    const ws = join(root, 'jobs', 'j1', 'a1');
    await mkdir(ws, { recursive: true });
    await mkdir(join(data, 'home', '.claude'), { recursive: true });
    const runner = new HostRestrictedRunner({
      identity: { verified: true, username: 'remyral-worker', uid: 990, problems: [] },
      workspaceRoot: root,
      workerDataDir: data,
      platform: 'linux',
      keepHome,
      linuxIsolation: active(),
    });
    return { data, root, ws, runner };
  };

  const plan = (home: string) => ({
    command: '/usr/bin/codex',
    args: ['exec'],
    cwd: '/',
    env: { HOME: home, PATH: '/usr/bin' },
    secretNames: [],
  });

  it('wraps the runtime in bwrap; per-attempt HOME even with keepHome for an API-key attempt', async () => {
    const { data, ws, runner } = await setup(true);
    expect(runner.filesystemConfinement).toBe('bwrap');
    expect(runner.kind).toBe('host-restricted:bwrap');
    expect(runner.check()).toMatchObject({
      ready: true,
      filesystemConfinement: 'bwrap',
      egressEnforced: false,
    });
    const ctx = {
      jobId: 'j1',
      attemptId: 'a1',
      authMode: 'secret-ref' as const,
      workspacePath: ws,
      network: { mode: 'none' as const },
      limits: DEFAULT_LIMITS,
    };
    const c = await runner.confiner(ctx).confine(plan(join(data, 'home')));
    try {
      const bw = c.args.indexOf('/usr/bin/bwrap');
      expect(c.command).toBe('/bin/sh'); // rlimits prelude first
      expect(bw).toBeGreaterThan(0);
      const sep = c.args.indexOf('--', bw);
      expect(c.args.slice(sep + 1)).toEqual(['/usr/bin/codex', 'exec']);
      expect(c.args).toContain('--unshare-user');
      expect(c.env.HOME).toMatch(/sandboxes\/j1\/a1\/home$/);
      // Not the subscription login: the worker home is not bound back.
      expect(c.args.join(' ')).not.toContain(`--bind ${join(data, 'home')} `);
    } finally {
      await c.dispose?.();
    }
  });

  it('a subscription-login attempt keeps the worker HOME (bound read-write)', async () => {
    const { data, ws, runner } = await setup(true);
    const home = await realpath(join(data, 'home'));
    const c = await runner
      .confiner({
        jobId: 'j1',
        attemptId: 'a1',
        authMode: 'local-login',
        workspacePath: ws,
        network: { mode: 'none' },
        limits: DEFAULT_LIMITS,
      })
      .confine(plan(join(data, 'home')));
    try {
      expect(c.env.HOME).toBe(join(data, 'home'));
      expect(c.args.join(' ')).toContain(`--bind ${home} ${home}`);
    } finally {
      await c.dispose?.();
    }
  });

  it('runtime-sandbox runs without the view (the runtime’s own bubblewrap cannot nest)', async () => {
    const { data, ws, runner } = await setup(false);
    const rs = new RuntimeSandboxRunner(runner, 'linux', { usable: true, detail: 'test' });
    const conf = rs.confiner({
      jobId: 'j1',
      attemptId: 'a1',
      runtime: 'codex',
      workspacePath: ws,
      network: { mode: 'none' },
      limits: DEFAULT_LIMITS,
    });
    const c = await conf.confine(plan(join(data, 'home')));
    try {
      expect(c.args).not.toContain('/usr/bin/bwrap');
      expect(c.args.slice(-2)).toEqual(['/usr/bin/codex', 'exec']);
    } finally {
      await c.dispose?.();
    }
  });
});

describe('Sandbox card on Linux (status)', () => {
  const runners = async (findBwrap: () => Promise<string | null>) => {
    const root = await tempDir('lhs-');
    const r = await createSandboxRunners({
      settings: SandboxSettings.parse({ container: { engine: 'podman' } }),
      workspaceRoot: root,
      dataDir: root,
      platform: 'linux',
      identity: { verified: true, username: 'remyral-worker', uid: 990, problems: [] },
      namespaces: { usable: true, detail: 'test' },
      maxParallelJobs: () => 3,
      linuxIsolation: {
        findBwrap,
        trusted: () => Promise.resolve(null),
        start: fakeStart(() => ({ code: 0, stdout: okProbe, stderr: '' })),
      },
    });
    await r.linuxIsolation?.verify();
    // No container engine here: a real `podman info` (installed on some CI hosts) is slow and not what this tests.
    vi.spyOn(r.container, 'check').mockResolvedValue({
      ready: false,
      reasonCode: 'engine_unavailable',
      reason: 'no container engine (test)',
    });
    const status = await buildSandboxStatus({
      runners: r,
      runnersError: null,
      enabledRuntimes: ['codex'],
      unconfined: 'not_enabled',
      workspaceRoot: root,
      privilegedHelper: { available: true },
      freeBytes: 10 * 1024 ** 3,
    });
    return { r, status };
  };

  it('verified: host-restricted parallel in bwrap views; runtime-sandbox one at a time', async () => {
    const { r, status } = await runners(() => Promise.resolve('/usr/bin/bwrap'));
    expect(r.hostRestrictedConcurrency()).toBe(3);
    expect(status.checks.find((c) => c.id === 'host_isolation')).toMatchObject({ status: 'ok' });
    const host = status.profiles.find((p) => p.profile === 'host-restricted');
    expect(host).toMatchObject({
      ready: true,
      concurrency: 3,
      confinement: { filesystem: 'bwrap', egress: 'proxy_env_only', limits: 'rlimits' },
      checks: ['worker_identity', 'worker_user', 'host_isolation'],
    });
    expect(host?.concurrencyNote).toMatch(/one job family at a time/);
    expect(status.profiles.find((p) => p.profile === 'runtime-sandbox')).toMatchObject({
      concurrency: 1,
    });
  });

  it('bubblewrap missing: one at a time, the check says how to install it', async () => {
    const { r, status } = await runners(() => Promise.resolve(null));
    expect(r.hostRestrictedConcurrency()).toBe(1);
    const check = status.checks.find((c) => c.id === 'host_isolation');
    expect(check).toMatchObject({
      status: 'warning',
      code: 'host_isolation_bwrap_missing',
      fix: 'prepare_privileged',
    });
    expect(check?.detail).toContain('sudo apt install bubblewrap');
    const host = status.profiles.find((p) => p.profile === 'host-restricted');
    // Security fix: no confinement at all is reported as such (not "service account only"), with why and the fix.
    expect(host).toMatchObject({
      ready: true,
      concurrency: 1,
      confinement: { filesystem: 'none', egress: 'proxy_env_only' },
      code: 'host_unconfined_fallback',
      fix: 'prepare_privileged',
    });
    expect(host?.reason).toMatch(/device key/);
    expect(host?.remedy).toMatch(/install bubblewrap/);
    expect(host?.concurrencyNote).toMatch(/^one attempt at a time: bubblewrap is not installed/);
  });
});
