import { Capability, RuntimeCapabilities } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { buildRuntimeReport, detectRuntime, pinStatusOf } from '../src/runtimes/detect.js';
import { RUNTIME_PINS } from '../src/runtimes/pins.js';
import { FakeSystem, fail, ok } from './fake-system.js';

describe('CLI runtime detection', () => {
  it('matches the pin and reports every capability as unverified (ADR-0008)', async () => {
    const sys = new FakeSystem({
      platform: 'darwin',
      env: { PATH: '/usr/local/bin' },
      files: { '/usr/local/bin/codex': '' },
      exec: (file, args) =>
        file === '/usr/local/bin/codex' && args[0] === '--version' ? ok('codex-cli 0.164.0\n') : undefined,
    });
    const detected = await detectRuntime(sys, 'codex');
    expect(detected).toMatchObject({
      installed: true,
      version: '0.164.0',
      binaryPath: '/usr/local/bin/codex',
    });
    const { report, problems } = buildRuntimeReport(sys, detected);
    expect(report.pinStatus).toBe('match');
    expect(RuntimeCapabilities.parse(report.capabilities)).toMatchObject({
      authenticated: 'unknown',
      installed: true,
    });
    for (const c of Capability.options) {
      expect(report.capabilities.capabilities[c]?.status).toBe('unverified');
      expect(report.capabilities.capabilities[c]?.note).not.toMatch(/pinMismatch/);
    }
    expect(problems).toEqual([]);
  });

  it('marks a version that differs from the pin with pinMismatch everywhere', async () => {
    const sys = new FakeSystem({
      env: { PATH: '/bin' },
      files: { '/bin/claude': '' },
      exec: () => ok('2.1.281 (Claude Code)'),
    });
    const { report, problems } = buildRuntimeReport(sys, await detectRuntime(sys, 'claude-code'));
    expect(report.pinStatus).toBe('mismatch');
    expect(report.capabilities.version).toBe('2.1.281');
    expect(report.pin).toBe(RUNTIME_PINS['claude-code'].version);
    for (const c of Capability.options) {
      expect(report.capabilities.capabilities[c]).toMatchObject({ status: 'unverified' });
      expect(report.capabilities.capabilities[c]?.note).toMatch(/^pinMismatch: 2\.1\.281 != pin 2\.1\.310/);
    }
    expect(report.notes.some((n) => n.startsWith('pinMismatch'))).toBe(true);
    expect(problems).toMatchObject([{ code: 'runtime.pin_mismatch', severity: 'warning' }]);
  });

  it('reports an unreadable version as pin status unknown', async () => {
    const sys = new FakeSystem({ env: { PATH: '/bin' }, files: { '/bin/pi': '' }, exec: () => fail(1) });
    const detected = await detectRuntime(sys, 'pi');
    expect(pinStatusOf(detected)).toBe('unknown');
    const { report, problems } = buildRuntimeReport(sys, detected);
    expect(report.capabilities.version).toBe('unknown');
    expect(problems.map((p) => p.code)).toEqual(['runtime.version_unreadable']);
  });

  it('reports a missing runtime as installed=false with unsupported capabilities', async () => {
    const sys = new FakeSystem({ env: { PATH: '/bin' } });
    const { report, problems } = buildRuntimeReport(sys, await detectRuntime(sys, 'opencode'));
    expect(report).toMatchObject({ pinStatus: 'not-installed', binaryPath: null });
    expect(report.capabilities).toMatchObject({
      installed: false,
      version: 'not-installed',
      authenticated: 'unknown',
    });
    expect(Object.values(report.capabilities.capabilities).every((c) => c.status === 'unsupported')).toBe(
      true,
    );
    expect(problems).toMatchObject([{ code: 'runtime.not_installed', severity: 'info' }]);
  });

  it('flags the deprecated @mariozechner pi package', async () => {
    const sys = new FakeSystem({
      env: { PATH: '/bin' },
      files: { '/bin/pi': '' },
      realpaths: { '/bin/pi': '/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js' },
      exec: () => ok('0.70.0'),
    });
    expect((await detectRuntime(sys, 'pi')).notes.join(' ')).toMatch(/deprecated @mariozechner/);
  });

  it('adds Windows platform caveats from the compat matrix', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: 'C:\\npm' },
      files: { 'C:\\npm\\pi.cmd': '' },
      exec: () => ok('1.4.0'),
    });
    const { report } = buildRuntimeReport(sys, await detectRuntime(sys, 'pi'));
    expect(report.pinStatus).toBe('match');
    expect(report.notes.join(' ')).toMatch(/Git Bash/);
  });
});
