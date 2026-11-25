import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: machine page → Runtime’lar and Etkinlik. The remote-operations status of
 * every harness machine (`GET /workers/:id/ops`): managed runtimes (an upgrade, a rollback, a modified install, an
 * unsupported runtime), the subscription logins (one expired after a failed refresh) and a recent operation history.
 * Also used by apps/web/test/diyalog-w3-machine-runtimes.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

export function opFixture(
  id: string,
  workerId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    workerId,
    kind: 'runtime.install',
    params: { runtime: 'codex', version: '0.162.1' },
    state: 'succeeded',
    reason: null,
    detail: null,
    progress: null,
    result: null,
    requestedBy: { type: 'user', id: 'u1', username: 'alex' },
    requestedAt: iso(2 * HOUR),
    updatedAt: iso(2 * HOUR),
    finishedAt: iso(2 * HOUR),
    login: null,
    logs: null,
    ...over,
  };
}

export function opsStatusFixture(
  workerId: string,
  over: Record<string, unknown> = {},
  report: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workerId,
    displayName: workerId,
    state: 'online',
    connected: true,
    supported: true,
    reportedAt: iso(MIN),
    ops: [
      opFixture('op-3', workerId, {
        kind: 'login.status',
        params: { runtime: 'claude-code' },
        requestedAt: iso(20 * MIN),
      }),
      opFixture('op-2', workerId, {
        kind: 'runtime.install',
        params: { runtime: 'opencode', version: '1.14.2' },
        state: 'failed',
        reason: 'checksum_mismatch',
        detail: 'İndirilen paket sabitlenen sağlama toplamıyla eşleşmedi.',
        requestedAt: iso(3 * HOUR),
      }),
      opFixture('op-1', workerId, { kind: 'logs.tail', params: { lines: 300 }, requestedAt: iso(26 * HOUR) }),
    ],
    report: {
      runtimes: [
        {
          runtime: 'claude-code',
          method: 'npm',
          supported: true,
          pinned: '2.1.296',
          previous: '2.1.290',
          available: ['2.1.290', '2.1.296'],
          installed: [
            { version: '2.1.290', installedAt: iso(9 * 24 * HOUR), integrity: 'ok' },
            { version: '2.1.296', installedAt: iso(2 * 24 * HOUR), integrity: 'ok' },
          ],
          active: '2.1.296',
        },
        {
          runtime: 'codex',
          method: 'npm',
          supported: true,
          pinned: '0.162.1',
          previous: '0.161.0',
          available: ['0.161.0', '0.162.1'],
          installed: [{ version: '0.161.0', installedAt: iso(12 * 24 * HOUR), integrity: 'ok' }],
          active: '0.161.0',
        },
        {
          runtime: 'opencode',
          method: 'binary',
          supported: true,
          pinned: '1.14.2',
          available: ['1.14.2'],
          installed: [{ version: '1.14.2', installedAt: iso(5 * 24 * HOUR), integrity: 'modified' }],
          active: '1.14.2',
        },
        {
          runtime: 'pi',
          method: 'npm',
          supported: false,
          unsupportedReason: 'Bu makinede Node.js >= 24 bulunamadı',
          pinned: '1.1.0',
          available: [],
          installed: [],
          active: null,
        },
      ],
      login: [
        {
          runtime: 'claude-code',
          status: 'expired',
          reason: 'login_expired',
          method: 'claude.ai',
          checkedAt: iso(40 * MIN),
        },
        { runtime: 'codex', status: 'logged_in', method: 'ChatGPT', checkedAt: iso(3 * HOUR) },
      ],
      service: { manager: 'systemd', restartable: true },
      logs: { available: true, bytes: 48_000 },
      ...report,
    },
    ...over,
  };
}

/** The machine's lifecycle history (`GET /workers/:id/history`), newest first. */
export const HISTORY_FIXTURE = {
  items: [
    {
      at: iso(25 * MIN),
      action: 'worker.session.start',
      outcome: 'success',
      actor: { type: 'worker' },
      detail: {},
    },
    {
      at: iso(30 * MIN),
      action: 'worker.session.end',
      outcome: 'success',
      actor: { type: 'worker' },
      detail: {},
    },
    {
      at: iso(3 * 24 * HOUR),
      action: 'worker.update.target',
      outcome: 'success',
      actor: { type: 'user' },
      detail: { from: '1.0.40', to: '1.0.41', channel: 'stable' },
    },
    {
      at: iso(9 * 24 * HOUR),
      action: 'worker.rotate.approve',
      outcome: 'failure',
      actor: { type: 'user' },
      detail: { reason: 'step_up_required' },
    },
    {
      at: iso(40 * 24 * HOUR),
      action: 'worker.approve',
      outcome: 'success',
      actor: { type: 'user' },
      detail: {},
    },
    {
      at: iso(40 * 24 * HOUR + 5 * MIN),
      action: 'worker.pairing.request',
      outcome: 'success',
      actor: { type: 'worker' },
      detail: {},
    },
  ],
};

const ROUTES_BY_WORKER: Record<string, (url: URL, method: string) => unknown> = {};
for (const id of ['w1', 'w2', 'w3', 'w4', 'w5']) {
  ROUTES_BY_WORKER[`/workers/${id}/history`] = (_u, method) =>
    method === 'GET' ? HISTORY_FIXTURE : undefined;
  ROUTES_BY_WORKER[`/workers/${id}/ops`] = (_u, method) =>
    method === 'GET' ? opsStatusFixture(id, id === 'w4' ? { connected: false } : {}) : undefined;
}

export const ROUTES: ScreenRoutes = { ...ROUTES_BY_WORKER };
