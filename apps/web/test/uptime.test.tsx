import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOutputItem } from '../src/api/outputs';
import {
  monitorQuery,
  parseMonitor,
  pct,
  providerRow,
  targetText,
  validateMonitorForm,
} from '../src/api/uptime';
import { USER } from './helpers';

/**
 * p8-uptime: the Uptime list (status, uptime %, sparkline, counts, filters, New monitor validation), the monitor page
 * (provider status, incidents with flapping suppression, TLS warning, Outputs link), the Outputs status dot and
 * "Monitor this", and the chat draft card / watch condition labels.
 */

configure({ asyncUtilTimeout: 5_000 });

const NOW = '2026-10-16T08:00:00.000Z';
const M1 = '11111111-1111-4111-8111-111111111111';
const JOB = '66666666-6666-4666-8666-666666666666';
const ACTION = '77777777-7777-4777-8777-777777777777';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function monitor(over: Record<string, unknown> = {}) {
  return {
    id: M1,
    project: 'acme',
    name: 'Shop',
    type: 'http',
    config: { url: 'https://shop.example.com/', method: 'GET', tlsWarnDays: 14 },
    outputKey: null,
    intervalSec: 60,
    timeoutMs: 10_000,
    retries: 1,
    paused: false,
    status: 'up',
    flapping: false,
    consecutiveFailures: 0,
    statusChangedAt: NOW,
    lastCheck: { at: NOW, ok: true, latencyMs: 120, statusCode: 200, error: null, detail: null },
    tls: null,
    uptime: { h24: 99.5, d7: 100, d30: null },
    latencyAvg24h: 118,
    sparkline: [100, 120, null, 130, ...Array<null>(20).fill(null)],
    openIncident: null,
    nextCheckAt: NOW,
    createdBy: { type: 'user', id: USER.id },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('uptime api helpers', () => {
  it('parses monitors, builds queries and describes targets', () => {
    const m = parseMonitor(monitor());
    expect(m.sparkline.slice(0, 4)).toEqual([100, 120, null, 130]);
    expect(monitorQuery({ project: 'acme', status: 'down', q: 'a b' })).toBe(
      '?project=acme&status=down&q=a+b',
    );
    expect(monitorQuery({})).toBe('');
    expect(targetText('tcp', { host: 'db.example.com', port: 5432 })).toBe('db.example.com:5432');
    expect(targetText('pages', { project: 'site', env: 'preview' })).toBe('site (preview)');
    expect(pct(null)).toBe('—');
    expect(pct(100)).toBe('100 %');
    expect(pct(99.5)).toBe('99.50 %');
    expect(providerRow('pages', 'healthy', 'up')).toBe('Cloudflare Pages: healthy');
    expect(providerRow('coolify', 'running:healthy', 'up')).toBe('Coolify app: running:healthy');
    expect(providerRow('http', null, 'up')).toBeNull();
    expect(() => parseMonitor({ ...monitor(), status: 'weird' })).toThrow();
  });

  it('validates the form like the master: ports, credentials, intervals, keyword with GET', () => {
    const base = {
      name: 'x',
      type: 'http' as const,
      url: 'https://a.example.com',
      method: 'GET' as const,
      keyword: '',
      host: '',
      port: '',
      pagesProject: '',
      coolifyUuid: '',
      intervalSec: '60',
    };
    expect(validateMonitorForm(base)).toEqual({});
    expect(validateMonitorForm({ ...base, url: 'https://a.example.com:22/' }).url).toMatch(/Port 22/);
    expect(validateMonitorForm({ ...base, url: 'https://u:p@a.example.com/' }).url).toMatch(/password/);
    expect(validateMonitorForm({ ...base, url: 'ftp://a.example.com/' }).url).toMatch(/http/);
    expect(validateMonitorForm({ ...base, intervalSec: '10' }).intervalSec).toMatch(/30/);
    expect(validateMonitorForm({ ...base, method: 'HEAD', keyword: 'ok' }).keyword).toMatch(/GET/);
    expect(
      validateMonitorForm({ ...base, type: 'pages', pagesProject: 'site', intervalSec: '30' }).intervalSec,
    ).toMatch(/once a minute/);
    expect(validateMonitorForm({ ...base, type: 'tcp', host: 'db', port: '70000' }).port).toBeDefined();
  });

  it('outputs items carry their uptime defensively', () => {
    const item = parseOutputItem({
      ...siteItem(null),
      uptime: {
        status: 'down',
        uptime24h: 90,
        monitors: [
          {
            id: M1,
            name: 'x',
            type: 'http',
            status: 'down',
            paused: false,
            uptime24h: 90,
            detail: null,
            lastCheckAt: NOW,
          },
        ],
      },
    });
    expect(item.uptime?.status).toBe('down');
    expect(parseOutputItem(siteItem(null)).uptime).toBeNull();
    expect(() =>
      parseOutputItem({ ...siteItem(null), uptime: { status: 'x', uptime24h: null, monitors: [] } }),
    ).toThrow();
  });
});

function siteItem(uptime: unknown) {
  return {
    key: 'site:pages:acme-site:production',
    type: 'site',
    project: 'acme',
    title: null,
    name: 'acme-site',
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: NOW,
    site: {
      url: 'https://acme-site.pages.dev',
      env: 'production',
      provider: 'pages',
      target: 'pages:acme-site',
      opsActionId: ACTION,
      opsKind: 'pages.deploy',
      deployedAt: NOW,
    },
    file: null,
    note: null,
    uptime,
  };
}
