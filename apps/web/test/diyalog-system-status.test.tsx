// p16-observability: Ayarlar → Sistem durumu — the status snapshot (problems first, tiles, panels), the log search with
// filters and paging, the recent traces with their span tree, and the home page's system line. Read-only, admins.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemStatus } from '../src/api/system';
import { logQuery } from '../src/api/system';
import type { AuthState } from '../src/auth/AuthProvider';
import { ageText } from '../src/diyalog/screens/settings/SystemView';
import { messagesFor } from '@remyral/i18n';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

const STATUS: SystemStatus = {
  checkedAt: new Date().toISOString(),
  overall: 'warning',
  problems: ['queue_backlog', 'workers_offline'],
  components: [
    { id: 'master', state: 'ok', code: null, latencyMs: null },
    { id: 'web', state: 'ok', code: null, latencyMs: 4 },
    { id: 'postgres', state: 'ok', code: null, latencyMs: 2 },
    { id: 'redis', state: 'failing', code: 'timeout', latencyMs: null },
    { id: 'backup', state: 'not_configured', code: null, latencyMs: null },
  ],
  master: {
    releaseTag: 'abcdef123456',
    startedAt: '2026-10-12T10:00:00.000Z',
    uptimeSec: 7200,
    rssBytes: 200 * 1024 * 1024,
    heapUsedBytes: 90 * 1024 * 1024,
    eventLoopDelayMs: 12.3,
    node: 'v24.21.0',
  },
  workerRelease: [{ channel: 'stable', version: '1.0.71', rolloutPercent: 100 }],
  queue: {
    queued: 3,
    running: 1,
    oldestQueuedSec: 900,
    oldestQueuedJobId: 'job-oldest',
    activeLeases: 1,
    approvalsPending: 2,
  },
  workers: {
    online: 1,
    offline: 1,
    pending: 0,
    list: [
      {
        id: 'wrk_a',
        name: 'mac-mini',
        state: 'online',
        connected: true,
        lastSeenAt: new Date().toISOString(),
        workerVersion: '1.0.71',
        runningJobs: 1,
      },
      {
        id: 'wrk_b',
        name: 'pi-5',
        state: 'offline',
        connected: false,
        lastSeenAt: '2026-10-11T10:00:00.000Z',
        workerVersion: '1.0.70',
        runningJobs: 0,
      },
    ],
  },
  versionFeed: {
    enabled: true,
    items: 12,
    failing: 1,
    lastCheckedAt: new Date().toISOString(),
    errors: [{ item: 'node', error: 'HTTP 503' }],
  },
  integrations: {
    coolify: [
      { id: 'c1', label: 'prod', usable: true, lastTestAt: new Date().toISOString(), lastTestOk: true },
    ],
    cloudflare: null,
    github: { connected: true, keyUsable: true, missingPermissions: 0 },
  },
  errors: {
    windowMinutes: 60,
    httpRequests: 1200,
    http5xx: 3,
    dbErrors: 0,
    jobFailures: 1,
    leaseExpiries: 0,
    stepFailures: 0,
    workerMessageErrors: 0,
    chatTurns: 10,
    chatTurnsFailed: 1,
    errorLogLines: 4,
  },
  disk: [
    { id: 'data', totalBytes: 100 * 1024 ** 3, freeBytes: 30 * 1024 ** 3, usedPercent: 70, state: 'ok' },
  ],
  database: { sizeBytes: 512 * 1024 * 1024, connections: 7 },
  redis: { usedMemoryBytes: 8 * 1024 * 1024, maxMemoryBytes: 256 * 1024 * 1024 },
  tracing: { enabled: true, exporting: false, slow: 2, errors: 1 },
  logs: { enabled: true, retentionDays: 7, dropped: 0, lastError: null },
};

const LINES = {
  enabled: true,
  retentionDays: 7,
  since: '2026-10-11T12:00:00.000Z',
  until: '2026-10-12T12:00:00.000Z',
  nextBefore: '41',
  lines: [
    {
      id: '42',
      at: '2026-10-12T11:59:00.000Z',
      level: 50,
      levelName: 'error',
      component: 'orchestrator',
      reqId: 'req-1',
      jobId: 'job-1',
      workerId: null,
      traceId: '0123456789abcdef0123456789abcdef',
      msg: 'dispatch failed: [REDACTED:github-token]',
      fields: { attempt: 2 },
    },
  ],
};

const TRACES = {
  enabled: true,
  traces: [
    {
      traceId: '0123456789abcdef0123456789abcdef',
      root: 'HTTP POST /jobs',
      startedAt: '2026-10-12T11:58:00.000Z',
      durationMs: 1830.5,
      error: true,
      slow: true,
      spanCount: 2,
      droppedSpans: 0,
      attributes: { 'http.route': '/jobs' },
    },
  ],
};

