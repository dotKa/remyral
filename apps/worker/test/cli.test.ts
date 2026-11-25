import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT_CRASH, EXIT_OK, main } from '../src/cli.js';
import { ProbeReport } from '../src/probe/report.js';
import { WORKER_VERSION } from '../src/probe/probe.js';
import { FakeSystem, ok } from './fake-system.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

const linuxPi = () =>
  new FakeSystem({
    platform: 'linux',
    arch: 'arm64',
    machine: 'aarch64',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-must-not-appear' },
    files: { '/usr/bin/git': '', '/usr/bin/opencode': '', '/proc/device-tree/model': 'Raspberry Pi 5' },
    exec: (file) => {
      if (file === '/usr/bin/git') return ok('git version 2.47.2');
      if (file === '/usr/bin/opencode') return ok('1.19.4');
      return undefined;
    },
  });

describe('remyral-worker probe', () => {
  it('--json prints a valid ProbeReport and exits 0 even with problems', async () => {
    const { io, out } = capture();
    const sys = linuxPi();
    expect(await main(['probe', '--json'], sys, io)).toBe(EXIT_OK);
    const report = ProbeReport.parse(JSON.parse(out.join('')));
    expect(report.schemaVersion).toBe(1);
    expect(report.host.facts).toMatchObject({ os: 'linux', arch: 'arm64' });
    expect(report.runtimes.map((r) => r.runtime)).toEqual(['claude-code', 'codex', 'pi', 'opencode']);
    expect(report.runtimes.find((r) => r.runtime === 'opencode')?.pinStatus).toBe('match');
    expect(report.problems.length).toBeGreaterThan(0);
    expect(out.join('')).not.toContain('sk-ant-must-not-appear');
    expect(report.probe).toMatchObject({ selfTest: false, runtimeFilter: null });
  });

  it('--runtime limits detection to one runtime', async () => {
    const { io, out } = capture();
    expect(await main(['probe', '--json', '--runtime', 'opencode'], linuxPi(), io)).toBe(EXIT_OK);
    const report = ProbeReport.parse(JSON.parse(out.join('')));
    expect(report.runtimes.map((r) => r.runtime)).toEqual(['opencode']);
    expect(report.probe.runtimeFilter).toBe('opencode');
  });

  it('prints a human table by default', async () => {
    const { io, out } = capture();
    expect(await main(['probe'], linuxPi(), io)).toBe(EXIT_OK);
    const text = out.join('');
    for (const heading of ['HOST', 'TOOLS', 'RUNTIMES', 'SANDBOX PROFILES', 'PROBLEMS'])
      expect(text).toContain(heading);
    expect(text).toContain('Raspberry Pi 5');
  });

  it('reports an unsupported 32-bit platform in the report instead of crashing', async () => {
    const { io, out } = capture();
    const sys = new FakeSystem({ platform: 'linux', arch: 'arm', machine: 'aarch64', env: { PATH: '' } });
    expect(await main(['probe', '--json'], sys, io)).toBe(EXIT_OK);
    const report = ProbeReport.parse(JSON.parse(out.join('')));
    expect(report.host.facts).toBeNull();
    expect(report.problems.filter((p) => p.severity === 'error').map((p) => p.code)).toEqual([
      'host.arch_32bit',
      'host.userland_32bit',
    ]);
  });

  it('exits 2 on bad arguments', async () => {
    for (const argv of [[], ['probe', '--runtime', 'gpt'], ['probe', '--bogus'], ['frobnicate']]) {
      const { io, err } = capture();
      expect(await main(argv, linuxPi(), io)).toBe(EXIT_CRASH);
      expect(err.join('')).toMatch(/Usage|--runtime|Unknown|bogus/);
    }
  });

  it('exits 2 when the probe itself crashes', async () => {
    const sys = linuxPi();
    sys.now = () => {
      throw new Error('clock exploded');
    };
    const { io, err } = capture();
    expect(await main(['probe', '--json'], sys, io)).toBe(EXIT_CRASH);
    expect(err.join('')).toContain('clock exploded');
  });

  it('--version matches package.json', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(WORKER_VERSION).toBe(pkg.version);
    const { io, out } = capture();
    expect(await main(['--version'], linuxPi(), io)).toBe(EXIT_OK);
    expect(out.join('').trim()).toBe(pkg.version);
  });

  it('runs the opt-in self-test only with --self-test', async () => {
    const sys = linuxPi();
    const { io } = capture();
    await main(['probe', '--json', '--runtime', 'opencode'], sys, io);
    expect(sys.serverCalls).toHaveLength(0);
    await main(['probe', '--json', '--runtime', 'opencode', '--self-test'], sys, capture().io);
    expect(sys.serverCalls).toHaveLength(1);
    expect(sys.stoppedServers).toBe(1);
  });
});
