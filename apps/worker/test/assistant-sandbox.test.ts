import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnOwnedProcess } from '@remyral/agent-adapters';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_LOOPBACK_PORTS_ENV,
  AssistantSandbox,
  assistantEgress,
  type AssistantSandboxOptions,
  buildAssistantBwrapArgs,
  buildAssistantSeatbeltProfile,
} from '../src/assistant/sandbox.js';
import { SandboxRequestError } from '../src/sandbox/errors.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function options(over: Partial<AssistantSandboxOptions> = {}): AssistantSandboxOptions {
  return {
    mode: 'auto',
    platform: 'darwin',
    workerDataDir: '/var/lib/remyral',
    workspaceRoot: '/srv/remyral/ws',
    readableInDataDir: ['/var/lib/remyral/runtimes'],
    protectedHomes: [],
    workerHome: '/home/remyral',
    allowKeychain: false,
    egressAllow: ['api.anthropic.com'],
    limits: DEFAULT_LIMITS,
    seatbeltAvailable: () => true,
    ...over,
  };
}

const spec = {
  session: '/var/lib/remyral/assistant/s-abc',
  workerDataDir: '/var/lib/remyral',
  readableInDataDir: ['/var/lib/remyral/runtimes'],
  workspaceRoot: '/srv/remyral/ws',
  homes: ['/home/remyral'],
  allowKeychain: false,
  writableDirs: [],
  writablePrefixes: [],
  denyRead: ['/home/remyral/.codex'],
};

describe('assistant sandbox profile: report and readiness', () => {
  it('reports what each OS enforces', () => {
    expect(new AssistantSandbox(options()).report()).toEqual({
      mode: 'auto',
      filesystem: 'seatbelt',
      limits: 'rlimits',
      egress: 'enforced',
    });
    expect(new AssistantSandbox(options({ seatbeltAvailable: () => false })).report()).toMatchObject({
      filesystem: 'none',
      egress: 'proxy-env',
    });
    expect(
      new AssistantSandbox(
        options({ platform: 'linux', bwrap: () => ({ path: '/usr/bin/bwrap', usable: true }) }),
      ).report(),
    ).toEqual({ mode: 'auto', filesystem: 'bwrap', limits: 'rlimits', egress: 'proxy-env' });
    expect(
      new AssistantSandbox(
        options({ platform: 'linux', bwrap: () => ({ path: null, usable: null }) }),
      ).report(),
    ).toMatchObject({ filesystem: 'none', detail: 'bubblewrap (bwrap) is not installed' });
    expect(
      new AssistantSandbox(
        options({
          platform: 'win32',
          windowsJobRunner: () => ({ verified: true }),
        }),
      ).report(),
    ).toMatchObject({ filesystem: 'none', limits: 'job-object', egress: 'proxy-env' });
    expect(new AssistantSandbox(options({ mode: 'off' })).report()).toMatchObject({
      mode: 'off',
      filesystem: 'none',
      egress: 'none',
    });
  });

  it('refuses sessions when the profile is required but no filesystem confinement exists', () => {
    const sb = new AssistantSandbox(
      options({
        mode: 'required',
        platform: 'linux',
        bwrap: () => ({ path: '/usr/bin/bwrap', usable: false }),
      }),
    );
    const r = sb.ready();
    expect(r.ok).toBe(false);
    expect(() =>
      sb.forSession({ runtime: 'claude-code', authMode: 'secret-ref', sessionDir: '/tmp/x' }),
    ).toThrow(SandboxRequestError);
    // auto runs with what exists; off has no confiner at all.
    expect(new AssistantSandbox(options({ platform: 'linux' })).ready().ok).toBe(true);
    expect(
      new AssistantSandbox(options({ mode: 'off' })).forSession({
        runtime: 'codex',
        authMode: 'local-login',
        sessionDir: '/tmp/x',
      }).confiner,
    ).toBeUndefined();
  });
});