const TRACE = {
  ...TRACES.traces[0],
  spans: [
    {
      spanId: 'a000000000000001',
      parentSpanId: null,
      name: 'HTTP POST /jobs',
      kind: 1,
      startMs: 1000,
      durationMs: 1830.5,
      error: true,
      attributes: { 'http.route': '/jobs' },
    },
    {
      spanId: 'a000000000000002',
      parentSpanId: 'a000000000000001',
      name: 'db insert',
      kind: 2,
      startMs: 1010,
      durationMs: 1500,
      error: false,
      attributes: { 'db.operation.name': 'insert' },
    },
  ],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/system/status': ok(STATUS),
    'GET /api/system/traces?kind=all': ok(TRACES),
    'GET /api/system/traces/0123456789abcdef0123456789abcdef': ok(TRACE),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      if (k in t) return t[k];
      if (k.startsWith('GET /api/system/logs')) return t['GET /api/system/logs'] ?? ok(LINES);
      return (() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler;
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sistem durumu — status', () => {
  it('leads with the verdict and its problems, then tiles and the panels', async () => {
    renderApp({ path: '/settings/system', initialState: owner, routes: routes() });
    const overall = await screen.findByTestId('dy-system-overall');
    expect(overall.textContent).toContain('Dikkat gerektiren 2 konu var');
    expect(within(screen.getByTestId('dy-system-problems')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('dy-system-tile-queue').textContent).toContain('3 bekliyor');
    expect(screen.getByTestId('dy-system-tile-errors').textContent).toContain('1200 istekten');
    expect(screen.getByTestId('dy-system-redis').textContent).toContain('Çalışmıyor');
    expect(screen.getByTestId('dy-system-redis').textContent).toContain('timeout');
    expect(screen.getByTestId('dy-system-deploy').textContent).toContain('abcdef123456');
    expect(screen.getByTestId('dy-system-machines').textContent).toContain('pi-5');
    expect(screen.getByTestId('dy-system-integrations').textContent).toContain('HTTP 503');
    const oldest = within(screen.getByTestId('dy-system-queue')).getByRole('link', { name: /İşi aç/ });
    expect(oldest.getAttribute('href')).toBe('/jobs/job-oldest');
    expect(screen.getByRole('link', { name: /Sistem durumu/ })).toBeDefined();
  });

  it('formats ages and builds log queries without empty filters', () => {
    const t = messagesFor('tr').systemStatus;
    expect(ageText(t, 42)).toBe('42 sn');
    expect(ageText(t, 900)).toBe('15 dk');
    expect(ageText(t, 7200)).toBe('2 sa');
    expect(logQuery({ level: 'error', component: '', jobId: 'job-1' })).toBe('?level=error&jobId=job-1');
    expect(logQuery({})).toBe('');
  });
});

describe('Sistem durumu — logs', () => {
  it('searches with the filters, shows redacted lines with their links and pages older', async () => {
    const user = userEvent.setup();
    const r = renderApp({ path: '/settings/system?tab=logs', initialState: owner, routes: routes() });
    const line = await screen.findByTestId('dy-log-line');
    expect(line.textContent).toContain('dispatch failed: [REDACTED:github-token]');
    expect(
      within(line)
        .getByRole('link', { name: /İşin günlüğü/ })
        .getAttribute('href'),
    ).toBe('/jobs/job-1');
    await user.selectOptions(screen.getByLabelText('En düşük seviye'), 'error');
    await user.type(screen.getByLabelText('Metin'), 'dispatch');
    await user.click(screen.getByRole('button', { name: 'Ara' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/system/logs?level=error&q=dispatch&limit=100')).toBe(
        true,
      );
    });
    await user.click(screen.getByRole('button', { name: 'Daha eski satırlar' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url.includes('before=41'))).toBe(true);
    });
    await user.click(
      within(screen.getAllByTestId('dy-log-line')[0] as HTMLElement).getByRole('button', {
        name: 'Bu isteğin satırları',
      }),
    );
    await waitFor(() => {
      expect(r.requests.some((q) => q.url.includes('reqId=req-1'))).toBe(true);
    });
  });

  it('says when the log search is off', async () => {
    renderApp({
      path: '/settings/system?tab=logs',
      initialState: owner,
      routes: routes({
        'GET /api/system/logs': ok({
          enabled: false,
          retentionDays: 0,
          lines: [],
          nextBefore: null,
          since: null,
          until: null,
        }),
      }),
    });
    expect((await screen.findByTestId('dy-logs-off')).textContent).toContain('kapalı');
  });
});

describe('Sistem durumu — traces', () => {
  it('lists slow / failed traces and opens one as a span tree', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings/system?tab=traces', initialState: owner, routes: routes() });
    const row = await screen.findByTestId('dy-trace-row');
    expect(row.textContent).toContain('HTTP POST /jobs');
    expect(row.textContent).toContain('hata');
    await user.click(within(row).getByRole('button'));
    const detail = await screen.findByTestId('dy-trace-detail');
    const spans = within(detail).getAllByTestId('dy-trace-span');
    expect(spans).toHaveLength(2);
    expect(spans[1]?.textContent).toContain('db insert');
    expect(spans[1]?.textContent).toContain('db.operation.name=insert');
  });
});

describe('home page system line', () => {
  it('admins see the verdict linking to the status page', async () => {
    renderApp({
      path: '/',
      initialState: owner,
      routes: routes({
        'GET /api/system/status': ok({ ...STATUS, overall: 'failing' }),
      }),
    });
    const health = await screen.findByTestId('dy-home-health');
    const link = await within(health).findByRole('link', { name: /Sistemde sorun var/ });
    expect(link.getAttribute('href')).toBe('/settings/system');
  });
});
