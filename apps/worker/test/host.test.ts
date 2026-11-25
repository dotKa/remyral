import { HostFacts } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { probeHost } from '../src/probe/host.js';
import { FakeSystem, ok } from './fake-system.js';

const codes = (problems: { code: string }[]) => problems.map((p) => p.code);

describe('probeHost', () => {
  it('produces valid HostFacts on macOS using sw_vers', async () => {
    const sys = new FakeSystem({
      platform: 'darwin',
      exec: (file) => (file === 'sw_vers' ? ok('26.6\n') : undefined),
    });
    const { host, problems } = await probeHost(sys);
    expect(HostFacts.parse(host.facts)).toMatchObject({
      os: 'darwin',
      arch: 'arm64',
      osVersion: 'macOS 26.6 (Darwin 25.6.0)',
      hostname: 'test-host',
      cpuCount: 8,
    });
    expect(problems).toEqual([]);
  });

  it('reads /etc/os-release and the Raspberry Pi model on Linux', async () => {
    const sys = new FakeSystem({
      platform: 'linux',
      arch: 'arm64',
      machine: 'aarch64',
      release: '6.12.25+rpt-rpi-2712',
      files: {
        '/etc/os-release': 'NAME="Debian"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n',
        '/proc/device-tree/model': 'Raspberry Pi 5 Model B Rev 1.0\u0000',
      },
    });
    const { host } = await probeHost(sys);
    expect(host.facts?.osVersion).toBe('Debian GNU/Linux 13 (trixie) (kernel 6.12.25+rpt-rpi-2712)');
    expect(host.raw.hardwareModel).toBe('Raspberry Pi 5 Model B Rev 1.0');
  });

  it('reports a 32-bit userland on a 64-bit kernel as errors and never throws', async () => {
    const sys = new FakeSystem({ platform: 'linux', arch: 'arm', machine: 'aarch64' });
    const { host, problems } = await probeHost(sys);
    expect(host.facts).toBeNull();
    expect(host.raw.arch).toBe('arm');
    expect(codes(problems)).toEqual(expect.arrayContaining(['host.arch_32bit', 'host.userland_32bit']));
    expect(problems.every((p) => p.severity === 'error')).toBe(true);
  });

  it('flags ia32 Windows', async () => {
    const sys = new FakeSystem({ platform: 'win32', arch: 'ia32', machine: 'i686' });
    const { host, problems } = await probeHost(sys);
    expect(host.facts).toBeNull();
    expect(codes(problems)).toEqual(['host.arch_32bit']);
  });

  it('flags Node < 24 but still produces facts', async () => {
    const sys = new FakeSystem({ platform: 'linux', arch: 'x64', nodeVersion: '22.11.0' });
    const { host, problems } = await probeHost(sys);
    expect(host.facts).not.toBeNull();
    expect(codes(problems)).toContain('host.node_too_old');
  });

  it('flags unsupported OS families', async () => {
    const sys = new FakeSystem({ platform: 'freebsd', arch: 'x64' });
    const { host, problems } = await probeHost(sys);
    expect(host.facts).toBeNull();
    expect(codes(problems)).toContain('host.os_unsupported');
  });

  it('warns on low memory and unknown disk space', async () => {
    const sys = new FakeSystem({ platform: 'linux', totalMemoryBytes: 2 * 1024 ** 3, diskFreeBytes: null });
    const { host, problems } = await probeHost(sys);
    expect(codes(problems)).toEqual(expect.arrayContaining(['host.memory_low', 'host.disk_unknown']));
    expect(host.facts?.diskFreeBytes).toBe(0);
  });

  it('builds a Windows osVersion from os.version() and os.release()', async () => {
    const sys = new FakeSystem({
      platform: 'win32',
      arch: 'x64',
      kernelVersion: 'Windows 11 Pro',
      release: '10.0.26100',
    });
    const { host } = await probeHost(sys);
    expect(host.facts?.osVersion).toBe('Windows 11 Pro 10.0.26100');
  });
});
