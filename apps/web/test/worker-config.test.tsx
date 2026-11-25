import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanSpec, parseLabels } from '../src/screens/fleet/workerConfig';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

const ID = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID2 = 'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const SIGNED_IN = { kind: 'signedIn' as const, user: USER, session: null, remainingRecoveryCodes: null };

function worker(id = ID, name = 'linux-1'): Record<string, unknown> {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: 'SHA256:x',
    os: 'linux',
    arch: 'x64',
    osVersion: null,
    hostname: name,
    workerVersion: '0.1.0',
    protocolVersion: '1.0',
    runningJobs: 0,
    lastSeenAt: new Date().toISOString(),
    createdAt: '2026-10-13T10:00:00.000Z',
    approvedAt: '2026-10-13T10:00:00.000Z',
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    archivedAt: null,
  };
}

function detail(id = ID): Record<string, unknown> {
  return {
    ...worker(id),
    credentials: [],
    runtimes: [],
    load: null,
    sandboxProfiles: [],
    tools: [],
    maxParallelJobs: 1,
    capabilitiesAt: null,
    drainReason: null,
  };
}

const SPEC = {
  projects: ['alpha'],
  allowedRuntimes: ['codex'],
  maxParallelJobs: 2,
  sandboxProfiles: ['container'],
  workspace: {},
  labels: { site: 'home' },
  runtimes: {
    codex: { auth: { mode: 'secret-ref', credentialRef: { source: 'worker-store', name: 'openai' } } },
  },
};

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'panel',
    generation: 2,
    documentHash: 'e'.repeat(64),
    effective: {
      projects: ['alpha'],
      allowedRuntimes: ['codex'],
      maxParallelJobs: 2,
      sandboxProfiles: ['container'],
      runtimeAuth: { codex: 'secret-ref' },
      labels: { site: 'home' },
    },
    ceiling: {
      projects: null,
      repoHosts: ['github.com'],
      allowedRuntimes: null,
      maxParallelJobs: 4,
      sandboxProfiles: null,
      pinnedRuntimes: [],
    },
    blocked: [{ path: 'projects.beta', code: 'blocked_by_local_ceiling', detail: 'host not allowed' }],
    ...over,
  };
}

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId: ID,
    displayName: 'linux-1',
    state: 'online',
    connected: true,
    supported: true,
    desired: {
      generation: 2,
      documentHash: 'e'.repeat(64),
      spec: SPEC,
      document: {},
      cause: 'edit',
      rollbackOf: null,
      changeNote: null,
      createdAt: '2026-10-14T10:00:00.000Z',
      createdBy: USER.id,
    },
    delivered: { generation: 2, at: '2026-10-14T10:00:01.000Z' },
    report: report(),
    reportedAt: '2026-10-14T10:00:02.000Z',
    status: 'applied',
    drift: [{ path: 'projects.beta', reason: 'blocked_by_local_ceiling: host not allowed' }],
    suggested: SPEC,
    projectOptions: [
      { id: 'alpha', name: 'Alpha', repositoryUrl: 'https://github.com/acme/alpha.git' },
      { id: 'beta', name: 'beta', repositoryUrl: 'https://gitlab.com/acme/beta.git' },
      { id: 'gamma', name: 'gamma', repositoryUrl: null },
    ],
    ...over,
  };
}

function fleetRoutes(extra: Record<string, Handler>): Record<string, Handler> {
  return {
    'GET /api/workers': () => ({ status: 200, body: { workers: [worker(), worker(ID2, 'mac-1')] } }),
    [`GET /api/workers/${ID}`]: () => ({ status: 200, body: detail() }),
    [`GET /api/workers/${ID2}`]: () => ({ status: 200, body: detail(ID2) }),
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Fleet → worker → Configuration (ADR-0015)', () => {
  it('is not offered to viewers (the API is admin-only)', async () => {
    renderApp({
      path: '/fleet',
      initialState: { ...SIGNED_IN, user: { ...USER, role: 'viewer' } },
      routes: fleetRoutes({}),
    });
    const user = userEvent.setup();
    const link = await screen.findByRole('link', { name: /linux-1/ });
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Select/ })).toBeNull();
    await user.click(link);
    await screen.findByTestId('worker-details');
    expect(screen.queryByRole('tab', { name: 'Configuration' })).toBeNull();
  });

  it('opens the machine page on its Configuration tab from a /fleet?worker=…&section=config deep link', async () => {
    renderApp({
      path: `/fleet?worker=${ID}&section=config`,
      initialState: SIGNED_IN,
      routes: fleetRoutes({ [`GET /api/workers/${ID}/config`]: () => ({ status: 200, body: view() }) }),
    });
    const panel = await screen.findByTestId('worker-config-panel');
    expect((await within(panel).findByTestId('config-status')).dataset.status).toBe('applied');
    expect(screen.getAllByTestId('worker-details')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('parses labels and drops empty settings and settings of disallowed runtimes', () => {
    expect(parseLabels('a=1\n\nbad\n b = 2 ')).toEqual({ labels: { a: '1', b: '2' }, invalid: ['bad'] });
    const out = cleanSpec({
      ...SPEC,
      allowedRuntimes: ['codex'],
      workspace: { retainFailed: undefined },
      runtimes: {
        codex: { modelProfile: '  ' },
        pi: { model: 'x/y' },
      },
    } as never);
    expect(out.runtimes).toEqual({});
    expect(out.workspace).toEqual({});
  });
});
