import { describe, expect, it } from 'vitest';
import { probeTools } from '../src/probe/tools.js';
import { FakeSystem, fail, ok } from './fake-system.js';

describe('probeTools', () => {
  it('detects docker with a reachable rootless daemon on Linux', async () => {
    const sys = new FakeSystem({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/docker': '', '/usr/bin/git': '', '/usr/bin/bwrap': '' },
      exec: (file, args) => {
        if (file === '/usr/bin/docker' && args[0] === '--version')
          return ok('Docker version 28.1.0, build x');
        if (file === '/usr/bin/docker' && args[0] === 'info')
          return ok('["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n');
        if (file === '/usr/bin/git') return ok('git version 2.47.0');
        if (file === '/usr/bin/bwrap') return ok('bubblewrap 0.11.0');
        return undefined;
      },
    });
    const { tools, problems } = await probeTools(sys);
    expect(tools.find((t) => t.name === 'docker')).toMatchObject({
      found: true,
      version: '28.1.0',
      details: { daemonReachable: true, rootless: true },
    });
    expect(tools.find((t) => t.name === 'bubblewrap')).toMatchObject({ found: true, version: '0.11.0' });
    expect(tools.some((t) => t.name === 'wsl')).toBe(false);
    expect(problems.map((p) => p.code)).not.toContain('tool.container_rootful');
  });

  it('warns about a rootful Linux docker daemon and an unreachable one is not "usable"', async () => {
    const rootful = new FakeSystem({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/docker': '' },
      exec: (_f, args) =>
        args[0] === 'info' ? ok('["name=seccomp,profile=builtin"]') : ok('Docker version 28.1.0'),
    });
    expect((await probeTools(rootful)).problems.map((p) => p.code)).toContain('tool.container_rootful');

    const down = new FakeSystem({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/docker': '' },
      exec: (_f, args) =>
        args[0] === 'info' ? fail(1, 'Cannot connect to the Docker daemon') : ok('Docker version 28.1.0'),
    });
    const docker = (await probeTools(down)).tools.find((t) => t.name === 'docker');
    expect(docker?.details).toEqual({ daemonReachable: false, rootless: null });
  });

  it('skips the Windows Store python3 alias and falls back to `py -3`', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      arch: 'x64',
      env: { Path: 'C:\\Users\\op\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows' },
      files: {
        'C:\\Users\\op\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe': '',
        'C:\\Windows\\py.exe': '',
      },
      exec: (file, args) => {
        if (file.endsWith('python3.exe')) return fail(9009);
        if (file.endsWith('py.exe') && args[0] === '-3') return ok('Python 3.12.7');
        return undefined;
      },
    });
    const { tools, problems } = await probeTools(sys);
    expect(tools.find((t) => t.name === 'python')).toMatchObject({
      found: true,
      version: '3.12.7',
      path: 'C:\\Windows\\py.exe',
      details: { command: 'py' },
    });
    expect(problems.map((p) => p.code)).not.toContain('tool.python_too_old');
    // ADR-0023: Python is informational only (no runtime needs it); never a problem.
    expect(problems.some((p) => p.code.startsWith('tool.python'))).toBe(false);
  });

  it('reports WSL on Windows, decoding UTF-16 output', async () => {
    const utf16 = (s: string) => s.split('').join('\u0000') + '\u0000';
    const sys = new FakeSystem({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: 'C:\\Windows\\System32' },
      files: { 'C:\\Windows\\System32\\wsl.exe': '' },
      exec: (file) =>
        file.endsWith('wsl.exe')
          ? ok(utf16('WSL version: 2.4.13.0\r\nKernel version: 6.6.36.3-1'))
          : undefined,
    });
    const { tools } = await probeTools(sys);
    expect(tools.find((t) => t.name === 'wsl')).toMatchObject({ found: true, version: '2.4.13' });
    expect(tools.some((t) => t.name === 'bubblewrap')).toBe(false);
  });

  it('flags a missing git; an old Python is no longer a problem (ADR-0023)', async () => {
    const sys = new FakeSystem({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/python3': '' },
      exec: (file) => (file === '/usr/bin/python3' ? ok('Python 3.9.6') : undefined),
    });
    const codes = (await probeTools(sys)).problems.map((p) => p.code);
    expect(codes).toContain('tool.git_missing');
    expect(codes).not.toContain('tool.python_too_old');
  });

  it('reports node from the running process even when not on PATH', async () => {
    const sys = new FakeSystem({ platform: 'linux', env: { PATH: '' } });
    const { tools } = await probeTools(sys);
    expect(tools.find((t) => t.name === 'node')).toEqual({ name: 'node', found: true, version: '24.19.0' });
  });
});
