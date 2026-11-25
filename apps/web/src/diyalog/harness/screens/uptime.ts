import type { ScreenRoute, ScreenRoutes } from './types';

/** p12-diyalog Faz 4 harness fixtures for the Uptime screen. Return undefined to fall through to the base fixtures. */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

const wave = (base: number, amp: number, gaps: readonly number[] = []): (number | null)[] =>
  Array.from({ length: 24 }, (_, i) =>
    gaps.includes(i) ? null : Math.round(base + amp * Math.sin(i / 2.3) + ((i * 37) % 11)),
  );

function monitor(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project: 'vitrin-web',
    name,
    type: 'http',
    config: { url: `https://${name}/`, method: 'GET', tlsWarnDays: 14 },
    outputKey: null,
    intervalSec: 60,
    timeoutMs: 10_000,
    retries: 1,
    paused: false,
    status: 'up',
    flapping: false,
    consecutiveFailures: 0,
    statusChangedAt: iso(3 * 60 * MIN),
    lastCheck: { at: iso(MIN), ok: true, latencyMs: 142, statusCode: 200, error: null, detail: null },
    tls: null,
    uptime: { h24: 99.93, d7: 99.98, d30: 99.9 },
    latencyAvg24h: 138,
    sparkline: wave(130, 18),
    openIncident: null,
    nextCheckAt: iso(-MIN),
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(20 * 24 * 60 * MIN),
    updatedAt: iso(MIN),
    ...over,
  };
}

const MONITORS = [
  monitor('m-2', 'docs.vitrin.example', {
    status: 'down',
    consecutiveFailures: 4,
    lastCheck: { at: iso(MIN), ok: false, latencyMs: null, statusCode: 502, error: 'status', detail: null },
    uptime: { h24: 91.7, d7: 98.8, d30: 99.6 },
    latencyAvg24h: 310,
    sparkline: wave(290, 60, [21, 22, 23]),
    openIncident: { id: 'i-1', startedAt: iso(4 * MIN), cause: 'status' },
  }),
  monitor('m-5', 'odeme-api.internal:5432', {
    project: 'odeme-api',
    type: 'tcp',
    config: { host: 'odeme-api.internal', port: 5432 },
    status: 'pending',
    flapping: true,
    lastCheck: null,
    uptime: { h24: null, d7: null, d30: null },
    latencyAvg24h: null,
    sparkline: Array<null>(24).fill(null),
  }),
  monitor('m-1', 'vitrin-web.pages.dev', {
    flapping: true,
    tls: { expiresAt: iso(-9 * 24 * 60 * MIN), daysLeft: 9, warning: true },
    outputKey: 'site:vitrin-web',
  }),
  monitor('m-3', 'vitrin-web (Pages)', {
    type: 'pages',
    config: { project: 'vitrin-web', env: 'production' },
    lastCheck: {
      at: iso(2 * MIN),
      ok: true,
      latencyMs: null,
      statusCode: null,
      error: null,
      detail: 'healthy',
    },
    latencyAvg24h: null,
    sparkline: Array<null>(24).fill(null),
  }),
  monitor('m-4', 'mobil-app.demo.test', {
    project: 'mobil-app',
    paused: true,
    uptime: { h24: null, d7: 100, d30: 99.99 },
    sparkline: wave(90, 10, [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]),
    latencyAvg24h: 94,
  }),
];

const HOUR = 60 * MIN;
const BUCKET: Readonly<Record<string, number>> = {
  '24h': HOUR,
  '7d': 6 * HOUR,
  '30d': 24 * HOUR,
  '90d': 72 * HOUR,
};

function series(m: Record<string, unknown>, range: string): unknown {
  const n = range === '24h' ? 24 : range === '7d' ? 28 : 30;
  const step = BUCKET[range] ?? HOUR;
  const down = m.status === 'down';
  const base = down ? 260 : 130;
  return {
    points: Array.from({ length: n }, (_, i) => {
      const gap = m.type === 'tcp' || (down && i >= n - 2) ? false : i === 9;
      const dip = down ? i >= n - 3 || i === 5 : i === 17;
      return {
        t: new Date(NOW - (n - i) * step).toISOString(),
        uptime: gap ? null : dip ? (down && i >= n - 2 ? 0 : 96.4) : 100,
        latencyAvg:
          gap || (down && i >= n - 2) ? null : Math.round(base + 30 * Math.sin(i / 2.6) + ((i * 37) % 17)),
        latencyMax: null,
        checks: gap ? 0 : 60,
      };
    }),
  };
}

function incidents(m: Record<string, unknown>): unknown {
  const items = [
    ...(m.status === 'down'
      ? [
          {
            id: 'i-1',
            startedAt: iso(4 * MIN),
            endedAt: null,
            durationMs: null,
            cause: 'status',
            detail: 'HTTP 502',
            suppressed: false,
          },
        ]
      : []),
    {
      id: 'i-0',
      startedAt: iso(26 * HOUR),
      endedAt: iso(26 * HOUR - 7 * MIN),
      durationMs: 7 * MIN,
      cause: 'timeout',
      detail: null,
      suppressed: false,
    },
    {
      id: 'i-x',
      startedAt: iso(3 * 24 * HOUR),
      endedAt: iso(3 * 24 * HOUR - 2 * MIN),
      durationMs: 2 * MIN,
      cause: 'connect',
      detail: null,
      suppressed: true,
    },
  ];
  return { items, nextCursor: null };
}

function checks(m: Record<string, unknown>, u: URL): unknown {
  const limit = Number(u.searchParams.get('limit') ?? '25');
  const page = u.searchParams.get('cursor') === null ? 0 : 1;
  const down = m.status === 'down';
  const items = Array.from({ length: Math.min(limit, 25) }, (_, k) => {
    const i = page * 25 + k;
    const bad = down && i < 4;
    return {
      id: `c-${String(i)}`,
      at: iso((i + 1) * MIN),
      ok: !bad,
      latencyMs: bad ? null : 120 + ((i * 29) % 40),
      statusCode: bad ? 502 : 200,
      error: bad ? 'status' : null,
      detail: null,
    };
  });
  return { items, nextCursor: page === 0 ? 'c2' : null };
}

const DETAIL: Record<string, ScreenRoute> = {};
for (const m of MONITORS) {
  const base = `/uptime/monitors/${String(m.id)}`;
  DETAIL[base] = (_u, method) =>
    method === 'DELETE' ? null : method === 'PATCH' ? { ...m, paused: m.paused !== true } : m;
  DETAIL[`${base}/check`] = () => ({
    ...m,
    lastCheck: { ...(m.lastCheck as object), at: new Date().toISOString() },
  });
  DETAIL[`${base}/series`] = (u) => series(m, u.searchParams.get('range') ?? '24h');
  DETAIL[`${base}/incidents`] = () => incidents(m);
  DETAIL[`${base}/checks`] = (u) => checks(m, u);
}

export const ROUTES: ScreenRoutes = {
  ...DETAIL,
  '/uptime/monitors': (u, method) => {
    if (method !== 'GET') return undefined;
    const status = u.searchParams.get('status');
    const items = MONITORS.filter((m) =>
      status === null
        ? true
        : status === 'paused'
          ? m.paused === true
          : m.paused !== true && m.status === status,
    );
    const limit = Number(u.searchParams.get('limit') ?? '25');
    return { items: items.slice(0, limit), total: items.length };
  },
};
