import { type InstallerKitInfo, type InstallerOs } from '../../api/installers';

/**
 * Fleet → "Add machine" (p5-worker-onboarding, docs/ops/worker-pairing.md §1). Pick the system, run the
 * two-line command (download + SHA-256 check of the bootstrap, then run it) or download the installer
 * bundle; the machine then shows up under "Waiting to pair" with its pairing code and fingerprint.
 * Read-only: nothing is created here; approval still needs the fingerprint check and the pairing code.
 */
export interface Platform {
  readonly id: string;
  readonly os: InstallerOs;
  readonly label: string;
  /** nodejs.org platform of the pinned Node archive. */
  readonly node: string;
  readonly note: string;
}

export const PLATFORMS: readonly Platform[] = [
  {
    id: 'linux-x64',
    os: 'linux',
    label: 'Linux x64',
    node: 'linux-x64',
    note: 'Debian, Ubuntu, Fedora … with systemd.',
  },
  {
    id: 'linux-arm64',
    os: 'linux',
    label: 'Linux arm64 / Raspberry Pi',
    node: 'linux-arm64',
    note: 'Raspberry Pi OS must be the 64-bit edition (uname -m shows aarch64).',
  },
  {
    id: 'darwin-arm64',
    os: 'macos',
    label: 'macOS (Apple silicon)',
    node: 'darwin-arm64',
    note: 'macOS 13 or newer.',
  },
  { id: 'darwin-x64', os: 'macos', label: 'macOS (Intel)', node: 'darwin-x64', note: 'macOS 13 or newer.' },
  {
    id: 'win-x64',
    os: 'windows',
    label: 'Windows x64',
    node: 'win-x64',
    note: 'Windows 10/11. Run the commands in PowerShell opened with "Run as administrator".',
  },
];

export const NODE_HOME: Record<InstallerOs, string> = {
  linux: '/opt/remyral-worker/node',
  macos: '/Library/Application Support/RemyralWorker/node',
  windows: '%ProgramFiles%\\RemyralWorker\\node',
};

export function bundleSteps(kit: InstallerKitInfo, masterUrl: string): string {
  const dir = kit.file.replace(/\.(tar\.gz|zip)$/, '');
  if (kit.os === 'windows') {
    return [
      `if ((Get-FileHash ${kit.file} -Algorithm SHA256).Hash -ne '${kit.sha256.toUpperCase()}') { throw 'checksum mismatch' }`,
      `Expand-Archive ${kit.file} -DestinationPath .`,
      `powershell -NoProfile -ExecutionPolicy Bypass -File .\\${dir}\\install.ps1 -MasterUrl ${masterUrl}`,
    ].join('\n');
  }
  const check = kit.os === 'linux' ? 'sha256sum -c -' : 'shasum -a 256 -c -';
  return [
    `echo '${kit.sha256}  ${kit.file}' | ${check}`,
    `tar -xzf ${kit.file}`,
    `sudo ./${dir}/install.sh --master-url ${masterUrl}`,
  ].join('\n');
}
