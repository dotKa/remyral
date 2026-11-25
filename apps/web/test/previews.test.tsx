import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOutputItem } from '../src/api/outputs';
import { isAppPackage, parseTunnel, safePreviewUrl } from '../src/api/previews';

/**
 * p8-preview-tunnels (ADR-0032): the job page's Preview card (states, public-link warning, extend / close / open,
 * reveal of a service token with a fresh code), Project → Deploy → Preview links (saved with the deploy targets),
 * the Cloudflare connection test's missing token permissions, the composer's "open a preview when the dev server is
 * up", and app packages / preview items in Outputs.
 */

configure({ asyncUtilTimeout: 5_000 });

const JOB = '22222222-2222-4222-8222-222222222222';
const TUNNEL = '33333333-3333-4333-8333-333333333333';
const ACTION = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-16T08:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tunnel(over: Record<string, unknown> = {}) {
  return {
    id: TUNNEL,
    project: 'shop',
    name: 'web',
    hostname: 'pv-web-k3x9q2m7ta.example.org',
    url: 'https://pv-web-k3x9q2m7ta.example.org',
    protection: 'none',
    stable: false,
    state: 'active',
    connector: { state: 'running', detail: null, since: NOW },
    jobId: JOB,
    workerId: 'w1',
    port: 5173,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: NOW,
    closedAt: null,
    closeReason: null,
    openedBy: { type: 'system', id: `job:${JOB}`, username: null },
    openActionId: ACTION,
    serviceTokenClientId: null,
    ...over,
  };
}

describe('API parsing', () => {
  it('parses a tunnel and only links https preview URLs', () => {
    const t = parseTunnel(tunnel());
    expect(t.connector?.state).toBe('running');
    expect(safePreviewUrl(t.url)).toBe('https://pv-web-k3x9q2m7ta.example.org/');
    expect(safePreviewUrl('javascript:alert(1)')).toBeNull();
    expect(safePreviewUrl('http://x.example')).toBeNull();
    expect(() => parseTunnel(tunnel({ protection: 'open' }))).toThrow();
  });

  it('recognises app packages by type or extension', () => {
    expect(isAppPackage('application/vnd.android.package-archive')).toBe(true);
    expect(isAppPackage('application/octet-stream', 'out/app-release.AAB')).toBe(true);
    expect(isAppPackage('application/pdf', 'report.pdf')).toBe(false);
  });
});

describe('Outputs', () => {
  const base = {
    key: 'x',
    project: 'shop',
    title: null,
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: NOW,
    note: null,
  };

  it('never previews an app package', () => {
    const item = parseOutputItem({
      ...base,
      type: 'file',
      name: 'out/app-release.apk',
      site: null,
      file: {
        source: 'workspace',
        artifactId: 'ws-app',
        kind: 'output',
        mediaType: 'application/vnd.android.package-archive',
        sizeBytes: 30_000_000,
        sha256: 'a'.repeat(64),
        redacted: false,
        removed: null,
        expiresAt: null,
        download: `/jobs/${JOB}/artifacts/ws-app`,
        preview: 'image',
      },
    });
    expect(item.file?.preview).toBe('none');
  });

  it('reads preview items (provider tunnel) with their protection', () => {
    const item = parseOutputItem({
      ...base,
      type: 'site',
      name: 'web',
      file: null,
      site: {
        url: 'https://pv-web-k3x9q2m7ta.example.org',
        env: 'preview',
        provider: 'tunnel',
        target: `tunnel:${TUNNEL}`,
        opsActionId: ACTION,
        opsKind: 'tunnel.open',
        deployedAt: NOW,
        protection: 'none',
        expiresAt: NOW,
      },
    });
    expect(item.site).toMatchObject({ provider: 'tunnel', protection: 'none', expiresAt: NOW });
  });
});
