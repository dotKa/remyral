import { describe, expect, it } from 'vitest';
import { candidateNames, locateBinary } from '../src/probe/locate.js';
import { FakeSystem } from './fake-system.js';

describe('locateBinary (POSIX)', () => {
  it('walks PATH in order and returns the first hit', async () => {
    const sys = new FakeSystem({
      platform: 'linux',
      env: { PATH: '/opt/a:/opt/b' },
      files: { '/opt/b/codex': '', '/usr/local/bin/codex': '' },
    });
    expect(await locateBinary(sys, 'codex')).toBe('/opt/b/codex');
  });

  it('ignores relative PATH entries (no cwd hijack)', async () => {
    const sys = new FakeSystem({ platform: 'linux', env: { PATH: '.:bin' }, files: { 'bin/git': '' } });
    expect(await locateBinary(sys, 'git')).toBeNull();
  });

  it('falls back to well-known per-user dirs when PATH is minimal', async () => {
    const sys = new FakeSystem({
      platform: 'darwin',
      homedir: '/Users/op',
      env: { PATH: '/usr/bin' },
      files: { '/Users/op/.opencode/bin/opencode': '' },
    });
    expect(await locateBinary(sys, 'opencode')).toBe('/Users/op/.opencode/bin/opencode');
  });

  it('returns null when nothing matches', async () => {
    const sys = new FakeSystem({ platform: 'linux', env: { PATH: '/usr/bin' } });
    expect(await locateBinary(sys, 'nope')).toBeNull();
  });
});

describe('locateBinary (Windows, via fakes)', () => {
  it('expands PATHEXT and finds npm .cmd shims, reading the case-insensitive Path variable', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      env: {
        Path: 'C:\\Windows\\System32;C:\\Users\\op\\AppData\\Roaming\\npm',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      files: { 'C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd': '' },
    });
    expect(await locateBinary(sys, 'claude')).toBe('C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd');
  });

  it('prefers .exe over .cmd in the same directory (PATHEXT order)', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      env: { PATH: 'C:\\tools' },
      files: { 'C:\\tools\\codex.cmd': '', 'C:\\tools\\codex.exe': '' },
    });
    expect(await locateBinary(sys, 'codex')).toBe('C:\\tools\\codex.exe');
  });

  it('accepts quoted PATH entries and matches case-insensitively', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      env: { PATH: '"C:\\Program Files\\Git\\cmd"' },
      files: { 'c:\\program files\\git\\cmd\\GIT.EXE': '' },
    });
    expect(await locateBinary(sys, 'git')).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('searches %APPDATA%\\npm even when it is not on PATH', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      env: { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\op\\AppData\\Roaming' },
      files: { 'C:\\Users\\op\\AppData\\Roaming\\npm\\pi.cmd': '' },
    });
    expect(await locateBinary(sys, 'pi')).toBe('C:\\Users\\op\\AppData\\Roaming\\npm\\pi.cmd');
  });

  it('uses the default PATHEXT when the variable is missing and keeps explicit extensions', () => {
    const sys = new FakeSystem({ platform: 'win32', env: {} });
    expect(candidateNames(sys, 'wsl')).toEqual(['wsl.com', 'wsl.exe', 'wsl.bat', 'wsl.cmd']);
    expect(candidateNames(sys, 'python.exe')).toEqual(['python.exe']);
    expect(candidateNames(new FakeSystem({ platform: 'linux' }), 'wsl')).toEqual(['wsl']);
  });
});
