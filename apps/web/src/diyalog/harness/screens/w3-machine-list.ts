import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: machine list leftovers and `/machines/add` — the installer overview
 * (`GET /installers`: a stable release with Linux / macOS / Windows kits and the one-line commands) and one archived
 * machine for "Arşivdekileri göster". Answer only the paths this package owns (undefined falls through).
 */

const SHA = (c: string): string => c.repeat(64);

function kit(os: 'linux' | 'macos' | 'windows'): Record<string, unknown> {
  const file = `remyral-worker-1.0.41-${os}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
  const base = `https://remyral.example/v1/worker/install/1.0.41/${os}`;
  return {
    os,
    file,
    sha256: SHA(os === 'linux' ? 'a' : os === 'macos' ? 'b' : 'c'),
    sizeBytes: 41_800_000,
    commands: {
      bootstrapUrl: `${base}/bootstrap.${os === 'windows' ? 'ps1' : 'sh'}`,
      bootstrapSha256: SHA('d'),
      download:
        os === 'windows'
          ? `Invoke-WebRequest -UseBasicParsing -Uri '${base}/bootstrap.ps1' -OutFile remyral-bootstrap.ps1; if ((Get-FileHash remyral-bootstrap.ps1 -Algorithm SHA256).Hash -ne '${SHA('D')}') { throw 'checksum mismatch' }`
          : `curl -fsSL --proto '=https' --tlsv1.2 -o remyral-bootstrap.sh '${base}/bootstrap.sh' && echo '${SHA('d')}  remyral-bootstrap.sh' | ${os === 'linux' ? 'sha256sum -c -' : 'shasum -a 256 -c -'}`,
      run:
        os === 'windows'
          ? 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\remyral-bootstrap.ps1'
          : 'sudo sh remyral-bootstrap.sh',
    },
    kitUrl: `${base}/${file}`,
  };
}

export const INSTALLERS = {
  publicOrigin: 'https://remyral.example',
  masterUrl: 'wss://remyral.example/v1/worker',
  publicDownloads: true,
  current: {
    version: '1.0.41',
    channel: 'stable',
    stable: true,
    keyId: '0123456789abcdef',
    nodeVersion: '24.21.0',
    uploadedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    kits: [kit('linux'), kit('macos'), kit('windows')],
  },
  withoutKits: [],
};

const ARCHIVED = {
  id: 'w8',
  name: 'old-box',
  state: 'quarantined',
  quarantineReason: null,
  connected: false,
  fingerprint: 'SHA256:W8x9Qm2LrT0aV7bK4nE1sW8yH3cJ6dF5gP',
  os: 'linux',
  arch: 'x64',
  osVersion: '6.1',
  hostname: 'old-box',
  workerVersion: '1.0.12',
  runningJobs: 0,
  lastSeenAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
};

export const ROUTES: ScreenRoutes = {
  '/installers': () => INSTALLERS,
  '/workers': (url) => (url.searchParams.get('archived') === '1' ? { workers: [ARCHIVED] } : undefined),
};