describe('assistant egress allowlist', () => {
  it('adds the subscription login hosts each runtime needs (OAuth refresh) to the model hosts', () => {
    const base = ['api.anthropic.com', 'api.openai.com'];
    expect(assistantEgress('claude-code', 'local-login', base)).toEqual([
      'api.anthropic.com',
      'api.openai.com',
      'platform.claude.com',
    ]);
    expect(assistantEgress('claude-code', 'secret-ref', [])).toEqual(['api.anthropic.com']);
    expect(assistantEgress('codex', 'local-login', [])).toEqual([
      'api.openai.com',
      'chatgpt.com',
      'auth.openai.com',
    ]);
    expect(assistantEgress('pi', 'local-login', ['api.example.com'])).toEqual(['api.example.com']);
  });

  it('Windows without a verified job runner still starts the runtime (proxy environment only)', async () => {
    const root = await realpath(await tempDir('asb-win-'));
    const session = join(root, 'data', 'assistant', 's-1');
    await mkdir(join(session, 'work'), { recursive: true });
    const sb = new AssistantSandbox(
      options({
        platform: 'win32',
        workerDataDir: join(root, 'data'),
        workspaceRoot: join(root, 'ws'),
        windowsJobRunner: () => undefined,
        proxyLookup: () => Promise.resolve([]),
      }),
    );
    expect(sb.ready().ok).toBe(true);
    const { confiner } = sb.forSession({
      runtime: 'claude-code',
      authMode: 'local-login',
      sessionDir: session,
    });
    const c = await confiner?.confine({
      command: 'claude.exe',
      args: ['--print'],
      cwd: join(session, 'work'),
      env: { USERPROFILE: 'C:\\Users\\w' },
      secretNames: [],
    });
    try {
      expect(c?.command).toBe('claude.exe');
      expect(c?.args).toEqual(['--print']);
      expect(c?.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // A local login keeps the user's profile (Claude Code's credentials live there on Windows).
      expect(c?.env.USERPROFILE).toBe('C:\\Users\\w');
    } finally {
      await c?.dispose?.();
    }
  });
});

// Builds macOS Seatbelt paths with this host's path module: not meaningful on a Windows host.
describePosix('assistant Seatbelt profile', () => {
  it('writes only to the session, hides the data dir, the workspace root and other logins, no network', () => {
    const sb = buildAssistantSeatbeltProfile({ ...spec, proxyPort: 41234 });
    // No path is interpolated into the profile text: every path is a -D parameter.
    expect(sb.profile).not.toContain('/var/lib/remyral');
    expect(sb.profile).not.toContain('/srv/remyral');
    expect(sb.profile).toContain('(deny file-write*)');
    expect(sb.profile).toContain('(deny network*)');
    expect(sb.profile).toContain('(allow network-outbound (remote ip "localhost:41234"))');
    expect(sb.profile).not.toContain('network-bind');
    const values = Object.values(sb.params);
    expect(values).toContain('/var/lib/remyral/assistant/s-abc');
    expect(values).toContain('/srv/remyral/ws');
    expect(values).toContain('/home/remyral/.ssh');
    expect(values).toContain('/home/remyral/.codex');
    expect(values).toContain('/home/remyral/Library/Keychains');
    expect(sb.argv.slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
  });

  it('lets OpenCode serve on loopback and reach its tool endpoint; keeps a local login writable', () => {
    const sb = buildAssistantSeatbeltProfile({
      ...spec,
      allowKeychain: true,
      writableDirs: ['/home/remyral/.claude'],
      writablePrefixes: ['/home/remyral/.claude.json'],
      allowListen: true,
      loopbackPorts: [5555],
      proxyPort: 41234,
    });
    expect(sb.profile).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(sb.profile).toContain('(allow network-outbound (remote ip "localhost:5555"))');
    expect(sb.profile).toMatch(/\(prefix \(param "P\d+"\)\)/);
    expect(Object.values(sb.params)).not.toContain('/home/remyral/Library/Keychains');
    expect(() => buildAssistantSeatbeltProfile({ ...spec, loopbackPorts: [70000] })).toThrow(
      SandboxRequestError,
    );
    expect(() => buildAssistantSeatbeltProfile({ ...spec, session: 'relative/path' })).toThrow(
      SandboxRequestError,
    );
  });
});

describe('assistant bubblewrap view (Linux)', () => {
  it('masks the workspace root, the data dir and protected paths; binds back installs and the session', async () => {
    const root = await tempDir('asb-bwrap-');
    const data = join(root, 'data');
    const ws = join(root, 'ws');
    const home = join(root, 'home');
    for (const d of [
      join(data, 'runtimes'),
      join(data, 'assistant', 's-1'),
      ws,
      join(home, '.ssh'),
      join(home, '.codex'),
    ]) {
      await mkdir(d, { recursive: true });
    }
    await writeFile(join(home, '.netrc'), 'machine x login y password z');
    const args = await buildAssistantBwrapArgs(
      {
        ...spec,
        session: join(data, 'assistant', 's-1'),
        workerDataDir: data,
        readableInDataDir: [join(data, 'runtimes')],
        workspaceRoot: ws,
        homes: [home],
        denyRead: [join(home, '.codex')],
      },
      join(data, 'assistant', 's-1', 'work'),
    );
    const joined = args.join(' ');
    expect(args.slice(0, 5)).toEqual(['--die-with-parent', '--unshare-ipc', '--ro-bind', '/', '/']);
    expect(joined).toContain(`--tmpfs ${ws}`);
    expect(joined).toContain(`--tmpfs ${data}`);
    expect(joined).toContain(`--ro-bind ${join(data, 'runtimes')} ${join(data, 'runtimes')}`);
    expect(joined).toContain(`--tmpfs ${join(home, '.ssh')}`);
    expect(joined).toContain(`--tmpfs ${join(home, '.codex')}`);
    expect(joined).toContain(`--ro-bind /dev/null ${join(home, '.netrc')}`);
    // The session is bound back after the masks (later mounts win) and is the only writable bind.
    expect(args.lastIndexOf('--bind')).toBeGreaterThan(args.indexOf(data));
    expect(args.filter((a) => a === '--bind')).toHaveLength(1);
    expect(args.at(-2)).toBe('--chdir');
  });
});

const seatbelt =
  process.platform === 'darwin' &&
  (() => {
    try {
      execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
      return true;
    } catch {
      return false;
    }
  })();

describe.skipIf(!seatbelt)('assistant sandbox on this Mac (real sandbox-exec)', { timeout: 60_000 }, () => {
  it('confines a process the way the profile says', async () => {
    const root = await realpath(await tempDir('asb-real-'));
    const data = join(root, 'data');
    const ws = join(root, 'ws');
    const home = join(root, 'home');
    const session = join(data, 'assistant', 's-1');
    for (const d of [
      join(data, 'runtimes'),
      join(session, 'work'),
      ws,
      join(home, '.ssh'),
      join(home, '.codex'),
    ]) {
      await mkdir(d, { recursive: true });
    }
    await writeFile(join(data, 'device.key'), 'DEVICE-SECRET');
    await writeFile(join(data, 'runtimes', 'cli.txt'), 'RUNTIME-OK');
    await writeFile(join(ws, 'repo.txt'), 'REPO-SECRET');
    await writeFile(join(home, '.ssh', 'id_ed25519'), 'SSH-SECRET');
    await writeFile(join(home, '.codex', 'auth.json'), 'CODEX-SECRET');
    const sb = new AssistantSandbox({
      mode: 'required',
      workerDataDir: data,
      workspaceRoot: ws,
      readableInDataDir: [join(data, 'runtimes')],
      protectedHomes: [],
      workerHome: home,
      allowKeychain: false,
      egressAllow: ['api.anthropic.com'],
      limits: DEFAULT_LIMITS,
      // No DNS, no upstream: the proxy is only started, never used here.
      proxyLookup: () => Promise.resolve([]),
    });
    const { confiner } = sb.forSession({
      runtime: 'claude-code',
      authMode: 'secret-ref',
      sessionDir: session,
    });
    const script = [
      `cat ${join(data, 'device.key')} 2>/dev/null || echo DENIED-DATA`,
      `cat ${join(data, 'runtimes', 'cli.txt')} 2>/dev/null || echo DENIED-RUNTIME`,
      `cat ${join(ws, 'repo.txt')} 2>/dev/null || echo DENIED-WS`,
      `cat ${join(home, '.ssh', 'id_ed25519')} 2>/dev/null || echo DENIED-SSH`,
      `cat ${join(home, '.codex', 'auth.json')} 2>/dev/null || echo DENIED-CODEX`,
      `(echo ok > ${join(session, 'work', 'note.txt')} && echo WROTE-SESSION) 2>/dev/null || echo DENIED-SESSION`,
      `(echo x > ${join(root, 'escape.txt')} && echo WROTE-OUTSIDE) 2>/dev/null || echo DENIED-OUTSIDE`,
      `(echo x > ${join(ws, 'evil.txt')} && echo WROTE-WS) 2>/dev/null || echo DENIED-WRITE-WS`,
      `echo HOME=$HOME`,
      `echo PROXY=$HTTPS_PROXY`,
      `${process.execPath} -e "require('net').connect(443,'1.1.1.1').on('connect',()=>{console.log('NET-OPEN');process.exit(0)}).on('error',e=>{console.log('NET-'+e.code);process.exit(0)})"`,
    ].join('; ');
    const proc = await spawnOwnedProcess({
      command: '/bin/sh',
      args: ['-c', script],
      cwd: join(session, 'work'),
      env: { PATH: '/usr/bin:/bin' },
      inheritEnv: [],
      ...(confiner === undefined ? {} : { confiner }),
    });
    const exit = await proc.exited;
    const out = proc.stdoutTail();
    await proc.dispose();
    expect(exit.code).toBe(0);
    for (const line of [
      'DENIED-DATA',
      'RUNTIME-OK',
      'DENIED-WS',
      'DENIED-SSH',
      'DENIED-CODEX',
      'WROTE-SESSION',
      'DENIED-OUTSIDE',
      'DENIED-WRITE-WS',
      `HOME=${join(session, 'home')}`,
      'PROXY=http://127.0.0.1:',
      'NET-EPERM',
    ]) {
      expect(out).toContain(line);
    }
    for (const leaked of ['DEVICE-SECRET', 'REPO-SECRET', 'SSH-SECRET', 'CODEX-SECRET', 'NET-OPEN']) {
      expect(out).not.toContain(leaked);
    }
    expect(await readFile(join(session, 'work', 'note.txt'), 'utf8')).toBe('ok\n');
  });

  it('lets an OpenCode session reach the loopback ports its engine names', async () => {
    const root = await realpath(await tempDir('asb-oc-'));
    const session = join(root, 'data', 'assistant', 's-1');
    await mkdir(join(session, 'work'), { recursive: true });
    const sb = new AssistantSandbox({
      mode: 'required',
      workerDataDir: join(root, 'data'),
      workspaceRoot: join(root, 'ws'),
      readableInDataDir: [],
      protectedHomes: [],
      workerHome: join(root, 'home'),
      allowKeychain: false,
      egressAllow: [],
      limits: DEFAULT_LIMITS,
    });
    const net = await import('node:net');
    const server = net.createServer((s) => s.end('HELLO\n'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const other = net.createServer((s) => s.end('OTHER\n'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherPort = (other.address() as { port: number }).port;
    try {
      const { confiner } = sb.forSession({
        runtime: 'opencode',
        authMode: 'secret-ref',
        sessionDir: session,
      });
      const probe = (p: number) =>
        `require('net').connect(${String(p)},'127.0.0.1').on('data',d=>{process.stdout.write('${String(p)}:'+d)}).on('error',e=>{console.log('${String(p)}:'+e.code)})`;
      const proc = await spawnOwnedProcess({
        command: process.execPath,
        args: ['-e', `${probe(port)};${probe(otherPort)}`],
        cwd: join(session, 'work'),
        env: { PATH: '/usr/bin:/bin', [ASSISTANT_LOOPBACK_PORTS_ENV]: String(port) },
        inheritEnv: [],
        ...(confiner === undefined ? {} : { confiner }),
      });
      await proc.exited;
      const out = proc.stdoutTail();
      await proc.dispose();
      expect(out).toContain(`${String(port)}:HELLO`);
      expect(out).toContain(`${String(otherPort)}:EPERM`);
    } finally {
      server.close();
      other.close();
    }
  });
});
