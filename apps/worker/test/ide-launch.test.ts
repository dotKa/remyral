import { execFile } from 'node:child_process';
import { realpath, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_SERVER_AUTH_PROBE, CODE_SERVER_DROP_ENV, ideLaunchPlan } from '../src/ide/launch.js';
import { buildSeatbeltProfile } from '../src/sandbox/host/seatbelt.js';
import { SandboxRequestError } from '../src/sandbox/errors.js';
import { tempDir } from './helpers.js';

/**
 * p19-ide W2b: the launch contract per pinned server (launch.ts) and the Seatbelt additions the IDE needs on macOS
 * (the bridge port, Unix sockets under the run dir, the mirror read-only). The last block applies real profiles with
 * `sandbox-exec` (macOS only; skipped elsewhere).
 */

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
const dirs = {
  run: '/r/run',
  home: '/r/run/home',
  ext: '/r/run/extensions',
  userData: '/r/run/user-data',
  serverData: '/r/run/server-data',
};
const base = '/w/0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';

describe('IDE launch plans (p19-ide W2b)', () => {
  it('openvscode-server: token file, base path, token cookie in the browser', () => {
    const p = ideLaunchPlan({
      install: {
        kind: 'openvscode-server',
        version: '1.109.5',
        dir: '/s',
        binary: '/s/bin/openvscode-server',
      },
      platform: 'linux',
      port: 4000,
      token: TOKEN,
      basePath: base,
      dirs,
      folder: '/r/jobs/ide-x/files',
    });
    expect(p.command).toBe('/s/bin/openvscode-server');
    expect(p.args).toContain('--connection-token-file');
    expect(p.args[p.args.indexOf('--server-base-path') + 1]).toBe(base);
    expect(p.args.join(' ')).not.toContain(TOKEN);
    expect(p.files).toEqual([{ path: join('/r/run', 'connection-token'), content: TOKEN }]);
    expect(p.upstream).toEqual({
      kind: 'openvscode-server',
      cookie: `vscode-tkn=${TOKEN}`,
      stripBase: false,
      browserTokenCookie: true,
    });
    expect(p.readiness).toMatchObject({ readyPath: `${base}/version`, anonymousStatus: [401, 403] });
    expect(p.readiness.authedPath).toBeUndefined();
  });

  it('code-server: package dir first, secret only in the 0600 config, flags, env, readiness', () => {
    const mac = ideLaunchPlan({
      install: { kind: 'code-server', version: '4.143.1', dir: '/s', binary: '/s/lib/node' },
      platform: 'darwin',
      port: 4001,
      token: TOKEN,
      basePath: base,
      dirs,
      folder: '/r/jobs/ide-x/checkout',
    });
    expect(mac.command).toBe('/s/lib/node');
    expect(mac.args[0]).toBe('/s');
    expect(mac.args.join(' ')).not.toContain(TOKEN);
    expect(mac.args[mac.args.indexOf('--bind-addr') + 1]).toBe('127.0.0.1:4001');
    expect(mac.args[mac.args.indexOf('--auth') + 1]).toBe('password');
    expect(mac.args[mac.args.indexOf('--session-socket') + 1]).toBe(join('/r/run', 'cs.sock'));
    expect(mac.args.slice(-2)).toEqual(['--', '/r/jobs/ide-x/checkout']);
    for (const flag of [
      '--disable-proxy',
      '--disable-update-check',
      '--disable-telemetry',
      '--disable-getting-started-override',
      '--ignore-last-opened',
    ])
      expect(mac.args).toContain(flag);
    expect(mac.files).toHaveLength(1);
    expect(mac.files[0]?.path).toBe(join('/r/run', 'code-server.yaml'));
    expect(mac.files[0]?.content).toContain(`hashed-password: "${TOKEN}"`);
    expect(mac.files[0]?.content).not.toContain('$argon');
    expect(mac.env).toEqual({ EXTENSIONS_GALLERY: '{}' });
    for (const v of ['PORT', 'CODE_SERVER_HOST', 'PASSWORD', 'HASHED_PASSWORD', 'GITHUB_TOKEN'])
      expect(CODE_SERVER_DROP_ENV).toContain(v);
    expect(mac.upstream).toEqual({
      kind: 'code-server',
      cookie: `code-server-session=${TOKEN}`,
      stripBase: true,
      browserTokenCookie: false,
    });
    expect(mac.readiness).toEqual({
      readyPath: '/healthz',
      anonymousPath: CODE_SERVER_AUTH_PROBE,
      anonymousStatus: [401],
      authedPath: CODE_SERVER_AUTH_PROBE,
      cookie: `code-server-session=${TOKEN}`,
    });
    // Windows: the named pipe default of code-server instead of a socket path.
    const win = ideLaunchPlan({
      install: { kind: 'code-server', version: '4.143.1', dir: 'C:\\s', binary: 'C:\\s\\lib\\node.exe' },
      platform: 'win32',
      port: 4002,
      token: TOKEN,
      basePath: base,
      dirs,
      folder: 'C:\\r\\jobs\\ide-x\\files',
    });
    expect(win.command).toBe('C:\\s\\lib\\node.exe');
    expect(win.args).not.toContain('--session-socket');
  });

  it('refuses a malformed secret or port', () => {
    const input = {
      install: { kind: 'code-server' as const, version: '4.143.1', dir: '/s', binary: '/s/lib/node' },
      platform: 'darwin' as const,
      port: 4001,
      token: TOKEN,
      basePath: base,
      dirs,
      folder: '/f',
    };
    expect(() => ideLaunchPlan({ ...input, token: 'a"\nauth: none' })).toThrow(RangeError);
    expect(() => ideLaunchPlan({ ...input, port: 0 })).toThrow(RangeError);
  });
});

