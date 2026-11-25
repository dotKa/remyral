import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, USER } from './helpers';

const signedIn = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null } as const;
const SHA = (c: string) => c.repeat(64);

function kit(os: 'linux' | 'macos' | 'windows', commands = true) {
  const file = `remyral-worker-1.2.0-${os}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
  return {
    os,
    file,
    sha256: SHA(os[0] ?? 'a'),
    sizeBytes: 1_200_000,
    commands: commands
      ? {
          bootstrapUrl: `https://r.example.com/v1/worker/install/1.2.0/${os}/bootstrap.${os === 'windows' ? 'ps1' : 'sh'}`,
          bootstrapSha256: SHA('b'),
          download:
            os === 'windows'
              ? `Invoke-WebRequest … '${SHA('B')}'`
              : `curl -fsSL --proto '=https' --tlsv1.2 -o remyral-bootstrap.sh '…' && echo '${SHA('b')}  remyral-bootstrap.sh' | ${os === 'linux' ? 'sha256sum -c -' : 'shasum -a 256 -c -'}`,
          run:
            os === 'windows'
              ? 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\remyral-bootstrap.ps1'
              : 'sudo sh remyral-bootstrap.sh',
        }
      : null,
    kitUrl: commands ? `https://r.example.com/v1/worker/install/1.2.0/${os}/${file}` : null,
  };
}

function overview(over: Record<string, unknown> = {}, commands = true) {
  return {
    publicOrigin: commands ? 'https://r.example.com' : null,
    masterUrl: commands ? 'wss://r.example.com/v1/worker' : null,
    publicDownloads: true,
    current: {
      version: '1.2.0',
      channel: 'stable',
      stable: true,
      keyId: '0123456789abcdef',
      nodeVersion: '24.21.0',
      uploadedAt: '2026-10-14T10:00:00.000Z',
      kits: [kit('linux', commands), kit('macos', commands), kit('windows', commands)],
    },
    withoutKits: [],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Fleet → Add machine (p5-worker-onboarding)', () => {
  it('explains how to publish kits when there are none, and warns when not on stable', async () => {
    renderApp({
      path: '/fleet/add',
      initialState: signedIn,
      routes: {
        'GET /api/installers': () => ({
          status: 200,
          body: overview({ current: null, withoutKits: ['1.1.0'] }),
        }),
      },
    });
    expect(await screen.findByText(/sign\.mjs installers/)).toBeTruthy();
  });
});
