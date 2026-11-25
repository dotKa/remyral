import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, safeLoginUrl, startLogin } from '../src/api/remoteOps';
import { fakeFetch, stubCookies, USER } from './helpers';

const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = `/api/workers/${W}`;
const OP_ID = '00000000-0000-4000-8000-0000000000a1';

function op(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OP_ID,
    workerId: W,
    kind: 'runtime.install',
    params: { runtime: 'codex', version: '0.162.1' },
    state: 'sent',
    reason: null,
    detail: null,
    progress: null,
    result: null,
    requestedBy: USER.id,
    requestedAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: null,
    login: null,
    logs: null,
    ...over,
  };
}

function status(
  over: Record<string, unknown> = {},
  report: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workerId: W,
    displayName: 'linux-1',
    state: 'online',
    connected: true,
    supported: true,
    reportedAt: '2026-10-14T10:00:00.000Z',
    ops: [],
    report: {
      runtimes: [
        {
          runtime: 'codex',
          method: 'npm',
          supported: true,
          pinned: '0.162.1',
          previous: '0.161.0',
          available: ['0.161.0', '0.162.1'],
          installed: [],
          active: null,
        },
        {
          runtime: 'claude-code',
          method: 'npm',
          supported: true,
          pinned: '2.1.296',
          available: ['2.1.296'],
          installed: [{ version: '2.1.296', installedAt: '2026-10-14T09:00:00.000Z', integrity: 'ok' }],
          active: '2.1.296',
        },
        {
          runtime: 'pi',
          method: 'npm',
          supported: false,
          unsupportedReason: 'Node.js >= 24 not found on this host',
          pinned: '1.1.0',
          available: [],
          installed: [],
          active: null,
        },
        // ADR-0023: an older worker may still report its managed OpenHands install; it is not shown.
        {
          runtime: 'openhands',
          method: 'pypi',
          supported: true,
          pinned: '1.54.0',
          available: ['1.54.0'],
          installed: [],
          active: null,
        },
      ],
      login: [{ runtime: 'claude-code', status: 'logged_out' }],
      service: { manager: 'systemd', restartable: false },
      logs: { available: true, bytes: 100 },
      ...report,
    },
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Machine page → Runtimes / Activity (p5-remote-ops, p6-ui-machines)', () => {
  it('a foreign or non-https login URL is never shown as a link', () => {
    expect(safeLoginUrl('https://evil.example/x')).toBeNull();
    expect(safeLoginUrl('http://claude.com/x')).toBeNull();
    expect(safeLoginUrl('javascript:alert(1)')).toBeNull();
    expect(safeLoginUrl('https://auth.openai.com/codex/device')).toBe('https://auth.openai.com/codex/device');
    expect(compareVersions('0.162.1', '0.161.9')).toBe(1);
  });
});

describe('startLogin resumes an open login (login_in_progress)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const open = op({ kind: 'login.start', params: { runtime: 'claude-code' }, state: 'waiting_for_user' });

  it('returns the open login instead of failing', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const f = fakeFetch({
      [`POST ${BASE}/runtimes/codex/login`]: () => ({
        status: 409,
        body: { error: 'login_in_progress', message: 'A login is already in progress on this worker.' },
      }),
      [`GET ${BASE}/ops`]: () => ({ status: 200, body: status({ ops: [open] }) }),
    });
    vi.stubGlobal('fetch', f.fetch);
    await expect(startLogin(W, 'codex')).resolves.toMatchObject({ id: OP_ID, kind: 'login.start' });
  });

  it('still fails when no open login is listed', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const f = fakeFetch({
      [`POST ${BASE}/runtimes/codex/login`]: () => ({
        status: 409,
        body: { error: 'login_in_progress', message: 'A login is already in progress on this worker.' },
      }),
      [`GET ${BASE}/ops`]: () => ({ status: 200, body: status({ ops: [] }) }),
    });
    vi.stubGlobal('fetch', f.fetch);
    await expect(startLogin(W, 'codex')).rejects.toMatchObject({ code: 'login_in_progress' });
  });
});
