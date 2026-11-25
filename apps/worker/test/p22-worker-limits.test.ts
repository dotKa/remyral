import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectProcessNetworkPolicy, projectRefusalHint } from '../src/jobs/repo-egress.js';
import { SandboxSettings } from '../src/sandbox/config.js';
import {
  buildHostBwrapArgs,
  type HostBwrapSpec,
  LinuxIsolationController,
  type Lstat,
  NET_PROBE_SCRIPT,
  netnsRelayArgv,
  netProbeVerdict,
  type StartProcess,
  startEgressRelay,
  VIEW_EGRESS_SOCKET,
} from '../src/sandbox/host/linux-isolation.js';
import { HostRestrictedRunner, LOGIN_STORE_PROTECTED } from '../src/sandbox/host/runner.js';
import { WINDOWS_JOBRUN_PS1 } from '../src/sandbox/host/windows-jobrun.js';
import {
  type JobSandboxRequirements,
  type RunningAttempt,
  selectProfile,
  type WorkerSandboxCapabilities,
} from '../src/sandbox/policy.js';
import { DEFAULT_LIMITS, type SandboxContext } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/**
 * p22-worker-limits (docs/design/p22-worker-limits.md): the Linux private network namespace with an egress relay
 * (p19-linux-net-isolation), the login-store view of subscription-login attempts (p19-linux-local-login-parallel), the
 * Windows job runner's privilege-stripped token (p9-windows-worker-token-privileges, script content only — the run is
 * Windows-only) and the service / IDE refusal hint. The real bubblewrap / Windows runs are live checks.
 */

const files = (map: Record<string, 'dir' | 'file'>): Lstat => {
  return (p) =>
    Promise.resolve(
      map[p] === undefined ? null : { isDirectory: () => map[p] === 'dir', isFile: () => map[p] === 'file' },
    );
};