describe('Seatbelt profile for the IDE (p19-ide W2b)', () => {
  const spec = {
    workspace: '/root/jobs/ide-x/files',
    sandboxDir: '/root/sandboxes/ide-x/run',
    workspaceRoot: '/root',
    workerDataDir: '/data',
    homes: [],
  };

  it('adds the bridge port, one socket rule per directory, and the mirror as a read carve-out', () => {
    const sb = buildSeatbeltProfile({
      ...spec,
      allowListen: true,
      proxyPort: 4100,
      loopbackPorts: [4200],
      unixSocketDirs: ['/root/sandboxes/ide-x/run'],
      readOnlyDirs: ['/root/mirrors/abc'],
    });
    expect(sb.profile).toContain('(allow network-outbound (remote ip "localhost:4200"))');
    const key = (v: string) => Object.entries(sb.params).find(([, p]) => p === v)?.[0] ?? 'none';
    const socketKey = Object.entries(sb.params).find(
      ([k, v]) =>
        v === '/root/sandboxes/ide-x/run' &&
        sb.profile.includes(`(local unix-socket (subpath (param "${k}")))`),
    );
    expect(socketKey).toBeDefined();
    expect(sb.profile).toContain(
      `(allow network-outbound (remote unix-socket (subpath (param "${socketKey?.[0] ?? ''}"))))`,
    );
    expect(sb.profile).toContain(`(require-not (subpath (param "${key('/root/mirrors/abc')}")))`);
    // Never writable: the only write allowances are the workspace and the sandbox dir.
    expect(sb.profile).not.toMatch(/allow file-write\*[^\n]*mirrors/);
    expect(() => buildSeatbeltProfile({ ...spec, loopbackPorts: [70000] })).toThrow(SandboxRequestError);
    // Without the IDE fields nothing changes for jobs.
    expect(buildSeatbeltProfile(spec).profile).not.toContain('unix-socket');
  });
});

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

function sandboxed(profile: string, params: Record<string, string>, script: string, arg: string) {
  return new Promise<string>((resolve) => {
    const argv = ['-p', profile];
    for (const [k, v] of Object.entries(params)) argv.push('-D', `${k}=${v}`);
    execFile(
      '/usr/bin/sandbox-exec',
      [...argv, process.execPath, '-e', script, arg],
      { timeout: 20_000 },
      (err, stdout, stderr) => {
        resolve(err === null ? stdout.trim() : `error ${stderr.trim() || err.message}`);
      },
    );
  });
}

describeMac('Seatbelt allowances applied by sandbox-exec (macOS only)', () => {
  const socketScript = `
    const net = require('node:net');
    const p = process.argv[1];
    const s = net.createServer((c) => c.end('pong')).listen(p, () => {
      const c = net.connect(p, () => undefined);
      c.on('data', (d) => { console.log('ok ' + d); c.destroy(); s.close(); });
      c.on('error', (e) => { console.log('fail ' + e.code); s.close(); });
    });
    s.on('error', (e) => console.log('fail ' + e.code));`;

  it('allows Unix sockets under the listed directory only, and the listed loopback port', async () => {
    const dir = await realpath(await tempDir('rw-sbx-'));
    const outside = await realpath(await tempDir('rw-sbx-out-'));
    try {
      const sb = buildSeatbeltProfile({
        workspace: dir,
        sandboxDir: dir,
        workspaceRoot: join(dir, 'root'),
        workerDataDir: join(dir, 'data'),
        homes: [],
        unixSocketDirs: [dir],
      });
      expect(await sandboxed(sb.profile, sb.params, socketScript, join(dir, 's.sock'))).toBe('ok pong');
      expect(await sandboxed(sb.profile, sb.params, socketScript, join(outside, 's.sock'))).toMatch(/^fail /);

      const tcp = createNetServer((c) => c.end('pong'));
      await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
      const port = (tcp.address() as { port: number }).port;
      const tcpScript = `
        const c = require('node:net').connect(Number(process.argv[1]), '127.0.0.1');
        c.on('data', (d) => { console.log('ok ' + d); c.destroy(); });
        c.on('error', (e) => console.log('fail ' + e.code));`;
      try {
        const allowed = buildSeatbeltProfile({
          workspace: dir,
          sandboxDir: dir,
          workspaceRoot: join(dir, 'root'),
          workerDataDir: join(dir, 'data'),
          homes: [],
          loopbackPorts: [port],
        });
        expect(await sandboxed(allowed.profile, allowed.params, tcpScript, String(port))).toBe('ok pong');
        const denied = buildSeatbeltProfile({
          workspace: dir,
          sandboxDir: dir,
          workspaceRoot: join(dir, 'root'),
          workerDataDir: join(dir, 'data'),
          homes: [],
        });
        expect(await sandboxed(denied.profile, denied.params, tcpScript, String(port))).toMatch(/^fail /);
      } finally {
        await new Promise((r) => tcp.close(r));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 60_000);
});
