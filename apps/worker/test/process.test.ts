import { describe, expect, it } from 'vitest';
import { buildChildEnv, planKillTree, planSpawn } from '../src/system/process.js';

describe('planSpawn', () => {
  it('spawns POSIX binaries directly in their own process group', () => {
    expect(planSpawn('linux', '/usr/bin/opencode', ['serve'])).toEqual({
      file: '/usr/bin/opencode',
      args: ['serve'],
      windowsVerbatimArguments: false,
      detached: true,
    });
  });

  it('spawns Windows .exe directly, not detached', () => {
    expect(planSpawn('win32', 'C:\\x\\codex.exe', ['--version'])).toMatchObject({
      file: 'C:\\x\\codex.exe',
      detached: false,
      windowsVerbatimArguments: false,
    });
  });

  it('routes Windows .cmd shims through cmd.exe /d /s /c with quoting', () => {
    const plan = planSpawn('win32', 'C:\\Users\\A B\\npm\\claude.cmd', ['--version']);
    expect(plan.file).toBe('cmd.exe');
    expect(plan.args).toEqual(['/d', '/s', '/c', '""C:\\Users\\A B\\npm\\claude.cmd" --version"']);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it('refuses cmd.exe metacharacters instead of escaping them', () => {
    expect(() => planSpawn('win32', 'C:\\npm\\pi.cmd', ['a&calc'])).toThrow(/metacharacter/);
    expect(() => planSpawn('win32', 'C:\\npm\\pi.cmd', ['%PATH%'])).toThrow(/metacharacter/);
  });
});

describe('planKillTree', () => {
  it('uses taskkill /T /F on Windows', () => {
    expect(planKillTree('win32', 123, false)).toEqual({
      kind: 'exec',
      file: 'taskkill',
      args: ['/PID', '123', '/T', '/F'],
    });
  });

  it('signals the process group on POSIX, escalating to SIGKILL', () => {
    expect(planKillTree('darwin', 9, false)).toEqual({ kind: 'signal-group', pid: 9, signal: 'SIGTERM' });
    expect(planKillTree('linux', 9, true)).toEqual({ kind: 'signal-group', pid: 9, signal: 'SIGKILL' });
  });
});

describe('buildChildEnv', () => {
  const parent: Record<string, string> = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-should-not-leak',
    OPENAI_API_KEY: 'sk-nope',
    GITHUB_TOKEN: 'ghp_nope',
    LANG: 'en_US.UTF-8',
    HOME: '/home/op',
  };

  it('keeps only allow-listed variables and isolates HOME', () => {
    const env = buildChildEnv((n) => parent[n], '/tmp/iso', '/', { OPENCODE_SERVER_PASSWORD: 'secret' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.HOME).toBe('/tmp/iso');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/iso/.config');
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('secret');
    expect(Object.values(env).join(' ')).not.toMatch(/sk-|ghp_|\/home\/op/);
  });

  it('never emits PATH and Path together on Windows', () => {
    const win: Record<string, string> = {
      PATH: 'C:\\Windows',
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
    };
    const env = buildChildEnv(
      (n) => win[n] ?? win[Object.keys(win).find((k) => k.toLowerCase() === n.toLowerCase()) ?? ''],
      'C:\\T\\iso',
      '\\',
      {},
    );
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toHaveLength(1);
    expect(env.APPDATA).toBe('C:\\T\\iso\\AppData\\Roaming');
    expect(env.USERPROFILE).toBe('C:\\T\\iso');
  });
});
