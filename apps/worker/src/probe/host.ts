import { Arch, HostFacts, OsFamily } from '@remyral/protocol';
import { MIN_NODE_MAJOR } from '../runtimes/pins.js';
import type { System } from '../system/types.js';
import type { HostSection, Problem } from './report.js';
import { firstLine } from './version.js';

const BITS32 = new Set(['ia32', 'arm', 'x32', 'mips', 'mipsel', 'ppc', 's390']);
const KERNEL64 = /^(aarch64|arm64|x86_64|amd64)$/i;
const GIB = 1024 ** 3;

function clip(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

async function osVersion(sys: System): Promise<string> {
  const release = sys.release();
  if (sys.platform === 'darwin') {
    const r = await sys.exec('sw_vers', ['-productVersion'], { timeoutMs: 5000 });
    const product = r.exitCode === 0 ? firstLine(r.stdout, 32) : '';
    return clip(product ? `macOS ${product} (Darwin ${release})` : `Darwin ${release}`, 128);
  }
  if (sys.platform === 'linux') {
    const osRelease = (await sys.readText('/etc/os-release', 16 * 1024)) ?? '';
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(osRelease)?.[1];
    return clip(pretty ? `${pretty} (kernel ${release})` : `Linux ${release}`, 128);
  }
  if (sys.platform === 'win32') {
    // os.version() → e.g. "Windows 11 Pro", os.release() → "10.0.26100".
    return clip(`${sys.kernelVersion()} ${release}`, 128) || 'Windows';
  }
  return clip(`${sys.platform} ${release}`, 128) || sys.platform;
}

/** Host facts never throw: unsupported platforms become `error` problems and `facts: null`. */
export async function probeHost(sys: System): Promise<{ host: HostSection; problems: Problem[] }> {
  const problems: Problem[] = [];
  const machine = sys.machine();
  const diskPath = sys.homedir();

  const nodeMajor = Number(sys.nodeVersion.split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    problems.push({
      code: 'host.node_too_old',
      severity: 'error',
      message: `Node.js ${sys.nodeVersion} is below the required ${String(MIN_NODE_MAJOR)}.x LTS (ADR-0002); install Node 24.`,
    });
  }

  const os = OsFamily.safeParse(sys.platform);
  if (!os.success) {
    problems.push({
      code: 'host.os_unsupported',
      severity: 'error',
      message: `Operating system "${sys.platform}" is not a supported worker OS (darwin, linux, win32).`,
    });
  }

  const arch = Arch.safeParse(sys.arch);
  if (!arch.success) {
    const bits32 = BITS32.has(sys.arch);
    problems.push({
      code: bits32 ? 'host.arch_32bit' : 'host.arch_unsupported',
      severity: 'error',
      message: bits32
        ? `32-bit architecture "${sys.arch}" is not supported; no runtime supports 32-bit (compat/README.md §3). Install a 64-bit OS and a 64-bit Node.js.`
        : `Architecture "${sys.arch}" is not supported (x64, arm64 only).`,
    });
    if (bits32 && KERNEL64.test(machine)) {
      problems.push({
        code: 'host.userland_32bit',
        severity: 'error',
        message: `64-bit kernel (${machine}) with a 32-bit Node.js/userland. On Raspberry Pi install Raspberry Pi OS (64-bit).`,
      });
    }
  }

  let hardwareModel: string | undefined;
  if (sys.platform === 'linux') {
    const model = await sys.readText('/proc/device-tree/model', 256);
    if (model) hardwareModel = clip(model.replaceAll('\u0000', ''), 128) || undefined;
  }

  const totalMemory = sys.totalMemoryBytes();
  if (totalMemory > 0 && totalMemory < 4 * GIB) {
    problems.push({
      code: 'host.memory_low',
      severity: 'warning',
      message: `Only ${(totalMemory / GIB).toFixed(1)} GiB RAM; Claude Code needs >= 4 GB (compat/README.md §3).`,
    });
  }

  const diskFree = await sys.diskFreeBytes(diskPath);
  if (diskFree === null) {
    problems.push({
      code: 'host.disk_unknown',
      severity: 'warning',
      message: 'Could not read free disk space of the home directory filesystem.',
    });
  }

  let facts: HostSection['facts'] = null;
  if (os.success && arch.success) {
    const candidate = HostFacts.safeParse({
      os: os.data,
      osVersion: (await osVersion(sys)) || sys.platform,
      arch: arch.data,
      hostname: clip(sys.hostname(), 255) || 'unknown-host',
      cpuCount: Math.max(1, sys.cpuCount()),
      memoryBytes: Math.max(0, Math.floor(totalMemory)),
      diskFreeBytes: Math.max(0, Math.floor(diskFree ?? 0)),
    });
    if (candidate.success) facts = candidate.data;
    else
      problems.push({
        code: 'host.facts_invalid',
        severity: 'error',
        message: `Host facts did not validate: ${candidate.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      });
  }

  return {
    host: {
      facts,
      raw: {
        platform: clip(sys.platform, 32),
        arch: clip(sys.arch, 32),
        machine: clip(machine, 64),
        release: clip(sys.release(), 128),
        nodeVersion: clip(sys.nodeVersion, 32),
        ...(hardwareModel ? { hardwareModel } : {}),
        diskPath: diskPath.slice(0, 1024),
      },
    },
    problems,
  };
}