// Builds Linux paths (bubblewrap) with this host's path module: not meaningful on a Windows host. The relay is a Unix socket below a POSIX /tmp.
describePosix('bubblewrap view: private network and login-store home', () => {
  const spec: HostBwrapSpec = {
    workspace: '/srv/ws/jobs/j1/a1',
    sandboxDir: '/srv/ws/sandboxes/j1/a1',
    workspaceRoot: '/srv/ws',
    workerDataDir: '/var/lib/rw',
    homes: ['/home/w'],
    pidNamespace: false,
  };
  const fs = files({
    '/srv/ws': 'dir',
    '/var/lib/rw': 'dir',
    '/home/w': 'dir',
    '/home/w/.gitconfig': 'file',
    '/home/w/.local': 'dir',
    '/home/w/.claude': 'dir',
    '/home/w/.claude/settings.json': 'file',
    '/home/w/.codex': 'dir',
    '/home/w/.ssh': 'dir',
  });

  it('no private network by default (host network, as before)', async () => {
    const args = await buildHostBwrapArgs(spec, spec.workspace, fs);
    expect(args).not.toContain('--unshare-net');
  });

  it('--unshare-net with the relay socket bound below the view /tmp, after the private /tmp', async () => {
    const args = await buildHostBwrapArgs(
      {
        ...spec,
        privateNetwork: { relay: { hostSocket: '/tmp/rmy-nab/e.sock', viewSocket: VIEW_EGRESS_SOCKET } },
      },
      spec.workspace,
      fs,
    );
    expect(args).toContain('--unshare-net');
    const s = args.join(' ');
    expect(s).toContain(`--tmpfs /tmp --bind /tmp/rmy-nab/e.sock ${VIEW_EGRESS_SOCKET}`);
    // Without a relay (network mode none): no network at all.
    const none = await buildHostBwrapArgs({ ...spec, privateNetwork: {} }, spec.workspace, fs);
    expect(none).toContain('--unshare-net');
    expect(none.join(' ')).not.toContain('e.sock');
    await expect(
      buildHostBwrapArgs(
        { ...spec, privateNetwork: { relay: { hostSocket: '/tmp/x.sock', viewSocket: '/run/x.sock' } } },
        spec.workspace,
        fs,
      ),
    ).rejects.toThrow(/below the view/);
  });

  it('login-store home: tmpfs home, entries read-only, stores read-write, trusted config read-only, before the masks', async () => {
    const args = await buildHostBwrapArgs(
      {
        ...spec,
        sharedHome: '/home/w',
        loginStoreHome: {
          home: '/home/w',
          readOnly: ['/home/w/.gitconfig', '/home/w/.local', '/home/w/.ssh', '/etc/passwd'],
          stores: ['/home/w/.claude', '/home/w/.codex', '/home/w/.pi/agent'],
          protect: ['/home/w/.claude/settings.json', '/home/w/.claude/hooks'],
        },
      },
      spec.workspace,
      fs,
    );
    const s = args.join(' ');
    expect(s).toContain('--tmpfs /home/w --ro-bind /home/w/.gitconfig /home/w/.gitconfig');
    expect(s).toContain('--ro-bind /home/w/.local /home/w/.local');
    // Outside the home: never bound through this list.
    expect(s).not.toContain('/etc/passwd');
    expect(s).toContain('--bind /home/w/.claude /home/w/.claude --bind /home/w/.codex /home/w/.codex');
    expect(s).not.toContain('/home/w/.pi/agent'); // missing store
    expect(s).toContain('--ro-bind /home/w/.claude/settings.json /home/w/.claude/settings.json');
    // The worker HOME is not bound read-write any more.
    expect(s).not.toContain('--bind /home/w /home/w');
    // The data dir / workspace root masks come after the home (they cover anything below it).
    expect(args.indexOf('/home/w')).toBeLessThan(args.indexOf('/var/lib/rw'));
    // Protected paths (.ssh) are still hidden on top.
    expect(s).toContain('--tmpfs /home/w/.ssh --remount-ro /home/w/.ssh');
  });

  it('p22-harness-gaps: a login-store home inside the data dir (system install) is mounted after the masks', async () => {
    // linux-worker-1 2026-11-02: HOME /var/lib/rw/home below the data dir /var/lib/rw — the data-dir tmpfs used to erase the
    // view (`cp …/home/.claude.json` exit 125). Reproduced and checked with real bubblewrap (docs/design/p22-harness-gaps.md).
    const home = `${spec.workerDataDir}/home`;
    const args = await buildHostBwrapArgs(
      {
        ...spec,
        homes: [home],
        sharedHome: home,
        loginStoreHome: {
          home,
          readOnly: [`${home}/.gitconfig`, `${home}/.ssh`],
          stores: [`${home}/.claude`],
          protect: [`${home}/.claude/settings.json`],
        },
      },
      spec.workspace,
      (p) =>
        Promise.resolve(
          [
            spec.workerDataDir,
            spec.workspaceRoot,
            spec.workspace,
            spec.sandboxDir,
            home,
            `${home}/.claude`,
            `${home}/.ssh`,
          ].includes(p)
            ? ({ isDirectory: () => true, isFile: () => false } as never)
            : [`${home}/.gitconfig`, `${home}/.claude/settings.json`].includes(p)
              ? ({ isDirectory: () => false, isFile: () => true } as never)
              : null,
        ),
    );
    const s = args.join(' ');
    const at = (a: string, b: string): number => s.indexOf(`${a} ${b}`);
    expect(at('--tmpfs', spec.workerDataDir)).toBeGreaterThan(-1);
    expect(at('--tmpfs', home)).toBeGreaterThan(at('--tmpfs', spec.workerDataDir));
    expect(s).toContain(`--bind ${home}/.claude ${home}/.claude`);
    expect(s).toContain(`--ro-bind ${home}/.claude/settings.json ${home}/.claude/settings.json`);
    // Protected paths below the home view are hidden (it counts as bound back).
    expect(s).toContain(`--tmpfs ${home}/.ssh --remount-ro ${home}/.ssh`);
  });

  it('the in-view forwarder command and the network probe verdict', () => {
    expect(netnsRelayArgv('/usr/bin/node', VIEW_EGRESS_SOCKET, 4321, '/usr/bin/claude', ['-p', 'x'])).toEqual(
      [
        '/usr/bin/node',
        '-e',
        expect.stringContaining('net.connect(sock)') as unknown as string,
        '--',
        VIEW_EGRESS_SOCKET,
        '4321',
        '/usr/bin/claude',
        '-p',
        'x',
      ],
    );
    const ok = ['started', 'relay', 'host_loopback', 'own_loopback'].map((k) => `R ${k} ok`).join('\n');
    expect(netProbeVerdict(ok)).toBeNull();
    expect(netProbeVerdict(ok.replace('R host_loopback ok', 'R host_loopback leak'))).toBe(
      'host_loopback: leak',
    );
    expect(netProbeVerdict('R started ok')).toMatch(/relay: no answer/);
  });

  it('the host relay pipes a Unix-socket connection to the proxy port', async () => {
    const srv = createServer((c) => c.end('proxied'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const relay = await startEgressRelay(port);
    try {
      expect(relay.socket.length).toBeLessThanOrEqual(100);
      const got = await new Promise<string>((resolve, reject) => {
        let d = '';
        const c = connect(relay.socket);
        c.on('data', (b) => (d += b.toString()));
        c.on('end', () => {
          resolve(d);
        });
        c.on('error', reject);
      });
      expect(got).toBe('proxied');
    } finally {
      await relay.close();
      srv.close();
    }
    expect(await lstat(relay.socket).catch(() => null)).toBeNull();
  });
});

// Builds Linux paths (bubblewrap) with this host's path module: not meaningful on a Windows host. The relay is a Unix socket below a POSIX /tmp.
describePosix('the forwarder and the network probe as real processes (no namespace here)', () => {
  it('the probe reaches the stand-in proxy through relay + forwarder; its own loopback works; exit code passes on', async () => {
    const proxy = createServer((c) => c.end('relay-m1\n'));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as { port: number }).port;
    const relay = await startEgressRelay(proxyPort);
    // The forwarder listens on a free port of the (here: shared) loopback, as in the view on the proxy's port.
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
    const viewPort = (free.address() as { port: number }).port;
    await new Promise<void>((r) =>
      free.close(() => {
        r();
      }),
    );
    const { spawn } = await import('node:child_process');
    const run = (cmd: string[], env: Record<string, string>) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const ch = spawn(
          process.execPath,
          netnsRelayArgv(process.execPath, relay.socket, viewPort, cmd[0] ?? '', cmd.slice(1)).slice(1),
          {
            env: { ...process.env, ...env },
          },
        );
        let out = '';
        ch.stdout.on('data', (b: Buffer) => (out += b.toString()));
        ch.on('close', (code) => {
          resolve({ code, out });
        });
      });
    try {
      const r = await run([process.execPath, '-e', NET_PROBE_SCRIPT], {
        RELAY_PORT: String(viewPort),
        HOST_PORT: '1',
        MARKER: 'm1',
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain('R relay ok');
      expect(r.out).toContain('R own_loopback ok');
      expect(r.out).toContain('R host_loopback ok'); // nothing listens on port 1
      const failing = await run(['/bin/sh', '-c', 'exit 3'], {});
      expect(failing.code).toBe(3);
    } finally {
      await relay.close();
      proxy.close();
    }
  });
});

// Builds Linux paths (bubblewrap) with this host's path module: not meaningful on a Windows host. The relay is a Unix socket below a POSIX /tmp.
describePosix('controller: the network self-check (sandbox.linuxPrivateNetwork)', () => {
  const okFs = [
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
    .map((k) => `R ${k} ok`)
    .join('\n');
  const start =
    (net: string, calls: string[][]): StartProcess =>
    (_file, args, opts) => {
      calls.push([...args]);
      const script = args[args.length - 1] ?? '';
      if (script.includes('READY')) {
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
      const out = args.includes('--unshare-net') ? net : okFs;
      return { wait: () => Promise.resolve({ code: 0, stdout: out, stderr: '' }), kill: () => undefined };
    };
  const controller = async (net: string, calls: string[][], privateNetwork?: 'auto' | 'off') => {
    const data = await tempDir('p22n-');
    await mkdir(join(data, 'ws'), { recursive: true });
    return new LinuxIsolationController({
      mode: 'auto',
      workspaceRoot: join(data, 'ws'),
      dataDir: data,
      readableInDataDir: [],
      findBwrap: () => Promise.resolve('/usr/bin/bwrap'),
      trusted: () => Promise.resolve(null),
      start: start(net, calls),
      ...(privateNetwork === undefined ? {} : { privateNetwork }),
    });
  };
  const netOk = ['started', 'relay', 'host_loopback', 'own_loopback'].map((k) => `R ${k} ok`).join('\n');

  it('auto + passing probe: private network on; the probe runs behind the forwarder with --unshare-net', async () => {
    const calls: string[][] = [];
    const c = await controller(netOk, calls, 'auto');
    const s = await c.verify();
    expect(s).toMatchObject({ active: true, privateNetwork: true });
    expect(s.detail).toMatch(/network: its own namespace/);
    expect(c.active()).toMatchObject({ privateNetwork: true, node: process.execPath });
    const net = calls.find((a) => a.includes('--unshare-net'));
    expect(net).toBeDefined();
    expect(net?.join(' ')).toContain(VIEW_EGRESS_SOCKET);
    expect(net?.at(-1)).toBe(NET_PROBE_SCRIPT);
  });

  it('auto + a leak: the view stays active on the host network, the detail says why', async () => {
    const calls: string[][] = [];
    const c = await controller(netOk.replace('host_loopback ok', 'host_loopback leak'), calls, 'auto');
    const s = await c.verify();
    expect(s).toMatchObject({ active: true, privateNetwork: false });
    expect(s.detail).toMatch(/shared with the host .*host_loopback: leak/);
  });

  it('off (the default of the setting): no network probe', async () => {
    const calls: string[][] = [];
    const c = await controller(netOk, calls);
    expect(await c.verify()).toMatchObject({ active: true });
    expect(c.active()?.privateNetwork).toBe(false);
    expect(calls.some((a) => a.includes('--unshare-net'))).toBe(false);
    expect(SandboxSettings.parse({}).linuxPrivateNetwork).toBe('off');
    expect(SandboxSettings.parse({}).linuxLoginStoreView).toBe(false);
  });
});

// Builds Linux paths (bubblewrap) with this host's path module: not meaningful on a Windows host. The relay is a Unix socket below a POSIX /tmp.
describePosix('host runner: private network and login-store view', () => {
  const setup = async (o: { privateNetwork?: boolean; loginStoreView?: boolean } = {}) => {
    const data = await realpath(await tempDir('p22r-'));
    const root = join(data, 'workspaces');
    const ws = join(root, 'jobs', 'j1', 'a1');
    const home = join(data, 'home');
    await mkdir(ws, { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.npm'), { recursive: true });
    await writeFile(join(home, '.gitconfig'), '[user]\n');
    await writeFile(join(home, '.claude.json'), '{"oauthAccount":{}}\n');
    const linuxIsolation = new LinuxIsolationController({
      mode: 'auto',
      workspaceRoot: '/unused',
      dataDir: '/unused',
      readableInDataDir: [],
      findBwrap: () => Promise.resolve('/usr/bin/bwrap'),
    });
    Object.defineProperty(linuxIsolation, 'active', {
      value: () => ({
        bwrap: '/usr/bin/bwrap',
        pidNamespace: false,
        privateNetwork: o.privateNetwork === true,
        node: process.execPath,
      }),
    });
    const runner = new HostRestrictedRunner({
      identity: { verified: true, username: 'remyral-worker', uid: 990, problems: [] },
      workspaceRoot: root,
      workerDataDir: data,
      platform: 'linux',
      keepHome: true,
      linuxIsolation,
      linuxLoginStoreView: o.loginStoreView === true,
      listenRuntimes: ['opencode'],
      proxyLookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });
    return { data, ws, home, runner };
  };
  const plan = (home: string) => ({
    command: '/usr/bin/claude',
    args: ['-p'],
    cwd: '/',
    env: { HOME: home, PATH: '/usr/bin' },
    secretNames: [],
  });
  const ctx = (ws: string, over: Partial<SandboxContext> = {}): SandboxContext => ({
    jobId: 'j1',
    attemptId: 'a1',
    authMode: 'secret-ref',
    workspacePath: ws,
    network: { mode: 'allowlist', targets: [{ host: 'api.anthropic.com', port: 443 }] },
    limits: DEFAULT_LIMITS,
    ...over,
  });

  it('an agent attempt: own network namespace, the proxy reached through the relay at the same URL', async () => {
    const { ws, home, runner } = await setup({ privateNetwork: true });
    const c = await runner.confiner(ctx(ws)).confine(plan(home));
    try {
      expect(c.args).toContain('--unshare-net');
      const sep = c.args.indexOf('--', c.args.indexOf('/usr/bin/bwrap'));
      const inner = c.args.slice(sep + 1);
      const port = new URL(c.env.HTTPS_PROXY ?? '').port;
      expect(inner.slice(0, 2)).toEqual([process.execPath, '-e']);
      expect(inner.slice(3)).toEqual(['--', VIEW_EGRESS_SOCKET, port, '/usr/bin/claude', '-p']);
      // The relay's host socket is bound into the view; the node binary is visible read-only.
      const bind = c.args.indexOf(VIEW_EGRESS_SOCKET);
      const hostSocket = c.args[bind - 1] ?? '';
      expect((await lstat(hostSocket)).isSocket()).toBe(true);
      expect(c.args.join(' ')).toContain(`--ro-bind ${await realpath(process.execPath)}`);
      await c.dispose?.();
      expect(await lstat(hostSocket).catch(() => null)).toBeNull();
    } catch (e) {
      await c.dispose?.();
      throw e;
    }
  });

  it('services / IDE (listen), preview jobs (hostNetwork) and OpenCode keep the host network', async () => {
    const { ws, home, runner } = await setup({ privateNetwork: true });
    for (const over of [
      { listen: true },
      { hostNetwork: true },
      { loopbackPorts: [4000] },
      { runtime: 'opencode' as const },
    ]) {
      const c = await runner.confiner(ctx(ws, over)).confine(plan(home));
      try {
        expect(c.args, JSON.stringify(over)).not.toContain('--unshare-net');
        expect(c.args).not.toContain(VIEW_EGRESS_SOCKET);
      } finally {
        await c.dispose?.();
      }
    }
  });

  it('network mode none: a private namespace without any relay', async () => {
    const { ws, home, runner } = await setup({ privateNetwork: true });
    const c = await runner.confiner(ctx(ws, { network: { mode: 'none' } })).confine(plan(home));
    try {
      expect(c.args).toContain('--unshare-net');
      expect(c.args).not.toContain(VIEW_EGRESS_SOCKET);
      expect(c.args.at(-2)).toBe('/usr/bin/claude');
    } finally {
      await c.dispose?.();
    }
  });

  it('login-store view (opt-in): private home, stores writable, trusted config created and read-only, ~/.claude.json copied', async () => {
    const { ws, home, runner } = await setup({ loginStoreView: true });
    expect(runner.check().loginStoreView).toBe(true);
    const c = await runner.confiner(ctx(ws, { authMode: 'local-login' })).confine(plan(home));
    try {
      const s = c.args.join(' ');
      expect(c.env.HOME).toBe(home);
      expect(s).toContain(`--tmpfs ${home} `);
      expect(s).toContain(`--ro-bind ${home}/.gitconfig ${home}/.gitconfig`);
      expect(s).not.toContain(`${home}/.npm`); // a cache starts fresh
      expect(s).toContain(`--bind ${home}/.claude ${home}/.claude`);
      expect(s).not.toContain(`--bind ${home} ${home}`);
      for (const p of ['settings.json', 'CLAUDE.md', 'hooks', 'commands']) {
        expect(s).toContain(`--ro-bind ${home}/.claude/${p} ${home}/.claude/${p}`);
      }
      // Missing trusted config was created neutral (an attempt cannot plant it for the next one).
      expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}\n');
      expect((await lstat(join(home, '.claude', 'hooks'))).isDirectory()).toBe(true);
      // ~/.claude.json: a private copy seeded by the sh prelude.
      const sep = c.args.indexOf('--', c.args.indexOf('/usr/bin/bwrap'));
      const inner = c.args.slice(sep + 1);
      expect(inner[0]).toBe('/bin/sh');
      expect(inner[4]).toMatch(/login-seed\/claude\.json$/);
      expect(await readFile(inner[4] ?? '', 'utf8')).toContain('oauthAccount');
      expect(inner.slice(5)).toEqual([`${home}/.claude.json`, '/usr/bin/claude', '-p']);
    } finally {
      await c.dispose?.();
    }
    expect(LOGIN_STORE_PROTECTED.map((p) => p.store)).toEqual(['.claude', '.codex', '.pi/agent']);
  });

  it('login-store view off (default): the worker HOME stays bound read-write', async () => {
    const { ws, home, runner } = await setup();
    expect(runner.check().loginStoreView).toBe(false);
    const c = await runner.confiner(ctx(ws, { authMode: 'local-login' })).confine(plan(home));
    try {
      expect(c.args.join(' ')).toContain(`--bind ${home} ${home}`);
    } finally {
      await c.dispose?.();
    }
  });
});

describe('selection: local-login across job families with the login-store view', () => {
  const attempt = (over: Partial<RunningAttempt> = {}): RunningAttempt => ({
    family: '22222222-2222-4222-8222-222222222222',
    projectId: 'p',
    profile: 'host-restricted',
    runtime: 'claude-code',
    authMode: 'local-login',
    ...over,
  });
  const caps = (loginStoreView: boolean): WorkerSandboxCapabilities => ({
    platform: 'linux',
    container: { ready: true },
    hostRestricted: {
      ready: true,
      filesystemConfinement: 'bwrap',
      egressEnforced: false,
      concurrency: 3,
      loginStoreView,
    },
    runtimeSandboxes: [],
    runningAttempts: 1,
    attempts: [attempt()],
  });
  const job: JobSandboxRequirements = {
    profile: 'host-restricted',
    runtime: 'claude-code',
    sourceTrust: 'trusted',
    needsEgress: true,
    hostExecutionOptIn: true,
    authMode: 'local-login',
    family: '11111111-1111-4111-8111-111111111111',
    projectId: 'p',
  };
  const policy = { allowedProfiles: ['host-restricted'] as const };

  it('off: one family at a time; on: beside another family, with a note', () => {
    const off = selectProfile(job, caps(false), policy);
    expect(off.ok).toBe(false);
    const on = selectProfile(job, caps(true), policy);
    expect(on).toMatchObject({ ok: true, profile: 'host-restricted' });
    expect(on.ok && on.notes.join()).toMatch(/only the login stores are writable/);
  });
});

describe('Windows job runner: privilege-stripped token (script content; the run is a live check)', () => {
  const ps1 = WINDOWS_JOBRUN_PS1;

  it('creates the worker-account child with CreateRestrictedToken(DISABLE_MAX_PRIVILEGE) via CreateProcessAsUser', () => {
    expect(ps1).toContain('static extern bool CreateRestrictedToken(IntPtr existing, uint flags');
    expect(ps1).toContain('const uint DISABLE_MAX_PRIVILEGE = 0x1;');
    expect(ps1).toMatch(
      /CreateRestrictedToken\(own, DISABLE_MAX_PRIVILEGE, 0, IntPtr\.Zero, 0, IntPtr\.Zero, 0, IntPtr\.Zero, out restricted\)/,
    );
    // Every start goes through a token: the plain CreateProcess path (the service token itself) is gone.
    expect(ps1).not.toMatch(/CreateProcessW\(/);
    expect(ps1).toMatch(/public static int Run\([^)]*\)\s*\{\s*IntPtr token = StrippedOwnToken\(\);/);
    // The per-job account path still uses its own logon token on its own window station.
    expect(ps1).toContain('RunWith(token, true, commandLine');
    expect(ps1).toContain('if (otherAccount) si.StartupInfo.lpDesktop = "";');
  });

  it('the self-test fails when the stripped token still holds a privilege besides SeChangeNotifyPrivilege', () => {
    expect(ps1).toContain("$RemyralJobRunVersion = '3'");
    expect(ps1).toContain('[RemyralJobRun]::ExtraPrivilegesOfStrippedToken()');
    expect(ps1).toContain('if ($extra -ne 0)');
    expect(ps1).toContain('GetTokenInformation(token, TOKEN_INFORMATION_PRIVILEGES');
    expect(/[^\t\n\r\x20-\x7e]/.test(ps1)).toBe(false);
  });
});

describe('service / IDE network policy hint (both project kinds)', () => {
  it('names the Network access screen and the Workspace tab', () => {
    const p = projectProcessNetworkPolicy({ mode: 'allowlist', hosts: ['registry.npmjs.org'] }, [
      'api.anthropic.com',
    ]);
    expect(p).toMatchObject({ mode: 'allowlist' });
    const hint = p.mode === 'none' ? '' : (p.refusalHint ?? '');
    expect(hint).toContain('Ağ erişimi');
    expect(hint).toContain('Workspace tab');
    expect(projectRefusalHint(null)).toContain('did not send');
  });
});
